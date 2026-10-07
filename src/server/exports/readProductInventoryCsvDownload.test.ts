// @vitest-environment node
// Internal Response contract only: real adapter, reader, tenant authorization and
// formatter; synthetic pg transport/session seam. No SQL engine, crypto, Next
// dispatch, browser, retained backup, operational authority or Task21 acceptance.
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import type { QueryConfig } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProductInventoryCsvDownload } from './readProductInventoryCsvDownload';
import * as csvFormatter from './productInventoryCsv';
import * as productReader from './readAuthorizedProductInventoryDisplay';

const seams = vi.hoisted(() => {
  // Before application imports: never use inherited DB credentials or real pg.
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/adapter-no-db');
  vi.stubEnv('DIRECT_DATABASE_URL', 'postgresql://synthetic.invalid/adapter-no-db');
  const fetch = vi.fn(() => { throw new Error('Network forbidden in adapter fixture'); });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch, connect: vi.fn(), pool: vi.fn(), on: vi.fn(),
    session: vi.fn<(request: Request) => { subject: string; email: string; issuedAt: number } | null>(),
  };
});
vi.mock('server-only', () => ({}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) { seams.pool(options); }
    connect = seams.connect;
    on = seams.on;
  },
}));
vi.mock('@/server/googleOAuth', () => ({
  GOOGLE_AUTH_COOKIE: 'class_store_google_auth', getGoogleSessionFromRequest: seams.session,
}));

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'SYNTHETIC_SUBJECT_CANARY';
const EMAIL = 'synthetic-canary@example.invalid';
const PRIVATE = 'SYNTHETIC_PRIVATE_DIRECTORY_CANARY';
const SECRET = 'SYNTHETIC_DRIVER_ERROR_CANARY';
const COOKIE = 'class_store_google_auth=v2.synthetic.canary.fixture';
const URL = 'https://example.invalid/api/exports/alpha/products';
const HEADER = '"product_id","name","category","price","stock","is_active"\r\n';
const ROW = `"'000007","'연필, ""한글""\n둘째","","'9007199254740991","'0","'false"\r\n`;
const CANARIES = [TENANT, OTHER, USER, MEMBER, SUBJECT, EMAIL, PRIVATE, SECRET, COOKIE,
  'postgresql://synthetic.invalid/adapter-no-db'];

type WireRow = Record<string, unknown>;
type Fields = readonly (readonly [string, number])[];
type Reply = { rows: WireRow[]; fields: { name: string; dataTypeID: number; format: string }[] };
type Config = QueryConfig & { query_timeout: number };
const TENANT_FIELDS: Fields = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: Fields = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const DISPLAY_FIELDS: Fields = [['authorized', 16], ['product_count', 25], ['overflow', 16], ['valid', 16],
  ['tenant_id', 2950], ['product_id', 25], ['name', 25], ['category', 25], ['price', 25], ['stock', 25], ['is_active', 16]];
const TRANSACTION_SQL = new Set([
  'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
  "SET LOCAL statement_timeout = '1500ms'", "SET LOCAL lock_timeout = '500ms'",
  "SET LOCAL idle_in_transaction_session_timeout = '5000ms'", 'ROLLBACK',
]);
function reply(rows: WireRow[], fields: Fields): Reply {
  return { rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) };
}
function product(change: WireRow = {}): WireRow {
  return { authorized: true, product_count: '1', overflow: false, valid: true, tenant_id: TENANT,
    product_id: '000007', name: '연필, "한글"\n둘째', category: null,
    price: '9007199254740991', stock: '0', is_active: false, ...change };
}
function request(init: RequestInit = {}, url = URL): Request {
  return new Request(url, { ...init, headers: { cookie: COOKIE, ...init.headers } });
}
let queries: Config[];
let unexpectedQueries: string[];
let tenantReply: Reply;
let memberReply: Reply;
let displayReply: Reply;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
const isDisplay = (config: Config) => config.text.startsWith('WITH identity AS MATERIALIZED (');

