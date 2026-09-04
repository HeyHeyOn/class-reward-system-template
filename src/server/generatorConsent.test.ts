import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  GENERATOR_GRANT_COOKIE,
  createGeneratorConsentAuthUrl,
  getGeneratorGrantFromRequest,
  setGeneratorConsentStateCookie,
  setGeneratorGrantCookie,
} from '@/server/googleOAuth';

const strongSecret = 'a'.repeat(32);
const generatorClientId = 'generator-client-id.apps.googleusercontent.com';
const clientFingerprint = createHash('sha256').update(generatorClientId).digest('hex');
const identity = {
  subject: 'google-subject-123',
  email: 'teacher@example.com',
  name: 'Teacher',
  issuedAt: Date.now(),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generator Google consent', () => {
  it('requests offline drive.file consent without broad Sheets or Drive scopes', () => {
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', generatorClientId);
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_SECRET', 'generator-client-secret');

    const url = new URL(createGeneratorConsentAuthUrl('https://generator.example', 'opaque-state'));
    const scopes = url.searchParams.get('scope')?.split(' ') ?? [];

    expect(scopes).toEqual(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file']);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.toString()).not.toContain('spreadsheets');
    expect(url.toString()).not.toContain('refresh_token');
  });

  it('does not authorize generator consent with legacy Google credentials alone', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'legacy-client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'legacy-client-secret');

    expect(() => createGeneratorConsentAuthUrl('https://generator.example', 'opaque-state')).toThrow(/GENERATOR_GOOGLE_CLIENT_ID/);
  });

  it('stores encrypted short-lived purpose-bound state without URL leakage', () => {
    vi.stubEnv('AUTH_SECRET', strongSecret);
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', generatorClientId);
    const response = NextResponse.json({ ok: true });

    setGeneratorConsentStateCookie(response, {
      purpose: 'generator',
      state: 'opaque-state',
      subject: identity.subject,
      email: identity.email,
      clientFingerprint,
      issuedAt: Date.now(),
    });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).toContain('Path=/api/google/callback');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).not.toContain(identity.subject);
    expect(cookie).not.toContain(identity.email);
    expect(cookie).not.toContain('opaque-state');
  });

  it('stores the refresh token only in a separate encrypted short-lived narrow-path grant cookie', () => {
    vi.stubEnv('AUTH_SECRET', strongSecret);
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', generatorClientId);
    const response = NextResponse.json({ ok: true });
    const issuedAt = Date.now();

    setGeneratorGrantCookie(response, {
      purpose: 'generator',
      subject: identity.subject,
      email: identity.email,
      refreshToken: 'user-specific-refresh-token',
      grantId: 'grant-id-that-is-at-least-thirty-two-characters',
      expiresAt: issuedAt + 600_000,
      clientFingerprint,
      issuedAt,
    });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${GENERATOR_GRANT_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).toContain('Path=/api/generator');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).not.toContain('user-specific-refresh-token');
    expect(cookie).not.toContain(identity.email);

    const value = new RegExp(`${GENERATOR_GRANT_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? '';
    const request = new Request('https://generator.example/api/generator/create', {
      headers: { cookie: `${GENERATOR_GRANT_COOKIE}=${value}` },
    });
    expect(getGeneratorGrantFromRequest(request, identity, {
      AUTH_SECRET: strongSecret,
      GENERATOR_GOOGLE_CLIENT_ID: generatorClientId,
    })).toEqual(expect.objectContaining({
      purpose: 'generator',
      subject: identity.subject,
      email: identity.email,
      refreshToken: 'user-specific-refresh-token',
    }));
  });

  it('rejects a grant bound to another ordinary identity session', () => {
    vi.stubEnv('AUTH_SECRET', strongSecret);
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', generatorClientId);
    const response = NextResponse.json({ ok: true });
    const issuedAt = Date.now();
    setGeneratorGrantCookie(response, {
      purpose: 'generator',
      subject: identity.subject,
      email: identity.email,
      refreshToken: 'user-specific-refresh-token',
      grantId: 'grant-id-that-is-at-least-thirty-two-characters',
      expiresAt: issuedAt + 600_000,
      clientFingerprint,
      issuedAt,
    });
    const cookie = response.headers.get('set-cookie') ?? '';
    const value = new RegExp(`${GENERATOR_GRANT_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? '';
    const request = new Request('https://generator.example/api/generator/create', {
      headers: { cookie: `${GENERATOR_GRANT_COOKIE}=${value}` },
    });

    expect(getGeneratorGrantFromRequest(request, { ...identity, subject: 'different-subject' }, {
      AUTH_SECRET: strongSecret,
      GENERATOR_GOOGLE_CLIENT_ID: generatorClientId,
    })).toBeNull();
  });

  it('refuses weak AUTH_SECRET values for generator state and grant encryption', () => {
    vi.stubEnv('AUTH_SECRET', 'too-short');
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', generatorClientId);
    const response = NextResponse.json({ ok: true });

    expect(() => setGeneratorConsentStateCookie(response, {
      purpose: 'generator',
      state: 'opaque-state',
      subject: identity.subject,
      email: identity.email,
      clientFingerprint,
      issuedAt: Date.now(),
    })).toThrow(/AUTH_SECRET/);
  });
});
