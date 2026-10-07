// @vitest-environment node
// Owned generated PostgreSQL only. Immediate final-envelope fault, not a writer fence.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, TENANT, JOB } from '../../../test-support/task19DeleteFixture';
import { inspectLegacyFinalGeneration, stageLegacyFinalGeneration } from './finalGeneration';
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';
import { projectLegacyStagingGraph } from './importer';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
afterEach(cleanupDeleteFixture);
const flags = { authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' };
const categories = ['students', 'accounts', 'products', 'settings', 'tasks', 'task_allowed_students', 'promotions',
  'promotion_products', 'transactions', 'transaction_items', 'adjustments', 'task_assignments', 'task_completions',
  'legacy_operation_bindings', 'padlet_evidence_claims', 'padlet_claim_digest_tombstones'];
const ordered = (rows: readonly unknown[]) => rows.map(row => canonicalJson(row)).sort();

async function fixture() {
  const f = await deleteFixture();
  // A genuinely committed earlier candidate must survive both refusal and success.
  const earlier = await f.stage(f.original);
  await f.commitDelete();
  const task = [...f.original.sheets.tabs.Tasks.rows[0].cells];
  for (const [key, value] of Object.entries({ title: 'Final task', reward: '11', allowedStudentIds: '' })) {
    task[f.original.sheets.tabs.Tasks.headers.indexOf(key)] = value;
  }
  expect((await f.local.owner.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Tasks' AND ordinal=1",
    [JSON.stringify(task), TENANT])).rowCount).toBe(1);
  const edits = [
    "UPDATE task19_delete_rows SET cells=jsonb_set(cells,'{1}','\"green\"') WHERE tenant=$1 AND tab='Settings' AND cells->>0='themeColor'",
    "UPDATE task19_delete_rows SET cells=jsonb_set(cells,'{1}','\"Final pencil\"') WHERE tenant=$1 AND tab='Products' AND cells->>0='P1'",
  ];
  for (const query of edits) expect((await f.local.owner.query(query, [TENANT])).rowCount).toBe(1);
  await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
  const candidate = await f.capture();
  return { ...f, earlier, candidate, finalInput: f.input(candidate) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function exactPublication(f: Fixture) {
  const before = await f.state();
  // Keep the old ADDED-only wrapper strict, including rollback of its appends.
  await expect(stageLocalFullDeltaCheckedPreparation(f.finalInput, f.source.runTenantTransaction)).rejects.toThrow();
  expect(await f.state()).toEqual(before);
  const result = await f.stage(f.candidate), { binding, staged, next } = result;
  expect(staged).toMatchObject({ ...flags, scope: 'LOCAL_FULL_MUTABLE_SNAPSHOT', persistedReadback: 'MATCH' });
  expect(binding.generationId).not.toBe(f.earlier.binding.generationId);
  const plan = await inspectLegacyFinalGeneration(f.finalInput, f.source.runTenantTransaction);
  expect(plan.plan.status).toBe('DIFF_VALIDATED');
  expect(plan.plan.blockers).toEqual([]);
  expect(plan.plan.changes.map(row => [row.table, row.identity, row.kind])).toEqual([
    ['products', '["P1"]', 'MUTATED'], ['products', '["PX"]', 'REMOVED'], ['settings', '["themeColor"]', 'MUTATED'],
    ['task_allowed_students', '["TI1","S1"]', 'REMOVED'], ['tasks', '["TI1"]', 'MUTATED'],
  ]);
  const header = (await f.source.owner.query(`SELECT tenant_id,migration_job_id,candidate_generation_id,original_generation_id,
    plan_id,expected_state_version::text,source_fingerprint,manifest_digest,scope,writer_exclusion_status
    FROM migration_full_generations WHERE generation_id=$1`, [binding.generationId])).rows;
  expect(header).toEqual([{ tenant_id: TENANT, migration_job_id: JOB, candidate_generation_id: plan.candidateGenerationId,
    original_generation_id: plan.originalGenerationId, plan_id: plan.planId, expected_state_version: binding.expectedStateVersion,
    source_fingerprint: next.sourceFingerprint, manifest_digest: next.manifestDigest, scope: 'LOCAL_CANDIDATE', writer_exclusion_status: 'NOT_PROVEN' }]);
  const archive = (await f.source.owner.query('SELECT redacted_details FROM audit_events WHERE event_id=$1', [plan.candidateGenerationId])).rows[0].redacted_details;
  expect(archive.acquisition).toEqual(f.candidate); expect(archive.manifest).toEqual(next);
  expect(archive.binding).toMatchObject({ tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: binding.expectedStateVersion });
  const read = async (table: string, columns: string) => (await f.source.owner.query(
    `SELECT ${columns} FROM ${table} WHERE generation_id=$1`, [binding.generationId])).rows;
  const targets = await read('migration_full_targets', 'target_table,target_id,canonical_value');
  const expectedTargets = projectLegacyStagingGraph(next).targets.map(({ table, id, value }) =>
    ({ target_table: table, target_id: id, canonical_value: value }));
  expect(ordered(targets)).toEqual(ordered(expectedTargets));
  for (const table of categories) expect(ordered(targets.filter(row => row.target_table === table).map(row => row.canonical_value)))
    .toEqual(ordered(next.records[table] ?? []));
  expect(targets).toHaveLength(Object.values(next.records).reduce((n, rows) => n + rows.length, 0));
  const sources = await read('migration_full_sources', 'source_ordinal,source_value');
  const expectedSources = next.sourceRecords.map((source_value, source_ordinal) => ({ source_ordinal, source_value }));
  expect(ordered(sources)).toEqual(ordered(expectedSources));
  const mappings = await read('migration_full_mappings', 'mapping_ordinal,target_table,target_id,mapping_value');
  const expectedMappings = next.mappings.map((mapping_value, mapping_ordinal) => ({ mapping_ordinal,
    target_table: mapping_value.targetTable, target_id: mapping_value.targetId, mapping_value }));
  expect(ordered(mappings)).toEqual(ordered(expectedMappings));
  const contributors = await read('migration_full_contributors', 'mapping_ordinal,source_ordinal');
  const expectedContributors = projectLegacyStagingGraph(next).contributors.map(({ mappingOrdinal, sourceOrdinal }) =>
    ({ mapping_ordinal: mappingOrdinal, source_ordinal: sourceOrdinal }));
  expect(ordered(contributors)).toEqual(ordered(expectedContributors));
  const deltas = await read('migration_full_delta_entries', 'target_table,target_id,change_kind,entry_value');
  expect(deltas).toHaveLength(plan.plan.changes.length);
  // Pin both logical identities (above) and physical IDs, including the derived
  // allowed-student ID for this fixed tenant/TI1/S1 fixture, not observed DB IDs.
  const expectedIds = ['P1', 'PX', 'themeColor', '1cce75b2-ef1a-5aa7-a349-ebe8e6a24ecf', 'TI1'];
  const identityFields: Record<string, string[]> = { products: ['productId'], settings: ['key'],
    tasks: ['taskInstanceId'], task_allowed_students: ['taskInstanceId', 'studentId'] };
  const expectedDeltas = [];
  for (const [index, change] of plan.plan.changes.entries()) {
    const delta = deltas.find(row => row.target_table === change.table && row.entry_value.identity === change.identity)!;
    expect(delta.target_id).toBe(expectedIds[index]);
    expect(delta.change_kind).toBe(change.kind); expect(delta.entry_value).toMatchObject(change);
    const expectedEntry: Record<string, unknown> = { ...change, before: null, after: null };
    for (const [side, manifest] of [['before', f.old], ['after', next]] as const) {
      const rows = manifest.records[change.table] ?? [];
      const target = rows.find(row => canonicalJson(identityFields[change.table].map(field => row[field])) === change.identity) ?? null;
      expect(target ? sha256(canonicalJson(target)) : null).toBe(change[`${side}Digest`]);
      expect(delta.entry_value[side]?.target ?? null).toEqual(target);
      if (!target) { expect(delta.entry_value[side]).toBeNull(); continue; }
      const imageMappings = manifest.mappings.flatMap((mappingValue, mappingOrdinal) => mappingValue.targetTable === change.table
        && mappingValue.targetId === expectedIds[index] ? [{ mappingOrdinal, mappingValue }] : []);
      const imageContributors = projectLegacyStagingGraph(manifest).contributors.filter(row =>
        imageMappings.some(mapping => mapping.mappingOrdinal === row.mappingOrdinal));
      const imageSources = manifest.sourceRecords.flatMap((sourceValue, sourceOrdinal) =>
        imageContributors.some(row => row.sourceOrdinal === sourceOrdinal) ? [{ sourceOrdinal, sourceValue }] : []);
      expect(imageSources).toHaveLength(1); expect(imageMappings).toHaveLength(1);
      expectedEntry[side] = { target, sources: imageSources, mappings: imageMappings, contributors: imageContributors };
      expect(delta.entry_value[side]).toEqual(expectedEntry[side]);
    }
    expectedDeltas.push({ target_table: change.table, target_id: expectedIds[index], change_kind: change.kind, entry_value: expectedEntry });
  }
  expect(ordered(deltas)).toEqual(ordered(expectedDeltas));
  expect(await read('migration_full_claim_recaptures', '*')).toEqual([]);
  const reports = await read('migration_full_reconciliation', 'category,expected_count,observed_count,expected_digest,observed_digest,status');
  const expectedReports = Object.entries({ SOURCE_RECORDS: expectedSources, MAPPINGS: expectedMappings,
    CONTRIBUTORS: expectedContributors, DELTA_ENTRIES: expectedDeltas,
    ...Object.fromEntries(categories.map(table => [table, expectedTargets.filter(row => row.target_table === table)])),
  }).map(([category, rows]) => ({ category, expected_count: rows.length, observed_count: rows.length,
    expected_digest: sha256(canonicalJson(ordered(rows))), observed_digest: sha256(canonicalJson(ordered(rows))), status: 'MATCH' }));
  expect(ordered(reports)).toEqual(ordered(expectedReports));
  const after = await f.state();
  expect(after.local).toEqual(before.local); expect(after.destination).toEqual(before.destination);
  for (const [table, prior] of Object.entries(before.source)) {
    if (table.startsWith('migration_full_') || table === 'audit_events') {
      expect((prior as string[]).every(row => (after.source[table] as string[]).includes(row)), table).toBe(true);
    } else expect(after.source[table], table).toEqual(prior);
  }
  // Exact retry has no DML effects, including the earlier candidate's physical rows.
  expect(await f.stage(f.candidate)).toEqual(result); expect(await f.state()).toEqual(after);
  deletionEvidence('atomic-p-publication', { earlier: f.earlier.binding, binding, header, reports, deltas, before, after, staged });
  return result;
}

type Fault = 'aborted-version' | 'final-marker' | 'native-error';
async function fault(f: Fixture, kind: Fault) {
  const update = kind === 'aborted-version' ? "status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now()"
    : `final_fingerprint='${sha256('unbound immediate authority marker')}'`;
  await f.source.owner.query(`CREATE SEQUENCE atomic_p_fired;
    CREATE FUNCTION atomic_p_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    DECLARE affected integer; BEGIN
      IF NEW.event_type='MIGRATION_PREPARATION_PLAN' THEN
        IF (SELECT count(*) FROM migration_full_generations) <> 1 THEN RAISE EXCEPTION 'earlier candidate missing'; END IF;
        ${kind === 'native-error' ? "PERFORM nextval('atomic_p_fired'); RAISE EXCEPTION 'atomic_p_native_fault';" : `
        UPDATE migration_jobs SET ${update} WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected<>1 THEN RAISE EXCEPTION 'job fault did not mutate one row'; END IF;
        PERFORM nextval('atomic_p_fired');`}
      END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER atomic_p_fault AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION atomic_p_fault()`);
}
async function removeFault(f: Fixture) {
  await f.source.owner.query('DROP TRIGGER atomic_p_fault ON audit_events; DROP FUNCTION atomic_p_fault(); DROP SEQUENCE atomic_p_fired');
}

suite('Task19 atomic final capture publication', () => {
  it('positive: complete mixed Task Settings Product candidate and bound reports preserve earlier generation and authority', async () => {
    await exactPublication(await fixture());
  }, 120_000);
  for (const phase of ['preparation', 'full-candidate'] as const) {
    it.each(['aborted-version', 'final-marker'] as const)(`negative: ${phase} rolls back immediate final-plan %s and all new evidence`, async kind => {
      const f = await fixture(); await fault(f, kind);
      const before = await f.state();
      const outcome = await (phase === 'preparation'
        ? stageLegacyFinalGeneration(f.finalInput, { runTransaction: f.source.runTenantTransaction }) : f.stage(f.candidate))
        .then(value => ({ accepted: true, value }), error => ({ accepted: false, error: (error as Error).message }));
      const after = await f.state();
      const fired = (await f.source.owner.query('SELECT last_value::text,is_called FROM atomic_p_fired')).rows;
      deletionEvidence(`atomic-p-${phase}-${kind}`, { outcome, before, after, fired, earlier: f.earlier.binding });
      console.info('TASK19_ATOMIC_P_FAULT', JSON.stringify({ phase, kind, outcome, fired,
        beforeDigest: sha256(canonicalJson(before)), afterDigest: sha256(canonicalJson(after)) }));
      expect(fired).toEqual([{ last_value: '1', is_called: true }]);
      expect(outcome).toEqual({ accepted: false, error: phase === 'preparation'
        ? 'Final generation preparation refused.' : 'Local full-generation stage refused.' });
      expect(after).toEqual(before);
      await removeFault(f); await exactPublication(f);
    }, 120_000);
  }
  it('related negative: native final-plan error rolls back all new envelopes and leaves clean retry possible', async () => {
    const f = await fixture(); await fault(f, 'native-error');
    const before = await f.state();
    await expect(f.stage(f.candidate)).rejects.toThrow('Local full-generation stage refused.');
    const after = await f.state(), fired = (await f.source.owner.query('SELECT last_value::text,is_called FROM atomic_p_fired')).rows;
    expect(fired).toEqual([{ last_value: '1', is_called: true }]); expect(after).toEqual(before);
    deletionEvidence('atomic-p-native-rollback', { before, after, fired });
    await removeFault(f); await exactPublication(f);
  }, 120_000);
});
