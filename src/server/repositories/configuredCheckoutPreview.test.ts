import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Product, Promotion } from '@/domain/types';
import {
  createCheckoutPreviewRepositoryCreators,
  createConfiguredCheckoutPreviewService,
} from '@/server/repositories/configuredCheckoutPreview';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const PRODUCTS: Product[] = [{
  productId: 'P1', name: '연필', price: 100, stock: 5, isActive: true, sortOrder: 1,
}];
const PROMOTIONS: Promotion[] = [];
const SUCCESS = { ok: true as const, totalAmount: 100, items: [] };

function activeTenant(overrides: Record<string, unknown> = {}) {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE', ...overrides };
}

describe('configured checkout preview composition root', () => {
  it('loads products and promotions in one PostgreSQL snapshot then calls pricing logic', async () => {
    const transaction = { marker: 'snapshot' };
    const withTenantSnapshot = vi.fn(async (_tenantId, callback) => callback(transaction as never));
    const getProducts = vi.fn(async () => PRODUCTS);
    const getActivePromotions = vi.fn(async () => PROMOTIONS);
    const createDatabaseCatalogQueries = vi.fn(({ runTenantTransaction }) => ({
      getProducts: () => runTenantTransaction(TENANT_ID, async (received: unknown) => {
        expect(received).toBe(transaction);
        return getProducts();
      }),
      getActiveProducts: vi.fn(), getProductById: vi.fn(), getPromotions: vi.fn(),
      getActivePromotions: () => runTenantTransaction(TENANT_ID, async (received: unknown) => {
        expect(received).toBe(transaction);
        return getActivePromotions();
      }),
      getPromotionById: vi.fn(),
    }));
    const createCartPricingPreview = vi.fn(() => SUCCESS);
    const createConfiguredSheetsStore = vi.fn();
    const creators = createCheckoutPreviewRepositoryCreators({
      createDatabaseCatalogQueries,
      withTenantSnapshot,
      createCartPricingPreview,
      createConfiguredSheetsStore,
      previewCheckoutCart: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const service = await createConfiguredCheckoutPreviewService({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });
    const now = new Date('2026-09-01T00:00:00.000Z');
    await expect(service.previewCheckoutCart({
      items: [{ productId: 'P1', quantity: 1 }], now: () => now,
    })).resolves.toBe(SUCCESS);

    expect(withTenantSnapshot).toHaveBeenCalledOnce();
    expect(createDatabaseCatalogQueries).toHaveBeenCalledOnce();
    expect(getProducts).toHaveBeenCalledOnce();
    expect(getActivePromotions).toHaveBeenCalledOnce();
    expect(createCartPricingPreview).toHaveBeenCalledWith({
      products: PRODUCTS, cartItems: [{ productId: 'P1', quantity: 1 }], promotions: PROMOTIONS, now,
    });
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('keeps explicit Sheets lazy and delegates the existing Sheets preview path', async () => {
    const store = { getRows: vi.fn() };
    const createConfiguredSheetsStore = vi.fn(async () => store as never);
    const previewCheckoutCart = vi.fn(async () => SUCCESS);
    const creators = createCheckoutPreviewRepositoryCreators({
      createDatabaseCatalogQueries: vi.fn(), withTenantSnapshot: vi.fn(),
      createCartPricingPreview: vi.fn(), createConfiguredSheetsStore, previewCheckoutCart,
    });
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());
    const service = await createConfiguredCheckoutPreviewService({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    const input = { items: [{ productId: 'P1', quantity: 1 }] };
    await expect(service.previewCheckoutCart(input)).resolves.toBe(SUCCESS);
    expect(createConfiguredSheetsStore).toHaveBeenCalledOnce();
    expect(previewCheckoutCart).toHaveBeenCalledWith(store, input);
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tenant', undefined], ['invalid tenant', activeTenant({ tenantId: 'bad' })],
    ['inactive tenant', activeTenant({ tenantStatus: 'SUSPENDED' })],
  ])('fails closed for PostgreSQL with %s before accessing a backend', async (_label, context) => {
    const creators = {} as Parameters<typeof createConfiguredCheckoutPreviewService>[0]['creators'];
    const postgresGetter = vi.fn();
    const sheetsGetter = vi.fn();
    Object.defineProperties(creators, {
      createPostgresql: { get: postgresGetter }, createSheets: { get: sheetsGetter },
    });
    await expect(createConfiguredCheckoutPreviewService({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => context, creators,
    })).rejects.toThrow(/tenant|ACTIVE/i);
    expect(postgresGetter).not.toHaveBeenCalled();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('does not fall back to Sheets after a PostgreSQL read failure', async () => {
    const dbError = new Error('database unavailable');
    const sheetsGetter = vi.fn();
    const creators = {
      createPostgresql: vi.fn(() => ({ previewCheckoutCart: vi.fn(async () => { throw dbError; }) })),
    } as unknown as Parameters<typeof createConfiguredCheckoutPreviewService>[0]['creators'];
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });
    const service = await createConfiguredCheckoutPreviewService({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });
    await expect(service.previewCheckoutCart({ items: [{ productId: 'P1', quantity: 1 }] }))
      .rejects.toBe(dbError);
    expect(sheetsGetter).not.toHaveBeenCalled();
  });
});
