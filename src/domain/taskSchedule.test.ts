import { describe, expect, it } from 'vitest';
import type { TaskSchedule } from './types';
import {
  TaskScheduleValidationError,
  parseTaskScheduleCells,
  prepareTaskScheduleEdit,
  promotePendingTaskSchedule,
  resolveTaskSchedule,
  serializeTaskScheduleCells,
  validateTaskSchedule,
} from './taskSchedule';

const current: TaskSchedule = {
  ruleVersion: 2,
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'DAILY', time: '09:00' },
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: false,
};

describe('versioned task schedule codec', () => {
  it('leaves legacy weekday cells empty for multi-weekday current and pending schedules', () => {
    const weekly = (ruleVersion: number, effectiveFrom: string): TaskSchedule => ({
      ruleVersion, effectiveFrom, timeZone: 'Asia/Seoul',
      recurrence: { type: 'WEEKLY', weekdays: [2, 4], time: '09:00' },
      resetCompletionOnCycle: true, resetAssignmentOnCycle: false,
    });
    const cells = serializeTaskScheduleCells({
      taskInstanceId: 'multi',
      currentSchedule: weekly(2, '2026-08-01T00:00:00Z'),
      pendingSchedule: weekly(3, '2026-08-02T00:00:00Z'),
    });
    expect(cells.recurrenceWeekday).toBe('');
    expect(cells.pendingRecurrenceWeekday).toBe('');
    expect(cells.recurrenceWeekdays).toBe('2,4');
    expect(cells.pendingRecurrenceWeekdays).toBe('2,4');
  });

  it('reads a missing legacy schedule as permanent NONE without requiring a physical backfill', () => {
    expect(parseTaskScheduleCells({}, {
      taskId: 'T-1',
      createdAt: '2026-08-01T00:00:00.000Z',
      classTimeZone: 'Asia/Tokyo',
    })).toEqual({
      taskInstanceId: 'legacy:T-1:2026-08-01T00:00:00.000Z',
      currentSchedule: {
        ruleVersion: 1,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        timeZone: 'Asia/Tokyo',
        recurrence: { type: 'NONE' },
        resetCompletionOnCycle: false,
        resetAssignmentOnCycle: false,
      },
      pendingSchedule: null,
    });
  });

  it('uses an explicit epoch fallback for malformed or missing legacy createdAt', () => {
    for (const createdAt of [undefined, '', 'not-a-date', '123', '2026-02-30', '2026-08-01T09:00:00', '2026-08-01']) {
      const parsed = parseTaskScheduleCells({}, { taskId: 'T-2', createdAt, classTimeZone: 'bad/zone' });
      expect(parsed.taskInstanceId).toBe('legacy:T-2:1970-01-01T00:00:00.000Z');
      expect(parsed.currentSchedule.effectiveFrom).toBe('1970-01-01T00:00:00.000Z');
      expect(parsed.currentSchedule.timeZone).toBe('Asia/Seoul');
    }
  });

  it('canonicalizes only strict legacy instants with an explicit offset independent of host time zone', () => {
    expect(parseTaskScheduleCells({}, {
      taskId: 'T-Z', createdAt: '2026-08-01T09:00:00+09:00',
    }).currentSchedule.effectiveFrom).toBe('2026-08-01T00:00:00.000Z');
    expect(parseTaskScheduleCells({}, {
      taskId: 'T-Z', createdAt: '2026-08-01T00:00:00.123456789Z',
    }).currentSchedule.effectiveFrom).toBe('2026-08-01T00:00:00.123Z');
  });

  it('round-trips current and pending schedules through the fixed sheet field contract', () => {
    const pending: TaskSchedule = {
      ruleVersion: 3,
      effectiveFrom: '2026-08-02T00:00:00.000Z',
      timeZone: 'America/New_York',
      recurrence: { type: 'WEEKLY', weekdays: [5], time: '08:30' },
      resetCompletionOnCycle: false,
      resetAssignmentOnCycle: true,
    };
    const cells = serializeTaskScheduleCells({ taskInstanceId: 'instance-1', currentSchedule: current, pendingSchedule: pending });
    expect(cells).toMatchObject({
      taskInstanceId: 'instance-1', ruleVersion: '2', scheduleEffectiveFrom: current.effectiveFrom,
      recurrenceTimeZone: 'Asia/Seoul', recurrenceType: 'DAILY', recurrenceTime: '09:00',
      pendingRuleVersion: '3', pendingEffectiveFrom: pending.effectiveFrom, pendingTimeZone: 'America/New_York',
      pendingRecurrenceType: 'WEEKLY', pendingRecurrenceTime: '08:30', pendingRecurrenceWeekday: '5',
      pendingResetCompletionOnCycle: 'FALSE', pendingResetAssignmentOnCycle: 'TRUE',
    });
    expect(parseTaskScheduleCells(cells, { taskId: 'ignored', createdAt: current.effectiveFrom })).toEqual({
      taskInstanceId: 'instance-1', currentSchedule: current, pendingSchedule: pending,
    });
  });

  it('falls back non-destructively to legacy NONE when persisted schedule cells are malformed', () => {
    const parsed = parseTaskScheduleCells({
      taskInstanceId: 'kept-instance', ruleVersion: 'zero', scheduleEffectiveFrom: 'bad',
      recurrenceTimeZone: '+09:00', recurrenceType: 'WEEKLY', recurrenceTime: '25:00', recurrenceWeekday: '9',
      resetCompletionOnCycle: 'TRUE', pendingRuleVersion: '2', pendingEffectiveFrom: 'bad', pendingRecurrenceType: 'DAILY',
    }, { taskId: 'T-3', createdAt: '2026-01-01T00:00:00Z' });
    expect(parsed.taskInstanceId).toBe('kept-instance');
    expect(parsed.currentSchedule).toMatchObject({ ruleVersion: 1, recurrence: { type: 'NONE' }, timeZone: 'Asia/Seoul' });
    expect(parsed.pendingSchedule).toBeNull();
    expect(parsed.readWarnings).toEqual(['INVALID_CURRENT_SCHEDULE', 'INVALID_PENDING_SCHEDULE']);
    expect(() => serializeTaskScheduleCells(parsed)).toThrow(TaskScheduleValidationError);
  });

  it('diagnoses any populated malformed current or pending schedule field but not a true legacy row', () => {
    expect(parseTaskScheduleCells({ recurrenceTimeZone: 'Mars/Olympus' }, { taskId: 'current' }).readWarnings)
      .toEqual(['INVALID_CURRENT_SCHEDULE']);
    expect(parseTaskScheduleCells({ pendingRecurrenceType: 'DAILY' }, { taskId: 'pending' }).readWarnings)
      .toEqual(['INVALID_PENDING_SCHEDULE']);
    expect(parseTaskScheduleCells({}, { taskId: 'legacy' }).readWarnings).toBeUndefined();
  });

  it.each([
    [{ ...current, timeZone: 'Mars/Olympus' }],
    [{ ...current, timeZone: '+09:00' }],
    [{ ...current, ruleVersion: 0 }],
    [{ ...current, effectiveFrom: 'tomorrow' }],
    [{ ...current, recurrence: { type: 'DAILY', time: '9:00' } }],
    [{ ...current, recurrence: { type: 'WEEKLY', weekdays: [0], time: '09:00' } }],
    [{ ...current, recurrence: { type: 'MONTHLY', dayOfMonth: 32, time: '09:00' } }],
  ])('rejects invalid new schedule input %# with a domain validation error', (schedule) => {
    expect(() => validateTaskSchedule(schedule)).toThrow(TaskScheduleValidationError);
  });

  it('canonicalizes surrounding whitespace in a valid named schedule time zone', () => {
    expect(validateTaskSchedule({ ...current, timeZone: '  America/New_York  ' }).timeZone)
      .toBe('America/New_York');
  });

  it.each([
    ['2026-08-01T09:00:00+09:00', '2026-08-01T00:00:00.000Z'],
    ['2026-08-01T00:00:00.123456789Z', '2026-08-01T00:00:00.123Z'],
  ])('canonicalizes effectiveFrom %s to millisecond UTC persistence', (effectiveFrom, expected) => {
    const validated = validateTaskSchedule({ ...current, effectiveFrom });
    expect(validated.effectiveFrom).toBe(expected);
    expect(serializeTaskScheduleCells({
      taskInstanceId: 'canonical-instance', currentSchedule: validated, pendingSchedule: null,
    }).scheduleEffectiveFrom).toBe(expected);
  });

  it('selects pending at its inclusive effective instant and promotes it without mutation', () => {
    const pending = { ...current, ruleVersion: 3, effectiveFrom: '2026-08-02T00:00:00Z' };
    expect(resolveTaskSchedule({ currentSchedule: current, pendingSchedule: pending, now: '2026-08-01T23:59:59.999Z' })).toBe(current);
    expect(resolveTaskSchedule({ currentSchedule: current, pendingSchedule: pending, now: pending.effectiveFrom })).toBe(pending);
    const state = { taskInstanceId: 'i', currentSchedule: current, pendingSchedule: pending };
    expect(promotePendingTaskSchedule(state)).toEqual({ taskInstanceId: 'i', currentSchedule: pending, pendingSchedule: null });
    expect(state.pendingSchedule).toBe(pending);
  });

  it('applies recurring schedule edits immediately at the edit instant', () => {
    expect(prepareTaskScheduleEdit({
      currentSchedule: current,
      recurrence: { type: 'WEEKLY', weekdays: [1], time: '09:00' },
      timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
      editedAt: '2026-08-01T03:00:00Z',
    })).toMatchObject({ ruleVersion: 3, effectiveFrom: '2026-08-01T03:00:00.000Z' });

    const none = { ...current, recurrence: { type: 'NONE' } as const };
    expect(prepareTaskScheduleEdit({
      currentSchedule: none, recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: false, editedAt: '2026-08-01T03:00:00Z',
    })).toMatchObject({ ruleVersion: 3, effectiveFrom: '2026-08-01T03:00:00.000Z' });
  });

  it.each([
    ['2026-08-01T12:00:00+09:00', '2026-08-01T03:00:00.000Z'],
    ['2026-08-01T03:00:00.987654321Z', '2026-08-01T03:00:00.987Z'],
  ])('canonicalizes editedAt %s with the schedule persistence convention', (editedAt, expected) => {
    expect(prepareTaskScheduleEdit({
      currentSchedule: current,
      recurrence: { type: 'WEEKLY', weekdays: [1], time: '09:00' },
      timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
      editedAt,
    }).effectiveFrom).toBe(expected);
  });

  it.each([
    { type: 'DAILY', time: '09:00' } as const,
    { type: 'WEEKLY', weekdays: [3], time: '09:00' } as const,
    { type: 'MONTHLY', dayOfMonth: 15, time: '09:00' } as const,
  ])('updates reset flags without creating a new version when the recurrence and time zone are unchanged', (recurrence) => {
    const recurring = { ...current, recurrence };
    expect(prepareTaskScheduleEdit({
      currentSchedule: recurring,
      recurrence: { ...recurrence },
      timeZone: recurring.timeZone,
      resetCompletionOnCycle: !recurring.resetCompletionOnCycle,
      resetAssignmentOnCycle: !recurring.resetAssignmentOnCycle,
      editedAt: '2026-08-01T03:00:00Z',
    })).toEqual({
      ...recurring,
      resetCompletionOnCycle: !recurring.resetCompletionOnCycle,
      resetAssignmentOnCycle: !recurring.resetAssignmentOnCycle,
    });
  });

  it.each([
    [{ type: 'DAILY', time: '10:00' } as const, 'Asia/Seoul'],
    [{ type: 'DAILY', time: '09:00' } as const, 'America/New_York'],
  ])('creates a new version when a recurring schedule rule changes', (recurrence, timeZone) => {
    expect(prepareTaskScheduleEdit({
      currentSchedule: current,
      recurrence,
      timeZone,
      resetCompletionOnCycle: current.resetCompletionOnCycle,
      resetAssignmentOnCycle: current.resetAssignmentOnCycle,
      editedAt: '2026-08-01T03:00:00Z',
    })).toMatchObject({ ruleVersion: 3, effectiveFrom: '2026-08-01T03:00:00.000Z' });
  });

  it('does not create a reward cycle/version for a NONE to NONE settings edit', () => {
    const none = { ...current, recurrence: { type: 'NONE' } as const };
    expect(prepareTaskScheduleEdit({
      currentSchedule: none, recurrence: { type: 'NONE' }, timeZone: 'Asia/Tokyo',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: true, editedAt: '2026-08-01T03:00:00Z',
    })).toEqual({ ...none, timeZone: 'Asia/Tokyo', resetCompletionOnCycle: true, resetAssignmentOnCycle: true });
  });
});
