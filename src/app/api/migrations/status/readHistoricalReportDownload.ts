import 'server-only';

import { types as nodeTypes } from 'node:util';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { readPreflightReport } from './readPreflightReport';
import type { PreflightReportProjection } from './preflightReportProjection';

const MAX_BODY_BYTES = 65_536;
const METRICS = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
] as const;
const CATEGORIES = [
  ...METRICS, 'INTEGRITY', 'SOURCES', 'CHECKPOINTS', 'TRANSACTION_ITEMS', 'SETTINGS', 'ALLOWED_STUDENTS',
] as const;
const CODES = [
  'INVALID_DIAGNOSTIC', 'INVALID_MANIFEST', 'INVALID_CURRENT_MANIFEST', 'UNSUPPORTED_HISTORY', 'BINDING_MISMATCH',
  'SOURCE_MUTATION', 'ROW_MISMATCH', 'CARDINALITY_MISMATCH', 'CHECKPOINT_INCOMPLETE',
  'HISTORY_ORDER', 'OPERATIONAL_PROJECTION', 'DATABASE_READ_FAILED', 'INVALID_COMPARISON_INSTANT', 'DATABASE_WRITE_FAILED',
] as const;
const privateHeaders = {
  'cache-control': 'private, no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'vary': 'Cookie',
  'x-content-type-options': 'nosniff',
};

function invalid(): never { throw new Error('Unavailable historical display'); }
function own(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length
    || !required.every(key => Object.hasOwn(value, key))) invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) invalid();
    copy[key] = own(value, key);
  }
  return copy;
}
function list(value: unknown, max: number): unknown[] {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, index) => own(value, String(index)));
}
function literal<T extends string | number | boolean>(value: unknown, expected: T): T {
  if (value !== expected) invalid();
  return expected;
}
function allowed<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid();
  return value as T;
}
function text(value: unknown, max: number, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) invalid();
  return value;
}
function digest(value: unknown): string { return text(value, 64, /^[a-f0-9]{64}$/); }
function decimal(value: unknown, digits: number): string {
  const result = text(value, digits + 1, /^(?:0|-?[1-9][0-9]*)$/);
  if ((result.startsWith('-') ? result.length - 1 : result.length) > digits) invalid();
  return result;
}
function instant(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 24, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid();
  return result;
}

/** Versioned display allowlist ONLY, not archival integrity or authorization.
 * The real reader has already bounded wire bytes and validated the envelope,
 * tenant/job/report binding and digest. Never reconstruct that envelope here.
 * Missing fields/version drift fail closed, including all non-authority flags.
 * Only named own data fields enter a new inert object; no spreads/toJSON of the
 * reader result. Small fixed-depth arrays/scalars bound work before stringify.
 * These defensive checks cannot undo allocation before this trusted boundary.
 */
