import { Temporal } from '@js-temporal/polyfill';
import { BudgetExceededError, BudgetUnavailableError, trimBudgetString, type BudgetContext } from '@/lib/boundedWork';

const FIXED_OFFSET_TIME_ZONE = /^[+-]\d{2}(?::?\d{2})?$/;

/** Accepts named time zones supported by Temporal and rejects numeric fixed offsets. */
export function isValidNamedTimeZone(value: unknown, budget?: BudgetContext): value is string {
  budget?.spend();
  if (typeof value !== 'string') return false;
  const timeZone = trimBudgetString(value, budget);
  if (!timeZone) return false;
  budget?.spend(1 + Math.ceil(timeZone.length / 256));
  const fixedOffset = FIXED_OFFSET_TIME_ZONE.test(timeZone);
  budget?.check();
  if (fixedOffset) return false;
  try {
    // Closed six-field Temporal argument, five numeric scalar occurrences,
    // one opaque logical library result and the returned boolean. The string is
    // shared with the reserved trim result; library-internal heap is not metered.
    budget?.reserve({ nodes: 8, slots: 6, structuralBytes: 16 + 24 + 30 + 20 + 16 + 4 });
    budget?.spend(1 + Math.ceil(timeZone.length / 256));
    Temporal.ZonedDateTime.from({
      timeZone,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    });
    budget?.check();
    return true;
  } catch (error) {
    if (budget) {
      if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
      budget.check();
    }
    return false;
  }
}
