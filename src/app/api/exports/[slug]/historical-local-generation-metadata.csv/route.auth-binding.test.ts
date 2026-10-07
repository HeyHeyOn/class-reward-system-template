// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import type { QueryConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as route from './route';
import * as adapter from '@/server/exports/readHistoricalLocalGenerationCsvDownload';
import * as reader from '@/server/exports/readPersistedLocalGeneration';
import * as authorization from '@/server/tenantAuth';
import * as formatter from '@/server/exports/historicalLocalGenerationCsv';

// Actual GET/explicit HEAD -> adapter -> real cookie verifier/tenant authorization
// -> real persisted reader -> real formatter. Application spies ONLY call through.
// Only PG Pool/client I/O supplies synthetic replies; pg scalar parsers stay real.
// SQL is NOT executed. Final-row fixtures are NOT a second authorization engine.
// No Next HTTP listener/proxy, real PG/RLS/grants, Sheets/Redis, full export,
// continuous exclusion, retained backup, cutover or Task21 acceptance proof.
// Installed Next docs read before authoring:
// next/dist/docs/01-app/01-getting-started/15-route-handlers.md
// next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md
// Promised params + explicit HEAD are used; automatic OPTIONS/405 is out of scope.
vi.mock('server-only', () => ({})); // Node test harness marker, not an auth seam.
const io = vi.hoisted(() => ({
  connect: vi.fn(), pool: vi.fn(), on: vi.fn(),
  denied: vi.fn((): never => { throw new Error('External I/O forbidden in route auth fixture'); }),
}));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  return { ...actual, Pool: class {
    constructor(options: unknown) { io.pool(options); }
    connect = io.connect;
    on = io.on;
  } };
});
// Block SDK I/O, never synthesize a Google identity/Sheets response.
vi.mock('googleapis', () => ({ google: {
  auth: { OAuth2: io.denied, GoogleAuth: io.denied, JWT: io.denied },
  oauth2: io.denied, sheets: io.denied, drive: io.denied,
} }));

const METHODS = ['GET', 'HEAD'] as const;
type Method = typeof METHODS[number];
type Row = Record<string, unknown>;
type Fields = readonly (readonly [string, number])[];
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-route-auth-binding-subject';
const SECRET = 'public-synthetic-route-auth-binding-key-not-a-credential';
const DATABASE = 'postgresql://synthetic.invalid/route-auth-binding';
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const JOB = 'historical/작업:%20';
const GENERATION = `preparation:candidate:${'a'.repeat(64)}`;
const PATH = '/api/exports/alpha/historical-local-generation-metadata.csv';
const QUERY = `?jobId=${encodeURIComponent(JOB)}&generationId=${encodeURIComponent(GENERATION)}`;
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
  vary: 'Cookie', 'x-content-type-options': 'nosniff',
};
const ERRORS = { 400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
  404: 'NOT_FOUND', 503: 'UNAVAILABLE' } as const;
const SECURITY_FIELDS: Fields = [['runtime_safe', 16]];
const TENANT_FIELDS: Fields = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: Fields = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const GENERATION_FIELDS: Fields = [
  ['found', 16], ['binding_valid', 16], ['tenant_id', 2950], ['job_id', 25], ['generation_id', 25],
  ['original_source_id', 25], ['original_snapshot_id', 25], ['candidate_event_id', 25], ['plan_event_id', 25],
  ['candidate_manifest_digest', 25], ['candidate_sheet_digest', 25], ['recorded_state_version', 25],
  ['phase', 25], ['exclusion', 25], ['original_snapshot_phase', 25],
];
const DIRECTORY = { id: TENANT, slug: 'alpha', display_name: 'Synthetic',
  lifecycle: 'MIGRATION_READ_ONLY', timezone: 'Asia/Seoul' };
