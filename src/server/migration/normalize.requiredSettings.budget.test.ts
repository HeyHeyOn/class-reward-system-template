import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as validators from './validators';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
type Entry = { tab: string; source: unknown; errors: string[]; refs: unknown[]; canonical: Record<string, unknown>; targets: { record: unknown }[] };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/required-settings-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; raw: unknown[] } }[] };
const fixture = (name = 'valid') => golden.cases.find(c => c.name === name)!;
const admitted = (b: BudgetContext, name = 'valid') => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: 'work' | 'nodes' | 'slots' | 'structuralBytes' | 'contentBytes', amount: number) { const rest = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(rest); else b.reserve({ [dimension]: rest }); }
let inspecting = false;
function at() { if (inspecting) return false; inspecting = true; const old = Error.stackTraceLimit; Error.stackTraceLimit = 70; try { return new Error().stack?.includes('validateRequiredSettings') ?? false; } finally { Error.stackTraceLimit = old; inspecting = false; } }

describe('original Git no-context Settings getter order', () => {
  const cases = (golden as unknown as { getterCases: { name: string; fail: string; trace: unknown[]; error?: { name: string; message: string }; json?: string }[] }).getterCases;
  for (const f of cases) it(`${f.name} throwing=${f.fail}`, () => {
    const filter = Array.prototype.filter, trace: unknown[] = []; let watching = false, error: { name: string; message: string } | undefined, result: ReturnType<typeof run> | undefined;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] {
      const result = filter.call(this, cb, receiver) as T[];
      if (!watching && (this[0] as Entry)?.source && at()) {
        watching = true;
        for (const e of result as Entry[]) {
          const source = e.source as { tab: string; rowNumber: number }, label = source.tab + ':' + source.rowNumber;
          for (const [object, prefix] of [[e, 'entry'], [e.canonical, 'canonical']] as const) for (const key of Object.keys(object)) {
            const record = object as unknown as Record<string, unknown>, value = record[key];
            Object.defineProperty(object, key, { configurable: true, enumerable: true, get() { if (at()) { trace.push([label, prefix, key]); if (key === f.fail) throw new RangeError('getter ' + f.fail); } return value; }, set(next) { Object.defineProperty(object, key, { value: next, writable: true, enumerable: true, configurable: true }); } });
          }
        }
      }
      return result;
    };
    try { result = run(structuredClone(fixture(f.name).input)); } catch (e) { error = { name: (e as Error).name, message: (e as Error).message }; } finally { Array.prototype.filter = filter; }
    expect(trace).toEqual(f.trace); expect(error).toEqual(f.error); expect(result ? JSON.stringify(result) : undefined).toBe(f.json);
  });
});

describe('executed original Git required Settings oracle', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const entries: Entry[] = [], seen = new Set<Entry>(), set = Map.prototype.set;
    Map.prototype.set = function (key: unknown, value: unknown) { if (Array.isArray(value)) for (const e of value as Entry[]) if (e && e.source && Array.isArray(e.errors) && !seen.has(e)) { seen.add(e); entries.push(e); } return set.call(this, key, value); };
    let result: ReturnType<typeof run>;
    try { result = run(b ? admitted(b, f.name) : structuredClone(f.input), b); } finally { Map.prototype.set = set; }
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(JSON.parse(JSON.stringify(entries.map(e => ({ tab: e.tab, source: e.source, errors: e.errors, refs: e.refs, canonical: e.canonical, targets: e.targets, aliases: e.targets.map(t => t.record === e.canonical) }))))).toEqual(f.outcome.raw);
    for (const e of entries) {
      expect(Object.isFrozen(e.errors)).toBe(false); expect(Object.isFrozen(e.refs)).toBe(false); expect(Object.isFrozen(e.targets)).toBe(false);
      if (e.canonical) {
        expect(Object.isFrozen(e.canonical)).toBe(false);
        if (b && e.tab === 'Settings') expect(() => assertRegisteredBoundedJson(e.canonical, b)).toThrow('Legacy bounded JSON is invalid.');
      }
    }
  });
});

