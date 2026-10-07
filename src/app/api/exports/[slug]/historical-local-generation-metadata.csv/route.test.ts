// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { AppRouteHandlers } from 'next/dist/server/route-modules/app-route/module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as adapter from '@/server/exports/readHistoricalLocalGenerationCsvDownload';
import * as formatter from '@/server/exports/historicalLocalGenerationCsv';
import type { PersistedLocalGenerationReadResult, readPersistedLocalGeneration } from '@/server/exports/readPersistedLocalGeneration';

// RED contract for the MISSING production ./route.ts, never a substitute route.
// Real route (once supplied) -> real adapter/cookie verifier/CSV formatter;
// persisted reader is MOCKED. Reader authorization, SQL/RLS, real PG, Sheets,
// Redis, Next HTTP registration, proxy/CDN, browser downloads, retention/restore
// and Task21 acceptance are NOT established by this bounded in-process suite.
// Docs read before authoring (installed Next 16.3.3):
// node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md
// Promised params and explicit HEAD matter; framework OPTIONS/405 are separate.
vi.mock('server-only', () => ({}));
const seams = vi.hoisted(() => ({
  read: vi.fn<typeof readPersistedLocalGeneration>(),
  io: vi.fn(() => { throw new Error('External I/O forbidden in route contract'); }),
}));
vi.mock('@/server/exports/readPersistedLocalGeneration', () => ({ readPersistedLocalGeneration: seams.read }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: seams.io }));
vi.mock('pg', () => ({ Pool: class { constructor() { seams.io(); } } }));
vi.mock('googleapis', () => ({ google: new Proxy({}, { get: seams.io }) }));

