import { projectTaskCycleState } from '@/domain/taskCycleState';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { ClassTask, Student, TaskAssignment, TaskAssignmentSource, TaskCompletion } from '@/domain/types';
import { getTaskRecords } from '@/server/sheetsRepository';
import {
  buildTaskAssignmentAppendRow,
  buildTaskCompletionAppendRow,
  createHeaderIndex,
  parseStudentRow,
  parseTaskAssignmentRows,
  parseTaskCompletionRow,
  requireColumns,
  REQUIRED_TASK_ASSIGNMENT_COLUMNS,
  REQUIRED_TASK_COMPLETION_COLUMNS,
} from '@/server/sheetsRows';
import type { RecurringSchemaMigrationStore } from '@/server/storage/tabularStore';
import { migrateRecurringTaskSchema } from './recurringSchemaMigrator';
import { enqueueTaskCommand, taskCommandQueueKey } from './taskCommandQueue';
import { readTaskCompletions } from './taskCycleQueries';

export type TaskAssignmentMutation = {
  task: ClassTask;
  taskRowNumber: number;
  studentId: string;
  assigned: boolean;
  source: Extract<TaskAssignmentSource, 'ADMIN' | 'QR'>;
  now?: string;
  note?: string;
  schemaReady?: boolean;
};

export type TaskAssignmentMutationResult = {
  changed: boolean;
  assignment: TaskAssignment | null;
  assignedStudentIds: string[];
  legacyMirrorWarning?: string;
};

export type TaskBatchAssignmentOperation = {
  studentId: string;
  assigned?: boolean;
  completed?: boolean;
  source: 'ADMIN';
};

export type TaskBatchAssignmentTarget = {
  taskId: string;
  operations: TaskBatchAssignmentOperation[];
};

export type TaskBatchAssignmentFailure = {
  taskId: string;
  studentId: string;
  code: 'OPERATION_FAILED';
};

export type TaskBatchAssignmentWarning = {
  taskId: string;
  code: 'LEGACY_MIRROR_UPDATE_FAILED';
};

export type TaskBatchAssignmentResult = {
  appliedCount: number;
  failures: TaskBatchAssignmentFailure[];
  warnings?: TaskBatchAssignmentWarning[];
  aborted?: true;
  notAttempted?: Array<{ taskId: string; studentId: string }>;
};

const MAX_BATCH_TASKS = 20;
const MAX_BATCH_OPERATIONS = 40;
const MAX_BATCH_TOTAL_OPERATIONS = 100;
const MAX_BATCH_CANONICAL_APPENDS = 250;

