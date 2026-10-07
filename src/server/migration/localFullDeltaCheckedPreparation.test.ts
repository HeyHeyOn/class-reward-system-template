// @vitest-environment node
// Synthetic PGlite only: no live acquisition, final import, PostgreSQL or cutover proof.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { importLegacyNormalizationManifest, inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import type { FinalGenerationPreparationInput, stageLegacyFinalGeneration } from './finalGeneration';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson } from './validators';
import * as pointer from './localCapturedSourceCoverage';
import * as delta from './localFullCategoryDeltaCoverage';
import { inspectLocalPointerPreparationEnvelopes } from './localPointerCheckedPreparation';
import { stageLocalFullDeltaCheckedPreparation, inspectLocalFullDeltaPreparationEnvelopes } from './localFullDeltaCheckedPreparation';

vi.mock('server-only', () => ({})); // Environment marker only; all business implementations execute.
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Local full-delta-checked preparation refused.';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (value: unknown) => hash(canonicalJson(value));
type Acquisition = FinalGenerationPreparationInput['original'];
type Stage = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
type Envelope = { tenant_id: string; event_id: string; job_id: string; event_type: string;
  operation_id: null; actor_user_id: null; entity_type: null; entity_id: null; redacted_details: Record<string, unknown> };
type Fact = Record<string, unknown>;
const facts: Record<string, Fact> = {};
const flags = { scope: 'LOCAL_FULL_DELTA_CHECKED_PREPARATION_ONLY', authority: 'NONAUTHORITY',
  complete: false, activationAllowed: false, exclusion: 'NOT_PROVEN', fullSourceReconciliation: 'NOT_PERFORMED',
  fullTargetReconciliation: 'NOT_PERFORMED', preRedactionInventory: 'NOT_OBSERVED',
  canonicalBusinessValidation: 'NOT_PERFORMED', contributorMultiplicityValidation: 'NOT_PERFORMED' };
const directory = 'src/server/db/migrations';
const migrations = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'src/server/migration/localFullDeltaCheckedPreparation.ts',
  'src/server/migration/localFullDeltaCheckedPreparation.test.ts', 'src/server/migration/localFullCategoryDeltaCoverage.ts',
  'src/server/migration/localFullCategoryDeltaCoverage.test.ts', 'src/server/migration/localPointerCheckedPreparation.ts',
  'src/server/migration/localPointerCheckedPreparation.test.ts', 'src/server/migration/localCapturedSourceCoverage.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts', 'src/server/migration/manifest.ts',
  'src/server/migration/normalize.ts', 'src/server/migration/validators.ts', 'src/server/migration/__fixtures__/normalization.ts',
  'src/server/db/testing/pglite.ts', 'src/server/db/transaction.ts', 'package.json', 'vitest.config.mts',
  ...migrations.map((name) => join(directory, name))];
const hashes = () => Object.fromEntries(watched.map((path) => [path, hash(readFileSync(path, 'utf8'))]));
const initialHashes = hashes();

