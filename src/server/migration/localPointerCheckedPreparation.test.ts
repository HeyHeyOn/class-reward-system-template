// @vitest-environment node
// LOCAL_POINTER_CHECKED_PREPARATION_PGLITE_ONLY. Synthetic, never a cutover gate.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { importLegacyNormalizationManifest, inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { createLegacyNormalizationManifest } from './manifest';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson } from './validators';
import * as coverage from './localCapturedSourceCoverage';
import { stageLocalPointerCheckedPreparation, inspectLocalPointerPreparationEnvelopes } from './localPointerCheckedPreparation';

// Environment marker only. All importer/inspector/stage/checker/SQL implementations are real.
vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Local pointer-checked preparation refused.';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => hash(canonicalJson(value));
type Acquisition = FinalGenerationPreparationInput['original'];

type Fact = Record<string, unknown>;
type Envelope = { tenant_id: string; event_id: string; job_id: string; event_type: string;
  operation_id: null; actor_user_id: null; entity_type: null; entity_id: null; redacted_details: Record<string, unknown> };
const flags = { scope: 'LOCAL_POINTER_CHECKED_PREPARATION_ONLY', authority: 'NONAUTHORITY', complete: false,
  activationAllowed: false, exclusion: 'NOT_PROVEN', fullSourceReconciliation: 'NOT_PERFORMED',
  fullTargetReconciliation: 'NOT_PERFORMED', preRedactionInventory: 'NOT_OBSERVED',
  canonicalBusinessValidation: 'NOT_PERFORMED', contributorMultiplicityValidation: 'NOT_PERFORMED' };
const directory = 'src/server/db/migrations';
const migrations = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'src/server/migration/localPointerCheckedPreparation.ts',
  'src/server/migration/localPointerCheckedPreparation.test.ts', 'src/server/migration/finalGeneration.ts',
  'src/server/migration/localCapturedSourceCoverage.ts', 'src/server/migration/importer.ts',
  'src/server/migration/manifest.ts', 'src/server/migration/normalize.ts', 'src/server/migration/validators.ts',
  'src/server/migration/__fixtures__/normalization.ts', 'src/server/db/testing/pglite.ts',
  'src/server/db/transaction.ts', 'package.json', 'vitest.config.mts', ...migrations.map((name) => join(directory, name))];
const hashes = () => Object.fromEntries(watched.map((path) => [path, hash(readFileSync(path, 'utf8'))]));
const initialHashes = hashes();
const facts: Record<string, Fact> = {};

