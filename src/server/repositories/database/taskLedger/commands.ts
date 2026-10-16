import 'server-only';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { allocatePadletPosts, PADLET_SUMMARY_LIMIT, type PadletAllocation, type PadletLinkedTask, type PadletPost } from '@/domain/padlet';
import { lastResetAt } from '@/domain/taskLedger';
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
import { insertPadletUse, lockPadletBoardSyncAttempt, readPadletBoardSyncs, readPadletLinks, readPadletUses, recordPadletBoardSync, type PadletLinkRow } from '../padletStore';
import { boardKeyOf, insertBoardUse, lockBoardLinkSyncAttempt, readBoardLinks, readBoardLinkSyncs, readBoardUses, recordBoardLinkSync } from '../boardStore';
import { applyTaskGrowth, type TaskGrowthInput } from '../taskGrowth';
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
  taskWindows,
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
  resolveStudentQr?: (value: string) => string | Promise<string>;
}>;

type Context = {
  tx: TenantTransaction;
  tenantId: string;
  now: string;
  ledgerFrom: string;
  operationId: string;
  payloadHash: string;
  growth: TaskGrowthInput[];
};

/** Why an event was written; shown in the history (the ID prefix keeps it). */
type Cause = 'TEACHER' | 'QR' | 'RESET' | 'PADLET' | 'BOARD';
const CAUSE_PREFIX: Readonly<Record<Cause, { stage: 'tl-a' | 'tl-q' | 'tl-r' | 'tl-p' | 'tl-b'; completion: 'tl-c' | 'tl-cq' | 'tl-cr' | 'tl-cp' | 'tl-cb' }>> = {
  TEACHER: { stage: 'tl-a', completion: 'tl-c' },
  QR: { stage: 'tl-q', completion: 'tl-cq' },
  RESET: { stage: 'tl-r', completion: 'tl-cr' },
  // A Padlet post only ever makes 미완료 into 완료 가능.
  PADLET: { stage: 'tl-p', completion: 'tl-cp' },
  // So does a 딴쌤 board post or submission.
  BOARD: { stage: 'tl-b', completion: 'tl-cb' },
};

/** A post or submission the 딴쌤 board counts for one student (app links 8-2 evidence). */
export type BoardEvidence = Readonly<{ id: string; createdAt: string; studentId: string }>;

/** A linked task as the Padlet rules see it: open from its start or latest reset until 마감. */
function padletLinkedTask(task: LedgerTask, link: Pick<PadletLinkRow, 'sectionId'>, now: string): PadletLinkedTask {
  const opens = [task.createdAt, task.availableFrom, lastResetAt(taskWindows(task), now)]
    .filter((value): value is string => typeof value === 'string')
    .reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
  return { taskId: task.taskInstanceId, title: task.title, sortOrder: task.sortOrder, prerequisiteTaskId: task.prerequisiteTaskInstanceId,
    sectionId: link.sectionId, opensAt: opens, closesAt: task.dueAt, visible: task.isActive };
}

const eventId = ledgerEventId;

