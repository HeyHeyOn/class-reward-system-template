import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { DayOfMonth, IsoWeekday, TaskRecurrence, TaskSchedule } from '@/domain/types';
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

export type UpdateTaskAdminInput = Readonly<{
  operationId: string;
  taskId: string;
  expectedTaskVersion: number;
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
}>;

export type DeleteTaskAdminInput = Readonly<{
  operationId: string;
  taskId: string;
  expectedTaskVersion: number;
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

export type TaskAdminUpdateSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'UPDATE';
  completedAt: string;
  tasks: readonly Readonly<{
    taskId: string;
    taskInstanceId: string;
    versionBefore: number;
    versionAfter: number;
    assignmentEventIds: readonly string[];
  }>[];
}>;

export type TaskAdminDeleteSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'DELETE';
  completedAt: string;
  tasks: readonly Readonly<{
    taskId: string;
    taskInstanceId: string;
    versionBefore: number;
    versionAfter: number;
    assignmentEventIds: readonly string[];
  }>[];
}>;

export type TaskAdminSuccess = TaskAdminCreateSuccess | TaskAdminUpdateSuccess | TaskAdminDeleteSuccess;

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
  operation_id: string;
  operation_kind: string;
  payload_hash: string;
  status: string;
  result_snapshot: unknown;
  finished_at: Date | null;
  failure_code: string | null;
  attempt_count: string;
  started_at: Date;
  created_at: Date;
  updated_at: Date;
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
const OPERATION_ROW_KEYS = [
  'operation_id', 'operation_kind', 'payload_hash', 'status', 'result_snapshot',
  'finished_at', 'failure_code', 'attempt_count', 'started_at', 'created_at', 'updated_at',
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
  eventType?: 'ASSIGNED' | 'UNASSIGNED',
): string {
  if (eventType) return `task-admin-assignment:${sha256({
    domain: 'task-admin-assignment-v1', operationId, taskId, studentId, eventType,
  })}`;
  return `task-admin-assignment:${sha256({
    domain: 'task-admin-assignment-v1', operationId, taskId, studentId,
  })}`;
}

export function createTaskAdminPayloadHash(input: CreateTaskAdminInput): string {
  const canonical = canonicalCreate(input);
  return payloadHashFor(canonical);
}

export function createTaskAdminResultHash(result: TaskAdminSuccess): string {
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
    async update(rawInput: UpdateTaskAdminInput): Promise<TaskAdminUpdateSuccess> {
      return updateTaskDefinition(dependencies, rawInput);
    },
    async delete(rawInput: DeleteTaskAdminInput): Promise<TaskAdminDeleteSuccess> {
      return deleteTaskDefinition(dependencies, rawInput);
    },
  };
}

type CanonicalDeleteInput = DeleteTaskAdminInput;

type DeleteEvidence = Readonly<{
  input: CanonicalDeleteInput;
  payloadHash: string;
  now: Date;
  targetBefore: LockedUpdateTask;
  targetAfter: Omit<LockedUpdateTask, 'deletedAt'> & { deletedAt: string };
  assignments: readonly UpdateAssignment[];
  completions: readonly CompletionEvidence[];
  assignmentEventIds: readonly string[];
}>;

const DELETE_KEYS = ['operationId', 'taskId', 'expectedTaskVersion'] as const;

function canonicalDelete(raw: DeleteTaskAdminInput): CanonicalDeleteInput {
  const input = exactRecord(raw, DELETE_KEYS, 'task delete input');
  return {
    operationId: canonicalId(input.operationId, 'operation ID'),
    taskId: canonicalId(input.taskId, 'task ID'),
    expectedTaskVersion: safeInteger(input.expectedTaskVersion, 'expected task version',
      1, Number.MAX_SAFE_INTEGER),
  };
}

function deletePayloadHash(input: CanonicalDeleteInput): string {
  return sha256({ kind: 'TASK_ADMIN', action: 'DELETE', tasks: [{
    taskId: input.taskId, expectedTaskVersion: input.expectedTaskVersion,
  }], schemaVersion: 1 });
}

async function deleteTaskDefinition(
  dependencies: DatabaseTaskAdminCommandDependencies,
  rawInput: DeleteTaskAdminInput,
): Promise<TaskAdminDeleteSuccess> {
  const input = canonicalDelete(rawInput);
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Task administration current timestamp is invalid.');
  }
  const payloadHash = deletePayloadHash(input);
  return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
    const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (existing) return resolveDeleteReplay(tx, dependencies.tenantId, existing, input, payloadHash);
    const claim = await tx.execute(sql`
      INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
      VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${payloadHash},
              'PENDING', 1, ${now}, ${now}, ${now})
      ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id
    `);
    if (claim.rows.length !== 1
      || (claim.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
      if (claim.rows.length !== 0) throw new Error('Task administration operation claim integrity check failed.');
      const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (!winner) throw new Error('Task administration operation race integrity check failed.');
      return resolveDeleteReplay(tx, dependencies.tenantId, winner, input, payloadHash);
    }

    const taskRows = await tx.execute(sql`
      SELECT task_instance_id, task_id, title, description, reward::text AS reward, is_active,
        sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
        padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
        version::text AS version, created_at, updated_at, deleted_at
      FROM tasks WHERE tenant_id=${dependencies.tenantId} AND deleted_at IS NULL
      ORDER BY task_instance_id FOR UPDATE
    `);
    const tasks = parseLockedUpdateTasks(taskRows.rows, now);
    assertCompleteTaskGraph(tasks);
    const matches = tasks.filter((task) => task.taskId === input.taskId);
    if (matches.length !== 1) throw new Error('Task administration delete target not found.');
    const target = matches[0];
    if (target.version !== input.expectedTaskVersion) {
      throw new Error('Task administration stale task version.');
    }
    if (target.version === Number.MAX_SAFE_INTEGER) {
      throw new Error('Task administration task version successor is unsafe.');
    }
    if (tasks.some((task) => task.taskInstanceId !== target.taskInstanceId
      && task.prerequisiteTaskInstanceId === target.taskInstanceId)) {
      throw new Error('Task administration task has live dependents.');
    }

    const mirrorLock = await tx.execute(sql`
      SELECT task_instance_id, student_id, created_at FROM task_allowed_students
      WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${target.taskInstanceId}
      ORDER BY student_id FOR UPDATE
    `);
    const mirrors = parseLockedMirrors(mirrorLock.rows, target.taskInstanceId, now)
      .sort((left, right) => compareText(left.studentId, right.studentId));
    const assignmentLock = await tx.execute(sql`
      SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
        task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
        student_id, event_type, source, previous_assignment_id, admin_operation_id,
        admin_operation_hash, created_at, schema_version, note
      FROM task_assignments WHERE tenant_id=${dependencies.tenantId}
        AND task_instance_id=${target.taskInstanceId}
      ORDER BY student_id, event_sequence FOR UPDATE
    `);
    const oldAssignments = parseUpdateAssignments(assignmentLock.rows, now);
    assertUpdateAssignmentChains(oldAssignments);
    for (const event of oldAssignments) {
      if (event.task_id_snapshot !== target.taskId || event.task_instance_id !== target.taskInstanceId) {
        throw new Error('Task administration assignment event integrity check failed.');
      }
    }
    const effectiveSchedule = resolveTaskSchedule({ currentSchedule: target.currentSchedule,
      pendingSchedule: target.pendingSchedule, now: now.toISOString() });
    const cycle = getTaskCycle({ taskInstanceId: target.taskInstanceId, schedule: effectiveSchedule,
      taskCreatedAt: target.createdAt, now: now.toISOString() });
    const cycleStart = new Date(cycle.startsAt).toISOString();
    const cycleEnd = cycle.endsAt ? new Date(cycle.endsAt).toISOString() : null;
    const previousByStudent = new Map<string, UpdateAssignment>();
    for (const event of oldAssignments) {
      if (event.cycle_id === cycle.cycleId && event.cycle_start_at === cycleStart
        && event.cycle_end_at === cycleEnd && event.rule_version === effectiveSchedule.ruleVersion
        && event.timezone === effectiveSchedule.timeZone) {
        const selected = previousByStudent.get(event.student_id);
        if (!selected || Number(event.event_sequence) > Number(selected.event_sequence)) {
          previousByStudent.set(event.student_id, event);
        }
      }
    }
    const assignmentEventIds = mirrors.map((mirror) => createTaskAdminAssignmentEventId(
      input.operationId, input.taskId, mirror.studentId, 'UNASSIGNED'));
    const completionLock = await tx.execute(sql`
      SELECT completion_id, event_sequence::text AS event_sequence, completed_at,
        task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
        student_name_snapshot, reward_snapshot::text AS reward_snapshot,
        balance_before::text AS balance_before, balance_after::text AS balance_after,
        status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source,
        assignment_id, transaction_id, operation_id, operation_hash, admin_operation_id,
        admin_operation_hash, schema_version, evidence_provider, evidence_board_id,
        evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
      FROM task_completions
      WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${target.taskInstanceId}
      ORDER BY event_sequence FOR UPDATE
    `);
    const completions = parseCompletionSnapshots(completionLock.rows);
    if (completions.some((completion) => completion.task_instance_id !== target.taskInstanceId
      || completion.task_id_snapshot !== target.taskId)) {
      throw new Error('Task administration completion event integrity check failed.');
    }

    const updated = await tx.execute(sql`
      UPDATE tasks SET is_active=false, deleted_at=${now}, updated_at=${now}, version=version + 1
      WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${target.taskInstanceId}
        AND deleted_at IS NULL AND version=${input.expectedTaskVersion}
      RETURNING task_instance_id, task_id, title, description, reward::text AS reward, is_active,
        sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
        padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
        version::text AS version, created_at, updated_at, deleted_at
    `);
    const targetAfter = { ...target, isActive: false, version: input.expectedTaskVersion + 1,
      updatedAt: now.toISOString(), deletedAt: now.toISOString() };
    assertSingleDeletedTask(updated.rows, targetAfter, now);
    if (mirrors.length > 0) {
      const deleted = await tx.execute(sql`
        DELETE FROM task_allowed_students WHERE tenant_id=${dependencies.tenantId}
          AND task_instance_id=${target.taskInstanceId}
        RETURNING task_instance_id, student_id, created_at
      `);
      assertMirrorSubset(deleted.rows, mirrors);
    }
    let insertedAssignments: readonly UpdateAssignment[] = [];
    if (mirrors.length > 0) {
      const inserted = await tx.execute(sql`
        INSERT INTO task_assignments
          (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
           cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
           source, previous_assignment_id, admin_operation_id, admin_operation_hash,
           created_at, schema_version, note)
        VALUES ${sql.join(mirrors.map((mirror, index) => sql`
          (${dependencies.tenantId}, ${assignmentEventIds[index]}, ${input.taskId},
           ${target.taskInstanceId}, ${cycle.cycleId}, ${new Date(cycle.startsAt)},
           ${cycle.endsAt ? new Date(cycle.endsAt) : null}, ${effectiveSchedule.ruleVersion},
           ${effectiveSchedule.timeZone}, ${mirror.studentId}, 'UNASSIGNED', 'ADMIN',
           ${previousByStudent.get(mirror.studentId)?.assignment_id ?? null}, ${input.operationId},
           ${payloadHash}, ${now}, 1, NULL)
        `), sql`, `)}
        RETURNING assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
          task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
          student_id, event_type, source, previous_assignment_id, admin_operation_id,
          admin_operation_hash, created_at, schema_version, note
      `);
      insertedAssignments = parseUpdateAssignments(inserted.rows, now);
      assertInsertedUpdateAssignments(insertedAssignments,
        mirrors.map((mirror) => ({ studentId: mirror.studentId, eventType: 'UNASSIGNED' as const })),
        assignmentEventIds, target, cycle, effectiveSchedule,
        new Map([...previousByStudent].map(([studentId, event]) => [studentId, event.assignment_id])),
        { ...input, title: target.title, description: target.description, reward: target.reward,
          isActive: false, sortOrder: target.sortOrder, allowedStudentIds: [], availableFrom: null,
          dueAt: null, prerequisiteTaskId: null, padletBoardId: null }, payloadHash, now);
    }
    const evidence: DeleteEvidence = { input, payloadHash, now, targetBefore: target, targetAfter,
      assignments: [...oldAssignments, ...insertedAssignments], completions, assignmentEventIds };
    await assertDeleteState(tx, dependencies.tenantId, evidence);
    const result = freezeDeleteResult({ ok: true, operationId: input.operationId, action: 'DELETE',
      completedAt: now.toISOString(), tasks: [{ taskId: input.taskId,
        taskInstanceId: target.taskInstanceId, versionBefore: input.expectedTaskVersion,
        versionAfter: input.expectedTaskVersion + 1, assignmentEventIds }] });
    const audit = deleteAuditInput(result, now);
    await appendOperationAudit(tx, dependencies.tenantId, audit);
    await assertDeleteAudit(tx, dependencies.tenantId, audit);
    const terminal = await tx.execute(sql`
      UPDATE operations SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
        finished_at=${now}, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
      RETURNING operation_id
    `);
    if (terminal.rows.length !== 1
      || (terminal.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
      throw new Error('Task administration terminal operation integrity check failed.');
    }
    await assertDeleteState(tx, dependencies.tenantId, evidence);
    const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (!stored) throw new Error('Task administration terminal operation integrity check failed.');
    return resolveDeleteReplay(tx, dependencies.tenantId, stored, input, payloadHash);
  });
}

