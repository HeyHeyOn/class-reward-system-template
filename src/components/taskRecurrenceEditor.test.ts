import { describe, expect, it } from 'vitest';
import {
  EMPTY_RECURRENCE_FORM,
  formatRecurrenceSummary,
  resolveEffectiveAdminTaskSchedule,
  scheduleDtoToForm,
  scheduleFormToPayload,
  validateRecurrenceForm,
} from './taskRecurrenceEditor';

const baseSchedule = {
  ruleVersion: 3,
  effectiveFrom: '2026-08-25T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'NONE' as const },
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
};

describe('taskRecurrenceEditor', () => {
  it.each([
    [{ type: 'NONE' }, { type: 'NONE' }, '반복 없음'],
    [{ type: 'DAILY', time: '08:30' }, { type: 'DAILY', time: '08:30' }, '매일 08:30'],
    [{ type: 'WEEKLY', weekday: 3, time: '09:10' }, { type: 'WEEKLY', weekday: 3, time: '09:10' }, '매주 수요일 09:10'],
    [{ type: 'MONTHLY', dayOfMonth: 31, time: '17:45' }, { type: 'MONTHLY', dayOfMonth: 31, time: '17:45' }, '매월 31일 17:45'],
  ] as const)('round trips %o with a strict edit payload', (recurrence, expected, summary) => {
    const form = scheduleDtoToForm({ ...baseSchedule, recurrence, resetCompletionOnCycle: true });
    const result = scheduleFormToPayload(form);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        recurrence: expected,
        timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: false,
      });
      expect(Object.keys(result.payload).sort()).toEqual(['recurrence', 'resetAssignmentOnCycle', 'resetCompletionOnCycle', 'timeZone'].sort());
    }
    expect(formatRecurrenceSummary(form)).toBe(summary);
  });

  it('keeps additive API metadata while exposing stable controlled defaults', () => {
    const form = scheduleDtoToForm(undefined, { timeZone: 'Europe/Paris', taskInstanceId: 'instance-7' });
    expect(form).toEqual({ ...EMPTY_RECURRENCE_FORM, timeZone: 'Europe/Paris', taskInstanceId: 'instance-7' });
    expect(Object.values(form).every((value) => value !== undefined)).toBe(true);
  });

  it('validates only fields required by the selected recurrence', () => {
    expect(validateRecurrenceForm({ ...EMPTY_RECURRENCE_FORM, type: 'DAILY', time: '24:00' })).toContain('시간');
    expect(validateRecurrenceForm({ ...EMPTY_RECURRENCE_FORM, type: 'WEEKLY', time: '08:00', weekday: '0' })).toContain('요일');
    expect(validateRecurrenceForm({ ...EMPTY_RECURRENCE_FORM, type: 'MONTHLY', time: '08:00', dayOfMonth: '32' })).toContain('1일부터 31일');
    expect(validateRecurrenceForm({ ...EMPTY_RECURRENCE_FORM, type: 'MONTHLY', time: '08:00', dayOfMonth: '31' })).toBeNull();
    expect(validateRecurrenceForm({ ...EMPTY_RECURRENCE_FORM, type: 'NONE', time: '', weekday: '', dayOfMonth: '' })).toBeNull();
  });

  it('uses an already-effective pending schedule and keeps a future pending schedule inactive', () => {
    const currentSchedule = {
      ...baseSchedule,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      recurrence: { type: 'DAILY' as const, time: '09:00' },
    };
    const pendingSchedule = {
      ...baseSchedule,
      ruleVersion: 4,
      effectiveFrom: '2026-08-20T00:00:00.000Z',
      timeZone: 'Europe/Paris',
      recurrence: { type: 'WEEKLY' as const, weekday: 5 as const, time: '16:30' },
    };

    expect(resolveEffectiveAdminTaskSchedule(
      { schedule: currentSchedule, pendingSchedule },
      '2026-08-25T00:00:00.000Z',
    )).toBe(pendingSchedule);
    expect(resolveEffectiveAdminTaskSchedule(
      { schedule: currentSchedule, pendingSchedule },
      '2026-08-10T00:00:00.000Z',
    )).toBe(currentSchedule);
  });
});
