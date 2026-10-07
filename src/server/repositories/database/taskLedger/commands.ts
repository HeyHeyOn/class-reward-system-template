import 'server-only';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { initialSchedule, repeatSettingOf, sameRepeatSetting, scheduleForRepeat, scheduleInForce } from '@/domain/taskRepeat';
import type { TaskStage } from '@/domain/taskStage';
import type {
  AdminTaskDto,
  CreateTaskRequest,
  DeleteTasksRequest,
  QrStageRequest,
  QrStageResultDto,
  ResetTasksRequest,
  SetRepeatRequest,
  SetStagesRequest,
  TaskDefinitionDto,
  UpdateTaskRequest,
} from '@/lib/taskLedgerApi';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit } from '../operationAudit';
import { ensureTaskLedger, type RunTenantTransaction } from './migration';
import { writeTeacherPaidCompletion } from './reward';
import { readCurrentLedgerStates } from './currentState';
import { lockTaskGraph } from './locking';
import {
  buildAdminTaskDto,
  canonicalJson,
  clockNow,
  latestEvent,
  readLedgerFrom,
  readLedgerStudents,
  readLedgerTasks,
  sha256,
  sortTasks,
  stageOf,
  TaskLedgerError,
  type LedgerEventRow,
  type LedgerEventSource,
  type LedgerStudent,
  type LedgerTask,
} from './store';
import {
  ADMIN_COMPLETION_NOTE,
  insertStageEvent,
  insertUnpaidCompletion,
  ledgerEventId,
  readBalances,
  RESET_COMPLETION_NOTE,
  RESET_NOW_COMPLETION_NOTE,
  type LedgerWriter,
} from './writes';

export type TaskLedgerCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  runTenantSnapshot?: RunTenantTransaction;
  /** Resolves a scanned student QR to a student ID of this class, or throws. */
  resolveStudentQr?: (value: string) => string;
}>;

type Context = {
  tx: TenantTransaction;
  tenantId: string;
  now: string;
  ledgerFrom: string;
  operationId: string;
  payloadHash: string;
};

/** Why an event was written; shown in the history (the ID prefix keeps it). */
type Cause = 'TEACHER' | 'QR' | 'RESET';
const CAUSE_PREFIX: Readonly<Record<Cause, { stage: 'tl-a' | 'tl-q' | 'tl-r'; completion: 'tl-c' | 'tl-cq' | 'tl-cr' }>> = {
  TEACHER: { stage: 'tl-a', completion: 'tl-c' },
  QR: { stage: 'tl-q', completion: 'tl-cq' },
  RESET: { stage: 'tl-r', completion: 'tl-cr' },
};

const eventId = ledgerEventId;

