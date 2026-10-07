import 'server-only';

import { types as nodeTypes } from 'node:util';
import { Pool, type PoolClient, type QueryConfig, type QueryResult } from 'pg';
import { getDatabaseConfig } from '@/server/db/config';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { authorizeTenantAdmin, TenantAuthorizationError, type TenantMembership } from '@/server/tenantAuth';
import { parseTenantSlug, resolveTenantContext, TenantContextError, type TenantRecord } from '@/server/tenantContext';
import type { ProductInventoryDisplayDto, ProductInventoryDisplayRow } from './productInventoryCsv';

/** Fixed admission limits, not caller options. No truncation or partial pages.
 * maxOutputBytes bounds a conservative UTF-8/JSON budget (not CSV bytes): 1024
 * envelope bytes + sum(256 + 6 * text-field UTF-8 bytes + decimal digits).
 * The factor 6 allows JSON escaping; unused budget is not transferable across
 * per-field limits. This deliberately refuses some otherwise small outputs.
 */
export const PRODUCT_INVENTORY_DISPLAY_READ_LIMITS = Object.freeze({
  maxRows: 10_000,
  maxProductIdBytes: 256,
  maxNameBytes: 4_096,
  maxCategoryBytes: 256,
  maxOutputBytes: 8 * 1024 * 1024,
});
const LIMITS = PRODUCT_INVENTORY_DISPLAY_READ_LIMITS;
const STAGE_MS = 2_000;
const TOTAL_MS = 5_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_DECIMAL = '9007199254740991';
const LIFECYCLES = ['DRAFT', 'IMPORTING', 'READY', 'ACTIVE', 'MIGRATION_READ_ONLY', 'SUSPENDED'];

export type AuthorizedProductInventoryDisplayResult = Readonly<{
  kind: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'UNAVAILABLE' | 'LIMIT_EXCEEDED';
}> | Readonly<{
  kind: 'CURRENT_PRODUCT_INVENTORY_DISPLAY';
  authority: 'NONAUTHORITY';
  readOnly: true;
  source: 'POSTGRESQL';
  scope: 'ALL_NONDELETED_PRODUCTS';
  snapshot: 'STATEMENT';
  complete: true;
  cutoverAllowed: false;
  activationAllowed: false;
  rowCount: number;
  dto: ProductInventoryDisplayDto;
}>;
const unavailable = (): AuthorizedProductInventoryDisplayResult => ({ kind: 'UNAVAILABLE' });

function boundedString(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length <= bytes && Buffer.byteLength(value, 'utf8') <= bytes;
}
function displayText(value: unknown, bytes: number, blank: boolean): value is string {
  if (!boundedString(value, bytes) || (!blank && !value.trim())) return false;
  // Same lossless text admission as the display formatter: tabs/CR/LF survive;
  // other C0/C1 controls and unpaired surrogates do not. No repair/normalization.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
}
function decimal(value: unknown): value is string {
  return boundedString(value, 16) && /^(?:0|[1-9][0-9]{0,15})$/.test(value)
    && (value.length < MAX_DECIMAL.length || value <= MAX_DECIMAL);
}
function unambiguousCookie(request: Request): boolean {
  let count = 0;
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const segment = part.trim();
    const equals = segment.indexOf('=');
    const name = equals < 0 ? segment : segment.slice(0, equals).trim();
    if (name !== GOOGLE_AUTH_COOKIE) continue;
    if (++count !== 1 || equals < 0) return false;
    try {
      const token = decodeURIComponent(segment.slice(equals + 1));
      if (!boundedString(token, 8192) || !/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
    } catch { return false; }
  }
  return count === 1;
}

// Separate bounded runtime pool: do not mutate the shared application's pool.
// pg's own acquisition deadline removes queued waiters/connecting sockets; a
// Promise.race around an unbounded shared pool alone would not do that.
let pool: Pool | undefined;
function runtimePool(): Pool {
  if (!pool) {
    const { databaseUrl } = getDatabaseConfig({ DATABASE_URL: process.env.DATABASE_URL });
    pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: STAGE_MS,
      idleTimeoutMillis: 1_000, allowExitOnIdle: true });
    pool.on('error', () => { /* Failed idle clients are removed by pg-pool. No raw logs. */ });
  }
  return pool;
}

