import { projectTaskCycleState, type TaskCycleState } from '@/domain/taskCycleState';
import type { ClassTask, TaskAssignment, TaskCompletion } from '@/domain/types';
import {
  createHeaderIndex,
  parseTaskAssignmentRows,
  parseTaskCompletionRow,
  requireColumns,
  REQUIRED_TASK_ASSIGNMENT_COLUMNS,
  REQUIRED_TASK_COMPLETION_COLUMNS,
} from '@/server/sheetsRows';
import type { TabularReader } from '@/server/storage/tabularStore';

type TaskCycleHistoryEventBase = {
  eventId: string;
  occurredAt: string;
  taskId: string;
  taskInstanceId?: string;
  cycleId?: string;
  cycleStartsAt?: string;
  cycleEndsAt?: string | null;
  ruleVersion?: number;
  timeZone?: string;
  studentId: string;
  note: string;
};

export type TaskCycleHistoryEvent =
  | TaskCycleHistoryEventBase & {
      eventType: 'ASSIGNMENT';
      assignmentStatus: TaskAssignment['status'];
      assignmentSource: TaskAssignment['source'];
    }
  | TaskCycleHistoryEventBase & {
      eventType: 'COMPLETION';
      completionStatus: string;
      completionSource?: TaskCompletion['source'];
      studentName: string;
      reward?: number;
      balanceBefore: number;
      balanceAfter: number;
      assignmentId?: string;
    };

export type TaskCycleLedgerSnapshot = {
  assignments: TaskAssignment[];
  completions: TaskCompletion[];
};

export async function loadTaskCycleLedgerSnapshot(
  reader: TabularReader,
): Promise<TaskCycleLedgerSnapshot> {
  const [assignments, completions] = await Promise.all([
    readTaskAssignmentsIfPresent(reader),
    readTaskCompletions(reader),
  ]);
  return { assignments, completions };
}

export function projectTaskCycleStateFromSnapshot(
  task: ClassTask,
  now: string,
  snapshot: TaskCycleLedgerSnapshot,
): TaskCycleState {
  return projectTaskCycleState({ task, now, ...snapshot });
}

export function projectTaskCycleHistoryFromSnapshot(
  snapshot: TaskCycleLedgerSnapshot,
  filter: { taskId?: string; taskInstanceId?: string } = {},
): TaskCycleHistoryEvent[] {
  const matches = (event: { taskId: string; taskInstanceId?: string }) =>
    (!filter.taskId || event.taskId === filter.taskId)
    && (!filter.taskInstanceId || event.taskInstanceId === filter.taskInstanceId);

  return [
    ...snapshot.assignments.filter(matches).map(assignmentHistoryDto),
    ...snapshot.completions.filter(matches).map(completionHistoryDto),
  ];
}

export async function readTaskCycleState(
  reader: TabularReader,
  task: ClassTask,
  now: string,
): Promise<TaskCycleState> {
  const snapshot = await loadTaskCycleLedgerSnapshot(reader);
  return projectTaskCycleStateFromSnapshot(task, now, snapshot);
}

export async function readTaskCycleHistory(
  reader: TabularReader,
  filter: { taskId?: string; taskInstanceId?: string } = {},
): Promise<TaskCycleHistoryEvent[]> {
  const snapshot = await loadTaskCycleLedgerSnapshot(reader);
  return projectTaskCycleHistoryFromSnapshot(snapshot, filter);
}

export async function readTaskAssignmentsIfPresent(reader: TabularReader): Promise<TaskAssignment[]> {
  const rows = await reader.getRows('TaskAssignments');
  if (!Array.isArray(rows)) return [];
  const [headers, ...dataRows] = rows;
  if (!headers) return [];
  const headerIndex = createHeaderIndex(headers);
  const requiredColumns = requireColumns(headerIndex, REQUIRED_TASK_ASSIGNMENT_COLUMNS);
  if (requiredColumns.ok === false) {
    throw new Error(`TaskAssignments 시트에 필수 컬럼이 없습니다: ${requiredColumns.missingColumns.join(', ')}`);
  }
  return parseTaskAssignmentRows(dataRows, headerIndex);
}

export async function readTaskCompletions(reader: TabularReader): Promise<TaskCompletion[]> {
  const rows = await reader.getRows('TaskCompletions');
  if (!Array.isArray(rows)) return [];
  const [headers, ...dataRows] = rows;
  if (!headers) return [];
  const headerIndex = createHeaderIndex(headers);
  const requiredColumns = requireColumns(headerIndex, REQUIRED_TASK_COMPLETION_COLUMNS);
  if (requiredColumns.ok === false) {
    throw new Error(`TaskCompletions 시트에 필수 컬럼이 없습니다: ${requiredColumns.missingColumns.join(', ')}`);
  }
  return dataRows
    .map((row) => parseTaskCompletionRow(row, headerIndex))
    .filter((event): event is TaskCompletion => event !== null);
}

function assignmentHistoryDto(event: TaskAssignment): TaskCycleHistoryEvent {
  return {
    eventType: 'ASSIGNMENT',
    eventId: event.assignmentId,
    occurredAt: event.createdAt,
    taskId: event.taskId,
    taskInstanceId: event.taskInstanceId,
    cycleId: event.cycleId,
    cycleStartsAt: event.cycleStartsAt,
    cycleEndsAt: event.cycleEndsAt,
    ruleVersion: event.ruleVersion,
    timeZone: event.timeZone,
    studentId: event.studentId,
    assignmentStatus: event.status,
    assignmentSource: event.source,
    note: event.note,
  };
}

function completionHistoryDto(event: TaskCompletion): TaskCycleHistoryEvent {
  return {
    eventType: 'COMPLETION',
    eventId: event.completionId,
    occurredAt: event.timestamp,
    taskId: event.taskId,
    ...(event.taskInstanceId ? { taskInstanceId: event.taskInstanceId } : {}),
    ...(event.cycleId ? { cycleId: event.cycleId } : {}),
    ...(event.cycleStartsAt ? { cycleStartsAt: event.cycleStartsAt } : {}),
    ...(event.cycleEndsAt !== undefined ? { cycleEndsAt: event.cycleEndsAt } : {}),
    ...(event.ruleVersion !== undefined ? { ruleVersion: event.ruleVersion } : {}),
    ...(event.timeZone ? { timeZone: event.timeZone } : {}),
    studentId: event.studentId,
    completionStatus: event.status,
    ...(event.source ? { completionSource: event.source } : {}),
    studentName: event.studentName,
    reward: event.reward,
    balanceBefore: event.balanceBefore,
    balanceAfter: event.balanceAfter,
    ...(event.assignmentId ? { assignmentId: event.assignmentId } : {}),
    note: event.note,
  };
}
