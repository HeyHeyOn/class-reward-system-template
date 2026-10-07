import 'server-only';
import { types } from 'node:util';
import type { SheetsSnapshot } from './sheetsSnapshot';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import type { LegacyNormalizationManifest } from './manifest';
import type { NormalizedSourceRecord, SourcePointer } from './normalize';
import { assertManifestInputShape, assertNormalizationInput, canonicalJson, isHexDigest, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Capture = Readonly<{ tenantId: string; migrationJobId: string; sheets: SheetsSnapshot; redis?: RedisClaimSnapshot }>;
export type CapturedSourceCoverageInput = Readonly<{ capture: Capture; manifest: LegacyNormalizationManifest }>;
type Presence = 'PRESENT_NONEMPTY' | 'PRESENT_EMPTY' | 'ABSENT_IN_CAPTURE' | 'NOT_OBSERVED';
type Family = {
  kind: 'SHEET' | 'REDIS'; family: string; familyDigest: string; presence: Presence;
  review: 'KNOWN_FAMILY' | 'UNREVIEWED_FAMILY'; expectedSourceUnits: number | null;
  referencedSourceUnits: number; sourceRecordReferences: number;
  quarantinedReferences: number; warningReferences: number;
};
type Unit = { family: string; familyDigest: string; pointerDigest: string;
  sourceRecordReferences: number; quarantinedReferences: number; warningReferences: number };
type Diagnostic = Readonly<{ code: 'MISSING_CAPTURE_SOURCE' | 'UNEXPECTED_SOURCE_POINTER' | 'REDIS_NOT_OBSERVED' | 'NORMALIZATION_BLOCKED'; referenceDigest?: string }>;
const REQUIRED = ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks'];
const OPTIONAL = ['TaskAssignments', 'TaskCompletions', 'Promotions', 'PromotionProducts'];
const SHEET_NAMES = new Set([...REQUIRED, ...OPTIONAL]);
const REDIS_FAMILIES = [
  ['v2Claims', 'REDIS_V2_CLAIMS'], ['operationBindings', 'REDIS_OPERATION_BINDINGS'],
  ['v1Tombstones', 'REDIS_V1_TOMBSTONES'], ['orphanedClaimDigests', 'REDIS_ORPHANED_CLAIMS'],
] as const;
const MAX_UNITS = 4_000;
const MAX_REFERENCES = 4_000;
const MAX_DIAGNOSTICS = 128;
const MAX_NODES = 100_000;
const MAX_TEXT_BYTES = 1_000_000;
const MAX_STRING = 8_192;
const MAX_ARRAY = 4_096;
const MAX_KEYS = 256;
const MAX_DEPTH = 24;
const MANIFEST_KEYS = ['manifestVersion', 'status', 'tenantId', 'migrationJobId', 'sourceFingerprint', 'sourceArtifacts',
  'metadata', 'records', 'sourceRecords', 'mappings', 'warnings', 'blockingConflicts', 'quarantines', 'manifestDigest'];

/** Pure local accounting of a SINGLE sanitized capture's source pointers.
 * The denominator comes from capture tabs/rows and four Redis source arrays,
 * NEVER from normalized tables, plan changes, mappings or a second candidate.
 * Content digests bind supplied data, not its origin/authenticity or business
 * meaning. No normalizer/importer/DB/writer is called; no stage integration.
 *
 * Local admission ceilings: 100k visited occurrences, 1MB key/string UTF-8,
 * 8192 UTF-16 units/string, 4096 array elements, 256 object keys, depth 24,
 * 4000 source units and 4000 source-record references. These deliberately may
 * refuse otherwise valid larger captures/manifests. Aliases are charged on each
 * occurrence; cycles/accessors/proxies/symbols/non-JSON prototypes are refused.
 * Native ownKeys allocation precedes the key-count check: this is an in-process
 * diagnostic, NOT a streaming ingress or full BudgetContext allocation proof.
 * Canonical encoding scratch is bounded by admitted graph/text, including JSON
 * escaping. Output is limited to units/families and 128 diagnostics with an exact
 * omitted count. No caller-controlled source text or credential hash is returned.
 *
 * Multiple references to one Sheet unit can be real base/derived fan-out. Their
 * counts are observations, not contributor-multiset or canonical-target proof.
 */
export function verifyLocalCapturedSourceCoverage(raw: unknown) {
  admit(raw);
  if (!record(raw) || !exact(raw, ['capture', 'manifest'])) refuse('input');
  const value = raw as unknown as CapturedSourceCoverageInput;
  try {
    assertNormalizationInput(value.capture);
    assertManifestInputShape(value.capture);
  } catch { refuse('input'); }
  const { capture, manifest } = value;
  assertManifest(manifest, capture);
  const families: Family[] = [];
  const units = new Map<string, { unit: Unit; family: Family }>();
  const diagnostics: Diagnostic[] = [];
  const addFamily = (kind: Family['kind'], name: string, label: string, presence: Presence, count: number | null, known: boolean) => {
    const family: Family = { kind, family: label, familyDigest: sha256(name), presence,
      review: known ? 'KNOWN_FAMILY' : 'UNREVIEWED_FAMILY', expectedSourceUnits: count,
      referencedSourceUnits: 0, sourceRecordReferences: 0, quarantinedReferences: 0, warningReferences: 0 };
    families.push(family); return family;
  };
  const addUnit = (source: SourcePointer, family: Family) => {
    if (units.size >= MAX_UNITS) refuse('limit');
    const key = canonicalJson(source);
    // A cross-family pointer collision cannot safely be assigned by inference.
    if (units.has(key)) refuse('binding');
    units.set(key, { family, unit: { family: family.family, familyDigest: family.familyDigest,
      pointerDigest: sha256(key), sourceRecordReferences: 0, quarantinedReferences: 0, warningReferences: 0 } });
  };
  const tabs = capture.sheets.tabs;
  for (const name of [...new Set([...REQUIRED, ...OPTIONAL, ...Object.keys(tabs)])].sort()) {
    const tab = Object.hasOwn(tabs, name) ? tabs[name] : undefined;
    const family = addFamily('SHEET', name, SHEET_NAMES.has(name) ? `SHEET:${name}` : 'SHEET:UNREVIEWED',
      !tab ? 'ABSENT_IN_CAPTURE' : tab.rows.length ? 'PRESENT_NONEMPTY' : 'PRESENT_EMPTY', tab?.rows.length ?? null, SHEET_NAMES.has(name));
    if (tab) for (const row of tab.rows) addUnit({ kind: 'SHEET', artifactDigest: capture.sheets.digest,
      tab: name, rowNumber: row.rowNumber, rowHash: row.hash }, family);
  }
  for (const [name, label] of REDIS_FAMILIES) {
    const redis = capture.redis;
    const rows = redis?.[name];
    const family = addFamily('REDIS', name, label, !rows ? 'NOT_OBSERVED'
      : rows.length ? 'PRESENT_NONEMPTY' : 'PRESENT_EMPTY', rows?.length ?? null, true);
    if (redis && rows) for (const row of rows) addUnit({ kind: 'REDIS', artifactDigest: redis.digest,
      provenance: typeof row === 'string' ? 'upstash:padlet:evidence-bindings:v2:orphan' : row.sourceProvenance,
      // Orphans hash the digest STRING, NOT its JSON-quoted representation.
      sourceDigest: sha256(typeof row === 'string' ? row : canonicalJson(row)) }, family);
  }
  let unexpectedSourceReferences = 0;
  for (const sourceRecord of manifest.sourceRecords) {
    const key = canonicalJson(sourceRecord.source);
    const match = units.get(key);
    if (!match) {
      unexpectedSourceReferences++;
      diagnostics.push({ code: 'UNEXPECTED_SOURCE_POINTER', referenceDigest: sha256(key) });
      continue;
    }
    const { unit, family } = match;
    if (unit.sourceRecordReferences === 0) family.referencedSourceUnits++;
    unit.sourceRecordReferences++; family.sourceRecordReferences++;
    if (sourceRecord.mappingStatus === 'QUARANTINED') { unit.quarantinedReferences++; family.quarantinedReferences++; }
    // Unknown columns may have a global header warning but no per-row warning.
    if (sourceRecord.warningCodes.length || sourceRecord.redactedSourceRecord.omittedFieldCount) {
      unit.warningReferences++; family.warningReferences++;
    }
  }
  let missingSourceUnits = 0;
  for (const { unit } of units.values()) if (!unit.sourceRecordReferences) {
    missingSourceUnits++;
    diagnostics.push({ code: 'MISSING_CAPTURE_SOURCE', referenceDigest: unit.pointerDigest });
  }
  if (!capture.redis) diagnostics.push({ code: 'REDIS_NOT_OBSERVED' });
  if (manifest.status === 'BLOCKED') diagnostics.push({ code: 'NORMALIZATION_BLOCKED' });
  const mismatch = missingSourceUnits > 0 || unexpectedSourceReferences > 0;
  diagnostics.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
  return deepFreeze({
    scope: 'CAPTURED_SOURCE_POINTER_ACCOUNTING_ONLY' as const,
    status: diagnostics.length ? 'BLOCKED' as const : 'CAPTURE_POINTERS_ACCOUNTED' as const,
    pointerAccounting: mismatch ? 'MISMATCH' as const : !capture.redis ? 'INCOMPLETE' as const : 'ACCOUNTED' as const,
    authority: 'NONAUTHORITY' as const, complete: false as const, activationAllowed: false as const,
    exclusion: 'NOT_PROVEN' as const, fullSourceReconciliation: 'NOT_PERFORMED' as const,
    fullTargetReconciliation: 'NOT_PERFORMED' as const, preRedactionInventory: 'NOT_OBSERVED' as const,
    canonicalBusinessValidation: 'NOT_PERFORMED' as const, contributorMultiplicityValidation: 'NOT_PERFORMED' as const,
    binding: 'CONTENT_DIGESTS_ONLY' as const, normalizationStatus: manifest.status,
    manifestDigest: manifest.manifestDigest, sheetsDigest: capture.sheets.digest, redisDigest: capture.redis?.digest ?? null,
    expectedSourceUnits: units.size, sourceRecordReferences: manifest.sourceRecords.length,
    missingSourceUnits, unexpectedSourceReferences, normalizationWarnings: manifest.warnings.length,
    families, units: [...units.values()].map(({ unit }) => unit).sort((a, b) => compare(a.pointerDigest, b.pointerDigest)),
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS), omittedDiagnostics: Math.max(0, diagnostics.length - MAX_DIAGNOSTICS),
  });
}

