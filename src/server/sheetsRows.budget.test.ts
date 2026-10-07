import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createHeaderIndex, requireColumns, parseTaskRow, parsePromotionRow } from './sheetsRows';
import { createBudgetContext, BudgetExceededError, BudgetUnavailableError, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson, createBoundedSheetsScheduleInputs, registeredBoundedKeys } from '@/lib/boundedJson';

type Fixture = { kind: string; input: { headers: string[]; row: string[]; zone?: string; required: string[] }; outcome: { json?: string; error?: { name: string; message: string } } };
const fixtures = JSON.parse(readFileSync('src/server/migration/__fixtures__/row-integration-golden.json', 'utf8')) as Fixture[];
const header = createHeaderIndex as (value: string[], budget?: BudgetContext) => Map<string, number>;
const required = requireColumns as (map: Map<string, number>, value: string[], budget?: BudgetContext) => unknown;
const task = parseTaskRow as (row: string[], map: Map<string, number>, zone?: string, budget?: BudgetContext) => ReturnType<typeof parseTaskRow>;
const promotion = parsePromotionRow as (row: string[], map: Map<string, number>, budget?: BudgetContext) => ReturnType<typeof parsePromotionRow>;
function admitted<T>(value: T, budget: BudgetContext): T { return parseRegisteredBoundedJson(JSON.stringify(value), budget) as T; }
function run(fixture: Fixture, budget?: BudgetContext) {
  const input = budget ? admitted(fixture.input, budget) : fixture.input;
  try {
    const map = header(input.headers, budget);
    const value = fixture.kind === 'task' ? task(input.row, map, input.zone, budget)
      : fixture.kind === 'promotion' ? promotion(input.row, map, budget)
        : fixture.kind === 'required' ? required(map, input.required, budget) : Array.from(map);
    return { json: JSON.stringify(value) };
  } catch (error) { const e = error as Error; return { error: { name: e.name, message: e.message } }; }
}
const validTask = fixtures.find(f => f.kind === 'task')!;
const validPromotion = fixtures.find(f => f.kind === 'promotion')!;
const boundaryFixtures = [
  fixtures.find(f => f.kind === 'header' && f.input.headers.length === 3)!,
  fixtures.find(f => f.kind === 'required' && f.input.headers.length === 3)!,
  validTask,
  fixtures.find(f => f.kind === 'task' && f.input.headers.includes('pendingRecurrenceWeekdays'))!,
  fixtures.find(f => f.kind === 'task' && f.outcome.json?.includes('INVALID_PENDING_SCHEDULE'))!,
  validPromotion,
  ...['PROMOTIONAL_PRICE', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT'].map(type => fixtures.find(f => f.kind === 'promotion' && f.outcome.json?.includes(`"type":"${type}"`))!),
];
for (const counter of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) {
  it(`exact cumulative ${counter} limit−1/exact/+1 across all row variants`, () => {
    for (const fixture of boundaryFixtures) {
      const measure = createBudgetContext({ now: () => 0 }); expect(run(fixture, measure)).toEqual(fixture.outcome);
      const cost = measure.usage()[counter];
      for (const offset of [-1, 0, 1]) {
        const budget = createBudgetContext({ now: () => 0, limits: { [counter]: cost + offset } });
        // Admission can itself exhaust an exceptionally small cap; catch both
        // the admission and parser boundaries without converting them to null.
        if (offset < 0) {
          let outcome: ReturnType<typeof run>;
          try { outcome = run(fixture, budget); } catch (error) { expect(error).toBeInstanceOf(BudgetExceededError); continue; }
          expect(outcome).toEqual({ error: { name: 'BudgetExceededError', message: 'Legacy normalization budget exceeded.' } });
        } else { expect(run(fixture, budget)).toEqual(fixture.outcome); expect(budget.usage()[counter]).toBe(cost); }
      }
    }
  });
  it(`request-owned ${counter} is not reset between rows`, () => {
    for (const fixture of [validTask, validPromotion]) {
      const measure = createBudgetContext({ now: () => 0 }); const input = admitted(fixture.input, measure); const map = header(input.headers, measure);
      const before = measure.usage()[counter];
      const invoke = (budget: BudgetContext, data: typeof input, index: typeof map) => fixture.kind === 'task' ? task(data.row, index, data.zone, budget) : promotion(data.row, index, budget);
      invoke(measure, input, map); const once = measure.usage()[counter] - before;
      const budget = createBudgetContext({ now: () => 0, limits: { [counter]: before + 2 * once - 1 } }); const secondInput = admitted(fixture.input, budget); const secondMap = header(secondInput.headers, budget);
      expect(invoke(budget, secondInput, secondMap)).not.toBeNull();
      expect(() => invoke(budget, secondInput, secondMap)).toThrow(BudgetExceededError);
    }
  });
}


describe('Sheets complete bounded row integration', () => {
  fixtures.forEach((fixture, index) => {
    it(`original ${index} ${fixture.kind} no-budget`, () => expect(run(fixture)).toEqual(fixture.outcome));
    it(`original ${index} ${fixture.kind} bounded`, () => expect(run(fixture, createBudgetContext({ now: () => 0 }))).toEqual(fixture.outcome));
  });
  it('rejects a foreign header before callback/trim', () => {
    const trim = vi.fn(() => 'a');
    expect(() => header([{ trim }] as unknown as string[], createBudgetContext())).toThrow();
    expect(trim).not.toHaveBeenCalled();
  });
  it('reserves before native header Map construction', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const headers = admitted(['a'], budget);
    budget.reserve({ nodes: budget.limits.nodes - budget.usage().nodes });
    expect(() => header(headers, budget)).toThrow(BudgetExceededError);
  });
  it('refuses foreign rows before cell getters', () => {
    const budget = createBudgetContext();
    const map = header(admitted(['taskId', 'title', 'reward'], budget), budget);
    const getter = vi.fn(() => 'x'); const row: string[] = [];
    Object.defineProperty(row, '0', { get: getter });
    expect(() => task(row, map, undefined, budget)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('refuses a map owned by another request', () => {
    const first = createBudgetContext(), second = createBudgetContext();
    const map = header(admitted(['taskId'], first), first);
    expect(() => task(admitted(['x'], second), map, undefined, second)).toThrow();
  });
  it('precharges required missing-list allocation', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const map = header(admitted([], budget), budget), columns = admitted(['missing'], budget);
    budget.reserve({ slots: budget.limits.slots - budget.usage().slots });
    expect(() => required(map, columns, budget)).toThrow(BudgetExceededError);
  });
  for (const fixture of [validTask, validPromotion]) {
    it(`${fixture.kind} consumes the same context after admission`, () => {
      const budget = createBudgetContext({ now: () => 0 }); const input = admitted(fixture.input, budget); const map = header(input.headers, budget);
      budget.spend(budget.limits.work - budget.usage().work);
      expect(() => fixture.kind === 'task' ? task(input.row, map, input.zone, budget) : promotion(input.row, map, budget)).toThrow(BudgetExceededError);
    });
  }
  it('task output including nested recurrence and IDs remains mutable', () => {
    const budget = createBudgetContext(); const input = admitted(validTask.input, budget); const result = task(input.row, header(input.headers, budget), input.zone, budget)!;
    result.allowedStudentIds.push('new'); result.schedule!.timeZone = 'UTC'; result.title = 'changed';
    expect(result.allowedStudentIds.at(-1)).toBe('new'); expect(result.schedule!.timeZone).toBe('UTC');
  });
  it('promotion nested productIds remains mutable', () => {
    const budget = createBudgetContext(); const input = admitted(validPromotion.input, budget); const result = promotion(input.row, header(input.headers, budget), budget)!;
    result.productIds.push('new'); expect(result.productIds).toEqual(['new']);
  });
  it('closed schedule recipe refuses uncertified legacy operands', () => {
    const budget = createBudgetContext(); const row = admitted([], budget); const map = header(admitted([], budget), budget);
    const foreign = { mutable: true } as unknown as string;
    expect(() => createBoundedSheetsScheduleInputs(row, map, foreign, '', 'UTC', budget)).toThrow();
    expect(() => createBoundedSheetsScheduleInputs(row, map, '', foreign, 'UTC', budget)).toThrow();
    expect(() => createBoundedSheetsScheduleInputs(row, map, '', '', (() => 'UTC') as unknown as string, budget)).toThrow();
  });
  it('closed recipe certifies only its immutable arguments, not mutable parser results', () => {
    const budget = createBudgetContext(); const input = admitted(validTask.input, budget); const map = header(input.headers, budget);
    const args = createBoundedSheetsScheduleInputs(input.row, map, 't', '', 'UTC', budget);
    expect(Object.isFrozen(args[0])).toBe(true); expect(Object.isFrozen(args[1])).toBe(true);
    expect(() => registeredBoundedKeys(args[0], budget)).not.toThrow();
    expect(() => registeredBoundedKeys(task(input.row, map, undefined, budget)!, budget)).toThrow();
  });
  it('precharges the Date ISO native call separately after construction', () => {
    const budget = createBudgetContext({ now: () => 0 }); const input = admitted(validPromotion.input, budget); const map = header(input.headers, budget);
    const NativeDate = Date; const iso = vi.spyOn(NativeDate.prototype, 'toISOString');
    class SentinelDate extends NativeDate { constructor(value: number) { super(value); budget.spend(budget.limits.work - budget.usage().work); } }
    vi.stubGlobal('Date', SentinelDate);
    try { expect(() => promotion(input.row, map, budget)).toThrow(BudgetExceededError); expect(iso).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); iso.mockRestore(); }
  });
  it('late numeric exceptions are discarded on deadline', () => {
    let now = 0; const budget = createBudgetContext({ now: () => now }); const input = admitted(validTask.input, budget); const map = header(input.headers, budget);
    const NativeNumber = Number;
    function sentinel(value: unknown) { if (value === '1200') { now = 5000; throw new Error('native numeric failure'); } return NativeNumber(value); }
    Object.setPrototypeOf(sentinel, NativeNumber); vi.stubGlobal('Number', sentinel);
    try { expect(() => task(input.row, map, undefined, budget)).toThrow(BudgetUnavailableError); }
    finally { vi.unstubAllGlobals(); }
  });
  it('empty closed recipe accounts for both sidecars, legacy scalar occurrences and all containers', () => {
    const budget = createBudgetContext({ now: () => 0 }); const row = admitted([], budget); const map = header(admitted([], budget), budget);
    const before = budget.usage(); createBoundedSheetsScheduleInputs(row, map, 't', '', 'UTC', budget); const after = budget.usage();
    expect(after.nodes - before.nodes).toBeGreaterThanOrEqual(16);
    expect(after.structuralBytes - before.structuralBytes).toBeGreaterThanOrEqual(528);
  });
  it('schedule recipe does not allocate a native size descriptor in request work', () => {
    const budget = createBudgetContext(); const row = admitted([], budget); const map = header(admitted([], budget), budget);
    const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    try { createBoundedSheetsScheduleInputs(row, map, 't', '', 'UTC', budget); expect(descriptor.mock.calls.length).toBe(0); }
    finally { descriptor.mockRestore(); }
  });
  it('mutable owned header edits use current native entries, never stale certificates', () => {
    const budget = createBudgetContext(); const input = admitted(validTask.input, budget); const map = header(input.headers, budget);
    map.set('title', 0);
    expect(task(input.row, map, undefined, budget)!.title).toBe('t');
    Map.prototype.set.call(map, 'extra'.repeat(1000), 0);
    expect(task(input.row, map, undefined, budget)!.taskId).toBe('t');
    expect(() => registeredBoundedKeys(map, budget)).toThrow();
  });
  it('hostile native Map entry injection never invokes coercion', () => {
    const budget = createBudgetContext(); const input = admitted(validTask.input, budget); const map = header(input.headers, budget);
    const valueOf = vi.fn(() => 0); Map.prototype.set.call(map, 'taskId', { valueOf });
    expect(() => task(input.row, map, undefined, budget)).toThrow(); expect(valueOf).not.toHaveBeenCalled();
  });
  it('recipe refuses before fromEntries when the argument containers cannot fit', () => {
    const budget = createBudgetContext(); const row = admitted([], budget); const map = header(admitted([], budget), budget);
    budget.reserve({ slots: budget.limits.slots - budget.usage().slots });
    const factory = vi.spyOn(Object, 'fromEntries');
    try { expect(() => createBoundedSheetsScheduleInputs(row, map, 't', '', 'UTC', budget)).toThrow(BudgetExceededError); expect(factory.mock.calls.length).toBe(0); }
    finally { factory.mockRestore(); }
  });
  for (const fail of [false, true]) {
    it(`late Date formatting ${fail ? 'exception' : 'success'} discards the row`, () => {
      let now = 0; const budget = createBudgetContext({ now: () => now }); const input = admitted(validPromotion.input, budget); const map = header(input.headers, budget);
      const native = Date.prototype.toISOString;
      const spy = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(function (this: Date) { now = 5000; if (fail) throw new RangeError('native failed'); return native.call(this); });
      try { expect(() => promotion(input.row, map, budget)).toThrow(BudgetUnavailableError); } finally { spy.mockRestore(); }
    });
  }
  it('late budget errors from Date are never converted into invalid promotions', () => {
    const budget = createBudgetContext(); const input = admitted(validPromotion.input, budget); const map = header(input.headers, budget);
    const spy = vi.spyOn(Date, 'parse').mockImplementation(() => { throw new BudgetExceededError(); });
    try { expect(() => promotion(input.row, map, budget)).toThrow(BudgetExceededError); } finally { spy.mockRestore(); }
  });
  it('task pending weekdays and allowed IDs use the same cumulative split budget', () => {
    const fixture = fixtures.find(f => f.kind === 'task' && f.input.headers.includes('pendingRecurrenceWeekdays'))!;
    const budget = createBudgetContext({ now: () => 0 }); const input = admitted(fixture.input, budget); const map = header(input.headers, budget);
    const native = String.prototype.split; let calls = 0;
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator, limit) {
      if ((separator as unknown) === ',') { calls++; if (calls === 2) budget.spend(budget.limits.work - budget.usage().work); }
      return native.call(this, separator, limit);
    });
    try { expect(() => task(input.row, map, undefined, budget)).toThrow(BudgetExceededError); expect(calls).toBe(2); } finally { spy.mockRestore(); }
  });
  it('oversized allowed-ID fanout is refused before native split', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const input = admitted({ headers: ['taskId', 'title', 'reward', 'allowedStudentIds'], row: ['t', 'title', '1', 'x,'.repeat(5000)] }, budget);
    const map = header(input.headers, budget);
    const trim = String.prototype.trim; let trims = 0;
    const trimSpy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      const result = trim.call(this);
      if (result === input.row[3] && ++trims === 2) budget.reserve({ slots: budget.limits.slots - budget.usage().slots - 5000 });
      return result;
    });
    const native = String.prototype.split; let split = false;
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator, limit) {
      if (String(separator) === '/[\\n,;]/') split = true;
      return native.call(this, separator, limit);
    });
    try { expect(() => task(input.row, map, undefined, budget)).toThrow(BudgetExceededError); expect(split).toBe(false); expect(trims).toBe(2); } finally { spy.mockRestore(); trimSpy.mockRestore(); }
  });
  it('late finite-number checks cannot return an invalid task after the deadline', () => {
    let now = 0; const budget = createBudgetContext({ now: () => now });
    const input = admitted({ headers: ['taskId', 'title', 'reward', 'sortOrder'], row: ['', 'title', '1', '2'] }, budget); const map = header(input.headers, budget);
    const native = Number.isFinite;
    const spy = vi.spyOn(Number, 'isFinite').mockImplementation(value => { if (value === 2) now = 5000; return native(value); });
    try { expect(() => task(input.row, map, undefined, budget)).toThrow(BudgetUnavailableError); } finally { spy.mockRestore(); }
  });
  it('deadline refuses before Date parsing', () => {
    let now = 0; const budget = createBudgetContext({ now: () => now }); const input = admitted(validPromotion.input, budget); const map = header(input.headers, budget);
    now = 5000; const spy = vi.spyOn(Date, 'parse');
    try { expect(() => promotion(input.row, map, budget)).toThrow(BudgetUnavailableError); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
  });
});
