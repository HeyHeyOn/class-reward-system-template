// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainColdDatabase, type ColdAnchor } from '@/server/db/testing/coldRestore';
import { readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { materializeLocalCandidate, prepareLocalCandidateTransition, reconcileLocalPreparedTransition, type LocalCandidateBinding } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, OTHER, TENANT } from '../../../test-support/task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(cleanupDeleteFixture);
const suite = process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const exec = promisify(execFile);
const policy = () => ({retainUntil:Date.now()+60_000,expiresAt:Date.now()+3_600_000});
const directories = () => Object.fromEntries(['.cold-restore-control','.cold-restore-transport'].map(path =>
  [path,existsSync(path) ? readdirSync(path).sort() : []]));
async function fixture() {
  const f = await deleteFixture(), q = await f.local.owner.connect();
  try {
    await q.query('BEGIN');
    expect((await q.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Products' AND cells->>0='P1' RETURNING cells",
      [JSON.stringify(['P1','Final modified pencil','27','8','TRUE','','school','1']),TENANT])).rowCount).toBe(1);
    expect((await q.query("DELETE FROM task19_delete_rows WHERE tenant=$1 AND tab='Products' AND cells->>0='PX' RETURNING cells",[TENANT])).rowCount).toBe(1);
    await q.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1',[TENANT]);
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const candidate = await f.capture(), {binding} = await f.stage(candidate);
  await materializeLocalCandidate(binding,f.run());
  const reports = (await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent = {binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
    expectedDestinationStateVersion:'2',expectedReportDigest:sha256(canonicalJson(reports)),expectedMaterializationDigest:sha256(canonicalJson(materialization))};
  const lease = (db:typeof f.source) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId:f.ownerId,
    queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
  return {...f,binding,intent,candidate,sourceLease:lease(f.source),destinationLease:lease(f.destination)};
}
async function cold(anchor:ColdAnchor,binding:LocalCandidateBinding) {
  mkdirSync('.task19-physical-results',{recursive:true,mode:0o700});
  const prefix = `.task19-physical-results/${randomUUID()}`;
  writeFileSync(`${prefix}-request.json`,JSON.stringify({anchor,binding}),{flag:'wx',mode:0o600});
  const output = await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19PhysicalRestoreChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:'/scratch',LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',TASK19_PHYSICAL_REQUEST:`${prefix}-request.json`},maxBuffer:8_000_000});
  writeFileSync(`${prefix}-process.json`,JSON.stringify({exitCode:0,...output}),{flag:'wx',mode:0o600});
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`,'utf8'))).toMatchObject({numPassedTests:1,numFailedTests:0,success:true});
  const result = JSON.parse(readFileSync(`${prefix}-result.json`,'utf8'));
  expect(result.pid).not.toBe(process.pid);
  return result;
}
suite('Task19 prepared archive boundary',() => {
  it('proves the genuine prepared backup blocker without relabeling the earlier cold image',async () => {
    const f = await fixture(), before = await f.state();
    const early = await retainColdDatabase(f.destination,f.ownerId,f.binding,policy());
    const expectationPath = `.cold-restore-control/${early.id}/expectation.json`;
    const expectationBytes = readFileSync(expectationPath), transport = readFileSync(`.cold-restore-transport/${early.id}.sql`);
    expect(sha256(expectationBytes.toString())).toBe(early.expectationSha256);
    const {seal} = JSON.parse(expectationBytes.toString());
    expect(sha256(transport.toString())).toBe(seal.digest);
    const prepared = await prepareLocalCandidateTransition(f.intent,f.run());
    expect(prepared).toMatchObject({scope:'LOCAL_PREPARED_STOP',status:'RECONCILING',stateVersion:'3',authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
    const stopped = await f.state(), exact = await readMaterializedRecoveryState(f.destination.owner);
    expect(stopped.local).toEqual(before.local); expect(stopped.source).toEqual(before.source);
    expect(JSON.parse(exact.tables.migration_jobs)).toMatchObject([{status:'RECONCILING',state_version:3,final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
    expect(JSON.parse(exact.tables.audit_events)).toMatchObject([{event_id:prepared.auditEventId,redacted_details:prepared.receipt}]);
    expect((await f.destination.owner.query('SELECT a.occurred_at=j.updated_at AS same_time FROM audit_events a JOIN migration_jobs j USING(tenant_id,job_id)')).rows).toEqual([{same_time:true}]);
    expect((await reconcileLocalPreparedTransition(f.intent,f.sourceLease,f.destinationLease)).disposition).toBe('DURABLE_PREPARED_STOP');
    const files = directories(), dump = vi.spyOn(archive,'dumpOwnedDatabase');
    let blocked;
    try {
      blocked = await retainColdDatabase(f.destination,f.ownerId,f.binding,policy()).then(anchor => ({accepted:true,anchor}),error => ({accepted:false,error:(error as Error).message}));
      expect(blocked).toEqual({accepted:false,error:'Local disposable PostgreSQL restore refused.'});
      expect(dump).not.toHaveBeenCalled();
    } finally { dump.mockRestore(); }
    expect(directories()).toEqual(files);
    await expect(prepareLocalCandidateTransition(f.intent,f.run())).rejects.toThrow('Local prepared transition refused.');
    await expect(materializeLocalCandidate(f.binding,f.run())).rejects.toThrow();
    await expect(f.destination.owner.query("UPDATE audit_events SET event_type='RELABEL' WHERE event_id=$1",[prepared.auditEventId])).rejects.toThrow(/immutable/i);
    await expect(f.destination.owner.query('UPDATE migration_local_materializations SET activation_allowed=true')).rejects.toThrow(/immutable/i);
    expect((await f.destination.runTenantTransaction(OTHER,tx => tx.execute(sql`SELECT * FROM products`))).rows).toEqual([]);
    expect((await f.destination.runTenantTransaction(OTHER,tx => tx.execute(sql`SELECT * FROM audit_events`))).rows).toEqual([]);
    const physical = await Promise.all([f.local,f.source,f.destination].map(archive.inspectArchiveDatabase));
    const restored = await cold(early,f.binding);
    expect(restored.outcome.accepted).toBe(true); expect(restored.journal.status).toBe('SUCCEEDED');
    const {value} = restored.outcome;
    expect(restored.observed.poolsClosed).toBe(true); expect(value.cleanup.containerRemoved).toBe(true);
    expect(physical.map(p => p.id)).not.toContain(value.containerId);
    expect(physical.map(p => p.systemIdentifier)).not.toContain(restored.observed.physical.systemIdentifier);
    expect([f.local.runId,f.source.runId,f.destination.runId]).not.toContain(value.databaseId);
    expect(value.ownerId).not.toBe(f.ownerId);
    expect(restored.observed.products).toEqual([{product_id:'P1',name:'Final modified pencil',price:'27',stock:'8'}]);
    expect(restored.observed.role).toEqual([{rolsuper:false,rolbypassrls:false}]);
    expect(restored.observed.otherProducts).toEqual([]); expect(restored.observed.otherReceipts).toEqual([]);
    expect(value.readback.tables.migration_local_disposable_database).toEqual([]);
    expect(value.readback.tables.migration_local_materializations).toEqual([]);
    expect(value.readback.tables.migration_jobs).toMatchObject([{status:'IMPORTING',state_version:2}]);
    expect(value.readback.tables.audit_events).toEqual([]);
    expect(value.readback.tables.migration_local_restorations).toMatchObject([{authority:'NONAUTHORITY',activation_allowed:false,
      source_database_id:f.destination.runId,backup_digest:seal.digest,provenance:{marker:seal.marker,materialization:seal.receipt}}]);
    for (const [name,wire] of Object.entries(seal.tables)) {
      if (['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'].includes(name)) continue;
      expect(value.readback.tables[name],name).toEqual(JSON.parse(wire as string));
    }
    expect(value.readback.guards).toBe(seal.guards);
    const replay = await cold(early,f.binding);
    expect(replay.outcome).toEqual({accepted:false,error:'Cold restore refused.'}); expect(replay.dispatched).toBe(false);
    expect(replay.journal).toEqual(restored.journal);
    expect(readFileSync(expectationPath)).toEqual(expectationBytes);
    expect(readFileSync(`.cold-restore-transport/${early.id}.sql`)).toEqual(transport);
    expect(await f.state()).toEqual(stopped);
    expect(await readMaterializedRecoveryState(f.destination.owner)).toEqual(exact);
    expect(await Promise.all([f.local,f.source,f.destination].map(archive.inspectArchiveDatabase))).toEqual(physical);
    deletionEvidence('prepared-archive-blocker',{intent:f.intent,prepared,blocked,early,seal,exact,stopped,physical,restored,replay});
  },300_000);

  it('refuses caller PREPARED labels before sealing an IMPORTING image',async () => {
    const f = await fixture(), before = await f.state(), files = directories();
    const binding = {...f.binding,archiveBoundary:{status:'RECONCILING',stateVersion:'3',scope:'LOCAL_PREPARED_STOP'}};
    const outcome = await retainColdDatabase(f.destination,f.ownerId,binding,policy()).then(anchor => ({accepted:true,anchor}),error => ({accepted:false,error:(error as Error).message}));
    const proof = outcome.accepted && 'anchor' in outcome ? JSON.parse(readFileSync(`.cold-restore-control/${outcome.anchor!.id}/expectation.json`,'utf8')) : null;
    deletionEvidence('prepared-archive-label',{binding,outcome,proof});
    expect(await f.state()).toEqual(before);
    expect(outcome).toEqual({accepted:false,error:'Local disposable PostgreSQL restore refused.'});
    expect(directories()).toEqual(files);
  },150_000);

  it.each(['receipt','version','chronology'])('refuses tampered actual prepared stop %s without archive publication',async fault => {
    const f = await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    if (fault==='version') {
      await f.destination.owner.query('ALTER TABLE migration_jobs DISABLE TRIGGER USER');
      await f.destination.owner.query('UPDATE migration_jobs SET state_version=4');
      await f.destination.owner.query('ALTER TABLE migration_jobs ENABLE TRIGGER USER');
    } else {
      await f.destination.owner.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      if (fault==='receipt') await f.destination.owner.query("UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,'{stateVersion}','\"2\"')");
      else await f.destination.owner.query("UPDATE audit_events SET occurred_at=occurred_at+interval '1 second'");
      await f.destination.owner.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
    }
    const before = await f.state(), files = directories();
    await expect(reconcileLocalPreparedTransition(f.intent,f.sourceLease,f.destinationLease)).rejects.toThrow('Local prepared reconciliation refused.');
    await expect(retainColdDatabase(f.destination,f.ownerId,f.binding,policy())).rejects.toThrow('Local disposable PostgreSQL restore refused.');
    expect(directories()).toEqual(files); expect(await f.state()).toEqual(before);
    deletionEvidence('prepared-archive-tamper',{fault,intent:f.intent,before});
  },150_000);

  it('refuses partial archive and equivocated stop binding before cold dispatch',async () => {
    const f = await fixture(), anchor = await retainColdDatabase(f.destination,f.ownerId,f.binding,policy());
    await prepareLocalCandidateTransition(f.intent,f.run());
    const before = await f.state(), statePath = `.cold-restore-control/${anchor.id}/state.json`, journal = readFileSync(statePath);
    const changed = await cold(anchor,{...f.binding,manifestDigest:sha256('equivocated prepared binding')});
    expect(changed.outcome).toEqual({accepted:false,error:'Cold restore refused.'}); expect(changed.dispatched).toBe(false);
    const path = `.cold-restore-transport/${anchor.id}.sql`, bytes = readFileSync(path);
    writeFileSync(path,bytes.subarray(0,100));
    let partial;
    try {
      partial = await cold(anchor,f.binding);
      expect(partial.outcome).toEqual({accepted:false,error:'Cold restore refused.'}); expect(partial.dispatched).toBe(false);
    } finally { writeFileSync(path,bytes); }
    expect(readFileSync(statePath)).toEqual(journal); expect(await f.state()).toEqual(before);
    deletionEvidence('prepared-archive-transport',{anchor,changed,partial,before});
  },300_000);
});
