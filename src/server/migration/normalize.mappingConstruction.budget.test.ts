/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-this-alias -- Native receiver identity is the observed contract. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as outputModule from './normalizationOutput';
import { normalizeLegacySnapshots as run } from './normalize';

// ORACLE_OBSERVER_BEGIN
function observe(normalize: (input: any) => any, input: any, hooked = true, probe?: string) {
  const push = Array.prototype.push, set = Map.prototype.set;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!;
  const entries: any[] = [], received: any[] = [], mappings: any[] = [], trace: string[] = [];
  const seen = new Set<any>();
  let armed = false, mappingReceiver: any, entryReceiver: any, error: any, result: any;
  const stop = new RangeError('mapping getter');
  function remember(e: any) {
    if (e && Array.isArray(e.errors) && Array.isArray(e.targets) && e.source && !seen.has(e)) {
      seen.add(e); push.call(entries, e);
    }
  }
  function getter(object: any, key: string, name: string) {
    const value = object[key];
    Object.defineProperty(object, key, { configurable: true, get() {
      push.call(trace, name); if (probe === name) throw stop; return value;
    } });
  }
  function wrapped(this: any[], ...items: any[]) {
    if (armed && items[0]?.status === 'STAGED' && 'sourceDigest' in items[0]) {
      push.call(trace, 'push'); mappingReceiver = this;
      if (probe) throw stop;
    }
    if (hooked) for (const e of items) {
      remember(e);
      if (!entryReceiver && seen.has(e) && e.source.kind === 'SHEET') entryReceiver = this;
      if (this === entryReceiver && seen.has(e)) push.call(received, entries.indexOf(e));
      if (e?.status === 'STAGED' && 'sourceDigest' in e) push.call(mappings, { ...e });
    }
    const value = push.apply(this, items);
    if (probe && !armed) {
      const e = entries.find(e => e.tab === 'Students' && e.targets[0] === items[0] && this !== e.targets);
      if (e) {
        const source = e.source, target = items[0], digestKey = source.kind === 'SHEET' ? 'rowHash' : 'sourceDigest';
        getter(e, 'source', 'source'); getter(source, 'kind', 'kind');
        getter(source, digestKey, 'digest');
        getter(target, 'table', 'table'); getter(target, 'id', 'id');
        trace.length = 0; armed = true;
      }
    }
    return value;
  }
  try {
    Object.defineProperty(Array.prototype, 'push', { configurable: true, get() {
      if (armed && probe) push.call(trace, 'pushLookup'); return wrapped;
    } });
    Map.prototype.set = function(k: any, v: any) {
      if (hooked && Array.isArray(v)) for (const e of v) remember(e);
      return set.call(this, k, v);
    };
    // Initial Entries must also be retained in unhooked getter probes to arm the same seam.
    if (!hooked && probe) {
      const inner = wrapped;
      Object.defineProperty(Array.prototype, 'push', { configurable: true, get() {
        if (armed) push.call(trace, 'pushLookup');
        return function(this: any[], ...items: any[]) { if (!armed) for (const e of items) remember(e); return inner.apply(this, items); };
      } });
    }
    result = normalize(input);
  } catch (e) { error = e; }
  finally { Object.defineProperty(Array.prototype, 'push', descriptor); Map.prototype.set = set; }
  if (probe) return { trace, errorIdentity: error === stop, reached: armed, receiverSize: mappingReceiver?.length ?? null };
  if (error) throw error;
  return {
    json: JSON.stringify(result), received, mappings,
    raw: entries.map(e => ({ source: e.source, tab: e.tab, errors: e.errors, warnings: e.warnings, refs: e.refs, canonical: e.canonical, targets: e.targets,
      canonicalOwner: e.canonical ? entries.findIndex(other => other.canonical === e.canonical) : null,
      aliases: e.targets.map((t: any) => t.record === e.canonical) })),
    nullPrototype: Object.getPrototypeOf(result.records) === null,
    mutable: !Object.isFrozen(result.mappings) && result.mappings.every((m: any) => !Object.isFrozen(m)),
    counts: Object.fromEntries(Object.entries(result.records).map(([k, v]) => [k, (v as any[]).length])),
  };
}
// ORACLE_OBSERVER_END

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/mapping-construction-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: ReturnType<typeof observe> }[];
  getters: { probe: string; hooked: boolean; outcome: ReturnType<typeof observe> }[];
};
const supported = () => golden.cases.find(c => c.name === 'supported-v3')!.input;
const realCreate = outputModule.createNormalizationOutput;
function seamInput(): Input {
  const input = clone(supported());
  return { ...input, sheets: { ...input.sheets, tabs: { Students: input.sheets.tabs.Students } } };
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

// Native instrumentation is armed only after the actual final target-index append.
function atMappingTarget(action: (entry: any, target: any) => void) {
  const push = Array.prototype.push, entries: any[] = [];
  let armed = false;
  Array.prototype.push = function(...items: any[]) {
    for (const e of items) if (e && Array.isArray(e.errors) && Array.isArray(e.targets) && e.tab === 'Students' && !entries.includes(e)) push.call(entries, e);
    const result = push.apply(this, items);
    if (!armed) {
      const e = entries.find(e => e.targets[0] === items[0] && this !== e.targets);
      if (e) { armed = true; action(e, items[0]); }
    }
    return result;
  };
  return () => { Array.prototype.push = push; return armed; };
}
function consume(context: BudgetContext, key: 'nodes' | 'slots' | 'structuralBytes' | 'work', remaining: number) {
  const amount = context.limits[key] - context.usage()[key] - remaining;
  if (key === 'work') context.spend(amount); else context.reserve({ [key]: amount });
}

describe('executed original Git mapping bytes and raw contributor parity', () => {
  for (const enabled of [false, true]) for (const f of golden.cases) it(`${f.name} budget=${enabled}`, () => {
    const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = budget ? parseRegisteredBoundedJson(JSON.stringify(f.input), budget) as Input : clone(f.input);
    const actual = observe(i => run(i, budget), input);
    // Raw occurrences are deliberately asserted before the final sorted/deduplicated JSON.
    expect(actual.mappings).toEqual(f.outcome.mappings);
    expect(actual.raw).toEqual(f.outcome.raw); expect(actual.received).toEqual(f.outcome.received);
    expect(actual).toEqual(f.outcome);
  });
  for (const f of golden.getters) it(`no-budget original getter ${f.probe} hooked=${f.hooked}`, () => {
    expect(observe(run, clone(supported()), f.hooked, f.probe)).toEqual(f.outcome);
  });
});

describe('real mapping admission, independent fixed payload and total recipes', () => {
  const payload = { nodes: 5, slots: 4, structuralBytes: 85, work: 5 };
  const total = { nodes: 5, slots: 5, structuralBytes: 89, work: 6 };
  for (const boundary of ['method', 'factory'] as const) for (const key of Object.keys(payload) as (keyof typeof payload)[]) for (const delta of [-1, 0, 1]) {
    it(`${boundary} ${key} exact ${boundary === 'method' ? total[key] : payload[key]} delta ${delta}: first source getter`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      const input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
      const stop = new RangeError('first payload getter'); let getters = 0, methods = 0, factories = 0;
      const restore = atMappingTarget(e => { Object.defineProperty(e, 'source', { get() { getters++; throw stop; } }); });
      const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
        expect(context).toBe(budget); const output = realCreate(context);
        return { ...output, mapping(list, factory) {
          methods++;
          if (boundary === 'method') consume(budget, key, total[key] + delta);
          output.mapping(list, () => { factories++; if (boundary === 'factory') consume(budget, key, payload[key] + delta); return factory(); });
        } };
      });
      let error: unknown, reached: boolean;
      try { run(input, budget); } catch (e) { error = e; } finally { reached = restore(); spy.mockRestore(); }
      expect(reached!, String(error)).toBe(true); expect(methods).toBe(1); expect(factories).toBe(1);
      expect(getters).toBe(delta < 0 ? 0 : 1);
      if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
    });
  }
  it('payload and total exact deltas, zero content, same context and no refund after factory failure', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
    let method: ReturnType<BudgetContext['usage']>, factoryStart: ReturnType<BudgetContext['usage']>, first: ReturnType<BudgetContext['usage']>;
    const stop = new RangeError('operand');
    const restore = atMappingTarget(e => Object.defineProperty(e, 'source', { get() { first = budget.usage(); throw stop; } }));
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); const output = realCreate(context);
      return { ...output, mapping(list, factory) { method = budget.usage(); output.mapping(list, () => { factoryStart = budget.usage(); return factory(); }); } };
    });
    let error: unknown;
    try { run(input, budget); } catch (e) { error = e; } finally { restore(); spy.mockRestore(); }
    expect(error).toBe(stop);
    for (const key of Object.keys(payload) as (keyof typeof payload)[]) {
      expect(first![key] - factoryStart![key]).toBe(payload[key]); expect(first![key] - method![key]).toBe(total[key]);
    }
    expect(first!.contentBytes - method!.contentBytes).toBe(0); expect(budget.usage()).toEqual(first!);
  });
});

