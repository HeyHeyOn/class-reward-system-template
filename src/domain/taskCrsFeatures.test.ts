import { describe, expect, it } from 'vitest';
import { getTaskCycle } from './taskRecurrence';
import { classifyTaskAvailability, validateTaskAvailability } from './taskAvailability';
import { validateTaskPrerequisiteGraph } from './taskPrerequisite';
import { formatStudentTaskDue, formatStudentTaskRecurrence } from './taskStudentDisplay';
import type { ClassTask, TaskSchedule } from './types';

const baseTask = (taskId: string, prerequisiteTaskId?: string): ClassTask => ({
  taskId, title: taskId, description: '', reward: 1, isActive: true, sortOrder: 1,
  allowedStudentIds: [], ...(prerequisiteTaskId ? { prerequisiteTaskId } : {}),
});

describe('CRS task availability', () => {
  it('uses an inclusive start and exclusive due instant', () => {
    const window = { availableFrom: '2026-08-01T00:00:00Z', dueAt: '2026-08-02T00:00:00Z' };
    expect(classifyTaskAvailability(window, '2026-07-31T23:59:59.999Z')).toBe('UPCOMING');
    expect(classifyTaskAvailability(window, '2026-08-01T00:00:00Z')).toBe('AVAILABLE');
    expect(classifyTaskAvailability(window, '2026-08-02T00:00:00Z')).toBe('EXPIRED');
  });

  it('validates ISO instants and increasing windows', () => {
    expect(() => validateTaskAvailability({ availableFrom: 'bad' })).toThrow('ISO');
    expect(() => validateTaskAvailability({ availableFrom: '2026-08-02T00:00:00Z', dueAt: '2026-08-02T00:00:00Z' })).toThrow('기한');
  });
});

describe('CRS prerequisites', () => {
  it('rejects missing, self, and cyclic references', () => {
    expect(() => validateTaskPrerequisiteGraph([baseTask('A', 'X')])).toThrow('찾을 수');
    expect(() => validateTaskPrerequisiteGraph([baseTask('A', 'A')])).toThrow('자기 자신');
    expect(() => validateTaskPrerequisiteGraph([baseTask('A', 'B'), baseTask('B', 'A')])).toThrow('순환');
  });

  it('normalizes IDs consistently and rejects whitespace-hidden cycles', () => {
    expect(() => validateTaskPrerequisiteGraph([
      baseTask(' A ', ' B '),
      baseTask('B', 'A'),
    ])).toThrow('순환');
  });

  it('rejects references to inactive prerequisite tasks', () => {
    expect(() => validateTaskPrerequisiteGraph([
      { ...baseTask('A'), isActive: false },
      baseTask('B', 'A'),
    ])).toThrow('비활성');
  });
});

describe('weekly multi-day recurrence', () => {
  const schedule: TaskSchedule = {
    ruleVersion: 1, effectiveFrom: '2026-08-01T00:00:00Z', timeZone: 'Asia/Seoul',
    recurrence: { type: 'WEEKLY', weekdays: [1, 4], time: '09:00' },
    resetCompletionOnCycle: true, resetAssignmentOnCycle: false,
  };
  it('rejects empty, duplicate, and out-of-range weekday arrays', () => {
    const invalid = (weekdays: number[]) => ({ ...schedule, recurrence: { type: 'WEEKLY' as const, weekdays, time: '09:00' } });
    expect(() => getTaskCycle({ taskInstanceId: 'I', schedule: invalid([]) as TaskSchedule, now: '2026-08-03T01:00:00Z' })).toThrow('weekdays');
    expect(() => getTaskCycle({ taskInstanceId: 'I', schedule: invalid([1, 1]) as TaskSchedule, now: '2026-08-03T01:00:00Z' })).toThrow('unique');
    expect(() => getTaskCycle({ taskInstanceId: 'I', schedule: invalid([8]) as TaskSchedule, now: '2026-08-03T01:00:00Z' })).toThrow('1 to 7');
  });

  it('cycles Monday to Thursday and Thursday to Monday', () => {
    const monday = getTaskCycle({ taskInstanceId: 'I', schedule, now: '2026-08-03T01:00:00Z' });
    expect(monday).toMatchObject({ startsAt: '2026-08-03T00:00:00Z', endsAt: '2026-08-06T00:00:00Z' });
    const thursday = getTaskCycle({ taskInstanceId: 'I', schedule, now: '2026-08-06T01:00:00Z' });
    expect(thursday).toMatchObject({ startsAt: '2026-08-06T00:00:00Z', endsAt: '2026-08-10T00:00:00Z' });
  });
});

describe('student-safe task display', () => {
  it('shows only due and recurrence summaries', () => {
    expect(formatStudentTaskDue(undefined)).toBe('기한: 없음');
    expect(formatStudentTaskDue('2026-08-27T04:30:00Z')).toBe('기한: 2026년 8월 27일 오후 1:30까지');
    expect(formatStudentTaskRecurrence({ type: 'WEEKLY', weekdays: [1, 4], time: '09:00' })).toBe('반복: 매주 월, 목');
  });
});
