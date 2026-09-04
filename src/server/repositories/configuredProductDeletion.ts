import 'server-only';

import { types as nodeUtilTypes } from 'node:util';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabaseCatalogCommands,
  type DeactivateProductAdminInput,
  type ProductAdminSuccess,
} from '@/server/repositories/database/catalogCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import {
  deleteProduct,
  type ProductDeletionInput,
  type SheetsStore,
} from '@/server/sheetsRepository';

export type ConfiguredProductDeletionInput = DeactivateProductAdminInput;
export type ConfiguredProductDeletionResult = Readonly<{ productId: string }>;
export type ConfiguredProductDeletionCommand = Readonly<{
  delete(input: ConfiguredProductDeletionInput): Promise<ConfiguredProductDeletionResult>;
}>;

type DatabaseProductDeletionCommand = Readonly<{
  deactivate(input: DeactivateProductAdminInput): Promise<ProductAdminSuccess>;
}>;

type ProductDeletionCreatorDependencies = Readonly<{
  createDatabaseCatalogCommands: (dependencies: {
    tenantId: string;
    runTenantTransaction: typeof withTenantTransaction;
  }) => DatabaseProductDeletionCommand;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore: (request?: Request) => Promise<SheetsStore>;
  deleteProduct: (store: SheetsStore, input: ProductDeletionInput) => Promise<{ productId: string }>;
}>;

export type ConfiguredProductDeletionOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredProductDeletionCommand, ConfiguredProductDeletionCommand>;
}>;

export function createProductDeletionRepositoryCreators(
  dependencies: ProductDeletionCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredProductDeletionCommand, ConfiguredProductDeletionCommand> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabaseCatalogCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async delete(input) {
          const snapshot = validatedProductDeletionInputSnapshot(input);
          const rawResult = await commands.deactivate(snapshot);
          assertProductDeletionResult(rawResult, snapshot);
          return { productId: snapshot.productId };
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
        async delete(input) {
          const snapshot = validatedProductDeletionInputSnapshot(input);
          const deleted = await dependencies.deleteProduct(
            await configuredStore(),
            snapshot,
          );
          const values = exactOrdinaryDataValues(deleted, ['productId']);
          if (!values || values.productId !== snapshot.productId) throw resultIntegrityError();
          return { productId: snapshot.productId };
        },
      };
    },
  };
}

const CANONICAL_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validatedProductDeletionInputSnapshot(
  input: ConfiguredProductDeletionInput,
): Readonly<ProductDeletionInput> {
  if (nodeUtilTypes.isProxy(input)) throw resultIntegrityError();
  const values = exactOrdinaryDataValues(
    input,
    ['operationId', 'productId', 'expectedProductVersion'],
  );
  if (!values
    || typeof values.operationId !== 'string'
    || !CANONICAL_OPERATION_ID.test(values.operationId)
    || typeof values.productId !== 'string'
    || values.productId.length === 0
    || values.productId.trim() !== values.productId
    || !isPositiveSafeInteger(values.expectedProductVersion)
    || values.expectedProductVersion >= Number.MAX_SAFE_INTEGER) {
    throw resultIntegrityError();
  }
  return Object.freeze({
    operationId: values.operationId,
    productId: values.productId,
    expectedProductVersion: values.expectedProductVersion,
  });
}

function assertProductDeletionResult(
  rawResult: ProductAdminSuccess,
  input: ConfiguredProductDeletionInput,
): void {
  const result = exactOrdinaryDataValues(
    rawResult,
    ['ok', 'operationId', 'action', 'completedAt', 'products'],
  );
  if (!result || result.ok !== true || result.operationId !== input.operationId
    || result.action !== 'DEACTIVATE' || !isCanonicalInstant(result.completedAt)) {
    throw resultIntegrityError();
  }
  const products = exactSingleElementArray(result.products);
  if (!products) throw resultIntegrityError();
  assertProductRow(products[0], input, result.completedAt);
}

