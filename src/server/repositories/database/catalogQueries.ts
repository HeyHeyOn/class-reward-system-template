import 'server-only';

import { sql } from 'drizzle-orm';
import type { Product, Promotion } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  compareProductsLikeSheets,
  isoString,
  nullableString,
  safeInteger,
} from '@/server/repositories/database/queryProjection';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseCatalogQueryDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
}>;

type ProductRow = {
  product_id: unknown;
  name: unknown;
  price: unknown;
  stock: unknown;
  is_active: boolean;
  image_url: unknown;
  category: unknown;
  sort_order: unknown;
};

type PromotionRow = {
  promotion_id: unknown;
  name: unknown;
  description: unknown;
  type: unknown;
  n_plus_one_buy_quantity: unknown;
  n_plus_one_free_quantity: unknown;
  promotional_price: unknown;
  percent_discount: unknown;
  fixed_discount: unknown;
  starts_at: unknown;
  ends_at: unknown;
  is_active: boolean;
  sort_order: unknown;
  created_at: unknown;
  updated_at: unknown;
  schema_version: unknown;
  product_id: unknown;
  product_schema_version: unknown;
};

export function createDatabaseCatalogQueries(dependencies: DatabaseCatalogQueryDependencies) {
  return {
    async getProducts(): Promise<Product[]> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT product_id, name, price, stock, is_active, image_url, category, sort_order
          FROM products
          WHERE tenant_id = ${dependencies.tenantId} AND deleted_at IS NULL
          ORDER BY created_at, product_id
        `);
        return (result.rows as ProductRow[])
          .map(toProduct)
          .sort(compareProductsLikeSheets);
      });
    },

    async getActiveProducts(): Promise<Product[]> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT product_id, name, price, stock, is_active, image_url, category, sort_order
          FROM products
          WHERE tenant_id = ${dependencies.tenantId}
            AND is_active = true
            AND deleted_at IS NULL
          ORDER BY created_at, product_id
        `);
        return (result.rows as ProductRow[])
          .map(toProduct)
          .sort(compareProductsLikeSheets);
      });
    },

    async getProductById(productId: string): Promise<Product | null> {
      assertCanonicalProductId(productId);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT product_id, name, price, stock, is_active, image_url, category, sort_order
          FROM products
          WHERE tenant_id = ${dependencies.tenantId}
            AND product_id = ${productId}
            AND deleted_at IS NULL
        `);
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) throw new Error('Product query returned duplicate rows.');
        return toProduct(result.rows[0] as ProductRow);
      });
    },

    async getPromotions(): Promise<Promotion[]> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT p.promotion_id, p.name, p.description, p.type,
                 p.n_plus_one_buy_quantity, p.n_plus_one_free_quantity,
                 p.promotional_price, p.percent_discount, p.fixed_discount,
                 p.starts_at, p.ends_at, p.is_active, p.sort_order,
                 p.created_at, p.updated_at, p.schema_version, pp.product_id,
                 pp.schema_version AS product_schema_version
          FROM promotions p
          LEFT JOIN promotion_products pp
            ON pp.tenant_id = ${dependencies.tenantId}
           AND pp.promotion_id = p.promotion_id
          WHERE p.tenant_id = ${dependencies.tenantId}
            AND p.deleted_at IS NULL
          ORDER BY p.sort_order, p.promotion_id, pp.product_id
        `);
        return projectPromotions(result.rows as PromotionRow[]);
      });
    },

    async getActivePromotions(): Promise<Promotion[]> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT p.promotion_id, p.name, p.description, p.type,
                 p.n_plus_one_buy_quantity, p.n_plus_one_free_quantity,
                 p.promotional_price, p.percent_discount, p.fixed_discount,
                 p.starts_at, p.ends_at, p.is_active, p.sort_order,
                 p.created_at, p.updated_at, p.schema_version, pp.product_id,
                 pp.schema_version AS product_schema_version
          FROM promotions p
          LEFT JOIN promotion_products pp
            ON pp.tenant_id = ${dependencies.tenantId}
           AND pp.promotion_id = p.promotion_id
          WHERE p.tenant_id = ${dependencies.tenantId}
            AND p.is_active = true
            AND p.deleted_at IS NULL
          ORDER BY p.sort_order, p.promotion_id, pp.product_id
        `);
        return projectPromotions(result.rows as PromotionRow[]);
      });
    },

    async getPromotionById(promotionId: string): Promise<Promotion | null> {
      assertCanonicalPromotionId(promotionId);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT p.promotion_id, p.name, p.description, p.type,
                 p.n_plus_one_buy_quantity, p.n_plus_one_free_quantity,
                 p.promotional_price, p.percent_discount, p.fixed_discount,
                 p.starts_at, p.ends_at, p.is_active, p.sort_order,
                 p.created_at, p.updated_at, p.schema_version, pp.product_id,
                 pp.schema_version AS product_schema_version
          FROM promotions p
          LEFT JOIN promotion_products pp
            ON pp.tenant_id = ${dependencies.tenantId}
           AND pp.promotion_id = p.promotion_id
          WHERE p.tenant_id = ${dependencies.tenantId}
            AND p.promotion_id = ${promotionId}
            AND p.deleted_at IS NULL
          ORDER BY pp.product_id
        `);
        const projected = projectPromotions(result.rows as PromotionRow[]);
        if (projected.length > 1) throw new Error('Promotion query returned duplicate rows.');
        return projected[0] ?? null;
      });
    },
  };
}

