// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { PoolConfig, QueryConfig } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), pool: vi.fn(), idleError: vi.fn(), config: vi.fn() }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(), Pool: class {
  constructor(config: unknown) { mocks.pool(config); }
  connect = mocks.connect;
  on = mocks.idleError;
} }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: mocks.config }));
// Use the REAL local Google cookie verifier. Never call a producer, network,
// shared pool, source adapter, deployed DB or another worker's test harness.
import { readPreflightReport } from './readPreflightReport';
import * as projection from './preflightReportProjection';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-subject';
const JOB = 'historical/과거 job:%20';
const SECRET = 'synthetic-reader-test-secret-not-a-real-credential';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
type Config = QueryConfig & { query_timeout: number };
type Reply = { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[] };
const reply = (rows: Record<string, unknown>[], fields: [string, number][]): Reply => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
const directoryRow = { id: TENANT, slug: 'alpha', display_name: 'Synthetic alpha', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const memberRow = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };

// Hand-built archival fixture, NOT a producer invocation. The pure projection's
// own existing suite separately pins canonical encoding to the producer export.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}
function archive(job = JOB) {
  const details = {
    report: { reportVersion: 1, phase: 'PREFLIGHT', status: 'BLOCKED', authority: 'SHEETS_AND_REDIS',
      cutoverAllowed: false, metrics: [], diagnostics: [{ category: 'INTEGRITY', code: 'BINDING_MISMATCH' }], omittedDiagnostics: 0 },
    comparisonInstant: '2026-09-01T12:00:00.000Z', manifestDigest: 'a'.repeat(64),
    currentManifestDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
  };
  return seal({ tenant_id: TENANT, event_id: '', job_id: job, event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT',
    operation_id: null as string | null, actor_user_id: null as string | null,
    entity_type: null as string | null, entity_id: null as string | null, redacted_details: details });
}
function seal<T extends { tenant_id: string; job_id: string; event_id: string; redacted_details: unknown }>(row: T): T {
  row.event_id = `reconciliation:${createHash('sha256').update(canonical([row.tenant_id, row.job_id, row.redacted_details])).digest('hex')}`;
  return row;
}
const event = archive();
function cookie(issuedAt = Date.now(), subject = SUBJECT) {
  const iv = Buffer.alloc(12, 7); // Synthetic, deterministic test fixture only.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
let requestPath = '/api/migrations/status/alpha/preflight';
let requestMethod = 'GET';
function request(options: { cookie?: string; query?: string; path?: string; method?: string; signal?: AbortSignal } = {}) {
  return new Request(`https://example.test${options.path ?? requestPath}?${options.query ?? `jobId=${encodeURIComponent(JOB)}&reportId=${event.event_id}`}`, {
    headers: { cookie: options.cookie ?? cookie(), 'x-tenant-id': OTHER, 'x-role': 'OWNER' },
    method: options.method ?? requestMethod, signal: options.signal,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let configs: Config[];
let reportReply: Reply;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
let hook: ((config: Config) => Promise<Reply | void> | Reply | void) | undefined;
let projectSpy: MockInstance<typeof projection.projectPreflightReport>;

beforeEach(() => {
  requestPath = '/api/migrations/status/alpha/preflight';
  requestMethod = 'GET';
  vi.stubEnv('AUTH_SECRET', SECRET);
  configs = [];
  reportReply = reply([{ found: true, oversized: false, envelope_text: JSON.stringify(event) }], REPORT_FIELDS);
  hook = undefined;
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: Config): Promise<Reply> => {
      configs.push(config);
      const overridden = await hook?.(config);
      if (overridden) return overridden;
      if (config.text.includes('public.audit_events')) return reportReply;
      if (config.text.includes('public.platform_find_membership')) return reply([memberRow], MEMBER_FIELDS);
      if (config.text.includes('public.platform_find_tenant')) return reply([directoryRow], TENANT_FIELDS);
      return reply([], []);
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  mocks.connect.mockReset().mockResolvedValue(client);
  mocks.config.mockReturnValue({ databaseUrl: 'postgresql://synthetic.invalid/fixture', directDatabaseUrl: 'must-not-use' });
  projectSpy = vi.spyOn(projection, 'projectPreflightReport');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network forbidden'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const read = (req = request(), slug: unknown = 'alpha') => readPreflightReport(slug, req);
const reportConfig = () => configs.find(config => config.text.includes('public.audit_events'))!;

describe.each([
  { path: '/api/migrations/status/alpha/preflight', method: 'GET' },
  { path: '/api/migrations/status/alpha/preflight', method: 'HEAD' },
  { path: '/api/migrations/status/alpha/preflight/download', method: 'GET' },
  { path: '/api/migrations/status/alpha/preflight/download', method: 'HEAD' },
])('authenticated bounded historical reader: $method $path (no route)', ({ path, method }) => {
  beforeEach(() => { requestPath = path; requestMethod = method; });
  it('reads an exact archive with real Google auth, canonical authorization and one read-only transaction', async () => {
    const result = await read();
    expect(result).toEqual(projection.projectPreflightReport(event, { tenantId: TENANT, migrationJobId: JOB, reportId: event.event_id }));
    expect(result).toMatchObject({ kind: 'HISTORICAL_REPORT', projection: {
      scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY', originalBinding: 'NOT_VERIFIED',
      currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
    } });
    expect(mocks.pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: 'postgresql://synthetic.invalid/fixture',
      connectionTimeoutMillis: 2000, max: 2 } satisfies Partial<PoolConfig>));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(configs[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(configs.at(-1)?.text).toBe('ROLLBACK');
    expect(configs.filter(config => config.text.startsWith('BEGIN'))).toHaveLength(1);
    expect(configs.find(config => config.text.includes("set_config('app.tenant_id'"))?.values).toEqual([TENANT]);
    expect(reportConfig().values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]);
    expect(configs.every(config => config.query_timeout > 0 && config.query_timeout <= 2000)).toBe(true);
    expect(configs.every(config => /^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/.test(config.text.trimStart()))).toBe(true);
    expect(configs.map(config => config.text).join('\n')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|COMMIT|CREATE|ALTER|GRANT|FOR SHARE|FOR UPDATE|pg_advisory)\b/i);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(client.listenerCount('error')).toBe(0);
  });

  it.each(['', 'class_store_admin=fake; class_store_tenant_admin=fake', 'class_store_google_auth=bad',
    `${cookie(NOW)}; ${cookie(NOW)}`, 'class_store_google_auth=%ZZ', 'class_store_google_auth'])('rejects invalid/ambiguous Google cookies before DB (%s)', async value => {
    expect(await read(request({ cookie: value }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([-MAX_AGE - 1, 1])('uses actual verifier expiration/future validation (%s)', async delta => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    expect(await read(request({ cookie: cookie(NOW + delta) }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('rejects a tampered authenticated token', async () => {
    expect(await read(request({ cookie: cookie().replace('v2.', 'v3.') }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['', 'jobId=x', `jobId=&reportId=${event.event_id}`, `jobId=x&reportId=${'a'.repeat(64)}`,
    `jobId=x&reportId=${event.event_id.toUpperCase()}`, `jobId=%ZZ&reportId=${event.event_id}`,
    `jobId=%C0%AF&reportId=${event.event_id}`, `jobId=%ED%A0%80&reportId=${event.event_id}`,
    `jobId=%20x&reportId=${event.event_id}`, `jobId=x%00&reportId=${event.event_id}`,
    `jobId=${'x'.repeat(1025)}&reportId=${event.event_id}`, `jobId=x&reportId=${event.event_id}&tenantId=${OTHER}`,
    `jobId=x&jobId=y&reportId=${event.event_id}`, `jobId=x&reportId=${event.event_id}&reportId=${event.event_id}`,
    `job%49d=x&reportId=${event.event_id}`, `jobId=x&report%49d=${event.event_id}`,
    `jobId=x&reportId=${event.event_id}&download=1`, `jobId=x&reportId=${event.event_id}%00`,
    `jobId=x&reportId=${event.event_id}&`,
  ])('rejects malformed/literal selector violations before lookup (%s)', async query => {
    expect(await read(request({ query }))).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['/api/migrations/status/%61lpha/preflight', '/api/migrations/status/alpha/preflight/',
    '/api/migrations/status/beta/preflight', '/api/migrations/status/alpha%2F/preflight',
    '/api/migrations/status/Alpha/preflight/download', '/api/migrations/status/beta/preflight/download',
    '/api/migrations/status/%61lpha/preflight/download', '/api/migrations/status/alpha%2F/preflight/download',
    '/api/migrations/status/alpha/preflight/download/', '/api/migrations/status/alpha/preflight/download/extra',
    '/api/migrations/status/alpha/preflight/%64ownload', '/api/migrations/status/alpha/preflight/download%2F',
    '/api/migrations/status/alpha/preflight/download.json', '/api/migrations/status/alpha/preflightdownload',
  ])('refuses path aliases (%s)', async path => {
    expect(await read(request({ path }))).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['Alpha', ' alpha', '', null])('refuses noncanonical slugs without repairing them (%s)', async slug => {
    expect(await read(request(), slug)).toEqual({ kind: 'FORBIDDEN' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('bounds URL and Cookie bytes before application parsing, with no body reads', async () => {
    for (const req of [request({ cookie: 'a'.repeat(32769) }), request({ query: 'q=' + 'x'.repeat(16385) }),
      request({ cookie: 'a=' + '\u00e9'.repeat(17000) }), request({ method: 'POST' })]) {
      expect(await read(req)).toEqual({ kind: 'INVALID_REQUEST' });
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('does not double-decode an opaque job ID and supports HEAD without adding a handler', async () => {
    await read(request({ method: 'HEAD' }));
    expect(reportConfig().values?.[2]).toBe(JOB);
  });
  it.each(['tenant', 'member', 'final'])('denies missing or revoked authorization at %s', async stage => {
    hook = config => {
      if (stage === 'tenant' && config.text.includes('public.platform_find_tenant') && !config.text.includes('public.audit_events')) return reply([], TENANT_FIELDS);
      if (stage === 'member' && config.text.includes('public.platform_find_membership') && !config.text.includes('public.audit_events')) return reply([], MEMBER_FIELDS);
      if (stage === 'final' && config.text.includes('public.audit_events')) return reply([], REPORT_FIELDS);
    };
    expect(await read()).toEqual({ kind: 'FORBIDDEN' });
    expect(projectSpy).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it.each([{ tenant_id: OTHER }, { google_subject: 'other' }, { role: 'VIEWER' }, { id: 'not-a-uuid' }])('denies invalid admitted membership %j', async mutation => {
    hook = config => config.text.includes('public.platform_find_membership') ? reply([{ ...memberRow, ...mutation }], MEMBER_FIELDS) : undefined;
    expect(await read()).toEqual({ kind: 'FORBIDDEN' });
    expect(reportConfig()).toBeUndefined();
  });
  it.each([{ id: OTHER, slug: 'beta' }, { id: 'bad' }, { timezone: 'UTC' }, { lifecycle: 'ALIEN' }, { display_name: 'x'.repeat(1025) }])('denies invalid canonical directory %j', async mutation => {
    hook = config => config.text.includes('public.platform_find_tenant') ? reply([{ ...directoryRow, ...mutation }], TENANT_FIELDS) : undefined;
    expect(await read()).toEqual({ kind: 'FORBIDDEN' });
    expect(reportConfig()).toBeUndefined();
  });
  it('returns uniform absence without inferring foreign existence', async () => {
    reportReply = reply([{ found: false, oversized: false, envelope_text: null }], REPORT_FIELDS);
    expect(await read()).toEqual({ kind: 'NOT_FOUND' });
    expect(projectSpy).not.toHaveBeenCalled();
  });
  it('allows current ADMIN but never promotes a recomputed MATCHED archive to provenance/live authority', async () => {
    // Independently constructed, self-consistent archive; no producer/source.
    const matched = seal({ ...event, redacted_details: { ...event.redacted_details,
      report: { ...event.redacted_details.report, status: 'MATCHED_PREFLIGHT', diagnostics: [], metrics: [
        'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS', 'COMPLETIONS',
        'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK', 'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA',
        'CANCELLATIONS', 'CANCELLATION_AMOUNT', 'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS',
        'TOMBSTONES', 'ORPHANED_CLAIMS', 'RECURRENCE',
      ].map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })) },
    } });
    reportReply = reply([{ found: true, oversized: false, envelope_text: JSON.stringify(matched) }], REPORT_FIELDS);
    hook = config => config.text.includes('public.platform_find_membership') && !config.text.includes('public.audit_events')
      ? reply([{ ...memberRow, role: 'ADMIN' }], MEMBER_FIELDS) : undefined;
    const result = await read(request({ query: `jobId=${encodeURIComponent(JOB)}&reportId=${matched.event_id}` }));
    expect(result).toMatchObject({ kind: 'HISTORICAL_REPORT', projection: {
      scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY', eventIntegrity: 'VERIFIED',
      originalBinding: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED',
      operationalAuthority: 'UNKNOWN', cutoverAllowed: false, report: { status: 'MATCHED_PREFLIGHT' },
    } });
    expect(JSON.stringify(result)).not.toContain('SHEETS_AND_REDIS');
  });
  it.each([
    { found: true, oversized: true, envelope_text: null },
    { found: false, oversized: true, envelope_text: null },
    { found: false, oversized: false, envelope_text: '{}' },
    { found: true, oversized: false, envelope_text: null },
    { found: true, oversized: false, envelope_text: {} },
    { found: 'true', oversized: false, envelope_text: '{}' },
    { found: true, oversized: false, envelope_text: '{bad' },
    { found: true, oversized: false, envelope_text: '{}', extra: 'private' },
  ])('sanitizes invalid flags/envelopes %j', async row => {
    reportReply = reply([row], REPORT_FIELDS);
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each(['x'.repeat(65537), '\uac00'.repeat(22000)])('refuses oversized driver TEXT before parse/projection', async text => {
    reportReply = reply([{ found: true, oversized: false, envelope_text: text }], REPORT_FIELDS);
    const parse = vi.spyOn(JSON, 'parse');
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(parse.mock.calls.some(([value]) => value === text)).toBe(false);
    expect(projectSpy).not.toHaveBeenCalled();
  });
  it('rejects extra rows and JSONB field metadata', async () => {
    reportReply.rows.push(reportReply.rows[0]);
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    reportReply.rows.pop();
    reportReply.fields[2].dataTypeID = 3802;
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(projectSpy).not.toHaveBeenCalled();
  });
  it('enforces full TEXT SQL gate, same-statement reauthorization and an OID parser allowlist', async () => {
    await read();
    const sql = reportConfig().text;
    expect(sql).toContain("octet_length(convert_to(envelope_text, 'UTF8'))");
    expect(sql).toContain('65536');
    expect(sql).toContain('ELSE NULL::text');
    expect(sql).toContain('LIMIT 2');
    expect(sql).not.toMatch(/SELECT\s+\*|pg_column_size|occurred_at|ORDER BY/i);
    for (const field of ['tenant_id', 'event_id', 'job_id', 'event_type', 'operation_id', 'actor_user_id', 'entity_type', 'entity_id', 'redacted_details']) {
      expect(sql).toContain(`'${field}', e.${field}`);
    }
    for (const predicate of ['m.id = $4', 'm.user_id = $5', 'm.google_subject = $2', 't.slug = $6', 'e.event_id = $7']) expect(sql).toContain(predicate);
    // pg invokes parsers from event callbacks, NOT a promise try/catch. An
    // unexpected OID must stay inert text, not throw an uncaught exception or
    // invoke JSON.parse. Result metadata then rejects it before projection.
    const parse = vi.spyOn(JSON, 'parse');
    expect(reportConfig().types!.getTypeParser(3802, 'text')('{}')).toBe('{}');
    expect(parse).not.toHaveBeenCalled();
    expect(reportConfig().types!.getTypeParser(25, 'text')('opaque')).toBe('opaque');
  });
});

describe('deadline, identity lifetime, cancellation and cleanup', () => {
  it('uses pg-pool native queue expiry without late acquisition or a socket', async () => {
    // Actual installed pg-pool, but a synthetic Client: this tests removal of
    // queued waiters, NOT pg TCP/TLS cancellation or real connection failures.
    vi.useFakeTimers();
    const { Pool } = await vi.importActual<typeof import('pg')>('pg');
    let connections = 0;
    class SocketlessClient extends EventEmitter {
      _queryable = true;
      _ending = false;
      connect(callback: () => void) { connections++; callback(); }
      end(callback?: () => void) { this.emit('end'); callback?.(); }
    }
    const pool = new Pool({ max: 2, connectionTimeoutMillis: 2000,
      Client: SocketlessClient as unknown as NonNullable<PoolConfig['Client']> });
    const a = await pool.connect(); const b = await pool.connect();
    const queued = pool.connect().then(() => 'unexpected', () => 'expired');
    expect(pool.waitingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await queued).toBe('expired');
    expect(pool.waitingCount).toBe(0);
    a.release(true); b.release(true);
    await pool.end();
    expect(connections).toBe(2);
    expect(pool.totalCount).toBe(0);
  });
  it.each(['BEGIN', 'SET LOCAL statement_timeout', 'SET LOCAL lock_timeout', 'SET LOCAL idle_in_transaction_session_timeout',
    'public.platform_find_tenant', 'public.platform_find_membership', "set_config('app.tenant_id'", 'public.audit_events', 'ROLLBACK'])('fails closed without retry on a failed %s', async marker => {
    hook = config => { if (config.text.includes(marker)) throw new Error('private connection string'); };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(configs.filter(config => config.text.includes(marker))).toHaveLength(1);
  });
  it('bounds acquisition and destroys a late client without any query', async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof client>(); mocks.connect.mockReturnValue(pending.promise);
    const result = read();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    pending.resolve(client); await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query).not.toHaveBeenCalled();
  });
  it.each(['public.platform_find_tenant', 'public.platform_find_membership', 'public.audit_events', 'ROLLBACK'])('destroys a stalled %s with no late continuation', async marker => {
    vi.useFakeTimers();
    const pending = deferred<Reply>();
    hook = config => config.text.includes(marker) ? pending.promise : undefined;
    const result = read(); await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    const count = configs.length;
    pending.resolve(reply([], [])); await vi.advanceTimersByTimeAsync(0);
    expect(configs).toHaveLength(count);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('caps aggregate latency, not just each stage', async () => {
    vi.useFakeTimers();
    hook = () => new Promise(resolve => setTimeout(() => resolve(undefined), 900));
    const result = read(); await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    expect(reportConfig()).toBeUndefined();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    await vi.runAllTimersAsync();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
  it('revalidates actual Google expiry after awaited work, including rollback', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const req = request({ cookie: cookie(NOW - MAX_AGE + 10) });
    hook = config => { if (config.text === 'ROLLBACK') vi.setSystemTime(NOW + 11); };
    expect(await read(req)).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it('cancels in-flight discovery and ignores its late rejection', async () => {
    const abort = new AbortController(); const pending = deferred<Reply>();
    hook = config => {
      if (config.text.includes('public.platform_find_tenant')) { abort.abort(); return pending.promise; }
    };
    expect(await read(request({ signal: abort.signal }))).toEqual({ kind: 'UNAVAILABLE' });
    pending.reject(new Error('late private rejection'));
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(reportConfig()).toBeUndefined();
  });
  it('rejects pre-aborted requests before acquisition', async () => {
    const abort = new AbortController(); abort.abort();
    expect(await read(request({ signal: abort.signal }))).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses a changed Google identity after discovery', async () => {
    const req = request();
    hook = config => {
      if (config.text.includes('public.platform_find_tenant')) req.headers.set('cookie', cookie(Date.now(), 'different-subject'));
    };
    expect(await read(req)).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(reportConfig()).toBeUndefined();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('does not publish after cancellation during cleanup', async () => {
    const abort = new AbortController();
    client.release.mockImplementation(() => { abort.abort(); });
    expect(await read(request({ signal: abort.signal }))).toEqual({ kind: 'UNAVAILABLE' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it('handles connect rejection and synchronous throws without retries', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('private')).mockImplementationOnce(() => { throw new Error('private'); });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(client.release).not.toHaveBeenCalled();
  });
  it('does not publish on release failure or double release the client', async () => {
    client.release.mockImplementation(() => { throw new Error('private release failure'); });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
  it('destroys a client on an asynchronous connection error', async () => {
    hook = config => { if (config.text.includes('public.platform_find_tenant')) client.emit('error', new Error('private')); };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(reportConfig()).toBeUndefined();
  });
});

describe('in-memory PostgreSQL SQL boundary (NOT a real pg wire/pool test)', () => {
  let database: PGlite;
  let sqlReport: Reply | undefined;
  let fixtures: Record<string, unknown>[];
  const id = (digit: string) => `reconciliation:${digit.repeat(64)}`;
  const owner = async <T>(work: () => Promise<T>) => {
    await database.exec('RESET ROLE');
    try { return await work(); }
    finally { await database.exec('SET ROLE historical_reader'); }
  };
  const insert = async (row: Record<string, unknown>) => database.query(`INSERT INTO audit_events
    (tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [row.tenant_id, row.event_id, row.job_id, row.event_type,
    row.operation_id, row.actor_user_id, row.entity_type, row.entity_id, JSON.stringify(row.redacted_details)]);
  const exactRequest = (reportId = event.event_id, jobId = JOB, slug = 'alpha') => request({
    path: `/api/migrations/status/${slug}/preflight`, query: `jobId=${encodeURIComponent(jobId)}&reportId=${reportId}`,
  });
  const snapshot = () => owner(async () => {
    const result: Record<string, unknown> = {};
    // Fixed test-only tables; hashing avoids pulling huge fixture rows to JS.
    for (const table of ['tenants', 'users', 'tenant_memberships', 'migration_jobs', 'audit_events']) {
      result[table] = (await database.query(`SELECT count(*) AS count,
        md5(string_agg(row_to_json(t)::text, ',' ORDER BY row_to_json(t)::text)) AS digest FROM ${table} AS t`)).rows;
    }
    return result;
  });
  beforeAll(async () => {
    database = new PGlite({ extensions: { pgcrypto } });
    for (const name of ['0001_identity_tenants.sql', '0002_operational.sql', '0003_operations_migrations.sql', '0012_platform_tenant_discovery.sql']) {
      await database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
    }
    await database.query(`INSERT INTO tenants (id,slug,display_name,lifecycle) VALUES
      ($1,'alpha','Synthetic alpha','ACTIVE'),($2,'beta','Synthetic beta','ACTIVE')`, [TENANT, OTHER]);
    await database.query('INSERT INTO users (id,google_subject,canonical_email) VALUES ($1,$2,$3)', [USER, SUBJECT, 'synthetic@example.test']);
    await database.query("INSERT INTO tenant_memberships (tenant_id,id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [TENANT, MEMBER, USER]);
    await database.query(`INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES
      ($1,$3,'DISCOVERED'),($2,$3,'DISCOVERED'),($1,'different-job','DISCOVERED')`, [TENANT, OTHER, JOB]);
    fixtures = [event, { ...event, tenant_id: OTHER },
      { ...event, event_id: id('1'), redacted_details: { padding: 'x'.repeat(2 * 1024 * 1024) } },
      { ...event, event_id: id('2'), entity_type: 'x'.repeat(2 * 1024 * 1024), entity_id: 'synthetic' },
      { ...event, event_id: id('3'), entity_type: '가'.repeat(22000), entity_id: 'synthetic' },
      { ...event, event_id: id('4'), entity_type: '\\'.repeat(32768), entity_id: 'synthetic' },
      { ...event, event_id: id('5'), event_type: 'MIGRATION_LOCAL_RECONCILIATION' },
      { ...event, event_id: id('6'), job_id: 'different-job' },
    ];
    for (const [digit, target] of [['7', 65536], ['8', 65537]] as const) {
      const row = { ...event, event_id: id(digit), entity_type: 'x', entity_id: 'synthetic' };
      const bytes = (await database.query<{ bytes: number }>(
        "SELECT octet_length(convert_to($1::jsonb::text,'UTF8')) AS bytes", [JSON.stringify(row)],
      )).rows[0].bytes;
      row.entity_type = 'x'.repeat(target - bytes + 1);
      fixtures.push(row);
    }
    for (const row of fixtures) await insert(row);
    // Test-only, in-memory fixture role. No real role/grant/service is touched.
    await database.exec(`CREATE ROLE historical_reader NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO historical_reader;
      GRANT SELECT ON migration_jobs,audit_events TO historical_reader;
      GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO historical_reader;
      GRANT EXECUTE ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO historical_reader;`);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    sqlReport = undefined;
    await database.exec('SET ROLE historical_reader');
    hook = async config => {
      if (config.text.includes('public.audit_events')) {
        expect((await database.query<{ read_only: string }>("SELECT current_setting('transaction_read_only') AS read_only")).rows[0].read_only).toBe('on');
        expect((await database.query<{ tenant: string }>("SELECT current_setting('app.tenant_id') AS tenant")).rows[0].tenant).toBe(TENANT);
      }
      const data = await database.query<Record<string, unknown>>(config.text, config.values);
      if (config.text.includes('public.audit_events')) sqlReport = data;
      return data;
    };
  });
  afterEach(async () => { await database.exec('ROLLBACK; RESET ROLE'); });

  it('executes the actual bounded SQL under FORCE RLS; exact rows/OIDs and all persisted rows remain unchanged', async () => {
    const before = await snapshot();
    expect((await database.query('SELECT event_id FROM audit_events')).rows).toEqual([]);
    expect((await database.query('SELECT status FROM migration_jobs')).rows).toEqual([]);
    const role = (await database.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const result = await read();
    expect(result).toMatchObject({ kind: 'HISTORICAL_REPORT', projection: { verification: 'INTEGRITY_ONLY', cutoverAllowed: false } });
    expect(sqlReport?.fields).toEqual(REPORT_FIELDS.map(([name, dataTypeID]) => ({ name, dataTypeID })));
    expect(JSON.parse(sqlReport!.rows[0].envelope_text as string)).toEqual(event);
    expect((await database.query("SELECT nullif(current_setting('app.tenant_id',true),'') AS tenant")).rows).toEqual([{ tenant: null }]);
    expect((await database.query('SELECT event_id FROM audit_events')).rows).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    for (const sql of ["UPDATE migration_jobs SET status='FAILED'", 'DELETE FROM audit_events',
      "INSERT INTO audit_events (tenant_id,event_id,event_type) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','forbidden','forbidden')"]) {
      await expect(database.exec(sql)).rejects.toThrow(/permission denied/);
    }
  });
  it.each(['1', '2', '3', '4', '8'])('gates huge/compressible JSON, metadata, UTF-8 and escaped envelope bytes in SQL (%s)', async digit => {
    const before = await snapshot();
    expect(await read(exactRequest(id(digit)))).toEqual({ kind: 'UNAVAILABLE' });
    expect(sqlReport?.rows).toEqual([{ found: true, oversized: true, envelope_text: null }]);
    expect(projectSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
  it.each([['redacted_details', '1'], ['entity_type', '2']])('proves compressed %s length would admit an oversized value', async (column, digit) => {
    const lengths = await owner(async () => (await database.query<{ compressed: number; expanded: number }>(
      `SELECT pg_column_size(${column}) AS compressed, octet_length(convert_to(${column}::text,'UTF8')) AS expanded FROM audit_events WHERE tenant_id=$1 AND event_id=$2`, [TENANT, id(digit)],
    )).rows[0]);
    expect(lengths.compressed).toBeLessThan(65536);
    expect(lengths.expanded).toBeGreaterThan(65536);
    expect(await read(exactRequest(id(digit)))).toEqual({ kind: 'UNAVAILABLE' });
    expect(sqlReport?.rows[0].envelope_text).toBeNull();
  });
  it('allows exactly 65536 serialized bytes as TEXT, then still rejects invalid archival metadata', async () => {
    expect(await read(exactRequest(id('7')))).toEqual({ kind: 'UNAVAILABLE' });
    expect(sqlReport?.rows[0]).toMatchObject({ found: true, oversized: false });
    expect(Buffer.byteLength(sqlReport!.rows[0].envelope_text as string, 'utf8')).toBe(65536);
    expect(projectSpy).toHaveBeenCalledOnce();
  });
  it('isolates exact tenant/job/report and event type without latest/fallback lookups', async () => {
    for (const req of [exactRequest(id('0')), exactRequest(id('5')), exactRequest(id('6')),
      exactRequest(event.event_id, 'different-job')]) {
      expect(await read(req)).toEqual({ kind: 'NOT_FOUND' });
      expect(sqlReport?.rows).toEqual([{ found: false, oversized: false, envelope_text: null }]);
    }
    expect(await read(exactRequest(event.event_id, JOB, 'beta'), 'beta')).toEqual({ kind: 'FORBIDDEN' });
    expect(projectSpy).not.toHaveBeenCalled();
  });
  it('bounds actual discovery metadata before returning it, instead of copying SELECT *', async () => {
    await owner(() => database.query('UPDATE tenants SET display_name=$1 WHERE id=$2', ['가'.repeat(1024), TENANT]));
    try {
      expect(await read()).toEqual({ kind: 'FORBIDDEN' });
      expect(reportConfig()).toBeUndefined();
      const discovery = configs.find(config => config.text.includes('public.platform_find_tenant'))!;
      expect((await database.query(discovery.text, discovery.values)).rows).toMatchObject([{ display_name: null }]);
    } finally { await owner(() => database.query("UPDATE tenants SET display_name='Synthetic alpha' WHERE id=$1", [TENANT])); }
  });
  it('the final SQL rejects a revoked/rebound membership even with the old admitted parameters', async () => {
    expect(await read()).toMatchObject({ kind: 'HISTORICAL_REPORT' });
    const final = reportConfig();
    // PGlite is single-session: test-owner revokes BETWEEN transactions. This
    // tests the actual final statement with stale admission values, NOT a
    // claimed multi-connection revocation race or stronger-than-snapshot lease.
    await owner(() => database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND id=$2', [TENANT, MEMBER]));
    try {
      expect(await read()).toEqual({ kind: 'FORBIDDEN' });
      await database.exec('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await database.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      expect((await database.query(final.text, final.values)).rows).toEqual([]);
      await database.exec('ROLLBACK');
      await owner(() => database.query("INSERT INTO tenant_memberships (tenant_id,id,user_id,role) VALUES ($1,$2,$3,'ADMIN')", [TENANT, OTHER, USER]));
      await database.exec('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      await database.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      expect((await database.query(final.text, final.values)).rows).toEqual([]);
      await database.exec('ROLLBACK');
    } finally {
      await database.exec('ROLLBACK');
      await owner(async () => {
        await database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1', [TENANT]);
        await database.query("INSERT INTO tenant_memberships (tenant_id,id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [TENANT, MEMBER, USER]);
      });
    }
  });
});