type Options = { added?: boolean; mutated?: boolean; removed?: boolean; freshRedis?: boolean; longCell?: boolean };
async function capture(options: Options = {}): Promise<Acquisition> {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  if (options.added) {
    workbook.Students.push(['S2', 'Bob', '0', 'ACTIVE']);
    workbook.Products.push(['P2', 'Notebook', '15', '3', 'TRUE', '', 'school', '2']);
  }
  if (options.mutated) workbook.Products[1][1] = 'Changed pencil';
  if (options.removed) {
    workbook.Promotions = [workbook.Promotions[0]];
    workbook.PromotionProducts = [workbook.PromotionProducts[0]];
  }
  if (options.longCell) workbook.Notes = [['future'], ['x'.repeat(9_000)]];
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId,
    capturedAt: options.added ? '2026-09-01T00:00:00.000Z' : seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
      // Content-changing candidates need a distinct source token so these
      // cases still reach the full-delta boundary, not revision equivocation.
      getRevision: async () => options.added || options.mutated || options.removed || options.longCell ? 'sheets-2' : 'sheets-1' } });
  const operation = makeRedis().operationBindings[0];
  const claimField = `claim:${hash(`${operation.binding.evidence.evidenceBoardId}\0${operation.binding.evidence.evidencePostId}`)}`;
  const entries: Array<readonly [string, string]> = [[claimField, operation.operationId],
    [`op:${hash(operation.operationId)}`, JSON.stringify({ binding: operation.binding, claimField })]];
  const redis = await captureRedisClaimSnapshot({
    hscan: async (key, cursor) => { expect([key, cursor]).toEqual(['padlet:evidence-bindings:v2', '0']); return { cursor: '0', entries: structuredClone(entries) }; },
    scan: async (cursor, pattern) => { expect([cursor, pattern]).toEqual(['0', 'padlet:evidence-claim:v1:*']); return { cursor: '0', keys: [] }; },
    get: async () => { throw new Error('No synthetic v1 key'); },
    getRevision: async () => options.freshRedis ? 'redis-2' : 'redis-1',
  }, { capturedAt: options.freshRedis ? '2026-09-01T00:00:00.000Z' : seed.capturedAt });
  return { sheets, redis };
}
const normalize = (tenantId: string, acquisition: Acquisition) => createLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, ...acquisition });
const binding = (input: FinalGenerationPreparationInput) => ({ tenantId: input.tenantId, migrationJobId: input.migrationJobId,
  expectedStateVersion: input.expectedStateVersion, originalSourceId: input.originalSourceId,
  originalSnapshotId: input.originalSnapshotId, exclusionGenerationReference: input.exclusionGenerationReference });
