import {
  buildTaskHistoryDetailDto,
  buildTaskHistoryListDto,

  type TaskHistoryDetailDto,
  type TaskHistoryListDto,
} from '@/domain/taskHistoryDtos';
import type { ClassTask } from '@/domain/types';
import { buildTaskCycleProjection, type TaskCycleProjectionDto,
  type TaskStudentCurrentCycleDto } from '@/server/taskReadProjection';
import { getTaskById, getTasks, type SheetsReader } from '@/server/sheetsRepository';
import {
  loadTaskCycleLedgerSnapshot,
  projectTaskCycleHistoryFromSnapshot,
  projectTaskCycleStateFromSnapshot,
  type TaskCycleLedgerSnapshot,
} from './taskCycleQueries';

export type { TaskCycleProjectionDto, TaskStudentCurrentCycleDto };

/** Reader-only projection: no migration, materialization, or ledger mutation. */
export async function getTaskCycleProjection(
  reader: SheetsReader,
  task: ClassTask,
  options: { studentId?: string; now?: string } = {},
): Promise<TaskCycleProjectionDto> {
  const snapshot = await loadTaskCycleLedgerSnapshot(reader);
  return projectTaskCycleProjectionFromSnapshot(task, options, snapshot);
}

function projectTaskCycleProjectionFromSnapshot(
  task: ClassTask,
  options: { studentId?: string; now?: string },
  snapshot: TaskCycleLedgerSnapshot,
): TaskCycleProjectionDto {
  const state = projectTaskCycleStateFromSnapshot(task, options.now ?? new Date().toISOString(), snapshot);
  return buildTaskCycleProjection(task, state, options.studentId);
}

export async function listTaskCycleProjections(
  reader: SheetsReader,
  options: { studentId?: string; includeInactive?: boolean; now?: string } = {},
): Promise<TaskCycleProjectionDto[]> {
  const [tasks, snapshot] = await Promise.all([
    getTasks(reader, { includeInactive: options.includeInactive }),
    loadTaskCycleLedgerSnapshot(reader),
  ]);
  const now = options.now ?? new Date().toISOString();
  return tasks.map((task) => projectTaskCycleProjectionFromSnapshot(task, {
    ...(options.studentId ? { studentId: options.studentId } : {}),
    now,
  }, snapshot));
}

/** Lists live definitions and taskIds which now exist only in append-only history. */
export async function listTaskHistory(
  reader: SheetsReader,
  now: string = new Date().toISOString(),
): Promise<TaskHistoryListDto[]> {
  const [tasks, snapshot] = await Promise.all([
    getTasks(reader, { includeInactive: true }),
    loadTaskCycleLedgerSnapshot(reader),
  ]);
  const events = projectTaskCycleHistoryFromSnapshot(snapshot);
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const taskIds = new Set([...tasksById.keys(), ...events.map((event) => event.taskId)]);
  return Array.from(taskIds).sort().map((taskId) => {
    const task = tasksById.get(taskId) ?? null;
    const currentCycleState = task?.taskInstanceId && task.schedule
      ? projectTaskCycleStateFromSnapshot(task, now, snapshot)
      : null;
    return buildTaskHistoryListDto({
      taskId,
      currentTaskDefinitionExists: task !== null,
      currentTaskInstanceId: task?.taskInstanceId ?? null,
      currentCycleState,
      events: events.filter((event) => event.taskId === taskId),
    });
  });
}

/** Detail keeps reused taskId lifecycles distinct and can select one exact lifecycle. */
export async function getTaskHistoryDetail(
  reader: SheetsReader,
  filter: { taskId: string; taskInstanceId?: string },
  now: string = new Date().toISOString(),
): Promise<TaskHistoryDetailDto> {
  const taskId = filter.taskId.trim();
  const [task, snapshot] = await Promise.all([
    getTaskById(reader, taskId),
    loadTaskCycleLedgerSnapshot(reader),
  ]);
  const events = projectTaskCycleHistoryFromSnapshot(snapshot, {
    taskId,
    ...(filter.taskInstanceId ? { taskInstanceId: filter.taskInstanceId } : {}),
  });
  const currentCycleState = task?.taskInstanceId && task.schedule
    ? projectTaskCycleStateFromSnapshot(task, now, snapshot)
    : null;
  return buildTaskHistoryDetailDto({
    taskId,
    requestedTaskInstanceId: filter.taskInstanceId ?? null,
    currentTaskDefinitionExists: task !== null,
    currentTaskInstanceId: task?.taskInstanceId ?? null,
    currentCycleState,
    events,
  });
}
