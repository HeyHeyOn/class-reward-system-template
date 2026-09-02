import 'server-only';

import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabasePromotionCommands,
  type PromotionAdminDefinitionInput,
  type PromotionAdminSuccess,
} from '@/server/repositories/database/promotionCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import {
  replacePromotionProducts,
  setPromotionActive,
  updatePromotion,
  type PromotionDefinitionInput,
} from '@/server/repositories/sheets/promotionCommands';
import type { AdditiveSchemaMigrationStore } from '@/server/storage/tabularStore';

export const PROMOTION_MUTATION_TARGET_PARTIAL_FAILURE_MESSAGE =
  '행사 정보는 저장되었을 수 있지만 대상 상품 수정에 실패했습니다. 새로고침 후 확인하고 다시 시도해 주세요.';

export class PromotionMutationTargetPartialFailure extends Error {
  constructor(options?: ErrorOptions) {
    super('Promotion target replacement failed after metadata update.', options);
    this.name = 'PromotionMutationTargetPartialFailure';
  }
}

export type ConfiguredPromotionMutationInput =
  | Readonly<{ kind: 'definition'; operationId: string; promotionId: string;
    expectedPromotionVersion: number; definition: PromotionDefinitionInput; productIds: string[] }>
  | Readonly<{ kind: 'activation'; operationId: string; promotionId: string;
    expectedPromotionVersion: number; isActive: boolean }>;
export type ConfiguredPromotionMutationResult = Readonly<{
  promotionId: string;
  mutationPrecondition: Readonly<{ promotionId: string; expectedVersion: number }>;
}>;
export type ConfiguredPromotionMutationCommand = Readonly<{
  patch(input: ConfiguredPromotionMutationInput): Promise<ConfiguredPromotionMutationResult>;
}>;

type DatabaseCommands = Readonly<{
  update(input: unknown): Promise<PromotionAdminSuccess>;
  activate(input: unknown): Promise<PromotionAdminSuccess>;
  deactivate(input: unknown): Promise<PromotionAdminSuccess>;
}>;
type Dependencies = Readonly<{
  createDatabasePromotionCommands(dependencies: { tenantId: string; runTenantTransaction: typeof withTenantTransaction }): DatabaseCommands;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore(request?: Request): Promise<AdditiveSchemaMigrationStore>;
  updatePromotion(store: AdditiveSchemaMigrationStore, input: PromotionDefinitionInput & { promotionId: string }): Promise<{ promotionId: string; productIds: string[] }>;
  replacePromotionProducts(store: AdditiveSchemaMigrationStore, promotionId: string, productIds: string[]): Promise<{ promotionId: string }>;
  setPromotionActive(store: AdditiveSchemaMigrationStore, promotionId: string, isActive: boolean): Promise<{ promotionId: string }>;
}>;
export type ConfiguredPromotionMutationOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext(env: CompatibilityCentralTenantEnv): CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredPromotionMutationCommand, ConfiguredPromotionMutationCommand>;
}>;

export function createPromotionMutationRepositoryCreators(
  dependencies: Dependencies,
  request?: Request,
): RepositoryCreators<ConfiguredPromotionMutationCommand, ConfiguredPromotionMutationCommand> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabasePromotionCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return { async patch(input) {
        assertInput(input);
        const commandInput = {
          operationId: input.operationId,
          promotionId: input.promotionId,
          expectedPromotionVersion: input.expectedPromotionVersion,
        };
        const raw = input.kind === 'definition'
          ? await commands.update({ ...commandInput, definition: input.definition as PromotionAdminDefinitionInput, productIds: [...input.productIds] })
          : input.isActive ? await commands.activate(commandInput) : await commands.deactivate(commandInput);
        const row = assertDatabaseResult(raw, input);
        return receipt(input.promotionId, row.promotionVersionAfter);
      } };
    },
    createSheets() {
      let storePromise: Promise<AdditiveSchemaMigrationStore> | undefined;
      const store = () => (storePromise ??= dependencies.createConfiguredSheetsStore(request));
      return { async patch(input) {
        assertInput(input);
        const configured = await store();
        if (input.kind === 'activation') {
          assertSheetsIdentity(await dependencies.setPromotionActive(configured, input.promotionId, input.isActive), input.promotionId);
          return receipt(input.promotionId, 1);
        }
        const updated = await dependencies.updatePromotion(configured, { promotionId: input.promotionId, ...input.definition });
        const updatedValues = assertSheetsIdentity(updated, input.promotionId);
        const currentIds = canonicalSet(updatedValues.productIds);
        const requestedIds = canonicalSet(input.productIds);
        if (!currentIds || !requestedIds) throw integrity();
        if (!sameIds(currentIds, requestedIds)) {
          try {
            assertSheetsIdentity(await dependencies.replacePromotionProducts(configured, input.promotionId, [...input.productIds]), input.promotionId);
          } catch (error) {
            throw new PromotionMutationTargetPartialFailure({ cause: error });
          }
        }
        return receipt(input.promotionId, 1);
      } };
    },
  };
}

