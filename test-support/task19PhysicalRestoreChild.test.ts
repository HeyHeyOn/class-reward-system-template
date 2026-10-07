// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { restoreColdDatabase, type ColdAnchor } from '@/server/db/testing/coldRestore';
import { ExecSocket } from '@/server/db/testing/disposablePostgres';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { OTHER } from './task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.TASK19_PHYSICAL_REQUEST;
if (path && !/^\.task19-physical-results\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid physical restore request');
it.skipIf(!path)('Task19 separate physical restore child',async () => {
  if (process.env.RUN_REAL_POSTGRES!=='1') throw new Error('Owned PG required');
  const q: {anchor:ColdAnchor;binding:LocalCandidateBinding;fault?:string} = JSON.parse(readFileSync(path!,'utf8'));
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
    if (q.fault==='postcommit-rls') await db.owner.query('ALTER TABLE products DISABLE ROW LEVEL SECURITY');
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
      const products = (await owner.query('SELECT product_id,name,price::text,stock::text FROM products ORDER BY product_id')).rows;
      const receipts = (await owner.query('SELECT * FROM migration_local_restorations')).rows;
      const identity = (await owner.query('SELECT * FROM migration_local_restore_databases')).rows;
      const marker = (await owner.query('SELECT * FROM migration_local_disposable_database')).rows;
      await runtime.query('BEGIN');
      await runtime.query("SELECT set_config('app.tenant_id',$1,true)",[OTHER]);
      const otherProducts = (await runtime.query('SELECT * FROM products')).rows;
      const otherReceipts = (await runtime.query('SELECT * FROM migration_local_restorations')).rows;
      await runtime.query('ROLLBACK');
      observed={physical,topology:db.evidence,backend,oldBackend,products,receipts,identity,marker,otherProducts,otherReceipts,
        role:(await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows};
      if (!q.fault) {
        expect(otherProducts).toEqual([]); expect(otherReceipts).toEqual([]);
        await expect(owner.query('UPDATE migration_local_restorations SET activation_allowed=true')).rejects.toThrow(/immutable/i);
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
