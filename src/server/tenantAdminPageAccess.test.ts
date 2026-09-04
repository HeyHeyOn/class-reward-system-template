import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { authorizeTenantAdminPage } from '@/server/tenantAdminPageAccess';

const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha-class', displayName: 'Alpha', lifecycle: 'ACTIVE' as const, timezone: 'Asia/Seoul' as const };
const session = { subject: 'subject-1', email: 'owner@example.com', issuedAt: 1 };

describe('tenant admin page access', () => {
  it('redirects an unauthenticated visitor to the scoped login page', async () => {
    const redirect = vi.fn((path: string): never => { throw new Error(`redirect:${path}`); });
    await expect(authorizeTenantAdminPage('alpha-class', new Request('https://example.test/c/alpha-class/admin'), {
      findBySlug: async () => tenant, findByTenantAndSubject: vi.fn(), getSession: () => null,
    }, { redirect, notFound: vi.fn((): never => { throw new Error('not-found'); }) }))
      .rejects.toThrow('redirect:/c/alpha-class/admin/login');
  });

  it('fails closed for an authenticated nonmember', async () => {
    const notFound = vi.fn((): never => { throw new Error('not-found'); });
    await expect(authorizeTenantAdminPage('alpha-class', new Request('https://example.test/c/alpha-class/admin'), {
      findBySlug: async () => tenant, findByTenantAndSubject: async () => null, getSession: () => session,
    }, { redirect: vi.fn((): never => { throw new Error('redirect'); }), notFound }))
      .rejects.toThrow('not-found');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('allows only matching tenant membership', async () => {
    await expect(authorizeTenantAdminPage('alpha-class', new Request('https://example.test/c/alpha-class/admin'), {
      findBySlug: async () => tenant,
      findByTenantAndSubject: async () => ({ id: '30000000-0000-4000-8000-000000000001', tenantId: tenant.id, userId: '10000000-0000-4000-8000-000000000001', googleSubject: session.subject, role: 'ADMIN' }),
      getSession: () => session,
    }, { redirect: vi.fn((): never => { throw new Error('redirect'); }), notFound: vi.fn((): never => { throw new Error('not-found'); }) }))
      .resolves.toMatchObject({ tenant, membership: { tenantId: tenant.id } });
  });
});
