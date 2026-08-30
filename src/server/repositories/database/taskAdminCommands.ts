import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTaskCycle } from '@/domain/taskRecurrence';
import type { DayOfMonth, IsoWeekday, TaskRecurrence } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

export type TaskAdminRecurrence = TaskRecurrence;

export type CreateTaskAdminInput = Readonly<{
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
  padletBoardId?: string | null;
  schedule: Readonly<{
    recurrence: TaskAdminRecurrence;
    timeZone: 'Asia/Seoul';
    resetCompletionOnCycle: boolean;
    resetAssignmentOnCycle: boolean;
  }>;
}>;

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseTaskAdminCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

export type TaskAdminCreateTaskResult = Readonly<{
  taskId: string;
  taskInstanceId: string;
  versionBefore: null;
  versionAfter: 1;
  assignmentEventIds: readonly string[];
}>;

export type TaskAdminCreateSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'CREATE';
  completedAt: string;
  tasks: readonly TaskAdminCreateTaskResult[];
}>;

type CanonicalInput = Omit<CreateTaskAdminInput, 'schedule' | 'allowedStudentIds'> & {
  allowedStudentIds: readonly string[];
  availableFrom: string | null;
  dueAt: string | null;
  prerequisiteTaskId: string | null;
  padletBoardId: string | null;
  schedule: Readonly<{
    recurrence: TaskAdminRecurrence;
    timeZone: 'Asia/Seoul';
    resetCompletionOnCycle: boolean;
    resetAssignmentOnCycle: boolean;
  }>;
};