beforeEach(() => {
  seams.session.mockReset().mockReturnValue({ subject: SUBJECT, email: EMAIL, issuedAt: 1 });
  queries = []; unexpectedQueries = [];
  tenantReply = reply([{ id: TENANT, slug: 'alpha', display_name: PRIVATE,
    lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' }], TENANT_FIELDS);
  memberReply = reply([{ id: MEMBER, tenant_id: TENANT, user_id: USER,
    google_subject: SUBJECT, role: 'OWNER' }], MEMBER_FIELDS);
  displayReply = reply([product()], DISPLAY_FIELDS);
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: Config): Promise<Reply> => {
      queries.push(config);
      if (TRANSACTION_SQL.has(config.text)) return reply([], []);
      if (config.text.includes('FROM pg_catalog.pg_roles AS r')) return reply([{ runtime_safe: true }], [['runtime_safe', 16]]);
      if (isDisplay(config)) return displayReply;
      if (config.text.includes('FROM public.platform_find_tenant_by_slug($1) AS t LIMIT 2')) return tenantReply;
      if (config.text.includes('FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m LIMIT 2')) return memberReply;
      if (config.text === "SELECT set_config('app.tenant_id', $1, true)") return reply([], []);
      unexpectedQueries.push(config.text);
      throw new Error('Unexpected synthetic SQL; no external fallback');
    }),
    release: vi.fn(),
  });
  seams.connect.mockReset().mockResolvedValue(client);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  try {
    expect(unexpectedQueries).toEqual([]);
    expect(seams.fetch).not.toHaveBeenCalled();
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) expect(console[method]).not.toHaveBeenCalled();
    expect(queries.map(config => config.text).join('\n')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT|CREATE|ALTER|DROP|GRANT|REVOKE|COPY)\b/i);
    expect(client.listenerCount('error')).toBe(0);
  } finally { vi.restoreAllMocks(); }
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function secureHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  for (const header of ['set-cookie', 'location', 'etag', 'last-modified', 'access-control-allow-origin']) {
    expect(response.headers.has(header)).toBe(false);
  }
  for (const canary of CANARIES) expect(JSON.stringify([...response.headers])).not.toContain(canary);
  for (const name of response.headers.keys()) {
    expect(['cache-control', 'vary', 'x-content-type-options', 'referrer-policy',
      'content-type', 'content-disposition', 'allow']).toContain(name);
  }
}
async function success(response: Response, text = HEADER + ROW, head = false) {
  expect(response.status).toBe(200);
  secureHeaders(response);
  expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="product-inventory-display.csv"');
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.equals(Buffer.from(head ? '' : text, 'utf8'))).toBe(true);
  if (head) expect(response.body).toBeNull();
  for (const canary of CANARIES) expect(bytes.toString('utf8')).not.toContain(canary);
}

const ERROR_CODES = {
  400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
  405: 'METHOD_NOT_ALLOWED', 413: 'LIMIT_EXCEEDED', 503: 'UNAVAILABLE',
} as const;
async function denied(response: Response, status: keyof typeof ERROR_CODES, head = false) {
  expect(response.status).toBe(status);
  secureHeaders(response);
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(response.headers.has('content-disposition')).toBe(false);
  expect(response.headers.has('content-length')).toBe(false);
  expect(response.headers.get('allow')).toBe(status === 405 ? 'GET, HEAD' : null);
  const text = await response.text();
  expect(text).toBe(head ? '' : `PRODUCT_INVENTORY_${ERROR_CODES[status]}\n`);
  if (head) expect(response.body).toBeNull();
  expect(text).not.toContain(HEADER);
  for (const canary of CANARIES) expect(text).not.toContain(canary);
}
function sentinel(change: WireRow = {}): WireRow {
  return { authorized: true, product_count: '0', overflow: false, valid: true,
    tenant_id: null, product_id: null, name: null, category: null, price: null,
    stock: null, is_active: null, ...change };
}