export async function updateTaskAssignmentsBatch(
  store: RecurringSchemaMigrationStore,
  requestedTargets: TaskBatchAssignmentTarget[],
  options: { now?: () => string } = {},
): Promise<TaskBatchAssignmentResult> {
  validateBatchInput(requestedTargets);

  return enqueueTaskCommand(taskCommandQueueKey(''), async () => {
    const now = options.now?.() ?? new Date().toISOString();
    await migrateRecurringTaskSchema(store);
    const [records, studentRows, assignmentRows, completionRows] = await Promise.all([
      getTaskRecords(store),
      store.getRows('Students'),
      store.getRowsFresh ? store.getRowsFresh('TaskAssignments') : store.getRows('TaskAssignments'),
      store.getRowsFresh ? store.getRowsFresh('TaskCompletions') : store.getRows('TaskCompletions'),
    ]);
    const [studentHeaders, ...studentDataRows] = studentRows;
    if (!studentHeaders) throw new Error('학생 정보를 찾을 수 없습니다.');
    const studentIndex = createHeaderIndex(studentHeaders);
    const studentsById = new Map<string, { student: Student; rowNumber: number }>();
    studentDataRows.forEach((row, index) => {
      const student = parseStudentRow(row, studentIndex);
      if (student?.status === 'ACTIVE') studentsById.set(student.studentId, { student, rowNumber: index + 2 });
    });

    const [assignmentHeaders, ...assignmentDataRows] = assignmentRows;
    if (!assignmentHeaders) throw new Error('TaskAssignments 시트에 헤더가 없습니다.');
    const assignmentIndex = createHeaderIndex(assignmentHeaders);
    const requiredAssignments = requireColumns(assignmentIndex, REQUIRED_TASK_ASSIGNMENT_COLUMNS);
    if (requiredAssignments.ok === false) {
      throw new Error(`TaskAssignments 시트에 필수 컬럼이 없습니다: ${requiredAssignments.missingColumns.join(', ')}`);
    }
    const assignments = parseTaskAssignmentRows(assignmentDataRows, assignmentIndex);

    const [completionHeaders, ...completionDataRows] = completionRows;
    if (!completionHeaders) throw new Error('TaskCompletions 시트에 헤더가 없습니다.');
    const completionIndex = createHeaderIndex(completionHeaders);
    const requiredCompletions = requireColumns(completionIndex, REQUIRED_TASK_COMPLETION_COLUMNS);
    if (requiredCompletions.ok === false) {
      throw new Error(`TaskCompletions 시트에 필수 컬럼이 없습니다: ${requiredCompletions.missingColumns.join(', ')}`);
    }
    const completions = completionDataRows
      .map((row) => parseTaskCompletionRow(row, completionIndex))
      .filter((event): event is TaskCompletion => event !== null);

    const recordsById = new Map(records.map((record) => [record.task.taskId, record]));
    const targets = requestedTargets.map((target) => {
      const record = recordsById.get(target.taskId);
      if (!record) throw new Error(`과제를 찾을 수 없습니다: ${target.taskId}`);
      if (!record.task.taskInstanceId || !record.task.schedule || record.task.scheduleReadWarnings?.length) {
        throw new Error(`과제 일정 데이터가 손상되었습니다: ${target.taskId}`);
      }
      return { record, operations: target.operations };
    });
    for (const target of requestedTargets) {
      for (const operation of target.operations) {
        if (!studentsById.has(operation.studentId)) {
          throw new Error(`학생 정보를 찾을 수 없습니다: ${operation.studentId}`);
        }
      }
    }

    const context: BatchMutationContext = {
      store, now, assignmentHeaders, completionHeaders, assignments, completions,
      assignmentTouchedTaskIds: new Set(),
      canonicalAppendCount: 0,
    };
    let appliedCount = 0;
    const failures: TaskBatchAssignmentFailure[] = [];
    const work = targets.flatMap(({ record, operations }) => operations.map((operation) => ({ record, operation })));
    let abortedAt = -1;
    for (let workIndex = 0; workIndex < work.length; workIndex += 1) {
      const { record, operation } = work[workIndex];
        const student = studentsById.get(operation.studentId)!.student;
        const initialStudentState = projectTaskCycleState({
          task: record.task, now, assignments, completions,
        }).students[student.studentId];
        const assignmentChanges = operation.assigned !== undefined
          && (initialStudentState?.assigned ?? false) !== operation.assigned;
        const completionChanges = operation.completed !== undefined
          && (initialStudentState?.completed ?? false) !== operation.completed;
        try {
          const mutateAssignment = async () => {
            if (operation.assigned === undefined) return;
            await mutateBatchAssignment(context, record.task, student.studentId, operation.assigned);
          };
          const mutateCompletion = async () => {
            if (operation.completed === undefined) return;
            await mutateBatchCompletion(context, record.task, student, operation.completed);
          };
          if (operation.assigned === false && operation.completed !== undefined) {
            await mutateCompletion();
            await mutateAssignment();
          } else {
            await mutateAssignment();
            await mutateCompletion();
          }
          if (assignmentChanges || completionChanges) appliedCount += 1;
        } catch (error) {
          failures.push({ taskId: record.task.taskId, studentId: student.studentId, code: 'OPERATION_FAILED' });
          if (error instanceof BatchProviderAbortError) {
            abortedAt = workIndex;
            break;
          }
        }
    }

    const warnings = await mirrorBatchAssignments(
      context,
      recordsById,
      new Set(requestedTargets.map((target) => target.taskId)),
    );
    const result: TaskBatchAssignmentResult = { appliedCount, failures };
    if (warnings.length > 0) result.warnings = warnings;
    if (abortedAt >= 0) {
      result.aborted = true;
      result.notAttempted = work.slice(abortedAt + 1).map(({ record, operation }) => ({
        taskId: record.task.taskId, studentId: operation.studentId,
      }));
    }
    return result;
  });
}

