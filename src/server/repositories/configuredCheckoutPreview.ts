import 'server-only';

import type { CartItem, Product } from '@/domain/types';
import {
  createCartPricingPreview,
  type CartPricingPreviewResult,
} from '@/domain/checkout';
import {
  previewCheckoutCart,
  type PreviewCheckoutCartInput,
} from '@/server/checkoutService';
import { withTenantSnapshot, type TenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseCatalogQueries } from '@/server/repositories/database/catalogQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import type { TabularStore } from '@/server/storage/tabularStore';

export type CheckoutPreviewService = Readonly<{
  previewCheckoutCart: (input: PreviewCheckoutCartInput) => Promise<CartPricingPreviewResult>;
}>;

type CheckoutPreviewCreatorDependencies = Readonly<{
  createDatabaseCatalogQueries: typeof createDatabaseCatalogQueries;
  withTenantSnapshot: typeof withTenantSnapshot;
  createCartPricingPreview: typeof createCartPricingPreview;
  createConfiguredSheetsStore: () => Promise<TabularStore>;
  previewCheckoutCart: typeof previewCheckoutCart;
}>;

export type ConfiguredCheckoutPreviewOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<CheckoutPreviewService, CheckoutPreviewService>;
}>;

export function createCheckoutPreviewRepositoryCreators(
  dependencies: CheckoutPreviewCreatorDependencies,
): RepositoryCreators<CheckoutPreviewService, CheckoutPreviewService> {
  return {
    createPostgresql(authority) {
      return {
        previewCheckoutCart(input) {
          return dependencies.withTenantSnapshot(authority.tenantId, async (transaction) => {
            const catalog = dependencies.createDatabaseCatalogQueries({
              tenantId: authority.tenantId,
              runTenantTransaction: <TResult>(
                _tenantId: string,
                callback: (current: TenantTransaction) => Promise<TResult>,
              ) => callback(transaction),
            });
            const products = await catalog.getProducts();
            const promotions = await catalog.getActivePromotions();
            const now = input.now?.() ?? new Date();
            return dependencies.createCartPricingPreview({
              products: selectProducts(products, input.items),
              cartItems: input.items,
              promotions,
              now,
            });
          });
        },
      };
    },
    createSheets() {
      let storePromise: Promise<TabularStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore();
        return storePromise;
      };
      return {
        async previewCheckoutCart(input) {
          return dependencies.previewCheckoutCart(await configuredStore(), input);
        },
      };
    },
  };
}

function selectProducts(products: Product[], items: CartItem[]): Product[] {
  const productsById = new Map(products.map((product) => [product.productId, product]));
  const selected = new Map<string, Product>();
  for (const item of items) {
    const product = productsById.get(item.productId);
    if (product) selected.set(item.productId, product);
  }
  return [...selected.values()];
}

function productionCreators(request?: Request): RepositoryCreators<CheckoutPreviewService, CheckoutPreviewService> {
  return createCheckoutPreviewRepositoryCreators({
    createDatabaseCatalogQueries,
    withTenantSnapshot,
    createCartPricingPreview,
    createConfiguredSheetsStore: () => createConfiguredSheetsStore(request),
    previewCheckoutCart,
  });
}

export function createConfiguredCheckoutPreviewService(): Promise<CheckoutPreviewService>;
export function createConfiguredCheckoutPreviewService(request: Request): Promise<CheckoutPreviewService>;
export function createConfiguredCheckoutPreviewService(
  options: ConfiguredCheckoutPreviewOptions,
): Promise<CheckoutPreviewService>;
export async function createConfiguredCheckoutPreviewService(
  requestOrOptions?: Request | ConfiguredCheckoutPreviewOptions,
): Promise<CheckoutPreviewService> {
  const options = isConfiguredCheckoutPreviewOptions(requestOrOptions) ? requestOrOptions : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isConfiguredCheckoutPreviewOptions(
  value: Request | ConfiguredCheckoutPreviewOptions | undefined,
): value is ConfiguredCheckoutPreviewOptions {
  return Boolean(value && typeof value === 'object' && 'creators' in value);
}
