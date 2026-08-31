import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { prepareTaskScheduleEdit, resolveTaskSchedule, validateTaskSchedule } from '@/domain/taskSchedule';
import type { DayOfMonth, IsoWeekday, TaskRecurrence, TaskSchedule } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit, operationAuditEventId } from './operationAudit';
import { materializeTaskConfigurationBoundaryCycleInternal } from './taskCycleMaterialization';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const UPDATE_KEYS = ['operationId', 'taskId', 'expectedTaskVersion', 'recurrence', 'timeZone',
  'resetCompletionOnCycle', 'resetAssignmentOnCycle'] as const;
const BATCH_KEYS = ['operationId', 'tasks'] as const;
const TASK_INPUT_KEYS = ['taskId', 'expectedTaskVersion', 'recurrence', 'timeZone',
  'resetCompletionOnCycle', 'resetAssignmentOnCycle'] as const;
const OPERATION_KEYS = ['operation_id', 'operation_kind', 'payload_hash', 'status', 'result_snapshot',
  'finished_at', 'failure_code', 'attempt_count', 'started_at', 'created_at', 'updated_at'] as const;

type RunTenantTransaction = <T>(tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<T>) => Promise<T>;

export type DatabaseTaskScheduleTaskInput = Readonly<{
  taskId: string;
  expectedTaskVersion: number;
  recurrence: TaskRecurrence;
  timeZone: 'Asia/Seoul';
  resetCompletionOnCycle: boolean;
  resetAssignmentOnCycle: boolean;
}>;
export type DatabaseTaskScheduleUpdateInput = Readonly<{
  operationId: string;
}> & DatabaseTaskScheduleTaskInput;
export type DatabaseTaskScheduleBatchUpdateInput = Readonly<{
  operationId: string;
  tasks: readonly DatabaseTaskScheduleTaskInput[];
}>;
export type DatabaseTaskScheduleTaskResult = Readonly<{
  taskId: string;
  taskInstanceId: string;
  changed: boolean;
  versionBefore: number;
  versionAfter: number;
  schedule: TaskSchedule;
  assignmentEventIds: readonly string[];
  completionEventIds: readonly string[];
}>;
export type DatabaseTaskScheduleBatchUpdateSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'SCHEDULE_UPDATE';
  completedAt: string;
  tasks: readonly DatabaseTaskScheduleTaskResult[];
}>;
export type DatabaseTaskScheduleUpdateSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'SCHEDULE_UPDATE';
  completedAt: string;
} & DatabaseTaskScheduleTaskResult>;
export type DatabaseTaskScheduleCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

type CanonicalTaskInput = DatabaseTaskScheduleTaskInput;
type CanonicalInput = Readonly<{ operationId: string; tasks: readonly CanonicalTaskInput[] }>;
type Operation = Readonly<{ operation_id: string; operation_kind: string; payload_hash: string;
  status: string; result_snapshot: unknown; finished_at: Date | null; failure_code: string | null;
  attempt_count: string; started_at: Date; created_at: Date; updated_at: Date }>;
type Task = Readonly<{ taskInstanceId: string; taskId: string; currentSchedule: TaskSchedule;
  pendingSchedule: TaskSchedule | null; version: number; createdAt: Date; updatedAt: Date }>;

export function createTaskScheduleUpdatePayloadHash(
  raw: DatabaseTaskScheduleUpdateInput | DatabaseTaskScheduleBatchUpdateInput,
): string {
  const input = 'tasks' in raw ? canonicalBatchInput(raw) : canonicalUpdateInput(raw);
  return payloadHash(input);
}

