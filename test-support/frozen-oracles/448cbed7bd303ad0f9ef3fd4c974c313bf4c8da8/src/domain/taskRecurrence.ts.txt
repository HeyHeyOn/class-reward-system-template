import { Temporal } from '@js-temporal/polyfill';
import { isValidNamedTimeZone } from './timeZone';
import type { TaskRecurrence, TaskSchedule } from './types';

export type TaskCycle = {
  cycleId: string;
  startsAt: string;
  endsAt: string | null;
  nextResetAt: string | null;
};

export class TaskRecurrenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskRecurrenceValidationError';
  }
}

type RecurringTaskRecurrence = Exclude<TaskRecurrence, { type: 'NONE' }>;

export function getTaskCycle({
  taskInstanceId,
  schedule,
  taskCreatedAt,
  now,
}: {
  taskInstanceId: string;
  schedule: TaskSchedule;
  taskCreatedAt?: string;
  now: string;
}): TaskCycle {
  schedule = validateSchedule(schedule);
  const nowInstant = parseRequiredInstant(now, 'now');
  const effectiveFrom = parseRequiredInstant(schedule.effectiveFrom, 'effectiveFrom');
  if (Temporal.Instant.compare(nowInstant, effectiveFrom) < 0) {
    throw new TaskRecurrenceValidationError('now must not be before effectiveFrom');
  }

  if (schedule.recurrence.type === 'NONE') {
    const createdAt = parseOptionalInstant(taskCreatedAt)
      ?? Temporal.Instant.fromEpochMilliseconds(0);
    const startsAt = (Temporal.Instant.compare(createdAt, effectiveFrom) >= 0 ? createdAt : effectiveFrom).toString();
    return makeCycle(taskInstanceId, schedule.ruleVersion, startsAt, null);
  }

  const boundaries = naturalBoundariesAround(
    schedule.recurrence,
    schedule.timeZone,
    nowInstant,
  );
  const naturalStart = latestAtOrBefore(boundaries, nowInstant);
  const naturalEnd = earliestAfter(boundaries, nowInstant);
  const startsAt = Temporal.Instant.compare(naturalStart, effectiveFrom) < 0
    ? effectiveFrom.toString()
    : naturalStart.toString();
  const endsAt = naturalEnd.toString();

  return makeCycle(taskInstanceId, schedule.ruleVersion, startsAt, endsAt);
}

export function getNextNaturalTaskBoundary({
  recurrence,
  timeZone,
  after,
}: {
  recurrence: TaskRecurrence;
  timeZone: string;
  after: string;
}): string {
  timeZone = validateTimeZone(timeZone);
  validateRecurrence(recurrence);
  if (recurrence.type === 'NONE') {
    throw new TaskRecurrenceValidationError('NONE has no natural boundary');
  }
  const afterInstant = parseRequiredInstant(after, 'after');
  return earliestAfter(
    naturalBoundariesAround(recurrence, timeZone, afterInstant),
    afterInstant,
  ).toString();
}

function makeCycle(
  taskInstanceId: string,
  ruleVersion: number,
  startsAt: string,
  endsAt: string | null,
): TaskCycle {
  return {
    cycleId: `v1|${taskInstanceId}|r${ruleVersion}|${startsAt}`,
    startsAt,
    endsAt,
    nextResetAt: endsAt,
  };
}

function validateSchedule(schedule: TaskSchedule): TaskSchedule {
  if (!Number.isInteger(schedule.ruleVersion) || schedule.ruleVersion < 1) {
    throw new TaskRecurrenceValidationError('ruleVersion must be a positive integer');
  }
  parseRequiredInstant(schedule.effectiveFrom, 'effectiveFrom');
  const timeZone = validateTimeZone(schedule.timeZone);
  validateRecurrence(schedule.recurrence);
  return { ...schedule, timeZone };
}

