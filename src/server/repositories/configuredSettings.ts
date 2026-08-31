import 'server-only';

import type { AppSettings } from '@/server/settings';
import { getAppSettings } from '@/server/settings';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { withTenantSnapshot } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseSettingsQueries } from '@/server/repositories/database/settingsQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import type { SheetsReader } from '@/server/sheetsRepository';

export type SettingsReader = Readonly<{
  getAppSettings: () => Promise<AppSettings>;
}>;

type SettingsQueryFactory = (dependencies: {
  tenantId: string;
  runTenantTransaction: typeof withTenantSnapshot;
}) => SettingsReader;

type SettingsCreatorDependencies = Readonly<{
  createDatabaseSettingsQueries: SettingsQueryFactory;
  withTenantSnapshot: typeof withTenantSnapshot;
  createConfiguredSheetsStore: (request?: Request) => Promise<SheetsReader>;
  getAppSettings: (options: { settingsReader: SheetsReader }) => Promise<AppSettings>;
}>;

export type ConfiguredSettingsOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<SettingsReader, SettingsReader>;
}>;

export function createSettingsRepositoryCreators(
  dependencies: SettingsCreatorDependencies,
  request?: Request,
): RepositoryCreators<SettingsReader, SettingsReader> {
  return {
    createPostgresql(authority) {
      return dependencies.createDatabaseSettingsQueries({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantSnapshot,
      });
    },
    createSheets() {
      let readerPromise: Promise<SheetsReader> | undefined;
      const configuredReader = () => {
        readerPromise ??= dependencies.createConfiguredSheetsStore(request);
        return readerPromise;
      };
      return {
        async getAppSettings() {
          return dependencies.getAppSettings({ settingsReader: await configuredReader() });
        },
      };
    },
  };
}

function productionCreators(request?: Request) {
  return createSettingsRepositoryCreators({ createDatabaseSettingsQueries, withTenantSnapshot,
    createConfiguredSheetsStore, getAppSettings }, request);
}

export function createConfiguredSettingsReader(): Promise<SettingsReader>;
export function createConfiguredSettingsReader(request: Request): Promise<SettingsReader>;
export function createConfiguredSettingsReader(options: ConfiguredSettingsOptions): Promise<SettingsReader>;
export async function createConfiguredSettingsReader(
  requestOrOptions?: Request | ConfiguredSettingsOptions,
): Promise<SettingsReader> {
  const options = isConfiguredSettingsOptions(requestOrOptions) ? requestOrOptions : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isConfiguredSettingsOptions(value: Request | ConfiguredSettingsOptions | undefined):
  value is ConfiguredSettingsOptions {
  return Boolean(value && typeof value === 'object' && 'creators' in value);
}