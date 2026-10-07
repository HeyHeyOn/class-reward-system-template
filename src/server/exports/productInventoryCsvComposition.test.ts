// @vitest-environment node
// Synthetic reader -> DTO -> CSV contract ONLY. No SQL engine, real credentials,
// endpoint, download, XLSX, retained artifact, backup or Task21 acceptance.
// Only pg transport and session lookup are fixtures; reader, tenant resolution,
// membership authorization and CSV formatter are real. No other test is imported.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { QueryConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  connect: vi.fn(),
  pool: vi.fn(),
  on: vi.fn(),
  session: vi.fn<() => { subject: string; email: string; issuedAt: number } | null>(),
}));
vi.mock('server-only', () => ({}));
// Deliberately do not import the original pg driver: no socket/SQL fallback.
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) { seams.pool(options); }
    connect = seams.connect;
    on = seams.on;
  },
}));
vi.mock('@/server/googleOAuth', () => ({
  GOOGLE_AUTH_COOKIE: 'class_store_google_auth',
  getGoogleSessionFromRequest: seams.session,
}));

import { buildProductInventoryCsv, type ProductInventoryCsv } from './productInventoryCsv';
import { readAuthorizedProductInventoryDisplay } from './readAuthorizedProductInventoryDisplay';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'SYNTHETIC_SESSION_SUBJECT_CANARY';
const EMAIL = 'synthetic-session-canary@example.invalid';
const DIRECTORY_CANARY = 'SYNTHETIC_DIRECTORY_PRIVATE_CANARY';
const DRIVER_CANARY = 'SYNTHETIC_DRIVER_SECRET_CANARY';
const EXTRA_CANARY = 'SYNTHETIC_UNAPPROVED_FIELD_CANARY';
const COOKIE = 'class_store_google_auth=v2.synthetic.canary.fixture';
const DATABASE_URL = 'postgresql://synthetic.invalid/composition-no-db';
const HEADER = '"product_id","name","category","price","stock","is_active"\r\n';
const MAX_SAFE = '9007199254740991';
const CANARIES = [TENANT, OTHER, USER, MEMBER, SUBJECT, EMAIL, DIRECTORY_CANARY,
  DRIVER_CANARY, EXTRA_CANARY, COOKIE, DATABASE_URL];

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
  "SET LOCAL statement_timeout = '1500ms'",
  "SET LOCAL lock_timeout = '500ms'",
  "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
  'ROLLBACK',
]);
function reply(rows: WireRow[], fields: Fields): Reply {
  return { rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) };
}
function product(productId = '000007', change: WireRow = {}): WireRow {
  return { authorized: true, product_count: '1', overflow: false, valid: true, tenant_id: TENANT,
    product_id: productId, name: '연필, "한글"\n둘째', category: null,
    price: MAX_SAFE, stock: '0', is_active: false, ...change };
}
function sentinel(change: WireRow = {}): WireRow {
  return { authorized: true, product_count: '0', overflow: false, valid: true,
    tenant_id: null, product_id: null, name: null, category: null, price: null,
    stock: null, is_active: null, ...change };
}
function request(cookie = COOKIE): Request {
  // Constructing a Request does not send it. Selectors/headers are untrusted.
  return new Request(`https://example.invalid/fixture?tenantId=${OTHER}&limit=1`, {
    headers: { cookie, 'x-tenant-id': OTHER, 'x-private-canary': EXTRA_CANARY },
  });
}