const EXPECTED_DTO = {
  kind: 'HISTORICAL_LOCAL_GENERATION', authority: 'NONAUTHORITY', readOnly: true,
  scope: 'HISTORICAL_ONLY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
  originalSnapshotPhase: 'PREFLIGHT', verification: 'PERSISTED_BINDING_ONLY',
  payloadIntegrity: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED',
  operationalAuthority: 'UNKNOWN', cutoverAllowed: false, activationAllowed: false,
  jobId: JOB, generationId: GENERATION, originalSourceId: 'source:synthetic',
  originalSnapshotId: 'snapshot:synthetic', candidateManifestDigest: 'c'.repeat(64),
  candidateSheetDigest: 'd'.repeat(64), recordedStateVersion: '7',
} satisfies Extract<reader.PersistedLocalGenerationReadResult, { kind: 'HISTORICAL_LOCAL_GENERATION' }>;
// Independent expected bytes for these fixed cells (no cell contains comma/quote).
// Never returned by an application mock; the production formatter must emit them.
const DISPLAY = { schemaVersion: 'historical-local-generation-metadata-display/v1',
  purpose: 'DISPLAY_ONLY', ...EXPECTED_DTO };
const EXPECTED_CSV = Object.keys(DISPLAY).map(key => `"${key}"`).join(',') + '\r\n'
  + Object.values(DISPLAY).map(value => `"'${value}"`).join(',') + '\r\n';

