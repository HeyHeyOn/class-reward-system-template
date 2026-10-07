// @vitest-environment node
// Synthetic PGlite + actual importer/inspector, explicit synthetic READY.
// No live source, actual PostgreSQL, issuer authentication or writer exclusion.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { importLegacyNormalizationManifest, inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { createLegacyNormalizationManifest } from './manifest';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { stageLocalFullDeltaCheckedPreparation, inspectLocalFullDeltaPreparationEnvelopes } from './localFullDeltaCheckedPreparation';
import { stageLocalStudentCheckedPreparation, inspectLocalStudentPreparationEnvelopes } from './localStudentCheckedPreparation';
import { createNonAuthorityReceiptStorage } from './authorityReceiptStorage';
import * as students from './localCapturedStudentProjection';
import * as manifests from './manifest';
import * as importer from './importer';
import { stageLocalStudentAttestedPreparation as stage, readCurrentLocalStudentAttestation as read } from './localStudentAttestedPreparation';

vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
const EVENT = 'MIGRATION_LOCAL_STUDENT_ATTESTATION';
const REFUSAL = 'Local student attestation refused.';
const flags = { authority: 'NONAUTHORITY', complete: false, activationAllowed: false, exclusion: 'NOT_PROVEN',
  sourceAuthenticity: 'NOT_PROVEN', fullReconciliation: 'NOT_PERFORMED' };
type Input = FinalGenerationPreparationInput;
type Prepared = Awaited<ReturnType<typeof stageLocalFullDeltaCheckedPreparation>>['preparation'];
type Side = 'ORIGINAL' | 'CANDIDATE';
type Row = { tenant_id: string; event_id: string; job_id: string; event_type: string; operation_id: null;
  actor_user_id: null; entity_type: null; entity_id: null; redacted_details: Record<string, unknown>; occurred_at: string; xmin: string };
const directory = 'src/server/db/migrations';
const migrations = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'src/server/migration/localStudentCheckedPreparation.ts',
  'src/server/migration/localStudentCheckedPreparation.test.ts', 'src/server/migration/localStudentCheckedPreparation.priorEnvelope.test.ts',
  'src/server/migration/localFullDeltaCheckedPreparation.ts', 'src/server/migration/localPointerCheckedPreparation.ts',
  'src/server/migration/localCapturedStudentProjection.ts', 'src/server/migration/localCapturedSourceCoverage.ts',
  'src/server/migration/localFullCategoryDeltaCoverage.ts', 'src/server/migration/finalGeneration.ts',
  'src/server/migration/importer.ts', 'src/server/migration/manifest.ts', 'src/server/migration/normalize.ts',
  'src/server/migration/validators.ts', 'src/server/migration/sensitiveRedaction.ts',
  ...migrations.map((name) => join(directory, name))];
