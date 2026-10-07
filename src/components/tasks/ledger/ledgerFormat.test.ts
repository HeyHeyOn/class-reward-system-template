import { afterEach, describe, expect, it } from 'vitest';
import {
  definitionFromForm, definitionFormOf, formatInstant, formatSince, historySentence, isWord, previewNextReset, recurrenceSummary,
  repeatFormOf, repeatFromForm, resetStageSummary, toWord,
} from './ledgerFormat';
import { clearLegacyTaskJournals } from './useTaskLedger';
import { makeTask } from './ledgerTestServer';

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Korean wording', () => {
  it('formats Seoul instants and since labels', () => {
    expect(formatInstant('2026-10-07T00:00:00.000Z', '2026-10-06T00:00:00.000Z')).toBe('10월 7일(수) 오전 9:00');
    expect(formatInstant('2027-01-02T06:05:00.000Z', '2026-10-06T00:00:00.000Z')).toBe('2027년 1월 2일(토) 오후 3:05');
    expect(formatSince('2026-10-06T00:00:00.000Z')).toBe('10/6 09:00부터');
  });

  it('picks particles by the last syllable', () => {
    expect(isWord('미완료')).toBe('미완료예요');
    expect(isWord('완료 가능')).toBe('완료 가능이에요');
    expect(toWord('미부여')).toBe('미부여로');
    expect(toWord('완료 가능')).toBe('완료 가능으로');
    expect(resetStageSummary('READY')).toBe('완료 가능으로 초기화');
    expect(resetStageSummary(null)).toBe('초기화 안 함');
  });

  it('writes history entries as sentences', () => {
    expect(historySentence({ id: '1', at: '2026-10-06T00:00:00.000Z', studentId: 'S1', studentName: '김민준', stage: 'COMPLETED', previousStage: 'READY', cause: 'BANK', reward: 120 }, '원'))
      .toBe('김민준 · 완료 가능 → 완료 · 은행에서 완료 (+120원)');
    expect(historySentence({ id: '2', at: '2026-10-06T00:00:00.000Z', studentId: 'S2', studentName: '', stage: 'READY', previousStage: null, cause: 'AUTO_RESET', reward: null }, '원'))
      .toBe('S2 · 완료 가능 · 자동 초기화');
  });
});

describe('forms', () => {
  it('turns repeat forms into the contract setting', () => {
    expect(repeatFromForm({ ...repeatFormOf(null), type: 'WEEKLY', weekdays: [5, 1], time: '07:40', resetStage: 'UNASSIGNED' }))
      .toEqual({ ok: true, value: { recurrence: { type: 'WEEKLY', time: '07:40', weekdays: [1, 5] }, resetStage: 'UNASSIGNED' } });
    expect(repeatFromForm({ ...repeatFormOf(null), type: 'DAILY', resetStage: 'NONE' })).toEqual({ ok: true, value: { recurrence: { type: 'DAILY', time: '09:00' }, resetStage: null } });
    expect(repeatFromForm({ ...repeatFormOf(null), type: 'NONE', resetStage: 'PENDING' })).toEqual({ ok: true, value: { recurrence: { type: 'NONE' }, resetStage: null } });
    expect(repeatFromForm({ ...repeatFormOf(null), type: '' }).ok).toBe(false);
    expect(repeatFromForm({ ...repeatFormOf(null), type: 'MONTHLY', dayOfMonth: '' }).ok).toBe(false);
    expect(recurrenceSummary({ type: 'MONTHLY', time: '13:00', dayOfMonth: 1 })).toBe('매월 1일 오후 1:00');
    expect(previewNextReset({ recurrence: { type: 'DAILY', time: '09:00' }, resetStage: 'READY' }, '2026-10-06T01:00:00.000Z')).toBe('2026-10-07T00:00:00Z');
    expect(previewNextReset({ recurrence: { type: 'DAILY', time: '09:00' }, resetStage: null }, '2026-10-06T01:00:00.000Z')).toBeNull();
  });

  it('round-trips the definition through Seoul datetime-local values', () => {
    const task = makeTask({ availableFrom: '2026-10-06T23:00:00.000Z', dueAt: '2026-10-10T08:59:00.000Z' });
    const form = definitionFormOf(task);
    expect(form.availableFrom).toBe('2026-10-07T08:00');
    expect(definitionFromForm(form)).toEqual({ ok: true, value: { title: task.title, description: task.description, reward: 120, isActive: true, sortOrder: 1,
      availableFrom: '2026-10-06T23:00:00.000Z', dueAt: '2026-10-10T08:59:00.000Z', prerequisiteTaskId: null } });
    expect(definitionFromForm({ ...form, reward: '' })).toEqual({ ok: false, error: '보상은 0 이상의 정수여야 합니다.' });
    expect(definitionFromForm({ ...form, dueAt: '2026-10-07T07:00' })).toEqual({ ok: false, error: '시작 시각은 기한보다 빨라야 합니다.' });
  });
});

describe('legacy journals', () => {
  it('removes only this class’s old task journals', () => {
    window.history.replaceState(null, '', '/c/demo-a/admin');
    const keep = ['crs:task-definition-save:/api/c/demo-ab/tasks/batch', 'crs:bank-completion:v1:/c/demo-a/bank', 'crs:other'];
    const drop = [
      'crs:task-completion-reset:/api/c/demo-a/tasks/completions/reset',
      'crs:task-assignment-save:/api/c/demo-a/tasks/assignments/batch',
      'crs:task-assignment-save:/api/c/demo-a/tasks/assignments/batch:drafts',
      'crs:task-schedule-save:/api/c/demo-a/tasks/schedules/batch',
      'crs:task-qr:/api/c/demo-a/tasks/qr-assignment',
      'crs:single-task-delete:/api/c/demo-a/tasks',
      'crs:admin-completion:/api/c/demo-a/tasks/admin-completion',
    ];
    for (const key of [...keep, ...drop]) sessionStorage.setItem(key, '{}');
    expect(clearLegacyTaskJournals()).toBe(drop.length);
    expect(Object.keys(sessionStorage).sort()).toEqual([...keep].sort());
  });

  it('does nothing outside a class page', () => {
    sessionStorage.setItem('crs:task-definition-save:/api/tasks/batch', '{}');
    expect(clearLegacyTaskJournals()).toBe(0);
    expect(sessionStorage.length).toBe(1);
  });
});
