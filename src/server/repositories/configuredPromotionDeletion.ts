import 'server-only';

import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabasePromotionCommands,
  type DeletePromotionAdminInput,
  type PromotionAdminSuccess,
} from '@/server/repositories/database/promotionCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { deletePromotion } from '@/server/repositories/sheets/promotionCommands';
import type { AdditiveSchemaMigrationStore } from '@/server/storage/tabularStore';

export type ConfiguredPromotionDeletionInput = DeletePromotionAdminInput;
export type ConfiguredPromotionDeletionResult = Readonly<{ promotionId: string }>;
export type ConfiguredPromotionDeletionCommand = Readonly<{
  delete(input: ConfiguredPromotionDeletionInput): Promise<ConfiguredPromotionDeletionResult>;
}>;

type DatabasePromotionDeletionCommand = Readonly<{
  delete(input: DeletePromotionAdminInput): Promise<PromotionAdminSuccess>;
}>;

type PromotionDeletionCreatorDependencies = Readonly<{
  createDatabasePromotionCommands: (dependencies: {
    tenantId: string;
    runTenantTransaction: typeof withTenantTransaction;
  }) => DatabasePromotionDeletionCommand;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore: (request?: Request) => Promise<AdditiveSchemaMigrationStore>;
  deletePromotion: (
    store: AdditiveSchemaMigrationStore,
    promotionId: string,
  ) => Promise<{ promotionId: string }>;
}>;

export type ConfiguredPromotionDeletionOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredPromotionDeletionCommand, ConfiguredPromotionDeletionCommand>;
}>;

export function createPromotionDeletionRepositoryCreators(
  dependencies: PromotionDeletionCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredPromotionDeletionCommand, ConfiguredPromotionDeletionCommand> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabasePromotionCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async delete(input) {
          assertPromotionDeletionInput(input);
          const rawResult = await commands.delete(input);
          assertPromotionDeletionResult(rawResult, input);
          return { promotionId: input.promotionId };
        },
      };
    },
    createSheets() {
      let storePromise: Promise<AdditiveSchemaMigrationStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async delete(input) {
          assertPromotionDeletionInput(input);
          const deleted = await dependencies.deletePromotion(
            await configuredStore(),
            input.promotionId,
          );
          const values = exactOrdinaryDataValues(deleted, ['promotionId']);
          if (!values || values.promotionId !== input.promotionId) throw resultIntegrityError();
          return { promotionId: input.promotionId };
        },
      };
    },
  };
}

function assertPromotionDeletionInput(input: ConfiguredPromotionDeletionInput): void {
  if (!isPositiveSafeInteger(input.expectedPromotionVersion)
    || input.expectedPromotionVersion >= Number.MAX_SAFE_INTEGER) {
    throw resultIntegrityError();
  }
}

function assertPromotionDeletionResult(
  rawResult: PromotionAdminSuccess,
  input: ConfiguredPromotionDeletionInput,
): void {
  const result = exactOrdinaryDataValues(
    rawResult,
    ['ok', 'operationId', 'action', 'completedAt', 'promotions'],
  );
  if (!result || result.ok !== true || result.operationId !== input.operationId
    || result.action !== 'DELETE' || !isCanonicalInstant(result.completedAt)) {
    throw resultIntegrityError();
  }
  const promotions = exactSingleElementArray(result.promotions);
  if (!promotions) throw resultIntegrityError();
  assertPromotionRow(promotions[0], input);
}

