import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  TenantAuthorizationError,
  authorizeTenantAdmin,
  resolveTenantAdminContext,
} from '@/server/tenantAuth';

const ALPHA_ID = '20000000-0000-4000-8000-000000000001';
const BETA_ID = '20000000-0000-4000-8000-000000000002';
const alpha = {
  id: ALPHA_ID,
  slug: 'alpha-class',
  displayName: 'Alpha Class',
  lifecycle: 'ACTIVE' as const,
  timezone: 'Asia/Seoul' as const,
};
const session = {
  subject: 'google-subject-owner',
  email: 'owner@example.com',
  issuedAt: 1,
};

describe('tenant membership authorization', () => {
  it.each(['OWNER', 'ADMIN'] as const)('grants %s membership tenant-admin authority', async (role) => {
    const findByTenantAndSubject = vi.fn(async () => ({
      id: '30000000-0000-4000-8000-000000000001',
      tenantId: ALPHA_ID,
      userId: '10000000-0000-4000-8000-000000000001',
      googleSubject: session.subject,
      role,
    }));

    await expect(authorizeTenantAdmin(alpha, session, { findByTenantAndSubject }))
      .resolves.toMatchObject({ tenantId: ALPHA_ID, role });
    expect(findByTenantAndSubject).toHaveBeenCalledWith(ALPHA_ID, session.subject);
  });

  it('gives an unauthenticated request no tenant-admin authority', async () => {
    const findByTenantAndSubject = vi.fn();

    await expect(authorizeTenantAdmin(alpha, null, { findByTenantAndSubject }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(findByTenantAndSubject).not.toHaveBeenCalled();
  });

  it('gives a valid Google session without membership no tenant-admin authority', async () => {
    await expect(authorizeTenantAdmin(alpha, session, {
      findByTenantAndSubject: async () => null,
    })).rejects.toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
  });

  it('rejects a cross-tenant membership returned by a confused deputy', async () => {
    await expect(authorizeTenantAdmin(alpha, session, {
      findByTenantAndSubject: async () => ({
        id: '30000000-0000-4000-8000-000000000002',
        tenantId: BETA_ID,
        userId: '10000000-0000-4000-8000-000000000001',
        googleSubject: session.subject,
        role: 'OWNER',
      }),
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_CONTEXT_MISMATCH', status: 403 });
  });

  it('rejects unsupported membership roles even if a store returns one', async () => {
    await expect(authorizeTenantAdmin(alpha, session, {
      findByTenantAndSubject: async () => ({
        id: '30000000-0000-4000-8000-000000000001',
        tenantId: ALPHA_ID,
        userId: '10000000-0000-4000-8000-000000000001',
        googleSubject: session.subject,
        role: 'VIEWER' as never,
      }),
    })).rejects.toBeInstanceOf(TenantAuthorizationError);
  });

  it('binds URL tenant selection and membership lookup to the same resolved tenant', async () => {
    const findBySlug = vi.fn(async (slug: string) => slug === 'beta-class'
      ? { ...alpha, id: BETA_ID, slug: 'beta-class' }
      : alpha);
    const findByTenantAndSubject = vi.fn(async (tenantId: string) => tenantId === ALPHA_ID
      ? {
        id: '30000000-0000-4000-8000-000000000001',
        tenantId: ALPHA_ID,
        userId: '10000000-0000-4000-8000-000000000001',
        googleSubject: session.subject,
        role: 'OWNER' as const,
      }
      : null);
    const request = new Request(`https://example.test/c/beta-class/admin?tenantId=${ALPHA_ID}`, {
      headers: { 'x-tenant-id': ALPHA_ID },
    });

    await expect(resolveTenantAdminContext('beta-class', request, {
      findBySlug,
      findByTenantAndSubject,
      getSession: () => session,
    })).rejects.toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
    expect(findByTenantAndSubject).toHaveBeenCalledWith(BETA_ID, session.subject);
  });
});
