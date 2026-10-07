// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authorized: vi.fn(() => true), frozen: vi.fn(), sheets: vi.fn(), batch: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/apiAuth', () => ({ isAuthorizedAdminRequest: mocks.authorized, unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }) }));
vi.mock('@/server/legacyDeploymentMode', () => ({ legacyWriteFreezeResponse: mocks.frozen }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: mocks.sheets }));
vi.mock('@/server/sheetsRepository', () => ({ updateProductDetailsBatch: mocks.batch, deleteProductsBatch: vi.fn() }));
import { PATCH } from './route';
const operationId = 'd0600000-0000-4000-8000-000000000011';
const product = { productId: 'P1', name: 'Legacy', price: 10, isActive: false, sortOrder: 1 };
const request = (body: unknown) => new Request('https://legacy.invalid/api/products/batch', { method: 'PATCH', body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); mocks.authorized.mockReturnValue(true); mocks.frozen.mockReturnValue(null); vi.stubEnv('CLASS_STORE_STORAGE', 'sheets'); mocks.sheets.mockResolvedValue({ marker: 'sheets' }); });
afterEach(() => vi.unstubAllEnvs());
describe('D06 product batch route preserves legacy Sheets behavior', () => {
  it('passes omitted stock unchanged with exact request and ID', async () => {
    const req = request({ operationId, products: [product] });
    const saved = [{ ...product, stock: 91 }]; mocks.batch.mockResolvedValueOnce(saved);
    const response = await PATCH(req);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(saved);
    expect(mocks.sheets).toHaveBeenCalledWith(req);
    expect(mocks.batch).toHaveBeenCalledWith({ marker: 'sheets' }, [product], operationId);
  });
  it('does not introduce a Sheets CAS/refusal requirement for explicit stock', async () => {
    mocks.batch.mockResolvedValueOnce([{ ...product, stock: 97 }]);
    expect((await PATCH(request({ operationId, products: [{ ...product, stock: 97 }] }))).status).toBe(200);
    expect(mocks.batch).toHaveBeenCalledWith({ marker: 'sheets' }, [{ ...product, stock: 97 }], operationId);
  });
  it('authenticates and validates before Google access, retaining legacy errors', async () => {
    mocks.authorized.mockReturnValueOnce(false);
    expect((await PATCH(request({}))).status).toBe(401);
    expect((await PATCH(request({ operationId, products: [{ ...product, expectedProductVersion: 2 }] }))).status).toBe(400);
    expect(mocks.sheets).not.toHaveBeenCalled();
    mocks.batch.mockRejectedValueOnce(new Error('legacy failure'));
    const response = await PATCH(request({ operationId, products: [product] }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'legacy failure' });
  });
  it('keeps the legacy write freeze before authentication and adapter access', async () => {
    mocks.frozen.mockReturnValueOnce(Response.json({ error: 'frozen' }, { status: 423 }));
    expect((await PATCH(request({ operationId, products: [product] }))).status).toBe(423);
    expect(mocks.authorized).not.toHaveBeenCalled(); expect(mocks.sheets).not.toHaveBeenCalled();
  });
});
