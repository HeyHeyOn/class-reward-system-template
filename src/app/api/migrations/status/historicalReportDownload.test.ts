// @vitest-environment node
import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as projector from './preflightReportProjection';

// Synthetic decoded archives only. Do not import producers, readers, adapters,
// DB configuration or shared fixtures (including their transitive I/O graph).
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'archived job:1';
const INSTANT = '2026-09-01T12:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const HASHED_ROW = 'c'.repeat(64);
const PRIVATE = 'synthetic-private-source-cookie-DO-NOT-ECHO';
const CATEGORIES = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
];
type Diagnostic = { category: string; code: string; rowReference?: string };
const FAILURE = {
  kind: 'UNAVAILABLE', reasonCode: 'INVALID_ARCHIVAL_REPORT', readOnly: true,
  scope: 'HISTORICAL_ONLY', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
};

// Fixture-only canonical encoding of inert JSON, not a replacement validator.
// Production canonical conformance is the existing projector suite's contract.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Fixture must be JSON');
  return encoded;
}
function archive() {
  return seal({
    tenant_id: TENANT, job_id: JOB, event_id: '', event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT',
    operation_id: null, actor_user_id: null, entity_type: null, entity_id: null,
    redacted_details: {
      report: {
        reportVersion: 1, phase: 'PREFLIGHT', status: 'MATCHED_PREFLIGHT', authority: 'SHEETS_AND_REDIS',
        cutoverAllowed: false,
        metrics: CATEGORIES.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
        diagnostics: [] as Diagnostic[], omittedDiagnostics: 0,
      },
      comparisonInstant: INSTANT as string | null, manifestDigest: DIGEST,
      currentManifestDigest: DIGEST as string | null, sourceFingerprint: 'b'.repeat(64),
      freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
    },
  });
}
type Archive = ReturnType<typeof archive>;
function seal<T extends { tenant_id: string; job_id: string; event_id: string; redacted_details: unknown }>(row: T): T {
  row.event_id = `reconciliation:${createHash('sha256')
    .update(canonical([row.tenant_id, row.job_id, row.redacted_details]), 'utf8').digest('hex')}`;
  return row;
}
function selection(row: Archive) {
  return { tenantId: row.tenant_id, migrationJobId: row.job_id, reportId: row.event_id };
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]),
  );
  return value;
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}

let formatHistoricalReportDownload: typeof import('./historicalReportDownload').formatHistoricalReportDownload;
let projectSpy: MockInstance<typeof projector.projectPreflightReport>;
const noNetwork = vi.fn(() => { throw new Error('Network forbidden'); });

// Vite raw module imports avoid test-authored filesystem reads. Inspect before
// loading the formatter so a new DB/reader/producer import fails the suite first.
// This is a regression tripwire for this tiny module, not a JavaScript sandbox.
const sources = import.meta.glob(['./historicalReportDownload.ts', './preflightReportProjection.ts'],
  { query: '?raw', import: 'default', eager: true });