const hashes = () => Object.fromEntries(watched.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const initialHashes = hashes();
const facts: Record<string, Record<string, unknown>> = {};

async function acquisition(tenantId: string, added: boolean, invalid: boolean): Promise<Input['original']> {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  if (added) workbook.Students.push(['S2', 'Synthetic Bob', '-7', 'INACTIVE']);
  if (invalid) {
    workbook.Students[0].push('unreviewed');
    for (const row of workbook.Students.slice(1)) row.push('synthetic extra field');
  }
  const sheets = await captureSheetsSnapshot({ spreadsheetId: `synthetic-${tenantId}`,
    capturedAt: added ? '2026-09-01T00:00:00.000Z' : seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => added ? 'synthetic-candidate' : 'synthetic-original' } });
  const operation = makeRedis().operationBindings[0];
  const claimField = `claim:${sha256(`${operation.binding.evidence.evidenceBoardId}\0${operation.binding.evidence.evidencePostId}`)}`;
  const entries: Array<readonly [string, string]> = [[claimField, operation.operationId],
    [`op:${sha256(operation.operationId)}`, JSON.stringify({ binding: operation.binding, claimField })]];
  const redis = await captureRedisClaimSnapshot({
    hscan: async (key, cursor) => { expect([key, cursor]).toEqual(['padlet:evidence-bindings:v2', '0']); return { cursor: '0', entries: structuredClone(entries) }; },
    scan: async (cursor, pattern) => { expect([cursor, pattern]).toEqual(['0', 'padlet:evidence-claim:v1:*']); return { cursor: '0', keys: [] }; },
    // Independent synthetic acquisitions, not the same globally owned Redis source reused across tenants.
    get: async () => { throw new Error('Unexpected synthetic v1 key'); }, getRevision: async () => `synthetic-redis-${tenantId}`,
  }, { capturedAt: seed.capturedAt });
  return { sheets, redis };
}
async function setup(h: PgliteDatabaseHarness, tenantId: string, invalidSide?: Side) {
  const original = await acquisition(tenantId, false, invalidSide === 'ORIGINAL');
  const candidate = await acquisition(tenantId, true, invalidSide === 'CANDIDATE');
  const manifest = createLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, ...original });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  expect(createLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, ...candidate }).status).toBe('READY_FOR_IMPORT');
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [tenantId, JOB]);
  await importLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  // Synthetic READY only; not the complete operational reconciler or freeze.
  for (const status of ['RECONCILING', 'READY']) await h.database.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2', [tenantId, JOB, status]);
  expect(await h.runTenantTransaction(tenantId, (tx) => inspectLegacyImport(tx, { tenantId, migrationJobId: JOB, manifest }, manifest))).toEqual([]);
  const { rows } = await h.database.query<{ version: string; source_id: string; snapshot_id: string }>(
    `SELECT j.state_version::text AS version,s.source_id,s.snapshot_id FROM migration_jobs j JOIN migration_snapshots s USING(tenant_id,job_id)
     WHERE j.tenant_id=$1 AND j.job_id=$2 AND s.phase='PREFLIGHT'`, [tenantId, JOB]);
  expect(rows).toHaveLength(1);
  const input: Input = { tenantId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSourceId: rows[0].source_id, originalSnapshotId: rows[0].snapshot_id,
    exclusionGenerationReference: 'a'.repeat(64), original, candidate };
  return { h, input, manifest, context: { tenantId, runTransaction: h.runTenantTransaction } };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function checked(name: string, body: (f: Fixture, fact: Record<string, unknown>) => Promise<void>, invalidSide?: Side) {
  it(name, async () => {
    const fact: Record<string, unknown> = { phase: 'schema/import/actual inspector/synthetic READY', closed: false }; facts[name] = fact;
    let h: PgliteDatabaseHarness | undefined;
    try {
      h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
      for (const name of migrations.filter((name) => name.slice(0, 4) > '0008')) await h.database.exec(readFileSync(join(directory, name), 'utf8'));
      const f = await setup(h, h.tenantOneId, invalidSide);
      fact.phase = 'requested attestation behavior';
      await body(f, fact); fact.status = 'passed';
    } catch (error) { fact.status = 'failed'; fact.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { vi.restoreAllMocks(); await h?.close(); fact.closed = Boolean(h); }
  }, 0);
}
async function rows(f: Fixture): Promise<Row[]> {
  return (await f.h.database.query<Row>(`SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,
    redacted_details,occurred_at::text,xmin::text FROM audit_events WHERE tenant_id=$1 AND job_id=$2
    AND (event_type LIKE 'MIGRATION_PREPARATION_%' OR event_type=$3) ORDER BY event_id`, [f.input.tenantId, JOB, EVENT])).rows;
}
function envelopes(stored: Row[]) {
  return stored.filter((row) => row.event_type.startsWith('MIGRATION_PREPARATION_')).map((row) => ({
    tenant_id: row.tenant_id, event_id: row.event_id, job_id: row.job_id, event_type: row.event_type,
    operation_id: row.operation_id, actor_user_id: row.actor_user_id, entity_type: row.entity_type,
    entity_id: row.entity_id, redacted_details: row.redacted_details,
  }));
}
async function state(h: PgliteDatabaseHarness, audit = true) {
  const { rows: tables } = await h.database.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result: Record<string, string[]> = {};
  for (const { tablename } of tables) {
    expect(tablename).toMatch(/^[a-z_][a-z0-9_]*$/);
    if (!audit && tablename === 'audit_events') continue;
    result[tablename] = (await h.database.query(`SELECT row_to_json(t) AS row,xmin::text FROM public."${tablename}" t`)).rows.map((row) => canonicalJson(row)).sort();
  }
  return result; // Exact rows/xmin, not sequence or concurrency proof.
}
function binding(input: Input) {
  return { tenantId: input.tenantId, migrationJobId: input.migrationJobId, expectedStateVersion: input.expectedStateVersion,
    originalSourceId: input.originalSourceId, originalSnapshotId: input.originalSnapshotId,
    exclusionGenerationReference: input.exclusionGenerationReference };
}
function selection(input: Input, preparation: Prepared, attestationId = `local-student-attestation:${'0'.repeat(64)}`) {
  const context = { migrationJobId: input.migrationJobId, expectedStateVersion: input.expectedStateVersion,
    originalSourceId: input.originalSourceId, originalSnapshotId: input.originalSnapshotId,
    exclusionGenerationReference: input.exclusionGenerationReference };
  return { ...context, originalGenerationId: preparation.originalGenerationId,
    candidateGenerationId: preparation.candidateGenerationId, planId: preparation.planId, attestationId };
}
async function direct(f: Fixture) {
  return (await stageLocalFullDeltaCheckedPreparation(f.input, f.h.runTenantTransaction)).preparation;
}
// Independent test recipe, not an exported product builder or caller report input.
async function recipe(f: Fixture, prepared: Prepared, invalid = false) {
  const records = envelopes(await rows(f));
  const full = inspectLocalFullDeltaPreparationEnvelopes(binding(f.input), prepared, records);
  const projections = invalid ? {
    original: students.verifyLocalCapturedStudentProjection({ capture: { tenantId: f.input.tenantId, migrationJobId: JOB,
      ...await acquisition(f.input.tenantId, false, false) }, manifest: createLegacyNormalizationManifest({ tenantId: f.input.tenantId, migrationJobId: JOB,
      ...await acquisition(f.input.tenantId, false, false) }) }),
    candidate: students.verifyLocalCapturedStudentProjection({ capture: { tenantId: f.input.tenantId, migrationJobId: JOB,
      ...await acquisition(f.input.tenantId, true, false) }, manifest: createLegacyNormalizationManifest({ tenantId: f.input.tenantId, migrationJobId: JOB,
      ...await acquisition(f.input.tenantId, true, false) }) }),
  } : inspectLocalStudentPreparationEnvelopes(binding(f.input), prepared, records).studentProjection;
  const payload = { attestationVersion: 1, verifierContract: 'CAPTURED_STUDENTS_V1', scope: 'LOCAL_CAPTURED_STUDENT_REVALIDATION_ONLY', ...flags,
    binding: { ...binding(f.input), expectedStatus: 'READY' }, originalGenerationId: prepared.originalGenerationId,
    candidateGenerationId: prepared.candidateGenerationId, planId: prepared.planId,
    originalManifestDigest: full.reports.original.manifestDigest, candidateManifestDigest: full.reports.candidate.manifestDigest,
    originalSheetsDigest: f.input.original.sheets.digest, candidateSheetsDigest: f.input.candidate.sheets.digest,
    originalRedisDigest: f.input.original.redis.digest, candidateRedisDigest: f.input.candidate.redis.digest,
    studentProjection: projections, fullDeltaDigest: sha256(canonicalJson(full.deltaCoverage)) };
  return { payload, id: `local-student-attestation:${sha256(canonicalJson(payload))}` };
}
async function insert(f: Fixture, id: string, payload: unknown, eventType = EVENT) {
  await f.h.runTenantTransaction(f.input.tenantId, async (tx) => {
    await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details)
      VALUES(${f.input.tenantId},${id},${JOB},${eventType},NULL,NULL,NULL,NULL,${JSON.stringify(payload)}::jsonb)`);
  });
}
async function within(tx: TenantTransaction, tenantId: string) {
  return (await tx.execute(sql`SELECT event_id,event_type FROM audit_events WHERE tenant_id=${tenantId} AND job_id=${JOB}
    AND (event_type LIKE 'MIGRATION_PREPARATION_%' OR event_type=${EVENT}) ORDER BY event_id`)).rows;
}
function assertFlags(result: Awaited<ReturnType<typeof stage>>) {
  expect(result).toMatchObject({ ...flags, status: 'CURRENT_LOCAL_STUDENT_REVALIDATED',
    scope: 'LOCAL_CAPTURED_STUDENT_REVALIDATION_ONLY', issuerAuthenticity: 'NOT_PROVEN' });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.studentProjection.original.expectedSourceUnits).toBe(1);
  expect(result.studentProjection.candidate.expectedSourceUnits).toBe(2);
}

afterAll(() => {
  const finalHashes = hashes();
  console.info('LOCAL_STUDENT_ATTESTATION_EVIDENCE ' + JSON.stringify({ ...flags, engine: 'synthetic in-memory PGlite',
    readiness: 'SYNTHETIC_READY_ACTUAL_IMPORTER_INSPECTOR', realPostgreSQLExecuted: false, issuerAuthenticationProven: false,
    initialHashes, finalHashes, facts }));
  expect(finalHashes).toEqual(initialHashes);
});

describe('design A only: durable locator with mandatory current revalidation', () => {
  checked('A-MISSING: three prior envelopes and transient student result are not a receipt', async (f) => {
    const prepared = await direct(f); expect(await rows(f)).toHaveLength(3);
    const baseline = await state(f.h);
    await expect(read(f.context, selection(f.input, prepared))).rejects.toThrow(REFUSAL);
    const transient = await stageLocalStudentCheckedPreparation(f.input, f.h.runTenantTransaction);
    await expect(read(f.context, transient as never)).rejects.toThrow(REFUSAL);
    await expect(read(f.context, { ...selection(f.input, prepared), studentProjection: transient.studentProjection } as never)).rejects.toThrow(REFUSAL);
    expect(await state(f.h)).toEqual(baseline);
  });
  for (const side of ['ORIGINAL', 'CANDIDATE'] as const) checked(`A-OLD-INVALID ${side}: prior commit retained; actual student refusal; no fourth row`, async (f, fact) => {
    await direct(f); const baseline = await state(f.h); expect(await rows(f)).toHaveLength(3);
    const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
    await expect(stage(f.input, f.h.runTenantTransaction)).rejects.toThrow(REFUSAL);
    expect(student.mock.results.map((r) => r.type)).toEqual(side === 'ORIGINAL' ? ['throw'] : ['return', 'throw']);
    expect(await state(f.h)).toEqual(baseline);
    fact.classification = 'PRIOR_COMMIT_RETAINED_NOT_ROLLED_BACK'; fact.studentResults = student.mock.results.map((r) => r.type);
  }, side);
  checked('A-UPGRADE/RETRY: actual two acquisitions, fourth row only, stable IDs/content/time/xmin', async (f, fact) => {
    const prepared = await direct(f); const prior = await rows(f); const nonAudit = await state(f.h, false);
    const expected = await recipe(f, prepared);
    const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
    const observations: unknown[] = [];
    const runner: TenantImportTransactionRunner = (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
      const raw = await callback(tx); observations.push(await within(tx, tenant)); return raw;
    });
    const result = await stage(f.input, runner); assertFlags(result);
    expect(result.attestationId).toBe(expected.id); expect(result.selection).toEqual(selection(f.input, prepared, expected.id));
    const committed = await rows(f); expect(committed).toHaveLength(4);
    expect(committed.filter((row) => row.event_type !== EVENT)).toEqual(prior);
    expect(committed.find((row) => row.event_type === EVENT)?.redacted_details).toEqual(expected.payload);
    expect(observations).toEqual([committed.map(({ event_id, event_type }) => ({ event_id, event_type }))]);
    expect(student.mock.calls.map(([operand]) => (operand as { capture: { sheets: { digest: string } } }).capture.sheets.digest))
      .toEqual([f.input.original.sheets.digest, f.input.candidate.sheets.digest, f.input.original.sheets.digest, f.input.candidate.sheets.digest]);
    const baseline = await state(f.h);
    for (const operation of [() => read(f.context, result.selection), () => stage(f.input, f.h.runTenantTransaction)]) {
      student.mockClear(); const value = await operation(); assertFlags(value); expect(value).toEqual(result);
      expect(student.mock.calls.length).toBeGreaterThanOrEqual(2); expect(await rows(f)).toEqual(committed);
      expect(await state(f.h)).toEqual(baseline);
    }
    expect(await state(f.h, false)).toEqual(nonAudit);
    fact.classification = 'CURRENT_REVALIDATION_NOT_ISSUER_AUTHENTICATION'; fact.committedRows = committed.length;
  });
  checked('A-FRESH: four rows observed on same actual transaction and committed after student gate', async (f) => {
    const baseline = await state(f.h, false); const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
    const result = await stage(f.input, (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
      expect(await within(tx, tenant)).toHaveLength(0);
      const raw = await callback(tx);
      expect(student.mock.results.map((r) => r.type)).toEqual(['return', 'return', 'return', 'return']);
      expect(await within(tx, tenant)).toHaveLength(4); return raw;
    }));
    assertFlags(result); expect(await rows(f)).toHaveLength(4); expect(await state(f.h, false)).toEqual(baseline);
  });
  for (const prior of [false, true]) checked(`A-ATOMIC prior=${prior}: precommit runner failure after fourth INSERT rolls back only this transaction`, async (f, fact) => {
    if (prior) await direct(f);
    const baseline = await state(f.h); let observed = 0;
    await expect(stage(f.input, (tenant, callback) => f.h.runTenantTransaction(tenant, async (tx) => {
      await callback(tx); observed = (await within(tx, tenant)).length; throw new Error('Synthetic precommit runner failure');
    }))).rejects.toThrow(REFUSAL);
    expect(observed).toBe(4); expect(await state(f.h)).toEqual(baseline);
    fact.classification = 'RUNNER_FAILURE_AFTER_REAL_FOURTH_APPEND_NOT_STUDENT_FAILURE'; fact.observedPrecommitRows = observed;
  });
  checked('A-COLLISION: conflicting stored ID is refused, not overwritten or mistaken for successful dedup', async (f) => {
    const prepared = await direct(f); const expected = await recipe(f, prepared);
    await insert(f, expected.id, { ...expected.payload, activationAllowed: true });
    const baseline = await state(f.h);
    await expect(stage(f.input, f.h.runTenantTransaction)).rejects.toThrow(REFUSAL);
    await expect(read(f.context, selection(f.input, prepared, expected.id))).rejects.toThrow(REFUSAL);
    expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-FORGE valid: generic INSERT can pass current checks but never proves issuer identity', async (f) => {
    const prepared = await direct(f); const expected = await recipe(f, prepared); await insert(f, expected.id, expected.payload);
    const baseline = await state(f.h); const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
    const normalize = vi.spyOn(manifests, 'createLegacyNormalizationManifest'); const inspect = vi.spyOn(importer, 'inspectLegacyImport');
    const result = await read(f.context, selection(f.input, prepared, expected.id)); assertFlags(result);
    expect(student).toHaveBeenCalledTimes(2); expect(normalize).toHaveBeenCalledTimes(2); expect(inspect).toHaveBeenCalledTimes(1);
    expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-FORGE invalid capture: self-hashed plausible receipt cannot skip actual Student rejection', async (f) => {
    const prepared = await direct(f); const fake = await recipe(f, prepared, true); await insert(f, fake.id, fake.payload);
    const baseline = await state(f.h); const student = vi.spyOn(students, 'verifyLocalCapturedStudentProjection');
    await expect(read(f.context, selection(f.input, prepared, fake.id))).rejects.toThrow(REFUSAL);
    expect(student.mock.results.map((r) => r.type)).toEqual(['return', 'throw']); expect(await state(f.h)).toEqual(baseline);
  }, 'CANDIDATE');
  for (const mutation of ['version', 'contract', 'extra', 'digest', 'count', 'oversize', 'metadata'] as const) checked(`A-MALFORMED stored ${mutation}: real INSERT, no trigger relaxation`, async (f) => {
    const prepared = await direct(f); const expected = await recipe(f, prepared);
    const payload = structuredClone(expected.payload) as Record<string, unknown>;
    if (mutation === 'version') payload.attestationVersion = 2;
    if (mutation === 'contract') payload.verifierContract = 'UNSUPPORTED';
    if (mutation === 'extra') payload.certified = true;
    if (mutation === 'digest') payload.fullDeltaDigest = '0'.repeat(64);
    if (mutation === 'count') (payload.studentProjection as { candidate: { expectedSourceUnits: number } }).candidate.expectedSourceUnits = 0;
    if (mutation === 'oversize') payload.padding = 'x'.repeat(16_385);
    const id = `local-student-attestation:${sha256(canonicalJson(payload))}`;
    await insert(f, id, payload, mutation === 'metadata' ? 'NOT_A_STUDENT_ATTESTATION' : EVENT);
    const baseline = await state(f.h);
    await expect(read(f.context, selection(f.input, prepared, id))).rejects.toThrow(REFUSAL);
    expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-TENANT: two actual imported tenants, mixed IDs/context and RLS negatives refuse without disclosure', async (f) => {
    const other = await setup(f.h, f.h.tenantTwoId);
    const a = await stage(f.input, f.h.runTenantTransaction), b = await stage(other.input, f.h.runTenantTransaction);
    const baseline = await state(f.h);
    for (const selected of [b.selection, { ...a.selection, originalGenerationId: b.selection.originalGenerationId },
      { ...a.selection, attestationId: b.attestationId }]) await expect(read(f.context, selected)).rejects.toThrow(REFUSAL);
    await expect(read({ tenantId: other.input.tenantId, runTransaction: (_tenant, callback) => f.h.runTenantTransaction(f.input.tenantId, callback) }, b.selection)).rejects.toThrow(REFUSAL);
    await f.h.runTenantTransaction(f.input.tenantId, async (tx) => {
      expect((await tx.execute(sql`SELECT event_id FROM audit_events WHERE tenant_id=${other.input.tenantId}`)).rows).toEqual([]);
    });
    await expect(f.h.runTenantTransaction(f.input.tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
        VALUES(${other.input.tenantId},'forbidden-cross-tenant',${JOB},${EVENT},'{}'::jsonb)`);
    })).rejects.toThrow();
    expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-BINDING: job/source/snapshot/version/exclusion mixups refuse and preserve records', async (f) => {
    const result = await stage(f.input, f.h.runTenantTransaction); const baseline = await state(f.h);
    const changes = { migrationJobId: '20000000-0000-4000-8000-000000000099', expectedStateVersion: '999',
      originalSourceId: `sheet:${'0'.repeat(64)}`, originalSnapshotId: `import:${'0'.repeat(64)}`, exclusionGenerationReference: '0'.repeat(64) };
    for (const [key, value] of Object.entries(changes)) await expect(read(f.context, { ...result.selection, [key]: value })).rejects.toThrow(REFUSAL);
    expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-CURRENT: legal ABORTED/status-version change invalidates historical receipt without deleting it', async (f) => {
    const result = await stage(f.input, f.h.runTenantTransaction);
    // A version-only update was actually refused by the unchanged DDL. Use its
    // allowed terminal transition; no FREEZING/FINAL_IMPORT/ACTIVE or trigger bypass.
    await f.h.database.query("UPDATE migration_jobs SET status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND job_id=$2", [f.input.tenantId, JOB]);
    const baseline = await state(f.h);
    await expect(read(f.context, result.selection)).rejects.toThrow(REFUSAL); expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-CURRENT-TARGET: current original inspector refuses legal target drift behind unchanged archived receipt', async (f) => {
    const result = await stage(f.input, f.h.runTenantTransaction);
    await f.h.database.query('UPDATE students SET name=$2 WHERE tenant_id=$1', [f.input.tenantId, 'Synthetic drift']);
    const baseline = await state(f.h); const inspect = vi.spyOn(importer, 'inspectLegacyImport');
    await expect(read(f.context, result.selection)).rejects.toThrow(REFUSAL);
    expect(inspect).toHaveBeenCalledTimes(1); expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-INGRESS: missing raw Students/redis, hash mutation, descriptors/proxies and extra authority refuse before runner', async (f) => {
    const baseline = await state(f.h); const attempted = vi.fn(); let accessed = 0;
    const runner: TenantImportTransactionRunner = (tenant, callback) => { attempted(); return f.h.runTenantTransaction(tenant, callback); };
    const missingStudents = structuredClone(f.input); delete (missingStudents.original.sheets.tabs as Record<string, unknown>).Students;
    const missingRedis = structuredClone(f.input); delete (missingRedis.candidate as unknown as Record<string, unknown>).redis;
    const rowHash = structuredClone(f.input); (rowHash.candidate.sheets.tabs.Students.rows[0] as unknown as { hash: string }).hash = '0'.repeat(64);
    const getter = structuredClone(f.input); Object.defineProperty(getter.candidate.sheets.tabs.Students.rows[0], 'cells', { enumerable: true, get() { accessed++; throw new Error('getter'); } });
    const proxy = structuredClone(f.input); Object.defineProperty(proxy, 'candidate', { enumerable: true, value: new Proxy(proxy.candidate, { get() { accessed++; throw new Error('proxy'); }, ownKeys() { accessed++; throw new Error('proxy'); } }) });
    for (const input of [missingStudents, missingRedis, rowHash, getter, proxy, { ...f.input, authority: 'ACTIVE' }])
      await expect(stage(input as Input, runner)).rejects.toThrow(REFUSAL);
    expect(accessed).toBe(0); expect(attempted).not.toHaveBeenCalled(); expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-READ-INGRESS: closed scalar selection and context reject getters/proxy/unknown keys without execution', async (f) => {
    const result = await stage(f.input, f.h.runTenantTransaction); const baseline = await state(f.h);
    const attempted = vi.fn(); let accessed = 0;
    const runner: TenantImportTransactionRunner = (tenant, callback) => { attempted(); return f.h.runTenantTransaction(tenant, callback); };
    const getter = { ...result.selection }; Object.defineProperty(getter, 'attestationId', { enumerable: true, get() { accessed++; return result.attestationId; } });
    const proxy = new Proxy(result.selection, { ownKeys() { accessed++; throw new Error('proxy'); } });
    for (const value of [getter, proxy, { ...result.selection, certified: true }, { ...result.selection, expectedStateVersion: '01' }])
      await expect(read({ tenantId: f.input.tenantId, runTransaction: runner }, value)).rejects.toThrow(REFUSAL);
    await expect(read({ ...f.context, authority: true } as never, result.selection)).rejects.toThrow(REFUSAL);
    expect(attempted).not.toHaveBeenCalled(); expect(accessed).toBe(0); expect(await state(f.h)).toEqual(baseline);
  });
  checked('A-CALLBACK: omission refuses; postcommit substitution refuses but committed rows remain', async (f) => {
    const baseline = await state(f.h);
    const omitted: TenantImportTransactionRunner = async <T>() => ({} as T);
    await expect(stage(f.input, omitted)).rejects.toThrow(REFUSAL); expect(await state(f.h)).toEqual(baseline);
    const substituted: TenantImportTransactionRunner = async <T>(tenant: string, callback: (tx: TenantTransaction) => Promise<T>) => {
      const value = await f.h.runTenantTransaction(tenant, callback); return structuredClone(value);
    };
    await expect(stage(f.input, substituted)).rejects.toThrow(REFUSAL); expect(await rows(f)).toHaveLength(4);
    const result = await stage(f.input, f.h.runTenantTransaction); const committed = await state(f.h);
    await expect(read({ ...f.context, runTransaction: omitted }, result.selection)).rejects.toThrow(REFUSAL);
    await expect(read({ ...f.context, runTransaction: substituted }, result.selection)).rejects.toThrow(REFUSAL);
    expect(await state(f.h)).toEqual(committed);
  });
  checked('A-COMMIT: synthetic postcommit ACK loss retains four rows; fresh retry revalidates without duplicates', async (f, fact) => {
    await expect(stage(f.input, async (tenant, callback) => { await f.h.runTenantTransaction(tenant, callback); throw new Error('Synthetic ACK loss'); })).rejects.toThrow(REFUSAL);
    expect(await rows(f)).toHaveLength(4); const committed = await state(f.h);
    const result = await stage(f.input, f.h.runTenantTransaction); assertFlags(result);
    expect(await read(f.context, result.selection)).toEqual(result); expect(await state(f.h)).toEqual(committed);
    fact.classification = 'SYNTHETIC_POSTCOMMIT_ACK_LOSS_NOT_ROLLBACK';
  });
  checked('A-NO-AUTH: local payload rejected by actual authority storage; authority/lifecycle tables unchanged', async (f) => {
    const baseline = await state(f.h, false); const result = await stage(f.input, f.h.runTenantTransaction); assertFlags(result);
    const receipt = (await rows(f)).find((row) => row.event_type === EVENT)!;
    await expect(createNonAuthorityReceiptStorage(f.context).append(receipt.redacted_details)).rejects.toThrow('Receipt storage refused.');
    expect(await read(f.context, result.selection)).toEqual(result); expect(await state(f.h, false)).toEqual(baseline);
  });
});