type CanonicalUpdateInput = Omit<UpdateTaskAdminInput, 'allowedStudentIds'> & {
  allowedStudentIds: readonly string[];
  availableFrom: string | null;
  dueAt: string | null;
  prerequisiteTaskId: string | null;
  padletBoardId: string | null;
};

type LockedUpdateTask = Readonly<{
  taskInstanceId: string; taskId: string; title: string; description: string; reward: number;
  isActive: boolean; sortOrder: number; availableFrom: string | null; availableUntil: string | null;
  dueAt: string | null; prerequisiteTaskInstanceId: string | null; padletBoardId: string | null;
  currentSchedule: TaskSchedule; pendingSchedule: TaskSchedule | null; scheduleSchemaVersion: 1;
  version: number; createdAt: string; updatedAt: string; deletedAt: null;
}>;

type UpdateAssignment = Readonly<{
  assignment_id: string; event_sequence: string; task_id_snapshot: string;
  task_instance_id: string; cycle_id: string; cycle_start_at: string; cycle_end_at: string | null;
  rule_version: number; timezone: string; student_id: string; event_type: string; source: string;
  previous_assignment_id: string | null; admin_operation_id: string | null;
  admin_operation_hash: string | null; created_at: string; schema_version: number; note: string | null;
}>;

type CompletionEvidence = Readonly<Record<(typeof COMPLETION_ROW_KEYS)[number],
  string | number | null>>;

type UpdateEvidence = Readonly<{
  input: CanonicalUpdateInput; payloadHash: string; now: Date; target: LockedUpdateTask;
  prerequisiteTaskInstanceId: string | null; desiredMirrors: readonly Readonly<{
    taskInstanceId: string; studentId: string; createdAt: string;
  }>[]; assignments: readonly UpdateAssignment[]; completions: readonly CompletionEvidence[];
  assignmentEventIds: readonly string[];
}>;

const UPDATE_REQUIRED_KEYS = [
  'operationId', 'taskId', 'expectedTaskVersion', 'title', 'description', 'reward',
  'isActive', 'sortOrder', 'allowedStudentIds',
] as const;
const UPDATE_KEYS = [
  ...UPDATE_REQUIRED_KEYS, 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId',
] as const;
const FULL_TASK_ROW_KEYS = [
  'task_instance_id', 'task_id', 'title', 'description', 'reward', 'is_active', 'sort_order',
  'available_from', 'available_until', 'due_at', 'prerequisite_task_instance_id',
  'padlet_board_id', 'current_schedule', 'pending_schedule', 'schedule_schema_version',
  'version', 'created_at', 'updated_at', 'deleted_at',
] as const;
const UPDATE_ASSIGNMENT_ROW_KEYS = [
  'assignment_id', 'event_sequence', 'task_id_snapshot', 'task_instance_id', 'cycle_id',
  'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'student_id', 'event_type',
  'source', 'previous_assignment_id', 'admin_operation_id', 'admin_operation_hash',
  'created_at', 'schema_version', 'note',
] as const;
const COMPLETION_ROW_KEYS = [
  'completion_id', 'event_sequence', 'completed_at', 'task_instance_id', 'task_id_snapshot',
  'task_name_snapshot', 'student_id', 'student_name_snapshot', 'reward_snapshot',
  'balance_before', 'balance_after', 'status', 'note', 'cycle_id', 'cycle_start_at',
  'cycle_end_at', 'rule_version', 'timezone', 'source', 'assignment_id', 'transaction_id',
  'operation_id', 'operation_hash', 'admin_operation_id', 'admin_operation_hash',
  'schema_version', 'evidence_provider', 'evidence_board_id', 'evidence_post_id',
  'evidence_created_at', 'evidence_author_full_name', 'created_at',
] as const;

function canonicalUpdate(raw: UpdateTaskAdminInput): CanonicalUpdateInput {
  const input = exactRecordOptional(raw, UPDATE_REQUIRED_KEYS, UPDATE_KEYS, 'task update input');
  const expectedTaskVersion = safeInteger(input.expectedTaskVersion, 'expected task version',
    1, Number.MAX_SAFE_INTEGER - 1);
  const allowedStudentIds = exactArray(input.allowedStudentIds, 'allowed student IDs')
    .map((value) => canonicalId(value, 'student ID')).sort(compareText);
  if (new Set(allowedStudentIds).size !== allowedStudentIds.length) {
    throw new Error('Duplicate allowed student ID.');
  }
  const availableFrom = optionalInstant(input.availableFrom, 'availableFrom');
  const dueAt = optionalInstant(input.dueAt, 'dueAt');
  if (availableFrom !== null && dueAt !== null && Date.parse(dueAt) <= Date.parse(availableFrom)) {
    throw new Error('Task dueAt must be after availableFrom.');
  }
  const padletBoardId = optionalId(input.padletBoardId, 'Padlet board ID');
  if (padletBoardId !== null && !PADLET_BOARD_ID.test(padletBoardId)) {
    throw new Error('Padlet board ID must be 16 to 22 alphanumeric characters.');
  }
  if (typeof input.isActive !== 'boolean') throw new Error('Task active flag must be boolean.');
  return {
    operationId: canonicalId(input.operationId, 'operation ID'),
    taskId: canonicalId(input.taskId, 'task ID'), expectedTaskVersion,
    title: canonicalText(input.title, 'task title', false),
    description: canonicalString(input.description, 'task description').trim(),
    reward: safeInteger(input.reward, 'task reward', 0, Number.MAX_SAFE_INTEGER),
    isActive: input.isActive,
    sortOrder: safeInteger(input.sortOrder, 'task sort order', INT32_MIN, INT32_MAX),
    allowedStudentIds, availableFrom, dueAt,
    prerequisiteTaskId: optionalId(input.prerequisiteTaskId, 'prerequisite task ID'),
    padletBoardId,
  };
}

