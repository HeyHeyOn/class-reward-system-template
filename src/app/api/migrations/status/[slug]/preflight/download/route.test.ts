// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';
import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { AppRouteHandlers } from 'next/dist/server/route-modules/app-route/module';
import type { QueryConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const transport = vi.hoisted(() => ({ connect: vi.fn(), config: vi.fn(), provider: vi.fn() }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(), Pool: class {
  connect = transport.connect;
  on() {}
} }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: transport.config }));
vi.mock('googleapis', () => ({ google: new Proxy({}, { get() {
  transport.provider(); throw new Error('External provider forbidden');
} }) }));
import * as reader from '../../../readPreflightReport';
import * as adapter from '../../../readHistoricalReportDownload';
import { formatHistoricalReportDownload } from '../../../historicalReportDownload';
import * as inline from '../route';
import * as route from './route';

// Actual route -> adapter -> reader -> local AES-GCM verifier/authorization/
// projector. The pg transport below is MOCKED, not SQL/HTTP/real PG evidence.
// The SQL companion suite executes PGlite. Neither exercises a Next socket,
// proxy/CDN, Google login flow, browser download or operational/private source.
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-route-subject';
const SECRET = 'synthetic-route-secret-not-a-real-credential';
const PRIVATE = 'synthetic-private-source-cookie-refresh-token-DO-NOT-ECHO';
const JOB = 'historical/과거 job:%20';
const PATH = '/api/migrations/status/alpha/preflight/download';
const METHODS = ['GET', 'HEAD'] as const;
type Method = typeof METHODS[number];
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store', 'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer', vary: 'Cookie', 'x-content-type-options': 'nosniff',
};
const CATEGORIES = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS', 'COMPLETIONS',
  'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK', 'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA',
  'CANCELLATIONS', 'CANCELLATION_AMOUNT', 'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS',
  'TOMBSTONES', 'ORPHANED_CLAIMS', 'RECURRENCE',
];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Invalid fixture');
  return text;
}
function archive(status: 'BLOCKED' | 'MATCHED_PREFLIGHT' = 'MATCHED_PREFLIGHT') {
  const details = {
    report: { reportVersion: 1, phase: 'PREFLIGHT', status, authority: 'SHEETS_AND_REDIS', cutoverAllowed: false,
      metrics: status === 'BLOCKED' ? [] : CATEGORIES.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
      diagnostics: status === 'BLOCKED' ? [{ category: 'INTEGRITY', code: 'BINDING_MISMATCH' }] : [], omittedDiagnostics: 0 },
    comparisonInstant: '2026-09-01T12:00:00.000Z', manifestDigest: 'a'.repeat(64), currentManifestDigest: 'a'.repeat(64),
    sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
  };
  return { tenant_id: TENANT, job_id: JOB,
    event_id: `reconciliation:${createHash('sha256').update(canonical([TENANT, JOB, details])).digest('hex')}`,
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
    entity_type: null, entity_id: null, redacted_details: details };
}
function cookie(issuedAt = Date.now(), subject = SUBJECT) {
  const iv = Buffer.alloc(12, 17); // Deterministic synthetic fixture only.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function tamperedCookie() {
  const parts = cookie().split('.');
  const tag = Buffer.from(parts[2], 'base64url');
  tag[0] ^= 1;
  parts[2] = tag.toString('base64url');
  return parts.join('.');
}
let event: ReturnType<typeof archive>;
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
const reply = (rows: Record<string, unknown>[], fields: [string, number][]): Reply => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
let tenant: Record<string, unknown> | null;
let member: Record<string, unknown> | null;
let report: Reply;
let queries: QueryConfig[];
let hook: ((config: QueryConfig) => void) | undefined;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
function install(status: 'BLOCKED' | 'MATCHED_PREFLIGHT' = 'MATCHED_PREFLIGHT') {
  event = archive(status);
  report = reply([{ found: true, oversized: false, envelope_text: JSON.stringify(event) }], REPORT_FIELDS);
}
function input(method = 'GET', options: { path?: string; query?: string; cookie?: string; signal?: AbortSignal } = {}) {
  return new NextRequest(`https://example.test${options.path ?? PATH}?${options.query ?? `jobId=${encodeURIComponent(JOB)}&reportId=${event.event_id}`}`, {
    method, signal: options.signal, headers: {
      cookie: options.cookie ?? cookie(), 'x-tenant-id': OTHER, 'x-role': 'OWNER',
      'if-none-match': '*', 'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT',
      range: 'bytes=0-10', origin: 'https://untrusted.example.test',
    },
  });
}
const context = () => ({ params: Promise.resolve({ slug: 'alpha' }) });
function noDisclosure(text: string) {
  for (const value of [PRIVATE, TENANT, OTHER, USER, MEMBER, SUBJECT, SECRET, JOB,
    'synthetic@example.test', 'postgresql://', 'class_store_google_auth', 'SHEETS_AND_REDIS', 'redacted_details']) {
    expect(text).not.toContain(value);
  }
}
async function failure(response: Response, method: Method, status: number, error: string, extra = {}) {
  expect(response.status).toBe(status);
  expect(Object.fromEntries(response.headers)).toEqual({ ...PRIVATE_HEADERS, ...extra });
  const text = await response.text();
  expect(text).toBe(method === 'HEAD' ? '' : JSON.stringify({ error }));
  if (method === 'HEAD') expect(response.body).toBeNull();
  noDisclosure(text); noDisclosure(JSON.stringify([...response.headers]));
}
beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  install();
  tenant = { id: TENANT, slug: 'alpha', display_name: 'Synthetic alpha', timezone: 'Asia/Seoul', lifecycle: 'ACTIVE' };
  member = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
  queries = []; hook = undefined;
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: QueryConfig): Promise<Reply> => {
      queries.push(config); hook?.(config);
      if (config.text.includes('public.audit_events')) return report;
      if (config.text.includes('public.platform_find_membership')) return reply(member ? [member] : [], MEMBER_FIELDS);
      if (config.text.includes('public.platform_find_tenant')) return reply(tenant ? [tenant] : [], TENANT_FIELDS);
      return reply([], []);
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  transport.connect.mockReset().mockResolvedValue(client);
  transport.config.mockReset().mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/fixture', directDatabaseUrl: 'must-not-use' });
  transport.provider.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled(); expect(transport.provider).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled(); expect(console.log).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); }
});