function assertInput(input: ConfiguredPromotionMutationInput): void {
  if (!input || typeof input !== 'object' || (input.kind !== 'definition' && input.kind !== 'activation')
    || !Number.isSafeInteger(input.expectedPromotionVersion) || input.expectedPromotionVersion <= 0
    || input.expectedPromotionVersion >= Number.MAX_SAFE_INTEGER) throw integrity();
}

function assertDatabaseResult(raw: unknown, input: ConfiguredPromotionMutationInput): Record<string, unknown> {
  const top = values(raw, ['ok', 'operationId', 'action', 'completedAt', 'promotions']);
  const expectedAction = input.kind === 'definition' ? 'UPDATE' : input.isActive ? 'ACTIVATE' : 'DEACTIVATE';
  if (!top || top.ok !== true || top.operationId !== input.operationId || top.action !== expectedAction
    || !canonicalInstant(top.completedAt)) throw integrity();
  const rows = singleArray(top.promotions);
  if (!rows) throw integrity();
  const row = parseRow(rows[0]);
  if (row.promotionId !== input.promotionId || row.schemaVersion !== 3
    || row.promotionVersionBefore !== input.expectedPromotionVersion
    || row.promotionVersionAfter !== input.expectedPromotionVersion + 1) throw integrity();
  if (input.kind === 'definition') {
    const expected = input.definition as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) if (row[key] !== value) throw integrity();
    if (!equalExactIds(row.productIds, input.productIds)) throw integrity();
  } else if (row.isActive !== input.isActive) throw integrity();
  return row;
}

function parseRow(raw: unknown): Record<string, unknown> {
  const descriptors = ordinaryDescriptors(raw);
  if (!descriptors) throw integrity();
  const type = descriptors.type?.value;
  const variant = type === 'N_PLUS_ONE' ? ['buyQuantity', 'freeQuantity']
    : type === 'PROMOTIONAL_PRICE' ? ['promotionalUnitPrice']
      : type === 'PERCENT_DISCOUNT' ? ['percent']
        : type === 'FIXED_DISCOUNT' ? ['discountAmount'] : undefined;
  if (!variant) throw integrity();
  const expected = ['promotionId', 'name', 'description', 'type', 'startsAt', 'endsAt', 'isActive',
    'sortOrder', 'schemaVersion', 'productIds', 'promotionVersionBefore', 'promotionVersionAfter', ...variant];
  if (!exactKeys(descriptors, expected)) throw integrity();
  const row = Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
  if (typeof row.promotionId !== 'string' || !row.promotionId || row.promotionId !== row.promotionId.trim()
    || typeof row.name !== 'string' || !row.name || row.name !== row.name.trim()
    || typeof row.description !== 'string' || row.description !== row.description.trim()
    || !canonicalInstant(row.startsAt) || !canonicalInstant(row.endsAt)
    || Date.parse(row.startsAt) >= Date.parse(row.endsAt) || typeof row.isActive !== 'boolean'
    || !Number.isInteger(row.sortOrder) || (row.sortOrder as number) < -2147483648 || (row.sortOrder as number) > 2147483647
    || !canonicalIds(row.productIds)) throw integrity();
  if (type === 'N_PLUS_ONE' && (!positive(row.buyQuantity) || !positive(row.freeQuantity))) throw integrity();
  if (type === 'PROMOTIONAL_PRICE' && (!Number.isSafeInteger(row.promotionalUnitPrice) || (row.promotionalUnitPrice as number) < 0)) throw integrity();
  if (type === 'PERCENT_DISCOUNT' && (typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent <= 0 || row.percent > 100)) throw integrity();
  if (type === 'FIXED_DISCOUNT' && !positive(row.discountAmount)) throw integrity();
  return row;
}

