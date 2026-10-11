// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto';
import type { QueryConfig } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Install the transport boundary before production imports. No verifier,
// tenant-access projection, authorization, handler or status reader is replaced.
vi.mock('server-only', () => ({}));
const transport = vi.hoisted(() => {
  const forbidden = vi.fn(() => { throw new Error('External transport forbidden'); });
  vi.stubGlobal('fetch', forbidden);
  return { database: vi.fn(), forbidden };
});
vi.mock('@/server/db/client', () => ({ getDatabaseClient: transport.database }));
vi.mock('googleapis', () => ({ google: {
  auth: { OAuth2: transport.forbidden, GoogleAuth: transport.forbidden },
  oauth2: transport.forbidden, sheets: transport.forbidden, drive: transport.forbidden,
} }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  // Drizzle's unused compatibility path imports pg; preserve its type codecs,
  // but refuse accidental real Pool/Client construction, including default pg.
  const denied = { Pool: transport.forbidden, Client: transport.forbidden };
  return { ...actual, ...denied, default: { ...actual.default, ...denied } };
});

import { getGoogleSessionFromRequest, type GoogleSession } from '@/server/googleOAuth';
import { currentLegalRevision } from '@/lib/legalDocuments';
import * as route from './route';

// N1: direct-handler contract, NOT live Google/PG/Next/browser evidence.
// Execute only after runner/import preflight, in a cleared environment with no
// credential files, host sockets or external network. Never import sibling tests.
// Time moves only through Date.now; the reader's acquisition deadline stays real.
const NOW = Date.parse('2026-01-02T12:00:00.000Z');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const KEY = 'synthetic-identity-lifetime-key-not-a-real-secret';
const TENANT = '20000000-0000-4000-8000-000000000001';
const MEMBER = '30000000-0000-4000-8000-000000000001';
const USER = '40000000-0000-4000-8000-000000000001';
const SUBJECT = 'synthetic-private-subject';
const JOB = 'synthetic-private-job';
const SESSION: GoogleSession = Object.freeze({
  subject: SUBJECT, email: 'synthetic-private@example.test', issuedAt: NOW - MAX_AGE_MS + 1,
  accountGeneration: '50000000-0000-4000-8000-000000000001', sessionId: '50000000-0000-4000-8000-000000000002',
  agreement: currentLegalRevision(NOW).version,
});
const tenant = Object.freeze({
  id: TENANT, slug: 'alpha', display_name: 'synthetic-private-class', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul',
});
const member = Object.freeze({ id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' });
const job = Object.freeze({ status: 'ACTIVE', source: 'synthetic-private-source', access_token: 'synthetic-private-token' });
const tenantSql = 'SELECT * FROM public.platform_find_tenant_by_slug($1)';
const memberSql = 'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)';
const sessionSql = 'SELECT public.platform_validate_teacher_session($1,$2::uuid,$3::uuid,$4,$5) AS valid';
const sessionBinding = [SUBJECT, SESSION.accountGeneration, SESSION.sessionId, false, SESSION.agreement];
const projected = {
  availability: 'AVAILABLE', readOnly: true, migrationStatus: 'ACTIVE', authority: 'UNKNOWN',
  reasonCode: 'OPERATIONAL_AUTHORITY_UNVERIFIED',
  reason: '저장된 작업 상태만 표시합니다. 실제 운영 권한은 확인되지 않았습니다.',
};
const blocked = {
  availability: 'BLOCKED', readOnly: true, migrationStatus: 'UNKNOWN', authority: 'UNKNOWN',
  reasonCode: 'TRUSTED_STATUS_READER_UNAVAILABLE',
  reason: '검증된 이전 상태 조회가 연결되지 않아 진행 상태와 운영 권한을 확인할 수 없습니다.',
};

type Reply = { rows: unknown[] };
type Point = 'membership' | 'job SELECT' | 'ROLLBACK';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function pauseAt(point: Point) {
  const entered = signal();
  const resume = signal();
  return { point, entered, resume };
}
let pause: ReturnType<typeof pauseAt> | undefined;
let now: number;
let role: 'OWNER' | 'ADMIN';
let failRollback: boolean;
let sequence: string[];
const directoryQuery = vi.fn<(text: string, values?: unknown[]) => Promise<Reply>>();
const query = vi.fn<(config: QueryConfig & { query_timeout?: number }) => Promise<Reply>>();
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));

async function waitAt(point: Point) {
  if (pause?.point !== point) return;
  pause.entered.resolve();
  await pause.resume.promise;
}

