// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { QueryConfig } from 'pg';
import { NextRequest } from 'next/server';
import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { AppRouteHandlers } from 'next/dist/server/route-modules/app-route/module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), config: vi.fn() }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(), Pool: class {
  connect = mocks.connect;
  on() {}
} }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: mocks.config }));
import * as reader from '../../readPreflightReport';
import { projectPreflightReport, type PreflightReportProjection } from '../../preflightReportProjection';
import * as route from './route';

// Isolated transport checks: real reader, cookie verifier and projection, but
// ALL PostgreSQL results are test doubles. No real PG, Next server or browser.
// No producer/import/freeze/cutover code is invoked to make these archives.
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-private-subject';
const SECRET = 'synthetic-route-test-secret-not-a-real-credential';
const JOB = 'historical/과거 job:%20';
const PRIVATE = 'private-source-row private-sheet-id private-refresh-token postgresql://private-password';
const METHODS = ['GET', 'HEAD'] as const;
type ReadMethod = typeof METHODS[number];
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
const reply = (rows: Record<string, unknown>[], fields: [string, number][]): Reply => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
const tenant = { id: TENANT, slug: 'alpha', display_name: 'private-class-name', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const member = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
const categories: PreflightReportProjection['report']['metrics'][number]['category'][] = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
];
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}
function archive(status: 'BLOCKED' | 'MATCHED_PREFLIGHT' = 'BLOCKED') {
  const details = {
    report: { reportVersion: 1, phase: 'PREFLIGHT', status, authority: 'SHEETS_AND_REDIS', cutoverAllowed: false,
      metrics: status === 'BLOCKED' ? [] : categories.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
      diagnostics: status === 'BLOCKED' ? [{ category: 'INTEGRITY', code: 'BINDING_MISMATCH' }] : [], omittedDiagnostics: 0 },
    comparisonInstant: '2026-09-01T12:00:00.000Z', manifestDigest: 'a'.repeat(64),
    currentManifestDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
  };
  return { tenant_id: TENANT, job_id: JOB,
    event_id: `reconciliation:${createHash('sha256').update(canonical([TENANT, JOB, details])).digest('hex')}`,
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
    entity_type: null, entity_id: null, redacted_details: details };
}
function cookie() {
  const iv = Buffer.alloc(12, 7); // Synthetic test-only IV/key, never production.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ subject: SUBJECT, email: 'private@example.test', issuedAt: Date.now() })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${bytes.toString('base64url')}`;
}
let event: ReturnType<typeof archive>;
let reportReply: Reply;
let membershipReply: Reply;
let client: EventEmitter & {
  query: ReturnType<typeof vi.fn<(config: QueryConfig) => Promise<Reply>>>;
  release: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
const reportCalls = () => client.query.mock.calls.filter(([config]) => config.text.includes('public.audit_events'));
function request(method: string = 'GET', options: { slug?: string; query?: string; cookie?: string } = {}) {
  return new Request(`https://example.test/api/migrations/status/${options.slug ?? 'alpha'}/preflight?${options.query ?? `jobId=${encodeURIComponent(JOB)}&reportId=${event.event_id}`}`, {
    method, headers: { cookie: options.cookie ?? cookie(), 'x-tenant-id': OTHER, 'x-tenant-slug': 'beta',
      'x-role': 'OWNER', 'x-cutover-allowed': 'true', origin: 'https://untrusted.example.test',
      'if-none-match': '*', 'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT' },
  });
}
const invoke = (method: ReadMethod, input = request(method), slug = 'alpha') =>
  route[method](input, { params: Promise.resolve({ slug }) });
function assertResponse(value: unknown): asserts value is Response {
  expect(value).toBeInstanceOf(Response);
}
function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('content-type')).toBe('application/json');
  for (const name of ['etag', 'last-modified', 'set-cookie', 'location', 'access-control-allow-origin', 'access-control-allow-credentials']) {
    expect(response.headers.get(name)).toBeNull();
  }
}
async function expectResponse(response: Response, method: ReadMethod, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expectPrivate(response);
  const text = await response.text();
  expect(JSON.stringify([...response.headers])).not.toContain('private-');
  if (method === 'HEAD') {
    expect(response.body).toBeNull();
    expect(text).toBe('');
  } else {
    expect(JSON.parse(text)).toEqual(body);
    for (const value of [PRIVATE, TENANT, OTHER, USER, MEMBER, SUBJECT, JOB, tenant.display_name, 'private@example.test', 'SHEETS_AND_REDIS']) {
      expect(text).not.toContain(value);
    }
  }
}
beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  event = archive();
  reportReply = reply([{ found: true, oversized: false, envelope_text: JSON.stringify(event) }], REPORT_FIELDS);
  membershipReply = reply([member], MEMBER_FIELDS);
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: QueryConfig): Promise<Reply> => {
      if (config.text.includes('public.audit_events')) return reportReply;
      if (config.text.includes('public.platform_find_membership')) return membershipReply;
      if (config.text.includes('public.platform_find_tenant')) return reply([tenant], TENANT_FIELDS);
      return reply([], []);
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  mocks.connect.mockReset().mockResolvedValue(client);
  mocks.config.mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/fixture', directDatabaseUrl: 'must-not-use' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  expect(client.query.mock.calls.every(([config]) =>
    /^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/.test(config.text.trimStart()))).toBe(true);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(METHODS)('historical preflight %s transport with mocked PG', method => {
  it.each(['OWNER', 'ADMIN'])('authenticates %s and returns only the historical projection', async role => {
    membershipReply = reply([{ ...member, role }], MEMBER_FIELDS);
    const projected = projectPreflightReport(event, { tenantId: TENANT, migrationJobId: JOB, reportId: event.event_id });
    expect(projected.kind).toBe('HISTORICAL_REPORT');
    if (projected.kind !== 'HISTORICAL_REPORT') throw new Error('Invalid synthetic archive');
    const input = request(method);
    const read = vi.spyOn(reader, 'readPreflightReport');
    await expectResponse(await invoke(method, input), method, 200, projected.projection);
    expect(read).toHaveBeenCalledExactlyOnceWith('alpha', input);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(reportCalls()).toHaveLength(1);
    expect(reportCalls()[0][0].values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]);
    expect(client.query.mock.calls.at(-1)?.[0].text).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it('never promotes a MATCHED_PREFLIGHT archive to live preflight or cutover authority', async () => {
    event = archive('MATCHED_PREFLIGHT');
    reportReply = reply([{ found: true, oversized: false, envelope_text: JSON.stringify(event) }], REPORT_FIELDS);
    const response = await invoke(method);
    expect(response.status).toBe(200);
    expectPrivate(response);
    if (method === 'HEAD') {
      expect(response.body).toBeNull();
      expect(await response.text()).toBe('');
    } else {
      expect(await response.json()).toMatchObject({ scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
        originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED',
        operationalAuthority: 'UNKNOWN', cutoverAllowed: false, freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
        report: { status: 'MATCHED_PREFLIGHT' } });
    }
  });

  it.each(['', 'class_store_tenant_admin=forged', 'class_store_google_auth=invalid'])('refuses unauthenticated cookies (%s) before PG', async value => {
    await expectResponse(await invoke(method, request(method, { cookie: value })), method, 401, { error: 'AUTHENTICATION_REQUIRED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'absent', rows: [] },
    { label: 'cross-tenant', rows: [{ ...member, tenant_id: OTHER }] },
    { label: 'cross-subject', rows: [{ ...member, google_subject: 'someone-else' }] },
    { label: 'unsupported role', rows: [{ ...member, role: 'STUDENT' }] },
  ])(
    'refuses $label membership', async ({ rows }) => {
      membershipReply = reply(rows, MEMBER_FIELDS);
      await expectResponse(await invoke(method), method, 403, { error: 'ACCESS_DENIED' });
      expect(reportCalls()).toHaveLength(0);
    },
  );

  it('rechecks the canonical path tenant despite forged tenant headers', async () => {
    client.query.mockImplementation(async (config: QueryConfig) => {
      if (config.text.includes('public.platform_find_tenant')) {
        expect(config.values).toEqual(['beta']);
        return reply([{ ...tenant, id: OTHER, slug: 'beta' }], TENANT_FIELDS);
      }
      if (config.text.includes('public.platform_find_membership')) {
        expect(config.values).toEqual([OTHER, SUBJECT]);
        return reply([], MEMBER_FIELDS);
      }
      return reply([], []);
    });
    await expectResponse(await invoke(method, request(method, { slug: 'beta' }), 'beta'), method, 403, { error: 'ACCESS_DENIED' });
    expect(reportCalls()).toHaveLength(0);
  });

  it.each(['missing report', 'foreign report', 'foreign job'])('returns uniform 404 for %s, without echoing selectors', async label => {
    reportReply = reply([{ found: false, oversized: false, envelope_text: null }], REPORT_FIELDS);
    const job = label === 'foreign job' ? 'private-foreign-job' : JOB;
    const report = label === 'foreign report' ? `reconciliation:${'f'.repeat(64)}` : event.event_id;
    const input = request(method, { query: `jobId=${encodeURIComponent(job)}&reportId=${report}` });
    await expectResponse(await invoke(method, input), method, 404, { error: 'PREFLIGHT_REPORT_NOT_FOUND' });
    expect(reportCalls()).toHaveLength(1);
    expect(reportCalls()[0][0].values?.slice(0, 3)).toEqual([TENANT, SUBJECT, job]);
  });

  it.each(['', `jobId=x&reportId=${'a'.repeat(64)}`, `jobId=x&reportId=${'r'.repeat(79)}`,
    `jobId=%ZZ&reportId=${'a'.repeat(64)}`, 'jobId=x&jobId=y', 'cutoverAllowed=true'])('maps rejected selectors to 400: %s', async query => {
    await expectResponse(await invoke(method, request(method, { query })), method, 400, { error: 'INVALID_PREFLIGHT_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('does not repair a URL/route-param mismatch', async () => {
    await expectResponse(await invoke(method, request(method, { slug: 'beta' })), method, 400, { error: 'INVALID_PREFLIGHT_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['SQL size gate', { found: true, oversized: true, envelope_text: null }],
    ['driver TEXT limit', { found: true, oversized: false, envelope_text: 'x'.repeat(65537) }],
    ['malformed archive', { found: true, oversized: false, envelope_text: PRIVATE }],
  ] as const)('maps %s to generic 503, never 413 or raw details', async (_label, row) => {
    reportReply = reply([row], REPORT_FIELDS);
    await expectResponse(await invoke(method), method, 503, { error: 'PREFLIGHT_REPORT_UNAVAILABLE' });
    expect(reportCalls()).toHaveLength(1);
  });

  it('refuses membership revoked at the final report read', async () => {
    reportReply = reply([], REPORT_FIELDS);
    await expectResponse(await invoke(method), method, 403, { error: 'ACCESS_DENIED' });
  });

  it.each(['connection', 'query', 'reader', 'params'] as const)('redacts %s failures without retrying or logging', async point => {
    if (point === 'connection') mocks.connect.mockRejectedValueOnce(new Error(PRIVATE));
    if (point === 'query') client.query.mockRejectedValueOnce(new Error(PRIVATE));
    if (point === 'reader') vi.spyOn(reader, 'readPreflightReport').mockRejectedValueOnce(new Error(PRIVATE));
    const response = point === 'params'
      ? await route[method](request(method), { params: Promise.reject(new Error(PRIVATE)) })
      : await invoke(method);
    await expectResponse(response, method, 503, { error: 'PREFLIGHT_REPORT_UNAVAILABLE' });
    expect(mocks.connect).toHaveBeenCalledTimes(point === 'params' || point === 'reader' ? 0 : 1);
  });

  it('does not cache success across membership revocation', async () => {
    expect((await invoke(method)).status).toBe(200);
    membershipReply = reply([], MEMBER_FIELDS);
    await expectResponse(await invoke(method), method, 403, { error: 'ACCESS_DENIED' });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it.each(['UNAUTHENTICATED', 'FORBIDDEN', 'INVALID_REQUEST', 'NOT_FOUND', 'UNAVAILABLE'] as const)('never spreads extra reader fields for %s', async kind => {
    const expected = {
      UNAUTHENTICATED: [401, 'AUTHENTICATION_REQUIRED'], FORBIDDEN: [403, 'ACCESS_DENIED'],
      INVALID_REQUEST: [400, 'INVALID_PREFLIGHT_REQUEST'], NOT_FOUND: [404, 'PREFLIGHT_REPORT_NOT_FOUND'],
      UNAVAILABLE: [503, 'PREFLIGHT_REPORT_UNAVAILABLE'],
    } as const;
    const result = { kind, details: PRIVATE, cutoverAllowed: true };
    vi.spyOn(reader, 'readPreflightReport').mockResolvedValueOnce(result);
    const [status, error] = expected[kind];
    await expectResponse(await invoke(method), method, status, { error });
  });

  it('fails closed on an unexpected reader kind', async () => {
    vi.spyOn(reader, 'readPreflightReport').mockResolvedValueOnce({ kind: 'ACTIVE', details: PRIVATE } as unknown as reader.PreflightReportReadResult);
    await expectResponse(await invoke(method), method, 503, { error: 'PREFLIGHT_REPORT_UNAVAILABLE' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses direct %s invocation before params/auth/read', async wrongMethod => {
    const params = vi.fn(() => { throw new Error(PRIVATE); });
    const read = vi.spyOn(reader, 'readPreflightReport');
    const response = await route[method](request(wrongMethod), { get params(): Promise<{ slug: string }> { return params(); } });
    await expectResponse(response, method, 405, { error: 'METHOD_NOT_ALLOWED' });
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(params).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('explicit HEAD and installed Next.js method dispatch (not a full server)', () => {
  it('exports only GET/HEAD plus dynamic Node configuration', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'HEAD', 'dynamic', 'runtime']);
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
    expect(autoImplementMethods(route as unknown as AppRouteHandlers).HEAD).toBe(route.HEAD);
  });

  it('HEAD performs authorization but does not serialize a report', async () => {
    const projected = projectPreflightReport(event, { tenantId: TENANT, migrationJobId: JOB, reportId: event.event_id });
    if (projected.kind !== 'HISTORICAL_REPORT') throw new Error('Invalid synthetic archive');
    const toJSON = vi.fn(() => { throw new Error(PRIVATE); });
    const projection = { ...projected.projection, toJSON };
    vi.spyOn(reader, 'readPreflightReport').mockResolvedValueOnce({ ...projected, projection });
    await expectResponse(await invoke('HEAD'), 'HEAD', 200, null);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('Next refuses unsupported %s without reader invocation', async method => {
    const read = vi.spyOn(reader, 'readPreflightReport');
    const methods = autoImplementMethods(route as unknown as AppRouteHandlers);
    const response = await methods[method](new NextRequest(request(method)), { params: Promise.resolve({ slug: 'alpha' }) });
    assertResponse(response);
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('');
    expect(read).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('Next OPTIONS advertises only reads and grants no CORS access', async () => {
    const methods = autoImplementMethods(route as unknown as AppRouteHandlers);
    const response = await methods.OPTIONS(new NextRequest(request('OPTIONS')), {});
    assertResponse(response);
    expect(response.status).toBe(204);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