function cookie() {
  const iv = Buffer.alloc(12, 27); // Fixed IV exclusively for this public synthetic fixture.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject: SUBJECT,
    email: 'synthetic@example.invalid', issuedAt: NOW })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function request(method: Method, auth = cookie(), path = PATH) {
  return new Request(`https://example.invalid${path}${QUERY}`, { method, headers: {
    cookie: auth, 'x-tenant-id': OTHER, 'x-role': 'OWNER', 'x-google-subject': 'spoofed-subject',
  } });
}
function invoke(method: Method, req = request(method), slug = 'alpha') {
  return route[method](req, { params: Promise.resolve({ slug }) });
}
function reply(rows: Row[], fields: Fields) {
  return { rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) };
}
const isFinal = (q: QueryConfig) => q.text.includes('public.migration_final_generations');
const isMember = (q: QueryConfig) => !isFinal(q) && q.text.includes('public.platform_find_membership');
const isTenant = (q: QueryConfig) => !isFinal(q) && q.text.includes('public.platform_find_tenant');
const CONTROL_SQL = [
  'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', "SET LOCAL statement_timeout = '1500ms'",
  "SET LOCAL lock_timeout = '500ms'", "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
  "SELECT set_config('app.tenant_id', $1, true)", 'ROLLBACK',
];
let memberRows: Row[];
let finalRows: Row[];
let runtimeSafe: boolean;
let configs: QueryConfig[];
let unexpectedSql: string[];
function makeClient() {
  return Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: QueryConfig) => {
      configs.push(config);
      if (CONTROL_SQL.includes(config.text)) return reply([], []);
      if (config.text.includes('pg_catalog.pg_roles')) return reply([{ runtime_safe: runtimeSafe }], SECURITY_FIELDS);
      // Scripted wire fixtures only: no copied auth predicate or SQL evaluator.
      if (isFinal(config)) return reply(finalRows, GENERATION_FIELDS);
      if (isMember(config)) return reply(memberRows, MEMBER_FIELDS);
      if (isTenant(config)) return reply([{ ...DIRECTORY }], TENANT_FIELDS);
      unexpectedSql.push(config.text); // Also asserted OUTSIDE production's sanitized catch.
      throw new Error('Unexpected SQL in bounded synthetic fixture');
    }),
    release: vi.fn<(destroy?: boolean) => void>(), end: vi.fn(async () => {}),
  });
}
let clients: ReturnType<typeof makeClient>[];
let download: MockInstance<typeof adapter.readHistoricalLocalGenerationCsvDownload>;
let read: MockInstance<typeof reader.readPersistedLocalGeneration>;
let authorize: MockInstance<typeof authorization.authorizeTenantAdmin>;
let serialize: MockInstance<typeof formatter.buildHistoricalLocalGenerationCsv>;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('DATABASE_URL', DATABASE);
  vi.stubEnv('DIRECT_DATABASE_URL', 'must-not-use');
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
  vi.stubEnv('MIGRATION_READ_ONLY', 'true'); // Synthetic mode only, not writer exclusion.
  for (const key of ['ADMIN_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_SHEET_ID', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_URL']) vi.stubEnv(key, '');
  io.denied.mockClear();
  vi.stubGlobal('fetch', io.denied); // Includes Redis REST/Sheets HTTP; no fallback response.
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(io.denied); // No TCP/TLS fallback.
  download = vi.spyOn(adapter, 'readHistoricalLocalGenerationCsvDownload');
  read = vi.spyOn(reader, 'readPersistedLocalGeneration');
  authorize = vi.spyOn(authorization, 'authorizeTenantAdmin');
  serialize = vi.spyOn(formatter, 'buildHistoricalLocalGenerationCsv');
  memberRows = [{ id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' }];
  finalRows = [{ found: true, binding_valid: true, tenant_id: TENANT, job_id: JOB, generation_id: GENERATION,
    original_source_id: 'source:synthetic', original_snapshot_id: 'snapshot:synthetic', candidate_event_id: GENERATION,
    plan_event_id: `preparation:plan:${'b'.repeat(64)}`, candidate_manifest_digest: 'c'.repeat(64),
    candidate_sheet_digest: 'd'.repeat(64), recorded_state_version: '7', phase: 'LOCAL_CANDIDATE',
    exclusion: 'NOT_PROVEN', original_snapshot_phase: 'PREFLIGHT' }];
  runtimeSafe = true; configs = []; unexpectedSql = []; clients = [];
  io.connect.mockReset().mockImplementation(async () => {
    const client = makeClient(); clients.push(client); return client;
  });
});
afterEach(() => {
  try {
    expect(io.denied).not.toHaveBeenCalled();
    expect(unexpectedSql).toEqual([]);
    for (const client of clients) expect(client.listenerCount('error')).toBe(0);
    for (const [options] of io.pool.mock.calls) expect(options).toEqual({ connectionString: DATABASE,
      max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
function noLeaks(text: string) {
  for (const value of [TENANT, OTHER, MEMBER, USER, SUBJECT, SECRET, DATABASE, cookie(),
    'synthetic@example.invalid', 'spoofed-subject', 'must-not-use', 'SELECT ']) expect(text).not.toContain(value);
}
async function refused(response: Response, method: Method, status: keyof typeof ERRORS) {
  expect(response.status).toBe(status);
  expect(Object.fromEntries(response.headers)).toEqual({ ...PRIVATE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  if (method === 'HEAD') expect(response.body).toBeNull();
  const text = await response.text();
  expect(text).toBe(method === 'HEAD' ? '' : `HISTORICAL_LOCAL_GENERATION_${ERRORS[status]}\n`);
  noLeaks(text + JSON.stringify([...response.headers]));
}
async function success(response: Response, method: Method) {
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toEqual({ ...PRIVATE_HEADERS,
    'content-type': 'text/csv; charset=utf-8; header=present',
    'content-disposition': 'attachment; filename="historical-local-generation-metadata.csv"',
    'content-length': String(Buffer.byteLength(EXPECTED_CSV, 'utf8')) });
  if (method === 'HEAD') expect(response.body).toBeNull();
  const text = await response.text();
  expect(text).toBe(method === 'HEAD' ? '' : EXPECTED_CSV);
  noLeaks(text + JSON.stringify([...response.headers]));
}
function boundFinalCalls(count: number) {
  const finals = configs.filter(isFinal);
  expect(finals).toHaveLength(count);
  for (const q of finals) {
    expect(q.values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', GENERATION]);
    // Text/argument regression assertions, NOT executed SQL/RLS proof.
    for (const predicate of ['m.tenant_id = $1', 'm.google_subject = $2', 'm.id = $4', 'm.user_id = $5',
      "m.role IN ('OWNER','ADMIN')", 't.id = $1', 't.slug = $6',
      'g.tenant_id = $1 AND g.job_id = $3 AND g.generation_id = $7']) expect(q.text).toContain(predicate);
  }
}

describe('production historical CSV authenticated composition — synthetic PG I/O, NONAUTHORITY', () => {
  it.each(['OWNER', 'ADMIN'])('binds actual %s membership for distinct GET and HEAD, never spoofed headers', async role => {
    memberRows[0].role = role;
    const getRequest = request('GET'); const headRequest = request('HEAD');
    const get = await invoke('GET', getRequest); const head = await invoke('HEAD', headRequest);
    await success(get, 'GET'); await success(head, 'HEAD');
    expect([...head.headers]).toEqual([...get.headers]);
    expect(download).toHaveBeenNthCalledWith(1, 'alpha', getRequest);
    expect(download).toHaveBeenNthCalledWith(2, 'alpha', headRequest);
    expect(read).toHaveBeenNthCalledWith(1, 'alpha', getRequest, { jobId: JOB, generationId: GENERATION });
    expect(read).toHaveBeenNthCalledWith(2, 'alpha', headRequest, { jobId: JOB, generationId: GENERATION });
    expect(authorize).toHaveBeenCalledTimes(2);
    for (const [tenant, session] of authorize.mock.calls) {
      expect(tenant.id).toBe(TENANT); expect(tenant.slug).toBe('alpha');
      expect(session).toEqual({ subject: SUBJECT, email: 'synthetic@example.invalid', issuedAt: NOW });
    }
    expect(configs.filter(isTenant).map(q => q.values)).toEqual([['alpha'], ['alpha']]);
    expect(configs.filter(isMember).map(q => q.values)).toEqual([[TENANT, SUBJECT], [TENANT, SUBJECT]]);
    expect(configs.filter(q => q.text.includes('set_config')).map(q => q.values)).toEqual([[TENANT], [TENANT]]);
    boundFinalCalls(2);
    expect(io.connect).toHaveBeenCalledTimes(2); expect(clients).toHaveLength(2);
    expect(serialize).toHaveBeenCalledTimes(2);
    clients.forEach((client, i) => {
      expect(serialize).toHaveBeenNthCalledWith(i + 1, EXPECTED_DTO);
      expect(client.query.mock.calls[0][0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      expect(client.query.mock.calls.at(-1)?.[0].text).toBe('ROLLBACK');
      expect(client.release).toHaveBeenCalledExactlyOnceWith();
      expect(client.release.mock.invocationCallOrder[0]).toBeLessThan(serialize.mock.invocationCallOrder[i]);
    });
  });

  it.each(['admission', 'final SELECT'])('rechecks a distinct HEAD after GET when membership is absent at %s', async stage => {
    const getRequest = request('GET'); const headRequest = request('HEAD');
    await success(await invoke('GET', getRequest), 'GET');
    if (stage === 'admission') memberRows = [];
    else finalRows = []; // Script the final SELECT's no-current-member result, not a DB mutation.
    await refused(await invoke('HEAD', headRequest), 'HEAD', 403);
    expect(io.connect).toHaveBeenCalledTimes(2); expect(authorize).toHaveBeenCalledTimes(2);
    expect(configs.filter(isMember)).toHaveLength(2);
    expect(read).toHaveBeenNthCalledWith(2, 'alpha', headRequest, { jobId: JOB, generationId: GENERATION });
    expect(serialize).toHaveBeenCalledExactlyOnceWith(EXPECTED_DTO);
    boundFinalCalls(stage === 'admission' ? 1 : 2);
    for (const client of clients) expect(client.release).toHaveBeenCalledExactlyOnceWith();
    // No assertion about a later revoke during rollback/release/HTTP delivery:
    // the final READ COMMITTED SELECT is a snapshot, never continuous exclusion.
  });

  describe.each(METHODS)('%s refusal through the actual production handler', method => {
    it.each(['missing', 'duplicate', 'legacy'])('refuses %s cookie with no PG I/O', async mode => {
      const auth = mode === 'duplicate' ? `${cookie()}; ${cookie()}`
        : mode === 'legacy' ? 'class_store_admin=fake; class_store_tenant_admin=fake' : '';
      await refused(await invoke(method, request(method, auth)), method, 401);
      expect(io.connect).not.toHaveBeenCalled(); expect(configs).toEqual([]);
      expect(authorize).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(mode === 'duplicate' ? 1 : 0);
    });

    it.each(['tenant', 'subject', 'role', 'revoked'])('refuses actual membership %s despite valid cookie/OWNER header', async mode => {
      if (mode === 'revoked') memberRows = [];
      else memberRows[0][mode === 'tenant' ? 'tenant_id' : mode === 'subject' ? 'google_subject' : 'role']
        = mode === 'tenant' ? OTHER : mode === 'subject' ? 'other-subject' : 'VIEWER';
      await refused(await invoke(method), method, 403);
      expect(authorize).toHaveBeenCalledTimes(1); expect(io.connect).toHaveBeenCalledTimes(1);
      expect(configs.filter(isMember).map(q => q.values)).toEqual([[TENANT, SUBJECT]]);
      expect(configs.some(q => q.text.includes('set_config'))).toBe(false);
      boundFinalCalls(0); expect(serialize).not.toHaveBeenCalled();
      expect(clients[0].release).toHaveBeenCalledExactlyOnceWith();
    });

    it.each(['noncanonical slug', 'path mismatch'])('refuses %s before reader/PG I/O', async mode => {
      const req = request(method, cookie(), mode === 'path mismatch' ? PATH.replace('/alpha/', '/beta/') : PATH);
      await refused(await invoke(method, req, mode === 'noncanonical slug' ? 'Alpha' : 'alpha'), method, 400);
      expect(read).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
      expect(io.connect).not.toHaveBeenCalled(); expect(configs).toEqual([]); expect(serialize).not.toHaveBeenCalled();
    });

    it('maps authenticated exact-generation absence to private 404, never empty CSV', async () => {
      finalRows = [Object.fromEntries(GENERATION_FIELDS.map(([name]) =>
        [name, name === 'found' || name === 'binding_valid' ? false : null]))];
      await refused(await invoke(method), method, 404);
      expect(authorize).toHaveBeenCalledTimes(1); boundFinalCalls(1);
      expect(serialize).not.toHaveBeenCalled(); expect(clients[0].release).toHaveBeenCalledExactlyOnceWith();
    });

    it.each(['unsafe runtime', 'cross-bound result'])('maps %s to private 503, not authority or 404', async mode => {
      if (mode === 'unsafe runtime') runtimeSafe = false;
      else finalRows[0].tenant_id = OTHER; // Corrupt wire binding, not successful cross-tenant SQL evidence.
      await refused(await invoke(method), method, 503);
      expect(io.connect).toHaveBeenCalledTimes(1); expect(serialize).not.toHaveBeenCalled();
      if (mode === 'unsafe runtime') {
        expect(authorize).not.toHaveBeenCalled(); expect(configs.filter(isTenant)).toHaveLength(0);
        boundFinalCalls(0); expect(clients[0].release).toHaveBeenCalledExactlyOnceWith(true);
      } else {
        expect(authorize).toHaveBeenCalledTimes(1); boundFinalCalls(1);
        expect(clients[0].release).toHaveBeenCalledExactlyOnceWith();
      }
    });
  });
});