type BatchMutationContext = {
  store: RecurringSchemaMigrationStore;
  now: string;
  assignmentHeaders: string[];
  completionHeaders: string[];
  assignments: TaskAssignment[];
  completions: TaskCompletion[];
  assignmentTouchedTaskIds: Set<string>;
  canonicalAppendCount: number;
};

class BatchProviderAbortError extends Error {
  constructor() {
    super('batch provider operation aborted');
    this.name = 'BatchProviderAbortError';
  }
}

function reserveCanonicalAppend(context: BatchMutationContext): void {
  if (context.canonicalAppendCount >= MAX_BATCH_CANONICAL_APPENDS) throw new BatchProviderAbortError();
  context.canonicalAppendCount += 1;
}

async function appendBatchAssignment(context: BatchMutationContext, assignment: TaskAssignment): Promise<void> {
  reserveCanonicalAppend(context);
  try {
    await context.store.appendRow(
      'TaskAssignments',
      buildTaskAssignmentAppendRow(context.assignmentHeaders, assignment),
    );
  } catch (error) {
    try {
      assignment = await reconcileAssignmentAppend(context.store, assignment.assignmentId, error);
    } catch {
      throw new BatchProviderAbortError();
    }
  }
  if (!context.assignments.some((event) => event.assignmentId === assignment.assignmentId)) {
    context.assignments.push(assignment);
  }
  context.assignmentTouchedTaskIds.add(assignment.taskId);
}

async function materializeBatchAssignments(
  context: BatchMutationContext,
  task: ClassTask,
): Promise<ReturnType<typeof projectTaskCycleState>> {
  const effectiveSchedule = resolveTaskSchedule({
    currentSchedule: task.schedule!, pendingSchedule: task.pendingSchedule ?? null, now: context.now,
  });
  let state = projectTaskCycleState({
    task, now: context.now, assignments: context.assignments, completions: context.completions,
  });
  const existingAssignmentIds = new Set(context.assignments.map((event) => event.assignmentId));
  const legacyStudentIds = state.assignedStudentIds.filter((studentId) =>
    state.students[studentId]?.assignmentOrigin === 'LEGACY');
  for (const legacyStudentId of legacyStudentIds) {
    const assignmentId = deterministicId('LEGACY', task.taskInstanceId!, state.cycle.cycleId, legacyStudentId);
    if (existingAssignmentIds.has(assignmentId)) continue;
    const seed = createAssignment({
      task, cycle: state.cycle, ruleVersion: effectiveSchedule.ruleVersion,
      timeZone: effectiveSchedule.timeZone, studentId: legacyStudentId, status: 'ASSIGNED',
      source: 'LEGACY_SEED', previousAssignmentId: '', createdAt: context.now, assignmentId,
      note: 'legacy allowedStudentIds seed',
    });
    await appendBatchAssignment(context, seed);
    existingAssignmentIds.add(assignmentId);
  }
  if (legacyStudentIds.length > 0) {
    state = projectTaskCycleState({
      task, now: context.now, assignments: context.assignments, completions: context.completions,
    });
  }

  const carries = Object.entries(state.students)
    .filter(([, student]) => student.assignmentOrigin === 'CARRY' && student.assignmentEvent)
    .map(([studentId, student]) => createAssignment({
      task, cycle: state.cycle, ruleVersion: effectiveSchedule.ruleVersion,
      timeZone: effectiveSchedule.timeZone, studentId,
      status: student.assigned ? 'ASSIGNED' : 'UNASSIGNED', source: 'CARRY_FORWARD',
      previousAssignmentId: student.assignmentEvent!.assignmentId, createdAt: context.now,
      assignmentId: deterministicId('CARRY', task.taskInstanceId!, state.cycle.cycleId, studentId),
      note: 'materialized cycle carry',
    }));
  for (const carry of carries) await appendBatchAssignment(context, carry);
  if (carries.length > 0) {
    state = projectTaskCycleState({
      task, now: context.now, assignments: context.assignments, completions: context.completions,
    });
  }
  return state;
}