type StoredOperation = {
  operation_kind: unknown;
  payload_hash: unknown;
  status: unknown;
  result_snapshot: unknown;
  finished_at: unknown;
  failure_code: unknown;
  attempt_count: unknown;
  started_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type InitialEvidence = Readonly<{
  input: CanonicalInput;
  taskInstanceId: string;
  prerequisiteTaskInstanceId: string | null;
  schedule: Readonly<Record<string, unknown>>;
  cycle: Readonly<{ cycleId: string; startsAt: string; endsAt: string | null }>;
  assignmentEventIds: readonly string[];
  payloadHash: string;
  now: Date;
}>;

const CREATE_REQUIRED_KEYS = [
  'operationId', 'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder',
  'allowedStudentIds', 'schedule',
] as const;
const CREATE_KEYS = [
  ...CREATE_REQUIRED_KEYS, 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId',
] as const;
const SCHEDULE_KEYS = [
  'recurrence', 'timeZone', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
] as const;
const MIRROR_ROW_KEYS = ['task_instance_id', 'student_id', 'created_at'] as const;
const ASSIGNMENT_ROW_KEYS = [
  'assignment_id', 'task_id_snapshot', 'task_instance_id', 'cycle_id', 'cycle_start_at',
  'cycle_end_at', 'rule_version', 'timezone', 'student_id', 'event_type', 'source',
  'previous_assignment_id', 'admin_operation_id', 'admin_operation_hash', 'created_at',
  'schema_version', 'note',
] as const;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const PADLET_BOARD_ID = /^[A-Za-z0-9]{16,22}$/;

export function createTaskAdminTaskInstanceId(operationId: string, taskId: string): string {
  return `task-admin-instance:${sha256({ domain: 'task-admin-instance-v1', operationId, taskId })}`;
}

export function createTaskAdminAssignmentEventId(
  operationId: string,
  taskId: string,
  studentId: string,
): string {
  return `task-admin-assignment:${sha256({
    domain: 'task-admin-assignment-v1', operationId, taskId, studentId,
  })}`;
}

export function createTaskAdminPayloadHash(input: CreateTaskAdminInput): string {
  const canonical = canonicalCreate(input);
  return payloadHashFor(canonical);
}

export function createTaskAdminResultHash(result: TaskAdminCreateSuccess): string {
  return sha256(canonicalResultValue(result));
}

export function createDatabaseTaskAdminCommands(dependencies: DatabaseTaskAdminCommandDependencies) {
  return {
    async create(rawInput: CreateTaskAdminInput): Promise<TaskAdminCreateSuccess> {
      const input = canonicalCreate(rawInput);
      const now = dependencies.now?.() ?? new Date();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Task administration current timestamp is invalid.');
      }
      const payloadHash = payloadHashFor(input);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) return resolveReplay(tx, dependencies.tenantId, existing, input, payloadHash);

        const claim = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
             started_at, created_at, updated_at)
          VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${payloadHash},
                  'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        if (claim.rows.length !== 1
          || (claim.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
          if (claim.rows.length !== 0) throw new Error('Task administration operation claim integrity check failed.');
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Task administration operation race integrity check failed.');
          return resolveReplay(tx, dependencies.tenantId, winner, input, payloadHash);
        }

        const liveTasksResult = await tx.execute(sql`
          SELECT task_instance_id, task_id, prerequisite_task_instance_id, created_at, updated_at, deleted_at
          FROM tasks
          WHERE tenant_id=${dependencies.tenantId} AND deleted_at IS NULL
          ORDER BY task_instance_id
          FOR UPDATE
        `);
        const liveTasks = parseLiveTasks(liveTasksResult.rows);
        if (liveTasks.some((task) => task.taskId === input.taskId)) {
          throw new Error('Task administration duplicate live task ID.');
        }
        let prerequisiteTaskInstanceId: string | null = null;
        if (input.prerequisiteTaskId !== null) {
          if (input.prerequisiteTaskId === input.taskId) {
            throw new Error('Task administration prerequisite cycle is not allowed.');
          }
          const prerequisite = liveTasks.filter((task) => task.taskId === input.prerequisiteTaskId);
          if (prerequisite.length !== 1) throw new Error('Task administration prerequisite task not found.');
          prerequisiteTaskInstanceId = prerequisite[0].taskInstanceId;
          assertNoPrerequisiteCycle(liveTasks, prerequisiteTaskInstanceId);
        }

        if (input.allowedStudentIds.length > 0) {
          const students = await tx.execute(sql`
            SELECT student_id, status
            FROM students
            WHERE tenant_id=${dependencies.tenantId}
              AND student_id IN (${sql.join(input.allowedStudentIds.map((id) => sql`${id}`), sql`, `)})
            ORDER BY student_id
            FOR UPDATE
          `);
          assertExactActiveStudents(students.rows, input.allowedStudentIds);
        }

        const taskInstanceId = createTaskAdminTaskInstanceId(input.operationId, input.taskId);
        const nowIso = now.toISOString();
        const schedule = {
          ruleVersion: 1,
          effectiveFrom: nowIso,
          timeZone: 'Asia/Seoul' as const,
          recurrence: input.schedule.recurrence,
          resetCompletionOnCycle: input.schedule.resetCompletionOnCycle,
          resetAssignmentOnCycle: input.schedule.resetAssignmentOnCycle,
        };
        const cycle = getTaskCycle({ taskInstanceId, schedule, taskCreatedAt: nowIso, now: nowIso });
        const assignmentEventIds = input.allowedStudentIds.map((studentId) =>
          createTaskAdminAssignmentEventId(input.operationId, input.taskId, studentId));
        const evidence: InitialEvidence = {
          input, taskInstanceId, prerequisiteTaskInstanceId, schedule, cycle,
          assignmentEventIds, payloadHash, now,
        };

        const taskInsert = await tx.execute(sql`
          INSERT INTO tasks
            (tenant_id, task_instance_id, task_id, title, description, reward, is_active,
             sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
             padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
             version, created_at, updated_at, deleted_at)
          VALUES (${dependencies.tenantId}, ${taskInstanceId}, ${input.taskId}, ${input.title},
                  ${input.description}, ${input.reward}, ${input.isActive}, ${input.sortOrder},
                  ${input.availableFrom ? new Date(input.availableFrom) : null}, NULL,
                  ${input.dueAt ? new Date(input.dueAt) : null}, ${prerequisiteTaskInstanceId},
                  ${input.padletBoardId}, ${JSON.stringify(schedule)}::jsonb, NULL, 1, 1,
                  ${now}, ${now}, NULL)
          RETURNING task_instance_id, task_id, title, description, reward::text AS reward,
                    is_active, sort_order, available_from, available_until, due_at,
                    prerequisite_task_instance_id, padlet_board_id, current_schedule,
                    pending_schedule, schedule_schema_version, version::text AS version,
                    created_at, updated_at, deleted_at
        `);
        assertTaskRow(taskInsert.rows, evidence);

        if (input.allowedStudentIds.length > 0) {
          const mirrorInsert = await tx.execute(sql`
            INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id, created_at)
            VALUES ${sql.join(input.allowedStudentIds.map((studentId) =>
              sql`(${dependencies.tenantId}, ${taskInstanceId}, ${studentId}, ${now})`), sql`, `)}
            RETURNING task_instance_id, student_id, created_at
          `);
          assertMirrorRows(mirrorInsert.rows, evidence);

          const assignmentInsert = await tx.execute(sql`
            INSERT INTO task_assignments
              (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
               cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
               source, previous_assignment_id, admin_operation_id, admin_operation_hash,
               created_at, schema_version, note)
            VALUES ${sql.join(input.allowedStudentIds.map((studentId, index) => sql`
              (${dependencies.tenantId}, ${assignmentEventIds[index]}, ${input.taskId},
               ${taskInstanceId}, ${cycle.cycleId}, ${new Date(cycle.startsAt)},
               ${cycle.endsAt ? new Date(cycle.endsAt) : null}, 1, 'Asia/Seoul', ${studentId},
               'ASSIGNED', 'ADMIN', NULL, ${input.operationId}, ${payloadHash}, ${now}, 1, NULL)
            `), sql`, `)}
            RETURNING assignment_id, task_id_snapshot, task_instance_id, cycle_id,
                      cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
                      event_type, source, previous_assignment_id, admin_operation_id,
                      admin_operation_hash, created_at, schema_version, note
          `);
          assertAssignmentRows(assignmentInsert.rows, evidence);
        }

        await assertInitialState(tx, dependencies.tenantId, evidence);
        const result = freezeResult({
          ok: true,
          operationId: input.operationId,
          action: 'CREATE',
          completedAt: nowIso,
          tasks: [{ taskId: input.taskId, taskInstanceId, versionBefore: null,
            versionAfter: 1, assignmentEventIds }],
        });
        const audit = auditInput(result, now);
        await appendOperationAudit(tx, dependencies.tenantId, audit);
        await assertSingleAudit(tx, dependencies.tenantId, audit);

        const terminal = await tx.execute(sql`
          UPDATE operations
          SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
              finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id
        `);
        if (terminal.rows.length !== 1
          || (terminal.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
          throw new Error('Task administration terminal operation integrity check failed.');
        }
        await assertInitialState(tx, dependencies.tenantId, evidence);
        const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!stored) throw new Error('Task administration terminal operation integrity check failed.');
        return resolveReplay(tx, dependencies.tenantId, stored, input, payloadHash);
      });
    },
  };
}

