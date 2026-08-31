import { isTaskAvailable } from '@/domain/taskAvailability';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import { buildTaskCurrentCycleStatusDto, type TaskCurrentCycleStatusDto } from '@/domain/taskHistoryDtos';
import type { TaskCycleState } from '@/domain/taskCycleState';
import type { ClassTask, TaskRecurrence } from '@/domain/types';

export type TaskStudentCurrentCycleDto = Readonly<{
  studentId: string;
  assigned: boolean;
  completed: boolean;
  assignmentOrigin: 'EVENT' | 'CARRY' | 'LEGACY' | 'DEFAULT';
  completionOrigin: 'EVENT' | 'CARRY' | 'LEGACY' | 'DEFAULT';
}>;

export type TaskCycleProjectionDto = ClassTask & Readonly<{
  currentCycle: TaskCurrentCycleStatusDto;
  studentStatus?: TaskStudentCurrentCycleDto;
}>;

export function buildTaskCycleProjection(
  task: ClassTask,
  state: TaskCycleState,
  studentId?: string,
): TaskCycleProjectionDto {
  const student = studentId ? state.students[studentId] : undefined;
  return {
    ...task,
    currentCycle: buildTaskCurrentCycleStatusDto(state),
    ...(studentId ? { studentStatus: {
      studentId,
      assigned: student?.assigned ?? false,
      completed: student?.completed ?? false,
      assignmentOrigin: student?.assignmentOrigin ?? 'DEFAULT',
      completionOrigin: student?.completionOrigin ?? 'DEFAULT',
    } } : {}),
  };
}

export type BankTaskDto = Readonly<{
  taskId: string;
  title: string;
  description: string;
  reward: number;
  sortOrder: number;
  availableFrom?: string;
  dueAt?: string;
  recurrence?: TaskRecurrence;
  prerequisiteTaskId?: string;
  prerequisiteTitle?: string;
}>;

/** Builds the explicit public-safe task cards used by the bank. */
export function buildBankTaskProjection(
  tasks: readonly ClassTask[],
  now: string,
): BankTaskDto[] {
  const visibleTasks = tasks.filter((task) => task.isActive && isTaskAvailable(task, now));
  const visibleTaskIds = new Set(visibleTasks.map((task) => task.taskId));
  const titleById = new Map(tasks.map((task) => [task.taskId, task.title]));
  return visibleTasks.map((task) => {
    const schedule = task.schedule ? resolveTaskSchedule({
      currentSchedule: task.schedule,
      pendingSchedule: task.pendingSchedule ?? null,
      now,
    }) : undefined;
    return {
      taskId: task.taskId,
      title: task.title,
      description: task.description,
      reward: task.reward,
      sortOrder: task.sortOrder,
      ...(task.availableFrom ? { availableFrom: task.availableFrom } : {}),
      ...(task.dueAt ? { dueAt: task.dueAt } : {}),
      ...(schedule ? { recurrence: schedule.recurrence } : {}),
      ...(task.prerequisiteTaskId && visibleTaskIds.has(task.prerequisiteTaskId)
        ? { prerequisiteTaskId: task.prerequisiteTaskId }
        : {}),
      ...(task.prerequisiteTaskId && titleById.has(task.prerequisiteTaskId)
        ? { prerequisiteTitle: titleById.get(task.prerequisiteTaskId)! }
        : {}),
    };
  });
}