function updatePayloadHash(input: CanonicalUpdateInput): string {
  return sha256({ kind: 'TASK_ADMIN', action: 'UPDATE', tasks: [{
    taskId: input.taskId, expectedTaskVersion: input.expectedTaskVersion, title: input.title,
    description: input.description, reward: input.reward, isActive: input.isActive,
    sortOrder: input.sortOrder, allowedStudentIds: input.allowedStudentIds,
    availableFrom: input.availableFrom, dueAt: input.dueAt,
    prerequisiteTaskId: input.prerequisiteTaskId, padletBoardId: input.padletBoardId,
  }], schemaVersion: 1 });
}

async function updateTaskDefinition(
  dependencies: DatabaseTaskAdminCommandDependencies,
  rawInput: UpdateTaskAdminInput,
): Promise<TaskAdminUpdateSuccess> {
  const input = canonicalUpdate(rawInput);
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Task administration current timestamp is invalid.');
  }
  const payloadHash = updatePayloadHash(input);
  return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
    const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (existing) return resolveUpdateReplay(tx, dependencies.tenantId, existing, input, payloadHash);
    const claim = await tx.execute(sql`
      INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
      VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${payloadHash},
              'PENDING', 1, ${now}, ${now}, ${now})
      ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id
    `);
    if (claim.rows.length !== 1
      || (claim.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
      if (claim.rows.length !== 0) throw new Error('Task administration operation claim integrity check failed.');
      const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (!winner) throw new Error('Task administration operation race integrity check failed.');
      return resolveUpdateReplay(tx, dependencies.tenantId, winner, input, payloadHash);
    }

    const taskRows = await tx.execute(sql`
      SELECT task_instance_id, task_id, title, description, reward::text AS reward, is_active,
             sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
             padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
             version::text AS version, created_at, updated_at, deleted_at
      FROM tasks WHERE tenant_id=${dependencies.tenantId} AND deleted_at IS NULL
      ORDER BY task_instance_id FOR UPDATE
    `);
    const tasks = parseLockedUpdateTasks(taskRows.rows, now);
    assertCompleteTaskGraph(tasks);
    const matches = tasks.filter((task) => task.taskId === input.taskId);
    if (matches.length !== 1) throw new Error('Task administration update target not found.');
    const target = matches[0];
    if (target.version !== input.expectedTaskVersion) {
      throw new Error('Task administration stale task version.');
    }
    let prerequisiteTaskInstanceId: string | null = null;
    if (input.prerequisiteTaskId !== null) {
      if (input.prerequisiteTaskId === input.taskId) {
        throw new Error('Task administration prerequisite cycle is not allowed.');
      }
      const prerequisite = tasks.filter((task) => task.taskId === input.prerequisiteTaskId);
      if (prerequisite.length !== 1) throw new Error('Task administration prerequisite task not found.');
      prerequisiteTaskInstanceId = prerequisite[0].taskInstanceId;
    }
    const proposed = tasks.map((task) => task.taskInstanceId === target.taskInstanceId
      ? { ...task, prerequisiteTaskInstanceId } : task);
    assertCompleteTaskGraph(proposed);

    if (input.allowedStudentIds.length > 0) {
      const students = await tx.execute(sql`
        SELECT student_id, status FROM students
        WHERE tenant_id=${dependencies.tenantId}
          AND student_id IN (${sql.join(input.allowedStudentIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY student_id FOR UPDATE
      `);
      assertExactActiveStudents(students.rows, input.allowedStudentIds);
    }

    const mirrorLock = await tx.execute(sql`
      SELECT task_instance_id, student_id, created_at FROM task_allowed_students
      WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${target.taskInstanceId}
      ORDER BY student_id FOR UPDATE
    `);
    const currentMirrors = parseLockedMirrors(mirrorLock.rows, target.taskInstanceId, now);
    const currentIds = currentMirrors.map((row) => row.studentId).sort(compareText);
    const additions = input.allowedStudentIds.filter((id) => !currentIds.includes(id));
    const removals = currentIds.filter((id) => !input.allowedStudentIds.includes(id));

    const assignmentLock = await tx.execute(sql`
      SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
             task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
             student_id, event_type, source, previous_assignment_id, admin_operation_id,
             admin_operation_hash, created_at, schema_version, note
      FROM task_assignments WHERE tenant_id=${dependencies.tenantId}
        AND task_instance_id=${target.taskInstanceId}
      ORDER BY student_id, event_sequence FOR UPDATE
    `);
    const oldAssignments = parseUpdateAssignments(assignmentLock.rows, now);
    assertUpdateAssignmentChains(oldAssignments);
    const effectiveSchedule = resolveTaskSchedule({ currentSchedule: target.currentSchedule,
      pendingSchedule: target.pendingSchedule, now: now.toISOString() });
    const cycle = getTaskCycle({ taskInstanceId: target.taskInstanceId, schedule: effectiveSchedule,
      taskCreatedAt: target.createdAt, now: now.toISOString() });
    const previousByStudent = new Map<string, UpdateAssignment>();
    const cycleStart = new Date(cycle.startsAt).toISOString();
    const cycleEnd = cycle.endsAt ? new Date(cycle.endsAt).toISOString() : null;
    for (const event of oldAssignments) {
      if (event.task_id_snapshot !== target.taskId || event.task_instance_id !== target.taskInstanceId) {
        throw new Error('Task administration assignment event integrity check failed.');
      }
      const sameCycle = event.cycle_id === cycle.cycleId && event.cycle_start_at === cycleStart
        && event.cycle_end_at === cycleEnd && event.rule_version === effectiveSchedule.ruleVersion
        && event.timezone === effectiveSchedule.timeZone;
      if (sameCycle) {
        const selected = previousByStudent.get(event.student_id);
        if (!selected || Number(event.event_sequence) > Number(selected.event_sequence)) {
          previousByStudent.set(event.student_id, event);
        }
      }
    }
    const changes = [
      ...additions.map((studentId) => ({ studentId, eventType: 'ASSIGNED' as const })),
      ...removals.map((studentId) => ({ studentId, eventType: 'UNASSIGNED' as const })),
    ].sort((a, b) => compareText(a.studentId, b.studentId));
    const predecessorIds = new Map([...previousByStudent]
      .map(([studentId, event]) => [studentId, event.assignment_id]));
    const assignmentEventIds = changes.map((change) => createTaskAdminAssignmentEventId(
      input.operationId, input.taskId, change.studentId, change.eventType));

    const completionLock = await tx.execute(sql`
      SELECT completion_id, event_sequence::text AS event_sequence, completed_at,
        task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
        student_name_snapshot, reward_snapshot::text AS reward_snapshot,
        balance_before::text AS balance_before, balance_after::text AS balance_after,
        status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source,
        assignment_id, transaction_id, operation_id, operation_hash, admin_operation_id,
        admin_operation_hash, schema_version, evidence_provider, evidence_board_id,
        evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
      FROM task_completions
      WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${target.taskInstanceId}
      ORDER BY event_sequence FOR UPDATE
    `);
    const completions = parseCompletionSnapshots(completionLock.rows);

    const updated = await tx.execute(sql`
      UPDATE tasks SET title=${input.title}, description=${input.description}, reward=${input.reward},
        is_active=${input.isActive}, sort_order=${input.sortOrder},
        available_from=${input.availableFrom ? new Date(input.availableFrom) : null},
        due_at=${input.dueAt ? new Date(input.dueAt) : null},
        prerequisite_task_instance_id=${prerequisiteTaskInstanceId},
        padlet_board_id=${input.padletBoardId}, version=version + 1, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${target.taskInstanceId}
        AND deleted_at IS NULL AND version=${input.expectedTaskVersion}
      RETURNING task_instance_id, task_id, title, description, reward::text AS reward, is_active,
        sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
        padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
        version::text AS version, created_at, updated_at, deleted_at
    `);
    const expectedTask: LockedUpdateTask = { ...target, title: input.title,
      description: input.description, reward: input.reward, isActive: input.isActive,
      sortOrder: input.sortOrder, availableFrom: input.availableFrom, dueAt: input.dueAt,
      prerequisiteTaskInstanceId, padletBoardId: input.padletBoardId,
      version: input.expectedTaskVersion + 1, updatedAt: now.toISOString() };
    assertSingleUpdatedTask(updated.rows, expectedTask, now);

    if (removals.length > 0) {
      const deleted = await tx.execute(sql`
        DELETE FROM task_allowed_students WHERE tenant_id=${dependencies.tenantId}
          AND task_instance_id=${target.taskInstanceId}
          AND student_id IN (${sql.join(removals.map((id) => sql`${id}`), sql`, `)})
        RETURNING task_instance_id, student_id, created_at
      `);
      assertMirrorSubset(deleted.rows, currentMirrors.filter((row) => removals.includes(row.studentId)));
    }
    let addedMirrors: readonly ReturnType<typeof parseLockedMirrors>[number][] = [];
    if (additions.length > 0) {
      const inserted = await tx.execute(sql`
        INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id, created_at)
        VALUES ${sql.join(additions.map((studentId) =>
          sql`(${dependencies.tenantId}, ${target.taskInstanceId}, ${studentId}, ${now})`), sql`, `)}
        RETURNING task_instance_id, student_id, created_at
      `);
      addedMirrors = parseLockedMirrors(inserted.rows, target.taskInstanceId, now);
      if (addedMirrors.length !== additions.length
        || additions.some((id) => !addedMirrors.some((row) => row.studentId === id))) {
        throw new Error('Task administration allowed-student mirror integrity check failed.');
      }
    }
    const desiredMirrors = [...currentMirrors.filter((row) => !removals.includes(row.studentId)),
      ...addedMirrors].sort((a, b) => compareText(a.studentId, b.studentId));

    let insertedAssignments: readonly UpdateAssignment[] = [];
    if (changes.length > 0) {
      const assignmentInsert = await tx.execute(sql`
        INSERT INTO task_assignments
          (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
           cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
           source, previous_assignment_id, admin_operation_id, admin_operation_hash,
           created_at, schema_version, note)
        VALUES ${sql.join(changes.map((change, index) => sql`
          (${dependencies.tenantId}, ${assignmentEventIds[index]}, ${input.taskId},
           ${target.taskInstanceId}, ${cycle.cycleId}, ${new Date(cycle.startsAt)},
           ${cycle.endsAt ? new Date(cycle.endsAt) : null}, ${effectiveSchedule.ruleVersion},
           ${effectiveSchedule.timeZone}, ${change.studentId}, ${change.eventType}, 'ADMIN',
           ${predecessorIds.get(change.studentId) ?? null}, ${input.operationId}, ${payloadHash},
           ${now}, 1, NULL)
        `), sql`, `)}
        RETURNING assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
          task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
          student_id, event_type, source, previous_assignment_id, admin_operation_id,
          admin_operation_hash, created_at, schema_version, note
      `);
      insertedAssignments = parseUpdateAssignments(assignmentInsert.rows, now);
      assertInsertedUpdateAssignments(insertedAssignments, changes, assignmentEventIds, target,
        cycle, effectiveSchedule, predecessorIds, input, payloadHash, now);
    }
    const evidence: UpdateEvidence = { input, payloadHash, now, target: expectedTask,
      prerequisiteTaskInstanceId, desiredMirrors,
      assignments: [...oldAssignments, ...insertedAssignments], completions, assignmentEventIds };
    await assertUpdateState(tx, dependencies.tenantId, evidence);
    const result = freezeUpdateResult({ ok: true, operationId: input.operationId, action: 'UPDATE',
      completedAt: now.toISOString(), tasks: [{ taskId: input.taskId,
        taskInstanceId: target.taskInstanceId, versionBefore: input.expectedTaskVersion,
        versionAfter: input.expectedTaskVersion + 1, assignmentEventIds }] });
    const audit = updateAuditInput(result, now);
    await appendOperationAudit(tx, dependencies.tenantId, audit);
    await assertUpdateAudit(tx, dependencies.tenantId, audit);
    const terminal = await tx.execute(sql`
      UPDATE operations SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
        finished_at=${now}, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
      RETURNING operation_id
    `);
    if (terminal.rows.length !== 1
      || (terminal.rows[0] as { operation_id?: unknown } | undefined)?.operation_id !== input.operationId) {
      throw new Error('Task administration terminal operation integrity check failed.');
    }
    await assertUpdateState(tx, dependencies.tenantId, evidence);
    const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
    if (!stored) throw new Error('Task administration terminal operation integrity check failed.');
    return resolveUpdateReplay(tx, dependencies.tenantId, stored, input, payloadHash);
  });
}