export function createDatabaseTaskScheduleCommands(dependencies: DatabaseTaskScheduleCommandDependencies) {
  const run = async (input: CanonicalInput): Promise<DatabaseTaskScheduleBatchUpdateSuccess> => {
    const now = dependencies.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Task schedule current timestamp is invalid.');
    }
    const hash = payloadHash(input);
    return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
      const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (existing) return replay(tx, dependencies.tenantId, existing, input, hash);
      const claim = await tx.execute(sql`INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
        VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${hash},
          'PENDING', 1, ${now}, ${now}, ${now})
        ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id`);
      if (claim.rows.length === 0) {
        const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!winner) throw new Error('Task schedule operation claim integrity check failed.');
        return replay(tx, dependencies.tenantId, winner, input, hash);
      }
      assertReturning(claim.rows, ['operation_id'], { operation_id: input.operationId }, 'operation claim');

      const ids = input.tasks.map((task) => task.taskId);
      const taskRows = await tx.execute(sql`SELECT task_instance_id, task_id, current_schedule,
        pending_schedule, version::text AS version, created_at, updated_at FROM tasks
        WHERE tenant_id=${dependencies.tenantId} AND deleted_at IS NULL
          AND task_id IN (${sql.join(ids.map((value) => sql`${value}`), sql`, `)})
        ORDER BY task_instance_id FOR UPDATE`);
      if (taskRows.rows.length !== input.tasks.length) throw new Error('Task schedule target not found.');
      const byId = new Map<string, Task>();
      for (const rawTask of taskRows.rows) {
        const task = parseTask(rawTask);
        if (!ids.includes(task.taskId) || byId.has(task.taskId)) {
          throw new Error('Task schedule target task integrity check failed.');
        }
        byId.set(task.taskId, task);
      }
      if (input.tasks.some((task) => !byId.has(task.taskId))) throw new Error('Task schedule target not found.');
      for (const requested of input.tasks) {
        if (byId.get(requested.taskId)!.version !== requested.expectedTaskVersion) {
          throw new Error('Task schedule stale task version.');
        }
      }

      const results: DatabaseTaskScheduleTaskResult[] = [];
      for (const requested of input.tasks) {
        const task = byId.get(requested.taskId)!;
        const current = resolveTaskSchedule({ currentSchedule: task.currentSchedule,
          pendingSchedule: task.pendingSchedule, now: now.toISOString() });
        if (current.timeZone !== 'Asia/Seoul') throw new Error('Task schedule timezone integrity check failed.');
        const changed = !sameConfiguration(current, requested);
        let schedule = current;
        let assignmentEventIds: readonly string[] = Object.freeze([] as string[]);
        let completionEventIds: readonly string[] = Object.freeze([] as string[]);
        if (changed) {
          schedule = prepareTaskScheduleEdit({ currentSchedule: current, recurrence: requested.recurrence,
            timeZone: requested.timeZone, resetCompletionOnCycle: requested.resetCompletionOnCycle,
            resetAssignmentOnCycle: requested.resetAssignmentOnCycle, editedAt: now.toISOString() });
          if (schedule.ruleVersion === current.ruleVersion) {
            schedule = validateTaskSchedule({ ...schedule, ruleVersion: current.ruleVersion + 1,
              effectiveFrom: now.toISOString() });
          }
          const oldCycle = getTaskCycle({ taskInstanceId: task.taskInstanceId, schedule: current,
            taskCreatedAt: task.createdAt.toISOString(), now: now.toISOString() });
          const newCycle = getTaskCycle({ taskInstanceId: task.taskInstanceId, schedule,
            taskCreatedAt: task.createdAt.toISOString(), now: now.toISOString() });
          const updated = await tx.execute(sql`UPDATE tasks SET current_schedule=${JSON.stringify(schedule)}::jsonb,
            pending_schedule=NULL, schedule_schema_version=1, version=version+1, updated_at=${now}
            WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${task.taskInstanceId}
              AND deleted_at IS NULL AND version=${requested.expectedTaskVersion}
            RETURNING task_instance_id, task_id, current_schedule, pending_schedule,
              schedule_schema_version, version::text AS version, created_at, updated_at`);
          assertUpdatedTask(updated.rows, task, schedule, now);
          const materialized = await materializeTaskConfigurationBoundaryCycleInternal({ tx,
            tenantId: dependencies.tenantId, taskId: task.taskId, taskInstanceId: task.taskInstanceId,
            oldCycle, oldRuleVersion: current.ruleVersion, newCycle,
            newRuleVersion: schedule.ruleVersion, timeZone: 'Asia/Seoul', now });
          assignmentEventIds = materialized.assignmentEventIds;
          completionEventIds = materialized.completionEventIds;
        }
        results.push(freezeTaskResult({ taskId: task.taskId, taskInstanceId: task.taskInstanceId,
          changed, versionBefore: task.version, versionAfter: task.version + (changed ? 1 : 0), schedule,
          assignmentEventIds, completionEventIds }));
      }
      const result = freezeBatchResult({ ok: true, operationId: input.operationId,
        action: 'SCHEDULE_UPDATE', completedAt: now.toISOString(), tasks: results });
      await verifyTasks(tx, dependencies.tenantId, result);
      const audit = auditInput(result, now);
      await appendOperationAudit(tx, dependencies.tenantId, audit);
      await assertOperationAudit(tx, dependencies.tenantId, audit);
      await assertOneAudit(tx, dependencies.tenantId, input.operationId);
      const terminal = await tx.execute(sql`UPDATE operations SET status='SUCCEEDED',
        result_snapshot=${JSON.stringify(result)}::jsonb, finished_at=${now}, updated_at=${now}
        WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
        RETURNING operation_id`);
      assertReturning(terminal.rows, ['operation_id'], { operation_id: input.operationId }, 'terminal operation');
      const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (!stored) throw new Error('Task schedule terminal operation integrity check failed.');
      return replay(tx, dependencies.tenantId, stored, input, hash);
    });
  };
  return {
    async updateBatch(raw: DatabaseTaskScheduleBatchUpdateInput) {
      return run(canonicalBatchInput(raw));
    },
    async update(raw: DatabaseTaskScheduleUpdateInput): Promise<DatabaseTaskScheduleUpdateSuccess> {
      const batch = await run(canonicalUpdateInput(raw));
      return freezeSingleResult(batch);
    },
  };
}

