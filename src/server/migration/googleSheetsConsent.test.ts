import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  MIGRATION_CONSENT_COOKIE,
  MIGRATION_GOOGLE_SCOPES,
  consumeMigrationConsentState,
  createMigrationConsentBinding,
  createMigrationConsentUrl,
  sanitizeMigrationReturnTo,
  setMigrationConsentStateCookie,
  withEphemeralMigrationAuthorization,
  type EphemeralMigrationAuthorization,
  type MigrationConsentBinding,
} from '@/server/migration/googleSheetsConsent';

const env = {
  AUTH_SECRET: 'migration-cookie-secret'.padEnd(32, '!'),
  MIGRATION_GOOGLE_CLIENT_ID: 'migration-client-id.apps.googleusercontent.com',
  MIGRATION_GOOGLE_CLIENT_SECRET: 'migration-client-secret',
};
const now = 1_800_000_000_000;

function binding(overrides: Partial<MigrationConsentBinding> = {}): MigrationConsentBinding {
  return {
    purpose: 'sheets-migration',
    stage: 'preflight',
    state: 'migration-state-123',
    sheetId: 'sheet-123',
    targetTenantId: 'tenant-123',
    returnTo: '/admin/migrations/source',
    issuedAt: now,
    expiresAt: now + 5 * 60_000,
    ...overrides,
  };
}

function requestWithCookie(value: string, state = 'migration-state-123') {
  return new Request(`https://class-store.example/api/migrations/google-sheets/callback?code=code&state=${state}`, {
    headers: { cookie: `${MIGRATION_CONSENT_COOKIE}=${encodeURIComponent(value)}` },
  });
}

