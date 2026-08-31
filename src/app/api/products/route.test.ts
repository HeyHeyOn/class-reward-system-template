import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConfiguredCatalogReader: vi.fn(),
  createConfiguredSheetsReader: vi.fn(),
  createConfiguredSheetsStore: vi.fn(),
  getProducts: vi.fn(),
  getActiveProducts: vi.fn(),
  createProduct: vi.fn(),
}));

vi.mock('@/server/repositories/configuredCatalog', () => ({
  createConfiguredCatalogReader: mocks.createConfiguredCatalogReader,
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsReader: mocks.createConfiguredSheetsReader,
  createConfiguredSheetsStore: mocks.createConfiguredSheetsStore,
}));
vi.mock('@/server/sheetsRepository', () => ({
  getProducts: mocks.getProducts,
  getActiveProducts: mocks.getActiveProducts,
  createProduct: mocks.createProduct,
}));

import { GET } from '@/app/api/products/route';

const allProducts = [{
  productId: 'P001', name: '연필', price: 100, stock: 5, isActive: false, sortOrder: 1,
}];
const activeProducts = [{
  productId: 'P002', name: '지우개', price: 200, stock: 3, isActive: true, sortOrder: 2,
}];

describe('products GET catalog authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['0', 'getActiveProducts', activeProducts],
    ['1', 'getProducts', allProducts],
  ] as const)('delegates includeInactive=%s to the active catalog adapter', async (
    includeInactive,
    selectedMethod,
    expected,
  ) => {
    const catalog = {
      getProducts: vi.fn(async () => allProducts),
      getActiveProducts: vi.fn(async () => activeProducts),
    };
    mocks.createConfiguredCatalogReader.mockResolvedValueOnce(catalog);

    const response = await GET(new Request(
      `https://example.test/api/products?includeInactive=${includeInactive}`,
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(catalog[selectedMethod]).toHaveBeenCalledOnce();
    expect(catalog[selectedMethod === 'getProducts' ? 'getActiveProducts' : 'getProducts'])
      .not.toHaveBeenCalled();
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(mocks.getProducts).not.toHaveBeenCalled();
    expect(mocks.getActiveProducts).not.toHaveBeenCalled();
  });

  it('preserves the existing GET error projection', async () => {
    mocks.createConfiguredCatalogReader.mockRejectedValueOnce(new Error('catalog unavailable'));

    const response = await GET(new Request('https://example.test/api/products'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'catalog unavailable' });
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
  });
});