let queries: Config[];
let unexpectedQueries: string[];
let tenantReply: Reply;
let memberReply: Reply;
let displayReply: Reply;
let displayError: Error | undefined;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
const isDisplay = (config: Config) => config.text.startsWith('WITH identity AS MATERIALIZED (');

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
  seams.session.mockReset().mockReturnValue({ subject: SUBJECT, email: EMAIL, issuedAt: 1 });
  queries = []; unexpectedQueries = []; displayError = undefined;
  tenantReply = reply([{ id: TENANT, slug: 'alpha', display_name: DIRECTORY_CANARY,
    lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' }], TENANT_FIELDS);
  memberReply = reply([{ id: MEMBER, tenant_id: TENANT, user_id: USER,
    google_subject: SUBJECT, role: 'OWNER' }], MEMBER_FIELDS);
  displayReply = reply([product()], DISPLAY_FIELDS);
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: Config): Promise<Reply> => {
      queries.push(config);
      if (TRANSACTION_SQL.has(config.text)) return reply([], []);
      if (config.text.includes('FROM pg_catalog.pg_roles AS r')) {
        return reply([{ runtime_safe: true }], [['runtime_safe', 16]]);
      }
      // The display CTE also contains the membership lookup: match it first.
      if (isDisplay(config)) {
        if (displayError) throw displayError;
        return displayReply;
      }
      if (config.text.includes('FROM public.platform_find_tenant_by_slug($1) AS t LIMIT 2')) return tenantReply;
      if (config.text.includes('FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m LIMIT 2')) return memberReply;
      if (config.text === "SELECT set_config('app.tenant_id', $1, true)") return reply([], []);
      unexpectedQueries.push(config.text);
      throw new Error('Unexpected synthetic query; no external fallback');
    }),
    release: vi.fn(),
  });
  seams.connect.mockReset().mockResolvedValue(client);
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network forbidden in composition fixture'); });
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  try {
    expect(unexpectedQueries).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) expect(console[method]).not.toHaveBeenCalled();
    expect(queries.map(config => config.text).join('\n'))
      .not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT|CREATE|ALTER|GRANT)\b/i);
    expect(client.listenerCount('error')).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

// Test-local success-kind gate, NOT a production adapter/HTTP authorization test.
async function compose(req = request()) {
  const result = await readAuthorizedProductInventoryDisplay('alpha', req);
  const before = JSON.stringify(result);
  const csv = result.kind === 'CURRENT_PRODUCT_INVENTORY_DISPLAY'
    ? buildProductInventoryCsv(result.dto) : undefined;
  expect(JSON.stringify(result)).toBe(before); // No DTO repair, reconstruction or mutation.
  if (result.kind === 'CURRENT_PRODUCT_INVENTORY_DISPLAY') {
    expect(csv?.rowCount).toBe(result.rowCount);
    expect(csv?.rowCount).toBe(result.dto.rows.length);
  }
  return { result, csv };
}
async function assertDenied(kind: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'UNAVAILABLE' | 'LIMIT_EXCEEDED', req = request()) {
  const { result, csv } = await compose(req);
  expect(result).toEqual({ kind });
  expect(Object.hasOwn(result, 'dto')).toBe(false);
  expect(Object.hasOwn(result, 'rows')).toBe(false);
  expect(csv).toBeUndefined(); // Not a successful header-only or partial export.
  expect(() => buildProductInventoryCsv(result)).toThrow('Invalid product inventory display CSV input');
  noCanaries(JSON.stringify(result));
}
function setProducts(rows: WireRow[]) {
  displayReply = reply(rows.length ? rows.map(row => ({ ...row, product_count: String(rows.length) }))
    : [sentinel()], DISPLAY_FIELDS);
}
function fixtureBudget(rows: WireRow[]): number {
  // Reader's conservative UTF-8/JSON admission budget, not the CSV byte count.
  return 1024 + rows.reduce((sum, row) => sum + 256 + 6 * (
    Buffer.byteLength(String(row.product_id), 'utf8') + Buffer.byteLength(String(row.name), 'utf8')
    + (row.category === null ? 0 : Buffer.byteLength(String(row.category), 'utf8')))
    + String(row.price).length + String(row.stock).length, 0);
}
function budgetProducts(target: number): WireRow[] {
  const rows = Array.from({ length: 350 }, (_, index) => product(`p-${String(index).padStart(5, '0')}`,
    { name: 'a', price: '1', stock: '1' }));
  let remaining = target - fixtureBudget(rows);
  for (const row of rows) {
    const extra = Math.min(4095, Math.floor(remaining / 6));
    row.name = 'a'.repeat(extra + 1);
    remaining -= extra * 6;
  }
  expect(remaining).toBeGreaterThanOrEqual(0);
  expect(remaining).toBeLessThan(6);
  rows[0].stock = `1${'0'.repeat(remaining)}`;
  expect(fixtureBudget(rows)).toBe(target);
  return rows;
}
function noCanaries(...values: string[]) {
  for (const value of values) for (const canary of CANARIES) expect(value).not.toContain(canary);
}
function assertCsv(csv: ProductInventoryCsv | undefined, expectedText: string, rowCount: number) {
  expect(csv).toBeDefined();
  if (!csv) throw new Error('Expected actual reader DTO to produce CSV');
  const { bytes, ...metadata } = csv;
  expect(metadata).toEqual({ format: 'CSV', schemaVersion: 'product-inventory-display/v1', purpose: 'DISPLAY_ONLY',
    contentType: 'text/csv; charset=utf-8; header=present', rowCount,
    byteLength: Buffer.byteLength(expectedText, 'utf8'),
    sha256: createHash('sha256').update(expectedText, 'utf8').digest('hex') });
  // Byte-for-byte comparison without deep-object diffing megabytes of Buffer keys.
  const actual = Buffer.from(bytes);
  expect(actual.equals(Buffer.from(expectedText, 'utf8'))).toBe(true);
  expect(actual.toString('utf8')).toBe(expectedText);
  expect(bytes[0]).toBe(0x22); // Quoted header, no BOM.
  expect(actual.subarray(-2).equals(Buffer.from('\r\n'))).toBe(true);
  noCanaries(actual.toString('utf8'), JSON.stringify(metadata));
}

