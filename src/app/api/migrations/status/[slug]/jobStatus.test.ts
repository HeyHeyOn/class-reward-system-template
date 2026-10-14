// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryConfig } from 'pg';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ dependencies: vi.fn(), database: vi.fn() }));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: mocks.dependencies }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: mocks.database }));
import { GET } from './route';

const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha', displayName: 'private-class', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const session = { subject: 'private-subject', email: 'private@example.test', issuedAt: 1 };
const member = { id: '30000000-0000-4000-8000-000000000001', tenantId: tenant.id, userId: '40000000-0000-4000-8000-000000000001', googleSubject: session.subject, role: 'OWNER' };
const getSession = vi.fn((): typeof session | null => session);
const findBySlug = vi.fn(async () => tenant);
const findByTenantAndSubject = vi.fn(async (): Promise<typeof member | null> => member);
const getCompatibilitySession = vi.fn();
const query = vi.fn<(config: QueryConfig) => Promise<{ rows: unknown[] }>>();
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));
let fetchSpy: ReturnType<typeof vi.spyOn>;
const jobId = 'job-explicit-1';
const projected = {
  availability: 'AVAILABLE', reasonCode: 'OPERATIONAL_AUTHORITY_UNVERIFIED',
  reason: '저장된 작업 상태만 표시해요. 실제 운영 권한은 확인되지 않았어요.',
  readOnly: true, migrationStatus: 'ACTIVE', authority: 'UNKNOWN',
};
const jobCalls = () => query.mock.calls.filter(([config]) => config.text.includes('public.migration_jobs'));
const get = (suffix = `?jobId=${jobId}`, method = 'GET') => GET(
  new Request(`https://example.test/api/migrations/status/alpha${suffix}`, { method }),
  { params: Promise.resolve({ slug: 'alpha' }) },
);
function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('vary')).toBe('Cookie');
}

