import { isTaskAvailable } from '@/domain/taskAvailability';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import { taskStage, type TaskStage } from '@/domain/taskStage';
import type { TaskRecurrence } from '@/domain/types';
import type { TaskCycleProjectionDto } from '@/server/repositories/sheets/taskHistoryQueries';

export type StudentTaskProjectionDto = {
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
  prerequisiteStatus?: 'UNAVAILABLE' | 'SATISFIED' | 'REQUIRED';
  prerequisiteMessage?: string;
  studentStatus: {
    studentId: string;
    assigned: boolean;
    completed?: boolean;
    /** Assigned and completable (완료 가능); assigned without it is 미완료. */
    ready: boolean;
    /** 미부여 → 미완료 → 완료 가능 → 완료. */
    stage: TaskStage;
  };
};

/** Builds the allowlisted task representation safe to return to one student. */
export function buildStudentTaskProjection(
  tasks: readonly TaskCycleProjectionDto[],
  studentId: string,
  now: string,
): StudentTaskProjectionDto[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const getStudentStatus = (task: TaskCycleProjectionDto) => {
    const directStatus = task.currentCycle?.students?.find((student) => student.studentId === studentId);
    const assigned = directStatus?.assigned
      ?? (Array.isArray(task.currentCycle?.assignedStudentIds)
        ? task.currentCycle.assignedStudentIds.includes(studentId)
        : task.allowedStudentIds.includes(studentId));
    const completed = directStatus?.completed
      ?? (Array.isArray(task.currentCycle?.completedStudentIds)
        ? task.currentCycle.completedStudentIds.includes(studentId)
        : undefined);
    // Projections from before stages existed have no ready flag: there, assigned meant completable.
    const ready = assigned && (directStatus?.ready ?? (Array.isArray(task.currentCycle?.pendingStudentIds)
      ? !task.currentCycle.pendingStudentIds.includes(studentId) : true));
    return { assigned, completed, ready, stage: taskStage({ assigned, ready, completed: completed === true }) };
  };

  const visibleTasks = tasks.filter((task) => task.isActive && isTaskAvailable(task, now));
  const assignedVisibleTaskIds = new Set(visibleTasks
    .filter((task) => getStudentStatus(task).assigned === true)
    .map((task) => task.taskId));

  return visibleTasks.map((task) => {
    const { assigned, completed, ready, stage } = getStudentStatus(task);
    const effectiveSchedule = task.schedule ? resolveTaskSchedule({
      currentSchedule: task.schedule,
      pendingSchedule: task.pendingSchedule ?? null,
      now,
    }) : undefined;
    const prerequisite = task.prerequisiteTaskId ? tasksById.get(task.prerequisiteTaskId) : undefined;
    const prerequisiteUnavailable = Boolean(task.prerequisiteTaskId
      && (!prerequisite || !prerequisite.isActive || !isTaskAvailable(prerequisite, now)));
    const prerequisiteCompleted = prerequisite ? getStudentStatus(prerequisite).completed === true : false;
    const prerequisiteTitle = prerequisite?.title ?? '선행 과제';
    const prerequisiteStatus = !task.prerequisiteTaskId
      ? undefined
      : prerequisiteUnavailable ? 'UNAVAILABLE'
        : prerequisiteCompleted ? 'SATISFIED' : 'REQUIRED';
    const prerequisiteMessage = prerequisiteStatus === 'REQUIRED'
      ? `선행 과제 '${prerequisiteTitle}'을(를) 먼저 완료해 주세요.`
      : prerequisiteStatus === 'UNAVAILABLE'
        ? `선행 과제 '${prerequisiteTitle}'을(를) 완료할 수 없습니다. 교사에게 문의해 주세요.`
        : undefined;

    return {
      taskId: task.taskId,
      title: task.title,
      description: task.description,
      reward: task.reward,
      sortOrder: task.sortOrder,
      ...(task.availableFrom ? { availableFrom: standardInstant(task.availableFrom) } : {}),
      ...(task.dueAt ? { dueAt: standardInstant(task.dueAt) } : {}),
      ...(effectiveSchedule ? { recurrence: effectiveSchedule.recurrence } : {}),
      ...(task.prerequisiteTaskId ? {
        ...(assigned && assignedVisibleTaskIds.has(task.prerequisiteTaskId)
          ? { prerequisiteTaskId: task.prerequisiteTaskId }
          : {}),
        prerequisiteTitle,
        prerequisiteStatus,
        ...(prerequisiteMessage ? { prerequisiteMessage } : {}),
      } : {}),
      studentStatus: {
        studentId,
        assigned,
        ...(completed === undefined ? {} : { completed }),
        ready,
        stage,
      },
    };
  });
}

/** Times sent to students take the standard form (as Date#toISOString), whatever precision they were stored with. */
function standardInstant(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}