async function mutateBatchAssignment(
  context: BatchMutationContext,
  task: ClassTask,
  studentId: string,
  assigned: boolean,
): Promise<void> {
  const state = await materializeBatchAssignments(context, task);
  const existing = state.students[studentId];
  if ((existing?.assigned ?? false) === assigned) return;
  const schedule = resolveTaskSchedule({
    currentSchedule: task.schedule!, pendingSchedule: task.pendingSchedule ?? null, now: context.now,
  });
  await appendBatchAssignment(context, createAssignment({
    task, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
    studentId, status: assigned ? 'ASSIGNED' : 'UNASSIGNED', source: 'ADMIN',
    previousAssignmentId: existing?.assignmentEvent?.assignmentId ?? '', createdAt: context.now,
    assignmentId: `A-${crypto.randomUUID()}`, note: '',
  }));
}

async function mutateBatchCompletion(
  context: BatchMutationContext,
  task: ClassTask,
  student: Student,
  completed: boolean,
): Promise<void> {
  let state = projectTaskCycleState({
    task, now: context.now, assignments: context.assignments, completions: context.completions,
  });
  let studentState = state.students[student.studentId];
  const resetEvent = !completed && studentState?.completed && !studentState.assigned
    ? studentState.completionEvent ?? null
    : null;
  let assignmentId = resetEvent
    ? resetEvent.assignmentId || legacyCompletionReference(resetEvent.completionId)
    : '';

  if (!resetEvent) {
    if (state.assignedStudentIds.length === 0) throw new Error('부여된 학생이 없습니다.');
    if (!(studentState?.assigned ?? false)) throw new Error('허가되지 않은 과제입니다.');
    state = await materializeBatchAssignments(context, task);
    studentState = state.students[student.studentId];
    assignmentId = studentState?.assignmentEvent?.assignmentId ?? '';
    if (!studentState?.assigned || !assignmentId) throw new Error('허가되지 않은 과제입니다.');
  }

  const schedule = resolveTaskSchedule({
    currentSchedule: task.schedule!, pendingSchedule: task.pendingSchedule ?? null, now: context.now,
  });
  if (!resetEvent
    && (studentState!.completionOrigin === 'CARRY' || studentState!.completionOrigin === 'LEGACY')
    && studentState!.completionEvent) {
    const carry = createBatchCompletion({
      task, student, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
      assignmentId, timestamp: context.now, source: 'CARRY_FORWARD',
      status: studentState!.completed ? 'SUCCESS' : 'RESET', note: 'materialized cycle carry',
    });
    await appendBatchCompletion(context, carry);
    state = projectTaskCycleState({
      task, now: context.now, assignments: context.assignments, completions: context.completions,
    });
  }

  const effectiveCompleted = state.students[student.studentId]?.completed ?? false;
  if (effectiveCompleted === completed) return;
  const completion = createBatchCompletion({
    task, student, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
    assignmentId, timestamp: context.now, source: completed ? 'ADMIN' : 'ADMIN_RESET',
    status: completed ? 'SUCCESS' : 'RESET', note: completed ? 'admin-completion' : 'admin-reset',
  });
  await appendBatchCompletion(context, completion);
}

async function appendBatchCompletion(context: BatchMutationContext, completion: TaskCompletion): Promise<void> {
  reserveCanonicalAppend(context);
  try {
    await context.store.appendRow(
      'TaskCompletions', buildTaskCompletionAppendRow(context.completionHeaders, completion),
    );
  } catch (error) {
    try {
      completion = await reconcileCompletionAppend(context.store, completion.completionId, error);
    } catch {
      throw new BatchProviderAbortError();
    }
  }
  if (!context.completions.some((event) => event.completionId === completion.completionId)) {
    context.completions.push(completion);
  }
}

