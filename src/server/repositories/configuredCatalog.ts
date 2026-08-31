import 'server-only';

import type { Product, Promotion } from '@/domain/types';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { withTenantSnapshot } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import { type RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseCatalogQueries } from '@/server/repositories/database/catalogQueries';
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
  getPromotions: () => Promise<Promotion[]>;
  getActivePromotions: () => Promise<Promotion[]>;
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
        async getPromotions() {
          return dependencies.getPromotions(await configuredReader());
        },
        async getActivePromotions() {
          return dependencies.getActivePromotions(await configuredReader());
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
  const options = isConfiguredCatalogOptions(requestOrOptions) ? requestOrOptions : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
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
  return Boolean(value && typeof value === 'object' && 'creators' in value);
}
