import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import {
  GOOGLE_AUTH_COOKIE,
  consumeGoogleStateCookie,
  createGoogleAuthUrl,
  exchangeGoogleCodeForGeneratorGrant,
  getGoogleSessionFromRequest,
  setGoogleStateCookie,
  setGoogleSessionCookie,
} from '@/server/googleOAuth';

const env = {
  AUTH_SECRET: 'test-auth-secret',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GENERATOR_GOOGLE_CLIENT_ID: 'generator-client-id.apps.googleusercontent.com',
  GENERATOR_GOOGLE_CLIENT_SECRET: 'generator-client-secret',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('ordinary Google identity OAuth', () => {
  it('binds and consumes only the exact classes return target with the OAuth state', () => {
    const issued = NextResponse.json({ ok: true });
    setGoogleStateCookie(issued, 'state-123', '/classes');
    const cookie = /class_store_google_state=([^;]+)/.exec(issued.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const consumed = NextResponse.json({ ok: true });

    expect(consumeGoogleStateCookie(new Request('https://class-store.example/api/google/callback', {
      headers: { cookie: `class_store_google_state=${cookie}` },
    }), consumed, 'state-123')).toEqual({ state: 'state-123', returnTo: '/classes' });

    const tampered = encodeURIComponent(JSON.stringify({ state: 'state-123', returnTo: 'https://evil.example' }));
    expect(consumeGoogleStateCookie(new Request('https://class-store.example/api/google/callback', {
      headers: { cookie: `class_store_google_state=${tampered}` },
    }), NextResponse.json({ ok: true }), 'state-123')).toBeNull();
  });

  it('requests exactly the identity scopes without offline or forced consent options', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET);

    const url = new URL(createGoogleAuthUrl('https://class-store.example', 'login-state'));

    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', 'profile']);
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.get('state')).toBe('login-state');
    expect(url.searchParams.get('redirect_uri')).toBe('https://class-store.example/api/google/callback');
    expect(url.toString()).not.toMatch(/spreadsheets|drive/i);
  });

  it('stores an identity-only 30-day session with no Sheets refresh token', () => {
    vi.stubEnv('AUTH_SECRET', env.AUTH_SECRET);
    const response = NextResponse.json({ ok: true });

    setGoogleSessionCookie(response, {
      subject: 'google-subject-123',
      email: 'teacher@example.com',
      name: 'Teacher',
      issuedAt: Date.now(),
    });

    const setCookie = response.headers.get('set-cookie') ?? '';
    const value = /class_store_google_auth=([^;]+)/.exec(setCookie)?.[1] ?? '';
    const request = new Request('https://class-store.example/api/google/session', {
      headers: { cookie: `${GOOGLE_AUTH_COOKIE}=${value}` },
    });
    const session = getGoogleSessionFromRequest(request, env);

    expect(session).toEqual(expect.objectContaining({
      subject: 'google-subject-123',
      email: 'teacher@example.com',
      name: 'Teacher',
    }));
    expect(session).not.toHaveProperty('refreshToken');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=lax');
    expect(setCookie).toContain('Path=/');
  });

  it('rejects identity cookies with duplicate or trailing encrypted segments', () => {
    vi.stubEnv('AUTH_SECRET', env.AUTH_SECRET);
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.json({ ok: true });
    setGoogleSessionCookie(response, {
      subject: 'google-subject-123',
      email: 'teacher@example.com',
      issuedAt: Date.now(),
    });
    const header = response.headers.get('set-cookie') ?? '';
    const cookie = new RegExp(`${GOOGLE_AUTH_COOKIE}=([^;]+)`).exec(header)?.[1] ?? '';
    const request = new Request('https://class-store.example/api/google/session', {
      headers: { cookie: `${GOOGLE_AUTH_COOKIE}=${cookie}.extra` },
    });

    expect(getGoogleSessionFromRequest(request, env)).toBeNull();
  });

  it('does not revive refresh-token-bearing legacy login cookies as ordinary identity sessions', () => {
    const issuedAt = Date.now();
    const iv = randomBytes(12);
    const key = createHash('sha256').update(env.AUTH_SECRET).digest();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify({
      email: 'teacher@example.com',
      refreshToken: 'legacy-sheets-refresh-token',
      issuedAt,
    }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const cookie = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');

    const request = new Request('https://class-store.example/api/google/session', {
      headers: { cookie: `${GOOGLE_AUTH_COOKIE}=${cookie}` },
    });

    expect(getGoogleSessionFromRequest(request, env)).toBeNull();
  });

  it.each([
    [{ id: 'different-subject', email: 'teacher@example.com', verified_email: true }, /계정/],
    [{ id: 'google-subject-123', email: 'teacher@example.com', verified_email: false }, /확인되지 않은/],
  ])('rejects switched or unverified Google accounts during generator consent', async (profile, message) => {
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', env.GENERATOR_GOOGLE_CLIENT_ID);
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_SECRET', env.GENERATOR_GOOGLE_CLIENT_SECRET);
    vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({
      tokens: { refresh_token: 'consenting-user-refresh-token', access_token: 'access-token' },
      res: null,
    } as never);
    const revokeToken = vi.spyOn(google.auth.OAuth2.prototype, 'revokeToken').mockResolvedValue(undefined as never);
    vi.spyOn(google, 'oauth2').mockReturnValue({
      userinfo: { get: vi.fn(async () => ({ data: profile })) },
    } as unknown as ReturnType<typeof google.oauth2>);

    await expect(exchangeGoogleCodeForGeneratorGrant('https://generator.example', 'authorization-code', {
      purpose: 'generator',
      state: 'opaque-state',
      subject: 'google-subject-123',
      email: 'teacher@example.com',
      clientFingerprint: createHash('sha256').update(env.GENERATOR_GOOGLE_CLIENT_ID).digest('hex'),
      issuedAt: Date.now(),
    })).rejects.toThrow(message);
    expect(revokeToken).toHaveBeenCalledWith('consenting-user-refresh-token');
  });

  it.each([
    [{ access_token: 'access-only-token' }, 'access-only-token'],
    [{ refresh_token: 'x'.repeat(4097), access_token: 'fallback-access-token' }, 'x'.repeat(4097)],
  ])('revokes the best available token and clears credentials when refresh token validation fails', async (tokens, expectedTarget) => {
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', env.GENERATOR_GOOGLE_CLIENT_ID);
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_SECRET', env.GENERATOR_GOOGLE_CLIENT_SECRET);
    vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({ tokens, res: null } as never);
    const setCredentials = vi.spyOn(google.auth.OAuth2.prototype, 'setCredentials');
    const revokeToken = vi.spyOn(google.auth.OAuth2.prototype, 'revokeToken').mockResolvedValue(undefined as never);

    await expect(exchangeGoogleCodeForGeneratorGrant('https://generator.example', 'authorization-code', {
      purpose: 'generator', state: 'opaque-state', subject: 'google-subject-123', email: 'teacher@example.com',
      clientFingerprint: createHash('sha256').update(env.GENERATOR_GOOGLE_CLIENT_ID).digest('hex'), issuedAt: Date.now(),
    })).rejects.toThrow(/refresh token/);

    expect(revokeToken).toHaveBeenCalledWith(expectedTarget);
    expect(setCredentials).toHaveBeenLastCalledWith({});
  });

  it('preserves the token validation error when revocation fails', async () => {
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', env.GENERATOR_GOOGLE_CLIENT_ID);
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_SECRET', env.GENERATOR_GOOGLE_CLIENT_SECRET);
    vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockResolvedValue({ tokens: { access_token: 'access-only-token' }, res: null } as never);
    vi.spyOn(google.auth.OAuth2.prototype, 'revokeToken').mockRejectedValue(new Error('revoke failed'));

    await expect(exchangeGoogleCodeForGeneratorGrant('https://generator.example', 'authorization-code', {
      purpose: 'generator', state: 'opaque-state', subject: 'google-subject-123', email: 'teacher@example.com',
      clientFingerprint: createHash('sha256').update(env.GENERATOR_GOOGLE_CLIENT_ID).digest('hex'), issuedAt: Date.now(),
    })).rejects.toThrow(/refresh token/);
  });
});