function assertProductRow(
  rawRow: unknown,
  input: ConfiguredProductDeletionInput,
  completedAt: string,
): void {
  const row = exactOrdinaryDataValues(rawRow, [
    'productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category',
    'sortOrder', 'productVersionBefore', 'productVersionAfter', 'stockBefore',
    'stockAfter', 'inventoryEventId', 'deletedAt',
  ]);
  if (!row
    || row.productId !== input.productId
    || typeof row.name !== 'string' || row.name.trim().length === 0
    || !isNonnegativeSafeInteger(row.price)
    || !isNonnegativeSafeInteger(row.stock)
    || row.isActive !== false
    || !isNullableString(row.imageUrl)
    || !isNullableString(row.category)
    || !isInt32(row.sortOrder)
    || row.productVersionBefore !== input.expectedProductVersion
    || row.productVersionAfter !== input.expectedProductVersion + 1
    || row.stockBefore !== row.stock
    || row.stockAfter !== row.stock
    || row.inventoryEventId !== null
    || !isCanonicalInstant(row.deletedAt)
    || row.deletedAt !== completedAt) {
    throw resultIntegrityError();
  }
}

function exactOrdinaryDataValues(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  const descriptors = ordinaryEnumerableDataDescriptors(value);
  if (!descriptors || !haveExactKeys(descriptors, expectedKeys)) return undefined;
  return Object.fromEntries(expectedKeys.map((key) => [key, descriptors[key].value]));
}

function ordinaryEnumerableDataDescriptors(
  value: unknown,
): Record<string, PropertyDescriptor> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return undefined;
  const descriptors: Record<string, PropertyDescriptor> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !descriptor.writable || !descriptor.configurable
      || !Object.hasOwn(descriptor, 'value')) return undefined;
    descriptors[key] = descriptor;
  }
  return descriptors;
}

function haveExactKeys(
  descriptors: Record<string, PropertyDescriptor>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(descriptors).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function exactSingleElementArray(value: unknown): [unknown] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys[0] !== '0' || keys[1] !== 'length') return undefined;
  const zero = Object.getOwnPropertyDescriptor(value, '0');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!zero || !zero.enumerable || !zero.writable || !zero.configurable
    || !Object.hasOwn(zero, 'value') || !length || length.enumerable || !length.writable
    || length.configurable || !Object.hasOwn(length, 'value') || length.value !== 1) return undefined;
  return [zero.value];
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isInt32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= -2147483648 && (value as number) <= 2147483647;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resultIntegrityError(): Error {
  return new Error('Product deletion result integrity check failed.');
}

function productionCreators(request?: Request) {
  return createProductDeletionRepositoryCreators({
    createDatabaseCatalogCommands,
    withTenantTransaction,
    createConfiguredSheetsStore,
    deleteProduct,
  }, request);
}

export function createConfiguredProductDeletion(): Promise<ConfiguredProductDeletionCommand>;
export function createConfiguredProductDeletion(
  request: Request,
): Promise<ConfiguredProductDeletionCommand>;
export function createConfiguredProductDeletion(
  options: ConfiguredProductDeletionOptions,
): Promise<ConfiguredProductDeletionCommand>;
export async function createConfiguredProductDeletion(
  requestOrOptions?: Request | ConfiguredProductDeletionOptions,
): Promise<ConfiguredProductDeletionCommand> {
  const supplied = arguments.length > 0;
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredProductDeletionOptions(requestOrOptions)
    ? requestOrOptions : undefined;
  if (supplied && !request && !options) {
    throw new Error('Invalid configured product deletion options.');
  }
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

function isConfiguredProductDeletionOptions(
  value: Request | ConfiguredProductDeletionOptions | undefined,
): value is ConfiguredProductDeletionOptions {
  const optionValues = exactOrdinaryDataValues(
    value,
    ['env', 'getCentralTenantContext', 'creators'],
  );
  return Boolean(optionValues && isSafeEnv(optionValues.env)
    && typeof optionValues.getCentralTenantContext === 'function'
    && hasExactSafeCreators(optionValues.creators));
}

function isSafeEnv(value: unknown): value is CompatibilityCentralTenantEnv {
  const descriptors = ordinaryEnumerableDataDescriptors(value);
  return Boolean(descriptors && Object.values(descriptors).every((descriptor) =>
    typeof descriptor.value === 'string' || descriptor.value === undefined));
}

function hasExactSafeCreators(value: unknown): value is ConfiguredProductDeletionOptions['creators'] {
  const creators = exactOrdinaryDataValues(value, ['createPostgresql', 'createSheets']);
  return Boolean(creators && typeof creators.createPostgresql === 'function'
    && typeof creators.createSheets === 'function');
}