export function createTaskLedgerCommands(dependencies: TaskLedgerCommandDependencies) {
  const { tenantId } = dependencies;

  async function withOperation<T>(kind: string, operationId: string, request: unknown,
    body: (context: Context) => Promise<T>, summary: (value: T) => Record<string, unknown>): Promise<Readonly<{ value: T | null; replayed: boolean }>> {
    await ensureTaskLedger(dependencies);
    return dependencies.runTenantTransaction(tenantId, async (tx) => {
      const payloadHash = sha256(canonicalJson({ kind: `task-ledger:${kind}`, request }));
      const now = await clockNow(tx);
      const inserted = await tx.execute(sql`
        INSERT INTO operations (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
          started_at, created_at, updated_at)
        VALUES (${tenantId}, ${operationId}, 'TASK_ADMIN', ${payloadHash}, 'PENDING', 1,
          ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz)
        ON CONFLICT (tenant_id, operation_id) DO NOTHING
        RETURNING operation_id`);
      if (inserted.rows.length === 0) {
        const existing = await tx.execute(sql`SELECT operation_kind, payload_hash, status FROM operations
          WHERE tenant_id=${tenantId} AND operation_id=${operationId}`);
        const row = existing.rows[0] as { operation_kind: string; payload_hash: string; status: string } | undefined;
        if (!row || row.operation_kind !== 'TASK_ADMIN' || row.payload_hash !== payloadHash || row.status !== 'SUCCEEDED') {
          throw new TaskLedgerError('OPERATION_CONFLICT', '같은 요청 번호로 다른 내용이 왔어요. 화면을 새로 고친 뒤 다시 시도해 주세요.');
        }
        return { value: null, replayed: true };
      }
      const ledgerFrom = await readLedgerFrom(tx, tenantId);
      if (!ledgerFrom) throw new Error('Task ledger start is missing.');
      const value = await body({ tx, tenantId, now, ledgerFrom, operationId, payloadHash });
      const finishedAt = await clockNow(tx);
      const details = summary(value);
      const taskIds = Array.isArray(details.taskIds) ? details.taskIds.map(String)
        : Array.isArray(details.deletedTaskIds) ? details.deletedTaskIds.map(String)
          : typeof details.taskId === 'string' ? [details.taskId] : [];
      await appendOperationAudit(tx, tenantId, { operationId, eventType: `TASK_LEDGER_${kind.toUpperCase()}`,
        entityType: 'TASK', entityId: taskIds.join(',').slice(0, 200) || 'none',
        redactedDetails: { payloadHash, ...details }, occurredAt: new Date(finishedAt) });
      await tx.execute(sql`
        UPDATE operations SET status='SUCCEEDED', result_snapshot=${JSON.stringify({ kind, ...details })}::jsonb,
          finished_at=${finishedAt}::timestamptz, updated_at=${finishedAt}::timestamptz
        WHERE tenant_id=${tenantId} AND operation_id=${operationId}`);
      return { value, replayed: false };
    });
  }

  /** Fresh DTOs of the given tasks (all live tasks when omitted), read after the write. */
  async function readTasks(taskIds?: readonly string[]): Promise<AdminTaskDto[]> {
    return (await readBoard(taskIds)).tasks;
  }

  /** Project stages and return their clock from the same read snapshot. */
  async function readBoard(taskIds?: readonly string[]): Promise<{ now: string; tasks: AdminTaskDto[] }> {
    await ensureTaskLedger(dependencies);
    const read = dependencies.runTenantSnapshot ?? dependencies.runTenantTransaction;
    return read(tenantId, async (tx) => {
      const ledgerFrom = await readLedgerFrom(tx, tenantId);
      const now = await clockNow(tx);
      const tasks = await readLedgerTasks(tx, tenantId, taskIds ? { taskIds } : {});
      const students = await readLedgerStudents(tx, tenantId);
      const events = ledgerFrom === null ? new Map() : await readCurrentLedgerStates(tx, tenantId, now,
        { taskInstanceIds: tasks.map((task) => task.taskInstanceId) });
      return {
        now: new Date(now).toISOString(),
        tasks: sortTasks(tasks.map((task) => buildAdminTaskDto(task, students, events.get(task.taskInstanceId), now))),
      };
    });
  }

  async function lockTasks(context: Context, taskIds: readonly string[]): Promise<Map<string, LedgerTask>> {
    const tasks = await readLedgerTasks(context.tx, tenantId, { lock: true, taskIds });
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const missing = taskIds.filter((taskId) => !byId.has(taskId));
    if (missing.length > 0) throw new TaskLedgerError('TASK_NOT_FOUND', '없거나 삭제된 과제가 있어요. 목록을 새로 불러와 주세요.', 404);
    return byId;
  }

  async function lockStudents(context: Context, studentIds: readonly string[]): Promise<Map<string, LedgerStudent>> {
    const unique = [...new Set(studentIds)].sort();
    const students = await readLedgerStudents(context.tx, tenantId, { studentIds: unique, lock: true });
    const byId = new Map(students.map((student) => [student.studentId, student]));
    if (unique.some((studentId) => !byId.has(studentId))) {
      throw new TaskLedgerError('STUDENT_NOT_FOUND', '없거나 삭제된 학생이 있어요. 목록을 새로 불러와 주세요.', 404);
    }
    return byId;
  }

  /**
   * Moves one student of one task to `stage` unless already there. Returns true when it wrote.
   * 완료 with `withReward` pays the task reward exactly like a bank completion.
   */
  async function moveStudent(context: Context, input: Readonly<{
    task: LedgerTask;
    student: LedgerStudent;
    stage: TaskStage;
    withReward: boolean;
    cause: Cause;
    events: LedgerEventSource | undefined;
    balances: Map<string, number>;
  }>): Promise<{ changed: boolean; paid: number }> {
    const current = stageOf(input.task, input.events, context.now);
    if (current.stage === input.stage) return { changed: false, paid: 0 };
    const writer: LedgerWriter = { source: input.cause === 'QR' ? 'QR' : 'ADMIN', operationId: context.operationId, payloadHash: context.payloadHash };
    const prefix = CAUSE_PREFIX[input.cause];
    if (input.stage !== 'COMPLETED') {
      await insertStageEvent(context.tx, tenantId, { id: eventId(prefix.stage, context.operationId, input.task.taskInstanceId, input.student.studentId),
        task: input.task, studentId: input.student.studentId, stage: input.stage, writer });
      return { changed: true, paid: 0 };
    }
    const balance = input.balances.get(input.student.studentId) ?? 0;
    if (input.withReward && input.task.reward > 0) {
      const paid = await writeTeacherPaidCompletion(context.tx, tenantId, { adminOperationId: context.operationId, task: input.task,
        student: input.student, balance, events: input.events });
      input.balances.set(input.student.studentId, paid.balanceAfter);
      return { changed: true, paid: input.task.reward };
    }
    const assignment = latestEvent(input.events, (event): event is LedgerEventRow => event.table === 'A' && event.kind === 'STAGE' && event.stage !== 'UNASSIGNED');
    await insertUnpaidCompletion(context.tx, tenantId, {
      id: eventId(prefix.completion, context.operationId, input.task.taskInstanceId, input.student.studentId),
      task: input.task, student: input.student, balance, assignmentId: assignment?.id ?? null,
      note: input.cause === 'RESET' ? RESET_NOW_COMPLETION_NOTE : ADMIN_COMPLETION_NOTE,
      writer: { source: 'ADMIN', operationId: context.operationId, payloadHash: context.payloadHash },
    });
    return { changed: true, paid: 0 };
  }

  /** Stage changes also advance the task's version, so screens can tell newer data from older. */
  async function bumpVersions(context: Context, taskInstanceIds: Iterable<string>): Promise<void> {
    const ids = [...new Set(taskInstanceIds)].sort();
    if (ids.length === 0) return;
    await context.tx.execute(sql`
      UPDATE tasks SET version=version+1, updated_at=GREATEST(${context.now}::timestamptz, updated_at)
      WHERE tenant_id=${tenantId} AND task_instance_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  }

  async function ledgerEventsFor(context: Context, tasks: readonly LedgerTask[], studentId?: string) {
    // Task/student locks can wait behind a committed writer. Project after the
    // wait, not at the request's earlier operation timestamp.
    context.now = await clockNow(context.tx);
    return readCurrentLedgerStates(context.tx, tenantId, context.now, {
      taskInstanceIds: tasks.map((task) => task.taskInstanceId), ...(studentId === undefined ? {} : { studentId }) });
  }

  /**
   * Writes, as plain events, the stages that automatic resets of the current schedule produced
   * since each student's last event — before that schedule is replaced, so they stay true.
   */
  async function settleResets(context: Context, task: LedgerTask, students: readonly LedgerStudent[],
    events: ReadonlyMap<string, LedgerEventSource> | undefined, balances: Map<string, number>): Promise<void> {
    for (const student of students) {
      const state = stageOf(task, events?.get(student.studentId), context.now);
      if (!state.byReset || state.since === null) continue;
      // Written at the reset's own time (after the student's last event), so history and order stay true.
      if (state.stage === 'COMPLETED') {
        await insertUnpaidCompletion(context.tx, tenantId, { id: eventId('tl-cs', context.operationId, task.taskInstanceId, student.studentId),
          task, student, balance: balances.get(student.studentId) ?? 0, assignmentId: null, note: RESET_COMPLETION_NOTE,
          writer: { source: 'CARRY_FORWARD' }, at: state.since });
      } else {
        await insertStageEvent(context.tx, tenantId, { id: eventId('tl-s', context.operationId, task.taskInstanceId, student.studentId),
          task, studentId: student.studentId, stage: state.stage, writer: { source: 'CARRY_FORWARD' }, at: state.since });
      }
    }
  }

  async function resolvePrerequisite(context: Context, prerequisiteTaskId: string | null, selfInstanceId: string | null): Promise<string | null> {
    if (prerequisiteTaskId === null) return null;
    const all = await readLedgerTasks(context.tx, tenantId);
    const byTaskId = new Map(all.map((task) => [task.taskId, task]));
    const prerequisite = byTaskId.get(prerequisiteTaskId);
    if (!prerequisite) throw new TaskLedgerError('PREREQUISITE_NOT_FOUND', '선행 과제를 찾을 수 없어요. 다른 과제를 골라 주세요.', 409);
    if (prerequisite.taskInstanceId === selfInstanceId) throw new TaskLedgerError('PREREQUISITE_SELF', '자기 자신을 선행 과제로 고를 수 없어요.', 409);
    const byInstance = new Map(all.map((task) => [task.taskInstanceId, task]));
    const seen = new Set<string>();
    let cursor: LedgerTask | undefined = prerequisite;
    while (cursor) {
      if (cursor.taskInstanceId === selfInstanceId) {
        throw new TaskLedgerError('PREREQUISITE_CYCLE', '두 과제가 서로를 선행 과제로 가리키게 돼요. 다른 과제를 골라 주세요.', 409);
      }
      if (seen.has(cursor.taskInstanceId)) break;
      seen.add(cursor.taskInstanceId);
      cursor = cursor.prerequisiteTaskInstanceId ? byInstance.get(cursor.prerequisiteTaskInstanceId) : undefined;
    }
    return prerequisite.taskInstanceId;
  }

  async function nextTaskId(context: Context): Promise<string> {
    const result = await context.tx.execute(sql`SELECT task_id FROM tasks WHERE tenant_id=${tenantId}`);
    let max = 0;
    for (const row of result.rows as Array<{ task_id: string }>) {
      const match = /^T(\d{1,9})$/.exec(row.task_id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `T${String(max + 1).padStart(3, '0')}`;
  }

  async function writeDefinition(context: Context, task: LedgerTask, definition: TaskDefinitionDto): Promise<boolean> {
    const prerequisiteInstanceId = await resolvePrerequisite(context, definition.prerequisiteTaskId, task.taskInstanceId);
    const same = task.title === definition.title && task.description === definition.description && task.reward === definition.reward
      && task.isActive === definition.isActive && task.sortOrder === definition.sortOrder
      && task.availableFrom === definition.availableFrom && task.dueAt === definition.dueAt
      && task.prerequisiteTaskInstanceId === prerequisiteInstanceId;
    if (same) return false;
    await context.tx.execute(sql`
      UPDATE tasks SET title=${definition.title}, description=${definition.description}, reward=${definition.reward},
        is_active=${definition.isActive}, sort_order=${definition.sortOrder},
        available_from=${definition.availableFrom}::timestamptz, due_at=${definition.dueAt}::timestamptz,
        prerequisite_task_instance_id=${prerequisiteInstanceId}, version=version+1,
        updated_at=GREATEST(${context.now}::timestamptz, updated_at)
      WHERE tenant_id=${tenantId} AND task_instance_id=${task.taskInstanceId}`);
    return true;
  }

  return {
    readTasks,
    readBoard,

    /**
     * `internal` is for server-side callers only (the .xlsx import keeps the sheet's task IDs and
     * Padlet boards); the HTTP route never passes it.
     */
    async createTask(request: CreateTaskRequest, internal: Readonly<{ taskId?: string; padletBoardId?: string | null }> = {}): Promise<AdminTaskDto> {
      const result = await withOperation('create', request.operationId, { ...request, internal }, async (context) => {
        await lockTaskGraph(context.tx, tenantId, 'exclusive');
        const taskId = internal.taskId ?? await nextTaskId(context);
        if (internal.taskId) {
          const taken = await context.tx.execute(sql`SELECT 1 FROM tasks WHERE tenant_id=${tenantId} AND task_id=${taskId} AND deleted_at IS NULL`);
          if (taken.rows.length > 0) throw new TaskLedgerError('TASK_ID_TAKEN', '같은 번호의 과제가 이미 있어요.', 409);
        }
        const taskInstanceId = `task-${randomUUID()}`;
        const prerequisiteInstanceId = await resolvePrerequisite(context, request.task.prerequisiteTaskId, null);
        const schedule = initialSchedule(request.repeat, context.now);
        await context.tx.execute(sql`
          INSERT INTO tasks (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
            available_from, due_at, prerequisite_task_instance_id, padlet_board_id, current_schedule, pending_schedule,
            schedule_schema_version, version, created_at, updated_at)
          VALUES (${tenantId}, ${taskInstanceId}, ${taskId}, ${request.task.title}, ${request.task.description},
            ${request.task.reward}, ${request.task.isActive}, ${request.task.sortOrder},
            ${request.task.availableFrom}::timestamptz, ${request.task.dueAt}::timestamptz, ${prerequisiteInstanceId},
            ${internal.padletBoardId ?? null}, ${JSON.stringify(schedule)}::jsonb, NULL, 1, 1,
            ${context.now}::timestamptz, ${context.now}::timestamptz)`);
        const assignments = (request.students ?? []).filter((entry) => entry.stage !== 'UNASSIGNED');
        if (assignments.length > 0) {
          const [task] = await readLedgerTasks(context.tx, tenantId, { taskInstanceIds: [taskInstanceId], lock: true });
          const students = await lockStudents(context, assignments.map((entry) => entry.studentId));
          const balances = await readBalances(context.tx, tenantId, [...students.keys()].sort(), true);
          for (const entry of assignments) {
            await moveStudent(context, { task, student: students.get(entry.studentId)!, stage: entry.stage, withReward: false,
              cause: 'TEACHER', events: [], balances });
          }
        }
        return { taskId };
      }, (value) => ({ taskId: value.taskId }));
      const taskId = result.value?.taskId ?? await replayedTaskId(request.operationId);
      const [task] = await readTasks([taskId]);
      if (!task) throw new TaskLedgerError('TASK_NOT_FOUND', '만든 과제를 찾지 못했어요. 목록을 새로 불러와 주세요.', 404);
      return task;
    },

    async updateTask(taskId: string, request: UpdateTaskRequest): Promise<AdminTaskDto> {
      await withOperation('update', request.operationId, { taskId, ...request }, async (context) => {
        await lockTaskGraph(context.tx, tenantId, 'exclusive');
        const tasks = await lockTasks(context, [taskId]);
        return { changed: await writeDefinition(context, tasks.get(taskId)!, request.task) };
      }, (value) => ({ taskId, changed: value.changed }));
      const [task] = await readTasks([taskId]);
      if (!task) throw new TaskLedgerError('TASK_NOT_FOUND', '과제를 찾을 수 없어요. 목록을 새로 불러와 주세요.', 404);
      return task;
    },

    async deleteTasks(request: DeleteTasksRequest): Promise<{ deletedTaskIds: string[] }> {
      const result = await withOperation('delete', request.operationId, request, async (context) => {
        await lockTaskGraph(context.tx, tenantId, 'exclusive');
        const live = await readLedgerTasks(context.tx, tenantId, { lock: true, taskIds: request.taskIds });
        if (live.length === 0) return { deletedTaskIds: [] as string[] };
        const instanceIds = live.map((task) => task.taskInstanceId);
        const list = sql.join(instanceIds.map((id) => sql`${id}`), sql`, `);
        // Tasks that needed one of these first simply lose that condition.
        await context.tx.execute(sql`
          UPDATE tasks SET prerequisite_task_instance_id=NULL, version=version+1,
            updated_at=GREATEST(${context.now}::timestamptz, updated_at)
          WHERE tenant_id=${tenantId} AND deleted_at IS NULL AND prerequisite_task_instance_id IN (${list})
            AND task_instance_id NOT IN (${list})`);
        await context.tx.execute(sql`
          UPDATE tasks SET is_active=false, version=version+1,
            updated_at=GREATEST(${context.now}::timestamptz, updated_at),
            deleted_at=GREATEST(${context.now}::timestamptz, updated_at)
          WHERE tenant_id=${tenantId} AND task_instance_id IN (${list})`);
        return { deletedTaskIds: live.map((task) => task.taskId) };
      }, (value) => ({ deletedTaskIds: value.deletedTaskIds }));
      return { deletedTaskIds: result.value?.deletedTaskIds ?? [...request.taskIds] };
    },

    async setStages(request: SetStagesRequest): Promise<{ tasks: AdminTaskDto[] }> {
      const taskIds = [...new Set(request.changes.map((change) => change.taskId))];
      await withOperation('stages', request.operationId, request, async (context) => {
        const tasks = await lockTasks(context, taskIds);
        const students = await lockStudents(context, request.changes.map((change) => change.studentId));
        const balances = await readBalances(context.tx, tenantId, [...students.keys()].sort(), true);
        const events = await ledgerEventsFor(context, [...tasks.values()]);
        let changed = 0;
        let paid = 0;
        const touched = new Set<string>();
        for (const change of request.changes) {
          const task = tasks.get(change.taskId)!;
          const moved = await moveStudent(context, { task, student: students.get(change.studentId)!, stage: change.stage,
            withReward: change.withReward === true, cause: 'TEACHER',
            events: events.get(task.taskInstanceId)?.get(change.studentId), balances });
          if (moved.changed) { changed += 1; touched.add(task.taskInstanceId); }
          paid += moved.paid;
        }
        await bumpVersions(context, touched);
        return { changed, paid };
      }, (value) => ({ taskIds, changed: value.changed, paid: value.paid }));
      return { tasks: await readTasks(taskIds) };
    },

    async resetTasks(request: ResetTasksRequest): Promise<{ tasks: AdminTaskDto[] }> {
      await withOperation('reset', request.operationId, request, async (context) => {
        const tasks = await lockTasks(context, request.taskIds);
        const all = await readLedgerStudents(context.tx, tenantId);
        const events = await ledgerEventsFor(context, [...tasks.values()]);
        const holders = new Map<string, LedgerStudent[]>();
        for (const task of tasks.values()) {
          holders.set(task.taskId, all.filter((student) => {
            const stage = stageOf(task, events.get(task.taskInstanceId)?.get(student.studentId), context.now).stage;
            return stage !== 'UNASSIGNED' && stage !== request.stage;
          }));
        }
        const studentIds = [...new Set([...holders.values()].flat().map((student) => student.studentId))].sort();
        const locked = await lockStudents(context, studentIds);
        const balances = await readBalances(context.tx, tenantId, studentIds, true);
        let changed = 0;
        const touched = new Set<string>();
        for (const task of tasks.values()) {
          for (const holder of holders.get(task.taskId) ?? []) {
            const moved = await moveStudent(context, { task, student: locked.get(holder.studentId)!, stage: request.stage, withReward: false,
              cause: 'RESET', events: events.get(task.taskInstanceId)?.get(holder.studentId), balances });
            if (moved.changed) { changed += 1; touched.add(task.taskInstanceId); }
          }
        }
        await bumpVersions(context, touched);
        return { changed };
      }, (value) => ({ taskIds: request.taskIds, stage: request.stage, changed: value.changed }));
      return { tasks: await readTasks(request.taskIds) };
    },

    async setRepeat(request: SetRepeatRequest): Promise<{ tasks: AdminTaskDto[] }> {
      await withOperation('repeat', request.operationId, request, async (context) => {
        const tasks = await lockTasks(context, request.taskIds);
        const students = await readLedgerStudents(context.tx, tenantId);
        const balances = await readBalances(context.tx, tenantId, students.map((student) => student.studentId), true);
        const events = await ledgerEventsFor(context, [...tasks.values()]);
        let changed = 0;
        for (const task of tasks.values()) {
          const inForce = scheduleInForce(task.currentSchedule, task.pendingSchedule, context.now);
          if (task.pendingSchedule === null && sameRepeatSetting(repeatSettingOf(inForce), request.repeat)) continue;
          await settleResets(context, task, students, events.get(task.taskInstanceId), balances);
          const schedule = scheduleForRepeat(inForce, request.repeat, context.now);
          await context.tx.execute(sql`
            UPDATE tasks SET current_schedule=${JSON.stringify(schedule)}::jsonb, pending_schedule=NULL, version=version+1,
              updated_at=GREATEST(${context.now}::timestamptz, updated_at)
            WHERE tenant_id=${tenantId} AND task_instance_id=${task.taskInstanceId}`);
          changed += 1;
        }
        return { changed };
      }, (value) => ({ taskIds: request.taskIds, changed: value.changed }));
      return { tasks: await readTasks(request.taskIds) };
    },

    async qrStage(request: QrStageRequest): Promise<QrStageResultDto> {
      if (!dependencies.resolveStudentQr) throw new TaskLedgerError('QR_UNAVAILABLE', 'QR을 확인할 수 없어요.', 503);
      let studentId: string;
      try {
        studentId = dependencies.resolveStudentQr(request.studentQr);
      } catch (error) {
        if (error instanceof TaskLedgerError) throw error;
        throw new TaskLedgerError('STUDENT_NOT_FOUND', '등록된 학생 QR이 아니에요. 다시 찍어 주세요.', 404);
      }
      const result = await withOperation('qr', request.operationId, { ...request, studentQr: undefined, studentId }, async (context) => {
        const tasks = await lockTasks(context, [request.taskId]);
        const task = tasks.get(request.taskId)!;
        let students: Map<string, LedgerStudent>;
        try {
          students = await lockStudents(context, [studentId]);
        } catch {
          throw new TaskLedgerError('STUDENT_NOT_FOUND', '이 학급 학생의 QR이 아니에요. 다시 찍어 주세요.', 404);
        }
        const student = students.get(studentId)!;
        if (student.status !== 'ACTIVE') throw new TaskLedgerError('STUDENT_INACTIVE', '쉬고 있는 학생이에요. 학생 목록에서 확인해 주세요.', 409);
        const balances = await readBalances(context.tx, tenantId, [studentId], true);
        const events = (await ledgerEventsFor(context, [task], studentId)).get(task.taskInstanceId)?.get(studentId);
        const previousStage = stageOf(task, events, context.now).stage;
        const moved = await moveStudent(context, { task, student, stage: request.stage, withReward: request.withReward === true,
          cause: 'QR', events, balances });
        if (moved.changed) await bumpVersions(context, [task.taskInstanceId]);
        return { previousStage, changed: moved.changed, name: student.name };
      }, (value) => ({ taskId: request.taskId, studentId, previousStage: value.previousStage, changed: value.changed }));
      const [task] = await readTasks([request.taskId]);
      if (!task) throw new TaskLedgerError('TASK_NOT_FOUND', '과제를 찾을 수 없어요. 목록을 새로 불러와 주세요.', 404);
      const row = task.students.find((entry) => entry.studentId === studentId);
      const name = result.value?.name ?? await studentName(studentId);
      return { task, student: { studentId, name }, previousStage: result.value?.previousStage ?? row?.stage ?? request.stage,
        stage: row?.stage ?? request.stage, changed: result.value?.changed ?? false };
    },
  };

  async function replayedTaskId(operationId: string): Promise<string> {
    const read = dependencies.runTenantSnapshot ?? dependencies.runTenantTransaction;
    return read(tenantId, async (tx) => {
      const result = await tx.execute(sql`SELECT result_snapshot->>'taskId' AS task_id FROM operations
        WHERE tenant_id=${tenantId} AND operation_id=${operationId}`);
      const value = (result.rows[0] as { task_id?: unknown } | undefined)?.task_id;
      if (typeof value !== 'string') throw new TaskLedgerError('OPERATION_CONFLICT', '과제를 만든 결과를 찾지 못했어요. 목록을 새로 불러와 주세요.');
      return value;
    });
  }

  async function studentName(studentId: string): Promise<string> {
    const read = dependencies.runTenantSnapshot ?? dependencies.runTenantTransaction;
    return read(tenantId, async (tx) => (await readLedgerStudents(tx, tenantId, { studentIds: [studentId] }))[0]?.name ?? studentId);
  }
}