function canonicalCreate(raw: CreateTaskAdminInput): CanonicalInput {
  const input = exactRecordOptional(raw, CREATE_REQUIRED_KEYS, CREATE_KEYS, 'task create input');
  const operationId = canonicalId(input.operationId, 'operation ID');
  const taskId = canonicalId(input.taskId, 'task ID');
  const title = canonicalText(input.title, 'task title', false);
  const description = canonicalString(input.description, 'task description').trim();
  const reward = safeInteger(input.reward, 'task reward', 0, Number.MAX_SAFE_INTEGER);
  const sortOrder = safeInteger(input.sortOrder, 'task sort order', INT32_MIN, INT32_MAX);
  if (typeof input.isActive !== 'boolean') throw new Error('Task active flag must be boolean.');
  const ids = exactArray(input.allowedStudentIds, 'allowed student IDs').map((value) =>
    canonicalId(value, 'student ID')).sort(compareText);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate allowed student ID.');
  const availableFrom = optionalInstant(input.availableFrom, 'availableFrom');
  const dueAt = optionalInstant(input.dueAt, 'dueAt');
  if (availableFrom !== null && dueAt !== null && Date.parse(dueAt) < Date.parse(availableFrom)) {
    throw new Error('Task dueAt must not be before availableFrom.');
  }
  const prerequisiteTaskId = optionalId(input.prerequisiteTaskId, 'prerequisite task ID');
  const padletBoardId = optionalId(input.padletBoardId, 'Padlet board ID');
  if (padletBoardId !== null && !PADLET_BOARD_ID.test(padletBoardId)) {
    throw new Error('Padlet board ID must be 16 to 22 alphanumeric characters.');
  }
  const schedule = canonicalSchedule(input.schedule);
  return {
    operationId, taskId, title, description, reward, isActive: input.isActive, sortOrder,
    allowedStudentIds: ids, availableFrom, dueAt, prerequisiteTaskId, padletBoardId, schedule,
  };
}

function canonicalSchedule(raw: unknown): CanonicalInput['schedule'] {
  const value = exactRecord(raw, SCHEDULE_KEYS, 'task schedule');
  if (value.timeZone !== 'Asia/Seoul') throw new Error('Task timeZone must be Asia/Seoul.');
  if (typeof value.resetCompletionOnCycle !== 'boolean'
    || typeof value.resetAssignmentOnCycle !== 'boolean') throw new Error('Task reset flags must be boolean.');
  return {
    recurrence: canonicalRecurrence(value.recurrence),
    timeZone: 'Asia/Seoul',
    resetCompletionOnCycle: value.resetCompletionOnCycle,
    resetAssignmentOnCycle: value.resetAssignmentOnCycle,
  };
}

