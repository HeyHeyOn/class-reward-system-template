import 'server-only';

import type { Product } from '@/domain/types';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabaseCatalogCommands,
  type CreateProductAdminInput,
  type ProductAdminSuccess,
} from '@/server/repositories/database/catalogCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { createProduct, type ProductCreate, type SheetsStore } from '@/server/sheetsRepository';

export type ConfiguredProductCreationInput = CreateProductAdminInput;

export type ConfiguredProductCreationCommand = Readonly<{
  create(input: ConfiguredProductCreationInput): Promise<Product>;
}>;

type DatabaseProductCreationCommand = Readonly<{
  create(input: CreateProductAdminInput): Promise<ProductAdminSuccess>;
}>;

type ProductCreationCreatorDependencies = Readonly<{
  createDatabaseCatalogCommands: (dependencies: {
    tenantId: string;
    runTenantTransaction: typeof withTenantTransaction;
  }) => DatabaseProductCreationCommand;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore: (request?: Request) => Promise<SheetsStore>;
  createProduct: (store: SheetsStore, input: ProductCreate) => Promise<Product>;
}>;

export type ConfiguredProductCreationOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredProductCreationCommand, ConfiguredProductCreationCommand>;
}>;

export function createProductCreationRepositoryCreators(
  dependencies: ProductCreationCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredProductCreationCommand, ConfiguredProductCreationCommand> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabaseCatalogCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async create(input) {
          const result = await commands.create(input);
          if (result.products.length !== 1) {
            throw new Error('Product creation must return exactly one product.');
          }
          const created = result.products[0];
          return {
            productId: created.productId,
            name: created.name,
            price: created.price,
            stock: created.stock,
            isActive: created.isActive,
            ...(created.imageUrl === null ? {} : { imageUrl: created.imageUrl }),
            ...(created.category === null ? {} : { category: created.category }),
            sortOrder: created.sortOrder,
          };
        },
      };
    },
    createSheets() {
      let storePromise: Promise<SheetsStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async create(input) {
          const legacyInput: ProductCreate = {
            productId: input.productId,
            name: input.name,
            price: input.price,
            stock: input.stock,
            isActive: input.isActive,
            imageUrl: input.imageUrl,
            category: input.category,
            sortOrder: input.sortOrder,
          };
          return dependencies.createProduct(await configuredStore(), legacyInput);
        },
      };
    },
  };
}

function productionCreators(request?: Request) {
  return createProductCreationRepositoryCreators({
    createDatabaseCatalogCommands,
    withTenantTransaction,
    createConfiguredSheetsStore,
    createProduct,
  }, request);
}

export function createConfiguredProductCreation(): Promise<ConfiguredProductCreationCommand>;
export function createConfiguredProductCreation(
  request: Request,
): Promise<ConfiguredProductCreationCommand>;
export function createConfiguredProductCreation(
  options: ConfiguredProductCreationOptions,
): Promise<ConfiguredProductCreationCommand>;
export async function createConfiguredProductCreation(
  requestOrOptions?: Request | ConfiguredProductCreationOptions,
): Promise<ConfiguredProductCreationCommand> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredProductCreationOptions(requestOrOptions)
    ? requestOrOptions
    : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function isConfiguredProductCreationOptions(
  value: Request | ConfiguredProductCreationOptions | undefined,
): value is ConfiguredProductCreationOptions {
  return Boolean(
    value
    && typeof value === 'object'
    && Object.hasOwn(value, 'env')
    && Object.hasOwn(value, 'getCentralTenantContext')
    && Object.hasOwn(value, 'creators')
    && typeof (value as ConfiguredProductCreationOptions).getCentralTenantContext === 'function'
    && typeof (value as ConfiguredProductCreationOptions).creators === 'object',
  );
}