describe('mapping operand completion before the next getter or append', () => {
  for (const variant of ['SHEET', 'REDIS']) for (const field of ['source', 'kind', 'digest', 'table', 'id']) {
    for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) {
      it(`${variant} ${field} ${state} ${exit}`, () => {
        let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
        const input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
        const error = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('operand');
        const trace: string[] = []; let appends = 0, factories = 0, returned = 0, unchosen = 0;
        const restore = atMappingTarget((entry, target) => {
          // Synthetic variant selection at the real caller; natural variants are covered by Git parity.
          const source: any = { ...entry.source, kind: variant, rowHash: 'sheet-scalar', sourceDigest: 'redis-scalar' };
          const selected = variant === 'SHEET' ? 'rowHash' : 'sourceDigest', unused = variant === 'SHEET' ? 'sourceDigest' : 'rowHash';
          Object.defineProperty(source, unused, { get() { unchosen++; throw new Error('unchosen'); } });
          for (const [object, key, label, value] of [[entry, 'source', 'source', source], [source, 'kind', 'kind', variant], [source, selected, 'digest', source[selected]], [target, 'table', 'table', target.table], [target, 'id', 'id', target.id]] as const) {
            Object.defineProperty(object, key, { configurable: true, get() {
              trace.push(label);
              if (label === field) { if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw error; }
              return value;
            } });
          }
        });
        const stop = new RangeError('append reached');
        const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
          expect(context).toBe(budget); const output = realCreate(context);
          return { ...output, mapping(list, factory) {
            Object.defineProperty(list, 'push', { configurable: true, value() { appends++; throw stop; } });
            output.mapping(list, () => { factories++; const value = factory(); returned++; return value; });
          } };
        });
        let caught: unknown, reached: boolean;
        try { run(input, budget); } catch (e) { caught = e; } finally { reached = restore(); spy.mockRestore(); }
        expect(reached!).toBe(true); expect(factories).toBe(1); expect(unchosen).toBe(0);
        const all = ['source', 'kind', 'digest', 'table', 'id'];
        const complete = state === 'timely' && exit === 'success';
        expect(trace).toEqual(complete ? all : all.slice(0, all.indexOf(field) + 1));
        expect(returned).toBe(complete ? 1 : 0); expect(appends).toBe(complete ? 1 : 0);
        if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error);
        else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
        else expect(caught).toBe(exit === 'success' ? stop : error);
      });
    }
  }
});

