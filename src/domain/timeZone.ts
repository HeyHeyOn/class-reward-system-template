import { Temporal } from '@js-temporal/polyfill';

const FIXED_OFFSET_TIME_ZONE = /^[+-]\d{2}(?::?\d{2})?$/;

/** Accepts named time zones supported by Temporal and rejects numeric fixed offsets. */
export function isValidNamedTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timeZone = value.trim();
  if (!timeZone || FIXED_OFFSET_TIME_ZONE.test(timeZone)) return false;
  try {
    Temporal.ZonedDateTime.from({
      timeZone,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    });
    return true;
  } catch {
    return false;
  }
}
