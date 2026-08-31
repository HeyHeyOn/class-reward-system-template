import 'server-only';

import type { CentralTenantContextInput, StorageSelectionEnv } from '@/server/repositories/context';
import type { ResolvedRepository } from '@/server/repositories/contracts';
import {
  resolveRepositoryFromEnv,
  type RepositoryCreators,
} from '@/server/repositories/factory';

export type CompatibilityCentralTenantEnv = StorageSelectionEnv & Readonly<{
  CLASS_STORE_CENTRAL_TENANT_ID?: string;
  CLASS_STORE_CENTRAL_TENANT_STATUS?: string;
}>;

export type CompatibilityConfiguredRepositoryOptions<TPostgreSQLAdapter, TSheetsAdapter> = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<TPostgreSQLAdapter, TSheetsAdapter>;
}>;

export function getCompatibilityCentralTenantContext(
  env: CompatibilityCentralTenantEnv = process.env,
): CentralTenantContextInput {
  return {
    tenantId: env.CLASS_STORE_CENTRAL_TENANT_ID,
    tenantStatus: env.CLASS_STORE_CENTRAL_TENANT_STATUS,
  };
}

export function resolveCompatibilityConfiguredRepository<TPostgreSQLAdapter, TSheetsAdapter>(
  options: CompatibilityConfiguredRepositoryOptions<TPostgreSQLAdapter, TSheetsAdapter>,
): Promise<ResolvedRepository<TPostgreSQLAdapter, TSheetsAdapter>> {
  const centralTenant = options.env.CLASS_STORE_STORAGE === 'postgresql'
    ? options.getCentralTenantContext(options.env)
    : undefined;
  return resolveRepositoryFromEnv(options.env, centralTenant, options.creators);
}
