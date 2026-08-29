import 'server-only';

import { sql } from 'drizzle-orm';
import type { Product } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  compareProductsLikeSheets,
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
  };
}

function assertCanonicalProductId(productId: string): void {
  if (!productId || productId.trim() !== productId) {
    throw new Error('A canonical product ID is required.');
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

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonblank string.`);
  return value.trim();
}

function optionalTrimmedString(value: unknown, label: string): string | undefined {
  const projected = nullableString(value, label);
  return projected?.trim() || undefined;
}