async function replay(tx: TenantTransaction, tenantId: string, operation: Operation,
  input: CanonicalInput, hash: string): Promise<DatabaseTaskScheduleBatchUpdateSuccess> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== hash) {
    throw new Error('Task schedule operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== '1' || operation.finished_at === null
    || operation.started_at.getTime() !== operation.created_at.getTime()
    || operation.finished_at.getTime() !== operation.updated_at.getTime()
    || operation.started_at > operation.finished_at) {
    throw new Error('Task schedule operation is not replayable.');
  }
  const result = parseBatchResult(operation.result_snapshot);
  if (result.operationId !== input.operationId || result.completedAt !== operation.finished_at.toISOString()
    || result.tasks.length !== input.tasks.length) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  for (let index = 0; index < input.tasks.length; index += 1) {
    const requested = input.tasks[index]; const saved = result.tasks[index];
    if (saved.taskId !== requested.taskId || saved.versionBefore !== requested.expectedTaskVersion
      || saved.versionAfter !== saved.versionBefore + (saved.changed ? 1 : 0)
      || !sameConfiguration(saved.schedule, requested)) {
      throw new Error('Task schedule stored result integrity check failed.');
    }
  }
  await verifyTasks(tx, tenantId, result);
  await verifyMaterializationIds(tx, tenantId, result);
  await assertOperationAudit(tx, tenantId, auditInput(result, operation.finished_at));
  await assertOneAudit(tx, tenantId, input.operationId);
  return result;
}

async function verifyTasks(tx: TenantTransaction, tenantId: string,
  result: DatabaseTaskScheduleBatchUpdateSuccess) {
  const instances = result.tasks.map((task) => task.taskInstanceId);
  const rows = await tx.execute(sql`SELECT task_instance_id, task_id, current_schedule,
    pending_schedule, schedule_schema_version, version::text AS version, updated_at
    FROM tasks WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id`);
  if (rows.rows.length !== result.tasks.length) throw new Error('Task schedule task state integrity check failed.');
  const expected = new Map(result.tasks.map((task) => [task.taskInstanceId, task]));
  for (const raw of rows.rows) {
    const row = exactRow(raw, ['task_instance_id', 'task_id', 'current_schedule', 'pending_schedule',
      'schedule_schema_version', 'version', 'updated_at'], 'task state evidence');
    const task = expected.get(id(row.task_instance_id));
    if (!task || row.task_id !== task.taskId || row.schedule_schema_version !== 1
      || positiveText(row.version) !== task.versionAfter) throw new Error('Task schedule task state integrity check failed.');
    const effective = resolveTaskSchedule({ currentSchedule: parseSchedule(row.current_schedule),
      pendingSchedule: row.pending_schedule === null ? null : parseSchedule(row.pending_schedule),
      now: result.completedAt });
    if (sha256(effective) !== sha256(task.schedule)
      || (task.changed && (row.pending_schedule !== null
        || date(row.updated_at).toISOString() !== result.completedAt))) {
      throw new Error('Task schedule task state integrity check failed.');
    }
  }
}

