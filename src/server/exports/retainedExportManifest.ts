import 'server-only';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

/** Pure, private v1 descriptor contract, NOT a retained artifact or backup.
 * All IDs, versions, windows and digests are UNTRUSTED caller claims, not
 * authenticated tenant/job/generation/export bindings. No I/O or ambient config.
 *
 * v1: canonical lowercase UUIDs; positive safe-integer generation; bounded
 * ASCII schema/code tokens; CSV/JSON/XLSX format labels; lowercase SHA-256.
 * Format/version labels do not validate the payload's syntax or schema/code.
 * Exactly one SNAPSHOT(at), then zero or more ordered, nonempty DELTA(from,to]
 * windows. Each from equals the preceding end. Times are fixed-precision UTC
 * ISO strings, not clock/freshness/transaction evidence. Unique artifact IDs;
 * repeated digests are allowed (distinct windows may describe identical bytes).
 *
 * Outputs are detached, deeply frozen records/arrays with primitive leaves.
 * No storage locations, keys, credentials, signatures, auth, DB, retention,
 * restoration or cutover mechanism is accepted or implemented. Both claimed
 * metadata AND bytes can be forged consistently; matching them grants nothing.
 */
export type RetainedExportWindow =
  | Readonly<{ kind: 'SNAPSHOT'; at: string }>
  | Readonly<{ kind: 'DELTA'; fromExclusive: string; toInclusive: string }>;
export type RetainedExportArtifact = Readonly<{
  artifactId: string;
  format: 'CSV' | 'JSON' | 'XLSX';
  digest: Readonly<{ algorithm: 'SHA-256'; hex: string }>;
  byteLength: number;
  window: RetainedExportWindow;
}>;
export type RetainedExportManifest = Readonly<{
  manifestVersion: 1;
  purpose: 'RETAINED_EXPORT_DESCRIPTOR';
  tenantId: string;
  jobId: string;
  generation: number;
  exportId: string;
  exportSchemaVersion: string;
  producerCodeVersion: string;
  artifacts: readonly RetainedExportArtifact[];
}>;
const UNPROVEN = Object.freeze({
  authority: 'NONAUTHORITY', sourceAuthenticity: 'NOT_PROVEN',
  retention: 'NOT_PROVEN', coverage: 'NOT_PROVEN', restoreAllowed: false, cutoverAllowed: false,
} as const);
export type RetainedExportManifestCheck = Readonly<typeof UNPROVEN & {
  kind: 'STRUCTURE_ONLY'; manifest: RetainedExportManifest;
}>;

export const RETAINED_EXPORT_MANIFEST_LIMITS = Object.freeze({
  maxArtifacts: 32, maxArtifactBytes: 8_388_608, maxTotalArtifactBytes: 33_554_432,
  maxManifestBytes: 16_384, maxVersionBytes: 64,
});
const LIMITS = RETAINED_EXPORT_MANIFEST_LIMITS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_KEYS = ['manifestVersion', 'purpose', 'tenantId', 'jobId', 'generation', 'exportId',
  'exportSchemaVersion', 'producerCodeVersion', 'artifacts'];
