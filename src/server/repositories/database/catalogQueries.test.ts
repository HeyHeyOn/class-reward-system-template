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
});
