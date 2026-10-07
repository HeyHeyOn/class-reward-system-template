import { Temporal } from '@js-temporal/polyfill';
import { isCompletionForTaskInstance } from './taskCompletionPolicy';
import { getTaskCycle, type TaskCycle } from './taskRecurrence';
import { resolveTaskSchedule } from './taskSchedule';
import type { ClassTask, TaskAssignment, TaskCompletion, TaskSchedule } from './types';

export type TaskCycleTransition =
  | 'PERMANENT'
  | 'INITIAL_CYCLE'
  | 'SCHEDULE_CHANGE_FIRST_CYCLE'
  | 'NATURAL_BOUNDARY';

export type TaskCycleStudentState = {
  assigned: boolean;
  completed: boolean;
  assignmentOrigin: 'EVENT' | 'CARRY' | 'LEGACY' | 'DEFAULT';
  completionOrigin: 'EVENT' | 'CARRY' | 'LEGACY' | 'DEFAULT';
  assignmentEvent?: TaskAssignment;
  completionEvent?: TaskCompletion;
};

export type TaskCycleState = {
  taskId: string;
  taskInstanceId: string;
  cycle: TaskCycle;
  transition: TaskCycleTransition;
  students: Record<string, TaskCycleStudentState>;
  assignedStudentIds: string[];
  completedStudentIds: string[];
};

export function projectTaskCycleState({
  task,
  now,
  assignments,
  completions,
}: {
  task: ClassTask;
  now: string;
  assignments: readonly TaskAssignment[];
  completions: readonly TaskCompletion[];
}): TaskCycleState {
  if (!task.taskInstanceId || !task.schedule) {
    throw new Error('task cycle projection requires a task instance and schedule');
  }
  const schedule = resolveTaskSchedule({
    currentSchedule: task.schedule,
    pendingSchedule: task.pendingSchedule ?? null,
    now,
  });

  const cycle = getTaskCycle({
    taskInstanceId: task.taskInstanceId,
    schedule,
    taskCreatedAt: task.createdAt,
    now,
  });
  const transition = classifyTransition(schedule, cycle);
  const forceCarry = transition === 'SCHEDULE_CHANGE_FIRST_CYCLE';
  const instanceAssignments = assignments.filter((event) =>
    event.taskId === task.taskId && event.taskInstanceId === task.taskInstanceId);
  const currentAssignments = latestByStudent(
    instanceAssignments.filter((event) => event.cycleId === cycle.cycleId),
  );
  const priorAssignments = latestByStudent(nearestPriorCycleByStudent(instanceAssignments.filter((event) =>
    event.cycleId !== cycle.cycleId), {
    currentStartsAt: cycle.startsAt,
    currentCycleId: cycle.cycleId,
    currentRuleVersion: schedule.ruleVersion,
    allowSameStartFromPreviousVersion: forceCarry,
  }));

  const versionedCompletions = completions.filter((event) =>
    event.taskId === task.taskId
      && event.taskInstanceId === task.taskInstanceId
      && (event.status === 'SUCCESS' || event.status === 'RESET'));
  const currentCompletions = latestByStudent(
    versionedCompletions.filter((event) => event.cycleId === cycle.cycleId),
  );
  const priorCompletions = latestByStudent(nearestPriorCycleByStudent(versionedCompletions.filter((event) =>
    event.cycleId !== cycle.cycleId), {
    currentStartsAt: cycle.startsAt,
    currentCycleId: cycle.cycleId,
    currentRuleVersion: schedule.ruleVersion,
    allowSameStartFromPreviousVersion: forceCarry,
  }));
  const legacyCompletions = legacyCompletionByStudent(completions.filter((event) =>
    !event.taskInstanceId && isCompletionForTaskInstance(event, task)));

  const allowedStudentIds = new Set(task.allowedStudentIds);
  const assignmentStudentsWithEvents = new Set(instanceAssignments.map((event) => event.studentId));
  const studentIds = new Set<string>(task.allowedStudentIds);
  for (const collection of [currentAssignments, priorAssignments, currentCompletions, priorCompletions, legacyCompletions]) {
    collection.forEach((_event, studentId) => studentIds.add(studentId));
  }

  const students: Record<string, TaskCycleStudentState> = {};
  for (const studentId of Array.from(studentIds)) {
    const currentAssignment = currentAssignments.get(studentId);
    const priorAssignment = priorAssignments.get(studentId);
    const currentCompletion = currentCompletions.get(studentId);
    const priorCompletion = priorCompletions.get(studentId) ?? legacyCompletions.get(studentId);

    const assignment = projectAssignment({
      current: currentAssignment,
      prior: priorAssignment,
      legacyAssigned: !assignmentStudentsWithEvents.has(studentId)
        && allowedStudentIds.has(studentId)
        && (transition !== 'NATURAL_BOUNDARY' || !schedule.resetAssignmentOnCycle),
      carry: forceCarry || transition === 'PERMANENT' || !schedule.resetAssignmentOnCycle,
    });
    const completion = projectCompletion({
      current: currentCompletion,
      prior: priorCompletion,
      priorIsLegacy: !priorCompletions.has(studentId) && legacyCompletions.has(studentId),
      carry: forceCarry || transition === 'PERMANENT' || !schedule.resetCompletionOnCycle,
    });
    students[studentId] = { ...assignment, ...completion };
  }

  return {
    taskId: task.taskId,
    taskInstanceId: task.taskInstanceId,
    cycle,
    transition,
    students,
    assignedStudentIds: Array.from(studentIds).filter((id) => students[id].assigned),
    completedStudentIds: Array.from(studentIds).filter((id) => students[id].completed),
  };
}

