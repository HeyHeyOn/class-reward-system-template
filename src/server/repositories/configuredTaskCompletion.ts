import 'server-only';

import { createHash } from 'node:crypto';
import type { DayOfMonth, IsoWeekday, TaskCompletionEvidence } from '@/domain/types';
import { withTenantSnapshot, withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { fetchPadletBoardPosts, isCanonicalPadletPostId } from '@/server/padletClient';
import { createPadletCompletionEvidenceResolver } from '@/server/padletCompletionEvidenceResolver';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import { createDatabasePadletClaimRepository,
  type DatabasePadletClaimRepository } from '@/server/repositories/database/padletClaims';
import { createDatabaseTaskCompletionCommand,
  type PadletEvidenceResolutionInput } from '@/server/repositories/database/taskCompletionCommands';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import { createDatabaseTaskQueries } from '@/server/repositories/database/taskQueries';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { getCompatibilityCentralTenantContext, resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv } from '@/server/repositories/configuredRepository';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import { buildStudentTaskProjection,
  type StudentTaskProjectionDto } from '@/server/studentTaskProjection';
import { completeTaskForStudent } from '@/server/sheetsRepository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ConfiguredTaskCompletionInput = Readonly<{
  requestId: string;
  operationId: string;
  taskId: string;
  studentId: string;
}>;

export type ConfiguredTaskCompletionResult = Readonly<{
  task: Readonly<{ taskId: string; title: string; reward: number }>;
  student: Readonly<{ studentId: string; name: string }>;
  tasks: StudentTaskProjectionDto[];
  operation: Readonly<{ operationId: string; state: 'SUCCESS' }>;
}>;

export type ConfiguredTaskCompletionCommand = Readonly<{
  execute(input: ConfiguredTaskCompletionInput): Promise<ConfiguredTaskCompletionResult>;
}>;

type SnapshotRunner = typeof withTenantSnapshot;
type TransactionRunner = typeof withTenantTransaction;
type LegacyTaskCompletionStore = Parameters<typeof completeTaskForStudent>[0];
type UnknownCommand = Readonly<{ execute(input: {
  operationId: string; taskId: string; studentId: string;
}): Promise<unknown> }>;
type TaskCycleReader = Readonly<{ listTaskCycleProjections(options: {
  studentId?: string; includeInactive?: boolean; now?: string;
}): Promise<unknown> }>;

type TaskCompletionCreatorDependencies = Readonly<{
  createDatabasePadletClaimRepository: () => DatabasePadletClaimRepository;
  createDatabaseTaskCompletionCommand: (dependencies: {
    tenantId: string;
    runTenantTransaction: TransactionRunner;
    padletClaims: DatabasePadletClaimRepository;
    resolvePadletEvidence: (input: PadletEvidenceResolutionInput) => Promise<TaskCompletionEvidence>;
  }) => UnknownCommand;
  createDatabaseTaskQueries: (dependencies: {
    tenantId: string; runTenantTransaction: SnapshotRunner;
  }) => unknown;
  createDatabaseTaskCycleQueries: (dependencies: {
    tenantId: string; runTenantSnapshot: SnapshotRunner; taskQueries: unknown;
  }) => TaskCycleReader;
  createPadletCompletionEvidenceResolver: (dependencies: {
    fetchPosts: (boardId: string) => Promise<unknown[]>;
    findClaimedPostIds: (boardId: string, postIds: string[]) => Promise<string[]>;
  }) => (input: PadletEvidenceResolutionInput) => Promise<TaskCompletionEvidence>;
  fetchPadletBoardPosts: (input: { boardId: string }) => Promise<unknown[]>;
  withTenantTransaction: TransactionRunner;
  withTenantSnapshot: SnapshotRunner;
  createConfiguredSheetsStore: (request?: Request) => Promise<LegacyTaskCompletionStore>;
  completeTaskForStudent: typeof completeTaskForStudent;
  sheetsListTaskCycleProjections: typeof listTaskCycleProjections;
  buildStudentTaskProjection: typeof buildStudentTaskProjection;
}>;

export type ConfiguredTaskCompletionOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredTaskCompletionCommand, ConfiguredTaskCompletionCommand>;
}>;

export function createTaskCompletionRepositoryCreators(
  dependencies: TaskCompletionCreatorDependencies,
  request?: Request,
): RepositoryCreators<ConfiguredTaskCompletionCommand, ConfiguredTaskCompletionCommand> {
  return {
    createPostgresql(authority) {
      let initialized: {
        command: UnknownCommand;
        cycles: TaskCycleReader;
      } | undefined;
      const initialize = () => {
        if (initialized) return initialized;
        const claims = dependencies.createDatabasePadletClaimRepository();
        const resolver = dependencies.createPadletCompletionEvidenceResolver({
          fetchPosts: (boardId) => dependencies.fetchPadletBoardPosts({ boardId }),
          findClaimedPostIds: async (boardId, postIds) => [
            ...await dependencies.withTenantSnapshot(authority.tenantId,
              (transaction) => claims.findClaimedPostIds(transaction, boardId, postIds)),
          ],
        });
        const taskQueries = dependencies.createDatabaseTaskQueries({
          tenantId: authority.tenantId,
          runTenantTransaction: dependencies.withTenantSnapshot,
        });
        const cycles = dependencies.createDatabaseTaskCycleQueries({
          tenantId: authority.tenantId,
          runTenantSnapshot: dependencies.withTenantSnapshot,
          taskQueries,
        });
        const command = dependencies.createDatabaseTaskCompletionCommand({
          tenantId: authority.tenantId,
          runTenantTransaction: dependencies.withTenantTransaction,
          padletClaims: claims,
          resolvePadletEvidence: resolver,
        });
        initialized = { command, cycles };
        return initialized;
      };
      return {
        async execute(rawInput) {
          const input = parseInput(rawInput);
          const { command, cycles } = initialize();
          const raw = await command.execute({
            operationId: input.operationId,
            taskId: input.taskId,
            studentId: input.studentId,
          });
          const result = parseDatabaseResult(raw, input);
          const rawProjections = await cycles.listTaskCycleProjections({
            studentId: input.studentId,
            includeInactive: false,
            now: result.completedAt,
          });
          if (!isStrictArray(rawProjections)) throw integrityError();
          const projected: unknown = dependencies.buildStudentTaskProjection(
            rawProjections as never,
            input.studentId,
            result.completedAt,
          );
          const tasks = parseSafeTasks(projected, input);
          return safeResult(result.taskTitle, result.reward, result.studentName, tasks, input);
        },
      };
    },
    createSheets() {
      let storePromise: Promise<LegacyTaskCompletionStore> | undefined;
      const configuredStore = () => {
        storePromise ??= dependencies.createConfiguredSheetsStore(request);
        return storePromise;
      };
      return {
        async execute(rawInput) {
          const input = parseInput(rawInput);
          const store = await configuredStore();
          const raw: unknown = await dependencies.completeTaskForStudent(
            store,
            input.taskId,
            input.studentId,
            {
              requestId: input.requestId,
              operationId: input.operationId,
              operationPayloadHash: legacyPayloadHash(input.taskId, input.studentId),
              buildSafeProjection: async (now) => dependencies.buildStudentTaskProjection(
                await dependencies.sheetsListTaskCycleProjections(store, {
                  studentId: input.studentId,
                  includeInactive: false,
                  now,
                }),
                input.studentId,
                now,
              ),
            },
          );
          return parseSheetsResult(raw, input);
        },
      };
    },
  };
}