function parseLockedUpdateTasks(rows: readonly unknown[], now: Date): LockedUpdateTask[] {
  const failure = 'Task administration live-task integrity check failed.';
  const parsed = rows.map((raw) => {
    const row = exactEvidenceRecord(raw, FULL_TASK_ROW_KEYS, failure);
    if (row.deleted_at !== null || row.schedule_schema_version !== 1) throw new Error(failure);
    const createdAt = evidenceTimestamp(row.created_at, failure);
    const updatedAt = evidenceTimestamp(row.updated_at, failure);
    if (Date.parse(createdAt) > Date.parse(updatedAt) || Date.parse(updatedAt) > now.getTime()) {
      throw new Error('Task administration live-task chronology integrity check failed.');
    }
    const reward = canonicalDatabaseInteger(row.reward, 0, Number.MAX_SAFE_INTEGER, failure);
    const version = canonicalDatabaseInteger(row.version, 1, Number.MAX_SAFE_INTEGER, failure);
    if (typeof row.title !== 'string' || typeof row.description !== 'string'
      || typeof row.is_active !== 'boolean' || typeof row.sort_order !== 'number'
      || !Number.isSafeInteger(row.sort_order) || row.sort_order < INT32_MIN || row.sort_order > INT32_MAX) {
      throw new Error(failure);
    }
    return {
      taskInstanceId: exactDatabaseId(row.task_instance_id), taskId: exactDatabaseId(row.task_id),
      title: row.title, description: row.description, reward, isActive: row.is_active,
      sortOrder: row.sort_order, availableFrom: nullableEvidenceTimestamp(row.available_from, failure),
      availableUntil: nullableEvidenceTimestamp(row.available_until, failure),
      dueAt: nullableEvidenceTimestamp(row.due_at, failure),
      prerequisiteTaskInstanceId: row.prerequisite_task_instance_id === null ? null
        : exactDatabaseId(row.prerequisite_task_instance_id),
      padletBoardId: row.padlet_board_id === null ? null : exactDatabaseId(row.padlet_board_id),
      currentSchedule: parseStoredSchedule(row.current_schedule, failure),
      pendingSchedule: row.pending_schedule === null ? null : parseStoredSchedule(row.pending_schedule, failure),
      scheduleSchemaVersion: 1 as const, version, createdAt, updatedAt, deletedAt: null,
    };
  });
  if (new Set(parsed.map((row) => row.taskInstanceId)).size !== parsed.length
    || new Set(parsed.map((row) => row.taskId)).size !== parsed.length) throw new Error(failure);
  return parsed;
}

function parseStoredSchedule(raw: unknown, failure: string): TaskSchedule {
  try {
    const value = exactRecord(raw, ['ruleVersion', 'effectiveFrom', 'timeZone', 'recurrence',
      'resetCompletionOnCycle', 'resetAssignmentOnCycle'] as const, 'stored task schedule');
    const ruleVersion = safeInteger(value.ruleVersion, 'stored schedule rule version', 1,
      Number.MAX_SAFE_INTEGER);
    const effectiveFrom = strictCanonicalInstant(value.effectiveFrom, 'stored schedule effectiveFrom');
    if (value.timeZone !== 'Asia/Seoul' || typeof value.resetCompletionOnCycle !== 'boolean'
      || typeof value.resetAssignmentOnCycle !== 'boolean') throw new Error(failure);
    return { ruleVersion, effectiveFrom, timeZone: 'Asia/Seoul',
      recurrence: canonicalRecurrence(value.recurrence),
      resetCompletionOnCycle: value.resetCompletionOnCycle,
      resetAssignmentOnCycle: value.resetAssignmentOnCycle };
  } catch { throw new Error(failure); }
}

function assertCompleteTaskGraph(tasks: readonly LockedUpdateTask[]) {
  const byId = new Map(tasks.map((task) => [task.taskInstanceId, task]));
  for (const start of tasks) {
    const visited = new Set<string>();
    let current: LockedUpdateTask | undefined = start;
    while (current) {
      if (visited.has(current.taskInstanceId)) {
        throw new Error('Task administration prerequisite cycle is not allowed.');
      }
      visited.add(current.taskInstanceId);
      if (current.prerequisiteTaskInstanceId === null) break;
      current = byId.get(current.prerequisiteTaskInstanceId);
      if (!current) throw new Error('Task administration prerequisite chain integrity check failed.');
    }
  }
}

function parseLockedMirrors(rows: readonly unknown[], taskInstanceId: string, now: Date) {
  const failure = 'Task administration allowed-student mirror integrity check failed.';
  const parsed = rows.map((raw) => {
    const row = exactEvidenceRecord(raw, MIRROR_ROW_KEYS, failure);
    const createdAt = evidenceTimestamp(row.created_at, failure);
    const instance = exactDatabaseId(row.task_instance_id);
    if (instance !== taskInstanceId || Date.parse(createdAt) > now.getTime()) throw new Error(failure);
    return { taskInstanceId: instance, studentId: exactDatabaseId(row.student_id), createdAt };
  });
  if (new Set(parsed.map((row) => row.studentId)).size !== parsed.length) throw new Error(failure);
  return parsed;
}

