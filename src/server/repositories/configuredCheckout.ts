import 'server-only';

import {
  createSheetsCheckoutCommand,
  type CheckoutCommand,
} from '@/server/checkoutService';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseCheckoutCommand } from '@/server/repositories/database/checkoutCommands';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import type { TabularStore } from '@/server/storage/tabularStore';

type CheckoutCommandCreatorDependencies = Readonly<{
  createDatabaseCheckoutCommand: typeof createDatabaseCheckoutCommand;
  withTenantTransaction: typeof withTenantTransaction;
  createConfiguredSheetsStore: (request?: Request) => Promise<TabularStore>;
  createSheetsCheckoutCommand: typeof createSheetsCheckoutCommand;
}>;

export type ConfiguredCheckoutOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<CheckoutCommand, CheckoutCommand>;
}>;

export function createCheckoutCommandRepositoryCreators(
  dependencies: CheckoutCommandCreatorDependencies,
  request?: Request,
): RepositoryCreators<CheckoutCommand, CheckoutCommand> {
  return {
    createPostgresql(authority) {
      return dependencies.createDatabaseCheckoutCommand({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
    },
    createSheets() {
      let commandPromise: Promise<CheckoutCommand> | undefined;
      const configuredCommand = () => {
        commandPromise ??= dependencies.createConfiguredSheetsStore(request)
          .then((store) => dependencies.createSheetsCheckoutCommand(store));
        return commandPromise;
      };
      return {
        async execute(input) {
          return (await configuredCommand()).execute(input);
        },
      };
    },
  };
}

function productionCreators(request?: Request): RepositoryCreators<CheckoutCommand, CheckoutCommand> {
  return createCheckoutCommandRepositoryCreators({
    createDatabaseCheckoutCommand,
    withTenantTransaction,
    createConfiguredSheetsStore,
    createSheetsCheckoutCommand,
  }, request);
}

export function createConfiguredCheckoutCommand(): Promise<CheckoutCommand>;
export function createConfiguredCheckoutCommand(request: Request): Promise<CheckoutCommand>;
export function createConfiguredCheckoutCommand(
  options: ConfiguredCheckoutOptions,
): Promise<CheckoutCommand>;
export async function createConfiguredCheckoutCommand(
  requestOrOptions?: Request | ConfiguredCheckoutOptions,
): Promise<CheckoutCommand> {
  const options = isConfiguredCheckoutOptions(requestOrOptions) ? requestOrOptions : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isConfiguredCheckoutOptions(
  value: Request | ConfiguredCheckoutOptions | undefined,
): value is ConfiguredCheckoutOptions {
  return Boolean(value && typeof value === 'object' && 'creators' in value);
}
