// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { QueryConfig } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), pool: vi.fn(), on: vi.fn() }));
vi.mock('pg', async original => ({ ...await original<typeof import('pg')>(), Pool: class {
  constructor(options: unknown) { mocks.pool(options); }
  connect = mocks.connect;
  on = mocks.on;
} }));
// Only the connection boundary is mocked; real cookie verification, tenant
// resolver and membership authorizer run. All identities/credentials are synthetic.
import { readAuthorizedProductInventoryDisplay } from './readAuthorizedProductInventoryDisplay';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-reader-subject';
const SECRET = 'public-synthetic-product-reader-test-secret';
const NOW = Date.parse('2026-09-26T00:00:00Z');
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
type Config = QueryConfig & { query_timeout: number };
type Row = Record<string, unknown>;
type Fields = [string, number][];
type Reply = { rows: Row[]; fields: { name: string; dataTypeID: number; format: string }[] };
const TENANT_FIELDS: Fields = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: Fields = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const DISPLAY_FIELDS: Fields = [['authorized', 16], ['product_count', 25], ['overflow', 16], ['valid', 16],
  ['tenant_id', 2950], ['product_id', 25], ['name', 25], ['category', 25], ['price', 25], ['stock', 25], ['is_active', 16]];
const reply = (rows: Row[], fields: Fields): Reply => ({ rows,
  fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) });