// Refuse accidentally privileged URLs and disabled FORCE RLS, rather than
// silently succeeding through the migration/owner role. No SET ROLE or grants.
// Canonical deployed schemas/policies remain a provisioning prerequisite; this
// is not an attestation of arbitrary RLS policy bodies or credential provenance.
const SECURITY_SQL = `SELECT COALESCE((SELECT NOT r.rolsuper AND NOT r.rolbypassrls
  AND current_user = session_user
  AND (SELECT count(*) = 3 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner <> r.oid)
    FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('products','tenants','tenant_memberships') AND c.relkind = 'r')
  FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user), false) AS runtime_safe`;
const TENANT_SQL = `SELECT t.id,
  CASE WHEN octet_length(convert_to(t.slug, 'UTF8')) <= 63 THEN t.slug ELSE NULL::text END AS slug,
  CASE WHEN octet_length(convert_to(t.display_name, 'UTF8')) <= 1024 THEN t.display_name ELSE NULL::text END AS display_name,
  CASE WHEN t.lifecycle IN ('DRAFT','IMPORTING','READY','ACTIVE','MIGRATION_READ_ONLY','SUSPENDED') THEN t.lifecycle ELSE NULL::text END AS lifecycle,
  CASE WHEN t.timezone = 'Asia/Seoul' THEN t.timezone ELSE NULL::text END AS timezone
  FROM public.platform_find_tenant_by_slug($1) AS t LIMIT 2`;
const MEMBER_SQL = `SELECT m.id, m.tenant_id, m.user_id,
  CASE WHEN octet_length(convert_to(m.google_subject, 'UTF8')) <= 1024 THEN m.google_subject ELSE NULL::text END AS google_subject,
  CASE WHEN m.role IN ('OWNER','ADMIN') THEN m.role ELSE NULL::text END AS role
  FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m LIMIT 2`;

