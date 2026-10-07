// @vitest-environment node
// PUBLIC_PREPARATION_RECAPTURE_PGLITE_ONLY: synthetic regression, NOT an authority gate.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { stageLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';
import { reconcileLocalNoopFinalDelta } from './localNoopReconciliation';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeSheets, makeRedis } from './__fixtures__/normalization';
import { assertNormalizationInput, canonicalJson } from './validators';

// Only Next's environment marker is mocked; every business/SQL function is real.
vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
const CLAIMS = 'padlet_evidence_claims';
const FIRST = '2026-08-31T00:00:00.000Z';
const SECOND = '2026-09-01T00:00:00.000Z';
type Acquisition = FinalGenerationPreparationInput['original'];
type Manifest = LegacyNormalizationManifest;
type Stage = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
type Fact = Record<string, unknown>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => hash(canonicalJson(value));
const migrationsDirectory = 'src/server/db/migrations';
const migrations = readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = [
  'src/server/migration/finalGeneration.ts', 'src/server/migration/finalGeneration.test.ts',
  'src/server/migration/finalCaptureProvenance.test.ts', 'src/server/migration/finalCaptureProvenance.stage.test.ts',
  'src/server/migration/importer.ts', 'src/server/migration/localNoopReconciliation.ts',
  'src/server/migration/normalize.ts', 'src/server/migration/manifest.ts', 'src/server/migration/validators.ts',
  'src/server/migration/sheetsSnapshot.ts', 'src/server/migration/redisClaimSnapshot.ts',
  'src/server/migration/__fixtures__/normalization.ts', 'src/server/db/testing/pglite.ts',
  'src/server/db/transaction.ts', 'package.json', 'vitest.config.mts',
  ...migrations.map((name) => join(migrationsDirectory, name)),
];
const sourceHashes = () => Object.fromEntries(watched.map((path) => [path, hash(readFileSync(path, 'utf8'))]));
const initialHashes = sourceHashes();
const evidencePath = join(tmpdir(), `class-store-provenance-stage-${randomUUID()}.json`);
const cases: Record<string, Fact> = {};
const evidence = {
  scope: 'PUBLIC_PREPARATION_RECAPTURE_PGLITE_ONLY', authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN',
  complete: false, activationAllowed: false, fullSourceReconciliation: 'NOT_PERFORMED',
  fullTargetReconciliation: 'NOT_PERFORMED', engine: 'in-memory PGlite, not PostgreSQL 17 / production role proof',
  sourceHashes: initialHashes, migrations, cases,
};

