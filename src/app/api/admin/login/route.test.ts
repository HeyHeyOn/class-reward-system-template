import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { POST } from './route';
import * as route from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('server-only', () => ({}));

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

  it('exports only the POST route handler', () => {
    expect(Object.keys(route)).toEqual(['POST']);
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

  it.each([
    ['an environment password (central)', null, { password: 'legacy-global-password' }],
    ['a class password', tenant, { kind: 'password', value: 'top-secret' }],
    ['a class admin QR', tenant, { kind: 'qr', value: 'class-store-admin:top-secret' }],
    ['a malformed body', tenant, { value: 'top-secret' }],
  ] as const)('refuses %s in PostgreSQL mode: class administrators sign in with Google only', async (_label, scope, body) => {
    process.env.CLASS_STORE_STORAGE = 'postgresql';
    process.env.ADMIN_PASSWORD = 'legacy-global-password';
    const request = new Request('https://example.test/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const response = scope ? await runWithTrustedTenantRequestContext({ tenant: scope }, () => POST(request)) : await POST(request);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: '학급 관리자는 Google 계정으로 로그인해 주세요.', code: 'GOOGLE_LOGIN_REQUIRED' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
  });
});
