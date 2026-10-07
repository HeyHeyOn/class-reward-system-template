import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const database = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => ({ pool: database }) }));

import { POST as adminLogout } from '@/app/api/admin/logout/route';
import { POST as googleLogout } from '@/app/api/google/logout/route';
import { createTenantLegacyAdminAuth } from '@/server/tenantLegacyAdminAuth';
import { resolveTenantAdminContext } from '@/server/tenantAuth';

const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha', displayName: 'Alpha', lifecycle: 'ACTIVE' as const, timezone: 'Asia/Seoul' as const };
const raw = 'A'.repeat(43), token = `csa1.1.${raw}`;

describe('administrator logout', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([['Google', googleLogout], ['password', adminLogout]] as const)(
    '%s logout revokes its persisted bearer session and clears every admin cookie including mixed identity', async (_name, logout) => {
      const now = Date.now();
      const stored = { tenantId: tenant.id, credentialVersion: 2, sessionVersion: 1, tokenSessionVersion: 1,
        expiresAt: new Date(now + 43200000), revokedAt: null as Date | null };
      const auth = createTenantLegacyAdminAuth({
        readSession: async (_id, value) => value === token ? stored : null,
        readCurrentCredential: async () => ({ tenantId: tenant.id, lifecycle: 'ACTIVE', credentialVersion: 2, secretVersion: 2,
          secretHash: 'f'.repeat(64), hashAlgorithm: 'sha256', revokedAt: null }),
      }, { CLASS_STORE_STORAGE: 'postgresql', AUTH_SECRET: 'synthetic-logout-signing-secret' });
      const request = new Request('https://class.example/api/admin/logout', { method: 'POST', headers: {
        cookie: `class_store_tenant_admin=${token}; class_store_google_auth=synthetic; class_store_admin=synthetic; class_store_generator_grant=synthetic`,
      } });
      const dependencies = { findBySlug: async () => tenant, getSession: () => null, findByTenantAndSubject: async () => null,
        getCompatibilitySession: async () => await auth.verifySession(token, tenant.id) ? { tenantId: tenant.id } : null };
      await expect(resolveTenantAdminContext(tenant.slug, request, dependencies)).resolves.toHaveProperty('compatibilitySession');
      database.query.mockImplementation(async (_sql, params) => {
        expect(params).toEqual([createHash('sha256').update(raw).digest('hex'), 1]);
        stored.revokedAt = new Date(); return { rows: [] };
      });
      const response = await logout(request);
      expect(response.status).toBe(200);
      expect(database.query).toHaveBeenCalledOnce();
      expect(response.cookies.getAll().map(c => [c.name, c.maxAge])).toEqual(expect.arrayContaining([
        ['class_store_tenant_admin', 0], ['class_store_google_auth', 0], ['class_store_admin', 0], ['class_store_generator_grant', 0],
      ]));
      expect(response.cookies.get('class_store_tenant_admin')).toMatchObject({ path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
      // Even a saved cookie cannot replay the revoked compatibility session.
      await expect(resolveTenantAdminContext(tenant.slug, request, dependencies)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    },
  );

  it('does not claim success or discard the retry cookie when server revocation fails', async () => {
    database.query.mockRejectedValue(new Error('synthetic unavailable'));
    const response = await googleLogout(new Request('https://class.example/api/google/logout', {
      method: 'POST', headers: { cookie: `class_store_tenant_admin=${token}` },
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('synthetic unavailable');
  });

  it.each(['', 'class_store_tenant_admin=malformed', 'class_store_tenant_admin=%ZZ'])(
    'is idempotent for absent or invalid cookies without database access (%s)', async cookie => {
      const response = await adminLogout(new Request('https://class.example/api/admin/logout', { method: 'POST', headers: { cookie } }));
      expect(response.status).toBe(200);
      expect(database.query).not.toHaveBeenCalled();
      expect(response.cookies.get('class_store_tenant_admin')?.maxAge).toBe(0);
    },
  );
});
