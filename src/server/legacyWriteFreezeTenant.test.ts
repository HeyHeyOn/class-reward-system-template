// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from './db/testing/pglite';
import { createTenantApiDispatcher } from './tenantApiDispatcher';
import { createCartPricingPreview } from '@/domain/checkout';
import { POST as checkout } from '@/app/api/checkout/route';
import { POST as createProduct } from '@/app/api/products/route';

vi.mock('server-only', () => ({}));
let harness: PgliteDatabaseHarness;
// Replace only the external pool/transaction transport, preserving real configured adapters and SQL commands.
vi.mock('./db/transaction', async importOriginal => {
  const actual = await importOriginal<typeof import('./db/transaction')>();
  return { ...actual, withTenantTransaction: (...args: Parameters<typeof actual.withTenantTransaction>) => harness.runTenantTransaction(...args) };
});
const forbidden = vi.hoisted(() => ({ sheets: vi.fn(() => { throw new Error('No Sheets fallback'); }) }));
vi.mock('googleapis', () => ({ google: { sheets: forbidden.sheets } }));

beforeAll(async () => {
  vi.stubEnv('MIGRATION_READ_ONLY', 'true');
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external network'); }));
  harness = await createPgliteDatabaseHarness();
  await harness.database.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [harness.tenantOneId]);
  await harness.database.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'s1','Student','ACTIVE')", [harness.tenantOneId]);
  await harness.database.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'s1',100)", [harness.tenantOneId]);
  await harness.database.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,'p1','Pencil',10,5,true,1)", [harness.tenantOneId]);
});
afterAll(async () => { await harness?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function dispatch() {
  return createTenantApiDispatcher({
    findBySlug: async slug => slug === 'class-a' ? {
      id: harness.tenantOneId, slug, displayName: 'Class A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul',
    } : null,
    getSession: async () => ({ subject: 'nonmember', email: 'nonmember@example.invalid', issuedAt: 1 }),
    findByTenantAndSubject: async () => null,
  }, [
    { method: 'POST', pattern: 'checkout', access: 'public', handler: checkout },
    { method: 'POST', pattern: 'products', access: 'admin', handler: createProduct },
  ]);
}
function request(scoped = true) {
  const items = [{ productId: 'p1', quantity: 1 }];
  const expectedPricing = createCartPricingPreview({ cartItems: items, products: [
    { productId: 'p1', name: 'Pencil', price: 10, stock: 5, isActive: true, sortOrder: 1 },
  ], now: new Date() });
  if (!expectedPricing.ok) throw new Error('Invalid fixture');
  return new Request(`https://central.example/api/${scoped ? 'c/class-a/' : ''}checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': harness.tenantTwoId },
    body: JSON.stringify({ operationId: '10000000-0000-4000-8000-000000000001', studentId: 's1', items, expectedPricing }),
  });
}

describe('freeze is not tenant routing or authorization authority', () => {
  it('executes a real active PostgreSQL checkout under canonical dispatcher authority', async () => {
    const response = await dispatch()(request(), { slug: 'class-a', path: ['checkout'] });
    expect(response.status, await response.text()).toBe(200);
    expect((await harness.database.query<{ balance: string }>('SELECT balance::text FROM accounts WHERE tenant_id=$1', [harness.tenantOneId])).rows)
      .toEqual([{ balance: '90' }]);
    expect((await harness.database.query<{ stock: string }>('SELECT stock::text FROM products WHERE tenant_id=$1', [harness.tenantOneId])).rows)
      .toEqual([{ stock: '4' }]);
    expect(forbidden.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not let a spoofed header unfreeze an unscoped legacy request', async () => {
    const response = await checkout(request(false));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('MIGRATION_READ_ONLY');
    expect(forbidden.sheets).not.toHaveBeenCalled();
  });
  it('retains nonmember denial instead of replacing auth with migration policy', async () => {
    const response = await dispatch()(new Request('https://central.example/api/c/class-a/products', { method: 'POST', body: '{}' }), {
      slug: 'class-a', path: ['products'],
    });
    expect(response.status).toBe(403);
  });
});
