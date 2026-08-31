import 'server-only';

import type { Transaction } from '@/domain/types';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { withTenantSnapshot } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { getTransactions, type SheetsReader } from '@/server/sheetsRepository';

export type TransactionReader = Readonly<{
  getTransactions: () => Promise<Transaction[]>;
}>;

type TransactionQueryFactory = (dependencies: {
  tenantId: string;
  runTenantTransaction: typeof withTenantSnapshot;
}) => TransactionReader;

type TransactionCreatorDependencies = Readonly<{
  createDatabaseTransactionQueries: TransactionQueryFactory;
  withTenantSnapshot: typeof withTenantSnapshot;
  createConfiguredSheetsReader: () => Promise<SheetsReader>;
  getTransactions: (reader: SheetsReader) => Promise<Transaction[]>;
}>;

export type ConfiguredTransactionOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<TransactionReader, TransactionReader>;
}>;

export function createTransactionRepositoryCreators(
  dependencies: TransactionCreatorDependencies,
): RepositoryCreators<TransactionReader, TransactionReader> {
  return {
    createPostgresql(authority) {
      return dependencies.createDatabaseTransactionQueries({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantSnapshot,
      });
    },
    createSheets() {
      let readerPromise: Promise<SheetsReader> | undefined;
      const configuredReader = () => {
        readerPromise ??= dependencies.createConfiguredSheetsReader();
        return readerPromise;
      };
      return {
        async getTransactions() {
          return dependencies.getTransactions(await configuredReader());
        },
      };
    },
  };
}

const productionCreators = createTransactionRepositoryCreators({
  createDatabaseTransactionQueries,
  withTenantSnapshot,
  createConfiguredSheetsReader,
  getTransactions,
});

export function createConfiguredTransactionReader(): Promise<TransactionReader>;
export function createConfiguredTransactionReader(
  options: ConfiguredTransactionOptions,
): Promise<TransactionReader>;
export async function createConfiguredTransactionReader(
  options?: ConfiguredTransactionOptions,
): Promise<TransactionReader> {
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators,
  });
  return repository.adapter;
}