async function reconcileAssignmentAppend(
  store: RecurringSchemaMigrationStore,
  assignmentId: string,
  appendError: unknown,
): Promise<TaskAssignment> {
  if (!store.getRowsFresh) throw appendError;
  try {
    const rows = await store.getRowsFresh('TaskAssignments');
    const [headers, ...dataRows] = rows;
    if (!headers) throw appendError;
    const observed = parseTaskAssignmentRows(dataRows, createHeaderIndex(headers))
      .find((event) => event.assignmentId === assignmentId);
    if (observed) return observed;
  } catch (reconciliationError) {
    if (reconciliationError === appendError) throw reconciliationError;
  }
  throw appendError;
}

async function reconcileCompletionAppend(
  store: RecurringSchemaMigrationStore,
  completionId: string,
  appendError: unknown,
): Promise<TaskCompletion> {
  if (!store.getRowsFresh) throw appendError;
  try {
    const rows = await store.getRowsFresh('TaskCompletions');
    const [headers, ...dataRows] = rows;
    if (!headers) throw appendError;
    const index = createHeaderIndex(headers);
    const observed = dataRows.map((row) => parseTaskCompletionRow(row, index))
      .find((event): event is TaskCompletion => event?.completionId === completionId);
    if (observed) return observed;
  } catch (reconciliationError) {
    if (reconciliationError === appendError) throw reconciliationError;
  }
  throw appendError;
}

function createBatchCompletion(input: {
  task: ClassTask;
  student: Student;
  cycle: { cycleId: string; startsAt: string; endsAt: string | null };
  ruleVersion: number;
  timeZone: string;
  assignmentId: string;
  timestamp: string;
  source: NonNullable<TaskCompletion['source']>;
  status: string;
  note: string;
}): TaskCompletion {
  return {
    completionId: `TC-${crypto.randomUUID()}`, timestamp: input.timestamp,
    taskId: input.task.taskId, studentId: input.student.studentId, studentName: input.student.name,
    reward: 0, balanceBefore: input.student.balance, balanceAfter: input.student.balance,
    status: input.status, note: input.note, taskInstanceId: input.task.taskInstanceId!,
    cycleId: input.cycle.cycleId, cycleStartsAt: input.cycle.startsAt, cycleEndsAt: input.cycle.endsAt,
    ruleVersion: input.ruleVersion, timeZone: input.timeZone, source: input.source,
    assignmentId: input.assignmentId, schemaVersion: 2,
  };
}

async function mirrorBatchAssignments(
  context: BatchMutationContext,
  recordsById: Map<string, { task: ClassTask; rowNumber: number }>,
  requestedTaskIds: Set<string>,
): Promise<TaskBatchAssignmentWarning[]> {
  const mirrorTaskIds = Array.from(requestedTaskIds);
  if (mirrorTaskIds.length === 0) return [];
  let observedAssignments: TaskAssignment[];
  try {
    observedAssignments = await readFreshTaskAssignments(context.store);
  } catch {
    return mirrorTaskIds.map((taskId) => ({
      taskId, code: LEGACY_MIRROR_WARNING,
    }));
  }
  const warnings: TaskBatchAssignmentWarning[] = [];
  for (const taskId of mirrorTaskIds) {
    const record = recordsById.get(taskId)!;
    const state = projectTaskCycleState({
      task: record.task, now: context.now, assignments: observedAssignments, completions: context.completions,
    });
    const allowedStudentIds = state.assignedStudentIds.join(',');
    if (record.task.allowedStudentIds.join(',') === allowedStudentIds) continue;
    try {
      await context.store.updateCell(
        'Tasks', record.rowNumber, 'allowedStudentIds', allowedStudentIds,
      );
    } catch {
      warnings.push({ taskId, code: LEGACY_MIRROR_WARNING });
    }
  }
  return warnings;
}

