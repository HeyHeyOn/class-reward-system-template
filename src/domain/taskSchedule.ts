import { Temporal } from '@js-temporal/polyfill';
import { isValidNamedTimeZone } from './timeZone';
import type { DayOfMonth, IsoWeekday, TaskRecurrence, TaskSchedule, TaskScheduleReadWarning } from './types';

export const DEFAULT_CLASS_TIME_ZONE = 'Asia/Seoul';
export const LEGACY_TASK_INSTANT = '1970-01-01T00:00:00.000Z';

export type VersionedTaskSchedule = {
  taskInstanceId: string;
  currentSchedule: TaskSchedule;
  pendingSchedule: TaskSchedule | null;
  readWarnings?: TaskScheduleReadWarning[];
};

export type TaskScheduleCells = Record<string, string>;

export class TaskScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskScheduleValidationError';
  }
}

export function normalizeLegacyTimeZone(value: unknown): string {
  return isValidNamedTimeZone(value) ? value.trim() : DEFAULT_CLASS_TIME_ZONE;
}

export function validateTaskSchedule(value: unknown): TaskSchedule {
  if (!value || typeof value !== 'object') throw new TaskScheduleValidationError('schedule must be an object');
  const schedule = value as TaskSchedule;
  if (!Number.isInteger(schedule.ruleVersion) || schedule.ruleVersion < 1) {
    throw new TaskScheduleValidationError('ruleVersion must be a positive integer');
  }
  const effectiveFrom = canonicalInstant(schedule.effectiveFrom, 'effectiveFrom');
  if (!isValidNamedTimeZone(schedule.timeZone)) {
    throw new TaskScheduleValidationError('timeZone must be a valid named IANA time zone');
  }
  if (typeof schedule.resetCompletionOnCycle !== 'boolean' || typeof schedule.resetAssignmentOnCycle !== 'boolean') {
    throw new TaskScheduleValidationError('reset flags must be boolean');
  }
  validateRecurrence(schedule.recurrence);
  const recurrence = schedule.recurrence.type === 'WEEKLY'
    ? { ...schedule.recurrence, weekdays: [...schedule.recurrence.weekdays].sort((a, b) => a - b) }
    : schedule.recurrence;
  return { ...schedule, recurrence, effectiveFrom, timeZone: schedule.timeZone.trim() };
}

export function parseTaskScheduleCells(
  cells: Readonly<Record<string, string | undefined>>,
  legacy: { taskId: string; createdAt?: string; classTimeZone?: string },
): VersionedTaskSchedule {
  const normalizedCreatedAt = normalizeLegacyInstant(legacy.createdAt);
  const legacySchedule: TaskSchedule = {
    ruleVersion: 1,
    effectiveFrom: normalizedCreatedAt,
    timeZone: normalizeLegacyTimeZone(legacy.classTimeZone),
    recurrence: { type: 'NONE' },
    resetCompletionOnCycle: false,
    resetAssignmentOnCycle: false,
  };
  const taskInstanceId = cells.taskInstanceId?.trim()
    || `legacy:${legacy.taskId}:${normalizedCreatedAt}`;

  const hasCurrentSchedule = hasPopulatedCell(cells, CURRENT_SCHEDULE_FIELDS)
    || Boolean(cells.taskInstanceId?.trim());
  const hasPendingSchedule = hasPopulatedCell(cells, PENDING_SCHEDULE_FIELDS);
  const parsedCurrent = hasCurrentSchedule ? safeParseSchedule(cells, '') : null;
  const parsedPending = hasPendingSchedule ? safeParseSchedule(cells, 'pending') : null;
  const readWarnings: TaskScheduleReadWarning[] = [];
  if (hasCurrentSchedule && !parsedCurrent) readWarnings.push('INVALID_CURRENT_SCHEDULE');
  if (hasPendingSchedule && !parsedPending) readWarnings.push('INVALID_PENDING_SCHEDULE');
  return {
    taskInstanceId,
    currentSchedule: parsedCurrent ?? legacySchedule,
    pendingSchedule: parsedPending,
    ...(readWarnings.length > 0 ? { readWarnings } : {}),
  };
}

export function serializeTaskScheduleCells(state: VersionedTaskSchedule): TaskScheduleCells {
  if (state.readWarnings?.length) {
    throw new TaskScheduleValidationError('cannot serialize a schedule produced from malformed persisted cells');
  }
  if (!state.taskInstanceId.trim()) throw new TaskScheduleValidationError('taskInstanceId is required');
  const currentSchedule = validateTaskSchedule(state.currentSchedule);
  const pendingSchedule = state.pendingSchedule ? validateTaskSchedule(state.pendingSchedule) : null;
  return {
    taskInstanceId: state.taskInstanceId.trim(),
    ...scheduleToCells(currentSchedule, ''),
    ...scheduleToCells(pendingSchedule, 'pending'),
  };
}