function invalid(): never { throw new TypeError('Invalid retained export descriptor.'); }
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input)) return invalid();
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length) return invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function list(input: unknown): unknown[] {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !Array.isArray(input)
    || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 || input.length > LIMITS.maxArtifacts) return invalid();
  if (Reflect.ownKeys(input).length !== input.length + 1) return invalid();
  const copy: unknown[] = [];
  for (let i = 0; i < input.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor?.enumerable || !('value' in descriptor)) return invalid();
    copy.push(descriptor.value);
  }
  return copy;
}
function text(input: unknown, max: number, pattern: RegExp): string {
  // All admitted v1 text is ASCII: the code-unit bound is also a byte bound.
  // Exact full match prevents JS '$' from accepting a trailing line terminator.
  if (typeof input !== 'string' || input.length < 1 || input.length > max
    || pattern.exec(input)?.[0] !== input) return invalid();
  return input;
}
function id(input: unknown): string { return text(input, 36, UUID); }
function integer(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || Object.is(input, -0)
    || input < min || input > max) return invalid();
  return input;
}
function timestamp(input: unknown): string {
  const value = text(input, 24, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
  // Round-trip rejects normalized invalid dates (e.g. February 30), leap seconds
  // and timezone/precision aliases. No clock, freshness or source claim is made.
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return invalid();
  return value;
}
function exportWindow(input: unknown): RetainedExportWindow {
  if (!input || typeof input !== 'object' || types.isProxy(input)) return invalid();
  const kind = Object.getOwnPropertyDescriptor(input, 'kind');
  if (!kind || !('value' in kind)) return invalid();
  if (kind.value === 'SNAPSHOT') {
    const value = record(input, ['kind', 'at']);
    return Object.freeze({ kind: 'SNAPSHOT', at: timestamp(value.at) });
  }
  if (kind.value === 'DELTA') {
    const value = record(input, ['kind', 'fromExclusive', 'toInclusive']);
    const fromExclusive = timestamp(value.fromExclusive);
    const toInclusive = timestamp(value.toInclusive);
    if (fromExclusive >= toInclusive) return invalid();
    return Object.freeze({ kind: 'DELTA', fromExclusive, toInclusive });
  }
  return invalid();
}
function artifact(input: unknown): RetainedExportArtifact {
  const value = record(input, ['artifactId', 'format', 'digest', 'byteLength', 'window']);
  if (value.format !== 'CSV' && value.format !== 'JSON' && value.format !== 'XLSX') return invalid();
  const hash = record(value.digest, ['algorithm', 'hex']);
  if (hash.algorithm !== 'SHA-256') return invalid();
  return Object.freeze({ artifactId: id(value.artifactId), format: value.format,
    digest: Object.freeze({ algorithm: 'SHA-256', hex: text(hash.hex, 64, /^[0-9a-f]{64}$/) }),
    byteLength: integer(value.byteLength, 0, LIMITS.maxArtifactBytes),
    window: exportWindow(value.window),
  });
}

/** Shape only. The returned flags must not be consumed as an authorization or
 * activation capability. Nothing here looks up any tenant, job or generation. */
export function validateRetainedExportManifest(input: unknown): RetainedExportManifestCheck {
  try {
    const value = record(input, ROOT_KEYS);
    if (value.manifestVersion !== 1 || value.purpose !== 'RETAINED_EXPORT_DESCRIPTOR') return invalid();
    const manifest: RetainedExportManifest = Object.freeze({
      manifestVersion: 1, purpose: 'RETAINED_EXPORT_DESCRIPTOR',
      tenantId: id(value.tenantId), jobId: id(value.jobId),
      generation: integer(value.generation, 1, Number.MAX_SAFE_INTEGER), exportId: id(value.exportId),
      exportSchemaVersion: text(value.exportSchemaVersion, LIMITS.maxVersionBytes, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      producerCodeVersion: text(value.producerCodeVersion, LIMITS.maxVersionBytes, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      artifacts: Object.freeze(list(value.artifacts).map(artifact)),
    });
    const seen = new Set<string>();
    let end: string | undefined;
    let totalBytes = 0;
    for (const part of manifest.artifacts) {
      if (seen.has(part.artifactId)) return invalid();
      seen.add(part.artifactId);
      totalBytes += part.byteLength;
      if (totalBytes > LIMITS.maxTotalArtifactBytes) return invalid();
      if (end === undefined) {
        if (part.window.kind !== 'SNAPSHOT') return invalid();
        end = part.window.at;
      } else {
        if (part.window.kind !== 'DELTA' || part.window.fromExclusive !== end) return invalid();
        end = part.window.toInclusive;
      }
    }
    return Object.freeze({ kind: 'STRUCTURE_ONLY', ...UNPROVEN, manifest });
  } catch { return invalid(); }
}

export function serializeRetainedExportManifest(input: unknown): string {
  const wire = JSON.stringify(validateRetainedExportManifest(input).manifest);
  if (Buffer.byteLength(wire, 'utf8') > LIMITS.maxManifestBytes) return invalid();
  return wire;
}
/** Only the canonical ASCII JSON form emitted above is accepted, not arbitrary
 * JSON. Re-encoding equality rejects duplicate keys at EVERY level, alternate
 * escape/number spellings, reordered keys, BOM, whitespace and trailing bytes.
 * Object validation cannot detect duplicates already collapsed by a caller's
 * JSON parser; use this entry point for raw wire text. This is not a signature. */
export function parseRetainedExportManifest(input: unknown): RetainedExportManifestCheck {
  try {
    if (typeof input !== 'string' || input.length < 1 || input.length > LIMITS.maxManifestBytes
      || Buffer.byteLength(input, 'utf8') > LIMITS.maxManifestBytes) return invalid();
    const result = validateRetainedExportManifest(JSON.parse(input));
    if (JSON.stringify(result.manifest) !== input) return invalid();
    return result;
  } catch { return invalid(); }
}

const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const NATIVE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'byteLength')!.get!;
const NATIVE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'byteOffset')!.get!;
const NATIVE_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'buffer')!.get!;
const RESIZABLE = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function payloadView(input: unknown): Uint8Array {
  if (types.isProxy(input) || !types.isUint8Array(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return invalid();
  // No user getters, iterator, constructor/species or shadow byteLength. Check
  // the native bound before a view/hash; do not enumerate millions of indices.
  const length = NATIVE_LENGTH.call(input) as number;
  if (length > LIMITS.maxArtifactBytes) return invalid();
  const buffer: unknown = NATIVE_BUFFER.call(input);
  if (!types.isArrayBuffer(buffer) || RESIZABLE?.call(buffer)) return invalid();
  const offset = NATIVE_OFFSET.call(input) as number;
  // Excludes SharedArrayBuffer and resizable backing stores above. Detached
  // backing stores fail here, including detached zero-length views. Hashing is
  // synchronous; no caller hook/await interleaves with this borrowed byte view.
  return new Uint8Array(buffer, offset, length);
}

export type RetainedExportArtifactByteCheck = Readonly<typeof UNPROVEN & {
  kind: 'UNAUTHENTICATED_BYTES_MATCH'; artifactId: string; byteLength: number; sha256: string;
}>;
/** Relative consistency with one caller-supplied descriptor only. Not source
 * authentication, tenant/job/generation authority, payload syntax/schema or
 * complete-set/coverage verification. Does not read or retain any storage. */
export function checkRetainedExportArtifactBytes(
  input: unknown, artifactId: unknown, bytes: unknown,
): RetainedExportArtifactByteCheck {
  try {
    const manifest = validateRetainedExportManifest(input).manifest;
    const selectedId = id(artifactId);
    const part = manifest.artifacts.find(candidate => candidate.artifactId === selectedId);
    if (!part) return invalid();
    const view = payloadView(bytes);
    if (view.byteLength !== part.byteLength) return invalid();
    const sha256 = createHash('sha256').update(view).digest('hex');
    if (sha256 !== part.digest.hex) return invalid();
    return Object.freeze({ kind: 'UNAUTHENTICATED_BYTES_MATCH', ...UNPROVEN,
      artifactId: selectedId, byteLength: part.byteLength, sha256,
    });
  } catch { return invalid(); }
}
