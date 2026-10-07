import 'server-only';

import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { withTenantTransaction } from '@/server/db/transaction';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { parseStorageSelection } from './context';
import { createDatabaseCatalogCommands, validateProductBatchDeletionInput } from './database/catalogCommands';

// No compatibility environment tenant and no Sheets fallback for this command.
export async function createConfiguredProductBatchDeletion(request: Request) {
  const context = getOptionalTrustedTenantRequestContext();
  if (!context || !isAuthorizedAdminRequest(request)) throw new Error('Trusted tenant administrator is required.');
  const authority = parseStorageSelection({ CLASS_STORE_STORAGE: 'postgresql' }, {
    tenantId: context.tenant.id, tenantStatus: context.tenant.lifecycle,
  });
  if (authority.storage !== 'postgresql') throw new Error('PostgreSQL tenant is required.');
  return {
    async deleteBatch(input: unknown): Promise<{ operationId: string; productIds: string[] }> {
      validateProductBatchDeletionInput(input);
      const result = await createDatabaseCatalogCommands({
        tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction,
      }).deactivateBatch(input);
      const versions = new Map(input.products.map((product) => [product.productId, product.expectedProductVersion]));
      if (result.ok !== true || result.action !== 'DEACTIVATE' || result.operationId !== input.operationId
        || !Array.isArray(result.products) || result.products.length !== versions.size
        || typeof result.completedAt !== 'string' || !Number.isFinite(Date.parse(result.completedAt))) {
        throw new Error('Product batch deletion acknowledgment integrity check failed.');
      }
      const ids = new Set<string>();
      for (const product of result.products) {
        const version = versions.get(product.productId);
        if (version === undefined || ids.has(product.productId) || product.isActive !== false
          || product.productVersionBefore !== version || product.productVersionAfter !== version + 1
          || product.deletedAt !== result.completedAt || !Number.isSafeInteger(product.stock) || product.stock < 0
          || product.stockBefore !== product.stock || product.stockAfter !== product.stock || product.inventoryEventId !== null) {
          throw new Error('Product batch deletion acknowledgment integrity check failed.');
        }
        ids.add(product.productId);
      }
      return { operationId: result.operationId, productIds: [...ids].sort() };
    },
  };
}
