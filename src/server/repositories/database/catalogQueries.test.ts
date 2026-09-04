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
  version?: number;
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
  version?: number;
};

async function seedProduct(tenantId: string, product: ProductSeed) {
  await harness.database.query(
    `INSERT INTO products (
       tenant_id, product_id, name, price, stock, is_active, image_url, category, sort_order, deleted_at, version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      tenantId, product.productId, product.name, product.price, product.stock,
      product.isActive, product.imageUrl, product.category, product.sortOrder,
      product.deletedAt ?? null, product.version ?? 1,
    ],
  );
}

async function seedPromotion(tenantId: string, promotion: PromotionSeed) {
  await harness.database.query(
    `INSERT INTO promotions (
       tenant_id, promotion_id, name, description, type,
       n_plus_one_buy_quantity, n_plus_one_free_quantity, promotional_price,
       percent_discount, fixed_discount, starts_at, ends_at, is_active, sort_order,
       created_at, updated_at, schema_version, version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      tenantId, promotion.promotionId, promotion.name, promotion.description, promotion.type,
      promotion.type === 'N_PLUS_ONE' ? promotion.buyQuantity : null,
      promotion.type === 'N_PLUS_ONE' ? promotion.freeQuantity : null,
      promotion.type === 'PROMOTIONAL_PRICE' ? promotion.value : null,
      promotion.type === 'PERCENT_DISCOUNT' ? promotion.value : null,
      promotion.type === 'FIXED_DISCOUNT' ? promotion.value : null,
      promotion.startsAt, promotion.endsAt, promotion.isActive, promotion.sortOrder,
      promotion.createdAt, promotion.updatedAt, promotion.schemaVersion, promotion.version ?? 1,
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

  it('reads ordered product mutation preconditions from one tenant-scoped snapshot', async () => {
    await harness.database.query(
      `UPDATE products SET version = CASE product_id WHEN 'P1' THEN 7 WHEN 'P2' THEN 3 ELSE 5 END
       WHERE tenant_id = $1`,
      [harness.tenantOneId],
    );
    let snapshots = 0;
    let queriesRun = 0;
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      (tenantId, callback) => {
        snapshots += 1;
        return harness.runTenantTransaction(tenantId, async (transaction) => {
          const execute = transaction.execute.bind(transaction);
          const counted = Object.create(transaction) as typeof transaction;
          counted.execute = (async (...args: Parameters<typeof execute>) => {
            queriesRun += 1;
            return execute(...args);
          }) as never;
          return callback(counted);
        });
      };

    const result = await queries({ runTenantTransaction }).getProductsForAdminMutation();

    expect(result.products.map(({ productId }) => productId)).toEqual(['P3', 'P1', 'P2']);
    expect(result.mutationPreconditions).toEqual([
      { productId: 'P3', expectedVersion: 5 },
      { productId: 'P1', expectedVersion: 7 },
      { productId: 'P2', expectedVersion: 3 },
    ]);
    expect(result.products.every((product) => !Object.hasOwn(product, 'version'))).toBe(true);
    expect(snapshots).toBe(1);
    expect(queriesRun).toBe(1);
  });

  it('returns an empty product mutation snapshot from tenant-scoped nondeleted SQL', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      async (tenantId, callback) => {
        expect(tenantId).toBe(harness.tenantOneId);
        return callback({ execute } as never);
      };

    await expect(queries({ runTenantTransaction }).getProductsForAdminMutation()).resolves.toEqual({
      products: [], mutationPreconditions: [],
    });
    expect(execute).toHaveBeenCalledOnce();
    const query = (execute.mock.calls as unknown as [[unknown]])[0]?.[0];
    const rendered = JSON.stringify(query);
    expect(rendered).toContain('tenant_id');
    expect(rendered).toContain('deleted_at');
    expect(rendered).toContain('version');
    expect(rendered.match(/double precision/g)).toHaveLength(3);
  });

  it('normalizes product mutation fields exactly like the established product projection', async () => {
    await seedProduct(harness.tenantOneId, {
      productId: 'P5', name: '  공백 상품  ', price: 1, stock: 1, isActive: true,
      imageUrl: '   ', category: '  분류  ', sortOrder: 5, version: 4,
    });

    const expected = await queries().getProductById('P5');
    const snapshot = await queries().getProductsForAdminMutation();

    expect(snapshot.products.find(({ productId }) => productId === 'P5')).toEqual(expected);
    expect(snapshot.mutationPreconditions.find(({ productId }) => productId === 'P5')).toEqual({
      productId: 'P5', expectedVersion: 4,
    });
  });

  it('rejects hostile product row arrays before invoking any array hooks', async () => {
    const row = {
      product_id: 'P1', name: '연필', price: 100, stock: 5, is_active: true,
      image_url: null, category: null, sort_order: 1, version: 2,
    };
    const hook = vi.fn(() => row);
    const sparse = new Array(1);
    const decorated = [row];
    Object.defineProperty(decorated, 'extra', { value: true });
    const accessorIndex = [row];
    Object.defineProperty(accessorIndex, '0', {
      enumerable: true, configurable: true, get: hook,
    });
    const readonlyIndex = [row];
    Object.defineProperty(readonlyIndex, '0', {
      value: row, enumerable: true, writable: false, configurable: true,
    });
    const fixedLength = [row];
    Object.defineProperty(fixedLength, 'length', { writable: false });
    const ownMap = [row];
    Object.defineProperty(ownMap, 'map', {
      configurable: true, get: () => {
        hook();
        return Array.prototype.map;
      },
    });
    const symbolDecorated = [row];
    Object.defineProperty(symbolDecorated, Symbol('extra'), {
      configurable: true, get: hook,
    });
    const hostileRows = [
      sparse, decorated, accessorIndex, readonlyIndex, fixedLength, ownMap, symbolDecorated,
    ];

    const outcomes = await Promise.all(hostileRows.map(async (rows) => {
      const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
        async (_tenantId, callback) => callback({ execute: async () => ({ rows }) } as never);
      try {
        return await queries({ runTenantTransaction }).getProductsForAdminMutation();
      } catch (error) {
        return error;
      }
    }));

    expect(outcomes).toHaveLength(hostileRows.length);
    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/product mutation|integrity/i);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects proxy-wrapped product row arrays before invoking proxy traps', async () => {
    const trap = vi.fn(() => { throw new Error('proxy trap invoked'); });
    const rows = new Proxy([], {
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      async (_tenantId, callback) => callback({ execute: async () => ({ rows }) } as never);

    await expect(queries({ runTenantTransaction }).getProductsForAdminMutation())
      .rejects.toThrow(/product mutation|integrity/i);
    expect(trap).not.toHaveBeenCalled();
  });

  it('rejects proxy-wrapped product rows before invoking proxy traps', async () => {
    const trap = vi.fn(() => { throw new Error('row proxy trap invoked'); });
    const row = new Proxy({
      product_id: 'P1', name: '연필', price: 100, stock: 5, is_active: true,
      image_url: null, category: null, sort_order: 1, version: 2,
    }, {
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      async (_tenantId, callback) => callback({ execute: async () => ({ rows: [row] }) } as never);

    await expect(queries({ runTenantTransaction }).getProductsForAdminMutation())
      .rejects.toThrow(/product mutation|integrity/i);
    expect(trap).not.toHaveBeenCalled();
  });

  it('strictly rejects malformed product mutation rows before coercion hooks run', async () => {
    const hook = vi.fn(() => { throw new Error('coercion invoked'); });
    const base = () => ({
      product_id: 'P1', name: '연필', price: 100, stock: 5, is_active: true,
      image_url: null, category: null, sort_order: 1, version: 2,
    });
    const getter = base();
    Object.defineProperty(getter, 'price', { enumerable: true, get: hook });
    const custom = Object.assign(Object.create({}), base());
    const missing = base() as Record<string, unknown>;
    delete missing.stock;
    const hiddenExtra = base();
    Object.defineProperty(hiddenExtra, 'hidden', { value: true });
    const readonlyPrice = base();
    Object.defineProperty(readonlyPrice, 'price', {
      value: 100, enumerable: true, writable: false, configurable: true,
    });
    const fixedPrice = base();
    Object.defineProperty(fixedPrice, 'price', {
      value: 100, enumerable: true, writable: true, configurable: false,
    });
    const invalid = [
      getter, custom, { ...base(), extra: true }, missing, hiddenExtra, readonlyPrice, fixedPrice,
      Object.assign(base(), { [Symbol('extra')]: true }),
      { ...base(), product_id: ' P1' },
      { ...base(), price: new Number(100) }, { ...base(), price: -1 },
      { ...base(), stock: '5' }, { ...base(), stock: -1 },
      { ...base(), is_active: new Boolean(true) }, { ...base(), image_url: new String('x') },
      { ...base(), category: { toString: hook, valueOf: hook } },
      { ...base(), sort_order: 1.5 }, { ...base(), version: new Number(2) },
      { ...base(), version: { valueOf: hook, toString: hook } },
      { ...base(), version: 0 }, { ...base(), version: Number.MAX_SAFE_INTEGER },
    ];

    for (const row of invalid) {
      const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
        async (_tenantId, callback) => callback({ execute: async () => ({ rows: [row] }) } as never);
      await expect(queries({ runTenantTransaction }).getProductsForAdminMutation())
        .rejects.toThrow(/product mutation|integrity/i);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects duplicate product identities in mutation evidence', async () => {
    const row = {
      product_id: 'P1', name: '연필', price: 100, stock: 5, is_active: true,
      image_url: null, category: null, sort_order: 1, version: 2,
    };
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      async (_tenantId, callback) => callback({
        execute: async () => ({ rows: [row, { ...row, version: 3 }] }),
      } as never);

    await expect(queries({ runTenantTransaction }).getProductsForAdminMutation())
      .rejects.toThrow(/product mutation|integrity/i);
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
      'UPDATE products SET is_active = false, deleted_at = created_at WHERE tenant_id = $1 AND product_id = $2',
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

  it('reads ordered promotion mutation preconditions from the same joined tenant snapshot', async () => {
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'PROMO-Z', name: '묶음', description: '', type: 'N_PLUS_ONE',
      buyQuantity: 2, freeQuantity: 1, startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-01-01T00:00:00.000Z', isActive: true, sortOrder: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      schemaVersion: 3, version: 7,
    });
    await seedPromotion(harness.tenantOneId, {
      promotionId: 'PROMO-A', name: '특가', description: '', type: 'FIXED_DISCOUNT', value: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z',
      isActive: false, sortOrder: 1, createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z', schemaVersion: 3, version: 3,
    });
    await seedPromotionProduct(harness.tenantOneId, 'LINK-2', 'PROMO-Z', 'P2');
    await seedPromotionProduct(harness.tenantOneId, 'LINK-1', 'PROMO-Z', 'P1');
    let snapshots = 0;
    let queriesRun = 0;
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      (tenantId, callback) => {
        snapshots += 1;
        return harness.runTenantTransaction(tenantId, async (transaction) => {
          const execute = transaction.execute.bind(transaction);
          const counted = Object.create(transaction) as typeof transaction;
          counted.execute = (async (...args: Parameters<typeof execute>) => {
            queriesRun += 1;
            return execute(...args);
          }) as never;
          return callback(counted);
        });
      };

    const result = await queries({ runTenantTransaction }).getPromotionsForAdminMutation();

    expect(result.promotions.map(({ promotionId }) => promotionId)).toEqual(['PROMO-A', 'PROMO-Z']);
    expect(result.promotions[1].productIds).toEqual(['P1', 'P2']);
    expect(result.mutationPreconditions).toEqual([
      { promotionId: 'PROMO-A', expectedVersion: 3 },
      { promotionId: 'PROMO-Z', expectedVersion: 7 },
    ]);
    expect(result.promotions.every((promotion) => !Object.hasOwn(promotion, 'version'))).toBe(true);
    expect(snapshots).toBe(1);
    expect(queriesRun).toBe(1);
  });

  it('returns an empty promotion mutation snapshot from tenant-scoped SQL', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      async (tenantId, callback) => {
        expect(tenantId).toBe(harness.tenantOneId);
        return callback({ execute } as never);
      };

    await expect(queries({ runTenantTransaction }).getPromotionsForAdminMutation()).resolves.toEqual({
      promotions: [], mutationPreconditions: [],
    });
    expect(execute).toHaveBeenCalledOnce();
    const query = (execute.mock.calls as unknown as [[unknown]])[0]?.[0];
    expect(JSON.stringify(query)).toContain('tenant_id');
    expect(JSON.stringify(query)).toContain('version');
  });

  it('strictly rejects malformed promotion version evidence without coercion', async () => {
    const hook = vi.fn(() => { throw new Error('coercion invoked'); });
    const base = () => ({
      promotion_id: 'PROMO-1', name: '할인', description: '', type: 'FIXED_DISCOUNT',
      n_plus_one_buy_quantity: null, n_plus_one_free_quantity: null,
      promotional_price: null, percent_discount: null, fixed_discount: 10,
      starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z',
      is_active: true, sort_order: 1, created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', schema_version: 3,
      product_id: null, product_schema_version: null, version: 2,
    });
    const getter = base();
    Object.defineProperty(getter, 'version', { enumerable: true, get: hook });
    const custom = Object.assign(Object.create({}), base());
    const missing = base() as Record<string, unknown>;
    delete missing.version;
    const hiddenExtra = base();
    Object.defineProperty(hiddenExtra, 'hidden', { value: true });
    const readonlyVersion = base();
    Object.defineProperty(readonlyVersion, 'version', {
      value: 2, enumerable: true, writable: false, configurable: true,
    });
    const fixedVersion = base();
    Object.defineProperty(fixedVersion, 'version', {
      value: 2, enumerable: true, writable: true, configurable: false,
    });
    const invalid = [getter, custom, { ...base(), unknown: true }, missing,
      hiddenExtra, readonlyVersion, fixedVersion,
      { ...base(), version: new Number(2) },
      { ...base(), version: { valueOf: hook, toString: hook } },
      { ...base(), version: 0 }, { ...base(), version: -1 }, { ...base(), version: 1.5 },
      { ...base(), version: Number.MAX_SAFE_INTEGER }];

    for (const row of invalid) {
      const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
        async (_tenantId, callback) => callback({ execute: async () => ({ rows: [row] }) } as never);
      await expect(queries({ runTenantTransaction }).getPromotionsForAdminMutation())
        .rejects.toThrow(/version|integrity/i);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects inconsistent versions across joined rows for one promotion', async () => {
    const row = {
      promotion_id: 'PROMO-1', name: '할인', description: '', type: 'FIXED_DISCOUNT',
      n_plus_one_buy_quantity: null, n_plus_one_free_quantity: null,
      promotional_price: null, percent_discount: null, fixed_discount: 10,
      starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2027-01-01T00:00:00.000Z',
      is_active: true, sort_order: 1, created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', schema_version: 3,
      product_id: 'P1', product_schema_version: 3, version: 2,
    };
    const runTenantTransaction: DatabaseCatalogQueryDependencies['runTenantTransaction'] =
      async (_tenantId, callback) => callback({
        execute: async () => ({ rows: [row, { ...row, product_id: 'P2', version: 3 }] }),
      } as never);

    await expect(queries({ runTenantTransaction }).getPromotionsForAdminMutation())
      .rejects.toThrow(/version|integrity/i);
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