async function verifyMaterializationIds(tx: TenantTransaction, tenantId: string,
  result: DatabaseTaskScheduleBatchUpdateSuccess) {
  for (const task of result.tasks) {
    if (!task.changed) {
      if (task.assignmentEventIds.length || task.completionEventIds.length) {
        throw new Error('Task schedule no-op materialization integrity check failed.');
      }
      continue;
    }
    const expectedCycle = cycleId(task.taskInstanceId, task.schedule.ruleVersion, task.schedule.effectiveFrom);
    const assignmentRows = await tx.execute(sql`SELECT assignment_id FROM task_assignments
      WHERE tenant_id=${tenantId} AND task_instance_id=${task.taskInstanceId}
        AND cycle_id=${expectedCycle} AND source='CARRY_FORWARD' ORDER BY assignment_id`);
    const assignmentIds = assignmentRows.rows.map((raw) => id(exactRow(raw, ['assignment_id'],
      'replay assignment identity').assignment_id));
    const completionRows = await tx.execute(sql`SELECT completion_id FROM task_completions
      WHERE tenant_id=${tenantId} AND task_instance_id=${task.taskInstanceId}
        AND cycle_id=${expectedCycle} AND source='CARRY_FORWARD' ORDER BY completion_id`);
    const completionIds = completionRows.rows.map((raw) => id(exactRow(raw, ['completion_id'],
      'replay completion identity').completion_id));
    if (JSON.stringify(assignmentIds) !== JSON.stringify(task.assignmentEventIds)
      || JSON.stringify(completionIds) !== JSON.stringify(task.completionEventIds)) {
      throw new Error('Task schedule materialization set integrity check failed.');
    }
  }
}

function canonicalUpdateInput(raw: DatabaseTaskScheduleUpdateInput): CanonicalInput {
  const row = exactRow(raw, UPDATE_KEYS, 'input');
  return canonicalBatchParts(row.operationId, [{ taskId: row.taskId,
    expectedTaskVersion: row.expectedTaskVersion, recurrence: row.recurrence, timeZone: row.timeZone,
    resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle }]);
}
function canonicalBatchInput(raw: DatabaseTaskScheduleBatchUpdateInput): CanonicalInput {
  const row = exactRow(raw, BATCH_KEYS, 'batch input');
  return canonicalBatchParts(row.operationId, exactArray(row.tasks, 'tasks'));
}
function canonicalBatchParts(operationValue: unknown, rawTasks: readonly unknown[]): CanonicalInput {
  if (typeof operationValue !== 'string' || !UUID.test(operationValue)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  if (rawTasks.length < 1 || rawTasks.length > 20) throw new Error('Task schedule batch requires 1-20 tasks.');
  const tasks = rawTasks.map((raw) => canonicalTask(raw)).sort((a, b) => compareText(a.taskId, b.taskId));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new Error('Task schedule batch contains a duplicate task ID.');
  }
  return Object.freeze({ operationId: operationValue, tasks: Object.freeze(tasks) });
}
function canonicalTask(raw: unknown): CanonicalTaskInput {
  const row = exactRow(raw, TASK_INPUT_KEYS, 'task input');
  const taskId = id(row.taskId); const expectedTaskVersion = integer(row.expectedTaskVersion);
  if (expectedTaskVersion < 1 || expectedTaskVersion >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Task schedule expected version is invalid.');
  }
  if (row.timeZone !== 'Asia/Seoul' || typeof row.resetCompletionOnCycle !== 'boolean'
    || typeof row.resetAssignmentOnCycle !== 'boolean') throw new Error('Task schedule input is invalid.');
  const recurrence = parseRecurrence(row.recurrence);
  const normalized = validateTaskSchedule({ ruleVersion: 1,
    effectiveFrom: '1970-01-01T00:00:00.000Z',
    timeZone: row.timeZone, recurrence, resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle });
  return Object.freeze({ taskId, expectedTaskVersion,
    recurrence: freezeRecurrence(normalized.recurrence),
    timeZone: 'Asia/Seoul', resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle });
}
function payloadHash(input: CanonicalInput) {
  return sha256({ kind: 'TASK_ADMIN', action: 'SCHEDULE_UPDATE', tasks: input.tasks,
    schemaVersion: 1 });
}
function sameConfiguration(schedule: TaskSchedule, input: CanonicalTaskInput) {
  return sha256({ recurrence: schedule.recurrence, timeZone: schedule.timeZone,
    resetCompletionOnCycle: schedule.resetCompletionOnCycle,
    resetAssignmentOnCycle: schedule.resetAssignmentOnCycle })
    === sha256({ recurrence: input.recurrence, timeZone: input.timeZone,
      resetCompletionOnCycle: input.resetCompletionOnCycle,
      resetAssignmentOnCycle: input.resetAssignmentOnCycle });
}

