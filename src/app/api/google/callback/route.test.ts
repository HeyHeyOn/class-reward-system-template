import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/googleOAuth', () => ({
  consumeGoogleStateCookie: vi.fn(() => true),
  exchangeGoogleCodeForSession: vi.fn(async () => ({ email: 'teacher@example.com', refreshToken: 'refresh-token', issuedAt: Date.now() })),
  setGoogleSessionCookie: vi.fn(),
}));

import { GET } from './route';

describe('GET /api/google/callback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns generator users to the generator page after Google OAuth', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

    const response = await GET(new Request('https://class-store-generator.vercel.app/api/google/callback?code=ok&state=state-123'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(307);
    expect(location).toBe('https://class-store-generator.vercel.app/admin/generator');
  });

  it('returns system users to the admin center after Google OAuth', async () => {
    const response = await GET(new Request('https://teacher-app.vercel.app/api/google/callback?code=ok&state=state-123'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(307);
    expect(location).toBe('https://teacher-app.vercel.app/admin');
  });
});
