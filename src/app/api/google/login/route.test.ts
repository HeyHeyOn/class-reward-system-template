import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

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

  it('sends every class sign-in to the 딴쌤 hub when DDANSSAEM_LOGIN is 1', async () => {
    vi.stubEnv('DDANSSAEM_LOGIN', '1');
    vi.stubEnv('DDANSSAEM_HUB_URL', 'https://beta.ddanssaem.com');
    vi.stubEnv('DDANSSAEM_CLIENT_SECRET', 's'.repeat(40));
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');

    const response = await GET(new Request('https://class.example/api/google/login?returnTo=%2Fclasses'));

    expect(response.headers.get('location')).toBe('https://class.example/api/auth/ddanssaem/start?next=%2Fclasses');
    expect(oauthMocks.createGoogleAuthUrl).not.toHaveBeenCalled();
  });

  it('does not start OAuth in self-deployed system apps that already have a Sheets refresh token', async () => {
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'stored-refresh-token');

    const response = await GET(new Request('https://teacher-app.vercel.app/api/google/login'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(307);
    expect(location).toContain('/admin/login?error=');
    expect(decodeURIComponent(location)).toContain('관리자 비밀번호 또는 관리자 QR');
    expect(location).not.toContain('accounts.google.com');
  });

  it('allows identity-only OAuth for class selection even when the legacy system has a Sheets refresh token', async () => {
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'stored-refresh-token');

    const response = await GET(new Request('https://teacher-app.vercel.app/api/google/login?returnTo=%2Fclasses'));

    expect(response.headers.get('location')).toContain('accounts.google.com');
    expect(oauthMocks.createGoogleAuthUrl).toHaveBeenCalledOnce();
    expect(oauthMocks.setGoogleStateCookie).toHaveBeenCalledWith(expect.anything(), 'state-123', '/classes');
  });

  it('starts OAuth in the generator web page even when it has a Sheets refresh token for creating spreadsheets', async () => {
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'generator-refresh-token');
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/login'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(307);
    expect(location).toContain('accounts.google.com');
    expect(location).not.toContain('/admin/login');
    expect(oauthMocks.createGoogleAuthUrl).toHaveBeenCalledOnce();
    expect(oauthMocks.createGeneratorConsentAuthUrl).not.toHaveBeenCalled();
  });

  it('starts a separate generator consent flow bound to the authenticated identity', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

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

  it('binds the exact classes return target to the ordinary OAuth state cookie', async () => {
    await GET(new Request('https://teacher-app.vercel.app/api/google/login?returnTo=%2Fclasses'));

    expect(oauthMocks.setGoogleStateCookie).toHaveBeenCalledWith(expect.anything(), 'state-123', '/classes');
  });

  it('does not bind an external return target', async () => {
    await GET(new Request('https://teacher-app.vercel.app/api/google/login?returnTo=https%3A%2F%2Fevil.example'));

    expect(oauthMocks.setGoogleStateCookie).toHaveBeenCalledWith(expect.anything(), 'state-123', undefined);
  });

  it('refuses generator consent without an already authenticated ordinary session', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    oauthMocks.getGoogleSessionFromRequest.mockReturnValueOnce(null as never);

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/login?purpose=generator'));

    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('먼저 Google');
    expect(oauthMocks.createGeneratorConsentAuthUrl).not.toHaveBeenCalled();
  });
});


describe('PostgreSQL identity login return paths', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('binds the original scoped admin page to OAuth state', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    await GET(new Request('https://teacher-app.vercel.app/api/google/login?returnTo=%2Fc%2Falpha-class%2Fadmin'));
    expect(oauthMocks.setGoogleStateCookie).toHaveBeenCalledWith(expect.anything(), 'state-123', '/c/alpha-class/admin');
  });

  it.each(['', '/admin', '//evil.example', 'https://evil.example', '/c/alpha-class/admin?next=evil', '/c/Alpha/admin'])('uses class selection for missing/invalid target %s', async (returnTo) => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'legacy-token');
    const response = await GET(new Request(`https://teacher-app.vercel.app/api/google/login?returnTo=${encodeURIComponent(returnTo)}`));
    expect(response.headers.get('location')).toContain('accounts.google.com');
    expect(oauthMocks.setGoogleStateCookie).toHaveBeenCalledWith(expect.anything(), 'state-123', '/classes');
  });

  it('returns initialization errors to the scoped login page', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    oauthMocks.createGoogleAuthUrl.mockImplementationOnce(() => { throw new Error('OAuth unavailable'); });
    const response = await GET(new Request('https://teacher-app.vercel.app/api/google/login?returnTo=%2Fc%2Falpha-class%2Fadmin'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/c/alpha-class/admin/login');
  });
});
