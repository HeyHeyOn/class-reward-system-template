// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainColdDatabase, type ColdAnchor } from '@/server/db/testing/coldRestore';
import { inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';
import { materializeLocalCandidate, prepareLocalCandidateTransition, type LocalCandidateBinding } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, FINAL, STALE, TENANT } from '../../../test-support/task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(cleanupDeleteFixture);
const suite = process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const exec = promisify(execFile);
type Fixture = Awaited<ReturnType<typeof deleteFixture>>;
async function commit(f:Fixture,revision=true) {
  const q=await f.local.owner.connect();
  try {
    await q.query('BEGIN');
    expect((await q.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Products' AND cells->>0='P1' RETURNING cells",
      [JSON.stringify(['P1','Final modified pencil','27','8','TRUE','','school','1']),TENANT])).rowCount).toBe(1);
    expect((await q.query("DELETE FROM task19_delete_rows WHERE tenant=$1 AND tab='Products' AND cells->>0='PX' RETURNING cells",[TENANT])).rowCount).toBe(1);
    if (revision) await q.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1',[TENANT]);
    await q.query('COMMIT');
  } catch (error) {await q.query('ROLLBACK');throw error;} finally {q.release();}
}
async function fixture() {
  const f=await deleteFixture(); await commit(f);
  const candidate=await f.capture(),final=await f.stage(candidate);
  await materializeLocalCandidate(final.binding,f.run());
  await f.destination.owner.query("SELECT setval('transactions_event_sequence_seq',900,true)");
  const before=await f.state();
  // Final domain image, IMPORTING/2 and NONAUTHORITY. This is the actual existing
  // preactivation backup boundary, not an archive of PREPARED/RECONCILING/3.
  const anchor=await retainColdDatabase(f.destination,f.ownerId,final.binding,{retainUntil:Date.now()+60_000,expiresAt:Date.now()+1_800_000});
  expect(await f.state()).toEqual(before);
  const physical=await Promise.all([f.local,f.source,f.destination].map(inspectArchiveDatabase));
  const expected=JSON.parse(readFileSync(`.cold-restore-control/${anchor.id}/expectation.json`,'utf8')).seal;
  expect(expected.originalSourceId).toBe(f.source.runId);
  expect(expected.binding).toEqual(final.binding);
  return {...f,anchor,binding:final.binding,candidate,expected,physical,before};
}
async function cold(anchor:ColdAnchor,binding:LocalCandidateBinding,fault?:string) {
  mkdirSync('.task19-physical-results',{recursive:true,mode:0o700});
  const prefix=`.task19-physical-results/${randomUUID()}`;
  writeFileSync(`${prefix}-request.json`,JSON.stringify({anchor,binding,fault}),{flag:'wx',mode:0o600});
  let output;
  try {
    output=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19PhysicalRestoreChild.test.ts',
      '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
    {env:{PATH:process.env.PATH,HOME:'/scratch',LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',TASK19_PHYSICAL_REQUEST:`${prefix}-request.json`},timeout:180_000,maxBuffer:8_000_000});
  } catch (error) {
    writeFileSync(`${prefix}-process.json`,JSON.stringify({error:String(error),...(error as object)}),{flag:'wx',mode:0o600}); throw error;
  }
  writeFileSync(`${prefix}-process.json`,JSON.stringify({exitCode:0,...output}),{flag:'wx',mode:0o600});
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`,'utf8'))).toMatchObject({numPassedTests:1,numFailedTests:0,success:true});
  const result=JSON.parse(readFileSync(`${prefix}-result.json`,'utf8'));
  expect(result.pid).not.toBe(process.pid);
  console.info('TASK19_PHYSICAL_CHILD',JSON.stringify({prefix,pid:result.pid,fault,accepted:result.outcome.accepted,journal:result.journal.status}));
  return result;
}
async function unchanged(f:Awaited<ReturnType<typeof fixture>>,before=f.before) {
  expect(await f.state()).toEqual(before);
  expect(await Promise.all([f.local,f.source,f.destination].map(inspectArchiveDatabase))).toEqual(f.physical);
}
suite('Task19 final physical restore positive',() => {
  it('cold restores the final modified P1 and deleted PX backup into a physically independent owner without source adoption',async () => {
    const f=await fixture();
    const reports=(await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
    const materialization=(await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
    const intent={binding:f.binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
      expectedDestinationStateVersion:'2',expectedReportDigest:sha256(canonicalJson(reports)),expectedMaterializationDigest:sha256(canonicalJson(materialization))};
    const prepared=await prepareLocalCandidateTransition(intent,f.run());
    expect(prepared).toMatchObject({authority:'NONAUTHORITY',activationAllowed:false,exclusion:'NOT_PROVEN',complete:false});
    const before=await f.state();
    expect(before.source).toEqual(f.before.source); expect(before.local).toEqual(f.before.local);
    const r=await cold(f.anchor,f.binding);
    deletionEvidence('final-physical-positive',{anchor:f.anchor,binding:f.binding,original:f.original,candidate:f.candidate,physical:f.physical,prepared,before,result:r});
    expect(r.outcome.accepted).toBe(true); expect(r.journal.status).toBe('SUCCEEDED');
    const {value}=r.outcome, {observed}=r;
    expect(value.cleanup.containerRemoved).toBe(true); expect(observed.poolsClosed).toBe(true);
    expect(value.ownerId).not.toBe(f.ownerId);
    expect([f.local.runId,f.source.runId,f.destination.runId]).not.toContain(value.databaseId);
    expect(f.physical.map(p => p.id)).not.toContain(value.containerId);
    expect(f.physical.map(p => p.systemIdentifier)).not.toContain(observed.physical.systemIdentifier);
    expect(observed.products).toEqual([{product_id:'P1',name:'Final modified pencil',price:'27',stock:'8'}]);
    expect(observed.role).toEqual([{rolsuper:false,rolbypassrls:false}]);
    expect(observed.otherProducts).toEqual([]); expect(observed.otherReceipts).toEqual([]); expect(observed.marker).toEqual([]);
    const receipt=value.readback.tables.migration_local_restorations[0];
    expect(receipt).toMatchObject({source_database_id:f.destination.runId,destination_database_id:value.databaseId,
      source_owner_id:f.ownerId,destination_owner_id:value.ownerId,authority:'NONAUTHORITY',activation_allowed:false,
      backup_digest:f.expected.digest,provenance:{marker:f.expected.marker,materialization:f.expected.receipt}});
    expect(receipt.provenance.materialization).toMatchObject({source_database_id:f.source.runId,generation_id:f.binding.generationId,
      source_fingerprint:f.binding.sourceFingerprint,manifest_digest:f.binding.manifestDigest});
    for (const [table,wire] of Object.entries(f.expected.tables)) {
      if (['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'].includes(table)) continue;
      expect(value.readback.tables[table],table).toEqual(JSON.parse(wire as string));
    }
    expect(value.readback.guards).toBe(f.expected.guards);
    expect(value.readback.sequences.transactions_event_sequence_seq).toEqual({last_value:'900',is_called:true});
    expect(value.readback.tables.migration_jobs).toMatchObject([{status:'IMPORTING',state_version:2,final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
    expect((await f.destination.owner.query('SELECT status,state_version::text FROM migration_jobs')).rows).toEqual([{status:'RECONCILING',state_version:'3'}]);
    await unchanged(f,before);
    const retry=await cold(f.anchor,f.binding);
    expect(retry.outcome).toEqual({accepted:false,error:'Cold restore refused.'}); expect(retry.dispatched).toBe(false);
    await unchanged(f,before);
  },300_000);
});
suite('Task19 final physical restore negative',() => {
  it.each(['postcommit-value','postcommit-missing','postcommit-resurrect','postcommit-sequence','postcommit-rls'])
    ('quarantines %s instead of accepting intact receipts over a damaged committed restore',async fault => {
      const f=await fixture(),r=await cold(f.anchor,f.binding,fault);
      deletionEvidence('final-physical-postcommit',{fault,result:r,anchor:f.anchor});
      expect(r.dispatched).toBe(true); expect(r.observed.poolsClosed).toBe(true);
      expect(r.outcome).toEqual({accepted:false,error:'Cold restore refused.'});
      expect(r.journal).toMatchObject({status:'QUARANTINED',lastAttempt:{rollbackVerified:false}});
      const retry=await cold(f.anchor,f.binding);
      expect(retry.dispatched).toBe(false); expect(retry.outcome.accepted).toBe(false);
      expect(retry.journal).toEqual(r.journal); await unchanged(f);
    },300_000);
  it('refuses partial SQL in the restore transaction and permits only its verified empty rollback retry',async () => {
    const f=await fixture(),r=await cold(f.anchor,f.binding,'partial-sql');
    expect(r.dispatched).toBe(true); expect(r.outcome.accepted).toBe(false);
    expect(r.observed.publicTables).toEqual([]);
    // Native psql may close stdin before the large remaining SQL is consumed
    // (EPIPE). Exact empty public + authenticated READY is the rollback proof.
    expect(r.journal).toMatchObject({status:'READY',lastAttempt:{rollbackVerified:true,error:expect.any(String)}});
    const retry=await cold(f.anchor,f.binding); expect(retry.outcome.accepted).toBe(true); await unchanged(f);
  },300_000);
  it('refuses an old capture binding and partial transport without source-derived authority or target dispatch',async () => {
    const f=await fixture();
    const stale=await cold(f.anchor,{...f.binding,sourceFingerprint:f.old.sourceFingerprint,manifestDigest:f.old.manifestDigest});
    expect(stale.outcome).toEqual({accepted:false,error:'Cold restore refused.'}); expect(stale.dispatched).toBe(false);
    expect(stale.journal.status).toBe('READY');
    const file=`.cold-restore-transport/${f.anchor.id}.sql`,bytes=readFileSync(file);
    writeFileSync(file,bytes.subarray(0,100));
    try {
      const partial=await cold(f.anchor,f.binding);
      expect(partial.outcome).toEqual({accepted:false,error:'Cold restore refused.'}); expect(partial.dispatched).toBe(false);
      expect(partial.journal).toEqual(stale.journal);
    } finally {writeFileSync(file,bytes);}
    expect((await cold(f.anchor,f.binding)).outcome.accepted).toBe(true); await unchanged(f);
  },300_000);
  it.each(['equivocated','stale'])('refuses %s source capture on the final-to-backup path before retaining any archive',async fault => {
    const f=await deleteFixture(); await commit(f,fault!=='equivocated');
    const candidate=await f.capture(fault==='stale' ? STALE : FINAL);
    const before=await f.state();
    mkdirSync('.cold-restore-control',{recursive:true,mode:0o700}); const files=readdirSync('.cold-restore-control').sort();
    const produce=async () => {
      const {binding}=await f.stage(candidate);
      await materializeLocalCandidate(binding,f.run());
      return retainColdDatabase(f.destination,f.ownerId,binding,{retainUntil:Date.now(),expiresAt:Date.now()+60_000});
    };
    await expect(produce()).rejects.toThrow('Local full-generation stage refused.');
    expect(readdirSync('.cold-restore-control').sort()).toEqual(files); expect(await f.state()).toEqual(before);
    deletionEvidence('final-physical-source-refusal',{fault,original:f.original,candidate,before});
  },150_000);
});