function validateRecurrence(recurrence: TaskRecurrence): void {
  if (typeof recurrence !== 'object' || recurrence === null) {
    throw new TaskRecurrenceValidationError('recurrence must be an object');
  }

  switch (recurrence.type) {
    case 'NONE':
      return;
    case 'DAILY':
      parseTime(recurrence.time);
      return;
    case 'WEEKLY':
      parseTime(recurrence.time);
      if (!Array.isArray(recurrence.weekdays) || recurrence.weekdays.length === 0
        || recurrence.weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)
        || new Set(recurrence.weekdays).size !== recurrence.weekdays.length) {
        throw new TaskRecurrenceValidationError('weekdays must contain unique ISO weekdays from 1 to 7');
      }
      return;
    case 'MONTHLY':
      parseTime(recurrence.time);
      if (!Number.isInteger(recurrence.dayOfMonth)
        || recurrence.dayOfMonth < 1
        || recurrence.dayOfMonth > 31) {
        throw new TaskRecurrenceValidationError('dayOfMonth must be from 1 to 31');
      }
      return;
    default:
      throw new TaskRecurrenceValidationError('recurrence type is not supported');
  }
}

function validateTimeZone(timeZone: string): string {
  if (!isValidNamedTimeZone(timeZone)) {
    throw new TaskRecurrenceValidationError('timeZone must be a valid IANA time zone');
  }
  return timeZone.trim();
}

function parseTime(time: string): { hour: number; minute: number } {
  if (typeof time !== 'string') {
    throw new TaskRecurrenceValidationError('time must use HH:mm');
  }
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new TaskRecurrenceValidationError('time must use HH:mm');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new TaskRecurrenceValidationError('time must use a valid HH:mm value');
  }
  return { hour, minute };
}

function parseRequiredInstant(value: string, field: string): Temporal.Instant {
  try {
    return Temporal.Instant.from(value);
  } catch {
    throw new TaskRecurrenceValidationError(`${field} must be an ISO instant`);
  }
}

function parseOptionalInstant(value?: string): Temporal.Instant | null {
  if (!value) return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
}

function naturalBoundariesAround(
  recurrence: RecurringTaskRecurrence,
  timeZone: string,
  instant: Temporal.Instant,
): Temporal.Instant[] {
  const localDate = instant.toZonedDateTimeISO(timeZone).toPlainDate();
  const { hour, minute } = parseTime(recurrence.time);
  const dates: Temporal.PlainDate[] = [];

  if (recurrence.type === 'DAILY') {
    for (let offset = -2; offset <= 2; offset += 1) {
      dates.push(localDate.add({ days: offset }));
    }
  } else if (recurrence.type === 'WEEKLY') {
    for (let offset = -14; offset <= 14; offset += 1) {
      const date = localDate.add({ days: offset });
      if (recurrence.weekdays.includes(date.dayOfWeek as never)) dates.push(date);
    }
  } else {
    const monthStart = localDate.with({ day: 1 });
    for (let offset = -2; offset <= 2; offset += 1) {
      const targetMonth = monthStart.add({ months: offset });
      dates.push(targetMonth.with({
        day: Math.min(recurrence.dayOfMonth, targetMonth.daysInMonth),
      }));
    }
  }

  return dates.map((date) => Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour,
    minute,
  }, { disambiguation: 'compatible' }).toInstant());
}

function latestAtOrBefore(boundaries: Temporal.Instant[], target: Temporal.Instant): Temporal.Instant {
  const matching = boundaries.filter((boundary) => Temporal.Instant.compare(boundary, target) <= 0);
  if (matching.length === 0) throw new TaskRecurrenceValidationError('could not resolve cycle start');
  return matching.reduce((latest, boundary) =>
    Temporal.Instant.compare(boundary, latest) > 0 ? boundary : latest);
}

function earliestAfter(boundaries: Temporal.Instant[], target: Temporal.Instant): Temporal.Instant {
  const matching = boundaries.filter((boundary) => Temporal.Instant.compare(boundary, target) > 0);
  if (matching.length === 0) throw new TaskRecurrenceValidationError('could not resolve cycle end');
  return matching.reduce((earliest, boundary) =>
    Temporal.Instant.compare(boundary, earliest) < 0 ? boundary : earliest);
}