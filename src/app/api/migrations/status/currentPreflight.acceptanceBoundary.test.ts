// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { QueryConfig } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const transport = vi.hoisted(() => {
  const forbidden = vi.fn(() => { throw new Error('Unexpected external/operational transport'); });
  vi.stubGlobal('fetch', forbidden);
  return { forbidden, database: vi.fn(), config: vi.fn(), archiveConnect: vi.fn(), pool: vi.fn() };
});
vi.mock('@/server/db/client', () => ({ getDatabaseClient: transport.database }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: transport.config }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  class Pool {
    constructor(config: unknown) { transport.pool(config); }
    connect = transport.archiveConnect;
    on() {}
  }
  // Retain the real type codecs, but never construct a real socket-owning pg
  // Pool/Client, including through the unused compatibility path's default pg.
  const replacements = { Pool, Client: transport.forbidden };
  return { ...actual, ...replacements, default: { ...actual.default, ...replacements } };
});
vi.mock('googleapis', () => ({ google: new Proxy({}, { get() { return transport.forbidden(); } }) }));

import { getGoogleSessionFromRequest, type GoogleSession } from '@/server/googleOAuth';
import * as statusReader from './readStatus';
import * as historicalReader from './readPreflightReport';
import * as downloadReader from './readHistoricalReportDownload';
import * as statusRoute from './[slug]/route';
import * as preflightRoute from './[slug]/preflight/route';
import * as downloadRoute from './[slug]/preflight/download/route';

// Task20 CHARACTERIZATION ONLY: real exported routes -> real readers, local
// Google verifier, tenant authorization and archive projection. No current
// reader, route, verifier or producer is stubbed or invented. The in-memory pg
// replies and Date.now are synthetic; SQL text/parameters are asserted, NOT
// executed. This is not PostgreSQL/RLS, Next dispatch, browser or live-source
// evidence, nor a lease against revocation after a statement snapshot.
// Models: [slug]/identityLifetime.test.ts and preflight/download/route.test.ts.
// Positive controls below accept saved status/HISTORICAL_ONLY, never current
// preflight. Run only after workers cease and the supervisor approves an
// isolated, cleared-env runner with env-file loading/operational egress denied.
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const KEY = 'synthetic-current-boundary-key-not-a-real-credential';
const SUBJECT = 'synthetic-current-boundary-subject';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REPLACEMENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const JOB = 'historical/과거 job:%20';
const SESSION: GoogleSession = { subject: SUBJECT, email: 'synthetic@example.test', issuedAt: NOW - MAX_AGE_MS + 1 };
const baseTenant = { id: TENANT, slug: 'alpha', display_name: 'Synthetic class', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const baseMember = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
const METRICS = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS', 'COMPLETIONS',
  'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK', 'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA',
  'CANCELLATIONS', 'CANCELLATION_AMOUNT', 'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS',
  'TOMBSTONES', 'ORPHANED_CLAIMS', 'RECURRENCE',
];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Invalid synthetic archive');
  return text;
}
function archive(tenantId = TENANT, digest = 'a'.repeat(64), instant = '2026-09-01T12:00:00.000Z') {
  const details = {
    report: { reportVersion: 1, phase: 'PREFLIGHT', status: 'MATCHED_PREFLIGHT', authority: 'SHEETS_AND_REDIS',
      cutoverAllowed: false, metrics: METRICS.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
      diagnostics: [], omittedDiagnostics: 0 },
    comparisonInstant: instant, manifestDigest: digest, currentManifestDigest: digest,
    sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
  };
  // Independent archival fixture, not an invocation of READY/reconciliation or
  // source acquisition. A recomputable unkeyed hash does not prove provenance.
  return { tenant_id: tenantId, job_id: JOB,
    event_id: `reconciliation:${createHash('sha256').update(canonical([tenantId, JOB, details])).digest('hex')}`,
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
    entity_type: null, entity_id: null, redacted_details: details };
}
function cookie(session = SESSION) {
  const iv = Buffer.alloc(12, 23); // Fixed IV is synthetic-fixture-only, never production guidance.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(KEY).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${bytes.toString('base64url')}`;
}

