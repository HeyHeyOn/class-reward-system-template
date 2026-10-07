import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

// Version-specific archival contracts, NOT the mutable reconciliation_results
// summary. Grounded in migration/report.ts and reconcile.ts:independentMetrics
// plus its successful RECURRENCE projection. New producer versions fail closed.
const METRIC_CATEGORIES = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
] as const;
const DIAGNOSTIC_CATEGORIES = [
  'INTEGRITY', 'SOURCES', 'CHECKPOINTS', 'STUDENTS', 'BALANCES', 'PRODUCTS', 'STOCK',
  'TRANSACTIONS', 'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'TRANSACTION_ITEMS',
  'ADJUSTMENTS', 'CANCELLATIONS', 'CANCELLATION_AMOUNT', 'CANCELLATION_DELTA', 'TASKS', 'ASSIGNMENTS', 'COMPLETIONS',
  'PROMOTIONS', 'PROMOTION_PRODUCTS', 'RECURRENCE', 'SETTINGS', 'ALLOWED_STUDENTS',
  'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'ORPHANED_CLAIMS', 'TOMBSTONES',
] as const;
const DIAGNOSTIC_CODES = [
  'INVALID_DIAGNOSTIC', 'INVALID_MANIFEST', 'INVALID_CURRENT_MANIFEST', 'UNSUPPORTED_HISTORY', 'BINDING_MISMATCH',
  'SOURCE_MUTATION', 'ROW_MISMATCH', 'CARDINALITY_MISMATCH', 'CHECKPOINT_INCOMPLETE',
  'HISTORY_ORDER', 'OPERATIONAL_PROJECTION', 'DATABASE_READ_FAILED', 'INVALID_COMPARISON_INSTANT', 'DATABASE_WRITE_FAILED',
] as const;

// Local admission limits deliberately leave headroom for all v1 metrics and
// 100 hashed diagnostics. No unbounded stringify, recursion or BigInt parsing.
const MAX_JSON_BYTES = 65_536;
const MAX_DEPTH = 6;
const MAX_NODES = 1_024;
const MAX_KEYS = 16;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_UNITS = 1_024;
const MAX_STRING_BYTES = 4_096;
const DIGEST = /^[a-f0-9]{64}$/;
const EVENT_ID = /^reconciliation:[a-f0-9]{64}$/;
const TENANT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
type MetricCategory = typeof METRIC_CATEGORIES[number];
type DiagnosticCategory = typeof DIAGNOSTIC_CATEGORIES[number];
type DiagnosticCode = typeof DIAGNOSTIC_CODES[number];
type HistoricalMetric = Readonly<{
  category: MetricCategory; expected: string; actual: string; delta: string; status: 'MATCH' | 'MISMATCH';
}>;
type HistoricalDiagnostic = Readonly<{
  category: DiagnosticCategory; code: DiagnosticCode; rowReference?: string;
}>;
type HistoricalReport = Readonly<{
  reportVersion: 1; phase: 'PREFLIGHT'; status: 'BLOCKED' | 'MATCHED_PREFLIGHT';
  metrics: readonly HistoricalMetric[]; diagnostics: readonly HistoricalDiagnostic[]; omittedDiagnostics: number;
}>;

export type PreflightReportProjection = Readonly<{
  projectionVersion: 1;
  readOnly: true;
  scope: 'HISTORICAL_ONLY';
  verification: 'INTEGRITY_ONLY';
  eventIntegrity: 'VERIFIED';
  originalBinding: 'NOT_VERIFIED';
  currentFreshness: 'NOT_VERIFIED';
  currentPreflight: 'NOT_EVALUATED';
  operationalAuthority: 'UNKNOWN';
  cutoverAllowed: false;
  reportId: string;
  comparisonInstant: string | null;
  manifestDigest: string;
  currentManifestDigest: string | null;
  sourceFingerprint: string;
  freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE';
  report: HistoricalReport;
}>;
export type PreflightReportProjectionResult =
  | Readonly<{ kind: 'HISTORICAL_REPORT'; projection: PreflightReportProjection }>
  | Readonly<{
    kind: 'UNAVAILABLE'; reasonCode: 'INVALID_ARCHIVAL_REPORT'; readOnly: true;
    scope: 'HISTORICAL_ONLY'; operationalAuthority: 'UNKNOWN'; cutoverAllowed: false;
  }>;

