// @vitest-environment node
// A generated SQL workbook, never original/student data or an external reader.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteFixture, cleanupDeleteFixture, deleteState, TENANT, OTHER, JOB } from '../../../test-support/task19DeleteFixture';
import { inspectLegacyFinalGeneration } from './finalGeneration';
import { projectLegacyStagingGraph } from './importer';
import { LOCAL_DELTA_COVERAGE_CATALOG } from './localFullCategoryDeltaCoverage';
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';
import { materializeLocalCandidate, prepareLocalCandidateTransition, reconcileLocalPreparedTransition } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
afterEach(cleanupDeleteFixture);
const flags = { authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' };

async function fixture() {
  const f = await deleteFixture();
  // Edit only the generated workbook. The original imported DB is immutable.
  const task = [...f.original.sheets.tabs.Tasks.rows[0].cells];
  for (const [key, value] of Object.entries({ title: 'Read together', reward: '12', allowedStudentIds: '' })) {
    task[f.original.sheets.tabs.Tasks.headers.indexOf(key)] = value;
  }
  expect((await f.local.owner.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Tasks' AND ordinal=1 RETURNING cells",
    [JSON.stringify(task), TENANT])).rows).toHaveLength(1);
  expect((await f.local.owner.query(`UPDATE task19_delete_rows SET cells=jsonb_set(cells,'{1}','"green"')
    WHERE tenant=$1 AND tab='Settings' AND cells->>0='themeColor' RETURNING cells`, [TENANT])).rows).toHaveLength(1);
  await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
  const candidate = await f.capture(), input = f.input(candidate), before = await f.state();
  await expect(stageLocalFullDeltaCheckedPreparation(input, f.source.runTenantTransaction))
    .rejects.toThrow('Local full-delta-checked preparation refused.');
  expect(await f.state()).toEqual(before); // intentional ADDED-only contract stays closed
  const { binding, staged, next } = await f.stage(candidate);
  expect(staged).toMatchObject({ ...flags, scope: 'LOCAL_FULL_MUTABLE_SNAPSHOT', persistedReadback: 'MATCH' });
  const prepared = await inspectLegacyFinalGeneration(input, f.source.runTenantTransaction);
  expect(prepared.plan).toMatchObject({ status: 'DIFF_VALIDATED', blockers: [] });
  expect(prepared.plan.changes.map(row => [row.table, row.identity, row.kind])).toEqual([
    ['settings', '["themeColor"]', 'MUTATED'], ['task_allowed_students', '["TI1","S1"]', 'REMOVED'], ['tasks', '["TI1"]', 'MUTATED'],
  ]);
  // Exact retained acquisitions and original binding, not a synthesized MATCH.
  for (const [id, acquisition, manifest] of [[prepared.originalGenerationId, f.original, f.old],
    [prepared.candidateGenerationId, candidate, next]] as const) {
    const archive = (await f.source.owner.query('SELECT redacted_details FROM audit_events WHERE event_id=$1', [id])).rows[0].redacted_details;
    expect(archive.acquisition).toEqual(acquisition); expect(archive.manifest).toEqual(manifest);
    const originalPins = { tenantId: TENANT, migrationJobId: JOB,
      originalSourceId: input.originalSourceId, originalSnapshotId: input.originalSnapshotId };
    if (id === prepared.originalGenerationId) expect(archive).toMatchObject({ ...originalPins, phase: 'ORIGINAL_PREFLIGHT' });
    else expect(archive.binding).toMatchObject({ ...originalPins, expectedStateVersion: binding.expectedStateVersion,
      originalSourceFingerprint: f.old.sourceFingerprint });
  }
  const deltas = (await f.source.owner.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_table,target_id')).rows;
  expect(deltas).toHaveLength(3);
  for (const entry of deltas) {
    for (const [side, manifest] of [['before', f.old], ['after', next]] as const) {
      const graph = projectLegacyStagingGraph(manifest);
      const target = graph.targets.find(row => row.table === entry.target_table && row.id === entry.target_id)?.value ?? null;
      expect(entry.entry_value[`${side}Digest`]).toBe(target && sha256(canonicalJson(target)));
      if (!target) { expect(entry.entry_value[side]).toBeNull(); continue; }
      const mappings = manifest.mappings.flatMap((mappingValue, mappingOrdinal) => mappingValue.targetTable === entry.target_table
        && mappingValue.targetId === entry.target_id ? [{ mappingValue, mappingOrdinal }] : []);
      const contributors = graph.contributors.filter(row => mappings.some(mapping => mapping.mappingOrdinal === row.mappingOrdinal));
      const sources = manifest.sourceRecords.flatMap((sourceValue, sourceOrdinal) => contributors.some(row => row.sourceOrdinal === sourceOrdinal)
        ? [{ sourceValue, sourceOrdinal }] : []);
      expect(mappings.length).toBeGreaterThan(0); expect(sources.length).toBeGreaterThan(0);
      expect(entry.entry_value[side]).toEqual({ target, mappings, contributors, sources });
    }
  }
  const reports = (await f.source.owner.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
    FROM migration_full_reconciliation WHERE generation_id=$1 ORDER BY category`, [binding.generationId])).rows;
  expect(reports.map(row => row.category)).toEqual([...LOCAL_DELTA_COVERAGE_CATALOG.map(row => row.table),
    'SOURCE_RECORDS', 'MAPPINGS', 'CONTRIBUTORS', 'DELTA_ENTRIES'].sort());
  for (const report of reports) {
    expect(report.status).toBe('MATCH'); expect(report.expected_count).toBe(report.observed_count);
    expect(report.expected_digest).toBe(report.observed_digest);
  }
  expect(reports.find(row => row.category === 'task_allowed_students').expected_count).toBe(0);
  for (const table of ['task_assignments', 'task_completions', 'transactions', 'transaction_items', 'adjustments',
    'legacy_operation_bindings', 'padlet_evidence_claims']) expect(next.records[table]).toEqual(f.old.records[table]);
  const lease = (db: typeof f.source) => ({ kind: 'SYNTHETIC_DISPOSABLE' as const, databaseId: db.runId, ownerId: f.ownerId,
    queryOwner: (text: string, values?: unknown[]) => db.owner.query(text, values), runTransaction: db.runTenantTransaction });
  console.info('TASK19_TASK_SETTINGS_GRAPH', JSON.stringify({ binding, plan: prepared.plan, deltas, reports }));
  return { ...f, binding, reports, next, sourceLease: lease(f.source), destinationLease: lease(f.destination) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function intent(f: Fixture) {
  const receipt = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  return { binding: f.binding, ownerId: f.ownerId, sourceDatabaseId: f.source.runId, destinationDatabaseId: f.destination.runId,
    expectedDestinationStateVersion: '2', expectedReportDigest: sha256(canonicalJson(f.reports)), expectedMaterializationDigest: sha256(canonicalJson(receipt)) };
}
async function exactDomain(f: Fixture) {
  expect((await f.destination.owner.query('SELECT task_instance_id,title,reward::text FROM tasks')).rows)
    .toEqual([{ task_instance_id: 'TI1', title: 'Read together', reward: '12' }]);
  expect((await f.destination.owner.query('SELECT * FROM task_allowed_students')).rows).toEqual([]);
  expect((await f.destination.owner.query('SELECT settings FROM tenant_settings')).rows)
    .toEqual([{ settings: Object.fromEntries(f.next.records.settings.map(row => [row.key, row.value])) }]);
  expect((await f.source.owner.query('SELECT task_instance_id,title,reward::text FROM tasks')).rows)
    .toEqual([{ task_instance_id: 'TI1', title: 'Homework', reward: '10' }]);
  expect((await f.source.owner.query('SELECT task_instance_id,student_id FROM task_allowed_students')).rows)
    .toEqual([{ task_instance_id: 'TI1', student_id: 'S1' }]);
  expect((await f.source.owner.query("SELECT settings->>'themeColor' AS theme FROM tenant_settings")).rows).toEqual([{ theme: 'blue' }]);
}

suite('Task19 Tasks/Settings mixed graph and late materialization fault', () => {
  it('retains exact original/archive images and candidate domain through prepared NONAUTHORITY STOP', async () => {
    const f = await fixture(), before = await f.state();
    const result = await materializeLocalCandidate(f.binding, f.run());
    expect(result).toMatchObject({ ...flags, binding: f.binding });
    await exactDomain(f);
    const materialized = await f.state();
    expect(materialized.source).toEqual(before.source); expect(materialized.local).toEqual(before.local);
    expect(await materializeLocalCandidate(f.binding, f.run())).toEqual(result); expect(await f.state()).toEqual(materialized);
    const bound = await intent(f), stop = await prepareLocalCandidateTransition(bound, f.run());
    expect(stop).toMatchObject({ ...flags, preparation: 'PREPARED_STOP_REQUIRED', status: 'RECONCILING', stateVersion: '3' });
    const after = await f.state();
    expect(after.source).toEqual(before.source); expect(after.local).toEqual(before.local);
    expect(Object.keys(materialized.destination).filter(key => canonicalJson(materialized.destination[key]) !== canonicalJson(after.destination[key])).sort())
      .toEqual(['audit_events', 'migration_jobs']);
    expect(await reconcileLocalPreparedTransition(bound, f.sourceLease, f.destinationLease))
      .toMatchObject({ ...flags, disposition: 'DURABLE_PREPARED_STOP', repeatMutationAllowed: false, rollbackAllowed: false });
    expect(await f.state()).toEqual(after); await exactDomain(f);
    await expect(prepareLocalCandidateTransition(bound, f.run())).rejects.toThrow();
    expect(await f.state()).toEqual(after);
    console.info('TASK19_TASK_SETTINGS_STOP', JSON.stringify({ bound, stop, sourceBefore: sha256(canonicalJson(before.source)),
      sourceAfter: sha256(canonicalJson(after.source)), localBefore: sha256(canonicalJson(before.local)), localAfter: sha256(canonicalJson(after.local)) }));
  }, 120_000);

  it.each(['task', 'settings', 'removed-edge', 'job'] as const)('refuses actual %s drift caused by the final receipt INSERT and rolls back the whole destination', async fault => {
    const f = await fixture();
    const statements = {
      task: "UPDATE tasks SET reward=999 WHERE tenant_id=NEW.tenant_id AND task_instance_id='TI1'",
      settings: "UPDATE tenant_settings SET settings=jsonb_set(settings,'{themeColor}','\"wrong\"') WHERE tenant_id=NEW.tenant_id",
      'removed-edge': "INSERT INTO task_allowed_students(tenant_id,task_instance_id,student_id) VALUES(NEW.tenant_id,'TI1','S1')",
      job: "UPDATE migration_jobs SET final_fingerprint=repeat('a',64) WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id",
    };
    // Real immediate AFTER trigger, not mocked query results or deferred COMMIT.
    // A nontransactional sequence witnesses that exactly one native row changed
    // even when the destination transaction later rolls back.
    await f.destination.owner.query(`CREATE SEQUENCE task19_late_fault_seen;
      CREATE FUNCTION task19_late_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      DECLARE affected integer; BEGIN
        ${statements[fault]}; GET DIAGNOSTICS affected = ROW_COUNT;
        IF affected <> 1 THEN RAISE EXCEPTION 'late fault did not alter one row'; END IF;
        PERFORM nextval('public.task19_late_fault_seen'); RETURN NEW;
      END $$;
      CREATE TRIGGER task19_late_fault AFTER INSERT ON migration_local_materializations FOR EACH ROW EXECUTE FUNCTION task19_late_fault()`);
    const before = await f.state();
    const outcome = await materializeLocalCandidate(f.binding, f.run()).then(value => ({ accepted: true, value }),
      (error: Error) => ({ accepted: false, error: error.message }));
    const after = await f.state();
    const dispatched = (await f.destination.owner.query('SELECT last_value::text,is_called FROM task19_late_fault_seen')).rows;
    console.info('TASK19_TASK_SETTINGS_LATE_FAULT', JSON.stringify({ fault, binding: f.binding, outcome, dispatched,
      beforeDigest: sha256(canonicalJson(before)), afterDigest: sha256(canonicalJson(after)),
      observed: { tasks: after.destination.tasks, settings: after.destination.tenant_settings,
        allowed: after.destination.task_allowed_students, job: after.destination.migration_jobs } }));
    expect(dispatched).toEqual([{ last_value: '1', is_called: true }]);
    expect(outcome).toEqual({ accepted: false, error: 'Local candidate domain materialization refused.' });
    expect(after).toEqual(before);
    expect((await f.destination.owner.query('SELECT * FROM migration_local_materializations')).rows).toEqual([]);
    // Explicitly remove only this fixture's injected fault; do not repair rows.
    await f.destination.owner.query('DROP TRIGGER task19_late_fault ON migration_local_materializations');
    const clean = await materializeLocalCandidate(f.binding, f.run());
    expect(clean).toMatchObject(flags); await exactDomain(f);
    const bound = await intent(f);
    expect(await prepareLocalCandidateTransition(bound, f.run())).toMatchObject({ ...flags, status: 'RECONCILING' });
    expect(await reconcileLocalPreparedTransition(bound, f.sourceLease, f.destinationLease)).toMatchObject({ ...flags, disposition: 'DURABLE_PREPARED_STOP' });
    expect(await deleteState(f.source)).toEqual(before.source); expect(await deleteState(f.local)).toEqual(before.local);
  }, 120_000);

  it('rejects substituted tenant, original version and source/manifest pins without writing or promoting the mixed graph', async () => {
    const f = await fixture(), before = await f.state();
    for (const patch of [{ tenantId: OTHER }, { expectedStateVersion: '99' }, { sourceFingerprint: 'b'.repeat(64) }, { manifestDigest: 'c'.repeat(64) }]) {
      await expect(materializeLocalCandidate({ ...f.binding, ...patch }, f.run())).rejects.toThrow();
      expect(await f.state()).toEqual(before);
    }
    await materializeLocalCandidate(f.binding, f.run());
    const bound = await intent(f), materialized = await f.state();
    for (const patch of [{ expectedStateVersion: '99' }, { sourceFingerprint: 'b'.repeat(64) }]) {
      await expect(prepareLocalCandidateTransition({ ...bound, binding: { ...f.binding, ...patch } }, f.run())).rejects.toThrow();
      expect(await f.state()).toEqual(materialized);
    }
    expect(await prepareLocalCandidateTransition(bound, f.run())).toMatchObject(flags);
    const stopped = await f.state();
    await expect(reconcileLocalPreparedTransition({ ...bound, expectedReportDigest: 'd'.repeat(64) }, f.sourceLease, f.destinationLease)).rejects.toThrow();
    expect(await f.state()).toEqual(stopped);
  }, 120_000);
});
