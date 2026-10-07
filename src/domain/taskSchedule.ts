import { Temporal } from '@js-temporal/polyfill';
import { isValidNamedTimeZone } from './timeZone';
import { BudgetExceededError, BudgetUnavailableError, equalBudgetValue, splitBudgetString, stableBudgetSort, trimBudgetString, utf8ByteLength, type BudgetContext } from '@/lib/boundedWork';
import { createBoundedScheduleResult, registeredBoundedKeys } from '@/lib/boundedJson';
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

export function normalizeLegacyTimeZone(value: unknown, budget?: BudgetContext): string {
  return isValidNamedTimeZone(value, budget) ? trimBudgetString(value, budget) : DEFAULT_CLASS_TIME_ZONE;
}

export function validateTaskSchedule(value: unknown, budget?: BudgetContext): TaskSchedule {
  if (budget && value && typeof value === 'object') registeredBoundedKeys(value, budget);
  return validateSchedule(value, budget, false);
}

/** The only mutable input path is the immediately constructed, closed scheduleFromCells
 * recipe below. It never registers or exposes a mutable intermediate certificate. */
function validateSchedule(value: unknown, budget: BudgetContext | undefined, fromCells: boolean): TaskSchedule {
  // Fixed scalar checks: object branch, integer/range, and both boolean flags.
  budget?.spend(8);
  if (!value || typeof value !== 'object') throw new TaskScheduleValidationError('schedule must be an object');
  const schedule = value as TaskSchedule;
  if (!Number.isInteger(schedule.ruleVersion) || schedule.ruleVersion < 1) {
    throw new TaskScheduleValidationError('ruleVersion must be a positive integer');
  }
  const effectiveFrom = canonicalInstant(schedule.effectiveFrom, 'effectiveFrom', budget);
  if (!isValidNamedTimeZone(schedule.timeZone, budget)) {
    throw new TaskScheduleValidationError('timeZone must be a valid named IANA time zone');
  }
  if (typeof schedule.resetCompletionOnCycle !== 'boolean' || typeof schedule.resetAssignmentOnCycle !== 'boolean') {
    throw new TaskScheduleValidationError('reset flags must be boolean');
  }
  validateRecurrence(schedule.recurrence, budget);
  if (budget) {
    // External certified inputs are detached with the existing guarded clone;
    // this preserves arbitrary extras without certifying mutable outputs.
    // Internal cells have exactly the closed schema, reserved before the spread.
    if (fromCells) reserveScheduleRecord(budget);
    const result = fromCells ? { ...schedule } : createBoundedScheduleResult(() => schedule, budget) as TaskSchedule;
    if (equalBudgetValue(result.recurrence.type, 'WEEKLY', budget)) {
      if (fromCells) {
        reserveRecurrenceRecord(budget);
        result.recurrence = { ...result.recurrence };
      }
      const weekly = result.recurrence as Extract<TaskRecurrence, { type: 'WEEKLY' }>;
      weekly.weekdays = stableBudgetSort(weekly.weekdays, (a, b) => a - b, budget);
    }
    result.effectiveFrom = effectiveFrom;
    result.timeZone = trimBudgetString(schedule.timeZone, budget);
    budget.check();
    return result;
  }
  const recurrence = schedule.recurrence.type === 'WEEKLY'
    ? { ...schedule.recurrence, weekdays: [...schedule.recurrence.weekdays].sort((a, b) => a - b) }
    : schedule.recurrence;
  return { ...schedule, recurrence, effectiveFrom, timeZone: schedule.timeZone.trim() };
}

