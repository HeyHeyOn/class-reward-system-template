import 'server-only';

import type {
  LegacySheetsRepositoryAuthority,
  PostgreSQLRepositoryAuthority,
  RepositoryAuthority,
  ResolvedRepository,
} from '@/server/repositories/contracts';
import {
  parseStorageSelection,
  validateRepositoryAuthority,
  type CentralTenantContextInput,
  type StorageSelectionEnv,
} from '@/server/repositories/context';

export type RepositoryCreators<TPostgreSQLAdapter, TSheetsAdapter> = {
  readonly createPostgresql: (
    authority: PostgreSQLRepositoryAuthority,
  ) => TPostgreSQLAdapter | PromiseLike<TPostgreSQLAdapter>;
  readonly createSheets: (
    authority: LegacySheetsRepositoryAuthority,
  ) => TSheetsAdapter | PromiseLike<TSheetsAdapter>;
};

export async function resolveRepository<TPostgreSQLAdapter, TSheetsAdapter>(
  authority: RepositoryAuthority,
  creators: RepositoryCreators<TPostgreSQLAdapter, TSheetsAdapter>,
): Promise<ResolvedRepository<TPostgreSQLAdapter, TSheetsAdapter>> {
  const validatedAuthority = validateRepositoryAuthority(authority);
  if (validatedAuthority.storage === 'postgresql') {
    const createPostgresql = selectedCreator(
      creators,
      'createPostgresql',
      'PostgreSQL repository creator must be callable.',
    ) as RepositoryCreators<TPostgreSQLAdapter, TSheetsAdapter>['createPostgresql'];
    const adapter = await createPostgresql(validatedAuthority);
    return { ...validatedAuthority, adapter };
  }

  const createSheets = selectedCreator(
    creators,
    'createSheets',
    'Sheets repository creator must be callable.',
  ) as RepositoryCreators<TPostgreSQLAdapter, TSheetsAdapter>['createSheets'];
  const adapter = await createSheets(validatedAuthority);
  return { ...validatedAuthority, adapter };
}

export async function resolveRepositoryFromEnv<TPostgreSQLAdapter, TSheetsAdapter>(
  env: StorageSelectionEnv,
  centralTenant: CentralTenantContextInput | undefined,
  creators: RepositoryCreators<TPostgreSQLAdapter, TSheetsAdapter>,
): Promise<ResolvedRepository<TPostgreSQLAdapter, TSheetsAdapter>> {
  return resolveRepository(parseStorageSelection(env, centralTenant), creators);
}

function selectedCreator(
  creators: unknown,
  key: 'createPostgresql' | 'createSheets',
  errorMessage: string,
): unknown {
  if (!creators || (typeof creators !== 'object' && typeof creators !== 'function')) {
    throw new Error(errorMessage);
  }

  const creator = Reflect.get(creators, key);
  if (typeof creator !== 'function') {
    throw new Error(errorMessage);
  }
  return creator;
}