function classifyTransition(schedule: TaskSchedule, cycle: TaskCycle): TaskCycleTransition {
  if (schedule.ruleVersion > 1 && sameInstant(cycle.startsAt, schedule.effectiveFrom)) {
    return 'SCHEDULE_CHANGE_FIRST_CYCLE';
  }
  if (schedule.recurrence.type === 'NONE') return 'PERMANENT';
  if (sameInstant(cycle.startsAt, schedule.effectiveFrom)) {
    return 'INITIAL_CYCLE';
  }
  return 'NATURAL_BOUNDARY';
}

function projectAssignment({ current, prior, legacyAssigned, carry }: {
  current?: TaskAssignment;
  prior?: TaskAssignment;
  legacyAssigned: boolean;
  carry: boolean;
}): Pick<TaskCycleStudentState, 'assigned' | 'assignmentOrigin' | 'assignmentEvent'> {
  if (current) return {
    assigned: current.status === 'ASSIGNED', assignmentOrigin: 'EVENT', assignmentEvent: current,
  };
  if (carry && prior) return {
    assigned: prior.status === 'ASSIGNED', assignmentOrigin: 'CARRY', assignmentEvent: prior,
  };
  if (legacyAssigned) return { assigned: true, assignmentOrigin: 'LEGACY' };
  return { assigned: false, assignmentOrigin: 'DEFAULT' };
}

function projectCompletion({ current, prior, priorIsLegacy, carry }: {
  current?: TaskCompletion;
  prior?: TaskCompletion;
  priorIsLegacy: boolean;
  carry: boolean;
}): Pick<TaskCycleStudentState, 'completed' | 'completionOrigin' | 'completionEvent'> {
  if (current) return {
    completed: isCompletedEvent(current), completionOrigin: 'EVENT', completionEvent: current,
  };
  if (prior && carry) return {
    completed: isCompletedEvent(prior),
    completionOrigin: priorIsLegacy ? 'LEGACY' : 'CARRY',
    completionEvent: prior,
  };
  return { completed: false, completionOrigin: 'DEFAULT' };
}

function isCompletedEvent(event: TaskCompletion): boolean {
  return event.source !== 'ADMIN_RESET' && event.status === 'SUCCESS';
}

/** Iteration order is intentional: Map#set makes the last physical row authoritative. */
function latestByStudent<T extends { studentId: string }>(events: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const event of events) latest.set(event.studentId, event);
  return latest;
}

/** Legacy rows are historical outcomes, not append-only status events: any SUCCESS means completed. */
function legacyCompletionByStudent(events: readonly TaskCompletion[]): Map<string, TaskCompletion> {
  const projected = new Map<string, TaskCompletion>();
  for (const event of events) {
    const current = projected.get(event.studentId);
    if (!current || event.status === 'SUCCESS' || current.status !== 'SUCCESS') {
      projected.set(event.studentId, event);
    }
  }
  return projected;
}

function nearestPriorCycleByStudent<T extends {
  studentId: string;
  cycleId?: string;
  cycleStartsAt?: string;
  ruleVersion?: number;
}>(
  events: readonly T[],
  {
    currentStartsAt,
    currentCycleId,
    currentRuleVersion,
    allowSameStartFromPreviousVersion,
  }: {
    currentStartsAt: string;
    currentCycleId: string;
    currentRuleVersion: number;
    allowSameStartFromPreviousVersion: boolean;
  },
): T[] {
  try {
    const currentStart = Temporal.Instant.from(currentStartsAt);
    const nearestByStudent = new Map<string, { start: Temporal.Instant; events: T[] }>();
    for (const event of events) {
      if (!event.cycleStartsAt) continue;
      let eventStart: Temporal.Instant;
      try {
        eventStart = Temporal.Instant.from(event.cycleStartsAt);
      } catch {
        continue;
      }
      const currentComparison = Temporal.Instant.compare(eventStart, currentStart);
      if (currentComparison > 0) continue;
      if (currentComparison === 0 && !(
        allowSameStartFromPreviousVersion
        && event.cycleId !== currentCycleId
        && event.ruleVersion !== undefined
        && event.ruleVersion < currentRuleVersion
      )) continue;
      const nearest = nearestByStudent.get(event.studentId);
      const nearestComparison = nearest
        ? Temporal.Instant.compare(eventStart, nearest.start)
        : 1;
      if (nearestComparison > 0) {
        nearestByStudent.set(event.studentId, { start: eventStart, events: [event] });
      } else if (nearestComparison === 0) {
        nearest?.events.push(event);
      }
    }
    return Array.from(nearestByStudent.values()).flatMap(({ events: nearest }) => nearest);
  } catch {
    return [];
  }
}

function sameInstant(left: string, right: string): boolean {
  try {
    return Temporal.Instant.compare(Temporal.Instant.from(left), Temporal.Instant.from(right)) === 0;
  } catch {
    return false;
  }
}
