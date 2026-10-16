import 'server-only';

import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { StudentGroupError, createTenantStudentGroups, type StudentGroupsRepository } from '@/server/repositories/database/studentGroups';
import type { RepositoryCreators } from '@/server/repositories/factory';

export type ConfiguredStudentGroupsOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<StudentGroupsRepository, StudentGroupsRepository>;
}>;

const unsupported = (): never => {
  throw new StudentGroupError('UNSUPPORTED', '모둠은 새 방식(PostgreSQL) 학급에서만 쓸 수 있어요.', 404);
};

export function createStudentGroupRepositoryCreators(): RepositoryCreators<StudentGroupsRepository, StudentGroupsRepository> {
  return {
    createPostgresql: (authority) => createTenantStudentGroups(authority.tenantId),
    createSheets: () => ({ list: unsupported, create: unsupported, rename: unsupported, remove: unsupported, assign: unsupported }),
  };
}

/** The 모둠 of the class this request is for. */
export async function createConfiguredStudentGroups(
  requestOrOptions?: Request | ConfiguredStudentGroupsOptions,
): Promise<StudentGroupsRepository> {
  const options = requestOrOptions && !(requestOrOptions instanceof Request) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createStudentGroupRepositoryCreators(),
  });
  return repository.adapter;
}
