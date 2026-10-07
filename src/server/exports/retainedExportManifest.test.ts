// @vitest-environment node
// Pure synthetic data only. No DB, auth, filesystem, storage, key, HTTP or clock.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkRetainedExportArtifactBytes, parseRetainedExportManifest, serializeRetainedExportManifest, validateRetainedExportManifest } from './retainedExportManifest';

vi.mock('server-only', () => ({}));
const network = vi.hoisted(() => {
  const fetch = vi.fn(() => { throw new Error('Network forbidden in pure manifest fixture'); });
  vi.stubGlobal('fetch', fetch);
  return fetch;
});
const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const EXPORT = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT = '44444444-4444-4444-8444-444444444444';
const DELTA = '55555555-5555-4555-8555-555555555555';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';
const payload = Buffer.from('synthetic snapshot\n', 'utf8');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  return {
    manifestVersion: 1, purpose: 'RETAINED_EXPORT_DESCRIPTOR',
    tenantId: TENANT, jobId: JOB, generation: 1, exportId: EXPORT,
    exportSchemaVersion: 'products-display-v1', producerCodeVersion: 'synthetic-v1',
    artifacts: [{
      artifactId: SNAPSHOT, format: 'CSV',
      digest: { algorithm: 'SHA-256', hex: digest(payload) }, byteLength: payload.byteLength,
      window: { kind: 'SNAPSHOT', at: T0 },
    }],
  };
}
const UNPROVEN = {
  authority: 'NONAUTHORITY', sourceAuthenticity: 'NOT_PROVEN',
  retention: 'NOT_PROVEN', coverage: 'NOT_PROVEN', restoreAllowed: false, cutoverAllowed: false,
};
beforeEach(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});
afterEach(() => {
  try {
    expect(network).not.toHaveBeenCalled();
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) expect(console[method]).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
afterAll(() => vi.unstubAllGlobals());

it('returns a detached, deeply immutable STRUCTURE_ONLY descriptor, never authority', async () => {
  const { validateRetainedExportManifest } = await import('./retainedExportManifest');
  const input = fixture();
  const result = validateRetainedExportManifest(input);
  expect(result).toEqual({ kind: 'STRUCTURE_ONLY', ...UNPROVEN, manifest: input });
  const original = JSON.stringify(result);
  for (const value of [result, result.manifest, result.manifest.artifacts,
    result.manifest.artifacts[0], result.manifest.artifacts[0].digest, result.manifest.artifacts[0].window]) {
    expect(Object.isFrozen(value)).toBe(true);
  }
  expect(Object.isFrozen(input)).toBe(false);
  expect(result.manifest).not.toBe(input);
  input.artifacts[0].digest.hex = 'a'.repeat(64);
  input.tenantId = JOB;
  input.artifacts[0].window.at = T2;
  expect(JSON.stringify(result)).toBe(original);
  expect(Reflect.set(result.manifest, 'tenantId', JOB)).toBe(false);
});

const ERROR = 'Invalid retained export descriptor.';
function refused(input: unknown) {
  expect(() => validateRetainedExportManifest(input)).toThrow(new TypeError(ERROR));
}
it.each([null, undefined, [], true, 1, 'input', {}, new Date(0)])('rejects non-record input %# with a fixed error', input => refused(input));
it.each(Object.keys(fixture()))('rejects missing root field %s', key => {
  const input: Record<string, unknown> = fixture();
  delete input[key];
  refused(input);
});
it.each([
  ['manifestVersion', 2], ['manifestVersion', '1'], ['purpose', 'BACKUP'],
  ['tenantId', TENANT.toUpperCase().replace('11111111', 'AAAAAAAA')],
  ['tenantId', `${TENANT}\n`], ['tenantId', ` ${TENANT}`], ['tenantId', 'tenant/name'],
  ['jobId', 'invalid'], ['exportId', null], ['generation', 0], ['generation', -1],
  ['generation', -0], ['generation', 1.5], ['generation', '1'], ['generation', Number.NaN],
  ['generation', Number.POSITIVE_INFINITY], ['generation', Number.MAX_SAFE_INTEGER + 1],
  ['exportSchemaVersion', ''], ['exportSchemaVersion', 'x'.repeat(65)],
  ['exportSchemaVersion', 'schema\n'], ['exportSchemaVersion', 'schema/v1'],
  ['exportSchemaVersion', '\uD800'], ['producerCodeVersion', '한글'],
  ['producerCodeVersion', { toString: () => 'claimed-v1' }], ['producerCodeVersion', '../key'],
])('rejects noncanonical root scalar %s (%#), never repairing it', (key, value) => {
  refused({ ...fixture(), [key as string]: value });
});
it.each(['authority', 'signature', 'storageUrl', 'keyId', 'credential', '__proto__', 'toJSON'])('rejects extra root field %s', key => {
  refused(Object.defineProperty(fixture(), key, { value: 'SYNTHETIC_PRIVATE', enumerable: true }));
});
it.each(['artifactId', 'format', 'digest', 'byteLength', 'window'])('rejects missing artifact field %s', key => {
  const input = fixture();
  delete (input.artifacts[0] as Record<string, unknown>)[key];
  refused(input);
});
it.each([
  ['artifactId', `${SNAPSHOT}/../key`], ['format', 'csv'], ['format', 'SHEETS'],
  ['format', 'ZIP'], ['format', 'CSV\n'], ['byteLength', -1], ['byteLength', -0],
  ['byteLength', 0.5], ['byteLength', '18'], ['byteLength', Number.NaN],
  ['byteLength', Number.POSITIVE_INFINITY], ['byteLength', 8_388_609],
  ['digest', { algorithm: 'MD5', hex: 'a'.repeat(64) }],
  ['digest', { algorithm: 'SHA-256', hex: 'A'.repeat(64) }],
  ['digest', { algorithm: 'SHA-256', hex: 'a'.repeat(63) }],
  ['digest', { algorithm: 'SHA-256', hex: 'g'.repeat(64) }],
  ['digest', { algorithm: 'SHA-256', hex: `${'a'.repeat(64)}\n` }],
  ['digest', { algorithm: 'SHA-256' }], ['digest', { algorithm: 'SHA-256', hex: 'a'.repeat(64), verified: true }],
])('rejects malformed artifact %s (%#)', (key, value) => {
  const input = fixture();
  Object.assign(input.artifacts[0], { [key as string]: value });
  refused(input);
});
it('rejects extra artifact fields rather than dropping them', () => {
  const input = fixture();
  Object.assign(input.artifacts[0], { filename: '../../SYNTHETIC_PRIVATE' });
  refused(input);
});
it.each(['CSV', 'JSON', 'XLSX'])('accepts only a descriptor of %s, without claiming its payload syntax', format => {
  const input = fixture();
  input.artifacts[0].format = format;
  expect(validateRetainedExportManifest(input)).toMatchObject({ kind: 'STRUCTURE_ONLY', ...UNPROVEN });
});

function chain(count = 3) {
  const at = (index: number) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
  return { ...fixture(), artifacts: Array.from({ length: count }, (_, index) => ({
    ...fixture().artifacts[0], artifactId: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`,
    window: (index === 0 ? { kind: 'SNAPSHOT', at: at(0) }
      : { kind: 'DELTA', fromExclusive: at(index - 1), toInclusive: at(index) }) as Record<string, unknown>,
  })) };
}
it('accepts one snapshot followed by ordered adjacent (from, to] delta claims, not coverage proof', () => {
  const input = chain();
  const result = validateRetainedExportManifest(input);
  expect(result).toEqual({ kind: 'STRUCTURE_ONLY', ...UNPROVEN, manifest: input });
  expect(Object.isFrozen(result.manifest.artifacts[1].window)).toBe(true);
});
it.each([
  '2026-02-30T00:00:00.000Z', '2025-02-29T00:00:00.000Z', '2026-01-01T24:00:00.000Z',
  '2026-01-01T00:00:60.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00',
  '2026-01-01t00:00:00.000z', `${T0}\n`, 'yesterday', 'x'.repeat(100_000),
])('rejects invalid/noncanonical snapshot timestamp %#', at => {
  const input = fixture();
  input.artifacts[0].window.at = at;
  refused(input);
});
it('admits a real leap day without consulting the current clock', () => {
  const input = fixture();
  input.artifacts[0].window.at = '2024-02-29T12:34:56.789Z';
  expect(validateRetainedExportManifest(input).manifest.artifacts[0].window).toEqual(input.artifacts[0].window);
});
it.each(['empty', 'delta first', 'second snapshot', 'gap', 'overlap', 'reverse', 'zero delta',
  'reordered', 'duplicate ID', 'duplicate entry', 'missing window field', 'extra window field',
  'unknown kind', 'invalid delta time'])('rejects window/identity chain defect: %s', defect => {
  const input = chain();
  if (defect === 'empty') input.artifacts = [];
  if (defect === 'delta first') input.artifacts.shift();
  if (defect === 'second snapshot') input.artifacts[1].window = { kind: 'SNAPSHOT', at: T1 };
  if (defect === 'gap') input.artifacts[1].window.fromExclusive = '2026-01-01T01:00:00.000Z';
  if (defect === 'overlap') input.artifacts[2].window.fromExclusive = T0;
  if (defect === 'reverse') input.artifacts[1].window.toInclusive = '2025-12-31T00:00:00.000Z';
  if (defect === 'zero delta') input.artifacts[1].window.toInclusive = T0;
  if (defect === 'reordered') input.artifacts.reverse();
  if (defect === 'duplicate ID') input.artifacts[1].artifactId = input.artifacts[0].artifactId;
  if (defect === 'duplicate entry') input.artifacts.push(input.artifacts[1]);
  if (defect === 'missing window field') delete input.artifacts[1].window.fromExclusive;
  if (defect === 'extra window field') input.artifacts[0].window.toInclusive = T1;
  if (defect === 'unknown kind') input.artifacts[0].window.kind = 'FULL_BACKUP';
  if (defect === 'invalid delta time') input.artifacts[1].window.toInclusive = '2026-02-30T00:00:00.000Z';
  refused(input);
});
it('refuses two snapshots even if IDs differ and no delta is present', () => {
  const input = fixture();
  input.artifacts.push({ ...input.artifacts[0], artifactId: DELTA });
  refused(input);
});
it('admits inclusive metadata/count/aggregate byte bounds and rejects one beyond', () => {
  const input = chain(32);
  input.exportSchemaVersion = 'a'.repeat(64);
  input.producerCodeVersion = 'b'.repeat(64);
  input.generation = Number.MAX_SAFE_INTEGER;
  input.artifacts.forEach((part, index) => { part.byteLength = index < 4 ? 8_388_608 : 0; });
  expect(validateRetainedExportManifest(input).manifest.artifacts).toHaveLength(32);
  input.artifacts[4].byteLength = 1;
  refused(input);
  refused(chain(33));
});
it('rejects enormous sparse arrays before inspecting element getters', () => {
  const trap = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE'); });
  const artifacts = new Array(4_294_967_295);
  Object.defineProperty(artifacts, '0', { get: trap });
  refused({ ...fixture(), artifacts });
  expect(trap).not.toHaveBeenCalled();
});

it('serializes a stable ASCII v1 wire form and parses a detached immutable result', async () => {
  const { serializeRetainedExportManifest, parseRetainedExportManifest } = await import('./retainedExportManifest');
  const input = fixture();
  const reverse = (value: object) => Object.fromEntries(Object.entries(value).reverse());
  const reordered = reverse({ ...input, artifacts: [reverse({ ...input.artifacts[0],
    digest: reverse(input.artifacts[0].digest), window: reverse(input.artifacts[0].window),
  })] });
  const expected = JSON.stringify(input);
  const first = serializeRetainedExportManifest(input);
  expect(first).toBe(expected);
  expect(serializeRetainedExportManifest(reordered)).toBe(expected);
  expect(Buffer.byteLength(first, 'utf8')).toBe(first.length);
  expect(first.endsWith('\n')).toBe(false);
  const parsed = parseRetainedExportManifest(first);
  expect(parsed).toEqual(validateRetainedExportManifest(input));
  expect(Object.isFrozen(parsed.manifest.artifacts[0].digest)).toBe(true);
  expect(serializeRetainedExportManifest(parsed.manifest)).toBe(first);
});

it.each(['root duplicate', 'escaped duplicate', 'artifact duplicate', 'digest duplicate', 'window duplicate',
  'space', 'newline', 'BOM', 'key order', 'number alias', 'escape alias', 'truncated', 'trailing',
  'extra field', 'huge', 'deep'])('rejects noncanonical/ambiguous wire encoding: %s', defect => {
  const good = serializeRetainedExportManifest(fixture());
  let wire = good;
  if (defect === 'root duplicate') wire = good.replace('{', '{"manifestVersion":1,');
  if (defect === 'escaped duplicate') wire = good.replace('{', `{"\\u0074enantId":"${TENANT}",`);
  if (defect === 'artifact duplicate') wire = good.replace('"format":"CSV"', '"format":"JSON","format":"CSV"');
  if (defect === 'digest duplicate') wire = good.replace('"algorithm":"SHA-256"', '"algorithm":"SHA-256","algorithm":"SHA-256"');
  if (defect === 'window duplicate') wire = good.replace('"kind":"SNAPSHOT"', '"kind":"SNAPSHOT","kind":"SNAPSHOT"');
  if (defect === 'space') wire = ` ${good}`;
  if (defect === 'newline') wire = `${good}\n`;
  if (defect === 'BOM') wire = `\uFEFF${good}`;
  if (defect === 'key order') wire = JSON.stringify(Object.fromEntries(Object.entries(fixture()).reverse()));
  if (defect === 'number alias') wire = good.replace('"generation":1', '"generation":1e0');
  if (defect === 'escape alias') wire = good.replace('SNAPSHOT', '\\u0053NAPSHOT');
  if (defect === 'truncated') wire = good.slice(0, -1);
  if (defect === 'trailing') wire = `${good}null`;
  if (defect === 'extra field') wire = good.replace('{', '{"trusted":true,');
  if (defect === 'huge') wire = good.padEnd(16_385, ' ');
  if (defect === 'deep') wire = `${'['.repeat(8000)}0${']'.repeat(8000)}`;
  expect(() => parseRetainedExportManifest(wire)).toThrow(new TypeError(ERROR));
});
it.each([null, undefined, new Uint8Array(), 1, true])('does not coerce non-string wire input %#', input => {
  expect(() => parseRetainedExportManifest(input)).toThrow(new TypeError(ERROR));
});
it('rejects oversized wire input before parsing and never invokes a caller toString', () => {
  const parse = vi.spyOn(JSON, 'parse');
  expect(() => parseRetainedExportManifest('x'.repeat(16_385))).toThrow(new TypeError(ERROR));
  expect(parse).not.toHaveBeenCalled();
  const toString = vi.fn(() => serializeRetainedExportManifest(fixture()));
  expect(() => parseRetainedExportManifest({ toString })).toThrow(new TypeError(ERROR));
  expect(toString).not.toHaveBeenCalled();
});

it.each(['root', 'artifacts', 'artifact', 'digest', 'window'])('rejects hidden/symbol/accessor fields at %s without executing getters', site => {
  for (const field of ['hidden', 'symbol', 'accessor']) {
    const input = fixture();
    const target: object = site === 'root' ? input : site === 'artifacts' ? input.artifacts
      : site === 'artifact' ? input.artifacts[0] : site === 'digest' ? input.artifacts[0].digest : input.artifacts[0].window;
    const getter = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE'); });
    const key = field === 'symbol' ? Symbol('extra') : field === 'accessor' ? Object.keys(target)[0] : 'extra';
    Object.defineProperty(target, key, field === 'accessor' ? { enumerable: true, get: getter } : { value: true });
    refused(input);
    expect(getter).not.toHaveBeenCalled();
  }
});
it.each(['root', 'artifacts', 'artifact', 'digest', 'window'])('rejects proxies at %s before any user trap', site => {
  const input = fixture();
  const trap = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE'); });
  const wrap = (value: object) => new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  if (site === 'root') refused(wrap(input));
  if (site === 'artifacts') refused({ ...input, artifacts: wrap(input.artifacts) });
  if (site === 'artifact') refused({ ...input, artifacts: [wrap(input.artifacts[0])] });
  if (site === 'digest') refused({ ...input, artifacts: [{ ...input.artifacts[0], digest: wrap(input.artifacts[0].digest) }] });
  if (site === 'window') refused({ ...input, artifacts: [{ ...input.artifacts[0], window: wrap(input.artifacts[0].window) }] });
  expect(trap).not.toHaveBeenCalled();
});
it('rejects revoked proxies, cyclic values, custom prototypes and holes without traversal', () => {
  const revoked = Proxy.revocable(fixture(), {}); revoked.revoke(); refused(revoked.proxy);
  const cycle = fixture(); Object.assign(cycle, { artifacts: [cycle] }); refused(cycle);
  refused(Object.assign(Object.create({ trusted: true }), fixture()));
  const sparse = new Array(2); sparse[1] = fixture().artifacts[0];
  refused({ ...fixture(), artifacts: sparse });
  const inherited = [fixture().artifacts[0]]; Object.setPrototypeOf(inherited, { 0: fixture().artifacts[0] });
  refused({ ...fixture(), artifacts: inherited });
});
it('accepts own data properties on null-prototype records and returns new frozen plain records', () => {
  const input = fixture();
  Object.setPrototypeOf(input, null);
  Object.setPrototypeOf(input.artifacts[0], null);
  Object.setPrototypeOf(input.artifacts[0].digest, null);
  Object.setPrototypeOf(input.artifacts[0].window, null);
  const result = validateRetainedExportManifest(input);
  expect(Object.getPrototypeOf(result.manifest)).toBe(Object.prototype);
  expect(result.manifest.artifacts[0]).not.toBe(input.artifacts[0]);
  expect(Object.isFrozen(result.manifest.artifacts[0])).toBe(true);
});

it('checks only the supplied artifact bytes against caller claims, returning no authenticity capability', async () => {
  const { checkRetainedExportArtifactBytes } = await import('./retainedExportManifest');
  const input = fixture();
  const bytes = new Uint8Array(payload);
  const result = checkRetainedExportArtifactBytes(input, SNAPSHOT, bytes);
  expect(result).toEqual({ kind: 'UNAUTHENTICATED_BYTES_MATCH', ...UNPROVEN,
    artifactId: SNAPSHOT, byteLength: bytes.byteLength, sha256: digest(bytes),
  });
  expect(Object.isFrozen(result)).toBe(true);
  bytes[0] ^= 1;
  expect(result.sha256).toBe(input.artifacts[0].digest.hex);
  expect(Object.keys(result)).not.toContain('bytes');
});

it.each(['bit flip', 'truncated', 'appended', 'false digest', 'false length', 'unknown ID', 'missing artifact'])('rejects inconsistent provided bytes: %s', defect => {
  const input = fixture();
  let bytes = Buffer.from(payload);
  let artifactId = SNAPSHOT;
  if (defect === 'bit flip') bytes[0] ^= 1;
  if (defect === 'truncated') bytes = bytes.subarray(1);
  if (defect === 'appended') bytes = Buffer.concat([bytes, Buffer.from('x')]);
  if (defect === 'false digest') input.artifacts[0].digest.hex = '0'.repeat(64);
  if (defect === 'false length') input.artifacts[0].byteLength++;
  if (defect === 'unknown ID') artifactId = DELTA;
  if (defect === 'missing artifact') input.artifacts = [];
  expect(() => checkRetainedExportArtifactBytes(input, artifactId, bytes)).toThrow(new TypeError(ERROR));
});
it.each([null, 'text', [1, 2], new Uint16Array(2), new ArrayBuffer(2), new DataView(new ArrayBuffer(2))])('rejects non-byte-view payload %# without coercion', bytes => {
  expect(() => checkRetainedExportArtifactBytes(fixture(), SNAPSHOT, bytes)).toThrow(new TypeError(ERROR));
});
it('checks the exact view range rather than the backing Buffer pool', () => {
  const backing = Buffer.concat([Buffer.from('ignored-prefix'), payload, Buffer.from('ignored-suffix')]);
  const view = backing.subarray(Buffer.byteLength('ignored-prefix'), Buffer.byteLength('ignored-prefix') + payload.byteLength);
  expect(checkRetainedExportArtifactBytes(fixture(), SNAPSHOT, view).sha256).toBe(digest(payload));
});
it.each([0, 8_388_608])('admits the inclusive payload bound %s without retaining mutable bytes', byteLength => {
  const bytes = new Uint8Array(byteLength);
  const input = fixture();
  input.artifacts[0].byteLength = bytes.byteLength;
  input.artifacts[0].digest.hex = digest(bytes);
  expect(checkRetainedExportArtifactBytes(input, SNAPSHOT, bytes).byteLength).toBe(byteLength);
});
it('rejects an oversized byte view even with a lying own byteLength property', () => {
  const bytes = new Uint8Array(8_388_609);
  Object.defineProperty(bytes, 'byteLength', { value: payload.byteLength });
  expect(() => checkRetainedExportArtifactBytes(fixture(), SNAPSHOT, bytes)).toThrow(new TypeError(ERROR));
});
it.each(['byteLength', 'byteOffset', 'buffer', 'constructor', Symbol.iterator])('uses native byte slots, not caller properties %#', key => {
  const bytes = new Uint8Array(payload);
  const getter = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE'); });
  Object.defineProperty(bytes, key, { get: getter });
  expect(checkRetainedExportArtifactBytes(fixture(), SNAPSHOT, bytes).sha256).toBe(digest(payload));
  expect(getter).not.toHaveBeenCalled();
});
it('rejects shared, resizable, detached and subclass payloads', () => {
  const shared = new Uint8Array(new SharedArrayBuffer(payload.byteLength)); shared.set(payload);
  const resizing = new ArrayBuffer(payload.byteLength, { maxByteLength: payload.byteLength + 1 });
  expect(resizing.resizable).toBe(true);
  const resizeView = new Uint8Array(resizing); resizeView.set(payload);
  class DerivedBytes extends Uint8Array {}
  for (const bytes of [shared, resizeView, new DerivedBytes(payload)]) {
    expect(() => checkRetainedExportArtifactBytes(fixture(), SNAPSHOT, bytes)).toThrow(new TypeError(ERROR));
  }
  const detached = new Uint8Array(0);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const empty = fixture(); empty.artifacts[0].byteLength = 0; empty.artifacts[0].digest.hex = digest(new Uint8Array());
  expect(() => checkRetainedExportArtifactBytes(empty, SNAPSHOT, detached)).toThrow(new TypeError(ERROR));
});
it('rejects payload proxies before user traps, and sanitizes exceptions', () => {
  const trap = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE'); });
  const bytes = new Proxy(new Uint8Array(payload), { get: trap, getPrototypeOf: trap });
  expect(() => checkRetainedExportArtifactBytes(fixture(), SNAPSHOT, bytes)).toThrow(new TypeError(ERROR));
  expect(trap).not.toHaveBeenCalled();
});
it('does not authenticate a self-consistent forgery of every binding and its digest', () => {
  const forged = fixture();
  const bytes = Buffer.from('not XLSX, not CSV, not a source-authenticated export');
  forged.tenantId = JOB; forged.jobId = TENANT; forged.exportId = DELTA; forged.generation = 7;
  forged.exportSchemaVersion = 'attacker-claimed-schema'; forged.producerCodeVersion = 'attacker-claimed-code';
  forged.artifacts[0].format = 'XLSX'; forged.artifacts[0].digest.hex = digest(bytes);
  forged.artifacts[0].byteLength = bytes.byteLength;
  expect(parseRetainedExportManifest(serializeRetainedExportManifest(forged))).toMatchObject({ kind: 'STRUCTURE_ONLY', ...UNPROVEN });
  const result = checkRetainedExportArtifactBytes(forged, SNAPSHOT, bytes);
  expect(result).toEqual({ kind: 'UNAUTHENTICATED_BYTES_MATCH', ...UNPROVEN,
    artifactId: SNAPSHOT, byteLength: bytes.byteLength, sha256: digest(bytes),
  });
  expect(Object.keys(result)).not.toContain('authenticated');
});
it('makes no full-set claim when only one of several artifacts was provided', () => {
  const input = chain();
  const one = checkRetainedExportArtifactBytes(input, input.artifacts[0].artifactId, payload);
  expect(one.coverage).toBe('NOT_PROVEN');
  expect(one.retention).toBe('NOT_PROVEN');
  // Equal payload digests in DISTINCT windows are allowed, not called an ID replay.
  expect(input.artifacts[0].digest).toEqual(input.artifacts[1].digest);
  expect(one.restoreAllowed).toBe(false);
});
it('enforces UTF-8 byte size before JSON parsing, not just character count', () => {
  const wire = `"${'가'.repeat(6000)}"`;
  expect(wire.length).toBeLessThan(16_384);
  expect(Buffer.byteLength(wire, 'utf8')).toBeGreaterThan(16_384);
  const parse = vi.spyOn(JSON, 'parse');
  expect(() => parseRetainedExportManifest(wire)).toThrow(new TypeError(ERROR));
  expect(parse).not.toHaveBeenCalled();
});
it('is repeatable without current time, randomness, network or log output', () => {
  const input = fixture();
  const expected = serializeRetainedExportManifest(input);
  const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Clock forbidden'); });
  const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Random forbidden'); });
  try {
    expect(serializeRetainedExportManifest(input)).toBe(expected);
    expect(serializeRetainedExportManifest(parseRetainedExportManifest(expected).manifest)).toBe(expected);
    expect(checkRetainedExportArtifactBytes(input, SNAPSHOT, payload)).toEqual(checkRetainedExportArtifactBytes(input, SNAPSHOT, payload));
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  } finally { now.mockRestore(); random.mockRestore(); }
});
