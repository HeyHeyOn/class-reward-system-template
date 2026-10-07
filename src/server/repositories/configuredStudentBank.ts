import 'server-only';

import type { Student, Transaction } from '@/domain/types';
import { withTenantSnapshot, type TenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsReader } from '@/server/repositories/sheets/lazy';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseStudentQueries } from '@/server/repositories/database/studentQueries';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { getTransactions } from '@/server/repositories/sheets/lazy';
import type { SheetsReader } from '@/server/sheetsRepository';
import { confirmStudentLookup, type ConfirmedStudentLookup } from '@/server/studentLookup';

/** The PostgreSQL per-student window never returns more than this many parent transactions. */
export const STUDENT_BANK_TRANSACTION_LIMIT = 100;

/** Reads for one logged-in student's personal bank. Callers pass the session-derived student ID. */
export type StudentBankReader = Readonly<{
  confirmStudent(studentId: string): Promise<ConfirmedStudentLookup>;
  getTransactions(studentId: string): Promise<Transaction[]>;
}>;

type StudentBankCreatorDependencies = Readonly<{
  createDatabaseStudentQueries: typeof createDatabaseStudentQueries;
  createDatabaseTransactionQueries: typeof createDatabaseTransactionQueries;
  withTenantSnapshot: typeof withTenantSnapshot;
  createConfiguredSheetsReader: () => Promise<SheetsReader>;
  getTransactions: (reader: SheetsReader) => Promise<Transaction[]>;
  confirmStudentLookup: (reader: SheetsReader, studentId: string) => Promise<ConfirmedStudentLookup>;
}>;

export type ConfiguredStudentBankOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<StudentBankReader, StudentBankReader>;
}>;

export function createStudentBankRepositoryCreators(
  dependencies: StudentBankCreatorDependencies,
): RepositoryCreators<StudentBankReader, StudentBankReader> {
  return {
    createPostgresql(authority) {
      const inSnapshot = <TResult>(
        callback: (queries: Readonly<{
          students: ReturnType<typeof createDatabaseStudentQueries>;
          transactions: ReturnType<typeof createDatabaseTransactionQueries>;
        }>) => Promise<TResult>,
      ) => dependencies.withTenantSnapshot(authority.tenantId, async (transaction) => {
        const runTenantTransaction = <T>(_tenantId: string, run: (current: TenantTransaction) => Promise<T>) => run(transaction);
        return callback({
          students: dependencies.createDatabaseStudentQueries({ tenantId: authority.tenantId, runTenantTransaction }),
          transactions: dependencies.createDatabaseTransactionQueries({ tenantId: authority.tenantId, runTenantTransaction }),
        });
      });
      return {
        confirmStudent(studentId) {
          return inSnapshot(async ({ students }) => classifyStudent(await students.getStudentById(studentId)));
        },
        getTransactions(studentId) {
          return inSnapshot(async ({ transactions }) => newestFirst(
            await transactions.getTransactions({ studentId, limit: STUDENT_BANK_TRANSACTION_LIMIT }),
            studentId,
          ));
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
        async confirmStudent(studentId) {
          return dependencies.confirmStudentLookup(await configuredReader(), studentId);
        },
        async getTransactions(studentId) {
          return newestFirst(await dependencies.getTransactions(await configuredReader()), studentId);
        },
      };
    },
  };
}

function classifyStudent(student: Student | null): ConfirmedStudentLookup {
  if (!student) return { status: 'NOT_FOUND' };
  if (student.status !== 'ACTIVE') return { status: 'INACTIVE' };
  return { status: 'FOUND', student };
}

/** Only the student's own rows, newest first, bounded like the PostgreSQL window. */
function newestFirst(transactions: readonly Transaction[], studentId: string): Transaction[] {
  return transactions
    .map((transaction, index) => ({ transaction, index, time: Date.parse(transaction.timestamp) }))
    .filter(({ transaction }) => transaction.studentId === studentId)
    .sort((left, right) => {
      const leftTime = Number.isNaN(left.time) ? -Infinity : left.time;
      const rightTime = Number.isNaN(right.time) ? -Infinity : right.time;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.index - right.index;
    })
    .slice(0, STUDENT_BANK_TRANSACTION_LIMIT)
    .map(({ transaction }) => transaction);
}

function productionCreators(request?: Request): RepositoryCreators<StudentBankReader, StudentBankReader> {
  return createStudentBankRepositoryCreators({
    createDatabaseStudentQueries,
    createDatabaseTransactionQueries,
    withTenantSnapshot,
    createConfiguredSheetsReader: () => createConfiguredSheetsReader(request),
    getTransactions,
    confirmStudentLookup,
  });
}

export function createConfiguredStudentBankReader(): Promise<StudentBankReader>;
export function createConfiguredStudentBankReader(request: Request): Promise<StudentBankReader>;
export function createConfiguredStudentBankReader(options: ConfiguredStudentBankOptions): Promise<StudentBankReader>;
export async function createConfiguredStudentBankReader(
  requestOrOptions?: Request | ConfiguredStudentBankOptions,
): Promise<StudentBankReader> {
  const options = requestOrOptions && typeof requestOrOptions === 'object' && 'creators' in requestOrOptions
    ? requestOrOptions as ConfiguredStudentBankOptions
    : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}
