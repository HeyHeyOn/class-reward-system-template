import 'server-only';

import type { Promotion } from '@/domain/types';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabasePromotionCommands,
  type CreatePromotionAdminInput,
  type PromotionAdminSuccess,
} from '@/server/repositories/database/promotionCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import {
  createPromotion,
  replacePromotionProducts,
  type PromotionCreateInput,
} from '@/server/repositories/sheets/promotionCommands';
import type { AdditiveSchemaMigrationStore } from '@/server/storage/tabularStore';

export type ConfiguredPromotionCreationInput = CreatePromotionAdminInput;

export type ConfiguredPromotionCreationCommand = Readonly<{
  create(input: ConfiguredPromotionCreationInput): Promise<Promotion>;
}>;

type DistributiveOmit<T, TKey extends PropertyKey> = T extends unknown ? Omit<T, TKey> : never;
type PromotionDefinitionProjection = DistributiveOmit<PromotionCreateInput, 'promotionId'>;

type DatabasePromotionCreationCommand = Readonly<{
  create(input: CreatePromotionAdminInput): Promise<PromotionAdminSuccess>;
}>;

type PromotionCreationCreatorDependencies = Readonly<{
  createDatabasePromotionCommands: (dependencies: {
    tenantId: string;
    runTenantTransaction: typeof withTenantTransaction;
  }) => DatabasePromotionCreationCommand;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore: (request?: Request) => Promise<AdditiveSchemaMigrationStore>;
  createPromotion: (store: AdditiveSchemaMigrationStore, input: PromotionCreateInput) => Promise<Promotion>;
  replacePromotionProducts: (
    store: AdditiveSchemaMigrationStore,
    promotionId: string,
    productIds: string[],
  ) => Promise<Promotion>;
}>;

export type ConfiguredPromotionCreationOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredPromotionCreationCommand, ConfiguredPromotionCreationCommand>;
}>;

/** Promotion metadata exists, but its Sheets target links may not have been saved. */
export class PromotionCreationTargetPartialFailure extends Error {
  constructor(options?: ErrorOptions) {
    super('Promotion target replacement failed after metadata creation.', options);
    this.name = 'PromotionCreationTargetPartialFailure';
  }
}

export function createPromotionCreationRepositoryCreators(
  dependencies: PromotionCreationCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredPromotionCreationCommand, ConfiguredPromotionCreationCommand> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabasePromotionCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async create(input) {
          const result = await commands.create(input);
          assertPromotionCreationResult(result, input);
          const created = result.promotions[0];
          const definition = legacyDefinition(created);
          return {
            promotionId: created.promotionId,
            ...definition,
            productIds: [...created.productIds],
            createdAt: result.completedAt,
            updatedAt: result.completedAt,
            schemaVersion: created.schemaVersion,
          } as Promotion;
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
        async create(input) {
          const store = await configuredStore();
          const created = await dependencies.createPromotion(store, {
            promotionId: input.promotionId,
            ...input.definition,
          });
          if (haveSameProductIds(created.productIds, input.productIds)) return created;
          try {
            return await dependencies.replacePromotionProducts(
              store,
              input.promotionId,
              [...input.productIds],
            );
          } catch (error) {
            throw new PromotionCreationTargetPartialFailure({ cause: error });
          }
        },
      };
    },
  };
}

function legacyDefinition(
  created: PromotionAdminSuccess['promotions'][number],
): PromotionDefinitionProjection {
  const common = {
    name: created.name,
    description: created.description,
    startsAt: created.startsAt,
    endsAt: created.endsAt,
    isActive: created.isActive,
    sortOrder: created.sortOrder,
  };
  switch (created.type) {
    case 'N_PLUS_ONE':
      return { ...common, type: created.type, buyQuantity: requiredRuleNumber(created.buyQuantity), freeQuantity: requiredRuleNumber(created.freeQuantity) };
    case 'PROMOTIONAL_PRICE':
      return { ...common, type: created.type, promotionalUnitPrice: requiredRuleNumber(created.promotionalUnitPrice) };
    case 'PERCENT_DISCOUNT':
      return { ...common, type: created.type, percent: requiredRuleNumber(created.percent) };
    case 'FIXED_DISCOUNT':
      return { ...common, type: created.type, discountAmount: requiredRuleNumber(created.discountAmount) };
  }
}

