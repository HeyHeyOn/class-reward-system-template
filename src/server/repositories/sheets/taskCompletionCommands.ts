import { projectTaskCycleState } from '@/domain/taskCycleState';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { ClassTask, Student, TaskCompletion, Transaction } from '@/domain/types';
import { buildTaskCompletionAppendRow, buildTransactionAppendRow, createHeaderIndex, parseStudentRow } from '@/server/sheetsRows';
import type { RecurringSchemaMigrationStore } from '@/server/storage/tabularStore';
import { migrateRecurringTaskSchema } from './recurringSchemaMigrator';
import { mutateTaskAssignmentNow } from './taskAssignmentCommands';
import { enqueueTaskCommand, taskCommandQueueKey } from './taskCommandQueue';
import { readTaskAssignmentsIfPresent, readTaskCompletions } from './taskCycleQueries';

export type TaskCompletionMutation = {
  store: RecurringSchemaMigrationStore;
  task: ClassTask;
  taskRowNumber: number;
  student: Student;
  studentRowNumber: number;
  completed: boolean;
  source: 'BANK' | 'ADMIN';
  now?: string;
};

export type TaskCompletionMutationResult = {
  changed: boolean;
  completion: TaskCompletion | null;
  balanceAfter: number;
};

export class TaskCompletionReconciliationError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'TaskCompletionReconciliationError';
    this.cause = cause;
  }
}

const TRANSACTION_HEADERS = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];

/** Process-local sequential retry protection; no cross-process exactly-once guarantee is made. */
export function mutateTaskCompletion(mutation: TaskCompletionMutation): Promise<TaskCompletionMutationResult> {
  return enqueueTaskCommand(
    taskCommandQueueKey(mutation.task.taskId, mutation.task.taskInstanceId),
    () => mutateTaskCompletionNow(mutation),
  );
}

export async function mutateTaskCompletionNow(mutation: TaskCompletionMutation): Promise<TaskCompletionMutationResult> {
  const { store, task } = mutation;
  if (!task.taskInstanceId || !task.schedule) throw new Error('task completion mutation requires a task instance and schedule');
  const now = mutation.now ?? new Date().toISOString();

  // Migration and assignment validation/materialization must finish before balance or completion mutation.
  await migrateRecurringTaskSchema(store);
  const studentRows = await store.getRows('Students');
  const studentHeaders = studentRows[0];
  if (!studentHeaders) throw new Error('학생 정보를 찾을 수 없습니다.');
  const studentIndex = createHeaderIndex(studentHeaders);
  const observed = studentRows.slice(1).map((row, index) => ({ student: parseStudentRow(row, studentIndex), rowNumber: index + 2 }))
    .find((record) => record.student?.studentId === mutation.student.studentId);
  if (!observed?.student || observed.student.status !== 'ACTIVE') throw new Error('학생 정보를 찾을 수 없습니다.');
  const student = observed.student;
  const studentRowNumber = observed.rowNumber;
  let assignments = await readTaskAssignmentsIfPresent(store);
  let completions = await readTaskCompletions(store);
  let state = projectTaskCycleState({ task, now, assignments, completions });
  let studentState = state.students[student.studentId];
  const resetCompletionEvent = mutation.source === 'ADMIN' && !mutation.completed
    && studentState?.completed && !studentState.assigned
    ? studentState.completionEvent ?? null
    : null;
  const resetAssignmentId = resetCompletionEvent
    ? resetCompletionEvent.assignmentId || legacyCompletionReference(resetCompletionEvent.completionId)
    : '';
  let assignmentId: string;

  if (resetCompletionEvent) {
    // A reset negates the effective completion event. It retains that event's assignment
    // snapshot, or an explicit stable legacy reference, and never creates an assignment.
    assignmentId = resetAssignmentId;
  } else {
    if (state.assignedStudentIds.length === 0) throw new Error('부여된 학생이 없습니다.');
    if (!(studentState?.assigned ?? false)) throw new Error('허가되지 않은 과제입니다.');

    await mutateTaskAssignmentNow(store, {
      task,
      taskRowNumber: mutation.taskRowNumber,
      studentId: student.studentId,
      assigned: true,
      source: 'ADMIN',
      now,
      note: 'completion assignment materialization',
    });
    assignments = await readTaskAssignmentsIfPresent(store);
    completions = await readTaskCompletions(store);
    state = projectTaskCycleState({ task, now, assignments, completions });
    studentState = state.students[student.studentId];
    assignmentId = studentState?.assignmentEvent?.assignmentId ?? '';
    if (!studentState?.assigned || !assignmentId) throw new Error('허가되지 않은 과제입니다.');
  }

  const schedule = resolveTaskSchedule({ currentSchedule: task.schedule, pendingSchedule: task.pendingSchedule ?? null, now });
  const headers = (await store.getRows('TaskCompletions'))[0];
  if (!headers) throw new Error('TaskCompletions 시트에 헤더가 없습니다.');

  if (!resetCompletionEvent
    && (studentState.completionOrigin === 'CARRY' || studentState.completionOrigin === 'LEGACY')
    && studentState.completionEvent) {
    const carry = createCompletion({
      task, student, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
      assignmentId, timestamp: now, source: 'CARRY_FORWARD', status: studentState.completed ? 'SUCCESS' : 'RESET',
      reward: 0, balanceBefore: student.balance, balanceAfter: student.balance, note: 'materialized cycle carry',
    });
    await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(headers, carry));
    completions.push(carry);
    state = projectTaskCycleState({ task, now, assignments, completions });
  }

  const effectiveCompleted = state.students[student.studentId]?.completed ?? false;
  if (mutation.source === 'BANK' && effectiveCompleted) throw new Error('이미 완료한 과제입니다.');
  if (mutation.source === 'ADMIN' && effectiveCompleted === mutation.completed) {
    return { changed: false, completion: state.students[student.studentId]?.completionEvent ?? null, balanceAfter: student.balance };
  }
  if (mutation.source === 'BANK' && !mutation.completed) throw new Error('과제 완료 요청 형식이 올바르지 않습니다.');

  const isReward = mutation.source === 'BANK';
  const balanceAfter = isReward ? student.balance + task.reward : student.balance;
  const source = mutation.source === 'ADMIN' && !mutation.completed ? 'ADMIN_RESET' : mutation.source;
  const completion = createCompletion({
    task, student, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
    assignmentId, timestamp: now, source, status: mutation.completed ? 'SUCCESS' : 'RESET',
    reward: isReward ? task.reward : 0, balanceBefore: student.balance, balanceAfter,
    note: source === 'BANK' ? 'bank-self-completion' : source === 'ADMIN' ? 'admin-completion' : 'admin-reset',
  });

  if (isReward) {
    await store.updateCell('Students', studentRowNumber, 'balance', balanceAfter);
    try {
      await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(headers, completion));
    } catch (appendError) {
      let appendWasObserved: boolean;
      try {
        appendWasObserved = (await readTaskCompletions(store))
          .some((event) => event.completionId === completion.completionId);
      } catch (readError) {
        throw new TaskCompletionReconciliationError(
          'TASK_COMPLETION_APPEND_OUTCOME_UNKNOWN',
          readError,
        );
      }
      if (!appendWasObserved) {
        try {
          await store.updateCell('Students', studentRowNumber, 'balance', completion.balanceBefore);
        } catch (compensationError) {
          throw new TaskCompletionReconciliationError(
            'TASK_COMPLETION_BALANCE_COMPENSATION_FAILED',
            compensationError,
          );
        }
        throw appendError;
      }
    }
  } else {
    await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(headers, completion));
  }
  if (isReward) await appendRewardTransaction(store, task, completion);
  return { changed: true, completion, balanceAfter };
}

