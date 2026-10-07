// @vitest-environment node
// NONAUTHORITY: synthetic in-memory envelope copies, NOT persisted SQL rows.
// No authenticated FREEZING, writer exclusion, FINAL_IMPORT or Task19/23 acceptance.
// NOT_RUN: the shared Vitest/Vite loader's localhost boundary is still unproven.
// Exact focused command NOT RUN (no wrapper/relocation/alternate interpreter):
// ./node_modules/.bin/vitest run src/server/migration/localFullDeltaCheckedPreparation.captureBinding.test.ts
// Static evidence: vitest.config.mts:1-11 loads the shared React/Vite configuration;
// node_modules/vite/dist/node/chunks/node.js:2059-2076 conditionally looks up localhost.
// The inspector imports pointer -> finalGeneration -> transaction -> DB client;
// client.ts:24-84 defers pool creation, but this is NOT a complete import-safety proof.
// This file calls only pure inspectors/normalization/fixture builders, never a stage,
// transaction runner, capture reader, database harness, socket or subprocess.
// tsc/ESLint are NOT_RUN; no concurrent compiler, loader change or production edit.
// Fixture premises below are mandatory assertions, not a claimed execution result.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { createLegacyNormalizationManifest } from './manifest';
import { finalizeSheetsSnapshot, makeRedis, makeSupportedSheets } from './__fixtures__/normalization';
import { canonicalJson } from './validators';
import { verifyLocalCapturedSourceCoverage } from './localCapturedSourceCoverage';
import { inspectLocalPointerPreparationEnvelopes } from './localPointerCheckedPreparation';
import { inspectLocalFullDeltaPreparationEnvelopes } from './localFullDeltaCheckedPreparation';
import { verifyLocalFullCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';

// Environment marker only. No binding, manifest, checker, SQL or result mocks.
vi.mock('server-only', () => ({}));

const TENANT = '10000000-0000-4000-8000-000000000019';
const JOB = '20000000-0000-4000-8000-000000000019';
const AT = { A: '2026-09-01T00:00:00.000Z', B: '2026-09-02T00:00:00.000Z' } as const;
const REFUSAL = 'Local full-delta-checked preparation refused.';
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const EXCLUSION_LABEL = digest('synthetic label only; exclusion NOT_PROVEN');
type Generation = keyof typeof AT;
type Acquisition = FinalGenerationPreparationInput['original'];
type Context = Pick<FinalGenerationPreparationInput, 'tenantId' | 'migrationJobId' | 'expectedStateVersion'
  | 'originalSourceId' | 'originalSnapshotId' | 'exclusionGenerationReference'>;
type Stage = Parameters<typeof inspectLocalFullDeltaPreparationEnvelopes>[1];
type MutateTabs = Parameters<typeof makeSupportedSheets>[1];
const flags = { authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', complete: false, activationAllowed: false };

function normalizeCapture(generation: Generation, mutate?: MutateTabs) {
  // Every call constructs independent source bytes and runs the real manifest
  // builder. Never copy A's manifest/fingerprint/digest into generation B.
  // Static premise: normalize.ts:651 keeps the Sheet artifact digest on source
  // pointers; manifest.ts:79-115 omits that capture address from the semantic
  // fingerprint. Empty Redis families avoid capture-specific claim provenances.
  // manifest.ts:45-66 still includes acquisition digests in manifestDigest.
  const seed = makeSupportedSheets(3, mutate);
  const acquisition: Acquisition = {
    sheets: finalizeSheetsSnapshot({ ...seed, capturedAt: AT[generation], sourceRevision: `synthetic-sheet-${generation}` }),
    redis: makeRedis({ capturedAt: AT[generation], sourceRevision: `synthetic-redis-${generation}`,
      v2Claims: [], operationBindings: [], v1Tombstones: [], orphanedClaimDigests: [] }),
  };
  const manifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...acquisition });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  expect(manifest.blockingConflicts).toEqual([]);
  expect(manifest.quarantines).toEqual([]);
  expect(manifest.records.students).toHaveLength(1);
  expect(manifest.records.products).toHaveLength(1);
  expect(manifest.records.transactions).toHaveLength(2);
  expect(manifest.records.padlet_evidence_claims ?? []).toEqual([]);
  expect(manifest.records.legacy_operation_bindings ?? []).toEqual([]);
  for (const family of ['v2Claims', 'operationBindings', 'v1Tombstones', 'orphanedClaimDigests'] as const) {
    expect(acquisition.redis[family]).toEqual([]);
  }
  const { manifestDigest, ...manifestBody } = manifest;
  expect(manifestDigest).toBe(digest(manifestBody));
  for (const snapshot of [acquisition.sheets, acquisition.redis]) {
    const { digest: snapshotDigest, ...body } = snapshot;
    expect(snapshotDigest).toBe(digest(body));
  }
  // Real bounded capture/manifest validator and pointer accounting, not a forged
  // READY flag. Its successful result is still only content consistency.
  const report = verifyLocalCapturedSourceCoverage({
    capture: { tenantId: TENANT, migrationJobId: JOB, ...acquisition }, manifest,
  });
  expect(report).toMatchObject({ ...flags, status: 'CAPTURE_POINTERS_ACCOUNTED', pointerAccounting: 'ACCOUNTED',
    normalizationStatus: 'READY_FOR_IMPORT', missingSourceUnits: 0, unexpectedSourceReferences: 0,
    binding: 'CONTENT_DIGESTS_ONLY', manifestDigest, sheetsDigest: acquisition.sheets.digest,
    redisDigest: acquisition.redis.digest, fullSourceReconciliation: 'NOT_PERFORMED', fullTargetReconciliation: 'NOT_PERFORMED' });
  return { acquisition, manifest };
}
type NormalizedCapture = ReturnType<typeof normalizeCapture>;