describe('native receiver completion and cumulative emissions', () => {
  for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`mapping push ${state} ${exit}`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
    const input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
    const error = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('push');
    const stop = new RangeError('successor'); let pushes = 0, successors = 0, receiver: any[], before = 0;
    const native = Array.prototype.push;
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); const output = realCreate(context);
      return { ...output, mapping(list, factory) {
        if (pushes) { successors++; throw stop; }
        receiver = list; before = list.length;
        Object.defineProperty(list, 'push', { configurable: true, value(...values: any[]) {
          pushes++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true;
          if (exit !== 'success') throw error; return native.apply(list, values);
        } });
        output.mapping(list, factory);
      }, sourceRecord(list, quarantine, factory) { if (pushes) { successors++; throw stop; } output.sourceRecord(list, quarantine, factory); } };
    });
    // The next target.table getter is the earliest successor, before the next output method.
    const restore = atMappingTarget((entry) => {
      const target = entry.targets[1], table = target.table;
      Object.defineProperty(target, 'table', { configurable: true, get() { if (pushes) { successors++; throw stop; } return table; } });
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); spy.mockRestore(); }
    expect(pushes).toBe(1); expect(receiver!).toHaveLength(before + (exit === 'success' ? 1 : 0));
    expect(successors).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
    else expect(caught).toBe(exit === 'success' ? stop : error);
  });
  for (const count of [7999, 8000]) it(`synthetic same-owner category prefill ${count}: admission once`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
    const output = realCreate(budget), scratch: number[] = [];
    for (let i = 0; i < count; i++) output.mapping(scratch, () => i);
    let calls = 0, factories = 0, receiver: unknown[];
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget);
      return { ...output, mapping(list, factory) { calls++; receiver = list; output.mapping(list, () => { factories++; return factory(); }); } };
    });
    let error: unknown;
    try { run(input, budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(calls).toBe(count === 7999 ? 2 : 1);
    expect(factories).toBe(count === 7999 ? 1 : 0); expect(receiver!).toHaveLength(factories); expect(scratch).toHaveLength(count);
  });
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) it(`second reached mapping retains cumulative ${key} without refund`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
    let calls = 0, getters = 0, receiver: unknown[], usage: ReturnType<BudgetContext['usage']>;
    const restore = atMappingTarget(entry => { const source = entry.source; Object.defineProperty(entry, 'source', { get() { getters++; return source; } }); });
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); const output = realCreate(context);
      return { ...output, mapping(list, factory) {
        calls++; receiver = list;
        if (calls === 2) { expect(budget.usage()[key]).toBeGreaterThanOrEqual(usage[key]); consume(budget, key, ({ nodes: 4, slots: 4, structuralBytes: 88, work: 5 })[key]); }
        output.mapping(list, factory); usage = budget.usage();
      } };
    });
    let error: unknown;
    try { run(input, budget); } catch (e) { error = e; } finally { restore(); spy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(calls).toBe(2); expect(getters).toBe(1); expect(receiver!).toHaveLength(1);
  });
});
