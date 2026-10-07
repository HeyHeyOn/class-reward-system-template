// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createReconciliationReport, RECONCILIATION_CATEGORIES, type ReconciliationMetric } from '../../../../server/migration/report';
import { projectPreflightReport } from './preflightReportProjection';

// Exercise the ACTUAL canonicalJson export, but do not load its Sheets adapter
// dependency graph. Neither canonicalJson nor the pure report builder uses it.
vi.mock('../../../../server/migration/sheetsSnapshot', () => ({
  stableRowHash: () => { throw new Error('Sheets dependency must not be called'); },
}));
// Runtime conformance against the actual export; keep the worker-owned migration
// dependency graph out of this file's focused static typecheck. No replica/mock
// of canonicalJson is used, and the inspected no-budget signature is explicit.
const { canonicalJson } = await vi.importActual<{ canonicalJson: (value: unknown) => string }>(
  '../../../../server/migration/validators',
);

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'archived job:1';
const INSTANT = '2026-09-01T12:00:00.000Z';
const DIGEST = 'a'.repeat(64);
// independentMetrics in reconcile.ts, plus the successful recurrence projection.
// Intentionally not sourced from the validator under test or legacy summary.
const METRICS = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
] as const;
const completeMetrics = (): ReconciliationMetric[] => METRICS.map(category => ({
  category, expected: BigInt(0), actual: BigInt(0),
}));
function event(report = createReconciliationReport(completeMetrics(), [])) {
  const details = {
    report, comparisonInstant: INSTANT as string | null,
    manifestDigest: DIGEST, currentManifestDigest: DIGEST as string | null,
    sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
  };
  return seal({
    tenant_id: TENANT, job_id: JOB, event_id: '',
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null,
    actor_user_id: null, entity_type: null, entity_id: null, redacted_details: details,
  });
}
type Event = ReturnType<typeof event>;
function seal<T extends { tenant_id: string; job_id: string; event_id: string; redacted_details: unknown }>(row: T): T {
  row.event_id = `reconciliation:${createHash('sha256')
    .update(canonicalJson([row.tenant_id, row.job_id, row.redacted_details]), 'utf8').digest('hex')}`;
  return row;
}
function selection(row: Event) {
  return { tenantId: row.tenant_id, migrationJobId: row.job_id, reportId: row.event_id };
}
function projected(row: Event) {
  const result = projectPreflightReport(row, selection(row));
  expect(result.kind).toBe('HISTORICAL_REPORT');
  if (result.kind !== 'HISTORICAL_REPORT') throw new Error('Expected historical report');
  return result.projection;
}
function rejected(row: unknown, selected: unknown = selection(event())) {
  expect(projectPreflightReport(row, selected)).toEqual({
    kind: 'UNAVAILABLE', reasonCode: 'INVALID_ARCHIVAL_REPORT', readOnly: true,
    scope: 'HISTORICAL_ONLY', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
  });
}
function resealedRejection(edit: (row: Event) => void) {
  const row = event();
  edit(row);
  seal(row);
  rejected(row, selection(row));
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]),
  );
  return value;
}

