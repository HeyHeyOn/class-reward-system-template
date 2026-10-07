// @vitest-environment node
// Real owned local PG, generated source only. No external writer fence or cutover.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteFixture, cleanupDeleteFixture, deleteState, TENANT, JOB } from '../../../test-support/task19DeleteFixture';
import { stageLegacyFinalGeneration, inspectLegacyFinalGeneration } from './finalGeneration';
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';
import { materializeLocalCandidate, prepareLocalCandidateTransition, reconcileLocalPreparedTransition,
  type LocalCandidateBinding } from './localCandidateMaterialization';
import { createLegacyCutoverAbortService } from './cutover';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
afterEach(cleanupDeleteFixture);
const flags = { authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' };
const CATEGORIES = ['students', 'accounts', 'products', 'settings', 'tasks', 'task_allowed_students',
  'promotions', 'promotion_products', 'transactions', 'transaction_items', 'adjustments', 'task_assignments',
  'task_completions', 'legacy_operation_bindings', 'padlet_evidence_claims', 'padlet_claim_digest_tombstones',
  'SOURCE_RECORDS', 'MAPPINGS', 'CONTRIBUTORS', 'DELTA_ENTRIES'];
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const f = await deleteFixture();
  await f.commitDelete();
  // Modify the same synthetic SQL source, not a caller-made manifest.
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=jsonb_set(jsonb_set(cells,'{1}','"Final pencil"'),'{2}','"27"')
    WHERE tenant=$1 AND tab='Products' AND cells->>0='P1'`, [TENANT]);
  await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
  const candidate = await f.capture(), input = f.input(candidate);
  const lease = (db: typeof f.source) => ({ kind: 'SYNTHETIC_DISPOSABLE' as const, databaseId: db.runId, ownerId: f.ownerId,
    queryOwner: (text: string, values?: unknown[]) => db.owner.query(text, values), runTransaction: db.runTenantTransaction });
  return { ...f, candidate, input, sourceLease: lease(f.source), destinationLease: lease(f.destination) };
}
async function intent(f: Fixture, binding: LocalCandidateBinding) {
  const reports = (await f.source.owner.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
    FROM migration_full_reconciliation WHERE generation_id=$1 ORDER BY category`, [binding.generationId])).rows;
  expect(reports.map(row => row.category)).toEqual([...CATEGORIES].sort());
  expect(reports.every(row => row.status === 'MATCH' && row.expected_count === row.observed_count
    && row.expected_digest === row.observed_digest)).toBe(true);
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows;
  expect(materialization).toHaveLength(1);
  return { binding, ownerId: f.ownerId, sourceDatabaseId: f.source.runId, destinationDatabaseId: f.destination.runId,
    expectedDestinationStateVersion: '2', expectedReportDigest: sha256(canonicalJson(reports)),
    expectedMaterializationDigest: sha256(canonicalJson(materialization[0].value)) };
}
const taints = ['final-fingerprint', 'freeze-started', 'freeze-verified'] as const;
async function taint(f: Fixture, kind: typeof taints[number]) {
  // Owner-only fault injection in this disposable source mirror. No disabled
  // constraint/trigger: existing SQL permits these fields to change at READY/v4.
  const before = (await f.source.owner.query('SELECT status,state_version::text AS version FROM migration_jobs')).rows;
  if (kind === 'final-fingerprint') await f.source.owner.query('UPDATE migration_jobs SET final_fingerprint=$1,updated_at=now()', [sha256('unbound final authority')]);
  else if (kind === 'freeze-started') await f.source.owner.query('UPDATE migration_jobs SET freeze_started_at=now(),updated_at=now()');
  else await f.source.owner.query('UPDATE migration_jobs SET freeze_started_at=now(),freeze_verified_at=now(),updated_at=now()');
  expect((await f.source.owner.query('SELECT status,state_version::text AS version FROM migration_jobs')).rows).toEqual(before);
  expect(before).toEqual([{ status: 'READY', version: f.input.expectedStateVersion }]);
}
async function refusedUnchanged(f: Fixture, action: () => Promise<unknown>, message: string) {
  const before = await f.state();
  const outcome = await action().then(value => ({ accepted: true, value }),
    error => ({ accepted: false, error: (error as Error).message }));
  const after = await f.state();
  console.info('TASK19_FINAL_AUTHORITY_BOUNDARY', JSON.stringify({ outcome,
    beforeDigest: sha256(canonicalJson(before)), afterDigest: sha256(canonicalJson(after)), unchanged: canonicalJson(before) === canonicalJson(after) }));
  expect(outcome).toEqual({ accepted: false, error: message });
  expect(after).toEqual(before);
}

