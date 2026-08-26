import { DEFAULT_CLASS_TIME_ZONE, validateTaskSchedule } from '@/domain/taskSchedule';
import type { TaskRecurrence } from '@/domain/types';
import type { TaskScheduleEdit } from '@/server/sheetsRepository';

const SCHEDULE_KEYS = new Set([
  'recurrence', 'timeZone', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
]);

export function parseOptionalTaskScheduleEdit(value: unknown): TaskScheduleEdit | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schedule must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== SCHEDULE_KEYS.size || Object.keys(input).some((key) => !SCHEDULE_KEYS.has(key))) {
    throw new Error('schedule contains unsupported or missing fields');
  }
  const recurrence = parseRecurrence(input.recurrence);
  const candidate = validateTaskSchedule({
    ruleVersion: 1,
    effectiveFrom: '1970-01-01T00:00:00.000Z',
    recurrence,
    // Keep accepting the legacy exact payload shape, but the class policy is
    // authoritative: every newly written schedule uses Seoul.
    timeZone: DEFAULT_CLASS_TIME_ZONE,
    resetCompletionOnCycle: input.resetCompletionOnCycle,
    resetAssignmentOnCycle: input.resetAssignmentOnCycle,
  });
  return {
    recurrence: candidate.recurrence,
    timeZone: candidate.timeZone,
    resetCompletionOnCycle: candidate.resetCompletionOnCycle,
    resetAssignmentOnCycle: candidate.resetAssignmentOnCycle,
  };
}

function parseRecurrence(value: unknown): TaskRecurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recurrence must be an object');
  const input = value as Record<string, unknown>;
  const type = input.type;
  const allowed = type === 'NONE'
    ? ['type']
    : type === 'DAILY'
      ? ['type', 'time']
      : type === 'WEEKLY'
        ? ['type', 'time', 'weekday']
        : type === 'MONTHLY'
          ? ['type', 'time', 'dayOfMonth']
          : [];
  if (allowed.length === 0 || Object.keys(input).length !== allowed.length || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error('recurrence contains unsupported or missing fields');
  }
  return input as TaskRecurrence;
}
