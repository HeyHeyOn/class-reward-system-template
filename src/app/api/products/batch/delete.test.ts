// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantAdminContextDependencies } from '@/server/tenantAuth';
const mocks = vi.hoisted(() => ({
  access: {} as TenantAdminContextDependencies, commands: vi.fn(), batch: vi.fn(), single: vi.fn(),
  patch: vi.fn(), sheets: vi.fn(), legacy: vi.fn(), transaction: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: () => mocks.access }));
vi.mock('@/server/db/transaction', () => ({ withTenantTransaction: mocks.transaction }));
vi.mock('@/server/repositories/database/catalogCommands', async (original) => ({ ...await original<object>(), createDatabaseCatalogCommands: mocks.commands }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: mocks.sheets }));
vi.mock('@/server/sheetsRepository', () => ({ deleteProduct: vi.fn(), deleteProductsBatch: mocks.legacy }));
import { DELETE, PATCH } from '@/app/api/c/[slug]/[...path]/route';
import { DELETE as unscoped } from './route';
import { ProductAdminConflictError } from '@/server/repositories/database/catalogCommands';
const A = 'd0800000-0000-4000-8000-000000000001';
const B = 'd0800000-0000-4000-8000-000000000002';
const body = { operationId: 'd0800000-0000-4000-8000-000000000011', products: [
  { productId: 'P1', expectedProductVersion: 3 }, { productId: 'P2', expectedProductVersion: 8 },
] };
const completedAt = '2026-09-30T14:00:00.000Z';
const result = (products = body.products) => ({
  ok: true, operationId: body.operationId, action: 'DEACTIVATE', completedAt,
  products: products.map((p) => ({
    productId: p.productId, name: p.productId, price: 10, stock: 20, isActive: false,
    imageUrl: null, category: null, sortOrder: 1, productVersionBefore: p.expectedProductVersion,
    productVersionAfter: p.expectedProductVersion + 1, stockBefore: 20, stockAfter: 20,
    inventoryEventId: null, deletedAt: completedAt,
  })),
});
const request = (input: unknown, method = 'DELETE') => new Request('https://test.invalid/api/c/d08-a/products/batch?tenantId=' + B, {
  method, headers: { 'x-tenant-id': B, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
});
const call = (input: unknown = body) => DELETE(request(input), { params: Promise.resolve({ slug: 'd08-a', path: ['products', 'batch'] }) });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CLASS_STORE_STORAGE', 'sheets'); vi.stubEnv('ADMIN_PASSWORD', '');
  vi.stubEnv('AUTH_SECRET', ''); vi.stubEnv('MIGRATION_READ_ONLY', '');
  vi.stubEnv('GOOGLE_CLIENT_ID', ''); vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
  Object.assign(mocks.access, {
    findBySlug: vi.fn(async () => ({ id: A, slug: 'd08-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' })),
    getSession: vi.fn(() => ({ subject: 'owner', email: 'owner@example.test', issuedAt: Date.now() })),
    findByTenantAndSubject: vi.fn(async () => ({ id: 'm', tenantId: A, userId: 'u', googleSubject: 'owner', role: 'ADMIN' })),
  });
  mocks.commands.mockReturnValue({ deactivateBatch: mocks.batch, deactivate: mocks.single, updateBatch: mocks.patch });
  mocks.batch.mockResolvedValue(result());
  mocks.sheets.mockResolvedValue({ legacy: true }); mocks.legacy.mockResolvedValue({ productIds: ['P1', '2'] });
});
afterEach(() => vi.unstubAllEnvs());
describe('D08 actual scoped product batch DELETE dispatch', () => {
  it('selects batch handler, forwards multiple versioned IDs, ignores header/query/environment authority', async () => {
    vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_ID', B);
    const response = await call();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ productIds: ['P1', 'P2'], operationId: body.operationId });
    expect(mocks.commands).toHaveBeenCalledWith({ tenantId: A, runTenantTransaction: mocks.transaction });
    expect(mocks.batch).toHaveBeenCalledWith(body);
    expect(mocks.single).not.toHaveBeenCalled(); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it.each([
    {}, { productIds: ['P1'] }, { ...body, operationId: 'not-uuid' }, { ...body, tenantId: B },
    { ...body, products: [] }, { ...body, products: [body.products[0], body.products[0]] },
    { ...body, products: [{ productId: ' P1 ', expectedProductVersion: 3 }] },
    { ...body, products: [{ productId: '', expectedProductVersion: 3 }] },
    { ...body, products: [{ productId: 1, expectedProductVersion: 3 }] },
    { ...body, products: [{ productId: 'P1', expectedProductVersion: '3' }] },
    { ...body, products: [{ productId: 'P1', expectedProductVersion: 0 }] },
    { ...body, products: [{ productId: 'P1', expectedProductVersion: Number.MAX_SAFE_INTEGER }] },
    { ...body, products: [{ ...body.products[0], stock: 0 }] },
  ])('rejects malformed/duplicate payload before persistence: %j', async (input) => {
    const response = await call(input); expect(response.status).toBe(400);
    expect(mocks.batch).not.toHaveBeenCalled(); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it('requires identity and exact tenant membership before any commands', async () => {
    vi.mocked(mocks.access.getSession).mockReturnValueOnce(null);
    expect((await call()).status).toBe(401);
    vi.mocked(mocks.access.findByTenantAndSubject).mockResolvedValueOnce(null);
    expect((await call()).status).toBe(403);
    vi.mocked(mocks.access.findByTenantAndSubject).mockResolvedValueOnce({ id: 'm', tenantId: B, userId: 'u', googleSubject: 'owner', role: 'OWNER' });
    expect((await call()).status).toBe(403);
    vi.mocked(mocks.access.findByTenantAndSubject).mockResolvedValueOnce({ id: 'm', tenantId: A, userId: 'u', googleSubject: 'another-owner', role: 'ADMIN' });
    expect((await call()).status).toBe(403);
    expect(mocks.commands).not.toHaveBeenCalled(); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it('fails closed for DRAFT and absent trusted PG context', async () => {
    vi.mocked(mocks.access.findBySlug).mockResolvedValueOnce({ id: A, slug: 'd08-a', displayName: 'A', lifecycle: 'DRAFT', timezone: 'Asia/Seoul' });
    expect((await call()).status).toBe(500);
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    expect((await unscoped(request(body))).status).toBe(401);
    expect(mocks.commands).not.toHaveBeenCalled(); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it('maps CAS conflict and never falls back to Sheets or exposes PG errors', async () => {
    mocks.batch.mockRejectedValueOnce(new ProductAdminConflictError('STALE_VERSION'));
    const stale = await call(); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'STALE_VERSION' });
    mocks.batch.mockRejectedValueOnce(new Error('postgres://secret:password@private-host/failure'));
    const failed = await call(); expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('private-host');
    expect(mocks.sheets).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it('leaves the actual scoped single-product DELETE and D06 batch PATCH selected', async () => {
    mocks.single.mockResolvedValueOnce(result([body.products[0]]));
    const single = await DELETE(request({ operationId: body.operationId, expectedProductVersion: 3 }), { params: Promise.resolve({ slug: 'd08-a', path: ['products', 'P1'] }) });
    expect(single.status).toBe(200); expect(await single.json()).toEqual({ productId: 'P1' });
    expect(mocks.single).toHaveBeenCalledWith({ ...body.products[0], operationId: body.operationId });
    mocks.patch.mockResolvedValueOnce({ products: [{ productId: 'P1', name: 'Edited', price: 1, stock: 2, isActive: true, sortOrder: 1, imageUrl: null, category: null, productVersionAfter: 4 }] });
    const patchBody = { operationId: body.operationId, products: [{ ...body.products[0], name: 'Edited', price: 1, stock: 2, isActive: true, sortOrder: 1 }] };
    const patched = await PATCH(request(patchBody, 'PATCH'), { params: Promise.resolve({ slug: 'd08-a', path: ['products', 'batch'] }) });
    expect(patched.status).toBe(200); expect(await patched.json()).toEqual([expect.objectContaining({ productVersion: 4, stock: 2 })]);
    expect(mocks.patch).toHaveBeenCalledWith(patchBody); expect(mocks.batch).not.toHaveBeenCalled();
  });
  it('preserves unscoped legacy coercion and response, not a PG fallback', async () => {
    const req = request({ productIds: ['P1', 2] });
    const response = await unscoped(req);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ productIds: ['P1', '2'] });
    expect(mocks.sheets).toHaveBeenCalledWith(req);
    expect(mocks.legacy).toHaveBeenCalledWith({ legacy: true }, ['P1', '2']); expect(mocks.commands).not.toHaveBeenCalled();
  });
  it('keeps unscoped DELETE authentication, freeze precedence and legacy errors', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'synthetic-test-password');
    expect((await unscoped(request({ productIds: ['P1'] }))).status).toBe(401);
    vi.stubEnv('MIGRATION_READ_ONLY', 'true');
    const frozen = await unscoped(request({ productIds: ['P1'] }));
    expect(frozen.status).toBe(503); expect(await frozen.json()).toMatchObject({ code: 'MIGRATION_READ_ONLY' });
    expect(mocks.sheets).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
    vi.stubEnv('ADMIN_PASSWORD', ''); vi.stubEnv('MIGRATION_READ_ONLY', '');
    mocks.legacy.mockRejectedValueOnce(new Error('legacy delete failure'));
    const failed = await unscoped(request({ productIds: ['P1'] }));
    expect(failed.status).toBe(400); expect(await failed.json()).toEqual({ error: 'legacy delete failure' });
    expect(mocks.commands).not.toHaveBeenCalled();
  });
});
