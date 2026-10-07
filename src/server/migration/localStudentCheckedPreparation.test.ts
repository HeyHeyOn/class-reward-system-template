// @vitest-environment node
// Synthetic in-memory PGlite; never live source, real PostgreSQL or final authority.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { importLegacyNormalizationManifest, inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson } from './validators';
import * as students from './localCapturedStudentProjection';
import * as delta from './localFullCategoryDeltaCoverage';
import * as fullStage from './localFullDeltaCheckedPreparation';
import { inspectLocalStudentPreparationEnvelopes, stageLocalStudentCheckedPreparation } from './localStudentCheckedPreparation';

vi.mock('server-only', () => ({})); // Environment marker only, no business implementation replacement.
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Local student-checked preparation refused.';
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
type Acquisition = FinalGenerationPreparationInput['original'];

type Details = { acquisition: Acquisition; manifest: LegacyNormalizationManifest };
type Envelope = { tenant_id: string; event_id: string; job_id: string; event_type: string;
  operation_id: null; actor_user_id: null; entity_type: null; entity_id: null; redacted_details: Record<string, unknown> };
type Fact = Record<string, unknown>;
const facts: Record<string, Fact> = {};
const flags = { scope: 'LOCAL_STUDENT_CHECKED_PREPARATION_ONLY', authority: 'NONAUTHORITY', complete: false,
  activationAllowed: false, exclusion: 'NOT_PROVEN', fullSourceReconciliation: 'NOT_PERFORMED',
  fullTargetReconciliation: 'NOT_PERFORMED', preRedactionInventory: 'NOT_OBSERVED',
  canonicalBusinessValidation: 'NOT_PERFORMED', contributorMultiplicityValidation: 'NOT_PERFORMED' };
const studentFlags = { status: 'CAPTURED_STUDENT_PROJECTION_ACCOUNTED', authority: 'NONAUTHORITY',
  complete: false, activationAllowed: false, binding: 'CONTENT_DIGESTS_ONLY', sourceAuthenticity: 'NOT_PROVEN',
  fullSourceReconciliation: 'NOT_PERFORMED', fullTargetReconciliation: 'NOT_PERFORMED',
  semanticFingerprintValidation: 'NOT_PERFORMED', contributorMultiplicityValidation: 'STUDENTS_ONLY' };
const directory = 'src/server/db/migrations';
const migrations = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'src/server/migration/localFullDeltaCheckedPreparation.ts',
  'src/server/migration/localFullDeltaCheckedPreparation.test.ts', 'src/server/migration/localCapturedStudentProjection.ts',
  'src/server/migration/localCapturedStudentProjection.test.ts', 'src/server/migration/localCapturedSourceCoverage.ts',
  'src/server/migration/localFullCategoryDeltaCoverage.ts', 'src/server/migration/localPointerCheckedPreparation.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts', 'src/server/migration/manifest.ts',
  'src/server/migration/normalize.ts', 'src/server/migration/validators.ts', 'src/server/migration/__fixtures__/normalization.ts',
  'src/server/db/testing/pglite.ts', 'src/server/db/transaction.ts', 'package.json', 'vitest.config.mts',
  ...migrations.map((name) => join(directory, name))];
// Hash raw bytes, including the binary Git index; never decode index as UTF-8.
const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sourceHashes = () => Object.fromEntries(watched.map((path) => [path, fileHash(path)]));
const initialHashes = sourceHashes();