function canonicalRecurrence(raw: unknown): TaskAdminRecurrence {
  const base = exactRecordWithKnownType(raw, 'task recurrence');
  if (base.type === 'NONE') {
    assertExactKeys(base, ['type'], 'NONE recurrence');
    return { type: 'NONE' };
  }
  if (base.type === 'DAILY') {
    assertExactKeys(base, ['type', 'time'], 'DAILY recurrence');
    return { type: 'DAILY', time: recurrenceTime(base.time) };
  }
  if (base.type === 'WEEKLY') {
    assertExactKeys(base, ['type', 'time', 'weekdays'], 'WEEKLY recurrence');
    const weekdays = exactArray(base.weekdays, 'weekly weekdays').map((day) =>
      safeInteger(day, 'weekly weekday', 1, 7)).sort((a, b) => a - b);
    if (weekdays.length === 0 || new Set(weekdays).size !== weekdays.length) {
      throw new Error('Weekly weekdays must be nonempty and unique.');
    }
    return { type: 'WEEKLY', time: recurrenceTime(base.time), weekdays: weekdays as IsoWeekday[] };
  }
  if (base.type === 'MONTHLY') {
    assertExactKeys(base, ['type', 'time', 'dayOfMonth'], 'MONTHLY recurrence');
    return { type: 'MONTHLY', time: recurrenceTime(base.time),
      dayOfMonth: safeInteger(base.dayOfMonth, 'monthly day', 1, 31) as DayOfMonth };
  }
  throw new Error('Task recurrence type is invalid.');
}

function payloadHashFor(input: CanonicalInput): string {
  return sha256({ kind: 'TASK_ADMIN', action: 'CREATE', tasks: [{
    taskId: input.taskId, title: input.title, description: input.description,
    reward: input.reward, isActive: input.isActive, sortOrder: input.sortOrder,
    allowedStudentIds: input.allowedStudentIds, availableFrom: input.availableFrom,
    dueAt: input.dueAt, prerequisiteTaskId: input.prerequisiteTaskId,
    padletBoardId: input.padletBoardId, schedule: input.schedule,
  }], schemaVersion: 1 });
}