function legacyCompletionReference(completionId: string): string {
  return `LEGACY_COMPLETION:${encodeURIComponent(completionId)}`;
}

function validateBatchInput(targets: TaskBatchAssignmentTarget[]): void {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_BATCH_TASKS) {
    throw new Error('과제 ID 목록이 올바르지 않습니다.');
  }
  const taskIds = new Set<string>();
  let operationCount = 0;
  for (const target of targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || Object.keys(target).some((key) => !['taskId', 'operations'].includes(key))
      || typeof target.taskId !== 'string' || !target.taskId || target.taskId !== target.taskId.trim()
      || taskIds.has(target.taskId)
      || !Array.isArray(target.operations) || target.operations.length === 0
      || target.operations.length > MAX_BATCH_OPERATIONS) {
      throw new Error('과제 부여 작업 목록이 올바르지 않습니다.');
    }
    taskIds.add(target.taskId);
    operationCount += target.operations.length;
    const studentIds = new Set<string>();
    for (const operation of target.operations) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)
        || Object.keys(operation).some((key) => !['studentId', 'assigned', 'completed', 'source'].includes(key))
        || typeof operation.studentId !== 'string' || !operation.studentId
        || operation.studentId !== operation.studentId.trim()
        || operation.source !== 'ADMIN'
        || (operation.assigned !== undefined && typeof operation.assigned !== 'boolean')
        || (operation.completed !== undefined && typeof operation.completed !== 'boolean')
        || (operation.assigned === undefined && operation.completed === undefined)
        || studentIds.has(operation.studentId)) {
        throw new Error('과제 부여 작업 목록이 올바르지 않습니다.');
      }
      studentIds.add(operation.studentId);
    }
  }
  if (operationCount > MAX_BATCH_TOTAL_OPERATIONS) throw new Error('과제 부여 작업 목록이 올바르지 않습니다.');
}

const LEGACY_MIRROR_WARNING = 'LEGACY_MIRROR_UPDATE_FAILED';

/**
 * Mutates exactly one student's desired assignment state. The append-only ledger is canonical;
 * Tasks.allowedStudentIds is updated only after canonical success (or an idempotent no-op).
 * Commands for the same logical task are serialized in this process; no cross-process guarantee is made.
 */
export function mutateTaskAssignment(
  store: RecurringSchemaMigrationStore,
  mutation: TaskAssignmentMutation,
): Promise<TaskAssignmentMutationResult> {
  const queueKey = taskCommandQueueKey(mutation.task.taskId, mutation.task.taskInstanceId);
  return enqueueTaskCommand(queueKey, () => mutateTaskAssignmentNow(store, mutation));
}

