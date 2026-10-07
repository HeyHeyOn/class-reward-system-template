// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { createDisposablePostgres, ExecSocket } from '@/server/db/testing/disposablePostgres';
import { acquireColdArchive, coldAllocationRegistration, bindColdTarget, settleColdArchive, type ColdAnchor } from '@/server/db/testing/coldRestoreStore';
import * as restored from '@/server/db/testing/materializedRestore';
import { materializeLocalCandidate, type LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { canonicalJson, sha256 } from '@/server/migration/validators';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const exec = promisify(execFile);
const path = process.env.TASK19_CANDIDATE_REQUEST;
if (path && !/^\.task19-candidate-results\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid candidate request');
const read = (p:string) => JSON.parse(readFileSync(p,'utf8'));
const save = (p:string,value:unknown) => writeFileSync(p,JSON.stringify(value),{flag:'wx',mode:0o600});
export async function candidateChild(input:unknown) {
  const prefix=`.task19-candidate-results/${randomUUID()}`;
  save(`${prefix}-request.json`,input);
  const output=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19RestoredCandidateChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:'/scratch',LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',TASK19_CANDIDATE_REQUEST:`${prefix}-request.json`},maxBuffer:8_000_000});
  save(`${prefix}-process.json`,{exitCode:0,...output});
  expect(read(`${prefix}-vitest.json`)).toMatchObject({numPassedTests:1,numFailedTests:0,success:true});
  const result=read(`${prefix}-result.json`); expect(result.pid).not.toBe(process.pid);
  return result;
}
function connection(container:string) {
  const streams=new Set<ExecSocket>();
  const pool=new Pool({user:'postgres',database:'postgres',host:'/var/run/postgresql',port:5432,password:() => '',ssl:false,
    options:'-c timezone=UTC',application_name:'task19-candidate-independent-test',connectionTimeoutMillis:15000,max:1,idleTimeoutMillis:0,
    stream:() => {const stream=new ExecSocket(container,{PATH:process.env.PATH,HOME:'/scratch',DOCKER_CONFIG:'/scratch',LANG:'C',NODE_ENV:'test'}); streams.add(stream); return stream;}});
  pool.on('error',() => {});
  return {pool,close:async () => {await pool.end(); for (const s of streams) s.destroy();}};
}
// Real baseline probe: a restored NONAUTHORITY image lacks SOURCE ownership and
// generation/lease authority. Do not relabel it or bypass the unchanged runner.
async function legacyProbe(binding:LocalCandidateBinding,inventory:Record<string,string>) {
  const c=connection(inventory.containerId), destination=await createDisposablePostgres();
  try {
    await destination.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'candidate-legacy','Synthetic')",[binding.tenantId]);
    await destination.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[binding.tenantId,binding.migrationJobId]);
    await destination.owner.query("INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,'DESTINATION',$3,$4)",
      [destination.runId,inventory.ownerId,binding.tenantId,binding.migrationJobId]);
    const source={kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:inventory.runId,ownerId:inventory.ownerId,
      queryOwner:(text:string,values?:unknown[]) => c.pool.query(text,values),runTransaction:createTenantTransactionRunner({pool:c.pool})};
    const target={kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:destination.runId,ownerId:inventory.ownerId,
      queryOwner:(text:string,values?:unknown[]) => destination.owner.query(text,values),runTransaction:destination.runTenantTransaction};
    return await materializeLocalCandidate(binding,createOwnedLocalMaterializationRunner(binding.tenantId,binding.migrationJobId,source,target));
  } finally {await c.close(); console.info('CANDIDATE_LEGACY_CLEANUP',JSON.stringify(await destination.close()));}
}
it.skipIf(!path)('Task19 isolated restored candidate child',async () => {
  if (process.env.RUN_REAL_POSTGRES!=='1') throw new Error('Owned PG required');
  const input=read(path!) as {mode:string;anchor:ColdAnchor;binding:LocalCandidateBinding;fault?:string;request?:Record<string,unknown>};
  const {anchor,binding,fault}=input, dir=`.cold-restore-control/${anchor.id}`;
  let result:unknown;
  if (input.mode==='restore') {
    const lease=await acquireColdArchive(anchor,binding), {ownerId,registration}=coldAllocationRegistration(lease);
    const db=await createDisposablePostgres(registration);
    try {
      const target=await restored.allocateRestoreTarget(db,ownerId,binding);
      await bindColdTarget(lease,db); await restored.restoreRetainedMaterializedDatabase(lease,target);
      await settleColdArchive(lease,'SUCCEEDED',{pid:process.pid,targetId:db.runId,containerId:db.evidence.containerId,rollbackVerified:false});
      const original=await restored.readMaterializedRecoveryState(db.owner), inventory=read(`${dir}/inventory.json`), seal=read(`${dir}/expectation.json`).seal;
      const request={binding,stopIntentDigest:sha256(canonicalJson(seal.prepared.intent)),sourceGenerationDigest:seal.prepared.sourceGenerationDigest,
        restoreOwnerId:ownerId,restoreDatabaseId:db.runId,restoreAttemptId:inventory.attemptId,restoreSystemIdentifier:inventory.systemIdentifier,
        authority:'NONAUTHORITY',activationAllowed:false};
      const oldBackend=(await db.owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let legacy:unknown;
      if (!fault) legacy=await legacyProbe(binding,inventory).then(value => ({accepted:true,value}),error => ({accepted:false,error:error.message}));
      if (fault==='partial-image') await db.owner.query('DELETE FROM tenant_settings');
      if (fault==='changed-product') await db.owner.query("UPDATE products SET price=999 WHERE product_id='P1'");
      if (fault==='resurrected-delete') await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'PX','Resurrected',9,0)",[binding.tenantId]);
      if (fault==='changed-stop') {
        await db.owner.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
        await db.owner.query("UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,'{complete}','true')");
        await db.owner.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
      }
      if (fault==='changed-version') {await db.owner.query('ALTER TABLE migration_jobs DISABLE TRIGGER USER'); await db.owner.query('UPDATE migration_jobs SET state_version=4'); await db.owner.query('ALTER TABLE migration_jobs ENABLE TRIGGER USER');}
      if (fault==='changed-lineage') {
        // Coherent forged lineage, with the native composite FK still enabled.
        // Remove/reinsert the dependent receipt rather than failing the fixture
        // before the independent consumer can inspect the changed image.
        const client=await db.owner.connect(), forgedOwner=randomUUID();
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE migration_local_restore_databases DISABLE TRIGGER USER');
          await client.query('ALTER TABLE migration_local_restorations DISABLE TRIGGER USER');
          const row=(await client.query('DELETE FROM migration_local_restorations RETURNING *')).rows[0];
          await client.query('UPDATE migration_local_restore_databases SET owner_id=$1',[forgedOwner]);
          await client.query('INSERT INTO migration_local_restorations SELECT * FROM jsonb_populate_record(NULL::migration_local_restorations,$1::jsonb)',
            [JSON.stringify({...row,destination_owner_id:forgedOwner})]);
          await client.query('ALTER TABLE migration_local_restore_databases ENABLE TRIGGER USER');
          await client.query('ALTER TABLE migration_local_restorations ENABLE TRIGGER USER');
          await client.query('COMMIT');
        } catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
      }
      if (fault==='changed-control') {await db.owner.query('ALTER TABLE local_restore_control.lease DISABLE TRIGGER USER'); await db.owner.query('UPDATE local_restore_control.lease SET owner_id=$1',[randomUUID()]); await db.owner.query('ALTER TABLE local_restore_control.lease ENABLE TRIGGER USER');}
      if (fault==='privilege-promotion') await db.owner.query('ALTER ROLE app_runtime BYPASSRLS');
      if (fault==='changed-sequence') await db.owner.query("SELECT setval('transactions_event_sequence_seq',500,true)");
      const before=await restored.readMaterializedRecoveryState(db.owner);
      const consumed=await candidateChild({mode:'consume',anchor,binding,request,fault});
      const after=await restored.readMaterializedRecoveryState(db.owner);
      const replay=(!fault || consumed.journal?.status==='QUARANTINED') ? await candidateChild({mode:'consume',anchor,binding,request}) : undefined;
      const independent=connection(String(db.evidence.containerId));
      let readback;
      try {
        await independent.pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        readback={backend:(await independent.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
          readOnly:(await independent.pool.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
          state:await restored.readMaterializedRecoveryState(independent.pool)};
        await independent.pool.query('COMMIT');
      } finally {await independent.close();}
      result={pid:process.pid,oldBackend,legacy,original,before,after,inventory,request,consumed,replay,readback,seal};
    } finally {console.info('CANDIDATE_RESTORE_CLEANUP',JSON.stringify(await db.close()));}
  } else {
    const request=structuredClone(input.request!), inventory=read(`${dir}/inventory.json`);
    if (fault==='wrong-generation') request.binding={...binding,generationId:'wrong-generation'};
    if (fault==='wrong-source-version') request.binding={...binding,expectedStateVersion:'5'};
    if (fault==='wrong-tenant') request.binding={...binding,tenantId:randomUUID()};
    if (fault==='wrong-job') request.binding={...binding,migrationJobId:'other-job'};
    if (fault==='wrong-intent') request.stopIntentDigest=sha256('wrong');
    if (fault==='wrong-source-generation') request.sourceGenerationDigest=sha256('wrong');
    if (fault==='wrong-owner') request.restoreOwnerId=randomUUID();
    if (fault==='wrong-database') request.restoreDatabaseId=randomUUID();
    if (fault==='wrong-attempt') request.restoreAttemptId=randomUUID();
    if (fault==='wrong-system') request.restoreSystemIdentifier='100';
    if (fault==='authority') request.authority='ACTIVE';
    if (fault==='activation') request.activationAllowed=true;
    if (fault==='extra') request.complete=true;
    if (fault==='stale') vi.spyOn(Date,'now').mockReturnValue(read(`${dir}/expectation.json`).policy.expiresAt);
    const bytesFault=fault==='changed-archive' ? `.cold-restore-transport/${anchor.id}.sql` : fault==='changed-pin' ? `${dir}/expectation.json` : undefined;
    const saved=bytesFault ? readFileSync(bytesFault) : undefined;
    if (bytesFault) writeFileSync(bytesFault,saved!.subarray(0,100));
    if (fault==='post-reopen-change') {
      const actual=restored.readMaterializedRecoveryState;
      vi.spyOn(restored,'readMaterializedRecoveryState').mockImplementationOnce(async q => {
        const state=await actual(q), c=connection(inventory.containerId);
        try {await c.pool.query("UPDATE products SET price=999 WHERE product_id='P1'");} finally {await c.close();}
        return state;
      });
    }
    type Consumer=(anchor:ColdAnchor,request:Record<string,unknown>) => Promise<unknown>;
    const fn=(restored as unknown as {reconcileRestoredPreparedCandidate?:Consumer}).reconcileRestoredPreparedCandidate;
    const outcome=await (fn ? fn(anchor,request) : legacyProbe(binding,inventory))
      .then(value => ({accepted:true,value}),error => ({accepted:false,error:error.message}));
    if (bytesFault) writeFileSync(bytesFault,saved!);
    vi.restoreAllMocks();
    let journal:unknown=null;
    try {journal=read(`${dir}/candidate-reconciliation.json`);} catch {}
    result={pid:process.pid,outcome,journal,restoreJournal:read(`${dir}/state.json`)};
  }
  save(path!.replace('-request.json','-result.json'),result);
},300_000);
