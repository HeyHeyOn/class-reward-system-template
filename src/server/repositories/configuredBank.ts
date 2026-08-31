import 'server-only';

import type { Student, Transaction } from '@/domain/types';
import { withTenantSnapshot, type TenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import type { ConfirmedStudentLookup } from '@/server/studentLookup';
import { confirmStudentLookup } from '@/server/studentLookup';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseStudentQueries } from '@/server/repositories/database/studentQueries';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { getStudentById, getTransactions, type SheetsReader } from '@/server/sheetsRepository';

export type BankBalanceSnapshot = Readonly<{
  student: Student | null;
  transactions: Transaction[];
}>;

export type BankReader = Readonly<{
  getBalance: (studentId: string) => Promise<BankBalanceSnapshot>;
  confirmStudent: (studentId: string) => Promise<ConfirmedStudentLookup>;
}>;

type SnapshotRunner = typeof withTenantSnapshot;
type StudentQueryFactory = typeof createDatabaseStudentQueries;
type TransactionQueryFactory = typeof createDatabaseTransactionQueries;

type BankCreatorDependencies = Readonly<{
  createDatabaseStudentQueries: StudentQueryFactory;
  createDatabaseTransactionQueries: TransactionQueryFactory;
  withTenantSnapshot: SnapshotRunner;
  createConfiguredSheetsReader: () => Promise<SheetsReader>;
  getStudentById: (reader: SheetsReader, studentId: string) => Promise<Student | null>;
  getTransactions: (reader: SheetsReader) => Promise<Transaction[]>;
  confirmStudentLookup: (
    reader: SheetsReader,
    studentId: string,
  ) => Promise<ConfirmedStudentLookup>;
}>;

export type ConfiguredBankOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<BankReader, BankReader>;
}>;

export function createBankRepositoryCreators(
  dependencies: BankCreatorDependencies,
): RepositoryCreators<BankReader, BankReader> {
  return {
    createPostgresql(authority) {
      const runInSnapshot = <TResult>(
        transaction: TenantTransaction,
        callback: (transaction: TenantTransaction) => Promise<TResult>,
      ) => callback(transaction);
      return {
        getBalance(studentId) {
          return dependencies.withTenantSnapshot(authority.tenantId, async (transaction) => {
            const runTenantTransaction = <TResult>(
              _tenantId: string,
              callback: (current: TenantTransaction) => Promise<TResult>,
            ) => runInSnapshot(transaction, callback);
            const students = dependencies.createDatabaseStudentQueries({
              tenantId: authority.tenantId,
              runTenantTransaction,
            });
            const transactions = dependencies.createDatabaseTransactionQueries({
              tenantId: authority.tenantId,
              runTenantTransaction,
            });
            const student = await students.getStudentById(studentId);
            const history = student ? await transactions.getTransactions() : [];
            return { student, transactions: history };
          });
        },
        confirmStudent(studentId) {
          return dependencies.withTenantSnapshot(authority.tenantId, async (transaction) => {
            const students = dependencies.createDatabaseStudentQueries({
              tenantId: authority.tenantId,
              runTenantTransaction: <TResult>(
                _tenantId: string,
                callback: (current: TenantTransaction) => Promise<TResult>,
              ) => runInSnapshot(transaction, callback),
            });
            const student = await students.getStudentById(studentId);
            if (!student) return { status: 'NOT_FOUND' };
            if (student.status !== 'ACTIVE') return { status: 'INACTIVE' };
            return { status: 'FOUND', student };
          });
        },
      };
    },
    createSheets() {
      let readerPromise: Promise<SheetsReader> | undefined;
      const configuredReader = () => {
        readerPromise ??= dependencies.createConfiguredSheetsReader();
        return readerPromise;
      };
      return {
        async getBalance(studentId) {
          const reader = await configuredReader();
          const student = await dependencies.getStudentById(reader, studentId);
          const history = student ? await dependencies.getTransactions(reader) : [];
          return { student, transactions: history };
        },
        async confirmStudent(studentId) {
          return dependencies.confirmStudentLookup(await configuredReader(), studentId);
        },
      };
    },
  };
}

function productionCreators(request?: Request): RepositoryCreators<BankReader, BankReader> {
  return createBankRepositoryCreators({
    createDatabaseStudentQueries,
    createDatabaseTransactionQueries,
    withTenantSnapshot,
    createConfiguredSheetsReader: () => createConfiguredSheetsReader(request),
    getStudentById,
    getTransactions,
    confirmStudentLookup,
  });
}

export function createConfiguredBankReader(): Promise<BankReader>;
export function createConfiguredBankReader(request: Request): Promise<BankReader>;
export function createConfiguredBankReader(options: ConfiguredBankOptions): Promise<BankReader>;
export async function createConfiguredBankReader(
  requestOrOptions?: Request | ConfiguredBankOptions,
): Promise<BankReader> {
  const options = isConfiguredBankOptions(requestOrOptions) ? requestOrOptions : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isConfiguredBankOptions(
  value: Request | ConfiguredBankOptions | undefined,
): value is ConfiguredBankOptions {
  return Boolean(value && typeof value === 'object' && 'creators' in value);
}
