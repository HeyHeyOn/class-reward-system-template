import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseCatalogQueries,
  type DatabaseCatalogQueryDependencies,
} from '@/server/repositories/database/catalogQueries';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import { getProducts as getSheetProducts, type SheetsReader } from '@/server/sheetsRepository';
import { getPromotions as getSheetPromotions } from '@/server/repositories/sheets/promotionQueries';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedProduct(harness.tenantOneId, {
    productId: 'P2', name: '나 상품', price: 250, stock: 8, isActive: true,
    imageUrl: 'https://example.com/p2.png', category: '문구', sortOrder: 2,
  });
  await seedProduct(harness.tenantOneId, {
    productId: 'P1', name: '가 상품', price: 100, stock: 3, isActive: false,
    imageUrl: null, category: null, sortOrder: 2,
  });
  await seedProduct(harness.tenantOneId, {
    productId: 'P3', name: '다 상품', price: 500, stock: 0, isActive: true,
    imageUrl: null, category: '간식', sortOrder: 1,
  });
  await seedProduct(harness.tenantTwoId, {
    productId: 'P1', name: '다른 반 상품', price: 9999, stock: 99, isActive: true,
    imageUrl: null, category: null, sortOrder: 0,
  });
});

afterEach(async () => {
  await harness?.close();
});

function queries(overrides: Partial<DatabaseCatalogQueryDependencies> = {}) {
  return createDatabaseCatalogQueries({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    ...overrides,
  });
}

type ProductSeed = {
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl: string | null;
  category: string | null;
  sortOrder: number;
  deletedAt?: string;
};

type PromotionSeed = {
  promotionId: string;
  name: string;
  description: string;
  type: 'N_PLUS_ONE' | 'PROMOTIONAL_PRICE' | 'PERCENT_DISCOUNT' | 'FIXED_DISCOUNT';
  value?: number;
  buyQuantity?: number;
  freeQuantity?: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
};

async function seedProduct(tenantId: string, product: ProductSeed) {
  await harness.database.query(
    `INSERT INTO products (
       tenant_id, product_id, name, price, stock, is_active, image_url, category, sort_order, deleted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantId, product.productId, product.name, product.price, product.stock,
      product.isActive, product.imageUrl, product.category, product.sortOrder,
      product.deletedAt ?? null,
    ],
  );
}

async function seedPromotion(tenantId: string, promotion: PromotionSeed) {
  await harness.database.query(
    `INSERT INTO promotions (
       tenant_id, promotion_id, name, description, type,
       n_plus_one_buy_quantity, n_plus_one_free_quantity, promotional_price,
       percent_discount, fixed_discount, starts_at, ends_at, is_active, sort_order,
       created_at, updated_at, schema_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      tenantId, promotion.promotionId, promotion.name, promotion.description, promotion.type,
      promotion.type === 'N_PLUS_ONE' ? promotion.buyQuantity : null,
      promotion.type === 'N_PLUS_ONE' ? promotion.freeQuantity : null,
      promotion.type === 'PROMOTIONAL_PRICE' ? promotion.value : null,
      promotion.type === 'PERCENT_DISCOUNT' ? promotion.value : null,
      promotion.type === 'FIXED_DISCOUNT' ? promotion.value : null,
      promotion.startsAt, promotion.endsAt, promotion.isActive, promotion.sortOrder,
      promotion.createdAt, promotion.updatedAt, promotion.schemaVersion,
    ],
  );
}

async function seedPromotionProduct(
  tenantId: string,
  promotionProductId: string,
  promotionId: string,
  productId: string,
) {
  await harness.database.query(
    `INSERT INTO promotion_products (
       tenant_id, promotion_product_id, promotion_id, product_id, schema_version
     ) VALUES ($1, $2, $3, $4, 3)`,
    [tenantId, promotionProductId, promotionId, productId],
  );
}

