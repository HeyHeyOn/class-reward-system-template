// @vitest-environment node
// Existing-behavior integration evidence only: in-memory PGlite, NONAUTHORITY.
// A direct full-stage commit is not a student-check receipt. A later refusal
// cannot erase that earlier transaction. No real PostgreSQL or live acquisition.
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
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';
import { stageLocalStudentCheckedPreparation } from './localStudentCheckedPreparation';
import * as students from './localCapturedStudentProjection';
import * as delta from './localFullCategoryDeltaCoverage';

vi.mock('server-only', () => ({})); // Environment marker only. No business/SQL/runner substitutions.
const JOB = '20000000-0000-4000-8000-000000000019';
const SELF = 'src/server/migration/localStudentCheckedPreparation.priorEnvelope.test.ts';
const REFUSAL = 'Local student-checked preparation refused.';
const flags = { authority: 'NONAUTHORITY', complete: false, activationAllowed: false, exclusion: 'NOT_PROVEN',
  fullSourceReconciliation: 'NOT_PERFORMED', fullTargetReconciliation: 'NOT_PERFORMED' };
type Acquisition = FinalGenerationPreparationInput['original'];
type Side = 'ORIGINAL' | 'CANDIDATE';
type Envelope = { event_id: string; event_type: string; xmin: string; redacted_details: Record<string, unknown> };
type Fact = Record<string, unknown>;
const facts: Record<string, Fact> = {};
const directory = 'src/server/db/migrations';
const migrations = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'src/server/migration/localStudentCheckedPreparation.ts',
  'src/server/migration/localStudentCheckedPreparation.test.ts', 'src/server/migration/localFullDeltaCheckedPreparation.ts',
  'src/server/migration/localFullDeltaCheckedPreparation.test.ts', 'src/server/migration/localCapturedStudentProjection.ts',
  'src/server/migration/localCapturedStudentProjection.test.ts', 'src/server/migration/localCapturedSourceCoverage.ts',
  'src/server/migration/localFullCategoryDeltaCoverage.ts', 'src/server/migration/localPointerCheckedPreparation.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts', 'src/server/migration/manifest.ts',
  'src/server/migration/normalize.ts', 'src/server/migration/validators.ts', 'src/server/migration/sheetsSnapshot.ts',
  'src/server/migration/redisClaimSnapshot.ts', 'src/server/migration/__fixtures__/normalization.ts',
  'src/server/db/testing/pglite.ts', 'src/server/db/transaction.ts', 'package.json', 'vitest.config.mts',
  ...migrations.map((name) => join(directory, name))];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceHashes = () => Object.fromEntries(watched.map((path) => [path, hash(readFileSync(path))]));
const initialHashes = sourceHashes();
const testHash = hash(readFileSync(SELF));