function stateCookie(value: MigrationConsentBinding) {
  vi.stubEnv('AUTH_SECRET', env.AUTH_SECRET);
  vi.stubEnv('NODE_ENV', 'production');
  const response = NextResponse.json({ ok: true });
  setMigrationConsentStateCookie(response, value, env);
  const header = response.headers.get('set-cookie') ?? '';
  return { header, value: new RegExp(`${MIGRATION_CONSENT_COOKIE}=([^;]+)`).exec(header)?.[1] ?? '' };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('temporary Google Sheets migration consent', () => {
  it('creates a short-lived typed binding for explicit FREEZING re-consent', () => {
    const created = createMigrationConsentBinding({
      stage: 'freezing',
      sheetId: 'sheet-final',
      targetTenantId: 'tenant-123',
      returnTo: 'https://evil.example/steal',
    }, now);

    expect(created).toEqual({
      purpose: 'sheets-migration',
      stage: 'freezing',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      sheetId: 'sheet-final',
      targetTenantId: 'tenant-123',
      returnTo: '/admin/migrations',
      issuedAt: now,
      expiresAt: now + 10 * 60_000,
    });
  });

  it('rejects proxy and control-character migration context before property traps run', () => {
    let traps = 0;
    const proxy = new Proxy({
      stage: 'preflight' as const,
      sheetId: 'sheet-123',
    }, {
      get() { traps += 1; throw new Error('trap'); },
      ownKeys() { traps += 1; throw new Error('trap'); },
      getOwnPropertyDescriptor() { traps += 1; throw new Error('trap'); },
    });

    expect(() => createMigrationConsentBinding(proxy)).toThrow(/context/i);
    expect(traps).toBe(0);
    expect(() => createMigrationConsentBinding({ stage: 'preflight', sheetId: 'sheet\n123' })).toThrow(/context/i);
    expect(() => createMigrationConsentBinding({ stage: 'preflight', sheetId: 'sheet-123', targetTenantId: ' tenant-123' })).toThrow(/context/i);
    expect(() => createMigrationConsentBinding({ stage: 'freezing', sheetId: 'sheet-123' })).toThrow(/context/i);
  });

  it('requests exact readonly Sheets and selected-file Drive scopes with explicit online re-consent', () => {
    vi.stubEnv('MIGRATION_GOOGLE_CLIENT_ID', env.MIGRATION_GOOGLE_CLIENT_ID);
    vi.stubEnv('MIGRATION_GOOGLE_CLIENT_SECRET', env.MIGRATION_GOOGLE_CLIENT_SECRET);

    const url = new URL(createMigrationConsentUrl('https://class-store.example', 'migration-state'));

    expect(MIGRATION_GOOGLE_SCOPES).toEqual([
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ]);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(MIGRATION_GOOGLE_SCOPES);
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('redirect_uri')).toBe('https://class-store.example/api/migrations/google-sheets/callback');
    expect(url.searchParams.get('client_id')).toBe(env.MIGRATION_GOOGLE_CLIENT_ID);
    expect(url.toString()).not.toContain('auth/spreadsheets%20');
  });

  it('rejects an OAuth origin that differs from the configured canonical application origin', () => {
    expect(() => createMigrationConsentUrl('https://evil.example', 'migration-state', {
      ...env,
      MIGRATION_GOOGLE_OAUTH_ORIGIN: 'https://class-store.example',
    })).toThrow(/origin/i);
  });

  it('refuses to reuse the legacy deployment OAuth client for revocable migration consent', () => {
    expect(() => createMigrationConsentUrl('https://class-store.example', 'migration-state', {
      AUTH_SECRET: env.AUTH_SECRET,
      GOOGLE_CLIENT_ID: 'legacy-client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'legacy-client-secret',
    })).toThrow(/MIGRATION_GOOGLE_CLIENT_ID/);
  });

  it('requires a strong dedicated AUTH_SECRET for migration state encryption', () => {
    const response = NextResponse.json({ ok: true });
    expect(() => setMigrationConsentStateCookie(response, binding(), {
      GOOGLE_CLIENT_SECRET: 'client-secret',
      AUTH_SECRET: 'too-short',
    })).toThrow(/AUTH_SECRET/);
    expect(() => setMigrationConsentStateCookie(response, binding(), {
      GOOGLE_CLIENT_SECRET: 'client-secret',
      ADMIN_PASSWORD: 'administrator-password',
    })).toThrow(/AUTH_SECRET/);
  });

  it('uses a separate short-lived secure cookie bound to purpose, stage, Sheet, and tenant', () => {
    const cookie = stateCookie(binding());

    expect(cookie.header).toContain(`${MIGRATION_CONSENT_COOKIE}=`);
    expect(cookie.header).toContain('Max-Age=600');
    expect(cookie.header).toContain('HttpOnly');
    expect(cookie.header).toContain('Secure');
    expect(cookie.header).toContain('SameSite=lax');
    expect(cookie.header).toContain('Path=/api/migrations/google-sheets');
    expect(cookie.header).not.toContain('sheet-123');
    expect(cookie.header).not.toContain('migration-state-123');

    const response = NextResponse.json({ ok: true });
    expect(consumeMigrationConsentState(requestWithCookie(cookie.value), response, 'migration-state-123', env, now + 1)).toEqual(binding());
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('cannot confuse ordinary login state with migration state', () => {
    const response = NextResponse.json({ ok: true });
    const request = new Request('https://class-store.example/api/migrations/google-sheets/callback?state=login-state', {
      headers: { cookie: 'class_store_google_state=login-state' },
    });

    expect(consumeMigrationConsentState(request, response, 'login-state', env, now)).toBeNull();
  });

  it.each([
    ['wrong state', binding(), 'different-state', now + 1],
    ['expired state', binding(), 'migration-state-123', now + 5 * 60_000 + 1],
    ['future-issued state', binding({ issuedAt: now + 1 }), 'migration-state-123', now],
  ])('fails closed and consumes the cookie for %s', (_label, saved, submitted, at) => {
    const cookie = stateCookie(saved);
    const response = NextResponse.json({ ok: true });

    expect(consumeMigrationConsentState(requestWithCookie(cookie.value, submitted), response, submitted, env, at)).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it.each([
    binding({ purpose: 'identity-login' as 'sheets-migration' }),
    binding({ stage: 'importing' as 'preflight' }),
  ])('refuses to issue a cookie for a malformed purpose or stage binding', (invalidBinding) => {
    const response = NextResponse.json({ ok: true });
    expect(() => setMigrationConsentStateCookie(response, invalidBinding, env)).toThrow('Invalid migration consent binding');
  });

  it('rejects malformed and replayed state cookies', () => {
    const malformedResponse = NextResponse.json({ ok: true });
    expect(consumeMigrationConsentState(requestWithCookie('not-a-cookie'), malformedResponse, 'migration-state-123', env, now)).toBeNull();

    const cookie = stateCookie(binding());
    const firstResponse = NextResponse.json({ ok: true });
    expect(consumeMigrationConsentState(requestWithCookie(cookie.value), firstResponse, 'migration-state-123', env, now + 1)).not.toBeNull();
    const replayResponse = NextResponse.json({ ok: true });
    expect(consumeMigrationConsentState(requestWithCookie(cookie.value), replayResponse, 'migration-state-123', env, now + 2)).toBeNull();
  });

  it.each([
    ['/admin/migrations/job-1?step=source', '/admin/migrations/job-1?step=source'],
    ['https://evil.example/steal', '/admin/migrations'],
    ['//evil.example/steal', '/admin/migrations'],
    ['/api/migrations/google-sheets/callback', '/admin/migrations'],
    ['/admin/migrations.evil/steal', '/admin/migrations'],
    ['not-a-path', '/admin/migrations'],
  ])('allows only local admin migration return paths', (input, expected) => {
    expect(sanitizeMigrationReturnTo(input)).toBe(expected);
  });

  it('provides ephemeral credentials only inside the callback and revokes them after snapshot use', async () => {
    const auth = {
      credentials: {} as Record<string, unknown>,
      getToken: vi.fn(async () => ({ tokens: { access_token: 'access-token', refresh_token: 'unexpected-refresh-token', expiry_date: now + 60_000 } })),
      setCredentials: vi.fn(function (this: { credentials: Record<string, unknown> }, credentials: Record<string, unknown>) { this.credentials = credentials; }),
      revokeToken: vi.fn(async () => undefined),
      revokeCredentials: vi.fn(async () => undefined),
    };
    const captureSnapshot = vi.fn(async (authorization: EphemeralMigrationAuthorization) => {
      expect(auth.credentials.access_token).toBe('access-token');
      expect(authorization.auth).toBe(auth);
      expect(authorization).not.toHaveProperty('refreshToken');
      return 'snapshot-id';
    });

    await expect(withEphemeralMigrationAuthorization(
      'https://class-store.example',
      'authorization-code',
      captureSnapshot,
      { createClient: () => auth },
    )).resolves.toBe('snapshot-id');
    expect(auth.revokeToken).toHaveBeenCalledWith('unexpected-refresh-token');
    expect(auth.setCredentials).toHaveBeenLastCalledWith({});
  });

  it('revokes and deletes ephemeral credentials even when snapshot capture fails', async () => {
    const auth = {
      getToken: vi.fn(async () => ({ tokens: { access_token: 'access-token' } })),
      setCredentials: vi.fn(),
      revokeToken: vi.fn(async () => undefined),
      revokeCredentials: vi.fn(async () => undefined),
    };

    await expect(withEphemeralMigrationAuthorization(
      'https://class-store.example',
      'authorization-code',
      async () => { throw new Error('snapshot failed'); },
      { createClient: () => auth },
    )).rejects.toThrow('snapshot failed');
    expect(auth.revokeToken).toHaveBeenCalledWith('access-token');
    expect(auth.setCredentials).toHaveBeenLastCalledWith({});
  });

  it('preserves the snapshot failure when token revocation also fails', async () => {
    const auth = {
      getToken: vi.fn(async () => ({ tokens: { access_token: 'access-token' } })),
      setCredentials: vi.fn(),
      revokeToken: vi.fn(async () => { throw new Error('revocation failed'); }),
    };

    const snapshotFailure = new Error('snapshot failed');
    await expect(withEphemeralMigrationAuthorization(
      'https://class-store.example',
      'authorization-code',
      async () => { throw snapshotFailure; },
      { createClient: () => auth },
    )).rejects.toBe(snapshotFailure);
    expect(auth.setCredentials).toHaveBeenLastCalledWith({});
  });

  it('fails when Google returns no browser-attached access token and still revokes any grant', async () => {
    const auth = {
      getToken: vi.fn(async () => ({ tokens: { refresh_token: 'must-not-persist' } })),
      setCredentials: vi.fn(),
      revokeToken: vi.fn(async () => undefined),
      revokeCredentials: vi.fn(async () => undefined),
    };

    await expect(withEphemeralMigrationAuthorization(
      'https://class-store.example',
      'authorization-code',
      vi.fn(),
      { createClient: () => auth },
    )).rejects.toThrow('access token');
    expect(auth.revokeToken).toHaveBeenCalledWith('must-not-persist');
    expect(auth.setCredentials).toHaveBeenLastCalledWith({});
  });
});