function parseUpdateAssignments(rows: readonly unknown[], now: Date): UpdateAssignment[] {
  const failure = 'Task administration assignment event integrity check failed.';
  const parsed = rows.map((raw) => {
    const row = exactEvidenceRecord(raw, UPDATE_ASSIGNMENT_ROW_KEYS, failure);
    const createdAt = evidenceTimestamp(row.created_at, failure);
    if (Date.parse(createdAt) > now.getTime()) throw new Error(failure);
    const eventSequence = canonicalDatabaseInteger(row.event_sequence, 1, Number.MAX_SAFE_INTEGER, failure);
    const nullableId = (value: unknown) => value === null ? null : exactDatabaseId(value);
    const cycleStartAt = evidenceTimestamp(row.cycle_start_at, failure);
    const cycleEndAt = nullableEvidenceTimestamp(row.cycle_end_at, failure);
    const ruleVersion = evidenceInteger(row.rule_version, failure);
    const schemaVersion = evidenceInteger(row.schema_version, failure);
    const eventType = evidenceString(row.event_type, failure);
    const source = evidenceString(row.source, failure);
    const timezone = evidenceString(row.timezone, failure);
    const assignmentId = exactDatabaseId(row.assignment_id);
    const taskInstanceId = exactDatabaseId(row.task_instance_id);
    const cycleId = exactDatabaseId(row.cycle_id);
    const previousAssignmentId = nullableId(row.previous_assignment_id);
    const adminOperationId = nullableId(row.admin_operation_id);
    const adminOperationHash = row.admin_operation_hash === null ? null
      : evidenceString(row.admin_operation_hash, failure);
    const canonicalCyclePrefix = `v1|${taskInstanceId}|r${ruleVersion}|`;
    const canonicalCycleStart = cycleStartAt.endsWith('.000Z')
      ? cycleStartAt.slice(0, -5) + 'Z' : cycleStartAt;
    if (!['ASSIGNED', 'UNASSIGNED'].includes(eventType)
      || !['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(source)
      || timezone !== 'Asia/Seoul' || ruleVersion < 1 || schemaVersion !== 1
      || cycleId !== canonicalCyclePrefix + canonicalCycleStart
      || Date.parse(cycleStartAt) > Date.parse(createdAt)
      || cycleEndAt !== null && Date.parse(cycleEndAt) <= Date.parse(cycleStartAt)
      || previousAssignmentId === assignmentId
      || ['ADMIN', 'QR'].includes(source) && (adminOperationId === null
        || adminOperationHash === null || !/^[a-f0-9]{64}$/.test(adminOperationHash))
      || !['ADMIN', 'QR'].includes(source) && (adminOperationId !== null || adminOperationHash !== null)) {
      throw new Error(failure);
    }
    return {
      assignment_id: assignmentId, event_sequence: String(eventSequence),
      task_id_snapshot: exactDatabaseId(row.task_id_snapshot),
      task_instance_id: taskInstanceId, cycle_id: cycleId,
      cycle_start_at: cycleStartAt, cycle_end_at: cycleEndAt,
      rule_version: ruleVersion, timezone,
      student_id: exactDatabaseId(row.student_id), event_type: eventType,
      source, previous_assignment_id: previousAssignmentId,
      admin_operation_id: adminOperationId, admin_operation_hash: adminOperationHash,
      created_at: createdAt, schema_version: schemaVersion,
      note: row.note === null ? null : evidenceString(row.note, failure),
    };
  });
  if (new Set(parsed.map((row) => row.assignment_id)).size !== parsed.length
    || new Set(parsed.map((row) => row.event_sequence)).size !== parsed.length) throw new Error(failure);
  return parsed;
}

function assertUpdateAssignmentChains(assignments: readonly UpdateAssignment[]): void {
  const failure = 'Task administration assignment event integrity check failed.';
  const byId = new Map(assignments.map((event) => [event.assignment_id, event]));
  const chains = new Map<string, UpdateAssignment[]>();
  for (const event of assignments) {
    const key = stableJson([event.task_instance_id, event.student_id, event.cycle_id,
      event.cycle_start_at, event.cycle_end_at, event.rule_version, event.timezone]);
    const chain = chains.get(key) ?? [];
    chain.push(event);
    chains.set(key, chain);
  }
  for (const chain of chains.values()) {
    chain.sort((left, right) => Number(left.event_sequence) - Number(right.event_sequence));
    chain.forEach((event, index) => {
      if (event.source === 'LEGACY_SEED') {
        if (event.previous_assignment_id !== null) throw new Error(failure);
        return;
      }
      if (event.source !== 'CARRY_FORWARD') {
        const immediate = chain[index - 1];
        if (event.previous_assignment_id !== (immediate?.assignment_id ?? null)
          || (immediate && Date.parse(immediate.created_at) > Date.parse(event.created_at))) {
          throw new Error(failure);
        }
        return;
      }
      const previous = event.previous_assignment_id === null ? undefined : byId.get(event.previous_assignment_id);
      if (!previous || previous.event_type !== 'ASSIGNED'
        || previous.task_instance_id !== event.task_instance_id
        || previous.task_id_snapshot !== event.task_id_snapshot
        || previous.student_id !== event.student_id
        || previous.cycle_id === event.cycle_id
        || Number(previous.event_sequence) >= Number(event.event_sequence)
        || Date.parse(previous.created_at) > Date.parse(event.created_at)
        || previous.cycle_end_at === null
        || Date.parse(previous.cycle_end_at) > Date.parse(event.cycle_start_at)) throw new Error(failure);
    });
  }
}

function parseCompletionSnapshots(rows: readonly unknown[]): CompletionEvidence[] {
  const failure = 'Task administration completion event integrity check failed.';
  const databaseId = (value: unknown) => {
    try {
      return exactDatabaseId(value);
    } catch {
      throw new Error(failure);
    }
  };
  const parsed = rows.map((raw): CompletionEvidence => {
    const row = exactEvidenceRecord(raw, COMPLETION_ROW_KEYS, failure);
    const completionId = databaseId(row.completion_id);
    const eventSequence = canonicalDatabaseInteger(row.event_sequence, 1, Number.MAX_SAFE_INTEGER, failure);
    const completedAt = evidenceTimestamp(row.completed_at, failure);
    const createdAt = evidenceTimestamp(row.created_at, failure);
    const taskInstanceId = databaseId(row.task_instance_id);
    const taskId = databaseId(row.task_id_snapshot);
    const studentId = databaseId(row.student_id);
    const taskName = databaseId(row.task_name_snapshot);
    const studentName = databaseId(row.student_name_snapshot);
    const reward = canonicalDatabaseInteger(row.reward_snapshot, 0, Number.MAX_SAFE_INTEGER, failure);
    const balanceBefore = canonicalSignedDatabaseInteger(row.balance_before, failure);
    const balanceAfter = canonicalSignedDatabaseInteger(row.balance_after, failure);
    const status = evidenceString(row.status, failure);
    const cycleId = databaseId(row.cycle_id);
    const cycleStartAt = evidenceTimestamp(row.cycle_start_at, failure);
    const cycleEndAt = nullableEvidenceTimestamp(row.cycle_end_at, failure);
    const ruleVersion = evidenceInteger(row.rule_version, failure);
    const timezone = evidenceString(row.timezone, failure);
    const source = evidenceString(row.source, failure);
    const schemaVersion = evidenceInteger(row.schema_version, failure);
    const nullableId = (value: unknown) => value === null ? null : databaseId(value);
    const assignmentId = nullableId(row.assignment_id);
    const transactionId = nullableId(row.transaction_id);
    const operationId = nullableId(row.operation_id);
    const operationHash = row.operation_hash === null ? null : evidenceString(row.operation_hash, failure);
    const adminOperationId = nullableId(row.admin_operation_id);
    const adminOperationHash = row.admin_operation_hash === null ? null
      : evidenceString(row.admin_operation_hash, failure);
    const expectedCycleStart = cycleStartAt.endsWith('.000Z')
      ? cycleStartAt.slice(0, -5) + 'Z' : cycleStartAt;
    const operationPair = operationId !== null && operationHash !== null;
    const adminPair = adminOperationId !== null && adminOperationHash !== null;
    if (!['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'].includes(source)
      || !['COMPLETED', 'CANCELLED'].includes(status) || schemaVersion !== 1
      || timezone !== 'Asia/Seoul' || ruleVersion < 1
      || cycleId !== `v1|${taskInstanceId}|r${ruleVersion}|${expectedCycleStart}`
      || Date.parse(cycleStartAt) > Date.parse(completedAt)
      || Date.parse(completedAt) > Date.parse(createdAt)
      || cycleEndAt !== null && (Date.parse(cycleEndAt) <= Date.parse(cycleStartAt)
        || Date.parse(completedAt) >= Date.parse(cycleEndAt))
      || (operationId === null) !== (operationHash === null)
      || (adminOperationId === null) !== (adminOperationHash === null)
      || operationHash !== null && !/^[a-f0-9]{64}$/.test(operationHash)
      || adminOperationHash !== null && !/^[a-f0-9]{64}$/.test(adminOperationHash)
      || source === 'BANK' && (status !== 'COMPLETED' || assignmentId === null || !operationPair
        || adminPair || !Number.isSafeInteger(balanceBefore + reward)
        || balanceAfter !== balanceBefore + reward)
      || source === 'ADMIN' && (status !== 'COMPLETED' || reward !== 0
        || balanceAfter !== balanceBefore || operationPair || !adminPair)
      || source === 'ADMIN_RESET' && (status !== 'CANCELLED' || reward !== 0
        || balanceAfter !== balanceBefore || operationPair || !adminPair)
      || source === 'CARRY_FORWARD' && (status !== 'COMPLETED' || reward !== 0
        || balanceAfter !== balanceBefore || operationPair || adminPair)) throw new Error(failure);
    const evidenceValues = [row.evidence_provider, row.evidence_board_id, row.evidence_post_id,
      row.evidence_created_at, row.evidence_author_full_name];
    const evidenceCount = evidenceValues.filter((value) => value !== null).length;
    let evidenceCreatedAt: string | null = null;
    if (evidenceCount !== 0) {
      if (evidenceCount !== evidenceValues.length || source !== 'BANK' || !operationPair
        || row.evidence_provider !== 'PADLET') throw new Error(failure);
      const board = databaseId(row.evidence_board_id);
      const post = databaseId(row.evidence_post_id);
      const author = databaseId(row.evidence_author_full_name);
      evidenceCreatedAt = evidenceTimestamp(row.evidence_created_at, failure);
      if (!PADLET_BOARD_ID.test(board) || !/^[A-Za-z0-9_-]{3,128}$/.test(post)
        || author.length > 200 || author !== studentName
        || Date.parse(evidenceCreatedAt) < Date.parse(cycleStartAt)
        || cycleEndAt !== null && Date.parse(evidenceCreatedAt) >= Date.parse(cycleEndAt)
        || Date.parse(evidenceCreatedAt) > Date.parse(completedAt)) throw new Error(failure);
    }
    return {
      completion_id: completionId, event_sequence: String(eventSequence), completed_at: completedAt,
      task_instance_id: taskInstanceId, task_id_snapshot: taskId, task_name_snapshot: taskName,
      student_id: studentId, student_name_snapshot: studentName, reward_snapshot: String(reward),
      balance_before: String(balanceBefore), balance_after: String(balanceAfter), status,
      note: row.note === null ? null : evidenceString(row.note, failure), cycle_id: cycleId,
      cycle_start_at: cycleStartAt, cycle_end_at: cycleEndAt, rule_version: ruleVersion,
      timezone, source, assignment_id: assignmentId, transaction_id: transactionId,
      operation_id: operationId, operation_hash: operationHash, admin_operation_id: adminOperationId,
      admin_operation_hash: adminOperationHash, schema_version: schemaVersion,
      evidence_provider: row.evidence_provider as string | null,
      evidence_board_id: row.evidence_board_id as string | null,
      evidence_post_id: row.evidence_post_id as string | null,
      evidence_created_at: evidenceCreatedAt,
      evidence_author_full_name: row.evidence_author_full_name as string | null, created_at: createdAt,
    };
  });
  if (new Set(parsed.map((row) => row.completion_id)).size !== parsed.length
    || new Set(parsed.map((row) => row.event_sequence)).size !== parsed.length) throw new Error(failure);
  return parsed;
}

function assertSingleUpdatedTask(rows: readonly unknown[], expected: LockedUpdateTask, now: Date) {
  const parsed = parseLockedUpdateTasks(rows, now);
  if (parsed.length !== 1 || stableJson(parsed[0]) !== stableJson(expected)) {
    throw new Error('Task administration task row integrity check failed.');
  }
}

function assertMirrorSubset(rows: readonly unknown[], expected: readonly ReturnType<typeof parseLockedMirrors>[number][]) {
  const now = new Date(8640000000000000);
  const actual = parseLockedMirrors(rows, expected[0]?.taskInstanceId ?? '', now)
    .sort((a, b) => compareText(a.studentId, b.studentId));
  const wanted = [...expected].sort((a, b) => compareText(a.studentId, b.studentId));
  if (stableJson(actual) !== stableJson(wanted)) {
    throw new Error('Task administration allowed-student mirror integrity check failed.');
  }
}

function assertInsertedUpdateAssignments(
  rows: readonly UpdateAssignment[],
  changes: readonly Readonly<{ studentId: string; eventType: 'ASSIGNED' | 'UNASSIGNED' }>[],
  ids: readonly string[], target: LockedUpdateTask,
  cycle: Readonly<{ cycleId: string; startsAt: string; endsAt: string | null }>,
  schedule: TaskSchedule, previous: ReadonlyMap<string, string>, input: CanonicalUpdateInput,
  payloadHash: string, now: Date,
) {
  if (rows.length !== changes.length) throw new Error('Task administration assignment event integrity check failed.');
  for (let index = 0; index < changes.length; index += 1) {
    const row = rows.find((candidate) => candidate.assignment_id === ids[index]);
    const change = changes[index];
    if (!row || row.task_id_snapshot !== input.taskId || row.task_instance_id !== target.taskInstanceId
      || row.cycle_id !== cycle.cycleId || row.cycle_start_at !== new Date(cycle.startsAt).toISOString()
      || row.cycle_end_at !== (cycle.endsAt ? new Date(cycle.endsAt).toISOString() : null)
      || row.rule_version !== schedule.ruleVersion || row.timezone !== schedule.timeZone
      || row.student_id !== change.studentId || row.event_type !== change.eventType
      || row.source !== 'ADMIN' || row.previous_assignment_id !== (previous.get(change.studentId) ?? null)
      || row.admin_operation_id !== input.operationId || row.admin_operation_hash !== payloadHash
      || row.created_at !== now.toISOString() || row.schema_version !== 1 || row.note !== null) {
      throw new Error('Task administration assignment event integrity check failed.');
    }
  }
}

async function assertUpdateState(tx: TenantTransaction, tenantId: string, evidence: UpdateEvidence) {
  const task = await tx.execute(sql`
    SELECT task_instance_id, task_id, title, description, reward::text AS reward, is_active,
      sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
      padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
      version::text AS version, created_at, updated_at, deleted_at
    FROM tasks WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.target.taskInstanceId}
  `);
  assertSingleUpdatedTask(task.rows, evidence.target, evidence.now);
  const mirrors = await tx.execute(sql`
    SELECT task_instance_id, student_id, created_at FROM task_allowed_students
    WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.target.taskInstanceId}
    ORDER BY student_id
  `);
  const parsedMirrors = parseLockedMirrors(mirrors.rows, evidence.target.taskInstanceId, evidence.now)
    .sort((a, b) => compareText(a.studentId, b.studentId));
  if (stableJson(parsedMirrors) !== stableJson(evidence.desiredMirrors)) {
    throw new Error('Task administration allowed-student mirror integrity check failed.');
  }
  const assignments = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.target.taskInstanceId}
    ORDER BY student_id, event_sequence
  `);
  const parsedAssignments = parseUpdateAssignments(assignments.rows, evidence.now);
  assertUpdateAssignmentChains(parsedAssignments);
  parsedAssignments.sort((a, b) => Number(a.event_sequence) - Number(b.event_sequence));
  const expectedAssignments = [...evidence.assignments]
    .sort((a, b) => Number(a.event_sequence) - Number(b.event_sequence));
  if (stableJson(parsedAssignments) !== stableJson(expectedAssignments)) {
    throw new Error('Task administration assignment event integrity check failed.');
  }
  const completions = await tx.execute(sql`
    SELECT completion_id, event_sequence::text AS event_sequence, completed_at,
      task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
      student_name_snapshot, reward_snapshot::text AS reward_snapshot,
      balance_before::text AS balance_before, balance_after::text AS balance_after,
      status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source,
      assignment_id, transaction_id, operation_id, operation_hash, admin_operation_id,
      admin_operation_hash, schema_version, evidence_provider, evidence_board_id,
      evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
    FROM task_completions
    WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.target.taskInstanceId}
    ORDER BY event_sequence
  `);
  if (stableJson(parseCompletionSnapshots(completions.rows)) !== stableJson(evidence.completions)) {
    throw new Error('Task administration completion event integrity check failed.');
  }
}

function freezeUpdateResult(result: TaskAdminUpdateSuccess): TaskAdminUpdateSuccess {
  const task = Object.freeze({ ...result.tasks[0],
    assignmentEventIds: Object.freeze([...result.tasks[0].assignmentEventIds]) });
  return Object.freeze({ ...result, tasks: Object.freeze([task]) });
}

function updateResultHash(result: TaskAdminUpdateSuccess) {
  return sha256({ ok: true, operationId: result.operationId, action: 'UPDATE',
    completedAt: result.completedAt, tasks: result.tasks.map((task) => ({ taskId: task.taskId,
      taskInstanceId: task.taskInstanceId, versionBefore: task.versionBefore,
      versionAfter: task.versionAfter, assignmentEventIds: [...task.assignmentEventIds] })) });
}

function updateAuditInput(result: TaskAdminUpdateSuccess, occurredAt: Date) {
  return { operationId: result.operationId, eventType: 'TASK_ADMIN_COMPLETED',
    entityType: 'OPERATION', entityId: result.operationId, redactedDetails: {
      action: 'UPDATE', taskCount: 1,
      assignmentEventCount: result.tasks[0].assignmentEventIds.length,
      resultHash: updateResultHash(result),
    }, occurredAt } as const;
}

async function assertUpdateAudit(tx: TenantTransaction, tenantId: string,
  input: ReturnType<typeof updateAuditInput>) {
  await assertOperationAudit(tx, tenantId, input);
  const rows = await tx.execute(sql`SELECT event_type FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${input.operationId}`);
  if (rows.rows.length !== 1
    || (rows.rows[0] as { event_type?: unknown }).event_type !== 'TASK_ADMIN_COMPLETED') {
    throw new Error('Task administration audit integrity check failed.');
  }
}

function parseStoredUpdateResult(raw: unknown): TaskAdminUpdateSuccess {
  const value = exactRecordOrdered(raw, ['ok', 'tasks', 'action', 'completedAt', 'operationId'],
    'stored task result');
  if (value.ok !== true || value.action !== 'UPDATE') {
    throw new Error('Task administration stored result integrity check failed.');
  }
  const tasks = exactArray(value.tasks, 'stored tasks');
  if (tasks.length !== 1) throw new Error('Task administration stored result integrity check failed.');
  const task = exactRecordOrdered(tasks[0], ['taskId', 'versionAfter', 'versionBefore',
    'taskInstanceId', 'assignmentEventIds'], 'stored task result');
  const versionBefore = safeInteger(task.versionBefore, 'stored task version', 1,
    Number.MAX_SAFE_INTEGER - 1);
  if (task.versionAfter !== versionBefore + 1) {
    throw new Error('Task administration stored result integrity check failed.');
  }
  return freezeUpdateResult({ ok: true, operationId: exactStoredId(value.operationId), action: 'UPDATE',
    completedAt: strictCanonicalInstant(value.completedAt, 'stored completedAt'), tasks: [{
      taskId: exactStoredId(task.taskId), taskInstanceId: exactStoredId(task.taskInstanceId),
      versionBefore, versionAfter: versionBefore + 1,
      assignmentEventIds: exactArray(task.assignmentEventIds, 'stored assignment event IDs')
        .map(exactStoredId),
    }] });
}

async function resolveUpdateReplay(tx: TenantTransaction, tenantId: string, operation: StoredOperation,
  input: CanonicalUpdateInput, payloadHash: string): Promise<TaskAdminUpdateSuccess> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Task administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== '1') {
    throw new Error('Task administration operation is not replayable.');
  }
  const started = exactDate(operation.started_at, 'operation timestamp');
  const created = exactDate(operation.created_at, 'operation timestamp');
  const updated = exactDate(operation.updated_at, 'operation timestamp');
  const finished = exactDate(operation.finished_at, 'operation timestamp');
  if (started.getTime() !== created.getTime() || started.getTime() !== finished.getTime()
    || finished.getTime() !== updated.getTime()) {
    throw new Error('Task administration operation timestamp integrity check failed.');
  }
  const result = parseStoredUpdateResult(operation.result_snapshot);
  const taskResult = result.tasks[0];
  if (result.operationId !== input.operationId || result.completedAt !== finished.toISOString()
    || taskResult.taskId !== input.taskId || taskResult.versionBefore !== input.expectedTaskVersion
    || taskResult.versionAfter !== input.expectedTaskVersion + 1) {
    throw new Error('Task administration stored result integrity check failed.');
  }
  const identity = await tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${tenantId} AND task_instance_id=${taskResult.taskInstanceId}`);
  const identityFailure = 'Task administration physical identity integrity check failed.';
  if (identity.rows.length !== 1) throw new Error(identityFailure);
  const identityRow = exactEvidenceRecord(identity.rows[0], ['task_instance_id', 'task_id'] as const,
    identityFailure);
  if (exactDatabaseId(identityRow.task_instance_id) !== taskResult.taskInstanceId
    || exactDatabaseId(identityRow.task_id) !== input.taskId) throw new Error(identityFailure);

  const events = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId}
      AND admin_operation_id=${input.operationId}
    ORDER BY assignment_id, event_sequence
  `);
  const parsed = parseUpdateAssignments(events.rows, finished);
  const frozenIds = taskResult.assignmentEventIds;
  if (new Set(frozenIds).size !== frozenIds.length || new Set(parsed.map((row) => row.assignment_id)).size !== parsed.length
    || parsed.length !== frozenIds.length) {
    throw new Error('Task administration assignment event integrity check failed.');
  }
  const rawIds = parsed.map((row) => row.assignment_id).sort(compareText);
  if (rawIds.some((id, index) => id !== [...frozenIds].sort(compareText)[index])) {
    throw new Error('Task administration assignment event integrity check failed.');
  }
  const history = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId}
      AND task_instance_id=${taskResult.taskInstanceId}
    ORDER BY student_id, event_sequence
  `);
  const allEvents = parseUpdateAssignments(history.rows, new Date(8640000000000000));
  assertUpdateAssignmentChains(allEvents);
  const canonicalRows = [...parsed].sort((left, right) => compareText(left.student_id, right.student_id));
  if (new Set(canonicalRows.map((row) => row.student_id)).size !== canonicalRows.length
    || frozenIds.some((id, index) => id !== canonicalRows[index]?.assignment_id)) {
    throw new Error('Task administration assignment event integrity check failed.');
  }
  for (const row of canonicalRows) {
    const expectedType = input.allowedStudentIds.includes(row.student_id) ? 'ASSIGNED' : 'UNASSIGNED';
    const prior = allEvents.filter((candidate) => candidate.student_id === row.student_id
      && candidate.task_instance_id === taskResult.taskInstanceId
      && candidate.cycle_id === row.cycle_id && candidate.cycle_start_at === row.cycle_start_at
      && candidate.cycle_end_at === row.cycle_end_at && candidate.rule_version === row.rule_version
      && candidate.timezone === row.timezone
      && Number(candidate.event_sequence) < Number(row.event_sequence))
      .sort((left, right) => Number(right.event_sequence) - Number(left.event_sequence))[0];
    if (row.task_id_snapshot !== input.taskId || row.task_instance_id !== taskResult.taskInstanceId
      || row.event_type !== expectedType || row.source !== 'ADMIN'
      || row.assignment_id !== createTaskAdminAssignmentEventId(input.operationId, input.taskId,
        row.student_id, expectedType)
      || row.previous_assignment_id !== (prior?.assignment_id ?? null)
      || row.admin_operation_id !== input.operationId || row.admin_operation_hash !== payloadHash
      || row.created_at !== finished.toISOString() || row.schema_version !== 1 || row.note !== null) {
      throw new Error('Task administration assignment event integrity check failed.');
    }
  }
  await assertUpdateAudit(tx, tenantId, updateAuditInput(result, finished));
  return result;
}

