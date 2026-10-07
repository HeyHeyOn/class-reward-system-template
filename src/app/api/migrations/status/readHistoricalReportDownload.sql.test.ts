// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { QueryConfig } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const transport = vi.hoisted(() => ({ connect: vi.fn(), config: vi.fn(), provider: vi.fn() }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(), Pool: class {
  connect = transport.connect;
  on() {}
} }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: transport.config }));
vi.mock('googleapis', () => ({ google: new Proxy({}, { get() {
  transport.provider();
  throw new Error('External provider forbidden in synthetic SQL test');
} }) }));
// The adapter, reader, tenant authorization, AES-GCM cookie verifier, projector
// and formatter are REAL. Only pool acquisition/configuration is replaced:
// every successful query returns the unmodified result of actual PGlite SQL.
// No producer, route, Next server, socket, source or deployed database is used.
import { formatHistoricalReportDownload } from './historicalReportDownload';
import { readHistoricalReportDownload } from './readHistoricalReportDownload';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FOREIGN_USER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FOREIGN_MEMBER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SUBJECT = 'synthetic-sql-download-subject';
const FOREIGN_SUBJECT = 'synthetic-foreign-subject';
const JOB = 'historical/과거 job:%20';
const OTHER_JOB = 'different-job';
const BAD_JOB = 'bad-digest-job';
const SECRET = 'synthetic-sql-download-secret-not-a-real-credential';
const PRIVATE = 'synthetic-private-source-DO-NOT-ECHO';
const ROLE = 'historical_attachment_reader';
const LIMIT = 65_536;
const CATEGORIES = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
];
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
};
const NON_AUTHORITY = {
  projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
  eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
  currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
  freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
};
const id = (digit: string) => `reconciliation:${digit.repeat(64)}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Invalid synthetic fixture');
  return text;
}
function archive(status: 'MATCHED_PREFLIGHT' | 'BLOCKED', tenant = TENANT, job = JOB) {
  const details = {
    report: { reportVersion: 1, phase: 'PREFLIGHT', status, authority: 'SHEETS_AND_REDIS', cutoverAllowed: false,
      metrics: status === 'MATCHED_PREFLIGHT'
        ? CATEGORIES.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' }))
        : [{ category: 'BALANCES', expected: '-999999999999999999999999999999', actual: '999999999999999999999999999999',
          delta: '1999999999999999999999999999998', status: 'MISMATCH' }],
      diagnostics: status === 'MATCHED_PREFLIGHT' ? []
        : [{ category: 'BALANCES', code: 'ROW_MISMATCH', rowReference: 'c'.repeat(64) }], omittedDiagnostics: 0 },
    comparisonInstant: '2026-09-01T12:00:00.000Z', manifestDigest: 'a'.repeat(64),
    currentManifestDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
  };
  return { tenant_id: tenant, job_id: job,
    event_id: `reconciliation:${createHash('sha256').update(canonical([tenant, job, details]), 'utf8').digest('hex')}`,
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
    entity_type: null, entity_id: null, redacted_details: details };
}
const matched = archive('MATCHED_PREFLIGHT');
const blocked = archive('BLOCKED');
const foreign = archive('MATCHED_PREFLIGHT', OTHER);
const otherJob = archive('MATCHED_PREFLIGHT', TENANT, OTHER_JOB);
const badDigest = archive('MATCHED_PREFLIGHT', TENANT, BAD_JOB);
// Valid schema, stale digest: corruption must survive SQL selection but fail
// integrity, not be mistaken for an absent report or a valid MATCHED archive.
badDigest.redacted_details.sourceFingerprint = 'f'.repeat(64);
const oversized = [
  { label: 'full JSON details', eventId: id('1'), extra: { redacted_details: { padding: PRIVATE + 'x'.repeat(131_072) } } },
  { label: 'metadata outside details', eventId: id('2'), extra: { entity_type: 'x'.repeat(65_537), entity_id: PRIVATE } },
  { label: 'UTF-8 rather than string units', eventId: id('3'), extra: { entity_type: '가'.repeat(22_000), entity_id: PRIVATE } },
  { label: 'JSON escaping', eventId: id('4'), extra: { entity_type: '\\'.repeat(32_768), entity_id: PRIVATE } },
];
function cookie(subject = SUBJECT, issuedAt = Date.now()) {
  const iv = Buffer.alloc(12, 11); // Deterministic fixture only; not a token issuer.
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
let requestSuffix = '';
type Options = { method?: 'GET' | 'HEAD'; slug?: string; jobId?: string; reportId?: string; cookie?: string; query?: string; path?: string };
function request(options: Options = {}) {
  return new Request(`https://example.test${options.path ?? `/api/migrations/status/${options.slug ?? 'alpha'}/preflight${requestSuffix}`}?${options.query
    ?? `jobId=${encodeURIComponent(options.jobId ?? JOB)}&reportId=${options.reportId ?? matched.event_id}`}`, {
    method: options.method ?? 'GET',
    headers: { cookie: options.cookie ?? cookie(), 'x-tenant-id': OTHER, 'x-role': 'OWNER',
      'if-none-match': '*', range: 'bytes=0-10' },
  });
}
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
type Config = QueryConfig & { query_timeout: number };
let database: PGlite;
let tables: string[];
let inReader = false;
let queries: { config: Config; result: Reply; state: Record<string, unknown> }[];
let client: EventEmitter & { query: (config: Config) => Promise<Reply>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
const session = async () => (await database.query<Record<string, unknown>>(`SELECT current_user::text AS role,
  current_setting('transaction_read_only') AS read_only,
  current_setting('transaction_isolation') AS isolation,
  nullif(current_setting('app.tenant_id',true),'') AS tenant,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('lock_timeout') AS lock_timeout,
  current_setting('idle_in_transaction_session_timeout') AS idle_timeout`)).rows[0];
async function owner<T>(work: () => Promise<T>): Promise<T> {
  if (inReader) throw new Error('Fixture owner forbidden during reader invocation');
  await database.exec('RESET ROLE');
  try { return await work(); }
  finally { await database.exec(`SET ROLE ${ROLE}`); }
}
// Snapshot EVERY public fixture table, not just the selected rows. Counts and
// SHA256 of ordered complete row JSON include even empty operational tables.
const snapshot = () => owner(async () => {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[table] = (await database.query(`SELECT count(*) AS count,
      encode(digest(coalesce(string_agg(row_to_json(t)::text, ',' ORDER BY row_to_json(t)::text),''),'sha256'),'hex') AS digest
      FROM public."${table}" AS t`)).rows;
  }
  return result;
});
const insert = (row: Record<string, unknown>) => database.query(`INSERT INTO audit_events
  (tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [row.tenant_id, row.event_id, row.job_id, row.event_type,
  row.operation_id, row.actor_user_id, row.entity_type, row.entity_id, JSON.stringify(row.redacted_details)]);