beforeAll(async () => {
  const source = sources['./historicalReportDownload.ts'];
  if (typeof source !== 'string') throw new Error('Expected raw formatter source');
  const ast = ts.createSourceFile('historicalReportDownload.ts', source, ts.ScriptTarget.Latest, true);
  const imports = ast.statements.filter(ts.isImportDeclaration);
  expect(imports.map(node => (node.moduleSpecifier as ts.StringLiteral).text))
    .toEqual(['./preflightReportProjection']);
  const forbidden = new Set(['process', 'globalThis', 'window', 'document', 'fetch', 'require',
    'eval', 'Function', 'Date', 'Math', 'setTimeout', 'setInterval', 'WebSocket', 'XMLHttpRequest']);
  function inspect(node: ts.Node): void {
    if (ts.isIdentifier(node)) expect(forbidden.has(node.text), node.text).toBe(false);
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      const reportDigestSlice = ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'slice'
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === 'reportId';
      expect(['projectPreflightReport', 'JSON.stringify'].includes(callee) || reportDigestSlice, callee).toBe(true);
    }
    expect(ts.isNewExpression(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)).toBe(false);
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
  const projectionSource = sources['./preflightReportProjection.ts'];
  if (typeof projectionSource !== 'string') throw new Error('Expected raw projector source');
  const projectionAst = ts.createSourceFile('preflightReportProjection.ts', projectionSource, ts.ScriptTarget.Latest, true);
  expect(projectionAst.statements.filter(ts.isImportDeclaration)
    .map(node => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual(['node:crypto', 'node:util']);
  ({ formatHistoricalReportDownload } = await import('./historicalReportDownload'));
});
beforeEach(() => {
  projectSpy = vi.spyOn(projector, 'projectPreflightReport'); // Call through: no fake validation.
  noNetwork.mockClear();
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(() => {
  expect(noNetwork).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function format(envelope: unknown, selected: unknown) {
  const count = projectSpy.mock.calls.length;
  const result = formatHistoricalReportDownload(envelope, selected);
  expect(projectSpy.mock.calls).toHaveLength(count + 1);
  const call = projectSpy.mock.calls[count];
  expect(call[0]).toBe(envelope);
  expect(call[1]).toBe(selected);
  return result;
}
function download(row: Archive) {
  const result = format(row, selection(row));
  expect(result.kind).toBe('HISTORICAL_REPORT_DOWNLOAD');
  if (result.kind !== 'HISTORICAL_REPORT_DOWNLOAD') throw new Error('Expected historical descriptor');
  return result;
}
function decoded(row: Archive) {
  const descriptor = download(row);
  const bytes = new TextEncoder().encode(descriptor.body);
  // Exercise actual UTF-8 bytes, not just the in-memory projection object.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  expect(text).toBe(descriptor.body);
  expect(bytes.byteLength).toBeLessThanOrEqual(65_536);
  return { descriptor, bytes, projection: JSON.parse(text) as projector.PreflightReportProjection };
}
function rejected(envelope: unknown, selected: unknown) {
  const result = format(envelope, selected);
  expect(result).toEqual(FAILURE); // Exact keys: no descriptor, body, raw input or exception.
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
}
function resealedRejection(edit: (row: Archive) => void) {
  const row = archive();
  edit(row);
  seal(row);
  rejected(row, selection(row));
}

describe('pure HISTORICAL_ONLY JSON download descriptor (not a transport or authority)', () => {
  it('encodes only the real admitted projection and retains every historical qualifier for MATCHED', () => {
    const row = archive();
    const expected = projector.projectPreflightReport(row, selection(row));
    expect(expected.kind).toBe('HISTORICAL_REPORT');
    if (expected.kind !== 'HISTORICAL_REPORT') throw new Error('Invalid synthetic fixture');
    const { descriptor, bytes, projection } = decoded(row);
    expect(descriptor).toEqual({
      kind: 'HISTORICAL_REPORT_DOWNLOAD',
      filename: `historical-preflight-${row.event_id.slice('reconciliation:'.length)}.json`,
      mediaType: 'application/json', encoding: 'utf-8', body: `${JSON.stringify(expected.projection)}\n`,
    });
    expect(bytes).toEqual(new TextEncoder().encode(`${JSON.stringify(expected.projection)}\n`));
    expect(projection).toEqual(expected.projection);
    expect(projection).toMatchObject({
      projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
      eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
      currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
      comparisonInstant: INSTANT, freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
      report: { status: 'MATCHED_PREFLIGHT' },
    });
    for (const privateField of [TENANT, JOB, 'SHEETS_AND_REDIS', 'tenant_id', 'redacted_details', 'actor_user_id']) {
      expect(descriptor.body).not.toContain(privateField);
    }
  });

  it('is byte-identical across repeat calls and input key insertion order without mutation', () => {
    const row = archive();
    const selected = selection(row);
    const before = canonical(row);
    freeze(row);
    freeze(selected);
    const first = download(row);
    expect(format(row, selected)).toEqual(first);
    expect(format(reverseKeys(row), reverseKeys(selected))).toEqual(first);
    expect(new TextEncoder().encode(download(row).body)).toEqual(new TextEncoder().encode(first.body));
    expect(canonical(row)).toBe(before);
    const mutable = archive();
    const snapshot = download(mutable);
    mutable.redacted_details.report.metrics[0].expected = '42';
    expect(snapshot).toEqual(first);
  });

  it.each(['BALANCES', 'TRANSACTION_DELTA', 'CANCELLATION_DELTA'])(
    'preserves %s exact signed 30-digit values and 31-digit deltas in encoded bytes', category => {
      const limit = BigInt(10) ** BigInt(30) - BigInt(1);
      for (const [expected, actual] of [[-limit, limit], [limit, -limit], [-limit, -limit]]) {
        const row = archive();
        const metric = row.redacted_details.report.metrics.find(metric => metric.category === category)!;
        Object.assign(metric, { expected: expected.toString(), actual: actual.toString(),
          delta: (actual - expected).toString(), status: actual === expected ? 'MATCH' : 'MISMATCH' });
        row.redacted_details.report.status = actual === expected ? 'MATCHED_PREFLIGHT' : 'BLOCKED';
        seal(row);
        const { projection, descriptor } = decoded(row);
        expect(projection.report.metrics.find(metric => metric.category === category)).toEqual(metric);
        for (const field of ['expected', 'actual', 'delta'] as const) {
          expect(descriptor.body).toContain(`"${field}":"${metric[field]}"`);
        }
      }
    },
  );

  it('preserves 100 duplicate hashed diagnostics, empty metrics and omitted counts', () => {
    const row = archive();
    Object.assign(row.redacted_details.report, {
      status: 'BLOCKED', metrics: [], omittedDiagnostics: 50,
      diagnostics: Array.from({ length: 100 }, () => ({ category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: HASHED_ROW })),
    });
    seal(row);
    const { projection } = decoded(row);
    expect(projection.report).toEqual({
      reportVersion: 1, phase: 'PREFLIGHT', status: 'BLOCKED', metrics: [],
      diagnostics: row.redacted_details.report.diagnostics, omittedDiagnostics: 50,
    });
    expect(projection.report.diagnostics).toHaveLength(100);
  });

  it('preserves explicit null evidence and its retained diagnostics without inventing a clock or manifest', () => {
    const row = archive();
    Object.assign(row.redacted_details.report, { status: 'BLOCKED', metrics: [], diagnostics: [
      { category: 'RECURRENCE', code: 'INVALID_COMPARISON_INSTANT' },
      { category: 'SOURCES', code: 'INVALID_CURRENT_MANIFEST' },
    ] });
    row.redacted_details.comparisonInstant = null;
    row.redacted_details.currentManifestDigest = null;
    seal(row);
    const { projection } = decoded(row);
    expect(projection.comparisonInstant).toBeNull();
    expect(projection.currentManifestDigest).toBeNull();
    expect(projection.report.diagnostics).toEqual(row.redacted_details.report.diagnostics);
  });

  it('does not turn a coherently rehashed archive into source provenance or current approval', () => {
    const row = archive();
    row.redacted_details.manifestDigest = row.redacted_details.currentManifestDigest = 'd'.repeat(64);
    row.redacted_details.sourceFingerprint = 'e'.repeat(64);
    seal(row);
    expect(decoded(row).projection).toMatchObject({ verification: 'INTEGRITY_ONLY', originalBinding: 'NOT_VERIFIED',
      currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false });
  });

  it('derives a safe ASCII filename only from the admitted digest, not opaque job/source text', () => {
    const row = archive();
    row.job_id = `../../과거/"job"\\😀;${PRIVATE}.json`;
    seal(row);
    const { descriptor } = decoded(row);
    expect(descriptor.filename).toBe(`historical-preflight-${row.event_id.slice('reconciliation:'.length)}.json`);
    expect(descriptor.filename).toMatch(/^historical-preflight-[a-f0-9]{64}\.json$/);
    expect(descriptor.filename).not.toMatch(/[\r\n/\\:]/);
    expect(JSON.stringify(descriptor)).not.toContain(PRIVATE);
    expect(JSON.stringify(descriptor)).not.toContain(TENANT);
    for (const job of [`job\r\n${PRIVATE}`, `job\u0000${PRIVATE}`]) {
      row.job_id = job;
      seal(row);
      rejected(row, selection(row));
    }
  });

  it.each(['tenantId', 'migrationJobId', 'reportId'] as const)('rejects valid-looking misbound %s', key => {
    const row = archive();
    const alternatives = { tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      migrationJobId: 'another job', reportId: `reconciliation:${'f'.repeat(64)}` };
    rejected(row, { ...selection(row), [key]: alternatives[key] });
  });
  it('rejects raw JSON text, caller projections and extra binding/filename claims', () => {
    const row = archive();
    const selected = selection(row);
    const projected = projector.projectPreflightReport(row, selected);
    rejected(JSON.stringify(row), selected);
    rejected(projected, selected);
    if (projected.kind === 'HISTORICAL_REPORT') rejected(projected.projection, selected);
    for (const claims of [{ filename: `../${PRIVATE}` }, { originalBinding: 'VERIFIED' }, { role: 'OWNER' }]) {
      rejected(row, { ...selected, ...claims });
    }
    rejected(row, null);
  });

  it.each(['tenant_id', 'job_id', 'event_id', 'event_type'] as const)('rejects tampered envelope %s', key => {
    const row = archive();
    const selected = selection(row);
    row[key] = PRIVATE;
    rejected(row, selected);
  });
  it.each(['comparisonInstant', 'manifestDigest', 'currentManifestDigest', 'sourceFingerprint'] as const)(
    'rejects %s tampering without rehash', key => {
      const row = archive();
      row.redacted_details[key] = key === 'comparisonInstant' ? '2026-09-02T12:00:00.000Z' : 'd'.repeat(64);
      rejected(row, selection(row));
    },
  );
  it('rejects valid-looking metric tampering with an old digest and invalid arithmetic even after rehash', () => {
    const row = archive();
    Object.assign(row.redacted_details.report.metrics[0], { expected: '42', actual: '42' });
    rejected(row, selection(row));
    resealedRejection(row => { row.redacted_details.report.metrics[0].delta = '1'; });
    resealedRejection(row => { row.redacted_details.report.metrics = []; });
  });
  it.each(['expected', 'actual', 'delta'] as const)('rejects noncanonical or numeric %s, never rounding it', key => {
    for (const value of [0, null, '-0', '+1', '01', '1e3', '1.0', '9'.repeat(32)]) {
      resealedRejection(row => { Object.assign(row.redacted_details.report.metrics[0], { [key]: value }); });
    }
  });
  it.each(['event', 'details', 'report', 'metric', 'diagnostic'])('rejects unexpected raw fields at %s', target => {
    resealedRejection(row => {
      row.redacted_details.report.status = 'BLOCKED';
      row.redacted_details.report.diagnostics = [{ category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: HASHED_ROW }];
      const destinations: Record<string, object> = { event: row, details: row.redacted_details,
        report: row.redacted_details.report, metric: row.redacted_details.report.metrics[0],
        diagnostic: row.redacted_details.report.diagnostics[0] };
      Object.assign(destinations[target], { credential: PRIVATE });
    });
  });
  it('rejects plaintext row references, unknown codes and claimed cutover authority even after rehash', () => {
    for (const diagnostic of [{ category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: PRIVATE },
      { category: 'STUDENTS', code: PRIVATE }]) {
      resealedRejection(row => { Object.assign(row.redacted_details.report, { status: 'BLOCKED', diagnostics: [diagnostic] }); });
    }
    resealedRejection(row => { row.redacted_details.report.cutoverAllowed = true; });
    resealedRejection(row => { row.redacted_details.report.authority = 'POSTGRES'; });
  });

  it('rejects oversized aggregate encoded bytes, strings, nodes, depth and arrays without a descriptor', () => {
    const selected = selection(archive());
    const overBytes = Array.from({ length: 100 }, () => '한'.repeat(1024));
    expect(new TextEncoder().encode(JSON.stringify(overBytes)).byteLength).toBeGreaterThan(65_536);
    let deep: unknown = null;
    for (let index = 0; index < 20; index++) deep = { nested: deep };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const payload of [overBytes, 'x'.repeat(65_537), deep, cyclic, Array(101),
      Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 0))]) {
      const row = archive();
      Object.assign(row.redacted_details, { report: payload });
      rejected(row, selected);
    }
    resealedRejection(row => { Object.assign(row.redacted_details.report, { status: 'BLOCKED',
      diagnostics: Array.from({ length: 101 }, () => ({ category: 'STUDENTS', code: 'ROW_MISMATCH' })) }); });
    resealedRejection(row => { row.redacted_details.report.omittedDiagnostics = 1; });
  });

  it('rejects non-JSON graphs, accessors, toJSON and proxies without executing or leaking them', () => {
    const selected = selection(archive());
    const trap = vi.fn(() => { throw new Error(PRIVATE); });
    const getter = archive();
    Object.defineProperty(getter, 'redacted_details', { get: trap, enumerable: true });
    rejected(getter, selected);
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    rejected(proxy, selected);
    rejected(archive(), proxy);
    rejected(Object.assign(archive(), { toJSON: trap }), selected);
    for (const input of [null, undefined, BigInt(1), Symbol(PRIVATE), trap, new Date(INSTANT)]) {
      rejected(input, selected);
    }
    const hidden = archive();
    Object.defineProperty(hidden, 'credential', { value: PRIVATE, enumerable: false });
    rejected(hidden, selected);
    expect(trap).not.toHaveBeenCalled();
  });
});