describe('database catalog queries', () => {
  it('matches the Sheets product projection and ordering including inactive products', async () => {
    const sheetReader: SheetsReader = {
      getRows: async (sheetName) => sheetName === 'Products' ? [
        ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
        ['P2', '나 상품', '250', '8', 'TRUE', 'https://example.com/p2.png', '문구', '2'],
        ['P1', '가 상품', '100', '3', 'FALSE', '', '', '2'],
        ['P3', '다 상품', '500', '0', 'TRUE', '', '간식', '1'],
      ] : [],
    };
    const expected = await getSheetProducts(sheetReader);

    await expect(queries().getProducts()).resolves.toEqual(expected);
    expect(expected.map(({ productId }) => productId)).toEqual(['P3', 'P1', 'P2']);
  });

  it('returns only active products in the same Sheets ordering', async () => {
    await expect(queries().getActiveProducts()).resolves.toEqual([
      {
        productId: 'P3', name: '다 상품', price: 500, stock: 0, isActive: true,
        imageUrl: undefined, category: '간식', sortOrder: 1,
      },
      {
        productId: 'P2', name: '나 상품', price: 250, stock: 8, isActive: true,
        imageUrl: 'https://example.com/p2.png', category: '문구', sortOrder: 2,
      },
    ]);
  });

  it('returns an inactive product by exact ID without exposing the same ID from another tenant', async () => {
    await expect(queries().getProductById('P1')).resolves.toEqual({
      productId: 'P1', name: '가 상품', price: 100, stock: 3, isActive: false,
      imageUrl: undefined, category: undefined, sortOrder: 2,
    });
    await expect(queries().getProductById('missing')).resolves.toBeNull();
  });

  it('normalizes database strings like Sheets', async () => {
    await seedProduct(harness.tenantOneId, {
      productId: 'P5', name: '  공백 상품  ', price: 1, stock: 1, isActive: true,
      imageUrl: '   ', category: '  분류  ', sortOrder: 5,
    });

    await expect(queries().getProductById('P5')).resolves.toEqual({
      productId: 'P5', name: '공백 상품', price: 1, stock: 1, isActive: true,
      imageUrl: undefined, category: '분류', sortOrder: 5,
    });
  });

  it('keeps the explicit tenant predicate behind an independently mismatched RLS context', async () => {
    const runWithTenantTwoContext: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      (_tenantId, callback) => harness.runTenantTransaction(harness.tenantTwoId, callback);
    const mismatched = queries({ runTenantTransaction: runWithTenantTwoContext });

    await expect(mismatched.getProducts()).resolves.toEqual([]);
    await expect(mismatched.getProductById('P1')).resolves.toBeNull();
  });

  it('uses source-order timestamps to stabilize complete Sheets comparator ties', async () => {
    await seedProduct(harness.tenantOneId, {
      productId: 'PA', name: '동률', price: 1, stock: 1, isActive: true,
      imageUrl: null, category: null, sortOrder: -1,
    });
    await seedProduct(harness.tenantOneId, {
      productId: 'PZ', name: '동률', price: 1, stock: 1, isActive: true,
      imageUrl: null, category: null, sortOrder: -1,
    });
    await harness.database.query(
      `UPDATE products
       SET created_at = CASE product_id
         WHEN 'PZ' THEN '2026-01-01T00:00:00Z'::timestamptz
         ELSE '2026-01-02T00:00:00Z'::timestamptz
       END
       WHERE tenant_id = $1 AND product_id IN ('PA', 'PZ')`,
      [harness.tenantOneId],
    );

    const tiedIds = (await queries().getProducts())
      .filter(({ name }) => name === '동률')
      .map(({ productId }) => productId);
    expect(tiedIds).toEqual(['PZ', 'PA']);
  });

  it('hides soft-deleted products from every query', async () => {
    await seedProduct(harness.tenantOneId, {
      productId: 'P4', name: '삭제 상품', price: 700, stock: 7, isActive: true,
      imageUrl: null, category: null, sortOrder: 0,
    });
    await harness.database.query(
      'UPDATE products SET deleted_at = created_at WHERE tenant_id = $1 AND product_id = $2',
      [harness.tenantOneId, 'P4'],
    );

    await expect(queries().getProducts()).resolves.not.toContainEqual(
      expect.objectContaining({ productId: 'P4' }),
    );
    await expect(queries().getActiveProducts()).resolves.not.toContainEqual(
      expect.objectContaining({ productId: 'P4' }),
    );
    await expect(queries().getProductById('P4')).resolves.toBeNull();
  });

  it.each(['', ' P1', 'P1 '])(
    'rejects non-canonical product ID %j before opening a transaction',
    async (productId) => {
      let transactionOpened = false;
      const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
        <TResult>() => {
          transactionOpened = true;
          return Promise.reject(new Error('unexpected transaction')) as Promise<TResult>;
        };

      await expect(queries({ runTenantTransaction }).getProductById(productId))
        .rejects.toThrow(/product id/i);
      expect(transactionOpened).toBe(false);
    },
  );

  it('matches the actual Sheets promotion projection for all variants, links, and ordering', async () => {
    const promotionRows = [
      ['promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
        'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion'],
      ['PROMO-Z', '  하나 더  ', '  묶음 설명  ', 'N_PLUS_ONE', '', '2', '1',
        '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'TRUE', '1',
        '2026-01-01T01:00:00.000Z', '2026-01-02T01:00:00.000Z', '3'],
      ['PROMO-A', '특가', '', 'PROMOTIONAL_PRICE', '75', '', '',
        '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 'FALSE', '1',
        '2026-01-03T01:00:00.000Z', '2026-01-04T01:00:00.000Z', '3'],
      ['PROMO-P', '퍼센트', '할인', 'PERCENT_DISCOUNT', '12.5', '', '',
        '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', 'TRUE', '2',
        '2026-01-05T01:00:00.000Z', '2026-01-06T01:00:00.000Z', '3'],
      ['PROMO-F', '정액', '할인', 'FIXED_DISCOUNT', '30', '', '',
        '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z', 'TRUE', '3',
        '2026-01-07T01:00:00.000Z', '2026-01-08T01:00:00.000Z', '3'],
    ];
    const linkRows = [
      ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'],
      ['LINK-2', 'PROMO-Z', 'P2', '2026-01-01T00:00:00.000Z', '3'],
      ['LINK-1', 'PROMO-Z', 'P1', '2026-01-01T00:00:00.000Z', '3'],
      ['LINK-3', 'PROMO-F', 'P3', '2026-01-01T00:00:00.000Z', '3'],
    ];
    const sheetReader: SheetsReader = {
      getRows: async (sheetName) => sheetName === 'Promotions'
        ? promotionRows
        : sheetName === 'PromotionProducts' ? linkRows : [],
    };
    const expected = await getSheetPromotions(sheetReader);

    await seedPromotion(harness.tenantOneId, {
      promotionId: 'PROMO-Z', name: '  하나 더  ', description: '  묶음 설명  ', type: 'N_PLUS_ONE',
      buyQuantity: 2, freeQuantity: 1, startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-01-01T00:00:00.000Z', isActive: true, sortOrder: 1,
      createdAt: '2026-01-01T01:00:00.000Z', updatedAt: '2026-01-02T01:00:00.000Z', schemaVersion: 3,
    });
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'PROMO-A', name: '특가', description: '', type: 'PROMOTIONAL_PRICE', value: 75,
      startsAt: '2026-02-01T00:00:00.000Z', endsAt: '2026-03-01T00:00:00.000Z', isActive: false,
      sortOrder: 1, createdAt: '2026-01-03T01:00:00.000Z', updatedAt: '2026-01-04T01:00:00.000Z', schemaVersion: 3,
    });
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'PROMO-P', name: '퍼센트', description: '할인', type: 'PERCENT_DISCOUNT', value: 12.5,
      startsAt: '2025-01-01T00:00:00.000Z', endsAt: '2025-02-01T00:00:00.000Z', isActive: true,
      sortOrder: 2, createdAt: '2026-01-05T01:00:00.000Z', updatedAt: '2026-01-06T01:00:00.000Z', schemaVersion: 3,
    });
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'PROMO-F', name: '정액', description: '할인', type: 'FIXED_DISCOUNT', value: 30,
      startsAt: '2027-01-01T00:00:00.000Z', endsAt: '2027-02-01T00:00:00.000Z', isActive: true,
      sortOrder: 3, createdAt: '2026-01-07T01:00:00.000Z', updatedAt: '2026-01-08T01:00:00.000Z', schemaVersion: 3,
    });
    await seedPromotionProduct(harness.tenantOneId, 'LINK-2', 'PROMO-Z', 'P2');
    await seedPromotionProduct(harness.tenantOneId, 'LINK-1', 'PROMO-Z', 'P1');
    await seedPromotionProduct(harness.tenantOneId, 'LINK-3', 'PROMO-F', 'P3');

    await expect(queries().getPromotions()).resolves.toEqual(expected);
    expect(expected.map(({ promotionId }) => promotionId)).toEqual(['PROMO-A', 'PROMO-Z', 'PROMO-P', 'PROMO-F']);
    expect(expected.find(({ promotionId }) => promotionId === 'PROMO-Z')?.productIds).toEqual(['P1', 'P2']);
  });

  it('returns active promotions regardless of whether their time window is past or future', async () => {
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'PAST', name: '과거', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2020-02-01T00:00:00.000Z', isActive: true,
      sortOrder: 1, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 3,
    });
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'FUTURE', name: '미래', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2030-01-01T00:00:00.000Z', endsAt: '2030-02-01T00:00:00.000Z', isActive: true,
      sortOrder: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
    });
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'INACTIVE', name: '비활성', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', isActive: false,
      sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
    });

    const activeIds = (await queries().getActivePromotions()).map(({ promotionId }) => promotionId);
    expect(activeIds).toEqual(['PAST', 'FUTURE']);
  });

  it('returns an inactive promotion by ID without leaking same-ID promotion links from another tenant', async () => {
    const common = {
      promotionId: 'SHARED', description: '', type: 'FIXED_DISCOUNT' as const, value: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z',
      sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
    };
    await seedPromotion(harness.tenantOneId, { ...common, name: '첫 반', isActive: false });
    await seedPromotion(harness.tenantTwoId, { ...common, name: '다른 반', isActive: true });
    await seedPromotionProduct(harness.tenantOneId, 'T1-LINK', 'SHARED', 'P2');
    await seedPromotionProduct(harness.tenantTwoId, 'T2-LINK', 'SHARED', 'P1');

    await expect(queries().getPromotionById('SHARED')).resolves.toEqual(expect.objectContaining({
      promotionId: 'SHARED', name: '첫 반', isActive: false, productIds: ['P2'],
    }));
    await expect(queries().getPromotionById('missing')).resolves.toBeNull();
  });

  it('keeps promotion predicates behind an independently mismatched RLS context', async () => {
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'RLS-PROMO', name: '격리', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', isActive: true,
      sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
    });
    const runWithTenantTwoContext: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      (_tenantId, callback) => harness.runTenantTransaction(harness.tenantTwoId, callback);
    const mismatched = queries({ runTenantTransaction: runWithTenantTwoContext });

    await expect(mismatched.getPromotions()).resolves.toEqual([]);
    await expect(mismatched.getActivePromotions()).resolves.toEqual([]);
    await expect(mismatched.getPromotionById('RLS-PROMO')).resolves.toBeNull();
  });

  it('rejects unsupported promotion and promotion-link schema versions', async () => {
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'OLD-PROMO', name: '구버전', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', isActive: true,
      sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 1,
    });
    await expect(queries().getPromotions()).rejects.toThrow(/schema version/i);

    await harness.database.query(
      'DELETE FROM promotions WHERE tenant_id = $1 AND promotion_id = $2',
      [harness.tenantOneId, 'OLD-PROMO'],
    );
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'LINK-VERSION', name: '링크 버전', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', isActive: true,
      sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
    });
    await harness.database.query(
      `INSERT INTO promotion_products
       (tenant_id, promotion_product_id, promotion_id, product_id, schema_version)
       VALUES ($1, 'OLD-LINK', 'LINK-VERSION', 'P1', 1)`,
      [harness.tenantOneId],
    );
    await expect(queries().getPromotionById('LINK-VERSION')).rejects.toThrow(/schema version/i);
  });

  it('rejects a positive numeric percent that underflows to zero in JavaScript', async () => {
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'TINY-PERCENT', name: '미세 할인', description: '', type: 'PERCENT_DISCOUNT', value: 1,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', isActive: true,
      sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
    });
    await harness.database.query(
      `UPDATE promotions SET percent_discount = '1e-10000'::numeric
       WHERE tenant_id = $1 AND promotion_id = 'TINY-PERCENT'`,
      [harness.tenantOneId],
    );

    await expect(queries().getPromotionById('TINY-PERCENT')).rejects.toThrow(/percent/i);
  });

  it('hides soft-deleted promotions from every promotion query', async () => {
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'DELETED', name: '삭제', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z', isActive: true,
      sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schemaVersion: 3,
    });
    await harness.database.query(
      'UPDATE promotions SET deleted_at = created_at WHERE tenant_id = $1 AND promotion_id = $2',
      [harness.tenantOneId, 'DELETED'],
    );

    await expect(queries().getPromotions()).resolves.toEqual([]);
    await expect(queries().getActivePromotions()).resolves.toEqual([]);
    await expect(queries().getPromotionById('DELETED')).resolves.toBeNull();
  });

  it.each(['', ' SHARED', 'SHARED '])(
    'rejects non-canonical promotion ID %j before opening a transaction',
    async (promotionId) => {
      let transactionOpened = false;
      const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
        <TResult>() => {
          transactionOpened = true;
          return Promise.reject(new Error('unexpected transaction')) as Promise<TResult>;
        };

      await expect(queries({ runTenantTransaction }).getPromotionById(promotionId))
        .rejects.toThrow(/promotion id/i);
      expect(transactionOpened).toBe(false);
    },
  );
});
