// @vitest-environment node
import { NextRequest } from 'next/server';
import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { AppRouteHandlers } from 'next/dist/server/route-modules/app-route/module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreflightReportProjection } from '../../preflightReportProjection';

vi.mock('../../readPreflightReport', () => ({ readPreflightReport: vi.fn() }));
import { readPreflightReport } from '../../readPreflightReport';
import * as route from './route';

// In-process characterization of the CURRENT inline-JSON canonical route.
// Installed Next 16.3.3: dist/docs/01-app/03-api-reference/03-file-conventions/route.md
// (automatic OPTIONS), dist/server/route-modules/app-route/helpers/auto-implement-methods.js
// (bodyless 405/204, implicit HEAD), and app-route/module.js (helper dispatch table).
// The real helper and route run; the reader is mocked, so no authentication,
// selector admission, projection validation, PG, Sheets or Redis is exercised.
// This is NOT AppRouteRouteModule.handle(), Next HTTP/sendResponse, browser,
// proxy/CDN or production-cache evidence. Unknown HTTP verbs are outside this
// helper's table, not additional 405 cases. No synthetic dispatcher fallback.
const read = vi.mocked(readPreflightReport);
// Next's generic context permits absent params; this slug route requires them.
// This cast changes only TypeScript's view, not handlers, requests or dispatch.
const dispatched = autoImplementMethods(route as unknown as AppRouteHandlers);
const READ_METHODS = ['GET', 'HEAD'] as const;
const MISSING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
type ReadMethod = typeof READ_METHODS[number];
const PRIVATE = 'synthetic-only-cookie-and-upstream-detail';
const JOB = 'synthetic-private-dispatch-job';
const REPORT_ID = `reconciliation:${'a'.repeat(64)}`;
const privateHeaders = {
  'cache-control': 'private, no-store',
  'content-type': 'application/json',
  'referrer-policy': 'no-referrer',
  vary: 'Cookie',
};
const errors = [
  ['INVALID_REQUEST', 400, 'INVALID_PREFLIGHT_REQUEST'],
  ['UNAUTHENTICATED', 401, 'AUTHENTICATION_REQUIRED'],
  ['FORBIDDEN', 403, 'ACCESS_DENIED'],
  ['NOT_FOUND', 404, 'PREFLIGHT_REPORT_NOT_FOUND'],
  ['UNAVAILABLE', 503, 'PREFLIGHT_REPORT_UNAVAILABLE'],
] as const;

