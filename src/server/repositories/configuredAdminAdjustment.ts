import 'server-only';

import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabaseAdminCommands,
  type AdminAdjustmentMode,
} from '@/server/repositories/database/adminCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { bulkAdjustStudentBalances } from '@/server/sheetsRepository';

export type ConfiguredAdminAdjustmentInput = Readonly<{
  operationId: string;
  studentIds: string[];
  mode: AdminAdjustmentMode;
  amount: number;
}>;

export type ConfiguredAdminAdjustmentResult = Readonly<{
  students: ReadonlyArray<Readonly<{
    studentId: string;
    balanceAfter: number;
  }>>;
}>;

export type ConfiguredAdminAdjustmentCommand = Readonly<{
  adjust(input: ConfiguredAdminAdjustmentInput): Promise<ConfiguredAdminAdjustmentResult>;
}>;

type AdminAdjustmentCommandCreatorDependencies = Readonly<{
  createDatabaseAdminCommands: typeof createDatabaseAdminCommands;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore: typeof createConfiguredSheetsStore;
  bulkAdjustStudentBalances: typeof bulkAdjustStudentBalances;
}>;

export type ConfiguredAdminAdjustmentOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredAdminAdjustmentCommand, ConfiguredAdminAdjustmentCommand>;
}>;

export function createAdminAdjustmentCommandRepositoryCreators(
  dependencies: AdminAdjustmentCommandCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredAdminAdjustmentCommand, ConfiguredAdminAdjustmentCommand> {
  return {
    createPostgresql(authority) {
      return dependencies.createDatabaseAdminCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
    },
    createSheets() {
      let storePromise: ReturnType<typeof createConfiguredSheetsStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async adjust(input) {
          const rows = await dependencies.bulkAdjustStudentBalances(
            await configuredStore(),
            input,
          );
          return {
            students: rows.map(({ studentId, balance }) => ({
              studentId,
              balanceAfter: balance,
            })),
          };
        },
      };
    },
  };
}

function productionCreators(
  request?: Request,
): RepositoryCreators<ConfiguredAdminAdjustmentCommand, ConfiguredAdminAdjustmentCommand> {
  return createAdminAdjustmentCommandRepositoryCreators({
    createDatabaseAdminCommands,
    withTenantTransaction,
    createConfiguredSheetsStore,
    bulkAdjustStudentBalances,
  }, request);
}

export function createConfiguredAdminAdjustmentCommand(): Promise<ConfiguredAdminAdjustmentCommand>;
export function createConfiguredAdminAdjustmentCommand(
  request: Request,
): Promise<ConfiguredAdminAdjustmentCommand>;
export function createConfiguredAdminAdjustmentCommand(
  options: ConfiguredAdminAdjustmentOptions,
): Promise<ConfiguredAdminAdjustmentCommand>;
export async function createConfiguredAdminAdjustmentCommand(
  requestOrOptions?: Request | ConfiguredAdminAdjustmentOptions,
): Promise<ConfiguredAdminAdjustmentCommand> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredAdminAdjustmentOptions(requestOrOptions)
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

function isConfiguredAdminAdjustmentOptions(
  value: Request | ConfiguredAdminAdjustmentOptions | undefined,
): value is ConfiguredAdminAdjustmentOptions {
  return Boolean(
    value
    && typeof value === 'object'
    && Object.hasOwn(value, 'env')
    && Object.hasOwn(value, 'getCentralTenantContext')
    && Object.hasOwn(value, 'creators')
    && typeof (value as ConfiguredAdminAdjustmentOptions).getCentralTenantContext === 'function',
  );
}
