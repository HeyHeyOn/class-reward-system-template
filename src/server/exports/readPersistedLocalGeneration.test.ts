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
// REAL Google verifier, tenant resolver, membership authorizer, config parser.
// pg connections and successful catalog admission are synthetic, NOT real
// PostgreSQL runtime-role/RLS proof. No real identity/credentials in fixtures.
import { readPersistedLocalGeneration } from './readPersistedLocalGeneration';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-subject';
const SECRET = 'public-synthetic-local-generation-test-secret';
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const JOB = 'historical/과거 job:%20';
const GENERATION = `preparation:candidate:${'a'.repeat(64)}`;
const PLAN = `preparation:plan:${'b'.repeat(64)}`;
const selection = () => ({ jobId: JOB, generationId: GENERATION });
type Config = QueryConfig & { query_timeout: number };
type Row = Record<string, unknown>;
type Reply = { rows: Row[]; fields: { name: string; dataTypeID: number; format: string }[] };
const SECURITY_FIELDS: [string, number][] = [['runtime_safe', 16]];
const REQUIRED_TABLES = ['tenants', 'tenant_memberships', 'migration_final_generations',
  'migration_jobs', 'migration_sources', 'migration_snapshots', 'audit_events'];
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const GENERATION_FIELDS: [string, number][] = [
  ['found', 16], ['binding_valid', 16], ['tenant_id', 2950], ['job_id', 25], ['generation_id', 25],
  ['original_source_id', 25], ['original_snapshot_id', 25], ['candidate_event_id', 25], ['plan_event_id', 25],
  ['candidate_manifest_digest', 25], ['candidate_sheet_digest', 25], ['recorded_state_version', 25],
  ['phase', 25], ['exclusion', 25], ['original_snapshot_phase', 25],
];
const reply = (rows: Row[], fields: [string, number][]): Reply => ({ rows,
  fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) });