export async function mutateTaskAssignmentNow(
  store: RecurringSchemaMigrationStore,
  mutation: TaskAssignmentMutation,
): Promise<TaskAssignmentMutationResult> {
  const studentId = mutation.studentId.trim();
  if (!studentId) throw new Error('학생 ID를 입력해 주세요.');
  if (!mutation.task.taskInstanceId || !mutation.task.schedule) {
    throw new Error('task assignment mutation requires a task instance and schedule');
  }

  if (!mutation.schemaReady) await migrateRecurringTaskSchema(store);
  const now = mutation.now ?? new Date().toISOString();
  const effectiveSchedule = resolveTaskSchedule({
    currentSchedule: mutation.task.schedule,
    pendingSchedule: mutation.task.pendingSchedule ?? null,
    now,
  });
  const assignmentRows = store.getRowsFresh
    ? await store.getRowsFresh('TaskAssignments')
    : await store.getRows('TaskAssignments');
  const [assignmentHeaders, ...assignmentDataRows] = assignmentRows;
  if (!assignmentHeaders) throw new Error('TaskAssignments 시트에 헤더가 없습니다.');
  const assignmentHeaderIndex = createHeaderIndex(assignmentHeaders);
  const requiredAssignmentColumns = requireColumns(
    assignmentHeaderIndex,
    REQUIRED_TASK_ASSIGNMENT_COLUMNS,
  );
  if (requiredAssignmentColumns.ok === false) {
    throw new Error(`TaskAssignments 시트에 필수 컬럼이 없습니다: ${requiredAssignmentColumns.missingColumns.join(', ')}`);
  }
  const assignments = parseTaskAssignmentRows(assignmentDataRows, assignmentHeaderIndex);
  const completions = await readTaskCompletions(store);
  let state = projectTaskCycleState({ task: mutation.task, now, assignments, completions });
  const existingAssignmentIds = new Set(assignments.map((event) => event.assignmentId));
  const legacyStudentIds = state.assignedStudentIds.filter((legacyStudentId) =>
    state.students[legacyStudentId]?.assignmentOrigin === 'LEGACY');
  let canonicalTouched = false;

  // Materialize every still-implicit legacy student independently. A seed or explicit event
  // for one student must not disable fallback or resumability for another student.
  for (const legacyStudentId of legacyStudentIds) {
    const assignmentId = deterministicId(
      'LEGACY', mutation.task.taskInstanceId, state.cycle.cycleId, legacyStudentId,
    );
    if (existingAssignmentIds.has(assignmentId)) continue;
    const seed = createAssignment({
      task: mutation.task,
      cycle: state.cycle,
      ruleVersion: effectiveSchedule.ruleVersion,
      timeZone: effectiveSchedule.timeZone,
      studentId: legacyStudentId,
      status: 'ASSIGNED',
      source: 'LEGACY_SEED',
      previousAssignmentId: '',
      createdAt: now,
      assignmentId,
      note: 'legacy allowedStudentIds seed',
    });
    await appendCanonical(store, assignmentHeaders, seed);
    assignments.push(seed);
    existingAssignmentIds.add(assignmentId);
    canonicalTouched = true;
  }

  // Make an implicit carry explicit immediately before the desired-state decision.
  if (canonicalTouched) state = projectTaskCycleState({ task: mutation.task, now, assignments, completions });
  const carries = Object.entries(state.students)
    .filter(([, student]) => student.assignmentOrigin === 'CARRY' && student.assignmentEvent)
    .map(([carryStudentId, student]) => createAssignment({
      task: mutation.task,
      cycle: state.cycle,
      ruleVersion: effectiveSchedule.ruleVersion,
      timeZone: effectiveSchedule.timeZone,
      studentId: carryStudentId,
      status: student.assigned ? 'ASSIGNED' : 'UNASSIGNED',
      source: 'CARRY_FORWARD',
      previousAssignmentId: student.assignmentEvent!.assignmentId,
      createdAt: now,
      assignmentId: deterministicId('CARRY', mutation.task.taskInstanceId!, state.cycle.cycleId, carryStudentId),
      note: 'materialized cycle carry',
    }));
  for (const carry of carries) {
    await appendCanonical(store, assignmentHeaders, carry);
    assignments.push(carry);
    canonicalTouched = true;
  }
  if (carries.length > 0) state = projectTaskCycleState({ task: mutation.task, now, assignments, completions });

  const existing = state.students[studentId];
  const desiredStatus = mutation.assigned ? 'ASSIGNED' : 'UNASSIGNED';
  let assignment = existing?.assignmentEvent ?? null;
  let changed = false;
  if ((existing?.assigned ?? false) !== mutation.assigned) {
    assignment = createAssignment({
      task: mutation.task,
      cycle: state.cycle,
      ruleVersion: effectiveSchedule.ruleVersion,
      timeZone: effectiveSchedule.timeZone,
      studentId,
      status: desiredStatus,
      source: mutation.source,
      previousAssignmentId: existing?.assignmentEvent?.assignmentId ?? '',
      createdAt: now,
      assignmentId: `A-${crypto.randomUUID()}`,
      note: mutation.note ?? '',
    });
    await appendCanonical(store, assignmentHeaders, assignment);
    assignments.push(assignment);
    changed = true;
    canonicalTouched = true;
  }

  const mirrorMatchesProjection = mutation.task.allowedStudentIds.length === state.assignedStudentIds.length
    && mutation.task.allowedStudentIds.every((id) => state.assignedStudentIds.includes(id));
  if (!canonicalTouched && mirrorMatchesProjection) {
    return {
      changed,
      assignment,
      assignedStudentIds: state.assignedStudentIds,
    };
  }

  // Mirror the observed physical-row-authoritative ledger, not this command's local snapshot.
  let observedAssignments: TaskAssignment[];
  try {
    observedAssignments = await readFreshTaskAssignments(store);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fresh canonical reread unavailable';
    console.warn(`Task assignment canonical append succeeded but legacy mirror was skipped: ${message}`);
    return {
      changed,
      assignment,
      assignedStudentIds: projectTaskCycleState({
        task: mutation.task, now, assignments, completions,
      }).assignedStudentIds,
      legacyMirrorWarning: LEGACY_MIRROR_WARNING,
    };
  }
  const canonicalState = projectTaskCycleState({
    task: mutation.task, now, assignments: observedAssignments, completions,
  });
  const result: TaskAssignmentMutationResult = {
    changed,
    assignment,
    assignedStudentIds: canonicalState.assignedStudentIds,
  };
  try {
    await store.updateCell('Tasks', mutation.taskRowNumber, 'allowedStudentIds', canonicalState.assignedStudentIds.join(','));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'legacy assignment mirror failed';
    console.warn(`Task assignment canonical append succeeded but legacy mirror failed: ${message}`);
    result.legacyMirrorWarning = LEGACY_MIRROR_WARNING;
  }
  return result;
}