function parseDeletedTask(rows: readonly unknown[], now: Date) {
  const failure = 'Task administration task row integrity check failed.';
  if (rows.length !== 1) throw new Error(failure);
  const row = exactEvidenceRecord(rows[0], FULL_TASK_ROW_KEYS, failure);
  if (row.deleted_at === null || row.schedule_schema_version !== 1) throw new Error(failure);
  const createdAt = evidenceTimestamp(row.created_at, failure);
  const updatedAt = evidenceTimestamp(row.updated_at, failure);
  const deletedAt = evidenceTimestamp(row.deleted_at, failure);
  if (Date.parse(createdAt) > Date.parse(updatedAt) || updatedAt !== deletedAt
    || Date.parse(deletedAt) > now.getTime() || row.is_active !== false) throw new Error(failure);
  if (typeof row.title !== 'string' || typeof row.description !== 'string'
    || typeof row.sort_order !== 'number' || !Number.isSafeInteger(row.sort_order)
    || row.sort_order < INT32_MIN || row.sort_order > INT32_MAX) throw new Error(failure);
  return {
    taskInstanceId: exactDatabaseId(row.task_instance_id), taskId: exactDatabaseId(row.task_id),
    title: row.title, description: row.description,
    reward: canonicalDatabaseInteger(row.reward, 0, Number.MAX_SAFE_INTEGER, failure),
    isActive: false, sortOrder: row.sort_order,
    availableFrom: nullableEvidenceTimestamp(row.available_from, failure),
    availableUntil: nullableEvidenceTimestamp(row.available_until, failure),
    dueAt: nullableEvidenceTimestamp(row.due_at, failure),
    prerequisiteTaskInstanceId: row.prerequisite_task_instance_id === null ? null
      : exactDatabaseId(row.prerequisite_task_instance_id),
    padletBoardId: row.padlet_board_id === null ? null : exactDatabaseId(row.padlet_board_id),
    currentSchedule: parseStoredSchedule(row.current_schedule, failure),
    pendingSchedule: row.pending_schedule === null ? null : parseStoredSchedule(row.pending_schedule, failure),
    scheduleSchemaVersion: 1 as const,
    version: canonicalDatabaseInteger(row.version, 1, Number.MAX_SAFE_INTEGER, failure),
    createdAt, updatedAt, deletedAt,
  };
}

