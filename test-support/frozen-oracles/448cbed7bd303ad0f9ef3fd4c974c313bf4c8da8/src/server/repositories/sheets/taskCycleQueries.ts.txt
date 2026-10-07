import { projectTaskCycleState, type TaskCycleState } from '@/domain/taskCycleState';
import {
  projectTaskCycleHistoryFromSnapshot,
  type TaskCycleHistoryEvent,
} from '@/domain/taskCycleHistory';
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

export { projectTaskCycleHistoryFromSnapshot } from '@/domain/taskCycleHistory';
export type { TaskCycleHistoryEvent } from '@/domain/taskCycleHistory';

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
  return parseTaskCompletionRows(await reader.getRows('TaskCompletions'));
}

export async function readTaskCompletionsFresh(reader: TabularReader): Promise<TaskCompletion[]> {
  const rows = reader.getRowsFresh
    ? await reader.getRowsFresh('TaskCompletions')
    : await reader.getRows('TaskCompletions');
  return parseTaskCompletionRows(rows);
}

function parseTaskCompletionRows(rows: string[][]): TaskCompletion[] {
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