describe('pure historical preflight event projection', () => {
  it('projects a producer MATCHED report as integrity-only, never operational authority', () => {
    const row = event();
    const dto = projected(row);
    expect(dto).toEqual({
      projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY',
      verification: 'INTEGRITY_ONLY', eventIntegrity: 'VERIFIED',
      originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
      currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
      reportId: row.event_id, comparisonInstant: INSTANT, manifestDigest: DIGEST,
      currentManifestDigest: DIGEST, sourceFingerprint: 'b'.repeat(64),
      freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
      report: {
        reportVersion: 1, phase: 'PREFLIGHT', status: 'MATCHED_PREFLIGHT',
        metrics: row.redacted_details.report.metrics, diagnostics: [], omittedDiagnostics: 0,
      },
    });
    expect(JSON.stringify(dto)).not.toContain(JOB);
    expect(JSON.stringify(dto)).not.toContain(TENANT);
    expect(JSON.stringify(dto)).not.toContain('SHEETS_AND_REDIS');
    expect(dto.report).not.toBe(row.redacted_details.report);
    expect(dto.report.metrics[0]).not.toBe(row.redacted_details.report.metrics[0]);
  });

  it('accepts actual canonicalJson digests regardless of object insertion order', () => {
    const row = event();
    row.job_id = '과거/"job"\\😀';
    seal(row);
    expect(projectPreflightReport(reverseKeys(row), reverseKeys(selection(row))))
      .toEqual(projectPreflightReport(row, selection(row)));
    const noncanonical = event();
    noncanonical.event_id = `reconciliation:${createHash('sha256')
      .update(JSON.stringify([noncanonical.tenant_id, noncanonical.job_id, noncanonical.redacted_details])).digest('hex')}`;
    rejected(noncanonical, selection(noncanonical));
  });

  it('keeps metric coverage pinned to the inspected producer, not diagnostic categories', () => {
    const source = readFileSync(new URL('../../../../server/migration/reconcile.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function independentMetrics('), source.indexOf('\nfunction sum('));
    const categories = [...body.matchAll(/\['([A-Z_]+)',/g)].map(match => match[1]);
    categories.push('CANCELLATIONS', 'RECURRENCE');
    expect(new Set(categories)).toEqual(new Set(METRICS));
    expect(source).toContain("metrics.push({ category: 'RECURRENCE'");
  });

  it('retains a zero-delta BLOCKED report and only hashed row references', () => {
    const row = event(createReconciliationReport(completeMetrics(), [
      { category: 'COMPLETIONS', code: 'UNSUPPORTED_HISTORY', rowReference: 'private raw student row' },
    ]));
    const dto = projected(row);
    expect(dto.report.status).toBe('BLOCKED');
    expect(dto.report.metrics.every(metric => metric.delta === '0')).toBe(true);
    expect(dto.report.diagnostics).toEqual(row.redacted_details.report.diagnostics);
    expect(dto.report.diagnostics[0].rowReference).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(dto)).not.toContain('private raw student row');
  });

  it('retains BLOCKED with no metrics and an invalid comparison diagnostic', () => {
    const row = event(createReconciliationReport([], [
      { category: 'RECURRENCE', code: 'INVALID_COMPARISON_INSTANT' },
    ]));
    row.redacted_details.comparisonInstant = null;
    seal(row);
    const dto = projected(row);
    expect(dto.comparisonInstant).toBeNull();
    expect(dto.report.metrics).toEqual([]);
    expect(dto.report.status).toBe('BLOCKED');
    expect(dto.report.diagnostics[0].code).toBe('INVALID_COMPARISON_INSTANT');
  });

  it('retains invalid-current and SOURCE_MUTATION historical evidence without inventing source binding', () => {
    const invalid = event(createReconciliationReport(completeMetrics(), [
      { category: 'SOURCES', code: 'INVALID_CURRENT_MANIFEST' },
    ]));
    invalid.redacted_details.currentManifestDigest = null;
    seal(invalid);
    expect(projected(invalid).currentManifestDigest).toBeNull();
    const changed = event(createReconciliationReport(completeMetrics(), [
      { category: 'SOURCES', code: 'SOURCE_MUTATION' },
    ]));
    changed.redacted_details.currentManifestDigest = 'c'.repeat(64);
    seal(changed);
    const dto = projected(changed);
    expect(dto.manifestDigest).not.toBe(dto.currentManifestDigest);
    expect(dto.report.diagnostics[0].code).toBe('SOURCE_MUTATION');
    expect(dto.originalBinding).toBe('NOT_VERIFIED');
  });

  it('retains the diagnostic cap and omitted count without reclassifying BLOCKED', () => {
    const row = event(createReconciliationReport([], Array.from({ length: 150 }, () => ({
      category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: 'redacted',
    }))));
    const dto = projected(row);
    expect(dto.report.status).toBe('BLOCKED');
    expect(dto.report.diagnostics).toHaveLength(100);
    expect(dto.report.omittedDiagnostics).toBe(50);
    // The producer sets null from retained diagnostics, not hypothetical omitted ones.
    row.redacted_details.currentManifestDigest = null;
    seal(row);
    rejected(row, selection(row));
  });

  it('does not promote a coherently rehashed forgery to original or live source verification', () => {
    const row = event();
    row.redacted_details.manifestDigest = row.redacted_details.currentManifestDigest = 'd'.repeat(64);
    row.redacted_details.sourceFingerprint = 'e'.repeat(64);
    seal(row);
    const dto = projected(row);
    expect(dto.verification).toBe('INTEGRITY_ONLY');
    expect(dto.originalBinding).toBe('NOT_VERIFIED');
    expect(dto.currentPreflight).toBe('NOT_EVALUATED');
    expect(dto.operationalAuthority).toBe('UNKNOWN');
    expect(dto.cutoverAllowed).toBe(false);
  });

  it('accepts negative exact balances and signed 31-digit deltas without Number conversion', () => {
    const limit = BigInt(10) ** BigInt(30) - BigInt(1);
    for (const category of ['BALANCES', 'TRANSACTION_DELTA', 'CANCELLATION_DELTA'] as const) {
      for (const [expected, actual] of [[-limit, limit], [limit, -limit], [-limit, -limit]]) {
        const row = event(createReconciliationReport(completeMetrics().map(metric => metric.category === category
          ? { category, expected, actual } : metric), []));
        const metric = projected(row).report.metrics.find(metric => metric.category === category);
        expect(metric).toEqual({ category, expected: expected.toString(), actual: actual.toString(),
          delta: (actual - expected).toString(), status: actual === expected ? 'MATCH' : 'MISMATCH' });
      }
    }
  });

  it('accepts partial metrics only for a genuinely BLOCKED report', () => {
    const row = event(createReconciliationReport([
      { category: 'BALANCES', expected: BigInt(-10), actual: BigInt(-12) },
    ], []));
    expect(projected(row).report.metrics[0].delta).toBe('-2');
  });

  it.each(METRICS)('rejects MATCHED missing %s even with a recomputed digest', category => {
    resealedRejection(row => { row.redacted_details.report.metrics = row.redacted_details.report.metrics.filter(metric => metric.category !== category); });
  });
  it.each(METRICS)('rejects duplicate %s even in BLOCKED', category => {
    resealedRejection(row => {
      row.redacted_details.report.status = 'BLOCKED';
      row.redacted_details.report.diagnostics.push({ category: 'INTEGRITY', code: 'INVALID_DIAGNOSTIC' });
      const metrics = row.redacted_details.report.metrics;
      const duplicate = metrics.find(metric => metric.category === category)!;
      metrics[metrics.findIndex(metric => metric.category !== category)] = { ...duplicate };
    });
  });
  it('rejects the producer builder empty-MATCHED trap and unexplained BLOCKED', () => {
    const empty = event(createReconciliationReport([], []));
    rejected(empty, selection(empty));
    resealedRejection(row => { row.redacted_details.report.status = 'BLOCKED'; });
  });

  it.each(['expected', 'actual', 'delta'] as const)('rejects noncanonical/oversized %s', field => {
    for (const value of ['', '+1', '-0', '00', '-01', '1.0', '1e3', ' 0', '0\n', 'NaN', '9'.repeat(1000), 0, null]) {
      resealedRejection(row => { Object.assign(row.redacted_details.report.metrics[0], { [field]: value }); });
    }
  });
  it('rejects producer numeric boundary violations and incorrect arithmetic/status', () => {
    for (const value of ['1' + '0'.repeat(30), '-1' + '0'.repeat(30)]) {
      resealedRejection(row => { Object.assign(row.redacted_details.report.metrics[0], { expected: value, actual: value }); });
    }
    resealedRejection(row => { row.redacted_details.report.metrics[0].delta = '1'; });
    resealedRejection(row => { row.redacted_details.report.metrics[0].status = 'MISMATCH'; });
    resealedRejection(row => { Object.assign(row.redacted_details.report.metrics[0], { actual: '1', delta: '1' }); });
    resealedRejection(row => {
      Object.assign(row.redacted_details.report.metrics[0], { actual: '1', delta: '1', status: 'MISMATCH' });
    });
  });

  it.each(['tenant_id', 'job_id', 'event_id', 'event_type'] as const)('rejects altered event %s', key => {
    const row = event();
    const selected = selection(row);
    row[key] = key === 'tenant_id' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'other';
    rejected(row, selected);
  });
  it.each(['operation_id', 'actor_user_id', 'entity_type', 'entity_id'] as const)('requires explicit NULL %s', key => {
    for (const value of ['', 'unexpected', undefined, 0]) {
      const row = event();
      Object.assign(row, { [key]: value });
      rejected(row, selection(row));
    }
    const row = event();
    Reflect.deleteProperty(row, key);
    rejected(row, selection(row));
  });
  it.each(['tenantId', 'migrationJobId', 'reportId'] as const)('refuses malformed or mismatched selection %s', key => {
    const row = event();
    for (const value of ['', ' wrong ', 'a'.repeat(1025), 'x\u200by', null, [], 1]) {
      rejected(row, { ...selection(row), [key]: value });
    }
    const selected = selection(row);
    Reflect.deleteProperty(selected, key);
    rejected(row, selected);
  });
  it('rejects selectors with extra authority/binding claims or invalid identifier spelling', () => {
    const row = event();
    rejected(row, { ...selection(row), originalBinding: 'VERIFIED' });
    row.tenant_id = TENANT.toUpperCase();
    seal(row);
    rejected(row, selection(row));
    const uppercase = event();
    uppercase.event_id = uppercase.event_id.toUpperCase();
    rejected(uppercase, selection(uppercase));
  });

  it.each(['manifestDigest', 'currentManifestDigest', 'sourceFingerprint', 'comparisonInstant'] as const)(
    'rejects digest tampering of %s without rehash', key => {
      const row = event();
      row.redacted_details[key] = key === 'comparisonInstant' ? '2026-09-02T12:00:00.000Z' : 'c'.repeat(64);
      rejected(row, selection(row));
    },
  );
  it.each(['reportVersion', 'phase', 'status', 'authority', 'cutoverAllowed'] as const)('rejects unknown report %s even after rehash', key => {
    resealedRejection(row => { Object.assign(row.redacted_details.report, { [key]: key === 'cutoverAllowed' ? true : 'UNKNOWN' }); });
  });
  it('rejects wrong envelope freshness, digests, timestamps and missing required keys', () => {
    resealedRejection(row => { row.redacted_details.freshness = 'LIVE'; });
    for (const key of ['manifestDigest', 'sourceFingerprint', 'currentManifestDigest'] as const) {
      resealedRejection(row => { row.redacted_details[key] = DIGEST.toUpperCase(); });
    }
    for (const value of [null, '2026-02-30T00:00:00.000Z', '2026-09-01T12:00:00Z', '2026-09-01T12:00:00.000+00:00']) {
      resealedRejection(row => { row.redacted_details.comparisonInstant = value; });
    }
    for (const key of Object.keys(event().redacted_details)) {
      resealedRejection(row => { Reflect.deleteProperty(row.redacted_details, key); });
    }
    for (const key of Object.keys(event().redacted_details.report)) {
      resealedRejection(row => { Reflect.deleteProperty(row.redacted_details.report, key); });
    }
  });
  it('rejects MATCHED with null/changed current manifest or diagnostic evidence', () => {
    for (const value of [null, 'c'.repeat(64)]) {
      resealedRejection(row => { row.redacted_details.currentManifestDigest = value; });
    }
    resealedRejection(row => { row.redacted_details.report.diagnostics.push({ category: 'SOURCES', code: 'SOURCE_MUTATION' }); });
  });
  it('requires null evidence to agree with retained diagnostics', () => {
    for (const code of ['INVALID_COMPARISON_INSTANT', 'INVALID_CURRENT_MANIFEST']) {
      const row = event(createReconciliationReport([], [{ category: 'INTEGRITY', code }]));
      rejected(row, selection(row));
    }
    const row = event(createReconciliationReport([], [{ category: 'STUDENTS', code: 'ROW_MISMATCH' }]));
    row.redacted_details.currentManifestDigest = null;
    seal(row);
    rejected(row, selection(row));
  });

  it('rejects unknown metric/diagnostic labels and non-hash references without leaking raw data', () => {
    const secret = '<script>credential-secret</script>';
    resealedRejection(row => { Object.assign(row.redacted_details.report.metrics[0], { category: secret }); });
    resealedRejection(row => { Object.assign(row.redacted_details.report.metrics[0], { category: 'INTEGRITY' }); });
    for (const diagnostic of [
      { category: 'STUDENTS', code: secret }, { category: secret, code: 'ROW_MISMATCH' },
      { category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: secret },
      { category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: DIGEST.toUpperCase() },
      { category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: null },
    ]) {
      resealedRejection(row => { Object.assign(row.redacted_details.report, { status: 'BLOCKED', diagnostics: [diagnostic] }); });
    }
  });
  it('refuses unknown fields at every level rather than spreading stored JSON', () => {
    for (const target of ['event', 'details', 'report', 'metric', 'diagnostic']) {
      const row = event(createReconciliationReport(completeMetrics(), [{ category: 'STUDENTS', code: 'ROW_MISMATCH' }]));
      const destinations: Record<string, object> = { event: row, details: row.redacted_details,
        report: row.redacted_details.report, metric: row.redacted_details.report.metrics[0],
        diagnostic: row.redacted_details.report.diagnostics[0] };
      Object.assign(destinations[target], { credential: 'DO_NOT_ECHO' });
      seal(row);
      rejected(row, selection(row));
    }
  });
  it('refuses malformed omitted counts, oversized arrays and more than 100 diagnostics', () => {
    for (const value of [-1, -0, 0.5, '1', Number.MAX_SAFE_INTEGER, 1]) {
      resealedRejection(row => { Object.assign(row.redacted_details.report, { omittedDiagnostics: value, status: 'BLOCKED' }); });
    }
    // Non-finite values cannot be signed by the real canonicalJson producer.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const row = event();
      Object.assign(row.redacted_details.report, { omittedDiagnostics: value });
      rejected(row, selection(row));
    }
    const row = event(createReconciliationReport([], Array.from({ length: 100 }, () => ({ category: 'STUDENTS', code: 'ROW_MISMATCH' }))));
    row.redacted_details.report.diagnostics.push({ category: 'STUDENTS', code: 'ROW_MISMATCH' });
    seal(row);
    rejected(row, selection(row));
  });

  it('fails closed on oversized strings, wide/deep graphs and cycles before canonical hashing', () => {
    const cases: unknown[] = ['x'.repeat(100_000), Array(1_000_000), { tooWide: Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [`k${index}`, index]),
    ) }];
    let deep: unknown = 0;
    for (let index = 0; index < 1000; index++) deep = { nested: deep };
    cases.push(deep);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cases.push(cyclic);
    for (const value of cases) {
      const row = event();
      Object.assign(row.redacted_details.report, { metrics: value });
      rejected(row, selection(row));
    }
  });
  it('enforces aggregate bytes, node and UTF-8 string bounds, not just array lengths', () => {
    const row = event();
    for (const payload of [
      Array.from({ length: 100 }, () => 'x'.repeat(1024)),
      Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 0)),
      '😀'.repeat(4096),
    ]) {
      Object.assign(row.redacted_details, { report: payload });
      rejected(row, selection(row));
    }
  });
  it('rejects non-JSON values, sparse arrays, hidden keys, accessors and proxies without invoking them', () => {
    for (const value of [undefined, BigInt(1), () => 0, new Date(INSTANT), new Map(), Symbol('x'), NaN]) {
      const row = event();
      Object.assign(row.redacted_details.report, { diagnostics: value });
      rejected(row, selection(row));
    }
    const getter = vi.fn(() => { throw new Error('private getter'); });
    const withGetter = event();
    Object.defineProperty(withGetter, 'redacted_details', { get: getter, enumerable: true });
    rejected(withGetter);
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => { throw new Error('proxy trap'); });
    rejected(new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, get: trap }));
    expect(trap).not.toHaveBeenCalled();
    const hidden = event();
    Object.defineProperty(hidden.redacted_details, 'secret', { value: 'private', enumerable: false });
    rejected(hidden, selection(hidden));
    const symbol = event();
    Object.defineProperty(symbol, Symbol('secret'), { value: 'private' });
    rejected(symbol, selection(symbol));
    const sparse = event();
    Reflect.deleteProperty(sparse.redacted_details.report.metrics, '0');
    rejected(sparse, selection(sparse));
    const extraArrayKey = event();
    Object.assign(extraArrayKey.redacted_details.report.metrics, { credential: 'private' });
    rejected(extraArrayKey, selection(extraArrayKey));
    const poison = event();
    Object.defineProperty(poison.redacted_details, '__proto__', { value: {}, enumerable: true });
    rejected(poison, selection(poison));
    rejected(JSON.stringify(event())); // Input is a decoded DB envelope, not an ambiguous JSON-text parser.
  });
  it('retains every producer diagnostic category without admitting it as a metric', () => {
    for (const category of RECONCILIATION_CATEGORIES) {
      const row = event(createReconciliationReport([], [{ category, code: 'ROW_MISMATCH' }]));
      expect(projected(row).report.diagnostics).toEqual([{ category, code: 'ROW_MISMATCH' }]);
    }
  });
  it('retains every report-v1 allowlisted diagnostic code with consistent envelope nulls', () => {
    const codes = [
      'INVALID_DIAGNOSTIC', 'INVALID_MANIFEST', 'INVALID_CURRENT_MANIFEST', 'UNSUPPORTED_HISTORY', 'BINDING_MISMATCH',
      'SOURCE_MUTATION', 'ROW_MISMATCH', 'CARDINALITY_MISMATCH', 'CHECKPOINT_INCOMPLETE',
      'HISTORY_ORDER', 'OPERATIONAL_PROJECTION', 'DATABASE_READ_FAILED', 'INVALID_COMPARISON_INSTANT', 'DATABASE_WRITE_FAILED',
    ];
    for (const code of codes) {
      const row = event(createReconciliationReport([], [{ category: 'INTEGRITY', code }]));
      if (code === 'INVALID_COMPARISON_INSTANT') row.redacted_details.comparisonInstant = null;
      if (code === 'INVALID_CURRENT_MANIFEST') row.redacted_details.currentManifestDigest = null;
      seal(row);
      expect(projected(row).report.diagnostics[0].code).toBe(code);
    }
  });
  it('rejects structurally valid metric/diagnostic/tenant/job tampering that retains the old digest', () => {
    const changedMetric = event();
    Object.assign(changedMetric.redacted_details.report.metrics[0], { expected: '42', actual: '42' });
    rejected(changedMetric, selection(changedMetric));
    const changedDiagnostic = event(createReconciliationReport([], [{ category: 'STUDENTS', code: 'ROW_MISMATCH' }]));
    changedDiagnostic.redacted_details.report.diagnostics[0].code = 'CARDINALITY_MISMATCH';
    rejected(changedDiagnostic, selection(changedDiagnostic));
    const changedTenant = event();
    changedTenant.tenant_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    rejected(changedTenant, selection(changedTenant));
    const changedJob = event();
    changedJob.job_id = 'other valid opaque job';
    rejected(changedJob, selection(changedJob));
  });
  it('accepts null-prototype plain JSON but not inherited report fields or missing event columns', () => {
    const row = event();
    Object.setPrototypeOf(row, null);
    Object.setPrototypeOf(row.redacted_details, null);
    expect(projected(row).report.status).toBe('MATCHED_PREFLIGHT');
    for (const key of Object.keys(event())) {
      const missing = event();
      const selected = selection(missing);
      Reflect.deleteProperty(missing, key);
      rejected(missing, selected);
    }
    const inherited = event();
    Object.setPrototypeOf(inherited.redacted_details.report, { privateField: 'not JSON' });
    rejected(inherited, selection(inherited));
  });
  it('does not mutate frozen input or retain mutable input references', () => {
    const row = event();
    const before = canonicalJson(row);
    function freeze(value: unknown): void {
      if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    }
    freeze(row);
    const dto = projected(row);
    expect(canonicalJson(row)).toBe(before);
    expect(dto.report.metrics).not.toBe(row.redacted_details.report.metrics);
    const mutable = event();
    const snapshot = projected(mutable);
    mutable.redacted_details.report.metrics[0].expected = '999';
    expect(snapshot.report.metrics[0].expected).toBe('0');
  });
});
