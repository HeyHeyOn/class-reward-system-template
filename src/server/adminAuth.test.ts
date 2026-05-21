import { describe, expect, it } from 'vitest';
import { createAdminSessionToken, isAdminAuthEnabled, isValidAdminSession, verifyAdminPassword, verifyAdminPasswordWithSettings } from '@/server/adminAuth';

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

  it('accepts the recovery code stored as a hash in the Settings sheet', async () => {
    const reader = {
      async getRows() {
        return [
          ['key', 'value'],
          ['recoveryCodeHash', '65c524da460ffd672584ca0fb05e92e08b9e3aeda222596578536422a193d720'],
        ];
      },
    };

    await expect(verifyAdminPasswordWithSettings('ABCD-1234-EFGH-5678', reader, { ADMIN_PASSWORD: 'teacher@example.com' })).resolves.toBe(true);
    await expect(verifyAdminPasswordWithSettings('WRONG-1234-EFGH-5678', reader, { ADMIN_PASSWORD: 'teacher@example.com' })).resolves.toBe(false);
  });
});
