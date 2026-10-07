import type { TaskAssignment, TaskCompletion } from './types';

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

export type TaskCycleHistorySnapshot = Readonly<{
  assignments: readonly TaskAssignment[];
  completions: readonly TaskCompletion[];
}>;

export function projectTaskCycleHistoryFromSnapshot(
  snapshot: TaskCycleHistorySnapshot,
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
