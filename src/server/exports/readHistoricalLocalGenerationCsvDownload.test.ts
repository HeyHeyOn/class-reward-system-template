// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { QueryConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as reader from './readPersistedLocalGeneration';
import * as formatter from './historicalLocalGenerationCsv';
import { readHistoricalLocalGenerationCsvDownload as download } from './readHistoricalLocalGenerationCsvDownload';

// Real cookie verifier, authorization, reader and formatter; only synthetic I/O.
// No SQL engine/RLS, real pg, HTTP listener, SDK, Docker or acceptance evidence.
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ connect: vi.fn(), pool: vi.fn(), on: vi.fn(), network: vi.fn(() => {
  throw new Error('Network forbidden in synthetic metadata download');
}) }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: unknown) { mocks.pool(options); }
  connect = mocks.connect;
  on = mocks.on;
}, types: { getTypeParser: () => (value: string) => value } }));
vi.mock('googleapis', () => ({ google: { auth: { OAuth2: mocks.network }, oauth2: mocks.network } }));

const realFormatter = formatter.buildHistoricalLocalGenerationCsv;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SUBJECT = 'synthetic-subject-canary';
const SECRET = 'public-synthetic-download-cookie-secret';
const PRIVATE = 'synthetic-private-payload-canary';
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const LIFETIME = 30 * 24 * 60 * 60 * 1000;
const GENERATION = `preparation:candidate:${'a'.repeat(64)}`;
const PLAN = `preparation:plan:${'b'.repeat(64)}`;
const JOB = '과거/작업😀:%ZZ';
const PATH = '/api/exports/alpha/historical-local-generation-metadata.csv';
// Independent canonical transport encoder: RFC3986 unreserved, uppercase hex.
const encode = (value: string) => [...Buffer.from(value)].map(byte =>
  /[A-Za-z0-9._~-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
const query = (job = JOB, generation = GENERATION) => `?jobId=${encode(job)}&generationId=${encode(generation)}`;
const URL = `https://example.invalid${PATH}${query()}`;
function cookie(issuedAt = NOW, subject = SUBJECT) {
  const iv = Buffer.alloc(12, 3); // Fixed IV ONLY for public synthetic fixtures.
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ subject, email: 'synthetic@example.test', issuedAt })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function request(method = 'GET', url = URL, auth = cookie(), signal?: AbortSignal) {
  return new Request(url, { method, signal, headers: { cookie: auth, 'x-tenant-id': OTHER, 'x-role': 'OWNER' } });
}
function rawRequest(url: string, method = 'GET') {
  // Preserve aliases the native Request constructor otherwise normalizes first.
  return Object.defineProperty(request(method), 'url', { value: url, configurable: true });
}
type Row = Record<string, unknown>;
type Fields = [string, number][];
const SECURITY_FIELDS: Fields = [['runtime_safe', 16]];
const TENANT_FIELDS: Fields = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: Fields = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const GENERATION_FIELDS: Fields = [
  ['found', 16], ['binding_valid', 16], ['tenant_id', 2950], ['job_id', 25], ['generation_id', 25],
  ['original_source_id', 25], ['original_snapshot_id', 25], ['candidate_event_id', 25], ['plan_event_id', 25],
  ['candidate_manifest_digest', 25], ['candidate_sheet_digest', 25], ['recorded_state_version', 25],
  ['phase', 25], ['exclusion', 25], ['original_snapshot_phase', 25],
];
const reply = (rows: Row[], fields: Fields) => ({ rows,
  fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) });
const isSecurity = (c: QueryConfig) => c.text.includes('pg_catalog.pg_roles');
const isGeneration = (c: QueryConfig) => c.text.includes('public.migration_final_generations');
const isMembership = (c: QueryConfig) => !isGeneration(c) && c.text.includes('public.platform_find_membership');
const COLUMNS = ['schemaVersion', 'purpose', 'kind', 'authority', 'readOnly', 'scope', 'phase', 'exclusion',
  'originalSnapshotPhase', 'verification', 'payloadIntegrity', 'currentFreshness', 'currentPreflight',
  'operationalAuthority', 'cutoverAllowed', 'activationAllowed', 'jobId', 'generationId', 'originalSourceId',
  'originalSnapshotId', 'candidateManifestDigest', 'candidateSheetDigest', 'recordedStateVersion'];
