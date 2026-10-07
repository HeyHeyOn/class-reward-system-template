// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { makeRedis, makeSupportedSheets, makeSheets, finalizeRedisSnapshot, finalizeSheetsSnapshot } from './__fixtures__/normalization';
import { createLegacyNormalizationManifest } from './manifest';
import { verifyLocalCaptureBoundDeltaCoverage as verify } from './localClaimRecapture';
import { verifyLocalFullCategoryDeltaCoverage, verifyLocalMutableCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';
import { canonicalJson, sha256 } from './validators';
vi.mock('server-only', () => ({}));
const TENANT = '20000000-0000-4000-8000-000000000001';
const JOB = '20000000-0000-4000-8000-000000000019';
const EMPTY = { status: 'DIFF_VALIDATED' as const, changes: [], blockers: [] };
const CLAIMS = 'padlet_evidence_claims';
const REFUSAL = 'Local capture-bound claim recapture refused.';
function generation(redis = makeRedis(), sheets = makeSupportedSheets(), tenantId = TENANT, migrationJobId = JOB) {
  const acquisition = { sheets, redis };
  return { acquisition, manifest: createLegacyNormalizationManifest({ tenantId, migrationJobId, ...acquisition }) };
}
function pair() {
  const original = generation();
  const candidate = generation(finalizeRedisSnapshot({ ...makeRedis(), sourceRevision: 'new-revision', capturedAt: '2026-09-01T00:00:00.000Z' }),
    finalizeSheetsSnapshot({ ...makeSupportedSheets(), sourceRevision: 'new-sheet-revision', capturedAt: '2026-09-01T00:00:00.000Z' }));
  return { original, candidate };
}
function rehash(value: ReturnType<typeof generation>) {
  const { manifestDigest: _digest, ...body } = value.manifest;
  return { ...value, manifest: { ...value.manifest, manifestDigest: sha256(canonicalJson(body)) } };
}
describe('capture-bound single Redis claim recapture; never an activation receipt', () => {
  it('admits fresh acquisitions, returns full before/after digests and preserves every input byte', () => {
    const { original, candidate } = pair();
    const bytes = canonicalJson([original, candidate]);
    const result = verify(original, candidate, EMPTY);
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', complete: false, activationAllowed: false });
    expect(result.recaptures).toEqual([{ table: CLAIMS, identity: canonicalJson([original.manifest.records[CLAIMS][0].tupleDigest]),
      kind: 'RECAPTURED', beforeDigest: sha256(canonicalJson(original.manifest.records[CLAIMS][0])),
      afterDigest: sha256(canonicalJson(candidate.manifest.records[CLAIMS][0])) }]);
    expect(canonicalJson([original, candidate])).toBe(bytes);
    expect(original.manifest.sourceFingerprint).toBe(candidate.manifest.sourceFingerprint);
    expect(() => verifyLocalFullCategoryDeltaCoverage(original.manifest.records, candidate.manifest.records, EMPTY)).toThrow();
    expect(() => verifyLocalMutableCategoryDeltaCoverage(original.manifest.records, candidate.manifest.records, EMPTY)).toThrow();
  });
  it('does not manufacture recaptures when only Sheets acquisition metadata changes', () => {
    const { original, candidate } = pair();
    const sheetsOnly = generation(original.acquisition.redis, candidate.acquisition.sheets);
    expect(verify(original, sheetsOnly, EMPTY).recaptures).toEqual([]);
  });
  it('accepts unrelated captured tombstone addition without treating sourceFingerprint as identity', () => {
    const { original, candidate } = pair();
    const next = generation(finalizeRedisSnapshot({ ...candidate.acquisition.redis, v1Tombstones: [{
      tupleDigest: sha256('new historical tombstone'), ownerDigest: sha256('old owner'), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }] }));
    expect(next.manifest.sourceFingerprint).not.toBe(original.manifest.sourceFingerprint);
    const row = next.manifest.records.padlet_claim_digest_tombstones[0];
    const plan = { ...EMPTY, changes: [{ table: 'padlet_claim_digest_tombstones', identity: canonicalJson([row.tupleDigest]),
      kind: 'ADDED' as const, beforeDigest: null, afterDigest: sha256(canonicalJson(row)) }] };
    expect(verify(original, next, plan).recaptures).toHaveLength(1);
  });
  it.each(['operation-owner', 'board', 'post', 'author', 'evidence-time', 'task', 'student', 'cycle'] as const)(
    'refuses captured business change %s even under an empty nominal plan', change => {
      const { original, candidate } = pair();
      const op = structuredClone(candidate.acquisition.redis.operationBindings[0]);
      const binding = { ...op.binding, evidence: { ...op.binding.evidence } };
      if (change === 'board') binding.evidence.evidenceBoardId = 'abcdefghijklmnop';
      if (change === 'post') binding.evidence.evidencePostId = 'changed-post';
      if (change === 'author') binding.evidence.evidenceAuthorFullName = 'Different author';
      if (change === 'evidence-time') binding.evidence.evidenceCreatedAt = '2026-09-01T01:00:00.000Z';
      if (change === 'task') binding.taskId = 'different-task';
      if (change === 'student') binding.studentId = 'different-student';
      if (change === 'cycle') binding.cycleStartsAt = '2026-09-02T00:00:00.000Z';
      const next = generation(finalizeRedisSnapshot({ ...candidate.acquisition.redis, operationBindings: [
        { ...op, operationId: change === 'operation-owner' ? 'different-operation' : op.operationId, binding }] }));
      expect(() => verify(original, next, EMPTY)).toThrow(REFUSAL);
    });
  it.each(['source-type', 'source-digest', 'source-multiplicity', 'mapping-multiplicity', 'mapping-target', 'provenance-digest', 'business', 'omitted-claim'] as const)(
    'rejects rehashed but uncaptured %s substitutions, preserving typed contributors', change => {
      const { original, candidate } = pair();
      const forged = JSON.parse(JSON.stringify(candidate)) as ReturnType<typeof generation>;
      const manifest = forged.manifest as unknown as { records: Record<string, Record<string, unknown>[]>;
        sourceRecords: Array<Record<string, unknown>>; mappings: Array<Record<string, unknown>> };
      const source = manifest.sourceRecords.find(row => row.targetTable === CLAIMS)!;
      const mapping = manifest.mappings.find(row => row.targetTable === CLAIMS)!;
      const pointer = source.source as Record<string, unknown>;
      if (change === 'source-type') pointer.kind = 'SHEET';
      if (change === 'source-digest') pointer.sourceDigest = sha256('substitution');
      if (change === 'source-multiplicity') manifest.sourceRecords.push(structuredClone(source));
      if (change === 'mapping-multiplicity') manifest.mappings.push(structuredClone(mapping));
      if (change === 'mapping-target') mapping.targetId = 'other';
      if (change === 'provenance-digest') (manifest.records[CLAIMS][0].provenances as Record<string, unknown>[])[0].artifactDigest = original.acquisition.redis.digest;
      if (change === 'business') manifest.records[CLAIMS][0].ownerDigest = sha256('owner');
      if (change === 'omitted-claim') manifest.records[CLAIMS] = [];
      expect(() => verify(original, rehash(forged), EMPTY)).toThrow(REFUSAL);
    });
  it.each(['tenant', 'job', 'spreadsheet', 'original-capture', 'candidate-capture', 'swap-manifest'] as const)(
    'refuses %s binding mismatch', kind => {
      const { original, candidate } = pair();
      let a = original, b = candidate;
      if (kind === 'tenant') b = generation(candidate.acquisition.redis, candidate.acquisition.sheets, '20000000-0000-4000-8000-000000000002');
      if (kind === 'job') b = generation(candidate.acquisition.redis, candidate.acquisition.sheets, TENANT, '20000000-0000-4000-8000-000000000020');
      if (kind === 'spreadsheet') b = generation(candidate.acquisition.redis, finalizeSheetsSnapshot({ ...candidate.acquisition.sheets, spreadsheetId: 'other-sheet' }));
      if (kind === 'original-capture') a = { ...original, acquisition: candidate.acquisition };
      if (kind === 'candidate-capture') b = { ...candidate, acquisition: original.acquisition };
      if (kind === 'swap-manifest') b = { ...candidate, manifest: original.manifest };
      expect(() => verify(a, b, EMPTY)).toThrow(REFUSAL);
    });
  it('refuses captured claim removal and unsupported BANK/Sheet contributor scope', () => {
    const { original, candidate } = pair();
    const removed = generation(finalizeRedisSnapshot({ ...candidate.acquisition.redis, operationBindings: [] }));
    expect(() => verify(original, removed, EMPTY)).toThrow(REFUSAL);
    const bank = generation(candidate.acquisition.redis, makeSheets());
    expect(() => verify(original, bank, EMPTY)).toThrow(REFUSAL);
  });
  it.each(['claim-mutation', 'claim-duplicate', 'extra-field', 'blocked', 'missing-mutable'] as const)(
    'rejects %s plan rather than using recapture as an accounting escape', kind => {
      const { original, candidate } = pair();
      const row = candidate.manifest.records[CLAIMS][0];
      const change = { table: CLAIMS, identity: canonicalJson([row.tupleDigest]), kind: 'MUTATED' as const,
        beforeDigest: sha256(canonicalJson(original.manifest.records[CLAIMS][0])), afterDigest: sha256(canonicalJson(row)) };
      if (kind === 'missing-mutable') {
        const sheets = structuredClone(candidate.acquisition.sheets);
        (sheets.tabs.Products.rows[0].cells as string[])[1] = 'New product name';
        expect(() => verify(original, generation(candidate.acquisition.redis, finalizeSheetsSnapshot(sheets)), EMPTY)).toThrow(REFUSAL);
      } else {
        const plan = kind === 'extra-field' ? { ...EMPTY, ignored: true }
          : kind === 'blocked' ? { ...EMPTY, blockers: ['not-allowed'] }
          : { ...EMPTY, changes: kind === 'claim-duplicate' ? [change, change] : [change] };
        expect(() => verify(original, candidate, plan)).toThrow(REFUSAL);
      }
    });
  it('refuses accessors and proxies without executing caller code', () => {
    const { original, candidate } = pair(); let reads = 0;
    const hostile = { ...candidate };
    Object.defineProperty(hostile, 'manifest', { enumerable: true, get: () => { reads++; return candidate.manifest; } });
    expect(() => verify(original, hostile, EMPTY)).toThrow(REFUSAL);
    expect(() => verify(original, new Proxy(candidate, { get: () => { reads++; throw new Error('trap'); } }), EMPTY)).toThrow(REFUSAL);
    const nested = { ...candidate, acquisition: { ...candidate.acquisition,
      redis: new Proxy(candidate.acquisition.redis, { getPrototypeOf: () => { reads++; throw new Error('trap'); } }) } };
    expect(() => verify(original, nested, EMPTY)).toThrow(REFUSAL);
    const arrayProxy = { ...EMPTY, changes: new Proxy([], { ownKeys: () => { reads++; throw new Error('trap'); } }) };
    expect(() => verify(original, candidate, arrayProxy)).toThrow(REFUSAL);
    expect(reads).toBe(0);
  });
});
