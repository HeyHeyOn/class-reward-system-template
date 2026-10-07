import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/transaction', () => ({ withTenantSnapshot: vi.fn(), withTenantTransaction: vi.fn() }));

import { createAdminPasswordHash } from '@/server/adminAuth';
import { withTenantSnapshot, withTenantTransaction, type TenantTransaction } from '@/server/db/transaction';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import {
  createTenantLegacyAdminAuth,
  getProductionTenantLegacyAdminAuth,
  TenantLegacyAdminAuthError,
  TenantLegacyAdminRateLimitError,
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

  it('stops exhausted attempts before credential reads or password hashing', async () => {
    const consumeLoginAttempt = vi.fn(async () => 240);
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential, consumeLoginAttempt }, env);
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'candidate' })))
      .rejects.toBeInstanceOf(TenantLegacyAdminRateLimitError);
    expect(consumeLoginAttempt).toHaveBeenCalledWith(ALPHA_ID);
    expect(readCurrentCredential).not.toHaveBeenCalled();
  });

  it('counts unsuccessful and successful password or QR attempts before checking the credential', async () => {
    const events: string[] = [];
    const current = credential();
    const consumeLoginAttempt = vi.fn(async () => { events.push('attempt'); return 0; });
    const auth = createTenantLegacyAdminAuth({ consumeLoginAttempt,
      readCurrentCredential: async () => { events.push('credential'); return current; }, now: () => 1000 }, env);
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'wrong' }))).rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'qr', value: 'class-store-admin:correct horse' }))).resolves.toHaveProperty('sessionToken');
    expect(events).toEqual(['attempt', 'credential', 'attempt', 'credential']);
  });

  it('fails closed when the durable limiter is unavailable', async () => {
    const auth = createTenantLegacyAdminAuth({ readCurrentCredential,
      consumeLoginAttempt: async () => { throw new Error('synthetic unavailable'); } }, env);
    await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'correct horse' }))).rejects.toThrow();
    expect(readCurrentCredential).not.toHaveBeenCalled();
  });
});

