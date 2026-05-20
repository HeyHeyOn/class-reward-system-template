import { describe, expect, it } from 'vitest';
import { createSignedAdminSessionToken } from '@/server/adminAuth';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';

describe('api auth', () => {
  it('allows admin API writes with password or QR login session cookie even when Google OAuth is enabled', () => {
    const env = {
      AUTH_SECRET: 'test-secret',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
    };
    const token = createSignedAdminSessionToken('teacher-pin', env);
    const request = new Request('https://example.com/api/students/S001', {
      headers: { cookie: `class_store_admin=${token}` },
    });

    expect(isAuthorizedAdminRequest(request, env)).toBe(true);
  });

  it('allows Google login cookie as an admin API write credential and rejects missing credentials', () => {
    const env = { GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret' };
    const googleRequest = new Request('https://example.com/api/products', {
      headers: { cookie: 'class_store_google_auth=oauth-token' },
    });
    const anonymousRequest = new Request('https://example.com/api/products');

    expect(isAuthorizedAdminRequest(googleRequest, env)).toBe(true);
    expect(isAuthorizedAdminRequest(anonymousRequest, env)).toBe(false);
  });
});