describe('real authorized product display DTO composed with real display CSV (no DB/network)', () => {
  it.each(['OWNER', 'ADMIN'])('composes the unchanged authorized DTO as %s, including inactive rows', async role => {
    memberReply.rows[0].role = role;
    const { result, csv } = await compose();
    expect(result).toEqual({ kind: 'CURRENT_PRODUCT_INVENTORY_DISPLAY', authority: 'NONAUTHORITY',
      readOnly: true, source: 'POSTGRESQL', scope: 'ALL_NONDELETED_PRODUCTS', snapshot: 'STATEMENT',
      complete: true, cutoverAllowed: false, activationAllowed: false, rowCount: 1,
      dto: { rows: [{ productId: '000007', name: '연필, "한글"\n둘째', category: null,
        price: MAX_SAFE, stock: '0', isActive: false }] } });
    assertCsv(csv, HEADER + `"'000007","'연필, ""한글""\n둘째","","'9007199254740991","'0","'false"\r\n`, 1);
    expect(queries.filter(isDisplay)).toHaveLength(1);
    expect(queries.find(isDisplay)?.values).toEqual([TENANT, SUBJECT, MEMBER, USER, 'alpha']);
    expect(queries.find(config => config.text.includes("set_config('app.tenant_id'"))?.values).toEqual([TENANT]);
    expect(queries[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(queries.at(-1)?.text).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(seams.connect).toHaveBeenCalledTimes(1);
    noCanaries(JSON.stringify(result));
  });

  it('distinguishes an authorized empty inventory from denied DTO absence', async () => {
    setProducts([]);
    const { result, csv } = await compose();
    expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected authorized empty DTO');
    expect(result.dto).toEqual({ rows: [] });
    expect(result.rowCount).toBe(0);
    assertCsv(csv, HEADER, 0);
    displayReply.rows = [sentinel({ authorized: false })];
    await assertDenied('FORBIDDEN');
  });

  it('preserves opaque IDs and deterministic UTF-16 order across fixture permutations', async () => {
    // Explicit oracle, NOT localeCompare, numeric sorting or the formatter's sort.
    // Supplementary Unicode must precede U+E000 in UTF-16, unlike UTF-8/C order.
    const ordered = [' 007 ', "'007", '000007', '10', '2', '=opaque', 'e\u0301', 'é', '한', '😀', '\uE000'];
    const permutations = [[...ordered].reverse(), [...ordered.slice(4), ...ordered.slice(0, 4)], [...ordered]];
    const expected = HEADER + ordered.map(id => `"'${id}","'상품","","'1","'2","'true"\r\n`).join('');
    let first: ProductInventoryCsv | undefined;
    for (const ids of permutations) {
      setProducts(ids.map((id, index) => product(id, { name: '상품', category: index % 2 ? '' : null,
        price: '1', stock: '2', is_active: true })));
      const { result, csv } = await compose();
      expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
      if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected ordered DTO');
      expect(result.dto.rows.map(row => row.productId)).toEqual(ordered);
      assertCsv(csv, expected, ordered.length);
      const repeated = buildProductInventoryCsv(result.dto);
      expect(repeated).toEqual(csv);
      expect(repeated.bytes).not.toBe(csv?.bytes);
      if (first) expect(csv).toEqual(first);
      first = csv;
    }
  });

  it('quotes commas, double quotes and embedded CR/LF without counting them as records', async () => {
    const id = '=opaque, "id"\r\n끝';
    const name = ' \t=SUM(1,2)\n"한글"';
    const category = '@분류\r다음';
    setProducts([product(id, { name, category, price: '0', stock: '0', is_active: true })]);
    const { result, csv } = await compose();
    expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected lossless DTO');
    expect(result.dto.rows[0]).toEqual({ productId: id, name, category, price: '0', stock: '0', isActive: true });
    assertCsv(csv, HEADER + `"'=opaque, ""id""\r\n끝","' \t=SUM(1,2)\n""한글""","'@분류\r다음","'0","'0","'true"\r\n`, 1);
    expect(Buffer.from(csv!.bytes).toString('utf8').split('\n').length).toBeGreaterThan(csv!.rowCount + 1);
  });

  it.each([
    ['=1+1', `"'=1+1"`],
    ['+SUM(1,2)', `"'+SUM(1,2)"`],
    ['-7', `"'-7"`],
    ['@SUM(A1:A2)', `"'@SUM(A1:A2)"`],
    [' \t=1+1', `"' \t=1+1"`],
    ["'=1+1", `"''=1+1"`],
    ['＝1+1', `"'＝1+1"`],
  ])('keeps formula-like data %j behind the literal display prefix', async (name, cell) => {
    setProducts([product('formula-id', { name, category: '분류', price: '0', stock: '1', is_active: true })]);
    const { csv } = await compose();
    assertCsv(csv, HEADER + `"'formula-id",${cell},"'분류","'0","'1","'true"\r\n`, 1);
  });

  it.each([['0', MAX_SAFE], [MAX_SAFE, '0']])('preserves safe-boundary decimal strings price=%s stock=%s', async (price, stock) => {
    setProducts([product('0000001', { name: '숫자', price, stock })]);
    const { result, csv } = await compose();
    expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected bounded decimal DTO');
    expect(result.dto.rows[0].price).toBe(price);
    expect(result.dto.rows[0].stock).toBe(stock);
    assertCsv(csv, HEADER + `"'0000001","'숫자","","'${price}","'${stock}","'false"\r\n`, 1);
  });

  it.each([
    { price: '9007199254740992' }, { stock: '9007199254740992' },
    { price: 7 }, { stock: '01' },
  ])('refuses unsafe/noncanonical numeric fixture %# rather than serializing a valid prefix', async change => {
    setProducts([product('good'), product('bad', change)]);
    await assertDenied('UNAVAILABLE');
  });

  it.each([0, 1])('enforces multibyte name boundary plus %s without truncation', async extra => {
    const limit = 4096;
    const width = Buffer.byteLength('가', 'utf8');
    const name = '가'.repeat(Math.floor(limit / width)) + 'a'.repeat(limit % width + extra);
    expect(Buffer.byteLength(name, 'utf8')).toBe(limit + extra);
    setProducts([product('한글-😀', { name, price: '0', stock: '1' })]);
    if (extra) { await assertDenied('UNAVAILABLE'); return; }
    const { result, csv } = await compose();
    expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected multibyte DTO');
    expect(result.dto.rows[0].name).toBe(name);
    assertCsv(csv, HEADER + `"'한글-😀","'${name}","","'0","'1","'false"\r\n`, 1);
  });

  it('composes all 10000 admitted rows, not a catalog page or a truncated CSV', async () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => `p-${String(index).padStart(5, '0')}`);
    setProducts([...ids].reverse().map(id => product(id, { name: '연필', price: '0', stock: '1' })));
    const { result, csv } = await compose();
    expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected complete fixture DTO');
    expect(result.dto.rows.map(row => row.productId)).toEqual(ids);
    const expected = HEADER + ids.map(id => `"'${id}","'연필","","'0","'1","'false"\r\n`).join('');
    assertCsv(csv, expected, 10_000);
  });

  it.each([0, 1])('enforces the reader byte budget plus %s before CSV composition', async extra => {
    const rows = budgetProducts(8 * 1024 * 1024 + extra);
    setProducts(rows);
    if (extra) { await assertDenied('LIMIT_EXCEEDED'); return; }
    const { result, csv } = await compose();
    expect(result.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (result.kind !== 'CURRENT_PRODUCT_INVENTORY_DISPLAY') throw new Error('Expected full boundary DTO');
    expect(result.dto.rows).toHaveLength(rows.length);
    const expected = HEADER + rows.map(row => `"'${row.product_id}","'${row.name}","","'${row.price}","'${row.stock}","'false"\r\n`).join('');
    assertCsv(csv, expected, rows.length);
  });

  it.each(['missing cookie', 'missing session'])('has no DTO/CSV for %s', async mode => {
    if (mode === 'missing session') seams.session.mockReturnValue(null);
    await assertDenied('UNAUTHENTICATED', request(mode === 'missing cookie' ? '' : COOKIE));
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it('has no DTO/CSV for a nonread request', async () => {
    const req = new Request('https://example.invalid/fixture', { method: 'POST', headers: { cookie: COOKIE } });
    await assertDenied('INVALID_REQUEST', req);
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it.each(['missing membership', 'other tenant membership', 'unsupported role', 'statement revocation'])('has no DTO/CSV for %s', async mode => {
    if (mode === 'missing membership') memberReply.rows = [];
    if (mode === 'other tenant membership') memberReply.rows[0].tenant_id = OTHER;
    if (mode === 'unsupported role') memberReply.rows[0].role = 'VIEWER';
    if (mode === 'statement revocation') displayReply.rows = [sentinel({ authorized: false })];
    await assertDenied('FORBIDDEN');
    expect(queries.filter(isDisplay)).toHaveLength(mode === 'statement revocation' ? 1 : 0);
  });

  it('has no DTO/CSV for a cross-tenant product even after a good product', async () => {
    setProducts([product('first-good'), product('foreign', { tenant_id: OTHER })]);
    await assertDenied('UNAVAILABLE');
  });

  it.each(['missing member of set', 'duplicate ID', 'unexpected field'])('rejects %s without publishing partial rows', async mode => {
    if (mode === 'missing member of set') displayReply.rows[0].product_count = '2';
    if (mode === 'duplicate ID') setProducts([product('same'), product('same')]);
    if (mode === 'unexpected field') displayReply.rows[0].image_url = EXTRA_CANARY;
    await assertDenied('UNAVAILABLE');
  });

  it('has no DTO/CSV for the 10001-row overflow sentinel', async () => {
    displayReply.rows = [sentinel({ product_count: '10001', overflow: true })];
    await assertDenied('LIMIT_EXCEEDED');
  });

  it('does not leak a synthetic driver error to results, CSV or console', async () => {
    displayError = new Error(DRIVER_CANARY);
    await assertDenied('UNAVAILABLE');
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('refuses DTO publication if read-only cleanup fails', async () => {
    client.release.mockImplementation(() => { throw new Error(DRIVER_CANARY); });
    await assertDenied('UNAVAILABLE');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