suite('Task19 final-delta authority-state binding', () => {
  it('positive: modified/deleted final SQL source reaches exact candidate and prepared STOP, never authority', async () => {
    const f = await fixture(), before = await f.state();
    // This older opt-in is intentionally ADDED-only, not the mutable path.
    await expect(stageLocalFullDeltaCheckedPreparation(f.input, f.source.runTenantTransaction))
      .rejects.toThrow('Local full-delta-checked preparation refused.');
    expect(await f.state()).toEqual(before);
    const { binding, staged } = await f.stage(f.candidate);
    expect(staged).toMatchObject({ ...flags, scope: 'LOCAL_FULL_MUTABLE_SNAPSHOT', persistedReadback: 'MATCH' });
    const plan = await inspectLegacyFinalGeneration(f.input, f.source.runTenantTransaction);
    expect(plan.plan).toMatchObject({ status: 'DIFF_VALIDATED', blockers: [] });
    expect(plan.plan.changes.map(change => [change.table, change.identity, change.kind]))
      .toEqual([['products', '["P1"]', 'MUTATED'], ['products', '["PX"]', 'REMOVED']]);
    const archived = (await f.source.owner.query('SELECT redacted_details FROM audit_events WHERE event_id=$1', [plan.candidateGenerationId])).rows[0].redacted_details;
    expect(archived.binding).toMatchObject({ tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: f.input.expectedStateVersion,
      originalSourceId: f.input.originalSourceId, originalSnapshotId: f.input.originalSnapshotId, originalSourceFingerprint: f.old.sourceFingerprint });
    expect(archived.acquisition).toEqual(f.candidate);
    const source = await deleteState(f.source), local = await deleteState(f.local);
    const physical = await materializeLocalCandidate(binding, f.run());
    expect(physical).toMatchObject({ ...flags, binding });
    expect((await f.destination.owner.query('SELECT product_id,name,price::text FROM products ORDER BY product_id')).rows)
      .toEqual([{ product_id: 'P1', name: 'Final pencil', price: '27' }]);
    expect((await f.source.owner.query('SELECT product_id,name,price::text FROM products ORDER BY product_id')).rows)
      .toEqual([{ product_id: 'P1', name: 'Pencil', price: '20' }, { product_id: 'PX', name: 'Delete me', price: '9' }]);
    const committed = await f.state();
    expect(await materializeLocalCandidate(binding, f.run())).toEqual(physical);
    expect(await f.state()).toEqual(committed);
    const proposed = await intent(f, binding);
    const prepared = await prepareLocalCandidateTransition(proposed, f.run());
    expect(prepared).toMatchObject({ ...flags, preparation: 'PREPARED_STOP_REQUIRED', status: 'RECONCILING', stateVersion: '3' });
    const durable = await f.state();
    expect(await reconcileLocalPreparedTransition(proposed, f.sourceLease, f.destinationLease))
      .toMatchObject({ ...flags, disposition: 'DURABLE_PREPARED_STOP' });
    expect(await f.state()).toEqual(durable);
    expect(await deleteState(f.source)).toEqual(source); expect(await deleteState(f.local)).toEqual(local);
    expect((await f.destination.owner.query('SELECT status,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
      .toEqual([{ status: 'RECONCILING', final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null, completed_at: null }]);
    console.info('TASK19_FINAL_AUTHORITY_POSITIVE', JSON.stringify({ binding, plan: plan.plan, physical, proposed, prepared }));
  }, 120_000);

  for (const phase of ['stage', 'materialize', 'materialization-retry', 'prepared-transition'] as const) {
    it.each(taints)(`negative: ${phase} refuses same-version source %s before any further evidence or transition`, async kind => {
      const f = await fixture();
      if (phase === 'stage') {
        await taint(f, kind);
        await refusedUnchanged(f, () => stageLegacyFinalGeneration(f.input, { runTransaction: f.source.runTenantTransaction }),
          'Final generation preparation refused.');
        await refusedUnchanged(f, () => f.stage(f.candidate), 'Local full-generation stage refused.');
        return;
      }
      const { binding } = await f.stage(f.candidate);
      if (phase === 'materialization-retry' || phase === 'prepared-transition') await materializeLocalCandidate(binding, f.run());
      const proposed = phase === 'prepared-transition' ? await intent(f, binding) : null;
      await taint(f, kind);
      // These downstream services must execute the SAME original-source gate,
      // not trust a prior MATCH/materialization or a still-equal version/digest.
      await refusedUnchanged(f, () => proposed ? prepareLocalCandidateTransition(proposed, f.run()) : materializeLocalCandidate(binding, f.run()),
        proposed ? 'Local prepared transition refused.' : 'Local candidate domain materialization refused.');
      await refusedUnchanged(f, () => inspectLegacyFinalGeneration(f.input, f.source.runTenantTransaction), 'Final generation preparation refused.');
    }, 120_000);
  }

  it('negative: explicit authenticated ABORT stays available after tainted-source refusal and never rewrites the candidate', async () => {
    const f = await fixture(), { binding } = await f.stage(f.candidate);
    await materializeLocalCandidate(binding, f.run());
    const proposed = await intent(f, binding);
    await taint(f, 'freeze-verified');
    await refusedUnchanged(f, () => prepareLocalCandidateTransition(proposed, f.run()), 'Local prepared transition refused.');
    // Synthetic identity setup only; no live users, permissions, or accounts.
    const actor = randomUUID();
    await f.source.owner.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'local-abort-owner','local-abort@example.invalid')", [actor]);
    await f.source.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [TENANT, actor]);
    const before = await f.state();
    const abort = createLegacyCutoverAbortService({ tenantId: TENANT, getAuthenticatedSubject: async () => 'local-abort-owner', runTransaction: f.source.runTenantTransaction });
    const result = await abort({ migrationJobId: JOB, expectedStatus: 'READY', expectedStateVersion: f.input.expectedStateVersion,
      expectedSourceFingerprint: f.old.sourceFingerprint });
    expect(result).toMatchObject({ status: 'ABORTED', externalCleanup: 'NOT_PERFORMED' });
    const after = await f.state();
    expect(after.local).toEqual(before.local); expect(after.destination).toEqual(before.destination);
    const changed = Object.keys(before.source).filter(table => canonicalJson(before.source[table]) !== canonicalJson(after.source[table]));
    expect(changed.sort()).toEqual(['audit_events', 'migration_jobs']);
    expect((await f.source.owner.query('SELECT status,final_fingerprint,freeze_started_at IS NOT NULL AS started,freeze_verified_at IS NOT NULL AS verified FROM migration_jobs')).rows)
      .toEqual([{ status: 'ABORTED', final_fingerprint: null, started: true, verified: true }]);
    await refusedUnchanged(f, () => prepareLocalCandidateTransition(proposed, f.run()), 'Local prepared transition refused.');
    console.info('TASK19_FINAL_AUTHORITY_ABORT', JSON.stringify({ binding, result, changed, externalCleanup: 'NOT_PERFORMED' }));
  }, 120_000);
});
