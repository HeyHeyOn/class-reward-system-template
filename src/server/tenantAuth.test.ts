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

  it('falls back to an exact-tenant compatibility session when a Google identity is not a member', async () => {
    const getCompatibilitySession = vi.fn(async () => ({ tenantId: ALPHA_ID }));

    await expect(resolveTenantAdminContext(
      'alpha-class',
      new Request('https://example.test/c/alpha-class/admin'),
      {
        findBySlug: async () => alpha,
        findByTenantAndSubject: async () => null,
        getSession: () => session,
        getCompatibilitySession,
      },
    )).resolves.toMatchObject({ compatibilitySession: { tenantId: ALPHA_ID } });
    expect(getCompatibilitySession).toHaveBeenCalledWith(expect.any(Request), ALPHA_ID);
  });

  it.each(['OWNER', 'ADMIN'] as const)(
    'prefers a valid Google %s membership without invoking compatibility verification',
    async (role) => {
      const getCompatibilitySession = vi.fn(async () => ({ tenantId: ALPHA_ID }));

      await expect(resolveTenantAdminContext(
        'alpha-class',
        new Request('https://example.test/c/alpha-class/admin'),
        {
          findBySlug: async () => alpha,
          findByTenantAndSubject: async () => ({
            id: '30000000-0000-4000-8000-000000000001',
            tenantId: ALPHA_ID,
            userId: '10000000-0000-4000-8000-000000000001',
            googleSubject: session.subject,
            role,
          }),
          getSession: () => session,
          getCompatibilitySession,
        },
      )).resolves.toMatchObject({ session, membership: { role } });
      expect(getCompatibilitySession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', null],
    ['invalid', null],
    ['wrong-tenant', { tenantId: BETA_ID }],
  ])('preserves NOT_A_MEMBER when the compatibility session is %s', async (_label, compatibilitySession) => {
    await expect(resolveTenantAdminContext(
      'alpha-class',
      new Request('https://example.test/c/alpha-class/admin'),
      {
        findBySlug: async () => alpha,
        findByTenantAndSubject: async () => null,
        getSession: () => session,
        getCompatibilitySession: compatibilitySession === null && _label === 'missing'
          ? undefined
          : async () => compatibilitySession,
      },
    )).rejects.toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
  });

  it.each([
    ['MEMBERSHIP_CONTEXT_MISMATCH', {
      id: '30000000-0000-4000-8000-000000000002',
      tenantId: BETA_ID,
      userId: '10000000-0000-4000-8000-000000000001',
      googleSubject: session.subject,
      role: 'OWNER' as const,
    }],
    ['UNSUPPORTED_MEMBERSHIP_ROLE', {
      id: '30000000-0000-4000-8000-000000000001',
      tenantId: ALPHA_ID,
      userId: '10000000-0000-4000-8000-000000000001',
      googleSubject: session.subject,
      role: 'VIEWER' as never,
    }],
  ] as const)('does not replace %s with compatibility authority', async (code, membership) => {
    const getCompatibilitySession = vi.fn(async () => ({ tenantId: ALPHA_ID }));

    await expect(resolveTenantAdminContext(
      'alpha-class',
      new Request('https://example.test/c/alpha-class/admin'),
      {
        findBySlug: async () => alpha,
        findByTenantAndSubject: async () => membership,
        getSession: () => session,
        getCompatibilitySession,
      },
    )).rejects.toMatchObject({ code, status: 403 });
    expect(getCompatibilitySession).not.toHaveBeenCalled();
  });

  it('propagates membership store failures without invoking compatibility verification', async () => {
    const failure = new Error('membership store unavailable');
    const getCompatibilitySession = vi.fn(async () => ({ tenantId: ALPHA_ID }));

    await expect(resolveTenantAdminContext(
      'alpha-class',
      new Request('https://example.test/c/alpha-class/admin'),
      {
        findBySlug: async () => alpha,
        findByTenantAndSubject: async () => { throw failure; },
        getSession: () => session,
        getCompatibilitySession,
      },
    )).rejects.toBe(failure);
    expect(getCompatibilitySession).not.toHaveBeenCalled();
  });

  it('accepts a compatibility session only when it verifies for the canonical tenant', async () => {
    const getCompatibilitySession = vi.fn(async (_request: Request, tenantId: string) =>
      tenantId === ALPHA_ID ? { tenantId: ALPHA_ID } : null);
    const dependencies = {
      findBySlug: async (slug: string) => slug === 'alpha-class' ? alpha : { ...alpha, id: BETA_ID, slug },
      findByTenantAndSubject: vi.fn(),
      getSession: () => null,
      getCompatibilitySession,
    };

    await expect(resolveTenantAdminContext('alpha-class', new Request('https://example.test/c/alpha-class/admin'), dependencies))
      .resolves.toMatchObject({ compatibilitySession: { tenantId: ALPHA_ID } });
    await expect(resolveTenantAdminContext('beta-class', new Request('https://example.test/c/beta-class/admin'), dependencies))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(getCompatibilitySession).toHaveBeenLastCalledWith(expect.any(Request), BETA_ID);
  });
});
