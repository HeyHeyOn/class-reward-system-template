// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageLegacyFinalGeneration } from './finalGeneration';
import { prepareLocalCandidateTransition, type LocalCandidateBinding, type LocalPreparedTransitionIntent } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, INITIAL, FINAL, STALE, TENANT, OTHER } from '../../../test-support/task19DeleteFixture';
import { APPLICATION, denyWrites, witness } from '../../../test-support/task19MixedCold';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(cleanupDeleteFixture);
const suite = process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const exec = promisify(execFile);
type Fixture = Awaited<ReturnType<typeof deleteFixture>>;
type Variant = 'pair'|'mutation'|'deletion';

// Commit changes to a third, editable owned PG database. source remains the
// exact ORIGINAL import mirror; do not pretend that mirror is live source truth.
async function commit(f:Fixture,variant:Variant,advanceRevision=true) {
  const client = await f.local.owner.connect();
  try {
    await client.query('BEGIN');
    if (variant!=='deletion') expect((await client.query(`UPDATE task19_delete_rows SET cells=$1::jsonb
      WHERE tenant=$2 AND tab='Products' AND cells->>0='P1' RETURNING cells`,
    [JSON.stringify(['P1','Final modified pencil','27','8','TRUE','','school','1']),TENANT])).rowCount).toBe(1);
    if (variant!=='mutation') expect((await client.query("DELETE FROM task19_delete_rows WHERE tenant=$1 AND tab='Products' AND cells->>0='PX' RETURNING cells",[TENANT])).rowCount).toBe(1);
    // Deliberately broken source-revision publication for negative fixtures.
    // Both subsequent capture reads still return the same real DB checkpoint.
    if (advanceRevision) await client.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1',[TENANT]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  expect((await f.local.owner.query("SELECT cells FROM task19_delete_rows WHERE tenant=$1 AND tab='Products' AND ordinal>0 ORDER BY ordinal",[OTHER])).rows)
    .toEqual([{cells:['PX','Other tenant sentinel','9','0','TRUE','','school','2']}]);
}
async function cold(f:Fixture,phase:'pointer'|'materialize'|'prepared',binding?:LocalCandidateBinding,intent?:LocalPreparedTransitionIntent) {
  mkdirSync('.task19-final-reconcile',{recursive:true,mode:0o700});
  const prefix = `.task19-final-reconcile/${randomUUID()}`;
  const pin = async (db:Fixture['source']) => ({databaseId:db.runId,containerId:String(db.evidence.containerId),imageId:String(db.evidence.imageId),
    systemIdentifier:(await db.owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id});
  writeFileSync(`${prefix}-request.json`,JSON.stringify({source:await pin(f.source),destination:await pin(f.destination),ownerId:f.ownerId,phase,binding,intent}),{flag:'wx',mode:0o600});
  const child = await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19FinalReconcileChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:'/scratch',LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',TASK19_FINAL_RECONCILE_REQUEST:`${prefix}-request.json`},
    timeout:150_000,maxBuffer:8_000_000});
  writeFileSync(`${prefix}-process.json`,JSON.stringify({exitCode:0,...child}),{flag:'wx',mode:0o600});
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`,'utf8'))).toMatchObject({numPassedTests:1,numFailedTests:0,success:true});
  const result = JSON.parse(readFileSync(`${prefix}-result.json`,'utf8'));
  expect(result.pid).not.toBe(process.pid); expect(result.poolsClosed).toBe(true);
  for (const db of [f.source,f.destination]) expect((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[APPLICATION])).rows).toEqual([]);
  console.info('TASK19_FINAL_RECONCILE_COLD',JSON.stringify({phase,prefix,...result}));
  return result;
}
const faults = [
  {name:'same revision modified and deleted',variant:'pair',advance:false,at:FINAL},
  {name:'same revision modified only',variant:'mutation',advance:false,at:FINAL},
  {name:'same revision deleted only',variant:'deletion',advance:false,at:FINAL},
  {name:'older modified only',variant:'mutation',advance:true,at:STALE},
] as const;

suite('Task19 final source consistency negative',() => {
  it.each(faults)('refuses $name before persisting candidate evidence',async fault => {
    const f = await deleteFixture(); await commit(f,fault.variant,fault.advance);
    const candidate = await f.capture(fault.at),before = await f.state();
    const outcome = await f.stage(candidate).then(value => ({accepted:true,value}),error => ({accepted:false,error:(error as Error).message}));
    const after = await f.state();
    deletionEvidence('final-consistency-admission',{fault,original:f.original,candidate,before,after,outcome});
    expect(outcome).toEqual({accepted:false,error:'Local full-generation stage refused.'});
    expect(after).toEqual(before);
  },120_000);

  it.each(faults)('cold refuses retained $name envelopes without repairing or inferring source truth',async fault => {
    const f = await deleteFixture(); await commit(f,fault.variant,fault.advance);
    const candidate = await f.capture(fault.at);
    // The pre-existing low-level untrusted archive API remains unchanged. This
    // reproduces legacy stored evidence without mocking/weakening any local gate.
    await stageLegacyFinalGeneration(f.input(candidate),{runTransaction:f.source.runTenantTransaction});
    await denyWrites(f.source); await denyWrites(f.destination);
    const before = await f.state(),result = await cold(f,'pointer');
    expect(await f.state()).toEqual(before);
    deletionEvidence('final-consistency-cold',{fault,original:f.original,candidate,before,result});
    expect(result.outcome).toEqual({accepted:false,error:'Local pointer-checked preparation refused.'});
  },240_000);
});

suite('Task19 final source consistency positive',() => {
  it('preserves the committed modification and deletion through cold materialization and uncertain PREPARED recovery',async () => {
    const f = await deleteFixture();
    const initialCandidate = await f.capture(INITIAL);
    expect(initialCandidate.sheets.tabs.Products.rows.map(row => row.cells[0])).toEqual(['P1','PX']);
    await commit(f,'pair');
    const candidate = await f.capture(),final = await f.stage(candidate);
    expect(candidate.sheets.sourceRevision).toBe('2');
    const delta = (await f.source.owner.query('SELECT target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_id')).rows;
    expect(delta.map(row => [row.target_id,row.change_kind])).toEqual([['P1','MUTATED'],['PX','REMOVED']]);
    expect(delta[0].entry_value.before.target).toEqual(f.old.records.products.find(row => row.productId==='P1'));
    expect(delta[0].entry_value.after.target).toEqual(final.next.records.products[0]);
    expect(delta[1].entry_value.after).toBeNull(); expect(delta[1].entry_value.afterDigest).toBeNull();
    expect((await f.source.owner.query('SELECT product_id,name FROM products ORDER BY product_id')).rows)
      .toEqual([{product_id:'P1',name:'Pencil'},{product_id:'PX',name:'Delete me'}]);
    await denyWrites(f.source);
    const sourceBefore = await witness(f.source),localBefore = (await f.state()).local;
    const imported = await cold(f,'materialize',final.binding);
    expect(imported.outcome).toMatchObject({accepted:true,value:{authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'}});
    const products = (await f.destination.owner.query('SELECT product_id,name,price::text,stock::text FROM products ORDER BY product_id')).rows;
    expect(products).toEqual([{product_id:'P1',name:'Final modified pencil',price:'27',stock:'8'}]);
    const reports = (await f.source.owner.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
      FROM migration_full_reconciliation ORDER BY category`)).rows;
    const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
    const intent = {binding:final.binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
      expectedDestinationStateVersion:'2',expectedReportDigest:sha256(canonicalJson(reports)),expectedMaterializationDigest:sha256(canonicalJson(materialization))};
    let committed = false;
    const run = f.run();
    await expect(prepareLocalCandidateTransition(intent,async (tenant,callback) => {
      await run(tenant,callback); committed = true;
      throw new Error('Synthetic application acknowledgement lost after destination COMMIT');
    })).rejects.toThrow('Local prepared transition refused.');
    expect(committed).toBe(true);
    expect((await f.destination.owner.query('SELECT status,state_version::text,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
      .toEqual([{status:'RECONCILING',state_version:'3',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
    await denyWrites(f.destination);
    const before = await f.state();
    const recovered = await cold(f,'prepared',final.binding,intent),retry = await cold(f,'prepared',final.binding,intent);
    expect(recovered.outcome).toMatchObject({accepted:true,value:{disposition:'DURABLE_PREPARED_STOP',authority:'NONAUTHORITY',activationAllowed:false,
      complete:false,exclusion:'NOT_PROVEN',repeatMutationAllowed:false,rollbackAllowed:false}});
    expect(retry.outcome).toEqual(recovered.outcome); expect(retry.pid).not.toBe(recovered.pid);
    expect(await f.state()).toEqual(before); expect(await witness(f.source)).toBe(sourceBefore); expect(before.local).toEqual(localBefore);
    deletionEvidence('final-consistency-positive',{initialCandidate,candidate,final,delta,products,imported,recovered,retry,before});
  },300_000);

  it('permits an identical source revision recaptured later without mistaking capture digest changes for content changes',async () => {
    const f = await deleteFixture(),candidate = await f.capture(FINAL);
    expect(candidate.sheets.sourceRevision).toBe(f.original.sheets.sourceRevision);
    expect(candidate.sheets.digest).not.toBe(f.original.sheets.digest);
    expect(candidate.sheets.tabs).toEqual(f.original.sheets.tabs);
    const final = await f.stage(candidate);
    const before = await f.state();
    await denyWrites(f.source);
    const result = await cold(f,'materialize',final.binding);
    expect(result.outcome).toMatchObject({accepted:true,value:{authority:'NONAUTHORITY',activationAllowed:false}});
    expect((await f.destination.owner.query('SELECT product_id,name FROM products ORDER BY product_id')).rows)
      .toEqual([{product_id:'P1',name:'Pencil'},{product_id:'PX',name:'Delete me'}]);
    expect((await f.state()).source).toEqual(before.source);
  },240_000);
});
