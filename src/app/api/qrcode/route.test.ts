import * as QRCode from 'qrcode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredStudentReader } from '@/server/repositories/configuredStudents';
import { resolveStudentQr } from '@/server/studentQr';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { GET, POST } from './route';

vi.mock('qrcode', () => ({ toString: vi.fn() }));
vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/repositories/configuredStudents', () => ({ createConfiguredStudentReader: vi.fn() }));

const tenant = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'alpha', displayName: 'Alpha',
  lifecycle: 'ACTIVE' as const, timezone: 'Asia/Seoul' as const,
};
const activeStudent = { studentId: 'S001', name: 'Kim', balance: 0, status: 'ACTIVE' as const };

function post(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/qrcode', {
    method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(body),
  });
}

describe('POST /api/qrcode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STUDENT_QR_ACTIVE_KEY_ID = 'current';
    process.env.STUDENT_QR_SIGNING_KEYS = JSON.stringify({ current: Buffer.alloc(32, 7).toString('base64url') });
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(QRCode.toString as unknown as () => Promise<string>).mockResolvedValue('<svg>QR</svg>');
  });

  it('rejects GET entirely so QR values can never enter a query string', async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('authenticates and resolves an active student before signing in current tenant context', async () => {
    const reader = { getStudentById: vi.fn(async () => activeStudent) };
    vi.mocked(createConfiguredStudentReader).mockResolvedValue(reader as never);
    const request = post({ kind: 'student', studentId: 'S001' });

    const response = await runWithTrustedTenantRequestContext({ tenant }, () => POST(request));

    expect(isAuthorizedAdminRequest).toHaveBeenCalledWith(request);
    expect(createConfiguredStudentReader).toHaveBeenCalledOnce();
    expect(reader.getStudentById).toHaveBeenCalledExactlyOnceWith('S001');
    expect(response.status).toBe(200);
    const encoded = vi.mocked(QRCode.toString).mock.calls[0][0] as string;
    expect(encoded).toMatch(/^csq1\.current\./);
    expect(encoded).not.toContain('S001');
    expect(resolveStudentQr(encoded, tenant.id)).toEqual({ studentId: 'S001', format: 'SIGNED' });
  });

  it.each([
    ['missing', null],
    ['inactive', { ...activeStudent, status: 'INACTIVE' }],
  ])('rejects a %s student nondisclosing and never signs it', async (_label, found) => {
    const reader = { getStudentById: vi.fn(async () => found) };
    vi.mocked(createConfiguredStudentReader).mockResolvedValue(reader as never);
    const response = await runWithTrustedTenantRequestContext({ tenant }, () => POST(post({ kind: 'student', studentId: 'S001' })));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'QR 코드를 생성하지 못했습니다.' });
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('does not fall back or sign when current tenant repository lookup fails', async () => {
    const reader = { getStudentById: vi.fn(async () => { throw new Error('cross tenant unavailable'); }) };
    vi.mocked(createConfiguredStudentReader).mockResolvedValue(reader as never);
    const response = await runWithTrustedTenantRequestContext({ tenant }, () => POST(post({ kind: 'student', studentId: 'SAME-ID' })));
    expect(response.status).toBe(404);
    expect(createConfiguredStudentReader).toHaveBeenCalledOnce();
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('supports authenticated Sheets student generation only after configured-reader resolution', async () => {
    const reader = { getStudentById: vi.fn(async () => activeStudent) };
    vi.mocked(createConfiguredStudentReader).mockResolvedValue(reader as never);
    const response = await POST(post({ kind: 'student', studentId: 'S001' }));
    expect(response.status).toBe(200);
    expect(reader.getStudentById).toHaveBeenCalledExactlyOnceWith('S001');
    expect(QRCode.toString).toHaveBeenCalledWith('S001', expect.any(Object));
  });

  it('generates an authenticated admin credential from body only', async () => {
    const request = post({ kind: 'admin', password: 'top-secret' });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(isAuthorizedAdminRequest).toHaveBeenCalledWith(request);
    expect(QRCode.toString).toHaveBeenCalledWith('class-store-admin:top-secret', expect.any(Object));
    expect(request.url).toBe('http://localhost/api/qrcode');
  });

  it.each([
    [{ kind: 'student', studentId: 'S001', extra: true }, 'application/json'],
    [{ kind: 'admin', password: 'secret', extra: true }, 'application/json'],
    [{ kind: 'anything', value: 'secret' }, 'application/json'],
    [{ kind: 'student', studentId: 'S001' }, 'text/plain'],
  ])('rejects non-exact bodies and media types', async (body, contentType) => {
    const response = await POST(post(body, contentType));
    expect(response.status).toBe(400);
    expect(createConfiguredStudentReader).not.toHaveBeenCalled();
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('requires admin authentication before parsing or resolving', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await POST(post({ kind: 'student', studentId: 'S001' }));
    expect(response.status).toBe(401);
    expect(createConfiguredStudentReader).not.toHaveBeenCalled();
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('rejects every query-bearing POST before authentication or body processing', async () => {
    const request = new Request('http://localhost/api/qrcode?password=top-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'admin', password: 'top-secret' }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(isAuthorizedAdminRequest).not.toHaveBeenCalled();
    expect(QRCode.toString).not.toHaveBeenCalled();
  });
});
