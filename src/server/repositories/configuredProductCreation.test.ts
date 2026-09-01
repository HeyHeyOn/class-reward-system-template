import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ createProduct: vi.fn() }));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  createConfiguredProductCreation,
  createProductCreationRepositoryCreators,
} from '@/server/repositories/configuredProductCreation';
import { createProduct } from '@/server/sheetsRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  productId: ' P001 ',
  name: ' 연필 ',
  price: 100,
  stock: 5,
  isActive: true,
  imageUrl: ' ',
  category: '문구',
  sortOrder: 1,
};

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('configured product creation composition root', () => {
  it('uses the active PostgreSQL authority, forwards input unchanged, and projects one legacy product', async () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      operationId: INPUT.operationId,
      action: 'CREATE' as const,
      completedAt: '2026-09-01T00:00:00.000Z',
      products: [{
        productId: 'P001', name: '연필', price: 100, stock: 5, isActive: true,
        imageUrl: null, category: '문구', sortOrder: 1,
        productVersionBefore: null, productVersionAfter: 1,
        stockBefore: null, stockAfter: 5, inventoryEventId: 'event-id',
      }],
    }));
    const createDatabaseCatalogCommands = vi.fn(() => ({ create }));
    const runTenantTransaction = vi.fn();
    const createSheetsStore = vi.fn();
    const creators = createProductCreationRepositoryCreators({
      createDatabaseCatalogCommands,
      withTenantTransaction: runTenantTransaction,
      createConfiguredSheetsStore: createSheetsStore,
      createProduct: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredProductCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });
    const product = await command.create(INPUT);

    expect(createDatabaseCatalogCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction,
    });
    expect(create).toHaveBeenCalledWith(INPUT);
    expect(product).toEqual({
      productId: 'P001', name: '연필', price: 100, stock: 5, isActive: true,
      category: '문구', sortOrder: 1,
    });
    expect(Object.keys(product)).toEqual([
      'productId', 'name', 'price', 'stock', 'isActive', 'category', 'sortOrder',
    ]);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createSheetsStore).not.toHaveBeenCalled();
  });

  it('rejects a PostgreSQL result that does not contain exactly one created product', async () => {
    const creators = createProductCreationRepositoryCreators({
      createDatabaseCatalogCommands: vi.fn(() => ({
        create: vi.fn(async () => ({ products: [] })),
      })) as never,
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore: vi.fn(),
      createProduct: vi.fn(),
    });
    const command = await createConfiguredProductCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    await expect(command.create(INPUT)).rejects.toThrow(/exactly one/i);
  });

  it('keeps Sheets lazy, forwards the exact Request, strips only operationId, and returns unchanged', async () => {
    const request = new Request('http://localhost/api/products', { method: 'POST' });
    const store = { marker: 'sheets' };
    const legacyProduct = {
      productId: 'P001', name: '연필', price: 100, stock: 5, isActive: true,
      category: '문구', sortOrder: 1,
    };
    const createSheetsStore = vi.fn(async () => store as never);
    const createLegacyProduct = vi.fn(async () => legacyProduct);
    const creators = createProductCreationRepositoryCreators({
      createDatabaseCatalogCommands: vi.fn(),
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore: createSheetsStore,
      createProduct: createLegacyProduct,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const command = await createConfiguredProductCreation({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createSheetsStore).not.toHaveBeenCalled();
    await expect(command.create(INPUT)).resolves.toBe(legacyProduct);
    expect(createSheetsStore).toHaveBeenCalledWith(request);
    expect(createLegacyProduct).toHaveBeenCalledWith(store, {
      productId: INPUT.productId,
      name: INPUT.name,
      price: INPUT.price,
      stock: INPUT.stock,
      isActive: INPUT.isActive,
      imageUrl: INPUT.imageUrl,
      category: INPUT.category,
      sortOrder: INPUT.sortOrder,
    });
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('recognizes a decorated Request before the full own-property options discriminator', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/products', { method: 'POST' });
    Object.defineProperties(request, {
      env: { value: { CLASS_STORE_STORAGE: 'postgresql' } },
      getCentralTenantContext: { value: vi.fn(() => activeTenant()) },
      creators: { value: { createSheets: vi.fn(() => { throw new Error('wrong options'); }) } },
    });
    const store = { marker: 'decorated-request-store' };
    const legacyProduct = {
      productId: 'P001', name: '연필', price: 100, stock: 5, isActive: true, sortOrder: 1,
    };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(createProduct).mockResolvedValue(legacyProduct);

    const command = await createConfiguredProductCreation(request);
    await expect(command.create(INPUT)).resolves.toBe(legacyProduct);

    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
  });
});
