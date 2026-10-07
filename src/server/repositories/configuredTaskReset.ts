import 'server-only';

import { createConfiguredSheetsStore } from '@/server/repositories/sheets/lazy';
import { LegacyTaskWriterUnsupportedError } from '@/server/legacyTaskWriters';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { resetTaskCompletionsBatch } from '@/server/repositories/sheets/lazy';

export type TaskResetCommandInput = Readonly<{
  operationId: string;
  taskIds: readonly string[];
}>;

export type TaskResetResult = Readonly<{
  taskIds: readonly string[];
  resetEventsAppended: number;
  deletedCount: number;
}>;

export type TaskResetCommand = Readonly<{
  resetBatch(input: TaskResetCommandInput): Promise<TaskResetResult>;
}>;

type TaskResetCommandCreatorDependencies = Readonly<{
  createConfiguredSheetsStore: typeof createConfiguredSheetsStore;
  resetTaskCompletionsBatch: typeof resetTaskCompletionsBatch;
}>;

export type ConfiguredTaskResetOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<TaskResetCommand, TaskResetCommand>;
}>;

/** PostgreSQL classes reset stages in the task ledger, never through this per-cycle writer. */
const unsupported: TaskResetCommand = {
  async resetBatch() { throw new LegacyTaskWriterUnsupportedError(); },
};

export function createTaskResetCommandRepositoryCreators(
  dependencies: TaskResetCommandCreatorDependencies,
  request?: Request,
): RepositoryCreators<TaskResetCommand, TaskResetCommand> {
  return {
    createPostgresql: () => unsupported,
    createSheets() {
      let storePromise: ReturnType<typeof createConfiguredSheetsStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async resetBatch(input) {
          return dependencies.resetTaskCompletionsBatch(await configuredStore(), [...input.taskIds], {
            operationId: input.operationId.trim(),
          });
        },
      };
    },
  };
}

function productionCreators(request?: Request): RepositoryCreators<TaskResetCommand, TaskResetCommand> {
  return createTaskResetCommandRepositoryCreators({
    createConfiguredSheetsStore,
    resetTaskCompletionsBatch,
  }, request);
}

export function createConfiguredTaskResetCommand(): Promise<TaskResetCommand>;
export function createConfiguredTaskResetCommand(request: Request): Promise<TaskResetCommand>;
export function createConfiguredTaskResetCommand(
  options: ConfiguredTaskResetOptions,
): Promise<TaskResetCommand>;
export async function createConfiguredTaskResetCommand(
  requestOrOptions?: Request | ConfiguredTaskResetOptions,
): Promise<TaskResetCommand> {
  const options = isConfiguredTaskResetOptions(requestOrOptions) ? requestOrOptions : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isConfiguredTaskResetOptions(
  value: Request | ConfiguredTaskResetOptions | undefined,
): value is ConfiguredTaskResetOptions {
  return Boolean(value && typeof value === 'object' && 'creators' in value);
}