function boardDto(link: Awaited<ReturnType<typeof readBoardLinks>>[number] | undefined,
  syncs: Map<string, Awaited<ReturnType<typeof readBoardLinkSyncs>>[number]>): AdminTaskDto['board'] {
  if (!link) return null;
  const sync = syncs.get(boardKeyOf(link));
  return { boardId: link.boardId, boardCode: link.boardCode, boardTitle: link.boardTitle, boardFormat: link.boardFormat,
    groupId: link.groupId, groupName: link.groupName, lastReadAt: sync?.succeededAt ?? null, error: sync?.errorCode ?? null,
    checking: sync?.checking ?? false };
}

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
      const growth: TaskGrowthInput[] = [];
      const value = await body({ tx, tenantId, now, ledgerFrom, operationId, payloadHash, growth });
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
      for (const entry of growth) await applyTaskGrowth(tx, tenantId, entry);
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
      const links = new Map((await readPadletLinks(tx, tenantId)).map((link) => [link.taskInstanceId, link]));
      const syncs = links.size ? new Map((await readPadletBoardSyncs(tx, tenantId)).map((sync) => [sync.boardId, sync])) : new Map();
      const boardLinks = new Map((await readBoardLinks(tx, tenantId)).map((link) => [link.taskInstanceId, link]));
      const boardSyncs = boardLinks.size ? new Map((await readBoardLinkSyncs(tx, tenantId)).map((sync) => [sync.boardKey, sync])) : new Map();
      return {
        now: new Date(now).toISOString(),
        tasks: sortTasks(tasks.map((task) => {
          const link = links.get(task.taskInstanceId);
          return { ...buildAdminTaskDto(task, students, events.get(task.taskInstanceId), now),
            padlet: link ? { boardId: link.boardId, boardTitle: link.boardTitle, boardUrl: link.boardUrl,
              sectionId: link.sectionId, sectionTitle: link.sectionTitle,
              lastReadAt: syncs.get(link.boardId)?.succeededAt ?? null, error: syncs.get(link.boardId)?.errorCode ?? null,
              checking: syncs.get(link.boardId)?.checking ?? false, retryAt: syncs.get(link.boardId)?.retryAt ?? null } : null,
            board: boardDto(boardLinks.get(task.taskInstanceId), boardSyncs) };
        })),
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
      context.growth.push(paid.growth);
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

  /** Who a board's posts move, from the stages and uses as they are in `tx`. Null when no task uses the board. */
  async function planPadlet(tx: TenantTransaction, now: string, boardId: string, posts: readonly PadletPost[], lock: boolean): Promise<{
    allocation: PadletAllocation;
    tasks: Map<string, LedgerTask>;
    students: Map<string, LedgerStudent>;
    events: Awaited<ReturnType<typeof readCurrentLedgerStates>>;
  } | null> {
    let links = await readPadletLinks(tx, tenantId, boardId);
    if (links.length === 0) return null;
    const tasks = new Map((await readLedgerTasks(tx, tenantId, { taskInstanceIds: links.map((link) => link.taskInstanceId), lock }))
      .map((task) => [task.taskInstanceId, task]));
    if (lock) {
      // A relink/unlink may have committed while task locks were acquired. Only the links
      // still protected by those task locks can participate in this attempt's allocation.
      links = (await readPadletLinks(tx, tenantId, boardId)).filter((link) => tasks.has(link.taskInstanceId));
      if (links.length === 0) return null;
    }
    const students = new Map((await readLedgerStudents(tx, tenantId)).map((student) => [student.studentId, student]));
    const events = await readCurrentLedgerStates(tx, tenantId, now, { taskInstanceIds: [...tasks.keys()] });
    const uses = await readPadletUses(tx, tenantId, [...tasks.keys()]);
    const allocation = allocatePadletPosts({
      tasks: links.flatMap((link) => {
        const task = tasks.get(link.taskInstanceId);
        return task ? [padletLinkedTask(task, link, now)] : [];
      }),
      students: [...students.values()].map((student) => ({ studentId: student.studentId, name: student.name, active: student.status === 'ACTIVE' })),
      stageOf: (taskInstanceId, studentId) => stageOf(tasks.get(taskInstanceId)!, events.get(taskInstanceId)?.get(studentId), now).stage,
      // Sent back to 미완료 (a reset or the teacher's change): only posts written after that count.
      sinceOf: (taskInstanceId, studentId) => stageOf(tasks.get(taskInstanceId)!, events.get(taskInstanceId)?.get(studentId), now).since,
      posts,
      uses: uses.map((use) => ({ taskId: use.taskInstanceId, postId: use.postId, studentId: use.studentId })),
      now,
    });
    return { allocation, tasks, students, events };
  }

  /** Who a board key's evidence moves, from the stages and uses as they are in `tx`. Null when no task uses it. */
  async function planBoardEvidence(tx: TenantTransaction, now: string, boardKey: string, evidence: readonly BoardEvidence[], lock: boolean) {
    let links = await readBoardLinks(tx, tenantId, boardKey);
    if (links.length === 0) return null;
    const tasks = new Map((await readLedgerTasks(tx, tenantId, { taskInstanceIds: links.map((link) => link.taskInstanceId), lock }))
      .map((task) => [task.taskInstanceId, task]));
    if (lock) {
      links = (await readBoardLinks(tx, tenantId, boardKey)).filter((link) => tasks.has(link.taskInstanceId));
      if (links.length === 0) return null;
    }
    const students = new Map((await readLedgerStudents(tx, tenantId)).map((student) => [student.studentId, student]));
    const events = await readCurrentLedgerStates(tx, tenantId, now, { taskInstanceIds: [...tasks.keys()] });
    const uses = await readBoardUses(tx, tenantId, [...tasks.keys()]);
    // The board answers for one student at a time: its items carry the student, and fit the linked group.
    const allocation = allocatePadletPosts({
      tasks: links.flatMap((link) => {
        const task = tasks.get(link.taskInstanceId);
        return task ? [padletLinkedTask(task, { sectionId: null }, now)] : [];
      }),
      students: [...students.values()].map((student) => ({ studentId: student.studentId, name: student.name, active: student.status === 'ACTIVE' })),
      stageOf: (taskInstanceId, studentId) => stageOf(tasks.get(taskInstanceId)!, events.get(taskInstanceId)?.get(studentId), now).stage,
      sinceOf: (taskInstanceId, studentId) => stageOf(tasks.get(taskInstanceId)!, events.get(taskInstanceId)?.get(studentId), now).since,
      posts: evidence.map((item) => ({ id: item.id, createdAt: item.createdAt, status: 'approved' as const, authorName: '', subject: '',
        sectionId: null, url: null, studentId: item.studentId })),
      uses: uses.map((use) => ({ taskId: use.taskInstanceId, postId: use.evidenceId, studentId: use.studentId })),
      now,
    });
    return { allocation, tasks, students, events, boardId: links[0].boardId };
  }

  return {
    readTasks,
    readBoard,

    /**
     * Moves the students whose board posts or submissions count to 완료 가능, under the task locks and the
     * board key's sync token (so two reads never use an item twice).
     */
    async applyBoardEvidence(input: Readonly<{ operationId: string; boardKey: string; evidence: readonly BoardEvidence[]; syncAttemptId: string }>): Promise<{ moved: number }> {
      const request = { boardKey: input.boardKey, syncAttemptId: input.syncAttemptId,
        evidence: input.evidence.map((item) => [item.id, item.createdAt, item.studentId]) };
      const result = await withOperation('board', input.operationId, request, async (context) => {
        context.now = await clockNow(context.tx);
        const plan = await planBoardEvidence(context.tx, context.now, input.boardKey, input.evidence, true);
        if (!plan) return { moved: 0, taskIds: [] as string[] };
        if (!await lockBoardLinkSyncAttempt(context.tx, tenantId, input.boardKey, input.syncAttemptId)) return { moved: 0, taskIds: [] as string[] };
        const touched = new Set<string>();
        for (const move of plan.allocation.moves) {
          const task = plan.tasks.get(move.taskId)!;
          const student = plan.students.get(move.studentId)!;
          const moved = await moveStudent(context, { task, student, stage: 'READY', withReward: false, cause: 'BOARD',
            events: plan.events.get(task.taskInstanceId)?.get(student.studentId), balances: new Map() });
          if (moved.changed) touched.add(task.taskInstanceId);
          await insertBoardUse(context.tx, tenantId, { taskInstanceId: task.taskInstanceId, evidenceId: move.postId, boardId: plan.boardId,
            studentId: student.studentId, evidenceCreatedAt: move.postCreatedAt, operationId: context.operationId });
        }
        await bumpVersions(context, touched);
        await recordBoardLinkSync(context.tx, tenantId, input.boardKey, { ok: true }, input.syncAttemptId);
        return { moved: plan.allocation.moves.length, taskIds: [...touched].map((id) => plan.tasks.get(id)!.taskId).sort() };
      }, (value) => ({ taskIds: value.taskIds, boardKey: input.boardKey, moved: value.moved }));
      return { moved: result.value?.moved ?? 0 };
    },

    /** What a board's posts would do now, without writing (most reads change nothing). */
    async planPadletBoard(boardId: string, posts: readonly PadletPost[]): Promise<PadletAllocation | null> {
      await ensureTaskLedger(dependencies);
      const read = dependencies.runTenantSnapshot ?? dependencies.runTenantTransaction;
      return read(tenantId, async (tx) => (await planPadlet(tx, await clockNow(tx), boardId, posts, false))?.allocation ?? null);
    },

    /**
     * Moves the students whose posts count to 완료 가능 (recomputed under the task locks, so two
     * reads of the same board never use a post twice) and keeps the board's summary.
     */
    async applyPadletBoard(input: Readonly<{ operationId: string; boardId: string; posts: readonly PadletPost[]; syncAttemptId?: string }>): Promise<{ moved: number }> {
      const request = { boardId: input.boardId, ...(input.syncAttemptId ? { syncAttemptId: input.syncAttemptId } : {}),
        posts: input.posts.map((post) => [post.id, post.createdAt, post.status, post.authorName, post.subject, post.sectionId]) };
      const result = await withOperation('padlet', input.operationId, request, async (context) => {
        context.now = await clockNow(context.tx);
        const plan = await planPadlet(context.tx, context.now, input.boardId, input.posts, true);
        if (!plan) return { moved: 0, taskIds: [] as string[] };
        // The lock order matches unlink: task rows first, then the board sync row. Its token
        // remains locked through stage changes, post uses and the final result write.
        if (!await lockPadletBoardSyncAttempt(context.tx, tenantId, input.boardId, input.syncAttemptId)) {
          return { moved: 0, taskIds: [] as string[] };
        }
        const touched = new Set<string>();
        for (const move of plan.allocation.moves) {
          const task = plan.tasks.get(move.taskId)!;
          const student = plan.students.get(move.studentId)!;
          const moved = await moveStudent(context, { task, student, stage: 'READY', withReward: false, cause: 'PADLET',
            events: plan.events.get(task.taskInstanceId)?.get(student.studentId), balances: new Map() });
          if (moved.changed) touched.add(task.taskInstanceId);
          await insertPadletUse(context.tx, tenantId, { taskInstanceId: task.taskInstanceId, postId: move.postId, boardId: input.boardId,
            studentId: student.studentId, postCreatedAt: move.postCreatedAt, operationId: context.operationId });
        }
        await bumpVersions(context, touched);
        await recordPadletBoardSync(context.tx, tenantId, input.boardId,
          { ok: true, summary: plan.allocation.outcomes.slice(0, PADLET_SUMMARY_LIMIT) }, input.syncAttemptId);
        return { moved: plan.allocation.moves.length, taskIds: [...touched].map((id) => plan.tasks.get(id)!.taskId).sort() };
      }, (value) => ({ taskIds: value.taskIds, boardId: input.boardId, moved: value.moved }));
      return { moved: result.value?.moved ?? 0 };
    },

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
        studentId = await dependencies.resolveStudentQr(request.studentQr);
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