function displayProjection(value: unknown): PreflightReportProjection {
  const p = record(value, ['projectionVersion', 'readOnly', 'scope', 'verification', 'eventIntegrity',
    'originalBinding', 'currentFreshness', 'currentPreflight', 'operationalAuthority', 'cutoverAllowed',
    'reportId', 'comparisonInstant', 'manifestDigest', 'currentManifestDigest', 'sourceFingerprint', 'freshness', 'report']);
  const report = record(p.report, ['reportVersion', 'phase', 'status', 'metrics', 'diagnostics', 'omittedDiagnostics']);
  const seen = new Set<string>();
  const metrics = list(report.metrics, METRICS.length).map(value => {
    const row = record(value, ['category', 'expected', 'actual', 'delta', 'status']);
    const category = allowed(row.category, METRICS);
    if (seen.has(category)) invalid();
    seen.add(category);
    const expected = decimal(row.expected, 30);
    const actual = decimal(row.actual, 30);
    const delta = decimal(row.delta, 31);
    const status = allowed(row.status, ['MATCH', 'MISMATCH'] as const);
    if (BigInt(actual) - BigInt(expected) !== BigInt(delta) || (status === 'MATCH') !== (actual === expected)) invalid();
    return { category, expected, actual, delta, status };
  });
  const diagnostics = list(report.diagnostics, 100).map(value => {
    const row = record(value, ['category', 'code'], ['rowReference']);
    const category = allowed(row.category, CATEGORIES);
    const code = allowed(row.code, CODES);
    return Object.hasOwn(row, 'rowReference') ? { category, code, rowReference: digest(row.rowReference) } : { category, code };
  });
  const omittedDiagnostics = report.omittedDiagnostics;
  if (typeof omittedDiagnostics !== 'number' || !Number.isSafeInteger(omittedDiagnostics) || Object.is(omittedDiagnostics, -0)
    || omittedDiagnostics < 0 || omittedDiagnostics > 0xffff_ffff - 100
    || (omittedDiagnostics > 0 && diagnostics.length !== 100)) invalid();
  const status = allowed(report.status, ['BLOCKED', 'MATCHED_PREFLIGHT'] as const);
  const blocked = diagnostics.length > 0 || omittedDiagnostics > 0 || metrics.some(row => row.status === 'MISMATCH');
  if ((status === 'BLOCKED') !== blocked || (status === 'MATCHED_PREFLIGHT' && seen.size !== METRICS.length)) invalid();
  const comparisonInstant = instant(p.comparisonInstant);
  const manifestDigest = digest(p.manifestDigest);
  const currentManifestDigest = p.currentManifestDigest === null ? null : digest(p.currentManifestDigest);
  const has = (code: typeof CODES[number]) => diagnostics.some(row => row.code === code);
  if ((comparisonInstant === null) !== has('INVALID_COMPARISON_INSTANT')
    || (currentManifestDigest === null) !== has('INVALID_CURRENT_MANIFEST')
    || (currentManifestDigest !== null && currentManifestDigest !== manifestDigest && !has('SOURCE_MUTATION') && omittedDiagnostics === 0)
    || (status === 'MATCHED_PREFLIGHT' && (comparisonInstant === null || currentManifestDigest !== manifestDigest))) invalid();
  return {
    projectionVersion: literal(p.projectionVersion, 1), readOnly: literal(p.readOnly, true),
    scope: literal(p.scope, 'HISTORICAL_ONLY'), verification: literal(p.verification, 'INTEGRITY_ONLY'),
    eventIntegrity: literal(p.eventIntegrity, 'VERIFIED'), originalBinding: literal(p.originalBinding, 'NOT_VERIFIED'),
    currentFreshness: literal(p.currentFreshness, 'NOT_VERIFIED'), currentPreflight: literal(p.currentPreflight, 'NOT_EVALUATED'),
    operationalAuthority: literal(p.operationalAuthority, 'UNKNOWN'), cutoverAllowed: literal(p.cutoverAllowed, false),
    reportId: text(p.reportId, 79, /^reconciliation:[a-f0-9]{64}$/), comparisonInstant,
    manifestDigest, currentManifestDigest, sourceFingerprint: digest(p.sourceFingerprint),
    freshness: literal(p.freshness, 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE'),
    report: { reportVersion: literal(report.reportVersion, 1), phase: literal(report.phase, 'PREFLIGHT'),
      status, metrics, diagnostics, omittedDiagnostics },
  };
}

/** Server-only in-process Response adapter. NOT a route or an operational
 * export/backup, current preflight, migration capability or cutover approval.
 * Accepts only the original canonical preflight GET/HEAD Request and slug.
 * Every invocation calls the fixed authenticated reader anew: no caller DTO,
 * tenantId/role flags, injected reader, cached viewer success or URL rewrite.
 *
 * Authorization is the reader's verified Google identity + canonical tenant
 * discovery + current OWNER/ADMIN binding in the final READ COMMITTED statement.
 * It is not a revocation lease after that snapshot. No second query, producer,
 * formatter-envelope reconstruction, operational I/O or fallback is attempted.
 * Public route wiring and Next/proxy dispatch tests need separate ownership.
 */
export async function readHistoricalReportDownload(slug: unknown, request: Request): Promise<Response> {
  const head = request.method === 'HEAD';
  const fail = (status: number, error: string, headers: HeadersInit = privateHeaders) =>
    new Response(head ? null : JSON.stringify({ error }), { status, headers });
  const unavailable = () => fail(503, 'PREFLIGHT_REPORT_UNAVAILABLE');
  if (request.method !== 'GET' && !head) {
    return fail(405, 'METHOD_NOT_ALLOWED', { ...privateHeaders, allow: 'GET, HEAD' });
  }
  try {
    const cookie = request.headers.get('cookie');
    if (request.signal.aborted) return unavailable();
    const result: unknown = await readPreflightReport(slug, request);
    // No await/I/O between successful reader cleanup and publication. Keep the
    // original Request (Cookie and signal included), not a normalized copy.
    if (request.signal.aborted) return unavailable();
    if (request.headers.get('cookie') !== cookie) return fail(401, 'AUTHENTICATION_REQUIRED');
    if (result === null || typeof result !== 'object' || nodeTypes.isProxy(result)) return unavailable();
    const kind = own(result, 'kind');
    if (kind !== 'HISTORICAL_REPORT') {
      record(result, ['kind']);
      switch (kind) {
        case 'UNAUTHENTICATED': return fail(401, 'AUTHENTICATION_REQUIRED');
        case 'FORBIDDEN': return fail(403, 'ACCESS_DENIED');
        case 'INVALID_REQUEST': return fail(400, 'INVALID_PREFLIGHT_REQUEST');
        case 'NOT_FOUND': return fail(404, 'PREFLIGHT_REPORT_NOT_FOUND');
        default: return unavailable();
      }
    }
    const projected = displayProjection(record(result, ['kind', 'projection']).projection);
    const body = `${JSON.stringify(projected)}\n`;
    // Gate the complete UTF-8 representation, including LF, BEFORE Response.
    // No partial stream, truncation, double JSON encoding, BOM, ETag or Range.
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES || request.signal.aborted) return unavailable();
    // Identical cookie bytes can expire after reader cleanup or serialization.
    // Reverify their lifetime at publication; this adds no DB query/lease.
    if (request.headers.get('cookie') !== cookie || !getGoogleSessionFromRequest(request)) {
      return fail(401, 'AUTHENTICATION_REQUIRED');
    }
    return new Response(head ? null : body, { status: 200, headers: {
      ...privateHeaders,
      'content-disposition': `attachment; filename="historical-preflight-${projected.reportId.slice('reconciliation:'.length)}.json"`,
    } });
  } catch {
    return unavailable(); // No identifiers, upstream errors, logs or retry.
  }
}