beforeAll(async () => {
  database = new PGlite({ extensions: { pgcrypto } });
  for (const name of ['0001_identity_tenants.sql', '0002_operational.sql', '0003_operations_migrations.sql', '0012_platform_tenant_discovery.sql']) {
    await database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
  }
  await database.query(`INSERT INTO tenants (id,slug,display_name,lifecycle) VALUES
    ($1,'alpha','Synthetic alpha','ACTIVE'),($2,'beta','Synthetic beta','ACTIVE')`, [TENANT, OTHER]);
  await database.query(`INSERT INTO users (id,google_subject,canonical_email) VALUES
    ($1,$2,'synthetic@example.test'),($3,$4,'foreign@example.test')`, [USER, SUBJECT, FOREIGN_USER, FOREIGN_SUBJECT]);
  await database.query("INSERT INTO tenant_memberships (tenant_id,id,user_id,role) VALUES ($1,$2,$3,'OWNER')",
    [OTHER, FOREIGN_MEMBER, FOREIGN_USER]);
  await database.query(`INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES
    ($1,$3,'DISCOVERED'),($2,$3,'DISCOVERED'),($1,$4,'DISCOVERED'),($1,$5,'DISCOVERED')`, [TENANT, OTHER, JOB, OTHER_JOB, BAD_JOB]);
  for (const row of [matched, blocked, foreign, otherJob, badDigest,
    { ...matched, event_id: id('5'), event_type: 'MIGRATION_LOCAL_RECONCILIATION' },
    { ...matched, event_id: id('6'), redacted_details: { ...matched.redacted_details, rawSource: PRIVATE } },
    ...oversized.map(fixture => ({ ...matched, event_id: fixture.eventId, ...fixture.extra }))]) await insert(row);
  // Pin the *SQL JSONB text* full-envelope edge, not JS stringify's different
  // whitespace. The at-limit row remains invalid archival metadata (503).
  for (const [digit, target] of [['7', LIMIT], ['8', LIMIT + 1]] as const) {
    const row = { ...matched, event_id: id(digit), entity_type: 'x', entity_id: PRIVATE };
    const bytes = (await database.query<{ bytes: number }>(
      "SELECT octet_length(convert_to($1::jsonb::text,'UTF8')) AS bytes", [JSON.stringify(row)],
    )).rows[0].bytes;
    row.entity_type = 'x'.repeat(target - bytes + 1);
    await insert(row);
  }
  tables = (await database.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  )).rows.map(row => row.tablename);
  expect(tables).toEqual(expect.arrayContaining(['tenants', 'users', 'tenant_memberships', 'migration_jobs', 'audit_events']));
  expect(tables.every(table => /^[a-z_]+$/.test(table))).toBe(true);
  await database.exec(`CREATE ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO ${ROLE};
    GRANT SELECT ON migration_jobs,audit_events TO ${ROLE};
    GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO ${ROLE};
    GRANT EXECUTE ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO ${ROLE};`);
}, 30_000);
afterAll(async () => {
  if (database) {
    try { await database.exec('ROLLBACK; RESET ROLE'); }
    finally { await database.close(); }
  }
});
beforeEach(async () => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External fetch forbidden')));
  transport.provider.mockClear();
  transport.config.mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/fixture', directDatabaseUrl: 'must-not-use' });
  await owner(async () => {
    await database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1', [TENANT]);
    await database.query("INSERT INTO tenant_memberships (tenant_id,id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [TENANT, MEMBER, USER]);
  });
  queries = [];
  client = Object.assign(new EventEmitter(), {
    async query(config: Config): Promise<Reply> {
      // NO success interception, canned row, SQL rewriting or elevated role.
      // PGlite supplies its own field OIDs/decoded rows, NOT pg's wire parsers.
      const result = await database.query<Record<string, unknown>>(config.text, config.values);
      queries.push({ config, result, state: await session() });
      return result;
    },
    release: vi.fn(), end: vi.fn(async () => {}),
  });
  transport.connect.mockReset().mockResolvedValue(client);
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(transport.provider).not.toHaveBeenCalled();
  } finally {
    inReader = false;
    try { await database.exec('ROLLBACK; RESET ROLE'); }
    finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  }
});