const GOLDEN = COLUMNS.map(key => `"${key}"`).join(',') + '\r\n'
  + `"'historical-local-generation-metadata-display/v1","'DISPLAY_ONLY","'HISTORICAL_LOCAL_GENERATION","'NONAUTHORITY","'true","'HISTORICAL_ONLY","'LOCAL_CANDIDATE","'NOT_PROVEN","'PREFLIGHT","'PERSISTED_BINDING_ONLY","'NOT_VERIFIED","'NOT_VERIFIED","'NOT_EVALUATED","'UNKNOWN","'false","'false","'과거/작업😀:%ZZ","'preparation:candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","'source:synthetic","'snapshot:synthetic","'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","'7"\r\n`;
const ERRORS: Record<number, string> = { 400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
  404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 503: 'UNAVAILABLE' };
function privateHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  for (const header of ['etag', 'last-modified', 'location', 'set-cookie', 'content-range', 'accept-ranges']) {
    expect(response.headers.has(header)).toBe(false);
  }
}
function noLeaks(text: string) {
  for (const value of [TENANT, OTHER, MEMBER, USER, SUBJECT, SECRET, PRIVATE, cookie(),
    'synthetic@example.test', 'must-not-use', 'postgresql://', 'SELECT ', 'canonical_record', 'redacted_details']) {
    expect(text).not.toContain(value);
  }
}
async function refused(response: Response, status: number, head = false) {
  expect(response.status).toBe(status); privateHeaders(response);
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(response.headers.has('content-disposition')).toBe(false);
  expect(response.headers.has('content-length')).toBe(false);
  expect(response.headers.get('allow')).toBe(status === 405 ? 'GET, HEAD' : null);
  if (head) expect(response.body).toBeNull();
  const body = await response.text();
  expect(body).toBe(head ? '' : `HISTORICAL_LOCAL_GENERATION_${ERRORS[status]}\n`);
  expect(body).not.toContain('schemaVersion'); expect(body).not.toContain(JOB); expect(body).not.toContain(GENERATION);
  noLeaks(body + JSON.stringify([...response.headers]));
}