function assertSingleDeletedTask(rows: readonly unknown[], expected: DeleteEvidence['targetAfter'], now: Date) {
  if (stableJson(parseDeletedTask(rows, now)) !== stableJson(expected)) {
    throw new Error('Task administration task row integrity check failed.');
  }
}

async function assertDeleteState(tx: TenantTransaction, tenantId: string, evidence: DeleteEvidence) {
  const task = await tx.execute(sql`
    SELECT task_instance_id, task_id, title, description, reward::text AS reward, is_active,
      sort_order, available_from, available_until, due_at, prerequisite_task_instance_id,
      padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
      version::text AS version, created_at, updated_at, deleted_at
    FROM tasks WHERE tenant_id=${tenantId} AND task_instance_id=${evidence.targetAfter.taskInstanceId}
  `);
  assertSingleDeletedTask(task.rows, evidence.targetAfter, evidence.now);
  const mirrors = await tx.execute(sql`SELECT task_instance_id, student_id, created_at
    FROM task_allowed_students WHERE tenant_id=${tenantId}
      AND task_instance_id=${evidence.targetAfter.taskInstanceId} ORDER BY student_id`);
  if (mirrors.rows.length !== 0) {
    throw new Error('Task administration allowed-student mirror integrity check failed.');
  }
  const assignments = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId}
      AND task_instance_id=${evidence.targetAfter.taskInstanceId}
    ORDER BY student_id, event_sequence
  `);
  const parsedAssignments = parseUpdateAssignments(assignments.rows, evidence.now);
  assertUpdateAssignmentChains(parsedAssignments);
  const bySequence = (values: readonly UpdateAssignment[]) => [...values]
    .sort((left, right) => Number(left.event_sequence) - Number(right.event_sequence));
  if (stableJson(bySequence(parsedAssignments)) !== stableJson(bySequence(evidence.assignments))) {
    throw new Error('Task administration assignment event integrity check failed.');
  }
  const completions = await tx.execute(sql`
    SELECT completion_id, event_sequence::text AS event_sequence, completed_at,
      task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
      student_name_snapshot, reward_snapshot::text AS reward_snapshot,
      balance_before::text AS balance_before, balance_after::text AS balance_after,
      status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source,
      assignment_id, transaction_id, operation_id, operation_hash, admin_operation_id,
      admin_operation_hash, schema_version, evidence_provider, evidence_board_id,
      evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
    FROM task_completions WHERE tenant_id=${tenantId}
      AND task_instance_id=${evidence.targetAfter.taskInstanceId} ORDER BY event_sequence
  `);
  if (stableJson(parseCompletionSnapshots(completions.rows)) !== stableJson(evidence.completions)) {
    throw new Error('Task administration completion event integrity check failed.');
  }
  const dependents = await tx.execute(sql`SELECT task_instance_id FROM tasks
    WHERE tenant_id=${tenantId} AND deleted_at IS NULL
      AND prerequisite_task_instance_id=${evidence.targetAfter.taskInstanceId}
    ORDER BY task_instance_id`);
  if (dependents.rows.length !== 0) throw new Error('Task administration dependent integrity check failed.');
}

function freezeDeleteResult(result: TaskAdminDeleteSuccess): TaskAdminDeleteSuccess {
  const task = Object.freeze({ ...result.tasks[0],
    assignmentEventIds: Object.freeze([...result.tasks[0].assignmentEventIds]) });
  return Object.freeze({ ...result, tasks: Object.freeze([task]) });
}

function deleteResultHash(result: TaskAdminDeleteSuccess) {
  return sha256(canonicalResultValue(result));
}

function deleteAuditInput(result: TaskAdminDeleteSuccess, occurredAt: Date) {
  return { operationId: result.operationId, eventType: 'TASK_ADMIN_COMPLETED',
    entityType: 'OPERATION', entityId: result.operationId, redactedDetails: {
      action: 'DELETE', taskCount: 1,
      assignmentEventCount: result.tasks[0].assignmentEventIds.length,
      resultHash: deleteResultHash(result),
    }, occurredAt } as const;
}

async function assertDeleteAudit(tx: TenantTransaction, tenantId: string,
  input: ReturnType<typeof deleteAuditInput>) {
  await assertOperationAudit(tx, tenantId, input);
  const rows = await tx.execute(sql`SELECT event_type FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${input.operationId}`);
  if (rows.rows.length !== 1
    || (rows.rows[0] as { event_type?: unknown }).event_type !== 'TASK_ADMIN_COMPLETED') {
    throw new Error('Task administration audit integrity check failed.');
  }
}

function parseStoredDeleteResult(raw: unknown): TaskAdminDeleteSuccess {
  const value = exactRecordOrdered(raw, ['ok', 'tasks', 'action', 'completedAt', 'operationId'],
    'stored task result');
  if (value.ok !== true || value.action !== 'DELETE') {
    throw new Error('Task administration stored result integrity check failed.');
  }
  const tasks = exactArray(value.tasks, 'stored tasks');
  if (tasks.length !== 1) throw new Error('Task administration stored result integrity check failed.');
  const task = exactRecordOrdered(tasks[0], ['taskId', 'versionAfter', 'versionBefore',
    'taskInstanceId', 'assignmentEventIds'], 'stored task result');
  const versionBefore = safeInteger(task.versionBefore, 'stored task version', 1,
    Number.MAX_SAFE_INTEGER - 1);
  if (task.versionAfter !== versionBefore + 1) {
    throw new Error('Task administration stored result integrity check failed.');
  }
  return freezeDeleteResult({ ok: true, operationId: exactStoredId(value.operationId), action: 'DELETE',
    completedAt: strictCanonicalInstant(value.completedAt, 'stored completedAt'), tasks: [{
      taskId: exactStoredId(task.taskId), taskInstanceId: exactStoredId(task.taskInstanceId),
      versionBefore, versionAfter: versionBefore + 1,
      assignmentEventIds: exactArray(task.assignmentEventIds, 'stored assignment event IDs')
        .map(exactStoredId),
    }] });
}

async function resolveDeleteReplay(tx: TenantTransaction, tenantId: string, operation: StoredOperation,
  input: CanonicalDeleteInput, payloadHash: string): Promise<TaskAdminDeleteSuccess> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Task administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== '1') throw new Error('Task administration operation is not replayable.');
  const started = exactDate(operation.started_at, 'operation timestamp');
  const created = exactDate(operation.created_at, 'operation timestamp');
  const updated = exactDate(operation.updated_at, 'operation timestamp');
  const finished = exactDate(operation.finished_at, 'operation timestamp');
  if (started.getTime() !== created.getTime() || started.getTime() !== finished.getTime()
    || finished.getTime() !== updated.getTime()) {
    throw new Error('Task administration operation timestamp integrity check failed.');
  }
  const result = parseStoredDeleteResult(operation.result_snapshot);
  const taskResult = result.tasks[0];
  if (result.operationId !== input.operationId || result.completedAt !== finished.toISOString()
    || taskResult.taskId !== input.taskId || taskResult.versionBefore !== input.expectedTaskVersion
    || taskResult.versionAfter !== input.expectedTaskVersion + 1) {
    throw new Error('Task administration stored result integrity check failed.');
  }
  const identity = await tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${tenantId} AND task_instance_id=${taskResult.taskInstanceId}`);
  const identityFailure = 'Task administration physical identity integrity check failed.';
  if (identity.rows.length !== 1) throw new Error(identityFailure);
  const identityRow = exactEvidenceRecord(identity.rows[0], ['task_instance_id', 'task_id'] as const,
    identityFailure);
  if (exactDatabaseId(identityRow.task_instance_id) !== taskResult.taskInstanceId
    || exactDatabaseId(identityRow.task_id) !== input.taskId) throw new Error(identityFailure);
  const operationEvents = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId} AND admin_operation_id=${input.operationId}
    ORDER BY assignment_id, event_sequence
  `);
  const parsed = parseUpdateAssignments(operationEvents.rows, finished);
  const history = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId}
      AND task_instance_id=${taskResult.taskInstanceId} ORDER BY student_id, event_sequence
  `);
  const allEvents = parseUpdateAssignments(history.rows, new Date(8640000000000000));
  assertUpdateAssignmentChains(allEvents);
  const canonicalRows = [...parsed].sort((left, right) => compareText(left.student_id, right.student_id));
  if (new Set(taskResult.assignmentEventIds).size !== taskResult.assignmentEventIds.length
    || canonicalRows.length !== taskResult.assignmentEventIds.length
    || new Set(canonicalRows.map((row) => row.student_id)).size !== canonicalRows.length
    || taskResult.assignmentEventIds.some((id, index) => id !== canonicalRows[index]?.assignment_id)) {
    throw new Error('Task administration assignment event integrity check failed.');
  }
  for (const row of canonicalRows) {
    const prior = allEvents.filter((candidate) => candidate.student_id === row.student_id
      && candidate.task_instance_id === taskResult.taskInstanceId
      && candidate.cycle_id === row.cycle_id && candidate.cycle_start_at === row.cycle_start_at
      && candidate.cycle_end_at === row.cycle_end_at && candidate.rule_version === row.rule_version
      && candidate.timezone === row.timezone
      && Number(candidate.event_sequence) < Number(row.event_sequence))
      .sort((left, right) => Number(right.event_sequence) - Number(left.event_sequence))[0];
    if (row.task_id_snapshot !== input.taskId || row.task_instance_id !== taskResult.taskInstanceId
      || row.event_type !== 'UNASSIGNED' || row.source !== 'ADMIN'
      || row.assignment_id !== createTaskAdminAssignmentEventId(input.operationId, input.taskId,
        row.student_id, 'UNASSIGNED')
      || row.previous_assignment_id !== (prior?.assignment_id ?? null)
      || row.admin_operation_id !== input.operationId || row.admin_operation_hash !== payloadHash
      || row.created_at !== finished.toISOString() || row.schema_version !== 1 || row.note !== null) {
      throw new Error('Task administration assignment event integrity check failed.');
    }
  }
  await assertDeleteAudit(tx, tenantId, deleteAuditInput(result, finished));
  return result;
}

