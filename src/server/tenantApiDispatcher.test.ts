import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { getTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { createTenantApiDispatcher } from '@/server/tenantApiDispatcher';

const ALPHA_ID = '20000000-0000-4000-8000-000000000001';
const BETA_ID = '20000000-0000-4000-8000-000000000002';
const tenants = {
  'alpha-class': { id: ALPHA_ID, slug: 'alpha-class', displayName: 'Alpha', lifecycle: 'ACTIVE' as const, timezone: 'Asia/Seoul' as const },
  'beta-class': { id: BETA_ID, slug: 'beta-class', displayName: 'Beta', lifecycle: 'ACTIVE' as const, timezone: 'Asia/Seoul' as const },
};

function dependencies(memberTenantId: string | null = null) {
  return {
    findBySlug: vi.fn(async (slug: string) => tenants[slug as keyof typeof tenants] ?? null),
    getSession: vi.fn(async () => ({ subject: 'subject-1', email: 'owner@example.com', issuedAt: 1 })),
    findByTenantAndSubject: vi.fn(async (tenantId: string) => memberTenantId === tenantId ? ({
      id: '30000000-0000-4000-8000-000000000001', tenantId,
      userId: '10000000-0000-4000-8000-000000000001', googleSubject: 'subject-1', role: 'OWNER' as const,
    }) : null),
  };
}

describe('tenant API dispatcher', () => {
  it('binds a public handler only to the canonical URL tenant despite header query and body overrides', async () => {
    const handler = vi.fn(async (request: Request) => Response.json({
      tenantId: getTrustedTenantRequestContext().tenant.id,
      pathname: new URL(request.url).pathname,
      body: await request.json(),
    }));
    const dispatch = createTenantApiDispatcher(dependencies(), [{
      method: 'POST', pattern: 'echo', access: 'public', handler,
    }]);
    const request = new Request(`https://example.test/api/c/alpha-class/echo?tenantId=${BETA_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': BETA_ID, 'x-tenant-slug': 'beta-class' },
      body: JSON.stringify({ tenantId: BETA_ID, tenantSlug: 'beta-class' }),
    });

    const response = await dispatch(request, { slug: 'alpha-class', path: ['echo'] });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenantId: ALPHA_ID, pathname: '/api/echo' });
  });

  it('denies a nonmember before invoking an admin handler', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const deps = dependencies(ALPHA_ID);
    const dispatch = createTenantApiDispatcher(deps, [{ method: 'POST', pattern: 'products', access: 'admin', handler }]);
    const request = new Request('https://example.test/api/c/beta-class/products', { method: 'POST' });

    const response = await dispatch(request, { slug: 'beta-class', path: ['products'] });

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(deps.findByTenantAndSubject).toHaveBeenCalledWith(BETA_ID, 'subject-1');
  });

  it('passes the resolved membership through trusted context for an admin handler', async () => {
    const handler = vi.fn(async () => Response.json({
      tenantId: getTrustedTenantRequestContext().tenant.id,
      membershipTenantId: getTrustedTenantRequestContext().membership?.tenantId,
    }));
    const dispatch = createTenantApiDispatcher(dependencies(ALPHA_ID), [{ method: 'POST', pattern: 'products', access: 'admin', handler }]);

    const response = await dispatch(new Request('https://example.test/api/c/alpha-class/products', { method: 'POST' }), {
      slug: 'alpha-class', path: ['products'],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: ALPHA_ID, membershipTenantId: ALPHA_ID });
  });

  it('supports request-derived access decisions without trusting tenant inputs', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const dispatch = createTenantApiDispatcher(dependencies(), [{
      method: 'GET', pattern: 'products',
      access: (request) => new URL(request.url).searchParams.get('includeInactive') === '1' ? 'admin' : 'public',
      handler,
    }]);

    const response = await dispatch(new Request('https://example.test/api/c/alpha-class/products?includeInactive=1'), {
      slug: 'alpha-class', path: ['products'],
    });

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects routes outside the static allowlist', async () => {
    const dispatch = createTenantApiDispatcher(dependencies(), []);
    const response = await dispatch(new Request('https://example.test/api/c/alpha-class/generator/create'), {
      slug: 'alpha-class', path: ['generator', 'create'],
    });
    expect(response.status).toBe(404);
  });

  it('resolves the canonical tenant before invoking only the exact public login POST', async () => {
    const handler = vi.fn(async () => Response.json({ tenantId: getTrustedTenantRequestContext().tenant.id }));
    const deps = dependencies();
    const dispatch = createTenantApiDispatcher(deps, [{ method: 'POST', pattern: 'admin/login', access: 'public', handler }]);
    const response = await dispatch(new Request('https://example.test/api/c/alpha-class/admin/login', { method: 'POST' }), {
      slug: 'alpha-class', path: ['admin', 'login'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: ALPHA_ID });
    expect(deps.findBySlug).toHaveBeenCalledWith('alpha-class');
    expect(deps.getSession).not.toHaveBeenCalled();

    const getResponse = await dispatch(new Request('https://example.test/api/c/alpha-class/admin/login'), {
      slug: 'alpha-class', path: ['admin', 'login'],
    });
    expect(getResponse.status).toBe(404);
  });
});
