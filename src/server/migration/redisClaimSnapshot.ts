import { createHash } from 'node:crypto';
import { deepFreeze } from './sensitiveRedaction';

const V2_HASH_KEY = 'padlet:evidence-bindings:v2';
const V1_PREFIX = 'padlet:evidence-claim:v1:';
const V2_PROVENANCE = 'upstash:padlet:evidence-bindings:v2' as const;
const HEX_64 = /^[a-f0-9]{64}$/;
const MAX_STRING = 2_048;

export interface LegacyRedisSnapshotReader {
  hscan(key: string, cursor: string, count: number): Promise<Readonly<{ cursor: string; entries: readonly (readonly [string, string])[] }>>;
  scan(cursor: string, match: string, count: number): Promise<Readonly<{ cursor: string; keys: readonly string[] }>>;
  get(key: string): Promise<string | null>;
  getRevision(): Promise<string>;
}

export type LegacyV2Claim = Readonly<{
  tupleDigest: string; boardId: string; postId: string; ownerDigest: string; operationId: string;
  sourceProvenance: typeof V2_PROVENANCE;
}>;
export type LegacyOperationBinding = Readonly<{
  operationId: string; tupleDigest: string; ownerDigest: string; payloadHash: string;
  binding: PadletOperationBinding; claimField: string;
  sourceProvenance: typeof V2_PROVENANCE;
}>;
export type LegacyV1Tombstone = Readonly<{
  tupleDigest: string; ownerDigest: string; sourceProvenance: 'upstash:padlet:evidence-claim:v1';
}>;
export type RedisClaimSnapshot = Readonly<{
  snapshotVersion: 1; capturedAt: string; sourceRevision: string;
  v2Claims: readonly LegacyV2Claim[];
  operationBindings: readonly LegacyOperationBinding[];
  v1Tombstones: readonly LegacyV1Tombstone[];
  orphanedClaimDigests: readonly string[];
  digest: string;
}>;

type PadletEvidence = Readonly<{
  evidenceProvider: 'PADLET'; evidenceBoardId: string; evidencePostId: string;
  evidenceCreatedAt: string; evidenceAuthorFullName: string;
}>;
type PadletOperationBinding = Readonly<{
  taskId: string; studentId: string; cycleStartsAt: string; evidence: PadletEvidence;
}>;
type ParsedOperationRecord = Readonly<{ binding: PadletOperationBinding; claimField: string }>;