describe.each(METHODS)('explicit %s route with REAL reader/auth and MOCK pg transport', method => {
  it.each(['OWNER', 'ADMIN'])('serves MATCHED/BLOCKED only for current %s, preserving the entire original Request', async role => {
    member!.role = role;
    const read = vi.spyOn(reader, 'readPreflightReport');
    const download = vi.spyOn(adapter, 'readHistoricalReportDownload');
    for (const status of ['MATCHED_PREFLIGHT', 'BLOCKED'] as const) {
      install(status);
      const req = input(method);
      // Forged VIEWER cannot revoke a real member, just as forged OWNER cannot grant membership.
      req.headers.set('x-role', 'VIEWER');
      const original = { url: req.url, headers: [...req.headers], signal: req.signal };
      const expected = formatHistoricalReportDownload(event, { tenantId: TENANT, migrationJobId: JOB, reportId: event.event_id });
      if (expected.kind !== 'HISTORICAL_REPORT_DOWNLOAD') throw new Error('Invalid fixture');
      const response = await route[method](req, context());
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toEqual({ ...PRIVATE_HEADERS, 'content-disposition': `attachment; filename="${expected.filename}"` });
      expect(read.mock.calls.at(-1)?.[1]).toBe(req); expect(download.mock.calls.at(-1)?.[1]).toBe(req);
      expect(read.mock.calls.at(-1)?.[0]).toBe('alpha');
      expect({ url: req.url, headers: [...req.headers], signal: req.signal }).toEqual(original);
      expect(req.signal).toBe(original.signal); expect(req.bodyUsed).toBe(false);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes).toEqual(new TextEncoder().encode(method === 'HEAD' ? '' : expected.body));
      expect(bytes.byteLength).toBeLessThanOrEqual(65_536);
      if (method === 'HEAD') expect(response.body).toBeNull();
      else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        expect(bytes[0]).toBe(123); expect(text.endsWith('\n')).toBe(true); expect(text.endsWith('\n\n')).toBe(false);
        expect(JSON.parse(text)).toMatchObject({ readOnly: true, scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
          eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
          currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
          freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE', report: { status } });
        noDisclosure(text);
      }
      noDisclosure(JSON.stringify([...response.headers]));
      expect(queries.at(-1)?.text).toBe('ROLLBACK');
    }
    expect(read).toHaveBeenCalledTimes(2); expect(download).toHaveBeenCalledTimes(2);
    expect(transport.connect).toHaveBeenCalledTimes(2); expect(client.release.mock.calls).toEqual([[], []]);
    expect(queries.every(config => /^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/.test(config.text))).toBe(true);
  });

  it.each(['missing', 'legacy', 'malformed', 'duplicate', 'tampered', 'expired'])('refuses %s identity before DB', async kind => {
    const valid = cookie();
    const value = kind === 'missing' ? '' : kind === 'legacy' ? 'class_store_admin=fake; class_store_tenant_admin=fake'
      : kind === 'duplicate' ? `${valid}; ${valid}` : kind === 'expired' ? cookie(Date.now() - 31 * 24 * 60 * 60 * 1000)
        : kind === 'tampered' ? tamperedCookie() : 'class_store_google_auth=%ZZ';
    await failure(await route[method](input(method, { cookie: value }), context()), method, 401, 'AUTHENTICATION_REQUIRED');
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it.each(['tenant', 'member', 'foreign', 'subject', 'role', 'final'])('refuses %s binding without caller-header authority', async kind => {
    if (kind === 'tenant') tenant = null;
    if (kind === 'member') member = null;
    if (kind === 'foreign') member!.tenant_id = OTHER;
    if (kind === 'subject') member!.google_subject = PRIVATE;
    if (kind === 'role') member!.role = 'VIEWER'; // Malformed seam, NOT an impossible real-schema fixture.
    if (kind === 'final') report = reply([], REPORT_FIELDS);
    await failure(await route[method](input(method), context()), method, 403, 'ACCESS_DENIED');
    if (kind !== 'final') expect(queries.some(query => query.text.includes('public.audit_events'))).toBe(false);
  });
  it('maps an authorized absent selection to uniform 404', async () => {
    report = reply([{ found: false, oversized: false, envelope_text: null }], REPORT_FIELDS);
    await failure(await route[method](input(method), context()), method, 404, 'PREFLIGHT_REPORT_NOT_FOUND');
  });
  it('does not carry an earlier GET attachment through loss of membership', async () => {
    expect((await route.GET(input(), context())).status).toBe(200);
    member = null;
    await failure(await route[method](input(method), context()), method, 403, 'ACCESS_DENIED');
    expect(transport.connect).toHaveBeenCalledTimes(2);
  });
  it.each(['jobId=x', 'jobId=%ZZ&reportId=x', 'jobId=%C0%AF&reportId=x', 'job%49d=x&reportId=x',
    'jobId=x&jobId=y&reportId=x', 'jobId=x&reportId=x&download=1', 'jobId=x&reportId=x&role=OWNER'])(
    'does not repair raw selectors %s', async query => {
      const req = input(method, { query });
      await failure(await route[method](req, context()), method, 400, 'INVALID_PREFLIGHT_REQUEST');
      expect(new URL(req.url).search.slice(1)).toBe(query); expect(transport.connect).not.toHaveBeenCalled();
    },
  );
  it.each([`${PATH}/`, `${PATH}/extra`, `${PATH}.json`, '/api/migrations/status/beta/preflight/download',
    '/api/migrations/status/%61lpha/preflight/download', '/api/migrations/status/alpha/preflight/%64ownload'])(
    'refuses pathname near miss %s as received, not raw HTTP normalization evidence', async path => {
      await failure(await route[method](input(method, { path }), context()), method, 400, 'INVALID_PREFLIGHT_REQUEST');
      expect(transport.connect).not.toHaveBeenCalled();
    },
  );
  it('fails closed on missing runtime configuration before creating the reader-local pool', async () => {
    // Config is read once when this module creates its pool, not on every
    // request. Use a fresh module; changing config after earlier successes
    // would test the existing pool rather than the missing-config boundary.
    vi.resetModules();
    transport.config.mockImplementation(() => { throw new Error(PRIVATE); });
    const fresh = await import('./route');
    await failure(await fresh[method](input(method), context()), method, 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(transport.config).toHaveBeenCalledTimes(1);
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it.each(['connect', 'query', 'rollback', 'release', 'oid', 'oversized', 'json', 'digest', 'private-field'])(
    'sanitizes %s failure with no attachment or private disclosure', async stage => {
      if (stage === 'connect') transport.connect.mockRejectedValue(new Error(PRIVATE));
      if (stage === 'query' || stage === 'rollback') hook = config => {
        if (stage === 'query' || config.text === 'ROLLBACK') throw new Error(PRIVATE);
      };
      if (stage === 'release') client.release.mockImplementation(() => { throw new Error(PRIVATE); });
      if (stage === 'oid') report.fields[2].dataTypeID = 3802;
      if (stage === 'oversized') report.rows[0].envelope_text = '가'.repeat(22_000);
      if (stage === 'json') report.rows[0].envelope_text = `{${PRIVATE}`;
      if (stage === 'digest') event.redacted_details.sourceFingerprint = 'f'.repeat(64);
      if (stage === 'private-field') Object.assign(event.redacted_details, { rawSource: PRIVATE, cookie: cookie(), connection: 'postgresql://private.invalid/source' });
      if (stage === 'digest' || stage === 'private-field') report.rows[0].envelope_text = JSON.stringify(event);
      await failure(await route[method](input(method), context()), method, 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
      expect(transport.connect.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );
  it.each(['abort', 'cookie'])('suppresses publication after %s during cleanup', async change => {
    const abort = new AbortController(); const req = input(method, { signal: abort.signal });
    client.release.mockImplementation(() => {
      if (change === 'abort') abort.abort(); else req.headers.set('cookie', cookie(Date.now(), 'different-subject'));
    });
    await failure(await route[method](req, context()), method, change === 'abort' ? 503 : 401,
      change === 'abort' ? 'PREFLIGHT_REPORT_UNAVAILABLE' : 'AUTHENTICATION_REQUIRED');
  });
  it.each(['rejected', 'missing', 'undefined', 'slug', 'getter'])('sanitizes %s params without invoking the adapter', async kind => {
    const download = vi.spyOn(adapter, 'readHistoricalReportDownload');
    const ctx = kind === 'rejected' ? { params: Promise.reject(new Error(PRIVATE)) }
      : kind === 'missing' ? {} : kind === 'undefined' ? { params: Promise.resolve(undefined) }
        : kind === 'slug' ? { params: Promise.resolve({}) } : { get params() { throw new Error(PRIVATE); } };
    // Deliberately malformed framework context: a test-only type escape.
    await failure(await route[method](input(method), ctx as unknown as ReturnType<typeof context>), method, 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(download).not.toHaveBeenCalled(); expect(transport.connect).not.toHaveBeenCalled();
  });
  it('awaits promised params and does not start auth early', async () => {
    let resolve!: (params: { slug: string }) => void;
    const params = new Promise<{ slug: string }>(yes => { resolve = yes; });
    const pending = route[method](input(method), { params });
    await Promise.resolve(); expect(transport.connect).not.toHaveBeenCalled();
    resolve({ slug: 'alpha' }); expect((await pending).status).toBe(200);
  });
  it('catches an adapter rejection at the route-owned boundary', async () => {
    const download = vi.spyOn(adapter, 'readHistoricalReportDownload').mockRejectedValueOnce(new Error(PRIVATE));
    await failure(await route[method](input(method), context()), method, 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(download).toHaveBeenCalledTimes(1); expect(transport.connect).not.toHaveBeenCalled();
  });
  it('keeps the old inline route bytes and headers unchanged with its original canonical Request', async () => {
    const download = vi.spyOn(adapter, 'readHistoricalReportDownload');
    const expected = formatHistoricalReportDownload(event, { tenantId: TENANT, migrationJobId: JOB, reportId: event.event_id });
    if (expected.kind !== 'HISTORICAL_REPORT_DOWNLOAD') throw new Error('Invalid fixture');
    const response = await inline[method](input(method, { path: '/api/migrations/status/alpha/preflight' }), context());
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({ 'cache-control': 'private, no-store',
      'content-type': 'application/json', 'referrer-policy': 'no-referrer', vary: 'Cookie' });
    expect(await response.text()).toBe(method === 'HEAD' ? '' : expected.body.slice(0, -1));
    expect(download).not.toHaveBeenCalled();
  });
});

describe('installed Next autoImplementMethods characterization (NOT HTTP; reader mocked here)', () => {
  const dispatched = autoImplementMethods(route as unknown as AppRouteHandlers);
  it('exports only explicit GET/HEAD and dynamic Node config, with no hidden method exports', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'HEAD', 'dynamic', 'runtime']);
    expect(route.dynamic).toBe('force-dynamic'); expect(route.runtime).toBe('nodejs');
    expect(dispatched.GET).toBe(route.GET); expect(dispatched.HEAD).toBe(route.HEAD);
    expect(dispatched.HEAD).not.toBe(route.GET);
    expect(Object.keys(dispatched).sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    expect(Object.hasOwn(dispatched, 'BREW')).toBe(false); // No invented unknown-verb fallback.
  });
  it.each(METHODS)('passes %s to the actual route with a mocked denied reader (not authorization evidence)', async method => {
    const read = vi.spyOn(reader, 'readPreflightReport').mockResolvedValueOnce({ kind: 'FORBIDDEN' });
    const req = input(method);
    const response = await dispatched[method](req, context());
    expect(response).toBeInstanceOf(Response);
    await failure(response as Response, method, 403, 'ACCESS_DENIED');
    expect(read).toHaveBeenCalledExactlyOnceWith('alpha', req);
    expect(read.mock.calls[0][1]).toBe(req); expect(transport.connect).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('automatic %s has no inherited private headers and never calls params/reader', async method => {
    const read = vi.spyOn(reader, 'readPreflightReport');
    const params = vi.fn(() => { throw new Error(PRIVATE); });
    const response = await dispatched[method](input(method), { get params() { return params(); } });
    expect(response).toBeInstanceOf(Response);
    const result = response as Response;
    expect(result.status).toBe(method === 'OPTIONS' ? 204 : 405);
    expect(result.body).toBeNull(); expect(await result.text()).toBe('');
    expect(Object.fromEntries(result.headers)).toEqual(method === 'OPTIONS' ? { allow: 'GET, HEAD, OPTIONS' } : {});
    expect(read).not.toHaveBeenCalled(); expect(params).not.toHaveBeenCalled(); expect(transport.connect).not.toHaveBeenCalled();
  });
  describe.each(METHODS)('direct %s misuse is NOT Next dispatch', exported => {
    it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter(method => method !== exported))('guards Request method %s before params/adapter', async method => {
      const download = vi.spyOn(adapter, 'readHistoricalReportDownload');
      const params = vi.fn(() => { throw new Error(PRIVATE); });
      const response = await route[exported](input(method), { get params() { return params(); } });
      await failure(response, exported === 'HEAD' || method === 'HEAD' ? 'HEAD' : 'GET', 405, 'METHOD_NOT_ALLOWED', { allow: 'GET, HEAD, OPTIONS' });
      expect(params).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled(); expect(transport.connect).not.toHaveBeenCalled();
    });
  });
});
