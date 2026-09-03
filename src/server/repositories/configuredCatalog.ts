import 'server-only';

import type { Product, Promotion } from '@/domain/types';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { withTenantSnapshot } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import { type RepositoryCreators } from '@/server/repositories/factory';
import {
  createDatabaseCatalogQueries,
  type ProductAdminMutationSnapshot,
  type PromotionAdminMutationSnapshot,
} from '@/server/repositories/database/catalogQueries';
import {
  getActivePromotions,
  getPromotions,
} from '@/server/repositories/sheets/promotionQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { getActiveProducts, getProducts, type SheetsReader } from '@/server/sheetsRepository';

export type CatalogReader = Readonly<{
  getProducts: () => Promise<Product[]>;
  getActiveProducts: () => Promise<Product[]>;
  getProductsForAdminMutation: () => Promise<ProductAdminMutationSnapshot>;
  getPromotions: () => Promise<Promotion[]>;
  getActivePromotions: () => Promise<Promotion[]>;
  getPromotionsForAdminMutation: () => Promise<PromotionAdminMutationSnapshot>;
}>;

type CatalogQueryFactory = (dependencies: {
  tenantId: string;
  runTenantTransaction: typeof withTenantSnapshot;
}) => CatalogReader;

type CatalogCreatorDependencies = Readonly<{
  createDatabaseCatalogQueries: CatalogQueryFactory;
  withTenantSnapshot: typeof withTenantSnapshot;
  createConfiguredSheetsReader: (request?: Request) => Promise<SheetsReader>;
  getProducts: (reader: SheetsReader) => Promise<Product[]>;
  getActiveProducts: (reader: SheetsReader) => Promise<Product[]>;
  getPromotions: (reader: SheetsReader) => Promise<Promotion[]>;
  getActivePromotions: (reader: SheetsReader) => Promise<Promotion[]>;
}>;

export type ConfiguredCatalogOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<CatalogReader, CatalogReader>;
}>;

export function createCatalogRepositoryCreators(
  dependencies: CatalogCreatorDependencies,
  request?: Request,
): RepositoryCreators<CatalogReader, CatalogReader> {
  return {
    createPostgresql(authority) {
      return dependencies.createDatabaseCatalogQueries({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantSnapshot,
      });
    },
    createSheets() {
      let readerPromise: Promise<SheetsReader> | undefined;
      const configuredReader = () => {
        readerPromise ??= dependencies.createConfiguredSheetsReader(request);
        return readerPromise;
      };
      return {
        async getProducts() {
          return dependencies.getProducts(await configuredReader());
        },
        async getActiveProducts() {
          return dependencies.getActiveProducts(await configuredReader());
        },
        async getProductsForAdminMutation() {
          const products = (await dependencies.getProducts(await configuredReader()))
            .map((product) => ({ ...product }));
          return {
            products,
            mutationPreconditions: products.map(({ productId }) => ({
              productId,
              expectedVersion: 1,
            })),
          };
        },
        async getPromotions() {
          return dependencies.getPromotions(await configuredReader());
        },
        async getActivePromotions() {
          return dependencies.getActivePromotions(await configuredReader());
        },
        async getPromotionsForAdminMutation() {
          const promotions = (await dependencies.getPromotions(await configuredReader()))
            .map((promotion) => ({ ...promotion, productIds: [...promotion.productIds] }));
          return {
            promotions,
            mutationPreconditions: promotions.map(({ promotionId }) => ({
              promotionId,
              expectedVersion: 1,
            })),
          };
        },
      };
    },
  };
}

function productionCreators(request?: Request) {
  return createCatalogRepositoryCreators({
    createDatabaseCatalogQueries, withTenantSnapshot,
    createConfiguredSheetsReader,
    getProducts, getActiveProducts, getPromotions, getActivePromotions,
  }, request);
}

export function createConfiguredCatalogReader(): Promise<CatalogReader>;
export function createConfiguredCatalogReader(request: Request): Promise<CatalogReader>;
export function createConfiguredCatalogReader(options: ConfiguredCatalogOptions): Promise<CatalogReader>;
export async function createConfiguredCatalogReader(
  requestOrOptions?: Request | ConfiguredCatalogOptions,
): Promise<CatalogReader> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredCatalogOptions(requestOrOptions)
    ? requestOrOptions : undefined;
  if (requestOrOptions !== undefined && !request && !options) {
    throw new Error('Invalid configured catalog options.');
  }
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isConfiguredCatalogOptions(value: Request | ConfiguredCatalogOptions | undefined):
  value is ConfiguredCatalogOptions {
  const optionValues = exactEnumerableDataValues(
    value,
    ['env', 'getCentralTenantContext', 'creators'],
  );
  return Boolean(optionValues && isSafeEnv(optionValues.env)
    && typeof optionValues.getCentralTenantContext === 'function'
    && hasExactSafeCreators(optionValues.creators));
}

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function exactEnumerableDataValues(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function isSafeEnv(value: unknown): value is CompatibilityCentralTenantEnv {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
      && (typeof descriptor.value === 'string' || descriptor.value === undefined));
  });
}

function hasExactSafeCreators(value: unknown): value is ConfiguredCatalogOptions['creators'] {
  const expectedKeys = ['createPostgresql', 'createSheets'] as const;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string'
      || !expectedKeys.includes(key as typeof expectedKeys[number]))) return false;
  return expectedKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && descriptor.enumerable
      && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function');
  });
}