describe('production legacy-admin DB adapter unit timestamp regression (no native SQL or HTTP)', () => {
  // Pinned Drizzle rawQueryConfig TIMESTAMPTZ (OID 1184, text) shape:
  // node-postgres/session.js returns the zoned PostgreSQL literal unchanged.
  const rawExpiry = '2030-01-01 00:00:00.123456+00';
  const tokenRaw = 'A'.repeat(43);
  const token = `csa1.1.${tokenRaw}`;
  const dialect = new PgDialect();
  const snapshot = vi.mocked(withTenantSnapshot);
  let sessionRow: Record<string, unknown>;
  let credentialRow: Record<string, unknown>;
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    expect(compiled.params[0]).toBe(ALPHA_ID);
    if (compiled.sql.includes('platform_consume_tenant_login_attempt')) return { rows: [{ retry_after: 0 }] };
    if (compiled.sql.includes('FROM public.tenant_sessions s')) {
      const matchesToken = compiled.params[1] === createHash('sha256').update(tokenRaw).digest('hex');
      return { rows: matchesToken ? [sessionRow] : [] };
    }
    expect(compiled.sql).toContain('FROM public.tenants t');
    return { rows: [credentialRow] };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T00:00:00Z'));
    sessionRow = {
      tenant_id: ALPHA_ID, credential_version: 1, session_version: 1,
      expires_at: rawExpiry, revoked_at: null,
    };
    credentialRow = {
      tenant_id: ALPHA_ID, lifecycle: 'READY', credential_version: 1, secret_version: 1,
      secret_hash: createAdminPasswordHash('correct horse'), hash_algorithm: 'scrypt', revoked_at: null,
    };
    snapshot.mockImplementation(async (_tenantId, callback) =>
      callback({ execute } as unknown as TenantTransaction));
    vi.mocked(withTenantTransaction).mockImplementation(async (_tenantId, callback) =>
      callback({ execute } as unknown as TenantTransaction));
  });

  afterEach(() => vi.restoreAllMocks());

  it('authorizes a valid persisted raw-text session through production readers', async () => {
    await expect(getProductionTenantLegacyAdminAuth(env).verifySession(token, ALPHA_ID)).resolves.toBe(true);
    expect(snapshot).toHaveBeenNthCalledWith(1, ALPHA_ID, expect.any(Function));
    expect(snapshot).toHaveBeenNthCalledWith(2, ALPHA_ID, expect.any(Function));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Date', new Date('2030-01-01T00:00:00.123Z')],
    ['zoned ISO', '2030-01-01T09:00:00.123+09:00'],
  ])('preserves equivalent valid %s expiry authorization', async (_label, expiry) => {
    sessionRow.expires_at = expiry;
    await expect(getProductionTenantLegacyAdminAuth(env).verifySession(token, ALPHA_ID)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails closed for expired, exact-boundary and invalid expiry values', async () => {
    const auth = getProductionTenantLegacyAdminAuth(env);
    for (const expiry of [
      '2026-10-01 00:00:00+00', new Date('2026-10-02T00:00:00Z'),
      '2026-10-02 09:00:00+09',
      new Date(NaN), 'infinity', '2030-02-30 00:00:00+00',
      '2030-01-01T00:00:00', '2030-01-01T00:00:00+24:00', `${rawExpiry}\n`,
      null, undefined, 1, true, {},
    ]) {
      sessionRow.expires_at = expiry;
      await expect(auth.verifySession(token, ALPHA_ID)).resolves.toBe(false);
    }
    expect(execute.mock.calls.every(([query]) =>
      dialect.sqlToQuery(query).sql.includes('FROM public.tenant_sessions s'))).toBe(true);
  });

  it.each(['session', 'credential'] as const)('never treats nonnull %s revocation as unrevoked', async (kind) => {
    const auth = getProductionTenantLegacyAdminAuth(env);
    for (const revoked of [
      '2026-10-01 00:00:00.123456+00', new Date('2026-10-01T00:00:00Z'),
      'malformed', new Date(NaN), undefined, 0, false, {},
    ]) {
      (kind === 'session' ? sessionRow : credentialRow).revoked_at = revoked;
      await expect(auth.verifySession(token, ALPHA_ID)).resolves.toBe(false);
      if (kind === 'credential') {
        await expect(inTenant(ALPHA_ID, 'READY', () => auth.login({ kind: 'password', value: 'correct horse' })))
          .rejects.toBeInstanceOf(TenantLegacyAdminAuthError);
      }
    }
  });

  it('retains production tenant, credential/secret/session version and lifecycle denials', async () => {
    const auth = getProductionTenantLegacyAdminAuth(env);
    const originalSession = { ...sessionRow };
    const originalCredential = { ...credentialRow };
    for (const [session, currentCredential] of [
      [{ tenant_id: BETA_ID }, {}], [{ credential_version: 2 }, {}], [{ session_version: 2 }, {}],
      [{}, { tenant_id: BETA_ID }], [{}, { secret_version: 2 }],
      [{}, { lifecycle: 'ACTIVE' }], [{}, { lifecycle: 'FROZEN' }],
    ]) {
      sessionRow = { ...originalSession, ...session };
      credentialRow = { ...originalCredential, ...currentCredential };
      await expect(auth.verifySession(token, ALPHA_ID)).resolves.toBe(false);
    }
  });

  it('retains opaque token shape and hash matching denials', async () => {
    const auth = getProductionTenantLegacyAdminAuth(env);
    for (const invalidToken of [undefined, 'malformed', `csa1.0.${tokenRaw}`]) {
      await expect(auth.verifySession(invalidToken, ALPHA_ID)).resolves.toBe(false);
    }
    expect(snapshot).not.toHaveBeenCalled();
    await expect(auth.verifySession(`csa1.1.${'B'.repeat(43)}`, ALPHA_ID)).resolves.toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });
});