type Options = { added?: boolean; extraColumn?: boolean; mutated?: boolean; invalid?: boolean; longCell?: boolean; revision?: string };
async function capture(options: Options = {}): Promise<Acquisition> {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  if (options.added) workbook.Students.push(['S2', 'Synthetic Bob', '-7', 'INACTIVE']);
  if (options.extraColumn) {
    workbook.Students[0].push('unreviewed');
    for (const row of workbook.Students.slice(1)) row.push('synthetic extra field');
  }
  if (options.mutated) workbook.Students[1][1] = 'Synthetic changed name';
  if (options.invalid) workbook.Students[1][2] = 'not-an-integer';
  if (options.longCell) workbook.Notes = [['future'], ['x'.repeat(9_000)]];
  // Mutations must not reuse the original raw revision and accidentally stop at
  // the pointer gate when a test intends to reach the full-delta/student gate.
  const revision = options.revision ?? `synthetic-students-${createHash('sha256').update(canonicalJson(workbook)).digest('hex')}`;
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId,
    capturedAt: options.added ? '2026-09-01T00:00:00.000Z' : seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => revision } });
  const operation = makeRedis().operationBindings[0];
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const claimField = `claim:${hash(`${operation.binding.evidence.evidenceBoardId}\0${operation.binding.evidence.evidencePostId}`)}`;
  const entries: Array<readonly [string, string]> = [[claimField, operation.operationId],
    [`op:${hash(operation.operationId)}`, JSON.stringify({ binding: operation.binding, claimField })]];
  const redis = await captureRedisClaimSnapshot({
    hscan: async (key, cursor) => { expect([key, cursor]).toEqual(['padlet:evidence-bindings:v2', '0']); return { cursor: '0', entries: structuredClone(entries) }; },
    scan: async (cursor, pattern) => { expect([cursor, pattern]).toEqual(['0', 'padlet:evidence-claim:v1:*']); return { cursor: '0', keys: [] }; },
    get: async () => { throw new Error('No synthetic v1 key'); }, getRevision: async () => 'synthetic-redis',
  }, { capturedAt: seed.capturedAt });
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
function envelope(rows: Envelope[], kind: string) { return rows.find((row) => row.event_type === `MIGRATION_PREPARATION_${kind}`)!; }
function details(rows: Envelope[], kind: string) { return envelope(rows, kind).redacted_details as unknown as Details; }
async function fixture(h: PgliteDatabaseHarness, fact: Fact, originalExtra: boolean) {
  const original = await capture({ extraColumn: originalExtra });
  const manifest = normalize(h.tenantOneId, original);
  expect(manifest.status).toBe('READY_FOR_IMPORT'); expect(manifest.records.padlet_evidence_claims).toHaveLength(1);
  fact.phase = 'actual importer';
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [h.tenantOneId, JOB]);
  fact.importResult = await importLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  // Existing synthetic harness state, NOT an operational READY/exclusion receipt.
  for (const status of ['RECONCILING', 'READY']) await h.database.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2', [h.tenantOneId, JOB, status]);
  fact.phase = 'actual original inspector';
  expect(await h.runTenantTransaction(h.tenantOneId, (tx) => inspectLegacyImport(tx,
    { tenantId: h.tenantOneId, migrationJobId: JOB, manifest }, manifest))).toEqual([]);
  const { rows } = await h.database.query<{ version: string; source_id: string; snapshot_id: string }>(
    `SELECT j.state_version::text AS version,s.source_id,s.snapshot_id FROM migration_jobs j JOIN migration_snapshots s USING(tenant_id,job_id)
     WHERE j.tenant_id=$1 AND j.job_id=$2 AND s.phase='PREFLIGHT'`, [h.tenantOneId, JOB]);
  expect(rows).toHaveLength(1);
  const input: FinalGenerationPreparationInput = { tenantId: h.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSourceId: rows[0].source_id, originalSnapshotId: rows[0].snapshot_id, original, candidate: await capture({ added: true }),
    exclusionGenerationReference: 'a'.repeat(64) };
  expect(await stored(h)).toEqual([]); fact.phase = 'test body';
  return { h, input, manifest, fact, baseline: await state(h), nonAudit: await state(h, false) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function checked(name: string, body: (f: Fixture) => Promise<void>, originalExtra = false) {
  it(name, async () => {
    const fact: Fact = { phase: 'in-memory PGlite DDL', status: 'running', closed: false }; facts[name] = fact;
    let h: PgliteDatabaseHarness | undefined;
    try {
      h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
      for (const name of migrations.filter((name) => name.slice(0, 4) > '0008')) await h.database.exec(readFileSync(join(directory, name), 'utf8'));
      await body(await fixture(h, fact, originalExtra)); fact.status = 'passed';
    } catch (error) { fact.status = 'failed'; fact.error = error instanceof Error ? error.message : String(error); throw error;
    } finally { vi.restoreAllMocks(); await h?.close(); fact.closed = Boolean(h); }
  }, 0);
}
type Observation = { entries: number; rows?: Envelope[]; studentCalls?: number; fullCalls?: number };
function observedRunner(f: Fixture, observed: Observation,
  calls?: { student: () => number; full: () => number }): TenantImportTransactionRunner {
  return (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
    observed.entries++;
    try { return await callback(tx); }
    finally {
      // The actual connection is still in the transaction, BEFORE COMMIT/ROLLBACK.
      observed.rows = (await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,
        actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
        WHERE tenant_id=${tenant} AND job_id=${JOB} AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`)).rows as Envelope[];
      observed.studentCalls = calls?.student(); observed.fullCalls = calls?.full();
    }
  });
}
function expectedOperand(f: Fixture, rows: Envelope[], kind: string) {
  const { acquisition, manifest } = details(rows, kind);
  return { capture: { tenantId: f.input.tenantId, migrationJobId: JOB, ...acquisition }, manifest };
}
async function unchanged(f: Fixture) {
  expect(await state(f.h, false)).toEqual(f.nonAudit);
  expect(await f.h.runTenantTransaction(f.input.tenantId, (tx) => inspectLegacyImport(tx,
    { tenantId: f.input.tenantId, migrationJobId: JOB, manifest: f.manifest }, f.manifest))).toEqual([]);
}
function observers() {
  // Delegating spies: real exported implementations and real thrown errors execute.
  const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
  const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
  return { student, full, counts: { student: () => student.mock.calls.length, full: () => full.mock.calls.length } };
}
afterAll(() => {
  const finalHashes = sourceHashes();
  console.info('STUDENT_PREPARATION_EVIDENCE ' + JSON.stringify({ ...flags, engine: 'in-memory PGlite only',
    originalDenominator: 'ARCHIVED_ORIGINAL_ACQUISITION', initialHashes, finalHashes, facts,
    implementationHash: fileHash('src/server/migration/localStudentCheckedPreparation.ts'),
    testHash: fileHash('src/server/migration/localStudentCheckedPreparation.test.ts'),
    realPostgreSQLExecuted: false, liveSourceAccessed: false }));
  expect(finalHashes).toEqual(initialHashes);
});

describe('opt-in same-transaction archived student projection', () => {
  checked('commits the actual two-denominator checks and exact three-envelope readback, then retries without writes', async (f) => {
    const { student, full, counts } = observers();
    const stage = vi.spyOn(fullStage, 'stageLocalFullDeltaCheckedPreparation');
    const observed: Observation = { entries: 0 }; const before = canonicalJson(f.input);
    const result = await stageLocalStudentCheckedPreparation(f.input, observedRunner(f, observed, counts));
    expect(result).toMatchObject(flags); expect(stage).toHaveBeenCalledTimes(1);
    expect(observed).toMatchObject({ entries: 1, studentCalls: 2, fullCalls: 2 });
    expect(observed.rows).toHaveLength(3); expect(full.mock.results.every((r) => r.type === 'return')).toBe(true);
    expect(student.mock.calls).toEqual([[expectedOperand(f, observed.rows!, 'ORIGINAL')], [expectedOperand(f, observed.rows!, 'CANDIDATE')]]);
    expect(student.mock.results.every((r) => r.type === 'return')).toBe(true);
    expect(result.studentProjection.original).toMatchObject({ ...studentFlags, expectedSourceUnits: 1,
      studentRows: 1, accountRows: 1, sourceRecordReferences: 1, mappingReferences: 2 });
    expect(result.studentProjection.candidate).toMatchObject({ ...studentFlags, expectedSourceUnits: 2,
      studentRows: 2, accountRows: 2, sourceRecordReferences: 2, mappingReferences: 4 });
    const rows = await stored(f.h); expect(rows).toEqual(observed.rows);
    for (const [kind, id] of [['ORIGINAL', result.preparation.originalGenerationId], ['CANDIDATE', result.preparation.candidateGenerationId], ['PLAN', result.preparation.planId]]) {
      expect(envelope(rows, kind).event_id).toBe(id);
      expect(id).toBe(`preparation:${kind.toLowerCase()}:${digest(envelope(rows, kind).redacted_details)}`);
    }
    expect(details(rows, 'ORIGINAL').acquisition).toEqual(f.input.original);
    expect(details(rows, 'CANDIDATE').acquisition).toEqual(f.input.candidate);
    expect(details(rows, 'ORIGINAL').manifest).toEqual(f.manifest);
    expect(details(rows, 'CANDIDATE').manifest).toEqual(normalize(f.input.tenantId, f.input.candidate));
    expect(details(rows, 'ORIGINAL').acquisition.sheets.tabs.Students.rows).toHaveLength(1);
    expect(details(rows, 'CANDIDATE').acquisition.sheets.tabs.Students.rows[1].cells).toEqual(['S2', 'Synthetic Bob', '-7', 'INACTIVE']);
    expect(result.preparation.plan.changes).toHaveLength(2); await unchanged(f);
    const committed = await state(f.h);
    expect(await stageLocalStudentCheckedPreparation(f.input, f.h.runTenantTransaction)).toEqual(result);
    expect(await state(f.h)).toEqual(committed); expect(canonicalJson(f.input)).toBe(before);
    expect(Object.isFrozen(f.input)).toBe(false); expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.studentProjection.original)).toBe(true);
    f.fact.witness = { classification: 'ACTUAL_PGLITE_COMMIT', actualRowsBeforeCommit: 3,
      fullChecksBeforeCommit: observed.fullCalls, studentChecksBeforeCommit: observed.studentCalls,
      originalRawRows: 1, candidateRawRows: 2, retryRowsAndXminUnchanged: true };
  });

  checked('actual candidate unreviewed column reaches student checker after append and full success, then rolls back', async (f) => {
    const input = { ...f.input, candidate: await capture({ added: true, extraColumn: true }) };
    expect(normalize(input.tenantId, input.candidate).status).toBe('READY_FOR_IMPORT');
    const { student, full, counts } = observers(); const observed: Observation = { entries: 0 };
    await expect(stageLocalStudentCheckedPreparation(input, observedRunner(f, observed, counts))).rejects.toThrow(REFUSAL);
    expect(observed).toMatchObject({ entries: 1, studentCalls: 2, fullCalls: 2 }); expect(observed.rows).toHaveLength(3);
    expect(full.mock.results.every((r) => r.type === 'return')).toBe(true);
    expect(student.mock.calls).toEqual([[expectedOperand(f, observed.rows!, 'ORIGINAL')], [expectedOperand(f, observed.rows!, 'CANDIDATE')]]);
    expect(student.mock.results[0].type).toBe('return');
    expect(student.mock.results[1]).toMatchObject({ type: 'throw', value: new students.LocalCapturedStudentProjectionError('STUDENT_PROJECTION') });
    expect(await state(f.h)).toEqual(f.baseline); expect(await stored(f.h)).toEqual([]);
    const result = await stageLocalStudentCheckedPreparation(f.input, f.h.runTenantTransaction);
    expect(result).toMatchObject(flags); expect(await stored(f.h)).toHaveLength(3); await unchanged(f);
    f.fact.witness = { classification: 'POST_APPEND_ACTUAL_CANDIDATE_STUDENT_REFUSAL', actualRowsBeforeRollback: 3,
      actualFullChecksReturned: 2, actualOriginalStudentReturned: true, actualCandidateStudentThrew: true,
      baselineRowsAndXminRestored: true, subsequentValidCommit: true, rejectionReason: 'UNREVIEWED_EXTRA_COLUMN_NOT_CORRUPTION' };
  });

  checked('actual ORIGINAL extra column is independently rejected, not replaced by candidate denominator', async (f) => {
    const { student, full, counts } = observers(); const observed: Observation = { entries: 0 };
    await expect(stageLocalStudentCheckedPreparation(f.input, observedRunner(f, observed, counts))).rejects.toThrow(REFUSAL);
    expect(observed).toMatchObject({ entries: 1, studentCalls: 1, fullCalls: 2 }); expect(observed.rows).toHaveLength(3);
    expect(full.mock.results.every((r) => r.type === 'return')).toBe(true);
    expect(student.mock.calls).toEqual([[expectedOperand(f, observed.rows!, 'ORIGINAL')]]);
    expect(student.mock.results[0]).toMatchObject({ type: 'throw', value: new students.LocalCapturedStudentProjectionError('STUDENT_PROJECTION') });
    expect(await state(f.h)).toEqual(f.baseline); expect(await stored(f.h)).toEqual([]); await unchanged(f);
    f.fact.witness = { classification: 'POST_APPEND_ACTUAL_ORIGINAL_STUDENT_REFUSAL', actualRowsBeforeRollback: 3,
      fullChecksReturned: 2, originalStudentThrew: true, candidateStudentCalls: 0, baselineRowsAndXminRestored: true };
  }, true);

  for (const kind of ['version', 'snapshot', 'inspector', 'READY', 'missing original'] as const) {
    checked(`keeps upstream ${kind} rejection before append distinct from student failure`, async (f) => {
      let input = f.input;
      if (kind === 'version') input = { ...input, expectedStateVersion: '999' };
      if (kind === 'snapshot') input = { ...input, originalSnapshotId: 'wrong' };
      if (kind === 'missing original') input = { ...input, original: undefined as unknown as Acquisition };
      if (kind === 'inspector') await f.h.database.query("UPDATE students SET name='Unexpected synthetic target' WHERE tenant_id=$1", [input.tenantId]);
      if (kind === 'READY') {
        const { rows } = await f.h.database.query<{ version: string }>("UPDATE migration_jobs SET status='ABORTED',completed_at=now(),updated_at=now(),state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2 RETURNING state_version::text AS version", [input.tenantId, JOB]);
        input = { ...input, expectedStateVersion: rows[0].version };
      }
      const baseline = await state(f.h); const { student, full } = observers(); const observed: Observation = { entries: 0 };
      await expect(stageLocalStudentCheckedPreparation(input, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
      expect(student).not.toHaveBeenCalled(); expect(full).not.toHaveBeenCalled(); expect(observed.rows ?? []).toEqual([]);
      expect(await state(f.h)).toEqual(baseline);
      f.fact.witness = { classification: 'UPSTREAM_PREAPPEND', actualRowsBeforeRollback: 0, studentCalls: 0 };
    });
  }
  for (const kind of ['mutated', 'invalid', 'longCell'] as const) {
    checked(`keeps upstream ${kind} failure after append distinct from student failure`, async (f) => {
      const input = { ...f.input, candidate: await capture({ [kind]: true }) };
      const { student, full } = observers(); const observed: Observation = { entries: 0 };
      await expect(stageLocalStudentCheckedPreparation(input, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
      expect(observed.rows).toHaveLength(3); expect(student).not.toHaveBeenCalled();
      if (kind === 'mutated') { expect(full).toHaveBeenCalledTimes(1); expect(full.mock.results[0].type).toBe('throw'); }
      else expect(full).not.toHaveBeenCalled();
      expect(await state(f.h)).toEqual(f.baseline);
      f.fact.witness = { classification: 'UPSTREAM_POSTAPPEND_NOT_STUDENT', reason: kind, actualRowsBeforeRollback: 3, studentCalls: 0 };
    });
  }

  checked('contradictory same-revision mutation is rejected at pointer before full/student checks with actual rollback', async (f) => {
    const candidate = await capture({ mutated: true, revision: f.input.original.sheets.sourceRevision });
    expect(candidate.sheets.sourceRevision).toBe(f.input.original.sheets.sourceRevision);
    expect(candidate.sheets.tabs.Students.rows).not.toEqual(f.input.original.sheets.tabs.Students.rows);
    const { student, full } = observers(); const observed: Observation = { entries: 0 };
    await expect(stageLocalStudentCheckedPreparation({ ...f.input, candidate }, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
    expect(observed.rows).toHaveLength(3); expect(full).not.toHaveBeenCalled(); expect(student).not.toHaveBeenCalled();
    expect(await state(f.h)).toEqual(f.baseline); expect(await stored(f.h)).toEqual([]);
    f.fact.witness = { classification: 'SAME_REVISION_RAW_CONTRADICTION_POSTAPPEND', actualRowsBeforeRollback: 3,
      fullCalls: 0, studentCalls: 0, baselineRowsAndXminRestored: true };
  });

  checked('snapshots binding before await and checks archived raw values rather than subsequently swapped caller captures', async (f) => {
    const input = structuredClone(f.input); const { student } = observers();
    const result = await stageLocalStudentCheckedPreparation(input, async (tenant, callback) => {
      await Promise.resolve();
      Object.assign(input, { migrationJobId: 'changed', expectedStateVersion: '999', originalSnapshotId: 'changed',
        exclusionGenerationReference: 'b'.repeat(64), original: input.candidate, candidate: input.original });
      return f.h.runTenantTransaction(tenant, callback);
    });
    expect(result).toMatchObject(flags); const rows = await stored(f.h);
    expect(student.mock.calls).toEqual([[expectedOperand(f, rows, 'ORIGINAL')], [expectedOperand(f, rows, 'CANDIDATE')]]);
    expect(result.studentProjection.original.expectedSourceUnits).toBe(1);
    expect(result.studentProjection.candidate.expectedSourceUnits).toBe(2); await unchanged(f);
  });

  checked('requires explicit non-proxy runner and accepts no caller projection/manifest, without a default connection', async (f) => {
    const { student } = observers(); let traps = 0;
    const proxy = new Proxy(f.h.runTenantTransaction, { apply: () => { traps++; throw new Error('private'); } });
    for (const runner of [undefined, proxy]) await expect(stageLocalStudentCheckedPreparation(f.input,
      runner as TenantImportTransactionRunner)).rejects.toThrow(REFUSAL);
    await expect(stageLocalStudentCheckedPreparation({ ...f.input, studentProjection: { complete: true } } as FinalGenerationPreparationInput,
      f.h.runTenantTransaction)).rejects.toThrow(REFUSAL);
    expect(traps).toBe(0); expect(student).not.toHaveBeenCalled(); expect(await state(f.h)).toEqual(f.baseline);
  });

  checked('rejects omitted callback even with a previously valid cached preparation and does not reuse evidence', async (f) => {
    const prior = await stageLocalStudentCheckedPreparation(f.input, f.h.runTenantTransaction);
    const committed = await state(f.h); const { student } = observers();
    const omitted: TenantImportTransactionRunner = async <TResult>() => prior.preparation as unknown as TResult;
    await expect(stageLocalStudentCheckedPreparation(f.input, omitted)).rejects.toThrow(REFUSAL);
    expect(student).not.toHaveBeenCalled(); expect(await state(f.h)).toEqual(committed);
    f.fact.witness = { classification: 'CALLBACK_OMITTED', studentCalls: 0, priorRowsRetained: true };
  });

  checked('result substitution is rejected after a genuine commit, never mislabeled as rollback', async (f) => {
    const { student } = observers(); let committedAck = false;
    await expect(stageLocalStudentCheckedPreparation(f.input, async (tenant, callback) => {
      const result = await f.h.runTenantTransaction(tenant, callback); committedAck = true;
      return structuredClone(result); // Equal bytes, wrong callback-result identity.
    })).rejects.toThrow(REFUSAL);
    expect(committedAck).toBe(true); expect(student).toHaveBeenCalledTimes(2); expect(await stored(f.h)).toHaveLength(3);
    const committed = await state(f.h); await unchanged(f);
    expect(await stageLocalStudentCheckedPreparation(f.input, f.h.runTenantTransaction)).toMatchObject(flags);
    expect(await state(f.h)).toEqual(committed);
    f.fact.witness = { classification: 'POST_COMMIT_RESULT_SUBSTITUTION', committedAck: true, persistedRows: 3, rollbackClaimed: false };
  });

  checked('precommit runner failure really rolls back; clean retry rechecks both acquisitions', async (f) => {
    const { student } = observers(); let attempts = 0;
    const retrying: TenantImportTransactionRunner = async (tenant, callback) => {
      await expect(f.h.runTenantTransaction(tenant, async (tx) => {
        attempts++; await callback(tx); throw new Error('synthetic precommit failure');
      })).rejects.toThrow('synthetic precommit failure');
      expect(student).toHaveBeenCalledTimes(2); expect(await state(f.h)).toEqual(f.baseline);
      return f.h.runTenantTransaction(tenant, (tx) => { attempts++; return callback(tx); });
    };
    const result = await stageLocalStudentCheckedPreparation(f.input, retrying);
    expect(result).toMatchObject(flags); expect(attempts).toBe(2); expect(student).toHaveBeenCalledTimes(4);
    expect(await stored(f.h)).toHaveLength(3); await unchanged(f);
    f.fact.witness = { classification: 'RUNNER_PRECOMMIT_FAILURE_THEN_RETRY', attempts, actualStudentCalls: 4,
      failedAttemptBaselineRestored: true, finalCommit: true, checkerFailureClaimed: false };
  });

  checked('lost commit response reports failure while preserving committed rows and idempotent recovery', async (f) => {
    const { student } = observers(); let committedAck = false;
    await expect(stageLocalStudentCheckedPreparation(f.input, async (tenant, callback) => {
      await f.h.runTenantTransaction(tenant, callback); committedAck = true; throw new Error('private commit response loss');
    })).rejects.toThrow(REFUSAL);
    expect(committedAck).toBe(true); expect(student).toHaveBeenCalledTimes(2); expect(await stored(f.h)).toHaveLength(3);
    const committed = await state(f.h); await unchanged(f);
    expect(await stageLocalStudentCheckedPreparation(f.input, f.h.runTenantTransaction)).toMatchObject(flags);
    expect(await state(f.h)).toEqual(committed);
    f.fact.witness = { classification: 'POST_COMMIT_RESPONSE_LOSS', committedAck: true, persistedRows: 3, rollbackClaimed: false };
  });

  checked('pure copy inspection revalidates exact envelopes before extracting either capture', async (f) => {
    const result = await stageLocalStudentCheckedPreparation(f.input, f.h.runTenantTransaction);
    const rows = await stored(f.h); const context = binding(f.input);
    expect(inspectLocalStudentPreparationEnvelopes(context, result.preparation, rows).studentProjection).toEqual(result.studentProjection);
    const { student } = observers();
    const mutations: Array<[string, (copy: Envelope[]) => void]> = [
      ['missing', (r) => { r.pop(); }], ['duplicate', (r) => { r[1] = structuredClone(r[0]); }],
      ['tenant', (r) => { r[0].tenant_id = f.h.tenantTwoId; }], ['job', (r) => { r[0].job_id = 'other'; }],
      ['swapped acquisition', (r) => { envelope(r, 'ORIGINAL').redacted_details.acquisition = details(r, 'CANDIDATE').acquisition; }],
      ['missing original raw', (r) => { delete envelope(r, 'ORIGINAL').redacted_details.acquisition; }],
      ['manifest', (r) => { envelope(r, 'CANDIDATE').redacted_details.manifest = details(r, 'ORIGINAL').manifest; }],
      ['plan', (r) => { envelope(r, 'PLAN').redacted_details.changes = []; }],
    ];
    for (const [name, mutate] of mutations) {
      const copy = structuredClone(rows); mutate(copy);
      expect(() => inspectLocalStudentPreparationEnvelopes(context, result.preparation, copy), name).toThrow(REFUSAL);
    }
    let getters = 0; const copy = structuredClone(rows);
    Object.defineProperty(envelope(copy, 'ORIGINAL').redacted_details, 'acquisition', { enumerable: true,
      get: () => { getters++; throw new Error('private raw source'); } });
    expect(() => inspectLocalStudentPreparationEnvelopes(context, result.preparation, copy)).toThrow(REFUSAL);
    expect(() => inspectLocalStudentPreparationEnvelopes(context, result.preparation, new Proxy(rows, {
      get: () => { getters++; throw new Error('private proxy'); }, ownKeys: () => { getters++; return []; },
    }))).toThrow(REFUSAL);
    expect(getters).toBe(0); expect(student).not.toHaveBeenCalled(); expect(await stored(f.h)).toEqual(rows);
    f.fact.witness = { classification: 'PURE_READBACK_COPIES_ONLY', cases: mutations.map(([name]) => name),
      actualStudentCallsForInvalidCopies: 0, storedTamperingClaimed: false };
  });

  for (const kind of ['missing', 'duplicate', 'swapped acquisition', 'mutated plan'] as const) {
    checked(`additional transactional readback ${kind} substitution is rejected before student checks`, async (f) => {
      let reads = 0; const { student, full } = observers(); const observed: Observation = { entries: 0 };
      const runner: TenantImportTransactionRunner = (tenant, callback) => observedRunner(f, observed)(tenant, async (tx) => {
        const execute = tx.execute.bind(tx);
        const spy = vi.spyOn(tx, 'execute').mockImplementation((query) => {
          const pending = execute(query); const realPending = pending.execute.bind(pending);
          pending.execute = async () => {
            const result = await realPending();
            if (result.rows.length === 3 && result.rows.every((row) => 'event_id' in row && 'redacted_details' in row)) {
              reads++;
              if (reads === 3) {
                const rows = structuredClone(result.rows) as Envelope[];
                if (kind === 'missing') rows.pop();
                if (kind === 'duplicate') rows[1] = structuredClone(rows[0]);
                if (kind === 'swapped acquisition') envelope(rows, 'ORIGINAL').redacted_details.acquisition = details(rows, 'CANDIDATE').acquisition;
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
      await expect(stageLocalStudentCheckedPreparation(f.input, runner)).rejects.toThrow(REFUSAL);
      expect(reads).toBe(3); expect(full).toHaveBeenCalledTimes(1); expect(full.mock.results[0].type).toBe('return');
      expect(student).not.toHaveBeenCalled(); expect(observed.rows).toHaveLength(3); expect(await state(f.h)).toEqual(f.baseline);
      f.fact.witness = { classification: 'TEST_ONLY_THIRD_SQL_RESPONSE_SUBSTITUTION', priorActualFullReturned: true,
        actualRowsBeforeRollback: 3, actualStudentCalls: 0, exactBaselineRestored: true, persistedTamperingClaimed: false };
    });
  }
});