function contextFor(original: NormalizedCapture): Context {
  return { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: '7',
    originalSourceId: `sheet:${original.acquisition.sheets.digest}`,
    originalSnapshotId: `import:${original.manifest.manifestDigest}`,
    exclusionGenerationReference: EXCLUSION_LABEL };
}

function envelope<T extends object>(kind: 'ORIGINAL' | 'CANDIDATE' | 'PLAN', details: T) {
  return { tenant_id: TENANT, job_id: JOB, event_type: `MIGRATION_PREPARATION_${kind}`,
    event_id: `preparation:${kind.toLowerCase()}:${digest(details)}`,
    operation_id: null, actor_user_id: null, entity_type: null, entity_id: null, redacted_details: details };
}

function seal(original: NormalizedCapture, candidate: NormalizedCapture, context: Context) {
  // In-memory fixture protocol from finalGeneration.ts:65-79, NOT a stage result
  // obtained from a fake runner. The unchanged plan is fixture data, not a mocked
  // planner/checker return. The mutation test deliberately hides a real change.
  const binding = { tenantId: context.tenantId, migrationJobId: context.migrationJobId,
    expectedStatus: 'READY', expectedStateVersion: context.expectedStateVersion,
    originalSourceId: context.originalSourceId, originalSnapshotId: context.originalSnapshotId,
    originalManifestDigest: original.manifest.manifestDigest, originalSourceFingerprint: original.manifest.sourceFingerprint };
  const originalEnvelope = envelope('ORIGINAL', { storage: 'UNTRUSTED_PREPARATION', phase: 'ORIGINAL_PREFLIGHT',
    tenantId: TENANT, migrationJobId: JOB, originalSourceId: context.originalSourceId,
    originalSnapshotId: context.originalSnapshotId, ...original });
  const candidateEnvelope = envelope('CANDIDATE', { storage: 'UNTRUSTED_PREPARATION', phase: 'FINAL_CANDIDATE',
    binding, originalGenerationId: originalEnvelope.event_id,
    exclusionGenerationReference: context.exclusionGenerationReference, ...candidate });
  const plan: Stage['plan'] = { status: 'DIFF_VALIDATED', changes: [], blockers: [] };
  const planEnvelope = envelope('PLAN', { storage: 'UNTRUSTED_PREPARATION', phase: 'DELTA_PLAN', binding,
    originalGenerationId: originalEnvelope.event_id, candidateGenerationId: candidateEnvelope.event_id,
    exclusionGenerationReference: context.exclusionGenerationReference,
    originalManifestDigest: original.manifest.manifestDigest, candidateManifestDigest: candidate.manifest.manifestDigest, ...plan });
  const prepared: Stage = { storage: 'UNTRUSTED_PREPARATION', originalGenerationId: originalEnvelope.event_id,
    candidateGenerationId: candidateEnvelope.event_id, planId: planEnvelope.event_id, plan };
  return { original, candidate, context, prepared, originalEnvelope, candidateEnvelope, planEnvelope,
    rows: [originalEnvelope, candidateEnvelope, planEnvelope] };
}
type Fixture = ReturnType<typeof seal>;
const bytes = (fixture: Fixture, context: Context = fixture.context) => canonicalJson({ context, prepared: fixture.prepared, rows: fixture.rows });

