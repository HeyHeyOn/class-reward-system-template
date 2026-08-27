import { describe, expect, it } from 'vitest';
import type { ClassTask, TaskAssignment, TaskCompletion } from './types';
import { projectTaskCycleState } from './taskCycleState';

const schedule = {
  ruleVersion: 1,
  effectiveFrom: '2026-08-20T00:00:00.000Z',
  timeZone: 'UTC',
  recurrence: { type: 'DAILY' as const, time: '00:00' },
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
};
const task: ClassTask = {
  taskId: 'T1', taskInstanceId: 'I1', title: 'Read', description: '', reward: 5,
  isActive: true, sortOrder: 1, allowedStudentIds: ['legacy'], createdAt: '2026-08-20T00:00:00.000Z', schedule,
};
function assignment(overrides: Partial<TaskAssignment>): TaskAssignment {
  return {
    assignmentId: 'A', taskId: 'T1', taskInstanceId: 'I1',
    cycleId: 'v1|I1|r1|2026-08-24T00:00:00Z', cycleStartsAt: '2026-08-24T00:00:00Z',
    cycleEndsAt: '2026-08-25T00:00:00Z', ruleVersion: 1, timeZone: 'UTC', studentId: 'S1',
    status: 'ASSIGNED', source: 'ADMIN', previousAssignmentId: '', createdAt: '2026-08-24T01:00:00Z',
    schemaVersion: 2, note: '', ...overrides,
  };
}
function completion(overrides: Partial<TaskCompletion>): TaskCompletion {
  return {
    completionId: 'C', timestamp: '2026-08-24T02:00:00Z', taskId: 'T1', taskInstanceId: 'I1',
    cycleId: 'v1|I1|r1|2026-08-24T00:00:00Z', cycleStartsAt: '2026-08-24T00:00:00Z',
    cycleEndsAt: '2026-08-25T00:00:00Z', ruleVersion: 1, timeZone: 'UTC', source: 'BANK',
    studentId: 'S1', studentName: 'One', reward: 5, balanceBefore: 0, balanceAfter: 5,
    status: 'SUCCESS', note: '', schemaVersion: 2, ...overrides,
  };
}