type Surface = 'status' | 'preflight' | 'download';
type Point = 'membership' | 'data' | 'rollback' | 'release';
type Config = QueryConfig & { query_timeout?: number };
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
const SURFACES: Surface[] = ['status', 'preflight', 'download'];
const routes = { status: statusRoute, preflight: preflightRoute, download: downloadRoute };
const TENANT_SQL = 'SELECT * FROM public.platform_find_tenant_by_slug($1)';
const MEMBER_SQL = 'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)';
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
const reply = (rows: Record<string, unknown>[], fields: [string, number][] = []): Reply => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const SETUP_SQL = [
  'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
  "SET LOCAL statement_timeout = '1500ms'", "SET LOCAL lock_timeout = '500ms'",
  "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
  "SELECT set_config('app.tenant_id', $1, true)", 'ROLLBACK',
];
let now: number;
let tenant: typeof baseTenant;
let member: typeof baseMember | null;
let event: ReturnType<typeof archive>;
let injectedEnvelope: ReturnType<typeof archive> | undefined;
let onPoint: ((point: Point) => void) | undefined;
let failRollback: boolean;
let clients: ReturnType<typeof makeClient>[];
const directoryQuery = vi.fn<(text: string, values?: unknown[]) => Promise<Reply>>();
const statusConnect = vi.fn();

// This fixture models returned rows only. Separate assertions on every actual
// data statement below pin the SQL predicates and parameter binding; these
// negatives must not be represented as execution of those SQL predicates.
function bindingMatches(values: unknown[]) {
  return member !== null && tenant.id === values[0] && tenant.slug === values[5]
    && member.tenant_id === values[0] && member.google_subject === values[1]
    && member.id === values[3] && member.user_id === values[4] && ['OWNER', 'ADMIN'].includes(member.role);
}
async function discovery(kind: 'tenant' | 'member', values: unknown[]): Promise<Reply> {
  const result = kind === 'tenant'
    ? reply(values[0] === tenant.slug ? [{ ...tenant }] : [], TENANT_FIELDS)
    : reply(member && values[0] === member.tenant_id && values[1] === member.google_subject ? [{ ...member }] : [], MEMBER_FIELDS);
  // Capture the admission reply before the synthetic concurrent change, then
  // resolve the awaited transport. Timeouts/performance.now remain real.
  if (kind === 'member') await onPoint?.('membership');
  return result;
}
function makeClient(kind: 'status' | 'archive') {
  const sequence: string[] = [];
  return Object.assign(new EventEmitter(), {
    kind, sequence,
    query: vi.fn(async (config: Config): Promise<Reply> => {
      const text = config.text;
      const values = config.values ?? [];
      const historical = text.includes('public.audit_events');
      if (text.includes('public.migration_jobs')) {
        sequence.push('data');
        let result: Reply;
        if (!bindingMatches(values)) result = reply([], historical ? REPORT_FIELDS : []);
        else if (historical) {
          const found = values[0] === event.tenant_id && values[2] === event.job_id && values[6] === event.event_id;
          result = reply([{ found: Boolean(injectedEnvelope) || found, oversized: false,
            envelope_text: injectedEnvelope ? JSON.stringify(injectedEnvelope) : found ? JSON.stringify(event) : null }], REPORT_FIELDS);
        } else {
          // Two tenants reuse the same opaque job text but have distinct states.
          result = reply([{ status: values[2] === JOB ? values[0] === TENANT ? 'ACTIVE' : 'DISCOVERED' : null }]);
        }
        await onPoint?.('data');
        return result;
      }
      if (text.includes('public.platform_find_membership')) {
        sequence.push('membership');
        return discovery('member', values);
      }
      if (text.includes('public.platform_find_tenant')) {
        sequence.push('tenant');
        return discovery('tenant', values);
      }
      if (!SETUP_SQL.includes(text)) return transport.forbidden();
      sequence.push(text);
      if (text === 'ROLLBACK') {
        await onPoint?.('rollback');
        if (failRollback) throw new Error('synthetic-private-rollback-failure');
      }
      return reply([]);
    }),
    release: vi.fn((discard?: boolean) => {
      sequence.push(discard ? 'release:discard' : 'release:reuse');
      onPoint?.('release');
    }),
    end: vi.fn(async () => {}),
  });
}
function request(surface: Surface, options: { slug?: string; query?: string; cookie?: string; method?: string } = {}) {
  const slug = options.slug ?? 'alpha';
  const suffix = surface === 'status' ? '' : surface === 'preflight' ? '/preflight' : '/preflight/download';
  const query = options.query ?? `jobId=${encodeURIComponent(JOB)}${surface === 'status' ? '' : `&reportId=${event.event_id}`}`;
  return new Request(`https://example.test/api/migrations/status/${slug}${suffix}?${query}`, {
    method: options.method ?? 'GET', headers: {
      cookie: options.cookie ?? cookie(), 'x-tenant-id': OTHER, 'x-role': 'OWNER',
      'x-current-preflight': 'VERIFIED', 'x-cutover-allowed': 'true',
      'if-none-match': '*', 'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT', range: 'bytes=0-10',
    },
  });
}
const context = (slug = 'alpha') => ({ params: Promise.resolve({ slug }) });
const get = (surface: Surface, req = request(surface), slug = 'alpha') => routes[surface].GET(req, context(slug));
const dataReads = () => clients.flatMap(client => client.query.mock.calls.map(([config]) => config))
  .filter(config => config.text.includes('public.migration_jobs'));