function assertPromotionRow(rawRow: unknown, input: ConfiguredPromotionDeletionInput): void {
  const descriptors = ordinaryEnumerableDataDescriptors(rawRow);
  if (!descriptors) throw resultIntegrityError();
  const type = descriptors.type?.value;
  const variantKeys = type === 'N_PLUS_ONE' ? ['buyQuantity', 'freeQuantity']
    : type === 'PROMOTIONAL_PRICE' ? ['promotionalUnitPrice']
      : type === 'PERCENT_DISCOUNT' ? ['percent']
        : type === 'FIXED_DISCOUNT' ? ['discountAmount'] : undefined;
  if (!variantKeys) throw resultIntegrityError();
  const expectedKeys = [
    'promotionId', 'name', 'description', 'type', 'startsAt', 'endsAt', 'isActive',
    'sortOrder', 'schemaVersion', 'productIds', 'promotionVersionBefore',
    'promotionVersionAfter', ...variantKeys,
  ];
  if (!haveExactKeys(descriptors, expectedKeys)) throw resultIntegrityError();
  const row = Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
  if (row.promotionId !== input.promotionId
    || typeof row.name !== 'string' || !row.name || row.name !== row.name.trim()
    || typeof row.description !== 'string' || row.description !== row.description.trim()
    || !isCanonicalInstant(row.startsAt) || !isCanonicalInstant(row.endsAt)
    || Date.parse(row.startsAt) >= Date.parse(row.endsAt)
    || row.isActive !== false
    || !Number.isInteger(row.sortOrder) || row.sortOrder < -2147483648 || row.sortOrder > 2147483647
    || row.schemaVersion !== 3
    || row.promotionVersionBefore !== input.expectedPromotionVersion
    || row.promotionVersionAfter !== input.expectedPromotionVersion + 1
    || !isCanonicalProductIdArray(row.productIds)) throw resultIntegrityError();
  if (type === 'N_PLUS_ONE'
    && (!isPositiveSafeInteger(row.buyQuantity) || !isPositiveSafeInteger(row.freeQuantity))) {
    throw resultIntegrityError();
  }
  if (type === 'PROMOTIONAL_PRICE' && !isNonnegativeSafeInteger(row.promotionalUnitPrice)) {
    throw resultIntegrityError();
  }
  if (type === 'PERCENT_DISCOUNT'
    && (typeof row.percent !== 'number' || !Number.isFinite(row.percent)
      || row.percent <= 0 || row.percent > 100)) throw resultIntegrityError();
  if (type === 'FIXED_DISCOUNT' && !isPositiveSafeInteger(row.discountAmount)) {
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

function isCanonicalProductIdArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || lengthDescriptor.enumerable || !lengthDescriptor.writable
    || lengthDescriptor.configurable || !Object.hasOwn(lengthDescriptor, 'value')
    || lengthDescriptor.value !== value.length || keys.length !== value.length + 1) return false;
  let previous: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (keys[index] !== key) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !descriptor.writable || !descriptor.configurable
      || !Object.hasOwn(descriptor, 'value')) return false;
    const productId = descriptor.value;
    if (typeof productId !== 'string' || !productId || productId !== productId.trim()
      || (previous !== undefined && compareText(previous, productId) >= 0)) return false;
    previous = productId;
  }
  return keys[value.length] === 'length';
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resultIntegrityError(): Error {
  return new Error('Promotion deletion result integrity check failed.');
}

function productionCreators(request?: Request) {
  return createPromotionDeletionRepositoryCreators({
    createDatabasePromotionCommands,
    withTenantTransaction,
    createConfiguredSheetsStore,
    deletePromotion,
  }, request);
}

export function createConfiguredPromotionDeletion(): Promise<ConfiguredPromotionDeletionCommand>;
export function createConfiguredPromotionDeletion(
  request: Request,
): Promise<ConfiguredPromotionDeletionCommand>;
export function createConfiguredPromotionDeletion(
  options: ConfiguredPromotionDeletionOptions,
): Promise<ConfiguredPromotionDeletionCommand>;
export async function createConfiguredPromotionDeletion(
  requestOrOptions?: Request | ConfiguredPromotionDeletionOptions,
): Promise<ConfiguredPromotionDeletionCommand> {
  const supplied = arguments.length > 0;
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredPromotionDeletionOptions(requestOrOptions)
    ? requestOrOptions : undefined;
  if (supplied && !request && !options) {
    throw new Error('Invalid configured promotion deletion options.');
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

function isConfiguredPromotionDeletionOptions(
  value: Request | ConfiguredPromotionDeletionOptions | undefined,
): value is ConfiguredPromotionDeletionOptions {
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

function hasExactSafeCreators(value: unknown): value is ConfiguredPromotionDeletionOptions['creators'] {
  const creators = exactOrdinaryDataValues(value, ['createPostgresql', 'createSheets']);
  return Boolean(creators && typeof creators.createPostgresql === 'function'
    && typeof creators.createSheets === 'function');
}