describe('internal product CSV Response through real reader and formatter (synthetic pg/auth)', () => {
  it('returns exactly the six-column CSV bytes and private attachment headers', async () => {
    const req = request();
    await success(await readProductInventoryCsvDownload('alpha', req));
    expect(seams.session.mock.calls.every(([seen]) => seen === req)).toBe(true);
    expect(queries.filter(isDisplay)).toHaveLength(1);
    expect(queries.find(isDisplay)?.values).toEqual([TENANT, SUBJECT, MEMBER, USER, 'alpha']);
    expect(queries.find(config => config.text.includes("set_config('app.tenant_id'"))?.values).toEqual([TENANT]);
    expect(queries[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(queries.at(-1)?.text).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it('runs authorization for HEAD and returns the same success headers with a null body', async () => {
    const get = await readProductInventoryCsvDownload('alpha', request());
    const head = await readProductInventoryCsvDownload('alpha', request({ method: 'HEAD' }));
    expect([...head.headers]).toEqual([...get.headers]);
    await success(head, HEADER + ROW, true);
    expect(seams.connect).toHaveBeenCalledTimes(2);
    expect(queries.filter(isDisplay)).toHaveLength(2);
  });

  it.each(['GET', 'HEAD'])('keeps an authorized empty %s distinct from a denied response', async method => {
    displayReply.rows = [sentinel()];
    await success(await readProductInventoryCsvDownload('alpha', request({ method })), HEADER, method === 'HEAD');
    displayReply.rows = [sentinel({ authorized: false })];
    await denied(await readProductInventoryCsvDownload('alpha', request({ method })), 403, method === 'HEAD');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s before auth or pg', async method => {
    await denied(await readProductInventoryCsvDownload('alpha', request({ method })), 405);
    expect(seams.session).not.toHaveBeenCalled();
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each(['', 'Alpha', ' alpha', 'alpha ', '-alpha', 'alpha-', 'alpha--beta', 'alpha/beta',
    '%61lpha', '한글', 'a'.repeat(64), null, undefined, 7, { tenantId: TENANT }])('refuses noncanonical slug %# without repair', async slug => {
    await denied(await readProductInventoryCsvDownload(slug, request()), 400);
    expect(seams.session).not.toHaveBeenCalled();
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each([
    '/api/exports/beta/products', '/api/exports/Alpha/products', '/api/exports/%61lpha/products',
    '/api/exports/alpha%2Fbeta/products', '/api/exports/alpha/products/', '/api//exports/alpha/products',
    '/API/exports/alpha/products', '/api/exports/alpha/Products', '/api/exports/alpha/products.csv',
    '/api/exports/alpha/products?tenantId=beta', '/api/exports/alpha/products?limit=1',
    '/api/exports/alpha/products?', '/api/exports/alpha/products#private', '/api/exports/alpha/products#',
    '/c/alpha/admin', '/api/exports/alpha/products?filename=private.csv',
  ])('rejects pathname/query/fragment alias %s before reader', async path => {
    await denied(await readProductInventoryCsvDownload('alpha', request({}, `https://example.invalid${path}`)), 400);
    expect(seams.session).not.toHaveBeenCalled();
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.invalid/api/exports/alpha/./products',
    'https://example.invalid/api/exports/beta/../alpha/products',
    'https://example.invalid/api/exports/alpha/%2e/products',
    'https://example.invalid\\api\\exports\\alpha\\products',
    'https://user:secret@example.invalid/api/exports/alpha/products',
    '/api/exports/alpha/products', 'not a URL',
    'ftp://example.invalid/api/exports/alpha/products',
    `https://${'a'.repeat(2050)}.invalid/api/exports/alpha/products`,
  ])('never repairs a noncanonical Request.url %#', async url => {
    const req = request();
    // The Web Request constructor normalizes some inputs before an adapter can
    // see them. This tests the raw url property presented AT this boundary only.
    Object.defineProperty(req, 'url', { value: url });
    await denied(await readProductInventoryCsvDownload('alpha', req), 400);
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it('rejects a cookie header above the fixed byte bound before authentication', async () => {
    await denied(await readProductInventoryCsvDownload('alpha', request({ headers: { cookie: 'x='.padEnd(32769, 'a') } })), 400);
    expect(seams.session).not.toHaveBeenCalled();
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('omits sensitive bytes and attachment for unauthenticated %s', async method => {
    seams.session.mockReturnValue(null);
    await denied(await readProductInventoryCsvDownload('alpha', request({ method })), 401, method === 'HEAD');
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each(['', 'class_store_google_auth=invalid', `${COOKIE}; ${COOKIE}`])('lets the real reader reject ambiguous/missing auth cookie %#', async cookie => {
    await denied(await readProductInventoryCsvDownload('alpha', request({ headers: { cookie } })), 401);
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each(['absent tenant', 'absent member', 'foreign member', 'wrong subject', 'VIEWER', 'STUDENT', 'statement revoked'])('sanitizes forbidden %s without attachment', async mode => {
    if (mode === 'absent tenant') tenantReply.rows = [];
    if (mode === 'absent member') memberReply.rows = [];
    if (mode === 'foreign member') memberReply.rows[0].tenant_id = OTHER;
    if (mode === 'wrong subject') memberReply.rows[0].google_subject = PRIVATE;
    if (mode === 'VIEWER' || mode === 'STUDENT') memberReply.rows[0].role = mode;
    if (mode === 'statement revoked') displayReply.rows = [sentinel({ authorized: false })];
    await denied(await readProductInventoryCsvDownload('alpha', request()), 403);
  });

  it('maps a reader overflow to a fixed 413 rather than a header-only CSV', async () => {
    displayReply.rows = [sentinel({ product_count: '10001', overflow: true })];
    await denied(await readProductInventoryCsvDownload('alpha', request()), 413);
  });

  it.each(['OWNER', 'ADMIN'])('passes the identical original Request and reader DTO through as %s', async role => {
    memberReply.rows[0].role = role;
    // Pass-through spies observe identity; neither reader nor formatter is replaced.
    const read = vi.spyOn(productReader, 'readAuthorizedProductInventoryDisplay');
    const format = vi.spyOn(csvFormatter, 'buildProductInventoryCsv');
    const req = request({ headers: { 'x-tenant-id': OTHER, 'x-role': 'OWNER',
      'x-filename': 'private.csv', 'if-none-match': '*', range: 'bytes=0-1' } });
    const response = await readProductInventoryCsvDownload('alpha', req);
    await success(response);
    expect(response.headers.has('content-range')).toBe(false);
    expect(read).toHaveBeenCalledExactlyOnceWith('alpha', req);
    const result = await read.mock.results[0].value;
    expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected real DTO');
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', readOnly: true, complete: true,
      source: 'POSTGRESQL', scope: 'ALL_NONDELETED_PRODUCTS', snapshot: 'STATEMENT',
      cutoverAllowed: false, activationAllowed: false, rowCount: 1 });
    expect(format).toHaveBeenCalledExactlyOnceWith(result.dto);
    expect(format.mock.results[0].value.rowCount).toBe(result.rowCount);
    expect(result.dto.rows).toHaveLength(result.rowCount);
  });

  it('keeps formula-looking text inert and cannot derive response headers from cells', async () => {
    displayReply.rows = [product({ name: '=SUM(1,2)\r\nContent-Disposition: private.csv', category: '@category' })];
    await success(await readProductInventoryCsvDownload('alpha', request()), HEADER
      + `"'000007","'=SUM(1,2)\r\nContent-Disposition: private.csv","'@category","'9007199254740991","'0","'false"\r\n`);
  });

  it.each(['membership', 'statement', 'session'])('reauthorizes the same Request after %s revocation, never serving cached CSV', async mode => {
    const req = request();
    await success(await readProductInventoryCsvDownload('alpha', req));
    const format = vi.spyOn(csvFormatter, 'buildProductInventoryCsv');
    if (mode === 'membership') memberReply.rows[0].role = 'VIEWER';
    if (mode === 'statement') displayReply.rows = [sentinel({ authorized: false })];
    if (mode === 'session') seams.session.mockReturnValue(null);
    await denied(await readProductInventoryCsvDownload('alpha', req), mode === 'session' ? 401 : 403);
    expect(seams.connect).toHaveBeenCalledTimes(mode === 'session' ? 1 : 2);
    expect(format).not.toHaveBeenCalled();
  });

  it('does not reuse alpha authorization or data for beta on later calls', async () => {
    await success(await readProductInventoryCsvDownload('alpha', request()));
    tenantReply.rows[0] = { ...tenantReply.rows[0], id: OTHER, slug: 'beta' };
    const betaRequest = request({}, 'https://example.invalid/api/exports/beta/products');
    // Alpha membership cannot authorize a different canonical slug.
    await denied(await readProductInventoryCsvDownload('beta', betaRequest), 403);
    memberReply.rows[0].tenant_id = OTHER;
    displayReply.rows = [product({ tenant_id: OTHER, product_id: 'beta-only', name: '다른 상품' })];
    await success(await readProductInventoryCsvDownload('beta', betaRequest), HEADER
      + `"'beta-only","'다른 상품","","'9007199254740991","'0","'false"\r\n`);
    expect(queries.filter(isDisplay).map(config => config.values)).toEqual([
      [TENANT, SUBJECT, MEMBER, USER, 'alpha'], [OTHER, SUBJECT, MEMBER, USER, 'beta'],
    ]);
    expect(seams.connect).toHaveBeenCalledTimes(3);
  });

  it.each(['foreign row', 'incomplete set', 'duplicate id', 'invalid decimal', 'extra field', 'invalid metadata'])('publishes no prefix/CSV for %s from pg', async mode => {
    if (mode === 'foreign row') displayReply.rows = [product({ product_count: '2' }), product({ product_count: '2', product_id: 'foreign', tenant_id: OTHER })];
    if (mode === 'incomplete set') displayReply.rows[0].product_count = '2';
    if (mode === 'duplicate id') displayReply.rows = [product({ product_count: '2' }), product({ product_count: '2' })];
    if (mode === 'invalid decimal') displayReply.rows[0].price = '9007199254740992';
    if (mode === 'extra field') displayReply.rows[0].private_payload = PRIVATE;
    if (mode === 'invalid metadata') displayReply.fields[0].dataTypeID = 25;
    const format = vi.spyOn(csvFormatter, 'buildProductInventoryCsv');
    await denied(await readProductInventoryCsvDownload('alpha', request()), 503);
    expect(format).not.toHaveBeenCalled();
  });

  it.each(['connect', 'query', 'cleanup'])('sanitizes %s errors and never retries or formats', async stage => {
    if (stage === 'connect') seams.connect.mockRejectedValue(new Error(SECRET));
    if (stage === 'query') client.query.mockRejectedValue(new Error(SECRET));
    if (stage === 'cleanup') client.release.mockImplementation(() => { throw new Error(SECRET); });
    const format = vi.spyOn(csvFormatter, 'buildProductInventoryCsv');
    await denied(await readProductInventoryCsvDownload('alpha', request()), 503);
    expect(format).not.toHaveBeenCalled();
    expect(seams.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(stage === 'connect' ? 0 : 1);
  });

  it.each(['GET', 'HEAD'])('does not read or authenticate an already aborted %s', async method => {
    const abort = new AbortController();
    abort.abort();
    await denied(await readProductInventoryCsvDownload('alpha', request({ method, signal: abort.signal })), 503, method === 'HEAD');
    expect(seams.session).not.toHaveBeenCalled();
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it('fails closed on abort while acquiring pg and releases a late synthetic connection', async () => {
    const abort = new AbortController();
    seams.connect.mockImplementation(async () => { abort.abort(); return client; });
    await denied(await readProductInventoryCsvDownload('alpha', request({ signal: abort.signal })), 503);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('refuses cookie mutation during reader cleanup', async () => {
    const req = request();
    client.release.mockImplementation(() => { req.headers.set('cookie', 'class_store_google_auth=v2.other.canary.fixture'); });
    await denied(await readProductInventoryCsvDownload('alpha', req), 401);
  });

  it.each(['cookie', 'abort'])('refuses %s changes in the await gap after real reader cleanup, before formatting', async change => {
    const abort = new AbortController();
    const req = request({ signal: abort.signal });
    client.release.mockImplementation(() => {
      // Runs after the reader's last synchronous identity check, before the
      // adapter resumes. The real reader is not replaced by a success mock.
      queueMicrotask(() => {
        if (change === 'cookie') req.headers.set('cookie', 'class_store_google_auth=v2.other.canary.fixture');
        else abort.abort();
      });
    });
    const format = vi.spyOn(csvFormatter, 'buildProductInventoryCsv');
    await denied(await readProductInventoryCsvDownload('alpha', req), change === 'cookie' ? 401 : 503);
    expect(format).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('sanitizes a formatter exception after real formatting for %s', async method => {
    const realFormat = csvFormatter.buildProductInventoryCsv;
    const format = vi.spyOn(csvFormatter, 'buildProductInventoryCsv').mockImplementation(input => {
      realFormat(input);
      throw new Error(SECRET);
    });
    await denied(await readProductInventoryCsvDownload('alpha', request({ method })), 503, method === 'HEAD');
    expect(format).toHaveBeenCalledTimes(1);
    expect(queries.filter(isDisplay)).toHaveLength(1);
  });

  it.each(['cookie', 'abort'])('refuses %s changes after real formatting, immediately before publication', async change => {
    const abort = new AbortController();
    const req = request({ signal: abort.signal });
    const realFormat = csvFormatter.buildProductInventoryCsv;
    vi.spyOn(csvFormatter, 'buildProductInventoryCsv').mockImplementation(input => {
      const csv = realFormat(input);
      if (change === 'cookie') req.headers.set('cookie', 'class_store_google_auth=v2.other.canary.fixture');
      else abort.abort();
      return csv;
    });
    await denied(await readProductInventoryCsvDownload('alpha', req), change === 'cookie' ? 401 : 503);
  });

  it.each([400, 401, 403, 413, 503] as const)('has no body or attachment for HEAD failure %s', async status => {
    const req = request({ method: 'HEAD' });
    if (status === 400) Object.defineProperty(req, 'url', { value: `${URL}?` });
    if (status === 401) seams.session.mockReturnValue(null);
    if (status === 403) memberReply.rows = [];
    if (status === 413) displayReply.rows = [sentinel({ product_count: '10001', overflow: true })];
    if (status === 503) seams.connect.mockRejectedValue(new Error(SECRET));
    await denied(await readProductInventoryCsvDownload('alpha', req), status, true);
  });

  it.each(['method', 'url'])('refuses original Request %s drift after real formatting', async field => {
    const req = request();
    const realFormat = csvFormatter.buildProductInventoryCsv;
    vi.spyOn(csvFormatter, 'buildProductInventoryCsv').mockImplementation(input => {
      const csv = realFormat(input);
      Object.defineProperty(req, field, { value: field === 'method' ? 'POST' : `${URL}?tenantId=beta` });
      return csv;
    });
    await denied(await readProductInventoryCsvDownload('alpha', req), 400);
  });

  it('refuses caller DTO objects masquerading as the original Request', async () => {
    const fake = { url: URL, method: 'GET', role: 'OWNER', tenantId: TENANT, dto: { rows: [] } };
    await denied(await readProductInventoryCsvDownload('alpha', fake as unknown as Request), 400);
    expect(seams.session).not.toHaveBeenCalled();
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each([
    { rowCount: 2 }, { byteLength: -1 }, { bytes: new Uint8Array() },
    { format: 'XLSX' }, { schemaVersion: 'other' }, { purpose: 'BACKUP' }, { contentType: 'text/html' },
  ])('fails closed on formatter result contract drift %# after real formatting', async change => {
    const realFormat = csvFormatter.buildProductInventoryCsv;
    vi.spyOn(csvFormatter, 'buildProductInventoryCsv').mockImplementation(input => (
      { ...realFormat(input), ...change } as csvFormatter.ProductInventoryCsv
    ));
    await denied(await readProductInventoryCsvDownload('alpha', request()), 503);
  });
});
