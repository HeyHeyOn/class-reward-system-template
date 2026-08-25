import { describe, expect, it } from 'vitest';
import {
  TaskRecurrenceValidationError,
  getNextNaturalTaskBoundary,
  getTaskCycle,
} from './taskRecurrence';
import type { TaskRecurrence, TaskSchedule } from './types';

const schedule = (
  recurrence: TaskRecurrence,
  overrides: Partial<TaskSchedule> = {},
): TaskSchedule => ({
  ruleVersion: 1,
  effectiveFrom: '2024-01-01T00:00:00Z',
  timeZone: 'Asia/Seoul',
  recurrence,
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: false,
  ...overrides,
});

const uncheckedRecurrence = (value: unknown): TaskRecurrence => value as TaskRecurrence;

const cycle = (currentSchedule: TaskSchedule, now: string, taskCreatedAt = '2023-12-01T00:00:00Z') =>
  getTaskCycle({ taskInstanceId: 'task-1', schedule: currentSchedule, taskCreatedAt, now });

describe('getTaskCycle', () => {
  it('gives NONE one permanent, instance-specific cycle and falls back to the epoch', () => {
    const none = schedule({ type: 'NONE' });
    expect(cycle(none, '2030-01-01T00:00:00Z')).toEqual({
      cycleId: 'v1|task-1|r1|2023-12-01T00:00:00Z',
      startsAt: '2023-12-01T00:00:00Z',
      endsAt: null,
      nextResetAt: null,
    });
    expect(cycle(none, '2030-01-01T00:00:00Z', 'invalid').startsAt)
      .toBe('1970-01-01T00:00:00Z');
    expect(getTaskCycle({
      taskInstanceId: 'task-2', schedule: none, taskCreatedAt: undefined, now: '2030-01-01T00:00:00Z',
    }).cycleId).toBe('v1|task-2|r1|1970-01-01T00:00:00Z');
  });

  it.each([
    ['just before', '2024-01-02T23:59:59.999Z', '2024-01-02T00:00:00Z', '2024-01-03T00:00:00Z'],
    ['exactly at', '2024-01-03T00:00:00Z', '2024-01-03T00:00:00Z', '2024-01-04T00:00:00Z'],
    ['just after', '2024-01-03T00:00:00.001Z', '2024-01-03T00:00:00Z', '2024-01-04T00:00:00Z'],
  ])('uses inclusive/exclusive Seoul daily boundaries %s', (_label, now, startsAt, endsAt) => {
    const result = cycle(schedule({ type: 'DAILY', time: '09:00' }), now);
    expect(result).toMatchObject({ startsAt, endsAt, nextResetAt: endsAt });
  });

  it.each([
    ['2024-01-07T23:59:59.999Z', '2024-01-01T00:00:00Z', '2024-01-08T00:00:00Z'],
    ['2024-01-08T00:00:00Z', '2024-01-08T00:00:00Z', '2024-01-15T00:00:00Z'],
    ['2024-01-08T00:00:00.001Z', '2024-01-08T00:00:00Z', '2024-01-15T00:00:00Z'],
  ])('uses Seoul ISO-weekday weekly boundaries at %s', (now, startsAt, endsAt) => {
    expect(cycle(schedule({ type: 'WEEKLY', weekday: 1, time: '09:00' }), now))
      .toMatchObject({ startsAt, endsAt, nextResetAt: endsAt });
  });

  it.each([
    ['2024-01-30T23:59:59.999Z', '2024-01-01T00:00:00Z', '2024-01-31T00:00:00Z'],
    ['2024-01-31T00:00:00Z', '2024-01-31T00:00:00Z', '2024-02-29T00:00:00Z'],
    ['2024-01-31T00:00:00.001Z', '2024-01-31T00:00:00Z', '2024-02-29T00:00:00Z'],
  ])('uses Seoul monthly boundaries at %s', (now, startsAt, endsAt) => {
    expect(cycle(schedule({ type: 'MONTHLY', dayOfMonth: 31, time: '09:00' }), now))
      .toMatchObject({ startsAt, endsAt, nextResetAt: endsAt });
  });

  it.each([
    [28, '2023-02-27T15:00:00Z'],
    [29, '2023-02-27T15:00:00Z'],
    [30, '2023-02-27T15:00:00Z'],
    [31, '2023-02-27T15:00:00Z'],
  ] as const)('clamps monthly day %i to a non-leap February month end', (day, expected) => {
    expect(cycle(schedule({ type: 'MONTHLY', dayOfMonth: day, time: '00:00' }, {
      effectiveFrom: '2023-01-01T00:00:00Z',
    }), '2023-02-28T12:00:00Z').startsAt)
      .toBe(expected);
  });

  it('handles leap years and year rollover', () => {
    const monthly = schedule({ type: 'MONTHLY', dayOfMonth: 31, time: '00:00' }, {
      effectiveFrom: '2023-01-01T00:00:00Z',
    });
    expect(cycle(monthly, '2024-02-29T00:00:00Z')).toMatchObject({
      startsAt: '2024-02-28T15:00:00Z', endsAt: '2024-03-30T15:00:00Z',
    });
    expect(cycle(monthly, '2024-01-01T00:00:00Z')).toMatchObject({
      startsAt: '2023-12-30T15:00:00Z', endsAt: '2024-01-30T15:00:00Z',
    });
  });

  it('uses Temporal compatible semantics: gap later and fold earlier in New York', () => {
    const gap = schedule({ type: 'DAILY', time: '02:30' }, {
      timeZone: 'America/New_York', effectiveFrom: '2024-03-01T00:00:00Z',
    });
    expect(cycle(gap, '2024-03-10T07:15:00Z')).toMatchObject({
      startsAt: '2024-03-09T07:30:00Z', endsAt: '2024-03-10T07:30:00Z',
    });
    const fold = schedule({ type: 'DAILY', time: '01:30' }, {
      timeZone: 'America/New_York', effectiveFrom: '2024-11-01T00:00:00Z',
    });
    expect(cycle(fold, '2024-11-03T05:45:00Z')).toMatchObject({
      startsAt: '2024-11-03T05:30:00Z', endsAt: '2024-11-04T06:30:00Z',
    });
  });

  it.each([
    [schedule({ type: 'DAILY', time: '09:00' }, { timeZone: 'Mars/Olympus' })],
    [schedule({ type: 'DAILY', time: '9:00' })],
    [schedule({ type: 'DAILY', time: '24:00' })],
    [schedule(uncheckedRecurrence({ type: 'WEEKLY', weekday: 0, time: '09:00' }))],
    [schedule(uncheckedRecurrence({ type: 'WEEKLY', weekday: 8, time: '09:00' }))],
    [schedule(uncheckedRecurrence({ type: 'MONTHLY', dayOfMonth: 0, time: '09:00' }))],
    [schedule(uncheckedRecurrence({ type: 'MONTHLY', dayOfMonth: 32, time: '09:00' }))],
  ])('rejects invalid recurrence domain values', (invalidSchedule) => {
    expect(() => cycle(invalidSchedule, '2024-02-01T00:00:00Z'))
      .toThrow(TaskRecurrenceValidationError);
  });

  it.each(['+09:00', '-05:00', '+0900', '+09'])
    ('rejects the fixed offset time zone %s', (timeZone) => {
      expect(() => cycle(
        schedule({ type: 'DAILY', time: '09:00' }, { timeZone }),
        '2024-02-01T00:00:00Z',
      )).toThrow(TaskRecurrenceValidationError);
    });

  it.each([
    null,
    42,
    { type: 'YEARLY', time: '09:00' },
    { type: 'DAILY' },
    { type: 'WEEKLY', time: '09:00' },
    { type: 'MONTHLY', time: '09:00' },
  ])('converts malformed runtime recurrence %# to the domain validation error', (recurrence) => {
    expect(() => cycle(
      schedule(uncheckedRecurrence(recurrence)),
      '2024-02-01T00:00:00Z',
    )).toThrow(TaskRecurrenceValidationError);
  });

  it('produces deterministic versioned IDs', () => {
    const daily = schedule({ type: 'DAILY', time: '09:00' }, { ruleVersion: 7 });
    const first = cycle(daily, '2024-01-03T12:00:00Z');
    expect(first.cycleId).toBe('v1|task-1|r7|2024-01-03T00:00:00Z');
    expect(cycle(daily, '2024-01-03T12:00:00Z')).toEqual(first);
  });

  it('clamps a new version first cycle to effectiveFrom and ends at the first strictly later natural boundary', () => {
    const changed = schedule({ type: 'DAILY', time: '13:00' }, {
      ruleVersion: 2, effectiveFrom: '2024-01-03T00:00:00Z',
    });
    expect(cycle(changed, '2024-01-03T00:00:00Z')).toMatchObject({
      startsAt: '2024-01-03T00:00:00Z', endsAt: '2024-01-03T04:00:00Z',
    });
    expect(cycle(changed, '2024-01-03T00:00:00.001Z').startsAt).toBe('2024-01-03T00:00:00Z');
  });

  it.each([
    [{ type: 'WEEKLY', weekday: 1, time: '09:00' } as const, '2024-01-03T12:00:00Z', '2024-01-08T00:00:00Z'],
    [{ type: 'MONTHLY', dayOfMonth: 31, time: '09:00' } as const, '2024-01-03T12:00:00Z', '2024-01-31T00:00:00Z'],
  ])('clamps a %s first cycle to effectiveFrom', (recurrence, effectiveFrom, endsAt) => {
    expect(cycle(schedule(recurrence, { ruleVersion: 2, effectiveFrom }), effectiveFrom))
      .toMatchObject({ startsAt: effectiveFrom, endsAt });
  });

  it('rejects now immediately before effectiveFrom with the exact validation error', () => {
    expect(() => cycle(
      schedule({ type: 'DAILY', time: '09:00' }, { effectiveFrom: '2024-01-03T00:00:00Z' }),
      '2024-01-02T23:59:59.999999999Z',
    )).toThrowError(new TaskRecurrenceValidationError('now must not be before effectiveFrom'));
  });

  it.each([
    [schedule({ type: 'DAILY', time: '09:00' }, { ruleVersion: 0 }), '2024-01-03T00:00:00Z', 'ruleVersion must be a positive integer'],
    [schedule({ type: 'DAILY', time: '09:00' }, { ruleVersion: 1.5 }), '2024-01-03T00:00:00Z', 'ruleVersion must be a positive integer'],
    [schedule({ type: 'DAILY', time: '09:00' }, { effectiveFrom: 'not-an-instant' }), '2024-01-03T00:00:00Z', 'effectiveFrom must be an ISO instant'],
    [schedule({ type: 'DAILY', time: '09:00' }), 'not-an-instant', 'now must be an ISO instant'],
  ])('rejects invalid schedule/instant input with the exact error', (invalidSchedule, now, message) => {
    expect(() => cycle(invalidSchedule, now))
      .toThrowError(new TaskRecurrenceValidationError(message));
  });

  it('has no gap or overlap immediately around a reset-time version transition', () => {
    const oldRule = schedule({ type: 'DAILY', time: '09:00' });
    const oldCycle = cycle(oldRule, '2024-01-02T23:59:59.999Z');
    const changed = schedule({ type: 'DAILY', time: '13:00' }, {
      ruleVersion: 2, effectiveFrom: oldCycle.endsAt!,
    });
    const at = cycle(changed, oldCycle.endsAt!);
    const after = cycle(changed, '2024-01-03T00:00:00.001Z');
    expect(oldCycle.endsAt).toBe(at.startsAt);
    expect(after.startsAt).toBe(at.startsAt);
    expect(at.endsAt).toBe('2024-01-03T04:00:00Z');
  });
});