describe('supplemental original Git canonical timezone getter values', () => {
  const cases = (golden as unknown as { valueGetterCases: { value: unknown; armed: boolean; json: string }[] }).valueGetterCases;
  for (const f of cases) for (const guarded of [false, true]) it(`value=${JSON.stringify(f.value)} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined, input = b ? admitted(b) : structuredClone(fixture().input), filter = Array.prototype.filter;
    let armed = false, result: ReturnType<typeof run>;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] {
      const result = filter.call(this, cb, receiver) as T[];
      if (!armed && (this[0] as Entry)?.source && at()) {
        armed = true;
        for (const e of result as Entry[]) if (e.canonical.key === 'classTimeZone') {
          const original = e.canonical.value;
          Object.defineProperty(e.canonical, 'value', { enumerable: true, configurable: true, get() { return at() ? f.value : original; } });
        }
      }
      return result;
    };
    try { result = run(input, b); } finally { Array.prototype.filter = filter; }
    expect(armed).toBe(f.armed); expect(armed).toBe(true); expect(JSON.stringify(result)).toBe(f.json);
  });
});

describe('required Settings reached native completion', () => {
  for (const stage of ['filter', 'String', 'trim', 'test', 'DateTimeFormat', 'resolvedOptions'] as const)
    for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const)
      for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
        let now = 0; const controller = new AbortController();
        const b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
        const input = b ? admitted(b) : structuredClone(fixture().input);
        const owner = (stage === 'filter' ? Array.prototype : stage === 'String' ? globalThis : stage === 'trim' ? String.prototype : stage === 'test' ? RegExp.prototype : stage === 'DateTimeFormat' ? Intl : Intl.DateTimeFormat.prototype) as unknown as Record<string, (...args: unknown[]) => unknown>;
        const native = owner[stage], sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('Settings native exit');
        let reached = 0, later = 0, error: unknown;
        function observe(receiver: unknown, args: unknown[]) {
          const operand = stage === 'filter' ? Array.isArray(receiver) && (receiver[0] as Entry)?.source : stage === 'String' ? args[0] === 3 : stage === 'trim' ? receiver === 'Asia/Seoul' : stage === 'test' ? args[0] === 'Asia/Seoul' : stage === 'DateTimeFormat' ? args[0] === 'en-US' && (args[1] as { timeZone?: unknown })?.timeZone === 'Asia/Seoul' : true;
          if (!operand || !at()) return;
          if (reached) { later++; return; }
          reached++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel;
        }
        owner[stage] = new Proxy(native, { apply(target, receiver, args) { observe(receiver, args); return Reflect.apply(target, receiver, args); }, construct(target, args, newTarget) { observe(undefined, args); return Reflect.construct(target, args, newTarget); } });
        try { run(input, b); } catch (e) { error = e; } finally { owner[stage] = native; }
        expect(reached).toBe(1);
        const caught = stage === 'DateTimeFormat' || stage === 'resolvedOptions';
        if (state === 'unbounded' && caught) expect(error).toBeUndefined();
        else if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
        else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(later).toBe(0); }
        else if (exit === 'ordinary' && !caught) expect(error).toBe(sentinel); else expect(error).toBeUndefined();
      });
});

describe('required Settings cumulative work and list admission', () => {
  for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`matched filter ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), filter = Array.prototype.filter;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] {
      if ((this[0] as Entry)?.source && at()) {
        if (armed) { reached++; throw new Error('matched filter entered'); }
        const result = filter.call(this, cb, receiver) as T[]; armed++;
        leave(b, dimension, (dimension === 'nodes' ? 1 : dimension === 'slots' ? result.length : 16 + 4 * result.length) + delta); return result;
      }
      return filter.call(this, cb, receiver) as T[];
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const stage of ['filter', 'trim', 'test'] as const) it(`${stage} completion exhaustion prevents next native`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const filter = Array.prototype.filter, trim = String.prototype.trim, test = RegExp.prototype.test, format = Intl.DateTimeFormat;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] { if (stage === 'filter' && (this[0] as Entry)?.source && at()) { if (armed) reached++; else { const result = filter.call(this, cb, receiver) as T[]; armed++; leave(b, 'work', 0); return result; } } return filter.call(this, cb, receiver) as T[]; };
    String.prototype.trim = function () { const result = trim.call(this); if (stage === 'trim' && this === 'Asia/Seoul' && at()) { armed++; leave(b, 'work', 0); } return result; };
    RegExp.prototype.test = function (value: string) { if (value === 'Asia/Seoul' && at()) { if (stage === 'trim' && armed) reached++; if (stage === 'test') { const result = test.call(this, value); armed++; leave(b, 'work', 0); return result; } } return test.call(this, value); };
    Intl.DateTimeFormat = new Proxy(format, { construct(target, args, newTarget) { if (stage === 'test' && armed && args[0] === 'en-US' && at()) reached++; return Reflect.construct(target, args, newTarget); } });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; String.prototype.trim = trim; RegExp.prototype.test = test; Intl.DateTimeFormat = format; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`matched error ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'duplicate-schemaVersion'), filter = Array.prototype.filter, push = Array.prototype.push;
    let armed = 0, reached = 0, ordinal = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] { const result = filter.call(this, cb, receiver) as T[]; if ((this[0] as Entry)?.source && at() && ++ordinal === 2) { armed++; leave(b, dimension, (dimension === 'structuralBytes' ? 8 : 1) + delta); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'INVALID_SCHEMA_VERSION_SETTING' && at()) { reached++; throw new Error('matched error entered'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});


describe('required missing diagnostic pre-admission', () => {
  for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`path and diagnostic ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'missing-schemaVersion'), filter = Array.prototype.filter, hash = validators.sha256;
    let ordinal = 0, armed = 0, reached = 0, owner: BudgetContext | undefined, error: unknown;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] { const result = filter.call(this, cb, receiver) as T[]; if ((this[0] as Entry)?.source && at() && ++ordinal === 2) { armed++; leave(b, dimension, (dimension === 'nodes' ? 6 : dimension === 'slots' ? 5 : 68) + delta); } return result; };
    const spy = vi.spyOn(validators, 'sha256').mockImplementation((value, budget) => { if (armed && at()) { reached++; owner = budget; throw new Error('missing diagnostic hash'); } return hash(value, budget); });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; spy.mockRestore(); }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(owner).toBe(b);
  });
});

