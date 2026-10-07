import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
type Entry = { tab: string; source: unknown; errors: string[]; refs: unknown[]; canonical: unknown; targets: { record: unknown }[] };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/global-index-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; raw: unknown[] } }[] };
const fixture = (name: string) => golden.cases.find(c => c.name === name)!;
const admitted = (b: BudgetContext, name = 'accepted') => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: 'work' | 'slots' | 'structuralBytes' | 'contentBytes', amount: number) { const rest = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(rest); else b.reserve({ [dimension]: rest }); }
let inspecting = false;
function at(name: string) { if (inspecting) return false; inspecting = true; const old = Error.stackTraceLimit; Error.stackTraceLimit = 70; try { return new Error().stack?.includes(name) ?? false; } finally { Error.stackTraceLimit = old; inspecting = false; } }
afterEach(() => vi.restoreAllMocks());

describe('executed original Git global duplicate/adjustment/cancellation oracle', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = b ? admitted(b, f.name) : structuredClone(f.input);
    const entries: Entry[] = [], seen = new Set<Entry>(), set = Map.prototype.set;
    Map.prototype.set = function (key: unknown, value: unknown) {
      if (Array.isArray(value)) for (const e of value as Entry[]) if (e && e.source && Array.isArray(e.errors) && !seen.has(e)) { seen.add(e); entries.push(e); }
      return set.call(this, key, value);
    };
    let result: ReturnType<typeof run>;
    try { result = run(input, b); } finally { Map.prototype.set = set; }
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    expect(JSON.parse(JSON.stringify(entries.map(e => ({ tab: e.tab, source: e.source, errors: e.errors, refs: e.refs, canonical: e.canonical, targets: e.targets, aliases: e.targets.map(t => t.record === e.canonical) }))))).toEqual(f.outcome.raw);
    for (const e of entries) if (e.canonical) expect(Object.isFrozen(e.canonical)).toBe(false);
    if (f.name === 'accepted') expect(result.records.adjustments).toHaveLength(1);
    if (f.name === 'cancellation-accepted') expect(result.records.transactions).toHaveLength(2);
  });
});