function request(method: string, cookie = PRIVATE) {
  return new NextRequest(`https://example.test/api/migrations/status/alpha/preflight?jobId=${JOB}&reportId=${REPORT_ID}`, {
    method,
    signal: new AbortController().signal,
    headers: {
      cookie: `class_store_google_auth=${cookie}`,
      origin: 'https://untrusted.example.test',
      'if-none-match': '*',
      'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT',
      range: 'bytes=0-10',
    },
  });
}
const context = () => ({ params: Promise.resolve({ slug: 'alpha' }) });
function unreadableContext() {
  const params = vi.fn((): Promise<{ slug: string }> => { throw new Error(PRIVATE); });
  return { params, value: { get params() { return params(); } } };
}
async function dispatch(method: keyof typeof dispatched, input = request(method), ctx = context()) {
  const response = await dispatched[method](input, ctx);
  // Next's AppRouteHandlerFn returns unknown; never coerce a failed import or
  // non-Response into fabricated transport evidence.
  if (!(response instanceof Response)) throw new Error('Expected a Web Response');
  return response;
}
function expectHeaders(response: Response, expected: Record<string, string>) {
  // Exact in-process headers also exclude CORS grants, Set-Cookie, redirects,
  // cache validators, Content-Range and attachment metadata. Not wire headers.
  expect(Object.fromEntries(response.headers)).toEqual(expected);
}
async function expectPrivateResponse(response: Response, method: ReadMethod, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expectHeaders(response, privateHeaders);
  const text = await response.text();
  if (method === 'HEAD') {
    expect(response.body).toBeNull();
    expect(text).toBe('');
  } else {
    expect(JSON.parse(text)).toEqual(body);
  }
  for (const sensitive of [PRIVATE, JOB, 'class_store_google_auth']) {
    expect(text).not.toContain(sensitive);
    expect(JSON.stringify([...response.headers])).not.toContain(sensitive);
  }
}
function projection(status: 'BLOCKED' | 'MATCHED_PREFLIGHT'): PreflightReportProjection {
  // Synthetic already-projected reader output, not a generated/verified archive.
  const categories: PreflightReportProjection['report']['metrics'][number]['category'][] = [
    'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
    'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
    'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
    'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
    'ORPHANED_CLAIMS', 'RECURRENCE',
  ];
  return {
    projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY',
    verification: 'INTEGRITY_ONLY', eventIntegrity: 'VERIFIED',
    originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
    currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
    reportId: REPORT_ID, comparisonInstant: null, manifestDigest: 'b'.repeat(64),
    currentManifestDigest: null, sourceFingerprint: 'c'.repeat(64),
    freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
    report: {
      reportVersion: 1, phase: 'PREFLIGHT', status,
      metrics: status === 'BLOCKED' ? [] : categories.map(category => ({
        category, expected: '0', actual: '0', delta: '0', status: 'MATCH',
      })),
      diagnostics: status === 'BLOCKED' ? [{ category: 'INTEGRITY', code: 'BINDING_MISMATCH' }] : [],
      omittedDiagnostics: 0,
    },
  };
}
function expectOriginalRequest(input: NextRequest) {
  expect(read).toHaveBeenCalledExactlyOnceWith('alpha', input);
  const forwarded = read.mock.calls[0][1];
  expect(forwarded).toBe(input);
  expect(forwarded.url).toBe(input.url);
  expect(forwarded.headers).toBe(input.headers);
  expect(forwarded.headers.get('cookie')).toBe(input.headers.get('cookie'));
  expect(forwarded.signal).toBe(input.signal);
}

beforeEach(() => { read.mockReset(); });

