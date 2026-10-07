// @vitest-environment node
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { networkInterfaces } from 'node:os';
import { NextRequest } from 'next/server';
import { NodeNextRequest, NodeNextResponse } from 'next/dist/server/base-http/node';
import { sendResponse } from 'next/dist/server/send-response';
import { isHTTPMethod } from 'next/dist/server/web/http';
import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { AppRouteHandlers } from 'next/dist/server/route-modules/app-route/module';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';
import type { QueryConfig } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), config: vi.fn(), session: vi.fn(), forbidden: vi.fn() }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(),
  Pool: class { connect = mocks.connect; on() {} },
  Client: class { constructor() { mocks.forbidden(); throw new Error('Real SQL transport forbidden'); } },
}));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: mocks.config }));
vi.mock('@/server/googleOAuth', () => ({ getGoogleSessionFromRequest: mocks.session }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient() {
  mocks.forbidden(); throw new Error('Shared database forbidden');
} }));
vi.mock('googleapis', () => ({ google: new Proxy({}, { get() {
  mocks.forbidden(); throw new Error('Provider forbidden');
} }) }));
import * as adapter from '../../../readHistoricalReportDownload';
import * as reader from '../../../readPreflightReport';
import * as route from './route';

// OPT IN ONLY: CLASS_STORE_DOWNLOAD_LOOPBACK_ISOLATED=1 is an acknowledgement,
// NOT a sandbox. Run in a fresh network namespace containing only loopback,
// with an empty environment/home and only source, installed dependencies and
// tool configs mounted read-only. Do not mount .env*, credentials, host /proc,
// operational files or sockets. Writable Vite caches belong to private tmpfs.
// Never start Next, connect to an existing server, or nest a sandbox here.
//
// Like ../../route.test.ts, this is a bounded Node HTTP runtime SLICE: installed
// Next parameter decoding + method dispatch + response sender, real canonical
// route/adapter/reader/projector, MOCK SQL transport and current identity.
// It does NOT exercise AppRouteRouteModule, Next rewrites/middleware/cache,
// proxy/CDN normalization, real SQL/RLS/authentication or a browser download.
const isolated = process.env.CLASS_STORE_DOWNLOAD_LOOPBACK_ISOLATED === '1';
const PATH = '/api/migrations/status/alpha/preflight/download';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUBJECT = 'synthetic-loopback-subject';
const JOB = 'synthetic/과거 +:%20';
// Syntactically admitted, deliberately NOT a credential: auth is fully mocked.
const COOKIE = 'class_store_google_auth=v2.synthetic.synthetic.synthetic';
const SESSION = { subject: SUBJECT, email: 'synthetic@example.test', issuedAt: 1 };
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
const MAX_BYTES = 65_536;
// Transport watchdog comfortably exceeds the real reader's 5s total deadline;
// this is resource cleanup, not a budget for the overall verification run.
const HTTP_MS = 30_000;
const TEST_MS = 120_000;
const matchPath = getRouteMatcher(getRouteRegex('/api/migrations/status/[slug]/preflight/download'));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Invalid synthetic fixture');
  return text;
}
function fixture(status: 'BLOCKED' | 'MATCHED_PREFLIGHT' = 'MATCHED_PREFLIGHT') {
  const report = { reportVersion: 1, phase: 'PREFLIGHT', status,
    metrics: status === 'BLOCKED' ? [] : CATEGORIES.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
    diagnostics: status === 'BLOCKED' ? [{ category: 'INTEGRITY', code: 'BINDING_MISMATCH' }] : [], omittedDiagnostics: 0 };
  const details = { report: { ...report, authority: 'SHEETS_AND_REDIS', cutoverAllowed: false },
    comparisonInstant: '2026-09-01T12:00:00.000Z', manifestDigest: 'a'.repeat(64), currentManifestDigest: 'a'.repeat(64),
    sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE' };
  const digest = createHash('sha256').update(canonical([TENANT, JOB, details]), 'utf8').digest('hex');
  const reportId = `reconciliation:${digest}`;
  const event = { tenant_id: TENANT, job_id: JOB, event_id: reportId,
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
    entity_type: null, entity_id: null, redacted_details: details };
  // Independent expected representation; never call the production formatter or
  // projector to manufacture the expected wire bytes from the actual response.
  const body = Buffer.from(`${JSON.stringify({
    projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
    eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
    currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
    reportId, comparisonInstant: details.comparisonInstant, manifestDigest: details.manifestDigest,
    currentManifestDigest: details.currentManifestDigest, sourceFingerprint: details.sourceFingerprint,
    freshness: details.freshness, report,
  })}\n`, 'utf8');
  return { event, reportId, body, disposition: `attachment; filename="historical-preflight-${digest}.json"` };
}
type Fields = readonly (readonly [string, number])[];
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
const reply = (rows: Record<string, unknown>[], fields: Fields): Reply => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const TENANT_FIELDS: Fields = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: Fields = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: Fields = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
const CONTROLS = [
  'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', "SET LOCAL statement_timeout = '1500ms'",
  "SET LOCAL lock_timeout = '500ms'", "SET LOCAL idle_in_transaction_session_timeout = '5000ms'", 'ROLLBACK',
];
let archive: ReturnType<typeof fixture>;
let report: Reply;
let role: 'OWNER' | 'ADMIN';
let queries: QueryConfig[];
let unexpectedQueries: string[];
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
function install(status: 'BLOCKED' | 'MATCHED_PREFLIGHT' = 'MATCHED_PREFLIGHT') {
  archive = fixture(status);
  report = reply([{ found: true, oversized: false, envelope_text: JSON.stringify(archive.event) }], REPORT_FIELDS);
}
function queryString() { return `jobId=${encodeURIComponent(JOB)}&reportId=${encodeURIComponent(archive.reportId)}`; }
function selectedQueries() { return queries.filter(query => query.text.includes('public.audit_events')); }
function expectPrivate(headers: IncomingHttpHeaders) {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) expect(headers[name]).toBe(value);
  for (const name of ['etag', 'last-modified', 'set-cookie', 'location', 'access-control-allow-origin',
    'access-control-allow-credentials', 'content-range', 'accept-ranges', 'x-nextjs-cache']) {
    expect(headers[name]).toBeUndefined();
  }
}
function expectRedacted(value: string) {
  for (const text of [TENANT, USER, MEMBER, SUBJECT, JOB, COOKIE, SESSION.email, 'postgresql://',
    'SHEETS_AND_REDIS', 'redacted_details', 'synthetic-upstream-error']) expect(value).not.toContain(text);
}
type Wire = { status: number | undefined; headers: IncomingHttpHeaders; body: Buffer };
type Seen = { input: NextRequest; rawPath: string; slug: unknown; status: number; bodyless: boolean };
type Send = (method: string, path?: string, headers?: Record<string, string>) => Promise<Wire>;
async function withHttpRoute(run: (send: Send, seen: Seen[]) => Promise<void>) {
  const methods = autoImplementMethods(route as unknown as AppRouteHandlers);
  const seen: Seen[] = [];
  const errors: unknown[] = [];
  const active: Promise<void>[] = [];
  let count = 0;
  const server = createServer((incoming, outgoing) => {
    outgoing.sendDate = false;
    active.push((async () => {
      try {
        if (++count > 16 || !incoming.url || !incoming.method || !isHTTPMethod(incoming.method)) {
          throw new Error('Unexpected loopback request');
        }
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback port');
        const input = new NextRequest(`http://127.0.0.1:${address.port}${incoming.url}`, {
          method: incoming.method,
          headers: new Headers(Object.entries(incoming.headers).flatMap<[string, string]>(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]])),
        });
        const params = matchPath(input.nextUrl.pathname);
        if (!params) throw new Error('Outside this bounded route fixture');
        // Decode params with Next, but pass the ORIGINAL Request unchanged.
        // Do not rebuild its pathname/query using those decoded parameters.
        const response = await methods[incoming.method](input, { params: Promise.resolve(params) });
        if (!(response instanceof Response)) throw new Error('Expected route Response');
        seen.push({ input, rawPath: incoming.url, slug: params.slug, status: response.status, bodyless: response.body === null });
        await sendResponse(new NodeNextRequest(incoming), new NodeNextResponse(outgoing), response);
      } catch (error) {
        errors.push(error);
        if (!outgoing.headersSent) outgoing.statusCode = 500;
        outgoing.end();
      }
    })());
  });
  server.requestTimeout = HTTP_MS;
  server.headersTimeout = HTTP_MS;
  server.on('error', error => { errors.push(error); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing ephemeral address');
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
    const send: Send = (method, path = `${PATH}?${queryString()}`, headers = {}) => new Promise((resolve, reject) => {
      const pending = httpRequest({ hostname: '127.0.0.1', port: address.port, method, path, agent: false,
        signal: AbortSignal.timeout(HTTP_MS), headers: { cookie: COOKIE, ...headers } }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) response.destroy(new Error('Response exceeded fixture byte bound'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Incomplete loopback response')));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      pending.on('error', reject);
      pending.end();
    });
    await run(send, seen);
    await Promise.all(active);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(active);
  }
}

// Ordinary suites must not open sockets on an operational host. The isolated
// invocation must report executed tests, not this default opt-in skip.
describe.skipIf(!isolated)('canonical download: isolated installed-Next Node loopback slice', () => {
  beforeAll(() => {
    const addresses = Object.values(networkInterfaces()).flatMap(value => value ?? []);
    expect(addresses.some(value => value.address === '127.0.0.1')).toBe(true);
    expect(addresses.every(value => value.internal)).toBe(true);
    expect(Object.keys(process.env).filter(name =>
      /SECRET|TOKEN|PASSWORD|DATABASE|REDIS|GOOGLE|AWS_|GCP_|AZURE_|VERCEL|CREDENTIAL|AUTH_/i.test(name))).toEqual([]);
    for (const path of ['.env', '.env.local', '.env.test', '.env.test.local', '.env.production', '.env.development',
      '/home/haeon/.hermes', '/run/user', '/var/run/docker.sock']) expect(existsSync(path)).toBe(false);
  });
  beforeEach(() => {
    vi.resetAllMocks();
    install(); role = 'OWNER'; queries = []; unexpectedQueries = [];
    mocks.session.mockReturnValue(SESSION);
    mocks.config.mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/never-connected' });
    client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (config: QueryConfig): Promise<Reply> => {
        queries.push(config);
        if (config.text.includes('public.audit_events')) return report;
        if (config.text.includes('public.platform_find_membership')) return reply([
          { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role },
        ], MEMBER_FIELDS);
        if (config.text.includes('public.platform_find_tenant')) return reply([
          { id: TENANT, slug: 'alpha', display_name: 'Synthetic class', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' },
        ], TENANT_FIELDS);
        if (CONTROLS.includes(config.text) || config.text === "SELECT set_config('app.tenant_id', $1, true)") return reply([], []);
        unexpectedQueries.push(config.text);
        throw new Error('Unexpected SQL in read-only fixture');
      }), release: vi.fn(), end: vi.fn(async () => {}),
    });
    mocks.connect.mockResolvedValue(client);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Egress forbidden')));
  });
  afterEach(() => {
    try {
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.forbidden).not.toHaveBeenCalled();
      expect(unexpectedQueries).toEqual([]);
      expect(client.listenerCount('error')).toBe(0);
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it.each(['OWNER', 'ADMIN'] as const)('sends exact MATCHED/BLOCKED bytes and empty HEAD for current mocked %s', async currentRole => {
    role = currentRole;
    const read = vi.spyOn(reader, 'readPreflightReport');
    const download = vi.spyOn(adapter, 'readHistoricalReportDownload');
    await withHttpRoute(async (send, seen) => {
      for (const status of ['MATCHED_PREFLIGHT', 'BLOCKED'] as const) {
        install(status);
        // Alternate selector order/encoding without normalizing the Request.
        const path = `${PATH}?reportId=${archive.reportId}&jobId=${encodeURIComponent(JOB).replace(/%20/g, '+')}`;
        for (const method of ['GET', 'HEAD']) {
          const response = await send(method, path, {
            origin: 'https://synthetic.invalid', range: 'bytes=0-10', 'if-none-match': '*',
            'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT', 'x-role': 'VIEWER', 'x-tenant-id': USER,
          });
          expect(response.status).toBe(200);
          expectPrivate(response.headers);
          expect(response.headers['content-disposition']).toBe(archive.disposition);
          expect(response.body).toEqual(method === 'HEAD' ? Buffer.alloc(0) : archive.body);
          expect(response.body.length).toBeLessThanOrEqual(MAX_BYTES);
          if (method === 'GET') {
            expect(response.body[0]).toBe(123); // No UTF-8 BOM or double-encoded JSON.
            const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
            expect(text.endsWith('\n')).toBe(true); expect(text.endsWith('\n\n')).toBe(false);
          }
          expectRedacted(response.body.toString('utf8'));
          expectRedacted(JSON.stringify(response.headers));
          const received = seen.at(-1)!;
          expect(received.rawPath).toBe(path);
          expect(received.input.url).toBe(`${new URL(received.input.url).origin}${path}`);
          expect(received.input.method).toBe(method);
          expect(received.input.headers.get('cookie')).toBe(COOKIE);
          expect(received.input.bodyUsed).toBe(false);
          expect(received.bodyless).toBe(method === 'HEAD');
          expect(download.mock.calls.at(-1)).toEqual(['alpha', received.input]);
          expect(read.mock.calls.at(-1)?.[1]).toBe(received.input);
          expect(download.mock.calls.at(-1)?.[1]).toBe(received.input);
          expect(mocks.session.mock.calls.at(-1)?.[0]).toBe(received.input);
          expect(selectedQueries().at(-1)?.values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', archive.reportId]);
          expect(queries.at(-1)?.text).toBe('ROLLBACK');
        }
      }
    });
    expect(mocks.connect).toHaveBeenCalledTimes(4);
    expect(selectedQueries()).toHaveLength(4);
    expect(client.release.mock.calls).toEqual([[], [], [], []]);
  }, TEST_MS);

  it.each([
    ['%61lpha', 'alpha', 400], ['Alpha', 'Alpha', 403],
    ['alpha%2Fbeta', 'alpha/beta', 403], ['alpha%252Fbeta', 'alpha%2Fbeta', 403],
  ] as const)('keeps original pathname %s distinct from Next-decoded params', async (segment, decoded, status) => {
    const read = vi.spyOn(reader, 'readPreflightReport');
    const path = `/api/migrations/status/${segment}/preflight/download?${queryString()}`;
    await withHttpRoute(async (send, seen) => {
      for (const method of ['GET', 'HEAD']) {
        const response = await send(method, path);
        expect(response.status).toBe(status); expectPrivate(response.headers);
        expect(response.body).toEqual(Buffer.from(method === 'HEAD' ? '' : JSON.stringify({
          error: status === 400 ? 'INVALID_PREFLIGHT_REQUEST' : 'ACCESS_DENIED',
        })));
        expect(seen.at(-1)?.slug).toBe(decoded);
        expect(seen.at(-1)?.rawPath).toBe(path);
        expect(new URL(seen.at(-1)!.input.url).pathname).toBe(`/api/migrations/status/${segment}/preflight/download`);
        expect(read.mock.calls.at(-1)?.[0]).toBe(decoded);
        expect(read.mock.calls.at(-1)?.[1]).toBe(seen.at(-1)?.input);
      }
    });
    expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  }, TEST_MS);

  it.each(['trailing-slash', 'duplicate', 'encoded-key', 'malformed-percent', 'malformed-utf8', 'extra'] as const)(
    'rejects original %s boundary before mocked auth/SQL for GET and HEAD', async kind => {
      const query = queryString();
      const paths = {
        'trailing-slash': `${PATH}/?${query}`,
        duplicate: `${PATH}?${query}&jobId=other`,
        'encoded-key': `${PATH}?${query.replace('jobId=', '%6AobId=')}`,
        'malformed-percent': `${PATH}?jobId=%GG&reportId=${archive.reportId}`,
        'malformed-utf8': `${PATH}?jobId=%C0%AF&reportId=${archive.reportId}`,
        extra: `${PATH}?${query}&cutoverAllowed=true`,
      };
      const read = vi.spyOn(reader, 'readPreflightReport');
      await withHttpRoute(async (send, seen) => {
        for (const method of ['GET', 'HEAD']) {
          const response = await send(method, paths[kind]);
          expect(response.status).toBe(400); expectPrivate(response.headers);
          expect(response.headers['content-disposition']).toBeUndefined();
          expect(response.body).toEqual(Buffer.from(method === 'HEAD' ? '' : '{"error":"INVALID_PREFLIGHT_REQUEST"}'));
          const received = seen.at(-1)!;
          expect(received.input.url).toBe(`${new URL(received.input.url).origin}${paths[kind]}`);
          expect(read.mock.calls.at(-1)?.[1]).toBe(received.input);
        }
      });
      expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    }, TEST_MS,
  );

  it.each(['unauthenticated', 'revoked', 'not-found', 'unavailable'] as const)(
    'sends private %s failure bytes and empty HEAD without an attachment', async outcome => {
      if (outcome === 'unauthenticated') mocks.session.mockReturnValue(null);
      if (outcome === 'revoked') report = reply([], REPORT_FIELDS);
      if (outcome === 'not-found') report = reply([{ found: false, oversized: false, envelope_text: null }], REPORT_FIELDS);
      if (outcome === 'unavailable') mocks.connect.mockRejectedValue(new Error('synthetic-upstream-error'));
      const expected = {
        unauthenticated: [401, 'AUTHENTICATION_REQUIRED'], revoked: [403, 'ACCESS_DENIED'],
        'not-found': [404, 'PREFLIGHT_REPORT_NOT_FOUND'], unavailable: [503, 'PREFLIGHT_REPORT_UNAVAILABLE'],
      }[outcome];
      await withHttpRoute(async send => {
        for (const method of ['GET', 'HEAD']) {
          const response = await send(method);
          expect(response.status).toBe(expected[0]); expectPrivate(response.headers);
          expect(response.headers['content-disposition']).toBeUndefined();
          expect(response.body).toEqual(Buffer.from(method === 'HEAD' ? '' : JSON.stringify({ error: expected[1] })));
          expectRedacted(response.body.toString('utf8')); expectRedacted(JSON.stringify(response.headers));
        }
      });
      if (outcome === 'unauthenticated') expect(mocks.connect).not.toHaveBeenCalled();
      else expect(mocks.connect).toHaveBeenCalledTimes(2);
    }, TEST_MS,
  );

  it('rechecks final mocked membership on HEAD after a successful wire GET', async () => {
    await withHttpRoute(async send => {
      expect((await send('GET')).body).toEqual(archive.body);
      report = reply([], REPORT_FIELDS); // Revocation in the next statement's mocked result.
      const response = await send('HEAD');
      expect(response.status).toBe(403); expect(response.body).toEqual(Buffer.alloc(0));
      expectPrivate(response.headers); expect(response.headers['content-disposition']).toBeUndefined();
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2); expect(selectedQueries()).toHaveLength(2);
    expect(client.release.mock.calls).toEqual([[], []]);
  }, TEST_MS);

  it('uses installed Next OPTIONS/405 dispatch without route/auth/SQL or inherited private headers', async () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'HEAD', 'dynamic', 'runtime']);
    expect(route.dynamic).toBe('force-dynamic'); expect(route.runtime).toBe('nodejs');
    const download = vi.spyOn(adapter, 'readHistoricalReportDownload');
    await withHttpRoute(async send => {
      for (const method of ['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await send(method, `${PATH}?unexpected=synthetic`, {
          origin: 'https://synthetic.invalid', 'access-control-request-method': 'POST',
        });
        expect(response.status).toBe(method === 'OPTIONS' ? 204 : 405);
        expect(response.body).toEqual(Buffer.alloc(0));
        expect(response.headers.allow).toBe(method === 'OPTIONS' ? 'GET, HEAD, OPTIONS' : undefined);
        for (const header of [...Object.keys(PRIVATE_HEADERS), 'content-disposition', 'set-cookie', 'location',
          'access-control-allow-origin', 'access-control-allow-credentials']) expect(response.headers[header]).toBeUndefined();
      }
    });
    expect(download).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled(); expect(queries).toEqual([]);
  }, TEST_MS);
});