describe('getNextNaturalTaskBoundary', () => {
  it.each(['UTC', 'Asia/Seoul', 'America/New_York', 'Etc/GMT+9'])
    ('accepts the named IANA time zone %s', (timeZone) => {
      expect(() => getNextNaturalTaskBoundary({
        recurrence: { type: 'DAILY', time: '09:00' },
        timeZone,
        after: '2024-01-02T03:00:00Z',
      })).not.toThrow();
    });

  it.each([
    [{ type: 'DAILY', time: '09:00' } as const, '2024-01-03T00:00:00Z'],
    [{ type: 'WEEKLY', weekday: 1, time: '09:00' } as const, '2024-01-08T00:00:00Z'],
    [{ type: 'MONTHLY', dayOfMonth: 31, time: '09:00' } as const, '2024-01-31T00:00:00Z'],
  ])('lets callers transition NONE to %s at the first natural boundary', (recurrence, expected) => {
    expect(getNextNaturalTaskBoundary({
      recurrence, timeZone: 'Asia/Seoul', after: '2024-01-02T03:00:00Z',
    })).toBe(expected);
  });

  it('is strictly after the edit instant when that instant is already a boundary', () => {
    expect(getNextNaturalTaskBoundary({
      recurrence: { type: 'DAILY', time: '09:00' },
      timeZone: 'Asia/Seoul',
      after: '2024-01-03T00:00:00Z',
    })).toBe('2024-01-04T00:00:00Z');
  });

  it.each([
    [{ recurrence: { type: 'NONE' } as TaskRecurrence, timeZone: 'Asia/Seoul' }, 'NONE has no natural boundary'],
    [{ recurrence: { type: 'DAILY', time: '09:00' } as TaskRecurrence, timeZone: 'Mars/Olympus' }, 'timeZone must be a valid IANA time zone'],
    [{ recurrence: uncheckedRecurrence({ type: 'WEEKLY', weekday: 8, time: '09:00' }), timeZone: 'Asia/Seoul' }, 'weekday must be an ISO weekday from 1 to 7'],
  ])('rejects unsupported or invalid boundary input with the exact error', (input, message) => {
    expect(() => getNextNaturalTaskBoundary({
      ...input,
      after: '2024-01-02T03:00:00Z',
    })).toThrowError(new TaskRecurrenceValidationError(message));
  });

  it('rejects fixed offsets and malformed recurrence through the boundary API', () => {
    expect(() => getNextNaturalTaskBoundary({
      recurrence: { type: 'DAILY', time: '09:00' },
      timeZone: '+09:00',
      after: '2024-01-02T03:00:00Z',
    })).toThrow(TaskRecurrenceValidationError);

    expect(() => getNextNaturalTaskBoundary({
      recurrence: uncheckedRecurrence({ type: 'YEARLY', time: '09:00' }),
      timeZone: 'UTC',
      after: '2024-01-02T03:00:00Z',
    })).toThrow(TaskRecurrenceValidationError);
  });
});