function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  for (const name of ['set-cookie', 'etag', 'last-modified', 'location', 'content-range', 'access-control-allow-origin']) {
    expect(response.headers.get(name)).toBeNull();
  }
}
function expectNoDisclosure(text: string) {
  for (const value of [KEY, SUBJECT, SESSION.email, TENANT, OTHER, MEMBER, USER, JOB,
    'class_store_google_auth', 'postgresql://', 'SHEETS_AND_REDIS', 'redacted_details', 'synthetic-private-rollback-failure']) {
    expect(text).not.toContain(value);
  }
}
async function failure(response: Response, status: number, error: string) {
  expectPrivate(response);
  expect(response.status).toBe(status);
  expect(response.headers.get('content-disposition')).toBeNull();
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error });
  expectNoDisclosure(text);
}
async function historicalSuccess(response: Response, attachment = false) {
  expectPrivate(response);
  expect(response.status).toBe(200);
  const text = await response.text();
  expectNoDisclosure(text);
  const projected = JSON.parse(text);
  expect(projected).toEqual({
    projectionVersion: 1, readOnly: true, scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY',
    eventIntegrity: 'VERIFIED', originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
    currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
    reportId: event.event_id, comparisonInstant: event.redacted_details.comparisonInstant,
    manifestDigest: event.redacted_details.manifestDigest, currentManifestDigest: event.redacted_details.currentManifestDigest,
    sourceFingerprint: event.redacted_details.sourceFingerprint, freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
    report: { reportVersion: 1, phase: 'PREFLIGHT', status: 'MATCHED_PREFLIGHT',
      metrics: event.redacted_details.report.metrics, diagnostics: [], omittedDiagnostics: 0 },
  });
  expect(projected).not.toHaveProperty('migrationStatus');
  expect(text).not.toContain('READY');
  if (attachment) {
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="historical-preflight-${event.event_id.slice('reconciliation:'.length)}.json"`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(text).toBe(`${JSON.stringify(projected)}\n`);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(65_536);
  } else expect(response.headers.get('content-disposition')).toBeNull();
  return projected;
}
async function statusSuccess(response: Response, stored = 'ACTIVE') {
  expectPrivate(response);
  expect(response.status).toBe(200);
  const text = await response.text();
  expectNoDisclosure(text);
  expect(JSON.parse(text)).toEqual({
    availability: 'AVAILABLE', readOnly: true, migrationStatus: stored, authority: 'UNKNOWN',
    reasonCode: 'OPERATIONAL_AUTHORITY_UNVERIFIED',
    reason: '저장된 작업 상태만 표시합니다. 실제 운영 권한은 확인되지 않았습니다.',
  });
}
function expectCleanup(client: ReturnType<typeof makeClient>, discarded = false) {
  expect(client.release.mock.calls).toEqual(discarded ? [[true]] : [[]]);
  expect(client.sequence.at(-1)).toBe(discarded ? 'release:discard' : 'release:reuse');
  expect(client.listenerCount('error')).toBe(0);
  expect(client.end).not.toHaveBeenCalled();
}
function expectDataBinding(surface: Surface, tenantId = TENANT, memberId = MEMBER, slug = 'alpha') {
  expect(dataReads().at(-1)?.values).toEqual([
    tenantId, SUBJECT, JOB, memberId, USER, slug, ...(surface === 'status' ? [] : [event.event_id]),
  ]);
}

beforeAll(() => {
  // Do not clear evidence of any accidental transport call at module import.
  expect(transport.forbidden).not.toHaveBeenCalled();
  expect(transport.database).not.toHaveBeenCalled();
  expect(transport.pool).not.toHaveBeenCalled();
});
afterAll(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  now = NOW; tenant = { ...baseTenant }; member = { ...baseMember }; event = archive();
  clients = []; onPoint = undefined; injectedEnvelope = undefined; failRollback = false;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (const name of ['GOOGLE_CLIENT_SECRET', 'ADMIN_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_REFRESH_TOKEN',
    'GENERATOR_GOOGLE_CLIENT_ID', 'GENERATOR_GOOGLE_CLIENT_SECRET', 'DATABASE_URL', 'DIRECT_DATABASE_URL']) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('AUTH_SECRET', KEY);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  directoryQuery.mockReset().mockImplementation(async (text, values = []) => {
    if (text === TENANT_SQL) return discovery('tenant', values);
    if (text === MEMBER_SQL) return discovery('member', values);
    return transport.forbidden();
  });
  statusConnect.mockReset().mockImplementation(async () => {
    const client = makeClient('status'); clients.push(client); return client;
  });
  transport.archiveConnect.mockReset().mockImplementation(async () => {
    const client = makeClient('archive'); clients.push(client); return client;
  });
  transport.database.mockReset().mockReturnValue({ pool: { query: directoryQuery, connect: statusConnect } });
  transport.config.mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/fixture', directDatabaseUrl: 'must-not-use' });
});
afterEach(() => {
  try {
    expect(transport.forbidden).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(transport.forbidden);
    expect(Object.keys(statusRoute).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    for (const route of [preflightRoute, downloadRoute]) expect(Object.keys(route).sort()).toEqual(['GET', 'HEAD', 'dynamic', 'runtime']);
    for (const route of Object.values(routes)) {
      expect(route.dynamic).toBe('force-dynamic'); expect(route.runtime).toBe('nodejs');
    }
    for (const [config] of transport.pool.mock.calls) expect(config).toEqual({
      connectionString: 'postgresql://synthetic.invalid/fixture', max: 2,
      connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000, allowExitOnIdle: true,
    });
    for (const [text] of directoryQuery.mock.calls) expect([TENANT_SQL, MEMBER_SQL]).toContain(text);
    for (const client of clients) {
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.listenerCount('error')).toBe(0);
      for (const [config] of client.query.mock.calls) {
        expect(config.query_timeout).toBeGreaterThan(0); expect(config.query_timeout).toBeLessThanOrEqual(2000);
        expect(config.text.trimStart()).toMatch(/^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/);
        expect(config.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|COMMIT|MERGE|CALL|COPY|pg_advisory)\b|FOR SHARE|migration_sources|migration_snapshots|canonical_record/i);
      }
    }
    // Real emitted SQL, not a synthetic current reader: every data statement
    // must repeat canonical tenant AND membership within that same SELECT.
    for (const config of dataReads()) {
      const sql = config.text.replace(/\s+/g, ' ');
      for (const predicate of [
        'FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m',
        'JOIN public.platform_find_tenant_by_slug($6) AS t ON t.id = m.tenant_id',
        'j.tenant_id = $1 AND j.job_id = $3', 'm.tenant_id = $1 AND m.google_subject = $2',
        "m.id = $4 AND m.user_id = $5 AND m.role IN ('OWNER','ADMIN')", 't.id = $1 AND t.slug = $6',
      ]) expect(sql).toContain(predicate);
      expect(sql).not.toMatch(/SELECT\s+\*|ORDER BY|FOR UPDATE/i);
      if (sql.includes('public.audit_events')) {
        expect(sql).toContain('e.tenant_id = j.tenant_id AND e.job_id = j.job_id');
        expect(sql).toContain("e.event_id = $7 AND e.event_type = 'MIGRATION_RECONCILIATION_PREFLIGHT'");
        expect(sql).toContain("octet_length(convert_to(envelope_text, 'UTF8')) <= 65536");
        expect(sql).toMatch(/LIMIT 2$/);
      } else expect(sql).toMatch(/LIMIT 1$/);
    }
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe('existing status + historical routes cannot establish current-preflight acceptance', () => {
  it.each(['OWNER', 'ADMIN'])('saved ACTIVE + matched archive + attachment remain non-authoritative for %s', async role => {
    member!.role = role;
    const statusRead = vi.spyOn(statusReader, 'readMigrationStatus');
    const reportRead = vi.spyOn(historicalReader, 'readPreflightReport');
    const downloadRead = vi.spyOn(downloadReader, 'readHistoricalReportDownload');
    const requests = SURFACES.map(surface => request(surface));
    await statusSuccess(await get('status', requests[0]));
    const inline = await historicalSuccess(await get('preflight', requests[1]));
    const attachment = await historicalSuccess(await get('download', requests[2]), true);
    expect(attachment).toEqual(inline);
    expect(statusRead).toHaveBeenCalledExactlyOnceWith('alpha', requests[0], JOB);
    expect(reportRead.mock.calls).toEqual([['alpha', requests[1]], ['alpha', requests[2]]]);
    expect(downloadRead).toHaveBeenCalledExactlyOnceWith('alpha', requests[2]);
    expect(directoryQuery.mock.calls).toEqual([[TENANT_SQL, ['alpha']], [MEMBER_SQL, [TENANT, SUBJECT]]]);
    expect(statusConnect).toHaveBeenCalledTimes(1); expect(transport.archiveConnect).toHaveBeenCalledTimes(2);
    expect(dataReads().map(config => config.values)).toEqual([
      [TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha'],
      ...[1, 2].map(() => [TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]),
    ]);
    expect(clients).toHaveLength(3);
    expect(new Set(clients).size).toBe(3);
    for (const client of clients) {
      expectCleanup(client);
      expect(client.sequence[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      expect(client.sequence.slice(-2)).toEqual(['ROLLBACK', 'release:reuse']);
      expect(client.query.mock.calls.filter(([config]) => config.text.includes("set_config('app.tenant_id'")).map(([config]) => config.values)).toEqual([[TENANT]]);
      if (client.kind === 'archive') expect(client.sequence).toContain('membership');
    }
  });

  it('a newly timestamped/rehashed matching archive still does not verify original binding or live sources', async () => {
    const oldId = event.event_id;
    event = archive(TENANT, 'c'.repeat(64), new Date(NOW).toISOString());
    expect(event.event_id).not.toBe(oldId);
    await statusSuccess(await get('status'));
    await historicalSuccess(await get('preflight'));
    await historicalSuccess(await get('download'), true);
    // No live-source dependency exists on these paths; do not fabricate one or
    // turn the absence of its invocation into a positive current-preflight gate.
  });

  it('no job selection stays BLOCKED/UNKNOWN even after the archive and stored ACTIVE succeeded', async () => {
    await statusSuccess(await get('status'));
    await historicalSuccess(await get('preflight'));
    const connections = clients.length;
    const reads = dataReads().length;
    const response = await get('status', request('status', { query: '' }));
    expectPrivate(response); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      availability: 'BLOCKED', reasonCode: 'TRUSTED_STATUS_READER_UNAVAILABLE',
      reason: '검증된 이전 상태 조회가 연결되지 않아 진행 상태와 운영 권한을 확인할 수 없습니다.',
      readOnly: true, migrationStatus: 'UNKNOWN', authority: 'UNKNOWN',
    });
    expect(clients).toHaveLength(connections); expect(dataReads()).toHaveLength(reads);
    expect(directoryQuery.mock.calls).toHaveLength(4);
  });

  it.each(['preflight', 'download'] as const)('%s needs exact historical selectors, not an implicit latest/current report', async surface => {
    await failure(await get(surface, request(surface, { query: '' })), 400, 'INVALID_PREFLIGHT_REQUEST');
    expect(clients).toHaveLength(0); expect(directoryQuery).not.toHaveBeenCalled();
  });

  it('an old successful inline view cannot authorize a download after membership loss', async () => {
    await statusSuccess(await get('status'));
    await historicalSuccess(await get('preflight'));
    member = null;
    await failure(await get('download'), 403, 'ACCESS_DENIED');
    expect(transport.archiveConnect).toHaveBeenCalledTimes(2);
    expect(dataReads()).toHaveLength(2);
    expect(clients[2].sequence).toContain('membership');
    expect(clients[2].sequence).not.toContain('data');
    expectCleanup(clients[2]);
  });

  it('the same opaque job in another tenant neither exposes ACTIVE nor retrieves the first tenant archive', async () => {
    tenant = { ...baseTenant, id: OTHER, slug: 'beta' };
    member = { ...baseMember, id: REPLACEMENT, tenant_id: OTHER };
    await statusSuccess(await get('status', request('status', { slug: 'beta' }), 'beta'), 'DISCOVERED');
    expectDataBinding('status', OTHER, REPLACEMENT, 'beta');
    for (const surface of ['preflight', 'download'] as const) {
      await failure(await get(surface, request(surface, { slug: 'beta' }), 'beta'), 404, 'PREFLIGHT_REPORT_NOT_FOUND');
      expectDataBinding(surface, OTHER, REPLACEMENT, 'beta');
    }
  });

  it.each(['preflight', 'download'] as const)('%s independently rejects a foreign-tenant envelope even if transport says found', async surface => {
    event = archive(OTHER);
    injectedEnvelope = event; // Deliberately violate the transport's tenant filter.
    await failure(await get(surface), 503, 'PREFLIGHT_REPORT_UNAVAILABLE');
    expectDataBinding(surface); expectCleanup(clients[0]);
  });

  it.each(['preflight', 'download'] as const)('%s HEAD is bodyless, independently authorized and never a cached success', async surface => {
    const route = surface === 'preflight' ? preflightRoute : downloadRoute;
    await historicalSuccess(await get(surface), surface === 'download');
    const head = await route.HEAD(request(surface, { method: 'HEAD' }), context());
    expectPrivate(head); expect(head.status).toBe(200); expect(head.body).toBeNull(); expect(await head.text()).toBe('');
    member = null;
    const denied = await route.HEAD(request(surface, { method: 'HEAD' }), context());
    expectPrivate(denied); expect(denied.status).toBe(403); expect(denied.body).toBeNull();
    expect(denied.headers.get('content-disposition')).toBeNull();
    expect(transport.archiveConnect).toHaveBeenCalledTimes(3); expect(dataReads()).toHaveLength(2);
  });
});

describe.each(SURFACES)('%s real route/reader boundary with synthetic transport', surface => {
  it.each(['tenantId=ignored', 'role=OWNER', 'currentPreflight=VERIFIED', 'cutoverAllowed=true'])('rejects caller query authority hint %s before any lookup', async hint => {
    const req = request(surface);
    const changed = new Request(`${req.url}&${hint}`, { headers: req.headers });
    await failure(await get(surface, changed), 400, surface === 'status' ? 'INVALID_STATUS_REQUEST' : 'INVALID_PREFLIGHT_REQUEST');
    expect(transport.database).not.toHaveBeenCalled(); expect(clients).toHaveLength(0);
  });

  it('refuses direct POST invocation without source/producer/cookie side effects', async () => {
    const response = await get(surface, request(surface, { method: 'POST' }));
    await failure(response, 405, 'METHOD_NOT_ALLOWED');
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(transport.database).not.toHaveBeenCalled(); expect(clients).toHaveLength(0);
  });

  it.each(['expired', 'compatibility-only'] as const)('rejects %s identity before DB admission', async kind => {
    const req = request(surface, { cookie: kind === 'expired'
      ? cookie({ ...SESSION, issuedAt: NOW - MAX_AGE_MS - 1 }) : 'class_store_admin=fake; class_store_tenant_admin=fake' });
    expect(getGoogleSessionFromRequest(req)).toBeNull();
    await failure(await get(surface, req), 401, 'AUTHENTICATION_REQUIRED');
    expect(transport.database).not.toHaveBeenCalled(); expect(clients).toHaveLength(0);
  });

  it.each(['membership id', 'user id', 'subject', 'role', 'tenant id', 'canonical slug'] as const)('final same-statement refusal after admitted %s changes', async change => {
    onPoint = point => {
      if (point !== 'membership') return;
      switch (change) {
        case 'membership id': member!.id = REPLACEMENT; break;
        case 'user id': member!.user_id = REPLACEMENT; break;
        case 'subject': member!.google_subject = 'replacement-subject'; break;
        case 'role': member!.role = 'VIEWER'; break; // Invalid/stale transport seam, not a schema claim.
        case 'tenant id': tenant.id = OTHER; break;
        case 'canonical slug': tenant.slug = 'beta'; break;
      }
    };
    await failure(await get(surface), 403, 'ACCESS_DENIED');
    expectDataBinding(surface); expect(dataReads()).toHaveLength(1);
    expectCleanup(clients[0]);
    expect(clients[0].sequence.slice(-2)).toEqual(['ROLLBACK', 'release:reuse']);
  });

  it.each(['membership', 'data', 'rollback'] as const)('valid control at inclusive session age after awaited %s', async point => {
    const req = request(surface);
    expect(getGoogleSessionFromRequest(req)).toEqual(SESSION);
    onPoint = stage => { if (stage === point) now = NOW + 1; };
    const response = await get(surface, req);
    expect(getGoogleSessionFromRequest(req)).toEqual(SESSION);
    if (surface === 'status') await statusSuccess(response);
    else await historicalSuccess(response, surface === 'download');
    expectDataBinding(surface); expectCleanup(clients[0]);
  });

  it.each(['membership', 'data', 'rollback', 'release'] as const)('suppresses publication when the admitted identity expires during %s', async point => {
    const req = request(surface);
    expect(getGoogleSessionFromRequest(req)).toEqual(SESSION);
    onPoint = stage => { if (stage === point) now = NOW + 2; };
    await failure(await get(surface, req), 401, 'AUTHENTICATION_REQUIRED');
    expect(getGoogleSessionFromRequest(req)).toBeNull();
    if (surface === 'status' && point === 'membership') {
      expect(statusConnect).not.toHaveBeenCalled(); expect(clients).toHaveLength(0);
    } else {
      // Historical queries check identity before ROLLBACK; after membership or
      // data expiry they discard the client instead. Status rolls back first.
      expectCleanup(clients[0], surface !== 'status' && (point === 'membership' || point === 'data'));
      if (point === 'rollback' || point === 'release') expect(clients[0].sequence).toContain('ROLLBACK');
    }
    expect(dataReads()).toHaveLength(point === 'membership' ? 0 : 1);
  });

  it.each(['same identity, changed bytes', 'different subject'] as const)('refuses %s Cookie replacement at cleanup', async change => {
    const req = request(surface);
    onPoint = point => {
      if (point !== 'release') return;
      req.headers.set('cookie', change === 'different subject'
        ? cookie({ ...SESSION, subject: 'replacement-subject' }) : `${cookie()}; unrelated=changed`);
    };
    await failure(await get(surface, req), 401, 'AUTHENTICATION_REQUIRED');
    expect(getGoogleSessionFromRequest(req)?.subject).toBe(change === 'different subject' ? 'replacement-subject' : SUBJECT);
    expectCleanup(clients[0]); expectDataBinding(surface);
  });

  it('failed rollback discards one client without retry, repairing status or publishing an archive', async () => {
    failRollback = true;
    await failure(await get(surface), 503, surface === 'status' ? 'JOB_STATUS_UNAVAILABLE' : 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(clients).toHaveLength(1); expectCleanup(clients[0], true);
    expectDataBinding(surface); expect(dataReads()).toHaveLength(1);
    expect(clients[0].sequence.filter(point => point === 'ROLLBACK')).toHaveLength(1);
  });
});
