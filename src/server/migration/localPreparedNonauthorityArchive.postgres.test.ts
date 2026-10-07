// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainColdDatabase, type ColdAnchor } from '@/server/db/testing/coldRestore';
import { backupPreparedDatabase, retainMaterializedBackup, readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
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
async function cold(anchor:ColdAnchor,binding:LocalCandidateBinding,fault?:string) {
  mkdirSync('.task19-physical-results',{recursive:true,mode:0o700});
  const prefix = `.task19-physical-results/${randomUUID()}`;
  writeFileSync(`${prefix}-request.json`,JSON.stringify({anchor,binding,fault}),{flag:'wx',mode:0o600});
  const output = await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19PreparedRestoreChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:'/scratch',LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',TASK19_PHYSICAL_REQUEST:`${prefix}-request.json`},maxBuffer:8_000_000});
  writeFileSync(`${prefix}-process.json`,JSON.stringify({exitCode:0,...output}),{flag:'wx',mode:0o600});
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`,'utf8'))).toMatchObject({numPassedTests:1,numFailedTests:0,success:true});
  const result = JSON.parse(readFileSync(`${prefix}-result.json`,'utf8'));
  expect(result.pid).not.toBe(process.pid);
  return result;
}
const retain = async (f:Awaited<ReturnType<typeof fixture>>) =>
  retainMaterializedBackup(await backupPreparedDatabase(f.source,f.destination,f.intent),policy());
suite('Task19 genuine prepared NONAUTHORITY archive',() => {
  it('archives committed RECONCILING/3 and physically cold restores the exact post-stop image',async () => {
    const f = await fixture(), before = await f.state();
    const prepared = await prepareLocalCandidateTransition(f.intent,f.run());
    const stopped = await f.state(), exact = await readMaterializedRecoveryState(f.destination.owner);
    expect(stopped.local).toEqual(before.local); expect(stopped.source).toEqual(before.source);
    expect((await reconcileLocalPreparedTransition(f.intent,f.sourceLease,f.destinationLease)).disposition).toBe('DURABLE_PREPARED_STOP');
    const dump = vi.spyOn(archive,'dumpOwnedDatabase');
    let anchor:ColdAnchor;
    try {
      anchor = await retain(f);
      expect(dump).toHaveBeenCalledTimes(1);
    } finally { dump.mockRestore(); }
    const expectationPath = `.cold-restore-control/${anchor.id}/expectation.json`;
    const expectationBytes = readFileSync(expectationPath), transport = readFileSync(`.cold-restore-transport/${anchor.id}.sql`);
    expect(sha256(expectationBytes.toString())).toBe(anchor.expectationSha256);
    const {seal} = JSON.parse(expectationBytes.toString());
    expect(sha256(transport.toString())).toBe(seal.digest);
    expect(seal.tables).toEqual(exact.tables); expect(seal.guards).toBe(exact.guards);
    expect(seal.prepared).toMatchObject({contract:'LOCAL_PREPARED_NONAUTHORITY_ARCHIVE_V1',intent:f.intent,
      auditEventId:prepared.auditEventId,receipt:prepared.receipt,sourceFreshness:'NOT_PROVEN',continuousWriterFence:'NOT_PROVEN'});
    expect(seal.prepared.sourceGenerationDigest).toBe(sha256(seal.prepared.sourceGeneration));
    expect(seal.prepared.reportDigest).toBe(f.intent.expectedReportDigest);
    expect(JSON.parse(seal.tables.migration_jobs)).toMatchObject([{status:'RECONCILING',state_version:3}]);
    expect(JSON.parse(seal.tables.audit_events)).toMatchObject([{event_id:prepared.auditEventId,redacted_details:prepared.receipt}]);
    const files = directories();
    await expect(retainColdDatabase(f.destination,f.ownerId,f.binding,policy())).rejects.toThrow();
    expect(directories()).toEqual(files);
    const physical = await Promise.all([f.local,f.source,f.destination].map(archive.inspectArchiveDatabase));
    const restored = await cold(anchor,f.binding);
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
    expect(restored.observed.otherAudits).toEqual([]);
    expect(restored.observed.readOnly).toBe('on'); expect(restored.observed.chronology).toEqual([{same_time:true}]);
    expect(restored.observed.jobs).toMatchObject([{status:'RECONCILING',state_version:3}]);
    expect(restored.observed.audits).toEqual(JSON.parse(seal.tables.audit_events));
    expect(value.readback.tables.migration_local_disposable_database).toEqual([]);
    expect(value.readback.tables.migration_local_materializations).toEqual([]);
    expect(value.readback.tables.migration_full_generations).toEqual([]);
    expect(value.readback.tables.migration_local_restorations).toMatchObject([{authority:'NONAUTHORITY',activation_allowed:false,
      source_database_id:f.destination.runId,backup_digest:seal.digest,provenance:{marker:seal.marker,materialization:seal.receipt,prepared:seal.prepared}}]);
    for (const [name,wire] of Object.entries(seal.tables)) {
      if (['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'].includes(name)) continue;
      expect(value.readback.tables[name],name).toEqual(JSON.parse(wire as string));
    }
    expect(value.readback.guards).toBe(seal.guards);
    const replay = await cold(anchor,f.binding);
    expect(replay.outcome.accepted).toBe(false); expect(replay.dispatched).toBe(false); expect(replay.journal).toEqual(restored.journal);
    await expect(prepareLocalCandidateTransition(f.intent,f.run())).rejects.toThrow();
    await expect(materializeLocalCandidate(f.binding,f.run())).rejects.toThrow();
    expect(readFileSync(expectationPath)).toEqual(expectationBytes);
    expect(readFileSync(`.cold-restore-transport/${anchor.id}.sql`)).toEqual(transport);
    expect(await f.state()).toEqual(stopped); expect(await readMaterializedRecoveryState(f.destination.owner)).toEqual(exact);
    expect(await Promise.all([f.local,f.source,f.destination].map(archive.inspectArchiveDatabase))).toEqual(physical);
    deletionEvidence('genuine-prepared-image',{intent:f.intent,prepared,anchor,seal,exact,stopped,physical,restored,replay});
  },300_000);

  it('refuses an unprepared IMPORTING/2 image through the separate prepared entry',async () => {
    const f=await fixture(), before=await f.state(), files=directories(), dump=vi.spyOn(archive,'dumpOwnedDatabase');
    try { await expect(retain(f)).rejects.toThrow(); expect(dump).not.toHaveBeenCalled(); }
    finally { dump.mockRestore(); }
    expect(directories()).toEqual(files); expect(await f.state()).toEqual(before);
  },150_000);

  it.each(['audit','chronology','job-version','intent-report','intent-materialization','intent-destination','intent-extra',
    'binding-version','source-version','source-private','source-unknown','destination-unknown','destination-foreign',
    'guard-function','guard-rls','guard-trigger','guard-grant','domain','materialization'])('refuses %s before native dump or publication',async fault => {
    const f=await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    if (fault==='audit' || fault==='chronology') {
      await f.destination.owner.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
      await f.destination.owner.query(fault==='audit' ? "UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,'{complete}','true')"
        : "UPDATE audit_events SET occurred_at=occurred_at+interval '1 second'");
      await f.destination.owner.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
    }
    if (fault==='job-version') {
      await f.destination.owner.query('ALTER TABLE migration_jobs DISABLE TRIGGER USER');
      await f.destination.owner.query('UPDATE migration_jobs SET state_version=4');
      await f.destination.owner.query('ALTER TABLE migration_jobs ENABLE TRIGGER USER');
    }
    if (fault==='intent-report') f.intent.expectedReportDigest=sha256('wrong');
    if (fault==='intent-materialization') f.intent.expectedMaterializationDigest=sha256('wrong');
    if (fault==='intent-destination') f.intent.destinationDatabaseId=randomUUID();
    if (fault==='intent-extra') Object.assign(f.intent,{status:'PREPARED'});
    if (fault==='binding-version') f.intent.binding={...f.binding,expectedStateVersion:'5'};
    if (fault==='source-version') await f.source.owner.query("UPDATE migration_jobs SET status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now()");
    if (fault==='source-private') await f.source.owner.query("CREATE TABLE extra_private(payload text); INSERT INTO extra_private VALUES('synthetic sentinel')");
    if (fault==='source-unknown') await f.source.owner.query('CREATE TABLE extra_empty(payload text)');
    if (fault==='destination-unknown') await f.destination.owner.query('CREATE TABLE extra_empty(payload text)');
    if (fault==='destination-foreign') {
      await f.destination.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'foreign','Foreign')",[OTHER]);
      await f.destination.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'foreign','sentinel',1,0)",[OTHER]);
      expect((await f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`SELECT * FROM products WHERE product_id='foreign'`))).rows).toEqual([]);
    }
    if (fault==='guard-function') await f.destination.owner.query("CREATE FUNCTION extra_noop() RETURNS int LANGUAGE sql AS 'SELECT 1'");
    if (fault==='guard-rls') await f.destination.owner.query('ALTER TABLE products DISABLE ROW LEVEL SECURITY');
    if (fault==='guard-trigger') await f.destination.owner.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
    if (fault==='guard-grant') await f.destination.owner.query('GRANT DELETE ON migration_local_materializations TO app_runtime');
    if (fault==='domain') await f.destination.owner.query("UPDATE products SET price=29 WHERE product_id='P1'");
    if (fault==='materialization') {
      await f.destination.owner.query('ALTER TABLE migration_local_materializations DISABLE TRIGGER USER');
      await f.destination.owner.query("UPDATE migration_local_materializations SET domain_readback='{}'");
      await f.destination.owner.query('ALTER TABLE migration_local_materializations ENABLE TRIGGER USER');
    }
    const before=await f.state(), files=directories(), dump=vi.spyOn(archive,'dumpOwnedDatabase');
    try { await expect(retain(f)).rejects.toThrow(); expect(dump).not.toHaveBeenCalled(); }
    finally { dump.mockRestore(); }
    expect(directories()).toEqual(files); expect(await f.state()).toEqual(before);
    deletionEvidence('prepared-admission-negative',{fault,intent:f.intent});
  },150_000);

  it('refuses partial transport and equivocated binding or pin before cold dispatch',async () => {
    const f=await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    const anchor=await retain(f), before=await f.state(), journal=readFileSync(`.cold-restore-control/${anchor.id}/state.json`);
    const changed=await cold(anchor,{...f.binding,manifestDigest:sha256('equivocation')});
    expect(changed.outcome.accepted).toBe(false); expect(changed.dispatched).toBe(false);
    for (const path of [`.cold-restore-transport/${anchor.id}.sql`,`.cold-restore-control/${anchor.id}/expectation.json`]) {
      const bytes=readFileSync(path); writeFileSync(path,bytes.subarray(0,100));
      try { const partial=await cold(anchor,f.binding); expect(partial.outcome.accepted).toBe(false); expect(partial.dispatched).toBe(false); }
      finally { writeFileSync(path,bytes); }
    }
    expect(readFileSync(`.cold-restore-control/${anchor.id}/state.json`)).toEqual(journal);
    expect(await f.state()).toEqual(before);
  },300_000);

  it.each(['partial-sql','postcommit-value'])('rolls back or quarantines genuine prepared %s without a success receipt',async fault => {
    const f=await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    const anchor=await retain(f), before=await f.state(), result=await cold(anchor,f.binding,fault);
    expect(result.dispatched).toBe(true); expect(result.outcome.accepted).toBe(false);
    expect(result.journal.status).toBe(fault==='partial-sql' ? 'READY' : 'QUARANTINED');
    expect(result.journal.lastAttempt.rollbackVerified).toBe(fault==='partial-sql');
    if (fault==='partial-sql') expect(result.observed.publicTables).toEqual([]);
    else { const replay=await cold(anchor,f.binding); expect(replay.outcome.accepted).toBe(false); expect(replay.dispatched).toBe(false); }
    expect(await f.state()).toEqual(before);
    deletionEvidence('prepared-restore-fault',{fault,anchor,result});
  },300_000);
});
