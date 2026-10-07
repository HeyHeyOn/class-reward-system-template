import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
type Entry = { tab: string; source: unknown; errors: string[]; refs: unknown[]; canonical: Record<string, unknown>; targets: { record: unknown }[] };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/cancellation-validation-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; raw: unknown[]; cancellationGetters: unknown[] } }[] };
const fixture = (name = 'accepted') => golden.cases.find(c => c.name === `cancellation-${name}`)!;
const admitted = (b: BudgetContext, name = 'accepted') => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: 'work' | 'nodes' | 'slots' | 'structuralBytes', amount: number) { const rest = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(rest); else b.reserve({ [dimension]: rest }); }
let inspecting = false;
function at(name = 'validateTransactionCancellations') { if (inspecting) return false; inspecting = true; const old = Error.stackTraceLimit; Error.stackTraceLimit = 70; try { return new Error().stack?.includes(name) ?? false; } finally { Error.stackTraceLimit = old; inspecting = false; } }

describe('executed original Git cancellation validation oracle', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const entries: Entry[] = [], seen = new Set<Entry>(), set = Map.prototype.set;
    Map.prototype.set = function (key: unknown, value: unknown) { if (Array.isArray(value)) for (const e of value as Entry[]) if (e && e.source && Array.isArray(e.errors) && !seen.has(e)) { seen.add(e); entries.push(e); } return set.call(this, key, value); };
    let result: ReturnType<typeof run>;
    try { result = run(b ? admitted(b, f.name.slice(13)) : structuredClone(f.input), b); } finally { Map.prototype.set = set; }
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(JSON.parse(JSON.stringify(entries.map(e => ({ tab: e.tab, source: e.source, errors: e.errors, refs: e.refs, canonical: e.canonical, targets: e.targets, aliases: e.targets.map(t => t.record === e.canonical) }))))).toEqual(f.outcome.raw);
    for (const e of entries) if (e.canonical) expect(Object.isFrozen(e.canonical)).toBe(false);
    if (f.name === 'cancellation-accepted') expect(result.records.transactions).toHaveLength(2);
  });
});

describe('cancellation native completion through actual caller', () => {
  for (const stage of ['get', 'set', 'filter', 'String', 'parse', 'Number', 'includes', 'push'] as const)
    for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const)
      for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
        let now = 0; const controller = new AbortController();
        const b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
        const name = stage === 'includes' || stage === 'push' ? 'missing-original' : 'accepted';
        const input = b ? admitted(b, name) : structuredClone(fixture(name).input);
        const owner = (stage === 'String' || stage === 'Number' ? globalThis : stage === 'parse' ? Date : stage === 'get' || stage === 'set' ? Map.prototype : Array.prototype) as unknown as Record<string, (...args: unknown[]) => unknown>;
        const native = owner[stage], sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('cancellation native exit');
        let armed = 0, reachedAfter = 0, error: unknown;
        owner[stage] = new Proxy(native, { apply(target, receiver, args) {
          // Filter cheap operands BEFORE stack formatting; native observers may reenter.
          const operand = stage === 'String' ? args[0] === 'TX1' : stage === 'Number' ? args[0] === -20 : stage === 'parse' ? args[0] === '2026-08-31T00:01:00.000Z' : stage === 'includes' || stage === 'push' ? args[0] === 'MALFORMED_CANCELLATION_HISTORY' : stage === 'get' || stage === 'set' ? args[0] === 'TX1' : Array.isArray(receiver) && (receiver[0] as Entry)?.source;
          if ((operand || (armed && (stage === 'parse' || stage === 'Number'))) && at()) { if (armed) reachedAfter++; else { armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; } }
          return Reflect.apply(target, receiver, args);
        } });
        try { run(input, b); } catch (e) { error = e; } finally { owner[stage] = native; }
        expect(armed).toBe(1);
        if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
        else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(reachedAfter).toBe(0); }
        else if (exit === 'ordinary') expect(error).toBe(sentinel); else expect(error).toBeUndefined();
      });
});