// Every invocation, including pre-DB refusals, compares all persisted contents
// and the pooled session. Assertions are OUTSIDE the reader's catch/sanitizer.
async function read(options: Options = {}, acquires = true) {
  const before = await snapshot();
  const beforeState = await session();
  expect(beforeState).toMatchObject({ role: ROLE, read_only: 'off', tenant: null });
  queries = [];
  transport.connect.mockClear(); client.release.mockClear(); client.end.mockClear();
  const req = request(options);
  const originalCookie = req.headers.get('cookie');
  let response: Response;
  inReader = true;
  try { response = await readHistoricalReportDownload(options.slug ?? 'alpha', req); }
  finally { inReader = false; }
  expect(req.headers.get('cookie')).toBe(originalCookie);
  expect(await session()).toEqual(beforeState); // Before any test-owned rollback/reset.
  expect((await database.query('SELECT event_id FROM audit_events')).rows).toEqual([]);
  expect((await database.query('SELECT job_id FROM migration_jobs')).rows).toEqual([]);
  expect(await snapshot()).toEqual(before);
  expect(client.listenerCount('error')).toBe(0);
  expect(client.end).not.toHaveBeenCalled();
  if (acquires) {
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(queries[0].config.text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(queries.at(-1)?.config.text).toBe('ROLLBACK');
    expect(queries.filter(({ config }) => config.text.startsWith('BEGIN'))).toHaveLength(1);
    for (const { config, state } of queries.slice(0, -1)) {
      expect(state).toMatchObject({ role: ROLE, read_only: 'on', isolation: 'read committed' });
      expect(config.query_timeout).toBeGreaterThan(0);
      expect(config.query_timeout).toBeLessThanOrEqual(2_000);
    }
    expect(queries.every(({ config }) => /^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/.test(config.text))).toBe(true);
    for (const { state } of queries.filter(({ config }) => config.text.includes('public.audit_events'))) {
      expect(state).toMatchObject({ tenant: TENANT, statement_timeout: '1500ms', lock_timeout: '500ms', idle_timeout: '5s' });
    }
  } else {
    expect(transport.connect).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  }
  return response;
}
function reportResult() {
  const reports = queries.filter(({ config }) => config.text.includes('public.audit_events'));
  expect(reports).toHaveLength(1);
  expect(reports[0].result.fields).toEqual([
    { name: 'found', dataTypeID: 16 }, { name: 'oversized', dataTypeID: 16 }, { name: 'envelope_text', dataTypeID: 25 },
  ]);
  return reports[0].result;
}
function noDisclosure(text: string) {
  for (const raw of [PRIVATE, TENANT, OTHER, USER, MEMBER, FOREIGN_USER, FOREIGN_MEMBER, SUBJECT, FOREIGN_SUBJECT,
    SECRET, JOB, BAD_JOB, 'synthetic@example.test', 'postgresql://', 'SHEETS_AND_REDIS', 'redacted_details']) expect(text).not.toContain(raw);
}
async function failure(response: Response, status: number, error: string, method: 'GET' | 'HEAD') {
  expect(response.status).toBe(status);
  // Exact allowlist also excludes disposition, cookies, CORS, redirects,
  // validators, ranges and Content-Length on EVERY failure, including HEAD.
  expect(Object.fromEntries(response.headers)).toEqual(PRIVATE_HEADERS);
  const text = await response.text();
  expect(text).toBe(method === 'HEAD' ? '' : JSON.stringify({ error }));
  noDisclosure(text);
}

describe.each(['', '/download'])('synthetic SQL -> authenticated attachment at /preflight%s (NOT HTTP or real pg wire)', suffix => {
  beforeEach(() => { requestSuffix = suffix; });
  it('proves the fixture role is SELECT-only, non-owner/NOBYPASSRLS with FORCE RLS and SQL read-only enforcement', async () => {
    expect((await database.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const privileges = (await database.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
      owns: boolean; can_select: boolean; can_write: boolean;
    }>(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      c.relowner = (SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns,
      has_table_privilege(c.oid,'SELECT') AS can_select,
      has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)).rows;
    expect(privileges).toHaveLength(tables.length);
    for (const row of privileges) {
      expect(row).toMatchObject({ owns: false, can_write: false });
      expect(row.can_select).toBe(['audit_events', 'migration_jobs'].includes(row.relname));
      if (row.can_select) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const before = await snapshot();
    // Negative harness controls only, outside any reader invocation.
    await expect(database.exec("UPDATE migration_jobs SET status='FAILED'")).rejects.toMatchObject({ code: '42501' });
    await database.exec('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    try { await expect(database.exec('DELETE FROM audit_events')).rejects.toMatchObject({ code: '25006' }); }
    finally { await database.exec('ROLLBACK'); }
    expect(await snapshot()).toEqual(before);
  });

  it.each(['OWNER', 'ADMIN'] as const)('returns exact MATCHED and BLOCKED bytes for %s; HEAD repeats SQL/auth and preserves metadata', async role => {
    await owner(() => database.query('UPDATE tenant_memberships SET role=$1 WHERE tenant_id=$2 AND id=$3', [role, TENANT, MEMBER]));
    for (const row of [matched, blocked]) {
      const expected = formatHistoricalReportDownload(row, { tenantId: TENANT, migrationJobId: JOB, reportId: row.event_id });
      expect(expected.kind).toBe('HISTORICAL_REPORT_DOWNLOAD');
      if (expected.kind !== 'HISTORICAL_REPORT_DOWNLOAD') throw new Error('Invalid synthetic archive');
      const get = await read({ reportId: row.event_id });
      expect(get.status).toBe(200);
      const headers = { ...PRIVATE_HEADERS, 'content-disposition': `attachment; filename="${expected.filename}"` };
      expect(Object.fromEntries(get.headers)).toEqual(headers);
      const bytes = new Uint8Array(await get.arrayBuffer());
      expect(bytes).toEqual(new TextEncoder().encode(expected.body));
      expect(bytes.byteLength).toBeLessThanOrEqual(LIMIT);
      expect(bytes[0]).toBe(123); // No UTF-8 BOM, no double-encoded JSON.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      expect(text.endsWith('\n')).toBe(true); expect(text.endsWith('\n\n')).toBe(false);
      expect(JSON.parse(text)).toMatchObject({ ...NON_AUTHORITY, report: {
        status: row.redacted_details.report.status, metrics: row.redacted_details.report.metrics,
        diagnostics: row.redacted_details.report.diagnostics,
      } });
      noDisclosure(text);
      expect(JSON.parse(reportResult().rows[0].envelope_text as string)).toEqual(row);
      expect(queries.find(({ config }) => config.text.includes('public.audit_events'))?.config.values)
        .toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', row.event_id]);
      const head = await read({ method: 'HEAD', reportId: row.event_id });
      expect(head.status).toBe(200); expect(head.body).toBeNull(); expect(await head.text()).toBe('');
      expect(Object.fromEntries(head.headers)).toEqual(headers);
      expect(JSON.parse(reportResult().rows[0].envelope_text as string)).toEqual(row);
      expect(queries.filter(({ config }) => config.text.includes('public.platform_find_membership'))).toHaveLength(2);
    }
  });

  it.each(['revoked', 'rebound-member', 'rebound-user', 'rebound-slug'])('the actual final SQL rechecks %s with previously admitted parameters', async change => {
    expect((await read()).status).toBe(200);
    const final = queries.find(({ config }) => config.text.includes('public.audit_events'))!.config;
    // PGlite is single-session: test-owner changes are BETWEEN transactions,
    // never injected into the reader or a canned success result. Replaying the
    // exact SELECT proves its same-statement predicates with stale parameters,
    // NOT multi-connection revocation timing or a stronger-than-snapshot lease.
    await owner(async () => {
      if (change === 'revoked') await database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND id=$2', [TENANT, MEMBER]);
      if (change === 'rebound-member') await database.query('UPDATE tenant_memberships SET id=$1 WHERE tenant_id=$2 AND id=$3', [OTHER, TENANT, MEMBER]);
      if (change === 'rebound-user') await database.query('UPDATE tenant_memberships SET user_id=$1 WHERE tenant_id=$2 AND id=$3', [FOREIGN_USER, TENANT, MEMBER]);
      if (change === 'rebound-slug') await database.query("UPDATE tenants SET slug='alpha-rebound' WHERE id=$1", [TENANT]);
    });
    const before = await snapshot();
    const beforeState = await session();
    try {
      await database.exec('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await database.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      expect(await session()).toMatchObject({ role: ROLE, read_only: 'on', isolation: 'read committed', tenant: TENANT });
      const result = await database.query(final.text, final.values);
      expect(result.rows).toEqual([]);
      expect(result.fields).toEqual([
        { name: 'found', dataTypeID: 16 }, { name: 'oversized', dataTypeID: 16 }, { name: 'envelope_text', dataTypeID: 25 },
      ]);
      await database.exec('ROLLBACK');
      expect(await session()).toEqual(beforeState);
      expect(await snapshot()).toEqual(before);
    } finally {
      await database.exec('ROLLBACK');
      await owner(async () => {
        await database.query("UPDATE tenants SET slug='alpha' WHERE id=$1", [TENANT]);
        await database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1', [TENANT]);
        await database.query("INSERT INTO tenant_memberships (tenant_id,id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [TENANT, MEMBER, USER]);
      });
    }
  });

  describe.each(['GET', 'HEAD'] as const)('%s refusal boundaries using actual SQL', method => {
    it.each(['missing', 'tampered', 'duplicate', 'expired'] as const)('refuses %s identity without acquiring a client', async kind => {
      const valid = cookie();
      const value = kind === 'missing' ? '' : kind === 'tampered' ? tamperedCookie()
        : kind === 'duplicate' ? `${valid}; ${valid}` : cookie(SUBJECT, Date.now() - 31 * 24 * 60 * 60 * 1000);
      await failure(await read({ method, cookie: value }, false), 401, 'AUTHENTICATION_REQUIRED', method);
    });
    it.each([
      { slug: 'beta', reportId: foreign.event_id },
      { cookie: () => cookie(FOREIGN_SUBJECT) },
      { cookie: () => cookie('synthetic-nonmember') },
    ])('refuses foreign/nonmember admission without trusting tenant/role headers (%j)', async options => {
      await failure(await read({ ...options, cookie: typeof options.cookie === 'function' ? options.cookie() : undefined, method }),
        403, 'ACCESS_DENIED', method);
      expect(queries.some(({ config }) => config.text.includes('public.audit_events'))).toBe(false);
    });
    it('reauthorizes after membership revocation BETWEEN invocations, not a multi-connection race', async () => {
      expect((await read()).status).toBe(200);
      await owner(() => database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND id=$2', [TENANT, MEMBER]));
      await failure(await read({ method }), 403, 'ACCESS_DENIED', method);
      expect(queries.some(({ config }) => config.text.includes('public.audit_events'))).toBe(false);
    });
    it.each([
      { reportId: id('0') }, // Absent exact report, despite other valid reports.
      { jobId: 'absent-job' },
      { reportId: foreign.event_id }, // Exists, but only in another tenant.
      { reportId: otherJob.event_id }, // Exists, but only under another job.
      { reportId: id('5') }, // Wrong event type, not a fallback candidate.
    ])('maps missing/foreign/wrong-job/wrong-type selections uniformly (%j)', async options => {
      await failure(await read({ ...options, method }), 404, 'PREFLIGHT_REPORT_NOT_FOUND', method);
      expect(reportResult().rows).toEqual([{ found: false, oversized: false, envelope_text: null }]);
    });
    it.each([
      { reportId: badDigest.event_id, jobId: BAD_JOB },
      { reportId: id('6') },
    ])('refuses a found bad digest/shape without source or exception disclosure (%j)', async options => {
      await failure(await read({ ...options, method }), 503, 'PREFLIGHT_REPORT_UNAVAILABLE', method);
      expect(reportResult().rows[0]).toMatchObject({ found: true, oversized: false, envelope_text: expect.any(String) });
    });
    it.each(oversized)('gates $label in SQL before returning envelope TEXT', async fixture => {
      await failure(await read({ method, reportId: fixture.eventId }), 503, 'PREFLIGHT_REPORT_UNAVAILABLE', method);
      expect(reportResult().rows).toEqual([{ found: true, oversized: true, envelope_text: null }]);
    });
    it.each([['7', LIMIT], ['8', LIMIT + 1]] as const)('pins the SQL full-envelope boundary (%s -> %i bytes)', async (digit, bytes) => {
      await failure(await read({ method, reportId: id(digit) }), 503, 'PREFLIGHT_REPORT_UNAVAILABLE', method);
      const row = reportResult().rows[0];
      expect(row).toMatchObject({ found: true, oversized: bytes > LIMIT });
      if (bytes === LIMIT) expect(Buffer.byteLength(row.envelope_text as string, 'utf8')).toBe(LIMIT);
      else expect(row.envelope_text).toBeNull();
    });
    it.each([
      `jobId=${encodeURIComponent(JOB)}&reportId=bad`,
      `jobId=${encodeURIComponent(JOB)}&reportId=${matched.event_id}&download=1`,
      `jobId=%ZZ&reportId=${matched.event_id}`,
      `job%49d=${encodeURIComponent(JOB)}&reportId=${matched.event_id}`,
      `jobId=%C0%AF&reportId=${matched.event_id}`,
      `jobId=x&jobId=y&reportId=${matched.event_id}`,
      `jobId=x&reportId=${matched.event_id}&reportId=${matched.event_id}`,
    ])('preserves strict bad-selector admission without a query (%s)', async query => {
      await failure(await read({ method, query }, false), 400, 'INVALID_PREFLIGHT_REQUEST', method);
    });
    it.each([
      '/api/migrations/status/alpha/preflight/download/',
      '/api/migrations/status/alpha/preflight/download/extra',
      '/api/migrations/status/beta/preflight/download',
      '/api/migrations/status/%61lpha/preflight/download',
      '/api/migrations/status/alpha/preflight/%64ownload',
    ])('refuses near-miss path %s before SQL', async path => {
      await failure(await read({ method, path }, false), 400, 'INVALID_PREFLIGHT_REQUEST', method);
    });
  });
});