async function capture(added: boolean, extraColumn: boolean): Promise<Acquisition> {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  if (added) workbook.Students.push(['S2', 'Synthetic Bob', '-7', 'INACTIVE']);
  if (extraColumn) {
    workbook.Students[0].push('unreviewed');
    for (const row of workbook.Students.slice(1)) row.push('synthetic extra field');
  }
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId,
    capturedAt: added ? '2026-09-01T00:00:00.000Z' : seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => added ? 'synthetic-candidate' : 'synthetic-original' } });
  const operation = makeRedis().operationBindings[0];
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
async function state(h: PgliteDatabaseHarness, includeAudit = true) {
  const { rows: tables } = await h.database.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result: Record<string, string[]> = {};
  for (const { tablename } of tables) {
    expect(tablename).toMatch(/^[a-z_][a-z0-9_]*$/);
    if (!includeAudit && tablename === 'audit_events') continue;
    const { rows } = await h.database.query(`SELECT row_to_json(t) AS row,xmin::text AS xmin FROM public."${tablename}" t`);
    result[tablename] = rows.map((row) => canonicalJson(row)).sort();
  }
  return result; // Exact public-table rows + xmin, NOT sequences, roles or concurrency proof.
}
async function stored(h: PgliteDatabaseHarness) {
  return (await h.database.query<Envelope>(`SELECT event_id,event_type,redacted_details,xmin::text AS xmin FROM audit_events
    WHERE tenant_id=$1 AND job_id=$2 AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`, [h.tenantOneId, JOB])).rows;
}
function expectedOperand(tenantId: string, rows: Envelope[], side: Side) {
  const envelope = rows.find((row) => row.event_type === `MIGRATION_PREPARATION_${side}`);
  expect(envelope).toBeDefined();
  const { acquisition, manifest } = envelope!.redacted_details as { acquisition: Acquisition; manifest: LegacyNormalizationManifest };
  return { capture: { tenantId, migrationJobId: JOB, sheets: acquisition.sheets, redis: acquisition.redis }, manifest };
}
async function fixture(h: PgliteDatabaseHarness, fact: Fact, invalidSide?: Side) {
  fact.phase = 'actual capture and normalization';
  const original = await capture(false, invalidSide === 'ORIGINAL');
  const candidate = await capture(true, invalidSide === 'CANDIDATE');
  const manifest = createLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, ...original });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  expect(createLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, ...candidate }).status).toBe('READY_FOR_IMPORT');
  fact.phase = 'actual importer';
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [h.tenantOneId, JOB]);
  fact.importResult = await importLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  // Explicit synthetic READY setup, matching the existing integration fixture.
  // NOT a full reconciler/operational readiness or writer-exclusion proof.
  for (const status of ['RECONCILING', 'READY']) await h.database.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2', [h.tenantOneId, JOB, status]);
  fact.phase = 'actual original inspector';
  expect(await h.runTenantTransaction(h.tenantOneId, (tx) => inspectLegacyImport(tx,
    { tenantId: h.tenantOneId, migrationJobId: JOB, manifest }, manifest))).toEqual([]);
  const { rows } = await h.database.query<{ version: string; source_id: string; snapshot_id: string }>(
    `SELECT j.state_version::text AS version,s.source_id,s.snapshot_id FROM migration_jobs j JOIN migration_snapshots s USING(tenant_id,job_id)
     WHERE j.tenant_id=$1 AND j.job_id=$2 AND s.phase='PREFLIGHT'`, [h.tenantOneId, JOB]);
  expect(rows).toHaveLength(1);
  const input: FinalGenerationPreparationInput = { tenantId: h.tenantOneId, migrationJobId: JOB,
    expectedStateVersion: rows[0].version, originalSourceId: rows[0].source_id, originalSnapshotId: rows[0].snapshot_id,
    exclusionGenerationReference: 'a'.repeat(64), original, candidate };
  expect(await stored(h)).toEqual([]);
  return { h, input, fact, manifest, nonAudit: await state(h, false) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function checked(name: string, body: (f: Fixture) => Promise<void>, invalidSide?: Side) {
  it(name, async () => {
    const fact: Fact = { status: 'running', phase: 'in-memory PGlite schema', closed: false }; facts[name] = fact;
    let h: PgliteDatabaseHarness | undefined;
    try {
      h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
      for (const name of migrations.filter((name) => name.slice(0, 4) > '0008')) await h.database.exec(readFileSync(join(directory, name), 'utf8'));
      await body(await fixture(h, fact, invalidSide)); fact.status = 'passed';
    } catch (error) {
      // Upstream refusal remains a failing fixture at its recorded phase, never a skip or student-check witness.
      fact.status = 'failed'; fact.error = error instanceof Error ? error.message : String(error); throw error;
    } finally { vi.restoreAllMocks(); await h?.close(); fact.closed = Boolean(h); }
  }, 0);
}
function observe(f: Fixture, entries: Array<{ rows: Envelope[]; callbackReturned: boolean }>): TenantImportTransactionRunner {
  return (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
    let callbackReturned = false;
    try { const result = await callback(tx); callbackReturned = true; return result; }
    finally {
      // Same actual runner/transaction; no SQL response or callback result replacement.
      const { rows } = await tx.execute(sql`SELECT event_id,event_type,redacted_details,xmin::text AS xmin FROM audit_events
        WHERE tenant_id=${tenant} AND job_id=${JOB} AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`);
      entries.push({ rows: rows as Envelope[], callbackReturned });
    }
  });
}
async function unchanged(f: Fixture) {
  expect(await state(f.h, false)).toEqual(f.nonAudit);
  expect(await f.h.runTenantTransaction(f.input.tenantId, (tx) => inspectLegacyImport(tx,
    { tenantId: f.input.tenantId, migrationJobId: JOB, manifest: f.manifest }, f.manifest))).toEqual([]);
}
function assertEnvelopes(rows: Envelope[], preparation: Awaited<ReturnType<typeof stageLocalFullDeltaCheckedPreparation>>['preparation']) {
  expect(rows.map((row) => row.event_id).sort()).toEqual([
    preparation.originalGenerationId, preparation.candidateGenerationId, preparation.planId,
  ].sort());
  expect(rows.map((row) => row.event_type).sort()).toEqual([
    'MIGRATION_PREPARATION_ORIGINAL', 'MIGRATION_PREPARATION_CANDIDATE', 'MIGRATION_PREPARATION_PLAN',
  ].sort());
  for (const row of rows) {
    expect(row.redacted_details.storage).toBe('UNTRUSTED_PREPARATION');
    expect(row.redacted_details).not.toHaveProperty('studentProjection');
  }
}