/** PURE projection of one decoded audit_events row; no I/O, authorization,
 * job lookup, snapshot binding, report generation, source read or capability.
 *
 * selection must be exactly { tenantId, migrationJobId, reportId }, independently
 * supplied by the future authorized reader. envelope must contain exactly the
 * nine selected columns below (explicit nulls, parsed JSONB redacted_details).
 * Neither parameter accepts JSON text, SELECT * extras or caller binding claims.
 *
 * The caller must bound DB/transport bytes BEFORE decoding/materializing a row;
 * this function bounds traversal/copy/hash of the already-materialized graph.
 * Native own-key enumeration cannot undo memory already allocated by the caller.
 * Proxies/accessors are refused without executing their traps/getters.
 *
 * Digest equality binds these bytes and selectors only. Anyone can recompute
 * this unkeyed hash. No original DB/source evidence is supplied here, so even a
 * valid MATCHED archive is INTEGRITY_ONLY, never fresh preflight or cutover.
 * comparisonInstant is the stored comparison clock, NOT insertion/read time.
 */
export function projectPreflightReport(envelope: unknown, selection: unknown): PreflightReportProjectionResult {
  try {
    const selected = boundedCopy(selection);
    exactRecord(selected, ['tenantId', 'migrationJobId', 'reportId']);
    if (typeof selected.tenantId !== 'string' || !TENANT_ID.test(selected.tenantId)
      || !isJobId(selected.migrationJobId) || typeof selected.reportId !== 'string'
      || !EVENT_ID.test(selected.reportId)) invalid();

    const row = boundedCopy(envelope);
    exactRecord(row, ['tenant_id', 'event_id', 'job_id', 'event_type', 'operation_id',
      'actor_user_id', 'entity_type', 'entity_id', 'redacted_details']);
    if (row.tenant_id !== selected.tenantId || row.job_id !== selected.migrationJobId
      || row.event_id !== selected.reportId || row.event_type !== 'MIGRATION_RECONCILIATION_PREFLIGHT'
      || row.operation_id !== null || row.actor_user_id !== null
      || row.entity_type !== null || row.entity_id !== null) invalid();

    const details = row.redacted_details;
    exactRecord(details, ['report', 'comparisonInstant', 'manifestDigest', 'currentManifestDigest', 'sourceFingerprint', 'freshness']);
    if (!isDigest(details.manifestDigest) || !isDigest(details.sourceFingerprint)
      || (details.currentManifestDigest !== null && !isDigest(details.currentManifestDigest))
      || (details.comparisonInstant !== null && !isComparisonInstant(details.comparisonInstant))
      || details.freshness !== 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE') invalid();
    const report = parseReport(details.report);
    const hasDiagnostic = (code: DiagnosticCode) => report.diagnostics.some(row => row.code === code);
    if ((details.comparisonInstant === null) !== hasDiagnostic('INVALID_COMPARISON_INSTANT')) invalid();
    // prepareLegacyImportReady derives both nulls from the RETAINED diagnostics,
    // not from omitted upstream diagnostics. Do not invent a null exception.
    if ((details.currentManifestDigest === null) !== hasDiagnostic('INVALID_CURRENT_MANIFEST')) invalid();
    if (details.currentManifestDigest !== null && details.currentManifestDigest !== details.manifestDigest
      && !hasDiagnostic('SOURCE_MUTATION') && report.omittedDiagnostics === 0) invalid();
    if (report.status === 'MATCHED_PREFLIGHT' && (details.comparisonInstant === null
      || details.currentManifestDigest !== details.manifestDigest)) invalid();

    // reconcile.ts uses sha256(canonicalJson([tenantId, migrationJobId, details])).
    // Validate and bound FIRST. Hash the entire admitted details, not the DTO,
    // whose intentionally omitted historical authority label would change it.
    const digest = createHash('sha256').update(canonicalArchiveJson([
      selected.tenantId, selected.migrationJobId, details,
    ]), 'utf8').digest('hex');
    if (row.event_id !== `reconciliation:${digest}`) invalid();

    return {
      kind: 'HISTORICAL_REPORT',
      projection: {
        projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY',
        verification: 'INTEGRITY_ONLY', eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED',
        currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED',
        operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
        reportId: selected.reportId, comparisonInstant: details.comparisonInstant,
        manifestDigest: details.manifestDigest, currentManifestDigest: details.currentManifestDigest,
        sourceFingerprint: details.sourceFingerprint, freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE', report,
      },
    };
  } catch {
    // Deliberately no raw identifiers, input fields or upstream exception text.
    return { kind: 'UNAVAILABLE', reasonCode: 'INVALID_ARCHIVAL_REPORT', readOnly: true,
      scope: 'HISTORICAL_ONLY', operationalAuthority: 'UNKNOWN', cutoverAllowed: false };
  }
}

function parseReport(value: Json): HistoricalReport {
  exactRecord(value, ['reportVersion', 'phase', 'status', 'authority', 'cutoverAllowed', 'metrics', 'diagnostics', 'omittedDiagnostics']);
  if (value.reportVersion !== 1 || value.phase !== 'PREFLIGHT'
    || (value.status !== 'BLOCKED' && value.status !== 'MATCHED_PREFLIGHT')
    || value.authority !== 'SHEETS_AND_REDIS' || value.cutoverAllowed !== false
    || !Array.isArray(value.metrics) || value.metrics.length > METRIC_CATEGORIES.length
    || !Array.isArray(value.diagnostics) || value.diagnostics.length > 100
    || typeof value.omittedDiagnostics !== 'number' || !Number.isSafeInteger(value.omittedDiagnostics)
    || value.omittedDiagnostics < 0 || value.omittedDiagnostics > 0xffff_ffff - 100
    || (value.omittedDiagnostics > 0 && value.diagnostics.length !== 100)) invalid();

  const seen = new Set<MetricCategory>();
  const metrics: HistoricalMetric[] = value.metrics.map(metric => {
    exactRecord(metric, ['category', 'expected', 'actual', 'delta', 'status']);
    if (!allowed(METRIC_CATEGORIES, metric.category) || seen.has(metric.category)) invalid();
    seen.add(metric.category);
    // report.ts permits abs(expected/actual) < 10^30, so their signed difference
    // may require 31 digits. Never coerce aggregates to Number or clamp debt.
    const expected = decimal(metric.expected, 30);
    const actual = decimal(metric.actual, 30);
    const delta = decimal(metric.delta, 31);
    const status = actual.value === expected.value ? 'MATCH' : 'MISMATCH';
    if (actual.value - expected.value !== delta.value || metric.status !== status) invalid();
    return { category: metric.category, expected: expected.text, actual: actual.text, delta: delta.text, status };
  });
  const diagnostics: HistoricalDiagnostic[] = value.diagnostics.map(diagnostic => {
    exactRecord(diagnostic, ['category', 'code'], ['rowReference']);
    if (!allowed(DIAGNOSTIC_CATEGORIES, diagnostic.category) || !allowed(DIAGNOSTIC_CODES, diagnostic.code)) invalid();
    if (Object.hasOwn(diagnostic, 'rowReference')) {
      if (!isDigest(diagnostic.rowReference)) invalid();
      return { category: diagnostic.category, code: diagnostic.code, rowReference: diagnostic.rowReference };
    }
    return { category: diagnostic.category, code: diagnostic.code };
  });
  const blocked = diagnostics.length > 0 || value.omittedDiagnostics > 0 || metrics.some(row => row.status === 'MISMATCH');
  if ((value.status === 'BLOCKED') !== blocked) invalid();
  if (value.status === 'MATCHED_PREFLIGHT'
    && (seen.size !== METRIC_CATEGORIES.length || METRIC_CATEGORIES.some(category => !seen.has(category)))) invalid();
  return { reportVersion: 1, phase: 'PREFLIGHT', status: value.status, metrics, diagnostics,
    omittedDiagnostics: value.omittedDiagnostics };
}

function decimal(value: Json, digits: number): { text: string; value: bigint } {
  if (typeof value !== 'string' || value.length > digits + 1 || !/^(?:0|-?[1-9][0-9]*)$/.test(value)
    || (value[0] === '-' ? value.length - 1 : value.length) > digits) invalid();
  return { text: value, value: BigInt(value) };
}
function allowed<T extends string>(values: readonly T[], value: Json): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
function isDigest(value: Json): value is string { return typeof value === 'string' && DIGEST.test(value); }
function isComparisonInstant(value: Json): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isJobId(value: Json): value is string {
  // Same opaque-text selector contract as readJobStatus.ts, without importing
  // that DB reader or pretending a job ID must be a UUID. Never normalize it.
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
function exactRecord(value: Json, required: readonly string[], optional: readonly string[] = []): asserts value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !required.every(key => Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

/** Snapshot inert JSON only, before any semantic reads, hashing or DTO creation.
 * Strings are bounded before encoding; array length before key enumeration;
 * nodes/depth before recursion; own data descriptors before reading children. */
function boundedCopy(input: unknown): Json {
  let nodes = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();
  const charge = (amount: number) => { bytes += amount; if (bytes > MAX_JSON_BYTES) invalid(); };
  const chargeString = (text: string) => {
    if (text.length > MAX_STRING_UNITS || Buffer.byteLength(text, 'utf8') > MAX_STRING_BYTES) invalid();
    charge(Buffer.byteLength(JSON.stringify(text), 'utf8'));
  };
  const ownValue = (object: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    return descriptor.value;
  };
  const visit = (value: unknown, depth: number): Json => {
    nodes++;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    if (value === null || typeof value === 'boolean') { charge(5); return value; }
    if (typeof value === 'string') { chargeString(value); return value; }
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
      charge(String(value).length); return value;
    }
    if (typeof value !== 'object' || nodeTypes.isProxy(value) || seen.has(value)) invalid();
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    charge(2);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || value.length > MAX_ARRAY_ITEMS || nodes + value.length > MAX_NODES) invalid();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) invalid();
      const copy: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        charge(1);
        copy.push(visit(ownValue(value, String(index)), depth + 1));
      }
      return copy;
    }
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_KEYS || nodes + keys.length > MAX_NODES) invalid();
    const copy: JsonRecord = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 64 || POISON_KEYS.has(key)) invalid();
      chargeString(key); charge(2);
      copy[key] = visit(ownValue(value, key), depth + 1);
    }
    return copy;
  };
  return visit(input, 0);
}

/** EXACT validators.ts:canonicalJson no-budget contract used by reconcile.ts:
 * JSON primitive encoding, array order, object keys sorted by UTF-16 code units.
 * Kept local to avoid importing validators -> sheetsSnapshot -> Sheets adapters
 * into this pure boundary. Tests compare with the actual producer export, not
 * another hand-written fixture encoder. Only admitted JSON reaches this helper. */
function canonicalArchiveJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalArchiveJson).join(',')}]`;
  return `{${Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(key => `${JSON.stringify(key)}:${canonicalArchiveJson(value[key])}`).join(',')}}`;
}
function invalid(): never { throw new Error('Invalid archival report'); }
