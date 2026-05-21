import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/googleOAuth', () => ({
  createGoogleAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fexample.vercel.app%2Fapi%2Fgoogle%2Fcallback'),
  makeState: vi.fn(() => 'state-123'),
  setGoogleStateCookie: vi.fn(),
}));

import { GET } from './route';

describe('GET /api/google/login', () => {
  afterEach(() => {
    delete process.env.GOOGLE_REFRESH_TOKEN;
  });

  it('does not start OAuth in self-deployed apps that already have a Sheets refresh token', async () => {
    process.env.GOOGLE_REFRESH_TOKEN = 'stored-refresh-token';

    const response = await GET(new Request('https://teacher-app.vercel.app/api/google/login'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(307);
    expect(location).toContain('/admin/login?error=');
    expect(decodeURIComponent(location)).toContain('관리자 비밀번호 또는 관리자 QR');
    expect(location).not.toContain('accounts.google.com');
  });
});
