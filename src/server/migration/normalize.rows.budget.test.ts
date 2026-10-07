import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as rows from '@/server/sheetsRows';
import * as schedule from '@/domain/taskSchedule';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/normalizer-rows-budget-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json?: string; frozen?: boolean; sourceFrozen?: boolean; recordsNullPrototype?: boolean; error?: { name: string; message: string } } }[];
};
function value(name: string): Input { return JSON.parse(JSON.stringify(golden.cases.find((f) => f.name === name)!.input)) as Input; }
function admit(input: Input, budget: BudgetContext): Input { return parseRegisteredBoundedJson(JSON.stringify(input), budget) as Input; }
function change(input: Input, field: string, value: string) { const tab = input.sheets.tabs.Tasks; (tab.rows[0].cells as string[])[tab.headers.indexOf(field)] = value; }

describe('actual normalizer header/task/promotion caller slice; not complete P0', () => {
  for (const enabled of [false, true]) it.each(golden.cases)(`frozen Git bytes/native errors budget=${enabled}: $name`, (f) => {
    const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = budget ? admit(f.input, budget) : JSON.parse(JSON.stringify(f.input)) as Input;
    if (f.outcome.error) { try { run(input, budget); expect.fail('expected original error'); } catch (e) { expect({ name: (e as Error).name, message: (e as Error).message }).toEqual(f.outcome.error); } }
    else { const output = run(input, budget); expect(JSON.stringify(output)).toBe(f.outcome.json); expect(Object.isFrozen(output)).toBe(f.outcome.frozen); expect(Object.isFrozen(output.sourceRecords)).toBe(f.outcome.sourceFrozen); expect(Object.getPrototypeOf(output.records) === null).toBe(f.outcome.recordsNullPrototype); }
  });
  for (const name of ['task-default', 'task-current-pending', 'promotion:FIXED_DISCOUNT']) it(`passes admitted arrays and identical context to actual row parser: ${name}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value(name), budget);
    const header = vi.spyOn(rows, 'createHeaderIndex'), task = vi.spyOn(rows, 'parseTaskRow'), promotion = vi.spyOn(rows, 'parsePromotionRow');
    try {
      run(input, budget);
      const tab = input.sheets.tabs[name.startsWith('task') ? 'Tasks' : 'Promotions'];
      expect(header).toHaveBeenCalledWith(tab.headers, budget);
      expect(header.mock.calls[0][0]).toBe(tab.headers);
      if (name.startsWith('task')) { expect(task).toHaveBeenCalledWith(tab.rows[0].cells, expect.any(Map), 'Asia/Seoul', budget); expect(task.mock.calls[0][0]).toBe(tab.rows[0].cells); }
      else { expect(promotion).toHaveBeenCalledWith(tab.rows[0].cells, expect.any(Map), budget); expect(promotion.mock.calls[0][0]).toBe(tab.rows[0].cells); }
    } finally { header.mockRestore(); task.mockRestore(); promotion.mockRestore(); }
  });
  it('propagates identical context through actual current/pending schedule and allowed IDs', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-current-pending'), budget);
    const s = vi.spyOn(schedule, 'parseTaskScheduleCells'), ids = vi.spyOn(rows, 'parseAllowedStudentIds');
    try { run(input, budget); expect(s.mock.calls.length).toBe(1); expect(s.mock.calls[0][2]).toBe(budget); } finally { s.mockRestore(); ids.mockRestore(); }
  });
  it('passes the same context into the actual redacted identity hash', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-default'), budget), spy = vi.spyOn(validators, 'sha256');
    try { run(input, budget); expect(spy).toHaveBeenCalledWith('T1', budget); } finally { spy.mockRestore(); }
  });
  for (const mode of ['success', 'ordinary', 'budget', 'unavailable', 'abort'] as const) it(`header trim native ${mode} checks exit and preserves budget identity`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal }), input = value('task-default');
    (input.sheets.tabs.Tasks.headers as string[])[0] = ' taskId ';
    const admitted = admit(input, budget), native = String.prototype.trim;
    const failure = mode === 'budget' ? new BudgetExceededError() : new BudgetUnavailableError();
    const spy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      if (String(this) === ' taskId ') { if (mode === 'abort') signal.aborted = true; else now = 5000; if (mode === 'ordinary') throw new RangeError('late'); if (mode === 'budget' || mode === 'unavailable') throw failure; }
      return native.call(this);
    });
    let error: unknown; try { run(admitted, budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
    if (mode === 'budget' || mode === 'unavailable') expect(error).toBe(failure); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  it('reserves header trim copy before native trim', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-default'), budget);
    const native = String.prototype.trim; let calls = 0;
    budget.reserve({ contentBytes: budget.limits.contentBytes - budget.usage().contentBytes });
    const spy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) { calls++; return native.call(this); });
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); } finally { spy.mockRestore(); }
    expect(calls).toBe(0);
  });
  for (const field of ['allowedStudentIds', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays']) it(`huge ${field} refuses before nested native split`, () => {
    const text = Array(5001).fill(field === 'allowedStudentIds' ? 'S1' : '1').join(',');
    const input = value('task-current-pending'); change(input, field, text);
    const budget = createBudgetContext({ now: () => 0 }), admitted = admit(input, budget), native = String.prototype.split;
    const original = schedule.parseTaskScheduleCells;
    const s = vi.spyOn(schedule, 'parseTaskScheduleCells');
    // Exhaust at the actual nested parser entry, leaving enough for fixed recipes
    // but not the 5,001 substring slots. Budget omission previously reaches split.
    s.mockImplementation((cells, legacy, context) => {
      budget.reserve({ slots: budget.limits.slots - budget.usage().slots - 5000 });
      return original(cells, legacy, context);
    });
    let calls = 0;
    const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator: Parameters<typeof String.prototype.split>[0], limit?: number) { if (String(this) === text) calls++; return native.call(this, separator, limit); });
    try { expect(() => run(admitted, budget)).toThrow(BudgetExceededError); } finally { split.mockRestore(); s.mockRestore(); }
    expect(calls).toBe(0);
  });
  it('passes task scalar validation the same context before invoking the row parser', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-default'), budget), spy = vi.spyOn(validators, 'canonicalInstant');
    try { run(input, budget); expect(spy).toHaveBeenCalledWith('2026-09-01T00:00:00.000Z', budget); } finally { spy.mockRestore(); }
  });
  it('precharges the task chronology Date.parse before the next native call', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-default'), budget), native = Date.parse;
    const instant = validators.canonicalInstant; let armed = false;
    const validation = vi.spyOn(validators, 'canonicalInstant').mockImplementation((text, context) => { const result = instant(text, context); if (text === '2026-09-01T00:00:00.000Z') armed = true; return result; });
    let calls = 0;
    const spy = vi.spyOn(Date, 'parse').mockImplementation((text) => { if (armed) calls++; const result = native(text); if (armed && calls === 1) budget.spend(budget.limits.work - budget.usage().work); return result; });
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); } finally { spy.mockRestore(); validation.mockRestore(); }
    expect(calls).toBe(1);
  });
  it('propagates the request through header diagnostic hashing', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('headers-duplicate'), budget), spy = vi.spyOn(validators, 'sha256');
    try { run(input, budget); expect(spy).toHaveBeenCalledWith(input.sheets.digest, budget); } finally { spy.mockRestore(); }
  });
  it('reserves completion raw String before its native call, without trimming raw evidence', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('completion-raw'), budget), trim = String.prototype.trim, get = Map.prototype.get, NativeString = globalThis.String;
    let trimmed = false, atRaw = false, calls = 0;
    const t = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) { if (NativeString(this) === ' Alice ') trimmed = true; return trim.call(this); });
    const g = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) { if (trimmed && !atRaw && key === 'evidenceAuthorFullName') { atRaw = true; budget.reserve({ contentBytes: budget.limits.contentBytes - budget.usage().contentBytes }); } return get.call(this, key); });
    globalThis.String = new Proxy(NativeString, { apply(target, receiver, args) { if (atRaw && args[0] === ' Alice ') calls++; return Reflect.apply(target, receiver, args); } });
    let error: unknown; try { run(input, budget); } catch (e) { error = e; } finally { globalThis.String = NativeString; t.mockRestore(); g.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(atRaw).toBe(true); expect(calls).toBe(0);
  });
  it('refuses before calling the task row factory after final chronology work exhausts', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-default'), budget), instant = validators.canonicalInstant, native = Date.parse;
    let armed = false, calls = 0;
    const validation = vi.spyOn(validators, 'canonicalInstant').mockImplementation((text, context) => { const result = instant(text, context); if (text === '2026-09-01T00:00:00.000Z') armed = true; return result; });
    const date = vi.spyOn(Date, 'parse').mockImplementation((text) => { const result = native(text); if (armed && ++calls === 2) budget.spend(budget.limits.work - budget.usage().work); return result; });
    const row = vi.spyOn(rows, 'parseTaskRow');
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); expect(row).not.toHaveBeenCalled(); } finally { validation.mockRestore(); date.mockRestore(); row.mockRestore(); }
    expect(calls).toBe(2);
  });
  it('refuses before calling the promotion row factory after identity work exhausts', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('promotion:FIXED_DISCOUNT'), budget), native = validators.sha256;
    let exhausted = false;
    const hash = vi.spyOn(validators, 'sha256').mockImplementation((text, context) => { const result = native(text, context); if (text === 'PROMO1') { exhausted = true; budget.spend(budget.limits.work - budget.usage().work); } return result; });
    const row = vi.spyOn(rows, 'parsePromotionRow');
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); expect(row).not.toHaveBeenCalled(); } finally { hash.mockRestore(); row.mockRestore(); }
    expect(exhausted).toBe(true);
  });
  it('reserves the distinct duplicate-preserving raw allowed list before split', () => {
    const text = Array(5001).fill('S1').join(';'), input = value('task-default'); change(input, 'allowedStudentIds', text);
    const budget = createBudgetContext({ now: () => 0 }), admitted = admit(input, budget), original = rows.parseTaskRow, native = String.prototype.split;
    let afterParser = false, calls = 0;
    const row = vi.spyOn(rows, 'parseTaskRow').mockImplementation((cells, index, zone, context) => { const result = original(cells, index, zone, context); afterParser = true; budget.reserve({ slots: budget.limits.slots - budget.usage().slots - 5000 }); return result; });
    const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator: Parameters<typeof String.prototype.split>[0], limit?: number) { if (afterParser && String(this) === text) calls++; return native.call(this, separator, limit); });
    try { expect(() => run(admitted, budget)).toThrow(BudgetExceededError); } finally { row.mockRestore(); split.mockRestore(); }
    expect(afterParser).toBe(true); expect(calls).toBe(0);
  });
  for (const name of ['promotion:FIXED_DISCOUNT', 'promotion:N_PLUS_ONE']) it(`reserves promotion projection before native entries/fromEntries: ${name}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value(name), budget), original = rows.parsePromotionRow, entries = Object.entries, from = Object.fromEntries;
    let parsed: unknown, reached = false, afterParser = false;
    const row = vi.spyOn(rows, 'parsePromotionRow').mockImplementation((cells, index, context) => { parsed = original(cells, index, context); afterParser = true; budget.reserve({ nodes: budget.limits.nodes - budget.usage().nodes }); return parsed as ReturnType<typeof original>; });
    const e = vi.spyOn(Object, 'entries').mockImplementation((object) => { if (afterParser && object === parsed) reached = true; return entries(object); });
    const f = vi.spyOn(Object, 'fromEntries').mockImplementation((pairs) => { if (afterParser) reached = true; return from(pairs); });
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); } finally { row.mockRestore(); e.mockRestore(); f.mockRestore(); }
    expect(afterParser).toBe(true); expect(reached).toBe(false);
  });
  it('refuses schedule cells before native fromEntries when row-entry slots are exhausted', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-default'), budget), original = rows.parseTaskRow, native = Object.fromEntries;
    let reached = false, entered = false;
    const row = vi.spyOn(rows, 'parseTaskRow').mockImplementation((cells, index, zone, context) => { entered = true; budget.reserve({ slots: budget.limits.slots - budget.usage().slots }); return original(cells, index, zone, context); });
    const spy = vi.spyOn(Object, 'fromEntries').mockImplementation((pairs) => { if (entered) reached = true; return native(pairs); });
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); } finally { row.mockRestore(); spy.mockRestore(); }
    expect(entered).toBe(true); expect(reached).toBe(false);
  });
  it('rejects foreign ownership before row parser or header factory', () => {
    const input = admit(value('task-default'), createBudgetContext({ now: () => 0 }));
    const spy = vi.spyOn(rows, 'createHeaderIndex');
    try { expect(() => run(input, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.'); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
  });
  for (const field of ['recurrenceWeekdays', 'pendingRecurrenceWeekdays', 'allowedStudentIds']) for (const mode of ['success', 'ordinary', 'budget', 'unavailable', 'abort'] as const) it(`actual ${field} split ${mode} preserves native exit policy`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal }), input = value('task-current-pending');
    const text = field === 'allowedStudentIds' ? 'S1;S2' : field === 'recurrenceWeekdays' ? '5,1,3' : '6,2'; change(input, field, text);
    const admitted = admit(input, budget), native = String.prototype.split;
    const failure = mode === 'budget' ? new BudgetExceededError() : new BudgetUnavailableError(); let entered = false;
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, separator: Parameters<typeof String.prototype.split>[0], limit?: number) {
      if (String(this) === text) { entered = true; if (mode === 'abort') signal.aborted = true; else now = 5000; if (mode === 'ordinary') throw new SyntaxError('late native split'); if (mode === 'budget' || mode === 'unavailable') throw failure; }
      return native.call(this, separator, limit);
    });
    let thrown: unknown; try { run(admitted, budget); } catch (e) { thrown = e; } finally { spy.mockRestore(); }
    expect(entered).toBe(true); if (mode === 'budget' || mode === 'unavailable') expect(thrown).toBe(failure); else expect(thrown).toBeInstanceOf(BudgetUnavailableError);
  });
  for (const mode of ['success', 'ordinary', 'budget', 'unavailable', 'abort'] as const) it(`actual promotion native ISO ${mode} preserves exit policy`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal }), input = admit(value('promotion:FIXED_DISCOUNT'), budget);
    const original = rows.parsePromotionRow, native = Date.prototype.toISOString; let entered = false, formatted = false;
    const row = vi.spyOn(rows, 'parsePromotionRow').mockImplementation((cells, index, context) => { entered = true; return original(cells, index, context); });
    const failure = mode === 'budget' ? new BudgetExceededError() : new BudgetUnavailableError();
    const date = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(function (this: Date) { if (entered) { formatted = true; if (mode === 'abort') signal.aborted = true; else now = 5000; if (mode === 'ordinary') throw new RangeError('late ISO'); if (mode === 'budget' || mode === 'unavailable') throw failure; } return native.call(this); });
    let thrown: unknown; try { run(input, budget); } catch (e) { thrown = e; } finally { row.mockRestore(); date.mockRestore(); }
    expect(formatted).toBe(true); if (mode === 'budget' || mode === 'unavailable') expect(thrown).toBe(failure); else expect(thrown).toBeInstanceOf(BudgetUnavailableError);
  });
  it('accepted current/pending schedule outputs remain mutable and sorted', () => {
    const budget = createBudgetContext({ now: () => 0 }), output = run(admit(value('task-current-pending'), budget), budget);
    const record = output.sourceRecords[0].canonicalRecord!;
    expect(record).not.toBeNull();
    const current = record.currentSchedule as { recurrence: { weekdays: number[] } }, pending = record.pendingSchedule as { recurrence: { weekdays: number[] } };
    expect(current.recurrence.weekdays).toEqual([1, 3, 5]); expect(pending.recurrence.weekdays).toEqual([2, 6]);
    expect(Object.isFrozen(current)).toBe(false); expect(Object.isFrozen(pending.recurrence.weekdays)).toBe(false);
    expect(() => validators.canonicalJson(current, budget)).toThrow('Legacy bounded JSON is invalid.');
  });
  it('accumulates header and row work across repeated calls without resetting context', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(value('task-current-pending'), budget), initial = budget.usage();
    run(input, budget); const first = budget.usage(); run(input, budget); const second = budget.usage();
    for (const counter of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) { expect(first[counter]).toBeGreaterThan(initial[counter]); expect(second[counter] - first[counter]).toBe(first[counter] - initial[counter]); }
  });
  for (const name of ['task-default', 'task-current-pending', 'promotion:FIXED_DISCOUNT', 'promotion:N_PLUS_ONE']) for (const counter of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) for (const offset of [-1, 0, 1]) it(`${name} cumulative ${counter} limit ${offset}`, () => {
    const measurement = createBudgetContext({ now: () => 0 }); run(admit(value(name), measurement), measurement); const total = measurement.usage()[counter];
    const budget = createBudgetContext({ now: () => 0, limits: { [counter]: total + offset } }); const input = admit(value(name), budget);
    if (offset < 0) expect(() => run(input, budget)).toThrow(BudgetExceededError);
    else { run(input, budget); expect(budget.usage()[counter]).toBe(total); }
  });
});
