// @vitest-environment node
// Generated SQL source only; original fixtures and ADDED-only contract stay intact.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteFixture, cleanupDeleteFixture, deleteState, TENANT, OTHER, JOB } from '../../../test-support/task19DeleteFixture';
import { APPLICATION, denyWrites, witness } from '../../../test-support/task19MixedCold';
import { inspectLegacyFinalGeneration } from './finalGeneration';
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';
import { materializeLocalCandidate, prepareLocalCandidateTransition, reconcileLocalPreparedTransition } from './localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
afterEach(cleanupDeleteFixture);
const flags = { authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' };
const categories = ['students','accounts','products','settings','tasks','task_allowed_students','promotions','promotion_products',
  'transactions','transaction_items','adjustments','task_assignments','task_completions','legacy_operation_bindings',
  'padlet_evidence_claims','padlet_claim_digest_tombstones','SOURCE_RECORDS','MAPPINGS','CONTRIBUTORS','DELTA_ENTRIES'];

async function fixture() {
  const f = await deleteFixture();
  await f.commitDelete();
  // Same editable local SQL source after its immutable original was imported.
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=jsonb_set(cells,'{1}','"Final pencil"')
    WHERE tenant=$1 AND tab='Products' AND cells->>0='P1'`, [TENANT]);
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=jsonb_set(jsonb_set(cells,'{1}','"Final sale"'),'{4}','"7"')
    WHERE tenant=$1 AND tab='Promotions' AND cells->>0='PROMO1'`, [TENANT]);
  const removed = await f.local.owner.query("DELETE FROM task19_delete_rows WHERE tenant=$1 AND tab='PromotionProducts' AND cells->>0='LINK1' RETURNING cells", [TENANT]);
  expect(removed.rows).toHaveLength(1);
  await f.local.owner.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
  const candidate = await f.capture(), input = f.input(candidate), before = await f.state();
  await expect(stageLocalFullDeltaCheckedPreparation(input, f.source.runTenantTransaction))
    .rejects.toThrow('Local full-delta-checked preparation refused.');
  expect(await f.state()).toEqual(before);
  const { binding, staged, next } = await f.stage(candidate);
  expect(staged).toMatchObject({ ...flags, scope: 'LOCAL_FULL_MUTABLE_SNAPSHOT', persistedReadback: 'MATCH' });
  const plan = await inspectLegacyFinalGeneration(input, f.source.runTenantTransaction);
  expect(plan.plan).toMatchObject({ status: 'DIFF_VALIDATED', blockers: [] });
  expect(plan.plan.changes.map(row => [row.table, row.identity, row.kind])).toEqual([
    ['products', '["P1"]', 'MUTATED'], ['products', '["PX"]', 'REMOVED'],
    ['promotion_products', '["LINK1"]', 'REMOVED'], ['promotions', '["PROMO1"]', 'MUTATED'],
  ]);
  const archived = (await f.source.owner.query('SELECT redacted_details FROM audit_events WHERE event_id=$1', [plan.candidateGenerationId])).rows[0].redacted_details;
  expect(archived.acquisition).toEqual(candidate);
  expect(archived.binding).toMatchObject({ tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: binding.expectedStateVersion,
    originalSourceId: input.originalSourceId, originalSnapshotId: input.originalSnapshotId, originalSourceFingerprint: f.old.sourceFingerprint });
  const deltas = (await f.source.owner.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_table,target_id')).rows;
  for (const [table, id, key] of [['promotions', 'PROMO1', 'promotionId'], ['promotion_products', 'LINK1', 'promotionProductId']]) {
    const entry = deltas.find(row => row.target_table === table && row.target_id === id)!.entry_value;
    for (const [side, manifest] of [['before', f.old], ['after', next]] as const) {
      const target = (manifest.records[table] ?? []).find(row => row[key] === id) ?? null;
      expect(entry[`${side}Digest`]).toBe(target && sha256(canonicalJson(target)));
      if (!target) { expect(entry[side]).toBeNull(); continue; }
      expect(entry[side].target).toEqual(target);
      const sources = manifest.sourceRecords.flatMap((sourceValue, sourceOrdinal) => sourceValue.targetTable === table && sourceValue.targetId === id ? [{ sourceValue, sourceOrdinal }] : []);
      const mappings = manifest.mappings.flatMap((mappingValue, mappingOrdinal) => mappingValue.targetTable === table && mappingValue.targetId === id ? [{ mappingValue, mappingOrdinal }] : []);
      expect(sources).toHaveLength(1); expect(mappings).toHaveLength(1);
      expect(entry[side]).toEqual({ target, sources, mappings, contributors: [{ sourceOrdinal: sources[0].sourceOrdinal, mappingOrdinal: mappings[0].mappingOrdinal }] });
    }
  }
  const reports = (await f.source.owner.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
    FROM migration_full_reconciliation WHERE generation_id=$1 ORDER BY category`, [binding.generationId])).rows;
  expect(reports.map(row => row.category)).toEqual([...categories].sort());
  for (const report of reports) {
    expect(report.status).toBe('MATCH'); expect(report.expected_count).toBe(report.observed_count);
    expect(report.expected_digest).toBe(report.observed_digest);
  }
  expect(reports.find(row => row.category === 'promotion_products')!.expected_count).toBe(0);
  const source = await deleteState(f.source), local = await deleteState(f.local);
  const physical = await materializeLocalCandidate(binding, f.run());
  expect(physical).toMatchObject({ ...flags, binding });
  expect((await f.destination.owner.query('SELECT promotion_id,name,fixed_discount::text FROM promotions')).rows)
    .toEqual([{ promotion_id: 'PROMO1', name: 'Final sale', fixed_discount: '7' }]);
  expect((await f.destination.owner.query('SELECT * FROM promotion_products')).rows).toEqual([]);
  expect((await f.destination.owner.query('SELECT product_id,name FROM products')).rows).toEqual([{ product_id: 'P1', name: 'Final pencil' }]);
  expect((await f.source.owner.query('SELECT promotion_id,name,fixed_discount::text FROM promotions')).rows)
    .toEqual([{ promotion_id: 'PROMO1', name: 'Sale', fixed_discount: '5' }]);
  expect((await f.source.owner.query('SELECT promotion_product_id FROM promotion_products')).rows).toEqual([{ promotion_product_id: 'LINK1' }]);
  const committed = await f.state();
  expect(await materializeLocalCandidate(binding, f.run())).toEqual(physical); expect(await f.state()).toEqual(committed);
  expect(await deleteState(f.source)).toEqual(source); expect(await deleteState(f.local)).toEqual(local);
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent = { binding, ownerId: f.ownerId, sourceDatabaseId: f.source.runId, destinationDatabaseId: f.destination.runId,
    expectedDestinationStateVersion: '2', expectedReportDigest: sha256(canonicalJson(reports)), expectedMaterializationDigest: sha256(canonicalJson(materialization)) };
  const lease = (db: typeof f.source) => ({ kind: 'SYNTHETIC_DISPOSABLE' as const, databaseId: db.runId, ownerId: f.ownerId,
    queryOwner: (text: string, values?: unknown[]) => db.owner.query(text, values), runTransaction: db.runTenantTransaction });
  console.info('TASK19_MULTICATEGORY_PHYSICAL', JSON.stringify({ binding, plan: plan.plan, deltas, reports, physical }));
  return { ...f, candidate, input, binding, intent, sourceLease: lease(f.source), destinationLease: lease(f.destination) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function lostResponse(f: Fixture) {
  const before = await f.state(); let committed = false;
  const destination = { ...f.destinationLease, runTransaction: (async (tenant, callback) => {
    await f.destinationLease.runTransaction(tenant, callback);
    committed = true; // Real PG COMMIT has returned, but its caller never gets success.
    throw new Error('synthetic prepared response lost after COMMIT');
  }) as typeof f.destinationLease.runTransaction };
  await expect(prepareLocalCandidateTransition(f.intent, createOwnedLocalMaterializationRunner(TENANT, JOB, f.sourceLease, destination)))
    .rejects.toThrow('Local prepared transition refused.');
  expect(committed).toBe(true);
  const after = await f.state(); expect(after.source).toEqual(before.source); expect(after.local).toEqual(before.local);
  expect((await f.destination.owner.query('SELECT status,state_version::text AS version,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
    .toEqual([{ status: 'RECONCILING', version: '3', final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null, completed_at: null }]);
  const changed = Object.keys(before.destination).filter(key => canonicalJson(before.destination[key]) !== canonicalJson(after.destination[key]));
  expect(changed.sort()).toEqual(['audit_events', 'migration_jobs']);
  await expect(prepareLocalCandidateTransition(f.intent, f.run())).rejects.toThrow();
  await expect(materializeLocalCandidate(f.binding, f.run())).rejects.toThrow();
  expect(await f.state()).toEqual(after);
  console.info('TASK19_MULTICATEGORY_COMMIT_LOSS', JSON.stringify({ intent: f.intent, committed, changed, sourceUnchanged: true }));
}
async function refusedUnchanged(f: Fixture, action: () => Promise<unknown>) {
  const before = await f.state();
  const outcome = await action().then(value => ({ accepted: true, value }), error => ({ accepted: false, error: (error as Error).message }));
  const after = await f.state();
  console.info('TASK19_MULTICATEGORY_REFUSAL', JSON.stringify({ outcome, before: sha256(canonicalJson(before)), after: sha256(canonicalJson(after)) }));
  expect(after).toEqual(before);
  expect(outcome).toEqual({ accepted: false, error: 'Local prepared reconciliation refused.' });
}
async function cold(f: Fixture) {
  const pin = async (db: typeof f.source) => ({ databaseId: db.runId, containerId: String(db.evidence.containerId), imageId: String(db.evidence.imageId),
    systemIdentifier: (await db.owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id });
  mkdirSync('.task19-prepared-recovery', { recursive: true });
  const id = randomUUID(), path = `.task19-prepared-recovery/${id}-request.json`;
  writeFileSync(path, JSON.stringify({ source: await pin(f.source), destination: await pin(f.destination), ownerId: f.ownerId, binding: f.binding, intent: f.intent, accepted: true }));
  const before = { source: await witness(f.source), destination: await witness(f.destination) };
  const log = execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test-support/task19PreparedRecoveryChild.test.ts',
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=.task19-prepared-recovery/${id}-vitest.json`],
  { env: { PATH: process.env.PATH, HOME: '/scratch', LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1', PREPARED_RECOVERY_REQUEST: path },
    timeout: 150_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(`.task19-prepared-recovery/${id}-child.log`, log);
  const result = JSON.parse(readFileSync(path.replace('-request.json', '-result.json'), 'utf8'));
  expect(result.pid).not.toBe(process.pid);
  expect(result.outcome).toMatchObject({ accepted: true, frozen: true, value: { ...flags, disposition: 'DURABLE_PREPARED_STOP', intent: f.intent,
    repeatMutationAllowed: false, rollbackAllowed: false, status: 'RECONCILING', stateVersion: '3' } });
  expect(result.before).toEqual(before); expect(result.after).toEqual(before);
  for (const db of [f.source, f.destination]) expect((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [APPLICATION])).rows).toEqual([]);
  console.info('TASK19_MULTICATEGORY_COLD', JSON.stringify(result));
}

suite('Task19 multicategory prepared STOP', () => {
  it.each(['retry', 'prepare'] as const)('refuses hidden foreign promotion at the sibling %s boundary', async phase => {
    const f = await fixture();
    await f.destination.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'foreign-promo','Synthetic sentinel')", [OTHER]);
    await f.destination.owner.query(`INSERT INTO promotions(tenant_id,promotion_id,name,description,type,fixed_discount,starts_at,ends_at)
      VALUES($1,'FOREIGN','Foreign sale','Synthetic','FIXED_DISCOUNT',1,'2026-08-31T00:00:00Z','2026-09-01T00:00:00Z')`, [OTHER]);
    const before = await f.state();
    const execute = (run: ReturnType<typeof f.run>) => phase === 'retry' ? materializeLocalCandidate(f.binding, run)
      : prepareLocalCandidateTransition(f.intent, run);
    await expect(execute(f.run())).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    let reached = false;
    const destination = { ...f.destinationLease, queryOwner: async (text: string, values?: unknown[]) => {
      const result = await f.destinationLease.queryOwner(text, values);
      if (!text.includes('pg_catalog.pg_tables')) return result;
      reached = true; return { rows: result.rows.filter(row => row.tablename !== 'promotions') };
    } };
    const outcome = await execute(createOwnedLocalMaterializationRunner(TENANT, JOB, f.sourceLease, destination))
      .then(value => ({ accepted: true, value }), error => ({ accepted: false, error: (error as Error).message }));
    console.info('TASK19_MULTICATEGORY_SIBLING', JSON.stringify({ phase, reached, outcome }));
    expect(reached).toBe(true);
    expect(outcome).toEqual({ accepted: false, error: phase === 'retry' ? 'Local candidate domain materialization refused.' : 'Local prepared transition refused.' });
    expect(await f.state()).toEqual(before);
  }, 120_000);

  it('existing positive: modified promotion and deleted link reach exact physical candidate and durable STOP', async () => {
    const f = await fixture(), before = await f.state();
    expect(await prepareLocalCandidateTransition(f.intent, f.run())).toMatchObject({ ...flags, preparation: 'PREPARED_STOP_REQUIRED' });
    const prepared = await f.state();
    expect(await reconcileLocalPreparedTransition(f.intent, f.sourceLease, f.destinationLease)).toMatchObject({ ...flags, disposition: 'DURABLE_PREPARED_STOP' });
    expect(await f.state()).toEqual(prepared); expect(prepared.source).toEqual(before.source); expect(prepared.local).toEqual(before.local);
  }, 120_000);

  it('positive: independently cold determines cross-category STOP after a lost COMMIT response', async () => {
    const f = await fixture(); await lostResponse(f); await cold(f);
  }, 240_000);

  it('refuses a cross-category preparation rolled back before COMMIT, without confusing it with response loss', async () => {
    const f = await fixture(), before = await f.state(); let callbackDone = false;
    const destination = { ...f.destinationLease, runTransaction: (async (tenant, callback) => f.destinationLease.runTransaction(tenant, async tx => {
      await callback(tx); callbackDone = true; throw new Error('synthetic fault before prepared COMMIT');
    })) as typeof f.destinationLease.runTransaction };
    await expect(prepareLocalCandidateTransition(f.intent, createOwnedLocalMaterializationRunner(TENANT, JOB, f.sourceLease, destination))).rejects.toThrow();
    expect(callbackDone).toBe(true); expect(await f.state()).toEqual(before);
    await refusedUnchanged(f, () => reconcileLocalPreparedTransition(f.intent, f.sourceLease, f.destinationLease));
  }, 120_000);

  it.each(['empty', 'missing-promotion', 'missing-private', 'duplicate'] as const)(
    'refuses incomplete destination inventory %s after a lost cross-category COMMIT response', async fault => {
      const f = await fixture(); await lostResponse(f);
      await denyWrites(f.source); await denyWrites(f.destination); let reached = false;
      const destination = { ...f.destinationLease, queryOwner: async (text: string, values?: unknown[]) => {
        const result = await f.destinationLease.queryOwner(text, values);
        if (!text.includes('pg_catalog.pg_tables')) return result;
        reached = true;
        return { rows: fault === 'empty' ? [] : fault === 'duplicate' ? [...result.rows, result.rows[0]]
          : result.rows.filter(row => row.tablename !== (fault === 'missing-promotion' ? 'promotions' : 'generator_grant_claims')) };
      } };
      await refusedUnchanged(f, () => reconcileLocalPreparedTransition(f.intent, f.sourceLease, destination));
      expect(reached).toBe(true);
    }, 120_000);

  it('refuses hidden foreign promotion when truncated owner inventory masks contamination after COMMIT loss', async () => {
    const f = await fixture(); await lostResponse(f);
    await f.destination.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'foreign-promo','Synthetic sentinel')", [OTHER]);
    await f.destination.owner.query(`INSERT INTO promotions(tenant_id,promotion_id,name,description,type,fixed_discount,starts_at,ends_at)
      VALUES($1,'FOREIGN','Foreign sale','Synthetic','FIXED_DISCOUNT',1,'2026-08-31T00:00:00Z','2026-09-01T00:00:00Z')`, [OTHER]);
    expect((await f.destination.runTenantTransaction(TENANT, tx => tx.execute(sql`SELECT promotion_id FROM promotions WHERE tenant_id=${OTHER}`))).rows).toEqual([]);
    expect((await f.destination.owner.query('SELECT count(*)::text AS count FROM promotions')).rows).toEqual([{ count: '2' }]);
    await denyWrites(f.source); await denyWrites(f.destination);
    await refusedUnchanged(f, () => reconcileLocalPreparedTransition(f.intent, f.sourceLease, f.destinationLease));
    let reached = false;
    const destination = { ...f.destinationLease, queryOwner: async (text: string, values?: unknown[]) => {
      const result = await f.destinationLease.queryOwner(text, values);
      if (!text.includes('pg_catalog.pg_tables')) return result;
      reached = true; return { rows: result.rows.filter(row => row.tablename !== 'promotions') };
    } };
    await refusedUnchanged(f, () => reconcileLocalPreparedTransition(f.intent, f.sourceLease, destination));
    expect(reached).toBe(true);
  }, 120_000);

  it('preserves every source/tenant/version binding and refuses changed cross-category evidence without repair', async () => {
    const f = await fixture(); await lostResponse(f); await denyWrites(f.source); await denyWrites(f.destination);
    const wrong = Object.keys(f.binding).map(key => ({ ...f.intent, binding: { ...f.binding, [key]: key === 'tenantId' ? OTHER
      : key === 'expectedStateVersion' ? '5' : ['sourceFingerprint', 'manifestDigest'].includes(key) ? sha256('wrong binding') : 'wrong' } }));
    for (const intent of wrong) await refusedUnchanged(f, () => reconcileLocalPreparedTransition(intent, f.sourceLease, f.destinationLease));
    // Same-row-count physical mutation, not a missing-row/count-only witness.
    await f.destination.owner.query('DROP TRIGGER task19_mixed_no_write ON promotions');
    await f.destination.owner.query("UPDATE promotions SET fixed_discount=8 WHERE tenant_id=$1 AND promotion_id='PROMO1'", [TENANT]);
    await f.destination.owner.query('CREATE TRIGGER task19_mixed_no_write BEFORE INSERT OR UPDATE OR DELETE ON promotions FOR EACH STATEMENT EXECUTE FUNCTION task19_mixed_no_write()');
    await refusedUnchanged(f, () => reconcileLocalPreparedTransition(f.intent, f.sourceLease, f.destinationLease));
  }, 120_000);
});