function assertPromotionCreationResult(
  result: PromotionAdminSuccess,
  input: ConfiguredPromotionCreationInput,
): void {
  assertExactKeys(result, ['ok', 'operationId', 'action', 'completedAt', 'promotions']);
  if (result.ok !== true || result.operationId !== input.operationId || result.action !== 'CREATE'
    || !isCanonicalInstant(result.completedAt) || !Array.isArray(result.promotions)
    || result.promotions.length !== 1) throw resultIntegrityError();
  const row = result.promotions[0];
  const commonKeys = [
    'promotionId', 'name', 'description', 'type', 'startsAt', 'endsAt', 'isActive',
    'sortOrder', 'schemaVersion', 'productIds', 'promotionVersionBefore',
    'promotionVersionAfter',
  ];
  if (row.type !== 'N_PLUS_ONE' && row.type !== 'PROMOTIONAL_PRICE'
    && row.type !== 'PERCENT_DISCOUNT' && row.type !== 'FIXED_DISCOUNT') {
    throw resultIntegrityError();
  }
  const ruleKeys = row.type === 'N_PLUS_ONE' ? ['buyQuantity', 'freeQuantity']
    : row.type === 'PROMOTIONAL_PRICE' ? ['promotionalUnitPrice']
      : row.type === 'PERCENT_DISCOUNT' ? ['percent']
        : row.type === 'FIXED_DISCOUNT' ? ['discountAmount'] : [];
  assertExactKeys(row, [...commonKeys, ...ruleKeys]);
  if (row.promotionId !== input.promotionId
    || typeof row.name !== 'string' || !row.name.trim()
    || typeof row.description !== 'string'
    || !isCanonicalInstant(row.startsAt) || !isCanonicalInstant(row.endsAt)
    || Date.parse(row.startsAt) >= Date.parse(row.endsAt)
    || typeof row.isActive !== 'boolean'
    || !Number.isInteger(row.sortOrder) || row.sortOrder < -2147483648 || row.sortOrder > 2147483647
    || row.schemaVersion !== 3 || row.promotionVersionBefore !== null
    || row.promotionVersionAfter !== 1
    || !Array.isArray(row.productIds)
    || row.productIds.some((id: unknown) => typeof id !== 'string' || !id.trim() || id !== id.trim())
    || new Set(row.productIds).size !== row.productIds.length) throw resultIntegrityError();
  if (row.type === 'N_PLUS_ONE'
    && (!isPositiveSafeInteger(row.buyQuantity) || !isPositiveSafeInteger(row.freeQuantity))) {
    throw resultIntegrityError();
  }
  if (row.type === 'PROMOTIONAL_PRICE' && !isNonnegativeSafeInteger(row.promotionalUnitPrice)) {
    throw resultIntegrityError();
  }
  if (row.type === 'PERCENT_DISCOUNT'
    && (typeof row.percent !== 'number' || !Number.isFinite(row.percent)
      || row.percent <= 0 || row.percent > 100)) throw resultIntegrityError();
  if (row.type === 'FIXED_DISCOUNT' && !isPositiveSafeInteger(row.discountAmount)) {
    throw resultIntegrityError();
  }
}

function assertExactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw resultIntegrityError();
  }
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

function requiredRuleNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw resultIntegrityError();
  return value;
}

function resultIntegrityError(): Error {
  return new Error('Promotion creation result integrity check failed.');
}

function haveSameProductIds(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left.map((value) => value.trim()))].sort();
  const normalizedRight = [...new Set(right.map((value) => value.trim()))].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function productionCreators(request?: Request) {
  return createPromotionCreationRepositoryCreators({
    createDatabasePromotionCommands,
    withTenantTransaction,
    createConfiguredSheetsStore,
    createPromotion,
    replacePromotionProducts,
  }, request);
}

export function createConfiguredPromotionCreation(): Promise<ConfiguredPromotionCreationCommand>;
export function createConfiguredPromotionCreation(
  request: Request,
): Promise<ConfiguredPromotionCreationCommand>;
export function createConfiguredPromotionCreation(
  options: ConfiguredPromotionCreationOptions,
): Promise<ConfiguredPromotionCreationCommand>;
export async function createConfiguredPromotionCreation(
  requestOrOptions?: Request | ConfiguredPromotionCreationOptions,
): Promise<ConfiguredPromotionCreationCommand> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredPromotionCreationOptions(requestOrOptions)
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

function isConfiguredPromotionCreationOptions(
  value: Request | ConfiguredPromotionCreationOptions | undefined,
): value is ConfiguredPromotionCreationOptions {
  return Boolean(
    value
    && typeof value === 'object'
    && Object.hasOwn(value, 'env')
    && Object.hasOwn(value, 'getCentralTenantContext')
    && Object.hasOwn(value, 'creators')
    && typeof (value as ConfiguredPromotionCreationOptions).getCentralTenantContext === 'function'
    && typeof (value as ConfiguredPromotionCreationOptions).creators === 'object',
  );
}