function assertSealed(fixture: Fixture) {
  const { originalEnvelope, candidateEnvelope, planEnvelope, prepared } = fixture;
  expect(fixture.rows).toHaveLength(3);
  expect(new Set(fixture.rows.map((row) => row.event_id)).size).toBe(3);
  for (const [kind, row] of [['original', originalEnvelope], ['candidate', candidateEnvelope], ['plan', planEnvelope]] as const) {
    expect(row.event_id).toBe(`preparation:${kind}:${digest(row.redacted_details)}`);
    expect(row).toMatchObject({ tenant_id: TENANT, job_id: JOB, operation_id: null,
      actor_user_id: null, entity_type: null, entity_id: null });
  }
  expect(prepared.originalGenerationId).toBe(originalEnvelope.event_id);
  expect(prepared.candidateGenerationId).toBe(candidateEnvelope.event_id);
  expect(prepared.planId).toBe(planEnvelope.event_id);
  expect(candidateEnvelope.redacted_details.originalGenerationId).toBe(originalEnvelope.event_id);
  expect(planEnvelope.redacted_details.originalGenerationId).toBe(originalEnvelope.event_id);
  expect(planEnvelope.redacted_details.candidateGenerationId).toBe(candidateEnvelope.event_id);
  expect(planEnvelope.redacted_details.binding).toEqual(candidateEnvelope.redacted_details.binding);
  expect(prepared.plan).toEqual({ status: planEnvelope.redacted_details.status,
    changes: planEnvelope.redacted_details.changes, blockers: planEnvelope.redacted_details.blockers });
}

function makeGeneration(generation: Generation) {
  const original = normalizeCapture(generation);
  const candidate = normalizeCapture(generation);
  expect(candidate.acquisition).not.toBe(original.acquisition);
  expect(candidate.manifest).not.toBe(original.manifest);
  expect(candidate.manifest).toEqual(original.manifest);
  return seal(original, candidate, contextFor(original));
}

function assertAccepted(fixture: Fixture) {
  assertSealed(fixture);
  const before = bytes(fixture);
  const result = inspectLocalFullDeltaPreparationEnvelopes(fixture.context, fixture.prepared, fixture.rows);
  expect(result.deltaCoverage).toMatchObject({ ...flags, status: 'COVERED_LOCAL_INPUTS',
    scope: 'LOCAL_NORMALIZED_ADDED_DELTA_COVERAGE_ONLY', sourceReconciliation: 'NOT_PERFORMED', targetReconciliation: 'NOT_PERFORMED' });
  for (const [side, input] of [['original', fixture.original], ['candidate', fixture.candidate]] as const) {
    expect(result.reports[side]).toMatchObject({ ...flags, status: 'CAPTURE_POINTERS_ACCOUNTED',
      pointerAccounting: 'ACCOUNTED', manifestDigest: input.manifest.manifestDigest,
      sheetsDigest: input.acquisition.sheets.digest, redisDigest: input.acquisition.redis.digest,
      missingSourceUnits: 0, unexpectedSourceReferences: 0 });
  }
  expect(result.deltaCoverage.coverage).toEqual(expect.arrayContaining([
    { table: 'students', originalCount: 1, candidateCount: 1, addedCount: 0 },
    { table: 'products', originalCount: 1, candidateCount: 1, addedCount: 0 },
    { table: 'transactions', originalCount: 2, candidateCount: 2, addedCount: 0 },
  ]));
  expect(result.deltaCoverage.coverage.every((row) => row.originalCount === row.candidateCount && row.addedCount === 0)).toBe(true);
  expect(bytes(fixture)).toBe(before);
  return result;
}