// ONE READ COMMITTED statement snapshot for current authorization, membership,
// bounded full-set count, byte budget and every projected row. No count/list
// race, OFFSET/cursor, lazy page, per-product follow-up or READ COMMITTED pages.
// The discovery functions intentionally LIMIT 1 in the canonical schema. The
// direct scoped membership CTE also checks cardinality BEFORE matching member id
// or role, so an extra/rebound row cannot be hidden by that LIMIT 1 or a filter.
// User-subject uniqueness is guaranteed by the canonical users schema.
// Explicit tenant predicates supplement transaction-local app.tenant_id / RLS.
// Only nondeleted products belong to this display set; inactive ones DO belong.
// Count reaches at most 10001 (overflow sentinel, not a claimed source total).
// Per-cell gates + aggregate suppression precede wire parsing. PostgreSQL may
// still scan/sort/detoast more data internally; SQL/deadline bounds are not a
// claim of constant DB CPU/memory. None of the output proves Sheets freshness.
const DISPLAY_SQL = `WITH identity AS MATERIALIZED (
  SELECT m.id, m.tenant_id, m.user_id, m.google_subject, m.role
  FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m LIMIT 2
), current_members AS MATERIALIZED (
  SELECT m.id, m.tenant_id, m.user_id, m.role FROM public.tenant_memberships AS m
  WHERE m.tenant_id = $1 AND m.user_id = $4 LIMIT 2
), current_tenant AS MATERIALIZED (
  SELECT t.id, t.slug FROM public.tenants AS t WHERE t.id = $1 AND t.slug = $5 LIMIT 2
), access_gate AS MATERIALIZED (
  SELECT ((SELECT count(*) = 1 AND COALESCE(bool_and(m.id = $3 AND m.tenant_id = $1
      AND m.user_id = $4 AND m.google_subject = $2 AND m.role IN ('OWNER','ADMIN')), false) FROM identity AS m)
    AND (SELECT count(*) = 1 AND COALESCE(bool_and(m.id = $3 AND m.tenant_id = $1
      AND m.user_id = $4 AND m.role IN ('OWNER','ADMIN')), false) FROM current_members AS m)
    AND (SELECT count(*) = 1 FROM current_tenant)) AS authorized
), sampled AS MATERIALIZED (
  SELECT p.tenant_id,
    CASE WHEN octet_length(convert_to(p.product_id, 'UTF8')) <= ${LIMITS.maxProductIdBytes} THEN p.product_id ELSE NULL::text END AS product_id,
    CASE WHEN octet_length(convert_to(p.name, 'UTF8')) <= ${LIMITS.maxNameBytes} THEN p.name ELSE NULL::text END AS name,
    CASE WHEN octet_length(convert_to(p.category, 'UTF8')) <= ${LIMITS.maxCategoryBytes} THEN p.category ELSE NULL::text END AS category,
    CASE WHEN p.price BETWEEN 0 AND 9007199254740991 THEN p.price::text ELSE NULL::text END AS price,
    CASE WHEN p.stock BETWEEN 0 AND 9007199254740991 THEN p.stock::text ELSE NULL::text END AS stock,
    p.is_active,
    COALESCE(p.product_id IS NOT NULL AND octet_length(convert_to(p.product_id, 'UTF8')) <= ${LIMITS.maxProductIdBytes}
      AND p.name IS NOT NULL AND octet_length(convert_to(p.name, 'UTF8')) <= ${LIMITS.maxNameBytes}
      AND (p.category IS NULL OR octet_length(convert_to(p.category, 'UTF8')) <= ${LIMITS.maxCategoryBytes})
      AND p.price BETWEEN 0 AND 9007199254740991 AND p.stock BETWEEN 0 AND 9007199254740991
      AND p.is_active IS NOT NULL, false) AS row_valid
  FROM public.products AS p WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
    AND (SELECT authorized FROM access_gate)
  ORDER BY p.product_id COLLATE "C" LIMIT ${LIMITS.maxRows + 1}
), summary AS (
  SELECT count(*)::text AS product_count, COALESCE(bool_and(row_valid), true) AS valid,
    (count(*) > ${LIMITS.maxRows} OR 1024 + COALESCE(sum(256 + 6 * (
      COALESCE(octet_length(convert_to(product_id, 'UTF8')), 0)
      + COALESCE(octet_length(convert_to(name, 'UTF8')), 0)
      + COALESCE(octet_length(convert_to(category, 'UTF8')), 0))
      + COALESCE(length(price), 0) + COALESCE(length(stock), 0)), 0) > ${LIMITS.maxOutputBytes}) AS overflow
  FROM sampled
)
SELECT a.authorized, s.product_count, s.overflow, s.valid,
  p.tenant_id, p.product_id, p.name, p.category, p.price, p.stock, p.is_active
FROM access_gate AS a CROSS JOIN summary AS s
LEFT JOIN sampled AS p ON a.authorized AND s.valid AND NOT s.overflow
ORDER BY p.product_id COLLATE "C"`;

type Fields = readonly (readonly [string, number])[];
const SECURITY_FIELDS: Fields = [['runtime_safe', 16]];
const TENANT_FIELDS: Fields = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: Fields = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const DISPLAY_FIELDS: Fields = [['authorized', 16], ['product_count', 25], ['overflow', 16], ['valid', 16],
  ['tenant_id', 2950], ['product_id', 25], ['name', 25], ['category', 25], ['price', 25], ['stock', 25], ['is_active', 16]];
