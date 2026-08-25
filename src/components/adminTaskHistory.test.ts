import { describe, expect, it } from 'vitest';
import { formatAdminTaskHistoryEvent, groupAdminTaskHistory } from './adminTaskHistory';

const events = [
  { eventType: 'COMPLETION', eventId: 'c2', occurredAt: '2026-08-25T03:00:00Z', taskId: 'T1', taskInstanceId: 'i1', cycleId: 'cycle-2', ruleVersion: 2, studentId: 'S1', studentName: '민준', completionStatus: 'SUCCESS', completionSource: 'CARRY_FORWARD', reward: 0, balanceBefore: 10, balanceAfter: 10, note: '' },
  { eventType: 'ASSIGNMENT', eventId: 'a1', occurredAt: '2026-08-25T01:00:00Z', taskId: 'T1', taskInstanceId: 'i1', cycleId: 'cycle-1', ruleVersion: 1, studentId: 'S1', assignmentStatus: 'ASSIGNED', assignmentSource: 'ADMIN', note: '' },
  { eventType: 'COMPLETION', eventId: 'c1', occurredAt: '2026-08-25T02:00:00Z', taskId: 'T1', taskInstanceId: 'i1', cycleId: 'cycle-1', ruleVersion: 1, studentId: 'S1', studentName: '민준', completionStatus: 'RESET', completionSource: 'ADMIN_RESET', reward: 0, balanceBefore: 10, balanceAfter: 10, note: '' },
] as const;

describe('adminTaskHistory', () => {
  it('groups lifecycles and cycles without mutating events, sorted chronologically', () => {
    const original = JSON.stringify(events);
    const groups = groupAdminTaskHistory({
      taskId: 'T1', requestedTaskInstanceId: null,
      currentLifecycle: { taskDefinitionExists: true, taskInstanceId: 'i1', currentCycleStatus: null },
      cumulativeHistory: { eventCount: events.length, lifecycles: [{ taskInstanceId: 'i1', isCurrentLifecycle: true, eventCount: 3, firstOccurredAt: events[1].occurredAt, lastOccurredAt: events[0].occurredAt, events: [...events] }] },
    });
    expect(groups[0].isCurrentLifecycle).toBe(true);
    expect(groups[0].cycles.map((cycle) => cycle.cycleId)).toEqual(['cycle-1', 'cycle-2']);
    expect(groups[0].cycles[0].events.map((event) => event.eventId)).toEqual(['a1', 'c1']);
    expect(JSON.stringify(events)).toBe(original);
  });

  it('formats assignment, completion, carry and reset events in understandable Korean', () => {
    expect(formatAdminTaskHistoryEvent(events[1])).toContain('부여');
    expect(formatAdminTaskHistoryEvent(events[0])).toContain('이월');
    expect(formatAdminTaskHistoryEvent(events[2])).toContain('초기화');
  });

  it('shows reset source and preserves an explicitly recorded zero reward', () => {
    expect(formatAdminTaskHistoryEvent(events[2])).toContain('관리자 초기화');
    expect(formatAdminTaskHistoryEvent(events[0])).toContain('보상 0');
  });

  it('does not invent a zero reward when a reset history DTO has no reward field', () => {
    const resetWithoutReward = { ...events[2], reward: undefined };
    expect(formatAdminTaskHistoryEvent(resetWithoutReward)).not.toContain('보상 0');
  });

  it('marks rule-version changes between adjacent cycle groups', () => {
    const groups = groupAdminTaskHistory({ cumulativeHistory: { lifecycles: [{ taskInstanceId: 'i1', isCurrentLifecycle: true, events: [...events] }] } } as never);
    expect(groups[0].cycles[1].scheduleChanged).toBe(true);
  });
});
