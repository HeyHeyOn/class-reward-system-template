import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createAdminPasswordHash } from '@/server/adminAuth';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import {
  createTenantLegacyAdminAuth,
  TenantLegacyAdminAuthError,
} from '@/server/tenantLegacyAdminAuth';

const ALPHA_ID = '20000000-0000-4000-8000-000000000001';
const BETA_ID = '20000000-0000-4000-8000-000000000002';
const tenant = (id = ALPHA_ID, lifecycle: 'READY' | 'ACTIVE' = 'READY') => ({
  id, slug: id === ALPHA_ID ? 'alpha-class' : 'beta-class', displayName: 'Class', lifecycle,
  timezone: 'Asia/Seoul' as const,
});
const env = { CLASS_STORE_STORAGE: 'postgresql', AUTH_SECRET: 'a-secure-test-auth-secret' };

function credential(overrides: Partial<{
  tenantId: string; lifecycle: 'READY' | 'ACTIVE'; credentialVersion: number; secretVersion: number;
  secretHash: string; hashAlgorithm: string; revokedAt: Date | null;
}> = {}) {
  return {
    tenantId: ALPHA_ID,
    lifecycle: 'READY' as const,
    credentialVersion: 1,
    secretVersion: 1,
    secretHash: createAdminPasswordHash('correct horse'),
    hashAlgorithm: 'scrypt',
    revokedAt: null,
    ...overrides,
  };
}

function inTenant<T>(id: string, lifecycle: 'READY' | 'ACTIVE', callback: () => T): T {
  return runWithTrustedTenantRequestContext({ tenant: tenant(id, lifecycle) }, callback);
}

describe('tenant-scoped imported admin credential compatibility', () => {
  const readCurrentCredential = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    readCurrentCredential.mockResolvedValue(credential());
  });

  it('validates only the current trusted tenant imported hash and issues a tenant/version-bound session', async () => {
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential, now: () => 1_000 }, env);
    const result = await inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'correct horse' }));

    expect(result.sessionToken).not.toContain('correct horse');
    expect(readCurrentCredential).toHaveBeenCalledOnce();
    expect(readCurrentCredential).toHaveBeenCalledWith(ALPHA_ID);
    await expect(auth.verifySession(result.sessionToken, ALPHA_ID)).resolves.toBe(true);
  });

  it('normalizes an explicitly identified legacy QR only from the request body value', async () => {
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential, now: () => 1_000 }, env);
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({
      kind: 'qr', value: 'class-store-admin:correct horse',
    }))).resolves.toMatchObject({ credentialVersion: 1 });
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({
      kind: 'password', value: 'class-store-admin:correct horse',
    }))).rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
  });

  it('never searches another tenant even when the same student-style identifier or credential exists there', async () => {
    readCurrentCredential.mockImplementation(async (tenantId: string) =>
      tenantId === BETA_ID ? credential({ tenantId: BETA_ID }) : null);
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential, now: () => 1_000 }, env);

    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'correct horse' })))
      .rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
    expect(readCurrentCredential).toHaveBeenCalledTimes(1);
    expect(readCurrentCredential).toHaveBeenCalledWith(ALPHA_ID);
  });

  it.each([
    ['wrong password', { kind: 'password', value: 'wrong' }],
    ['tampered QR prefix', { kind: 'qr', value: 'class-store-adminx:correct horse' }],
    ['unknown kind', { kind: 'recovery', value: 'correct horse' }],
  ])('fails closed for %s', async (_label, input) => {
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential, now: () => 1_000 }, env);
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login(input)))
      .rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
  });

  it('fails without trusted tenant context and rejects env-only authority in PostgreSQL', async () => {
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential }, {
      ...env, ADMIN_PASSWORD: 'correct horse',
    });
    await expect(auth.login({ kind: 'password', value: 'correct horse' }))
      .rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
    expect(readCurrentCredential).not.toHaveBeenCalled();
  });

  it('invalidates old sessions and plaintext after credential rotation', async () => {
    let current = credential();
    readCurrentCredential.mockImplementation(async () => current);
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential, now: () => 1_000 }, env);
    const old = await inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'correct horse' }));

    current = credential({ credentialVersion: 2, secretVersion: 2, secretHash: createAdminPasswordHash('new password') });
    await expect(auth.verifySession(old.sessionToken, ALPHA_ID)).resolves.toBe(false);
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'correct horse' })))
      .rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
  });

  it('requires post-cutover imported version rotation and fails closed on lifecycle/version mismatch', async () => {
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential }, env);
    readCurrentCredential.mockResolvedValue(credential({ lifecycle: 'ACTIVE', credentialVersion: 1, secretVersion: 1 }));
    await expect(inTenant(ALPHA_ID, 'ACTIVE', () => auth.login({ kind: 'password', value: 'correct horse' })))
      .rejects.toBeInstanceOf(TenantLegacyAdminAuthError);

    readCurrentCredential.mockResolvedValue(credential({ lifecycle: 'ACTIVE', credentialVersion: 2, secretVersion: 1 }));
    await expect(inTenant(ALPHA_ID, 'ACTIVE', () => auth.login({ kind: 'password', value: 'correct horse' })))
      .rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
  });

  it('uses the persisted tenant session version and re-reads it on every authorization', async () => {
    const createSession = vi.fn(async () => ({ token: 'opaque-session-token', sessionVersion: 7 }));
    let storedSession = {
      tenantId: ALPHA_ID,
      credentialVersion: 2,
      sessionVersion: 7,
      tokenSessionVersion: 7,
      expiresAt: new Date(50_000),
      revokedAt: null as Date | null,
    };
    const readSession = vi.fn(async () => storedSession);
    readCurrentCredential.mockResolvedValue(credential({ credentialVersion: 2, secretVersion: 2 }));
    const auth = createTenantLegacyAdminAuth({
      readCurrentCredential,
      createSession,
      readSession,
      now: () => 1_000,
    }, env);

    const result = await inTenant(ALPHA_ID, 'READY', () =>
      auth.login({ kind: 'password', value: 'correct horse' }));

    expect(result).toMatchObject({ sessionToken: 'opaque-session-token', sessionVersion: 7 });
    expect(createSession).toHaveBeenCalledWith(ALPHA_ID, 2, new Date(43_201_000));
    await expect(auth.verifySession(result.sessionToken, ALPHA_ID)).resolves.toBe(true);
    expect(readSession).toHaveBeenCalledWith(ALPHA_ID, 'opaque-session-token');

    storedSession = { ...storedSession, sessionVersion: 8 };
    await expect(auth.verifySession(result.sessionToken, ALPHA_ID)).resolves.toBe(false);
  });
});