export function resolveTaskSchedule({ currentSchedule, pendingSchedule, now }: {
  currentSchedule: TaskSchedule;
  pendingSchedule: TaskSchedule | null;
  now: string;
}): TaskSchedule {
  validateTaskSchedule(currentSchedule);
  if (!pendingSchedule) return currentSchedule;
  validateTaskSchedule(pendingSchedule);
  const nowInstant = parseInstant(now, 'now');
  const pendingInstant = parseInstant(pendingSchedule.effectiveFrom, 'pendingEffectiveFrom');
  return Temporal.Instant.compare(nowInstant, pendingInstant) >= 0 ? pendingSchedule : currentSchedule;
}

export function promotePendingTaskSchedule(state: VersionedTaskSchedule): VersionedTaskSchedule {
  if (!state.pendingSchedule) return { ...state };
  validateTaskSchedule(state.pendingSchedule);
  return { ...state, currentSchedule: state.pendingSchedule, pendingSchedule: null };
}

export function prepareTaskScheduleEdit(input: {
  currentSchedule: TaskSchedule;
  recurrence: TaskRecurrence;
  timeZone: string;
  resetCompletionOnCycle: boolean;
  resetAssignmentOnCycle: boolean;
  editedAt: string;
}): TaskSchedule {
  validateTaskSchedule(input.currentSchedule);
  const candidate = validateTaskSchedule({
    ...input.currentSchedule,
    timeZone: input.timeZone,
    recurrence: input.recurrence,
    resetCompletionOnCycle: input.resetCompletionOnCycle,
    resetAssignmentOnCycle: input.resetAssignmentOnCycle,
  });

  if (
    (input.currentSchedule.recurrence.type === 'NONE' && candidate.recurrence.type === 'NONE')
    || (input.currentSchedule.timeZone === candidate.timeZone
      && recurrencesEqual(input.currentSchedule.recurrence, candidate.recurrence))
  ) {
    return candidate;
  }

  const effectiveFrom = canonicalInstant(input.editedAt, 'editedAt');
  return validateTaskSchedule({
    ...candidate,
    ruleVersion: input.currentSchedule.ruleVersion + 1,
    effectiveFrom,
  });
}

function recurrencesEqual(left: TaskRecurrence, right: TaskRecurrence): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'NONE' || right.type === 'NONE') return true;
  if (left.time !== right.time) return false;
  if (left.type === 'DAILY' || right.type === 'DAILY') return true;
  if (left.type === 'WEEKLY' && right.type === 'WEEKLY') return left.weekdays.join(',') === right.weekdays.join(',');
  return left.type === 'MONTHLY' && right.type === 'MONTHLY' && left.dayOfMonth === right.dayOfMonth;
}

function safeParseSchedule(
  cells: Readonly<Record<string, string | undefined>>,
  prefix: '' | 'pending',
): TaskSchedule | null {
  try {
    return validateTaskSchedule(scheduleFromCells(cells, prefix));
  } catch {
    return null;
  }
}

const CURRENT_SCHEDULE_FIELDS = [
  'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType', 'recurrenceTime',
  'recurrenceWeekday', 'recurrenceWeekdays', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
] as const;

const PENDING_SCHEDULE_FIELDS = [
  'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType',
  'pendingRecurrenceTime', 'pendingRecurrenceWeekday', 'pendingRecurrenceWeekdays', 'pendingRecurrenceDayOfMonth',
  'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
] as const;

function hasPopulatedCell(
  cells: Readonly<Record<string, string | undefined>>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => Boolean(cells[field]?.trim()));
}

function scheduleFromCells(cells: Readonly<Record<string, string | undefined>>, prefix: '' | 'pending'): TaskSchedule {
  const names = prefix === 'pending'
    ? {
        ruleVersion: 'pendingRuleVersion', effectiveFrom: 'pendingEffectiveFrom', timeZone: 'pendingTimeZone',
        recurrenceType: 'pendingRecurrenceType', recurrenceTime: 'pendingRecurrenceTime',
        recurrenceWeekday: 'pendingRecurrenceWeekday', recurrenceWeekdays: 'pendingRecurrenceWeekdays', recurrenceDayOfMonth: 'pendingRecurrenceDayOfMonth',
        resetCompletion: 'pendingResetCompletionOnCycle', resetAssignment: 'pendingResetAssignmentOnCycle',
      }
    : {
        ruleVersion: 'ruleVersion', effectiveFrom: 'scheduleEffectiveFrom', timeZone: 'recurrenceTimeZone',
        recurrenceType: 'recurrenceType', recurrenceTime: 'recurrenceTime', recurrenceWeekday: 'recurrenceWeekday', recurrenceWeekdays: 'recurrenceWeekdays',
        recurrenceDayOfMonth: 'recurrenceDayOfMonth', resetCompletion: 'resetCompletionOnCycle',
        resetAssignment: 'resetAssignmentOnCycle',
      };
  return {
    ruleVersion: Number(cells[names.ruleVersion]),
    effectiveFrom: cells[names.effectiveFrom]?.trim() ?? '',
    timeZone: cells[names.timeZone]?.trim() ?? '',
    recurrence: recurrenceFromCells(cells, names),
    resetCompletionOnCycle: parseStrictBoolean(cells[names.resetCompletion]),
    resetAssignmentOnCycle: parseStrictBoolean(cells[names.resetAssignment]),
  };
}