async function appendCanonical(
  store: RecurringSchemaMigrationStore,
  headers: string[],
  assignment: TaskAssignment,
): Promise<void> {
  try {
    await store.appendRow('TaskAssignments', buildTaskAssignmentAppendRow(headers, assignment));
  } catch (error) {
    await reconcileAssignmentAppend(store, assignment.assignmentId, error);
  }
}

async function readFreshTaskAssignments(store: RecurringSchemaMigrationStore): Promise<TaskAssignment[]> {
  if (!store.getRowsFresh) throw new Error('fresh TaskAssignments reads are unavailable');
  const rows = await store.getRowsFresh('TaskAssignments');
  const [headers, ...dataRows] = rows;
  if (!headers) return [];
  const index = createHeaderIndex(headers);
  const required = requireColumns(index, REQUIRED_TASK_ASSIGNMENT_COLUMNS);
  if (!required.ok) {
    throw new Error(`TaskAssignments 시트에 필수 컬럼이 없습니다: ${required.missingColumns.join(', ')}`);
  }
  return parseTaskAssignmentRows(dataRows, index);
}

function createAssignment({ task, cycle, ...event }: {
  task: ClassTask;
  cycle: { cycleId: string; startsAt: string; endsAt: string | null };
  ruleVersion: number;
  timeZone: string;
  assignmentId: string;
  studentId: string;
  status: TaskAssignment['status'];
  source: TaskAssignment['source'];
  previousAssignmentId: string;
  createdAt: string;
  note: string;
}): TaskAssignment {
  return {
    assignmentId: event.assignmentId,
    taskId: task.taskId,
    taskInstanceId: task.taskInstanceId!,
    cycleId: cycle.cycleId,
    cycleStartsAt: cycle.startsAt,
    cycleEndsAt: cycle.endsAt,
    ruleVersion: event.ruleVersion,
    timeZone: event.timeZone,
    studentId: event.studentId,
    status: event.status,
    source: event.source,
    previousAssignmentId: event.previousAssignmentId,
    createdAt: event.createdAt,
    schemaVersion: 2,
    note: event.note,
  };
}

function deterministicId(prefix: string, ...parts: string[]): string {
  const encoded = parts
    .map((part) => {
      const component = encodeURIComponent(part);
      return `${component.length}:${component}`;
    })
    .join('|');
  return `A-${prefix}-${encoded}`;
}
