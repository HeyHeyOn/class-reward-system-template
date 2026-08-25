import { projectTaskCycleState } from '@/domain/taskCycleState';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { ClassTask, TaskAssignment, TaskAssignmentSource } from '@/domain/types';
import {
  buildTaskAssignmentAppendRow,
  createHeaderIndex,
  parseTaskAssignmentRows,
  requireColumns,
  REQUIRED_TASK_ASSIGNMENT_COLUMNS,
} from '@/server/sheetsRows';
import type { RecurringSchemaMigrationStore } from '@/server/storage/tabularStore';
import { migrateRecurringTaskSchema } from './recurringSchemaMigrator';
import { readTaskAssignmentsIfPresent, readTaskCompletions } from './taskCycleQueries';

export type TaskAssignmentMutation = {
  task: ClassTask;
  taskRowNumber: number;
  studentId: string;
  assigned: boolean;
  source: Extract<TaskAssignmentSource, 'ADMIN' | 'QR'>;
  now?: string;
  note?: string;
};

export type TaskAssignmentMutationResult = {
  changed: boolean;
  assignment: TaskAssignment | null;
  assignedStudentIds: string[];
  legacyMirrorWarning?: string;
};

const commandQueues = new Map<string, Promise<void>>();
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
  const queueKey = JSON.stringify([mutation.task.taskId, mutation.task.taskInstanceId ?? null]);
  return enqueueCommand(queueKey, () => mutateTaskAssignmentNow(store, mutation));
}

async function mutateTaskAssignmentNow(
  store: RecurringSchemaMigrationStore,
  mutation: TaskAssignmentMutation,
): Promise<TaskAssignmentMutationResult> {
  const studentId = mutation.studentId.trim();
  if (!studentId) throw new Error('학생 ID를 입력해 주세요.');
  if (!mutation.task.taskInstanceId || !mutation.task.schedule) {
    throw new Error('task assignment mutation requires a task instance and schedule');
  }

  await migrateRecurringTaskSchema(store);
  const now = mutation.now ?? new Date().toISOString();
  const effectiveSchedule = resolveTaskSchedule({
    currentSchedule: mutation.task.schedule,
    pendingSchedule: mutation.task.pendingSchedule ?? null,
    now,
  });
  const assignmentRows = await store.getRows('TaskAssignments');
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
  const instanceAssignments = assignments.filter((event) =>
    event.taskId === mutation.task.taskId && event.taskInstanceId === mutation.task.taskInstanceId);
  const currentCycleId = projectTaskCycleState({
    task: mutation.task, now, assignments, completions,
  }).cycle.cycleId;

  // While no events exist, or only deterministic seeds from this cycle exist, retry any
  // missing active legacy seed independently. Prior-cycle/version seeds must project normally
  // so they can become carry-forward events linked to the original seed.
  if (instanceAssignments.length === 0 || instanceAssignments.every((event) =>
    event.source === 'LEGACY_SEED' && event.cycleId === currentCycleId)) {
    const assignmentsWithoutInstanceSeeds = assignments.filter((event) => !(
      event.taskId === mutation.task.taskId
      && event.taskInstanceId === mutation.task.taskInstanceId
      && event.source === 'LEGACY_SEED'
    ));
    const legacyState = projectTaskCycleState({
      task: mutation.task, now, assignments: assignmentsWithoutInstanceSeeds, completions,
    });
    const existingAssignmentIds = new Set(instanceAssignments.map((event) => event.assignmentId));
    for (const legacyStudentId of legacyState.assignedStudentIds) {
      if (legacyState.students[legacyStudentId]?.assignmentOrigin !== 'LEGACY') continue;
      const assignmentId = deterministicId(
        'LEGACY', mutation.task.taskInstanceId, legacyState.cycle.cycleId, legacyStudentId,
      );
      if (existingAssignmentIds.has(assignmentId)) continue;
      const seed = createAssignment({
        task: mutation.task,
        cycle: legacyState.cycle,
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
    }
  }

  // Make an implicit carry explicit immediately before the desired-state decision.
  let state = projectTaskCycleState({ task: mutation.task, now, assignments, completions });
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
  }

  // Mirror the observed physical-row-authoritative ledger, not this command's local snapshot.
  const observedAssignments = await readTaskAssignmentsIfPresent(store);
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

function enqueueCommand<T>(
  queueKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = commandQueues.get(queueKey) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  commandQueues.set(queueKey, tail);
  return result.finally(() => {
    if (commandQueues.get(queueKey) === tail) commandQueues.delete(queueKey);
  });
}

async function appendCanonical(
  store: RecurringSchemaMigrationStore,
  headers: string[],
  assignment: TaskAssignment,
): Promise<void> {
  await store.appendRow('TaskAssignments', buildTaskAssignmentAppendRow(headers, assignment));
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
