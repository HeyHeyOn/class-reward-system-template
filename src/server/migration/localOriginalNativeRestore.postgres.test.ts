// @vitest-environment node
// ORIGINAL importer-mirror recovery, never an operational source rollback.
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupOriginalDatabase, readMaterializedRecoveryState, retainMaterializedBackup } from '@/server/db/testing/materializedRestore';
import type { ColdAnchor } from '@/server/db/testing/coldRestore';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { materializeLocalCandidate, prepareLocalCandidateTransition, type LocalCandidateBinding } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, TENANT, OTHER } from '../../../test-support/task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(cleanupDeleteFixture);
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const exec = promisify(execFile);
function absent(id: string) {
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'ps', '-aq', '--no-trunc', '--filter', `id=${id}`],
    { env: { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
}
async function cold(anchor: ColdAnchor, binding: LocalCandidateBinding, fault?: string) {
  mkdirSync('.task19-physical-results', { recursive: true, mode: 0o700 });
  const prefix = `.task19-physical-results/${randomUUID()}`;
  writeFileSync(`${prefix}-request.json`, JSON.stringify({ anchor, binding, fault, original: true }), { flag: 'wx', mode: 0o600 });
  const output = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19PreparedRestoreChild.test.ts',
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${prefix}-vitest.json`],
    { env: { PATH: process.env.PATH, HOME: '/scratch', LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1',
      TASK19_PHYSICAL_REQUEST: `${prefix}-request.json` }, timeout: 180_000, maxBuffer: 8_000_000 });
  writeFileSync(`${prefix}-process.json`, JSON.stringify({ exitCode: 0, ...output }), { flag: 'wx', mode: 0o600 });
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`, 'utf8'))).toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0 });
  const result = JSON.parse(readFileSync(`${prefix}-result.json`, 'utf8'));
  expect(result.pid).not.toBe(process.pid);
  if (result.journal.lastAttempt?.containerId) absent(result.journal.lastAttempt.containerId);
  console.info('TASK21_ORIGINAL_CHILD', JSON.stringify({ prefix, pid: result.pid, accepted: result.outcome.accepted, journal: result.journal.status }));
  return result;
}
async function fixture() {
  const f = await deleteFixture();
  const task = [...f.original.sheets.tabs.Tasks.rows[0].cells];
  for (const [key, value] of Object.entries({ title: 'Read together', reward: '12', allowedStudentIds: '' })) task[f.original.sheets.tabs.Tasks.headers.indexOf(key)] = value;
  await f.local.owner.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Tasks' AND ordinal=1", [JSON.stringify(task), TENANT]);
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=jsonb_set(cells,'{1}','"green"') WHERE tenant=$1 AND tab='Settings' AND cells->>0='themeColor'`, [TENANT]);
  await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
  const { binding } = await f.stage(await f.capture());
  await materializeLocalCandidate(binding, f.run());
  const reports = (await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent = { binding, ownerId: f.ownerId, sourceDatabaseId: f.source.runId, destinationDatabaseId: f.destination.runId,
    expectedDestinationStateVersion: '2', expectedReportDigest: sha256(canonicalJson(reports)), expectedMaterializationDigest: sha256(canonicalJson(materialization)) };
  expect(await prepareLocalCandidateTransition(intent, f.run())).toMatchObject({ authority: 'NONAUTHORITY', activationAllowed: false, complete: false, status: 'RECONCILING', stateVersion: '3' });
  // Non-default, bigint-exact original sequence state must come from native SQL.
  await f.source.owner.query("SELECT setval('transactions_event_sequence_seq',9007199254741003,false)");
  const source = await readMaterializedRecoveryState(f.source.owner), candidate = await readMaterializedRecoveryState(f.destination.owner);
  const before = await f.state();
  const backup = await backupOriginalDatabase(f.source, f.destination, intent);
  const anchor = await retainMaterializedBackup(backup, { retainUntil: Date.now() + 60_000, expiresAt: Date.now() + 3_600_000 });
  expect(await f.state()).toEqual(before);
  const expectation = readFileSync(`.cold-restore-control/${anchor.id}/expectation.json`), { seal } = JSON.parse(expectation.toString());
  const bytes = readFileSync(`.cold-restore-transport/${anchor.id}.sql`);
  expect(sha256(bytes.toString())).toBe(seal.digest); expect(bytes.toString()).toContain('PostgreSQL database dump');
  const physical = [];
  for (const db of [f.local, f.source, f.destination]) {
    physical.push(await archive.inspectArchiveDatabase(db));
    expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
    await expect(db.owner.query('SELECT 1')).rejects.toThrow();
  }
  for (const pin of physical) absent(pin.id);
  return { anchor, binding, intent, source, candidate, physical, seal, expectation, bytes };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function preserved(f: Fixture) {
  for (const pin of f.physical) absent(pin.id);
  expect(readFileSync(`.cold-restore-control/${f.anchor.id}/expectation.json`)).toEqual(f.expectation);
  expect(readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`)).toEqual(f.bytes);
}
suite('Task21 independent ORIGINAL native recovery', () => {
  it('restores ORIGINAL native SQL rather than candidate SQL or retained evidence JSON', async () => {
    const f = await fixture(), r = await cold(f.anchor, f.binding);
    expect(r.outcome.accepted, r.outcome.error).toBe(true); expect(r.journal.status).toBe('SUCCEEDED');
    const { value } = r.outcome;
    // Baseline genuinely restores a CANDIDATE successfully, but fails here.
    expect(r.observed.tasks, 'native ORIGINAL SQL is not candidate SQL').toEqual([{ task_instance_id: 'TI1', title: 'Homework', reward: '10' }]);
    expect(r.observed.allowedStudents).toEqual([{ task_instance_id: 'TI1', student_id: 'S1' }]);
    expect(r.observed.settings[0].settings.themeColor).toBe('blue');
    expect(r.observed.poolsClosed).toBe(true); expect(r.observed.readOnly).toBe('on');
    expect(r.observed.sourceReuseRefused).toBe(true);
    expect(f.physical.map(pin => pin.systemIdentifier)).not.toContain(r.observed.physical.systemIdentifier);
    expect(f.physical.map(pin => pin.id)).not.toContain(value.containerId);
    expect([f.intent.sourceDatabaseId, f.intent.destinationDatabaseId]).not.toContain(value.databaseId);
    expect(value.ownerId).not.toBe(f.intent.ownerId);
    for (const [table, wire] of Object.entries(f.source.tables)) {
      if (table==='migration_local_restore_databases') continue;
      expect(value.readback.tables[table], table).toEqual(JSON.parse(wire));
    }
    expect(value.readback.guards).toBe(f.source.guards);
    for (const [name, wire] of Object.entries(f.source.sequences)) expect(value.readback.sequences[name]).toEqual(JSON.parse(wire)[0]);
    expect(value.readback.sequences.transactions_event_sequence_seq).toEqual({ last_value: '9007199254741003', is_called: false });
    expect(value.readback.tables.migration_jobs).toMatchObject([{ status: 'READY', state_version: Number(f.binding.expectedStateVersion), final_fingerprint: null, completed_at: null }]);
    expect(value.readback.tables.tenants).toMatchObject([{ lifecycle: 'IMPORTING' }]);
    const receipt = value.readback.originalRestorations[0];
    expect(receipt).toMatchObject({ source_database_id: f.intent.sourceDatabaseId, destination_database_id: value.databaseId,
      backup_digest: f.seal.digest, authority: 'NONAUTHORITY', activation_allowed: false,
      provenance: { original: { contract: 'LOCAL_ORIGINAL_NONAUTHORITY_ARCHIVE_V1', candidateDatabaseId: f.intent.destinationDatabaseId,
        candidateTablesDigest: sha256(canonicalJson(f.candidate.tables)), prepared: { intent: f.intent, sourceTables: f.source.tables } } } });
    expect(receipt.provenance.prepared).toBeUndefined(); // Not a prepared-candidate seal.
    expect(value.readback.tables.tasks).not.toEqual(JSON.parse(f.candidate.tables.tasks));
    expect(JSON.parse(f.candidate.tables.migration_full_generations)).toEqual([]);
    expect(value.readback.tables.migration_full_generations).toEqual(JSON.parse(f.source.tables.migration_full_generations));
    expect(r.observed.otherTasks).toEqual([]); expect(r.observed.otherSettings).toEqual([]); expect(r.observed.otherReceipts).toEqual([]);
    // Copied original identity is history, not a new SOURCE enrollment.
    expect(r.observed.marker[0].database_id).toBe(f.intent.sourceDatabaseId);
    expect(r.observed.marker[0].database_id).not.toBe(value.databaseId);
    expect(value.readback.tables.migration_local_materializations).toEqual([]);
    expect(value.readback.tables.migration_local_restore_databases).toMatchObject([{ state: 'RESTORED_NONAUTHORITY' }]);
    expect(value.result).toMatchObject({ authority: 'NONAUTHORITY', activationAllowed: false });
    const replay = await cold(f.anchor, f.binding);
    expect(replay.dispatched).toBe(false); expect(replay.outcome.accepted).toBe(false); expect(replay.journal).toEqual(r.journal);
    preserved(f); deletionEvidence('task21-original-native-positive', { anchor: f.anchor, binding: f.binding, intent: f.intent,
      source: f.source, candidate: f.candidate, physical: f.physical, result: r, replay });
  }, 300_000);

  it('rejects wrong tenant/source/job/version/digest and corrupt or substituted native backups before dispatch', async () => {
    const f = await fixture(), statePath = `.cold-restore-control/${f.anchor.id}/state.json`, state = readFileSync(statePath);
    for (const patch of [{ tenantId: OTHER }, { sourceFingerprint: sha256('wrong source') }, { migrationJobId: 'wrong job' },
      { generationId: 'wrong generation' }, { expectedStateVersion: '99' }, { manifestDigest: sha256('wrong manifest') }]) {
      const r = await cold(f.anchor, { ...f.binding, ...patch });
      expect(r.outcome.accepted).toBe(false); expect(r.dispatched).toBe(false); expect(readFileSync(statePath)).toEqual(state);
    }
    for (const patch of [{ ownerId: randomUUID() }, { expectationSha256: sha256('wrong expectation') }]) {
      const r = await cold({ ...f.anchor, ...patch }, f.binding);
      expect(r.outcome.accepted).toBe(false); expect(r.dispatched).toBe(false); expect(readFileSync(statePath)).toEqual(state);
    }
    const other = await fixture();
    for (const bad of [f.bytes.subarray(0, 100), other.bytes]) {
      expect(bad).not.toEqual(f.bytes);
      writeFileSync(`.cold-restore-transport/${f.anchor.id}.sql`, bad);
      try {
        const r = await cold(f.anchor, f.binding);
        expect(r.outcome.accepted).toBe(false); expect(r.dispatched).toBe(false); expect(readFileSync(statePath)).toEqual(state);
      } finally { writeFileSync(`.cold-restore-transport/${f.anchor.id}.sql`, f.bytes); }
    }
    const path = `.cold-restore-control/${f.anchor.id}/expectation.json`;
    writeFileSync(path, f.expectation.subarray(0, 100));
    try { const r = await cold(f.anchor, f.binding); expect(r.dispatched).toBe(false); expect(r.outcome.accepted).toBe(false); }
    finally { writeFileSync(path, f.expectation); }
    expect((await cold(f.anchor, f.binding)).outcome.accepted).toBe(true); preserved(f); preserved(other);
  }, 300_000);

  it('rolls partial SQL back without reactivating the closed source and retries only a fresh owned destination', async () => {
    const f = await fixture(), r = await cold(f.anchor, f.binding, 'partial-sql');
    expect(r.dispatched).toBe(true); expect(r.outcome.accepted).toBe(false); expect(r.observed.publicTables).toEqual([]);
    expect(r.journal).toMatchObject({ status: 'READY', lastAttempt: { rollbackVerified: true } });
    const retry = await cold(f.anchor, f.binding);
    expect(retry.outcome.accepted).toBe(true);
    expect(retry.outcome.value.databaseId).not.toBe(r.journal.lastAttempt.targetId);
    expect(retry.outcome.value.containerId).not.toBe(r.journal.lastAttempt.containerId);
    preserved(f); deletionEvidence('task21-original-native-rollback', { anchor: f.anchor, result: r, retry });
  }, 300_000);

  it.each(['postcommit-task', 'postcommit-sequence', 'postcommit-rls', 'post-original-receipt-guard'])('quarantines original %s damage after COMMIT with no replay', async fault => {
    const f = await fixture(), r = await cold(f.anchor, f.binding, fault);
    expect(r.dispatched).toBe(true); expect(r.outcome.accepted).toBe(false); expect(r.observed.poolsClosed).toBe(true);
    expect(r.journal).toMatchObject({ status: 'QUARANTINED', lastAttempt: { rollbackVerified: false } });
    const retry = await cold(f.anchor, f.binding);
    expect(retry.dispatched).toBe(false); expect(retry.outcome.accepted).toBe(false); expect(retry.journal).toEqual(r.journal);
    preserved(f); deletionEvidence('task21-original-native-damage', { fault, anchor: f.anchor, result: r, retry });
  }, 300_000);
});
