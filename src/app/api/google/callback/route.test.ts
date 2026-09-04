import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasGeneratorState: vi.fn(() => false),
  consumeGeneratorState: vi.fn(() => ({
    purpose: 'generator' as const,
    state: 'state-123',
    subject: 'google-subject-123',
    email: 'teacher@example.com',
    clientFingerprint: 'a'.repeat(64),
    issuedAt: Date.now(),
  })),
  consumeGoogleState: vi.fn(() => true),
  exchangeGrant: vi.fn(async () => ({
    purpose: 'generator' as const,
    subject: 'google-subject-123',
    email: 'teacher@example.com',
    refreshToken: 'consenting-user-refresh-token',
    grantId: 'grant-id-that-is-at-least-thirty-two-characters',
    expiresAt: Date.now() + 600_000,
    clientFingerprint: 'a'.repeat(64),
    issuedAt: Date.now(),
  })),
  exchangeSession: vi.fn(async () => ({ subject: 'google-subject-123', email: 'teacher@example.com', issuedAt: Date.now() })),
  getSession: vi.fn(() => ({ subject: 'google-subject-123', email: 'teacher@example.com', issuedAt: Date.now() })),
  setGrant: vi.fn(),
  revokeGrant: vi.fn(async () => undefined),
  setSession: vi.fn(),
}));

vi.mock('@/server/googleOAuth', () => ({
  hasGeneratorConsentStateCookie: mocks.hasGeneratorState,
  consumeGeneratorConsentStateCookie: mocks.consumeGeneratorState,
  consumeGoogleStateCookie: mocks.consumeGoogleState,
  exchangeGoogleCodeForGeneratorGrant: mocks.exchangeGrant,
  exchangeGoogleCodeForSession: mocks.exchangeSession,
  getGoogleSessionFromRequest: mocks.getSession,
  setGeneratorGrantCookie: mocks.setGrant,
  revokeGeneratorGrant: mocks.revokeGrant,
  setGoogleSessionCookie: mocks.setSession,
}));

import { GET } from './route';

describe('GET /api/google/callback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.hasGeneratorState.mockReset();
    mocks.hasGeneratorState.mockReturnValue(false);
    mocks.consumeGeneratorState.mockClear();
    mocks.consumeGoogleState.mockClear();
    mocks.exchangeGrant.mockClear();
    mocks.exchangeSession.mockClear();
    mocks.getSession.mockClear();
    mocks.setGrant.mockClear();
    mocks.revokeGrant.mockClear();
    mocks.setSession.mockClear();
  });

  it('returns generator users to the generator page after ordinary identity OAuth', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/callback?code=ok&state=state-123'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://class-store-generator.vercel.app/admin/generator?step=google');
    expect(mocks.setSession).toHaveBeenCalledOnce();
    expect(mocks.setGrant).not.toHaveBeenCalled();
  });

  it('binds generator consent to the existing identity without replacing the ordinary session', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    mocks.hasGeneratorState.mockReturnValueOnce(true);

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/callback?code=authorization-code&state=state-123'));

    expect(response.headers.get('location')).toBe('https://class-store-generator.vercel.app/admin/generator?step=google');
    expect(mocks.exchangeGrant).toHaveBeenCalledWith('https://class-store-generator.vercel.app', 'authorization-code', expect.objectContaining({
      subject: 'google-subject-123',
      email: 'teacher@example.com',
    }));
    expect(mocks.setGrant).toHaveBeenCalledOnce();
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(response.headers.get('location')).not.toMatch(/code|refresh|token/i);
  });

  it('rejects generator consent when the initiating identity session changed', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    mocks.hasGeneratorState.mockReturnValueOnce(true);
    mocks.getSession.mockReturnValueOnce({ subject: 'different-subject', email: 'teacher@example.com', issuedAt: Date.now() });

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/callback?code=authorization-code&state=state-123'));

    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('세션이 변경');
    expect(mocks.exchangeGrant).not.toHaveBeenCalled();
    expect(mocks.setGrant).not.toHaveBeenCalled();
  });

  it('revokes an issued generator grant when its encrypted cookie cannot be stored', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    mocks.hasGeneratorState.mockReturnValueOnce(true);
    mocks.setGrant.mockImplementationOnce(() => { throw new Error('cookie encryption failed'); });

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/callback?code=authorization-code&state=state-123'));

    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('cookie encryption failed');
    expect(mocks.revokeGrant).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'consenting-user-refresh-token' }));
  });

  it('returns system users to the admin center after Google OAuth', async () => {
    const response = await GET(new Request('https://teacher-app.vercel.app/api/google/callback?code=ok&state=state-123'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://teacher-app.vercel.app/admin');
  });
});
