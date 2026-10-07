import 'server-only';

import type { Product } from '@/domain/types';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/repositories/sheets/lazy';
import { updateProductDetailsBatch } from '@/server/repositories/sheets/lazy';
import type { ProductEditorUpdate } from '@/server/sheetsRepository';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { parseStorageSelection } from './context';
import { createDatabaseCatalogCommands, type UpdateProductsAdminBatchInput } from './database/catalogCommands';

export type VersionedAdminProduct = Product & { productVersion: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYS = ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'];

export async function createConfiguredProductMutation(request?: Request): Promise<{
  updateBatch(input: unknown): Promise<Array<Product | VersionedAdminProduct>>;
}> {
  const context = getOptionalTrustedTenantRequestContext();
  // PG tenant authority never comes from payload, headers, or compatibility env.
  const authority = parseStorageSelection(
    { CLASS_STORE_STORAGE: context ? 'postgresql' : (process.env.CLASS_STORE_STORAGE ?? 'sheets') },
    context ? { tenantId: context.tenant.id, tenantStatus: context.tenant.lifecycle } : undefined,
  );
  return {
    async updateBatch(input) {
      validateBatch(input, authority.storage);
      if (authority.storage === 'postgresql') {
        const result = await createDatabaseCatalogCommands({
          tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction,
        }).updateBatch(input as unknown as UpdateProductsAdminBatchInput);
        // Acknowledge the committed snapshot, never re-read and attach a newer version.
        return result.products.map((product) => ({
          productId: product.productId, name: product.name, price: product.price, stock: product.stock,
          isActive: product.isActive, sortOrder: product.sortOrder,
          ...(product.imageUrl !== null ? { imageUrl: product.imageUrl } : {}),
          ...(product.category !== null ? { category: product.category } : {}),
          productVersion: product.productVersionAfter,
        }));
      }
      // Preserve legacy omitted-stock behavior. D04 Sheets cross-runtime race remains unresolved.
      return updateProductDetailsBatch(
        await createConfiguredSheetsStore(request), input.products as ProductEditorUpdate[], input.operationId,
      );
    },
  };
}

function validateBatch(input: unknown, storage: 'postgresql' | 'sheets'): asserts input is {
  operationId: string; products: Record<string, unknown>[];
} {
  const invalid = () => new Error('올바른 상품 저장 요청이 아닙니다. 새로고침해 주세요.');
  if (!isRecord(input) || Object.keys(input).sort().join('|') !== 'operationId|products'
    || typeof input.operationId !== 'string' || !UUID.test(input.operationId) || !Array.isArray(input.products)) throw invalid();
  const allowed = storage === 'postgresql' ? [...KEYS, 'expectedProductVersion'] : KEYS;
  for (const row of input.products) {
    if (!isRecord(row) || Object.keys(row).some((key) => !allowed.includes(key))
      || typeof row.productId !== 'string' || typeof row.name !== 'string'
      || !Number.isSafeInteger(row.price) || Number(row.price) < 0
      || (Object.hasOwn(row, 'stock') && (!Number.isSafeInteger(row.stock) || Number(row.stock) < 0))
      || typeof row.isActive !== 'boolean' || !Number.isSafeInteger(row.sortOrder)
      || (Object.hasOwn(row, 'imageUrl') && typeof row.imageUrl !== 'string')
      || (Object.hasOwn(row, 'category') && typeof row.category !== 'string')) throw invalid();
    if (storage === 'postgresql' && (!row.productId.trim() || !row.name.trim() || !Number.isSafeInteger(row.stock)
      || !Number.isSafeInteger(row.expectedProductVersion) || Number(row.expectedProductVersion) < 1
      || Number(row.expectedProductVersion) >= Number.MAX_SAFE_INTEGER
      || Number(row.sortOrder) < -2147483648 || Number(row.sortOrder) > 2147483647)) throw invalid();
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
