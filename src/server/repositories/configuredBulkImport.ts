import 'server-only';

import type {
  BulkImportCommitRequest,
  ProductImportCommitResult,
  ProductImportPreview,
  ProductImportRow,
  StudentImportCommitResult,
  StudentImportPreview,
  StudentImportRow,
} from '@/lib/bulkImport';
import { withTenantTransaction } from '@/server/db/transaction';
import { BulkImportUnsupportedError } from '@/server/bulkImport/errors';
import { buildProductImportPreview, parseProductImportFile } from '@/server/bulkImport/productImport';
import { buildStudentImportPreview, parseStudentImportFile } from '@/server/bulkImport/studentImport';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import {
  createDatabaseProductImport,
  createDatabaseStudentImport,
} from '@/server/repositories/database/bulkImportCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';

export type ConfiguredStudentImport = Readonly<{
  preview(bytes: Uint8Array): Promise<StudentImportPreview>;
  commit(request: BulkImportCommitRequest<StudentImportRow>): Promise<StudentImportCommitResult>;
}>;

export type ConfiguredProductImport = Readonly<{
  preview(bytes: Uint8Array): Promise<ProductImportPreview>;
  commit(request: BulkImportCommitRequest<ProductImportRow>): Promise<ProductImportCommitResult>;
}>;

export type ConfiguredBulkImportOptions<TAdapter> = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<TAdapter, TAdapter>;
}>;

type BulkImportCreatorDependencies = Readonly<{
  withTenantTransaction: typeof withTenantTransaction;
  createDatabaseStudentImport: typeof createDatabaseStudentImport;
  createDatabaseProductImport: typeof createDatabaseProductImport;
}>;

const productionDependencies: BulkImportCreatorDependencies = {
  withTenantTransaction,
  createDatabaseStudentImport,
  createDatabaseProductImport,
};

/** Legacy unscoped Google Sheets storage has no transactional batch path: refuse clearly. */
const unsupported = {
  async preview(): Promise<never> { throw new BulkImportUnsupportedError(); },
  async commit(): Promise<never> { throw new BulkImportUnsupportedError(); },
} as const;

export function createStudentImportRepositoryCreators(
  dependencies: BulkImportCreatorDependencies = productionDependencies,
): RepositoryCreators<ConfiguredStudentImport, ConfiguredStudentImport> {
  return {
    createPostgresql(authority) {
      const database = dependencies.createDatabaseStudentImport({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async preview(bytes) {
          const parsed = await parseStudentImportFile(bytes);
          return buildStudentImportPreview(parsed, await database.loadExisting());
        },
        commit: (request) => database.commit(request),
      };
    },
    createSheets: () => unsupported,
  };
}

export function createProductImportRepositoryCreators(
  dependencies: BulkImportCreatorDependencies = productionDependencies,
): RepositoryCreators<ConfiguredProductImport, ConfiguredProductImport> {
  return {
    createPostgresql(authority) {
      const database = dependencies.createDatabaseProductImport({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async preview(bytes) {
          const parsed = await parseProductImportFile(bytes);
          return buildProductImportPreview(parsed, await database.loadExisting());
        },
        commit: (request) => database.commit(request),
      };
    },
    createSheets: () => unsupported,
  };
}

export async function createConfiguredStudentImport(
  requestOrOptions?: Request | ConfiguredBulkImportOptions<ConfiguredStudentImport>,
): Promise<ConfiguredStudentImport> {
  const options = isOptions(requestOrOptions) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createStudentImportRepositoryCreators(),
  });
  return repository.adapter;
}

export async function createConfiguredProductImport(
  requestOrOptions?: Request | ConfiguredBulkImportOptions<ConfiguredProductImport>,
): Promise<ConfiguredProductImport> {
  const options = isOptions(requestOrOptions) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createProductImportRepositoryCreators(),
  });
  return repository.adapter;
}

function isOptions<TAdapter>(
  value: Request | ConfiguredBulkImportOptions<TAdapter> | undefined,
): value is ConfiguredBulkImportOptions<TAdapter> {
  return Boolean(value && !(typeof Request !== 'undefined' && value instanceof Request)
    && typeof value === 'object' && 'creators' in value && 'env' in value);
}
