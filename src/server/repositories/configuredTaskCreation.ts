import 'server-only';

import type { ClassTask, TaskRecurrence } from '@/domain/types';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { LegacyTaskWriterUnsupportedError } from '@/server/legacyTaskWriters';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { createTask, type SheetsStore, type TaskCreate } from '@/server/sheetsRepository';

export type ConfiguredTaskCreationInput = Readonly<{
  operationId: string;
  taskId: string;
  title: string;
  description: string;
  reward: number;
  isActive: boolean;
  sortOrder: number;
  allowedStudentIds: readonly string[];
  availableFrom?: string | null;
  dueAt?: string | null;
  prerequisiteTaskId?: string | null;
  schedule?: Readonly<{
    recurrence: TaskRecurrence;
    timeZone: 'Asia/Seoul';
    resetCompletionOnCycle: boolean;
    resetAssignmentOnCycle: boolean;
  }>;
}>;

export type ConfiguredTaskCreationCommand = Readonly<{
  create(input: ConfiguredTaskCreationInput): Promise<ClassTask>;
}>;

type TaskCreationCreatorDependencies = Readonly<{
  createConfiguredSheetsStore: (request?: Request) => Promise<SheetsStore>;
  createTask: (store: SheetsStore, input: TaskCreate) => Promise<ClassTask>;
}>;

export type ConfiguredTaskCreationOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredTaskCreationCommand, ConfiguredTaskCreationCommand>;
}>;

/** PostgreSQL classes create tasks in the stage ledger, never through this per-cycle writer. */
const unsupported: ConfiguredTaskCreationCommand = {
  async create() { throw new LegacyTaskWriterUnsupportedError(); },
};

export function createTaskCreationRepositoryCreators(
  dependencies: TaskCreationCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredTaskCreationCommand, ConfiguredTaskCreationCommand> {
  return {
    createPostgresql: () => unsupported,
    createSheets() {
      let storePromise: Promise<SheetsStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async create(input) {
          const legacyInput: TaskCreate = {
            taskId: input.taskId,
            title: input.title,
            description: input.description,
            reward: input.reward,
            isActive: input.isActive,
            sortOrder: input.sortOrder,
            allowedStudentIds: [...input.allowedStudentIds],
            availableFrom: input.availableFrom ?? undefined,
            dueAt: input.dueAt ?? undefined,
            prerequisiteTaskId: input.prerequisiteTaskId ?? undefined,
            ...(input.schedule ? { schedule: input.schedule } : {}),
          };
          return dependencies.createTask(await configuredStore(), legacyInput);
        },
      };
    },
  };
}

function productionCreators(request?: Request) {
  return createTaskCreationRepositoryCreators({
    createConfiguredSheetsStore,
    createTask,
  }, request);
}

export function createConfiguredTaskCreation(): Promise<ConfiguredTaskCreationCommand>;
export function createConfiguredTaskCreation(request: Request): Promise<ConfiguredTaskCreationCommand>;
export function createConfiguredTaskCreation(
  options: ConfiguredTaskCreationOptions,
): Promise<ConfiguredTaskCreationCommand>;
export async function createConfiguredTaskCreation(
  requestOrOptions?: Request | ConfiguredTaskCreationOptions,
): Promise<ConfiguredTaskCreationCommand> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredTaskCreationOptions(requestOrOptions)
    ? requestOrOptions : undefined;
  if (requestOrOptions !== undefined && !request && !options) {
    throw new Error('Invalid configured task creation options.');
  }
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function isConfiguredTaskCreationOptions(
  value: Request | ConfiguredTaskCreationOptions | undefined,
): value is ConfiguredTaskCreationOptions {
  return Boolean(value && typeof value === 'object'
    && Object.hasOwn(value, 'env')
    && Object.hasOwn(value, 'getCentralTenantContext')
    && Object.hasOwn(value, 'creators')
    && typeof (value as ConfiguredTaskCreationOptions).getCentralTenantContext === 'function'
    && typeof (value as ConfiguredTaskCreationOptions).creators === 'object'
    && (value as ConfiguredTaskCreationOptions).creators !== null
    && hasCreator((value as ConfiguredTaskCreationOptions).creators, 'createPostgresql')
    && hasCreator((value as ConfiguredTaskCreationOptions).creators, 'createSheets'));
}

function hasCreator(value: object, key: 'createPostgresql' | 'createSheets'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor
    && (typeof descriptor.value === 'function' || typeof descriptor.get === 'function'));
}