describe('projectTaskCycleState', () => {
  it('uses physical row order for latest current-cycle events and ADMIN_RESET clears completion', () => {
    const state = projectTaskCycleState({
      task, now: '2026-08-24T12:00:00Z',
      assignments: [
        assignment({ assignmentId: 'later-time-first', createdAt: '2026-08-24T23:00:00Z', status: 'ASSIGNED' }),
        assignment({ assignmentId: 'earlier-time-last-row', createdAt: '2026-08-24T03:00:00Z', status: 'UNASSIGNED' }),
      ],
      completions: [
        completion({ completionId: 'later-time-first', timestamp: '2026-08-24T23:00:00Z' }),
        completion({ completionId: 'reset-last-row', timestamp: '2026-08-24T03:00:00Z', source: 'ADMIN_RESET' }),
      ],
    });
    expect(state.students.S1).toMatchObject({ assigned: false, completed: false });
  });

  it.each([
    ['2026-08-24T23:59:59.999Z', '2026-08-24T00:00:00Z'],
    ['2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00Z'],
    ['2026-08-25T00:00:00.001Z', '2026-08-25T00:00:00Z'],
  ])('uses inclusive/exclusive boundaries at %s', (now, startsAt) => {
    expect(projectTaskCycleState({ task, now, assignments: [], completions: [] }).cycle.startsAt).toBe(startsAt);
  });

  it('resets at a natural boundary when flags are true and otherwise purely carries prior observed state', () => {
    const priorAssignments = [assignment({ cycleId: 'old', cycleStartsAt: '2026-08-24T00:00:00Z' })];
    const priorCompletions = [completion({ cycleId: 'old', cycleStartsAt: '2026-08-24T00:00:00Z' })];
    const reset = projectTaskCycleState({
      task: { ...task, schedule: { ...schedule, resetAssignmentOnCycle: true, resetCompletionOnCycle: true } },
      now: '2026-08-25T00:00:00Z', assignments: priorAssignments, completions: priorCompletions,
    });
    const carry = projectTaskCycleState({
      task, now: '2026-08-25T00:00:00Z', assignments: priorAssignments, completions: priorCompletions,
    });
    expect(reset.students.S1).toMatchObject({ assigned: false, completed: false });
    expect(carry.students.S1).toMatchObject({ assigned: true, completed: true });
  });

  it('carries each student assignment from that student’s nearest prior cycle', () => {
    const state = projectTaskCycleState({
      task,
      now: '2026-08-26T12:00:00Z',
      assignments: [
        assignment({
          assignmentId: 's1-cycle1-assigned',
          studentId: 'S1',
          cycleId: 'cycle1',
          cycleStartsAt: '2026-08-24T00:00:00Z',
          status: 'ASSIGNED',
        }),
        assignment({
          assignmentId: 's2-cycle2-assigned',
          studentId: 'S2',
          cycleId: 'cycle2',
          cycleStartsAt: '2026-08-25T00:00:00Z',
          status: 'ASSIGNED',
        }),
      ],
      completions: [],
    });

    expect(state.students.S1).toMatchObject({
      assigned: true,
      assignmentOrigin: 'CARRY',
      assignmentEvent: { assignmentId: 's1-cycle1-assigned' },
    });
    expect(state.students.S2).toMatchObject({
      assigned: true,
      assignmentOrigin: 'CARRY',
      assignmentEvent: { assignmentId: 's2-cycle2-assigned' },
    });
  });

  it('carries each student completion from that student’s nearest prior cycle', () => {
    const state = projectTaskCycleState({
      task,
      now: '2026-08-26T12:00:00Z',
      assignments: [],
      completions: [
        completion({
          completionId: 's1-cycle1-success',
          studentId: 'S1',
          cycleId: 'cycle1',
          cycleStartsAt: '2026-08-24T00:00:00Z',
          source: 'BANK',
        }),
        completion({
          completionId: 's2-cycle2-success',
          studentId: 'S2',
          cycleId: 'cycle2',
          cycleStartsAt: '2026-08-25T00:00:00Z',
          source: 'BANK',
        }),
        completion({
          completionId: 's2-cycle2-reset',
          studentId: 'S2',
          cycleId: 'cycle2',
          cycleStartsAt: '2026-08-25T00:00:00Z',
          source: 'ADMIN_RESET',
        }),
      ],
    });

    expect(state.students.S1).toMatchObject({
      completed: true,
      completionOrigin: 'CARRY',
      completionEvent: { completionId: 's1-cycle1-success' },
    });
    expect(state.students.S2).toMatchObject({
      completed: false,
      completionOrigin: 'CARRY',
      completionEvent: { completionId: 's2-cycle2-reset' },
    });
  });

  it('carries only the temporally nearest previous cycle before applying physical row order within it', () => {
    const cycle1 = '2026-08-24T00:00:00Z';
    const cycle2 = '2026-08-25T00:00:00Z';
    const state = projectTaskCycleState({
      task,
      now: '2026-08-26T12:00:00Z',
      assignments: [
        assignment({ assignmentId: 'cycle1-assigned', cycleId: 'cycle1', cycleStartsAt: cycle1, status: 'ASSIGNED' }),
        assignment({ assignmentId: 'cycle2-unassigned', cycleId: 'cycle2', cycleStartsAt: cycle2, status: 'UNASSIGNED' }),
        assignment({ assignmentId: 'late-row-cycle1-assigned', cycleId: 'cycle1', cycleStartsAt: cycle1, status: 'ASSIGNED' }),
        assignment({ assignmentId: 'future-cycle4', cycleId: 'cycle4', cycleStartsAt: '2026-08-27T00:00:00Z', status: 'ASSIGNED' }),
        assignment({ assignmentId: 'other-instance', taskInstanceId: 'I2', cycleId: 'cycle2', cycleStartsAt: cycle2, status: 'ASSIGNED' }),
      ],
      completions: [
        completion({ completionId: 'cycle1-success', cycleId: 'cycle1', cycleStartsAt: cycle1, source: 'BANK' }),
        completion({ completionId: 'cycle2-reset', cycleId: 'cycle2', cycleStartsAt: cycle2, source: 'ADMIN_RESET' }),
        completion({ completionId: 'late-row-cycle1-success', cycleId: 'cycle1', cycleStartsAt: cycle1, source: 'BANK' }),
        completion({ completionId: 'future-cycle4', cycleId: 'cycle4', cycleStartsAt: '2026-08-27T00:00:00Z', source: 'BANK' }),
        completion({ completionId: 'other-instance', taskInstanceId: 'I2', cycleId: 'cycle2', cycleStartsAt: cycle2, source: 'BANK' }),
      ],
    });

    expect(state.students.S1).toMatchObject({
      assigned: false,
      completed: false,
      assignmentOrigin: 'CARRY',
      completionOrigin: 'CARRY',
      assignmentEvent: { assignmentId: 'cycle2-unassigned' },
      completionEvent: { completionId: 'cycle2-reset' },
    });
  });

  it.each([
    [false, false, true, true],
    [false, true, true, false],
    [true, false, false, true],
    [true, true, false, false],
  ])('forces carry in the immediate schedule-change cycle, then applies reset flags at the natural boundary (%s, %s)', (
    resetAssignmentOnCycle,
    resetCompletionOnCycle,
    expectedAssigned,
    expectedCompleted,
  ) => {
    const changedTask = {
      ...task,
      schedule: {
        ...schedule,
        ruleVersion: 2,
        effectiveFrom: '2026-08-25T09:30:00.000Z',
        resetAssignmentOnCycle,
        resetCompletionOnCycle,
      },
    };
    const priorAssignments = [assignment({ cycleId: 'old', cycleStartsAt: '2026-08-25T00:00:00Z' })];
    const priorCompletions = [completion({ cycleId: 'old', cycleStartsAt: '2026-08-25T00:00:00Z' })];
    const first = projectTaskCycleState({ task: changedTask, now: '2026-08-25T09:30:00Z', assignments: priorAssignments, completions: priorCompletions });
    const natural = projectTaskCycleState({ task: changedTask, now: '2026-08-26T00:00:00Z', assignments: priorAssignments, completions: priorCompletions });
    expect(first.transition).toBe('SCHEDULE_CHANGE_FIRST_CYCLE');
    expect(first.students.S1).toMatchObject({ assigned: true, completed: true });
    expect(natural.transition).toBe('NATURAL_BOUNDARY');
    expect(natural.students.S1).toMatchObject({ assigned: expectedAssigned, completed: expectedCompleted });
  });

  it('carries the previous schedule version at an identical boundary while exact current-cycle events override it', () => {
    const boundary = '2026-08-25T00:00:00Z';
    const changedTask: ClassTask = {
      ...task,
      schedule: {
        ...schedule,
        ruleVersion: 2,
        effectiveFrom: boundary,
        resetAssignmentOnCycle: true,
        resetCompletionOnCycle: true,
      },
    };
    const currentCycleId = 'v1|I1|r2|2026-08-25T00:00:00Z';
    const state = projectTaskCycleState({
      task: changedTask,
      now: boundary,
      assignments: [
        assignment({ assignmentId: 'previous-version', cycleId: 'old-natural-boundary', cycleStartsAt: boundary, ruleVersion: 1, studentId: 'carried' }),
        assignment({ assignmentId: 'malformed-equal-version', cycleId: 'not-current', cycleStartsAt: boundary, ruleVersion: 2, studentId: 'excluded' }),
        assignment({ assignmentId: 'malformed-higher-version', cycleId: 'future-version', cycleStartsAt: boundary, ruleVersion: 3, studentId: 'excluded' }),
        assignment({ assignmentId: 'previous-version-for-override', cycleId: 'old-natural-boundary', cycleStartsAt: boundary, ruleVersion: 1, studentId: 'overridden', status: 'ASSIGNED' }),
        assignment({ assignmentId: 'current-override', cycleId: currentCycleId, cycleStartsAt: boundary, ruleVersion: 2, studentId: 'overridden', status: 'UNASSIGNED' }),
      ],
      completions: [
        completion({ completionId: 'previous-version', cycleId: 'old-natural-boundary', cycleStartsAt: boundary, ruleVersion: 1, studentId: 'carried' }),
        completion({ completionId: 'malformed-equal-version', cycleId: 'not-current', cycleStartsAt: boundary, ruleVersion: 2, studentId: 'excluded' }),
        completion({ completionId: 'malformed-higher-version', cycleId: 'future-version', cycleStartsAt: boundary, ruleVersion: 3, studentId: 'excluded' }),
        completion({ completionId: 'previous-version-for-override', cycleId: 'old-natural-boundary', cycleStartsAt: boundary, ruleVersion: 1, studentId: 'overridden', source: 'BANK' }),
        completion({ completionId: 'current-override', cycleId: currentCycleId, cycleStartsAt: boundary, ruleVersion: 2, studentId: 'overridden', source: 'ADMIN_RESET' }),
      ],
    });

    expect(state.transition).toBe('SCHEDULE_CHANGE_FIRST_CYCLE');
    expect(state.students.carried).toMatchObject({
      assigned: true,
      completed: true,
      assignmentOrigin: 'CARRY',
      completionOrigin: 'CARRY',
      assignmentEvent: { assignmentId: 'previous-version' },
      completionEvent: { completionId: 'previous-version' },
    });
    expect(state.students.overridden).toMatchObject({
      assigned: false,
      completed: false,
      assignmentOrigin: 'EVENT',
      completionOrigin: 'EVENT',
      assignmentEvent: { assignmentId: 'current-override' },
      completionEvent: { completionId: 'current-override' },
    });
    expect(state.students.excluded).toBeUndefined();
  });

  it('still requires a strictly earlier cycle start outside a schedule-change first cycle', () => {
    const boundary = '2026-08-25T00:00:00Z';
    const state = projectTaskCycleState({
      task,
      now: boundary,
      assignments: [assignment({ cycleId: 'not-current', cycleStartsAt: boundary, ruleVersion: 0 })],
      completions: [completion({ cycleId: 'not-current', cycleStartsAt: boundary, ruleVersion: 0 })],
    });

    expect(state.transition).toBe('NATURAL_BOUNDARY');
    expect(state.students.S1).toBeUndefined();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('carries recurring state into a changed permanent schedule regardless of reset flags (%s, %s)', (
    resetAssignmentOnCycle,
    resetCompletionOnCycle,
  ) => {
    const changedAt = '2026-08-25T09:30:00.000Z';
    const changedTask: ClassTask = {
      ...task,
      schedule: {
        ...schedule,
        ruleVersion: 2,
        effectiveFrom: changedAt,
        recurrence: { type: 'NONE' },
        resetAssignmentOnCycle,
        resetCompletionOnCycle,
      },
    };
    const state = projectTaskCycleState({
      task: changedTask,
      now: changedAt,
      assignments: [assignment({ assignmentId: 'recurring-prior', cycleId: 'old', cycleStartsAt: '2026-08-25T00:00:00Z' })],
      completions: [completion({ completionId: 'recurring-prior', cycleId: 'old', cycleStartsAt: '2026-08-25T00:00:00Z' })],
    });

    expect(state.transition).toBe('SCHEDULE_CHANGE_FIRST_CYCLE');
    expect(state.cycle.endsAt).toBeNull();
    expect(state.students.S1).toMatchObject({
      assigned: true,
      completed: true,
      assignmentOrigin: 'CARRY',
      completionOrigin: 'CARRY',
    });
  });

  it('switches a pending schedule and timezone exactly at editedAt while carrying prior success into the immediate cycle', () => {
    const editedAt = '2026-08-25T09:30:00.000Z';
    const oldCycleId = 'v1|I1|r1|2026-08-25T00:00:00Z';
    const pendingTask: ClassTask = {
      ...task,
      pendingSchedule: {
        ...schedule,
        ruleVersion: 2,
        effectiveFrom: editedAt,
        timeZone: 'Asia/Seoul',
        resetAssignmentOnCycle: true,
        resetCompletionOnCycle: true,
      },
    };
    const priorAssignments = [assignment({
      assignmentId: 'old-cycle-assigned',
      cycleId: oldCycleId,
      cycleStartsAt: '2026-08-25T00:00:00Z',
      cycleEndsAt: '2026-08-26T00:00:00Z',
      ruleVersion: 1,
      timeZone: 'UTC',
      status: 'ASSIGNED',
      createdAt: '2026-08-25T08:00:00Z',
    })];
    const priorCompletions = [completion({
      completionId: 'old-cycle-success',
      cycleId: oldCycleId,
      cycleStartsAt: '2026-08-25T00:00:00Z',
      cycleEndsAt: '2026-08-26T00:00:00Z',
      ruleVersion: 1,
      timeZone: 'UTC',
      status: 'SUCCESS',
      timestamp: '2026-08-25T08:30:00Z',
    })];

    const before = projectTaskCycleState({
      task: pendingTask,
      now: '2026-08-25T09:29:59.999Z',
      assignments: priorAssignments,
      completions: priorCompletions,
    });
    const exact = projectTaskCycleState({
      task: pendingTask,
      now: editedAt,
      assignments: priorAssignments,
      completions: priorCompletions,
    });
    const after = projectTaskCycleState({
      task: pendingTask,
      now: '2026-08-25T09:30:00.001Z',
      assignments: priorAssignments,
      completions: priorCompletions,
    });

    expect(before.cycle).toMatchObject({
      cycleId: oldCycleId,
      startsAt: '2026-08-25T00:00:00Z',
      endsAt: '2026-08-26T00:00:00Z',
    });
    expect(before.students.S1).toMatchObject({
      assigned: true,
      completed: true,
      assignmentOrigin: 'EVENT',
      completionOrigin: 'EVENT',
    });

    expect(exact.cycle).toMatchObject({
      cycleId: 'v1|I1|r2|2026-08-25T09:30:00Z',
      startsAt: '2026-08-25T09:30:00Z',
      endsAt: '2026-08-25T15:00:00Z',
    });
    expect(exact.transition).toBe('SCHEDULE_CHANGE_FIRST_CYCLE');
    expect(after.cycle.cycleId).toBe(exact.cycle.cycleId);
    expect(after.cycle.startsAt).toBe(exact.cycle.startsAt);
    for (const state of [exact, after]) {
      expect(state.students.S1).toMatchObject({
        assigned: true,
        completed: true,
        assignmentOrigin: 'CARRY',
        completionOrigin: 'CARRY',
        assignmentEvent: { assignmentId: 'old-cycle-assigned' },
        completionEvent: { completionId: 'old-cycle-success' },
      });
    }
  });

  it('falls back to allowedStudentIds and cycle-less legacy completion heuristics', () => {
    const state = projectTaskCycleState({
      task, now: '2026-08-24T12:00:00Z', assignments: [],
      completions: [completion({ taskInstanceId: undefined, cycleId: undefined, cycleStartsAt: undefined, cycleEndsAt: undefined, ruleVersion: undefined, timeZone: undefined, source: undefined, schemaVersion: undefined, studentId: 'legacy', timestamp: '2026-08-21T00:00:00Z' })],
    });
    expect(state.students.legacy).toMatchObject({ assigned: true, completed: true, assignmentOrigin: 'LEGACY' });
  });

  it('keeps each unmaterialized legacy student assigned after another student is seeded', () => {
    const partialTask = { ...task, allowedStudentIds: ['S1', 'S2'] };
    const state = projectTaskCycleState({
      task: partialTask,
      now: '2026-08-24T12:00:00Z',
      assignments: [assignment({
        assignmentId: 'seed-s1',
        studentId: 'S1',
        source: 'LEGACY_SEED',
        cycleId: 'v1|I1|r1|2026-08-24T00:00:00Z',
      })],
      completions: [],
    });

    expect(state.students.S1).toMatchObject({ assigned: true, assignmentOrigin: 'EVENT' });
    expect(state.students.S2).toMatchObject({ assigned: true, assignmentOrigin: 'LEGACY' });
    expect(state.assignedStudentIds).toEqual(['S1', 'S2']);
  });

  it('uses assignment provenance per student instead of reviving an explicitly unassigned legacy ID', () => {
    const partialTask = { ...task, allowedStudentIds: ['S1', 'S2'] };
    const state = projectTaskCycleState({
      task: partialTask,
      now: '2026-08-24T12:00:00Z',
      assignments: [assignment({
        assignmentId: 'explicit-unassign-s1',
        studentId: 'S1',
        status: 'UNASSIGNED',
      })],
      completions: [],
    });

    expect(state.students.S1).toMatchObject({ assigned: false, assignmentOrigin: 'EVENT' });
    expect(state.students.S2).toMatchObject({ assigned: true, assignmentOrigin: 'LEGACY' });
    expect(state.assignedStudentIds).toEqual(['S2']);
  });

  it('does not resurrect unseeded or explicitly unassigned legacy IDs at a reset boundary', () => {
    const resetTask = {
      ...task,
      allowedStudentIds: ['S1', 'S2'],
      schedule: { ...schedule, resetAssignmentOnCycle: true },
    };
    const state = projectTaskCycleState({
      task: resetTask,
      now: '2026-08-25T12:00:00Z',
      assignments: [assignment({
        assignmentId: 'prior-unassign-s1',
        studentId: 'S1',
        status: 'UNASSIGNED',
        cycleId: 'prior',
        cycleStartsAt: '2026-08-24T00:00:00Z',
      })],
      completions: [],
    });

    expect(state.students.S1).toMatchObject({ assigned: false, assignmentOrigin: 'DEFAULT' });
    expect(state.students.S2).toMatchObject({ assigned: false, assignmentOrigin: 'DEFAULT' });
    expect(state.assignedStudentIds).toEqual([]);
  });

  it('carries prior explicit state while retaining a different unseeded legacy student', () => {
    const partialTask = { ...task, allowedStudentIds: ['S1', 'S2'] };
    const state = projectTaskCycleState({
      task: partialTask,
      now: '2026-08-25T12:00:00Z',
      assignments: [assignment({
        assignmentId: 'prior-assigned-s1',
        studentId: 'S1',
        cycleId: 'prior',
        cycleStartsAt: '2026-08-24T00:00:00Z',
      })],
      completions: [],
    });

    expect(state.students.S1).toMatchObject({ assigned: true, assignmentOrigin: 'CARRY' });
    expect(state.students.S2).toMatchObject({ assigned: true, assignmentOrigin: 'LEGACY' });
    expect(state.assignedStudentIds).toEqual(['S1', 'S2']);
  });

  it('keeps cycle-less legacy completion true when any matching SUCCESS exists despite a later failed row', () => {
    const legacySnapshot = {
      taskInstanceId: undefined,
      cycleId: undefined,
      cycleStartsAt: undefined,
      cycleEndsAt: undefined,
      ruleVersion: undefined,
      timeZone: undefined,
      source: undefined,
      schemaVersion: undefined,
      studentId: 'legacy',
    };
    const state = projectTaskCycleState({
      task,
      now: '2026-08-24T12:00:00Z',
      assignments: [],
      completions: [
        completion({ ...legacySnapshot, completionId: 'legacy-success', status: 'SUCCESS', timestamp: '2026-08-21T00:00:00Z' }),
        completion({ ...legacySnapshot, completionId: 'legacy-failed-later', status: 'FAILED', timestamp: '2026-08-22T00:00:00Z' }),
      ],
    });

    expect(state.students.legacy).toMatchObject({
      completed: true,
      completionOrigin: 'LEGACY',
      completionEvent: { completionId: 'legacy-success' },
    });
  });

  it('keeps cycle-less legacy completion false when matching rows contain no SUCCESS', () => {
    const state = projectTaskCycleState({
      task,
      now: '2026-08-24T12:00:00Z',
      assignments: [],
      completions: [
        completion({
          taskInstanceId: undefined,
          cycleId: undefined,
          cycleStartsAt: undefined,
          cycleEndsAt: undefined,
          ruleVersion: undefined,
          timeZone: undefined,
          source: undefined,
          schemaVersion: undefined,
          studentId: 'legacy',
          status: 'FAILED',
          timestamp: '2026-08-21T00:00:00Z',
        }),
        completion({
          taskId: 'OTHER',
          taskInstanceId: undefined,
          cycleId: undefined,
          cycleStartsAt: undefined,
          cycleEndsAt: undefined,
          ruleVersion: undefined,
          timeZone: undefined,
          source: undefined,
          schemaVersion: undefined,
          studentId: 'legacy',
          status: 'SUCCESS',
          timestamp: '2026-08-22T00:00:00Z',
        }),
      ],
    });

    expect(state.students.legacy).toMatchObject({ completed: false, completionOrigin: 'LEGACY' });
  });

  it('does not reset legacy assignment or completion state for an initial permanent schedule', () => {
    const permanentTask: ClassTask = {
      ...task,
      allowedStudentIds: ['legacy'],
      schedule: {
        ...schedule,
        recurrence: { type: 'NONE' },
        resetAssignmentOnCycle: true,
        resetCompletionOnCycle: true,
      },
    };
    const state = projectTaskCycleState({
      task: permanentTask,
      now: '2026-08-24T12:00:00Z',
      assignments: [],
      completions: [completion({
        taskInstanceId: undefined,
        cycleId: undefined,
        cycleStartsAt: undefined,
        cycleEndsAt: undefined,
        ruleVersion: undefined,
        timeZone: undefined,
        source: undefined,
        schemaVersion: undefined,
        studentId: 'legacy',
        timestamp: '2026-08-21T00:00:00Z',
      })],
    });

    expect(state.transition).toBe('PERMANENT');
    expect(state.students.legacy).toMatchObject({
      assigned: true,
      completed: true,
      assignmentOrigin: 'LEGACY',
      completionOrigin: 'LEGACY',
    });

    const currentEventState = projectTaskCycleState({
      task: permanentTask,
      now: '2026-08-24T12:00:00Z',
      assignments: [assignment({
        cycleId: state.cycle.cycleId,
        cycleStartsAt: state.cycle.startsAt,
        cycleEndsAt: null,
      })],
      completions: [completion({
        cycleId: state.cycle.cycleId,
        cycleStartsAt: state.cycle.startsAt,
        cycleEndsAt: null,
      })],
    });
    expect(currentEventState.students.S1).toMatchObject({
      assigned: true,
      completed: true,
      assignmentOrigin: 'EVENT',
      completionOrigin: 'EVENT',
    });
  });

  it('ignores assignment events with the same instance ID but a different task ID', () => {
    const state = projectTaskCycleState({
      task: { ...task, allowedStudentIds: ['legacy'] },
      now: '2026-08-24T12:00:00Z',
      assignments: [assignment({ taskId: 'OTHER', studentId: 'contaminated' })],
      completions: [],
    });

    expect(state.students.contaminated).toBeUndefined();
    expect(state.students.legacy).toMatchObject({ assigned: true, assignmentOrigin: 'LEGACY' });
  });

  it('ignores completion events with the same instance ID but a different task ID', () => {
    const state = projectTaskCycleState({
      task,
      now: '2026-08-24T12:00:00Z',
      assignments: [],
      completions: [completion({ taskId: 'OTHER', studentId: 'contaminated' })],
    });

    expect(state.students.contaminated).toBeUndefined();
  });

  it('uses per-student assignment fallback when another student has a matching event', () => {
    const state = projectTaskCycleState({
      task: { ...task, allowedStudentIds: ['legacy', 'S1'] },
      now: '2026-08-24T12:00:00Z',
      assignments: [assignment({ studentId: 'S1' })],
      completions: [],
    });

    expect(state.students.S1).toMatchObject({ assigned: true, assignmentOrigin: 'EVENT' });
    expect(state.students.legacy).toMatchObject({ assigned: true, assignmentOrigin: 'LEGACY' });
  });

  it('isolates a recreated task with the same taskId by instance and legacy createdAt', () => {
    const recreated = { ...task, taskInstanceId: 'I2', createdAt: '2026-08-25T00:00:00Z', schedule: { ...schedule, effectiveFrom: '2026-08-25T00:00:00Z' } };
    const state = projectTaskCycleState({
      task: recreated, now: '2026-08-25T12:00:00Z',
      assignments: [assignment({ taskInstanceId: 'I1' })],
      completions: [completion({ taskInstanceId: 'I1' }), completion({ taskInstanceId: undefined, cycleId: undefined, cycleStartsAt: undefined, timestamp: '2026-08-24T00:00:00Z' })],
    });
    expect(state.students.S1).toBeUndefined();
    expect(state.students.legacy.assigned).toBe(true);
  });

  it('does not contaminate a recreated task lifecycle with a malformed cycle-less legacy timestamp', () => {
    const recreated = {
      ...task,
      taskInstanceId: 'I2',
      createdAt: '2026-08-25T00:00:00Z',
      schedule: { ...schedule, effectiveFrom: '2026-08-25T00:00:00Z' },
    };
    const state = projectTaskCycleState({
      task: recreated,
      now: '2026-08-25T12:00:00Z',
      assignments: [],
      completions: [completion({
        taskInstanceId: undefined,
        cycleId: undefined,
        cycleStartsAt: undefined,
        cycleEndsAt: undefined,
        ruleVersion: undefined,
        timeZone: undefined,
        source: undefined,
        schemaVersion: undefined,
        studentId: 'legacy',
        timestamp: 'not-a-date',
      })],
    });

    expect(state.students.legacy).toMatchObject({ completed: false, completionOrigin: 'DEFAULT' });
    expect(state.completedStudentIds).toEqual([]);
  });
});
