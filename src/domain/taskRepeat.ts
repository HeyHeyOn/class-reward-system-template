import { isTaskStage, type ResetWindow } from './taskLedger';
import { validateTaskSchedule } from './taskSchedule';
import type { TaskStage } from './taskStage';
import type { TaskRecurrence, TaskSchedule } from './types';

/** What a teacher sets for a repeating task: when it resets and which stage it resets to. */
export type TaskRepeatSetting = Readonly<{
  recurrence: TaskRecurrence;
  /** The stage every student who has the task moves to at each reset; null = never reset. */
  resetStage: TaskStage | null;
}>;

/** A stored schedule; `resetStage` is absent on schedules written before stages existed. */
export type StoredTaskSchedule = TaskSchedule & { resetStage?: unknown };

/**
 * The reset stage of a stored schedule. Schedules from before stages existed carry only the two
 * reset flags: resetting assignments empties the task (미부여); resetting only completions lets
 * the students who have it complete it again (완료 가능).
 */
export function storedResetStage(schedule: StoredTaskSchedule): TaskStage | null {
  if (schedule.recurrence.type === 'NONE') return null;
  if (Object.hasOwn(schedule, 'resetStage')) return isTaskStage(schedule.resetStage) ? schedule.resetStage : null;
  if (schedule.resetAssignmentOnCycle) return 'UNASSIGNED';
  if (schedule.resetCompletionOnCycle) return 'READY';
  return null;
}

export function repeatSettingOf(schedule: StoredTaskSchedule): TaskRepeatSetting {
  return { recurrence: schedule.recurrence, resetStage: storedResetStage(schedule) };
}

/** The schedules in force over time: the current one, then a pending one from its start. */
export function resetWindowsOf(current: StoredTaskSchedule, pending: StoredTaskSchedule | null): ResetWindow[] {
  const windows: ResetWindow[] = [];
  const pendingFrom = pending ? pending.effectiveFrom : null;
  windows.push({ recurrence: current.recurrence, timeZone: current.timeZone, resetStage: storedResetStage(current),
    from: current.effectiveFrom, until: pendingFrom });
  if (pending) {
    windows.push({ recurrence: pending.recurrence, timeZone: pending.timeZone, resetStage: storedResetStage(pending),
      from: pending.effectiveFrom, until: null });
  }
  return windows;
}

/** The schedule that is in force at `now`. */
export function scheduleInForce(current: StoredTaskSchedule, pending: StoredTaskSchedule | null, now: string): StoredTaskSchedule {
  if (pending && Date.parse(pending.effectiveFrom) <= Date.parse(now)) return pending;
  return current;
}

export function sameRepeatSetting(left: TaskRepeatSetting, right: TaskRepeatSetting): boolean {
  return left.resetStage === right.resetStage && JSON.stringify(normalizeRecurrence(left.recurrence))
    === JSON.stringify(normalizeRecurrence(right.recurrence));
}

/**
 * The schedule to store for a new repeat setting. It takes effect at `editedAt`; resets before
 * that were already applied by the caller (see the repeat command), so the old rule is dropped.
 */
export function scheduleForRepeat(current: StoredTaskSchedule, setting: TaskRepeatSetting, editedAt: string): StoredTaskSchedule {
  const resetStage = setting.recurrence.type === 'NONE' ? null : setting.resetStage;
  const candidate = validateTaskSchedule({
    ruleVersion: current.ruleVersion + 1,
    effectiveFrom: new Date(editedAt).toISOString(),
    timeZone: 'Asia/Seoul',
    recurrence: normalizeRecurrence(setting.recurrence),
    // Kept coherent for readers of the two legacy flags.
    resetAssignmentOnCycle: resetStage === 'UNASSIGNED',
    resetCompletionOnCycle: resetStage !== null && resetStage !== 'COMPLETED',
  });
  return { ...candidate, resetStage };
}

/** The schedule of a new task. */
export function initialSchedule(setting: TaskRepeatSetting, createdAt: string): StoredTaskSchedule {
  return scheduleForRepeat({ ruleVersion: 0, effectiveFrom: createdAt, timeZone: 'Asia/Seoul',
    recurrence: { type: 'NONE' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false }, setting, createdAt);
}

function normalizeRecurrence(recurrence: TaskRecurrence): TaskRecurrence {
  if (recurrence.type === 'WEEKLY') return { type: 'WEEKLY', weekdays: [...recurrence.weekdays].sort((a, b) => a - b), time: recurrence.time };
  if (recurrence.type === 'DAILY') return { type: 'DAILY', time: recurrence.time };
  if (recurrence.type === 'MONTHLY') return { type: 'MONTHLY', dayOfMonth: recurrence.dayOfMonth, time: recurrence.time };
  return { type: 'NONE' };
}
