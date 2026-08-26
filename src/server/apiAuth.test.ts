import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSignedAdminSessionToken } from '@/server/adminAuth';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';

const googleEnv = {
  AUTH_SECRET: 'test-auth-secret',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
};

function googleSessionCookie(issuedAt: number): string {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(googleEnv.AUTH_SECRET).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({
    email: 'teacher@example.com',
    refreshToken: 'refresh-token',
    issuedAt,
  }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function requestWithCookie(name: string, value: string): Request {
  return new Request('https://example.com/api/products', {
    headers: { cookie: `${name}=${encodeURIComponent(value)}` },
  });
}

describe('api auth', () => {
  it('fails closed instead of throwing for malformed percent-encoded cookies', () => {
    const env = { GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret' };
    const request = new Request('https://example.com/api/products', {
      headers: { cookie: 'class_store_google_auth=%' },
    });

    expect(() => isAuthorizedAdminRequest(request, env)).not.toThrow();
    expect(isAuthorizedAdminRequest(request, env)).toBe(false);
  });

  it('allows admin API writes with password or QR login session cookie even when Google OAuth is enabled', () => {
    const token = createSignedAdminSessionToken('teacher-pin', googleEnv);
    const request = requestWithCookie('class_store_admin', token);

    expect(isAuthorizedAdminRequest(request, googleEnv)).toBe(true);
  });

  it('allows a valid encrypted Google session using the explicitly supplied auth environment', () => {
    const request = requestWithCookie('class_store_google_auth', googleSessionCookie(Date.now()));

    expect(isAuthorizedAdminRequest(request, googleEnv)).toBe(true);
  });

  it.each([
    ['forged nonempty value', 'oauth-token'],
    ['malformed encrypted value', 'v1.not-valid.not-valid.not-valid'],
  ])('rejects a %s in the Google auth cookie', (_label, value) => {
    expect(isAuthorizedAdminRequest(requestWithCookie('class_store_google_auth', value), googleEnv)).toBe(false);
  });

  it('rejects an expired encrypted Google session', () => {
    const olderThanThirtyDays = Date.now() - (30 * 24 * 60 * 60 * 1000) - 1;
    const request = requestWithCookie('class_store_google_auth', googleSessionCookie(olderThanThirtyDays));

    expect(isAuthorizedAdminRequest(request, googleEnv)).toBe(false);
  });

  it('rejects a future-dated encrypted Google session', () => {
    const request = requestWithCookie('class_store_google_auth', googleSessionCookie(Date.now() + 60_000));

    expect(isAuthorizedAdminRequest(request, googleEnv)).toBe(false);
  });

  it('rejects missing credentials when authentication is enabled', () => {
    expect(isAuthorizedAdminRequest(new Request('https://example.com/api/products'), googleEnv)).toBe(false);
  });

  it('preserves auth-disabled access when no admin or Google authentication is configured', () => {
    expect(isAuthorizedAdminRequest(new Request('https://example.com/api/products'), {})).toBe(true);
  });
});