type CaptureOptions = { fresh?: boolean; longCell?: boolean; bank?: boolean; author?: string; remove?: boolean; emptyOptional?: boolean };
async function capture(options: CaptureOptions = {}): Promise<Acquisition> {
  const seed = options.bank ? makeSheets() : makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  if (options.longCell) workbook.Notes = [['future'], ['x'.repeat(9_000)]];
  if (options.emptyOptional) {
    delete workbook.Promotions; workbook.PromotionProducts = [workbook.PromotionProducts[0]];
    workbook.UnreviewedEmpty = [['future']];
  }
  const operation = makeRedis().operationBindings[0];
  const old = structuredClone(operation.binding);
  const binding = { ...old, evidence: { ...old.evidence, evidenceAuthorFullName: options.author ?? old.evidence.evidenceAuthorFullName } };
  const claimField = `claim:${hash(`${binding.evidence.evidenceBoardId}\0${binding.evidence.evidencePostId}`)}`;
  const entries: Array<readonly [string, string]> = options.remove ? [] : [
    [claimField, operation.operationId], [`op:${hash(operation.operationId)}`, JSON.stringify({ binding, claimField })],
  ];
  const at = options.fresh ? '2026-09-01T00:00:00.000Z' : '2026-08-31T00:00:00.000Z';
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId, capturedAt: at, reader: {
    listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
    getRevision: async () => options.fresh ? 'sheets-2' : 'sheets-1',
  } });
  const redis = await captureRedisClaimSnapshot({
    hscan: async (key, cursor) => { expect([key, cursor]).toEqual(['padlet:evidence-bindings:v2', '0']);
      return { cursor: '0', entries: structuredClone(entries) }; },
    scan: async (cursor, pattern) => { expect([cursor, pattern]).toEqual(['0', 'padlet:evidence-claim:v1:*']);
      return { cursor: '0', keys: [] }; },
    get: async () => { throw new Error('No v1 fixture key'); },
    getRevision: async () => options.fresh ? 'redis-2' : 'redis-1',
  }, { capturedAt: at });
  return { sheets, redis };
}
const normalize = (tenantId: string, acquisition: Acquisition) => createLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, ...acquisition });
const context = (input: FinalGenerationPreparationInput) => ({ tenantId: input.tenantId, migrationJobId: input.migrationJobId,
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
    actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
    WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`)).rows;
}
async function fixture(h: PgliteDatabaseHarness, fact: Fact) {
  fact.phase = 'real synthetic capture/normalizer';
  const original = await capture();
  const manifest = normalize(h.tenantOneId, original);
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  expect(manifest.records.padlet_evidence_claims).toHaveLength(1);
  expect(manifest.records.legacy_operation_bindings).toHaveLength(1);
  fact.phase = 'real importer';
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [h.tenantOneId, JOB]);
  fact.importResult = await importLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  // Synthetic fixture state, not operational readiness or an external writer freeze.
  for (const status of ['RECONCILING', 'READY']) await h.database.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2', [h.tenantOneId, JOB, status]);
  fact.phase = 'real original inspector';
  const issues = await h.runTenantTransaction(h.tenantOneId, (tx) => inspectLegacyImport(tx, { tenantId: h.tenantOneId, migrationJobId: JOB, manifest }, manifest));
  expect(issues).toEqual([]); fact.inspectorIssues = issues;
  const { rows: versions } = await h.database.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [h.tenantOneId, JOB]);
  const { rows: snapshots } = await h.database.query<{ source_id: string; snapshot_id: string }>("SELECT source_id,snapshot_id FROM migration_snapshots WHERE tenant_id=$1 AND job_id=$2 AND phase='PREFLIGHT'", [h.tenantOneId, JOB]);
  expect(versions).toHaveLength(1); expect(snapshots).toHaveLength(1);
  const input: FinalGenerationPreparationInput = { tenantId: h.tenantOneId, migrationJobId: JOB,
    expectedStateVersion: versions[0].version, originalSourceId: snapshots[0].source_id,
    originalSnapshotId: snapshots[0].snapshot_id, original, candidate: await capture({ fresh: true }), exclusionGenerationReference: 'a'.repeat(64) };
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
// Read real rows inside the actual transaction, even after a JS checker rejection,
// BEFORE the real harness sees the exception and rolls back. No SQL/data substitution.
function observedRunner(f: Fixture, observation: { rows?: Envelope[]; entries: number }): TenantImportTransactionRunner {
  return (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
    observation.entries++;
    try { return await callback(tx); }
    finally {
      const { rows } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,
        actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
        WHERE tenant_id=${tenant} AND job_id=${JOB} AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`);
      observation.rows = rows as Envelope[];
    }
  });
}
async function preserved(f: Fixture) {
  expect(await state(f.h, false)).toEqual(f.nonAudit);
  expect(await f.h.runTenantTransaction(f.input.tenantId, (tx) => inspectLegacyImport(tx,
    { tenantId: f.input.tenantId, migrationJobId: JOB, manifest: f.manifest }, f.manifest))).toEqual([]);
}
async function assertReports(f: Fixture, result: Awaited<ReturnType<typeof stageLocalPointerCheckedPreparation>>, input = f.input) {
  expect(result).toMatchObject(flags);
  expect(result.preparation).toMatchObject({ storage: 'UNTRUSTED_PREPARATION', plan: { status: 'DIFF_VALIDATED', blockers: [] } });
  const rows = await stored(f.h); expect(rows).toHaveLength(3);
  for (const [side, kind, id] of [['original', 'ORIGINAL', result.preparation.originalGenerationId],
    ['candidate', 'CANDIDATE', result.preparation.candidateGenerationId]] as const) {
    const row = rows.find((row) => row.event_id === id)!;
    const manifest = normalize(input.tenantId, input[side]);
    expect(row.redacted_details.acquisition).toEqual(input[side]); expect(row.redacted_details.manifest).toEqual(manifest);
    expect(id).toBe(`preparation:${kind.toLowerCase()}:${digest(row.redacted_details)}`);
    expect(result.reports[side]).toEqual(coverage.verifyLocalCapturedSourceCoverage({ capture: { tenantId: input.tenantId, migrationJobId: JOB, ...input[side] }, manifest }));
    expect(result.reports[side]).toMatchObject({ authority: 'NONAUTHORITY', scope: 'CAPTURED_SOURCE_POINTER_ACCOUNTING_ONLY', status: 'CAPTURE_POINTERS_ACCOUNTED', pointerAccounting: 'ACCOUNTED', normalizationStatus: 'READY_FOR_IMPORT' });
  }
  const plan = rows.find((row) => row.event_id === result.preparation.planId)!;
  expect(plan.event_id).toBe(`preparation:plan:${digest(plan.redacted_details)}`);
  expect(plan.redacted_details).toMatchObject({ ...result.preparation.plan,
    originalGenerationId: result.preparation.originalGenerationId, candidateGenerationId: result.preparation.candidateGenerationId,
    originalManifestDigest: result.reports.original.manifestDigest, candidateManifestDigest: result.reports.candidate.manifestDigest });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.preparation.plan)).toBe(true);
  expect(Object.isFrozen(result.reports)).toBe(true); expect(Object.isFrozen(result.reports.candidate.units)).toBe(true);
  return rows;
}
afterAll(() => {
  const currentHashes = hashes();
  console.info(`POINTER_PREPARATION_EVIDENCE ${JSON.stringify({ ...flags, engine: 'in-memory PGlite only',
    initialHashes, currentHashes, facts })}`);
  expect(currentHashes).toEqual(initialHashes);
});