function parseTask(raw: unknown): Task {
  const row = exactRow(raw, ['task_instance_id', 'task_id', 'current_schedule', 'pending_schedule',
    'version', 'created_at', 'updated_at'], 'task evidence');
  return { taskInstanceId: id(row.task_instance_id), taskId: id(row.task_id),
    currentSchedule: parseSchedule(row.current_schedule),
    pendingSchedule: row.pending_schedule === null ? null : parseSchedule(row.pending_schedule),
    version: positiveText(row.version), createdAt: date(row.created_at), updatedAt: date(row.updated_at) };
}
function parseSchedule(raw: unknown): TaskSchedule {
  const row = exactRow(raw, ['ruleVersion', 'effectiveFrom', 'timeZone', 'recurrence',
    'resetCompletionOnCycle', 'resetAssignmentOnCycle'], 'schedule evidence');
  if (typeof row.resetCompletionOnCycle !== 'boolean' || typeof row.resetAssignmentOnCycle !== 'boolean') {
    throw new Error('Task schedule evidence is malformed.');
  }
  try {
    return validateTaskSchedule({ ruleVersion: integer(row.ruleVersion), effectiveFrom: id(row.effectiveFrom),
      timeZone: id(row.timeZone), recurrence: parseRecurrence(row.recurrence),
      resetCompletionOnCycle: row.resetCompletionOnCycle,
      resetAssignmentOnCycle: row.resetAssignmentOnCycle });
  } catch { throw new Error('Task schedule evidence is malformed.'); }
}
function parseRecurrence(raw: unknown): TaskRecurrence {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error('Task schedule recurrence is malformed.');
  }
  const type = Object.getOwnPropertyDescriptor(raw, 'type');
  if (!type?.enumerable || !Object.hasOwn(type, 'value')) throw new Error('Task schedule recurrence is malformed.');
  if (type.value === 'NONE') { exactRow(raw, ['type'], 'recurrence'); return { type: 'NONE' }; }
  if (type.value === 'DAILY') {
    const row = exactRow(raw, ['type', 'time'], 'recurrence'); return { type: 'DAILY', time: id(row.time) };
  }
  if (type.value === 'WEEKLY') {
    const row = exactRow(raw, ['type', 'time', 'weekdays'], 'recurrence');
    return { type: 'WEEKLY', time: id(row.time),
      weekdays: exactArray(row.weekdays, 'weekdays').map(integer) as IsoWeekday[] };
  }
  if (type.value === 'MONTHLY') {
    const row = exactRow(raw, ['type', 'time', 'dayOfMonth'], 'recurrence');
    return { type: 'MONTHLY', time: id(row.time), dayOfMonth: integer(row.dayOfMonth) as DayOfMonth };
  }
  throw new Error('Task schedule recurrence is malformed.');
}
function parseBatchResult(raw: unknown): DatabaseTaskScheduleBatchUpdateSuccess {
  const row = exactRow(raw, ['ok', 'operationId', 'action', 'completedAt', 'tasks'], 'stored result');
  if (row.ok !== true || row.action !== 'SCHEDULE_UPDATE') throw new Error('Task schedule stored result integrity check failed.');
  const tasks = exactArray(row.tasks, 'stored tasks').map(parseTaskResult);
  if (tasks.length < 1 || tasks.length > 20 || new Set(tasks.map((task) => task.taskId)).size !== tasks.length
    || tasks.some((task, index) => index > 0 && compareText(tasks[index - 1].taskId, task.taskId) >= 0)) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  return freezeBatchResult({ ok: true, operationId: id(row.operationId), action: 'SCHEDULE_UPDATE',
    completedAt: canonicalInstant(row.completedAt), tasks });
}
function parseTaskResult(raw: unknown): DatabaseTaskScheduleTaskResult {
  const row = exactRow(raw, ['taskId', 'taskInstanceId', 'changed', 'versionBefore', 'versionAfter',
    'schedule', 'assignmentEventIds', 'completionEventIds'], 'stored task result');
  if (typeof row.changed !== 'boolean') throw new Error('Task schedule stored result integrity check failed.');
  const result = { taskId: id(row.taskId), taskInstanceId: id(row.taskInstanceId), changed: row.changed,
    versionBefore: integer(row.versionBefore), versionAfter: integer(row.versionAfter),
    schedule: parseSchedule(row.schedule), assignmentEventIds: parseIdArray(row.assignmentEventIds),
    completionEventIds: parseIdArray(row.completionEventIds) };
  if (result.versionAfter !== result.versionBefore + (result.changed ? 1 : 0)
    || (!result.changed && (result.assignmentEventIds.length || result.completionEventIds.length))) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  return freezeTaskResult(result);
}
function parseIdArray(raw: unknown): string[] {
  const values = exactArray(raw, 'stored identities').map(id);
  if (new Set(values).size !== values.length
    || values.some((value, index) => index > 0 && compareText(values[index - 1], value) >= 0)) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  return values;
}
function freezeRecurrence(recurrence: TaskRecurrence): TaskRecurrence {
  if (recurrence.type === 'WEEKLY') Object.freeze(recurrence.weekdays);
  return Object.freeze(recurrence);
}
function freezeSchedule(schedule: TaskSchedule): TaskSchedule {
  freezeRecurrence(schedule.recurrence); return Object.freeze(schedule);
}
function freezeTaskResult(result: DatabaseTaskScheduleTaskResult): DatabaseTaskScheduleTaskResult {
  freezeSchedule(result.schedule); Object.freeze(result.assignmentEventIds); Object.freeze(result.completionEventIds);
  return Object.freeze(result);
}
function freezeBatchResult(result: DatabaseTaskScheduleBatchUpdateSuccess): DatabaseTaskScheduleBatchUpdateSuccess {
  result.tasks.forEach(freezeTaskResult); Object.freeze(result.tasks); return Object.freeze(result);
}
function freezeSingleResult(batch: DatabaseTaskScheduleBatchUpdateSuccess): DatabaseTaskScheduleUpdateSuccess {
  const task = batch.tasks[0];
  return Object.freeze({ ok: true, operationId: batch.operationId, action: batch.action,
    completedAt: batch.completedAt, ...task });
}

