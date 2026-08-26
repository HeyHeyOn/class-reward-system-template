import { describe, expect, it } from 'vitest';
import {
  createAdminPasswordHash,
  createAdminSessionToken,
  isAdminAuthEnabled,
  isValidAdminSession,
  verifyAdminPassword,
  verifyAdminPasswordHash,
  verifyAdminPasswordWithSettings,
} from '@/server/adminAuth';

describe('admin auth', () => {
  it('is disabled when no admin password is configured', () => {
    expect(isAdminAuthEnabled({})).toBe(false);
    expect(isValidAdminSession(undefined, {})).toBe(true);
    expect(verifyAdminPassword('', {})).toBe(true);
    expect(verifyAdminPassword('any-candidate', { AUTH_SECRET: 'session-signing-secret' })).toBe(false);
    expect(isValidAdminSession('dev-no-password', { AUTH_SECRET: 'session-signing-secret' })).toBe(false);
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

  it('creates salted password hashes that verify without exposing the password', () => {
    const first = createAdminPasswordHash('teacher-secret');
    const second = createAdminPasswordHash('teacher-secret');

    expect(first).toMatch(/^scrypt\$/);
    expect(first).not.toContain('teacher-secret');
    expect(first).not.toBe(second);
    expect(verifyAdminPasswordHash('teacher-secret', first)).toBe(true);
    expect(verifyAdminPasswordHash('wrong-secret', first)).toBe(false);
  });

  it('verifies legacy sha256 password hashes and fails closed for malformed hashes', () => {
    expect(verifyAdminPasswordHash(
      'legacy-secret',
      'fdcbc807d80f60c6f15ef644d5c372ac92760bd5f414cc3d48c3b320d9d1e689',
    )).toBe(true);
    expect(verifyAdminPasswordHash('legacy-secret', 'scrypt$broken')).toBe(false);
    expect(verifyAdminPasswordHash('legacy-secret', '')).toBe(false);
  });

  it('fails closed when a configured Settings password hash does not match or is malformed', async () => {
    const reader = (savedHash: string) => ({
      async getRows() {
        return [['key', 'value'], ['adminPasswordHash', savedHash]];
      },
    });
    const legacyHash = 'fdcbc807d80f60c6f15ef644d5c372ac92760bd5f414cc3d48c3b320d9d1e689';

    await expect(verifyAdminPasswordWithSettings('legacy-secret', reader(legacyHash), {})).resolves.toBe(true);
    await expect(verifyAdminPasswordWithSettings('wrong-secret', reader(legacyHash), {})).resolves.toBe(false);
    await expect(verifyAdminPasswordWithSettings('anything', reader('scrypt$broken'), {})).resolves.toBe(false);
  });

  it('fails closed when Settings rejects while AUTH_SECRET enables admin auth', async () => {
    const reader = {
      async getRows() {
        throw new Error('quota/network provider failure project_number:123');
      },
    };

    await expect(verifyAdminPasswordWithSettings(
      'any-candidate',
      reader,
      { AUTH_SECRET: 'session-signing-secret' },
    )).resolves.toBe(false);
  });

  it('fails closed when Settings reader creation failed while AUTH_SECRET enables auth', async () => {
    await expect(verifyAdminPasswordWithSettings(
      'any-candidate',
      undefined,
      { AUTH_SECRET: 'session-signing-secret' },
    )).resolves.toBe(false);
  });

  it.each([
    ['an empty Settings sheet', []],
    ['Settings rows without a verifiable credential', [['key', 'value'], ['appTitle', '학급 매점']]],
  ])('fails closed for %s when AUTH_SECRET enables auth', async (_description, rows) => {
    const reader = { async getRows() { return rows; } };

    await expect(verifyAdminPasswordWithSettings(
      'any-candidate',
      reader,
      { AUTH_SECRET: 'session-signing-secret' },
    )).resolves.toBe(false);
  });
});
