import 'server-only';

import type { ClassTask, TaskRecurrence } from '@/domain/types';
import { DEFAULT_CLASS_TIME_ZONE } from '@/domain/taskSchedule';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  createDatabaseTaskAdminCommands,
  createTaskAdminAssignmentEventId,
  createTaskAdminTaskInstanceId,
  type CreateTaskAdminInput,
  type TaskAdminCreateSuccess,
} from '@/server/repositories/database/taskAdminCommands';
import type { RepositoryCreators } from '@/server/repositories/factory';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { createTask, type SheetsStore, type TaskCreate } from '@/server/sheetsRepository';

type TaskCreationSchedule = CreateTaskAdminInput['schedule'];
export type ConfiguredTaskCreationInput = Omit<CreateTaskAdminInput, 'schedule'> & {
  schedule?: TaskCreationSchedule;
};

export type ConfiguredTaskCreationCommand = Readonly<{
  create(input: ConfiguredTaskCreationInput): Promise<ClassTask>;
}>;

type DatabaseTaskCreationCommand = Readonly<{
  create(input: CreateTaskAdminInput): Promise<TaskAdminCreateSuccess>;
}>;

type TaskCreationCreatorDependencies = Readonly<{
  createDatabaseTaskAdminCommands: (dependencies: {
    tenantId: string;
    runTenantTransaction: typeof withTenantTransaction;
  }) => DatabaseTaskCreationCommand;
  withTenantTransaction: typeof withTenantTransaction;
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

const DEFAULT_SCHEDULE: TaskCreationSchedule = Object.freeze({
  recurrence: Object.freeze({ type: 'NONE' as const }),
  timeZone: DEFAULT_CLASS_TIME_ZONE,
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
});

export function createTaskCreationRepositoryCreators(
  dependencies: TaskCreationCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredTaskCreationCommand, ConfiguredTaskCreationCommand> {
  return {
    createPostgresql(authority) {
      const commands = dependencies.createDatabaseTaskAdminCommands({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantTransaction,
      });
      return {
        async create(input) {
          const canonical = databaseInput(input);
          const raw: unknown = await commands.create(canonical);
          assertTaskCreationResult(raw, canonical);
          const evidence = raw.tasks[0];
          return projectLegacyTask(canonical, raw.completedAt, evidence.taskInstanceId);
        },
      };
    },
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

function databaseInput(input: ConfiguredTaskCreationInput): CreateTaskAdminInput {
  const schedule = input.schedule ?? DEFAULT_SCHEDULE;
  return {
    ...input,
    allowedStudentIds: [...input.allowedStudentIds],
    availableFrom: canonicalOptionalInstant(input.availableFrom, 'availableFrom'),
    dueAt: canonicalOptionalInstant(input.dueAt, 'dueAt'),
    prerequisiteTaskId: input.prerequisiteTaskId ?? null,
    padletBoardId: input.padletBoardId ?? null,
    schedule: {
      recurrence: cloneRecurrence(schedule.recurrence),
      timeZone: schedule.timeZone,
      resetCompletionOnCycle: schedule.resetCompletionOnCycle,
      resetAssignmentOnCycle: schedule.resetAssignmentOnCycle,
    },
  };
}

function canonicalOptionalInstant(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Task ${field} must be a valid instant.`);
  return parsed.toISOString();
}

function projectLegacyTask(
  input: CreateTaskAdminInput,
  completedAt: string,
  taskInstanceId: string,
): ClassTask {
  return {
    taskId: input.taskId,
    title: input.title,
    description: input.description,
    reward: input.reward,
    isActive: input.isActive,
    sortOrder: input.sortOrder,
    allowedStudentIds: [...input.allowedStudentIds],
    ...(input.availableFrom ? { availableFrom: input.availableFrom } : {}),
    ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    ...(input.prerequisiteTaskId ? { prerequisiteTaskId: input.prerequisiteTaskId } : {}),
    createdAt: completedAt,
    taskInstanceId,
    schedule: {
      ruleVersion: 1,
      effectiveFrom: completedAt,
      timeZone: input.schedule.timeZone,
      recurrence: cloneRecurrence(input.schedule.recurrence),
      resetCompletionOnCycle: input.schedule.resetCompletionOnCycle,
      resetAssignmentOnCycle: input.schedule.resetAssignmentOnCycle,
    },
    pendingSchedule: null,
  };
}

function cloneRecurrence(value: TaskRecurrence): TaskRecurrence {
  return value.type === 'WEEKLY' ? { ...value, weekdays: [...value.weekdays] } : { ...value };
}

function assertTaskCreationResult(
  value: unknown,
  input: CreateTaskAdminInput,
): asserts value is TaskAdminCreateSuccess {
  assertExactRecord(value, ['ok', 'operationId', 'action', 'completedAt', 'tasks']);
  if (value.ok !== true || value.operationId !== input.operationId || value.action !== 'CREATE'
    || !isCanonicalInstant(value.completedAt) || !isStrictArray(value.tasks, 1)) throw integrityError();
  const task = value.tasks[0];
  assertExactRecord(task, [
    'taskId', 'taskInstanceId', 'versionBefore', 'versionAfter', 'assignmentEventIds',
  ]);
  const expectedTaskInstanceId = createTaskAdminTaskInstanceId(input.operationId, input.taskId);
  const expectedEventIds = input.allowedStudentIds.map((studentId) =>
    createTaskAdminAssignmentEventId(input.operationId, input.taskId, studentId));
  if (task.taskId !== input.taskId || task.taskInstanceId !== expectedTaskInstanceId
    || task.versionBefore !== null || task.versionAfter !== 1
    || !isStrictArray(task.assignmentEventIds, expectedEventIds.length)
    || task.assignmentEventIds.some((id, index) => id !== expectedEventIds[index])) throw integrityError();
}

function assertExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw integrityError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw integrityError();
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw integrityError();
    }
  }
}

function isStrictArray(value: unknown, length: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0 || value.length !== length) return false;
  const keys = Reflect.ownKeys(value);
  const expected = [...Array.from({ length }, (_, index) => String(index)), 'length'];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) return false;
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && Object.hasOwn(descriptor, 'value')
      && (key === 'length' ? !descriptor.enumerable : descriptor.enumerable));
  });
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function integrityError(): Error {
  return new Error('Task creation result integrity check failed.');
}

function productionCreators(request?: Request) {
  return createTaskCreationRepositoryCreators({
    createDatabaseTaskAdminCommands,
    withTenantTransaction,
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
