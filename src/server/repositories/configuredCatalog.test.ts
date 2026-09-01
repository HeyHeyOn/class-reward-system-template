import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Product, Promotion } from '@/domain/types';
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
const PROMOTIONS: Promotion[] = [{
  promotionId: 'PROMO-1', name: '할인', description: '', type: 'FIXED_DISCOUNT',
  discountAmount: 10, productIds: ['P001'], startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2027-01-01T00:00:00.000Z', isActive: true, sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: 3,
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
      getPromotionsForAdminMutation: vi.fn(async () => ({ promotions: [], mutationPreconditions: [] })),
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
    Object.defineProperty(creators, 'createSheets', {
      enumerable: true, value: unselectedSheetsCreator,
    });

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
    Object.defineProperty(creators, 'createPostgresql', {
      enumerable: true, value: unselectedPostgresqlCreator,
    });
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

  it('builds a detached Sheets admin mutation snapshot lazily with one promotion read', async () => {
    const request = new Request('http://localhost/api/admin/promotions');
    const reader = { getRows: vi.fn() };
    const createConfiguredSheetsReader = vi.fn(async () => reader);
    const getPromotions = vi.fn(async () => PROMOTIONS);
    const creators = createCatalogRepositoryCreators({
      createDatabaseCatalogQueries: vi.fn(), withTenantSnapshot: vi.fn(),
      createConfiguredSheetsReader, getProducts: vi.fn(), getActiveProducts: vi.fn(),
      getPromotions, getActivePromotions: vi.fn(),
    }, request);
    const catalog = await createConfiguredCatalogReader({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(), creators,
    });
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();

    const snapshot = await catalog.getPromotionsForAdminMutation();
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(getPromotions).toHaveBeenCalledOnce();
    expect(getPromotions).toHaveBeenCalledWith(reader);
    expect(snapshot).toEqual({
      promotions: PROMOTIONS,
      mutationPreconditions: [{ promotionId: 'PROMO-1', expectedVersion: 1 }],
    });
    expect(snapshot.promotions).not.toBe(PROMOTIONS);
    expect(PROMOTIONS[0]).not.toHaveProperty('version');
    snapshot.mutationPreconditions[0].expectedVersion = 99;
    const second = await catalog.getPromotionsForAdminMutation();
    expect(second.mutationPreconditions).toEqual([{ promotionId: 'PROMO-1', expectedVersion: 1 }]);
  });

  it('uses the tenant-bound PostgreSQL admin snapshot and never falls back to Sheets', async () => {
    const dbError = new Error('database unavailable');
    const databaseAdapter = {
      getProducts: vi.fn(), getActiveProducts: vi.fn(), getPromotions: vi.fn(),
      getActivePromotions: vi.fn(),
      getPromotionsForAdminMutation: vi.fn(async () => { throw dbError; }),
    };
    const createDatabaseCatalogQueries = vi.fn(() => databaseAdapter);
    const sheetsGetter = vi.fn(() => { throw new Error('Sheets accessed'); });
    const creators = createCatalogRepositoryCreators({
      createDatabaseCatalogQueries, withTenantSnapshot: vi.fn(),
      createConfiguredSheetsReader: vi.fn(), getProducts: vi.fn(), getActiveProducts: vi.fn(),
      getPromotions: vi.fn(), getActivePromotions: vi.fn(),
    });
    Object.defineProperty(creators, 'createSheets', { enumerable: true, value: sheetsGetter });
    const catalog = await createConfiguredCatalogReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });

    await expect(catalog.getPromotionsForAdminMutation()).rejects.toBe(dbError);
    expect(createDatabaseCatalogQueries).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }));
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('recognizes Request first and rejects unsafe options before getters or creators run', async () => {
    const request = new Request('http://localhost/api/catalog');
    const hostile = vi.fn(() => { throw new Error('hostile getter'); });
    Object.defineProperties(request, {
      env: { enumerable: true, get: hostile },
      getCentralTenantContext: { enumerable: true, get: hostile },
      creators: { enumerable: true, get: hostile },
    });
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    await expect(createConfiguredCatalogReader(request)).resolves.toBeDefined();
    expect(hostile).not.toHaveBeenCalled();

    const getter = vi.fn(() => { throw new Error('option getter invoked'); });
    const invoked = vi.fn();
    const valid = () => ({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(),
      creators: { createPostgresql: vi.fn(invoked), createSheets: vi.fn(invoked) },
    });
    const getterOptions = valid();
    Object.defineProperty(getterOptions, 'env', { enumerable: true, get: getter });
    const creatorGetter = valid();
    Object.defineProperty(creatorGetter.creators, 'createSheets', { enumerable: true, get: getter });
    const envGetter = valid();
    Object.defineProperty(envGetter.env, 'CLASS_STORE_STORAGE', { enumerable: true, get: getter });
    const symbolOptions = valid() as Record<PropertyKey, unknown>;
    symbolOptions[Symbol('extra')] = true;
    const malformed: unknown[] = [
      {}, getterOptions, creatorGetter, envGetter, symbolOptions,
      { ...valid(), extra: true }, Object.assign(Object.create({}), valid()),
      { ...valid(), env: Object.assign(Object.create({}), valid().env) },
      { ...valid(), creators: Object.assign(Object.create({}), valid().creators) },
      { ...valid(), getCentralTenantContext: 'bad' },
    ];
    for (const value of malformed) {
      await expect(createConfiguredCatalogReader(value as never))
        .rejects.toThrow(/invalid configured catalog options/i);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tenant context', undefined],
    ['invalid tenant UUID', activeTenant({ tenantId: 'not-a-uuid' })],
    ['inactive tenant', activeTenant({ tenantStatus: 'SUSPENDED' })],
  ])('fails closed for PostgreSQL with %s before accessing creators', async (_label, tenantContext) => {
    const creators = {} as Parameters<typeof createConfiguredCatalogReader>[0]['creators'];
    const postgresGetter = vi.fn(() => { throw new Error('PostgreSQL creator invoked'); });
    const sheetsGetter = vi.fn(() => { throw new Error('Sheets creator invoked'); });
    Object.defineProperties(creators, {
      createPostgresql: { enumerable: true, value: postgresGetter },
      createSheets: { enumerable: true, value: sheetsGetter },
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
    const sheetsGetter = vi.fn(() => { throw new Error('Sheets creator invoked'); });
    const creators = { createPostgresql, createSheets: sheetsGetter } as unknown as
      Parameters<typeof createConfiguredCatalogReader>[0]['creators'];

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