beforeEach(() => {
  vi.resetAllMocks();
  getSession.mockReturnValue(session);
  findBySlug.mockResolvedValue(tenant);
  findByTenantAndSubject.mockResolvedValue(member);
  mocks.dependencies.mockReturnValue({ getSession, findBySlug, findByTenantAndSubject, getCompatibilitySession });
  mocks.database.mockReturnValue({ pool: { connect } });
  connect.mockResolvedValue({ query, release });
  query.mockImplementation(async config => ({ rows: config.text.includes('public.migration_jobs') ? [{ status: 'ACTIVE' }] : [] }));
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No source network'));
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(getCompatibilitySession).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('explicit tenant-bound persisted job status GET', () => {
  it.each(['DISCOVERED', 'VALIDATED', 'IMPORTING', 'RECONCILING', 'READY', 'FREEZING', 'FINAL_IMPORT', 'ACTIVE', 'FAILED', 'ABORTED'])(
    'projects only the persisted %s label while authority stays UNKNOWN', async status => {
      query.mockImplementation(async config => ({ rows: config.text.includes('public.migration_jobs') ? [{ status }] : [] }));
      const response = await get();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...projected, migrationStatus: status });
    },
  );

  it.each(['OWNER', 'ADMIN'])('reads a bounded projection for current %s, not operational authority', async role => {
    findByTenantAndSubject.mockResolvedValue({ ...member, role });
    const response = await get();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual(projected);
    // Initial admission, after membership, and after job rollback/release.
    expect(getSession).toHaveBeenCalledTimes(3);
    const [initialIdentity, afterMembership, afterJob] = getSession.mock.invocationCallOrder;
    expect(initialIdentity).toBeLessThan(findBySlug.mock.invocationCallOrder[0]);
    expect(findByTenantAndSubject.mock.invocationCallOrder[0]).toBeLessThan(afterMembership);
    expect(afterMembership).toBeLessThan(connect.mock.invocationCallOrder[0]);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(afterJob);
    expect(findBySlug).toHaveBeenCalledWith('alpha');
    expect(findByTenantAndSubject).toHaveBeenCalledWith(tenant.id, session.subject);
    expect(jobCalls()).toHaveLength(1);
    const [config] = jobCalls()[0];
    expect(config.values).toEqual([tenant.id, session.subject, jobId, member.id, member.userId, 'alpha']);
    expect(config.text).toContain('j.tenant_id = $1');
    expect(config.text).toContain('j.job_id = $3');
    expect(config.text).toContain('public.platform_find_membership_by_tenant_and_google_subject($1, $2)');
    expect(config.text).toContain('public.platform_find_tenant_by_slug($6)');
    expect(config.text).toContain("m.id = $4 AND m.user_id = $5 AND m.role IN ('OWNER','ADMIN')");
    expect(config.text).toMatch(/LIMIT 1\s*$/);
    expect(config.text).not.toMatch(/SELECT\s+\*|ORDER BY|FOR UPDATE/i);
    expect(query.mock.calls.at(-1)?.[0].text).toBe('ROLLBACK');
    expect(query.mock.invocationCallOrder.at(-1)).toBeLessThan(release.mock.invocationCallOrder[0]);
    expect(release.mock.calls).toEqual([[]]);
  });

  it('preserves no-selector BLOCKED/UNKNOWN without opening a job connection or choosing latest', async () => {
    const response = await get('');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ availability: 'BLOCKED', migrationStatus: 'UNKNOWN', authority: 'UNKNOWN' });
    expect(connect).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
  });

  it.each(['', ' ', ' job-1', 'job-1 ', 'job\n1', 'job\u00001', 'job\u20281', 'x'.repeat(1025)])('rejects malformed ID %j without any lookup', async id => {
    const response = await get(`?jobId=${encodeURIComponent(id)}`);
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'INVALID_STATUS_REQUEST' });
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([`?jobId=${jobId}&jobId=${jobId}`, `?jobId=${jobId}&tenantId=other`, `?jobId=${jobId}&authority=ACTIVE`, '?jobID=wrong'])('rejects duplicate/unsupported selectors: %s', async suffix => {
    expect((await get(suffix)).status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(['job-not-present', 'job-in-other-tenant'])('does not reveal %s', async id => {
    query.mockImplementation(async config => ({ rows: config.text.includes('public.migration_jobs') ? [{ status: null }] : [] }));
    const response = await get(`?jobId=${id}`);
    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'JOB_NOT_FOUND' });
  });

  it('rejects an absent Google session before DB access', async () => {
    getSession.mockReturnValue(null);
    expect((await get()).status).toBe(401);
    expect(findBySlug).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...member, googleSubject: 'another-subject' },
    { ...member, tenantId: '20000000-0000-4000-8000-000000000002' },
    { ...member, role: 'STUDENT' },
  ])('rejects missing or mismatched membership before job lookup', async membership => {
    findByTenantAndSubject.mockResolvedValue(membership);
    expect((await get()).status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects membership revoked between the access check and the job SELECT', async () => {
    query.mockResolvedValue({ rows: [] });
    const response = await get();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ACCESS_DENIED' });
    expect(jobCalls()).toHaveLength(1);
  });

  it('rechecks access after revocation, without a cached success', async () => {
    expect((await get()).status).toBe(200);
    findByTenantAndSubject.mockResolvedValue(null);
    expect((await get()).status).toBe(403);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(findByTenantAndSubject).toHaveBeenCalledTimes(2);
  });

  it.each(['pool', 'connect', 'begin', 'job', 'rollback'])('redacts %s failure and never retries', async point => {
    const error = new Error('private-refresh-token postgresql://private-password private-source-row');
    if (point === 'pool') mocks.database.mockImplementation(() => { throw error; });
    if (point === 'connect') connect.mockRejectedValue(error);
    if (point === 'begin') query.mockRejectedValueOnce(error);
    if (point === 'job' || point === 'rollback') query.mockImplementation(async config => {
      if (config.text.includes(point === 'job' ? 'public.migration_jobs' : 'ROLLBACK')) throw error;
      return { rows: [] };
    });
    const response = await get();
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'JOB_STATUS_UNAVAILABLE' });
    expect(connect.mock.calls.length).toBeLessThanOrEqual(1);
    if (['begin', 'job', 'rollback'].includes(point)) expect(release.mock.calls).toEqual([[true]]);
  });

  it('bounds pool acquisition and discards a connection arriving after timeout', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { query: typeof query; release: typeof release }) => void;
    connect.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = get();
    await vi.advanceTimersByTimeAsync(2001);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'JOB_STATUS_UNAVAILABLE' });
    resolve({ query, release });
    await vi.advanceTimersByTimeAsync(0);
    expect(release.mock.calls).toEqual([[true]]);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not echo ID, source, credentials, identity, raw JSON or audit details', async () => {
    query.mockImplementation(async config => ({ rows: config.text.includes('public.migration_jobs') ? [{
      status: 'ACTIVE', job_id: 'private-job', source_fingerprint: 'private-fingerprint',
      source: 'private-sheet', credentials: 'private-token', report: { audit: 'private-audit' },
      tenant_id: tenant.id, google_subject: session.subject, email: session.email,
    }] : [] }));
    const response = await get('?jobId=private-job');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(projected);
    expect(body).not.toContain('private');
    expect(body).not.toContain(tenant.id);
  });

  it.each(['private-secret', 'ACTIVE\n', {}, 1, undefined])('refuses unexpected persisted status instead of leaking it', async status => {
    query.mockImplementation(async config => ({ rows: config.text.includes('public.migration_jobs') ? [{ status }] : [] }));
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'JOB_STATUS_UNAVAILABLE' });
  });

  it('GET only SELECTs data inside a bounded READ ONLY transaction and rolls back', async () => {
    await get();
    const configs = query.mock.calls.map(([config]) => config);
    expect(configs[0].text).toBe('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    expect(configs.at(-1)?.text).toBe('ROLLBACK');
    expect(configs.some(config => config.text.includes("set_config('app.tenant_id', $1, true)"))).toBe(true);
    expect(configs.some(config => config.text.includes('statement_timeout'))).toBe(true);
    expect(configs.some(config => config.text.includes('lock_timeout'))).toBe(true);
    for (const config of configs) {
      expect(config).toMatchObject({ query_timeout: 2000 });
      expect(config.text.trimStart()).toMatch(/^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/);
      expect(config.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT|FOR UPDATE)\b/);
    }
  });
});
