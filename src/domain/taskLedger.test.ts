import { describe, expect, it } from 'vitest';
import { lastResetAt, ledgerTimeline, nextResetAt, projectLedgerStage, type LedgerEvent, type ResetWindow } from './taskLedger';
import { initialSchedule, resetWindowsOf, scheduleForRepeat, storedResetStage } from './taskRepeat';

let seq = 0;
const stage = (at: string, value: 'UNASSIGNED' | 'PENDING' | 'READY'): LedgerEvent => ({ kind: 'STAGE', id: `s${++seq}`, at, seq, stage: value });
const done = (at: string): LedgerEvent => ({ kind: 'COMPLETED', id: `c${++seq}`, at, seq });
const undone = (at: string): LedgerEvent => ({ kind: 'UNCOMPLETED', id: `u${++seq}`, at, seq });

// 09:00 in Seoul is 00:00 UTC.
const daily = (resetStage: ResetWindow['resetStage'], from = '2026-10-01T00:00:00.000Z', until: string | null = null): ResetWindow =>
  ({ recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul', resetStage, from, until });

describe('projectLedgerStage', () => {
  it('is 미부여 with no events and follows the latest event', () => {
    expect(projectLedgerStage({ events: [], windows: [], now: '2026-10-06T00:00:00Z' }))
      .toMatchObject({ stage: 'UNASSIGNED', since: null, byReset: false });
    const events = [stage('2026-10-02T01:00:00Z', 'PENDING'), stage('2026-10-02T02:00:00Z', 'READY')];
    expect(projectLedgerStage({ events, windows: [], now: '2026-10-06T00:00:00Z' }))
      .toMatchObject({ stage: 'READY', since: '2026-10-02T02:00:00Z' });
  });

  it('orders by time whatever the input order, and ignores events after now', () => {
    const events = [stage('2026-10-02T03:00:00Z', 'UNASSIGNED'), stage('2026-10-02T01:00:00Z', 'READY'), done('2026-10-09T00:00:00Z')];
    expect(projectLedgerStage({ events, windows: [], now: '2026-10-06T00:00:00Z' }).stage).toBe('UNASSIGNED');
  });

  it('lets a teacher move a completed student back to any stage', () => {
    const events = [stage('2026-10-02T01:00:00Z', 'READY'), done('2026-10-02T02:00:00Z'), stage('2026-10-02T03:00:00Z', 'PENDING')];
    expect(projectLedgerStage({ events, windows: [], now: '2026-10-06T00:00:00Z' }))
      .toMatchObject({ stage: 'PENDING', since: '2026-10-02T03:00:00Z', lastCompletionAt: null });
  });

  it('returns to the stage before the completion when the reward is cancelled', () => {
    const events = [stage('2026-10-02T01:00:00Z', 'READY'), done('2026-10-02T02:00:00Z'), undone('2026-10-02T03:00:00Z')];
    expect(projectLedgerStage({ events, windows: [], now: '2026-10-06T00:00:00Z' }))
      .toMatchObject({ stage: 'READY', since: '2026-10-02T01:00:00Z' });
  });

  it('resets everyone who has the task at the scheduled time, and nobody else', () => {
    const windows = [daily('READY')];
    const completed = [stage('2026-10-02T01:00:00Z', 'READY'), done('2026-10-02T02:00:00Z')];
    expect(projectLedgerStage({ events: completed, windows, now: '2026-10-02T23:59:00Z' }).stage).toBe('COMPLETED');
    expect(projectLedgerStage({ events: completed, windows, now: '2026-10-03T00:00:00Z' }))
      .toMatchObject({ stage: 'READY', since: '2026-10-03T00:00:00.000Z', byReset: true, lastCompletionAt: null });
    const unassigned = [stage('2026-10-02T01:00:00Z', 'READY'), stage('2026-10-02T02:00:00Z', 'UNASSIGNED')];
    expect(projectLedgerStage({ events: unassigned, windows, now: '2026-10-05T00:00:00Z' }).stage).toBe('UNASSIGNED');
  });

  it('resets to 미부여 and then stays 미부여', () => {
    const events = [stage('2026-10-02T01:00:00Z', 'PENDING')];
    expect(projectLedgerStage({ events, windows: [daily('UNASSIGNED')], now: '2026-10-09T00:00:00Z' }))
      .toMatchObject({ stage: 'UNASSIGNED', since: '2026-10-03T00:00:00.000Z' });
  });

  it('keeps an event made after the latest reset', () => {
    const events = [stage('2026-10-02T01:00:00Z', 'READY'), done('2026-10-03T05:00:00Z')];
    expect(projectLedgerStage({ events, windows: [daily('READY')], now: '2026-10-03T23:00:00Z' }).stage).toBe('COMPLETED');
  });

  it('applies each schedule only in its own time window', () => {
    const windows = [daily(null, '2026-10-01T00:00:00Z', '2026-10-04T12:00:00Z'), daily('PENDING', '2026-10-04T12:00:00Z')];
    const events = [stage('2026-10-02T01:00:00Z', 'READY'), done('2026-10-02T02:00:00Z')];
    expect(projectLedgerStage({ events, windows, now: '2026-10-04T23:00:00Z' }).stage).toBe('COMPLETED');
    expect(projectLedgerStage({ events, windows, now: '2026-10-05T00:00:00Z' }))
      .toMatchObject({ stage: 'PENDING', since: '2026-10-05T00:00:00.000Z' });
  });
});

describe('reset times', () => {
  it('names the next and the latest reset', () => {
    const windows = [daily('READY')];
    expect(nextResetAt(windows, '2026-10-05T10:00:00Z')).toBe('2026-10-06T00:00:00.000Z');
    expect(lastResetAt(windows, '2026-10-05T10:00:00Z')).toBe('2026-10-05T00:00:00.000Z');
    expect(nextResetAt([daily(null)], '2026-10-05T10:00:00Z')).toBeNull();
    expect(lastResetAt([daily('READY', '2026-10-05T03:00:00Z')], '2026-10-05T10:00:00Z')).toBeNull();
  });
});

describe('repeat settings', () => {
  it('reads the reset stage of schedules written before stages existed', () => {
    const base = { ruleVersion: 1, effectiveFrom: '2026-10-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY' as const, time: '09:00' } };
    expect(storedResetStage({ ...base, resetAssignmentOnCycle: true, resetCompletionOnCycle: true })).toBe('UNASSIGNED');
    expect(storedResetStage({ ...base, resetAssignmentOnCycle: false, resetCompletionOnCycle: true })).toBe('READY');
    expect(storedResetStage({ ...base, resetAssignmentOnCycle: false, resetCompletionOnCycle: false })).toBeNull();
    expect(storedResetStage({ ...base, recurrence: { type: 'NONE' }, resetAssignmentOnCycle: true, resetCompletionOnCycle: true })).toBeNull();
  });

  it('stores a new setting from the edit time, with coherent legacy flags', () => {
    const created = initialSchedule({ recurrence: { type: 'NONE' }, resetStage: null }, '2026-10-01T00:00:00Z');
    expect(created).toMatchObject({ ruleVersion: 1, effectiveFrom: '2026-10-01T00:00:00.000Z', resetStage: null });
    const edited = scheduleForRepeat(created, { recurrence: { type: 'WEEKLY', weekdays: [5, 1], time: '08:30' }, resetStage: 'PENDING' }, '2026-10-06T01:02:03Z');
    expect(edited).toMatchObject({ ruleVersion: 2, effectiveFrom: '2026-10-06T01:02:03.000Z', resetStage: 'PENDING',
      recurrence: { type: 'WEEKLY', weekdays: [1, 5], time: '08:30' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: true });
    expect(resetWindowsOf(edited, null)).toEqual([{ recurrence: edited.recurrence, timeZone: 'Asia/Seoul', resetStage: 'PENDING',
      from: '2026-10-06T01:02:03.000Z', until: null }]);
  });
});

describe('ledgerTimeline', () => {
  it('lists every change with the automatic resets in between, but not before the ledger start', () => {
    const events = [stage('2026-10-02T01:00:00Z', 'READY'), done('2026-10-02T02:00:00Z'), done('2026-10-04T02:00:00Z')];
    const steps = ledgerTimeline({ events, windows: [daily('READY')], now: '2026-10-05T12:00:00Z', resetsFrom: '2026-10-01T00:00:00Z' });
    expect(steps.map((step) => [step.event ? step.event.kind : 'RESET', step.at, step.previousStage, step.stage])).toEqual([
      ['STAGE', '2026-10-02T01:00:00Z', 'UNASSIGNED', 'READY'],
      ['COMPLETED', '2026-10-02T02:00:00Z', 'READY', 'COMPLETED'],
      ['RESET', '2026-10-03T00:00:00.000Z', 'COMPLETED', 'READY'],
      ['COMPLETED', '2026-10-04T02:00:00Z', 'READY', 'COMPLETED'],
      ['RESET', '2026-10-05T00:00:00.000Z', 'COMPLETED', 'READY'],
    ]);
    expect(ledgerTimeline({ events, windows: [daily('READY')], now: '2026-10-05T12:00:00Z', resetsFrom: '2026-10-09T00:00:00Z' })
      .filter((step) => step.event === null)).toEqual([]);
  });
});