// Independent synthetic AES-GCM encoder, not a mock verifier. The fixed IV is
// test-only and is not guidance for production encryption/key/IV reuse.
function input(explicitJob = true): Request {
  const iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(KEY).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(SESSION)), cipher.final()]);
  const value = ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), bytes.toString('base64url')].join('.');
  return new Request(`https://example.test/api/migrations/status/alpha${explicitJob ? `?jobId=${JOB}` : ''}`, {
    headers: { cookie: `class_store_google_auth=${value}` },
  });
}
function get(request: Request) {
  return route.GET(request, { params: Promise.resolve({ slug: 'alpha' }) });
}
function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('vary')).toBe('Cookie');
  for (const header of ['set-cookie', 'location', 'etag', 'access-control-allow-origin']) {
    expect(response.headers.get(header)).toBeNull();
  }
}
function expectAccessReads() {
  expect(directoryQuery.mock.calls).toEqual([[tenantSql, ['alpha']], [sessionSql, sessionBinding], [memberSql, [TENANT, SUBJECT]]]);
}
function expectNoJobConnection() {
  expect(connect).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
}
function expectJobCleanup(discard = false) {
  expect(connect).toHaveBeenCalledTimes(1);
  expect(release.mock.calls).toEqual(discard ? [[true]] : [[]]);
  expect(sequence.at(-1)).toBe(discard ? 'release:discard' : 'release:reuse');
  expect(sequence.filter(step => step === 'ROLLBACK')).toHaveLength(1);
  expect(sequence.indexOf('ROLLBACK')).toBeLessThan(sequence.indexOf(discard ? 'release:discard' : 'release:reuse'));
  const configs = query.mock.calls.map(([config]) => config);
  expect(configs.map(config => config.text.includes('public.migration_jobs') ? 'job SELECT' : config.text)).toEqual([
    'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
    "SET LOCAL statement_timeout = '1500ms'",
    "SET LOCAL lock_timeout = '500ms'",
    "SELECT set_config('app.tenant_id', $1, true)",
    'job SELECT',
    'ROLLBACK',
  ]);
  expect(configs[3].values).toEqual([TENANT]);
  const jobRead = configs[4];
  expect(jobRead.values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha']);
  // A lifetime fix must not drop the same-statement current membership binding.
  expect(jobRead.text).toContain('public.platform_find_membership_by_tenant_and_google_subject($1, $2)');
  expect(jobRead.text).toContain('public.platform_find_tenant_by_slug($6)');
  expect(jobRead.text).toContain('j.tenant_id = $1 AND j.job_id = $3');
  expect(jobRead.text).toContain("m.id = $4 AND m.user_id = $5 AND m.role IN ('OWNER','ADMIN')");
  expect(jobRead.text).toMatch(/LIMIT 1\s*$/);
  expect(jobRead.text).not.toMatch(/SELECT\s+\*|FOR UPDATE|ORDER BY/i);
}
async function expectUnauthenticated(response: Response) {
  expectPrivate(response);
  const text = await response.text();
  // Soft assertions keep RED's exact status/body and transport checks visible;
  // they do not invert expectations or mark a known failure as passing.
  expect.soft(response.status).toBe(401);
  expect.soft(JSON.parse(text)).toEqual({ error: 'AUTHENTICATION_REQUIRED' });
  for (const value of [JOB, TENANT, MEMBER, USER, SUBJECT, SESSION.email, KEY, job.source, job.access_token]) {
    expect(text).not.toContain(value);
  }
  expect.soft(text).not.toMatch(/migrationStatus|availability|authority|readOnly|cutoverAllowed/);
}

beforeAll(() => {
  // Do not erase evidence of an accidental transport call during module import.
  expect(transport.forbidden).not.toHaveBeenCalled();
  expect(transport.database).not.toHaveBeenCalled();
});
afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  transport.database.mockReset();
  transport.forbidden.mockClear();
  directoryQuery.mockReset();
  query.mockReset();
  release.mockReset();
  connect.mockClear();
  pause = undefined;
  now = NOW;
  role = 'OWNER';
  failRollback = false;
  sequence = [];
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  for (const name of ['GOOGLE_CLIENT_SECRET', 'ADMIN_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_REFRESH_TOKEN',
    'GENERATOR_GOOGLE_CLIENT_ID', 'GENERATOR_GOOGLE_CLIENT_SECRET']) vi.stubEnv(name, undefined);
  vi.stubEnv('AUTH_SECRET', KEY);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
  directoryQuery.mockImplementation(async (text, values) => {
    if (text === tenantSql) {
      expect(values).toEqual(['alpha']);
      sequence.push('tenant');
      return { rows: [tenant] };
    }
    if (text === memberSql) {
      expect(values).toEqual([TENANT, SUBJECT]);
      sequence.push('membership');
      await waitAt('membership');
      return { rows: [{ ...member, role }] };
    }
    if (text === sessionSql) {
      expect(values).toEqual(sessionBinding);
      sequence.push('teacher session');
      return { rows: [{ valid: true }] };
    }
    throw new Error('Unexpected directory SQL');
  });
  query.mockImplementation(async config => {
    if (config.text.includes('public.migration_jobs')) {
      sequence.push('job SELECT');
      await waitAt('job SELECT');
      return { rows: [job] };
    }
    const allowed = [
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      "SET LOCAL statement_timeout = '1500ms'",
      "SET LOCAL lock_timeout = '500ms'",
      "SELECT set_config('app.tenant_id', $1, true)",
      'ROLLBACK',
    ];
    if (!allowed.includes(config.text)) throw new Error('Unexpected job SQL');
    sequence.push(config.text);
    if (config.text === 'ROLLBACK') {
      await waitAt('ROLLBACK');
      if (failRollback) throw new Error('synthetic-private-rollback-error');
    }
    return { rows: [] };
  });
  release.mockImplementation((discard?: boolean) => { sequence.push(discard ? 'release:discard' : 'release:reuse'); });
  transport.database.mockReturnValue({ pool: { query: directoryQuery, connect } });
});
afterEach(() => {
  try {
    expect(transport.forbidden).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(transport.forbidden);
    expect(Object.keys(route).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    for (const [text] of directoryQuery.mock.calls) expect([tenantSql, sessionSql, memberSql]).toContain(text);
    for (const [config] of query.mock.calls) {
      expect(config.query_timeout).toBe(2000);
      expect(config.text.trimStart()).toMatch(/^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/);
      expect(config.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|COMMIT)\b/i);
    }
    expect(release).toHaveBeenCalledTimes(connect.mock.calls.length);
  } finally {
    pause?.resume.resolve();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

// Explicit gates prove the handler is still pending at the selected await.
// Both valid controls and expired cases use exactly the same transport path.
async function completeAcross(point: Point, explicitJob: boolean, elapsedMs: 1 | 2) {
  const request = input(explicitJob);
  expect(getGoogleSessionFromRequest(request)).toEqual(SESSION);
  pause = pauseAt(point);
  let settled = false;
  const pending = get(request).then(response => { settled = true; return response; });
  try {
    await Promise.race([pause.entered.promise, pending.then(response => {
      throw new Error(`Handler completed with status ${response.status} before reaching ${point}`);
    })]);
    expect(settled).toBe(false);
    expect(getGoogleSessionFromRequest(request)).toEqual(SESSION);
    now = NOW + elapsedMs;
    // <= MAX_AGE remains valid; +1 ms beyond it is expired in the real verifier.
    expect(getGoogleSessionFromRequest(request)).toEqual(elapsedMs === 1 ? SESSION : null);
  } finally {
    pause.resume.resolve();
    await pending;
  }
  const response = await pending;
  expectAccessReads();
  return response;
}

describe('status identity lifetime across asynchronous reads (socketless)', () => {
  it.each([
    ['membership', 'OWNER'], ['job SELECT', 'ADMIN'],
  ] as const)('positive control: %s wait retains valid %s at the inclusive age boundary', async (point, memberRole) => {
    role = memberRole;
    const response = await completeAcross(point, true, 1);
    expectPrivate(response);
    expectJobCleanup();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(projected);
  });

  it('positive control: a valid no-job request remains BLOCKED and non-authoritative', async () => {
    const response = await completeAcross('membership', false, 1);
    expectNoJobConnection();
    expectPrivate(response);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(blocked);
  });

  it.each([false, true])('negative control: already expired identity makes zero access reads (explicitJob=%s)', async explicitJob => {
    now = NOW + 2;
    const request = input(explicitJob);
    expect(getGoogleSessionFromRequest(request)).toBeNull();
    const response = await get(request);
    await expectUnauthenticated(response);
    expect(transport.database).not.toHaveBeenCalled();
    expect(directoryQuery).not.toHaveBeenCalled();
    expectNoJobConnection();
  });

  it.each([false, true])('fails closed when initially valid identity expires during membership (explicitJob=%s)', async explicitJob => {
    const response = await completeAcross('membership', explicitJob, 2);
    await expectUnauthenticated(response);
    expectNoJobConnection();
  });

  it.each(['job SELECT', 'ROLLBACK'] as const)('fails closed when initially valid identity expires during %s, after cleaning up', async point => {
    const response = await completeAcross(point, true, 2);
    expectJobCleanup();
    await expectUnauthenticated(response);
  });

  it('destroys exactly one connection on failed rollback without retry or an authority DTO', async () => {
    failRollback = true;
    const response = await completeAcross('job SELECT', true, 1);
    expectPrivate(response);
    expectJobCleanup(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'JOB_STATUS_UNAVAILABLE' });
  });
});
