import 'server-only';

import type { Student } from '@/domain/types';
import type { StudentAdminSnapshot } from '@/lib/studentAdminSnapshot';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { parseStorageSelection } from '@/server/repositories/context';
import { createConfiguredSheetsReader } from '@/server/repositories/sheets/lazy';
import { withTenantSnapshot } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import { type RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseStudentQueries } from '@/server/repositories/database/studentQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { getStudentById, getStudents } from '@/server/repositories/sheets/lazy';
import type { SheetsReader } from '@/server/sheetsRepository';

export type StudentReader = Readonly<{
  getStudents: () => Promise<Student[]>;
  getStudentById: (studentId: string) => Promise<Student | null>;
}>;

export async function readConfiguredStudentAdminSnapshot(): Promise<StudentAdminSnapshot> {
  const context = getOptionalTrustedTenantRequestContext();
  const authority = parseStorageSelection(
    { CLASS_STORE_STORAGE: context ? 'postgresql' : (process.env.CLASS_STORE_STORAGE ?? 'sheets') },
    context ? { tenantId: context.tenant.id, tenantStatus: context.tenant.lifecycle } : undefined,
  );
  if (authority.storage === 'postgresql') {
    const students = await createDatabaseStudentQueries({
      tenantId: authority.tenantId, runTenantTransaction: withTenantSnapshot,
    }).getAdminStudents();
    return { storage: 'postgresql', students };
  }
  return { storage: 'sheets', students: await getStudents(await createConfiguredSheetsReader()) };
}

type StudentQueryFactory = (dependencies: {
  tenantId: string;
  runTenantTransaction: typeof withTenantSnapshot;
}) => StudentReader;

type StudentCreatorDependencies = Readonly<{
  createDatabaseStudentQueries: StudentQueryFactory;
  withTenantSnapshot: typeof withTenantSnapshot;
  createConfiguredSheetsReader: () => Promise<SheetsReader>;
  getStudents: (reader: SheetsReader) => Promise<Student[]>;
  getStudentById: (reader: SheetsReader, studentId: string) => Promise<Student | null>;
}>;

export type ConfiguredStudentOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<StudentReader, StudentReader>;
}>;

export function createStudentRepositoryCreators(
  dependencies: StudentCreatorDependencies,
): RepositoryCreators<StudentReader, StudentReader> {
  return {
    createPostgresql(authority) {
      return dependencies.createDatabaseStudentQueries({
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
        async getStudents() {
          return dependencies.getStudents(await configuredReader());
        },
        async getStudentById(studentId: string) {
          return dependencies.getStudentById(await configuredReader(), studentId);
        },
      };
    },
  };
}

const productionCreators = createStudentRepositoryCreators({
  createDatabaseStudentQueries,
  withTenantSnapshot,
  createConfiguredSheetsReader,
  getStudents,
  getStudentById,
});

export function createConfiguredStudentReader(): Promise<StudentReader>;
export function createConfiguredStudentReader(options: ConfiguredStudentOptions): Promise<StudentReader>;
export async function createConfiguredStudentReader(
  options?: ConfiguredStudentOptions,
): Promise<StudentReader> {
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators,
  });
  return repository.adapter;
}