async function state(h: PgliteDatabaseHarness, audit = true) {
  const { rows: tables } = await h.database.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result: Record<string, string[]> = {};
  for (const { tablename } of tables) {
    expect(tablename).toMatch(/^[a-z_][a-z0-9_]*$/);
    if (!audit && tablename === 'audit_events') continue;
    const { rows } = await h.database.query(`SELECT row_to_json(t) AS row,xmin::text AS xmin FROM public."${tablename}" t`);
    result[tablename] = rows.map((row) => canonicalJson(row)).sort();
  }
  return result;
}
async function stored(h: PgliteDatabaseHarness) {
  return (await h.database.query<Envelope>(`SELECT tenant_id,event_id,job_id,event_type,operation_id,
    actor_user_id,entity_type,entity_id,redacted_details FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`)).rows;
}
async function fixture(h: PgliteDatabaseHarness, fact: Fact) {
  const original = await capture();
  const manifest = normalize(h.tenantOneId, original);
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  expect(manifest.records.padlet_evidence_claims).toHaveLength(1);
  fact.phase = 'actual importer';
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [h.tenantOneId, JOB]);
  fact.importResult = await importLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  // Local synthetic state transition, NOT operational readiness or external exclusion.
  for (const status of ['RECONCILING', 'READY']) await h.database.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2', [h.tenantOneId, JOB, status]);
  fact.phase = 'actual original inspector';
  expect(await h.runTenantTransaction(h.tenantOneId, (tx) => inspectLegacyImport(tx, { tenantId: h.tenantOneId, migrationJobId: JOB, manifest }, manifest))).toEqual([]);
  const { rows } = await h.database.query<{ version: string; source_id: string; snapshot_id: string }>(
    `SELECT j.state_version::text AS version,s.source_id,s.snapshot_id FROM migration_jobs j JOIN migration_snapshots s USING(tenant_id,job_id)
     WHERE j.tenant_id=$1 AND j.job_id=$2 AND s.phase='PREFLIGHT'`, [h.tenantOneId, JOB]);
  expect(rows).toHaveLength(1);
  const input: FinalGenerationPreparationInput = { tenantId: h.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSourceId: rows[0].source_id, originalSnapshotId: rows[0].snapshot_id, original, candidate: await capture({ added: true }),
    exclusionGenerationReference: 'a'.repeat(64) };
  expect(await stored(h)).toEqual([]);
  fact.phase = 'test body';
  return { h, input, manifest, fact, baseline: await state(h), nonAudit: await state(h, false) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function checked(name: string, body: (f: Fixture) => Promise<void>) {
  it(name, async () => {
    const fact: Fact = { phase: 'in-memory PGlite DDL', status: 'running', closed: false }; facts[name] = fact;
    let h: PgliteDatabaseHarness | undefined;
    try {
      h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
      for (const name of migrations.filter((name) => name.slice(0, 4) > '0008')) await h.database.exec(readFileSync(join(directory, name), 'utf8'));
      await body(await fixture(h, fact)); fact.status = 'passed';
    } catch (error) { fact.status = 'failed'; fact.error = error instanceof Error ? error.message : String(error); throw error;
    } finally { vi.restoreAllMocks(); await h?.close(); fact.closed = Boolean(h); }
  }, 0);
}
type Observation = { entries: number; rows?: Envelope[] };
function observedRunner(f: Fixture, observation: Observation): TenantImportTransactionRunner {
  return (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
    observation.entries++;
    try { return await callback(tx); }
    finally {
      observation.rows = (await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,
        actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
        WHERE tenant_id=${tenant} AND job_id=${JOB} AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`)).rows as Envelope[];
    }
  });
}
function envelope(rows: Envelope[], suffix: string) { return rows.find((row) => row.event_type === `MIGRATION_PREPARATION_${suffix}`)!; }
function records(rows: Envelope[], suffix: string) { return (envelope(rows, suffix).redacted_details.manifest as LegacyNormalizationManifest).records; }
function archivedPlan(rows: Envelope[]) {
  const { status, changes, blockers } = envelope(rows, 'PLAN').redacted_details;
  return { status, changes, blockers } as Stage['plan'];
}
async function unchanged(f: Fixture) {
  expect(await state(f.h, false)).toEqual(f.nonAudit);
  expect(await f.h.runTenantTransaction(f.input.tenantId, (tx) => inspectLegacyImport(tx,
    { tenantId: f.input.tenantId, migrationJobId: JOB, manifest: f.manifest }, f.manifest))).toEqual([]);
}
afterAll(() => {
  const currentHashes = hashes();
  console.info(`FULL_DELTA_PREPARATION_EVIDENCE ${JSON.stringify({ ...flags, engine: 'in-memory PGlite only', initialHashes, currentHashes, facts })}`);
  expect(currentHashes).toEqual(initialHashes);
});

describe('opt-in archived full normalized ADDED-only delta preparation', () => {
  checked('commits exactly three real envelopes after pointer and full-catalog DB-readback checks; exact retry', async (f) => {
    const pointers = vi.spyOn(pointer, 'verifyLocalCapturedSourceCoverage');
    const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
    const observed: Observation = { entries: 0 };
    const before = canonicalJson(f.input);
    const result = await stageLocalFullDeltaCheckedPreparation(f.input, observedRunner(f, observed));
    expect(result).toMatchObject(flags); expect(observed.entries).toBe(1); expect(observed.rows).toHaveLength(3);
    expect(pointers).toHaveBeenCalledTimes(4); expect(full).toHaveBeenCalledTimes(1);
    expect(full.mock.calls[0]).toEqual([records(observed.rows!, 'ORIGINAL'), records(observed.rows!, 'CANDIDATE'), archivedPlan(observed.rows!)]);
    const rows = await stored(f.h); expect(rows).toEqual(observed.rows);
    for (const [kind, id] of [['ORIGINAL', result.preparation.originalGenerationId], ['CANDIDATE', result.preparation.candidateGenerationId], ['PLAN', result.preparation.planId]]) {
      expect(envelope(rows, kind).event_id).toBe(id);
      expect(id).toBe(`preparation:${kind.toLowerCase()}:${digest(envelope(rows, kind).redacted_details)}`);
    }
    expect(envelope(rows, 'ORIGINAL').redacted_details.manifest).toEqual(f.manifest);
    expect(envelope(rows, 'CANDIDATE').redacted_details.manifest).toEqual(normalize(f.input.tenantId, f.input.candidate));
    expect(result.deltaCoverage).toMatchObject({ status: 'COVERED_LOCAL_INPUTS', complete: false, authority: 'NONAUTHORITY' });
    expect(result.deltaCoverage.coverage.map((row) => row.table)).toEqual(delta.LOCAL_DELTA_COVERAGE_CATALOG.map((row) => row.table));
    expect(result.deltaCoverage.coverage.filter((row) => row.addedCount)).toEqual([
      { table: 'students', originalCount: 1, candidateCount: 2, addedCount: 1 },
      { table: 'accounts', originalCount: 1, candidateCount: 2, addedCount: 1 },
      { table: 'products', originalCount: 1, candidateCount: 2, addedCount: 1 },
    ]);
    expect(result.preparation.plan.changes).toHaveLength(3);
    expect(result.reports.original.manifestDigest).not.toBe(result.reports.candidate.manifestDigest);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.deltaCoverage.coverage)).toBe(true);
    expect(canonicalJson(f.input)).toBe(before); expect(Object.isFrozen(f.input)).toBe(false);
    await unchanged(f);
    const committed = await state(f.h);
    expect(await stageLocalFullDeltaCheckedPreparation(f.input, f.h.runTenantTransaction)).toEqual(result);
    expect(await state(f.h)).toEqual(committed);
    f.fact.witness = { rowsBeforeCommit: observed.rows!.length, fullCheckerCallsBeforeCommit: 1,
      pointerCheckerCallsBeforeCommit: 4, changedTables: ['students', 'accounts', 'products'], retryRowsAndXminUnchanged: true };
  });

  for (const kind of ['mutated', 'removed', 'freshRedis'] as const) {
    checked(`actual ${kind} candidate reaches full checker after append and pointer success, then rolls back`, async (f) => {
      const input = { ...f.input, candidate: await capture({ [kind]: true }) };
      expect(normalize(input.tenantId, input.candidate).status).toBe('READY_FOR_IMPORT');
      const pointers = vi.spyOn(pointer, 'verifyLocalCapturedSourceCoverage');
      const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
      const observed: Observation = { entries: 0 };
      await expect(stageLocalFullDeltaCheckedPreparation(input, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
      expect(observed.entries).toBe(1); expect(observed.rows).toHaveLength(3);
      expect(pointers).toHaveBeenCalledTimes(4); expect(pointers.mock.results.every((r) => r.type === 'return')).toBe(true);
      expect(full).toHaveBeenCalledTimes(1); expect(full.mock.results[0]).toMatchObject({ type: 'throw', value: new Error('Local delta coverage refused.') });
      expect(archivedPlan(observed.rows!).status).toBe('DIFF_VALIDATED');
      if (kind === 'freshRedis') expect(archivedPlan(observed.rows!).changes).toEqual([]);
      else expect(archivedPlan(observed.rows!).changes.some((change) => change.kind === (kind === 'mutated' ? 'MUTATED' : 'REMOVED'))).toBe(true);
      expect(await state(f.h)).toEqual(f.baseline); expect(await stored(f.h)).toEqual([]);
      const result = await stageLocalFullDeltaCheckedPreparation(f.input, f.h.runTenantTransaction);
      expect(result).toMatchObject(flags); expect(await stored(f.h)).toHaveLength(3); await unchanged(f);
      f.fact.witness = { classification: 'POST_APPEND_ACTUAL_FULL_DELTA_REFUSAL', rowsBeforeRollback: 3,
        pointerChecksReturned: 4, fullCheckThrew: true, fullBaselineAndXminRestored: true, normalRetryCommitted: true,
        strictCaptureProvenanceBytes: kind === 'freshRedis' };
    });
  }

  checked('preserves upstream pointer limit refusal rather than relabeling it full-delta coverage', async (f) => {
    const observed: Observation = { entries: 0 };
    const pointers = vi.spyOn(pointer, 'verifyLocalCapturedSourceCoverage');
    const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
    await expect(stageLocalFullDeltaCheckedPreparation({ ...f.input, candidate: await capture({ longCell: true }) }, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
    expect(observed.rows).toHaveLength(3); expect(pointers).toHaveBeenCalledTimes(2);
    expect(pointers.mock.results[1]).toMatchObject({ type: 'throw', value: new Error('Captured source pointer accounting limit refused.') });
    expect(full).not.toHaveBeenCalled(); expect(await state(f.h)).toEqual(f.baseline);
    f.fact.witness = { classification: 'UPSTREAM_POINTER_LIMIT', rowsBeforeRollback: 3, fullCheckerCalls: 0, exactBaselineRestored: true };
  });

  for (const kind of ['version', 'snapshot', 'inspector', 'READY'] as const) {
    checked(`preserves actual upstream ${kind} guard before any envelope append`, async (f) => {
      let input = f.input;
      if (kind === 'version') input = { ...input, expectedStateVersion: '999' };
      if (kind === 'snapshot') input = { ...input, originalSnapshotId: 'wrong' };
      if (kind === 'inspector') await f.h.database.query("UPDATE products SET name='unexpected synthetic target' WHERE tenant_id=$1", [f.input.tenantId]);
      if (kind === 'READY') {
        const { rows } = await f.h.database.query<{ version: string }>("UPDATE migration_jobs SET status='ABORTED',completed_at=now(),updated_at=now(),state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2 RETURNING state_version::text AS version", [f.input.tenantId, JOB]);
        input = { ...input, expectedStateVersion: rows[0].version };
      }
      const baseline = await state(f.h);
      const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
      const pointers = vi.spyOn(pointer, 'verifyLocalCapturedSourceCoverage');
      const observed: Observation = { entries: 0 };
      await expect(stageLocalFullDeltaCheckedPreparation(input, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
      expect(observed.rows ?? []).toEqual([]); expect(full).not.toHaveBeenCalled(); expect(pointers).not.toHaveBeenCalled();
      expect(await state(f.h)).toEqual(baseline);
      f.fact.witness = { classification: 'UPSTREAM_REJECTION', fullCheckerCalls: 0, rowsBeforeRollback: 0, exactBaselineRestored: true };
    });
  }

  checked('freezes primitive binding before runner await and accepts no caller reports or default runner', async (f) => {
    const extra = { ...f.input, deltaCoverage: { complete: true } };
    await expect(stageLocalFullDeltaCheckedPreparation(extra, f.h.runTenantTransaction)).rejects.toThrow(REFUSAL);
    await expect(stageLocalFullDeltaCheckedPreparation(f.input, undefined as unknown as TenantImportTransactionRunner)).rejects.toThrow(REFUSAL);
    const nonCalling: TenantImportTransactionRunner = async <TResult>() => ({} as TResult);
    await expect(stageLocalFullDeltaCheckedPreparation(f.input, nonCalling)).rejects.toThrow(REFUSAL);
    expect(await state(f.h)).toEqual(f.baseline);
    const input = { ...structuredClone(f.input) };
    const result = await stageLocalFullDeltaCheckedPreparation(input, async (tenant, callback) => {
      await Promise.resolve(); input.migrationJobId = 'changed'; input.expectedStateVersion = '999';
      input.originalSnapshotId = 'changed'; input.exclusionGenerationReference = 'b'.repeat(64);
      return f.h.runTenantTransaction(tenant, callback);
    });
    expect(result).toMatchObject(flags); expect(await stored(f.h)).toHaveLength(3); await unchanged(f);
  });

  checked('does not confuse pre-commit rollback with lost response after commit; retry resets attempt evidence', async (f) => {
    let attempts = 0;
    const retrying: TenantImportTransactionRunner = async (tenant, callback) => {
      try { await f.h.runTenantTransaction(tenant, async (tx) => { attempts++; await callback(tx); throw new Error('synthetic precommit loss'); }); }
      catch { expect(await state(f.h)).toEqual(f.baseline); }
      return f.h.runTenantTransaction(tenant, (tx) => { attempts++; return callback(tx); });
    };
    const first = await stageLocalFullDeltaCheckedPreparation(f.input, retrying);
    expect(attempts).toBe(2); const committed = await state(f.h);
    let committedAck = false;
    await expect(stageLocalFullDeltaCheckedPreparation(f.input, async (tenant, callback) => {
      await f.h.runTenantTransaction(tenant, callback); committedAck = true; throw new Error('private response lost after commit');
    })).rejects.toThrow(REFUSAL);
    expect(committedAck).toBe(true); expect(await state(f.h)).toEqual(committed);
    expect(await stageLocalFullDeltaCheckedPreparation(f.input, f.h.runTenantTransaction)).toEqual(first);
    expect(await state(f.h)).toEqual(committed);
    f.fact.witness = { attempts, beforeCommitRollbackObserved: true, postCommitRowsRetained: true, postCommitRollbackClaimed: false };
  });

  checked('rejects resealed missing, duplicate, swapped, REMOVED and MUTATED plan copies AFTER existing pointer binding passes', async (f) => {
    const result = await stageLocalFullDeltaCheckedPreparation(f.input, f.h.runTenantTransaction);
    const rows = await stored(f.h);
    const cases: Array<[string, (changes: Array<Record<string, unknown>>) => Array<Record<string, unknown>>]> = [
      ['missing', (changes) => changes.slice(1)],
      ['duplicate', (changes) => [changes[0], structuredClone(changes[0]), ...changes.slice(2)]],
      ['swapped identity', (changes) => changes.map((c, i) => i ? c : { ...c, identity: '["foreign"]' })],
      ['swapped digest', (changes) => changes.map((c, i) => i ? c : { ...c, afterDigest: 'f'.repeat(64) })],
      ['REMOVED', (changes) => changes.map((c, i) => i ? c : { ...c, kind: 'REMOVED', beforeDigest: c.afterDigest, afterDigest: null })],
      ['MUTATED', (changes) => changes.map((c, i) => i ? c : { ...c, kind: 'MUTATED', beforeDigest: 'f'.repeat(64) })],
    ];
    for (const [name, mutate] of cases) {
      const copy = structuredClone(rows); const row = envelope(copy, 'PLAN');
      row.redacted_details.changes = mutate(row.redacted_details.changes as Array<Record<string, unknown>>);
      row.event_id = `preparation:plan:${digest(row.redacted_details)}`;
      const prepared = { ...structuredClone(result.preparation), planId: row.event_id, plan: archivedPlan(copy) };
      expect(() => inspectLocalPointerPreparationEnvelopes(binding(f.input), prepared, copy), name).not.toThrow();
      const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
      expect(() => inspectLocalFullDeltaPreparationEnvelopes(binding(f.input), prepared, copy), name).toThrow(REFUSAL);
      expect(full).toHaveBeenCalledTimes(1); expect(full.mock.results[0].type).toBe('throw'); full.mockRestore();
    }
    expect(await stored(f.h)).toEqual(rows);
    f.fact.witness = { classification: 'RESEALED_READBACK_COPIES_ONLY', cases: cases.map(([name]) => name),
      actualPointerBoundaryPassedPerCase: true, actualFullCheckerRefusedPerCase: true, persistedCorruptionClaimed: false };
  });

  checked('rejects unsafe or unbound readback copies before extracting normalized records', async (f) => {
    const result = await stageLocalFullDeltaCheckedPreparation(f.input, f.h.runTenantTransaction);
    const rows = await stored(f.h); const context = binding(f.input);
    const mutations: Array<[string, (copy: Envelope[]) => void]> = [
      ['missing', (copy) => { copy.pop(); }], ['duplicate', (copy) => { copy[1] = copy[0]; }],
      ['extra', (copy) => { copy.push(copy[0]); }], ['tenant', (copy) => { copy[0].tenant_id = f.h.tenantTwoId; }],
      ['job', (copy) => { copy[0].job_id = 'foreign'; }],
      ['swapped manifests', (copy) => { envelope(copy, 'CANDIDATE').redacted_details.manifest = envelope(copy, 'ORIGINAL').redacted_details.manifest; }],
      ['binding', (copy) => { (envelope(copy, 'PLAN').redacted_details.binding as Record<string, unknown>).expectedStateVersion = '999'; }],
      ['plan address', (copy) => { envelope(copy, 'PLAN').event_id = `preparation:plan:${'f'.repeat(64)}`; }],
    ];
    for (const [name, mutate] of mutations) {
      const copy = structuredClone(rows); mutate(copy);
      expect(() => inspectLocalFullDeltaPreparationEnvelopes(context, result.preparation, copy), name).toThrow(REFUSAL);
    }
    let getters = 0, traps = 0;
    const copy = structuredClone(rows);
    Object.defineProperty(envelope(copy, 'CANDIDATE').redacted_details, 'manifest', { enumerable: true, get: () => { getters++; throw new Error('private'); } });
    expect(() => inspectLocalFullDeltaPreparationEnvelopes(context, result.preparation, copy)).toThrow(REFUSAL);
    const proxy = new Proxy(rows, { get: () => { traps++; throw new Error('private'); } });
    expect(() => inspectLocalFullDeltaPreparationEnvelopes(context, result.preparation, proxy)).toThrow(REFUSAL);
    expect(getters).toBe(0); expect(traps).toBe(0); expect(await stored(f.h)).toEqual(rows);
    f.fact.copyNegatives = mutations.map(([name]) => name);
  });

  for (const kind of ['missing', 'duplicate', 'swapped', 'mutated plan'] as const) {
    checked(`transactional second-readback ${kind} substitution rolls back actual appended envelopes (test seam only)`, async (f) => {
      let fullReads = 0; const observed: Observation = { entries: 0 };
      const runner: TenantImportTransactionRunner = (tenant, callback) => observedRunner(f, observed)(tenant, async (tx) => {
        const realExecute = tx.execute.bind(tx);
        const spy = vi.spyOn(tx, 'execute').mockImplementation((query) => {
          const pending = realExecute(query);
          const executePending = pending.execute.bind(pending);
          pending.execute = async () => {
            const result = await executePending();
            if (result.rows.length === 3 && result.rows.every((row) => 'event_id' in row && 'redacted_details' in row)) {
              fullReads++;
              if (fullReads === 2) {
                const rows = structuredClone(result.rows) as Envelope[];
                if (kind === 'missing') rows.pop();
                if (kind === 'duplicate') rows[1] = rows[0];
                if (kind === 'swapped') envelope(rows, 'CANDIDATE').redacted_details.manifest = envelope(rows, 'ORIGINAL').redacted_details.manifest;
                if (kind === 'mutated plan') envelope(rows, 'PLAN').redacted_details.changes = [];
                return { ...result, rows };
              }
            }
            return result;
          };
          return pending;
        });
        try { return await callback(tx); } finally { spy.mockRestore(); }
      });
      const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
      await expect(stageLocalFullDeltaCheckedPreparation(f.input, runner)).rejects.toThrow(REFUSAL);
      expect(fullReads).toBe(2); expect(full).not.toHaveBeenCalled(); expect(observed.rows).toHaveLength(3);
      expect(await state(f.h)).toEqual(f.baseline);
      f.fact.witness = { classification: 'TEST_ONLY_DB_RESULT_SUBSTITUTION', realRowsBeforeRollback: 3,
        exactBaselineRestored: true, persistedTamperingClaimed: false, fullCheckerReached: false };
    });
  }
});
