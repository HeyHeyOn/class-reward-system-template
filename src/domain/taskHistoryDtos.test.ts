import { describe, expect, it } from 'vitest';
import { buildTaskHistoryDetailDto, buildTaskHistoryListDto } from './taskHistoryDtos';
import type { TaskCycleHistoryEvent } from '@/server/repositories/sheets/taskCycleQueries';

const events: TaskCycleHistoryEvent[] = [
  {
    eventType: 'COMPLETION', eventId: 'old-completion', occurredAt: '2026-01-01T00:00:00Z',
    taskId: 'T1', taskInstanceId: 'old-instance', cycleId: 'old-cycle', studentId: 'S1',
    completionStatus: 'SUCCESS', completionSource: 'BANK', studentName: 'Student', reward: 5,
    balanceBefore: 0, balanceAfter: 5, note: '',
  },
  {
    eventType: 'ASSIGNMENT', eventId: 'current-assignment', occurredAt: '2026-02-01T00:00:00Z',
    taskId: 'T1', taskInstanceId: 'current-instance', cycleId: 'current-cycle', studentId: 'S1',
    assignmentStatus: 'ASSIGNED', assignmentSource: 'ADMIN', note: '',
  },
];

const currentCycleState = {
  taskId: 'T1', taskInstanceId: 'current-instance', transition: 'PERMANENT' as const,
  cycle: { cycleId: 'current-cycle', startsAt: '2026-02-01T00:00:00Z', endsAt: null, nextResetAt: null },
  students: {
    S1: {
      assigned: true, completed: false, assignmentOrigin: 'EVENT' as const, completionOrigin: 'DEFAULT' as const,
      assignmentEvent: { assignmentId: 'current-assignment' } as never,
    },
  },
  assignedStudentIds: ['S1'], completedStudentIds: [],
};

describe('task history DTOs', () => {
  it('separates current-cycle status from cumulative lifecycle summaries', () => {
    expect(buildTaskHistoryListDto({
      taskId: 'T1', currentTaskDefinitionExists: true,
      currentTaskInstanceId: 'current-instance', currentCycleState, events,
    })).toEqual({
      taskId: 'T1',
      currentLifecycle: {
        taskDefinitionExists: true,
        taskInstanceId: 'current-instance',
        currentCycleStatus: {
          cycleId: 'current-cycle', startsAt: '2026-02-01T00:00:00Z', endsAt: null,
          transition: 'PERMANENT', assignedStudentIds: ['S1'], completedStudentIds: [],
          students: [{ studentId: 'S1', assigned: true, completed: false, assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT' }],
        },
      },
      cumulativeHistory: {
        eventCount: 2,
        lifecycles: [
          { taskInstanceId: 'old-instance', isCurrentLifecycle: false, eventCount: 1, firstOccurredAt: '2026-01-01T00:00:00Z', lastOccurredAt: '2026-01-01T00:00:00Z' },
          { taskInstanceId: 'current-instance', isCurrentLifecycle: true, eventCount: 1, firstOccurredAt: '2026-02-01T00:00:00Z', lastOccurredAt: '2026-02-01T00:00:00Z' },
        ],
      },
    });
  });

  it('returns immutable JSON-friendly detail groups and identifies a deleted lifecycle', () => {
    const dto = buildTaskHistoryDetailDto({
      taskId: 'T1', requestedTaskInstanceId: 'old-instance', currentTaskDefinitionExists: false,
      currentTaskInstanceId: null,
      currentCycleState: null, events: [events[0]],
    });
    expect(dto).toEqual({
      taskId: 'T1', requestedTaskInstanceId: 'old-instance',
      currentLifecycle: { taskDefinitionExists: false, taskInstanceId: null, currentCycleStatus: null },
      cumulativeHistory: {
        eventCount: 1,
        lifecycles: [{
          taskInstanceId: 'old-instance', isCurrentLifecycle: false, eventCount: 1,
          firstOccurredAt: '2026-01-01T00:00:00Z', lastOccurredAt: '2026-01-01T00:00:00Z',
          events: [events[0]],
        }],
      },
    });
    expect(dto.cumulativeHistory.lifecycles[0].events?.[0]).not.toBe(events[0]);
  });

  it('keeps an existing legacy definition truthful when it has no instance ID or cycle state', () => {
    expect(buildTaskHistoryDetailDto({
      taskId: 'T-LEGACY',
      currentTaskDefinitionExists: true,
      currentTaskInstanceId: null,
      currentCycleState: null,
      events: [],
    }).currentLifecycle).toEqual({
      taskDefinitionExists: true,
      taskInstanceId: null,
      currentCycleStatus: null,
    });
  });

  it('shows the current reused definition while limiting detail history to the requested old lifecycle', () => {
    const dto = buildTaskHistoryDetailDto({
      taskId: 'T1',
      requestedTaskInstanceId: 'old-instance',
      currentTaskDefinitionExists: true,
      currentTaskInstanceId: 'current-instance',
      currentCycleState,
      events: [events[0]],
    });

    expect(dto.currentLifecycle).toMatchObject({
      taskDefinitionExists: true,
      taskInstanceId: 'current-instance',
      currentCycleStatus: { cycleId: 'current-cycle' },
    });
    expect(dto.cumulativeHistory).toMatchObject({
      eventCount: 1,
      lifecycles: [{ taskInstanceId: 'old-instance', isCurrentLifecycle: false, eventCount: 1 }],
    });
  });
});