const directory = () => ({ id: TENANT, slug: 'alpha', display_name: 'Synthetic', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' });
const member = () => ({ id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' });
const generation = (): Row => ({ found: true, binding_valid: true, tenant_id: TENANT, job_id: JOB,
  generation_id: GENERATION, original_source_id: 'source:synthetic', original_snapshot_id: 'snapshot:synthetic',
  candidate_event_id: GENERATION, plan_event_id: PLAN, candidate_manifest_digest: 'c'.repeat(64),
  candidate_sheet_digest: 'd'.repeat(64), recorded_state_version: '7', phase: 'LOCAL_CANDIDATE',
  exclusion: 'NOT_PROVEN', original_snapshot_phase: 'PREFLIGHT' });
const expected = (jobId = JOB, recordedStateVersion = '7') => ({ kind: 'HISTORICAL_LOCAL_GENERATION',
  authority: 'NONAUTHORITY', readOnly: true, scope: 'HISTORICAL_ONLY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
  originalSnapshotPhase: 'PREFLIGHT', verification: 'PERSISTED_BINDING_ONLY', payloadIntegrity: 'NOT_VERIFIED',
  currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN',
  cutoverAllowed: false, activationAllowed: false, jobId, generationId: GENERATION,
  originalSourceId: 'source:synthetic', originalSnapshotId: 'snapshot:synthetic',
  candidateManifestDigest: 'c'.repeat(64), candidateSheetDigest: 'd'.repeat(64), recordedStateVersion });
function cookie(issuedAt = Date.now(), subject = SUBJECT) {
  const iv = Buffer.alloc(12, 7); // Deterministic IV ONLY for synthetic test fixtures.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function request(options: { cookie?: string; method?: string; signal?: AbortSignal } = {}) {
  // No URL contract is invented here. Headers/query are NOT authority/selection.
  return new Request(`https://example.test/internal?tenantId=${OTHER}&jobId=ignored`, {
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
let securityReply: Reply;
let generationReply: Reply;
let tenantReply: Reply;
let memberReply: Reply;
let hook: ((config: Config) => Promise<Reply | void> | Reply | void) | undefined;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
const isGeneration = (config: Config) => config.text.includes('public.migration_final_generations');
const isSecurity = (config: Config) => config.text.includes('pg_catalog.pg_roles');
const read = (req = request(), selected: unknown = selection(), slug: unknown = 'alpha') =>
  readPersistedLocalGeneration(slug, req, selected);
const finalQuery = () => configs.find(isGeneration)!;

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/fixture');
  // Invalid direct URL must not even be validated; never read/migrate with it.
  vi.stubEnv('DIRECT_DATABASE_URL', 'must-not-use');
  configs = []; hook = undefined;
  securityReply = reply([{ runtime_safe: true }], SECURITY_FIELDS); // Explicit mocked admission only.
  generationReply = reply([generation()], GENERATION_FIELDS);
  tenantReply = reply([directory()], TENANT_FIELDS);
  memberReply = reply([member()], MEMBER_FIELDS);
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: Config): Promise<Reply> => {
      configs.push(config);
      const overridden = await hook?.(config);
      if (overridden) return overridden;
      if (isSecurity(config)) return securityReply;
      if (isGeneration(config)) return generationReply;
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

describe('persisted exact local generation, authenticated NONAUTHORITY metadata only', () => {
  it.each(['OWNER', 'ADMIN'])('reads exact metadata with real authentication as %s after rollback/release', async role => {
    memberReply.rows[0].role = role;
    const input = Object.freeze(selection());
    client.release.mockImplementation(() => { expect(configs.at(-1)?.text).toBe('ROLLBACK'); });
    expect(await read(request(), input)).toEqual(expected());
    expect(input).toEqual(selection());
    expect(mocks.pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: 'postgresql://synthetic.invalid/fixture',
      max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000, allowExitOnIdle: true }));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(finalQuery().values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', GENERATION]);
    expect(configs[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(configs.at(-1)?.text).toBe('ROLLBACK');
    expect(configs.find(c => c.text.includes("set_config('app.tenant_id'"))?.values).toEqual([TENANT]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(client.listenerCount('error')).toBe(0);
  });

  it.each(['', 'class_store_admin=fake; class_store_tenant_admin=fake', 'class_store_google_auth=bad',
    'class_store_google_auth=%ZZ', 'class_store_google_auth', `${cookie(NOW)}; ${cookie(NOW)}`,
    `class_store_google_auth =fake; ${cookie(NOW)}`,
  ])('refuses missing/forged/duplicate Google cookie before connection (%s)', async value => {
    expect(await read(request({ cookie: value }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([-MAX_AGE - 1, 1])('refuses expired/future real session (%s)', async delta => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    expect(await read(request({ cookie: cookie(NOW + delta) }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses cryptographically tampered cookie', async () => {
    const parts = cookie().split('.'); parts[2] = Buffer.alloc(16).toString('base64url');
    expect(await read(request({ cookie: parts.join('.') }))).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['Alpha', ' alpha', 'alpha ', '', undefined, 'alpha/other', 'a'.repeat(64)])('refuses noncanonical slug (%s)', async slug => {
    expect(await readPersistedLocalGeneration(slug, request(), selection())).toEqual({ kind: 'FORBIDDEN' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['tenantId', 'subject', 'role', 'source', 'manifest', 'expectedStateVersion', 'complete', 'status'])('refuses caller authority field %s', async key => {
    expect(await read(request(), { ...selection(), [key]: 'untrusted' })).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { jobId: JOB }, { generationId: GENERATION }, new String(JOB)])('refuses incomplete/nonplain selector %#', async selected => {
    expect(await read(request(), selected)).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses accessors, symbols, hidden fields and Proxies without invoking traps', async () => {
    const trap = vi.fn(() => { throw new Error('selector must be inert'); });
    const getter = Object.defineProperty({ generationId: GENERATION }, 'jobId', { get: trap, enumerable: true });
    const proxy = new Proxy(selection(), { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable(selection(), {}); revoked.revoke();
    const hidden = Object.defineProperty(selection(), 'role', { value: 'OWNER' });
    for (const selected of [getter, proxy, revoked.proxy, hidden, { ...selection(), [Symbol('role')]: 'OWNER' },
      Object.create(selection()), Object.defineProperty(selection(), 'jobId', { enumerable: false })]) {
      expect(await read(request(), selected)).toEqual({ kind: 'INVALID_REQUEST' });
    }
    expect(trap).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each([' job', 'job ', '\u0000', 'a\nb', 'a\u200bb', 'a\u2028b', '\uD800', '\uDC00', 'x'.repeat(1025), '한'.repeat(342)])('refuses malformed/oversized job id %#', async jobId => {
    expect(await read(request(), { ...selection(), jobId })).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['', GENERATION.toUpperCase(), GENERATION.replace('candidate', 'plan'), GENERATION + 'a', 'a'.repeat(64),
    GENERATION.replace(/a$/, 'g'), ` ${GENERATION}`, `${GENERATION}\n`])('refuses malformed generation %#', async generationId => {
    expect(await read(request(), { ...selection(), generationId })).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['opaque%ZZ/./é', 'job😀', "x'; SELECT secret; --", 'x'.repeat(1024)])('preserves admitted literal opaque job exactly %#', async jobId => {
    generationReply.rows[0].job_id = jobId;
    expect(await read(request(), { jobId, generationId: GENERATION })).toEqual(expected(jobId));
    expect(finalQuery().values?.[2]).toBe(jobId); expect(finalQuery().text).not.toContain(jobId);
  });
  it.each(['POST', 'PUT', 'DELETE'])('refuses nonread method %s', async method => {
    expect(await read(request({ method }))).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('admits HEAD without a new URL/HTTP route contract', async () => {
    expect(await read(request({ method: 'HEAD' }))).toEqual(expected());
  });
  it('bounds the entire cookie header before parsing', async () => {
    expect(await read(request({ cookie: 'x'.repeat(32769) }))).toEqual({ kind: 'INVALID_REQUEST' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([{ slug: 'beta' }, { id: 'invalid' }])('denies wrong tenant directory %#', async change => {
    Object.assign(tenantReply.rows[0], change);
    expect(await read()).toEqual({ kind: 'FORBIDDEN' }); expect(configs.some(isGeneration)).toBe(false);
  });
  it.each([{ tenant_id: OTHER }, { google_subject: 'wrong' }, { role: 'VIEWER' }, { role: null }, { id: 'invalid' }, { user_id: null }])('denies membership mismatch/unsupported role %#', async change => {
    Object.assign(memberReply.rows[0], change);
    expect(await read()).toEqual({ kind: 'FORBIDDEN' }); expect(configs.some(isGeneration)).toBe(false);
  });
  it.each(['tenant', 'member'])('denies absent %s without querying generations', async which => {
    (which === 'tenant' ? tenantReply : memberReply).rows = [];
    expect(await read()).toEqual({ kind: 'FORBIDDEN' }); expect(configs.some(isGeneration)).toBe(false);
  });
  it('denies final membership revocation/rebind rather than trusting admission', async () => {
    generationReply.rows = [];
    expect(await read()).toEqual({ kind: 'FORBIDDEN' });
    expect(finalQuery().text).toContain('m.id = $4'); expect(finalQuery().text).toContain('m.user_id = $5');
    expect(finalQuery().text).toContain('m.google_subject = $2'); expect(finalQuery().text).toContain("m.role IN ('OWNER','ADMIN')");
    expect(finalQuery().text).toContain('t.slug = $6'); expect(finalQuery().text).toContain('t.id = $1');
  });
  it('returns NOT_FOUND only for authorized exact absence', async () => {
    generationReply.rows = [Object.fromEntries(GENERATION_FIELDS.map(([name]) => [name,
      name === 'found' || name === 'binding_valid' ? false : null]))];
    expect(await read()).toEqual({ kind: 'NOT_FOUND' });
  });
  it('does not hide a broken persisted scalar binding as NOT_FOUND', async () => {
    generationReply.rows[0].binding_valid = false;
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each([{ tenant_id: OTHER }, { job_id: 'wrong' }, { generation_id: `preparation:candidate:${'b'.repeat(64)}` },
    { candidate_event_id: PLAN }, { plan_event_id: GENERATION }, { original_source_id: null }, { original_snapshot_id: '' },
    { candidate_manifest_digest: 'C'.repeat(64) }, { candidate_sheet_digest: 'd'.repeat(63) },
    { phase: 'ACTIVE' }, { exclusion: 'PROVEN' }, { original_snapshot_phase: 'FINAL_FROZEN' },
    { recorded_state_version: 7 }, { recorded_state_version: '07' }, { recorded_state_version: '0' },
    { recorded_state_version: '-1' }, { recorded_state_version: '9007199254740992' }, { recorded_state_version: '7.0' },
    { found: false }, { binding_valid: 'true' }, { original_source_id: '한'.repeat(342) }, { original_snapshot_id: '\uD800' },
  ])('refuses malformed/cross-binding persisted metadata %#', async change => {
    Object.assign(generationReply.rows[0], change); expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each(['generation', 'tenant', 'member'])('rejects duplicate LIMIT-2 %s rows', async which => {
    const result = which === 'generation' ? generationReply : which === 'tenant' ? tenantReply : memberReply;
    result.rows.push({ ...result.rows[0] }); expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each(['missing', 'extra', 'jsonb', 'binary', 'wrong-field-order'])('refuses result shape/OID %s', async mode => {
    if (mode === 'missing') delete generationReply.rows[0].phase;
    if (mode === 'extra') generationReply.rows[0].redacted_details = { secret: 'canary' };
    if (mode === 'jsonb') generationReply.fields[3].dataTypeID = 3802;
    if (mode === 'binary') generationReply.fields[3].format = 'binary';
    if (mode === 'wrong-field-order') generationReply.fields.reverse();
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each(['1', '9007199254740991'])('preserves historical version %s without checking current version/status', async version => {
    generationReply.rows[0].recorded_state_version = version;
    expect(await read()).toEqual(expected(JOB, version));
    expect(finalQuery().text).not.toMatch(/j\.(?:state_version|status)|reconciliation|MATCH/);
  });
  it.each(['42501', '42P01', '42883', 'XX000'])('refuses permission/schema/database failure %s without fallback', async code => {
    hook = config => { if (isGeneration(config)) throw Object.assign(new Error('secret postgresql://private source payload'), { code }); };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).toHaveBeenCalledTimes(1); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(configs.filter(isGeneration)).toHaveLength(1);
  });
  it('uses only read-only bounded runtime SQL and no source/producer imports', async () => {
    await read();
    const sql = configs.map(c => c.text).join('\n');
    expect(configs.every(c => c.query_timeout > 0 && c.query_timeout <= 2000)).toBe(true);
    expect(sql).toContain("SET LOCAL statement_timeout = '1500ms'");
    expect(sql).toContain("SET LOCAL lock_timeout = '500ms'");
    expect(sql).toContain("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|COMMIT|CREATE|ALTER|GRANT|FOR SHARE|FOR UPDATE|pg_advisory)\b/i);
    expect(sql).not.toMatch(/SELECT\s+\*|redacted_details|canonical_record|canonical_target|external_source_id|acquisition|migration_final_targets|migration_final_source_records/);
    expect(sql).toContain('LIMIT 2'); expect(sql).toContain("octet_length(convert_to(");
    const source = readFileSync(new URL('./readPersistedLocalGeneration.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter(line => line.includes('import ')).join('\n');
    expect(imports).not.toMatch(/migration\/|sheets|redis|reconciliation|productInventory|repositories\/factory|next\//i);
    const parser = finalQuery().types!.getTypeParser;
    expect(parser(3802, 'text')('{"unsafe":true}')).toBe('{"unsafe":true}');
  });
});

describe('runtime admission (mocked catalog results, not real PostgreSQL role proof)', () => {
  function expectNoDataRead() {
    expect(configs.filter(isSecurity)).toHaveLength(1);
    expect(configs.some(c => isGeneration(c) || c.text.includes('public.platform_find_')
      || c.text.includes("set_config('app.tenant_id'"))).toBe(false);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
    expect(configs.at(-1)).toSatisfy(isSecurity);
  }

  it('requires a single bounded catalog admission before directory, membership, scope or generation SQL', async () => {
    expect(await read()).toEqual(expected());
    expect(configs.filter(isSecurity)).toHaveLength(1);
    expect(configs[4]).toSatisfy(isSecurity);
    expect(configs.slice(0, 4).map(c => c.text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', "SET LOCAL statement_timeout = '1500ms'",
      "SET LOCAL lock_timeout = '500ms'", "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
    ]);
    const guard = configs[4];
    expect(guard.values).toBeUndefined();
    expect(guard.query_timeout).toBeGreaterThan(0); expect(guard.query_timeout).toBeLessThanOrEqual(2000);
    for (const table of REQUIRED_TABLES) expect(guard.text).toContain(`'${table}'`);
    expect(guard.text).toContain('pg_catalog.pg_class'); expect(guard.text).toContain('pg_catalog.pg_namespace');
    expect(guard.text).toContain('current_user = session_user');
    expect(guard.text).toContain('NOT r.rolsuper'); expect(guard.text).toContain('NOT r.rolbypassrls');
    expect(guard.text).toContain('c.relowner <> r.oid');
    expect(guard.text).toContain('c.relrowsecurity'); expect(guard.text).toContain('c.relforcerowsecurity');
    expect(guard.text).toContain("n.nspname = 'public'"); expect(guard.text).toContain("c.relkind = 'r'");
    expect(configs[5].text).toContain('public.platform_find_tenant_by_slug');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([false, null, undefined, 'true', 't', 1, {}, [], new Boolean(true)])('refuses non-true admission %# before any data SQL', async value => {
    securityReply.rows = [{ runtime_safe: value }];
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expectNoDataRead();
  });

  it.each(['no-rows', 'duplicate', 'missing-key', 'extra-key', 'missing-fields', 'extra-field',
    'wrong-name', 'wrong-oid', 'binary', 'null-row', 'array-row', 'hidden-key', 'symbol-key', 'prototype',
    'rows-arraylike', 'fields-arraylike', 'hidden-admission',
  ])('refuses malformed catalog result %s', async mode => {
    if (mode === 'no-rows') securityReply.rows = [];
    if (mode === 'duplicate') securityReply.rows.push({ runtime_safe: true });
    if (mode === 'missing-key') securityReply.rows = [{}];
    if (mode === 'extra-key') securityReply.rows[0].private_canary = 'postgresql://synthetic-private';
    if (mode === 'missing-fields') securityReply.fields = [];
    if (mode === 'extra-field') securityReply.fields.push({ name: 'private', dataTypeID: 25, format: 'text' });
    if (mode === 'wrong-name') securityReply.fields[0].name = 'unexpected';
    if (mode === 'wrong-oid') securityReply.fields[0].dataTypeID = 25;
    if (mode === 'binary') securityReply.fields[0].format = 'binary';
    if (mode === 'null-row') securityReply.rows = [null as unknown as Row];
    if (mode === 'array-row') securityReply.rows = [[] as unknown as Row];
    if (mode === 'hidden-key') Object.defineProperty(securityReply.rows[0], 'private', { value: 'canary' });
    if (mode === 'symbol-key') Object.defineProperty(securityReply.rows[0], Symbol('private'), { value: 'canary' });
    if (mode === 'prototype') Object.setPrototypeOf(securityReply.rows[0], { inherited: true });
    if (mode === 'rows-arraylike') securityReply.rows = { 0: { runtime_safe: true }, length: 1 } as unknown as Row[];
    if (mode === 'fields-arraylike') securityReply.fields = { 0: securityReply.fields[0], length: 1 } as unknown as Reply['fields'];
    if (mode === 'hidden-admission') Object.defineProperty(securityReply.rows[0], 'runtime_safe', { enumerable: false });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expectNoDataRead();
  });

  it.each(['getter', 'proxy', 'revoked-proxy'])('rejects active catalog row %s without invoking it', async mode => {
    const trap = vi.fn(() => true);
    const row = { runtime_safe: true };
    if (mode === 'getter') Object.defineProperty(row, 'runtime_safe', { get: trap, enumerable: true });
    const proxy = Proxy.revocable(row, { get: trap });
    if (mode === 'revoked-proxy') proxy.revoke();
    securityReply.rows = [mode === 'getter' ? row : proxy.proxy];
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expectNoDataRead();
    expect(trap).not.toHaveBeenCalled();
  });

  it.each(['42501', '42P01', 'XX000'])('sanitizes catalog query failure %s without fallback/retry or logging', async code => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hook = config => { if (isSecurity(config)) throw Object.assign(new Error('postgresql://synthetic-private source-canary'), { code }); };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expectNoDataRead();
    expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });

  it('refuses malformed boolean wire values instead of coercing them into catalog admission', async () => {
    expect(await read()).toEqual(expected());
    const parser = configs.find(isSecurity)!.types!.getTypeParser;
    expect(parser(16, 'text')('t')).toBe(true); expect(parser(16, 'text')('f')).toBe(false);
    for (const text of ['true', 'TRUE', '1', 'false', 'garbage', '']) expect(parser(16, 'text')(text)).toBe(text);
    expect(parser(3802, 'text')('{"runtime_safe":true}')).toBe('{"runtime_safe":true}');
  });
});

describe('actual SELECTs against isolated in-memory scalar fixtures (not runtime grants/RLS/concurrency proof)', () => {
  let db: PGlite;
  let beforeFinal: (() => Promise<unknown>) | undefined;
  // Deliberately minimal, constraint-free fixtures so corrupt links can be
  // exercised. No migration harness, real PostgreSQL, filesystem DB, roles,
  // grants or source acquisition. Pool/transaction lifecycle and successful
  // catalog admission remain mocked; only the EXACT emitted discovery/final
  // SELECTs execute in PGlite unless a test explicitly executes the guard.
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE test_tenants (id uuid, slug text, display_name text, lifecycle text, timezone text);
      CREATE TABLE test_members (id uuid, tenant_id uuid, user_id uuid, google_subject text, role text);
      CREATE FUNCTION platform_find_tenant_by_slug(text) RETURNS SETOF test_tenants LANGUAGE sql
        AS 'SELECT * FROM test_tenants WHERE slug = $1';
      CREATE FUNCTION platform_find_membership_by_tenant_and_google_subject(uuid,text) RETURNS SETOF test_members LANGUAGE sql
        AS 'SELECT * FROM test_members WHERE tenant_id = $1 AND google_subject = $2';
      CREATE TABLE migration_jobs (tenant_id uuid, job_id text, state_version bigint, status text);
      CREATE TABLE migration_sources (tenant_id uuid, job_id text, source_id text, external_source_id text);
      CREATE TABLE migration_snapshots (tenant_id uuid, job_id text, source_id text, snapshot_id text, phase text);
      CREATE TABLE audit_events (tenant_id uuid, job_id text, event_id text, event_type text, redacted_details jsonb);
      CREATE TABLE migration_final_generations (tenant_id uuid, job_id text, generation_id text,
        original_source_id text, original_snapshot_id text, candidate_event_id text, plan_event_id text,
        candidate_manifest_digest text, candidate_sheet_digest text, expected_state_version bigint,
        phase text, exclusion text, original_snapshot_phase text);
    `);
  });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    beforeFinal = undefined;
    await db.exec('TRUNCATE test_tenants, test_members, migration_jobs, migration_sources, migration_snapshots, audit_events, migration_final_generations');
    await db.query('INSERT INTO test_tenants VALUES ($1,$2,$3,$4,$5)', Object.values(directory()));
    await db.query('INSERT INTO test_members VALUES ($1,$2,$3,$4,$5)', Object.values(member()));
    await db.query('INSERT INTO migration_jobs VALUES ($1,$2,99,\'ACTIVE\')', [TENANT, JOB]);
    await db.query('INSERT INTO migration_sources VALUES ($1,$2,$3,$4)', [TENANT, JOB, 'source:synthetic', 'private-sheet-canary']);
    await db.query('INSERT INTO migration_snapshots VALUES ($1,$2,$3,$4,$5)', [TENANT, JOB, 'source:synthetic', 'snapshot:synthetic', 'PREFLIGHT']);
    await db.query('INSERT INTO audit_events VALUES ($1,$2,$3,$4,$5),($1,$2,$6,$7,$5)',
      [TENANT, JOB, GENERATION, 'MIGRATION_PREPARATION_CANDIDATE', '{"private":"payload-canary"}', PLAN, 'MIGRATION_PREPARATION_PLAN']);
    const row = generation();
    await db.query('INSERT INTO migration_final_generations VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [TENANT, JOB, GENERATION, row.original_source_id, row.original_snapshot_id, GENERATION, PLAN,
        row.candidate_manifest_digest, row.candidate_sheet_digest, '7', 'LOCAL_CANDIDATE', 'NOT_PROVEN', 'PREFLIGHT']);
    hook = async config => {
      if (isSecurity(config) || !config.text.startsWith('SELECT ') || config.text.includes('set_config')) return;
      if (isGeneration(config)) await beforeFinal?.();
      const result = await db.query<Row>(config.text, config.values);
      return { rows: result.rows, fields: result.fields.map(field => ({ ...field, format: 'text' })) };
    };
  });
  it('executes exact SELECTs and keeps ACTIVE/version=99 separate from recorded version=7', async () => {
    const output = await read(); expect(output).toEqual(expected());
    for (const privateValue of ['private-sheet-canary', 'payload-canary', SUBJECT, TENANT, USER, MEMBER, 'example.test']) {
      expect(JSON.stringify(output)).not.toContain(privateValue);
    }
  });
  it('executes the unchanged catalog SELECT and refuses the privileged/incomplete PGlite fixture', async () => {
    const original = hook!;
    let observed: Reply | undefined;
    hook = async config => {
      if (!isSecurity(config)) return original(config);
      const result = await db.query<Row>(config.text, config.values);
      observed = { rows: result.rows, fields: result.fields.map(field => ({ ...field, format: 'text' })) };
      return observed;
    };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    // Outside the sanitized catch: a syntax error must NOT count as guard proof.
    expect(observed).toEqual(reply([{ runtime_safe: false }], SECURITY_FIELDS));
    expect(configs.filter(isSecurity)).toHaveLength(1);
    expect(configs.some(isGeneration)).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  // Exercise the emitted boolean expression with synthetic catalog rows via a
  // read-only CTE, substituting ONLY its catalog/identity inputs. These are NOT
  // actual roles, catalog mutation, grants, deployed policies or pg transport.
  const catalogRole = (): Row => ({ oid: 11, rolname: 'synthetic_runtime', rolsuper: false, rolbypassrls: false });
  const catalogTables = (): Row[] => REQUIRED_TABLES.map(relname => ({ relname, relnamespace: 1,
    relkind: 'r', relrowsecurity: true, relforcerowsecurity: true, relowner: 12 }));
  async function runCatalogFixture(roles: Row[], tables: Row[], sessionUser = 'synthetic_runtime') {
    const original = hook!;
    let observed: Reply | undefined;
    hook = async config => {
      if (!isSecurity(config)) return original(config);
      const sql = config.text.replaceAll('pg_catalog.pg_roles', 'fixture_roles')
        .replaceAll('pg_catalog.pg_class', 'fixture_tables').replaceAll('pg_catalog.pg_namespace', 'fixture_namespaces')
        .replaceAll('current_user', '$3::text').replaceAll('session_user', '$4::text');
      const result = await db.query<Row>(`WITH fixture_roles AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(oid int, rolname text, rolsuper bool, rolbypassrls bool)
      ), fixture_tables AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(relname text, relnamespace int, relkind text,
          relrowsecurity bool, relforcerowsecurity bool, relowner int)
      ), fixture_namespaces AS (SELECT 1 AS oid, 'public'::text AS nspname)
      ${sql}`, [JSON.stringify(roles), JSON.stringify(tables), 'synthetic_runtime', sessionUser]);
      observed = { rows: result.rows, fields: result.fields.map(field => ({ ...field, format: 'text' })) };
      return observed;
    };
    const output = await read();
    // A SQL error caught by the reader must fail this assertion, not pass a
    // negative UNAVAILABLE test accidentally. No assertion inside the hook.
    expect(observed).toBeDefined();
    expect(configs.filter(isSecurity)).toHaveLength(1);
    return { output, observed: observed! };
  }
  function expectCatalogRefusal(result: Awaited<ReturnType<typeof runCatalogFixture>>) {
    expect(result.observed).toEqual(reply([{ runtime_safe: false }], SECURITY_FIELDS));
    expect(result.output).toEqual({ kind: 'UNAVAILABLE' });
    expect(configs.some(c => isGeneration(c) || c.text.includes('public.platform_find_')
      || c.text.includes("set_config('app.tenant_id'"))).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
  }
  it('admits the synthetic least-privilege expression only with the complete canonical table set', async () => {
    const tables = catalogTables();
    tables.push({ ...tables[0], relname: 'unrelated', relrowsecurity: false, relowner: 11 });
    const result = await runCatalogFixture([catalogRole()], tables);
    expect(result.observed).toEqual(reply([{ runtime_safe: true }], SECURITY_FIELDS));
    expect(result.output).toEqual(expected());
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['superuser', 'bypassrls', 'session-role', 'missing-role', 'wrong-role', 'null-superuser', 'null-bypassrls', 'null-oid'])
    ('refuses synthetic principal catalog %s', async mode => {
      const role = catalogRole();
      if (mode === 'superuser') role.rolsuper = true;
      if (mode === 'bypassrls') role.rolbypassrls = true;
      if (mode === 'wrong-role') role.rolname = 'another_runtime';
      if (mode === 'null-superuser') role.rolsuper = null;
      if (mode === 'null-bypassrls') role.rolbypassrls = null;
      if (mode === 'null-oid') role.oid = null;
      expectCatalogRefusal(await runCatalogFixture(mode === 'missing-role' ? [] : [role], catalogTables(),
        mode === 'session-role' ? 'different_session' : 'synthetic_runtime'));
    });
  it.each(REQUIRED_TABLES.flatMap(table => ['missing', 'rls-off', 'force-off', 'owner', 'null-rls', 'null-force',
    'null-owner', 'wrong-schema', 'view', 'duplicate', 'substituted'].map(mode => [table, mode])))
    ('refuses synthetic canonical table %s: %s', async (table, mode) => {
      let tables = catalogTables();
      const row = tables.find(row => row.relname === table)!;
      if (mode === 'missing') tables = tables.filter(row => row.relname !== table);
      if (mode === 'rls-off') row.relrowsecurity = false;
      if (mode === 'force-off') row.relforcerowsecurity = false;
      if (mode === 'owner') row.relowner = 11;
      if (mode === 'null-rls') row.relrowsecurity = null;
      if (mode === 'null-force') row.relforcerowsecurity = null;
      if (mode === 'null-owner') row.relowner = null;
      if (mode === 'wrong-schema') row.relnamespace = 2;
      if (mode === 'view') row.relkind = 'v';
      if (mode === 'duplicate') tables.push({ ...row });
      if (mode === 'substituted') row.relname = REQUIRED_TABLES.find(name => name !== table)!;
      expectCatalogRefusal(await runCatalogFixture([catalogRole()], tables));
    });
  it.each([
    'DELETE FROM test_members',
    `UPDATE test_members SET id = '${OTHER}'`,
    `UPDATE test_members SET user_id = '${OTHER}'`,
    `UPDATE test_members SET tenant_id = '${OTHER}'`,
    "UPDATE test_members SET google_subject = 'rebound'",
    "UPDATE test_members SET role = 'VIEWER'",
    "UPDATE test_tenants SET slug = 'beta'",
    `UPDATE test_tenants SET id = '${OTHER}'`,
  ])('refuses membership/tenant rebind made after admission %#', async sql => {
    beforeFinal = () => db.exec(sql);
    expect(await read()).toEqual({ kind: 'FORBIDDEN' });
    expect(finalQuery()).toBeDefined();
  });
  it.each([
    'DELETE FROM migration_jobs', 'DELETE FROM migration_sources', 'DELETE FROM migration_snapshots',
    `DELETE FROM audit_events WHERE event_id = '${GENERATION}'`,
    `DELETE FROM audit_events WHERE event_id = '${PLAN}'`,
    "UPDATE migration_sources SET job_id = 'other-job'",
    `UPDATE migration_sources SET tenant_id = '${OTHER}'`,
    "UPDATE migration_snapshots SET source_id = 'wrong-source'",
    "UPDATE migration_snapshots SET snapshot_id = 'wrong-snapshot'",
    "UPDATE migration_snapshots SET job_id = 'wrong-job'",
    `UPDATE migration_snapshots SET tenant_id = '${OTHER}'`,
    "UPDATE migration_snapshots SET phase = 'FINAL_FROZEN'",
    `UPDATE audit_events SET job_id = 'other-job' WHERE event_id = '${GENERATION}'`,
    `UPDATE audit_events SET job_id = 'other-job' WHERE event_id = '${PLAN}'`,
    `UPDATE audit_events SET tenant_id = '${OTHER}' WHERE event_id = '${GENERATION}'`,
    `UPDATE audit_events SET tenant_id = '${OTHER}' WHERE event_id = '${PLAN}'`,
    `UPDATE audit_events SET event_type = 'MIGRATION_PREPARATION_PLAN' WHERE event_id = '${GENERATION}'`,
    `UPDATE audit_events SET event_type = 'MIGRATION_PREPARATION_CANDIDATE' WHERE event_id = '${PLAN}'`,
    `UPDATE migration_final_generations SET candidate_event_id = '${PLAN}'`,
    "UPDATE migration_final_generations SET phase = 'ACTIVE'",
    "UPDATE migration_final_generations SET exclusion = 'PROVEN'",
    "UPDATE migration_final_generations SET original_snapshot_phase = 'FINAL_FROZEN'",
  ])('keeps a corrupt selected generation visible but refuses its scalar binding %#', async sql => {
    await db.exec(sql); expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it.each([
    `UPDATE migration_final_generations SET tenant_id = '${OTHER}'`,
    "UPDATE migration_final_generations SET job_id = 'other-job'",
    `UPDATE migration_final_generations SET generation_id = 'preparation:candidate:${'f'.repeat(64)}'`,
  ])('does not pick another tenant/job/generation as fallback %#', async sql => {
    await db.exec(sql); expect(await read()).toEqual({ kind: 'NOT_FOUND' });
  });
  it('rejects real duplicate join rows instead of arbitrary first/last selection', async () => {
    await db.exec('INSERT INTO migration_final_generations SELECT * FROM migration_final_generations');
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
  });
  it('gates oversized multibyte metadata to NULL before returning rows to the reader', async () => {
    const longId = '한'.repeat(342);
    await db.query('UPDATE migration_final_generations SET original_source_id = $1', [longId]);
    await db.query('UPDATE migration_sources SET source_id = $1', [longId]);
    await db.query('UPDATE migration_snapshots SET source_id = $1', [longId]);
    const originalHook = hook!;
    let observed: Reply | void;
    hook = async config => { const result = await originalHook(config); if (isGeneration(config)) observed = result; return result; };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(observed!.rows[0]).toMatchObject({ found: true, binding_valid: true, original_source_id: null });
  });
});

describe('whole-call deadline, identity, cancellation and cleanup refusal', () => {
  it.each(['', 'not-a-postgres-url', 'https://example.test/db'])('refuses missing/invalid runtime config without using direct URL %#', async runtimeUrl => {
    vi.resetModules();
    const fresh = await import('./readPersistedLocalGeneration');
    vi.stubEnv('DATABASE_URL', runtimeUrl);
    vi.stubEnv('DIRECT_DATABASE_URL', 'postgresql://must-not-use.invalid/privileged');
    expect(await fresh.readPersistedLocalGeneration('alpha', request(), selection())).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses acquisition rejection without logging or retry', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.connect.mockRejectedValue(new Error('private credential source-canary'));
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(configs).toEqual([]); expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
  it('observes synchronous acquisition failure', async () => {
    mocks.connect.mockImplementation(() => { throw new Error('connect'); });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(mocks.connect).toHaveBeenCalledTimes(1);
  });
  it('refuses changed session after acquisition before issuing SQL', async () => {
    const req = request();
    mocks.connect.mockImplementation(async () => { req.headers.set('cookie', cookie(Date.now(), 'changed')); return client; });
    expect(await read(req)).toEqual({ kind: 'UNAUTHENTICATED' });
    expect(configs).toEqual([]); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('cleans up a client arriving after an abort, including failed release/end', async () => {
    const abort = new AbortController(); const pending = deferred<typeof client>(); mocks.connect.mockReturnValue(pending.promise);
    const result = read(request({ signal: abort.signal })); abort.abort();
    expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    client.release.mockImplementation(() => { throw new Error('late release'); });
    client.end.mockRejectedValue(new Error('late end'));
    pending.resolve(client); await Promise.resolve(); await Promise.resolve();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true); expect(client.end).toHaveBeenCalledTimes(1);
    expect(configs).toEqual([]);
  });
  it('refuses abort or changed identity during release before publication', async () => {
    const abort = new AbortController();
    client.release.mockImplementation(() => abort.abort());
    expect(await read(request({ signal: abort.signal }))).toEqual({ kind: 'UNAVAILABLE' });
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it('checks the whole-call deadline again after successful release', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    client.release.mockImplementation(() => { clock = 5000; });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it('refuses an already aborted request without DB access', async () => {
    const abort = new AbortController(); abort.abort();
    expect(await read(request({ signal: abort.signal }))).toEqual({ kind: 'UNAVAILABLE' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses acquisition timeout and destroys a late client without any SQL', async () => {
    vi.useFakeTimers(); const pending = deferred<typeof client>(); mocks.connect.mockReturnValue(pending.promise);
    const result = read(); await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    pending.resolve(client); await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true); expect(configs).toEqual([]);
  });
  it('observes late acquisition rejection', async () => {
    vi.useFakeTimers(); const pending = deferred<typeof client>(); mocks.connect.mockReturnValue(pending.promise);
    const result = read(); await vi.advanceTimersByTimeAsync(2001); expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    pending.reject(new Error('private url')); await vi.advanceTimersByTimeAsync(0); expect(configs).toEqual([]);
  });
  it.each(['BEGIN', 'security', 'generation', 'ROLLBACK'])('never publishes on stalled %s and observes late query rejection', async stage => {
    vi.useFakeTimers(); const pending = deferred<Reply>();
    hook = config => (stage === 'security' ? isSecurity(config) : stage === 'generation'
      ? isGeneration(config) : config.text.startsWith(stage)) ? pending.promise : undefined;
    const result = read(); await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' });
    const count = configs.length; pending.reject(new Error('late query')); await vi.advanceTimersByTimeAsync(0);
    expect(configs).toHaveLength(count); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    if (stage === 'security') expect(configs.some(isGeneration)).toBe(false);
  });
  it('enforces aggregate deadline even when each query takes less than stage timeout', async () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    hook = () => new Promise<void>(resolve => { setTimeout(resolve, 900); });
    const result = read(); await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toEqual({ kind: 'UNAVAILABLE' }); const count = configs.length;
    await vi.advanceTimersByTimeAsync(3000); expect(configs).toHaveLength(count);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('refuses a deadline crossed during synchronous response validation', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    Object.defineProperty(generationReply.rows[0], 'recorded_state_version', { enumerable: true, get: () => { clock = 5001; return '7'; } });
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each(['security', 'generation'])('aborts a pending %s query and prevents late continuation', async stage => {
    const abort = new AbortController(); const pending = deferred<Reply>();
    const entered = deferred<void>(); hook = config => {
      if (stage === 'security' ? isSecurity(config) : isGeneration(config)) { entered.resolve(); return pending.promise; }
    };
    const result = read(request({ signal: abort.signal })); await entered.promise; abort.abort();
    expect(await result).toEqual({ kind: 'UNAVAILABLE' }); const count = configs.length;
    pending.resolve(stage === 'security' ? securityReply : generationReply); await Promise.resolve(); await Promise.resolve();
    expect(configs).toHaveLength(count); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    if (stage === 'security') expect(configs.some(isGeneration)).toBe(false);
  });
  it.each(['security', 'generation', 'ROLLBACK'])('refuses cookie replacement during %s', async stage => {
    const req = request(); hook = config => {
      if (stage === 'security' ? isSecurity(config) : stage === 'generation' ? isGeneration(config) : config.text === stage) {
        req.headers.set('cookie', cookie(Date.now(), 'other-subject'));
      }
    };
    expect(await read(req)).toEqual({ kind: 'UNAUTHENTICATED' }); expect(client.release).toHaveBeenCalledTimes(1);
    if (stage === 'security') expect(configs.some(isGeneration)).toBe(false);
  });
  it('rechecks session expiry before returning', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const req = request({ cookie: cookie(NOW - MAX_AGE + 1) });
    hook = config => { if (isGeneration(config)) vi.setSystemTime(NOW + 2); };
    expect(await read(req)).toEqual({ kind: 'UNAUTHENTICATED' });
  });
  it('refuses failed rollback', async () => {
    hook = config => { if (config.text === 'ROLLBACK') throw new Error('rollback secret'); };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' }); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('refuses failed release without double release and observes end rejection', async () => {
    client.release.mockImplementation(() => { throw new Error('release secret'); });
    client.end.mockRejectedValue(new Error('end secret'));
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(client.release).toHaveBeenCalledTimes(1); expect(client.end).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('error')).toBe(0);
  });
  it.each(['security', 'generation'])('refuses active client error during %s without retry', async stage => {
    hook = config => { if (stage === 'security' ? isSecurity(config) : isGeneration(config)) client.emit('error', new Error('socket secret')); };
    expect(await read()).toEqual({ kind: 'UNAVAILABLE' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true); expect(mocks.connect).toHaveBeenCalledTimes(1);
    if (stage === 'security') expect(configs.some(isGeneration)).toBe(false);
  });
});