export async function captureRedisClaimSnapshot(reader: LegacyRedisSnapshotReader, options: Readonly<{
  capturedAt: string; maxPages?: number; maxRecords?: number; pageSize?: number;
}>): Promise<RedisClaimSnapshot> {
  assertCanonicalInstant(options.capturedAt);
  const maxPages = boundedPositive(options.maxPages ?? 10_000, 10_000, 'page limit');
  const maxRecords = boundedPositive(options.maxRecords ?? 100_000, 100_000, 'record limit');
  const pageSize = boundedPositive(options.pageSize ?? 500, 1_000, 'page size');
  const before = await reader.getRevision();
  assertText(before, 'revision');

  const hashEntries = await collectHash(reader, maxPages, maxRecords, pageSize);
  const rawClaims = new Map<string, string>();
  const rawOperations: Array<readonly [string, string]> = [];
  const operationClaims = new Map<string, string>();

  for (const [field, value] of hashEntries) {
    assertText(field, 'Redis field');
    assertText(value, 'Redis value', 32_768);
    if (field.startsWith('claim:')) {
      const tupleDigest = field.slice('claim:'.length);
      if (!HEX_64.test(tupleDigest) || !isCanonicalInternalId(value)) {
        throw new Error('Unsupported Redis claim shape.');
      }
      const priorOwner = rawClaims.get(tupleDigest);
      if (priorOwner !== undefined && priorOwner !== value) {
        throw new Error('Conflicting Redis claim owners.');
      }
      const priorTuple = operationClaims.get(value);
      if (priorTuple !== undefined && priorTuple !== tupleDigest) {
        throw new Error('Conflicting Redis operation claims.');
      }
      rawClaims.set(tupleDigest, value);
      operationClaims.set(value, tupleDigest);
    } else if (field.startsWith('op:')) {
      const operationDigest = field.slice('op:'.length);
      if (!HEX_64.test(operationDigest)) throw new Error('Unsupported Redis operation field.');
      rawOperations.push([operationDigest, value]);
    } else {
      throw new Error('Unsupported Redis registry field.');
    }
  }

  const claims = new Map<string, LegacyV2Claim>();
  const bindings = new Map<string, LegacyOperationBinding>();
  const canonicalTupleOwners = new Map<string, string>();
  const serializedOperations = new Map<string, string>();
  for (const [operationDigest, serialized] of rawOperations) {
    const record = parseOperationRecord(serialized);
    const tupleDigest = record.claimField.slice('claim:'.length);
    const operationId = rawClaims.get(tupleDigest);
    if (operationId === undefined) throw new Error('Conflicting Redis claim and operation binding.');
    const ownerDigest = digest(operationId);
    if (operationDigest !== ownerDigest) throw new Error('Conflicting Redis operation digest.');

    const { evidence } = record.binding;
    const expectedTupleDigest = tupleHash(evidence.evidenceBoardId, evidence.evidencePostId);
    if (tupleDigest !== expectedTupleDigest) throw new Error('Conflicting Redis evidence tuple digest.');

    const tupleKey = canonicalJson([evidence.evidenceBoardId, evidence.evidencePostId]);
    const priorCanonicalOwner = canonicalTupleOwners.get(tupleKey);
    if (priorCanonicalOwner !== undefined && priorCanonicalOwner !== ownerDigest) {
      throw new Error('Conflicting Redis canonical tuple owners.');
    }
    const priorSerialized = serializedOperations.get(operationId);
    if (priorSerialized !== undefined && priorSerialized !== canonicalJson(record)) {
      throw new Error('Conflicting Redis operation binding.');
    }
    const priorBinding = bindings.get(operationId);
    if (priorBinding !== undefined && priorBinding.tupleDigest !== tupleDigest) {
      throw new Error('Conflicting Redis operation tuples.');
    }

    canonicalTupleOwners.set(tupleKey, ownerDigest);
    serializedOperations.set(operationId, canonicalJson(record));
    claims.set(tupleDigest, {
      tupleDigest,
      boardId: evidence.evidenceBoardId,
      postId: evidence.evidencePostId,
      ownerDigest,
      operationId,
      sourceProvenance: V2_PROVENANCE,
    });
    bindings.set(operationId, {
      operationId,
      tupleDigest,
      ownerDigest,
      payloadHash: `sha256:${digest(canonicalJson(record.binding))}`,
      binding: record.binding,
      claimField: record.claimField,
      sourceProvenance: V2_PROVENANCE,
    });
  }

  const orphanedClaimDigests = [...rawClaims.keys()].filter((tupleDigest) => !claims.has(tupleDigest));
  const remainingRecords = maxRecords - hashEntries.length;
  const v1Keys = await collectKeys(reader, maxPages, remainingRecords, pageSize);
  const v1Tombstones: LegacyV1Tombstone[] = [];
  const seenV1 = new Set<string>();
  for (const key of v1Keys) {
    if (!key.startsWith(V1_PREFIX)) throw new Error('Unsupported Redis v1 key shape.');
    const tupleDigest = key.slice(V1_PREFIX.length);
    if (!HEX_64.test(tupleDigest) || seenV1.has(tupleDigest)) throw new Error('Conflicting or unsupported Redis v1 claim.');
    if (rawClaims.has(tupleDigest)) throw new Error('Conflicting Redis v1 and v2 claims.');
    seenV1.add(tupleDigest);
    const owner = await reader.get(key);
    if (typeof owner !== 'string' || !owner || owner.length > 32_768) throw new Error('Unsupported Redis v1 claim owner shape.');
    v1Tombstones.push({
      tupleDigest,
      ownerDigest: digest(owner),
      sourceProvenance: 'upstash:padlet:evidence-claim:v1',
    });
  }
  const after = await reader.getRevision();
  if (before !== after) throw new Error('Redis source changed during snapshot capture.');

  const v2Claims = [...claims.values()].sort((a, b) => compareCodeUnits(a.tupleDigest, b.tupleDigest));
  const operationBindings = [...bindings.values()].sort((a, b) => compareCodeUnits(a.operationId, b.operationId));
  v1Tombstones.sort((a, b) => compareCodeUnits(a.tupleDigest, b.tupleDigest));
  orphanedClaimDigests.sort(compareCodeUnits);
  const artifact = { snapshotVersion: 1 as const, capturedAt: options.capturedAt, sourceRevision: before,
    v2Claims, operationBindings, v1Tombstones, orphanedClaimDigests };
  return deepFreeze({ ...artifact, digest: digest(canonicalJson(artifact)) });
}

async function collectHash(reader: LegacyRedisSnapshotReader, maxPages: number, maxRecords: number, pageSize: number) {
  const result: Array<readonly [string, string]> = [];
  let cursor = '0';
  const seen = new Set<string>(['0']);
  for (let page = 0; page < maxPages; page += 1) {
    const response = await reader.hscan(V2_HASH_KEY, cursor, pageSize);
    if (!isCursor(response?.cursor) || !Array.isArray(response.entries)
      || response.entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || entry.some((value) => typeof value !== 'string'))) {
      throw new Error('Redis hash page is missing or malformed.');
    }
    result.push(...response.entries);
    if (result.length > maxRecords) throw new Error('Redis snapshot exceeds record limit.');
    if (response.cursor === '0') return result;
    if (seen.has(response.cursor)) throw new Error('Redis hash pagination cursor cycle detected.');
    seen.add(response.cursor);
    cursor = response.cursor;
  }
  throw new Error('Redis hash pagination did not complete within the page limit.');
}

