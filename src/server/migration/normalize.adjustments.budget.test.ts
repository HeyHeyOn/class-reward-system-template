import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as semantic from './semanticValidators';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
type Entry = { tab: string; source: unknown; errors: string[]; refs: unknown[]; canonical: unknown; targets: { record: unknown }[] };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/adjustment-correlation-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; raw: unknown[] } }[] };
const fixture = (name: string) => golden.cases.find(c => c.name === name)!;
const admitted = (b: BudgetContext, name = 'accepted') => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: 'work' | 'slots' | 'structuralBytes' | 'contentBytes', amount: number) { const rest = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(rest); else b.reserve({ [dimension]: rest }); }
let inspecting = false;
function at(name: string) { if (inspecting) return false; inspecting = true; const old = Error.stackTraceLimit; Error.stackTraceLimit = 70; try { return new Error().stack?.includes(name) ?? false; } finally { Error.stackTraceLimit = old; inspecting = false; } }
afterEach(() => vi.restoreAllMocks());

describe('executed original Git adjustment correlation oracle', () => {
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


describe('reached correlation work and allocation admission', () => {
  for (const delta of [-1, 0, 1]) it(`bucket and map entry slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get, set = Map.prototype.set;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && at('correlateAdjustments')) { armed++; leave(b, 'slots', 3 + delta); } return result; };
    Map.prototype.set = function (key: unknown, value: unknown) { if (armed && at('correlateAdjustments')) { reached++; throw new Error('bucket sentinel'); } return set.call(this, key, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Map.prototype.set = set; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('lookup exhaustion refuses before the next bucket append', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && at('correlateAdjustments')) { armed++; leave(b, 'work', 0); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as Entry)?.source && at('correlateAdjustments')) reached++; return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});
describe('correlation native completion and original budget error identity', () => {
  for (const stage of ['get', 'set', 'keys', 'push'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController();
    const b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b, 'duplicate-linked-adjustment') : structuredClone(fixture('duplicate-linked-adjustment').input);
    const owner = (stage === 'push' ? Array.prototype : Map.prototype) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const native = owner[stage], sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('correlation native exit');
    let armed = 0, reachedAfter = 0, error: unknown;
    owner[stage] = function (this: unknown, ...args: unknown[]) {
      const selected = (stage !== 'push' || args[0] === 'AMBIGUOUS_ADJUSTMENT_TRANSACTION') && at('correlateAdjustments');
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

describe('key callers receive detached same-request immutable inputs', () => {
  for (const method of ['adjustmentKey', 'adjustmentTransactionKey'] as const) it(method, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), native = semantic[method];
    let reached = 0;
    vi.spyOn(semantic, method).mockImplementation((value, owner) => {
      reached++; expect(owner).toBe(b); expect(Object.isFrozen(value)).toBe(true);
      assertRegisteredBoundedJson(value, b);
      return native(value, owner);
    });
    expect(run(input, b).records.adjustments).toHaveLength(1); expect(reached).toBe(1);
  });
});

describe('reached correlation linking and occurrence capacities', () => {
  for (const delta of [-1, 0, 1]) it(`resolved transactionId property slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get;
    let visits = 0, armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) {
      const result = get.call(this, key);
      if (at('correlateAdjustments') && ++visits === 4) {
        const record = result[0].canonical; Object.defineProperty(record, 'transactionId', { configurable: true, get: () => { reached++; throw new Error('transactionId operand'); } });
        armed++; leave(b, 'slots', 1 + delta);
      }
      return result;
    };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`resolved Ref and destination slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), NativeString = String, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    globalThis.String = new Proxy(NativeString, { apply(target, receiver, args) { const result = Reflect.apply(target, receiver, args); if (!armed && args[0] === 'TX-ADJ1' && at('correlateAdjustments')) { armed++; leave(b, 'slots', 4 + delta); } return result; } });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as { code?: string })?.code === 'BROKEN_TRANSACTION_REFERENCE' && at('correlateAdjustments')) { reached++; throw new Error('Ref append'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.String = NativeString; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`Target record and destination slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), push = Array.prototype.push, set = Map.prototype.set;
    let adjustment: Record<string, unknown> | undefined, armed = 0, reached = 0, error: unknown;
    Map.prototype.set = function (key: unknown, value: unknown) { if (at('correlateAdjustments') && Array.isArray(value) && value[0]?.tab === 'Adjustments') adjustment = value[0].canonical; return set.call(this, key, value); };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      const result = push.apply(this, items);
      if (!armed && (items[0] as { code?: string })?.code === 'BROKEN_TRANSACTION_REFERENCE' && at('correlateAdjustments')) {
        Object.defineProperty(adjustment!, 'adjustmentId', { configurable: true, get: () => { reached++; throw new Error('Target first operand'); } });
        armed++; leave(b, 'slots', 11 + delta);
      }
      return result;
    };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.set = set; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`malformed error occurrence slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'malformed-item'), native = semantic.adjustmentTransactionKey, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    vi.spyOn(semantic, 'adjustmentTransactionKey').mockImplementation((value, owner) => { const result = native(value, owner); expect(result).toBeNull(); armed++; leave(b, 'slots', 1 + delta); return result; });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'MALFORMED_REQUIRED_HISTORY' && at('correlateAdjustments')) { reached++; throw new Error('malformed append'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('correlation outer, temporary and union boundaries', () => {
  for (const delta of [-1, 0, 1]) it(`first index structural bytes exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), filter = Array.prototype.filter, NativeMap = Map;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T[] {
      const result = filter.call(this, callback, thisArg) as T[];
      if (!armed && at('validateTransactionCancellations') && callback.toString().includes('CANCELLED')) { armed++; leave(b, 'structuralBytes', 16 + delta); }
      return result;
    };
    globalThis.Map = new Proxy(NativeMap, { construct(target, args, receiver) { if (armed && at('correlateAdjustments')) { reached++; throw new Error('first Map'); } return Reflect.construct(target, args, receiver); } });
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.Map = NativeMap; Array.prototype.filter = filter; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('first index exhausts work before the first outer Entry getter', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), NativeMap = Map, set = Map.prototype.set;
    let first: Entry | undefined, armed = 0, reached = 0, error: unknown;
    Map.prototype.set = function (key: unknown, value: unknown) { if (!first && Array.isArray(value) && value[0]?.source) first = value[0]; return set.call(this, key, value); };
    globalThis.Map = new Proxy(NativeMap, { construct(target, args, receiver) {
      const result = Reflect.construct(target, args, receiver);
      if (!armed && at('correlateAdjustments')) { const tab = first!.tab; Object.defineProperty(first!, 'tab', { configurable: true, get: () => { reached++; return tab; } }); armed++; leave(b, 'work', 0); }
      return result;
    } });
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.Map = NativeMap; Map.prototype.set = set; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`key iterators union and Set slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), set = Map.prototype.set, keys = Map.prototype.keys;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.set = function (key: unknown, value: unknown) { const result = set.call(this, key, value); if (!armed && at('correlateAdjustments') && Array.isArray(value) && value[0]?.tab === 'Adjustments') { armed++; leave(b, 'slots', 6 + delta); } return result; };
    Map.prototype.keys = function () { if (armed && at('correlateAdjustments')) { reached++; throw new Error('keys scratch'); } return keys.call(this); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.set = set; Map.prototype.keys = keys; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const name of ['duplicate-linked-adjustment', 'pair-errors']) for (const delta of [-1, 0, 1]) it(`${name} implicated temporary slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), get = Map.prototype.get;
    let armed = 0, reached = 0, visits = 0, error: unknown, adjustment: Entry | undefined;
    const last = name === 'pair-errors' ? 4 : 5, slots = name === 'pair-errors' ? 2 : 3;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (at('correlateAdjustments')) {
      visits++; if (visits === last - 1) adjustment = result[0];
      if (visits === last) {
        // Pair branch reads errors.length before constructing the two-element list.
        const errors = adjustment!.errors; let reads = 0;
        Object.defineProperty(adjustment!, 'errors', { configurable: true, get: () => { if (name === 'pair-errors' && reads++ === 0) return errors; reached++; throw new Error('implicated operand'); } });
        armed++; leave(b, 'slots', slots + delta);
      }
    } return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`ambiguous occurrence slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'duplicate-linked-adjustment'), get = Map.prototype.get, push = Array.prototype.push;
    let visits = 0, armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (at('correlateAdjustments') && ++visits === 4) {
      const errors = result[0].errors;
      Object.defineProperty(result[0], 'errors', { configurable: true, get: () => { if (!armed) { armed++; leave(b, 'slots', 1 + delta); } return errors; } });
    } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'AMBIGUOUS_ADJUSTMENT_TRANSACTION' && at('correlateAdjustments')) { reached++; throw new Error('ambiguous append'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});
describe('executed original key getter order', () => {
  for (const f of golden.cases) it(f.name, () => {
    const getters: { name: string; trace: string[] }[] = [];
    for (const name of ['adjustmentKey', 'adjustmentTransactionKey'] as const) {
      const original = semantic[name];
      vi.spyOn(semantic, name).mockImplementation((value, budget) => {
        const trace: string[] = []; getters.push({ name, trace });
        function wrap(value: unknown, path = ''): unknown { return value && typeof value === 'object' ? new Proxy(value, { get(target, key, receiver) {
          trace.push(path + String(key)); const result = Reflect.get(target, key, receiver);
          return key === 'items' || path.startsWith('items.') ? wrap(result, path + String(key) + '.') : result;
        } }) : value; }
        return original(wrap(value) as Record<string, unknown>, budget);
      });
    }
    run(structuredClone(f.input));
    expect(getters).toEqual((f.outcome as typeof f.outcome & { getters: unknown }).getters);
  });
});

describe('same-request scalar native completion before later correlation emissions', () => {
  for (const stage of ['transactionString', 'targetString', 'integer'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController();
    const b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b) : structuredClone(fixture('accepted').input);
    const NativeString = String, integer = Number.isSafeInteger, push = Array.prototype.push;
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('scalar native');
    let armed = 0, reachedAfter = 0, error: unknown;
    function hit() { armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; }
    globalThis.String = new Proxy(NativeString, { apply(target, receiver, args) {
      if (!armed && stage !== 'integer' && args[0] === (stage === 'transactionString' ? 'TX-ADJ1' : 'ADJ1') && at('correlateAdjustments')) hit();
      return Reflect.apply(target, receiver, args);
    } });
    Number.isSafeInteger = function (value: unknown) { if (stage === 'integer' && (value === -10 || (armed > 0 && value === 80)) && at('adjustmentTransactionKey')) { if (!armed && value === -10) hit(); else if (armed && value === 80) reachedAfter++; } return integer(value); };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && at('correlateAdjustments') && ((items[0] as { table?: string })?.table === 'adjustments' || (items[0] as { code?: string })?.code === 'BROKEN_TRANSACTION_REFERENCE')) reachedAfter++; return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.String = NativeString; Number.isSafeInteger = integer; Array.prototype.push = push; }
    expect(armed).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(reachedAfter).toBe(0); }
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else { expect(error).toBeUndefined(); expect(reachedAfter).toBeGreaterThan(0); }
  });
});
describe('actual first outer visit work threshold', () => {
  for (const delta of [-1, 0, 1]) it(`work exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), NativeMap = Map, push = Array.prototype.push;
    let first: Entry | undefined, armed = 0, reached = 0, error: unknown;
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (!first && (items[0] as Entry)?.source && (items[0] as Entry)?.tab) first = items[0] as Entry; return push.apply(this, items); };
    globalThis.Map = new Proxy(NativeMap, { construct(target, args, receiver) {
      const result = Reflect.construct(target, args, receiver);
      if (!armed && at('correlateAdjustments')) { Object.defineProperty(first!, 'tab', { configurable: true, get: () => { reached++; throw new Error('first Entry getter'); } }); armed++; leave(b, 'work', 1 + delta); }
      return result;
    } });
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.Map = NativeMap; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('key-input shell and nested error-scan boundaries', () => {
  for (const method of ['transaction', 'adjustment'] as const) for (const delta of [-1, 0, 1]) it(`${method} detached key-input shell slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), push = Array.prototype.push;
    const original = semantic.adjustmentTransactionKey;
    let phase = false, installed = false, armed = 0, reached = 0, error: unknown;
    vi.spyOn(semantic, 'adjustmentTransactionKey').mockImplementation((value, owner) => { const result = original(value, owner); phase = true; return result; });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      const e = items[0] as Entry & { canonical: Record<string, unknown> };
      if (!installed && e?.source && e.canonical && ((method === 'transaction' && e.tab === 'Transactions' && e.canonical.status === 'ADMIN_ADJUSTMENT') || (method === 'adjustment' && e.tab === 'Adjustments'))) {
        installed = true; const target: Record<string, unknown> = method === 'transaction' ? e.canonical : e, key = method === 'transaction' ? 'status' : 'tab', value = target[key];
        Object.defineProperty(target, key, { configurable: true, get: () => {
          if (!armed && (method === 'transaction' || phase) && at('correlateAdjustments')) {
            Object.defineProperty(e.canonical, 'timestamp', { configurable: true, get: () => { reached++; throw new Error('key-input first operand'); } });
            armed++; leave(b, 'slots', (method === 'transaction' ? 14 : 11) + delta);
          }
          return value;
        } });
      }
      return push.apply(this, items);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(installed).toBe(true); expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`error string comparison and next inner visit work exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'duplicate-linked-adjustment'), get = Map.prototype.get;
    let visits = 0, armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (at('correlateAdjustments') && ++visits === 4) {
      const errors = ['x', 'y'];
      Object.defineProperty(errors, '0', { get: () => { if (!armed) { armed++; leave(b, 'work', 4 + delta); } return 'x'; } });
      Object.defineProperty(errors, '1', { get: () => { reached++; throw new Error('second error getter'); } }); result[0].errors = errors;
    } return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const method of ['adjustmentKey', 'adjustmentTransactionKey'] as const) it(`${method} refuses exhausted cumulative work before returning an encoded key`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), native = semantic[method];
    let armed = 0, encoded = 0, error: unknown;
    vi.spyOn(semantic, method).mockImplementation((value, owner) => { armed++; leave(b, 'work', 0); const result = native(value, owner); if (result) encoded++; return result; });
    try { run(input, b); } catch (e) { error = e; }
    expect(armed).toBe(1); expect(encoded).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('error destination and resolved canonical getter ordering', () => {
  for (const delta of [-1, 0, 1]) it(`reserves error destination before its getter exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'duplicate-linked-adjustment'), get = Map.prototype.get;
    let visits = 0, armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (at('correlateAdjustments') && ++visits === 4) {
      const errors = result[0].errors;
      Object.defineProperty(result[0], 'errors', { configurable: true, get: () => {
        if (!armed) { armed++; leave(b, 'slots', 1 + delta); return errors; }
        reached++; throw new Error('error destination getter');
      } });
    } return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`canonical getter ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController();
    const b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b) : structuredClone(fixture('accepted').input), NativeString = String, set = Map.prototype.set;
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('canonical getter');
    let entry: Entry | undefined, armed = 0, reached = 0, writes = 0, error: unknown;
    Map.prototype.set = function (key: unknown, value: unknown) { if (at('correlateAdjustments') && Array.isArray(value) && value[0]?.tab === 'Adjustments') entry = value[0]; return set.call(this, key, value); };
    globalThis.String = new Proxy(NativeString, { apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (!armed && args[0] === 'TX-ADJ1' && at('correlateAdjustments')) {
        armed++; const canonical = entry!.canonical as Record<string, unknown>;
        Object.defineProperty(canonical, 'transactionId', { configurable: true, set: () => { writes++; } });
        Object.defineProperty(entry!, 'canonical', { configurable: true, get: () => {
          if (at('correlateAdjustments')) { reached++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; }
          return canonical;
        } });
      }
      return result;
    } });
    try { run(input, b); } catch (e) { error = e; } finally { globalThis.String = NativeString; Map.prototype.set = set; }
    expect(armed).toBe(1); expect(reached).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(writes).toBe(0); }
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else { expect(error).toBeUndefined(); expect(writes).toBe(1); }
  });
});