describe('reached duplicate index reservations and nested work', () => {
  for (const delta of [-1, 0, 1]) it(`first index container structural bytes exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), each = Set.prototype.forEach, NativeMap = Map;
    let armed = 0, reached = 0, error: unknown;
    Set.prototype.forEach = function (callback, thisArg) { const result = each.call(this, callback, thisArg); if (!armed && at('normalizeLegacySnapshots') && !at('normalizeClaims')) { armed++; leave(b, 'structuralBytes', 16 + delta); } return result; };
    globalThis.Map = new Proxy(NativeMap, { construct(target, args, receiver) { if (armed && at('markDuplicates')) { reached++; throw new Error('Map allocation sentinel'); } return Reflect.construct(target, args, receiver); } });
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.Map = NativeMap; Set.prototype.forEach = each; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`bucket append plus Map entry slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get, set = Map.prototype.set;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && at('markDuplicates') && typeof key === 'string' && key.includes('\0')) { armed++; leave(b, 'slots', 3 + delta); } return result; };
    Map.prototype.set = function (key: unknown, value: unknown) { if (armed && at('markDuplicates')) { reached++; throw new Error('Map entry sentinel'); } return set.call(this, key, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Map.prototype.set = set; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('exhausted first group lookup refuses before bucket append', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && at('markDuplicates') && typeof key === 'string' && key.includes('\0')) { armed++; leave(b, 'work', 0); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as Entry)?.source && at('markDuplicates')) reached++; return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`duplicate error occurrence slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'duplicate-student'), has = Set.prototype.has, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    Set.prototype.has = function (value: unknown) { const result = has.call(this, value); if (!armed && value === 'Students' && at('markDuplicates')) { armed++; leave(b, 'slots', 1 + delta); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'DUPLICATE_PRIMARY_ID' && at('markDuplicates')) { reached++; throw new Error('error append sentinel'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Set.prototype.has = has; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('each filter predicate checks cumulative work before its next Entry getter', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), filter = Array.prototype.filter;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T[] {
      const selected = !armed && at('markDuplicates');
      if (selected) { const e = this[1] as Entry, tab = e.tab; Object.defineProperty(e, 'tab', { configurable: true, get: () => { if (armed) reached++; return tab; } }); }
      return filter.call(this, (value: T, i: number, array: T[]) => { const result = callback.call(thisArg, value, i, array); if (selected && !armed) { armed++; leave(b, 'work', 0); } return result; }) as T[];
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('business-group native lookup is owned by the same exhausted context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'duplicate-task'), get = Map.prototype.get, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && at('markBusinessDuplicate')) { armed++; leave(b, 'work', 0); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as Entry)?.source && at('markBusinessDuplicate')) reached++; return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('duplicate key and filter scratch precreation', () => {
  for (const delta of [-1, 0, 1]) it(`first native string key content bytes exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), NativeMap = Map, get = Map.prototype.get;
    let armed = 0, reached = 0, error: unknown;
    const key = 'products\0P1';
    globalThis.Map = new Proxy(NativeMap, { construct(target, args, receiver) { const result = Reflect.construct(target, args, receiver); if (!armed && at('markDuplicates')) { armed++; leave(b, 'contentBytes', Buffer.byteLength(key) + delta); } return result; } });
    Map.prototype.get = function (value: unknown) { if (armed && value === key && at('markDuplicates')) { reached++; throw new Error('key lookup sentinel'); } return get.call(this, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; globalThis.Map = NativeMap; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`values projection plus first filter slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), set = Map.prototype.set, filter = Array.prototype.filter;
    const raw = fixture('accepted').outcome.raw as { tab: string; targets: { table: string; id: string }[] }[];
    const last = raw.filter(e => e.tab === 'Transactions').at(-1)!.targets.at(-1)!;
    const key = `${last.table}\0${last.id}`, entries = Object.values(input.sheets.tabs).reduce((n, t) => n + t.rows.length, 0);
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.set = function (value: unknown, group: unknown) { const result = set.call(this, value, group); if (!armed && value === key && at('markDuplicates')) { armed++; leave(b, 'slots', this.size + entries + delta); } return result; };
    Array.prototype.filter = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T[] { if (armed && at('markDuplicates')) { reached++; throw new Error('filter allocation sentinel'); } return filter.call(this, callback, thisArg) as T[]; };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.set = set; Array.prototype.filter = filter; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('frozen no-budget duplicate getter order', () => {
  it('looks up the error destination before the financial predicate ordinary error', () => {
    const input = structuredClone(fixture('duplicate-student').input), set = Map.prototype.set, has = Set.prototype.has;
    const seen = new WeakSet<Entry>(), trace: string[] = [], sentinel = new RangeError('financial predicate sentinel');
    let error: unknown;
    Map.prototype.set = function (key: unknown, value: unknown) { if (key === 'students\0S1' && Array.isArray(value)) for (const e of value as Entry[]) if (!seen.has(e)) { seen.add(e); const errors = e.errors; Object.defineProperty(e, 'errors', { configurable: true, get: () => { trace.push('errors'); return errors; } }); } return set.call(this, key, value); };
    Set.prototype.has = function (value: unknown) { if (value === 'Students' && at('markDuplicates')) { trace.push('financial'); throw sentinel; } return has.call(this, value); };
    try { run(input); } catch (e) { error = e; } finally { Map.prototype.set = set; Set.prototype.has = has; }
    // Executed original-Git oracle-getter.cjs: errors, financial; same exception.
    expect(trace).toEqual(['errors', 'financial']); expect(error).toBe(sentinel);
  });
});

describe('duplicate native exit and exact error identity', () => {
  for (const stage of ['get', 'set', 'filter', 'push'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController();
    const b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b, 'duplicate-student') : structuredClone(fixture('duplicate-student').input);
    const owner = (stage === 'get' || stage === 'set' ? Map.prototype : Array.prototype) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const native = owner[stage], sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('duplicate native exit');
    let armed = 0, reachedAfter = 0, error: unknown;
    owner[stage] = function (this: unknown, ...args: unknown[]) {
      const selected = (stage === 'push' ? args[0] === 'DUPLICATE_PRIMARY_ID' : stage === 'filter' ? Array.isArray(this) && !!(this[0] as Entry)?.tab : typeof args[0] === 'string' && args[0].includes('\0')) && at('markDuplicates');
      if (selected) { if (armed) reachedAfter++; else { armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; } }
      return native.apply(this, args);
    };
    try { run(input, b); } catch (e) { error = e; } finally { owner[stage] = native; }
    expect(armed).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(reachedAfter).toBe(0); }
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else { expect(error).toBeUndefined(); expect(reachedAfter).toBeGreaterThan(0); }
  });
});