// Never call a JSON/global/custom parser or throw inside pg's event callbacks.
// Unknown OIDs remain inert text, and metadata validation then refuses them.
const scalarTypes: NonNullable<QueryConfig['types']> = {
  getTypeParser(oid, format) {
    if (oid === 16 && (!format || format === 'text')) return (value: string) => value === 't' ? true : value === 'f' ? false : value;
    return (value: string | Buffer) => value;
  },
};
function validRows(result: QueryResult, fields: Fields, maxRows: number): boolean {
  return result.rows.length <= maxRows && result.fields.length === fields.length
    && fields.every(([name, oid], i) => result.fields[i].name === name && result.fields[i].dataTypeID === oid
      && result.fields[i].format === 'text')
    && result.rows.every(row => {
      if (!row || typeof row !== 'object' || nodeTypes.isProxy(row) || Array.isArray(row)) return false;
      const proto = Object.getPrototypeOf(row);
      if (proto !== Object.prototype && proto !== null) return false;
      if (Reflect.ownKeys(row).length !== fields.length) return false;
      return fields.every(([name]) => {
        const descriptor = Object.getOwnPropertyDescriptor(row, name);
        return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
      });
    });
}
function project(data: QueryResult, tenantId: string): AuthorizedProductInventoryDisplayResult {
  if (!validRows(data, DISPLAY_FIELDS, LIMITS.maxRows) || !data.rows.length) return unavailable();
  const first = data.rows[0];
  if (typeof first.authorized !== 'boolean' || typeof first.valid !== 'boolean' || typeof first.overflow !== 'boolean'
    || !boundedString(first.product_count, 5) || !/^(?:0|[1-9][0-9]{0,4})$/.test(first.product_count)) return unavailable();
  const count = Number(first.product_count); // Bounded count ONLY; never convert product decimals or IDs.
  if (count > LIMITS.maxRows + 1 || data.rows.some(row => row.authorized !== first.authorized
    || row.valid !== first.valid || row.overflow !== first.overflow || row.product_count !== first.product_count)) return unavailable();
  const isSentinel = data.rows.length === 1 && DISPLAY_FIELDS.slice(4).every(([name]) => first[name] === null);
  if (!first.authorized) return isSentinel && count === 0 && first.valid && !first.overflow ? { kind: 'FORBIDDEN' } : unavailable();
  if (!first.valid) return unavailable();
  if (first.overflow) return isSentinel && count > 0 ? { kind: 'LIMIT_EXCEEDED' } : unavailable();
  if (count > LIMITS.maxRows || (count === 0 ? !isSentinel : data.rows.length !== count)) return unavailable();
  const rows: ProductInventoryDisplayRow[] = [];
  const seen = new Set<string>();
  let byteBudget = 1024;
  for (const row of count ? data.rows : []) {
    const { product_id: productId, name, category, price, stock, is_active: isActive } = row;
    if (row.tenant_id !== tenantId || !displayText(productId, LIMITS.maxProductIdBytes, false)
      || !displayText(name, LIMITS.maxNameBytes, false)
      || !(category === null || displayText(category, LIMITS.maxCategoryBytes, true))
      || !decimal(price) || !decimal(stock) || typeof isActive !== 'boolean' || seen.has(productId)) return unavailable();
    seen.add(productId);
    byteBudget += 256 + 6 * (Buffer.byteLength(productId, 'utf8') + Buffer.byteLength(name, 'utf8')
      + (category === null ? 0 : Buffer.byteLength(category, 'utf8'))) + price.length + stock.length;
    if (byteBudget > LIMITS.maxOutputBytes) return { kind: 'LIMIT_EXCEEDED' };
    rows.push({ productId, name, category, price, stock, isActive });
  }
  // Match the formatter's raw UTF-16 code-unit order, not PostgreSQL locale or
  // UTF-8/C order (which differs for supplementary vs BMP Unicode). All members
  // are present before sorting, so this never changes a page boundary.
  rows.sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
  return { kind: 'CURRENT_PRODUCT_INVENTORY_DISPLAY', authority: 'NONAUTHORITY', readOnly: true,
    source: 'POSTGRESQL', scope: 'ALL_NONDELETED_PRODUCTS', snapshot: 'STATEMENT', complete: true,
    cutoverAllowed: false, activationAllowed: false, rowCount: rows.length, dto: { rows } };
}
class ChangedIdentity extends Error {}