function canonicalDatabaseInteger(value: unknown, min: number, max: number, failure: string): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(failure);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max || String(parsed) !== value) {
    throw new Error(failure);
  }
  return parsed;
}

function canonicalSignedDatabaseInteger(value: unknown, failure: string): number {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw new Error(failure);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) throw new Error(failure);
  return parsed;
}

function nullableEvidenceTimestamp(value: unknown, failure: string): string | null {
  return value === null ? null : evidenceTimestamp(value, failure);
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
  if (availableFrom !== null && dueAt !== null && Date.parse(dueAt) <= Date.parse(availableFrom)) {
    throw new Error('Task dueAt must be after availableFrom.');
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
    SELECT operation_id, operation_kind, payload_hash, status, result_snapshot, finished_at,
           failure_code, attempt_count::text AS attempt_count, started_at, created_at, updated_at
    FROM operations WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  `);
  if (result.rows.length > 1) throw new Error('Task administration operation integrity check failed.');
  if (result.rows.length === 0) return null;
  const failure = 'Task administration operation integrity check failed.';
  const row = exactEvidenceRecord(result.rows[0], OPERATION_ROW_KEYS, failure);
  const text = (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new Error(failure);
    return value;
  };
  const date = (value: unknown) => {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(failure);
    return value;
  };
  const operationKind = text(row.operation_kind);
  const status = text(row.status);
  const payloadHash = text(row.payload_hash);
  const attemptCount = text(row.attempt_count);
  if (exactDatabaseId(row.operation_id) !== operationId || operationKind !== 'TASK_ADMIN'
    || !/^[a-f0-9]{64}$/.test(payloadHash) || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(status)
    || !/^[1-9][0-9]*$/.test(attemptCount) || !Number.isSafeInteger(Number(attemptCount))) {
    throw new Error(failure);
  }
  if (row.failure_code !== null && typeof row.failure_code !== 'string') throw new Error(failure);
  if (row.finished_at !== null && !(row.finished_at instanceof Date)) throw new Error(failure);
  return {
    operation_id: operationId, operation_kind: operationKind, payload_hash: payloadHash,
    status, result_snapshot: row.result_snapshot,
    finished_at: row.finished_at === null ? null : date(row.finished_at),
    failure_code: row.failure_code as string | null, attempt_count: attemptCount,
    started_at: date(row.started_at), created_at: date(row.created_at), updated_at: date(row.updated_at),
  } satisfies StoredOperation;
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
    || operation.attempt_count !== '1') {
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

function canonicalResultValue(result: TaskAdminSuccess) {
  return { ok: true, operationId: result.operationId, action: result.action, completedAt: result.completedAt,
    tasks: result.tasks.map((task) => ({ taskId: task.taskId, taskInstanceId: task.taskInstanceId,
      versionBefore: task.versionBefore, versionAfter: task.versionAfter,
      assignmentEventIds: [...task.assignmentEventIds] })) };
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