function distinctGenerations() {
  const a = makeGeneration('A');
  const b = makeGeneration('B');
  expect(a.original.manifest.records).toEqual(b.original.manifest.records);
  expect(a.original.manifest.sourceFingerprint).toBe(b.original.manifest.sourceFingerprint);
  expect(a.original.manifest.sourceRecords).not.toEqual(b.original.manifest.sourceRecords);
  expect(a.original.acquisition.sheets.capturedAt).not.toBe(b.original.acquisition.sheets.capturedAt);
  expect(a.original.acquisition.sheets.sourceRevision).not.toBe(b.original.acquisition.sheets.sourceRevision);
  expect(a.original.acquisition.redis.sourceRevision).not.toBe(b.original.acquisition.redis.sourceRevision);
  expect(a.original.acquisition.sheets.digest).not.toBe(b.original.acquisition.sheets.digest);
  expect(a.original.acquisition.redis.digest).not.toBe(b.original.acquisition.redis.digest);
  expect(a.original.manifest.manifestDigest).not.toBe(b.original.manifest.manifestDigest);
  expect(a.context.originalSourceId).not.toBe(b.context.originalSourceId);
  expect(a.context.originalSnapshotId).not.toBe(b.context.originalSnapshotId);
  // Only acquisition identities differ: no foreign tenant/job/version/exclusion
  // label can provide an easier, unrelated rejection in the substitution tests.
  expect({ ...a.context, originalSourceId: b.context.originalSourceId, originalSnapshotId: b.context.originalSnapshotId }).toEqual(b.context);
  expect(a.prepared.plan).toEqual(b.prepared.plan);
  for (const key of ['originalGenerationId', 'candidateGenerationId', 'planId'] as const) {
    expect(a.prepared[key]).not.toBe(b.prepared[key]);
  }
  assertAccepted(a);
  assertAccepted(b);
  return { a, b };
}

function assertRefused(fixture: Fixture, context: Context = fixture.context) {
  assertSealed(fixture);
  const before = bytes(fixture, context);
  expect(() => inspectLocalFullDeltaPreparationEnvelopes(context, fixture.prepared, fixture.rows)).toThrow(REFUSAL);
  expect(bytes(fixture, context)).toBe(before);
}