describe('required scalar copy pre-admission', () => {
  for (const stage of ['schema', 'timezone'] as const) for (const dimension of ['nodes', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`${stage} ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), filter = Array.prototype.filter, stringify = globalThis.String, trim = String.prototype.trim;
    let ordinal = 0, armed = 0, reached = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], cb: (value: T, index: number, array: T[]) => unknown, receiver?: unknown): T[] {
      const result = filter.call(this, cb, receiver) as T[];
      if ((this[0] as Entry)?.source && at() && ++ordinal === (stage === 'schema' ? 2 : 3)) {
        armed++; leave(b, dimension, (dimension === 'nodes' ? 1 : dimension === 'work' ? (stage === 'schema' ? 4 : 6) : 4) + delta);
      }
      return result;
    };
    globalThis.String = new Proxy(stringify, { apply(target, receiver, args) { if (stage === 'schema' && armed && args[0] === 3 && at()) { reached++; throw new Error('schema String'); } return Reflect.apply(target, receiver, args); } });
    String.prototype.trim = function () { if (stage === 'timezone' && armed && this === 'Asia/Seoul' && at()) { reached++; throw new Error('timezone trim'); } return trim.call(this); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; globalThis.String = stringify; String.prototype.trim = trim; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('required timezone native scratch pre-admission', () => {
  for (const boundary of ['format', 'resolved'] as const) for (const dimension of ['nodes', 'slots', 'structuralBytes', 'contentBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`${boundary} ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), test = RegExp.prototype.test, format = Intl.DateTimeFormat, resolved = format.prototype.resolvedOptions;
    let armed = 0, reached = 0, error: unknown;
    const allowance = dimension === 'work' ? (boundary === 'format' ? 3 : 1) : boundary === 'format' ? (dimension === 'nodes' ? 3 : dimension === 'slots' ? 1 : dimension === 'contentBytes' ? 8 : 52) : (dimension === 'nodes' ? 15 : dimension === 'slots' ? 11 : dimension === 'contentBytes' ? 49 : 116);
    RegExp.prototype.test = function (value: string) { const result = test.call(this, value); if (boundary === 'format' && value === 'Asia/Seoul' && at()) { armed++; leave(b, dimension, allowance + delta); } return result; };
    Intl.DateTimeFormat = new Proxy(format, { construct(target, args, newTarget) {
      if (args[0] === 'en-US' && at()) {
        if (boundary === 'format' && armed) { reached++; throw new Error('format entered'); }
        const result = Reflect.construct(target, args, newTarget); if (boundary === 'resolved') { armed++; leave(b, dimension, allowance + delta); } return result;
      }
      return Reflect.construct(target, args, newTarget);
    } });
    format.prototype.resolvedOptions = function () { if (boundary === 'resolved' && armed && at()) { reached++; throw new Error('resolved entered'); } return resolved.call(this); };
    try { run(input, b); } catch (e) { error = e; } finally { RegExp.prototype.test = test; Intl.DateTimeFormat = format; format.prototype.resolvedOptions = resolved; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const stage of ['trim', 'test', 'format', 'resolved'] as const) for (const ordinary of [false, true]) it(`${stage} deadline exit refuses the next semantic/native operand ordinary=${ordinary}`, () => {
    let now = 0;
    const b = createBudgetContext({ now: () => now }), input = admitted(b), trim = String.prototype.trim, test = RegExp.prototype.test, format = Intl.DateTimeFormat, resolved = format.prototype.resolvedOptions, push = Array.prototype.push;
    let armed = 0, later = 0, error: unknown;
    function arm() { armed++; now = 6000; if (ordinary) throw new RangeError('late native'); }
    String.prototype.trim = function () { if (this === 'Asia/Seoul' && at() && stage === 'trim') arm(); return trim.call(this); };
    RegExp.prototype.test = function (value: string) { if (value === 'Asia/Seoul' && at()) { if (armed) later++; if (stage === 'test') arm(); } return test.call(this, value); };
    Intl.DateTimeFormat = new Proxy(format, { construct(target, args, newTarget) { if (args[0] === 'en-US' && at()) { if (armed) later++; if (stage === 'format') arm(); } return Reflect.construct(target, args, newTarget); } });
    format.prototype.resolvedOptions = function () { if (at()) { if (armed) later++; if (stage === 'resolved') arm(); } return resolved.call(this); };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'INVALID_CLASS_TIME_ZONE_SETTING' && at()) later++; return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { String.prototype.trim = trim; RegExp.prototype.test = test; Intl.DateTimeFormat = format; format.prototype.resolvedOptions = resolved; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(later).toBe(0); expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});