afterAll(() => {
  const finalHashes = sourceHashes();
  console.info('STUDENT_PRIOR_ENVELOPE_EVIDENCE ' + JSON.stringify({ ...flags,
    engine: 'synthetic in-memory PGlite', readiness: 'SYNTHETIC_READY_WITH_ACTUAL_IMPORTER_AND_INSPECTOR',
    realPostgreSQLExecuted: false, liveSourceAccessed: false, acceptanceClaimed: false,
    initialHashes, finalHashes, testHash, finalTestHash: hash(readFileSync(SELF)), facts }));
  expect(finalHashes).toEqual(initialHashes); expect(hash(readFileSync(SELF))).toBe(testHash);
});

describe('already committed full-delta envelopes are not student-gate receipts (NONAUTHORITY)', () => {
  for (const side of ['ORIGINAL', 'CANDIDATE'] as const) {
    checked(`${side} unreviewed Students column: full commits, stricter refusal preserves prior envelopes`, async (f) => {
      // Delegating spies observe the unchanged real implementations, including their thrown errors.
      const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
      const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
      const observations: Array<{ rows: Envelope[]; callbackReturned: boolean }> = [];
      f.fact.phase = 'direct actual full wrapper commit';
      const direct = await stageLocalFullDeltaCheckedPreparation(f.input, observe(f, observations));
      expect(direct).toMatchObject(flags); expect(direct).not.toHaveProperty('studentProjection');
      expect(student).not.toHaveBeenCalled(); expect(full.mock.results.map((r) => r.type)).toEqual(['return']);
      const committed = await stored(f.h); assertEnvelopes(committed, direct.preparation);
      expect(observations).toEqual([{ rows: committed, callbackReturned: true }]);
      const committedState = await state(f.h); await unchanged(f);
      f.fact.directCommit = { studentCalls: 0, rows: committed.length, ids: committed.map((row) => row.event_id) };

      f.fact.phase = 'stricter actual student gate on prior commit';
      for (const attempt of [1, 2]) {
        student.mockClear(); full.mockClear(); observations.length = 0;
        let published = false;
        await expect(stageLocalStudentCheckedPreparation(f.input, observe(f, observations)).then((result) => {
          published = true; return result;
        })).rejects.toThrow(REFUSAL);
        expect(published).toBe(false);
        expect(full.mock.results.map((r) => r.type)).toEqual(['return', 'return']);
        const original = expectedOperand(f.input.tenantId, committed, 'ORIGINAL');
        const candidate = expectedOperand(f.input.tenantId, committed, 'CANDIDATE');
        expect(student.mock.calls).toEqual(side === 'ORIGINAL' ? [[original]] : [[original], [candidate]]);
        expect(student.mock.results.map((r) => r.type)).toEqual(side === 'ORIGINAL' ? ['throw'] : ['return', 'throw']);
        expect(observations).toEqual([{ rows: committed, callbackReturned: false }]);
        expect(await stored(f.h)).toEqual(committed);
        expect(await state(f.h)).toEqual(committedState); await unchanged(f);
        f.fact[`refusal${attempt}`] = { classification: `PRIOR_COMMIT_RETAINED_AFTER_ACTUAL_${side}_STUDENT_REFUSAL`,
          fullChecksReturned: full.mock.results.length, studentResults: student.mock.results.map((r) => r.type),
          priorEnvelopeRows: committed.length, rowsAndXminUnchanged: true, successPublished: published,
          newAppendRollbackClaimed: false, reason: 'UNREVIEWED_EXTRA_COLUMN_NOT_FABRICATED_CORRUPTION' };
      }
    }, side);
  }

  checked('supported direct full commit and student retries share identical IDs/content without a durable student receipt', async (f) => {
    const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
    const full = vi.spyOn(delta, 'verifyLocalFullCategoryDeltaCoverage');
    const observations: Array<{ rows: Envelope[]; callbackReturned: boolean }> = [];
    f.fact.phase = 'supported direct full wrapper commit';
    const direct = await stageLocalFullDeltaCheckedPreparation(f.input, observe(f, observations));
    expect(direct).toMatchObject(flags); expect(direct).not.toHaveProperty('studentProjection');
    expect(student).not.toHaveBeenCalled(); expect(full.mock.results.map((r) => r.type)).toEqual(['return']);
    const committed = await stored(f.h); assertEnvelopes(committed, direct.preparation);
    expect(observations).toEqual([{ rows: committed, callbackReturned: true }]);
    const committedState = await state(f.h); await unchanged(f);

    f.fact.phase = 'supported stricter student retries';
    for (const attempt of [1, 2]) {
      student.mockClear(); full.mockClear(); observations.length = 0;
      const result = await stageLocalStudentCheckedPreparation(f.input, observe(f, observations));
      expect(result).toMatchObject({ ...flags, scope: 'LOCAL_STUDENT_CHECKED_PREPARATION_ONLY' });
      expect(result.preparation).toEqual(direct.preparation);
      expect(result.reports).toEqual(direct.reports); expect(result.deltaCoverage).toEqual(direct.deltaCoverage);
      expect(full.mock.results.map((r) => r.type)).toEqual(['return', 'return']);
      expect(student.mock.calls).toEqual([[expectedOperand(f.input.tenantId, committed, 'ORIGINAL')],
        [expectedOperand(f.input.tenantId, committed, 'CANDIDATE')]]);
      expect(student.mock.results.map((r) => r.type)).toEqual(['return', 'return']);
      expect(result.studentProjection.original).toMatchObject({ ...flags, expectedSourceUnits: 1 });
      expect(result.studentProjection.candidate).toMatchObject({ ...flags, expectedSourceUnits: 2 });
      expect(observations).toEqual([{ rows: committed, callbackReturned: true }]);
      expect(await stored(f.h)).toEqual(committed); expect(await state(f.h)).toEqual(committedState);
      await unchanged(f);
      f.fact[`retry${attempt}`] = { classification: 'ACTUAL_STUDENT_RETRY_SAME_PRIOR_ENVELOPES', originalRawRows: 1,
        candidateRawRows: 2, studentCalls: student.mock.calls.length, rowsAndXminUnchanged: true, durableStudentReceiptCreated: false };
    }
    f.fact.directCommit = { studentCalls: 0, rows: committed.length, ids: committed.map((row) => row.event_id) };
  });
});
