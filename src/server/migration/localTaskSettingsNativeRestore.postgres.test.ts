// @vitest-environment node
// Synthetic Task21 native restore only; no source adoption or authority transition.
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupPreparedDatabase, readMaterializedRecoveryState, retainMaterializedBackup } from '@/server/db/testing/materializedRestore';
import type { ColdAnchor } from '@/server/db/testing/coldRestore';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { materializeLocalCandidate, prepareLocalCandidateTransition, reconcileLocalPreparedTransition, type LocalCandidateBinding } from './localCandidateMaterialization';
import { projectLegacyStagingGraph } from './importer';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, TENANT, OTHER } from '../../../test-support/task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(cleanupDeleteFixture);
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const exec = promisify(execFile);
const flags = { authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' };
function absent(id: string) {
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'ps', '-aq', '--no-trunc', '--filter', `id=${id}`],
    { env: { PATH: process.env.PATH, HOME: '/scratch', DOCKER_CONFIG: '/scratch', LANG: 'C', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
}
async function cold(anchor: ColdAnchor, binding: LocalCandidateBinding, fault?: string) {
  // Reuse the existing independent native psql consumer, not a JSON importer.
  mkdirSync('.task19-physical-results', { recursive: true, mode: 0o700 });
  const prefix = `.task19-physical-results/${randomUUID()}`;
  writeFileSync(`${prefix}-request.json`, JSON.stringify({ anchor, binding, fault }), { flag: 'wx', mode: 0o600 });
  let output;
  try {
    output = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19PreparedRestoreChild.test.ts',
      '--maxWorkers=1', '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${prefix}-vitest.json`],
    { env: { PATH: process.env.PATH, HOME: '/scratch', LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1',
      TASK19_PHYSICAL_REQUEST: `${prefix}-request.json` }, timeout: 180_000, maxBuffer: 8_000_000 });
  } catch (error) {
    writeFileSync(`${prefix}-process.json`, JSON.stringify({ error: String(error), ...(error as object) }), { flag: 'wx', mode: 0o600 });
    throw error;
  }
  writeFileSync(`${prefix}-process.json`, JSON.stringify({ exitCode: 0, ...output }), { flag: 'wx', mode: 0o600 });
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`, 'utf8'))).toMatchObject({ success: true, numPassedTests: 1, numFailedTests: 0 });
  const result = JSON.parse(readFileSync(`${prefix}-result.json`, 'utf8'));
  expect(result.pid).not.toBe(process.pid);
  if (result.journal.lastAttempt?.containerId) absent(result.journal.lastAttempt.containerId);
  console.info('TASK21_TASK_SETTINGS_CHILD', JSON.stringify({ prefix, pid: result.pid, fault, outcome: result.outcome.accepted,
    journal: result.journal.status, resultSha256: sha256(readFileSync(`${prefix}-result.json`, 'utf8')) }));
  return result;
}
async function fixture() {
  const f = await deleteFixture();
  const task = [...f.original.sheets.tabs.Tasks.rows[0].cells];
  for (const [key, value] of Object.entries({ title: 'Read together', reward: '12', allowedStudentIds: '' })) {
    task[f.original.sheets.tabs.Tasks.headers.indexOf(key)] = value;
  }
  expect((await f.local.owner.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Tasks' AND ordinal=1 RETURNING cells",
    [JSON.stringify(task), TENANT])).rowCount).toBe(1);
  expect((await f.local.owner.query(`UPDATE task19_delete_rows SET cells=jsonb_set(cells,'{1}','"green"')
    WHERE tenant=$1 AND tab='Settings' AND cells->>0='themeColor' RETURNING cells`, [TENANT])).rowCount).toBe(1);
  await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
  const candidate = await f.capture(), { binding, next } = await f.stage(candidate);
  const before = await f.state();
  await materializeLocalCandidate(binding, f.run());
  const reports = (await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent = { binding, ownerId: f.ownerId, sourceDatabaseId: f.source.runId, destinationDatabaseId: f.destination.runId,
    expectedDestinationStateVersion: '2', expectedReportDigest: sha256(canonicalJson(reports)), expectedMaterializationDigest: sha256(canonicalJson(materialization)) };
  const prepared = await prepareLocalCandidateTransition(intent, f.run());
  expect(prepared).toMatchObject({ ...flags, status: 'RECONCILING', stateVersion: '3' });
  const lease = (db: typeof f.source) => ({ kind: 'SYNTHETIC_DISPOSABLE' as const, databaseId: db.runId, ownerId: f.ownerId,
    queryOwner: (text: string, values?: unknown[]) => db.owner.query(text, values), runTransaction: db.runTenantTransaction });
  expect(await reconcileLocalPreparedTransition(intent, lease(f.source), lease(f.destination)))
    .toMatchObject({ ...flags, disposition: 'DURABLE_PREPARED_STOP' });
  const stopped = await f.state();
  expect(stopped.source).toEqual(before.source); expect(stopped.local).toEqual(before.local);
  const source = await readMaterializedRecoveryState(f.source.owner), destination = await readMaterializedRecoveryState(f.destination.owner);
  const deltas = JSON.parse(source.tables.migration_full_delta_entries);
  expect(deltas.map((row: { target_table: string; change_kind: string }) => [row.target_table, row.change_kind]).sort())
    .toEqual([['settings', 'MUTATED'], ['task_allowed_students', 'REMOVED'], ['tasks', 'MUTATED']]);
  for (const row of deltas) for (const [side, manifest] of [['before', f.old], ['after', next]] as const) {
    const graph = projectLegacyStagingGraph(manifest);
    const target = graph.targets.find(value => value.table === row.target_table && value.id === row.target_id)?.value ?? null;
    expect(row.entry_value[`${side}Digest`]).toBe(target && sha256(canonicalJson(target)));
    if (!target) expect(row.entry_value[side]).toBeNull();
    else {
      const mappings = manifest.mappings.flatMap((mappingValue, mappingOrdinal) => mappingValue.targetTable === row.target_table
        && mappingValue.targetId === row.target_id ? [{ mappingValue, mappingOrdinal }] : []);
      const contributors = graph.contributors.filter(value => mappings.some(mapping => mapping.mappingOrdinal === value.mappingOrdinal));
      const sources = manifest.sourceRecords.flatMap((sourceValue, sourceOrdinal) => contributors.some(value => value.sourceOrdinal === sourceOrdinal)
        ? [{ sourceValue, sourceOrdinal }] : []);
      expect(mappings.length).toBeGreaterThan(0); expect(sources.length).toBeGreaterThan(0);
      expect(row.entry_value[side]).toEqual({ target, mappings, contributors, sources });
    }
  }
  const generation = JSON.parse(source.tables.migration_full_generations)[0];
  const audits = JSON.parse(source.tables.audit_events);
  for (const [id, acquisition, manifest] of [[generation.original_generation_id, f.original, f.old],
    [generation.candidate_generation_id, candidate, next]] as const) {
    const payload = audits.find((row: { event_id: string }) => row.event_id === id).redacted_details;
    expect(payload.acquisition).toEqual(acquisition); expect(payload.manifest).toEqual(manifest);
  }
  expect(JSON.parse(source.tables.tasks)).toMatchObject([{ task_instance_id: 'TI1', title: 'Homework', reward: 10 }]);
  expect(JSON.parse(source.tables.task_allowed_students)).toMatchObject([{ task_instance_id: 'TI1', student_id: 'S1' }]);
  expect(JSON.parse(source.tables.tenant_settings)[0].settings.themeColor).toBe('blue');
  const dump = vi.spyOn(archive, 'dumpOwnedDatabase');
  let anchor: ColdAnchor;
  try {
    const backup = await backupPreparedDatabase(f.source, f.destination, intent);
    expect(dump).toHaveBeenCalledTimes(1); expect(dump.mock.calls[0][0]).toBe(f.destination);
    anchor = await retainMaterializedBackup(backup, { retainUntil: Date.now() + 60_000, expiresAt: Date.now() + 3_600_000 });
  } finally { dump.mockRestore(); }
  expect(await f.state()).toEqual(stopped);
  const expectation = readFileSync(`.cold-restore-control/${anchor.id}/expectation.json`);
  expect(sha256(expectation.toString())).toBe(anchor.expectationSha256);
  const { seal } = JSON.parse(expectation.toString());
  const bytes = readFileSync(`.cold-restore-transport/${anchor.id}.sql`);
  expect(sha256(bytes.toString())).toBe(seal.digest); expect(bytes.toString()).toContain('PostgreSQL database dump');
  const physical = await Promise.all([f.local, f.source, f.destination].map(archive.inspectArchiveDatabase));
  const cleanup = [];
  for (const db of [f.local, f.source, f.destination]) {
    cleanup.push(await db.close());
    await expect(db.owner.query('SELECT 1')).rejects.toThrow();
  }
  expect(cleanup.every(row => row.containerRemoved && row.scratchRemoved)).toBe(true);
  for (const pin of physical) absent(pin.id);
  // No fixture handles/captures are sent to the child. Only original anchor + binding.
  return { anchor, binding, intent, prepared, source, destination, physical, seal, expectation, bytes, cleanup,
    ownerId: f.ownerId, sourceId: f.source.runId, destinationId: f.destination.runId, localId: f.local.runId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function preserved(f: Fixture) {
  for (const pin of f.physical) absent(pin.id);
  expect(readFileSync(`.cold-restore-control/${f.anchor.id}/expectation.json`)).toEqual(f.expectation);
  expect(readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`)).toEqual(f.bytes);
}
suite('Task21 Tasks/Settings native restore with disposed originals', () => {
  it('retains exact original SQL, archive and delta provenance after a closed-source prepared native restore', async () => {
    const f = await fixture(), r = await cold(f.anchor, f.binding);
    expect(r.outcome.accepted, r.outcome.error).toBe(true); expect(r.journal.status).toBe('SUCCEEDED');
    const { value } = r.outcome;
    expect(value.cleanup).toMatchObject({ containerRemoved: true, scratchRemoved: true });
    expect(r.observed.poolsClosed).toBe(true); expect(r.observed.readOnly).toBe('on');
    expect(f.physical.map(pin => pin.id)).not.toContain(value.containerId);
    expect(f.physical.map(pin => pin.systemIdentifier)).not.toContain(r.observed.physical.systemIdentifier);
    expect([f.localId, f.sourceId, f.destinationId]).not.toContain(value.databaseId); expect(value.ownerId).not.toBe(f.ownerId);
    expect(r.observed.backend.pid).not.toBe(r.observed.oldBackend);
    expect(r.observed.tasks).toEqual([{ task_instance_id: 'TI1', title: 'Read together', reward: '12' }]);
    expect(r.observed.allowedStudents).toEqual([]);
    expect(r.observed.settings).toEqual(JSON.parse(f.destination.tables.tenant_settings).map((row: { settings: unknown }) => ({ settings: row.settings })));
    expect(r.observed.otherTasks).toEqual([]); expect(r.observed.otherSettings).toEqual([]); expect(r.observed.otherAllowedStudents).toEqual([]);
    expect(r.observed.otherReceipts).toEqual([]); expect(r.observed.role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const receipt = value.readback.tables.migration_local_restorations[0];
    expect(receipt).toMatchObject({ source_database_id: f.destinationId, destination_database_id: value.databaseId,
      source_owner_id: f.ownerId, destination_owner_id: value.ownerId, authority: 'NONAUTHORITY', activation_allowed: false,
      backup_digest: f.seal.digest, provenance: { materialization: { source_database_id: f.sourceId }, prepared: { intent: f.intent } } });
    for (const [table, wire] of Object.entries(f.destination.tables)) {
      if (['migration_local_disposable_database', 'migration_local_materializations', 'migration_local_restore_databases', 'migration_local_restorations'].includes(table)) continue;
      expect(value.readback.tables[table], table).toEqual(JSON.parse(wire));
    }
    expect(value.readback.guards).toBe(f.destination.guards);
    for (const [name, wire] of Object.entries(f.destination.sequences)) expect(value.readback.sequences[name]).toEqual(JSON.parse(wire)[0]);
    expect(value.readback.tables.migration_jobs).toMatchObject([{ status: 'RECONCILING', state_version: 3, final_fingerprint: null,
      freeze_started_at: null, freeze_verified_at: null, completed_at: null }]);
    expect(value.readback.tables.migration_local_disposable_database).toEqual([]);
    expect(value.readback.tables.migration_local_materializations).toEqual([]);
    const replay = await cold(f.anchor, f.binding);
    expect(replay.dispatched).toBe(false); expect(replay.outcome.accepted).toBe(false); expect(replay.journal).toEqual(r.journal);
    preserved(f);
    deletionEvidence('task21-tasks-native-positive', { anchor: f.anchor, binding: f.binding, intent: f.intent,
      source: f.source, destination: f.destination, physical: f.physical, cleanup: f.cleanup, result: r, replay });
    // Behavioral RED: the earlier native restore succeeds but has only this
    // source digest. Its discarded original/audit/delta body cannot be recovered.
    const retained = receipt.provenance.prepared;
    expect(retained.sourceTables, 'closed-source original/archive/delta SQL evidence must survive restoration').toEqual(f.source.tables);
    expect(sha256(canonicalJson(retained.sourceTables))).toBe(retained.sourceTablesDigest);
    expect(retained.sourceTables.migration_full_generations).toBe(retained.sourceGeneration);
    expect(r.observed.receipts[0].provenance.prepared.sourceTables).toEqual(f.source.tables);
  }, 300_000);

  it('rejects substituted tenant/source/version/digest or damaged transport before any cold dispatch', async () => {
    const f = await fixture(), statePath = `.cold-restore-control/${f.anchor.id}/state.json`, state = readFileSync(statePath);
    for (const patch of [{ tenantId: OTHER }, { sourceFingerprint: sha256('wrong source') }, { expectedStateVersion: '99' },
      { manifestDigest: sha256('wrong manifest') }]) {
      const r = await cold(f.anchor, { ...f.binding, ...patch });
      expect(r.outcome).toEqual({ accepted: false, error: 'Cold restore refused.' }); expect(r.dispatched).toBe(false);
      expect(readFileSync(statePath)).toEqual(state);
    }
    for (const patch of [{ ownerId: randomUUID() }, { expectationSha256: sha256('wrong expectation') }]) {
      const r = await cold({ ...f.anchor, ...patch }, f.binding);
      expect(r.outcome.accepted).toBe(false); expect(r.dispatched).toBe(false); expect(readFileSync(statePath)).toEqual(state);
    }
    for (const path of [`.cold-restore-control/${f.anchor.id}/expectation.json`, `.cold-restore-transport/${f.anchor.id}.sql`]) {
      const bytes = readFileSync(path); writeFileSync(path, bytes.subarray(0, 100));
      try {
        const r = await cold(f.anchor, f.binding);
        expect(r.outcome.accepted).toBe(false); expect(r.dispatched).toBe(false); expect(readFileSync(statePath)).toEqual(state);
      } finally { writeFileSync(path, bytes); }
    }
    expect((await cold(f.anchor, f.binding)).outcome.accepted).toBe(true); preserved(f);
  }, 300_000);

  it('rolls back partial native SQL to exact empty public and restores only on its admitted fresh-target retry', async () => {
    const f = await fixture(), r = await cold(f.anchor, f.binding, 'partial-sql');
    expect(r.dispatched).toBe(true); expect(r.outcome.accepted).toBe(false); expect(r.observed.publicTables).toEqual([]);
    expect(r.journal).toMatchObject({ status: 'READY', lastAttempt: { rollbackVerified: true } });
    const retry = await cold(f.anchor, f.binding);
    expect(retry.outcome.accepted).toBe(true);
    expect(retry.outcome.value.databaseId).not.toBe(r.journal.lastAttempt.targetId);
    expect(retry.outcome.value.containerId).not.toBe(r.journal.lastAttempt.containerId);
    preserved(f); deletionEvidence('task21-tasks-native-rollback', { anchor: f.anchor, result: r, retry });
  }, 300_000);

  it.each(['postcommit-task', 'postcommit-settings', 'postcommit-allowed-edge', 'postcommit-source-evidence'])
    ('quarantines actual %s damage without publishing success or replay', async fault => {
      const f = await fixture(), r = await cold(f.anchor, f.binding, fault);
      expect(r.dispatched).toBe(true); expect(r.observed.poolsClosed).toBe(true); expect(r.observed.faultRows).toBe(1);
      expect(r.outcome).toEqual({ accepted: false, error: 'Cold restore refused.' });
      expect(r.journal).toMatchObject({ status: 'QUARANTINED', lastAttempt: { rollbackVerified: false } });
      const retry = await cold(f.anchor, f.binding);
      expect(retry.dispatched).toBe(false); expect(retry.outcome.accepted).toBe(false); expect(retry.journal).toEqual(r.journal);
      preserved(f); deletionEvidence('task21-tasks-native-damage', { fault, anchor: f.anchor, result: r, retry });
    }, 300_000);
});