describe('synthetic capture-generation binding: NONAUTHORITY / NOT_PROVEN', () => {
  it('establishes two independently valid acquisitions with equal records/fingerprint and different addresses', () => {
    const { a, b } = distinctGenerations();
    expect(a.original.acquisition.sheets.spreadsheetId).toBe(b.original.acquisition.sheets.spreadsheetId);
    expect(a.original.manifest.sourceArtifacts.sheets.revisionDigest).not.toBe(b.original.manifest.sourceArtifacts.sheets.revisionDigest);
  });

  it('accepts A expected binding with independently normalized A/A envelopes', () => {
    assertAccepted(makeGeneration('A'));
  });

  it('accepts B expected binding with independently normalized B/B envelopes', () => {
    assertAccepted(makeGeneration('B'));
  });

  it('rejects A expected binding with the entire valid B-resealed envelope set and prepared shell', () => {
    const { a, b } = distinctGenerations();
    const aBefore = bytes(a);
    const resealedB = seal(b.original, b.candidate, { ...b.context });
    expect(resealedB.rows).toEqual(b.rows);
    expect(resealedB.prepared).toEqual(b.prepared);
    assertAccepted(resealedB); // Its own binding passes: not stale hashes or a malformed B.
    assertRefused(resealedB, a.context);
    expect(bytes(a)).toBe(aBefore);
    assertAccepted(a);
    assertAccepted(b);
  });

  it('rejects only a crossed source identity even after all references and content addresses are resealed', () => {
    const { a, b } = distinctGenerations();
    const before = bytes(a);
    const crossed = seal(a.original, a.candidate, { ...a.context, originalSourceId: b.context.originalSourceId });
    expect(crossed.context.originalSnapshotId).toBe(a.context.originalSnapshotId);
    expect(crossed.originalEnvelope.redacted_details.originalSourceId).toBe(b.context.originalSourceId);
    expect(crossed.candidateEnvelope.redacted_details.binding.originalSourceId).toBe(b.context.originalSourceId);
    expect(crossed.original.manifest).toBe(a.original.manifest);
    expect(crossed.context.originalSourceId).not.toBe(`sheet:${crossed.original.acquisition.sheets.digest}`);
    // Internal claimed bindings agree with the mixed expected context. The real
    // inspector must still bind source ID back to the independently valid bytes.
    assertRefused(crossed);
    expect(bytes(a)).toBe(before);
    assertAccepted(a);
  });

  it('rejects only a crossed snapshot identity even after all references and content addresses are resealed', () => {
    const { a, b } = distinctGenerations();
    const before = bytes(a);
    const crossed = seal(a.original, a.candidate, { ...a.context, originalSnapshotId: b.context.originalSnapshotId });
    expect(crossed.context.originalSourceId).toBe(a.context.originalSourceId);
    expect(crossed.originalEnvelope.redacted_details.originalSnapshotId).toBe(b.context.originalSnapshotId);
    expect(crossed.candidateEnvelope.redacted_details.binding.originalSnapshotId).toBe(b.context.originalSnapshotId);
    expect(crossed.original.manifest).toBe(a.original.manifest);
    expect(crossed.context.originalSnapshotId).not.toBe(`import:${crossed.original.manifest.manifestDigest}`);
    assertRefused(crossed);
    expect(bytes(a)).toBe(before);
    assertAccepted(a);
  });

  it('accepts unchanged A/B normalized records at the leaf without certifying capture identity', () => {
    const { a, b } = distinctGenerations();
    const before = canonicalJson([a.original.manifest, b.original.manifest, a.prepared.plan]);
    const result = verifyLocalFullCategoryDeltaCoverage(a.original.manifest.records, b.original.manifest.records, a.prepared.plan);
    expect(result).toMatchObject({ ...flags, status: 'COVERED_LOCAL_INPUTS',
      sourceReconciliation: 'NOT_PERFORMED', targetReconciliation: 'NOT_PERFORMED' });
    expect(result.coverage.every((row) => row.addedCount === 0 && row.candidateCount === row.originalCount)).toBe(true);
    expect(canonicalJson([a.original.manifest, b.original.manifest, a.prepared.plan])).toBe(before);
  });

  it('rejects a resealed immutable retained transaction mutation after the real pointer boundary passes', () => {
    const original = normalizeCapture('A');
    const unchanged = normalizeCapture('A');
    const control = seal(original, unchanged, contextFor(original));
    assertAccepted(control);
    // A fresh revision reaches immutable coverage; reusing A now correctly
    // fails earlier at the source-consistency/pointer boundary.
    const changed = normalizeCapture('B', (tabs) => {
      const tab = tabs.Transactions;
      const idIndex = tab.headers.indexOf('transactionId');
      const operatorIndex = tab.headers.indexOf('operator');
      expect(idIndex).toBeGreaterThanOrEqual(0);
      expect(operatorIndex).toBeGreaterThanOrEqual(0);
      const row = tab.rows.find((item) => item.cells[idIndex] === 'TX1');
      expect(row).toBeDefined();
      row!.cells[operatorIndex] = 'synthetic-changed-kiosk';
    });
    const prior = original.manifest.records.transactions.find((row) => row.transactionId === 'TX1');
    const next = changed.manifest.records.transactions.find((row) => row.transactionId === 'TX1');
    expect(prior).toBeDefined();
    expect(next).toEqual({ ...prior, operatorSnapshot: 'synthetic-changed-kiosk' });
    expect(next).not.toEqual(prior);
    expect(changed.manifest.sourceFingerprint).not.toBe(original.manifest.sourceFingerprint);
    const mutated = seal(original, changed, contextFor(original));
    const before = bytes(mutated);
    // A valid, recomputed candidate capture/manifest, but a deliberately dishonest
    // empty plan. No stored immutable row is modified and no SQL result is mocked.
    assertSealed(mutated);
    const pointers = inspectLocalPointerPreparationEnvelopes(mutated.context, mutated.prepared, mutated.rows);
    expect(pointers.original).toMatchObject({ ...flags, pointerAccounting: 'ACCOUNTED' });
    expect(pointers.candidate).toMatchObject({ ...flags, pointerAccounting: 'ACCOUNTED' });
    expect(() => verifyLocalFullCategoryDeltaCoverage(original.manifest.records, changed.manifest.records, mutated.prepared.plan))
      .toThrow('Local delta coverage refused.');
    assertRefused(mutated);
    expect(bytes(mutated)).toBe(before);
    assertAccepted(control);
  });

  it('rejects native writes to actual frozen manifest rows and published NONAUTHORITY inspection results', () => {
    const fixture = makeGeneration('A');
    const before = bytes(fixture);
    const result = assertAccepted(fixture);
    const resultBefore = canonicalJson(result);
    const retained = fixture.original.manifest.records.transactions.find((row) => row.transactionId === 'TX1');
    expect(retained).toBeDefined();
    expect(Object.isFrozen(fixture.original.manifest)).toBe(true);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.deltaCoverage)).toBe(true);
    expect(Object.isFrozen(result.deltaCoverage.coverage[0])).toBe(true);
    expect(Reflect.set(retained!, 'operatorSnapshot', 'forbidden mutation')).toBe(false);
    expect(Reflect.set(result.deltaCoverage, 'authority', 'AUTHORITY')).toBe(false);
    expect(Reflect.set(result.deltaCoverage.coverage[0], 'addedCount', 999)).toBe(false);
    expect(() => Object.defineProperty(retained!, 'operatorSnapshot', { value: 'forbidden mutation' })).toThrow(TypeError);
    expect(bytes(fixture)).toBe(before);
    expect(canonicalJson(result)).toBe(resultBefore);
    assertAccepted(fixture);
  });
});