describe('cancellation reached cumulative reservations', () => {
  for (const index of [1, 2]) for (const dimension of ['slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`index ${index} bucket ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get, set = Map.prototype.set;
    let visits = 0, armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (typeof key === 'string' && at() && ++visits === (index === 1 ? 1 : 3)) { armed++; leave(b, dimension, (dimension === 'slots' ? 3 : 28) + delta); } return result; };
    Map.prototype.set = function (key: unknown, value: unknown) { if (armed && at()) { reached++; throw new Error('bucket set'); } return set.call(this, key, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Map.prototype.set = set; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const index of [1, 2]) it(`index ${index} lookup exhaustion precedes append`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get, push = Array.prototype.push;
    let visits = 0, armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (typeof key === 'string' && at() && ++visits === (index === 1 ? 1 : 3)) { armed++; leave(b, 'work', 0); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as Entry)?.source && at()) reached++; return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`malformed destination slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'missing-original'), includes = Array.prototype.includes, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (!armed && value === 'MALFORMED_CANCELLATION_HISTORY' && at()) { armed++; leave(b, 'slots', 1 + delta); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'MALFORMED_CANCELLATION_HISTORY' && at()) { reached++; throw new Error('error append'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('ordered date pair precharges second native parse after first exhausts', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), parse = Date.parse;
    let armed = 0, reached = 0, error: unknown;
    Date.parse = function (value: string) { if (value === '2026-08-31T00:01:00.000Z' && at()) { armed++; const result = parse(value); leave(b, 'work', 0); return result; } if (armed && at()) reached++; return parse(value); };
    try { run(input, b); } catch (e) { error = e; } finally { Date.parse = parse; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});


describe('frozen no-context getter evaluation order', () => {
  for (const f of golden.cases) it(f.name, () => {
    const filter = Array.prototype.filter, set = Map.prototype.set, seen = new Set<Entry>(), trace: unknown[] = []; let watching = false;
    Map.prototype.set = function (key: unknown, value: unknown) { if (Array.isArray(value)) for (const e of value as Entry[]) if (e && e.source && Array.isArray(e.errors) && !seen.has(e)) seen.add(e); return set.call(this, key, value); };
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] {
      const result = filter.call(this, cb, receiver) as T[];
      if (!watching && (this[0] as Entry)?.source && at()) {
        watching = true;
        for (const e of result as Entry[]) {
          const sourcePath = (e.source as { path: unknown }).path;
          for (const [object, prefix] of [[e, 'entry'], [e.canonical, 'canonical']] as const) for (const key of Object.keys(object)) {
            const record = object as unknown as Record<string, unknown>, value = record[key];
            Object.defineProperty(object, key, { configurable: true, enumerable: true, get() { if (at()) trace.push([sourcePath, prefix, key]); return value; }, set(next) { Object.defineProperty(object, key, { value: next, writable: true, enumerable: true, configurable: true }); } });
          }
        }
      }
      return result;
    };
    try { run(structuredClone(f.input)); } finally { Array.prototype.filter = filter; Map.prototype.set = set; }
    expect(JSON.parse(JSON.stringify(trace))).toEqual(f.outcome.cancellationGetters);
  });
});

describe('filter and pair scratch reached admission', () => {
  for (const ordinal of [1, 2, 3]) for (const dimension of ['slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`filter ${ordinal} ${dimension} exact${delta}`, () => {
    // Exhaust at the preceding phase/filter exit. This fixture has no Settings;
    // its final missing-Settings diagnostic append arms the initial transaction filter.
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), filter = Array.prototype.filter, get = Map.prototype.get, set = Map.prototype.set, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown, nativeFilters = 0;
    const arm = (length: number) => { armed++; leave(b, dimension, (dimension === 'slots' ? length : 16 + 4 * length) + delta); };
    let totalEntries = 0;
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { const result = push.apply(this, items); if (!armed && ordinal === 1 && (items[0] as { code?: string })?.code === 'INVALID_CLASS_TIME_ZONE_SETTING' && at('validateRequiredSettings')) arm(totalEntries); return result; };
    Map.prototype.set = function (key: unknown, value: unknown) { const result = set.call(this, key, value); if (!armed && ordinal === 2 && key === 'C1' && at()) arm(2); return result; };
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && ordinal === 3 && key === 'TX1' && at() && Array.isArray(result) && result[0]?.canonical?.status === 'CANCELLED') { const original = result[0].canonical; const value = original.balanceBefore; Object.defineProperty(original, 'balanceBefore', { configurable: true, get() { arm(2); return value; } }); } return result; };
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] { if (ordinal === 1 && !totalEntries && (this[0] as Entry)?.source && at('validateRequiredSettings')) totalEntries = this.length; if ((this[0] as Entry)?.source && at()) { nativeFilters++; if (armed && nativeFilters === ordinal) { reached++; throw new Error('filter operand'); } } const result = filter.call(this, cb, receiver) as T[]; return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; Map.prototype.get = get; Map.prototype.set = set; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});


describe('nested cancellation work and scalar boundaries', () => {
  for (const delta of [-1, 0, 1]) it(`date native work exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), NativeString = String, parse = Date.parse;
    let armed = 0, reached = 0, error: unknown;
    globalThis.String = new Proxy(NativeString, { apply(target, receiver, args) { const result = Reflect.apply(target, receiver, args); if (!armed && args[0] === '2026-08-31T00:01:00.000Z' && at()) { armed++; leave(b, 'work', 2 + delta); } return result; } });
    Date.parse = function (value: string) { if (armed && at()) { reached++; throw new Error('date admitted'); } return parse(value); };
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.String = NativeString; Date.parse = parse; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const stage of ['candidate', 'student', 'number', 'errors'] as const) it(`${stage} nested work refusal before next operand`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, stage === 'errors' ? 'second-reversal' : 'accepted'), get = Map.prototype.get, includes = Array.prototype.includes;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) {
      const result = get.call(this, key);
      if (!armed && key === 'TX1' && at() && Array.isArray(result) && result[0]?.canonical?.status === 'CANCELLED') {
        const entry = result[0], record = entry.canonical;
        if (stage === 'candidate') { const value = entry.canonical; Object.defineProperty(entry, 'canonical', { configurable: true, get() { reached++; return value; } }); armed++; leave(b, 'work', 0); }
        else if (stage === 'student') { const value = record.studentId; Object.defineProperty(record, 'studentId', { configurable: true, get() { armed++; leave(b, 'work', 0); return value; } }); const stamp = record.timestamp; Object.defineProperty(record, 'timestamp', { configurable: true, get() { reached++; return stamp; } }); }
        else if (stage === 'number') { const value = record.totalAmount; Object.defineProperty(record, 'totalAmount', { configurable: true, get() { armed++; leave(b, 'work', 0); return value; } }); const balance = record.balanceAfter; Object.defineProperty(record, 'balanceAfter', { configurable: true, get() { reached++; return balance; } }); }
      }
      return result;
    };
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (stage === 'errors' && value === 'MALFORMED_CANCELLATION_HISTORY' && at()) { if (armed) reached++; else { armed++; leave(b, 'work', 0); } } return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.includes = includes; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});


describe('cancellation closed scalar and index containers', () => {
  for (const dimension of ['nodes', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`pair scratch ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && key === 'TX1' && at() && Array.isArray(result) && result[0]?.canonical?.status === 'CANCELLED') {
      const value = result[0].canonical, status = value.status;
      Object.defineProperty(value, 'status', { configurable: true, get() { reached++; throw new Error('pair operand'); } });
      void status; armed++; leave(b, dimension, (dimension === 'nodes' ? 13 : 52) + delta);
    } return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const ordinal of [1, 2]) for (const delta of [-1, 0, 1]) it(`Map ${ordinal} structural exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), filter = Array.prototype.filter, NativeMap = Map;
    let armed = 0, reached = 0, error: unknown, count = 0;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] { const result = filter.call(this, cb, receiver) as T[]; if ((this[0] as Entry)?.source && at() && ++count === ordinal) { armed++; leave(b, 'structuralBytes', 16 + delta); } return result; };
    globalThis.Map = new Proxy(NativeMap, { construct(target, args, receiver) { if (armed && at()) { reached++; throw new Error('map operand'); } return Reflect.construct(target, args, receiver); } });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; globalThis.Map = NativeMap; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});
