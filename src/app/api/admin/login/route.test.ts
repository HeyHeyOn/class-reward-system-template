import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { getProductionTenantLegacyAdminAuth } from '@/server/tenantLegacyAdminAuth';
import { POST } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/tenantLegacyAdminAuth', () => ({ getProductionTenantLegacyAdminAuth: vi.fn() }));

const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha-class', displayName: 'Alpha', lifecycle: 'ACTIVE' as const, timezone: 'Asia/Seoul' as const };

describe('/api/admin/login', () => {
  const originalAuthSecret = process.env.AUTH_SECRET;
  const originalAdminPassword = process.env.ADMIN_PASSWORD;
  const originalStorage = process.env.CLASS_STORE_STORAGE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = 'session-signing-secret';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.CLASS_STORE_STORAGE;
  });

  afterEach(() => {
    if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalAuthSecret;
    if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalAdminPassword;
    if (originalStorage === undefined) delete process.env.CLASS_STORE_STORAGE;
    else process.env.CLASS_STORE_STORAGE = originalStorage;
  });

  it.each([
    ['an empty Settings sheet', []],
    ['unrelated Settings rows', [['key', 'value'], ['appTitle', '학급 매점']]],
  ])('does not issue an admin cookie for %s', async (_description, rows) => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({
      async getRows() { return rows; },
    } as never);

    const response = await POST(new Request('http://localhost/api/admin/login', {
      method: 'POST', body: JSON.stringify({ password: 'any-candidate' }),
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not accept environment passwords in central PostgreSQL mode', async () => {
    process.env.CLASS_STORE_STORAGE = 'postgresql';
    process.env.ADMIN_PASSWORD = 'legacy-global-password';

    const response = await POST(new Request('http://localhost/api/admin/login', {
      method: 'POST', body: JSON.stringify({ password: 'legacy-global-password' }),
    }));

    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
  });

  it('accepts only strict body-only JSON in a trusted scoped tenant context and emits an opaque secure cookie', async () => {
    process.env.CLASS_STORE_STORAGE = 'postgresql';
    const login = vi.fn(async () => ({ sessionToken: 'opaque-token', credentialVersion: 2, sessionVersion: 4 }));
    vi.mocked(getProductionTenantLegacyAdminAuth).mockReturnValue({ login, verifySession: vi.fn() } as never);
    const credential = 'class-store-admin:top-secret';
    const request = new Request(`https://example.test/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'qr', value: credential }),
    });

    const response = await runWithTrustedTenantRequestContext({ tenant }, () => POST(request));

    expect(response.status).toBe(200);
    expect(login).toHaveBeenCalledWith({ kind: 'qr', value: credential });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('class_store_tenant_admin=opaque-token');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).not.toContain('top-secret');
    expect(await response.text()).not.toContain('top-secret');
  });

  it.each([
    ['query credential', 'https://example.test/api/admin/login?password=top-secret', { kind: 'password', value: 'top-secret' }, 'application/json'],
    ['missing field', 'https://example.test/api/admin/login', { value: 'top-secret' }, 'application/json'],
    ['smuggled field', 'https://example.test/api/admin/login', { kind: 'password', value: 'top-secret', tenantId: tenant.id }, 'application/json'],
    ['unknown kind', 'https://example.test/api/admin/login', { kind: 'recovery', value: 'top-secret' }, 'application/json'],
    ['non-JSON', 'https://example.test/api/admin/login', { kind: 'password', value: 'top-secret' }, 'text/plain'],
  ])('rejects scoped %s before credential validation', async (_label, url, body, contentType) => {
    process.env.CLASS_STORE_STORAGE = 'postgresql';
    const login = vi.fn();
    vi.mocked(getProductionTenantLegacyAdminAuth).mockReturnValue({ login, verifySession: vi.fn() } as never);
    const response = await runWithTrustedTenantRequestContext({ tenant }, () => POST(new Request(url, {
      method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body),
    })));
    expect(response.status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });
});
