import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as json from '@/lib/boundedJson';
import * as work from '@/lib/boundedWork';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import * as operational from './operationalProjection';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const fixtures = JSON.parse(readFileSync('src/server/migration/__fixtures__/operational-integration-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string } }[] };
function admitted(b: BudgetContext, name = 'supported-carry') { return json.parseRegisteredBoundedJson(JSON.stringify(fixtures.cases.find(c => c.name === name)!.input), b) as Input; }
const dimensions = ['nodes', 'slots', 'structuralBytes', 'contentBytes', 'work'] as const;
function leave(b: BudgetContext, d: typeof dimensions[number], n: number) { const debit = b.limits[d] - b.usage()[d] - n; if (d === 'work') b.spend(debit); else b.reserve({ [d]: debit }); }
function assignment(b: BudgetContext) { return json.createBoundedHistoryAssignment(b, 'AS0', 'T1', 'TI1', 'v1|TI1|r1|2026-08-30T00:00:00Z', '2026-08-30T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 1, 'Asia/Seoul', 'S1', 'ASSIGNED', 'LEGACY_SEED', null, '2026-08-30T00:00:00.000Z', 2, 'note'); }

describe('closed operational view ownership and allocation', () => {
  it('empty remaining work refuses list-count native validation before invocation', () => {
    const b = createBudgetContext({ now: () => 0 }), native = Number.isSafeInteger; leave(b, 'work', 0); let reached = 0;
    Number.isSafeInteger = function (value) { if (value === 11) reached++; return native(value); };
    try { expect(() => json.createBoundedOperationalHistoryList(11, () => ({}), b)).toThrow(BudgetExceededError); } finally { Number.isSafeInteger = native; }
    expect(reached).toBe(0);
  });
  it('private association ordinary native exception checks expiry directly', () => {
    let now = 0; const b = createBudgetContext({ now: () => now }), row = assignment(b), get = WeakMap.prototype.get; let reached = 0, error: unknown;
    WeakMap.prototype.get = function (key) { if (key === row) { reached++; now = 6000; throw Error('ordinary'); } return get.call(this, key); };
    try { json.boundedOperationalHistoryView(row, b); } catch (e) { error = e; } finally { WeakMap.prototype.get = get; }
    expect(reached).toBe(1); expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  it('index-key strings obey the individual string ceiling before list operands', () => {
    const b = createBudgetContext({ now: () => 0, limits: { stringBytes: 1 } }), source = vi.fn(() => ({}));
    expect(() => json.createBoundedOperationalHistoryList(11, source, b)).toThrow(BudgetExceededError);
    expect(source).not.toHaveBeenCalled();
  });
  it('mutable canonical stays uncertified and mutation cannot alter the private sibling', () => {
    const b = createBudgetContext({ now: () => 0 }), row = assignment(b), view = json.boundedOperationalHistoryView(row, b);
    expect(view).not.toBe(row); expect(Object.isFrozen(row)).toBe(false); expect(Object.isFrozen(view)).toBe(true);
    row.taskId = 'changed'; row.extra = { nested: [] }; expect(view.taskId).toBe('T1'); expect(view.extra).toBeUndefined();
    expect(() => json.assertRegisteredBoundedJson(row, b)).toThrow('Legacy bounded JSON is invalid.');
    json.assertRegisteredBoundedJson(view, b);
    expect(() => json.boundedOperationalHistoryView(row, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.');
    const list = json.createBoundedOperationalHistoryList(2, () => row, b); expect(list[0]).toBe(list[1]); expect(list[0]).toBe(view);
  });
  it('rejects proxy and copied canonical before traps or getters', () => {
    const b = createBudgetContext({ now: () => 0 }), row = assignment(b), traps = vi.fn(() => { throw Error('trap'); });
    for (const value of [new Proxy(row, { get: traps, ownKeys: traps }), { ...row }]) expect(() => json.boundedOperationalHistoryView(value, b)).toThrow('Legacy bounded JSON is invalid.');
    expect(traps).not.toHaveBeenCalled();
  });
  it('fixed primitive operands cannot certify an object graph', () => {
    const b = createBudgetContext({ now: () => 0 }), traps = vi.fn(() => { throw Error('trap'); }), operand = new Proxy({}, { get: traps, ownKeys: traps });
    expect(() => json.createBoundedHistoryInvalidCompletion(b, operand as string, 'T1', 'S1', null, null, null, null, null, 'digest')).toThrow('Legacy bounded JSON is invalid.'); expect(traps).not.toHaveBeenCalled();
  });
  for (const d of dimensions) for (const delta of [-1, 0, 1]) it(`complete closed pair counter ${d} ${delta}`, () => {
    const measured = createBudgetContext({ now: () => 0 }); const before = measured.usage(); assignment(measured); const cost = measured.usage()[d] - before[d];
    if (!cost) { expect(d).toBe('contentBytes'); return; }
    const b = createBudgetContext({ now: () => 0 }); leave(b, d, cost + delta);
    if (delta < 0) expect(() => assignment(b)).toThrow(BudgetExceededError); else expect(assignment(b).assignmentId).toBe('AS0');
  });
  for (const d of dimensions) for (const delta of [-1, 0, 1]) it(`complete closed list counter ${d} ${delta}`, () => {
    const measured = createBudgetContext({ now: () => 0 }), m = assignment(measured), before = measured.usage(); json.createBoundedOperationalHistoryList(2, () => m, measured); const cost = measured.usage()[d] - before[d]; expect(cost).toBeGreaterThan(0);
    const b = createBudgetContext({ now: () => 0 }), row = assignment(b); leave(b, d, cost + delta);
    if (delta < 0) expect(() => json.createBoundedOperationalHistoryList(2, () => row, b)).toThrow(BudgetExceededError); else expect(json.createBoundedOperationalHistoryList(2, () => row, b)).toHaveLength(2);
  });
  for (const d of ['nodes', 'slots', 'structuralBytes', 'contentBytes'] as const) for (const delta of [-1, 0, 1]) it(`list admission before lazy source ${d} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), row = assignment(b), source = vi.fn(() => row);
    const cost = { nodes: 9, slots: 10, structuralBytes: 184, contentBytes: 32 }; leave(b, d, cost[d] + delta);
    if (delta < 0) expect(() => json.createBoundedOperationalHistoryList(2, source, b)).toThrow(BudgetExceededError); else expect(json.createBoundedOperationalHistoryList(2, source, b)).toHaveLength(2);
    expect(source).toHaveBeenCalledTimes(delta < 0 ? 0 : 2);
  });
});

describe('reached actual chronology/sort/helper native boundaries', () => {
  for (const d of dimensions) for (const delta of [-1, 0, 1]) it(`actual helper counter minus/exact/plus ${d} ${delta}`, () => {
    const native = operational.unsupportedOperationalRecords, stop = Error('helper returned');
    const measure = createBudgetContext({ now: () => 0 }), measuredInput = admitted(measure); let cost = 0;
    const measuring = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((a, c, owner) => {
      expect(owner).toBe(measure); const before = measure.usage()[d]; const result = native(a, c, owner); cost = measure.usage()[d] - before; return result;
    });
    try { run(measuredInput, measure); } finally { measuring.mockRestore(); }
    expect(cost).toBeGreaterThan(0);
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b); let reached = 0, returned = 0, error: unknown;
    const spy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((a, c, owner) => {
      reached++; expect(owner).toBe(b); leave(b, d, cost + delta); native(a, c, owner); returned++; throw stop;
    });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(reached).toBe(1); expect(returned).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const d of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`sort scratch before comparator ${d} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'chronology-equal-tie'), native = work.stableBudgetSort, stop = Error('sorted'); let reached = 0, comparisons = 0, error: unknown;
    const spy = vi.spyOn(work, 'stableBudgetSort').mockImplementation((list, compare, owner) => {
      if ((list[0] as { tab?: string } | undefined)?.tab !== 'TaskCompletions') return native(list, compare, owner);
      reached++; expect(owner).toBe(b); leave(b, d, ({ nodes: 2, slots: 4, structuralBytes: 48 })[d] + delta);
      native(list, (l, r) => { comparisons++; return compare(l, r); }, owner); throw stop;
    });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(reached).toBe(1); expect(comparisons).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const d of dimensions) it(`actual list caller refuses before helper ${d}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), native = json.createBoundedOperationalHistoryList; let reached = 0, operands = 0, error: unknown;
    const helper = vi.spyOn(operational, 'unsupportedOperationalRecords');
    const spy = vi.spyOn(json, 'createBoundedOperationalHistoryList').mockImplementation((count, source, owner) => { reached++; expect(owner).toBe(b); leave(b, d, 0); return native(count, i => { operands++; return source(i); }, owner); });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
    try { expect(reached).toBe(1); expect(operands).toBe(0); expect(helper).not.toHaveBeenCalled(); expect(error).toBeInstanceOf(BudgetExceededError); } finally { helper.mockRestore(); }
  });
  for (const mode of ['deadline', 'abort', 'ordinary', 'exceeded', 'unavailable'] as const) for (const nativeSite of ['index', 'subject', 'chronology'] as const) it(`${nativeSite} native exit ${mode}`, () => {
    let now = 0; const signal = new AbortController(), b = createBudgetContext({ now: () => now, signal: signal.signal }), input = admitted(b, 'chronology-equal-tie');
    const stop = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : Error('native');
    let armed = false, reached = 0, after = 0, error: unknown;
    const helper = operational.unsupportedOperationalRecords, sort = work.stableBudgetSort, set = Map.prototype.set, stringify = JSON.stringify, get = Map.prototype.get;
    const trip = () => { reached++; if (mode === 'abort') signal.abort(); else now = 6000; if (mode === 'ordinary' || mode === 'exceeded' || mode === 'unavailable') throw stop; };
    const helperSpy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((a, c, owner) => { if (nativeSite !== 'chronology') armed = true; return helper(a, c, owner); });
    const sortSpy = vi.spyOn(work, 'stableBudgetSort').mockImplementation((list, compare, owner) => { if (nativeSite === 'chronology' && (list[0] as { tab?: string } | undefined)?.tab === 'TaskCompletions') armed = true; return sort(list, compare, owner); });
    Map.prototype.set = function (key, value) { const result = set.call(this, key, value); if (armed && nativeSite === 'index' && key === 'AS0' && !reached) trip(); else if (reached) after++; return result; };
    Map.prototype.get = function (key) { const result = get.call(this, key); if (armed && nativeSite === 'chronology' && typeof key === 'object' && key?.tab === 'TaskCompletions' && !reached) trip(); else if (reached) after++; return result; };
    JSON.stringify = function (value: unknown, replacer?: unknown, space?: string | number) { const result = stringify(value, replacer as never, space); if (armed && nativeSite === 'subject' && Array.isArray(value) && value[0] === 'T1' && !reached) trip(); else if (reached) after++; return result; } as typeof JSON.stringify;
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.set = set; Map.prototype.get = get; JSON.stringify = stringify; helperSpy.mockRestore(); sortSpy.mockRestore(); }
    expect(reached).toBe(1); expect(after).toBe(0); if (mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(stop); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  for (const mode of ['deadline', 'abort', 'ordinary', 'exceeded', 'unavailable'] as const) it(`closed numeric operand native exit ${mode}`, () => {
    let now = 0; const signal = new AbortController(), b = createBudgetContext({ now: () => now, signal: signal.signal });
    const create = Object.create, finite = Number.isFinite;
    const stop = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : Error('native');
    let active = false, reached = 0, after = 0, error: unknown;
    Object.create = function (prototype: object | null, properties?: PropertyDescriptorMap) {
      const result = properties ? create(prototype, properties) : create(prototype);
      if (prototype !== null) return result;
      active = true; return new Proxy(result, { set(target, key, value) { if (reached) after++; return Reflect.set(target, key, value); } });
    };
    Number.isFinite = function (value) { const result = finite(value); if (active && value === 1 && !reached) { reached++; if (mode === 'abort') signal.abort(); else now = 6000; if (mode === 'ordinary' || mode === 'exceeded' || mode === 'unavailable') throw stop; } return result; };
    try { assignment(b); } catch (e) { error = e; } finally { Object.create = create; Number.isFinite = finite; }
    expect(reached).toBe(1); expect(after).toBe(0); if (mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(stop); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  for (const mode of ['deadline', 'ordinary', 'exceeded', 'unavailable'] as const) it(`private shape freeze exit before registration ${mode}`, () => {
    let now = 0; const b = createBudgetContext({ now: () => now }), freeze = Object.freeze, set = WeakMap.prototype.set;
    const stop = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : Error('native'); let reached = 0, after = 0, error: unknown;
    Object.freeze = function <T>(value: T) { const result = freeze(value); if (value && typeof value === 'object' && 'owner' in value && value.owner === b) { reached++; now = 6000; if (mode !== 'deadline') throw stop; } return result; };
    WeakMap.prototype.set = function (key, value) { if (reached) after++; return set.call(this, key, value); };
    try { assignment(b); } catch (e) { error = e; } finally { Object.freeze = freeze; WeakMap.prototype.set = set; }
    expect(reached).toBe(1); expect(after).toBe(0); if (mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(stop); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});