function recurrenceFromCells(
  cells: Readonly<Record<string, string | undefined>>,
  names: { recurrenceType: string; recurrenceTime: string; recurrenceWeekday: string; recurrenceWeekdays: string; recurrenceDayOfMonth: string },
): TaskRecurrence {
  const type = cells[names.recurrenceType]?.trim();
  if (type === 'NONE') return { type: 'NONE' };
  if (type === 'DAILY') return { type, time: cells[names.recurrenceTime]?.trim() ?? '' };
  if (type === 'WEEKLY') {
    const multi = cells[names.recurrenceWeekdays]?.trim();
    const source = multi || cells[names.recurrenceWeekday]?.trim() || '';
    return { type, time: cells[names.recurrenceTime]?.trim() ?? '', weekdays: source.split(',').filter(Boolean).map(Number).sort((a, b) => a - b) as IsoWeekday[] };
  }
  if (type === 'MONTHLY') return {
    type, time: cells[names.recurrenceTime]?.trim() ?? '', dayOfMonth: Number(cells[names.recurrenceDayOfMonth]) as DayOfMonth,
  };
  return { type: type as 'NONE' };
}

function scheduleToCells(schedule: TaskSchedule | null, prefix: '' | 'pending'): TaskScheduleCells {
  const p = prefix;
  const names = p === 'pending'
    ? ['pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime', 'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle', 'pendingRecurrenceWeekdays']
    : ['ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType', 'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle', 'recurrenceWeekdays'];
  if (!schedule) return Object.fromEntries(names.map((name) => [name, '']));
  const recurrence = schedule.recurrence;
  return {
    [names[0]]: String(schedule.ruleVersion),
    [names[1]]: schedule.effectiveFrom,
    [names[2]]: schedule.timeZone,
    [names[3]]: recurrence.type,
    [names[4]]: recurrence.type === 'NONE' ? '' : recurrence.time,
    [names[5]]: recurrence.type === 'WEEKLY' && recurrence.weekdays.length === 1 ? String(recurrence.weekdays[0]) : '',
    [names[6]]: recurrence.type === 'MONTHLY' ? String(recurrence.dayOfMonth) : '',
    [names[7]]: schedule.resetCompletionOnCycle ? 'TRUE' : 'FALSE',
    [names[8]]: schedule.resetAssignmentOnCycle ? 'TRUE' : 'FALSE',
    [names[9]]: recurrence.type === 'WEEKLY' ? recurrence.weekdays.join(',') : '',
  };
}

function validateRecurrence(recurrence: TaskRecurrence): void {
  if (!recurrence || typeof recurrence !== 'object') throw new TaskScheduleValidationError('recurrence must be an object');
  if (recurrence.type === 'NONE') return;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(recurrence.time)) {
    throw new TaskScheduleValidationError('recurrence time must use valid HH:mm');
  }
  if (recurrence.type === 'DAILY') return;
  if (recurrence.type === 'WEEKLY') {
    if (!Array.isArray(recurrence.weekdays) || recurrence.weekdays.length === 0
      || recurrence.weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)
      || new Set(recurrence.weekdays).size !== recurrence.weekdays.length) {
      throw new TaskScheduleValidationError('weekdays must contain unique values from 1 to 7');
    }
    return;
  }
  if (recurrence.type === 'MONTHLY') {
    if (!Number.isInteger(recurrence.dayOfMonth) || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31) {
      throw new TaskScheduleValidationError('dayOfMonth must be from 1 to 31');
    }
    return;
  }
  throw new TaskScheduleValidationError('recurrence type is not supported');
}

function parseStrictBoolean(value: string | undefined): boolean {
  if (/^(true|1)$/i.test(value?.trim() ?? '')) return true;
  if (/^(false|0)$/i.test(value?.trim() ?? '')) return false;
  throw new TaskScheduleValidationError('reset flags must be boolean');
}

function parseInstant(value: unknown, field: string): Temporal.Instant {
  try {
    return Temporal.Instant.from(String(value ?? ''));
  } catch {
    throw new TaskScheduleValidationError(`${field} must be an ISO instant`);
  }
}

function canonicalInstant(value: unknown, field: string): string {
  return parseInstant(value, field).toString({ smallestUnit: 'millisecond' });
}

function normalizeLegacyInstant(value: unknown): string {
  try {
    return canonicalInstant(value, 'legacy instant');
  } catch {
    return LEGACY_TASK_INSTANT;
  }
}
