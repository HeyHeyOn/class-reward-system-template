import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Product } from '@/domain/types';
import {
  createCatalogRepositoryCreators,
  createConfiguredCatalogReader,
} from '@/server/repositories/configuredCatalog';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const PRODUCTS: Product[] = [{
  productId: 'P001',
  name: '연필',
  price: 100,
  stock: 5,
  isActive: true,
  sortOrder: 1,
}];

function activeTenant(overrides: Record<string, unknown> = {}) {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE', ...overrides };
}

describe('configured catalog read composition root', () => {
  it('selects PostgreSQL and builds catalog queries with the tenant snapshot runner', async () => {
    const withTenantSnapshot = vi.fn();
    const databaseAdapter = {
      getProducts: vi.fn(async () => PRODUCTS),
      getActiveProducts: vi.fn(async () => PRODUCTS),
      getPromotions: vi.fn(async () => []),
      getActivePromotions: vi.fn(async () => []),
    };
    const createDatabaseCatalogQueries = vi.fn(() => databaseAdapter);
    const createConfiguredSheetsReader = vi.fn();
    const creators = createCatalogRepositoryCreators({
      createDatabaseCatalogQueries,
      withTenantSnapshot,
      createConfiguredSheetsReader,
      getProducts: vi.fn(),
      getActiveProducts: vi.fn(),
      getPromotions: vi.fn(),
      getActivePromotions: vi.fn(),
    });
    const unselectedSheetsCreator = vi.fn(() => {
      throw new Error('unselected Sheets creator accessed');
    });
    Object.defineProperty(creators, 'createSheets', { get: unselectedSheetsCreator });

    const catalog = await createConfiguredCatalogReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    expect(catalog).toBe(databaseAdapter);
    expect(createDatabaseCatalogQueries).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: withTenantSnapshot,
    });
    expect(unselectedSheetsCreator).not.toHaveBeenCalled();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
  });

  it('selects explicit Sheets and lazily delegates both reads to one configured reader', async () => {
    const request = new Request('http://localhost/api/promotions');
    const reader = { getRows: vi.fn() };
    const createConfiguredSheetsReader = vi.fn(async () => reader);
    const getProducts = vi.fn(async () => PRODUCTS);
    const getActiveProducts = vi.fn(async () => PRODUCTS);
    const getPromotions = vi.fn(async () => []);
    const getActivePromotions = vi.fn(async () => []);
    const creators = createCatalogRepositoryCreators({
      createDatabaseCatalogQueries: vi.fn(),
      withTenantSnapshot: vi.fn(),
      createConfiguredSheetsReader,
      getProducts,
      getActiveProducts,
      getPromotions,
      getActivePromotions,
    }, request);
    const unselectedPostgresqlCreator = vi.fn(() => {
      throw new Error('unselected PostgreSQL creator accessed');
    });
    Object.defineProperty(creators, 'createPostgresql', { get: unselectedPostgresqlCreator });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const catalog = await createConfiguredCatalogReader({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext,
      creators,
    });

    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await expect(catalog.getProducts()).resolves.toEqual(PRODUCTS);
    await expect(catalog.getActiveProducts()).resolves.toEqual(PRODUCTS);
    await expect(catalog.getPromotions()).resolves.toEqual([]);
    await expect(catalog.getActivePromotions()).resolves.toEqual([]);
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(getProducts).toHaveBeenCalledWith(reader);
    expect(getActiveProducts).toHaveBeenCalledWith(reader);
    expect(getPromotions).toHaveBeenCalledWith(reader);
    expect(getActivePromotions).toHaveBeenCalledWith(reader);
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(unselectedPostgresqlCreator).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tenant context', undefined],
    ['invalid tenant UUID', activeTenant({ tenantId: 'not-a-uuid' })],
    ['inactive tenant', activeTenant({ tenantStatus: 'SUSPENDED' })],
  ])('fails closed for PostgreSQL with %s before accessing creators', async (_label, tenantContext) => {
    const creators = {} as Parameters<typeof createConfiguredCatalogReader>[0]['creators'];
    const postgresGetter = vi.fn(() => vi.fn());
    const sheetsGetter = vi.fn(() => vi.fn());
    Object.defineProperties(creators, {
      createPostgresql: { get: postgresGetter },
      createSheets: { get: sheetsGetter },
    });

    await expect(createConfiguredCatalogReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => tenantContext,
      creators,
    })).rejects.toThrow(/tenant|ACTIVE/i);
    expect(postgresGetter).not.toHaveBeenCalled();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('propagates PostgreSQL read failure without accessing Sheets', async () => {
    const dbError = new Error('database unavailable');
    const createPostgresql = vi.fn(async () => ({
      getProducts: vi.fn(async () => { throw dbError; }),
      getActiveProducts: vi.fn(async () => { throw dbError; }),
    }));
    const sheetsGetter = vi.fn(() => vi.fn());
    const creators = { createPostgresql } as unknown as
      Parameters<typeof createConfiguredCatalogReader>[0]['creators'];
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const catalog = await createConfiguredCatalogReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    await expect(catalog.getProducts()).rejects.toBe(dbError);
    expect(createPostgresql).toHaveBeenCalledOnce();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });
});