async function collectKeys(reader: LegacyRedisSnapshotReader, maxPages: number, maxRecords: number, pageSize: number) {
  const result: string[] = [];
  let cursor = '0';
  const seen = new Set<string>(['0']);
  for (let page = 0; page < maxPages; page += 1) {
    const response = await reader.scan(cursor, `${V1_PREFIX}*`, pageSize);
    if (!isCursor(response?.cursor) || !Array.isArray(response.keys) || response.keys.some((key) => typeof key !== 'string')) {
      throw new Error('Redis key page is missing or malformed.');
    }
    result.push(...response.keys);
    if (result.length > maxRecords) throw new Error('Redis snapshot exceeds record limit.');
    if (response.cursor === '0') return result;
    if (seen.has(response.cursor)) throw new Error('Redis key pagination cursor cycle detected.');
    seen.add(response.cursor);
    cursor = response.cursor;
  }
  throw new Error('Redis key pagination did not complete within the page limit.');
}

function parseOperationRecord(serialized: string): ParsedOperationRecord {
  const parsed = parseObject(serialized);
  assertExactKeys(parsed, ['binding', 'claimField'], 'operation record');
  if (typeof parsed.claimField !== 'string' || !/^claim:[a-f0-9]{64}$/.test(parsed.claimField)) {
    throw new Error('Unsupported Redis operation claim field shape.');
  }
  return { binding: parseBinding(parsed.binding), claimField: parsed.claimField };
}

function parseBinding(value: unknown): PadletOperationBinding {
  if (!isRecord(value)) throw new Error('Unsupported Redis operation binding shape.');
  assertExactKeys(value, ['taskId', 'studentId', 'cycleStartsAt', 'evidence'], 'operation binding');
  if (!isCanonicalInternalId(value.taskId) || !isCanonicalInternalId(value.studentId)
    || !isCanonicalInstant(value.cycleStartsAt) || !isRecord(value.evidence)) {
    throw new Error('Unsupported Redis operation binding shape.');
  }
  const evidence = value.evidence;
  assertExactKeys(evidence, [
    'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName',
  ], 'operation evidence');
  if (evidence.evidenceProvider !== 'PADLET'
    || typeof evidence.evidenceBoardId !== 'string' || !/^[A-Za-z0-9]{16,22}$/.test(evidence.evidenceBoardId)
    || typeof evidence.evidencePostId !== 'string' || !isCanonicalPadletPostId(evidence.evidencePostId)
    || !isCanonicalInstant(evidence.evidenceCreatedAt)
    || typeof evidence.evidenceAuthorFullName !== 'string'
    || evidence.evidenceAuthorFullName !== evidence.evidenceAuthorFullName.trim()
    || evidence.evidenceAuthorFullName.length < 1 || evidence.evidenceAuthorFullName.length > 200) {
    throw new Error('Unsupported Redis operation evidence shape.');
  }
  return {
    taskId: value.taskId,
    studentId: value.studentId,
    cycleStartsAt: value.cycleStartsAt,
    evidence: {
      evidenceProvider: 'PADLET',
      evidenceBoardId: evidence.evidenceBoardId,
      evidencePostId: evidence.evidencePostId,
      evidenceCreatedAt: evidence.evidenceCreatedAt,
      evidenceAuthorFullName: evidence.evidenceAuthorFullName,
    },
  };
}

function parseObject(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); if (isRecord(parsed)) return parsed; } catch { /* safe error below */ }
  throw new Error('Unsupported Redis registry value shape.');
}
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Unsupported Redis ${label} shape.`);
  }
}
function digest(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function tupleHash(boardId: string, postId: string) { return createHash('sha256').update(boardId, 'utf8').update('\0').update(postId, 'utf8').digest('hex'); }
function isCanonicalPadletPostId(value: string) { return value.length >= 3 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value); }
function isCanonicalInternalId(value: unknown): value is string { return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 128; }
function assertText(value: unknown, label: string, max = MAX_STRING): asserts value is string { if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Invalid ${label}.`); }
function isCursor(value: unknown): value is string { return typeof value === 'string' && /^\d+$/.test(value) && value.length <= 32; }
function boundedPositive(value: number, max: number, label: string) { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${label}.`); return value; }
function assertCanonicalInstant(value: string) { if (!isCanonicalInstant(value)) throw new Error('Invalid capture time.'); }
function isCanonicalInstant(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false; const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function compareCodeUnits(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function canonicalJson(value: unknown): string { if (value === null || ['string','boolean','number'].includes(typeof value)) return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (isRecord(value)) return `{${Object.entries(value).sort(([a],[b]) => compareCodeUnits(a, b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`; throw new Error('Invalid canonical value.'); }