let configs: QueryConfig[];
let directory: Row;
let membership: Row;
let generation: ReturnType<typeof reply>;
let security: ReturnType<typeof reply>;
let hook: ((config: QueryConfig) => void | Promise<void>) | undefined;
let clock: number;
let client: EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
let read: MockInstance<typeof reader.readPersistedLocalGeneration>;
let serialize: MockInstance<typeof formatter.buildHistoricalLocalGenerationCsv>;
beforeEach(() => {
  clock = NOW; vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic.invalid/fixture');
  vi.stubEnv('DIRECT_DATABASE_URL', 'must-not-use');
  mocks.network.mockClear(); vi.spyOn(globalThis, 'fetch').mockImplementation(mocks.network);
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  read = vi.spyOn(reader, 'readPersistedLocalGeneration');
  serialize = vi.spyOn(formatter, 'buildHistoricalLocalGenerationCsv');
  directory = { id: TENANT, slug: 'alpha', display_name: 'Synthetic', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
  membership = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
  generation = reply([{ found: true, binding_valid: true, tenant_id: TENANT, job_id: JOB,
    generation_id: GENERATION, original_source_id: 'source:synthetic', original_snapshot_id: 'snapshot:synthetic',
    candidate_event_id: GENERATION, plan_event_id: PLAN, candidate_manifest_digest: 'c'.repeat(64),
    candidate_sheet_digest: 'd'.repeat(64), recorded_state_version: '7', phase: 'LOCAL_CANDIDATE',
    exclusion: 'NOT_PROVEN', original_snapshot_phase: 'PREFLIGHT' }], GENERATION_FIELDS);
  security = reply([{ runtime_safe: true }], SECURITY_FIELDS); // NOT actual grants/RLS proof.
  configs = []; hook = undefined;
  client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (config: QueryConfig) => {
      configs.push(config); await hook?.(config);
      if (isSecurity(config)) return security;
      if (isGeneration(config)) {
        // Model ONLY the existing final statement's current-member/tenant predicate.
        // Assert the production SQL below; fixtures are not a SQL execution oracle.
        const [tenant, subject, , member, user, slug] = config.values ?? [];
        if (directory.id !== tenant || directory.slug !== slug || membership.tenant_id !== tenant
          || membership.google_subject !== subject || membership.id !== member || membership.user_id !== user
          || !['OWNER', 'ADMIN'].includes(String(membership.role))) return reply([], GENERATION_FIELDS);
        return generation;
      }
      if (isMembership(config)) return reply([membership], MEMBER_FIELDS);
      if (config.text.includes('public.platform_find_tenant')) return reply([directory], TENANT_FIELDS);
      return reply([], []);
    }), release: vi.fn(), end: vi.fn(async () => {}),
  });
  mocks.connect.mockReset().mockResolvedValue(client);
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect(mocks.network).not.toHaveBeenCalled();
  for (const method of ['log', 'warn', 'error'] as const) expect(console[method]).not.toHaveBeenCalled();
  expect(client.listenerCount('error')).toBe(0);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('fresh historical LOCAL_CANDIDATE metadata Response, not a public route/full export', () => {
  it.each(['OWNER', 'ADMIN'])('returns exact protected UTF-8 CSV bytes only after trusted %s read/cleanup', async role => {
    membership.role = role;
    const real = realFormatter;
    serialize.mockImplementation(value => {
      expect(client.release).toHaveBeenCalledExactlyOnceWith();
      expect(configs.at(-1)?.text).toBe('ROLLBACK');
      return real(value);
    });
    const req = request(); const response = await download('alpha', req);
    expect(response.status).toBe(200); privateHeaders(response);
    expect(read).toHaveBeenCalledExactlyOnceWith('alpha', req, { jobId: JOB, generationId: GENERATION });
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="historical-local-generation-metadata.csv"');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from(GOLDEN, 'utf8'));
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    noLeaks(bytes.toString('utf8') + JSON.stringify([...response.headers]));
    const final = configs.find(isGeneration)!;
    expect(final.values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', GENERATION]);
    for (const predicate of ['m.id = $4', 'm.user_id = $5', "m.role IN ('OWNER','ADMIN')", 't.id = $1', 't.slug = $6']) {
      expect(final.text).toContain(predicate);
    }
    expect(configs[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(configs.map(c => c.text).join('\n')).not.toMatch(/canonical_record|canonical_target|redacted_details|\b(?:GRANT|CREATE|ALTER|INSERT|DELETE|UPDATE|COMMIT)\b/i);
  });

  it('HEAD reauthorizes and formats the same representation but has no body', async () => {
    const get = await download('alpha', request());
    const head = await download('alpha', request('HEAD'));
    expect(head.status).toBe(200); expect(head.body).toBeNull(); expect(await head.text()).toBe('');
    expect([...head.headers]).toEqual([...get.headers]);
    expect(read).toHaveBeenCalledTimes(2); expect(serialize).toHaveBeenCalledTimes(2);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s before authentication/SQL', async method => {
    await refused(await download('alpha', request(method)), 405);
    expect(read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['', 'Alpha', ' alpha', 'alpha ', 'alpha/beta', '%61lpha', 'a'.repeat(64), null, 7])('rejects noncanonical slug %# without repairing it', async slug => {
    await refused(await download(slug, request()), 400);
    expect(read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
  });

  it.each([
    PATH.replace('alpha', 'beta') + query(), PATH.replace('alpha', '%61lpha') + query(), PATH + '/' + query(),
    PATH.replace('/api/', '/api//') + query(), PATH.replace('/alpha/', '/alpha/./') + query(),
    PATH.replace('metadata.csv', 'metadata') + query(), '/api/exports/alpha/products' + query(),
    '/api/migrations/status/alpha/preflight/download' + query(), '/api/c/alpha/exports/historical-local-generation-metadata.csv' + query(),
    PATH, PATH + '?', PATH + query() + '#', PATH + query() + '#secret',
    PATH + query() + '&', PATH + query() + '&jobId=another', PATH + query() + '&generationId=' + encode(GENERATION),
    PATH + query() + '&tenantId=' + OTHER, PATH + query() + '&role=OWNER', PATH + query() + '&filename=secret.csv',
    PATH + query() + '&unknown=x', PATH + query().replace('jobId=', '%6AobId='),
    PATH + `?generationId=${encode(GENERATION)}&jobId=${encode(JOB)}`,
    PATH + '?jobId=x', PATH + `?jobId=&generationId=${encode(GENERATION)}`,
    PATH + `?jobId=x&generationId=latest`, PATH + query('x', PLAN), PATH + query('x', GENERATION.toUpperCase()),
    PATH + query('x', GENERATION + '\n'), PATH + query('x', GENERATION + '0'),
    PATH + `?jobId=%ZZ&generationId=${encode(GENERATION)}`,
    PATH + `?jobId=%C0%AF&generationId=${encode(GENERATION)}`,
    PATH + `?jobId=%ED%A0%80&generationId=${encode(GENERATION)}`,
    PATH + query('x').replace('jobId=x', 'jobId=%78'),
    PATH + query('x y').replace('%20', '+'), PATH + query('x/y').replace('%2F', '%2f'),
    ...[' x', 'x ', '\t=1', 'a\0b', 'x\n', 'a\u200bb', 'a\u2028b', 'a\u007fb', 'x'.repeat(1025), '한'.repeat(342)]
      .map(job => PATH + query(job)),
  ])('rejects malformed/aliased/duplicate/unknown target %# before reader', async target => {
    await refused(await download('alpha', rawRequest(`https://example.invalid${target}`)), 400);
    expect(read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(['not a URL', '/relative', URL.replace('https:', 'ftp:'), URL.replace('//', '//user:password@'),
    URL.replace('/api/', '/discard/../api/'), URL + 'x'.repeat(8192)])('rejects invalid raw absolute URL %#', async url => {
    await refused(await download('alpha', rawRequest(url)), 400); expect(read).not.toHaveBeenCalled();
  });

  it.each(['=1+1', "'literal", 'a,"b",c', '00001', '%20', '%ZZ', 'a+b', 'x y', 'é', 'e\u0301',
    '한글😀/../:%ZZ', '"'.repeat(1024), '😀'.repeat(256)])('preserves literal admitted ID %# after exactly one transport decode', async job => {
    generation.rows[0].job_id = job;
    const req = request('GET', `https://example.invalid${PATH}${query(job)}`);
    const response = await download('alpha', req);
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith('alpha', req, { jobId: job, generationId: GENERATION });
    expect(configs.find(isGeneration)?.values?.[2]).toBe(job);
    expect(await response.text()).toContain(`"'${job.replace(/"/g, '""')}"`);
  });

  it.each(['range', 'if-range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since'])('refuses %s instead of cached/partial success', async header => {
    const req = request(); req.headers.set(header, 'synthetic');
    await refused(await download('alpha', req), 400); expect(read).not.toHaveBeenCalled();
  });

  it.each(['', 'class_store_admin=fake; class_store_tenant_admin=fake', 'class_store_google_auth=bad',
    'class_store_google_auth=%ZZ', cookie() + '; ' + cookie(), cookie(NOW - LIFETIME - 1)])('denies missing/malformed/duplicate/expired Google identity %#', async auth => {
    await refused(await download('alpha', request('GET', URL, auth)), 401);
    expect(mocks.connect).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
  });

  it('rejects an oversized cookie before touching the verifier or reader', async () => {
    await refused(await download('alpha', request('GET', URL, 'x'.repeat(32769))), 400);
    expect(read).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'subject', 'role', 'slug', 'member', 'user'])('denies initial %s mismatch; headers never grant authority', async mode => {
    if (mode === 'tenant') membership.tenant_id = OTHER;
    if (mode === 'subject') membership.google_subject = 'other-subject';
    if (mode === 'role') membership.role = 'VIEWER';
    if (mode === 'slug') directory.slug = 'beta';
    if (mode === 'member') membership.id = 'invalid';
    if (mode === 'user') membership.user_id = 'invalid';
    await refused(await download('alpha', request()), 403); expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'slug', 'member', 'user', 'subject', 'demotion', 'revoked'])('does not publish after final-statement %s drift', async mode => {
    hook = config => {
      if (!isGeneration(config)) return;
      if (mode === 'tenant') directory.id = OTHER;
      if (mode === 'slug') directory.slug = 'beta';
      if (mode === 'member') membership.id = OTHER;
      if (mode === 'user') membership.user_id = OTHER;
      if (mode === 'subject') membership.google_subject = 'other-subject';
      if (mode === 'demotion') membership.role = 'STUDENT';
      if (mode === 'revoked') generation.rows = [];
    };
    await refused(await download('alpha', request()), 403); expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['membership', 'generation', 'rollback', 'release', 'handoff'])('rejects identity expiry across %s and never serializes', async stage => {
    const expire = () => { clock = NOW + LIFETIME + 1; };
    if (stage === 'release') client.release.mockImplementation(expire);
    else if (stage === 'handoff') client.release.mockImplementation(() => { queueMicrotask(expire); });
    else hook = c => {
      if ((stage === 'membership' && isMembership(c)) || (stage === 'generation' && isGeneration(c))
        || (stage === 'rollback' && c.text === 'ROLLBACK')) expire();
    };
    await refused(await download('alpha', request()), 401); expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['cookie', 'url', 'method', 'signal'])('rejects request %s drift in reader-to-adapter handoff', async mode => {
    const req = request();
    client.release.mockImplementation(() => { queueMicrotask(() => {
      if (mode === 'cookie') req.headers.set('cookie', cookie(NOW, 'changed-subject'));
      else Object.defineProperty(req, mode, { value: mode === 'url' ? URL + '&role=OWNER'
        : mode === 'method' ? 'POST' : new AbortController().signal });
    }); });
    await refused(await download('alpha', req), mode === 'cookie' ? 401 : mode === 'signal' ? 503 : 400);
    expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['tenant_id', 'job_id', 'generation_id', 'binding_valid', 'candidate_event_id', 'phase'])('never exports corrupt persisted %s', async key => {
    generation.rows[0][key] = key === 'binding_valid' ? false : 'wrong-binding';
    await refused(await download('alpha', request()), 503); expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])('authorized not found is sanitized and not an empty CSV for %s', async method => {
    generation.rows = [Object.fromEntries(GENERATION_FIELDS.map(([name]) => [name,
      name === 'found' || name === 'binding_valid' ? false : null]))];
    await refused(await download('alpha', request(method)), 404, method === 'HEAD');
    expect(serialize).not.toHaveBeenCalled();
  });

  it.each(['unsafe', '42501', '42P01', '42883', 'connect', 'rollback', 'release'])('fails closed for %s with no CSV/error leakage/retry', async mode => {
    const fail = () => { throw Object.assign(new Error(PRIVATE + ' postgresql://private'), { code: mode }); };
    if (mode === 'unsafe') security.rows[0].runtime_safe = false;
    else if (mode === 'connect') mocks.connect.mockImplementation(fail);
    else if (mode === 'release') client.release.mockImplementation(fail);
    else hook = c => { if (mode === 'rollback' ? c.text === 'ROLLBACK' : isGeneration(c)) fail(); };
    await refused(await download('alpha', request()), 503); expect(serialize).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'generation', 'handoff', 'format'])('aborts at %s without CSV publication', async stage => {
    const abort = new AbortController(); const req = request('GET', URL, cookie(), abort.signal);
    if (stage === 'before') abort.abort();
    if (stage === 'generation') hook = c => { if (isGeneration(c)) abort.abort(); };
    if (stage === 'handoff') client.release.mockImplementation(() => { queueMicrotask(() => abort.abort()); });
    if (stage === 'format') {
      const real = realFormatter;
      serialize.mockImplementation(value => { const csv = real(value); abort.abort(); return csv; });
    }
    await refused(await download('alpha', req), 503);
    expect(serialize).toHaveBeenCalledTimes(stage === 'format' ? 1 : 0);
  });

  it.each(['expiry', 'cookie', 'throw'])('sanitizes synchronous formatter-boundary %s with no CSV prefix', async mode => {
    const req = request(); const real = realFormatter;
    serialize.mockImplementation(value => {
      const csv = real(value);
      if (mode === 'expiry') clock = NOW + LIFETIME + 1;
      if (mode === 'cookie') req.headers.set('cookie', cookie(NOW, 'changed'));
      if (mode === 'throw') throw new Error(PRIVATE);
      return csv;
    });
    await refused(await download('alpha', req), mode === 'throw' ? 503 : 401);
  });

  it('keeps HEAD refusals bodyless for admission, auth, forbidden, unavailable and formatter failure', async () => {
    await refused(await download('alpha', request('HEAD', URL + '&unknown=x')), 400, true);
    await refused(await download('alpha', request('HEAD', URL, '')), 401, true);
    membership.role = 'VIEWER'; await refused(await download('alpha', request('HEAD')), 403, true);
    membership.role = 'OWNER'; security.rows[0].runtime_safe = false;
    await refused(await download('alpha', request('HEAD')), 503, true);
    security.rows[0].runtime_safe = true;
    serialize.mockImplementation(() => { throw new Error(PRIVATE); });
    await refused(await download('alpha', request('HEAD')), 503, true);
  });

  it('never reuses success for a new identity, tenant or revoked membership', async () => {
    expect((await download('alpha', request())).status).toBe(200);
    await refused(await download('alpha', request('GET', URL, cookie(NOW, 'someone-else'))), 403);
    await refused(await download('beta', request('GET', URL.replace('/alpha/', '/beta/'))), 403);
    membership.role = 'VIEWER'; await refused(await download('alpha', request()), 403);
    expect(serialize).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(4);
    expect(mocks.connect).toHaveBeenCalledTimes(4);
  });

  it('documents the limit: membership revoked after the final snapshot is NOT a lease', async () => {
    client.release.mockImplementation(() => { membership.role = 'VIEWER'; });
    expect((await download('alpha', request())).status).toBe(200);
    await refused(await download('alpha', request()), 403);
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it('bounds pending acquisition and destroys a late client without SQL/CSV', async () => {
    vi.useFakeTimers();
    let resolve!: (value: typeof client) => void;
    mocks.connect.mockReturnValue(new Promise<typeof client>(yes => { resolve = yes; }));
    const pending = download('alpha', request());
    await vi.advanceTimersByTimeAsync(2001);
    await refused(await pending, 503);
    resolve(client); await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(configs).toEqual([]); expect(serialize).not.toHaveBeenCalled();
  });

  it('is a fixed server-only composition with one await and no route/cache/dependency override', () => {
    const source = readFileSync(new globalThis.URL('./readHistoricalLocalGenerationCsvDownload.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(source.startsWith("import 'server-only';")).toBe(true);
    expect(code.match(/\bawait\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/\b(?:fetch|console|process|Pool|setTimeout|setInterval)\b|use cache|export (?:const|function) (?:GET|HEAD)/);
    expect(download.length).toBe(2);
  });
});
