// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TenantRecord } from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import {
  authenticateStudentBankRequest,
  clearedStudentBankSessionCookie,
  confirmStudentBankStudent,
  createStudentBankSession,
  isStudentBankSessionConfigured,
  openStudentBankSession,
  readStudentBankSession,
  resolveStudentBankScope,
  sealStudentBankSession,
  STUDENT_BANK_SESSION_COOKIE,
  STUDENT_BANK_SESSION_LIFETIME_SECONDS,
  studentBankSessionCookie,
  StudentBankSessionConfigurationError,
  type StudentBankScope,
} from './studentBankSession';

vi.mock('server-only', () => ({}));

const ENV = { AUTH_SECRET: 'test-secret-that-is-long-enough-0123456789', CLASS_STORE_STORAGE: 'postgresql', NODE_ENV: 'test' };
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SCOPE_A: StudentBankScope = { tenantId: TENANT_A, cookiePath: '/api/c/class-a/bank' };
const SCOPE_B: StudentBankScope = { tenantId: TENANT_B, cookiePath: '/api/c/class-b/bank' };
const NOW = Date.UTC(2026, 9, 6, 1, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function tenant(id: string, slug: string): TenantRecord {
  return { id, slug, displayName: slug, lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
}

function sealed(scope = SCOPE_A, studentId = 'S001', now = NOW) {
  return sealStudentBankSession(createStudentBankSession(scope, studentId, now), ENV);
}

function requestWithCookie(value: string) {
  return new Request('https://example.test/api/bank/session', { headers: { cookie: `other=1; ${STUDENT_BANK_SESSION_COOKIE}=${value}` } });
}

function flipCharacter(value: string, index: number) {
  const replacement = value[index] === 'A' ? 'B' : 'A';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

describe('student bank session cookie', () => {
  it('round-trips an authentic session bound to one class for seven days', () => {
    const value = sealed();
    expect(value.split('.')).toHaveLength(4);
    expect(value).not.toContain('S001');
    expect(openStudentBankSession(value, SCOPE_A, ENV, NOW + DAY)).toEqual({
      tenantId: TENANT_A, studentId: 'S001', issuedAt: NOW, expiresAt: NOW + 7 * DAY,
    });
    expect(STUDENT_BANK_SESSION_LIFETIME_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it('rejects any tampering with version, IV, tag or ciphertext', () => {
    const value = sealed();
    const [version, iv, tag, ciphertext] = value.split('.');
    const tampered = [
      ['bs2', iv, tag, ciphertext].join('.'),
      [version, flipCharacter(iv, 2), tag, ciphertext].join('.'),
      [version, iv, flipCharacter(tag, 3), ciphertext].join('.'),
      [version, iv, tag, flipCharacter(ciphertext, 5)].join('.'),
      [version, iv, tag, `${ciphertext}AA`].join('.'),
      `${value}.extra`,
      '',
      'not-a-cookie',
    ];
    for (const candidate of tampered) expect(openStudentBankSession(candidate, SCOPE_A, ENV, NOW)).toBeNull();
  });

  it('rejects a cookie issued for another class', () => {
    expect(openStudentBankSession(sealed(SCOPE_B), SCOPE_A, ENV, NOW)).toBeNull();
    expect(openStudentBankSession(sealed(SCOPE_A), { tenantId: null, cookiePath: '/api/bank' }, ENV, NOW)).toBeNull();
  });

  it('expires exactly at seven days and refuses sessions issued in the future', () => {
    const value = sealed();
    expect(openStudentBankSession(value, SCOPE_A, ENV, NOW + 7 * DAY - 1)).not.toBeNull();
    expect(openStudentBankSession(value, SCOPE_A, ENV, NOW + 7 * DAY)).toBeNull();
    expect(openStudentBankSession(value, SCOPE_A, ENV, NOW - 60 * 60 * 1000)).toBeNull();
  });

  it('rejects cookies sealed with a different AUTH_SECRET and refuses to seal without a strong secret', () => {
    const value = sealed();
    expect(openStudentBankSession(value, SCOPE_A, { ...ENV, AUTH_SECRET: 'another-secret-that-is-long-enough-01' }, NOW)).toBeNull();
    expect(isStudentBankSessionConfigured({ ...ENV, AUTH_SECRET: 'short' })).toBe(false);
    expect(isStudentBankSessionConfigured(ENV)).toBe(true);
    expect(() => sealStudentBankSession(createStudentBankSession(SCOPE_A, 'S001', NOW), { ...ENV, AUTH_SECRET: '' }))
      .toThrow(StudentBankSessionConfigurationError);
  });

  it('serializes an HttpOnly, SameSite=Lax cookie scoped to the class bank API, Secure in production', () => {
    const session = createStudentBankSession(SCOPE_A, 'S001', NOW);
    const cookie = studentBankSessionCookie(session, SCOPE_A, ENV);
    expect(cookie).toMatch(new RegExp(`^${STUDENT_BANK_SESSION_COOKIE}=bs1\\.`));
    expect(cookie).toContain('Path=/api/c/class-a/bank');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    expect(studentBankSessionCookie(session, SCOPE_A, { ...ENV, NODE_ENV: 'production' })).toMatch(/; Secure$/);
    expect(STUDENT_BANK_SESSION_COOKIE).not.toBe('class_store_google_auth');
    expect(STUDENT_BANK_SESSION_COOKIE).not.toBe('class_store_admin');
    expect(clearedStudentBankSessionCookie(SCOPE_A, ENV)).toMatch(/^class_store_bank_session=; Path=\/api\/c\/class-a\/bank; Max-Age=0;/);
  });

  it('reads the first valid same-class cookie and reports invalid ones', () => {
    const valid = sealed();
    expect(readStudentBankSession(new Request('https://example.test/'), SCOPE_A, ENV, NOW)).toEqual({ status: 'NONE' });
    expect(readStudentBankSession(requestWithCookie('garbage'), SCOPE_A, ENV, NOW)).toEqual({ status: 'INVALID' });
    expect(readStudentBankSession(new Request('https://example.test/', {
      headers: { cookie: `${STUDENT_BANK_SESSION_COOKIE}=${sealed(SCOPE_B)}; ${STUDENT_BANK_SESSION_COOKIE}=${valid}` },
    }), SCOPE_A, ENV, NOW)).toMatchObject({ status: 'VALID', session: { studentId: 'S001', tenantId: TENANT_A } });
  });
});

describe('student bank scope and request authentication', () => {
  it('derives the scope from the trusted tenant context, never from the request', () => {
    expect(runWithTrustedTenantRequestContext({ tenant: tenant(TENANT_A, 'class-a') }, () => resolveStudentBankScope(ENV)))
      .toEqual(SCOPE_A);
    expect(resolveStudentBankScope(ENV)).toBeNull();
    expect(resolveStudentBankScope({ ...ENV, CLASS_STORE_STORAGE: 'sheets' })).toEqual({ tenantId: null, cookiePath: '/api/bank' });
  });

  it('accepts a valid cookie only inside its own class', () => {
    const request = requestWithCookie(sealed());
    const own = runWithTrustedTenantRequestContext({ tenant: tenant(TENANT_A, 'class-a') }, () => authenticateStudentBankRequest(request, ENV, NOW));
    expect(own).toMatchObject({ ok: true, session: { studentId: 'S001', tenantId: TENANT_A } });

    const other = runWithTrustedTenantRequestContext({ tenant: tenant(TENANT_B, 'class-b') }, () => authenticateStudentBankRequest(request, ENV, NOW));
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.response.status).toBe(401);
    expect(other.response.headers.get('set-cookie')).toContain('Path=/api/c/class-b/bank; Max-Age=0');
    expect(other.response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('asks for login without clearing anything when no cookie was sent', async () => {
    const result = runWithTrustedTenantRequestContext({ tenant: tenant(TENANT_A, 'class-a') },
      () => authenticateStudentBankRequest(new Request('https://example.test/'), ENV, NOW));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('set-cookie')).toBeNull();
    await expect(result.response.json()).resolves.toEqual({ error: '다시 로그인해 주세요.', code: 'BANK_SESSION_REQUIRED' });
  });

  it.each([
    [{ status: 'NOT_FOUND' as const }],
    [{ status: 'INACTIVE' as const }],
    [{ status: 'FOUND' as const, student: { studentId: 'S001', name: '김민준', balance: 10, status: 'INACTIVE' as const } }],
    [{ status: 'FOUND' as const, student: { studentId: 'S002', name: '다른 학생', balance: 10, status: 'ACTIVE' as const } }],
  ])('logs out a student who is no longer active (%j)', async (lookup) => {
    const session = createStudentBankSession(SCOPE_A, 'S001', NOW);
    const result = await confirmStudentBankStudent({ scope: SCOPE_A, session }, { confirmStudent: async () => lookup }, ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('reports temporary student data failures without logging out', async () => {
    const session = createStudentBankSession(SCOPE_A, 'S001', NOW);
    const result = await confirmStudentBankStudent({ scope: SCOPE_A, session }, { confirmStudent: async () => ({ status: 'UNAVAILABLE' }) }, ENV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get('set-cookie')).toBeNull();
  });
});
