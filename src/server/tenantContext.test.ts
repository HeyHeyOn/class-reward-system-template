import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  TenantContextError,
  compatibilityRedirectForPath,
  parseTenantSlug,
  resolveTenantContext,
  scopedTenantPath,
} from '@/server/tenantContext';

const ALPHA_ID = '20000000-0000-4000-8000-000000000001';
const alpha = {
  id: ALPHA_ID,
  slug: 'alpha-class',
  displayName: 'Alpha Class',
  lifecycle: 'ACTIVE' as const,
  timezone: 'Asia/Seoul' as const,
};

describe('tenant route context', () => {
  it('normalizes a safe mixed-case slug and identifies its canonical redirect', () => {
    expect(parseTenantSlug('Alpha-Class')).toEqual({
      slug: 'alpha-class',
      needsRedirect: true,
    });
    expect(scopedTenantPath('Alpha-Class', '/bank')).toEqual({
      path: '/c/alpha-class/bank',
      needsRedirect: true,
    });
  });

  it.each(['', '-alpha', 'alpha-', 'alpha--class', 'alpha_class', 'a'.repeat(64), '../alpha', 'alpha%2Fadmin'])(
    'rejects invalid tenant slug %j',
    (slug) => {
      expect(() => parseTenantSlug(slug)).toThrowError(TenantContextError);
    },
  );

  it('resolves only the tenant returned for the canonical URL slug', async () => {
    const findBySlug = vi.fn(async (slug: string) => slug === alpha.slug ? alpha : null);

    await expect(resolveTenantContext('Alpha-Class', { findBySlug })).resolves.toEqual({
      tenant: alpha,
      needsRedirect: true,
    });
    expect(findBySlug).toHaveBeenCalledWith('alpha-class');
  });

  it('fails closed when a directory returns a tenant for a different slug', async () => {
    const findBySlug = vi.fn(async () => ({ ...alpha, slug: 'other-class' }));

    await expect(resolveTenantContext('alpha-class', { findBySlug }))
      .rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISMATCH', status: 403 });
  });

  it('maps legacy pages only through an explicitly configured default tenant', () => {
    expect(compatibilityRedirectForPath('/', 'Default-Class')).toBe('/c/default-class');
    expect(compatibilityRedirectForPath('/bank', 'default-class')).toBe('/c/default-class/bank');
    expect(compatibilityRedirectForPath('/admin/settings', 'default-class'))
      .toBe('/c/default-class/admin/settings');
    expect(compatibilityRedirectForPath('/classes', 'default-class')).toBeNull();
    expect(compatibilityRedirectForPath('/bank', undefined)).toBeNull();
  });
});
