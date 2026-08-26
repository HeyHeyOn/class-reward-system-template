import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { POST } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));

describe('/api/admin/login', () => {
  const originalAuthSecret = process.env.AUTH_SECRET;
  const originalAdminPassword = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = 'session-signing-secret';
    delete process.env.ADMIN_PASSWORD;
  });

  afterEach(() => {
    if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalAuthSecret;
    if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalAdminPassword;
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
});