type CaptureOptions = { fresh?: boolean; author?: string; removeClaim?: boolean; bankSheet?: boolean };
async function capture(options: CaptureOptions = {}): Promise<Acquisition> {
  const seed = options.bankSheet ? makeSheets() : makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  const operation = makeRedis().operationBindings[0];
  const base = structuredClone(operation.binding);
  const binding = { ...base, evidence: { ...base.evidence,
    evidenceAuthorFullName: options.author ?? base.evidence.evidenceAuthorFullName } };
  const tuple = hash(`${binding.evidence.evidenceBoardId}\0${binding.evidence.evidencePostId}`);
  const claimField = `claim:${tuple}`;
  const entries: Array<readonly [string, string]> = options.removeClaim ? [] : [
    [claimField, operation.operationId],
    [`op:${hash(operation.operationId)}`, JSON.stringify({ binding, claimField })],
  ];
  let sheetReads = 0, redisReads = 0, scans = 0;
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId,
    capturedAt: options.fresh ? SECOND : FIRST,
    reader: {
      listSheetNames: async () => Object.keys(workbook),
      getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => { sheetReads++; return options.fresh ? 'sheet-2' : 'sheet-1'; },
    } });
  const redis = await captureRedisClaimSnapshot({
    hscan: async (key, cursor) => {
      expect(key).toBe('padlet:evidence-bindings:v2'); expect(cursor).toBe('0'); scans++;
      return { cursor: '0', entries: structuredClone(entries) };
    },
    scan: async (cursor, pattern) => {
      expect(cursor).toBe('0'); expect(pattern).toBe('padlet:evidence-claim:v1:*');
      return { cursor: '0', keys: [] };
    },
    get: async () => { throw new Error('No v1 fixture keys'); },
    getRevision: async () => { redisReads++; return options.fresh ? 'redis-2' : 'redis-1'; },
  }, { capturedAt: options.fresh ? SECOND : FIRST });
  expect([sheetReads, redisReads, scans]).toEqual([2, 2, 1]);
  for (const artifact of [sheets, redis]) {
    const { digest: actual, ...body } = artifact;
    expect(actual).toBe(digest(body));
  }
  return { sheets, redis };
}
function normalize(tenantId: string, acquisition: Acquisition, ready = true) {
  assertNormalizationInput(acquisition);
  const manifest = createLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, ...acquisition });
  if (ready) {
    expect(manifest.status, canonicalJson(manifest.blockingConflicts)).toBe('READY_FOR_IMPORT');
    expect(manifest.quarantines).toEqual([]); expect(manifest.blockingConflicts).toEqual([]);
  }
  return manifest;
}
// Canonical JSON value equality, not physical JSONB text/key ordering.
async function databaseState(harness: PgliteDatabaseHarness, includeAudit = true) {
  const { rows } = await harness.database.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const state: Record<string, string[]> = {};
  for (const { tablename } of rows) {
    expect(tablename).toMatch(/^[a-z_][a-z0-9_]*$/);
    if (!includeAudit && tablename === 'audit_events') continue;
    const result = await harness.database.query(`SELECT row_to_json(t) AS row, xmin::text AS xmin FROM public."${tablename}" t`);
    state[tablename] = result.rows.map((row) => canonicalJson(row)).sort();
  }
  return state;
}
type Envelope = { event_id: string; event_type: string; tenant_id: string; job_id: string;
  operation_id: null; actor_user_id: null; entity_type: null; entity_id: null; redacted_details: Record<string, unknown> };
