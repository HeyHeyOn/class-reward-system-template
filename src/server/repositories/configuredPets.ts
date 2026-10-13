import 'server-only';

import { withTenantTransaction } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { PetError, createPetCommands } from '@/server/repositories/database/pets';
import type { RepositoryCreators } from '@/server/repositories/factory';

/** The pets of one PostgreSQL class. */
export type ConfiguredPets = ReturnType<typeof createPetCommands>;

export type ConfiguredPetsOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredPets, ConfiguredPets>;
}>;

const unsupported = (): never => {
  throw new PetError('UNSUPPORTED', '펫 키우기는 새 방식(PostgreSQL) 학급에서만 쓸 수 있어요.', 404);
};

export function createPetRepositoryCreators(): RepositoryCreators<ConfiguredPets, ConfiguredPets> {
  return {
    createPostgresql: (authority) => createPetCommands({ tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction }),
    createSheets: () => ({
      studentView: unsupported, dexPage: unsupported, adopt: unsupported, care: unsupported, graduate: unsupported, buyDecor: unsupported,
      placeDecor: unsupported, setCompanions: unsupported, taskGains: unsupported, adminBoard: unsupported, saveSettings: unsupported,
      adjustGrowth: unsupported, renamePet: unsupported, renameOwnPet: unsupported,
    }),
  };
}

export async function createConfiguredPets(
  requestOrOptions?: Request | ConfiguredPetsOptions,
): Promise<ConfiguredPets> {
  const options = requestOrOptions && !(requestOrOptions instanceof Request) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createPetRepositoryCreators(),
  });
  return repository.adapter;
}