async function readOperation(tx: TenantTransaction, tenantId: string, operationId: string) {
  const result = await tx.execute(sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at, failure_code,
           attempt_count, started_at, created_at, updated_at
    FROM operations WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  `);
  if (result.rows.length > 1) throw new Error('Task administration operation integrity check failed.');
  return (result.rows[0] as StoredOperation | undefined) ?? null;
}

async function resolveReplay(
  tx: TenantTransaction,
  tenantId: string,
  operation: StoredOperation,
  input: CanonicalInput,
  payloadHash: string,
): Promise<TaskAdminCreateSuccess> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Task administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== 1 && operation.attempt_count !== '1') {
    throw new Error('Task administration operation is not replayable.');
  }
  const started = exactDate(operation.started_at, 'operation timestamp');
  const created = exactDate(operation.created_at, 'operation timestamp');
  const updated = exactDate(operation.updated_at, 'operation timestamp');
  const finished = exactDate(operation.finished_at, 'operation timestamp');
  if (!(started.getTime() === created.getTime()
    && started.getTime() <= finished.getTime()
    && finished.getTime() === updated.getTime())) {
    throw new Error('Task administration operation timestamp integrity check failed.');
  }
  const result = parseStoredResult(operation.result_snapshot);
  if (result.operationId !== input.operationId || result.completedAt !== finished.toISOString()
    || result.tasks[0].taskId !== input.taskId
    || createTaskAdminTaskInstanceId(input.operationId, input.taskId) !== result.tasks[0].taskInstanceId
    || result.tasks[0].assignmentEventIds.length !== input.allowedStudentIds.length
    || result.tasks[0].assignmentEventIds.some((id, index) =>
      id !== createTaskAdminAssignmentEventId(input.operationId, input.taskId, input.allowedStudentIds[index]))) {
    throw new Error('Task administration stored result integrity check failed.');
  }
  const identity = await tx.execute(sql`
    SELECT task_instance_id FROM tasks
    WHERE tenant_id=${tenantId} AND task_instance_id=${result.tasks[0].taskInstanceId}
  `);
  if (identity.rows.length !== 1
    || (identity.rows[0] as { task_instance_id?: unknown }).task_instance_id !== result.tasks[0].taskInstanceId) {
    throw new Error('Task administration physical identity integrity check failed.');
  }
  const schedule = {
    ruleVersion: 1,
    effectiveFrom: result.completedAt,
    timeZone: 'Asia/Seoul' as const,
    recurrence: input.schedule.recurrence,
    resetCompletionOnCycle: input.schedule.resetCompletionOnCycle,
    resetAssignmentOnCycle: input.schedule.resetAssignmentOnCycle,
  };
  const cycle = getTaskCycle({ taskInstanceId: result.tasks[0].taskInstanceId, schedule,
    taskCreatedAt: result.completedAt, now: result.completedAt });
  const assignmentEventIds = result.tasks[0].assignmentEventIds;
  const assignmentRows = assignmentEventIds.length === 0 ? [] : (await tx.execute(sql`
    SELECT assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
           cycle_end_at, rule_version, timezone, student_id, event_type, source,
           previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
           schema_version, note
    FROM task_assignments
    WHERE tenant_id=${tenantId}
      AND assignment_id IN (${sql.join(assignmentEventIds.map((id) => sql`${id}`), sql`, `)})
      AND admin_operation_id=${input.operationId}
    ORDER BY assignment_id
  `)).rows;
  assertAssignmentRows(assignmentRows, {
    input, taskInstanceId: result.tasks[0].taskInstanceId, prerequisiteTaskInstanceId: null,
    schedule, cycle, assignmentEventIds: result.tasks[0].assignmentEventIds,
    payloadHash, now: finished,
  });
  await assertSingleAudit(tx, tenantId, auditInput(result, finished));
  return result;
}

async function assertInitialState(tx: TenantTransaction, tenantId: string, evidence: InitialEvidence) {
  const task = await tx.execute(sql`
    SELECT task_instance_id, task_id, title, description, reward::text AS reward, is_active,
           sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
           padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
           version::text AS version, created_at, updated_at, deleted_at
    FROM tasks WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.taskInstanceId}
  `);
  assertTaskRow(task.rows, evidence);
  const mirrors = await tx.execute(sql`
    SELECT task_instance_id, student_id, created_at FROM task_allowed_students
    WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.taskInstanceId}
    ORDER BY student_id
  `);
  assertMirrorRows(mirrors.rows, evidence);
  const assignments = await tx.execute(sql`
    SELECT assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
           cycle_end_at, rule_version, timezone, student_id, event_type, source,
           previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
           schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId}
      AND task_instance_id=${evidence.taskInstanceId}
    ORDER BY cycle_id, student_id, assignment_id
  `);
  assertAssignmentRows(assignments.rows, evidence);
  const completions = await tx.execute(sql`
    SELECT completion_id FROM task_completions
    WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.taskInstanceId}
    ORDER BY completion_id
  `);
  if (completions.rows.length !== 0) {
    throw new Error('Task administration completion event integrity check failed.');
  }
}

function assertTaskRow(rows: readonly unknown[], evidence: InitialEvidence) {
  if (rows.length !== 1) throw new Error('Task administration task row integrity check failed.');
  const row = rows[0] as Record<string, unknown>;
  const expected = {
    task_instance_id: evidence.taskInstanceId, task_id: evidence.input.taskId,
    title: evidence.input.title, description: evidence.input.description,
    reward: String(evidence.input.reward), is_active: evidence.input.isActive,
    sort_order: evidence.input.sortOrder, available_from: evidence.input.availableFrom,
    available_until: null, due_at: evidence.input.dueAt,
    prerequisite_task_instance_id: evidence.prerequisiteTaskInstanceId,
    padlet_board_id: evidence.input.padletBoardId, current_schedule: evidence.schedule,
    pending_schedule: null, schedule_schema_version: 1, version: '1',
    created_at: evidence.now.toISOString(), updated_at: evidence.now.toISOString(), deleted_at: null,
  };
  if (stableJson(normalizeDbRow(row)) !== stableJson(expected)) {
    throw new Error('Task administration task row integrity check failed.');
  }
}

function assertMirrorRows(rows: readonly unknown[], evidence: InitialEvidence) {
  const failure = 'Task administration allowed-student mirror integrity check failed.';
  const actual = rows.map((raw) => {
    const row = exactEvidenceRecord(raw, MIRROR_ROW_KEYS, failure);
    return {
      taskInstanceId: evidenceString(row.task_instance_id, failure),
      studentId: evidenceString(row.student_id, failure),
      createdAt: evidenceTimestamp(row.created_at, failure),
    };
  }).sort((a, b) => compareText(a.studentId, b.studentId));
  const expected = evidence.input.allowedStudentIds.map((studentId) => ({
    taskInstanceId: evidence.taskInstanceId, studentId, createdAt: evidence.now.toISOString(),
  }));
  if (actual.length !== expected.length || actual.some((row, index) =>
    row.taskInstanceId !== expected[index].taskInstanceId
    || row.studentId !== expected[index].studentId
    || row.createdAt !== expected[index].createdAt)) {
    throw new Error(failure);
  }
}

function assertAssignmentRows(rows: readonly unknown[], evidence: InitialEvidence) {
  const failure = 'Task administration assignment event integrity check failed.';
  const actual = rows.map((raw) => {
    const row = exactEvidenceRecord(raw, ASSIGNMENT_ROW_KEYS, failure);
    return {
      assignment_id: evidenceString(row.assignment_id, failure),
      task_id_snapshot: evidenceString(row.task_id_snapshot, failure),
      task_instance_id: evidenceString(row.task_instance_id, failure),
      cycle_id: evidenceString(row.cycle_id, failure),
      cycle_start_at: evidenceTimestamp(row.cycle_start_at, failure),
      cycle_end_at: row.cycle_end_at === null ? null : evidenceTimestamp(row.cycle_end_at, failure),
      rule_version: evidenceInteger(row.rule_version, failure),
      timezone: evidenceString(row.timezone, failure),
      student_id: evidenceString(row.student_id, failure),
      event_type: evidenceString(row.event_type, failure),
      source: evidenceString(row.source, failure),
      previous_assignment_id: evidenceNull(row.previous_assignment_id, failure),
      admin_operation_id: evidenceString(row.admin_operation_id, failure),
      admin_operation_hash: evidenceString(row.admin_operation_hash, failure),
      created_at: evidenceTimestamp(row.created_at, failure),
      schema_version: evidenceInteger(row.schema_version, failure),
      note: evidenceNull(row.note, failure),
    };
  }).sort((a, b) => compareText(a.student_id, b.student_id));
  const expected = evidence.input.allowedStudentIds.map((studentId, index) => ({
    assignment_id: evidence.assignmentEventIds[index], task_id_snapshot: evidence.input.taskId,
    task_instance_id: evidence.taskInstanceId, cycle_id: evidence.cycle.cycleId,
    cycle_start_at: new Date(evidence.cycle.startsAt).toISOString(),
    cycle_end_at: evidence.cycle.endsAt ? new Date(evidence.cycle.endsAt).toISOString() : null,
    rule_version: 1, timezone: 'Asia/Seoul', student_id: studentId,
    event_type: 'ASSIGNED', source: 'ADMIN', previous_assignment_id: null,
    admin_operation_id: evidence.input.operationId, admin_operation_hash: evidence.payloadHash,
    created_at: evidence.now.toISOString(), schema_version: 1, note: null,
  }));
  if (actual.length !== expected.length || actual.some((row, index) => {
    const wanted = expected[index];
    return ASSIGNMENT_ROW_KEYS.some((key) => row[key] !== wanted[key]);
  })) {
    throw new Error(failure);
  }
}

function auditInput(result: TaskAdminCreateSuccess, occurredAt: Date) {
  return {
    operationId: result.operationId,
    eventType: 'TASK_ADMIN_COMPLETED',
    entityType: 'OPERATION',
    entityId: result.operationId,
    redactedDetails: {
      action: 'CREATE', taskCount: 1,
      assignmentEventCount: result.tasks[0].assignmentEventIds.length,
      resultHash: createTaskAdminResultHash(result),
    },
    occurredAt,
  } as const;
}

async function assertSingleAudit(
  tx: TenantTransaction,
  tenantId: string,
  input: ReturnType<typeof auditInput>,
) {
  await assertOperationAudit(tx, tenantId, input);
  const rows = await tx.execute(sql`
    SELECT event_type FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${input.operationId}
  `);
  if (rows.rows.length !== 1
    || (rows.rows[0] as { event_type?: unknown }).event_type !== 'TASK_ADMIN_COMPLETED') {
    throw new Error('Task administration audit integrity check failed.');
  }
}

function parseStoredResult(raw: unknown): TaskAdminCreateSuccess {
  const value = exactRecordOrdered(raw, ['ok', 'tasks', 'action', 'completedAt', 'operationId'], 'stored task result');
  if (value.ok !== true || value.action !== 'CREATE') throw new Error('Task administration stored result integrity check failed.');
  const operationId = exactStoredId(value.operationId);
  const completedAt = strictCanonicalInstant(value.completedAt, 'stored completedAt');
  const tasks = exactArray(value.tasks, 'stored tasks');
  if (tasks.length !== 1) throw new Error('Task administration stored result integrity check failed.');
  const task = exactRecordOrdered(tasks[0], [
    'taskId', 'versionAfter', 'versionBefore', 'taskInstanceId', 'assignmentEventIds',
  ], 'stored task result');
  if (task.versionBefore !== null || task.versionAfter !== 1) {
    throw new Error('Task administration stored result integrity check failed.');
  }
  const assignmentEventIds = exactArray(task.assignmentEventIds, 'stored assignment event IDs')
    .map(exactStoredId);
  return freezeResult({ ok: true, operationId, action: 'CREATE', completedAt, tasks: [{
    taskId: exactStoredId(task.taskId),
    taskInstanceId: exactStoredId(task.taskInstanceId),
    versionBefore: null, versionAfter: 1, assignmentEventIds,
  }] });
}

function freezeResult(result: TaskAdminCreateSuccess): TaskAdminCreateSuccess {
  const task = Object.freeze({ ...result.tasks[0],
    assignmentEventIds: Object.freeze([...result.tasks[0].assignmentEventIds]) });
  return Object.freeze({ ...result, tasks: Object.freeze([task]) });
}

function canonicalResultValue(result: TaskAdminCreateSuccess) {
  return { ok: true, operationId: result.operationId, action: 'CREATE', completedAt: result.completedAt,
    tasks: result.tasks.map((task) => ({ taskId: task.taskId, taskInstanceId: task.taskInstanceId,
      versionBefore: null, versionAfter: 1, assignmentEventIds: [...task.assignmentEventIds] })) };
}

function parseLiveTasks(rows: readonly unknown[]) {
  const parsed = rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const taskInstanceId = exactDatabaseId(row.task_instance_id);
    const taskId = exactDatabaseId(row.task_id);
    if (row.deleted_at !== null) throw new Error('Task administration live-task integrity check failed.');
    const created = exactDate(row.created_at, 'stored task timestamp');
    const updated = exactDate(row.updated_at, 'stored task timestamp');
    if (updated.getTime() < created.getTime()) throw new Error('Task administration live-task chronology integrity check failed.');
    return { taskInstanceId, taskId,
      prerequisiteTaskInstanceId: row.prerequisite_task_instance_id === null ? null
        : exactDatabaseId(row.prerequisite_task_instance_id) };
  });
  if (new Set(parsed.map((row) => row.taskInstanceId)).size !== parsed.length
    || new Set(parsed.map((row) => row.taskId)).size !== parsed.length) {
    throw new Error('Task administration live-task identity integrity check failed.');
  }
  return parsed;
}

function assertNoPrerequisiteCycle(
  tasks: readonly ReturnType<typeof parseLiveTasks>[number][],
  start: string,
) {
  const byInstance = new Map(tasks.map((task) => [task.taskInstanceId, task]));
  const visited = new Set<string>();
  let current: string | null = start;
  while (current !== null) {
    if (visited.has(current)) throw new Error('Task administration prerequisite cycle is not allowed.');
    visited.add(current);
    const row = byInstance.get(current);
    if (!row) throw new Error('Task administration prerequisite chain integrity check failed.');
    current = row.prerequisiteTaskInstanceId;
  }
}

function assertExactActiveStudents(rows: readonly unknown[], expected: readonly string[]) {
  const actual = rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    if (row.status !== 'ACTIVE') throw new Error('Task administration student is not active.');
    return exactDatabaseId(row.student_id);
  });
  if (actual.length !== expected.length || new Set(actual).size !== actual.length
    || expected.some((id) => !actual.includes(id))) {
    throw new Error('Task administration allowed student not found or invalid.');
  }
}

function normalizeDbRow(row: Record<string, unknown>) {
  return {
    task_instance_id: row.task_instance_id, task_id: row.task_id, title: row.title,
    description: row.description, reward: row.reward, is_active: row.is_active,
    sort_order: row.sort_order, available_from: nullableIso(row.available_from),
    available_until: nullableIso(row.available_until), due_at: nullableIso(row.due_at),
    prerequisite_task_instance_id: row.prerequisite_task_instance_id,
    padlet_board_id: row.padlet_board_id, current_schedule: row.current_schedule,
    pending_schedule: row.pending_schedule, schedule_schema_version: row.schedule_schema_version,
    version: row.version, created_at: nullableIso(row.created_at), updated_at: nullableIso(row.updated_at),
    deleted_at: nullableIso(row.deleted_at),
  };
}

function exactEvidenceRecord<T extends readonly string[]>(
  raw: unknown,
  keys: T,
  failure: string,
): Record<T[number], unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Object.getOwnPropertySymbols(raw).length > 0) throw new Error(failure);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new Error(failure);
  }
  if (actual.some((key) => !descriptors[key].enumerable || !('value' in descriptors[key]))) {
    throw new Error(failure);
  }
  return raw as Record<T[number], unknown>;
}

function evidenceString(value: unknown, failure: string): string {
  if (typeof value !== 'string') throw new Error(failure);
  return value;
}

function evidenceInteger(value: unknown, failure: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(failure);
  return value;
}

function evidenceNull(value: unknown, failure: string): null {
  if (value !== null) throw new Error(failure);
  return null;
}

function evidenceTimestamp(value: unknown, failure: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(failure);
  return value.toISOString();
}

function exactRecordOptional<R extends readonly string[], A extends readonly string[]>(
  raw: unknown,
  required: R,
  allowed: A,
  label: string,
): Record<A[number], unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Object.getOwnPropertySymbols(raw).length > 0) throw new Error(`Invalid ${label} shape.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const actual = Object.keys(descriptors);
  if (required.some((key) => !Object.hasOwn(descriptors, key))
    || actual.some((key) => !allowed.includes(key as A[number]))) {
    throw new Error(`Invalid ${label} fields.`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error(`Unsafe ${label} property.`);
  }
  return raw as Record<A[number], unknown>;
}