function assertManifest(manifest: LegacyNormalizationManifest, capture: Capture): void {
  if (!record(manifest) || !exact(manifest, MANIFEST_KEYS) || manifest.manifestVersion !== 1
    || !['READY_FOR_IMPORT', 'BLOCKED'].includes(manifest.status)
    || !isHexDigest(manifest.manifestDigest) || !isHexDigest(manifest.sourceFingerprint)
    || !record(manifest.metadata) || !exact(manifest.metadata, ['sheetSchemaVersion', 'classTimeZone'])
    || !text(manifest.metadata.classTimeZone) || !record(manifest.records)
    || !Object.values(manifest.records).every((rows) => Array.isArray(rows) && rows.every(record))
    || !Array.isArray(manifest.sourceRecords) || !Array.isArray(manifest.quarantines)
    || !Array.isArray(manifest.mappings) || !Array.isArray(manifest.warnings) || !Array.isArray(manifest.blockingConflicts)) refuse('input');
  if (manifest.sourceRecords.length > MAX_REFERENCES) refuse('limit');
  for (const r of [...manifest.sourceRecords, ...manifest.quarantines]) assertSourceRecord(r);
  for (const m of manifest.mappings) {
    if (!record(m) || !exact(m, ['sourceDigest', 'targetTable', 'targetId', 'status'])
      || !isHexDigest(m.sourceDigest) || !text(m.targetTable) || !text(m.targetId) || m.status !== 'STAGED') refuse('input');
  }
  for (const d of [...manifest.warnings, ...manifest.blockingConflicts]) {
    if (!record(d) || !exact(d, ['code', 'path', 'sourceDigest']) || !code(d.code) || !text(d.path) || !isHexDigest(d.sourceDigest)) refuse('input');
  }
  const blocked = manifest.blockingConflicts.length > 0 || manifest.quarantines.length > 0
    || manifest.sourceRecords.some((r) => r.mappingStatus === 'QUARANTINED');
  if ((manifest.status === 'BLOCKED') !== blocked) refuse('input');
  const artifacts = { sheets: { digest: capture.sheets.digest, spreadsheetIdDigest: sha256(capture.sheets.spreadsheetId),
    revisionDigest: sha256(capture.sheets.sourceRevision), credentialHashes: capture.sheets.credentialHashes },
  ...(capture.redis ? { redis: { digest: capture.redis.digest, revisionDigest: sha256(capture.redis.sourceRevision) } } : {}) };
  const { manifestDigest, ...body } = manifest;
  if (manifest.tenantId !== capture.tenantId || manifest.migrationJobId !== capture.migrationJobId
    || manifest.metadata.sheetSchemaVersion !== capture.sheets.schemaVersion
    || canonicalJson(manifest.sourceArtifacts) !== canonicalJson(artifacts)
    || manifestDigest !== sha256(canonicalJson(body))) refuse('binding');
}
function assertSourceRecord(r: NormalizedSourceRecord): void {
  if (!record(r) || !exact(r, ['source', 'redactedSourceRecord', 'canonicalRecord', 'mappingStatus', 'warningCodes', 'errorCodes'], ['targetTable', 'targetId'])
    || !record(r.redactedSourceRecord) || !exact(r.redactedSourceRecord, ['identityDigest', 'recognizedFieldCount', 'omittedFieldCount'])
    || !isHexDigest(r.redactedSourceRecord.identityDigest)
    || !count(r.redactedSourceRecord.recognizedFieldCount) || !count(r.redactedSourceRecord.omittedFieldCount)
    || (r.canonicalRecord !== null && !record(r.canonicalRecord))
    || !['STAGED', 'QUARANTINED'].includes(r.mappingStatus)
    || !Array.isArray(r.warningCodes) || !r.warningCodes.every(code)
    || !Array.isArray(r.errorCodes) || !r.errorCodes.every(code)
    || (r.mappingStatus === 'QUARANTINED') !== (r.errorCodes.length > 0)
    || Object.hasOwn(r, 'targetTable') !== Object.hasOwn(r, 'targetId')
    || (Object.hasOwn(r, 'targetTable') && (!text(r.targetTable) || !text(r.targetId) || r.mappingStatus === 'QUARANTINED'))) refuse('input');
  const s = r.source;
  if (!record(s) || !isHexDigest(s.artifactDigest)) refuse('input');
  if (s.kind === 'SHEET') {
    if (!exact(s, ['kind', 'artifactDigest', 'tab', 'rowNumber', 'rowHash']) || !text(s.tab, 200)
      || !Number.isSafeInteger(s.rowNumber) || s.rowNumber < 2 || !isHexDigest(s.rowHash)) refuse('input');
  } else if (s.kind === 'REDIS') {
    if (!exact(s, ['kind', 'artifactDigest', 'provenance', 'sourceDigest']) || !text(s.provenance)
      || !isHexDigest(s.sourceDigest)) refuse('input');
  } else refuse('input');
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function text(value: unknown, max = MAX_STRING): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function code(value: unknown): boolean { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function refuse(reason: 'input' | 'limit' | 'binding'): never { throw new Error(`Captured source pointer accounting ${reason} refused.`); }

// Descriptor-only JSON admission BEFORE semantic reads, sorting, cloning/hash
// work or diagnostics. Never invoke a getter, proxy trap or caller toJSON.
function admit(root: unknown): void {
  let nodes = 0, bytes = 0;
  const ancestors = new WeakSet<object>();
  const chargeText = (value: string) => {
    if (value.length > MAX_STRING) refuse('limit');
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_TEXT_BYTES) refuse('limit');
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES) refuse('limit');
    if (value !== null && typeof value === 'object' && ancestors.has(value)) refuse('input');
    if (depth > MAX_DEPTH) refuse('limit');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { chargeText(value); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) refuse('input'); return; }
    if (typeof value !== 'object' || types.isProxy(value)) refuse('input');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) refuse('input');
    if (array && value.length > MAX_ARRAY) refuse('limit');
    const keys = Reflect.ownKeys(value);
    if (!array && keys.length > MAX_KEYS) refuse('limit');
    if (array && keys.length !== value.length + 1) refuse('input');
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) refuse('input');
      chargeText(key);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) refuse('input');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) refuse('input');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(root, 0);
}
