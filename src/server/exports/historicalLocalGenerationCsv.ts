import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { PersistedLocalGenerationReadResult } from './readPersistedLocalGeneration';

type HistoricalDto = Extract<PersistedLocalGenerationReadResult, { kind: 'HISTORICAL_LOCAL_GENERATION' }>;
const SCHEMA = 'historical-local-generation-metadata-display/v1';
const PURPOSE = 'DISPLAY_ONLY';
const MAX_ID_BYTES = 1024;
const MAX_OUTPUT_BYTES = 16384;

export type HistoricalLocalGenerationCsv = Readonly<{
  format: 'CSV';
  schemaVersion: typeof SCHEMA;
  purpose: typeof PURPOSE;
  contentType: 'text/csv; charset=utf-8; header=present';
  /** One metadata DISPLAY row, never a business/source row count. */
  metadataRowCount: 1;
  /** Fresh caller-owned, unshared bytes. Mutation invalidates sha256. */
  bytes: Uint8Array;
  byteLength: number;
  /** Hash of CSV bytes only, not source authentication, retention or authority. */
  sha256: string;
}>;

function literal<T extends string | boolean>(expected: T) {
  return (value: unknown): value is T => value === expected;
}
function boundedText(value: unknown, maxBytes: number): value is string {
  // Reject oversized code-unit length before scanning/encoding arbitrary strings.
  return typeof value === 'string' && value.length <= maxBytes && Buffer.byteLength(value, 'utf8') <= maxBytes;
}
function opaqueId(value: unknown): value is string {
  // Same admission as the actual reader: literal opaque text, not URL/number/UUID.
  // Unicode mode admits valid surrogate pairs but refuses lone surrogates, whose
  // UTF-8 replacement would silently change IDs. No trim/normalize/decode/repair.
  return boundedText(value, MAX_ID_BYTES) && value.length > 0 && value.trim() === value
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(value);
}
function generationId(value: unknown): value is string {
  return boundedText(value, 86) && /^preparation:candidate:[a-f0-9]{64}$/.test(value);
}
function digest(value: unknown): value is string {
  return boundedText(value, 64) && /^[a-f0-9]{64}$/.test(value);
}
function recordedVersion(value: unknown): value is string {
  return boundedText(value, 16) && /^[1-9][0-9]{0,15}$/.test(value) && !/[^0-9]/.test(value)
    && BigInt(value) <= BigInt('9007199254740991');
}

// Explicit wire order, independent of caller property order. The mapped type
// ties BOTH the complete key set and literal predicates to the real closed DTO;
// an upstream contract change must be reviewed, not silently spread into CSV.
const RULES = Object.freeze({
  kind: literal('HISTORICAL_LOCAL_GENERATION'),
  authority: literal('NONAUTHORITY'),
  readOnly: literal(true),
  scope: literal('HISTORICAL_ONLY'),
  phase: literal('LOCAL_CANDIDATE'),
  exclusion: literal('NOT_PROVEN'),
  originalSnapshotPhase: literal('PREFLIGHT'),
  verification: literal('PERSISTED_BINDING_ONLY'),
  payloadIntegrity: literal('NOT_VERIFIED'),
  currentFreshness: literal('NOT_VERIFIED'),
  currentPreflight: literal('NOT_EVALUATED'),
  operationalAuthority: literal('UNKNOWN'),
  cutoverAllowed: literal(false),
  activationAllowed: literal(false),
  jobId: opaqueId,
  generationId,
  originalSourceId: opaqueId,
  originalSnapshotId: opaqueId,
  candidateManifestDigest: digest,
  candidateSheetDigest: digest,
  recordedStateVersion: recordedVersion,
} satisfies { [K in keyof HistoricalDto]: (value: unknown) => value is HistoricalDto[K] });
const KEYS = Object.freeze(Object.keys(RULES) as (keyof HistoricalDto)[]);
const HEADER = ['schemaVersion', 'purpose', ...KEYS].map(key => `"${key}"`).join(',') + '\r\n';

function invalid(): never {
  // One sanitized failure, no raw input/key/exception, log, or partial CSV.
  throw new TypeError('Invalid historical local generation metadata display CSV input');
}
function closedValues(input: unknown): string[] {
  // Reject even revoked Proxies before ANY reflective operation. Never execute
  // getters, caller toString/toJSON, inherited authority or exotic prototypes.
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Reflect.ownKeys(input).length !== KEYS.length) invalid();
  return KEYS.map(key => {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) invalid();
    const value: unknown = field.value;
    if (!RULES[key](value)) invalid();
    return typeof value === 'string' ? value : value ? 'true' : 'false';
  });
}
function displayCell(value: string): string {
  // Every admitted value is nonempty. Quotes alone do not prevent formula
  // execution/precision loss; prefix even numeric/literal-apostrophe cells.
  return `"'${value.replace(/"/g, '""')}"`;
}

/**
 * Pure synchronous bounded in-memory METADATA DISPLAY serializer. UTF-8/no BOM,
 * fixed quoted 23-column header, exactly one metadata row, comma, doubled quotes,
 * CRLF including the final record. All data cells have an ASCII apostrophe.
 * All NONAUTHORITY/unknown/unverified/false flags remain IN the CSV body.
 *
 * Accepts unknown to validate the actual reader's closed successful DTO at the
 * runtime boundary. Refusal/error DTOs are failures, not successful empty files.
 * No reader execution, I/O, auth check, cache, environment, clock or randomness.
 * Same-shaped forgeries cannot be authenticated here: a trusted caller must use
 * a freshly authorized reader result, never treat the DTO as a bearer credential.
 *
 * DISPLAY PROTECTION IS NOT A ROUNDTRIP FORMAT. Consumers must import as text
 * and retain prefixes; safety across every Excel/Sheets importer is not promised.
 * Not full source export, authorized HTTP download, current authority, XLSX,
 * Sheets restore, immutable report, retained artifact, backup or delta recovery.
 * Allowed IDs/digests can still be sensitive: this allowlist is NOT content DLP.
 * No tenant/identity/payload/URL/diagnostics/retention/time fields are synthesized.
 *
 * Fixed fields and pre-escape input bounds cap intermediate text; final encoded
 * bytes must also fit 16384. No truncation, pagination, streams or cap overrides.
 * Own-key reflection cannot undo an already allocated huge caller object or
 * preempt synchronous JS work. This is not an untrusted HTTP admission boundary.
 */
export function buildHistoricalLocalGenerationCsv(input: unknown): HistoricalLocalGenerationCsv {
  const values = closedValues(input);
  const text = HEADER + [SCHEMA, PURPOSE, ...values].map(displayCell).join(',') + '\r\n';
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) invalid();
  // TextEncoder owns an exact-size backing store, not a Buffer pool containing
  // unrelated bytes that a caller might observe through .buffer.
  const bytes = new TextEncoder().encode(text);
  return { format: 'CSV', schemaVersion: SCHEMA, purpose: PURPOSE,
    contentType: 'text/csv; charset=utf-8; header=present', metadataRowCount: 1,
    bytes, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
