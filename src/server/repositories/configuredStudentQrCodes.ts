import 'server-only';

import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { StudentQrCodeError, createTenantStudentQrCodes, type createStudentQrCodes } from '@/server/repositories/database/studentQrCodes';
import type { RepositoryCreators } from '@/server/repositories/factory';

/** The short QR codes of one PostgreSQL class. */
export type ConfiguredStudentQrCodes = Pick<ReturnType<typeof createStudentQrCodes>, 'reissue'>;

export type ConfiguredStudentQrCodesOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredStudentQrCodes, ConfiguredStudentQrCodes>;
}>;

export function createStudentQrCodeRepositoryCreators(): RepositoryCreators<ConfiguredStudentQrCodes, ConfiguredStudentQrCodes> {
  return {
    createPostgresql: (authority) => createTenantStudentQrCodes(authority.tenantId),
    createSheets: () => ({
      reissue: () => {
        throw new StudentQrCodeError('UNSUPPORTED', 'QR 새로 발급은 새 방식(PostgreSQL) 학급에서만 쓸 수 있어요.', 404);
      },
    }),
  };
}

export async function createConfiguredStudentQrCodes(
  requestOrOptions?: Request | ConfiguredStudentQrCodesOptions,
): Promise<ConfiguredStudentQrCodes> {
  const options = requestOrOptions && !(requestOrOptions instanceof Request) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createStudentQrCodeRepositoryCreators(),
  });
  return repository.adapter;
}
