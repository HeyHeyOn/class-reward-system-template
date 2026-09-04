import { afterEach, describe, expect, it, vi } from 'vitest';

const oauthMocks = vi.hoisted(() => ({
  createGoogleAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?purpose=identity'),
  createGeneratorConsentAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?purpose=generator'),
  getGoogleSessionFromRequest: vi.fn(() => ({ subject: 'google-subject-123', email: 'teacher@example.com', issuedAt: Date.now() })),
  getGeneratorGoogleClientFingerprint: vi.fn(() => 'a'.repeat(64)),
  makeState: vi.fn(() => 'state-123'),
  setGoogleStateCookie: vi.fn(),
  setGeneratorConsentStateCookie: vi.fn(),
}));

vi.mock('@/server/googleOAuth', () => oauthMocks);

import { GET } from './route';

describe('GET /api/google/login', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    oauthMocks.getGoogleSessionFromRequest.mockReset();
    oauthMocks.getGoogleSessionFromRequest.mockReturnValue({ subject: 'google-subject-123', email: 'teacher@example.com', issuedAt: Date.now() });
    oauthMocks.createGoogleAuthUrl.mockClear();
    oauthMocks.createGeneratorConsentAuthUrl.mockClear();
    oauthMocks.setGoogleStateCookie.mockClear();
    oauthMocks.setGeneratorConsentStateCookie.mockClear();
  });

  it('does not start OAuth in self-deployed system apps that already have a Sheets refresh token', async () => {
    process.env.GOOGLE_REFRESH_TOKEN = 'stored-refresh-token';

    const response = await GET(new Request('https://teacher-app.vercel.app/api/google/login'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(307);
    expect(location).toContain('/admin/login?error=');
    expect(decodeURIComponent(location)).toContain('관리자 비밀번호 또는 관리자 QR');
    expect(location).not.toContain('accounts.google.com');
  });

  it('starts OAuth in the generator web page even when it has a Sheets refresh token for creating spreadsheets', async () => {
    process.env.GOOGLE_REFRESH_TOKEN = 'generator-refresh-token';
    process.env.NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT = 'generator';

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/login'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(307);
    expect(location).toContain('accounts.google.com');
    expect(location).not.toContain('/admin/login');
    expect(oauthMocks.createGoogleAuthUrl).toHaveBeenCalledOnce();
    expect(oauthMocks.createGeneratorConsentAuthUrl).not.toHaveBeenCalled();
  });

  it('starts a separate generator consent flow bound to the authenticated identity', async () => {
    process.env.NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT = 'generator';

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/login?purpose=generator'));

    expect(response.headers.get('location')).toContain('purpose=generator');
    expect(oauthMocks.createGeneratorConsentAuthUrl).toHaveBeenCalledWith('https://class-store-generator.vercel.app', 'state-123');
    expect(oauthMocks.setGeneratorConsentStateCookie).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      purpose: 'generator',
      state: 'state-123',
      subject: 'google-subject-123',
      email: 'teacher@example.com',
      clientFingerprint: 'a'.repeat(64),
    }));
    expect(oauthMocks.setGoogleStateCookie).not.toHaveBeenCalled();
  });

  it('refuses generator consent without an already authenticated ordinary session', async () => {
    process.env.NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT = 'generator';
    oauthMocks.getGoogleSessionFromRequest.mockReturnValueOnce(null as never);

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/login?purpose=generator'));

    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('먼저 Google');
    expect(oauthMocks.createGeneratorConsentAuthUrl).not.toHaveBeenCalled();
  });
});
