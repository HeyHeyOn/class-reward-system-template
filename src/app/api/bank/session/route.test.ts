// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { STUDENT_BANK_SESSION_COOKIE } from '@/server/studentBankSession';
import { resolveStudentQrForCurrentTenant, StudentQrConfigurationError, StudentQrValidationError } from '@/server/studentQr';
import { createTenantApiDispatcher } from '@/server/tenantApiDispatcher';
import type { TenantRecord } from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { DELETE, GET, POST } from './route';

vi.mock('server-only', () => ({}));
vi.mock('@/server/repositories/configuredStudentBank', () => ({ createConfiguredStudentBankReader: vi.fn(), STUDENT_BANK_TRANSACTION_LIMIT: 100 }));
vi.mock('@/server/studentQr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/studentQr')>()), resolveStudentQrForCurrentTenant: vi.fn(),
}));

const TENANT_A: TenantRecord = { id: '11111111-1111-4111-8111-111111111111', slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const TENANT_B: TenantRecord = { id: '22222222-2222-4222-8222-222222222222', slug: 'class-b', displayName: 'B', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const ACTIVE = { studentId: 'S001', name: '김민준', balance: 120, status: 'ACTIVE' as const };

const confirmStudent = vi.fn();
const getTransactions = vi.fn();

function inClass<T>(tenant: TenantRecord, run: () => T): T {
  return runWithTrustedTenantRequestContext({ tenant }, run);
}

function loginRequest(body: unknown, init: { url?: string; contentType?: string } = {}) {
  return new Request(init.url ?? 'https://example.test/api/bank/session', {
    method: 'POST', headers: { 'content-type': init.contentType ?? 'application/json' }, body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const value = header.split(';', 1)[0];
  expect(value.startsWith(`${STUDENT_BANK_SESSION_COOKIE}=`)).toBe(true);
  return value;
}

async function loginAs(tenant = TENANT_A) {
  const response = await inClass(tenant, () => POST(loginRequest({ studentQr: 'csq1.signed-card' })));
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

function meRequest(cookie?: string) {
  return new Request('https://example.test/api/bank/session', cookie ? { headers: { cookie } } : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 'route-test-secret-that-is-long-enough-123');
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.mocked(resolveStudentQrForCurrentTenant).mockResolvedValue({ studentId: 'S001', format: 'SIGNED' });
  confirmStudent.mockResolvedValue({ status: 'FOUND', student: ACTIVE });
  vi.mocked(createConfiguredStudentBankReader).mockResolvedValue({ confirmStudent, getTransactions });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('POST /api/bank/session (login)', () => {
  it('logs in with the QR from the body and sets a class-scoped session cookie', async () => {
    const request = loginRequest({ studentQr: '  csq1.signed-card  ' });
    const response = await inClass(TENANT_A, () => POST(request));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ student: { studentId: 'S001', name: '김민준', balance: 120 } });
    expect(typeof body.session.expiresAt).toBe('string');
    expect(resolveStudentQrForCurrentTenant).toHaveBeenCalledWith('csq1.signed-card');
    expect(confirmStudent).toHaveBeenCalledWith('S001');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/c/class-a/bank');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).not.toContain('csq1');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it.each([
    [{ studentQr: 'S001', studentId: 'S002' }],
    [{ studentId: 'S001' }],
    [{ studentQr: '' }],
    [{ studentQr: 7 }],
    [{ studentQr: 'x'.repeat(513) }],
    [['S001']],
  ])('rejects malformed login bodies before any lookup: %j', async (body) => {
    const response = await inClass(TENANT_A, () => POST(loginRequest(body)));
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(resolveStudentQrForCurrentTenant).not.toHaveBeenCalled();
    expect(createConfiguredStudentBankReader).not.toHaveBeenCalled();
  });

  it('never accepts the QR in the URL', async () => {
    const response = await inClass(TENANT_A, () => POST(loginRequest({ studentQr: 'S001' }, { url: 'https://example.test/api/bank/session?studentQr=S001' })));
    expect(response.status).toBe(400);
    const nonJson = await inClass(TENANT_A, () => POST(loginRequest({ studentQr: 'S001' }, { contentType: 'text/plain' })));
    expect(nonJson.status).toBe(400);
  });

  it('answers an unknown, foreign or invalid QR with a friendly not-found', async () => {
    vi.mocked(resolveStudentQrForCurrentTenant).mockImplementation(() => { throw new StudentQrValidationError(); });
    const response = await inClass(TENANT_A, () => POST(loginRequest({ studentQr: 'csq1.other-class' })));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '등록된 학생 QR 코드가 아니에요. 다시 확인해 주세요.', code: 'STUDENT_NOT_FOUND' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('turns a broken signed-QR key configuration into a friendly message instead of a crash', async () => {
    vi.mocked(resolveStudentQrForCurrentTenant).mockImplementation(() => { throw new StudentQrConfigurationError('KEYS_JSON'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await inClass(TENANT_A, () => POST(loginRequest({ studentQr: 'csq1.signed-card' })));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'QR을 확인할 수 없어요. 선생님께 알려 주세요.', code: 'QR_UNAVAILABLE' });
    expect(log).toHaveBeenCalledWith('[student-qr] signing configuration invalid', 'KEYS_JSON');
    expect(JSON.stringify(log.mock.calls)).not.toContain('csq1');
    log.mockRestore();
  });

  it.each([[{ status: 'NOT_FOUND' }], [{ status: 'INACTIVE' }]])('refuses a missing or inactive student: %j', async (lookup) => {
    confirmStudent.mockResolvedValue(lookup);
    const response = await inClass(TENANT_A, () => POST(loginRequest({ studentQr: 'S001' })));
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses to log in without a usable AUTH_SECRET', async () => {
    vi.stubEnv('AUTH_SECRET', '');
    const response = await inClass(TENANT_A, () => POST(loginRequest({ studentQr: 'S001' })));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('BANK_SESSION_UNAVAILABLE');
    expect(resolveStudentQrForCurrentTenant).not.toHaveBeenCalled();
  });

  it('refuses PostgreSQL requests that did not come through a class URL', async () => {
    const response = await POST(loginRequest({ studentQr: 'S001' }));
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /api/bank/session (me)', () => {
  it('returns the logged-in student with a fresh balance', async () => {
    const cookie = await loginAs();
    confirmStudent.mockResolvedValue({ status: 'FOUND', student: { ...ACTIVE, balance: 150 } });
    const response = await inClass(TENANT_A, () => GET(meRequest(cookie)));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ student: { studentId: 'S001', name: '김민준', balance: 150 } });
    expect(confirmStudent).toHaveBeenLastCalledWith('S001');
  });

  it('requires a session and never reads data without one', async () => {
    const response = await inClass(TENANT_A, () => GET(meRequest()));
    expect(response.status).toBe(401);
    expect(createConfiguredStudentBankReader).not.toHaveBeenCalled();
  });

  it('rejects and clears a tampered cookie', async () => {
    const cookie = await loginAs();
    const tampered = `${cookie.slice(0, -2)}${cookie.endsWith('AA') ? 'BB' : 'AA'}`;
    vi.mocked(createConfiguredStudentBankReader).mockClear();
    const response = await inClass(TENANT_A, () => GET(meRequest(tampered)));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(createConfiguredStudentBankReader).not.toHaveBeenCalled();
  });

  it('rejects a cookie from another class', async () => {
    const cookie = await loginAs(TENANT_A);
    const response = await inClass(TENANT_B, () => GET(meRequest(cookie)));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Path=/api/c/class-b/bank; Max-Age=0');
  });

  it('expires after seven days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const cookie = await loginAs();
    vi.setSystemTime(new Date('2026-10-07T23:59:00.000Z'));
    expect((await inClass(TENANT_A, () => GET(meRequest(cookie)))).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    expect((await inClass(TENANT_A, () => GET(meRequest(cookie)))).status).toBe(401);
  });

  it('logs out a student who was deactivated after logging in', async () => {
    const cookie = await loginAs();
    confirmStudent.mockResolvedValue({ status: 'INACTIVE' });
    const response = await inClass(TENANT_A, () => GET(meRequest(cookie)));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('keeps the session through a temporary data failure', async () => {
    const cookie = await loginAs();
    confirmStudent.mockRejectedValue(new Error('database down'));
    const response = await inClass(TENANT_A, () => GET(meRequest(cookie)));
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(JSON.stringify(await response.json())).not.toContain('database down');
  });
});

describe('DELETE /api/bank/session (logout)', () => {
  it('clears the class-scoped cookie even without a valid session', async () => {
    const response = await inClass(TENANT_A, () => DELETE(new Request('https://example.test/api/bank/session', { method: 'DELETE' })));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toMatch(/^class_store_bank_session=; Path=\/api\/c\/class-a\/bank; Max-Age=0;/);
  });
});

describe('through the tenant dispatcher', () => {
  const dispatch = createTenantApiDispatcher({
    findBySlug: async (slug) => (slug === 'class-a' ? TENANT_A : slug === 'class-b' ? TENANT_B : null),
    getSession: async () => null,
    findByTenantAndSubject: async () => null,
  }, [
    { method: 'POST', pattern: 'bank/session', access: 'public', handler: (request) => POST(request) },
    { method: 'GET', pattern: 'bank/session', access: 'public', handler: (request) => GET(request) },
  ]);

  it('binds the session to the class in the URL, not to anything the client sends', async () => {
    const login = await dispatch(new Request('https://example.test/api/c/class-a/bank/session', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT_B.id }, body: JSON.stringify({ studentQr: 'S001' }),
    }), { slug: 'class-a', path: ['bank', 'session'] });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);

    const sameClass = await dispatch(new Request('https://example.test/api/c/class-a/bank/session', { headers: { cookie } }),
      { slug: 'class-a', path: ['bank', 'session'] });
    expect(sameClass.status).toBe(200);

    const otherClass = await dispatch(new Request('https://example.test/api/c/class-b/bank/session', { headers: { cookie } }),
      { slug: 'class-b', path: ['bank', 'session'] });
    expect(otherClass.status).toBe(401);
  });
});