/** Server-internal reader, not a route, serializer, export artifact or backup.
 * ONLY canonical slug and the authenticated request are accepted; no supplied
 * rows, tenant-id, completeness assertion, session/store/pool override or cursor.
 * A future transport must admit canonical path selectors, authenticate each call
 * and disable shared caching. Request URL/body/tenant headers are NOT authority.
 *
 * Scope: every nondeleted PostgreSQL product in the authorized tenant, including
 * inactive products, at ONE statement snapshot under the canonical schema/RLS.
 * This is neither a historical generation nor a claim that PostgreSQL is live,
 * current relative to Sheets, or fit for cutover/activation. No runtime wiring.
 * Schema prerequisites: canonical unique user subject and scoped membership,
 * FORCE RLS tenant policies, discovery EXECUTE and scoped SELECT on products,
 * tenants and tenant_memberships for a non-owner/non-BYPASSRLS runtime role.
 * Missing grants/schema/configuration refuse; never grant/fallback/repair here.
 *
 * One runtime connection, READ COMMITTED READ ONLY, then ROLLBACK (no COMMIT).
 * 5s whole-call / 2s step / 1.5s statement / 0.5s lock bounds; no retries. Checks
 * after synchronous projection/cleanup cannot preempt an event-loop pause, but
 * will refuse late publication. Revocation after the final statement snapshot
 * is not locked out: this is an observation, NOT an authorization lease.
 */