describe('current route: direct calls versus installed Next auto-method table', () => {
  it('preserves explicit GET/HEAD identity and dynamic Node configuration', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'HEAD', 'dynamic', 'runtime']);
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
    expect(dispatched.GET).toBe(route.GET);
    expect(dispatched.HEAD).toBe(route.HEAD);
    expect(dispatched.HEAD).not.toBe(route.GET);
    expect(Object.keys(dispatched).sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    expect(read).not.toHaveBeenCalled();
  });

  describe.each(READ_METHODS)('direct %s export is not HTTP method dispatch', exportedMethod => {
    it.each(MISSING_METHODS)('distinguishes a %s request from its Next-generated response', async method => {
      const input = request(method);
      const ctx = unreadableContext();
      const direct = await route[exportedMethod](input, ctx.value);
      expect(direct.status).toBe(405);
      expectHeaders(direct, { ...privateHeaders, allow: 'GET, HEAD, OPTIONS' });
      if (exportedMethod === 'HEAD') {
        expect(direct.body).toBeNull();
        expect(await direct.text()).toBe('');
      } else {
        expect(await direct.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
      }
      expect(read).not.toHaveBeenCalled();
      expect(ctx.params).not.toHaveBeenCalled();

      const automatic = await dispatch(method, input, ctx.value);
      expect(automatic.status).toBe(method === 'OPTIONS' ? 204 : 405);
      expect(automatic.body).toBeNull();
      expect(await automatic.text()).toBe('');
      // Deliberately NOT expectPrivateResponse(): the helper supplies no private
      // headers, content type or CORS grant. OPTIONS supplies only Allow.
      expectHeaders(automatic, method === 'OPTIONS' ? { allow: 'GET, HEAD, OPTIONS' } : {});
      expect(read).not.toHaveBeenCalled();
      expect(ctx.params).not.toHaveBeenCalled();
    });
  });

  it.each(READ_METHODS)('rejects the opposite read method when calling %s directly, before params/reader', async exportedMethod => {
    const otherMethod = exportedMethod === 'GET' ? 'HEAD' : 'GET';
    const ctx = unreadableContext();
    const response = await route[exportedMethod](request(otherMethod), ctx.value);
    expect(response.status).toBe(405);
    expectHeaders(response, { ...privateHeaders, allow: 'GET, HEAD, OPTIONS' });
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(ctx.params).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe.each(READ_METHODS)('installed Next table -> explicit %s (mocked reader, not HTTP)', method => {
  it.each(['BLOCKED', 'MATCHED_PREFLIGHT'] as const)('keeps %s historical-only and the current private inline representation', async status => {
    const expected = projection(status);
    // The route trusts the reader projection. Only extra result-envelope fields
    // are checked here; this does not claim that the route sanitizes projections.
    const result = { kind: 'HISTORICAL_REPORT' as const, projection: expected, details: PRIVATE };
    read.mockResolvedValueOnce(result);
    const input = request(method);
    const response = await dispatch(method, input);
    expectOriginalRequest(input);
    await expectPrivateResponse(response, method, 200, expected);
  });

  it.each(errors)('maps mocked %s to private %i without spreading reader details', async (kind, status, error) => {
    const result = { kind, details: PRIVATE, jobId: JOB, cutoverAllowed: true };
    read.mockResolvedValueOnce(result);
    const input = request(method);
    const response = await dispatch(method, input);
    expectOriginalRequest(input);
    await expectPrivateResponse(response, method, status, { error });
  });

  it.each(['reader', 'params'] as const)('sanitizes %s rejection as private 503', async point => {
    if (point === 'reader') read.mockRejectedValueOnce(new Error(PRIVATE));
    const input = request(method);
    const ctx = point === 'params' ? { params: Promise.reject(new Error(PRIVATE)) } : context();
    const response = await dispatch(method, input, ctx);
    await expectPrivateResponse(response, method, 503, { error: 'PREFLIGHT_REPORT_UNAVAILABLE' });
    if (point === 'reader') expectOriginalRequest(input);
    else expect(read).not.toHaveBeenCalled();
  });

  it('reads again for each invocation rather than reusing an earlier in-process success', async () => {
    const expected = projection('MATCHED_PREFLIGHT');
    read.mockResolvedValueOnce({ kind: 'HISTORICAL_REPORT', projection: expected })
      .mockResolvedValueOnce({ kind: 'UNAUTHENTICATED' })
      .mockResolvedValueOnce({ kind: 'FORBIDDEN' });
    const inputs = [request(method), request(method, ''), request(method, 'synthetic-other-cookie')];
    await expectPrivateResponse(await dispatch(method, inputs[0]), method, 200, expected);
    await expectPrivateResponse(await dispatch(method, inputs[1]), method, 401, { error: 'AUTHENTICATION_REQUIRED' });
    await expectPrivateResponse(await dispatch(method, inputs[2]), method, 403, { error: 'ACCESS_DENIED' });
    expect(read).toHaveBeenCalledTimes(3);
    inputs.forEach((input, index) => {
      expect(read.mock.calls[index][0]).toBe('alpha');
      expect(read.mock.calls[index][1]).toBe(input);
    });
    // Mocked kinds are not authentication/revocation or production-cache tests.
  });
});

describe('explicit HEAD is bodyless before any Next HTTP sender', () => {
  it.each(READ_METHODS)('%s retains its current serialization behavior', async method => {
    const toJSON = vi.fn(() => { throw new Error(PRIVATE); });
    const projected = { ...projection('BLOCKED'), toJSON };
    read.mockResolvedValueOnce({
      kind: 'HISTORICAL_REPORT', projection: projected,
    });
    const input = request(method);
    const response = await dispatch(method, input);
    expectOriginalRequest(input);
    await expectPrivateResponse(response, method, method === 'HEAD' ? 200 : 503, { error: 'PREFLIGHT_REPORT_UNAVAILABLE' });
    expect(toJSON).toHaveBeenCalledTimes(method === 'HEAD' ? 0 : 1);
  });
});
