import type { TaskCycleState } from './taskCycleState';
import type { TaskCycleHistoryEvent } from '@/server/repositories/sheets/taskCycleQueries';

export type TaskCurrentCycleStatusDto = {
  cycleId: string;
  startsAt: string;
  endsAt: string | null;
  transition: TaskCycleState['transition'];
  assignedStudentIds: string[];
  completedStudentIds: string[];
  students: Array<{
    studentId: string;
    assigned: boolean;
    completed: boolean;
    assignmentOrigin: TaskCycleState['students'][string]['assignmentOrigin'];
    completionOrigin: TaskCycleState['students'][string]['completionOrigin'];
  }>;
};

export type TaskHistoryLifecycleSummaryDto = {
  taskInstanceId: string | null;
  isCurrentLifecycle: boolean;
  eventCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
};

export type TaskHistoryListDto = {
  taskId: string;
  currentLifecycle: {
    taskDefinitionExists: boolean;
    taskInstanceId: string | null;
    currentCycleStatus: TaskCurrentCycleStatusDto | null;
  };
  cumulativeHistory: {
    eventCount: number;
    lifecycles: TaskHistoryLifecycleSummaryDto[];
  };
};

export type TaskHistoryDetailDto = Omit<TaskHistoryListDto, 'cumulativeHistory'> & {
  requestedTaskInstanceId: string | null;
  cumulativeHistory: {
    eventCount: number;
    lifecycles: Array<TaskHistoryLifecycleSummaryDto & { events: TaskCycleHistoryEvent[] }>;
  };
};

type TaskHistoryDtoInput = {
  taskId: string;
  currentTaskDefinitionExists: boolean;
  currentTaskInstanceId: string | null;
  currentCycleState: TaskCycleState | null;
  events: readonly TaskCycleHistoryEvent[];
};

export function buildTaskHistoryListDto(input: TaskHistoryDtoInput): TaskHistoryListDto {
  const lifecycles = groupHistory(input.events, input.currentTaskInstanceId);
  return {
    taskId: input.taskId,
    currentLifecycle: currentLifecycleDto(input),
    cumulativeHistory: {
      eventCount: input.events.length,
      lifecycles: lifecycles.map((lifecycle) => ({
        taskInstanceId: lifecycle.taskInstanceId,
        isCurrentLifecycle: lifecycle.isCurrentLifecycle,
        eventCount: lifecycle.eventCount,
        firstOccurredAt: lifecycle.firstOccurredAt,
        lastOccurredAt: lifecycle.lastOccurredAt,
      })),
    },
  };
}

export function buildTaskHistoryDetailDto(
  input: TaskHistoryDtoInput & { requestedTaskInstanceId?: string | null },
): TaskHistoryDetailDto {
  const lifecycles = groupHistory(input.events, input.currentTaskInstanceId);
  return {
    taskId: input.taskId,
    requestedTaskInstanceId: input.requestedTaskInstanceId ?? null,
    currentLifecycle: currentLifecycleDto(input),
    cumulativeHistory: {
      eventCount: input.events.length,
      lifecycles,
    },
  };
}

function currentLifecycleDto(input: TaskHistoryDtoInput): TaskHistoryListDto['currentLifecycle'] {
  return {
    taskDefinitionExists: input.currentTaskDefinitionExists,
    taskInstanceId: input.currentTaskInstanceId,
    currentCycleStatus: input.currentCycleState ? buildTaskCurrentCycleStatusDto(input.currentCycleState) : null,
  };
}

export function buildTaskCurrentCycleStatusDto(state: TaskCycleState): TaskCurrentCycleStatusDto {
  return {
    cycleId: state.cycle.cycleId,
    startsAt: state.cycle.startsAt,
    endsAt: state.cycle.endsAt,
    transition: state.transition,
    assignedStudentIds: [...state.assignedStudentIds],
    completedStudentIds: [...state.completedStudentIds],
    students: Object.entries(state.students).map(([studentId, student]) => ({
      studentId,
      assigned: student.assigned,
      completed: student.completed,
      assignmentOrigin: student.assignmentOrigin,
      completionOrigin: student.completionOrigin,
    })),
  };
}

function groupHistory(events: readonly TaskCycleHistoryEvent[], currentTaskInstanceId: string | null) {
  const grouped = new Map<string | null, TaskCycleHistoryEvent[]>();
  events.forEach((event) => {
    const lifecycleId = event.taskInstanceId ?? null;
    const lifecycle = grouped.get(lifecycleId) ?? [];
    lifecycle.push(cloneEvent(event));
    grouped.set(lifecycleId, lifecycle);
  });

  return Array.from(grouped, ([taskInstanceId, lifecycleEvents]) => {
    lifecycleEvents.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    return {
      taskInstanceId,
      isCurrentLifecycle: taskInstanceId !== null && taskInstanceId === currentTaskInstanceId,
      eventCount: lifecycleEvents.length,
      firstOccurredAt: lifecycleEvents[0].occurredAt,
      lastOccurredAt: lifecycleEvents[lifecycleEvents.length - 1].occurredAt,
      events: lifecycleEvents,
    };
  }).sort((left, right) => left.firstOccurredAt.localeCompare(right.firstOccurredAt));
}

function cloneEvent(event: TaskCycleHistoryEvent): TaskCycleHistoryEvent {
  return { ...event };
}