function values(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const descriptors = ordinaryDescriptors(value);
  if (!descriptors || !exactKeys(descriptors, keys)) return undefined;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function ordinaryDescriptors(value: unknown): Record<string, PropertyDescriptor> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return undefined;
  const result: Record<string, PropertyDescriptor> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !descriptor.writable || !descriptor.configurable || !Object.hasOwn(descriptor, 'value')) return undefined;
    result[key] = descriptor;
  }
  return result;
}
function exactKeys(descriptors: Record<string, PropertyDescriptor>, expected: readonly string[]): boolean {
  const actual = Object.keys(descriptors).sort(compare);
  const keys = [...expected].sort(compare);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function singleArray(value: unknown): [unknown] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  const zero = Object.getOwnPropertyDescriptor(value, '0');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (keys.length !== 2 || keys[0] !== '0' || keys[1] !== 'length' || !zero?.enumerable || !zero.writable
    || !zero.configurable || !Object.hasOwn(zero, 'value') || !length || length.enumerable || !length.writable
    || length.configurable || !Object.hasOwn(length, 'value') || length.value !== 1) return undefined;
  return [zero.value];
}
function canonicalIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || length.enumerable || !length.writable || length.configurable || length.value !== value.length || keys.length !== value.length + 1) return false;
  let previous: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const id = descriptor?.value;
    if (!descriptor?.enumerable || !descriptor.writable || !descriptor.configurable || typeof id !== 'string'
      || !id || id !== id.trim() || (previous !== undefined && compare(previous, id) >= 0)) return false;
    previous = id;
  }
  return keys[value.length] === 'length';
}
function equalExactIds(value: unknown, expected: readonly string[]): boolean {
  return canonicalIds(value) && value.length === expected.length && value.every((id, index) => id === [...expected].sort(compare)[index]);
}
function sameIds(left: unknown, right: unknown): boolean {
  const a = canonicalSet(left);
  const b = canonicalSet(right);
  return a !== undefined && b !== undefined && a.length === b.length
    && a.every((id, index) => id === b[index]);
}
function canonicalSet(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || length.enumerable || !length.writable || length.configurable
    || !Object.hasOwn(length, 'value') || length.value !== value.length
    || keys.length !== value.length + 1 || keys[value.length] !== 'length') return undefined;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const id = descriptor?.value;
    if (!descriptor?.enumerable || !descriptor.writable || !descriptor.configurable
      || !Object.hasOwn(descriptor, 'value') || typeof id !== 'string'
      || !id || id !== id.trim()) return undefined;
    result.push(id);
  }
  if (new Set(result).size !== result.length) return undefined;
  return result.sort(compare);
}
function assertSheetsIdentity(raw: unknown, expected: string): Record<string, unknown> {
  const descriptors = ordinaryDescriptors(raw);
  if (!descriptors || descriptors.promotionId?.value !== expected) throw integrity();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function receipt(promotionId: string, expectedVersion: unknown): ConfiguredPromotionMutationResult {
  if (!positive(expectedVersion)) throw integrity();
  return { promotionId, mutationPrecondition: { promotionId, expectedVersion } };
}
function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function integrity(): Error { return new Error('Promotion mutation result integrity check failed.'); }

function productionCreators(request?: Request) {
  return createPromotionMutationRepositoryCreators({ createDatabasePromotionCommands, withTenantTransaction,
    createConfiguredSheetsStore,
    updatePromotion: (store, { promotionId, ...definition }) => updatePromotion(store, promotionId, definition),
    replacePromotionProducts, setPromotionActive }, request);
}
export function createConfiguredPromotionMutation(): Promise<ConfiguredPromotionMutationCommand>;
export function createConfiguredPromotionMutation(request: Request): Promise<ConfiguredPromotionMutationCommand>;
export function createConfiguredPromotionMutation(options: ConfiguredPromotionMutationOptions): Promise<ConfiguredPromotionMutationCommand>;
export async function createConfiguredPromotionMutation(requestOrOptions?: Request | ConfiguredPromotionMutationOptions): Promise<ConfiguredPromotionMutationCommand> {
  const supplied = arguments.length > 0;
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : validOptions(requestOrOptions) ? requestOrOptions : undefined;
  if (supplied && !request && !options) throw new Error('Invalid configured promotion mutation options.');
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}
function isRequest(value: unknown): value is Request { return typeof Request !== 'undefined' && value instanceof Request; }
function validOptions(value: unknown): value is ConfiguredPromotionMutationOptions {
  const option = values(value, ['env', 'getCentralTenantContext', 'creators']);
  return Boolean(option && safeEnv(option.env) && typeof option.getCentralTenantContext === 'function' && safeCreators(option.creators));
}
function safeEnv(value: unknown): value is CompatibilityCentralTenantEnv {
  const descriptors = ordinaryDescriptors(value);
  return Boolean(descriptors && Object.values(descriptors).every((descriptor) => typeof descriptor.value === 'string' || descriptor.value === undefined));
}
function safeCreators(value: unknown): value is ConfiguredPromotionMutationOptions['creators'] {
  const creators = values(value, ['createPostgresql', 'createSheets']);
  return Boolean(creators && typeof creators.createPostgresql === 'function' && typeof creators.createSheets === 'function');
}
