import 'server-only';

import type { Transaction } from '@/domain/types';
import { withTenantSnapshot, withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabaseTransactionCommands,
  type CancelTransactionInput,
} from '@/server/repositories/database/transactionCommands';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { cancelTransaction } from '@/server/sheetsRepository';

export type ConfiguredTransactionCancellationInput = Readonly<
  Pick<CancelTransactionInput, 'operationId' | 'transactionId'>
>;

export type TransactionCancellationPair = Readonly<{
  cancelledTransaction: Transaction;
  reversalTransaction: Transaction;
}>;

export type ConfiguredTransactionCancellation = Readonly<{
  cancel(input: ConfiguredTransactionCancellationInput): Promise<TransactionCancellationPair>;
}>;

type TransactionCancellationCreatorDependencies = Readonly<{
  createDatabaseTransactionCommands: (
    dependencies: Parameters<typeof createDatabaseTransactionCommands>[0],
  ) => Readonly<{
    cancel(input: ConfiguredTransactionCancellationInput): Promise<Readonly<{
      originalTransactionId: string;
      reversalTransactionId: string;
    }>>;
  }>;
  createDatabaseTransactionQueries: (
    dependencies: Parameters<typeof createDatabaseTransactionQueries>[0],
  ) => Readonly<{
    getCancellationPair(
      originalId: string,
      reversalId: string,
    ): Promise<TransactionCancellationPair>;
  }>;
  withTenantTransaction: typeof withTenantTransaction;
  withTenantSnapshot: typeof withTenantSnapshot;
  createConfiguredSheetsStore: typeof createConfiguredSheetsStore;
  cancelTransaction: typeof cancelTransaction;
}>;

export type ConfiguredTransactionCancellationOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredTransactionCancellation, ConfiguredTransactionCancellation>;
}>;

export function createTransactionCancellationRepositoryCreators(
  dependencies: TransactionCancellationCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredTransactionCancellation, ConfiguredTransactionCancellation> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabaseTransactionCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      const queries = dependencies.createDatabaseTransactionQueries({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantSnapshot,
      });
      return {
        async cancel(input) {
          const result = await commands.cancel(input);
          return queries.getCancellationPair(
            result.originalTransactionId,
            result.reversalTransactionId,
          );
        },
      };
    },
    createSheets() {
      let storePromise: ReturnType<typeof createConfiguredSheetsStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async cancel(input) {
          return dependencies.cancelTransaction(
            await configuredStore(),
            input.transactionId,
            input.operationId,
          );
        },
      };
    },
  };
}

function productionCreators(
  request?: Request,
): RepositoryCreators<ConfiguredTransactionCancellation, ConfiguredTransactionCancellation> {
  return createTransactionCancellationRepositoryCreators({
    createDatabaseTransactionCommands,
    createDatabaseTransactionQueries,
    withTenantTransaction,
    withTenantSnapshot,
    createConfiguredSheetsStore,
    cancelTransaction,
  }, request);
}

export function createConfiguredTransactionCancellation(): Promise<ConfiguredTransactionCancellation>;
export function createConfiguredTransactionCancellation(
  request: Request,
): Promise<ConfiguredTransactionCancellation>;
export function createConfiguredTransactionCancellation(
  options: ConfiguredTransactionCancellationOptions,
): Promise<ConfiguredTransactionCancellation>;
export async function createConfiguredTransactionCancellation(
  requestOrOptions?: Request | ConfiguredTransactionCancellationOptions,
): Promise<ConfiguredTransactionCancellation> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredTransactionCancellationOptions(requestOrOptions)
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

function isConfiguredTransactionCancellationOptions(
  value: Request | ConfiguredTransactionCancellationOptions | undefined,
): value is ConfiguredTransactionCancellationOptions {
  return Boolean(
    value
    && typeof value === 'object'
    && Object.hasOwn(value, 'env')
    && Object.hasOwn(value, 'getCentralTenantContext')
    && Object.hasOwn(value, 'creators')
    && typeof (value as ConfiguredTransactionCancellationOptions).getCentralTenantContext === 'function',
  );
}