export async function readAuthorizedProductInventoryDisplay(
  slug: unknown, request: Request,
): Promise<AuthorizedProductInventoryDisplayResult> {
  const deadline = performance.now() + TOTAL_MS;
  let originalCookie: string | null;
  let session: ReturnType<typeof getGoogleSessionFromRequest>;
  try {
    const canonical = parseTenantSlug(slug);
    if (canonical.needsRedirect) return { kind: 'FORBIDDEN' };
    if (!['GET', 'HEAD'].includes(request.method) || !boundedString(request.headers.get('cookie') ?? '', 32768)) return { kind: 'INVALID_REQUEST' };
    if (!unambiguousCookie(request)) return { kind: 'UNAUTHENTICATED' };
    originalCookie = request.headers.get('cookie');
    session = getGoogleSessionFromRequest(request);
    if (!session || !displayText(session.subject, 1024, false)) return { kind: 'UNAUTHENTICATED' };
  } catch (error) {
    return { kind: error instanceof TenantContextError ? 'FORBIDDEN' : 'INVALID_REQUEST' };
  }

  let client: PoolClient | undefined;
  let rolledBack = false;
  let releaseAttempted = false;
  let failed = false;
  let rejectStep: (() => void) | undefined;
  const release = (destroy: boolean) => {
    if (!client || releaseAttempted) return;
    releaseAttempted = true;
    try {
      if (destroy) client.release(true);
      else client.release();
    } catch {
      try { void client.end().catch(() => {}); } catch { /* No raw error or double release. */ }
      throw new Error('Product display cleanup unavailable');
    } finally { client.removeListener('error', stop); }
  };
  function stop() {
    failed = true;
    try { release(true); } catch { /* Publication already refused. */ }
    rejectStep?.();
  }
  const check = () => {
    if (failed || request.signal.aborted || performance.now() >= deadline) throw new Error('Product display deadline');
  };
  const checkIdentity = () => {
    if (request.headers.get('cookie') !== originalCookie) throw new ChangedIdentity();
    const current = getGoogleSessionFromRequest(request);
    if (!unambiguousCookie(request) || !current || current.subject !== session.subject
      || current.issuedAt !== session.issuedAt) throw new ChangedIdentity();
  };
  const run = <T>(start: () => Promise<T>, late?: (value: T) => void): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = () => { settled = true; clearTimeout(timer); rejectStep = undefined; };
      rejectStep = () => { finish(); reject(new Error('Product display unavailable')); };
      const timer = setTimeout(stop, Math.max(1, Math.min(STAGE_MS, deadline - performance.now())));
      try {
        void start().then(value => {
          if (settled) { try { late?.(value); } catch { /* Never resume SQL on a late client. */ } return; }
          finish(); resolve(value);
        }, error => { if (!settled) { finish(); reject(error); } });
      } catch (error) { if (!settled) { finish(); reject(error); } }
    });
  };
  const query = (text: string, values?: unknown[]) => {
    check(); checkIdentity();
    const config: QueryConfig & { query_timeout: number } = { text, values, types: scalarTypes,
      query_timeout: Math.max(1, Math.floor(Math.min(STAGE_MS, deadline - performance.now()))) };
    return run(() => client!.query(config));
  };
  request.signal.addEventListener('abort', stop, { once: true });
  try {
    check();
    client = await run(() => runtimePool().connect(), late => {
      try { late.release(true); } catch { try { void late.end().catch(() => {}); } catch { /* No raw error. */ } }
    });
    client.on('error', stop);
    check(); checkIdentity();
    await query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    await query("SET LOCAL statement_timeout = '1500ms'");
    await query("SET LOCAL lock_timeout = '500ms'");
    await query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    const security = await query(SECURITY_SQL);
    if (!validRows(security, SECURITY_FIELDS, 1) || security.rows[0]?.runtime_safe !== true) throw new Error('Unsafe runtime context');
    let result: AuthorizedProductInventoryDisplayResult;
    try {
      const { tenant } = await resolveTenantContext(slug, {
        async findBySlug(canonicalSlug) {
          const data = await query(TENANT_SQL, [canonicalSlug]);
          if (!validRows(data, TENANT_FIELDS, 1)) throw new Error('Invalid directory result');
          const row = data.rows[0];
          if (!row || !boundedString(row.id, 36) || !UUID.test(row.id) || !boundedString(row.slug, 63)
            || !boundedString(row.display_name, 1024) || row.timezone !== 'Asia/Seoul'
            || !LIFECYCLES.includes(row.lifecycle)) return null;
          return { id: row.id, slug: row.slug, displayName: row.display_name, lifecycle: row.lifecycle, timezone: row.timezone } as TenantRecord;
        },
      });
      const membership = await authorizeTenantAdmin(tenant, session, {
        async findByTenantAndSubject(tenantId, subject) {
          const data = await query(MEMBER_SQL, [tenantId, subject]);
          if (!validRows(data, MEMBER_FIELDS, 1)) throw new Error('Invalid membership result');
          const row = data.rows[0];
          if (!row || !boundedString(row.id, 36) || !UUID.test(row.id) || !boundedString(row.user_id, 36)
            || !UUID.test(row.user_id) || !boundedString(row.google_subject, 1024)) return null;
          return { id: row.id, tenantId: row.tenant_id, userId: row.user_id, googleSubject: row.google_subject, role: row.role } as TenantMembership;
        },
      });
      await query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
      const data = await query(DISPLAY_SQL, [tenant.id, session.subject, membership.id, membership.userId, tenant.slug]);
      check(); checkIdentity();
      result = project(data, tenant.id);
    } catch (error) {
      if (error instanceof TenantContextError || error instanceof TenantAuthorizationError) result = { kind: 'FORBIDDEN' };
      else throw error;
    }
    check(); checkIdentity();
    await query('ROLLBACK');
    rolledBack = true;
    check(); checkIdentity();
    release(false); // Successful cleanup is a prerequisite to publication.
    check(); checkIdentity();
    return result;
  } catch (error) {
    return error instanceof ChangedIdentity ? { kind: 'UNAUTHENTICATED' } : unavailable();
  } finally {
    request.signal.removeEventListener('abort', stop);
    try { release(!rolledBack); } catch { /* Already refusing with sanitized output. */ }
  }
}