function exactRecord<T extends readonly string[]>(raw: unknown, keys: T, label: string): Record<T[number], unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Object.getOwnPropertySymbols(raw).length > 0) throw new Error(`Invalid ${label} shape.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new Error(`Invalid ${label} fields.`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error(`Unsafe ${label} property.`);
  }
  return raw as Record<T[number], unknown>;
}

function exactRecordOrdered<T extends readonly string[]>(
  raw: unknown,
  keys: T,
  label: string,
): Record<T[number], unknown> {
  const value = exactRecord(raw, keys, label);
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)) {
    throw new Error(`Invalid ${label} field order.`);
  }
  return value;
}

function exactRecordWithKnownType(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Object.getOwnPropertySymbols(raw).length > 0) throw new Error(`Invalid ${label} shape.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error(`Unsafe ${label} property.`);
  }
  return raw as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid ${label} fields.`);
  }
}

function exactArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || Object.getOwnPropertySymbols(raw).length > 0) throw new Error(`Invalid ${label}.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Object.keys(descriptors).filter((key) => key !== 'length');
  if (keys.length !== raw.length || keys.some((key, index) => key !== String(index)
    || !descriptors[key].enumerable || !('value' in descriptors[key]))) throw new Error(`Unsafe ${label}.`);
  return keys.map((key) => (descriptors[key] as PropertyDescriptor & { value: unknown }).value);
}

function canonicalString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`A string ${label} is required.`);
  return value;
}
function canonicalText(value: unknown, label: string, allowBlank: boolean): string {
  const canonical = canonicalString(value, label).trim();
  if (!allowBlank && canonical.length === 0) throw new Error(`A nonblank ${label} is required.`);
  return canonical;
}
function canonicalId(value: unknown, label: string): string {
  return canonicalText(value, label, false);
}
function exactDatabaseId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('Task administration database identity integrity check failed.');
  }
  return value;
}
function exactStoredId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('Task administration stored result integrity check failed.');
  }
  return value;
}
function optionalId(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : canonicalId(value, label);
}
function safeInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}
function optionalInstant(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO instant or null.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO instant or null.`);
  return date.toISOString();
}
function strictCanonicalInstant(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(`Invalid ${label}.`);
  return value;
}
function recurrenceTime(value: unknown): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('Task recurrence time must use HH:mm.');
  }
  return value;
}
function exactDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error(`Invalid ${label}.`);
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}.`);
  return date;
}
function nullableIso(value: unknown): string | null {
  return value === null ? null : exactDate(value, 'database timestamp').toISOString();
}
function compareText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