describe('opt-in local pointer-checked preparation', () => {
  checked('checks two independently bound DB-readback captures before commit and preserves exact retry', async (f) => {
    const spy = vi.spyOn(coverage, 'verifyLocalCapturedSourceCoverage'); // delegates to the real checker
    const observed = { entries: 0 } as { rows?: Envelope[]; entries: number };
    const result = await stageLocalPointerCheckedPreparation(f.input, observedRunner(f, observed));
    expect(observed.entries).toBe(1); expect(observed.rows).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [index, kind] of ['ORIGINAL', 'CANDIDATE'].entries()) {
      const details = observed.rows!.find((row) => row.event_type === `MIGRATION_PREPARATION_${kind}`)!.redacted_details;
      expect(spy.mock.calls[index][0]).toEqual({ capture: { tenantId: f.input.tenantId, migrationJobId: JOB,
        ...(details.acquisition as Acquisition) }, manifest: details.manifest });
      expect(spy.mock.calls[index][0]).not.toBe(f.input);
    }
    spy.mockRestore();
    expect(result.reports.original.manifestDigest).not.toBe(result.reports.candidate.manifestDigest);
    expect(result.reports.original.sheetsDigest).not.toBe(result.reports.candidate.sheetsDigest);
    expect(result.reports.original.redisDigest).not.toBe(result.reports.candidate.redisDigest);
    expect(result.preparation.plan.changes).toEqual([]);
    await assertReports(f, result); await preserved(f);
    const committed = await state(f.h);
    expect(await stageLocalPointerCheckedPreparation(f.input, f.h.runTenantTransaction)).toEqual(result);
    expect(await state(f.h)).toEqual(committed);
    f.fact.witness = { actualRowsBeforeCommit: observed.rows!.length, actualCheckerCalls: 2, retryRowsAndXminUnchanged: true };
  });

  checked('REAL post-append candidate checker limit refusal rolls back three rows; normal retry commits', async (f) => {
    const input = { ...f.input, candidate: await capture({ fresh: true, longCell: true }) };
    expect(normalize(input.tenantId, input.candidate).status).toBe('READY_FOR_IMPORT');
    const spy = vi.spyOn(coverage, 'verifyLocalCapturedSourceCoverage');
    const observed = { entries: 0 } as { rows?: Envelope[]; entries: number };
    await expect(stageLocalPointerCheckedPreparation(input, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
    expect(observed.entries).toBe(1); expect(observed.rows).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.results[0].type).toBe('return'); expect(spy.mock.results[1].type).toBe('throw');
    expect(spy.mock.results[1].value).toEqual(new Error('Captured source pointer accounting limit refused.'));
    const candidate = observed.rows!.find((row) => row.event_type === 'MIGRATION_PREPARATION_CANDIDATE')!;
    expect((candidate.redacted_details.acquisition as Acquisition).sheets.tabs.Notes.rows[0].cells[0]).toHaveLength(9_000);
    expect(observed.rows!.find((row) => row.event_type === 'MIGRATION_PREPARATION_PLAN')!.redacted_details.status).toBe('DIFF_VALIDATED');
    expect(await state(f.h)).toEqual(f.baseline); expect(await stored(f.h)).toEqual([]);
    spy.mockRestore();
    const retry = await stageLocalPointerCheckedPreparation(f.input, f.h.runTenantTransaction);
    await assertReports(f, retry); await preserved(f);
    f.fact.witness = { classification: 'POST_APPEND_REAL_CHECKER_LIMIT', rowsBeforeRollback: observed.rows!.length,
      originalCheckerReturned: true, candidateCheckerThrew: 'Captured source pointer accounting limit refused.',
      exactBaselineRestored: true, retryCommitted: true, missingSourceFamilyEndToEndProven: false };
  });

  checked('accepts same-object acquisition alias without mutating caller input', async (f) => {
    const input = { ...f.input, candidate: f.input.original }; const before = canonicalJson(input);
    const result = await stageLocalPointerCheckedPreparation(input, f.h.runTenantTransaction);
    expect(canonicalJson(input)).toBe(before); expect(Object.isFrozen(input)).toBe(false);
    expect(result.reports.original).toEqual(result.reports.candidate);
    await assertReports(f, result, input); await preserved(f);
  });

  checked('freezes primitive binding before a runner can mutate caller input across await', async (f) => {
    const input = { ...structuredClone(f.input) };
    const result = await stageLocalPointerCheckedPreparation(input, async (tenant, callback) => {
      await Promise.resolve(); input.migrationJobId = 'changed-after-stage-validation'; input.expectedStateVersion = '99';
      input.originalSourceId = 'changed'; input.exclusionGenerationReference = 'b'.repeat(64);
      return f.h.runTenantTransaction(tenant, callback);
    });
    await assertReports(f, result); await preserved(f);
  });

  for (const kind of ['claim mutation', 'claim removal', 'BANK quarantine'] as const) {
    checked(`does not turn ${kind} archived BLOCKED plan into pointer approval`, async (f) => {
      const candidate = await capture({ fresh: true, ...(kind === 'claim mutation' ? { author: 'Changed' }
        : kind === 'claim removal' ? { remove: true } : { bank: true }) });
      const spy = vi.spyOn(coverage, 'verifyLocalCapturedSourceCoverage');
      const observed = { entries: 0 } as { rows?: Envelope[]; entries: number };
      await expect(stageLocalPointerCheckedPreparation({ ...f.input, candidate }, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
      expect(observed.rows).toHaveLength(3);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.results.map((result) => result.type)).toEqual(['return', 'return']);
      expect(observed.rows!.find((row) => row.event_type === 'MIGRATION_PREPARATION_PLAN')!.redacted_details.status).toBe('BLOCKED');
      expect(await state(f.h)).toEqual(f.baseline);
      f.fact.witness = { classification: 'POST_APPEND_EXISTING_BLOCKER', rowsBeforeRollback: 3,
        actualCheckerCalls: spy.mock.calls.length, candidateNormalization: spy.mock.results[1].value.normalizationStatus,
        candidatePointerAccounting: spy.mock.results[1].value.pointerAccounting, exactBaselineRestored: true };
    });
  }

  for (const kind of ['stale capture', 'missing Redis', 'wrong snapshot', 'wrong state version', 'wrong tenant'] as const) {
    checked(`classifies ${kind} refusal as upstream, not a reached pointer checker`, async (f) => {
      let input = f.input;
      if (kind === 'stale capture') input = { ...input, candidate: { ...input.candidate, sheets: { ...input.candidate.sheets, capturedAt: '2020-01-01T00:00:00.000Z' } } };
      if (kind === 'missing Redis') input = { ...input, candidate: { sheets: input.candidate.sheets } as Acquisition };
      if (kind === 'wrong snapshot') input = { ...input, originalSnapshotId: 'wrong-snapshot' };
      if (kind === 'wrong state version') input = { ...input, expectedStateVersion: '999' };
      if (kind === 'wrong tenant') input = { ...input, tenantId: f.h.tenantTwoId };
      const spy = vi.spyOn(coverage, 'verifyLocalCapturedSourceCoverage');
      const observed = { entries: 0 } as { rows?: Envelope[]; entries: number };
      await expect(stageLocalPointerCheckedPreparation(input, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
      expect(spy).not.toHaveBeenCalled(); expect(observed.rows ?? []).toEqual([]);
      expect(await state(f.h)).toEqual(f.baseline);
      f.fact.witness = { classification: 'UPSTREAM_REJECTION', entries: observed.entries, checkerCalls: 0, exactBaselineRestored: true };
    });
  }

  checked('keeps optional absence, observed empty and unreviewed family visible', async (f) => {
    const input = { ...f.input, candidate: await capture({ fresh: true, emptyOptional: true }) };
    const result = await stageLocalPointerCheckedPreparation(input, f.h.runTenantTransaction);
    const families = result.reports.candidate.families;
    expect(families.find((r) => r.family === 'SHEET:Promotions')).toMatchObject({ presence: 'ABSENT_IN_CAPTURE', expectedSourceUnits: null });
    expect(families.find((r) => r.family === 'SHEET:PromotionProducts')).toMatchObject({ presence: 'PRESENT_EMPTY', expectedSourceUnits: 0 });
    expect(families.find((r) => r.family === 'SHEET:UNREVIEWED')).toMatchObject({ presence: 'PRESENT_EMPTY', review: 'UNREVIEWED_FAMILY' });
    await assertReports(f, result, input); await preserved(f);
  });

  checked('refuses absent or non-calling runners without a default production transaction', async (f) => {
    await expect(stageLocalPointerCheckedPreparation(f.input, undefined as unknown as TenantImportTransactionRunner)).rejects.toThrow(REFUSAL);
    const nonCalling: TenantImportTransactionRunner = async <TResult>() => ({ storage: 'UNTRUSTED_PREPARATION' } as TResult);
    await expect(stageLocalPointerCheckedPreparation(f.input, nonCalling)).rejects.toThrow(REFUSAL);
    expect(await state(f.h)).toEqual(f.baseline);
  });

  checked('distinguishes pre-commit failure after checks from response loss after commit', async (f) => {
    let preCommitRows = 0;
    await expect(stageLocalPointerCheckedPreparation(f.input, (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
      await callback(tx);
      preCommitRows = (await tx.execute(sql`SELECT event_id FROM audit_events WHERE tenant_id=${tenant} AND event_type LIKE 'MIGRATION_PREPARATION_%'`)).rows.length;
      throw new Error('private pre-commit failure must not leak');
    }))).rejects.toThrow(REFUSAL);
    expect(preCommitRows).toBe(3); expect(await state(f.h)).toEqual(f.baseline);
    let acknowledgedCommit = false;
    await expect(stageLocalPointerCheckedPreparation(f.input, async (tenant, callback) => {
      await f.h.runTenantTransaction(tenant, callback); acknowledgedCommit = true;
      throw new Error('private post-commit caller response failure must not leak');
    })).rejects.toThrow(REFUSAL);
    expect(acknowledgedCommit).toBe(true); expect(await stored(f.h)).toHaveLength(3);
    const committed = await state(f.h);
    const retry = await stageLocalPointerCheckedPreparation(f.input, f.h.runTenantTransaction);
    await assertReports(f, retry); expect(await state(f.h)).toEqual(committed); await preserved(f);
    f.fact.witness = { preCommitRows, preCommitBaselineRestored: true, acknowledgedCommit,
      postCommitRowsRemain: true, postCommitRollbackClaimed: false, retryXminUnchanged: true };
  });

  checked('pure readback-copy boundary rejects metadata, binding, digest and pointer substitutions (not DB tampering)', async (f) => {
    const result = await stageLocalPointerCheckedPreparation(f.input, f.h.runTenantTransaction);
    const rows = await stored(f.h); const binding = context(f.input);
    expect(inspectLocalPointerPreparationEnvelopes(binding, result.preparation, rows)).toEqual(result.reports);
    const cases: Array<[string, (copy: Envelope[]) => void]> = [
      ['duplicate row', (r) => { r[1] = structuredClone(r[0]); }],
      ['missing row', (r) => { r.pop(); }],
      ['foreign tenant', (r) => { r[0].tenant_id = f.h.tenantTwoId; }],
      ['wrong job', (r) => { r[0].job_id = 'other-job'; }],
      ['event type', (r) => { r[0].event_type = 'OTHER'; }],
      ['phase', (r) => { r[0].redacted_details.phase = 'ACTIVE'; }],
      ['storage', (r) => { r[0].redacted_details.storage = 'APPROVED'; }],
      ['extra field', (r) => { r[0].redacted_details.authority = 'ACTIVE'; }],
      ['actor', (r) => { Object.assign(r[0], { actor_user_id: f.h.tenantOneId }); }],
      ['operation', (r) => { Object.assign(r[0], { operation_id: f.h.tenantOneId }); }],
      ['entity', (r) => { Object.assign(r[0], { entity_type: 'MIGRATION', entity_id: f.input.migrationJobId }); }],
      ['snapshot', (r) => { r.find((x) => x.event_type.endsWith('_ORIGINAL'))!.redacted_details.originalSnapshotId = 'foreign'; }],
      ['binding version', (r) => { (r.find((x) => x.event_type.endsWith('_CANDIDATE'))!.redacted_details.binding as Record<string, unknown>).expectedStateVersion = '99'; }],
      ['candidate original link', (r) => { r.find((x) => x.event_type.endsWith('_CANDIDATE'))!.redacted_details.originalGenerationId = 'wrong'; }],
      ['exclusion label', (r) => { r.find((x) => x.event_type.endsWith('_CANDIDATE'))!.redacted_details.exclusionGenerationReference = 'b'.repeat(64); }],
      ['plan manifest link', (r) => { r.find((x) => x.event_type.endsWith('_PLAN'))!.redacted_details.candidateManifestDigest = 'f'.repeat(64); }],
      ['swapped manifest', (r) => { r.find((x) => x.event_type.endsWith('_CANDIDATE'))!.redacted_details.manifest = r.find((x) => x.event_type.endsWith('_ORIGINAL'))!.redacted_details.manifest; }],
    ];
    for (const [label, mutate] of cases) {
      const copy = structuredClone(rows); mutate(copy);
      expect(() => inspectLocalPointerPreparationEnvelopes(binding, result.preparation, copy), label).toThrow(REFUSAL);
    }
    // Every relational link still matches; ONLY the plan's content address is false.
    const forged = { ...structuredClone(result.preparation), planId: `preparation:plan:${'f'.repeat(64)}` };
    const copy = structuredClone(rows);
    copy.find((row) => row.event_type.endsWith('_PLAN'))!.event_id = forged.planId;
    expect(() => inspectLocalPointerPreparationEnvelopes(binding, forged, copy)).toThrow(REFUSAL);
    let getters = 0;
    Object.defineProperty(copy[0], 'tenant_id', { enumerable: true, configurable: true,
      get: () => { getters++; throw new Error('private getter'); } });
    expect(() => inspectLocalPointerPreparationEnvelopes(binding, result.preparation, copy)).toThrow(REFUSAL);
    expect(getters).toBe(0);
    let traps = 0;
    const proxy = new Proxy(rows, { get: () => { traps++; throw new Error('private proxy'); } });
    expect(() => inspectLocalPointerPreparationEnvelopes(binding, result.preparation, proxy)).toThrow(REFUSAL);
    expect(traps).toBe(0);
    expect(await stored(f.h)).toEqual(rows);
    f.fact.copyBoundaryNegatives = [...cases.map(([name]) => name), 'false content address with matching links', 'getter without invocation', 'proxy without trap'];
    f.fact.copyBoundaryIsPersistedCorruption = false;
  });
});
