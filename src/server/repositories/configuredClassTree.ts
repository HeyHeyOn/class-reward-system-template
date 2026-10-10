import 'server-only';

import { withTenantTransaction } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { ClassTreeError, createClassTreeCommands } from '@/server/repositories/database/classTree';
import type { RepositoryCreators } from '@/server/repositories/factory';

/** The class apple tree of one PostgreSQL class. */
export type ConfiguredClassTree = ReturnType<typeof createClassTreeCommands>;

export type ConfiguredClassTreeOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredClassTree, ConfiguredClassTree>;
}>;

const unsupported = (): never => {
  throw new ClassTreeError('UNSUPPORTED', '학급 나무는 새 방식(PostgreSQL) 학급에서만 쓸 수 있어요.', 404);
};

export function createClassTreeRepositoryCreators(): RepositoryCreators<ConfiguredClassTree, ConfiguredClassTree> {
  return {
    createPostgresql: (authority) => createClassTreeCommands({ tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction }),
    createSheets: () => ({
      studentView: unsupported, adminBoard: unsupported, saveSettings: unsupported, water: unsupported,
      classFeed: unsupported, harvest: unsupported,
    }),
  };
}

export async function createConfiguredClassTree(
  requestOrOptions?: Request | ConfiguredClassTreeOptions,
): Promise<ConfiguredClassTree> {
  const options = requestOrOptions && !(requestOrOptions instanceof Request) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createClassTreeRepositoryCreators(),
  });
  return repository.adapter;
}