function legacyCompletionReference(completionId: string): string {
  return `LEGACY_COMPLETION:${encodeURIComponent(completionId)}`;
}

function createCompletion(input: {
  task: ClassTask; student: Student; cycle: { cycleId: string; startsAt: string; endsAt: string | null };
  ruleVersion: number; timeZone: string; assignmentId: string; timestamp: string;
  source: TaskCompletion['source']; status: string; reward: number; balanceBefore: number; balanceAfter: number; note: string;
}): TaskCompletion {
  return {
    completionId: `TC-${crypto.randomUUID()}`,
    timestamp: input.timestamp,
    taskId: input.task.taskId,
    studentId: input.student.studentId,
    studentName: input.student.name,
    reward: input.reward,
    balanceBefore: input.balanceBefore,
    balanceAfter: input.balanceAfter,
    status: input.status,
    note: input.note,
    taskInstanceId: input.task.taskInstanceId!,
    cycleId: input.cycle.cycleId,
    cycleStartsAt: input.cycle.startsAt,
    cycleEndsAt: input.cycle.endsAt,
    ruleVersion: input.ruleVersion,
    timeZone: input.timeZone,
    source: input.source,
    assignmentId: input.assignmentId,
    schemaVersion: 2,
  };
}

async function appendRewardTransaction(store: RecurringSchemaMigrationStore, task: ClassTask, completion: TaskCompletion): Promise<void> {
  let headers = TRANSACTION_HEADERS;
  try { headers = (await store.getRows('Transactions'))[0] ?? TRANSACTION_HEADERS; } catch { /* best effort */ }
  const transaction: Transaction = {
    transactionId: `TASK-${completion.completionId}`, timestamp: completion.timestamp,
    studentId: completion.studentId, studentName: completion.studentName,
    items: [{ productId: task.taskId, name: task.title, price: -task.reward, quantity: 1, subtotal: -task.reward }],
    totalAmount: -task.reward, balanceBefore: completion.balanceBefore, balanceAfter: completion.balanceAfter,
    status: 'TASK_REWARD', operator: 'bank',
  };
  await store.appendRow('Transactions', buildTransactionAppendRow(headers, transaction)).catch(() => undefined);
}
