// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { restoreColdDatabase, type ColdAnchor } from '@/server/db/testing/coldRestore';
import { createDisposablePostgres, ExecSocket } from '@/server/db/testing/disposablePostgres';
import { backupMaterializedDatabase, readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { OTHER } from './task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.TASK19_PHYSICAL_REQUEST;
if (path && !/^\.task19-physical-results\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid physical restore request');
it.skipIf(!path)('Task19 separate prepared physical restore child',async () => {
  if (process.env.RUN_REAL_POSTGRES!=='1') throw new Error('Owned PG required');
  const q: {anchor:ColdAnchor;binding:LocalCandidateBinding;fault?:string;original?:boolean} = JSON.parse(readFileSync(path!,'utf8'));
  const execute = archive.executeOwnedRestore;
  let observed: Record<string,unknown> = {}, dispatched = false;
  const injected = vi.spyOn(archive,'executeOwnedRestore').mockImplementationOnce(async (db,script) => {
    dispatched = true;
    const physical = await archive.inspectArchiveDatabase(db);
    if (q.fault==='partial-sql') {
      const changed = script.replace(/^INSERT INTO public\.tenant_settings.*;$/m,'');
      expect(changed).not.toBe(script); script=changed;
    }
    try { await execute(db,script); }
    catch (error) {
      observed={physical,publicTables:(await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows};
      throw error;
    }
    // Deterministic infrastructure fault AFTER acknowledged native COMMIT,
    // before the service's readback. Not a forged psql/mock success.
    if (q.fault==='postcommit-value') await db.owner.query("UPDATE products SET name='Wrong after COMMIT' WHERE product_id='P1'");
    if (q.fault==='postcommit-missing') await db.owner.query('DELETE FROM tenant_settings');
    if (q.fault==='postcommit-resurrect') await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,category,sort_order) VALUES($1,'PX','Resurrected',9,0,true,'school',2)",[q.binding.tenantId]);
    if (q.fault==='postcommit-sequence') await db.owner.query("SELECT setval('transactions_event_sequence_seq',901,true)");
    if (q.fault==='post-original-receipt-guard') await db.owner.query('ALTER TABLE local_restore_control.original_restorations DISABLE TRIGGER immutable');
    if (q.fault==='postcommit-rls') await db.owner.query('ALTER TABLE products DISABLE ROW LEVEL SECURITY');
    let faultRows: number | null = null;
    if (q.fault==='postcommit-task') faultRows=(await db.owner.query("UPDATE tasks SET reward=999 WHERE task_instance_id='TI1'")).rowCount;
    if (q.fault==='postcommit-settings') faultRows=(await db.owner.query("UPDATE tenant_settings SET settings=jsonb_set(settings,'{themeColor}','\"wrong\"')")).rowCount;
    if (q.fault==='postcommit-allowed-edge') faultRows=(await db.owner.query("INSERT INTO task_allowed_students(tenant_id,task_instance_id,student_id) VALUES($1,'TI1','S1')",[q.binding.tenantId])).rowCount;
    if (q.fault==='postcommit-source-evidence') {
      await db.owner.query('ALTER TABLE migration_local_restorations DISABLE TRIGGER USER');
      try {
        faultRows=(await db.owner.query("UPDATE migration_local_restorations SET provenance=jsonb_set(provenance,'{prepared,sourceTables}','{}'::jsonb)")).rowCount;
      } finally { await db.owner.query('ALTER TABLE migration_local_restorations ENABLE TRIGGER USER'); }
    }
    // Open distinct native backend connections after restore. They carry no
    // source handle, snapshot importer or source-revision reconstruction.
    const streams = new Set<ExecSocket>();
    const pools: Pool[] = [];
    const open = (user:string) => {
      const pool = new Pool({user,database:'postgres',host:'/var/run/postgresql',port:5432,password:() => '',ssl:false,
        options:'-c timezone=UTC',application_name:'task19-physical-cold-read',connectionTimeoutMillis:15000,
        max:1,idleTimeoutMillis:0,stream:() => {
          const stream = new ExecSocket(String(db.evidence.containerId),{PATH:process.env.PATH,HOME:'/scratch',DOCKER_CONFIG:'/scratch',LANG:'C',NODE_ENV:'test'});
          streams.add(stream); return stream;
        }});
      pool.on('error',() => {}); pools.push(pool); return pool;
    };
    try {
      const owner = open('postgres'), runtime = open('app_runtime');
      const oldBackend = (await db.owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const backend = (await owner.query('SELECT pg_backend_pid() AS pid,system_identifier::text AS system FROM pg_control_system()')).rows[0];
      expect(backend.pid).not.toBe(oldBackend); expect(backend.system).toBe(physical.systemIdentifier);
      await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const readOnly=(await owner.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
      const jobs=(await owner.query('SELECT to_jsonb(t) AS value FROM migration_jobs t')).rows.map(r => r.value);
      const audits=(await owner.query('SELECT to_jsonb(t) AS value FROM audit_events t')).rows.map(r => r.value);
      const chronology=(await owner.query('SELECT a.occurred_at=j.updated_at AS same_time FROM audit_events a JOIN migration_jobs j USING(tenant_id,job_id)')).rows;
      const products = (await owner.query('SELECT product_id,name,price::text,stock::text FROM products ORDER BY product_id')).rows;
      const tasks=(await owner.query('SELECT task_instance_id,title,reward::text FROM tasks ORDER BY task_instance_id')).rows;
      const settings=(await owner.query('SELECT settings FROM tenant_settings')).rows;
      const allowedStudents=(await owner.query('SELECT task_instance_id,student_id FROM task_allowed_students ORDER BY task_instance_id,student_id')).rows;
      const receipts = q.original ? (await owner.query('SELECT receipt FROM local_restore_control.original_restorations')).rows.map(r => r.receipt)
        : (await owner.query('SELECT * FROM migration_local_restorations')).rows;
      const identity = (await owner.query('SELECT * FROM migration_local_restore_databases')).rows;
      const marker = (await owner.query('SELECT * FROM migration_local_disposable_database')).rows;
      await owner.query('COMMIT');
      await runtime.query('BEGIN READ ONLY');
      await runtime.query("SELECT set_config('app.tenant_id',$1,true)",[OTHER]);
      const otherAudits=(await runtime.query('SELECT * FROM audit_events')).rows;
      const otherProducts = (await runtime.query('SELECT * FROM products')).rows;
      const otherReceipts = (await runtime.query('SELECT * FROM migration_local_restorations')).rows;
      const otherTasks=(await runtime.query('SELECT * FROM tasks')).rows;
      const otherSettings=(await runtime.query('SELECT * FROM tenant_settings')).rows;
      const otherAllowedStudents=(await runtime.query('SELECT * FROM task_allowed_students')).rows;
      await runtime.query('ROLLBACK');
      if (q.original) await expect(runtime.query('SELECT * FROM local_restore_control.original_restorations')).rejects.toThrow(/permission denied/);
      observed={readOnly,jobs,audits,chronology,otherAudits,physical,topology:db.evidence,backend,oldBackend,products,receipts,identity,marker,otherProducts,otherReceipts,
        tasks,settings,allowedStudents,otherTasks,otherSettings,otherAllowedStudents,faultRows,
        role:(await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows};
      if (!q.fault) {
        expect(otherAudits).toEqual([]);
        await expect(owner.query("UPDATE audit_events SET event_type='RELABEL'")).rejects.toThrow(/immutable/i);
        expect(otherProducts).toEqual([]); expect(otherReceipts).toEqual([]);
        await expect(owner.query(q.original ? 'UPDATE local_restore_control.original_restorations SET receipt=receipt'
          : 'UPDATE migration_local_restorations SET activation_allowed=true')).rejects.toThrow(/immutable/i);
        if (q.original) await expect(owner.query('TRUNCATE local_restore_control.original_restorations')).rejects.toThrow(/immutable/i);
        if (q.original) {
          // Copied SOURCE marker is exact historical SQL, not an allocator
          // capability. Exercise the real materializer with the fresh run ID.
          const probe=await createDisposablePostgres();
          try {
            const before=await readMaterializedRecoveryState(db.owner),empty=await readMaterializedRecoveryState(probe.owner);
            const ownerId=String(marker[0].owner_id);
            const lease=(database:typeof db) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:database.runId,ownerId,
              queryOwner:(text:string,values?:unknown[]) => database.owner.query(text,values),runTransaction:database.runTenantTransaction});
            await expect(materializeLocalCandidate(q.binding,createOwnedLocalMaterializationRunner(q.binding.tenantId,q.binding.migrationJobId,
              lease(db),lease(probe)))).rejects.toThrow();
            await expect(backupMaterializedDatabase(db,ownerId,q.binding)).rejects.toThrow();
            expect(await readMaterializedRecoveryState(db.owner)).toEqual(before);
            expect(await readMaterializedRecoveryState(probe.owner)).toEqual(empty);
            observed.sourceReuseRefused=true;
          } finally { console.info('ORIGINAL_REUSE_PROBE_CLEANUP',JSON.stringify(await probe.close())); }
        }
      }
    } finally {
      await Promise.all(pools.map(pool => pool.end())); for (const stream of streams) stream.destroy();
      observed.poolsClosed=true;
    }
  });
  let outcome: unknown;
  try {
    outcome=await restoreColdDatabase(q.anchor,q.binding).then(value => ({accepted:true,value}),error => ({accepted:false,error:(error as Error).message}));
  } finally { injected.mockRestore(); }
  const journal=JSON.parse(readFileSync(`.cold-restore-control/${q.anchor.id}/state.json`,'utf8'));
  writeFileSync(path!.replace('-request.json','-result.json'),JSON.stringify({pid:process.pid,dispatched,observed,outcome,journal}),{flag:'wx',mode:0o600});
},150_000);