async function envelopes(harness: PgliteDatabaseHarness) {
  return (await harness.database.query<{ row: Envelope; xmin: string }>(
    "SELECT row_to_json(t) AS row,xmin::text AS xmin FROM audit_events t WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id")).rows;
}
async function fixture(harness: PgliteDatabaseHarness, fact: Fact) {
  fact.phase = 'capture/normalize original';
  const original = await capture();
  const manifest = normalize(harness.tenantOneId, original);
  expect(manifest.records[CLAIMS]).toHaveLength(1);
  expect(manifest.records.legacy_operation_bindings).toHaveLength(1);
  fact.original = { manifestDigest: manifest.manifestDigest, sheetsDigest: original.sheets.digest,
    redisDigest: original.redis.digest, claims: 1, bindings: 1 };
  fact.phase = 'real importer';
  await harness.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  fact.importResult = await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
    manifest, runTransaction: harness.runTenantTransaction });
  // Synthetic fixture lifecycle only. No readiness/freeze/authority is certified.
  fact.phase = 'synthetic job READY';
  await harness.database.query("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2", [harness.tenantOneId, JOB]);
  await harness.database.query("UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2", [harness.tenantOneId, JOB]);
  fact.phase = 'real original inspector';
  const issues = await harness.runTenantTransaction(harness.tenantOneId, (tx) => inspectLegacyImport(tx,
    { tenantId: harness.tenantOneId, migrationJobId: JOB, manifest }, manifest));
  fact.originalInspectorIssues = issues;
  expect(issues).toEqual([]);
  const { rows: jobs } = await harness.database.query<{ version: string }>(
    'SELECT state_version::text AS version FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [harness.tenantOneId, JOB]);
  const { rows: snapshots } = await harness.database.query<{ snapshot_id: string; source_id: string }>(
    "SELECT snapshot_id,source_id FROM migration_snapshots WHERE tenant_id=$1 AND job_id=$2 AND phase='PREFLIGHT'", [harness.tenantOneId, JOB]);
  expect(jobs).toHaveLength(1); expect(snapshots).toHaveLength(1);
  const candidate = await capture({ fresh: true });
  const input: FinalGenerationPreparationInput = { tenantId: harness.tenantOneId, migrationJobId: JOB,
    expectedStateVersion: jobs[0].version, originalSourceId: snapshots[0].source_id,
    originalSnapshotId: snapshots[0].snapshot_id, original, candidate,
    exclusionGenerationReference: 'a'.repeat(64) }; // local label, NEVER real writer proof
  const baseline = await databaseState(harness);
  for (const table of ['operations', CLAIMS, 'padlet_claim_digest_tombstones', 'migration_final_generations',
    'migration_final_source_records', 'migration_final_targets', 'migration_local_generation_reconciliation']) expect(baseline[table]).toEqual([]);
  fact.phase = 'test body';
  return { harness, fact, input, manifest, baseline };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function claimBusiness(manifest: Manifest) {
  expect(manifest.records[CLAIMS]).toHaveLength(1);
  const { provenances, ...business } = manifest.records[CLAIMS][0];
  expect(provenances).toHaveLength(1);
  return business;
}
function contributors(manifest: Manifest) {
  return manifest.sourceRecords.filter((record) => record.targetTable === CLAIMS).map(({ source }) => {
    const { artifactDigest, ...retained } = source;
    expect(artifactDigest).toBe(source.kind === 'REDIS' ? manifest.sourceArtifacts.redis?.digest : manifest.sourceArtifacts.sheets.digest);
    return canonicalJson(retained);
  }).sort();
}
async function assertPreserved(f: Fixture) {
  const before = { ...f.baseline }; delete before.audit_events;
  expect(await databaseState(f.harness, false)).toEqual(before);
  const issues = await f.harness.runTenantTransaction(f.input.tenantId, (tx) => inspectLegacyImport(tx,
    { tenantId: f.input.tenantId, migrationJobId: JOB, manifest: f.manifest }, f.manifest));
  expect(issues).toEqual([]);
}
async function assertStored(f: Fixture, input: FinalGenerationPreparationInput, result: Stage) {
  // Reconstruct each expected complete envelope independently from acquisitions.
  // Never derive expected bytes by stripping/rewriting persisted provenance.
  const originalManifest = normalize(input.tenantId, input.original);
  const candidateManifest = normalize(input.tenantId, input.candidate, result.plan.status !== 'BLOCKED');
  const binding = { tenantId: input.tenantId, migrationJobId: JOB, expectedStatus: 'READY',
    expectedStateVersion: input.expectedStateVersion, originalSnapshotId: input.originalSnapshotId,
    originalSourceId: input.originalSourceId, originalManifestDigest: originalManifest.manifestDigest,
    originalSourceFingerprint: originalManifest.sourceFingerprint };
  const original = { storage: 'UNTRUSTED_PREPARATION', phase: 'ORIGINAL_PREFLIGHT',
    tenantId: input.tenantId, migrationJobId: JOB, originalSnapshotId: input.originalSnapshotId,
    originalSourceId: input.originalSourceId, acquisition: input.original, manifest: originalManifest };
  const candidate = { storage: 'UNTRUSTED_PREPARATION', phase: 'FINAL_CANDIDATE', binding,
    originalGenerationId: result.originalGenerationId, exclusionGenerationReference: input.exclusionGenerationReference,
    acquisition: input.candidate, manifest: candidateManifest };
  const plan = { storage: 'UNTRUSTED_PREPARATION', phase: 'DELTA_PLAN', binding,
    originalGenerationId: result.originalGenerationId, candidateGenerationId: result.candidateGenerationId,
    exclusionGenerationReference: input.exclusionGenerationReference, originalManifestDigest: originalManifest.manifestDigest,
    candidateManifestDigest: candidateManifest.manifestDigest, ...result.plan };
  const expected = [
    ['ORIGINAL', result.originalGenerationId, original],
    ['CANDIDATE', result.candidateGenerationId, candidate],
    ['PLAN', result.planId, plan],
  ] as const;
  const saved = await envelopes(f.harness);
  expect(saved).toHaveLength(3);
  for (const [kind, id, details] of expected) {
    expect(id).toBe(`preparation:${kind.toLowerCase()}:${digest(details)}`);
    const matches = saved.filter(({ row }) => row.event_id === id);
    expect(matches).toHaveLength(1);
    expect(matches[0].row).toMatchObject({ tenant_id: input.tenantId, job_id: JOB,
      event_type: `MIGRATION_PREPARATION_${kind}`, operation_id: null, actor_user_id: null, entity_type: null, entity_id: null });
    expect(canonicalJson(matches[0].row.redacted_details)).toBe(canonicalJson(details));
  }
  f.fact.envelopes = saved.map(({ row, xmin }) => ({ eventId: row.event_id, xmin, detailsDigest: digest(row.redacted_details) }));
  return { originalManifest, candidateManifest };
}
function checked(name: string, body: (fixture: Fixture) => Promise<void>) {
  it(name, async () => {
    const fact: Fact = { status: 'running', phase: 'in-memory harness', databaseClosed: false };
    cases[name] = fact;
    let harness: PgliteDatabaseHarness | undefined;
    try {
      harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
      fact.phase = 'remaining real DDL';
      for (const name of migrations.filter((name) => name.slice(0, 4) > '0008')) {
        await harness.database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'));
      }
      await body(await fixture(harness, fact)); fact.status = 'passed';
    } catch (error) {
      fact.status = 'failed'; fact.error = error instanceof Error ? { name: error.name, message: error.message,
        cause: error.cause instanceof Error ? error.cause.message : String(error.cause ?? '') } : String(error);
      throw error;
    } finally {
      await harness?.close(); fact.databaseClosed = Boolean(harness);
    }
  }, 0); // No short per-test deadline for WASM DDL/import; no shell run budget.
}
afterAll(() => {
  const unchanged = canonicalJson(sourceHashes()) === canonicalJson(initialHashes);
  writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, sourceFilesUnchanged: unchanged }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Synthetic public preparation evidence: ${evidencePath}`);
  expect(unchanged).toBe(true);
});

describe('PUBLIC_PREPARATION_RECAPTURE_PGLITE_ONLY', () => {
  checked('imports a nonempty valid Redis claim and reaches public preparation without a fake inspector', async (f) => {
    const { input, manifest, harness, fact } = f;
    const candidate = normalize(input.tenantId, input.candidate);
    expect(candidate.sourceFingerprint).toBe(manifest.sourceFingerprint);
    expect(candidate.manifestDigest).not.toBe(manifest.manifestDigest);
    expect(input.candidate.redis.digest).not.toBe(input.original.redis.digest);
    expect(input.candidate.sheets.digest).not.toBe(input.original.sheets.digest);
    fact.phase = 'public stage';
    const result: Stage = await stageLegacyFinalGeneration(input, { runTransaction: harness.runTenantTransaction });
    expect(result.storage).toBe('UNTRUSTED_PREPARATION');
    expect(result.plan).toEqual({ status: 'DIFF_VALIDATED', changes: [], blockers: [] });
    await assertStored(f, input, result);
    await assertPreserved(f);
    fact.result = result;
  });

  checked('preserves both complete immutable acquisitions and manifests while exact business and contributors match', async (f) => {
    const { input, manifest, harness, fact } = f;
    const candidate = normalize(input.tenantId, input.candidate);
    const inputBytes = canonicalJson(input);
    expect(input.candidate).not.toBe(input.original);
    expect(claimBusiness(candidate)).toEqual(claimBusiness(manifest));
    expect(contributors(candidate)).toEqual(contributors(manifest));
    expect(contributors(candidate)).toHaveLength(1);
    expect(candidate.mappings).toEqual(manifest.mappings);
    expect(candidate.records.legacy_operation_bindings).toEqual(manifest.records.legacy_operation_bindings);
    const beforeClaim = manifest.records[CLAIMS][0], afterClaim = candidate.records[CLAIMS][0];
    expect(digest(afterClaim)).not.toBe(digest(beforeClaim));
    const result = await stageLegacyFinalGeneration(input, { runTransaction: harness.runTenantTransaction });
    expect(result.plan).toEqual({ status: 'DIFF_VALIDATED', changes: [], blockers: [] });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.plan)).toBe(true);
    expect(canonicalJson(input)).toBe(inputBytes);
    const saved = await assertStored(f, input, result);
    const originalPointer = manifest.sourceRecords.find((r) => r.targetTable === CLAIMS)!.source;
    const candidatePointer = candidate.sourceRecords.find((r) => r.targetTable === CLAIMS)!.source;
    expect(originalPointer).toMatchObject({ kind: 'REDIS', artifactDigest: input.original.redis.digest,
      provenance: 'upstash:padlet:evidence-bindings:v2' });
    expect(candidatePointer).toEqual({ ...originalPointer, artifactDigest: input.candidate.redis.digest });
    expect(saved.originalManifest.records[CLAIMS][0].provenances).toEqual([originalPointer]);
    expect(saved.candidateManifest.records[CLAIMS][0].provenances).toEqual([candidatePointer]);
    await assertPreserved(f);
    fact.rowDigests = { original: digest(beforeClaim), candidate: digest(afterClaim) };
    fact.sameBusiness = true; fact.exactContributorMultiplicity = 1; fact.originalInspectorAfter = [];
  });

  checked('identical retry returns the same IDs and preserves every row including audit xmin', async (f) => {
    const first = await stageLegacyFinalGeneration(f.input, { runTransaction: f.harness.runTenantTransaction });
    await assertStored(f, f.input, first);
    const once = await databaseState(f.harness);
    expect(await stageLegacyFinalGeneration(f.input, { runTransaction: f.harness.runTenantTransaction })).toEqual(first);
    expect(await databaseState(f.harness)).toEqual(once);
    await assertPreserved(f);
    f.fact.retry = { sameIds: true, everyRowAndXminUnchanged: true };
  });

  for (const wrong of ['originalSnapshotId', 'expectedStateVersion'] as const) {
    checked(`wrong ${wrong} refuses without adding or replacing existing preparation evidence`, async (f) => {
      await stageLegacyFinalGeneration(f.input, { runTransaction: f.harness.runTenantTransaction });
      const once = await databaseState(f.harness);
      const input = { ...f.input, [wrong]: wrong === 'originalSnapshotId' ? `import:${'b'.repeat(64)}`
        : String(BigInt(f.input.expectedStateVersion) + BigInt(1)) };
      let entries = 0;
      await expect(stageLegacyFinalGeneration(input, { runTransaction: (tenant, callback) => {
        entries++; return f.harness.runTenantTransaction(tenant, callback);
      } })).rejects.toThrow('Final generation preparation refused.');
      expect(entries).toBe(wrong === 'originalSnapshotId' ? 0 : 1);
      expect(await databaseState(f.harness)).toEqual(once);
      f.fact.refusal = { wrong, transactionEntries: entries, existingRowsUnchanged: true };
    });
  }

  checked('rollback is witnessed after three real append/readbacks and retry subsequently commits', async (f) => {
    let witnessed: unknown[] = [];
    await expect(stageLegacyFinalGeneration(f.input, { runTransaction: (tenant, callback) =>
      f.harness.runTenantTransaction(tenant, async (tx) => {
        const result = await callback(tx);
        expect(result).toMatchObject({ storage: 'UNTRUSTED_PREPARATION', plan: { status: 'DIFF_VALIDATED' } });
        const { rows } = await tx.execute(sql`SELECT event_id,redacted_details FROM audit_events
          WHERE tenant_id=${tenant} AND job_id=${JOB} AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`);
        expect(rows).toHaveLength(3);
        witnessed = rows;
        throw new Error('synthetic failure after actual append/readback, before COMMIT');
      }) })).rejects.toThrow('Final generation preparation refused.');
    expect(witnessed).toHaveLength(3);
    expect(await databaseState(f.harness)).toEqual(f.baseline);
    const result = await stageLegacyFinalGeneration(f.input, { runTransaction: f.harness.runTenantTransaction });
    await assertStored(f, f.input, result); await assertPreserved(f);
    f.fact.rollback = { witnessedRowsBeforeThrow: witnessed.length, restoredEntireBaseline: true, retryCommitted: true };
  });

  checked('post-commit lost caller response is distinguished from rollback and exact retry does not duplicate evidence', async (f) => {
    let acknowledgedCommit = false;
    await expect(stageLegacyFinalGeneration(f.input, { runTransaction: async (tenant, callback) => {
      await f.harness.runTenantTransaction(tenant, callback);
      acknowledgedCommit = true;
      throw new Error('synthetic caller response loss after acknowledged in-memory COMMIT');
    } })).rejects.toThrow('Final generation preparation refused.');
    expect(acknowledgedCommit).toBe(true);
    expect(await envelopes(f.harness)).toHaveLength(3);
    const committed = await databaseState(f.harness);
    const result = await stageLegacyFinalGeneration(f.input, { runTransaction: f.harness.runTenantTransaction });
    expect(await databaseState(f.harness)).toEqual(committed);
    await assertStored(f, f.input, result); await assertPreserved(f);
    f.fact.lostCallerResponse = { acknowledgedCommit, retryReadExistingRows: true, rollbackClaimed: false };
  });

  for (const kind of ['MUTATED', 'REMOVED'] as const) {
    checked(`fresh metadata does not mask true claim/binding ${kind} in the public archived plan`, async (f) => {
      const candidate = await capture({ fresh: true, ...(kind === 'MUTATED' ? { author: 'Alice-Changed' } : { removeClaim: true }) });
      const manifest = normalize(f.input.tenantId, candidate);
      expect(manifest.records[CLAIMS]).toHaveLength(kind === 'MUTATED' ? 1 : 0);
      const input = { ...f.input, candidate };
      const result = await stageLegacyFinalGeneration(input, { runTransaction: f.harness.runTenantTransaction });
      expect(result.plan.status).toBe('BLOCKED');
      expect(result.plan.blockers).toEqual(kind === 'MUTATED'
        ? ['APPEND_ONLY_HISTORY_CHANGED', 'APPEND_ONLY_HISTORY_PROVENANCE_CHANGED'] : ['APPEND_ONLY_HISTORY_CHANGED']);
      expect(result.plan.changes).toEqual(['legacy_operation_bindings', CLAIMS].map((table) => ({ table,
        identity: canonicalJson([f.manifest.records[table][0][table === CLAIMS ? 'tupleDigest' : 'operationId']]), kind,
        beforeDigest: digest(f.manifest.records[table][0]), afterDigest: kind === 'REMOVED' ? null : digest(manifest.records[table][0]) })));
      await assertStored(f, input, result); await assertPreserved(f);
      f.fact.blockedPlan = result.plan;
    });
  }

  for (const side of ['sheets', 'redis'] as const) {
    checked(`invalid ${side} digest refuses before the transaction with no evidence writes`, async (f) => {
      const input = { ...f.input, candidate: { ...f.input.candidate,
        [side]: { ...f.input.candidate[side], capturedAt: FIRST } } };
      let entries = 0;
      await expect(stageLegacyFinalGeneration(input, { runTransaction: (tenant, callback) => {
        entries++; return f.harness.runTenantTransaction(tenant, callback);
      } })).rejects.toThrow('Final generation preparation refused.');
      expect(entries).toBe(0);
      expect(await databaseState(f.harness)).toEqual(f.baseline);
      f.fact.transactionEntries = entries;
    });
  }

  checked('correctly rehashed duplicate Redis claim is invalid capture rather than admissible multiplicity', async (f) => {
    const { digest: priorDigest, ...body } = f.input.candidate.redis;
    expect(priorDigest).toBe(digest(body));
    const duplicate = { ...body, v2Claims: [structuredClone(body.v2Claims[0]), structuredClone(body.v2Claims[0])] };
    const candidate = { ...f.input.candidate, redis: { ...duplicate, digest: digest(duplicate) } };
    let entries = 0;
    await expect(stageLegacyFinalGeneration({ ...f.input, candidate }, { runTransaction: (tenant, callback) => {
      entries++; return f.harness.runTenantTransaction(tenant, callback);
    } })).rejects.toThrow('Final generation preparation refused.');
    expect(entries).toBe(0); expect(await databaseState(f.harness)).toEqual(f.baseline);
    f.fact.multiplicityLimit = 'Duplicate capture refused; not valid retained-union multiplicity proof';
  });

  checked('unsupported Sheet BANK plus Redis union remains normalization BLOCKED and only archival', async (f) => {
    const candidate = await capture({ fresh: true, bankSheet: true });
    const manifest = normalize(f.input.tenantId, candidate, false);
    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.quarantines.some((row) => row.errorCodes.includes('UNSUPPORTED_LEGACY_BANK_AUTHORITY'))).toBe(true);
    const input = { ...f.input, candidate };
    const result = await stageLegacyFinalGeneration(input, { runTransaction: f.harness.runTenantTransaction });
    expect(result.plan.status).toBe('BLOCKED'); expect(result.plan.blockers).toContain('NORMALIZATION_BLOCKED');
    await assertStored(f, input, result); await assertPreserved(f);
    f.fact.blockedPlan = result.plan; f.fact.validRetainedUnionProof = false;
  });

  checked('the original inspector still rejects substituting a freshly recaptured current manifest', async (f) => {
    const candidate = normalize(f.input.tenantId, f.input.candidate);
    const issues = await f.harness.runTenantTransaction(f.input.tenantId, (tx) => inspectLegacyImport(tx,
      { tenantId: f.input.tenantId, migrationJobId: JOB, manifest: f.manifest }, candidate));
    expect(issues).toContainEqual({ category: 'SOURCES', code: 'SOURCE_MUTATION' });
    expect(await databaseState(f.harness)).toEqual(f.baseline);
    f.fact.candidateAsCurrentDiagnostics = issues;
  });

  checked('exact-noop accepts independent byte-identical nonempty captures without gaining authority', async (f) => {
    const candidate = await capture();
    expect(candidate).not.toBe(f.input.original);
    expect(canonicalJson(candidate)).toBe(canonicalJson(f.input.original));
    const input = { ...f.input, candidate };
    const result = await reconcileLocalNoopFinalDelta(input, { runTransaction: f.harness.runTenantTransaction });
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', finding: 'IDENTICAL_CAPTURE' });
    expect(await envelopes(f.harness)).toHaveLength(3);
    const state = await databaseState(f.harness);
    expect(state.audit_events).toHaveLength(f.baseline.audit_events.length + 4);
    const { rows } = await f.harness.database.query<{ redacted_details: Record<string, unknown> }>(
      'SELECT redacted_details FROM audit_events WHERE event_id=$1', [result.reportEventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].redacted_details).toEqual({ storage: 'UNTRUSTED_PREPARATION', finding: 'IDENTICAL_CAPTURE',
      originalGenerationId: result.originalGenerationId, candidateGenerationId: result.candidateGenerationId,
      planId: result.planId, authority: 'NONAUTHORITY' });
    expect(await reconcileLocalNoopFinalDelta(input, { runTransaction: f.harness.runTenantTransaction })).toEqual(result);
    expect(await databaseState(f.harness)).toEqual(state); await assertPreserved(f);
    f.fact.exactNoop = result;
  });

  checked('exact-noop refuses metadata-only recapture after real preparation inserts and rolls them all back', async (f) => {
    let witnessed: unknown[] = [];
    await expect(reconcileLocalNoopFinalDelta(f.input, { runTransaction: (tenant, callback) =>
      f.harness.runTenantTransaction(tenant, async (tx) => {
        try { return await callback(tx); }
        catch (error) {
          const { rows } = await tx.execute(sql`SELECT event_type,redacted_details FROM audit_events
            WHERE tenant_id=${tenant} AND job_id=${JOB} AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_type`);
          expect(rows).toHaveLength(3);
          const plan = rows.find((row) => row.event_type === 'MIGRATION_PREPARATION_PLAN')?.redacted_details;
          expect(plan).toMatchObject({ status: 'DIFF_VALIDATED', changes: [], blockers: [] });
          expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('capture');
          witnessed = rows;
          throw error;
        }
      }) })).rejects.toThrow('Local no-op reconciliation refused.');
    expect(witnessed).toHaveLength(3); expect(await databaseState(f.harness)).toEqual(f.baseline);
    await assertPreserved(f);
    f.fact.exactNoopRefusal = { gate: 'capture', witnessedRowsBeforeRollback: witnessed.length, fullRollback: true };
  });
});