function assertCanonicalProductId(productId: string): void {
  if (!productId || productId.trim() !== productId) {
    throw new Error('A canonical product ID is required.');
  }
}

function assertCanonicalPromotionId(promotionId: string): void {
  if (!promotionId || promotionId.trim() !== promotionId) {
    throw new Error('A canonical promotion ID is required.');
  }
}

function toProduct(row: ProductRow): Product {
  return {
    productId: requiredTrimmedString(row.product_id, 'Product ID'),
    name: requiredTrimmedString(row.name, 'Product name'),
    price: safeInteger(row.price, 'Product price'),
    stock: safeInteger(row.stock, 'Product stock'),
    isActive: row.is_active,
    imageUrl: optionalTrimmedString(row.image_url, 'Product image URL'),
    category: optionalTrimmedString(row.category, 'Product category'),
    sortOrder: safeInteger(row.sort_order, 'Product sort order'),
  };
}

function projectPromotions(rows: PromotionRow[]): Promotion[] {
  const promotions = new Map<string, { promotion: Promotion; productIds: Set<string> }>();
  for (const row of rows) {
    const promotionId = requiredTrimmedString(row.promotion_id, 'Promotion ID');
    const existing = promotions.get(promotionId);
    const entry = existing ?? { promotion: toPromotion(row), productIds: new Set<string>() };
    if (row.product_id !== null && row.product_id !== undefined) {
      if (safeInteger(row.product_schema_version, 'Promotion product schema version') !== 3) {
        throw new Error('Promotion product schema version is unsupported.');
      }
      entry.productIds.add(requiredTrimmedString(row.product_id, 'Promotion product ID'));
    }
    promotions.set(promotionId, entry);
  }
  return [...promotions.values()]
    .map(({ promotion, productIds }) => ({
      ...promotion,
      productIds: [...productIds].sort(compareUtf16),
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder
      || compareUtf16(left.promotionId, right.promotionId));
}

function toPromotion(row: PromotionRow): Promotion {
  const schemaVersion = safeInteger(row.schema_version, 'Promotion schema version');
  if (schemaVersion !== 3) throw new Error('Promotion schema version is unsupported.');
  const common = {
    promotionId: requiredTrimmedString(row.promotion_id, 'Promotion ID'),
    name: requiredTrimmedString(row.name, 'Promotion name'),
    description: trimmedString(row.description, 'Promotion description'),
    productIds: [],
    startsAt: isoString(row.starts_at, 'Promotion start'),
    endsAt: isoString(row.ends_at, 'Promotion end'),
    isActive: row.is_active,
    sortOrder: safeInteger(row.sort_order, 'Promotion sort order'),
    createdAt: isoString(row.created_at, 'Promotion created timestamp'),
    updatedAt: isoString(row.updated_at, 'Promotion updated timestamp'),
    schemaVersion,
  };
  switch (row.type) {
    case 'N_PLUS_ONE':
      return {
        ...common,
        type: row.type,
        buyQuantity: safeInteger(row.n_plus_one_buy_quantity, 'Promotion buy quantity'),
        freeQuantity: safeInteger(row.n_plus_one_free_quantity, 'Promotion free quantity'),
      };
    case 'PROMOTIONAL_PRICE':
      return {
        ...common,
        type: row.type,
        promotionalUnitPrice: safeInteger(row.promotional_price, 'Promotional unit price'),
      };
    case 'PERCENT_DISCOUNT':
      return { ...common, type: row.type, percent: promotionPercent(row.percent_discount) };
    case 'FIXED_DISCOUNT':
      return {
        ...common,
        type: row.type,
        discountAmount: safeInteger(row.fixed_discount, 'Promotion discount amount'),
      };
    default:
      throw new Error('Promotion type is invalid.');
  }
}

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonblank string.`);
  return value.trim();
}

function optionalTrimmedString(value: unknown, label: string): string | undefined {
  const projected = nullableString(value, label);
  return projected?.trim() || undefined;
}

function trimmedString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value.trim();
}

function promotionPercent(value: unknown): number {
  const projected = finiteNumber(value, 'Promotion percent');
  if (projected <= 0 || projected > 100) throw new Error('Promotion percent is outside the supported range.');
  return projected;
}

function finiteNumber(value: unknown, label: string): number {
  const projected = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(projected)) throw new Error(`${label} must be a finite number.`);
  return projected;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