export function parseTaskScheduleCells(
  cells: Readonly<Record<string, string | undefined>>,
  legacy: { taskId: string; createdAt?: string; classTimeZone?: string },
  budget?: BudgetContext,
): VersionedTaskSchedule {
  if (budget) { registeredBoundedKeys(cells, budget); registeredBoundedKeys(legacy, budget); }
  const normalizedCreatedAt = normalizeLegacyInstant(legacy.createdAt, budget);
  reserveScheduleRecord(budget);
  reserveRecurrenceRecord(budget);
  const legacySchedule: TaskSchedule = {
    ruleVersion: 1,
    effectiveFrom: normalizedCreatedAt,
    timeZone: normalizeLegacyTimeZone(legacy.classTimeZone, budget),
    recurrence: { type: 'NONE' },
    resetCompletionOnCycle: false,
    resetAssignmentOnCycle: false,
  };
  const taskInstanceId = (budget ? trimCell(cells.taskInstanceId, budget) : cells.taskInstanceId?.trim())
    || legacyInstanceId(legacy.taskId, normalizedCreatedAt, budget);

  const hasCurrentSchedule = hasPopulatedCell(cells, CURRENT_SCHEDULE_FIELDS, budget)
    || Boolean(trimCell(cells.taskInstanceId, budget));
  const hasPendingSchedule = hasPopulatedCell(cells, PENDING_SCHEDULE_FIELDS, budget);
  const parsedCurrent = hasCurrentSchedule ? safeParseSchedule(cells, '', budget) : null;
  const parsedPending = hasPendingSchedule ? safeParseSchedule(cells, 'pending', budget) : null;
  // At most two warning scalar occurrences and two slots, before allocation.
  budget?.reserve({ nodes: 3, slots: 2, structuralBytes: 32 });
  const readWarnings: TaskScheduleReadWarning[] = [];
  budget?.spend(2);
  if (hasCurrentSchedule && !parsedCurrent) readWarnings.push('INVALID_CURRENT_SCHEDULE');
  if (hasPendingSchedule && !parsedPending) readWarnings.push('INVALID_PENDING_SCHEDULE');
  // Closed output plus optional one-field spread literal; references share payload.
  budget?.reserve({ nodes: 3, slots: 5, structuralBytes: 128 });
  budget?.spend();
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
  budget?: BudgetContext,
): TaskSchedule | null {
  try {
    return validateSchedule(scheduleFromCells(cells, prefix, budget), budget, true);
  } catch (error) {
    rethrowBudget(error, budget);
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
  budget?: BudgetContext,
): boolean {
  if (!budget) return fields.some((field) => Boolean(cells[field]?.trim()));
  budget.spend();
  return fields.some((field) => {
    budget.spend();
    // Preserve the original native error for malformed non-string cells; no
    // callable trim can exist in a decoder-certified JSON value.
    const value = cells[field];
    if (typeof value === 'string') {
      budget.reserveString(utf8ByteLength(value, budget));
      budget.spend(1 + Math.ceil(value.length / 256));
    }
    const result = Boolean(cells[field]?.trim()); budget.check(); return result;
  });
}

function scheduleFromCells(cells: Readonly<Record<string, string | undefined>>, prefix: '' | 'pending', budget?: BudgetContext): TaskSchedule {
  // Ten static field-name references, no input-derived names.
  budget?.reserve({ nodes: 1, slots: 10, structuralBytes: 220 });
  budget?.spend();
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
  reserveScheduleRecord(budget);
  return {
    ruleVersion: cellNumber(cells[names.ruleVersion], budget),
    effectiveFrom: trimCell(cells[names.effectiveFrom], budget) ?? '',
    timeZone: trimCell(cells[names.timeZone], budget) ?? '',
    recurrence: recurrenceFromCells(cells, names, budget),
    resetCompletionOnCycle: parseStrictBoolean(cells[names.resetCompletion], budget),
    resetAssignmentOnCycle: parseStrictBoolean(cells[names.resetAssignment], budget),
  };
}

function recurrenceFromCells(
  cells: Readonly<Record<string, string | undefined>>,
  names: { recurrenceType: string; recurrenceTime: string; recurrenceWeekday: string; recurrenceWeekdays: string; recurrenceDayOfMonth: string },
  budget?: BudgetContext,
): TaskRecurrence {
  const type = trimCell(cells[names.recurrenceType], budget);
  reserveRecurrenceRecord(budget);
  if (equalBudgetValue(type, 'NONE', budget)) return { type: 'NONE' };
  if (equalBudgetValue(type, 'DAILY', budget)) return { type, time: trimCell(cells[names.recurrenceTime], budget) ?? '' };
  if (equalBudgetValue(type, 'WEEKLY', budget)) {
    const multi = trimCell(cells[names.recurrenceWeekdays], budget);
    const source = multi || trimCell(cells[names.recurrenceWeekday], budget) || '';
    return { type, time: trimCell(cells[names.recurrenceTime], budget) ?? '', weekdays: parseWeekdays(source, budget) };
  }
  if (equalBudgetValue(type, 'MONTHLY', budget)) return {
    type, time: trimCell(cells[names.recurrenceTime], budget) ?? '', dayOfMonth: cellNumber(cells[names.recurrenceDayOfMonth], budget) as DayOfMonth,
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

function validateRecurrence(recurrence: TaskRecurrence, budget?: BudgetContext): void {
  budget?.spend(4);
  if (!recurrence || typeof recurrence !== 'object') throw new TaskScheduleValidationError('recurrence must be an object');
  if (equalBudgetValue(recurrence.type, 'NONE', budget)) return;
  const raw = recurrence as Exclude<TaskRecurrence, { type: 'NONE' }>;
  const time = budget ? budgetString(raw.time, budget) : raw.time;
  budget?.spend(1 + Math.ceil(time.length / 256));
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  budget?.check();
  if (!validTime) {
    throw new TaskScheduleValidationError('recurrence time must use valid HH:mm');
  }
  if (equalBudgetValue(recurrence.type, 'DAILY', budget)) return;
  if (equalBudgetValue(recurrence.type, 'WEEKLY', budget)) {
    const weekly = recurrence as Extract<TaskRecurrence, { type: 'WEEKLY' }>;
    if (!Array.isArray(weekly.weekdays) || weekly.weekdays.length === 0
      || weekly.weekdays.some((weekday) => { budget?.spend(4); return !Number.isInteger(weekday) || weekday < 1 || weekday > 7; })
      || !uniqueWeekdays(weekly.weekdays, budget)) {
      throw new TaskScheduleValidationError('weekdays must contain unique values from 1 to 7');
    }
    return;
  }
  if (equalBudgetValue(recurrence.type, 'MONTHLY', budget)) {
    budget?.spend(3);
    const monthly = recurrence as Extract<TaskRecurrence, { type: 'MONTHLY' }>;
    if (!Number.isInteger(monthly.dayOfMonth) || monthly.dayOfMonth < 1 || monthly.dayOfMonth > 31) {
      throw new TaskScheduleValidationError('dayOfMonth must be from 1 to 31');
    }
    return;
  }
  throw new TaskScheduleValidationError('recurrence type is not supported');
}

function parseStrictBoolean(value: string | undefined, budget?: BudgetContext): boolean {
  const first = trimCell(value, budget) ?? '';
  budget?.spend(1 + Math.ceil(first.length / 256));
  const truth = /^(true|1)$/i.test(first); budget?.check();
  if (truth) return true;
  const second = trimCell(value, budget) ?? '';
  budget?.spend(1 + Math.ceil(second.length / 256));
  const falsity = /^(false|0)$/i.test(second); budget?.check();
  if (falsity) return false;
  throw new TaskScheduleValidationError('reset flags must be boolean');
}

function parseInstant(value: unknown, field: string, budget?: BudgetContext): Temporal.Instant {
  try {
    const text = budget ? budgetString(value ?? '', budget) : String(value ?? '');
    // Opaque logical Temporal result; native internals are not metered.
    budget?.reserve({ nodes: 1, structuralBytes: 16 });
    budget?.spend(1 + Math.ceil(text.length / 256));
    const instant = Temporal.Instant.from(text);
    budget?.check();
    return instant;
  } catch (error) {
    rethrowBudget(error, budget);
    throw new TaskScheduleValidationError(`${field} must be an ISO instant`);
  }
}

function canonicalInstant(value: unknown, field: string, budget?: BudgetContext): string {
  const instant = parseInstant(value, field, budget);
  // The supported Temporal range needs at most a signed six-digit year plus
  // millisecond ISO suffix. Reserve options BEFORE the argument literal.
  budget?.reserve({ nodes: 1, slots: 1, structuralBytes: 32 });
  budget?.reserveString(32);
  budget?.spend();
  try {
    const result = instant.toString({ smallestUnit: 'millisecond' });
    budget?.check();
    return result;
  } catch (error) {
    rethrowBudget(error, budget);
    throw error;
  }
}

function normalizeLegacyInstant(value: unknown, budget?: BudgetContext): string {
  try {
    return canonicalInstant(value, 'legacy instant', budget);
  } catch (error) {
    rethrowBudget(error, budget);
    return LEGACY_TASK_INSTANT;
  }
}

function rethrowBudget(error: unknown, budget?: BudgetContext): void {
  if (!budget) return;
  if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
  budget.check();
}

// Closed mutable recipes, private to this parser. No arity/factory registration.
function reserveScheduleRecord(budget?: BudgetContext): void {
  budget?.reserve({ nodes: 7, slots: 6, structuralBytes: 160 });
  budget?.spend(6);
}
function reserveRecurrenceRecord(budget?: BudgetContext): void {
  // Largest three-field variant, including three scalar occurrences.
  budget?.reserve({ nodes: 4, slots: 3, structuralBytes: 64 });
  budget?.spend(3);
}
function trimCell(value: string | undefined, budget?: BudgetContext): string | undefined {
  budget?.spend();
  return value == null ? undefined : trimBudgetString(value, budget);
}
function cellNumber(value: string | undefined, budget?: BudgetContext): number {
  // Certified JSON cannot override valueOf with a function. For object values
  // its numeric ToPrimitive therefore uses the same native string conversion;
  // preflight that conversion rather than letting Number join an unchecked array.
  if (budget && value !== null && typeof value === 'object') value = budgetString(value, budget);
  budget?.reserve({ nodes: 1, structuralBytes: 4 });
  budget?.spend(1 + (typeof value === 'string' ? Math.ceil(value.length / 256) : 0));
  const result = Number(value); budget?.check(); return result;
}
function legacyInstanceId(taskId: string, createdAt: string, budget?: BudgetContext): string {
  if (budget && typeof taskId !== 'string') taskId = budgetString(taskId, budget);
  if (budget) {
    budget.reserveString(8 + utf8ByteLength(taskId, budget) + utf8ByteLength(createdAt, budget));
    budget.spend(1 + Math.ceil(taskId.length / 256) + Math.ceil(createdAt.length / 256));
  }
  const result = `legacy:${taskId}:${createdAt}`; budget?.check(); return result;
}
function parseWeekdays(source: string, budget?: BudgetContext): IsoWeekday[] {
  if (!budget) return source.split(',').filter(Boolean).map(Number).sort((a, b) => a - b) as IsoWeekday[];
  const split = splitBudgetString(source, ',', budget);
  // Filter before Number: whitespace-only pieces are retained and become zero.
  budget.reserve({ nodes: 1, slots: split.length, structuralBytes: 16 + 4 * split.length });
  budget.spend();
  const filtered = split.filter((value) => { budget.spend(); return Boolean(value); });
  budget.check();
  budget.reserve({ nodes: 1 + filtered.length, slots: filtered.length, structuralBytes: 16 + 8 * filtered.length });
  budget.spend();
  const numbers = filtered.map((value) => { budget.spend(); return cellNumber(value, budget); });
  budget.check();
  return stableBudgetSort(numbers, (a, b) => a - b, budget) as IsoWeekday[];
}
function uniqueWeekdays(values: IsoWeekday[], budget?: BudgetContext): boolean {
  if (!budget) return new Set(values).size === values.length;
  budget.reserve({ nodes: 1, structuralBytes: 16 }); budget.spend();
  const seen = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    budget.spend(2);
    if (!seen.has(values[i])) { budget.reserve({ slots: 1, structuralBytes: 4 }); budget.spend(); seen.add(values[i]); }
  }
  budget.spend(); return seen.size === values.length;
}

/** Preflight native String coercion of certified JSON values, including nested
 * array join. Object conversion cannot run user code: decoder forbids functions,
 * accessors and custom prototypes. Own nonfunction toString still throws natively.
 * This does not authorize a new graph or freeze a legacy result. */
function budgetString(value: unknown, budget: BudgetContext): string {
  function size(input: unknown, depth: number, arrayElement: boolean): number {
    budget.checkDepth(depth); budget.spend();
    if (typeof input === 'string') return utf8ByteLength(input, budget);
    if (input === null || input === undefined) return arrayElement ? 0 : 9;
    if (typeof input !== 'object') return 32;
    const keys = registeredBoundedKeys(input, budget);
    if (!Array.isArray(input)) return 15;
    let bytes = Math.max(0, input.length - 1);
    // Keys are consulted for certified ownership, not used as caller arity.
    budget.spend(keys.length);
    for (let i = 0; i < input.length; i++) {
      budget.spend(); bytes += size(input[i], depth + 1, true);
      if (bytes > budget.limits.stringBytes) throw new BudgetExceededError();
    }
    // Each nested native array join may materialize its own full string and
    // element-reference scratch, even when the outer String result is identical.
    bytes = Math.max(15, bytes);
    budget.reserveString(bytes);
    budget.reserve({ nodes: 1, slots: input.length, structuralBytes: 16 + 4 * input.length });
    budget.spend(1 + Math.ceil(bytes / 256));
    return bytes;
  }
  // Bounded recursive dry-run frames and native nested join logical temporaries.
  budget.reserve({ nodes: 64, slots: 256, structuralBytes: 8192 });
  const bytes = size(value, 1, false);
  budget.reserveString(bytes);
  budget.spend(1 + Math.ceil(bytes / 256));
  const result = String(value); budget.check(); return result;
}