async function readOperation(tx: TenantTransaction, tenantId: string, operationId: string) {
  const rows = await tx.execute(sql`SELECT operation_id, operation_kind, payload_hash, status,
    result_snapshot, finished_at, failure_code, attempt_count::text AS attempt_count,
    started_at, created_at, updated_at FROM operations WHERE tenant_id=${tenantId}
      AND operation_id=${operationId} FOR UPDATE`);
  if (rows.rows.length > 1) throw new Error('Task schedule operation integrity check failed.');
  if (!rows.rows.length) return null;
  const row = exactRow(rows.rows[0], OPERATION_KEYS, 'operation evidence');
  if (row.operation_id !== operationId || typeof row.operation_kind !== 'string'
    || typeof row.payload_hash !== 'string' || !HASH.test(row.payload_hash)
    || typeof row.status !== 'string' || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(row.status)
    || typeof row.attempt_count !== 'string' || !/^[1-9][0-9]*$/.test(row.attempt_count)) {
    throw new Error('Task schedule operation integrity check failed.');
  }
  return { ...row, started_at: date(row.started_at), created_at: date(row.created_at),
    updated_at: date(row.updated_at), finished_at: row.finished_at === null ? null : date(row.finished_at) } as Operation;
}
function auditInput(result: DatabaseTaskScheduleBatchUpdateSuccess, occurredAt: Date) {
  return { operationId: result.operationId, eventType: 'TASK_ADMIN_COMPLETED', entityType: 'OPERATION',
    entityId: result.operationId, redactedDetails: { action: 'SCHEDULE_UPDATE',
      taskCount: result.tasks.length, changedTaskCount: result.tasks.filter((task) => task.changed).length,
      assignmentMaterializationCount: result.tasks.reduce((sum, task) => sum + task.assignmentEventIds.length, 0),
      completionMaterializationCount: result.tasks.reduce((sum, task) => sum + task.completionEventIds.length, 0),
      resultHash: sha256(result) }, occurredAt } as const;
}
async function assertOneAudit(tx: TenantTransaction, tenantId: string, operationId: string) {
  const rows = await tx.execute(sql`SELECT event_id FROM audit_events WHERE tenant_id=${tenantId}
    AND operation_id=${operationId} ORDER BY event_id`);
  if (rows.rows.length !== 1) throw new Error('Task schedule audit set integrity check failed.');
  const row = exactRow(rows.rows[0], ['event_id'], 'audit evidence');
  if (row.event_id !== operationAuditEventId(operationId, 'TASK_ADMIN_COMPLETED')) {
    throw new Error('Task schedule audit set integrity check failed.');
  }
}
function assertUpdatedTask(rows: readonly unknown[], task: Task, schedule: TaskSchedule, now: Date) {
  if (rows.length !== 1) throw new Error('Task schedule optimistic update integrity check failed.');
  const row = exactRow(rows[0], ['task_instance_id', 'task_id', 'current_schedule', 'pending_schedule',
    'schedule_schema_version', 'version', 'created_at', 'updated_at'], 'updated task evidence');
  if (row.task_instance_id !== task.taskInstanceId || row.task_id !== task.taskId
    || row.pending_schedule !== null || row.schedule_schema_version !== 1
    || positiveText(row.version) !== task.version + 1 || date(row.created_at).getTime() !== task.createdAt.getTime()
    || date(row.updated_at).getTime() !== now.getTime()
    || sha256(parseSchedule(row.current_schedule)) !== sha256(schedule)) {
    throw new Error('Task schedule optimistic update integrity check failed.');
  }
}
function exactRow<const K extends readonly string[]>(raw: unknown, keys: K, label: string) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw); const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  for (const key of actual) if (!descriptors[key].enumerable
    || !Object.hasOwn(descriptors[key], 'value')) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  return raw as { [P in K[number]]: unknown };
}
function exactArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length) throw new Error(`Task schedule ${label} is malformed.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw) as Record<string, PropertyDescriptor>;
  const length = descriptors.length;
  if (!length || length.enumerable
    || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')) throw new Error(`Task schedule ${label} is malformed.`);
    values.push(descriptor.value);
  }
  if (Object.keys(descriptors).filter((key) => key !== 'length').length !== length.value) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  return values;
}
function assertReturning<const K extends readonly string[]>(rows: readonly unknown[], keys: K,
  expected: { [P in K[number]]: unknown }, label: string) {
  if (rows.length !== 1) throw new Error(`Task schedule ${label} integrity check failed.`);
  const row = exactRow(rows[0], keys, label);
  for (const key of keys as readonly K[number][]) if (row[key] !== expected[key]) {
    throw new Error(`Task schedule ${label} integrity check failed.`);
  }
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) throw new Error('Task schedule identity is invalid.');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('Task schedule integer is invalid.'); return value as number;
}
function positiveText(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Task schedule version is invalid.');
  }
  return Number(value);
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Task schedule timestamp is invalid.');
  return value;
}
function canonicalInstant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Task schedule timestamp is invalid.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error('Task schedule timestamp is invalid.');
  return value;
}
function cycleId(taskInstanceId: string, ruleVersion: number, effectiveFrom: string) {
  return `v1|${taskInstanceId}|r${ruleVersion}|${new Date(effectiveFrom).toISOString().replace('.000Z', 'Z')}`;
}
function compareText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
