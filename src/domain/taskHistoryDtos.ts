import type { TaskCycleState } from './taskCycleState';
import type { TaskCycleHistoryEvent } from './taskCycleHistory';
import type { TaskAssignmentSource } from './types';
import type { TaskStage } from './taskStage';

export type TaskCurrentCycleStatusDto = {
  cycleId: string;
  startsAt: string;
  endsAt: string | null;
  transition: TaskCycleState['transition'];
  assignedStudentIds: string[];
  /** Absent on rows produced before stages existed: then every assigned student is 완료 가능. */
  pendingStudentIds?: string[];
  readyStudentIds?: string[];
  completedStudentIds: string[];
  students: Array<{
    studentId: string;
    assigned: boolean;
    ready?: boolean;
    completed: boolean;
    stage?: TaskStage;
    assignmentOrigin: TaskCycleState['students'][string]['assignmentOrigin'];
    assignmentSource?: TaskAssignmentSource;
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

/** A student named in a task history, so the admin view can show names instead of IDs. */
export type TaskHistoryStudentDto = {
  studentId: string;
  /** The current name, or the name stored with a completion when the student row is gone. */
  name: string;
  /** The student was removed from the class. */
  deleted: boolean;
};

export type TaskHistoryDetailDto = Omit<TaskHistoryListDto, 'cumulativeHistory'> & {
  requestedTaskInstanceId: string | null;
  cumulativeHistory: {
    eventCount: number;
    lifecycles: Array<TaskHistoryLifecycleSummaryDto & { events: TaskCycleHistoryEvent[] }>;
  };
  /**
   * Names of the students in `cumulativeHistory`, sorted by student ID. Optional: older responses
   * and the legacy Sheets mode omit it, and then events keep only their own name snapshots.
   */
  students?: TaskHistoryStudentDto[];
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
  input: TaskHistoryDtoInput & {
    requestedTaskInstanceId?: string | null;
    students?: readonly TaskHistoryStudentDto[];
  },
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
    ...(input.students ? { students: input.students.map((student) => ({ ...student })) } : {}),
  };
}

/**
 * Names every student of `events`: the current students row first, then the latest completion
 * name snapshot. A student found nowhere is left out, so the view can say "삭제된 학생".
 */
export function buildTaskHistoryStudents(
  events: readonly TaskCycleHistoryEvent[],
  currentStudents: ReadonlyArray<Readonly<{ studentId: string; name: string; deleted: boolean }>>,
): TaskHistoryStudentDto[] {
  const current = new Map(currentStudents.map((student) => [student.studentId, student]));
  const snapshots = new Map<string, string>();
  [...events]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .forEach((event) => {
      if (event.eventType === 'COMPLETION' && event.studentName.trim()) {
        snapshots.set(event.studentId, event.studentName.trim());
      }
    });
  const studentIds = Array.from(new Set(events.map((event) => event.studentId)))
    .sort((left, right) => left.localeCompare(right, 'ko-KR', { numeric: true }));
  return studentIds.flatMap((studentId): TaskHistoryStudentDto[] => {
    const student = current.get(studentId);
    if (student && student.name.trim()) {
      return [{ studentId, name: student.name.trim(), deleted: student.deleted }];
    }
    const snapshot = snapshots.get(studentId);
    return snapshot ? [{ studentId, name: snapshot, deleted: true }] : [];
  });
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
    pendingStudentIds: [...state.pendingStudentIds],
    readyStudentIds: [...state.readyStudentIds],
    completedStudentIds: [...state.completedStudentIds],
    students: Object.entries(state.students).map(([studentId, student]) => ({
      studentId,
      assigned: student.assigned,
      ready: student.ready,
      completed: student.completed,
      stage: student.stage,
      assignmentOrigin: student.assignmentOrigin,
      ...(student.assignmentEvent?.source ? { assignmentSource: student.assignmentEvent.source } : {}),
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
