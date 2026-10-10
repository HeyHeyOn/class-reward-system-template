import 'server-only';

import { withTenantTransaction } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { StudentBagError, createStudentBagCommands } from '@/server/repositories/database/studentBag';
import type { RepositoryCreators } from '@/server/repositories/factory';

/** The student bags of one PostgreSQL class. */
export type ConfiguredStudentBag = ReturnType<typeof createStudentBagCommands>;

export type ConfiguredStudentBagOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredStudentBag, ConfiguredStudentBag>;
}>;

const unsupported = (): never => {
  throw new StudentBagError('UNSUPPORTED', '보관함은 새 방식(PostgreSQL) 학급에서만 쓸 수 있어요.', 404);
};

export function createStudentBagRepositoryCreators(): RepositoryCreators<ConfiguredStudentBag, ConfiguredStudentBag> {
  return {
    createPostgresql: (authority) => createStudentBagCommands({ tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction }),
    createSheets: () => ({
      studentBag: unsupported, setItemUsed: unsupported, giveItems: unsupported, revokeItem: unsupported,
      // A Sheets class has no digital products: the kiosk and store list just show none.
      digitalProducts: async () => [], setDigitalProduct: unsupported, checkoutVouchers: async () => [],
    }),
  };
}

export async function createConfiguredStudentBag(
  requestOrOptions?: Request | ConfiguredStudentBagOptions,
): Promise<ConfiguredStudentBag> {
  const options = requestOrOptions && !(requestOrOptions instanceof Request) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createStudentBagRepositoryCreators(),
  });
  return repository.adapter;
}
