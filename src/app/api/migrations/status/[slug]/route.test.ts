// @vitest-environment node
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { NodeNextRequest, NodeNextResponse } from 'next/dist/server/base-http/node';
import { sendResponse } from 'next/dist/server/send-response';
import { isHTTPMethod } from 'next/dist/server/web/http';
import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { AppRouteHandlers } from 'next/dist/server/route-modules/app-route/module';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ dependencies: vi.fn(), database: vi.fn() }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: mocks.database }));
vi.mock('@/server/tenantAccess', async importOriginal => ({
  ...await importOriginal<typeof import('@/server/tenantAccess')>(),
  getProductionTenantAccessDependencies: mocks.dependencies,
}));

import { createTenantAccessDependencies } from '@/server/tenantAccess';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest, setGoogleSessionCookie } from '@/server/googleOAuth';
import * as route from './route';

const tenantId = '20000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const session = { subject: 'private-subject', email: 'private@example.test', issuedAt: 1 };
const tenant = { id: tenantId, slug: 'alpha', display_name: 'private-class-name', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const member = { id: 'private-member-id', tenant_id: tenantId, user_id: 'private-user-id', google_subject: session.subject, role: 'OWNER' };
const tenantQuery = 'SELECT * FROM public.platform_find_tenant_by_slug($1)';
const membershipQuery = 'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)';
const query = vi.fn<(text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>();
const getSession = vi.fn<(request: Request) => typeof session | null>(() => session);
const getCompatibilitySession = vi.fn(async () => ({ tenantId }));
const blocked = {
  availability: 'BLOCKED',
  reasonCode: 'TRUSTED_STATUS_READER_UNAVAILABLE',
  reason: '검증된 이전 상태 조회가 연결되지 않아 진행 상태와 운영 권한을 확인할 수 없어요.',
  readOnly: true,
  migrationStatus: 'UNKNOWN',
  authority: 'UNKNOWN',
};
let fetchSpy: ReturnType<typeof vi.spyOn>;

function request(slug = 'alpha', queryString = '', headers?: HeadersInit) {
  return new Request(`https://example.test/api/migrations/status/${slug}${queryString}`, { headers });
}
function get(slug = 'alpha', input = request(slug)) {
  return route.GET(input, { params: Promise.resolve({ slug }) });
}
function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(response.headers.get('etag')).toBeNull();
}
function assertResponse(value: unknown): asserts value is Response {
  expect(value).toBeInstanceOf(Response);
}

const matchStatusPath = getRouteMatcher(getRouteRegex('/api/migrations/status/[slug]'));
type HttpResult = { status: number | undefined; headers: IncomingHttpHeaders; body: string };
type Send = (method: string, path?: string, headers?: Record<string, string>) => Promise<HttpResult>;

// Bounded runtime slice, not a full Next server: use the installed parameter
// decoder, method dispatcher and Node response sender over loopback HTTP.
// Access SELECTs remain test doubles; no env files or production DB are loaded.
async function withHttpRoute(run: (send: Send) => Promise<void>) {
  const methods = autoImplementMethods(route as unknown as AppRouteHandlers);
  const errors: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const input = new NextRequest(new URL(incoming.url!, 'http://127.0.0.1'), {
        method: incoming.method,
        headers: new Headers(Object.entries(incoming.headers).flatMap<[string, string]>(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]])),
      });
      const params = matchStatusPath(input.nextUrl.pathname);
      if (!params || !incoming.method || !isHTTPMethod(incoming.method)) {
        throw new Error('Unexpected runtime test request');
      }
      const response = await methods[incoming.method](input, { params: Promise.resolve(params) });
      assertResponse(response);
      await sendResponse(new NodeNextRequest(incoming), new NodeNextResponse(outgoing), response);
    } catch (error) {
      errors.push(error);
      outgoing.statusCode = 500;
      outgoing.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const send: Send = (method, path = '/api/migrations/status/alpha', headers = {}) =>
      new Promise((resolve, reject) => {
        const pending = httpRequest({ hostname: '127.0.0.1', port, method, path, headers, agent: false }, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
        });
        pending.on('error', reject);
        pending.end();
      });
    await run(send);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockReturnValue(session);
  getCompatibilitySession.mockResolvedValue({ tenantId });
  query.mockImplementation(async (text, values) => {
    if (text === tenantQuery && values?.[0] === 'alpha') return { rows: [{ ...tenant }] };
    if (text === membershipQuery && values?.[0] === tenantId && values?.[1] === session.subject) return { rows: [{ ...member }] };
    throw new Error('Unexpected database operation');
  });
  mocks.dependencies.mockReturnValue({ ...createTenantAccessDependencies({ query }, getSession), getCompatibilitySession });
  mocks.database.mockImplementation(() => { throw new Error('A real database must not be opened'); });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must not be used'));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mocks.database).not.toHaveBeenCalled();
  expect(getCompatibilitySession).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('read-only tenant migration status', () => {
  it.each(['OWNER', 'ADMIN'])('returns only a blocked, unknown projection for %s', async role => {
    query.mockResolvedValueOnce({ rows: [tenant] }).mockResolvedValueOnce({ rows: [{ ...member, role }] });
    const response = await get();
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual(blocked);
    expect(query.mock.calls).toEqual([[tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]]]);
  });

  it('requires authentication before directory lookup, even with forged caller authority', async () => {
    getSession.mockReturnValue(null);
    const response = await get('alpha', request('alpha', '', {
      cookie: 'class_store_tenant_admin=forged', 'x-tenant-id': tenantId, 'x-role': 'OWNER', 'x-migration-status': 'ACTIVE',
    }));
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'AUTHENTICATION_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['valid', 'expired', 'tampered', 'corrupted-ciphertext'])('uses the existing Google verifier for a %s encrypted identity cookie', async state => {
    const env = { AUTH_SECRET: 'task20-test-only-secret-not-a-production-credential' };
    vi.stubEnv('AUTH_SECRET', env.AUTH_SECRET);
    const issued = NextResponse.json({ ok: true });
    setGoogleSessionCookie(issued, { ...session, issuedAt: state === 'expired' ? 1 : Date.now() });
    const token = issued.cookies.get(GOOGLE_AUTH_COOKIE)?.value;
    expect(token).toBeTruthy();
    if (!token) throw new Error('Test cookie was not issued');
    const parts = token.split('.');
    if (state === 'corrupted-ciphertext') {
      parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
    }
    getSession.mockImplementation(input => getGoogleSessionFromRequest(input, env));
    const response = await get('alpha', request('alpha', '', {
      cookie: `${GOOGLE_AUTH_COOKIE}=${parts.join('.')}${state === 'tampered' ? '.extra' : ''}`,
    }));
    expectPrivate(response);
    if (state === 'valid') {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(blocked);
    } else {
      expect(response.status).toBe(401);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['nonmember', []],
    ['wrong tenant', [{ ...member, tenant_id: otherTenantId }]],
    ['wrong subject', [{ ...member, google_subject: 'other-subject' }]],
    ['unsupported role', [{ ...member, role: 'STUDENT' }]],
  ])('refuses %s without a compatibility fallback', async (_label, rows) => {
    query.mockResolvedValueOnce({ rows: [tenant] }).mockResolvedValueOnce({ rows });
    const response = await get();
    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'ACCESS_DENIED' });
  });

  it('does not let tenant headers override the canonical path tenant', async () => {
    query.mockImplementation(async (text, values) => {
      if (text === tenantQuery && values?.[0] === 'beta') return { rows: [{ ...tenant, id: otherTenantId, slug: 'beta' }] };
      if (text === membershipQuery && values?.[0] === otherTenantId) return { rows: [] };
      throw new Error('Unexpected query');
    });
    const response = await get('beta', request('beta', '', { 'x-tenant-id': tenantId, 'x-tenant-slug': 'alpha' }));
    expect(response.status).toBe(403);
    expect(query.mock.calls).toEqual([[tenantQuery, ['beta']], [membershipQuery, [otherTenantId, session.subject]]]);
  });

  it.each([
    ['missing tenant', []],
    ['wrong directory slug', [{ ...tenant, slug: 'beta' }]],
    ['malformed directory tenant ID', [{ ...tenant, id: 'invalid' }]],
  ])('does not expose %s', async (_label, rows) => {
    query.mockResolvedValueOnce({ rows });
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ACCESS_DENIED' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['Alpha', 'bad_slug', 'a'.repeat(64)])('rejects noncanonical slug %s before lookup', async slug => {
    const response = await get(slug);
    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['?tenantId=other', '?status=ACTIVE&cutoverAllowed=true', '?jobId=private-job&token=private-token'])('refuses caller-supplied selection or state: %s', async suffix => {
    const response = await get('alpha', request('alpha', suffix));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'INVALID_STATUS_REQUEST' });
    expect(mocks.dependencies).not.toHaveBeenCalled();
  });

  it('refuses a URL/route-parameter mismatch', async () => {
    const response = await get('alpha', request('beta'));
    expect(response.status).toBe(400);
    expect(mocks.dependencies).not.toHaveBeenCalled();
  });

  it('redacts a rejected asynchronous route parameter without attempting access reads', async () => {
    const response = await route.GET(request(), {
      params: Promise.reject(new Error('private-token postgresql://private-password')),
    });
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'ACCESS_CHECK_UNAVAILABLE' });
    expect(mocks.dependencies).not.toHaveBeenCalled();
  });

  it('revalidates membership on every read after revocation', async () => {
    const firstRequest = request();
    const first = await get('alpha', firstRequest);
    expect(first.status).toBe(503);
    expectPrivate(first);
    expect(await first.json()).toEqual(blocked);
    // No job: initial identity plus the post-membership publication gate.
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getSession.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
    expect(query.mock.invocationCallOrder[1]).toBeLessThan(getSession.mock.invocationCallOrder[1]);
    query.mockResolvedValueOnce({ rows: [tenant] }).mockResolvedValueOnce({ rows: [] });
    const revokedRequest = request();
    const revoked = await get('alpha', revokedRequest);
    expect(revoked.status).toBe(403);
    expectPrivate(revoked);
    expect(await revoked.json()).toEqual({ error: 'ACCESS_DENIED' });
    // Revoked membership exits after initial identity, without a status DTO.
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(getSession.mock.calls.map(([input]) => input)).toEqual([firstRequest, firstRequest, revokedRequest]);
    expect(query.mock.calls).toEqual([
      [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
      [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
    ]);
  });

  it.each(['session', 'directory', 'membership', 'composition'])('redacts all %s failures', async point => {
    const error = new Error('private-source-row private-sheet-id private-refresh-token postgresql://private-password');
    if (point === 'session') getSession.mockImplementationOnce(() => { throw error; });
    if (point === 'directory') query.mockRejectedValueOnce(error);
    if (point === 'membership') query.mockResolvedValueOnce({ rows: [tenant] }).mockRejectedValueOnce(error);
    if (point === 'composition') mocks.dependencies.mockImplementationOnce(() => { throw error; });
    const response = await get();
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'ACCESS_CHECK_UNAVAILABLE' });
  });

  it('does not spread identity, source data, or local candidate state into the response', async () => {
    const extras = { candidateStatus: 'ACTIVE', sourceRow: 'private-source-row', spreadsheetId: 'private-sheet-id', accessToken: 'private-token' };
    query.mockResolvedValueOnce({ rows: [{ ...tenant, ...extras }] }).mockResolvedValueOnce({ rows: [{ ...member, ...extras }] });
    const response = await get('alpha', request('alpha', '', { 'x-migration-status': 'ACTIVE', 'x-cutover-allowed': 'true' }));
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(blocked);
    for (const value of [...Object.values(extras), tenantId, tenant.display_name, session.email, session.subject, member.user_id]) {
      expect(body).not.toContain(value);
    }
  });

  it('performs only the two existing access SELECTs on repeated GETs', async () => {
    const before = structuredClone({ tenant, member });
    await get();
    await get();
    expect(query.mock.calls).toEqual([
      [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
      [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
    ]);
    expect({ tenant, member }).toEqual(before);
  });

  it('exports no mutating endpoint and explicitly stays dynamic', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects even a direct %s call into GET without reading state', async method => {
    const response = await get('alpha', new Request(request().url, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expectPrivate(response);
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  // Exercise the installed Next.js dispatcher, not just absence of exports.
  // Next supplies the required route params; its generic type marks them optional.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('Next.js returns 405 for %s without invoking the reader', async method => {
    const methods = autoImplementMethods(route as unknown as AppRouteHandlers);
    const response = await methods[method](new NextRequest(request().url, { method }), {
      params: Promise.resolve({ slug: 'alpha' }),
    });
    assertResponse(response);
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('');
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('Next.js advertises read-only methods and HEAD uses the same authorization boundary', async () => {
    const methods = autoImplementMethods(route as unknown as AppRouteHandlers);
    const options = await methods.OPTIONS(new NextRequest(request().url, { method: 'OPTIONS' }), {});
    assertResponse(options);
    expect(options.status).toBe(204);
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(mocks.dependencies).not.toHaveBeenCalled();
    const head = await methods.HEAD(new NextRequest(request().url, { method: 'HEAD' }), {
      params: Promise.resolve({ slug: 'alpha' }),
    });
    assertResponse(head);
    expect(head.status).toBe(503);
    expectPrivate(head);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('installed Next.js status runtime boundaries', () => {
  it.each([
    ['%61lpha', 'alpha', 400],
    ['%41lpha', 'Alpha', 400],
    ['%2561lpha', '%61lpha', 400],
    ['alpha%2Fbeta', 'alpha/beta', 400],
    ['alpha%252Fbeta', 'alpha%2Fbeta', 400],
    ['alpha%5Cbeta', 'alpha\\beta', 400],
    ['alpha%3FtenantId=beta', 'alpha?tenantId=beta', 400],
    ['alpha%23private-token', 'alpha#private-token', 400],
    ['alpha%00', 'alpha\0', 400],
    ['alpha%0A', 'alpha\n', 400],
    ['alpha%20', 'alpha ', 400],
    ['alpha/', 'alpha', 400],
    ['Alpha', 'Alpha', 403],
    ['alpha;private-token', 'alpha;private-token', 403],
    ['alpha--beta', 'alpha--beta', 403],
    ['-alpha', '-alpha', 403],
    ['alpha-', 'alpha-', 403],
  ])('refuses noncanonical path %s after Next decoding for GET and HEAD', async (segment, decoded, status) => {
    const path = `/api/migrations/status/${segment}`;
    expect(matchStatusPath(path)).toEqual({ slug: decoded });
    await withHttpRoute(async send => {
      for (const method of ['GET', 'HEAD']) {
        const response = await send(method, path);
        expect(response.status).toBe(status);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers.vary).toBe('Cookie');
        expect(response.headers.location).toBeUndefined();
        if (method === 'HEAD') expect(response.body).toBe('');
        else expect(JSON.parse(response.body)).toEqual({ error: status === 400 ? 'INVALID_STATUS_REQUEST' : 'ACCESS_DENIED' });
      }
    });
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['%', '%GG', '%C0%AF', '%ED%A0%80'])('Next rejects malformed encoding %s before a reader can be called', segment => {
    expect(() => matchStatusPath(`/api/migrations/status/${segment}`)).toThrow('failed to decode param');
    expect(mocks.dependencies).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'unauthenticated', 'forbidden', 'unavailable', 'invalid'] as const)(
    'keeps GET/HEAD %s responses private and HEAD bodyless on the wire', async outcome => {
      if (outcome === 'unauthenticated') getSession.mockReturnValue(null);
      if (outcome === 'forbidden') query.mockResolvedValue({ rows: [] });
      if (outcome === 'unavailable') getSession.mockImplementation(() => { throw new Error('private-token private-password'); });
      const expected = {
        blocked: { status: 503, body: blocked },
        unauthenticated: { status: 401, body: { error: 'AUTHENTICATION_REQUIRED' } },
        forbidden: { status: 403, body: { error: 'ACCESS_DENIED' } },
        unavailable: { status: 503, body: { error: 'ACCESS_CHECK_UNAVAILABLE' } },
        invalid: { status: 400, body: { error: 'INVALID_STATUS_REQUEST' } },
      }[outcome];
      await withHttpRoute(async send => {
        const path = `/api/migrations/status/alpha${outcome === 'invalid' ? '?token=private-token&status=ACTIVE' : ''}`;
        for (const method of ['GET', 'HEAD']) {
          const response = await send(method, path, {
            cookie: 'class_store_tenant_admin=private-forged-cookie',
            origin: 'https://untrusted.example.test',
            'if-none-match': '*', 'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT',
          });
          expect(response.status).toBe(expected.status);
          expect(response.headers['cache-control']).toBe('private, no-store');
          expect(response.headers['referrer-policy']).toBe('no-referrer');
          expect(response.headers.vary).toBe('Cookie');
          for (const header of ['etag', 'last-modified', 'set-cookie', 'location', 'access-control-allow-origin']) {
            expect(response.headers[header]).toBeUndefined();
          }
          expect(JSON.stringify(response)).not.toContain('private-');
          if (method === 'HEAD') expect(response.body).toBe('');
          else expect(JSON.parse(response.body)).toEqual(expected.body);
        }
      });
      if (outcome === 'invalid') expect(getSession).not.toHaveBeenCalled();
      else {
        // Only admitted membership reaches the second, no-job identity gate.
        // Next dispatches HEAD to GET, but both requests must authenticate.
        expect(getSession).toHaveBeenCalledTimes(outcome === 'blocked' ? 4 : 2);
        expect(getSession.mock.calls.map(([input]) => input.method)).toEqual(
          outcome === 'blocked' ? ['GET', 'GET', 'HEAD', 'HEAD'] : ['GET', 'HEAD'],
        );
      }
      if (outcome === 'blocked') expect(query.mock.calls).toEqual([
        [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
        [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
      ]);
      if (['invalid', 'unauthenticated', 'unavailable'].includes(outcome)) expect(query).not.toHaveBeenCalled();
    },
  );

  it('OPTIONS and unsupported writes stay empty without authentication, CORS grants or access reads', async () => {
    await withHttpRoute(async send => {
      for (const method of ['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await send(method, '/api/migrations/status/alpha?token=private-token', {
          origin: 'https://untrusted.example.test', 'access-control-request-method': 'POST',
        });
        expect(response.status).toBe(method === 'OPTIONS' ? 204 : 405);
        expect(response.body).toBe('');
        expect(response.headers.allow).toBe(method === 'OPTIONS' ? 'GET, HEAD, OPTIONS' : undefined);
        for (const header of ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials']) {
          expect(response.headers[header]).toBeUndefined();
        }
      }
    });
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rechecks membership between a wire GET and HEAD rather than reusing a blocked 503', async () => {
    await withHttpRoute(async send => {
      const first = await send('GET');
      expect(first.status).toBe(503);
      expect(JSON.parse(first.body)).toEqual(blocked);
      // The admitted GET revalidates after membership; revoked HEAD cannot.
      expect(getSession).toHaveBeenCalledTimes(2);
      query.mockResolvedValueOnce({ rows: [tenant] }).mockResolvedValueOnce({ rows: [] });
      const revoked = await send('HEAD');
      expect(revoked.status).toBe(403);
      expect(revoked.body).toBe('');
      for (const response of [first, revoked]) {
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers.vary).toBe('Cookie');
        for (const header of ['etag', 'last-modified', 'set-cookie', 'location', 'access-control-allow-origin']) {
          expect(response.headers[header]).toBeUndefined();
        }
      }
    });
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(getSession.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'GET', 'HEAD']);
    expect(query.mock.calls).toEqual([
      [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
      [tenantQuery, ['alpha']], [membershipQuery, [tenantId, session.subject]],
    ]);
  });
});