function parseInput(value: unknown): ConfiguredTaskCompletionInput {
  assertExactRecord(value, ['requestId', 'operationId', 'taskId', 'studentId'], inputError);
  const requestId = dataValue(value, 'requestId');
  const operationId = dataValue(value, 'operationId');
  const taskId = dataValue(value, 'taskId');
  const studentId = dataValue(value, 'studentId');
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('A nonblank request ID is required.');
  if (typeof operationId !== 'string' || !UUID.test(operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  if (!isCanonicalId(taskId)) throw new Error('A canonical task ID is required.');
  if (!isCanonicalId(studentId)) throw new Error('A canonical student ID is required.');
  return { requestId, operationId, taskId, studentId };
}

function parseSheetsResult(
  value: unknown,
  input: ConfiguredTaskCompletionInput,
): ConfiguredTaskCompletionResult {
  assertExactRecord(value, ['task', 'student', 'completion', 'tasks', 'operation']);
  const task = dataValue(value, 'task');
  const student = dataValue(value, 'student');
  const operation = dataValue(value, 'operation');
  assertRecordWithDataFields(task, ['taskId', 'title', 'reward']);
  assertRecordWithDataFields(student, ['studentId', 'name']);
  assertExactRecord(operation, ['operationId', 'state']);
  const taskId = dataValue(task, 'taskId');
  const title = dataValue(task, 'title');
  const reward = dataValue(task, 'reward');
  const studentId = dataValue(student, 'studentId');
  const name = dataValue(student, 'name');
  if (taskId !== input.taskId || studentId !== input.studentId
    || dataValue(operation, 'operationId') !== input.operationId
    || dataValue(operation, 'state') !== 'SUCCESS'
    || !isCanonicalText(title) || !isNonnegativeSafeInteger(reward)
    || !isCanonicalText(name)) throw integrityError();
  const tasks = parseSafeTasks(dataValue(value, 'tasks'), input);
  return safeResult(title, reward, name, tasks, input);
}

export function parseConfiguredTaskCompletionResult(
  value: unknown,
  expected: Readonly<{ operationId: string; taskId: string; studentId: string }>,
): ConfiguredTaskCompletionResult {
  assertExactRecord(value, ['task', 'student', 'tasks', 'operation']);
  const task = dataValue(value, 'task');
  const student = dataValue(value, 'student');
  const operation = dataValue(value, 'operation');
  assertExactRecord(task, ['taskId', 'title', 'reward']);
  assertExactRecord(student, ['studentId', 'name']);
  assertExactRecord(operation, ['operationId', 'state']);
  const title = dataValue(task, 'title');
  const reward = dataValue(task, 'reward');
  const name = dataValue(student, 'name');
  if (dataValue(task, 'taskId') !== expected.taskId
    || dataValue(student, 'studentId') !== expected.studentId
    || dataValue(operation, 'operationId') !== expected.operationId
    || dataValue(operation, 'state') !== 'SUCCESS'
    || !isCanonicalText(title) || !isNonnegativeSafeInteger(reward)
    || !isCanonicalText(name)) throw integrityError();
  const tasks = parseSafeTasks(dataValue(value, 'tasks'), expected);
  return safeResult(title, reward, name, tasks, expected);
}

type ParsedDatabaseResult = Readonly<{
  completedAt: string;
  taskTitle: string;
  studentName: string;
  reward: number;
}>;

function parseDatabaseResult(value: unknown, input: ConfiguredTaskCompletionInput): ParsedDatabaseResult {
  const hasEvidence = hasOwnDataProperty(value, 'evidence');
  const keys = ['ok', 'operationId', 'completedAt', 'taskId', 'taskInstanceId', 'taskTitle',
    'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'cycleId',
    'transactionId', 'completionId', ...(hasEvidence ? ['evidence'] : [])];
  assertExactRecord(value, keys);
  const get = (key: string) => dataValue(value, key);
  const completedAt = get('completedAt');
  const reward = get('reward');
  const before = get('balanceBefore');
  const after = get('balanceAfter');
  if (get('ok') !== true || get('operationId') !== input.operationId
    || get('taskId') !== input.taskId || get('studentId') !== input.studentId
    || !isCanonicalInstant(completedAt)
    || !isCanonicalText(get('taskInstanceId')) || !isCanonicalText(get('cycleId'))
    || !isCanonicalText(get('taskTitle')) || !isCanonicalText(get('studentName'))
    || !isNonnegativeSafeInteger(reward) || !Number.isSafeInteger(before)
    || !Number.isSafeInteger(after) || safeSum(before, reward) !== after
    || get('transactionId') !== `task-reward:${input.operationId}`
    || get('completionId') !== `task-completion:${input.operationId}`) throw integrityError();
  if (hasEvidence) parseEvidence(get('evidence'), get('studentName'), completedAt);
  return {
    completedAt,
    taskTitle: get('taskTitle') as string,
    studentName: get('studentName') as string,
    reward,
  };
}

function parseEvidence(value: unknown, studentName: unknown, completedAt: string): void {
  assertExactRecord(value, ['evidenceProvider', 'evidenceBoardId', 'evidencePostId',
    'evidenceCreatedAt', 'evidenceAuthorFullName']);
  const provider = dataValue(value, 'evidenceProvider');
  const boardId = dataValue(value, 'evidenceBoardId');
  const postId = dataValue(value, 'evidencePostId');
  const createdAt = dataValue(value, 'evidenceCreatedAt');
  const author = dataValue(value, 'evidenceAuthorFullName');
  if (provider !== 'PADLET' || typeof boardId !== 'string' || !/^[A-Za-z0-9]{16,22}$/.test(boardId)
    || !isCanonicalPadletPostId(postId) || !isCanonicalInstant(createdAt)
    || createdAt > completedAt || author !== studentName || !isCanonicalText(author)) throw integrityError();
}

function parseSafeTasks(
  value: unknown,
  input: Readonly<{ taskId: string; studentId: string }>,
): StudentTaskProjectionDto[] {
  if (!isStrictArray(value)) throw integrityError();
  const tasks = value.map(parseSafeTask);
  const targets = tasks.filter((task) => task.taskId === input.taskId);
  if (tasks.some((task) => task.studentStatus.studentId !== input.studentId)
    || targets.length !== 1 || targets[0].studentStatus.studentId !== input.studentId
    || targets[0].studentStatus.completed !== true) throw integrityError();
  return tasks;
}

function parseSafeTask(value: unknown): StudentTaskProjectionDto {
  const required = ['taskId', 'title', 'description', 'reward', 'sortOrder', 'studentStatus'];
  const optional = ['availableFrom', 'dueAt', 'recurrence', 'prerequisiteTaskId',
    'prerequisiteTitle', 'prerequisiteStatus', 'prerequisiteMessage'];
  assertAllowedRecord(value, required, optional);
  const taskId = dataValue(value, 'taskId');
  const title = dataValue(value, 'title');
  const description = dataValue(value, 'description');
  const reward = dataValue(value, 'reward');
  const sortOrder = dataValue(value, 'sortOrder');
  const status = dataValue(value, 'studentStatus');
  assertAllowedRecord(status, ['studentId', 'assigned'], ['completed']);
  if (!isCanonicalId(taskId) || !isCanonicalText(title) || typeof description !== 'string'
    || !isNonnegativeSafeInteger(reward) || !Number.isSafeInteger(sortOrder)
    || !isCanonicalId(dataValue(status, 'studentId'))
    || typeof dataValue(status, 'assigned') !== 'boolean'
    || (hasOwnDataProperty(status, 'completed') && typeof dataValue(status, 'completed') !== 'boolean')) {
    throw integrityError();
  }
  for (const key of ['availableFrom', 'dueAt'] as const) {
    if (hasOwnDataProperty(value, key) && !isCanonicalInstant(dataValue(value, key))) throw integrityError();
  }
  for (const key of ['prerequisiteTaskId', 'prerequisiteTitle', 'prerequisiteMessage'] as const) {
    if (hasOwnDataProperty(value, key) && !isCanonicalText(dataValue(value, key))) throw integrityError();
  }
  if (hasOwnDataProperty(value, 'prerequisiteStatus')
    && !['UNAVAILABLE', 'SATISFIED', 'REQUIRED'].includes(dataValue(value, 'prerequisiteStatus') as string)) {
    throw integrityError();
  }
  const recurrence = hasOwnDataProperty(value, 'recurrence')
    ? parseRecurrence(dataValue(value, 'recurrence'))
    : undefined;
  return {
    taskId,
    title,
    description,
    reward,
    sortOrder: sortOrder as number,
    ...(hasOwnDataProperty(value, 'availableFrom')
      ? { availableFrom: dataValue(value, 'availableFrom') as string } : {}),
    ...(hasOwnDataProperty(value, 'dueAt')
      ? { dueAt: dataValue(value, 'dueAt') as string } : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(hasOwnDataProperty(value, 'prerequisiteTaskId')
      ? { prerequisiteTaskId: dataValue(value, 'prerequisiteTaskId') as string } : {}),
    ...(hasOwnDataProperty(value, 'prerequisiteTitle')
      ? { prerequisiteTitle: dataValue(value, 'prerequisiteTitle') as string } : {}),
    ...(hasOwnDataProperty(value, 'prerequisiteStatus')
      ? { prerequisiteStatus: dataValue(value, 'prerequisiteStatus') as
        StudentTaskProjectionDto['prerequisiteStatus'] } : {}),
    ...(hasOwnDataProperty(value, 'prerequisiteMessage')
      ? { prerequisiteMessage: dataValue(value, 'prerequisiteMessage') as string } : {}),
    studentStatus: {
      studentId: dataValue(status, 'studentId') as string,
      assigned: dataValue(status, 'assigned') as boolean,
      ...(hasOwnDataProperty(status, 'completed')
        ? { completed: dataValue(status, 'completed') as boolean } : {}),
    },
  };
}

function parseRecurrence(value: unknown): NonNullable<StudentTaskProjectionDto['recurrence']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw integrityError();
  const record = value as Record<string, unknown>;
  const type = hasOwnDataProperty(record, 'type') ? dataValue(record, 'type') : undefined;
  if (type === 'NONE') {
    assertExactRecord(value, ['type']);
    return { type: 'NONE' };
  }
  if (type === 'DAILY') {
    assertExactRecord(value, ['type', 'time']);
    const time = dataValue(value, 'time');
    if (!isTaskTime(time)) throw integrityError();
    return { type: 'DAILY', time };
  }
  if (type === 'WEEKLY') {
    assertExactRecord(value, ['type', 'weekdays', 'time']);
    const weekdays = dataValue(value, 'weekdays');
    if (!isStrictArray(weekdays) || weekdays.length === 0
      || weekdays.some((day) => typeof day !== 'number'
        || !Number.isInteger(day) || day < 1 || day > 7)
      || new Set(weekdays).size !== weekdays.length) {
      throw integrityError();
    }
    const time = dataValue(value, 'time');
    if (!isTaskTime(time)) throw integrityError();
    return { type: 'WEEKLY', weekdays: [...weekdays] as IsoWeekday[], time };
  }
  if (type === 'MONTHLY') {
    assertExactRecord(value, ['type', 'dayOfMonth', 'time']);
    const dayOfMonth = dataValue(value, 'dayOfMonth');
    const time = dataValue(value, 'time');
    if (typeof dayOfMonth !== 'number' || !Number.isInteger(dayOfMonth)
      || dayOfMonth < 1 || dayOfMonth > 31 || !isTaskTime(time)) {
      throw integrityError();
    }
    return { type: 'MONTHLY', dayOfMonth: dayOfMonth as DayOfMonth, time };
  }
  throw integrityError();
}

function isTaskTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function safeResult(
  title: string,
  reward: number,
  name: string,
  tasks: StudentTaskProjectionDto[],
  input: Readonly<{ operationId: string; taskId: string; studentId: string }>,
): ConfiguredTaskCompletionResult {
  return {
    task: { taskId: input.taskId, title, reward },
    student: { studentId: input.studentId, name },
    tasks,
    operation: { operationId: input.operationId, state: 'SUCCESS' },
  };
}

function legacyPayloadHash(taskId: string, studentId: string): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ taskId, studentId }), 'utf8').digest('hex')}`;
}

function assertExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorFactory: () => Error = integrityError,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw errorFactory();
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw errorFactory();
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw errorFactory();
  }
}

function assertAllowedRecord(value: unknown, required: readonly string[], optional: readonly string[]):
  asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw integrityError();
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) throw integrityError();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw integrityError();
  }
}

function assertRecordWithDataFields(value: unknown, fields: readonly string[]):
  asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw integrityError();
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw integrityError();
  }
}

function dataValue(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function hasOwnDataProperty(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && Object.hasOwn(descriptor, 'value'));
}

function isStrictArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Reflect.ownKeys(value);
  const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length'];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) return false;
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && Object.hasOwn(descriptor, 'value')
      && (key === 'length' ? !descriptor.enumerable : descriptor.enumerable));
  });
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeSum(left: unknown, right: unknown): number | undefined {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return undefined;
  const result = BigInt(left as number) + BigInt(right as number);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) && result >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(result) : undefined;
}

function integrityError(): Error {
  return new Error('Configured task completion integrity check failed.');
}

function inputError(): Error {
  return new Error('Invalid configured task completion input.');
}

function productionCreators(request?: Request) {
  return createTaskCompletionRepositoryCreators({
    createDatabasePadletClaimRepository,
    createDatabaseTaskCompletionCommand,
    createDatabaseTaskQueries,
    createDatabaseTaskCycleQueries: createDatabaseTaskCycleQueries as never,
    createPadletCompletionEvidenceResolver: createPadletCompletionEvidenceResolver as never,
    fetchPadletBoardPosts,
    withTenantTransaction,
    withTenantSnapshot,
    createConfiguredSheetsStore,
    completeTaskForStudent,
    sheetsListTaskCycleProjections: listTaskCycleProjections,
    buildStudentTaskProjection,
  }, request);
}

export function createConfiguredTaskCompletion(): Promise<ConfiguredTaskCompletionCommand>;
export function createConfiguredTaskCompletion(request: Request): Promise<ConfiguredTaskCompletionCommand>;
export function createConfiguredTaskCompletion(
  options: ConfiguredTaskCompletionOptions,
): Promise<ConfiguredTaskCompletionCommand>;
export async function createConfiguredTaskCompletion(
  requestOrOptions?: Request | ConfiguredTaskCompletionOptions,
): Promise<ConfiguredTaskCompletionCommand> {
  const request = isRequest(requestOrOptions) ? requestOrOptions : undefined;
  const options = request ? undefined : isConfiguredOptions(requestOrOptions) ? requestOrOptions : undefined;
  if (requestOrOptions !== undefined && !request && !options) {
    throw new Error('Invalid configured task completion options.');
  }
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request;
}

function isConfiguredOptions(
  value: Request | ConfiguredTaskCompletionOptions | undefined,
): value is ConfiguredTaskCompletionOptions {
  const optionValues = exactEnumerableDataValues(
    value,
    ['env', 'getCentralTenantContext', 'creators'],
  );
  if (!optionValues || !isSafeEnv(optionValues.env)
    || typeof optionValues.getCentralTenantContext !== 'function') return false;
  return hasExactSafeCreators(optionValues.creators);
}

function hasExactSafeCreators(value: unknown): value is ConfiguredTaskCompletionOptions['creators'] {
  const expectedKeys = ['createPostgresql', 'createSheets'] as const;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key as typeof expectedKeys[number]))) {
    return false;
  }
  return expectedKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && descriptor.enumerable
      && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function');
  });
}

function exactEnumerableDataValues(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function isSafeEnv(value: unknown): value is CompatibilityCentralTenantEnv {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || (typeof descriptor.value !== 'string' && descriptor.value !== undefined)) return false;
  }
  return true;
}
