import { describe, expect, it } from 'vitest';
import { tenantApiPath, tenantPagePath } from '@/lib/tenantApiPath';

describe('tenantApiPath', () => {
  it('creates independent API prefixes from each tab pathname', () => {
    expect(tenantApiPath('/api/products?includeInactive=1', '/c/alpha-class/admin')).toBe('/api/c/alpha-class/products?includeInactive=1');
    expect(tenantApiPath('/api/products?includeInactive=1', '/c/beta-class/admin')).toBe('/api/c/beta-class/products?includeInactive=1');
  });

  it('keeps legacy pages on compatibility API routes', () => {
    expect(tenantApiPath('/api/products', '/admin')).toBe('/api/products');
    expect(tenantApiPath('/api/google/session', '/c/alpha-class/admin')).toBe('/api/google/session');
  });

  it('scopes student QR rendering to the tenant selected by this tab', () => {
    expect(tenantApiPath('/api/qrcode?studentId=S001', '/c/alpha-class/admin'))
      .toBe('/api/c/alpha-class/qrcode?studentId=S001');
  });

  it('rejects malformed or noncanonical scoped pathnames', () => {
    expect(tenantApiPath('/api/products', '/c/Alpha-Class/admin')).toBe('/api/products');
    expect(tenantApiPath('/api/products', '/c/alpha_class/admin')).toBe('/api/products');
  });

  it('keeps internal page navigation in the current tab tenant', () => {
    expect(tenantPagePath('/admin', '/c/alpha-class/admin/transactions')).toBe('/c/alpha-class/admin');
    expect(tenantPagePath('/admin', '/c/beta-class/admin/transactions')).toBe('/c/beta-class/admin');
    expect(tenantPagePath('/admin', '/admin/transactions')).toBe('/admin');
  });
});