const directory = () => ({ id: TENANT, slug: 'alpha', display_name: 'Synthetic', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' });
const member = () => ({ id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' });
const product = (id = 'p-01'): Row => ({ authorized: true, product_count: '1', overflow: false, valid: true,
  tenant_id: TENANT, product_id: id, name: '연필', category: null, price: '9007199254740991', stock: '0', is_active: false });
const sentinel = (change: Row = {}): Row => ({ authorized: true, product_count: '0', overflow: false, valid: true,
  tenant_id: null, product_id: null, name: null, category: null, price: null, stock: null, is_active: null, ...change });
const dtoRow = (row = product()) => ({ productId: row.product_id, name: row.name, category: row.category,
  price: row.price, stock: row.stock, isActive: row.is_active });
const expected = (rows = [dtoRow()]) => ({ kind: 'CURRENT_PRODUCT_INVENTORY_DISPLAY', authority: 'NONAUTHORITY',
  readOnly: true, source: 'POSTGRESQL', scope: 'ALL_NONDELETED_PRODUCTS', snapshot: 'STATEMENT', complete: true,
  cutoverAllowed: false, activationAllowed: false, rowCount: rows.length, dto: { rows } });
function budgetRows(target: number): Row[] {
  const rows: Row[] = Array.from({ length: 350 }, (_, index) => ({ ...product(`p-${String(index).padStart(5, '0')}`),
    product_count: '350', name: 'a', price: '1', stock: '1' }));
  let remaining = target - 1024 - rows.reduce((sum, row) => sum + 256
    + 6 * (Buffer.byteLength(row.product_id as string) + Buffer.byteLength(row.name as string)) + 2, 0);
  for (const row of rows) {
    const extra = Math.min(4095, Math.floor(remaining / 6));
    row.name = 'a'.repeat(extra + 1); remaining -= extra * 6;
  }
  expect(remaining).toBeGreaterThanOrEqual(0); expect(remaining).toBeLessThan(6);
  rows[0].stock = `1${'0'.repeat(remaining)}`;
  return rows;
}
function cookie(issuedAt = Date.now(), subject = SUBJECT) {
  const iv = Buffer.alloc(12, 9); // Deterministic test-only IV, not production encryption.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function request(options: { cookie?: string; method?: string; signal?: AbortSignal } = {}) {
  return new Request(`https://example.test/internal?tenantId=${OTHER}&limit=1&cursor=ignored`, {
    headers: { cookie: options.cookie ?? cookie(), 'x-tenant-id': OTHER, 'x-role': 'OWNER' },
    method: options.method ?? 'GET', signal: options.signal,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let configs: Config[];
let tenantReply: Reply;
let memberReply: Reply;
let displayReply: Reply;
let securityReply: Reply;
let hook: ((config: Config) => Reply | void | Promise<Reply | void>) | undefined;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
const isDisplay = (config: Config) => config.text.includes('public.products AS p');
const isSecurity = (config: Config) => config.text.includes('pg_catalog.pg_roles');
const finalQuery = () => configs.find(isDisplay)!;
const read = (req = request(), slug: unknown = 'alpha') => readAuthorizedProductInventoryDisplay(slug, req);
beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/fixture');
  vi.stubEnv('DIRECT_DATABASE_URL', 'must-not-use');
  configs = []; hook = undefined;
  tenantReply = reply([directory()], TENANT_FIELDS);
  memberReply = reply([member()], MEMBER_FIELDS);
  displayReply = reply([product()], DISPLAY_FIELDS);
  securityReply = reply([{ runtime_safe: true }], [['runtime_safe', 16]]);
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: Config): Promise<Reply> => {
      configs.push(config);
      const overridden = await hook?.(config);
      if (overridden) return overridden;
      if (isDisplay(config)) return displayReply;
      if (isSecurity(config)) return securityReply;
      if (config.text.includes('public.platform_find_membership')) return memberReply;
      if (config.text.includes('public.platform_find_tenant')) return tenantReply;
      return reply([], []);
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  mocks.connect.mockReset().mockResolvedValue(client);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('fail-closed admission and trusted membership, no caller data authority', () => {
  it.each(['', 'class_store_admin=fake', 'class_store_tenant_admin=fake', 'class_store_google_auth=bad',
    'class_store_google_auth=%ZZ', 'class_store_google_auth', `${cookie(NOW)}; ${cookie(NOW)}`,
    `class_store_google_auth =fake; ${cookie(NOW)}`])('rejects unauthenticated/ambiguous cookie %#', async value => {
    expect(await read(request({ cookie: value }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([-MAX_AGE - 1, 1])('rejects expired/future real cookie %s', async delta => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    expect(await read(request({ cookie: cookie(NOW + delta) }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('rejects tampered ciphertext', async () => {
    const parts = cookie().split('.'); parts[2] = Buffer.alloc(16).toString('base64url');
    expect(await read(request({ cookie: parts.join('.') }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['Alpha', ' alpha', 'alpha ', '', undefined, 'alpha/other', 'a'.repeat(64), { tenantId: TENANT, rows: [] }])('rejects noncanonical/caller authority slug %#', async slug => {
    expect(await readAuthorizedProductInventoryDisplay(slug, request())).toEqual({ kind: 'FORBIDDEN' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'DELETE'])('rejects nonread method %s', async method => {
    expect(await read(request({ method }))).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('bounds the complete cookie header', async () => {
    expect(await read(request({ cookie: 'x'.repeat(32769) }))).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([{ tenant_id: OTHER }, { google_subject: 'other' }, { user_id: 'bad' }, { id: 'bad' }, { role: 'VIEWER' }])('rejects cross-tenant/malformed membership %#', async change => {
    Object.assign(memberReply.rows[0], change);
    expect(await read()).toEqual({ kind: 'FORBIDDEN' }); expect(configs.some(isDisplay)).toBe(false);
  });
  it.each(['tenant', 'member'])('rejects missing %s', async which => {
    (which === 'tenant' ? tenantReply : memberReply).rows = [];
    expect(await read()).toEqual({ kind: 'FORBIDDEN' }); expect(configs.some(isDisplay)).toBe(false);
  });
  it.each(['tenant', 'member'])('rejects extra discovery %s rather than picking one', async which => {
    const data = which === 'tenant' ? tenantReply : memberReply; data.rows.push({ ...data.rows[0] });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(configs.some(isDisplay)).toBe(false);
  });
  it('rejects tenant directory mismatch', async () => {
    tenantReply.rows[0].slug = 'beta';
    expect(await read()).toEqual({ kind: 'FORBIDDEN' }); expect(configs.some(isDisplay)).toBe(false);
  });
  it.each([false, null, 'true'])('refuses unsafe/malformed role and RLS guard %s', async value => {
    securityReply.rows[0].runtime_safe = value;
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(configs.some(isDisplay)).toBe(false);
  });
  it.each(['OWNER', 'ADMIN'])('returns only a closed complete DTO as %s after cleanup', async role => {
    memberReply.rows[0].role = role;
    client.release.mockImplementation(() => { expect(configs.at(-1)?.text).toBe('ROLLBACK'); });
    expect(await read()).toEqual(expected());
    expect(finalQuery().values).toEqual([TENANT, SUBJECT, MEMBER, USER, 'alpha']);
    expect(configs.find(c => c.text.includes("set_config('app.tenant_id'"))?.values).toEqual([TENANT]);
    expect(configs[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(client.listenerCount('error')).toBe(0);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: 'postgresql://synthetic.invalid/fixture',
      max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000, allowExitOnIdle: true }));
  });
  it('admits HEAD and never uses URL/header pagination or fake role', async () => {
    expect(await read(request({ method: 'HEAD' }))).toEqual(expected());
    expect(finalQuery().values).not.toContain(OTHER);
  });
});

describe('complete bounded projection, not a page or an export artifact', () => {
  it('distinguishes authorized empty set from revoked membership', async () => {
    displayReply.rows = [sentinel()]; expect(await read()).toEqual(expected([]));
    displayReply.rows = [sentinel({ authorized: false })]; expect(await read()).toEqual({ kind: 'FORBIDDEN' });
  });
  it.each(['missing', 'extra', 'duplicate', 'no-envelope'])('refuses %s product membership against statement total', async mode => {
    if (mode === 'missing') displayReply.rows[0].product_count = '2';
    if (mode === 'extra') displayReply.rows.push(product('p-02'));
    if (mode === 'duplicate') displayReply.rows = [product(), product()].map(row => ({ ...row, product_count: '2' }));
    if (mode === 'no-envelope') displayReply.rows = [];
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each([{ tenant_id: OTHER }, { product_id: '' }, { product_id: ' ' }, { name: '\u0001' }, { name: '\ud800' },
    { name: '' }, { category: undefined }, { price: 1 }, { price: '01' }, { price: '-1' }, { price: '1e2' },
    { price: '9007199254740992' }, { stock: '9007199254740992' }, { stock: null }, { is_active: 'true' },
    { product_count: 1 }, { product_count: '01' }, { authorized: 'true' }, { valid: false },
    { product_id: 'x'.repeat(257) }, { name: 'x'.repeat(4097) }, { category: '한'.repeat(86) }])('refuses malformed display row %#', async change => {
    Object.assign(displayReply.rows[0], change); expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each(['extra', 'missing', 'jsonb', 'binary', 'reordered', 'accessor', 'proxy'])('refuses unexpected shape/type %s', async mode => {
    const trap = vi.fn(() => { throw new Error('must not inspect'); });
    if (mode === 'extra') displayReply.rows[0].image_url = 'private-canary';
    if (mode === 'missing') delete displayReply.rows[0].stock;
    if (mode === 'jsonb') displayReply.fields[6].dataTypeID = 3802;
    if (mode === 'binary') displayReply.fields[6].format = 'binary';
    if (mode === 'reordered') displayReply.fields.reverse();
    if (mode === 'accessor') Object.defineProperty(displayReply.rows[0], 'stock', { get: trap, enumerable: true });
    if (mode === 'proxy') displayReply.rows[0] = new Proxy(product(), { ownKeys: trap, get: trap });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(trap).not.toHaveBeenCalled();
  });
  it('orders by exact raw UTF-16 IDs, independently of DB collation', async () => {
    const ids = ['😀', '\uE000', 'é', 'e\u0301', '2', '10', '=opaque', '한'];
    displayReply.rows = ids.map(id => ({ ...product(id), product_count: String(ids.length) }));
    const output = await read();
    expect(output).toEqual(expected([...displayReply.rows].sort((a, b) => String(a.product_id) < String(b.product_id) ? -1 : 1).map(dtoRow)));
  });
  it('accepts inclusive field bounds and canonical safe-range decimals without number coercion', async () => {
    displayReply.rows = [{ ...product('x'.repeat(256)), name: 'x'.repeat(4096), category: 'x'.repeat(256),
      price: '0', stock: '9007199254740991' }];
    expect(await read()).toEqual(expected(displayReply.rows.map(dtoRow)));
  });
  it('preserves raw opaque IDs, whitespace and empty nullable category without normalization', async () => {
    displayReply.rows = [{ ...product('000001'), name: '  = raw\tname\n', category: '' }];
    expect(await read()).toEqual(expected(displayReply.rows.map(dtoRow)));
  });
  it.each([0, 1])('enforces multibyte UTF-8 name boundary plus %s without truncation', async extra => {
    const bytesPerCharacter = Buffer.byteLength('가');
    const name = '가'.repeat(Math.floor(4096 / bytesPerCharacter)) + 'a'.repeat(4096 % bytesPerCharacter + extra);
    expect(Buffer.byteLength(name)).toBe(4096 + extra);
    displayReply.rows = [{ ...product(), name }];
    expect(await read()).toEqual(extra === 0 ? expected(displayReply.rows.map(dtoRow)) : { kind: 'UNAVAILABLE' });
  });
  it.each([0, 1])('enforces the inclusive conservative output-byte boundary plus %s', async extra => {
    displayReply.rows = budgetRows(8 * 1024 * 1024 + extra);
    const output = await read();
    expect(output.kind).toBe(extra === 0 ? 'CURRENT_PRODUCT_INVENTORY_DISPLAY' : 'LIMIT_EXCEEDED');
    if (output.kind === 'CURRENT_PRODUCT_INVENTORY_DISPLAY') {
      expect(output.rowCount).toBe(350);
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
  });
  it('returns every one of 10000 rows, including inactive, instead of the catalog 500-row page', async () => {
    displayReply.rows = Array.from({ length: 10000 }, (_, i) => ({ ...product(`p-${String(i).padStart(5, '0')}`), product_count: '10000' }));
    const output = await read(); expect(output).toEqual(expected(displayReply.rows.map(dtoRow)));
  });
  it('refuses a 10001 overflow sentinel without publishing a prefix', async () => {
    displayReply.rows = [sentinel({ product_count: '10001', overflow: true })];
    expect(await read()).toEqual({ kind: 'LIMIT_EXCEEDED' });
  });
  it('rejects an inconsistent overflow/count envelope', async () => {
    displayReply.rows = [sentinel({ product_count: '10001' })];
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it('enforces the aggregate conservative output-byte budget even for individually valid rows', async () => {
    displayReply.rows = Array.from({ length: 400 }, (_, i) => ({ ...product(`p-${i}`), product_count: '400', name: 'x'.repeat(4096) }));
    expect(await read()).toEqual({ kind: 'LIMIT_EXCEEDED' });
  });
  it('never selects secrets/history/payloads or mutates operational data', async () => {
    await read(); const sql = configs.map(c => c.text).join('\n');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT|CREATE|ALTER|GRANT|FOR SHARE|FOR UPDATE|pg_advisory)\b/i);
    expect(sql).not.toMatch(/image_url|migration_|canonical_record|redacted_details|external_source_id/);
    expect(sql).toContain("SET LOCAL statement_timeout = '1500ms'");
    expect(sql).toContain("SET LOCAL lock_timeout = '500ms'");
    expect(sql).toContain("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    expect(sql).toContain('LIMIT 10001'); expect(sql).not.toMatch(/\bOFFSET\b/);
    expect(sql).toContain('p.deleted_at IS NULL'); expect(sql).not.toMatch(/p\.is_active\s*=\s*true/i);
    expect(configs.filter(isDisplay)).toHaveLength(1);
    expect(configs.every(c => c.query_timeout > 0 && c.query_timeout <= 2000)).toBe(true);
    const source = readFileSync(new URL('./readAuthorizedProductInventoryDisplay.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter(line => line.includes('import ')).join('\n');
    expect(imports).not.toMatch(/migration\/|sheets|redis|repositories\/factory|next\//i);
    expect(imports).not.toContain('buildProductInventoryCsv');
    expect(finalQuery().types!.getTypeParser(3802, 'text')('{"unsafe":true}')).toBe('{"unsafe":true}');
  });
});

describe('actual SELECTs in isolated in-memory PostgreSQL fixtures; no operational database', () => {
  let db: PGlite;
  let beforeFinal: (() => Promise<unknown>) | undefined;
  let sqlErrors: unknown[];
  afterEach(() => { expect(sqlErrors).toEqual([]); });
  // Real emitted SELECTs, with a mocked pool/role guard/transaction lifecycle.
  // Discovery deliberately retains the real LIMIT 1, so final direct membership
  // cardinality cannot accidentally rely on LIMIT 2 around that function.
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE tenants (id uuid, slug text, display_name text, lifecycle text, timezone text);
      CREATE TABLE users (id uuid, google_subject text);
      CREATE TABLE tenant_memberships (id uuid, tenant_id uuid, user_id uuid, role text);
      CREATE FUNCTION platform_find_tenant_by_slug(text) RETURNS SETOF tenants LANGUAGE sql STABLE
        AS 'SELECT * FROM tenants WHERE slug = $1 LIMIT 1';
      CREATE FUNCTION platform_find_membership_by_tenant_and_google_subject(uuid,text)
        RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, google_subject text, role text) LANGUAGE sql STABLE
        AS 'SELECT m.id, m.tenant_id, m.user_id, u.google_subject, m.role FROM tenant_memberships m
          JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.google_subject=$2 LIMIT 1';
      CREATE TABLE products (tenant_id uuid, product_id text, name text, category text,
        price bigint, stock bigint, is_active boolean, deleted_at timestamptz, image_url text);
    `);
  }, 20000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    beforeFinal = undefined; sqlErrors = [];
    await db.exec('TRUNCATE tenants, users, tenant_memberships, products');
    await db.query('INSERT INTO tenants VALUES ($1,$2,$3,$4,$5)', Object.values(directory()));
    await db.query('INSERT INTO users VALUES ($1,$2)', [USER, SUBJECT]);
    await db.query('INSERT INTO tenant_memberships VALUES ($1,$2,$3,$4)', [MEMBER, TENANT, USER, 'OWNER']);
    await db.query('INSERT INTO products VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)',
      [TENANT, 'p-01', '연필', null, '9007199254740991', '0', false, 'private-image-canary']);
    hook = async config => {
      if (isSecurity(config) || !/^(?:SELECT|WITH)\b/.test(config.text) || config.text.includes('set_config')) return;
      if (isDisplay(config)) await beforeFinal?.();
      try {
        const result = await db.query<Row>(config.text, config.values);
        return { rows: result.rows, fields: result.fields.map(field => ({ ...field, format: 'text' })) };
      } catch (error) {
        // Refusal tests must not pass merely because the actual SQL is broken.
        sqlErrors.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
  });
  it('selects current nondeleted tenant rows including inactive; excludes another tenant/deleted', async () => {
    await db.query('INSERT INTO products VALUES ($1,\'foreign\',\'secret\',NULL,1,1,true,NULL,\'secret\'), ($2,\'deleted\',\'gone\',NULL,1,1,true,now(),NULL)', [OTHER, TENANT]);
    const result = await read(); expect(result).toEqual(expected());
    for (const hidden of [TENANT, USER, MEMBER, SUBJECT, 'private-image-canary', 'foreign', 'deleted']) expect(JSON.stringify(result)).not.toContain(hidden);
  });
  it.each([
    'DELETE FROM tenant_memberships', `UPDATE tenant_memberships SET id = '${OTHER}'`,
    `UPDATE tenant_memberships SET user_id = '${OTHER}'`, `UPDATE tenant_memberships SET tenant_id = '${OTHER}'`,
    "UPDATE tenant_memberships SET role = 'VIEWER'", "UPDATE users SET google_subject = 'rebound'",
    "UPDATE tenants SET slug = 'beta'", `UPDATE tenants SET id = '${OTHER}'`,
    'INSERT INTO tenant_memberships SELECT * FROM tenant_memberships',
    `INSERT INTO tenant_memberships SELECT '${OTHER}',tenant_id,user_id,role FROM tenant_memberships`,
  ])('refuses revocation/rebind/extra membership after initial admission %#', async sql => {
    beforeFinal = () => db.exec(sql);
    expect(await read()).toEqual({ kind: 'FORBIDDEN' }); expect(finalQuery()).toBeDefined();
  });
  it('executes the real runtime catalog guard and refuses the privileged fixture principal', async () => {
    const original = hook!;
    let observed: Reply | undefined;
    hook = async config => {
      if (isSecurity(config)) {
        const result = await db.query<Row>(config.text, config.values);
        observed = { rows: result.rows, fields: result.fields.map(field => ({ ...field, format: 'text' })) };
        return observed;
      }
      return original(config);
    };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    // Assert outside the reader's sanitized catch so a failed SQL/assertion can
    // never masquerade as the expected refusal.
    expect(observed?.rows).toEqual([{ runtime_safe: false }]);
    expect(configs.some(isDisplay)).toBe(false);
  });
  it('executes READ ONLY transaction/session scope and rolls it back before returning', async () => {
    // The fixture owner is privileged: only this admission guard is mocked.
    // All transaction controls, local settings and data SELECTs execute in PG.
    hook = async config => {
      if (isSecurity(config)) return;
      if (isDisplay(config)) {
        expect((await db.query('SHOW transaction_read_only')).rows).toEqual([{ transaction_read_only: 'on' }]);
        expect((await db.query('SHOW transaction_isolation')).rows).toEqual([{ transaction_isolation: 'read committed' }]);
        expect((await db.query("SELECT current_setting('app.tenant_id') AS scope")).rows).toEqual([{ scope: TENANT }]);
      }
      const result = await db.query<Row>(config.text, config.values);
      return { rows: result.rows, fields: result.fields.map(field => ({ ...field, format: 'text' })) };
    };
    expect(await read()).toEqual(expected());
    expect((await db.query('SHOW transaction_read_only')).rows).toEqual([{ transaction_read_only: 'off' }]);
    expect((await db.query("SELECT current_setting('app.tenant_id',true) AS scope")).rows).toEqual([{ scope: '' }]);
  });
  it('rechecks actual complete product set in the final statement instead of an earlier list/count', async () => {
    beforeFinal = () => db.exec("DELETE FROM products; INSERT INTO products VALUES ('" + TENANT + "','new','new',NULL,1,2,true,NULL,NULL)");
    expect(await read()).toEqual(expected([{ productId: 'new', name: 'new', category: null, price: '1', stock: '2', isActive: true }]));
  });
  it('returns an authorized empty set, not a missing envelope', async () => {
    await db.exec('DELETE FROM products'); expect(await read()).toEqual(expected([]));
  });
  it('detects duplicated real product IDs rather than silently deduplicating', async () => {
    await db.exec('INSERT INTO products SELECT * FROM products');
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each([
    "UPDATE products SET price = -1", "UPDATE products SET stock = 9007199254740992",
    "UPDATE products SET is_active = NULL", "UPDATE products SET name = NULL",
    "UPDATE products SET category = repeat('한',86)", "UPDATE products SET product_id = repeat('x',257)",
    "UPDATE products SET name = repeat('x',4097)",
  ])('refuses an invalid member of the product set, not filtering it out %#', async sql => {
    await db.exec(sql); expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it('bounds oversized cells before wire output and suppresses the entire invalid product set', async () => {
    await db.query('UPDATE products SET name=$1', ['한'.repeat(2000)]);
    const original = hook!; let observed: Reply | void;
    hook = async c => { const result = await original(c); if (isDisplay(c)) observed = result; return result; };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(observed!.rows).toEqual([sentinel({ product_count: '1', valid: false })]);
  });
  it('executes the full 10000-row boundary and uses a 10001st sentinel instead of truncating', async () => {
    await db.exec(`DELETE FROM products; INSERT INTO products
      SELECT '${TENANT}', 'p-' || lpad(i::text,5,'0'), 'item', NULL, i, 0, (i%2=0), NULL, NULL FROM generate_series(1,10000) AS i`);
    const output = await read();
    expect(output.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (output.kind === 'CURRENT_PRODUCT_INVENTORY_DISPLAY') {
      expect(output.rowCount).toBe(10000); expect(output.dto.rows).toHaveLength(10000);
      expect(output.dto.rows[0].productId).toBe('p-00001'); expect(output.dto.rows.at(-1)?.productId).toBe('p-10000');
    }
    await db.query("INSERT INTO products VALUES ($1,'p-10001','item',NULL,1,0,true,NULL,NULL)", [TENANT]);
    const original = hook!; let observed: Reply | void;
    hook = async c => { const result = await original(c); if (isDisplay(c)) observed = result; return result; };
    expect(await read()).toEqual({ kind: 'LIMIT_EXCEEDED' });
    expect(observed!.rows).toEqual([sentinel({ product_count: '10001', overflow: true })]);
  });
  it('executes the exact inclusive SQL output-budget boundary and rejects one more byte', async () => {
    await db.exec('DELETE FROM products');
    const rows = budgetRows(8 * 1024 * 1024);
    await db.query(`INSERT INTO products (tenant_id,product_id,name,category,price,stock,is_active)
      SELECT $1,x.product_id,x.name,x.category,x.price,x.stock,x.is_active FROM jsonb_to_recordset($2::jsonb)
      AS x(product_id text,name text,category text,price bigint,stock bigint,is_active boolean)`, [TENANT, JSON.stringify(rows)]);
    const output = await read(); expect(output.kind).toBe('CURRENT_PRODUCT_INVENTORY_DISPLAY');
    if (output.kind === 'CURRENT_PRODUCT_INVENTORY_DISPLAY') expect(output.rowCount).toBe(350);
    await db.exec("UPDATE products SET price=10 WHERE product_id='p-00000'");
    expect(await read()).toEqual({ kind: 'LIMIT_EXCEEDED' });
  }, 15000);
  it('suppresses aggregate oversized data before pg can buffer the product rows', async () => {
    await db.exec(`DELETE FROM products; INSERT INTO products
      SELECT '${TENANT}', i::text, repeat('x',4096), NULL, 1, 0, true, NULL, NULL FROM generate_series(1,400) AS i`);
    const original = hook!; let observed: Reply | void;
    hook = async c => { const result = await original(c); if (isDisplay(c)) observed = result; return result; };
    expect(await read()).toEqual({ kind: 'LIMIT_EXCEEDED' });
    expect(observed!.rows).toEqual([sentinel({ product_count: '400', overflow: true })]);
  });
  it('executes the catalog guard and refuses the privileged in-memory test principal', async () => {
    await read(); const guard = configs.find(isSecurity)!;
    const actual = await db.query(guard.text, guard.values);
    expect(actual.rows).toEqual([{ runtime_safe: false }]);
  });
});

describe('bounded lifecycle and sanitized refusal', () => {
  it.each(['42501', '42P01', '42883', 'XX000'])('fails closed for permission/schema/query error %s', async code => {
    hook = config => { if (isDisplay(config)) throw Object.assign(new Error('postgresql://private-canary'), { code }); };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).toHaveBeenCalledTimes(1); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(configs.filter(isDisplay)).toHaveLength(1);
  });
  it('refuses missing runtime config without direct URL fallback', async () => {
    vi.resetModules(); const fresh = await import('./readAuthorizedProductInventoryDisplay');
    vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('DIRECT_DATABASE_URL', 'postgresql://must-not-use.invalid/privileged');
    expect(await fresh.readAuthorizedProductInventoryDisplay('alpha', request())).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses connection failure without raw logging/retry', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.connect.mockRejectedValue(new Error('private-canary'));
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
  it('refuses an already aborted request before acquiring a client', async () => {
    const abort = new AbortController(); abort.abort();
    expect(await read(request({ signal: abort.signal }))).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('destroys a client arriving after acquisition timeout without issuing SQL', async () => {
    vi.useFakeTimers(); const pending = deferred<typeof client>(); mocks.connect.mockReturnValue(pending.promise);
    const result = read(); await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' }); pending.resolve(client); await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true); expect(configs).toEqual([]);
  });
  it.each(['BEGIN', 'display', 'ROLLBACK'])('does not publish on stalled %s or resume after late rejection', async stage => {
    vi.useFakeTimers(); const pending = deferred<Reply>();
    hook = c => (stage === 'display' ? isDisplay(c) : c.text.startsWith(stage)) ? pending.promise : undefined;
    const result = read(); await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' }); const count = configs.length;
    pending.reject(new Error('late-private')); await vi.advanceTimersByTimeAsync(0);
    expect(configs).toHaveLength(count); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('enforces the whole-call 5s deadline even for individually fast queries', async () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    hook = () => new Promise<void>(resolve => { setTimeout(resolve, 900); });
    const result = read(); await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' }); const count = configs.length;
    await vi.advanceTimersByTimeAsync(3000); expect(configs).toHaveLength(count);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('aborts a pending data read and observes late completion without publishing', async () => {
    const abort = new AbortController(); const entered = deferred<void>(); const pending = deferred<Reply>();
    hook = c => { if (isDisplay(c)) { entered.resolve(); return pending.promise; } };
    const result = read(request({ signal: abort.signal })); await entered.promise; abort.abort();
    expect(await result).toEqual({ kind: 'UNAVAILABLE' }); const count = configs.length;
    pending.resolve(displayReply); await Promise.resolve(); await Promise.resolve();
    expect(configs).toHaveLength(count); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each(['display', 'ROLLBACK'])('rejects replaced cookie during %s', async stage => {
    const req = request(); hook = c => { if (stage === 'display' ? isDisplay(c) : c.text === stage) req.headers.set('cookie', cookie(Date.now(), 'other')); };
    expect(await read(req)).toEqual({ kind: 'UNAUTHENTICATED' }); expect(client.release).toHaveBeenCalledTimes(1);
  });
  it('refuses a session that expires during final SQL', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW); const req = request({ cookie: cookie(NOW - MAX_AGE + 1) });
    hook = c => { if (isDisplay(c)) vi.setSystemTime(NOW + 2); };
    expect(await read(req)).toEqual({ kind: 'UNAUTHENTICATED' });
  });
  it.each(['ROLLBACK', 'release', 'client-error'])('withholds success on cleanup failure %s', async mode => {
    hook = c => {
      if (mode === 'ROLLBACK' && c.text === 'ROLLBACK') throw new Error('private-rollback');
      if (mode === 'client-error' && isDisplay(c)) client.emit('error', new Error('private-error'));
    };
    if (mode === 'release') client.release.mockImplementation(() => { throw new Error('private-release'); });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(client.release).toHaveBeenCalledTimes(1);
    if (mode === 'release') expect(client.end).toHaveBeenCalledTimes(1);
  });
  it('rechecks cancellation/deadline after release before returning', async () => {
    const abort = new AbortController(); client.release.mockImplementation(() => abort.abort());
    expect(await read(request({ signal: abort.signal }))).toEqual({ kind: 'UNAVAILABLE' });
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
