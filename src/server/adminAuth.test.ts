import { describe, expect, it } from 'vitest';
import { createAdminSessionToken, isAdminAuthEnabled, isValidAdminSession, verifyAdminPassword } from '@/server/adminAuth';

describe('admin auth', () => {
  it('is disabled when no admin password is configured', () => {
    expect(isAdminAuthEnabled({})).toBe(false);
    expect(isValidAdminSession(undefined, {})).toBe(true);
    expect(verifyAdminPassword('', {})).toBe(true);
  });

  it('validates password and session token when configured', () => {
    const env = { ADMIN_PASSWORD: 'secret-pass' };
    const token = createAdminSessionToken(env);

    expect(isAdminAuthEnabled(env)).toBe(true);
    expect(verifyAdminPassword('secret-pass', env)).toBe(true);
    expect(verifyAdminPassword('wrong', env)).toBe(false);
    expect(isValidAdminSession(token, env)).toBe(true);
    expect(isValidAdminSession('bad-token', env)).toBe(false);
  });
});