const METHODS = ['GET', 'HEAD'] as const;
type Method = typeof METHODS[number];
type Context = { params: Promise<{ slug: string }> };
type DirectRoute = Record<Method, (request: Request, context: Context) => Promise<Response>> & {
  dynamic: string; runtime: string;
};
type HistoricalDto = Extract<PersistedLocalGenerationReadResult, { kind: 'HISTORICAL_LOCAL_GENERATION' }>;
const PATH = '/api/exports/alpha/historical-local-generation-metadata.csv';
const ORIGIN = 'https://example.test';
const JOB = 'historical/과거 job:%20';
const GENERATION = `preparation:candidate:${'a'.repeat(64)}`;
const SECRET = 'public-synthetic-route-contract-secret-not-a-credential';
const PRIVATE = 'synthetic-private-source-and-exception-canary';
const SUBJECT = 'synthetic-route-contract-subject';
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
  vary: 'Cookie', 'x-content-type-options': 'nosniff',
};
const ERRORS = {
  400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
  404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 503: 'UNAVAILABLE',
} as const;
// Independent byte-wise RFC3986 transport encoder, not the production selector.
const encode = (value: string) => [...Buffer.from(value, 'utf8')].map(byte =>
  /[A-Za-z0-9._~-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte)
    : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
const query = (job = JOB, generation = GENERATION) => `jobId=${encode(job)}&generationId=${encode(generation)}`;
const context = (slug = 'alpha'): Context => ({ params: Promise.resolve({ slug }) });
function dto(): HistoricalDto {
  return {
    kind: 'HISTORICAL_LOCAL_GENERATION', authority: 'NONAUTHORITY', readOnly: true,
    scope: 'HISTORICAL_ONLY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
    originalSnapshotPhase: 'PREFLIGHT', verification: 'PERSISTED_BINDING_ONLY',
    payloadIntegrity: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED',
    operationalAuthority: 'UNKNOWN', cutoverAllowed: false, activationAllowed: false,
    jobId: JOB, generationId: GENERATION, originalSourceId: 'source:synthetic',
    originalSnapshotId: 'snapshot:synthetic', candidateManifestDigest: 'b'.repeat(64),
    candidateSheetDigest: 'c'.repeat(64), recordedStateVersion: '7',
  };
}
function cookie(issuedAt = NOW) {
  const iv = Buffer.alloc(12, 19); // Fixed IV ONLY for this public synthetic fixture.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject: SUBJECT, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function request(method = 'GET', options: { path?: string; query?: string; cookie?: string; signal?: AbortSignal } = {}) {
  return new Request(`${ORIGIN}${options.path ?? PATH}?${options.query ?? query()}`, {
    method, signal: options.signal,
    headers: { cookie: options.cookie ?? cookie(), 'x-tenant-id': 'forged-tenant', 'x-role': 'OWNER' },
  });
}
function original(req: Request) {
  return { url: req.url, method: req.method, headers: [...req.headers], signal: req.signal, bodyUsed: req.bodyUsed };
}
function noDisclosure(text: string) {
  for (const value of [SECRET, PRIVATE, SUBJECT, cookie(), 'synthetic@example.test', 'forged-tenant', 'postgresql://', 'SELECT ']) {
    expect(text).not.toContain(value);
  }
}
async function refused(response: Response, method: Method, status: keyof typeof ERRORS) {
  expect(response.status).toBe(status);
  expect(Object.fromEntries(response.headers)).toEqual({
    ...PRIVATE_HEADERS, 'content-type': 'text/plain; charset=utf-8',
    ...(status === 405 ? { allow: 'GET, HEAD' } : {}),
  }); // Exact map excludes attachment, length, redirect, cookie, cache validators and ranges.
  if (method === 'HEAD') expect(response.body).toBeNull();
  const text = await response.text();
  expect(text).toBe(method === 'HEAD' ? '' : `HISTORICAL_LOCAL_GENERATION_${ERRORS[status]}\n`);
  for (const value of [JOB, GENERATION, 'schemaVersion']) expect(text).not.toContain(value);
  noDisclosure(text + JSON.stringify([...response.headers]));
}

let route: DirectRoute;
let download: MockInstance<typeof adapter.readHistoricalLocalGenerationCsvDownload>;
let serialize: MockInstance<typeof formatter.buildHistoricalLocalGenerationCsv>;
beforeAll(async () => {
  vi.stubGlobal('fetch', seams.io);
  expect(existsSync(new URL('./route.ts', import.meta.url)),
    'MISSING_PRODUCTION_ROUTE: ./route.ts must exist; no fake handler, fallback or conditional skip is allowed').toBe(true);
  // Nonliteral import avoids a missing-module TS diagnostic in unrelated suites.
  // This still imports ONLY the production sibling and fails hard if it is absent.
  const productionModule = './route';
  route = await import(productionModule) as DirectRoute;
});
afterAll(() => {
  try { expect(seams.io).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); }
});
beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  seams.read.mockReset().mockImplementation(async () => dto());
  download = vi.spyOn(adapter, 'readHistoricalLocalGenerationCsvDownload'); // Call through, never fake the route.
  serialize = vi.spyOn(formatter, 'buildHistoricalLocalGenerationCsv');
  for (const name of ['log', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => {});
});
afterEach(() => {
  try {
    expect(seams.io).not.toHaveBeenCalled();
    for (const name of ['log', 'warn', 'error'] as const) expect(console[name]).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

function forwarded(req: Request, slug = 'alpha') {
  expect(download).toHaveBeenCalledExactlyOnceWith(slug, req);
  expect(download.mock.calls[0][1]).toBe(req); // Equality alone would not detect a cloned Request.
}
async function successful(response: Response, method: Method) {
  // Exact real-formatter byte preservation is the route obligation, not a new
  // independent proof of CSV correctness (the serializer has its own tests).
  const expected = formatter.buildHistoricalLocalGenerationCsv(dto());
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toEqual({
    ...PRIVATE_HEADERS, 'content-type': 'text/csv; charset=utf-8; header=present',
    'content-disposition': 'attachment; filename="historical-local-generation-metadata.csv"',
    'content-length': String(expected.byteLength),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes).toEqual(method === 'HEAD' ? new Uint8Array() : expected.bytes);
  expect(expected.byteLength).toBeGreaterThan(0); expect(expected.byteLength).toBeLessThanOrEqual(16384);
  if (method === 'HEAD') expect(response.body).toBeNull();
  else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const flag of ['DISPLAY_ONLY', 'NONAUTHORITY', 'HISTORICAL_ONLY', 'LOCAL_CANDIDATE', 'NOT_PROVEN',
      'PERSISTED_BINDING_ONLY', 'NOT_VERIFIED', 'NOT_EVALUATED', 'UNKNOWN', 'false']) expect(text).toContain(`"'${flag}"`);
    noDisclosure(text);
  }
  noDisclosure(JSON.stringify([...response.headers]));
}

describe('production direct historical metadata CSV route contract (reader mocked)', () => {
  it('requires explicit, distinct GET/HEAD and uncached Node configuration, not an inventory stub', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'HEAD', 'dynamic', 'runtime']);
    expect(typeof route.GET).toBe('function'); expect(typeof route.HEAD).toBe('function');
    expect(route.HEAD).not.toBe(route.GET);
    expect(route.dynamic).toBe('force-dynamic'); expect(route.runtime).toBe('nodejs');
  });

  describe.each(METHODS)('%s preserves admission, representation and private refusal', method => {
    it('forwards the exact original Request and literal IDs once and returns the actual adapter Response', async () => {
      const req = request(method); const snapshot = original(req);
      const response = await route[method](req, context());
      forwarded(req);
      expect(seams.read).toHaveBeenCalledExactlyOnceWith('alpha', req, { jobId: JOB, generationId: GENERATION });
      expect(seams.read.mock.calls[0][1]).toBe(req);
      expect(seams.read.mock.calls[0][2]).toEqual({ jobId: JOB, generationId: GENERATION }); // %2520 -> literal %20, not a space.
      expect(serialize).toHaveBeenCalledExactlyOnceWith(dto());
      expect(response).toBe(await download.mock.results[0].value);
      expect(original(req)).toEqual(snapshot); expect(req.signal).toBe(snapshot.signal);
      await successful(response, method);
    });

    it('awaits promised Next params without an early read or rebuilding the Request', async () => {
      let resolve!: (value: { slug: string }) => void;
      const params = new Promise<{ slug: string }>(yes => { resolve = yes; });
      const req = request(method); const pending = route[method](req, { params });
      await Promise.resolve();
      try { expect(download).not.toHaveBeenCalled(); expect(seams.read).not.toHaveBeenCalled(); }
      finally { resolve({ slug: 'alpha' }); }
      expect((await pending).status).toBe(200); forwarded(req);
    });

    it.each([
      '', `jobId=${encode(JOB)}`, `generationId=${encode(GENERATION)}&jobId=${encode(JOB)}`,
      `${query()}&jobId=other`, `${query()}&generationId=${encode(GENERATION)}`, `${query()}&role=OWNER`,
      query().replace('jobId=', 'job%49d='), query().replace('%2F', '%2f'),
      query().replace('historical', '%68istorical'), query().replace('%20', '+'),
      `jobId=%ZZ&generationId=${encode(GENERATION)}`, `jobId=%C0%AF&generationId=${encode(GENERATION)}`,
      query(` ${JOB}`), query(JOB, 'latest'), query(JOB, `preparation:candidate:${'A'.repeat(64)}`),
      query(JOB, GENERATION).replaceAll('%3A', ':'),
    ])('refuses raw selector %# without reorder/decode/re-encode/trim/latest repair', async raw => {
      const req = request(method, { query: raw }); const snapshot = original(req);
      expect(req.url).toBe(`${ORIGIN}${PATH}?${raw}`); // Contract starts at the supplied Request, not raw wire bytes.
      await refused(await route[method](req, context()), method, 400);
      forwarded(req); expect(original(req)).toEqual(snapshot);
      expect(seams.read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
    });

    it.each([`${PATH}/`, PATH.replace('/alpha/', '/beta/'), PATH.replace('/alpha/', '/%61lpha/'),
      PATH.replace('/historical-', '/%68istorical-')])('refuses pathname near miss %s without rewriting it', async path => {
      const req = request(method, { path });
      expect(new URL(req.url).pathname).toBe(path);
      await refused(await route[method](req, context()), method, 400);
      forwarded(req); expect(seams.read).not.toHaveBeenCalled();
    });
    it.each(['Alpha', ' alpha', 'alpha '])('does not normalize promised slug %s', async slug => {
      const req = request(method);
      await refused(await route[method](req, context(slug)), method, 400);
      forwarded(req, slug); expect(seams.read).not.toHaveBeenCalled();
    });
    it.each(['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'])(
      'does not strip the %s header to turn a refused request into success', async name => {
        const req = request(method); req.headers.set(name, name === 'range' ? 'bytes=0-1' : '*');
        const snapshot = original(req);
        await refused(await route[method](req, context()), method, 400);
        forwarded(req); expect(original(req)).toEqual(snapshot); expect(seams.read).not.toHaveBeenCalled();
      },
    );

    it.each(['', 'class_store_admin=fake; class_store_tenant_admin=fake', 'class_store_google_auth=%ZZ'])(
      'refuses absent/legacy/malformed identity %# despite forged authority headers', async auth => {
        const req = request(method, { cookie: auth });
        await refused(await route[method](req, context()), method, 401);
        forwarded(req); expect(seams.read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
      },
    );
    it.each([
      ['UNAUTHENTICATED', 401], ['FORBIDDEN', 403], ['INVALID_REQUEST', 400], ['NOT_FOUND', 404], ['UNAVAILABLE', 503],
    ] as const)('preserves reader %s refusal, not an empty successful attachment', async (kind, status) => {
      seams.read.mockResolvedValueOnce({ kind });
      const req = request(method);
      await refused(await route[method](req, context()), method, status);
      forwarded(req); expect(seams.read).toHaveBeenCalledTimes(1); expect(serialize).not.toHaveBeenCalled();
    });
    it('does not reuse a prior successful representation after a fresh denied reader result', async () => {
      const first = await route.GET(request(), context()); expect(first.status).toBe(200);
      seams.read.mockResolvedValueOnce({ kind: 'FORBIDDEN' });
      await refused(await route[method](request(method), context()), method, 403);
      expect(download).toHaveBeenCalledTimes(2); expect(seams.read).toHaveBeenCalledTimes(2);
      expect(serialize).toHaveBeenCalledTimes(1);
    });
    it.each(['before-read', 'during-read'] as const)('preserves abort %s with no CSV publication', async stage => {
      const abort = new AbortController(); const req = request(method, { signal: abort.signal });
      if (stage === 'before-read') abort.abort();
      else seams.read.mockImplementationOnce(async () => { abort.abort(); return dto(); });
      await refused(await route[method](req, context()), method, 503);
      forwarded(req); expect(req.signal.aborted).toBe(true);
      expect(seams.read).toHaveBeenCalledTimes(stage === 'before-read' ? 0 : 1);
      expect(serialize).not.toHaveBeenCalled();
    });
    it.each(['job', 'generation', 'private-field', 'reader-rejection'] as const)('sanitizes %s without an attachment', async failure => {
      if (failure === 'reader-rejection') seams.read.mockRejectedValueOnce(new Error(PRIVATE));
      else if (failure === 'private-field') seams.read.mockResolvedValueOnce({ ...dto(), rawSource: PRIVATE } as HistoricalDto);
      else seams.read.mockResolvedValueOnce({ ...dto(), ...(failure === 'job' ? { jobId: 'other' }
        : { generationId: `preparation:candidate:${'d'.repeat(64)}` }) });
      await refused(await route[method](request(method), context()), method, 503);
      expect(seams.read).toHaveBeenCalledTimes(1);
    });
    it('sanitizes a rejected params Promise at the route boundary before the adapter', async () => {
      await refused(await route[method](request(method), { params: Promise.reject(new Error(PRIVATE)) }), method, 503);
      expect(download).not.toHaveBeenCalled(); expect(seams.read).not.toHaveBeenCalled();
    });
    it('sanitizes an adapter rejection at the route boundary (fault injection, not a route implementation)', async () => {
      download.mockRejectedValueOnce(new Error(PRIVATE));
      const req = request(method);
      await refused(await route[method](req, context()), method, 503);
      forwarded(req); expect(seams.read).not.toHaveBeenCalled();
    });
  });

  it('explicit HEAD rereads and formats its representation and is bodyless before any HTTP sender', async () => {
    const get = await route.GET(request(), context()); const headRequest = request('HEAD');
    const head = await route.HEAD(headRequest, context());
    expect(get.status).toBe(200); expect(head.status).toBe(200);
    expect([...head.headers]).toEqual([...get.headers]); expect(head.body).toBeNull(); expect(await head.text()).toBe('');
    expect(download).toHaveBeenCalledTimes(2); expect(download.mock.calls[1][1]).toBe(headRequest);
    expect(seams.read).toHaveBeenCalledTimes(2); expect(seams.read.mock.calls[1][1]).toBe(headRequest);
    expect(serialize).toHaveBeenCalledTimes(2);
  });
});

describe('installed Next method helper characterization, NOT HTTP dispatch or private-method acceptance', () => {
  it('keeps the actual explicit HEAD instead of Next automatic GET-to-HEAD fallback', () => {
    const dispatched = autoImplementMethods(route as unknown as AppRouteHandlers);
    expect(dispatched.GET).toBe(route.GET); expect(dispatched.HEAD).toBe(route.HEAD);
    expect(dispatched.HEAD).not.toBe(route.GET);
    expect(Object.keys(dispatched).sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    expect(Object.hasOwn(dispatched, 'BREW')).toBe(false); // No invented fallback for unknown verbs.
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)(
    '%s framework response is not the adapter private 405; neither path reads data', async method => {
      const dispatched = autoImplementMethods(route as unknown as AppRouteHandlers);
      const params = vi.fn(() => { throw new Error(PRIVATE); });
      const req = new NextRequest(request(method));
      const response = await dispatched[method](req, { get params() { return params(); } });
      expect(response).toBeInstanceOf(Response);
      const result = response as Response;
      expect(result.status).toBe(method === 'OPTIONS' ? 204 : 405);
      expect(result.body).toBeNull(); expect(await result.text()).toBe('');
      expect(Object.fromEntries(result.headers)).toEqual(method === 'OPTIONS' ? { allow: 'GET, HEAD, OPTIONS' } : {});
      expect(params).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
      expect(seams.read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
      // Deliberate direct ADAPTER invocation, not route.GET(POST) and not Next
      // dispatch. Its private 405/Allow cannot be attributed to framework output.
      await refused(await adapter.readHistoricalLocalGenerationCsvDownload('alpha', req), 'GET', 405);
      expect(download).toHaveBeenCalledExactlyOnceWith('alpha', req);
      expect(seams.read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
    },
  );
});
