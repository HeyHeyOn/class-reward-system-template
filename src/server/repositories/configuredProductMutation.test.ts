// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from './contracts';
const mocks = vi.hoisted(() => ({ sheets: vi.fn(), batch: vi.fn(), updateBatch: vi.fn(), commands: vi.fn(), transaction: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: mocks.sheets }));
vi.mock('@/server/sheetsRepository', () => ({ updateProductDetailsBatch: mocks.batch }));
vi.mock('@/server/db/transaction', () => ({ withTenantTransaction: mocks.transaction }));
vi.mock('./database/catalogCommands', async (original) => ({ ...await original<object>(), createDatabaseCatalogCommands: mocks.commands }));
import { createConfiguredProductMutation } from './configuredProductMutation';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

const tenantId = 'd0600000-0000-4000-8000-000000000001' as TenantId;
const row = { productId: 'P1', name: 'Name', price: 10, stock: 21, isActive: false, sortOrder: 1, expectedProductVersion: 3 };
const body = { operationId: 'd0600000-0000-4000-8000-000000000011', products: [row] };
function scoped<T>(callback: () => T, lifecycle: 'ACTIVE' | 'DRAFT' = 'ACTIVE') {
  return runWithTrustedTenantRequestContext({ tenant: { id: tenantId, slug: 'd06-a', displayName: 'A', timezone: 'Asia/Seoul', lifecycle } }, callback);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.commands.mockReturnValue({ updateBatch: mocks.updateBatch });
  mocks.updateBatch.mockResolvedValue({ products: [{ ...row, imageUrl: null, category: null, productVersionAfter: 4 }] });
  mocks.sheets.mockResolvedValue({ marker: 'sheets' });
});
afterEach(() => vi.unstubAllEnvs());

describe('D06 configured product mutation', () => {
  it('uses only trusted tenant and projects committed version without a second read', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_ID', 'd0600000-0000-4000-8000-000000000002');
    const result = await scoped(async () => (await createConfiguredProductMutation()).updateBatch(body));
    expect(mocks.commands).toHaveBeenCalledWith({ tenantId, runTenantTransaction: mocks.transaction });
    expect(mocks.updateBatch).toHaveBeenCalledWith(body);
    expect(result).toEqual([{ productId: 'P1', name: 'Name', price: 10, stock: 21, isActive: false, sortOrder: 1, productVersion: 4 }]);
    expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it('preserves versionless Sheets omitted-stock contract and exact request', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/products/batch');
    const legacy = { operationId: body.operationId, products: [{ productId: 'P1', name: 'Name', price: 10, isActive: false, sortOrder: 1 }] };
    mocks.batch.mockResolvedValue([{ ...legacy.products[0], stock: 20 }]);
    expect(await (await createConfiguredProductMutation(request)).updateBatch(legacy)).toHaveLength(1);
    expect(mocks.sheets).toHaveBeenCalledWith(request);
    expect(mocks.batch).toHaveBeenCalledWith({ marker: 'sheets' }, legacy.products, body.operationId);
    expect(mocks.commands).not.toHaveBeenCalled();
  });
  it.each([
    ['missing version', { ...body, products: [{ ...row, expectedProductVersion: undefined }] }],
    ['coerced version', { ...body, products: [{ ...row, expectedProductVersion: '3' }] }],
    ['tenant injection', { ...body, tenantId }],
    ['uppercase ID', { ...body, operationId: body.operationId.toUpperCase() }],
    ['partial PG row', { ...body, products: [{ ...row, stock: undefined }] }],
  ])('rejects %s before commands or Google', async (_label, input) => {
    await expect(scoped(async () => (await createConfiguredProductMutation()).updateBatch(input))).rejects.toThrow();
    expect(mocks.updateBatch).not.toHaveBeenCalled(); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it('rejects DRAFT/absent trusted context despite compatibility env and never falls back after PG failure', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_ID', tenantId);
    vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_STATUS', 'ACTIVE');
    await expect(createConfiguredProductMutation()).rejects.toThrow();
    await expect(scoped(() => createConfiguredProductMutation(), 'DRAFT')).rejects.toThrow(/ACTIVE/);
    mocks.updateBatch.mockRejectedValueOnce(new Error('PG offline'));
    await expect(scoped(async () => (await createConfiguredProductMutation()).updateBatch(body))).rejects.toThrow('PG offline');
    expect(mocks.sheets).not.toHaveBeenCalled();
  });
});
