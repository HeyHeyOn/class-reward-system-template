// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { QueryConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), config: vi.fn() }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(), Pool: class {
  connect = mocks.connect;
  on() {}
} }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: mocks.config }));
// Real cookie verifier, tenant authorization, reader and projector. Only the
// database transport is synthetic. No production pool, source or producer.
import * as reader from './readPreflightReport';
import { projectPreflightReport } from './preflightReportProjection';
import { formatHistoricalReportDownload } from './historicalReportDownload';
import { readHistoricalReportDownload } from './readHistoricalReportDownload';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-download-subject';
const JOB = 'historical/과거 job:%20';
const SECRET = 'synthetic-download-secret-not-a-real-credential';
const PRIVATE = 'synthetic-private-source-DO-NOT-ECHO';
const CATEGORIES = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
];
type Diagnostic = { category: string; code: string; rowReference?: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Invalid synthetic fixture');
  return text;
}
function seal<T extends { tenant_id: string; job_id: string; event_id: string; redacted_details: unknown }>(row: T): T {
  row.event_id = `reconciliation:${createHash('sha256')
    .update(canonical([row.tenant_id, row.job_id, row.redacted_details]), 'utf8').digest('hex')}`;
  return row;
}
function archive() {
  return seal({ tenant_id: TENANT, job_id: JOB, event_id: '', event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT',
    operation_id: null, actor_user_id: null, entity_type: null, entity_id: null,
    redacted_details: {
      report: { reportVersion: 1, phase: 'PREFLIGHT', status: 'MATCHED_PREFLIGHT', authority: 'SHEETS_AND_REDIS',
        cutoverAllowed: false, metrics: CATEGORIES.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
        diagnostics: [] as Diagnostic[], omittedDiagnostics: 0 },
      comparisonInstant: '2026-09-01T12:00:00.000Z' as string | null,
      manifestDigest: 'a'.repeat(64), currentManifestDigest: 'a'.repeat(64) as string | null,
      sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
    },
  });
}
type Archive = ReturnType<typeof archive>;
const selection = (row: Archive) => ({ tenantId: row.tenant_id, migrationJobId: row.job_id, reportId: row.event_id });
function cookie(issuedAt = Date.now(), subject = SUBJECT) {
  const iv = Buffer.alloc(12, 9); // Deterministic fixture only, never issue real tokens.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
const reply = (rows: Record<string, unknown>[], fields: [string, number][]): Reply => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
let event: Archive;
let tenant: Record<string, unknown>;
let member: Record<string, unknown> | null;
let reportReply: Reply;
let configs: QueryConfig[];
let hook: ((config: QueryConfig) => Reply | void | Promise<Reply | void>) | undefined;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
function install(row: Archive) {
  event = row;
  reportReply = reply([{ found: true, oversized: false, envelope_text: JSON.stringify(row) }], REPORT_FIELDS);
}
let requestPath = '/api/migrations/status/alpha/preflight';
function request(options: { cookie?: string; query?: string; path?: string; method?: string; signal?: AbortSignal } = {}) {
  return new Request(`https://example.test${options.path ?? requestPath}?${options.query ?? `jobId=${encodeURIComponent(event.job_id)}&reportId=${event.event_id}`}`, {
    method: options.method ?? 'GET', signal: options.signal,
    headers: { cookie: options.cookie ?? cookie(), 'x-tenant-id': OTHER, 'x-role': 'OWNER',
      'if-none-match': '*', range: 'bytes=0-10' },
  });
}
const read = (req = request(), slug: unknown = 'alpha') => readHistoricalReportDownload(slug, req);
function privacy(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  for (const name of ['etag', 'last-modified', 'content-range', 'accept-ranges', 'access-control-allow-origin', 'set-cookie']) {
    expect(response.headers.has(name)).toBe(false);
  }
}
async function failure(response: Response, status: number, error: string, head = false) {
  expect(response.status).toBe(status);
  privacy(response);
  expect(response.headers.has('content-disposition')).toBe(false);
  const text = await response.text();
  expect(text).toBe(head ? '' : JSON.stringify({ error }));
  for (const raw of [PRIVATE, TENANT, JOB, SUBJECT, SECRET]) expect(text).not.toContain(raw);
}
beforeEach(() => {
  requestPath = '/api/migrations/status/alpha/preflight';
  vi.stubEnv('AUTH_SECRET', SECRET);
  install(archive());
  tenant = { id: TENANT, slug: 'alpha', display_name: 'Synthetic alpha', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
  member = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
  configs = []; hook = undefined;
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: QueryConfig): Promise<Reply> => {
      configs.push(config);
      const overridden = await hook?.(config);
      if (overridden) return overridden;
      if (config.text.includes('public.audit_events')) return reportReply;
      if (config.text.includes('public.platform_find_membership')) return reply(member ? [member] : [], MEMBER_FIELDS);
      if (config.text.includes('public.platform_find_tenant')) return reply([tenant], TENANT_FIELDS);
      return reply([], []);
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  mocks.connect.mockReset().mockResolvedValue(client);
  mocks.config.mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/fixture' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe.each(['/api/migrations/status/alpha/preflight', '/api/migrations/status/alpha/preflight/download'])(
  'authenticated historical display-byte adapter: %s (not HTTP)', path => {
  beforeEach(() => { requestPath = path; });
  it.each(['OWNER', 'ADMIN'])('uses the actual reader and verified %s membership for exact formatter-equivalent UTF-8 bytes', async role => {
    member!.role = role;
    const req = request();
    const originalCookie = req.headers.get('cookie');
    const spy = vi.spyOn(reader, 'readPreflightReport');
    const expected = formatHistoricalReportDownload(event, selection(event));
    expect(expected.kind).toBe('HISTORICAL_REPORT_DOWNLOAD');
    if (expected.kind !== 'HISTORICAL_REPORT_DOWNLOAD') throw new Error('Invalid fixture');
    const response = await read(req);
    expect(response.status).toBe(200); privacy(response);
    expect(spy).toHaveBeenCalledExactlyOnceWith('alpha', req);
    expect(spy.mock.calls[0][1]).toBe(req);
    expect(req.headers.get('cookie')).toBe(originalCookie);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new TextEncoder().encode(expected.body));
    expect(bytes.byteLength).toBeLessThanOrEqual(65_536);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${expected.filename}"`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(text.endsWith('\n')).toBe(true); expect(text.endsWith('\n\n')).toBe(false);
    expect(bytes[0]).toBe(123); // JSON object, not BOM or double-encoded string.
    expect(JSON.parse(text)).toMatchObject({ scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
      eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
      currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
      report: { status: 'MATCHED_PREFLIGHT' } });
    for (const raw of [TENANT, JOB, SUBJECT, MEMBER, USER, SECRET, 'SHEETS_AND_REDIS', 'redacted_details']) expect(text).not.toContain(raw);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(configs.find(config => config.text.includes('public.audit_events'))?.values)
      .toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]);
    expect(configs.every(config => /^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/.test(config.text))).toBe(true);
    expect(configs.at(-1)?.text).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it('preserves signed aggregate strings, blocked diagnostics and explicit null evidence without defaults', async () => {
    const row = archive();
    Object.assign(row.redacted_details.report, { status: 'BLOCKED', metrics: [
      { category: 'BALANCES', expected: '-999999999999999999999999999999', actual: '999999999999999999999999999999',
        delta: '1999999999999999999999999999998', status: 'MISMATCH' },
    ], diagnostics: [
      { category: 'RECURRENCE', code: 'INVALID_COMPARISON_INSTANT' },
      { category: 'SOURCES', code: 'INVALID_CURRENT_MANIFEST' },
      ...Array.from({ length: 98 }, () => ({ category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: 'c'.repeat(64) })),
    ], omittedDiagnostics: 50 });
    row.redacted_details.comparisonInstant = row.redacted_details.currentManifestDigest = null;
    install(seal(row));
    const expected = formatHistoricalReportDownload(row, selection(row));
    if (expected.kind !== 'HISTORICAL_REPORT_DOWNLOAD') throw new Error('Invalid fixture');
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected.body);
  });

  it('HEAD reauthorizes with identical attachment metadata but no body', async () => {
    const get = await read();
    const head = await read(request({ method: 'HEAD' }));
    expect(head.status).toBe(200); privacy(head);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-disposition')).toBe(get.headers.get('content-disposition'));
    expect(head.headers.has('content-length')).toBe(false);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it.each(['GET', 'HEAD'])('does not reuse prior viewer authorization after membership revocation (%s)', async method => {
    expect((await read()).status).toBe(200);
    member = null;
    await failure(await read(request({ method })), 403, 'ACCESS_DENIED', method === 'HEAD');
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });
  it.each(['', 'class_store_admin=fake; class_store_tenant_admin=fake', 'class_store_google_auth=bad',
    'class_store_google_auth=%ZZ'])('refuses absent or forged credentials (%s)', async value => {
    await failure(await read(request({ cookie: value })), 401, 'AUTHENTICATION_REQUIRED');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses duplicate Google cookies and real verifier expiration', async () => {
    const value = cookie();
    for (const token of [`${value}; ${value}`, cookie(Date.now() - 31 * 24 * 60 * 60 * 1000)]) {
      await failure(await read(request({ cookie: token })), 401, 'AUTHENTICATION_REQUIRED');
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([{ tenant_id: OTHER }, { google_subject: 'other' }, { role: 'VIEWER' }, { user_id: null }, { id: null }])(
    'requires all trusted membership fields, not caller tenant/role headers (%j)', async mutation => {
      Object.assign(member!, mutation);
      await failure(await read(), 403, 'ACCESS_DENIED');
      expect(configs.some(config => config.text.includes('public.audit_events'))).toBe(false);
    },
  );
  it.each([{ id: null }, { slug: 'beta' }, { timezone: null }, { lifecycle: null }])('refuses missing/misbound trusted tenant context (%j)', async mutation => {
    Object.assign(tenant, mutation);
    await failure(await read(), 403, 'ACCESS_DENIED');
  });
  it('refuses final-statement membership loss rather than substituting a report', async () => {
    reportReply = reply([], REPORT_FIELDS);
    await failure(await read(), 403, 'ACCESS_DENIED');
  });
  it.each(['tenant_id', 'job_id', 'event_id', 'event_type'])('refuses mismatched archive envelope %s', async key => {
    const req = request();
    const changed = { ...event, [key]: key === 'tenant_id' ? OTHER : PRIVATE };
    reportReply.rows[0].envelope_text = JSON.stringify(changed);
    await failure(await read(req), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
  });
  it.each(['manifestDigest', 'sourceFingerprint', 'comparisonInstant', 'currentManifestDigest'])('refuses absent trusted archive field %s', async key => {
    const req = request();
    Reflect.deleteProperty(event.redacted_details, key);
    reportReply.rows[0].envelope_text = JSON.stringify(event);
    await failure(await read(req), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
  });
  it('refuses content tampering with an old digest', async () => {
    const req = request();
    event.redacted_details.sourceFingerprint = 'f'.repeat(64);
    reportReply.rows[0].envelope_text = JSON.stringify(event);
    await failure(await read(req), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
  });
  it.each(['jobId=x', 'jobId=%ZZ&reportId=x', 'jobId=%C0%AF&reportId=x',
    'jobId=x&jobId=y&reportId=x', 'jobId=x&reportId=x&download=1',
    'job%49d=x&reportId=x', 'jobId=x&reportId=x&tenantId=caller'])('keeps strict raw query admission (%s)', async query => {
    await failure(await read(request({ query })), 400, 'INVALID_PREFLIGHT_REQUEST');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['/api/migrations/status/alpha/preflight/download/', '/api/migrations/status/alpha/preflight/download/extra',
    '/api/migrations/status/beta/preflight/download', '/api/migrations/status/%61lpha/preflight/download',
    '/api/migrations/status/alpha/preflight/%64ownload', '/api/migrations/status/beta/preflight',
    '/api/migrations/status/%61lpha/preflight', '/api/migrations/status/alpha/preflight/'])('does not silently rewrite URL %s', async path => {
    await failure(await read(request({ path })), 400, 'INVALID_PREFLIGHT_REQUEST');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['Alpha', '', null])('does not repair a noncanonical slug (%s)', async slug => {
    await failure(await read(request(), slug), 403, 'ACCESS_DENIED');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses direct %s without reader calls or a new handler', async method => {
    const spy = vi.spyOn(reader, 'readPreflightReport');
    const response = await read(request({ method }));
    await failure(response, 405, 'METHOD_NOT_ALLOWED');
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(spy).not.toHaveBeenCalled();
  });
  it.each(['GET', 'HEAD'])('maps absence uniformly, with no attachment (%s)', async method => {
    reportReply = reply([{ found: false, oversized: false, envelope_text: null }], REPORT_FIELDS);
    await failure(await read(request({ method })), 404, 'PREFLIGHT_REPORT_NOT_FOUND', method === 'HEAD');
  });
  it.each(['GET', 'HEAD'])('rejects wire/OID violations before exposing bytes (%s)', async method => {
    reportReply.fields[2].dataTypeID = 3802;
    await failure(await read(request({ method })), 503, 'PREFLIGHT_REPORT_UNAVAILABLE', method === 'HEAD');
  });
  it('never parses an oversized multibyte driver TEXT envelope', async () => {
    const oversized = '한'.repeat(22_000);
    reportReply.rows[0].envelope_text = oversized;
    const spy = vi.spyOn(JSON, 'parse');
    await failure(await read(), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(spy.mock.calls.some(([value]) => value === oversized)).toBe(false);
  });
});

describe.each(['/api/migrations/status/alpha/preflight', '/api/migrations/status/alpha/preflight/download'])(
  'publication lifetime and safe projection refusal: %s', path => {
  beforeEach(() => { requestPath = path; });
  it.each(['query', 'rollback', 'release'])('never publishes on %s failure or leaks raw errors', async stage => {
    if (stage === 'release') client.release.mockImplementation(() => { throw new Error(PRIVATE); });
    else hook = config => {
      if (stage === 'query' || config.text === 'ROLLBACK') throw new Error(PRIVATE);
    };
    await failure(await read(), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
  it('waits for successful rollback/release before creating the response', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const rollback = new Promise<void>(resolve => { entered = resolve; });
    hook = async config => { if (config.text === 'ROLLBACK') { entered(); await gate; } };
    let settled = false;
    const pending = read().then(response => { settled = true; return response; });
    await rollback;
    expect(settled).toBe(false); expect(client.release).not.toHaveBeenCalled();
    finish();
    expect((await pending).status).toBe(200);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it('honors the existing acquisition timeout and destroys a late client without query/fallback', async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof client) => void;
    mocks.connect.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = read();
    await vi.advanceTimersByTimeAsync(2_001);
    await failure(await pending, 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    finish(client); await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation at cleanup and real cookie expiration during rollback', async () => {
    const abort = new AbortController();
    client.release.mockImplementationOnce(() => abort.abort());
    await failure(await read(request({ signal: abort.signal })), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    vi.useFakeTimers();
    const now = Date.now();
    const req = request({ cookie: cookie(now - 30 * 24 * 60 * 60 * 1000 + 10) });
    hook = config => { if (config.text === 'ROLLBACK') vi.setSystemTime(now + 11); };
    await failure(await read(req), 401, 'AUTHENTICATION_REQUIRED');
  });
  it.each(['cookie', 'abort'])('checks %s again between reader completion and publication', async change => {
    const abort = new AbortController();
    const req = request({ signal: abort.signal });
    const actual = reader.readPreflightReport;
    vi.spyOn(reader, 'readPreflightReport').mockImplementationOnce(async (slug, original) => {
      const result = await actual(slug, original);
      if (change === 'cookie') req.headers.set('cookie', cookie(Date.now(), 'different-subject'));
      else abort.abort();
      return result;
    });
    await failure(await read(req), change === 'cookie' ? 401 : 503,
      change === 'cookie' ? 'AUTHENTICATION_REQUIRED' : 'PREFLIGHT_REPORT_UNAVAILABLE');
  });
  describe.each(['reader-return', 'body-serialization'] as const)('Task20 publication expiry at %s', boundary => {
    it.each(['GET', 'HEAD'])('refuses an unchanged authentic cookie that expires before %s attachment publication', async method => {
      // Advance only the test clock at a witnessed boundary. The real reader,
      // AES-GCM verifier and projection run; no injected successful reader DTO.
      vi.useFakeTimers();
      const now = Date.now();
      const req = request({ method, cookie: cookie(now - 30 * 24 * 60 * 60 * 1000 + 10) });
      const originalCookie = req.headers.get('cookie');
      expect(getGoogleSessionFromRequest(req)?.subject).toBe(SUBJECT);
      let crossed = false;
      const expire = () => {
        expect(client.release).toHaveBeenCalledExactlyOnceWith();
        expect(configs.at(-1)?.text).toBe('ROLLBACK');
        expect(getGoogleSessionFromRequest(req)?.subject).toBe(SUBJECT);
        vi.setSystemTime(now + 11);
        expect(getGoogleSessionFromRequest(req)).toBeNull();
        crossed = true;
      };
      if (boundary === 'reader-return') {
        const actual = reader.readPreflightReport;
        vi.spyOn(reader, 'readPreflightReport').mockImplementationOnce(async (slug, original) => {
          const result = await actual(slug, original);
          expect(result.kind).toBe('HISTORICAL_REPORT');
          expire();
          return result;
        });
      } else {
        const actual = Buffer.byteLength;
        vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
          const length = actual(value, encoding);
          if (typeof value === 'string' && value.startsWith('{"projectionVersion":') && value.endsWith('\n')) expire();
          return length;
        });
      }
      const response = await read(req);
      expect(crossed).toBe(true);
      expect(req.headers.get('cookie')).toBe(originalCookie);
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      await failure(response, 401, 'AUTHENTICATION_REQUIRED', method === 'HEAD');
    });
  });
  it('sanitizes an unexpected reader throw without retry or fallback', async () => {
    const spy = vi.spyOn(reader, 'readPreflightReport').mockRejectedValueOnce(new Error(PRIVATE));
    await failure(await read(), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  // Fault injection ONLY at the already trusted reader return boundary. These
  // are defensive contract tests, not proof that client DTOs can authenticate.
  function projected() {
    const value = projectPreflightReport(event, selection(event));
    if (value.kind !== 'HISTORICAL_REPORT') throw new Error('Invalid fixture');
    return value;
  }
  function inject(value: unknown) {
    vi.spyOn(reader, 'readPreflightReport').mockResolvedValueOnce(value as reader.PreflightReportReadResult);
  }
  it.each(['projectionVersion', 'readOnly', 'scope', 'verification', 'eventIntegrity', 'originalBinding',
    'currentFreshness', 'currentPreflight', 'operationalAuthority', 'cutoverAllowed', 'reportId',
    'comparisonInstant', 'manifestDigest', 'currentManifestDigest', 'sourceFingerprint', 'freshness', 'report'])(
    'fails closed instead of defaulting an absent trusted projection field %s', async key => {
      const value = projected(); Reflect.deleteProperty(value.projection, key); inject(value);
      await failure(await read(), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    },
  );
  it.each([{ scope: 'CURRENT' }, { verification: 'FULL' }, { originalBinding: 'VERIFIED' },
    { currentFreshness: 'VERIFIED' }, { currentPreflight: 'MATCHED_PREFLIGHT' }, { operationalAuthority: 'POSTGRES' },
    { cutoverAllowed: true }, { reportId: `../../${PRIVATE}` }, { manifestDigest: null }])(
    'refuses an altered trusted display contract %j', async mutation => {
      const value = projected(); Object.assign(value.projection, mutation); inject(value);
      await failure(await read(), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    },
  );
  it.each(['report', 'metric', 'diagnostic'])('refuses missing or unexpected nested display fields (%s)', async target => {
    const value = projected();
    const report = value.projection.report;
    if (target === 'report') Reflect.deleteProperty(report, 'omittedDiagnostics');
    if (target === 'metric') Reflect.deleteProperty(report.metrics[0], 'delta');
    if (target === 'diagnostic') Object.assign(report, { status: 'BLOCKED', diagnostics: [{ category: 'STUDENTS', code: PRIVATE }] });
    inject(value);
    await failure(await read(), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
  });
  it('refuses unknown results, extra raw fields, toJSON, proxies and accessors without executing them', async () => {
    const trap = vi.fn(() => { throw new Error(PRIVATE); });
    const getter = projected();
    Object.defineProperty(getter.projection, 'report', { get: trap, enumerable: true });
    const extra = projected(); Object.assign(extra.projection, { credential: PRIVATE });
    const toJSON = projected(); Object.assign(toJSON.projection.report, { toJSON: trap });
    // Keep the proxy below the promise boundary: resolving a top-level proxy
    // would itself read `then` before the adapter ever receives the result.
    const proxy = { kind: 'HISTORICAL_REPORT', projection: new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }) };
    for (const value of [null, { kind: 'CURRENT_REPORT' }, { kind: 'UNAVAILABLE', error: PRIVATE },
      getter, extra, toJSON, proxy]) {
      inject(value);
      await failure(await read(), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    }
    expect(trap).not.toHaveBeenCalled();
  });
  it.each(['GET', 'HEAD'])('applies the final UTF-8 + LF gate before any %s attachment', async method => {
    const measured: string[] = [];
    const original = Buffer.byteLength;
    // A valid v1 graph is smaller than the cap. Inject ONLY the final byte
    // counter to exercise overflow refusal; real fixture bytes are checked above.
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
      if (typeof value === 'string' && value.startsWith('{"projectionVersion":') && value.endsWith('\n')) {
        measured.push(value); return 65_537;
      }
      return original(value, encoding);
    });
    await failure(await read(request({ method })), 503, 'PREFLIGHT_REPORT_UNAVAILABLE', method === 'HEAD');
    expect(measured).toHaveLength(1);
  });
  it('exports only an in-process adapter, with no HTTP handlers or dependency injection entry', async () => {
    const adapter = await import('./readHistoricalReportDownload');
    expect(Object.keys(adapter)).toEqual(['readHistoricalReportDownload']);
    expect(readHistoricalReportDownload.length).toBe(2);
  });
});
