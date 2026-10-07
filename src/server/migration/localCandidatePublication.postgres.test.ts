// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { retainColdDatabase, type ColdAnchor } from '@/server/db/testing/coldRestore';
import { inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';
import { backupMaterializedDatabase } from '@/server/db/testing/materializedRestore';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import { materializeLocalCandidate, type LocalCandidateBinding } from './localCandidateMaterialization';
import { deleteFixture, deleteState, cleanupDeleteFixture, TENANT, JOB } from '../../../test-support/task19DeleteFixture';
import { forbidMutableWrites } from '../../../test-support/task19MutableFixture';
import { hash, sqlImage, rows, verifySource, verifyDestination } from '../../../test-support/task19PublicationOracle';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); }}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const REFUSED = 'Local candidate domain materialization refused.';
const DIRECTORY = '.task19-publication-results';
afterEach(async () => { vi.restoreAllMocks(); await cleanupDeleteFixture(); });
function evidence(name: string, value: unknown) {
  mkdirSync(DIRECTORY,{recursive:true});
  const path = `${DIRECTORY}/${name}-${randomUUID()}.json`;
  writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600});
  console.info('TASK19_PUBLICATION_WITNESS',JSON.stringify({name,path,sha256:hash(value)}));
}
async function fixture() {
  const f = await deleteFixture();
  await f.commitDelete();
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=$1::jsonb
    WHERE tenant=$2 AND tab='Products' AND cells->>0='P1'`,
    [JSON.stringify(['P1','Publication pencil','31','8','TRUE','','school','1']),TENANT]);
  const {binding,next} = await f.stage(await f.capture());
  const before = await sqlImage(f.source);
  const oracle = verifySource(before,f.old,next);
  return {...f,binding,before,oracle};
}
const bodies = {
  'same-count-value':"UPDATE products SET name='Substituted after receipt' WHERE tenant_id=NEW.tenant_id AND product_id='P1';",
  'omitted-settings':'DELETE FROM tenant_settings WHERE tenant_id=NEW.tenant_id;',
  'resurrect-deleted':"INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,category,sort_order) VALUES(NEW.tenant_id,'PX','Resurrected after receipt',9,0,true,'school',2);",
  'source-binding':"UPDATE migration_jobs SET source_fingerprint=repeat('b',64) WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;",
  'authority':"UPDATE migration_jobs SET final_fingerprint=repeat('c',64),freeze_started_at=created_at,freeze_verified_at=created_at WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;",
  'noop':'PERFORM 1;',
};
async function trigger(f: Awaited<ReturnType<typeof fixture>>, fault: keyof typeof bodies, deferred: boolean) {
  // Native destination owner installs one deterministic fault on the LAST write.
  // No driver mocking, fabricated SQL result, operational role or external DB.
  await f.destination.owner.query(`CREATE SEQUENCE publication_fault_seen;
    CREATE FUNCTION publication_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    BEGIN PERFORM nextval('public.publication_fault_seen'); ${bodies[fault]} RETURN NEW; END $$`);
  await f.destination.owner.query(`CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER publication_fault AFTER INSERT ON migration_local_materializations
    ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW EXECUTE FUNCTION publication_fault()`);
  const details = (await f.destination.owner.query("SELECT pg_get_triggerdef(oid) AS definition,tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='publication_fault'")).rows;
  expect(details).toMatchObject([{tgdeferrable:deferred,tginitdeferred:deferred}]);
  return details;
}
async function dropFault(f: Awaited<ReturnType<typeof fixture>>) {
  await f.destination.owner.query('DROP TRIGGER publication_fault ON migration_local_materializations; DROP FUNCTION publication_fault(); DROP SEQUENCE publication_fault_seen');
}
async function coldChild(anchor: ColdAnchor, binding: LocalCandidateBinding) {
  mkdirSync('.task19-physical-results',{recursive:true});
  const path = `.task19-physical-results/${randomUUID()}-request.json`;
  writeFileSync(path,JSON.stringify({anchor,binding}),{flag:'wx',mode:0o600});
  const command=['node_modules/vitest/vitest.mjs','run','test-support/task19PhysicalRestoreChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${path}-vitest.json`];
  const execution = await new Promise<{code:number;stdout:string;stderr:string}>(resolve => {
    execFile(process.execPath,command,{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME,
      TMPDIR:process.env.TMPDIR,LANG:'C',NODE_ENV:'test',RUN_REAL_POSTGRES:'1',TASK19_PHYSICAL_REQUEST:path},
      timeout:150_000,maxBuffer:24*1024*1024},(error,stdout,stderr) => resolve({code:error ? 1 : 0,stdout,stderr}));
  });
  console.info('TASK19_PUBLICATION_COLD_PROCESS',JSON.stringify(execution));
  expect(execution.code).toBe(0);
  expect(JSON.parse(readFileSync(`${path}-vitest.json`,'utf8'))).toMatchObject({numPassedTests:1,numFailedTests:0,success:true});
  return JSON.parse(readFileSync(path.replace('-request.json','-result.json'),'utf8'));
}
suite('Task19 destination publication boundary', () => {
  const cases = [
    {fault:'same-count-value',deferred:true}, {fault:'omitted-settings',deferred:true},
    {fault:'resurrect-deleted',deferred:true}, {fault:'source-binding',deferred:true},
    {fault:'authority',deferred:true}, {fault:'same-count-value',deferred:false},
  ] as const;
  it.each(cases)('refuses $fault deferred=$deferred at destination publication and retries the exact binding',async ({fault,deferred}) => {
    const f = await fixture(), definition = await trigger(f,fault,deferred);
    const before = {source:await sqlImage(f.source),destination:await sqlImage(f.destination),
      sourceTuples:await deleteState(f.source),destinationTuples:await deleteState(f.destination)};
    const outcome = await materializeLocalCandidate(f.binding,f.run()).then(value => ({accepted:true,value,error:null}),
      (error: Error) => ({accepted:false,value:null,error:error.message}));
    // Independent owner connection AFTER the awaited native COMMIT/ROLLBACK.
    const after = {source:await sqlImage(f.source),destination:await sqlImage(f.destination),
      sourceTuples:await deleteState(f.source),destinationTuples:await deleteState(f.destination)};
    const archive = outcome.accepted ? await backupMaterializedDatabase(f.destination,f.ownerId,f.binding)
      .then(() => ({accepted:true,error:null}),(error: Error) => ({accepted:false,error:error.message})) : null;
    const reached = (await f.destination.owner.query('SELECT last_value::text,is_called FROM publication_fault_seen')).rows;
    evidence(`${deferred ? 'deferred' : 'immediate'}-${fault}`,{binding:f.binding,definition,triggerBody:bodies[fault],reached,
      physical:{source:f.source.evidence,destination:f.destination.evidence},before,after,outcome,archive,sourceOracle:f.oracle});
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
    expect(outcome).toEqual({accepted:false,value:null,error:REFUSED});
    expect(after).toEqual(before);
    await dropFault(f);
    const retried = await materializeLocalCandidate(f.binding,f.run());
    const destination = await sqlImage(f.destination);
    verifyDestination(destination,f.binding,f.source.runId,f.destination.runId,f.ownerId);
    expect(retried).toMatchObject({authority:'NONAUTHORITY',activationAllowed:false,complete:false});
    await forbidMutableWrites(f.destination);
    expect(await materializeLocalCandidate(f.binding,f.run())).toEqual(retried);
    expect(await sqlImage(f.destination)).toEqual(destination);
    expect(await sqlImage(f.source)).toEqual(before.source);
    expect(await deleteState(f.source)).toEqual(before.sourceTuples);
    evidence(`retry-${fault}-${deferred}`,{binding:f.binding,retried,source:await sqlImage(f.source),destination});
  },180_000);

  it('publishes full modified/deleted graph across transactions and independently restores after both source databases are removed',async () => {
    const f = await fixture();
    const definition = await trigger(f,'noop',true);
    const sourceBefore = await sqlImage(f.source), sourceTuples = await deleteState(f.source);
    const transactions: unknown[] = [];
    const lease = (db: typeof f.source) => ({kind:'SYNTHETIC_DISPOSABLE' as const,ownerId:f.ownerId,databaseId:db.runId,
      queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),
      runTransaction:((tenant,callback) => db.runTenantTransaction(tenant,async tx => {
        transactions.push({databaseId:db.runId,...(await tx.execute(sql`SELECT pg_backend_pid() AS backend,txid_current()::text AS xid`)).rows[0]});
        return callback(tx);
      })) as typeof db.runTenantTransaction});
    const stagedTransaction = (await f.source.owner.query('SELECT xmin::text AS xid FROM migration_full_generations')).rows[0];
    const result = await materializeLocalCandidate(f.binding,createOwnedLocalMaterializationRunner(TENANT,JOB,lease(f.source),lease(f.destination)));
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).not.toMatchObject(stagedTransaction);
    const destination = await sqlImage(f.destination);
    const oracle = verifyDestination(destination,f.binding,f.source.runId,f.destination.runId,f.ownerId);
    expect(await sqlImage(f.source)).toEqual(sourceBefore); expect(await deleteState(f.source)).toEqual(sourceTuples);
    const first = await materializeLocalCandidate(f.binding,f.run());
    expect(first).toEqual(result); expect(await sqlImage(f.destination)).toEqual(destination);
    const reached = (await f.destination.owner.query('SELECT last_value::text,is_called FROM publication_fault_seen')).rows;
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
    await dropFault(f);
    const archived = await sqlImage(f.destination);
    const physical = await Promise.all([f.local,f.source,f.destination].map(inspectArchiveDatabase));
    const anchor = await retainColdDatabase(f.destination,f.ownerId,f.binding,{retainUntil:Date.now()+60_000,expiresAt:Date.now()+1_800_000});
    {
      const cleanup = {local:await f.local.close(),source:await f.source.close(),destination:await f.destination.close()};
      expect(cleanup.local.containerRemoved).toBe(true);
      expect(cleanup.source.containerRemoved).toBe(true); expect(cleanup.destination.containerRemoved).toBe(true);
      const cold = await coldChild(anchor,f.binding);
      evidence('cold-positive',{binding:f.binding,definition,reached,transactions,stagedTransaction,sourceBefore,sourceOracle:f.oracle,
        destination,oracle,archived,cleanup,physical,anchor,cold});
      expect(cold.pid).not.toBe(process.pid); expect(cold.outcome.accepted).toBe(true);
      expect(cold.journal.status).toBe('SUCCEEDED'); expect(cold.dispatched).toBe(true);
      expect(cold.observed.products).toEqual([{product_id:'P1',name:'Publication pencil',price:'31',stock:'8'}]);
      expect(physical.map(value => value.systemIdentifier)).not.toContain(cold.observed.physical.systemIdentifier);
      expect(cold.observed.otherProducts).toEqual([]); expect(cold.observed.otherReceipts).toEqual([]);
      expect(cold.observed.role).toEqual([{rolsuper:false,rolbypassrls:false}]);
      const restored = cold.outcome.value.readback.tables as Record<string,unknown[]>;
      for (const [table,values] of Object.entries(archived)) {
        if (['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'].includes(table)) continue;
        expect(restored[table],table).toEqual(values.map(value => JSON.parse(value)));
      }
      expect(cold.observed.receipts).toMatchObject([{source_database_id:f.destination.runId,
        destination_database_id:cold.outcome.value.databaseId,tenant_id:TENANT,job_id:JOB,
        authority:'NONAUTHORITY',activation_allowed:false,provenance:{materialization:oracle.receipt}}]);
      // No source graph is reconstructed from domain rows; literal deleted PX
      // remains absent, exact domain rows and IMPORTING/non-authority bind survive.
      expect(rows(archived,'migration_full_targets')).toEqual([]);
      expect(cold.outcome.value.cleanup.containerRemoved).toBe(true);
    }
  },240_000);
});
