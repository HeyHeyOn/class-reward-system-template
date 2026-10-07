import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as work from '@/lib/boundedWork';
import * as operational from './operationalProjection';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/reference-guards-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; counts: Record<string, number> } }[] };
function fixture(name: string) { return golden.cases.find(c => c.name === name)!; }
function admitted(b: BudgetContext, name: string) { return parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input; }
function at(name: string) {
  // Preserve the current capture depth and every observation, without formatting
  // diagnostic stacks on each debit of the fixed-point accounting wrapper.
  const prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  let found = false;
  try {
    Error.prepareStackTrace = (_error, sites) => { found = sites.some(site => site.getFunctionName()?.includes(name)); return ''; };
    void new Error().stack;
    return found;
  } finally {
    if (prepare) Object.defineProperty(Error, 'prepareStackTrace', prepare);
    else Reflect.deleteProperty(Error, 'prepareStackTrace');
  }
}
function leave(b: BudgetContext, dimension: 'work' | 'slots' | 'nodes' | 'structuralBytes', amount: number) {
  const n = b.limits[dimension] - b.usage()[dimension] - amount;
  if (dimension === 'work') b.spend(n); else b.reserve({ [dimension]: n });
}

describe('reference stack observer', () => {
  it('uses caller frames without diagnostic formatting and restores the formatter and depth', () => {
    const prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'), limit = Error.stackTraceLimit;
    let formatted = 0, present = false, absent = true;
    const formatter = () => { formatted++; return 'diagnostic text is not caller identity'; };
    try {
      Error.prepareStackTrace = formatter;
      function namedReferenceAncestor() { return at('namedReferenceAncestor'); }
      present = namedReferenceAncestor(); absent = at('nonexistentReferenceAncestor');
      expect(Error.prepareStackTrace).toBe(formatter); expect(Error.stackTraceLimit).toBe(limit);
    } finally {
      if (prepare) Object.defineProperty(Error, 'prepareStackTrace', prepare);
      else Reflect.deleteProperty(Error, 'prepareStackTrace');
    }
    expect(present).toBe(true); expect(absent).toBe(false); expect(formatted).toBe(0);
  });
});

describe('reference fixed-point frozen Git bytes and accepted multiplicity', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.name) : f.input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    for (const [key, count] of Object.entries(f.outcome.counts)) expect(result.records[key]?.length ?? 0).toBe(count);
    for (const s of result.sourceRecords) if (s.canonicalRecord) {
      expect(Object.isFrozen(s.canonicalRecord)).toBe(false);
      if (b) expect(() => assertRegisteredBoundedJson(s.canonicalRecord, b)).toThrow('Legacy bounded JSON is invalid.');
    }
  });
});

describe('actual reached fixed point inner work', () => {
  for (const name of ['missing-3', 'missing-12', 'missing-40']) it(`refuses next nested lookup after missing candidate ${name}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), get = Map.prototype.get;
    let reached = 0, after = 0, error: unknown;
    Map.prototype.get = function (key) {
      if (at('validateReferences')) {
        if (reached) after++;
        if (key === 'MISSING' && !reached) { reached++; leave(b, 'work', 0); }
      }
      return get.call(this, key);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(reached).toBe(1); expect(after).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('small missing chain charges its repeated fixed-point passes, not only entry admission', () => {
    function measure(name: string) {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), get = Map.prototype.get;
      let first = -1, last = -1, visits = 0;
      Map.prototype.get = function (key) {
        if (key === 'MISSING' && at('validateReferences')) { if (first < 0) first = b.usage().work; last = b.usage().work; visits++; }
        return get.call(this, key);
      };
      try { run(input, b); } finally { Map.prototype.get = get; }
      return { work: last - first, visits };
    }
    const short = measure('missing-3'), long = measure('missing-40');
    expect(long.visits).toBeGreaterThan(short.visits);
    expect(long.work).toBeGreaterThan(short.work * 10);
  });
  it('both actual calls debit the same cumulative request context around operational validation', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'missing-3'), get = Map.prototype.get;
    const native = operational.unsupportedOperationalRecords; let second = false, first = 0, next = 0, operationalWork = 0;
    const spy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((a, c, owner) => {
      expect(owner).toBe(b); const result = native(a, c, owner); operationalWork = b.usage().work; second = true; return result;
    });
    Map.prototype.get = function (key) {
      if (key === 'MISSING' && at('validateReferences')) { if (second) next = b.usage().work; else first = b.usage().work; }
      return get.call(this, key);
    };
    try { run(input, b); } finally { Map.prototype.get = get; spy.mockRestore(); }
    expect(first).toBeGreaterThan(0); expect(next).toBeGreaterThan(operationalWork);
  });
});

describe('cycle path allocations are reserved before the next native operation', () => {
  for (const dimension of ['slots', 'structuralBytes'] as const) it(`path and positions insertion ${dimension}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'cycle-12'), set = Map.prototype.set;
    let reached = 0, after = 0, error: unknown;
    Map.prototype.set = function (key, value) {
      if (at('markDirectedReferenceCycles') && key === 'R0' && typeof value === 'number') {
        if (reached) after++;
        if (!reached && value === 1) { reached++; leave(b, dimension, 0); }
      }
      return set.call(this, key, value);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.set = set; }
    expect(reached).toBe(1); expect(after).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) it(`cycle slice refusal before allocation ${dimension}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'cycle-12'), get = Map.prototype.get, slice = Array.prototype.slice;
    let reached = 0, slices = 0, error: unknown;
    Map.prototype.get = function (key) {
      const value = get.call(this, key);
      if (!reached && key === 'R0' && value === 0 && at('markDirectedReferenceCycles')) { reached++; leave(b, dimension, 0); }
      return value;
    };
    Array.prototype.slice = function (start?: number, end?: number) { if (reached && this[0] === 'R0') slices++; return slice.call(this, start, end); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.slice = slice; }
    expect(reached).toBe(1); expect(slices).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('exact cycle slice storage and candidate boundaries', () => {
  for (const [dimension, cost] of [['nodes', 1], ['slots', 12], ['structuralBytes', 64]] as const) for (const delta of [-1, 0, 1]) it(`slice ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'cycle-12'), get = Map.prototype.get, slice = Array.prototype.slice;
    let reached = 0, slices = 0;
    Map.prototype.get = function (key) {
      const value = get.call(this, key);
      if (!reached && key === 'R0' && value === 0 && at('markDirectedReferenceCycles')) { reached++; leave(b, dimension, cost + delta); }
      return value;
    };
    Array.prototype.slice = function (start?: number, end?: number) { if (reached && this[0] === 'R0') slices++; return slice.call(this, start, end); };
    try { run(input, b); } catch (e) { expect(e).toBeInstanceOf(BudgetExceededError); } finally { Map.prototype.get = get; Array.prototype.slice = slice; }
    expect(reached).toBe(1); expect(slices).toBe(delta < 0 ? 0 : 1);
  });
  it('candidate errors are not read after the reached candidate lookup exhausts work', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'chain-3'), get = Map.prototype.get;
    let reached = 0, reads = 0, error: unknown;
    Map.prototype.get = function (key) {
      const value = get.call(this, key);
      if (!reached && key === 'R1' && Array.isArray(value) && value[0]?.tab === 'Tasks' && at('validateReferences')) {
        reached++; const errors = value[0].errors;
        Object.defineProperty(value[0], 'errors', { configurable: true, get() { reads++; return errors; } });
        leave(b, 'work', 0);
      }
      return value;
    };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(reached).toBe(1); expect(reads).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('resolved prerequisite property expansion', () => {
  for (const remaining of [0, 1, 2, 3]) it(`reserves each new mutable property before write, slots=${remaining}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'chain-3'), get = Map.prototype.get;
    let lookups = 0, reached = 0;
    let destination: { canonical: Record<string, unknown>; targets: { table: string; record: Record<string, unknown> }[] } | undefined;
    Map.prototype.get = function (key) {
      const value = get.call(this, key);
      if (key === 'R1' && Array.isArray(value) && value[0]?.tab === 'Tasks' && at('validateReferences') && ++lookups === 2) {
        destination = get.call(this, 'R0')[0]; const canonical = value[0].canonical, instance = canonical.taskInstanceId;
        Object.defineProperty(canonical, 'taskInstanceId', { configurable: true, get() { reached++; leave(b, 'slots', remaining); return instance; } });
      }
      return value;
    };
    try { run(input, b); } catch (e) { expect(e).toBeInstanceOf(BudgetExceededError); } finally { Map.prototype.get = get; }
    expect(reached).toBe(1);
    expect(Object.hasOwn(destination!.canonical, 'prerequisiteTaskInstanceId')).toBe(remaining >= 1);
    expect(Object.hasOwn(destination!.targets.find(t => t.table === 'tasks')!.record, 'prerequisiteTaskInstanceId')).toBe(remaining >= 2);
  });
});

describe('reference native exits preserve deadline and budget identity', () => {
  for (const mode of ['deadline', 'abort', 'exceeded', 'unavailable'] as const) for (const throws of [false, true]) it(`${mode} throws=${throws}`, () => {
    let now = 0; const signal = new AbortController(), b = createBudgetContext({ now: () => now, signal: signal.signal });
    const input = admitted(b, 'missing-3'), get = Map.prototype.get;
    const original = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : new Error('native sentinel');
    let reached = 0, after = 0, error: unknown;
    Map.prototype.get = function (key) {
      if (at('validateReferences')) {
        if (reached) after++;
        if (!reached && key === 'MISSING') { reached++; if (mode === 'abort') signal.abort(); else now = 6000; if (throws) throw original; }
      }
      return get.call(this, key);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(reached).toBe(1); expect(after).toBe(0);
    if (throws && (mode === 'exceeded' || mode === 'unavailable')) expect(error).toBe(original);
    else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});


describe('reference path accounting audit sentinels', () => {
  it('charges both actual fixed-point calls through the identical registered owner', () => {
    const real = createBudgetContext({ now: () => 0 }); let second = false, firstWork = 0, secondWork = 0;
    const b: BudgetContext = { ...real, spend(amount = 1) { if (at('validateReferences')) { if (second) secondWork += amount; else firstWork += amount; } real.spend(amount); } };
    const input = admitted(b, 'missing-12'), native = operational.unsupportedOperationalRecords;
    const spy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((a, c, owner) => { expect(owner).toBe(b); const result = native(a, c, owner); second = true; return result; });
    try { run(input, b); } finally { spy.mockRestore(); }
    expect(firstWork).toBeGreaterThan(0); expect(secondWork).toBeGreaterThan(0);
    expect(real.usage().work).toBeGreaterThan(firstWork + secondWork);
  });
  it('inner error includes cannot read its next error after exhaustion in the prior element', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'missing-3'), push = Array.prototype.push;
    let armed = false, reached = 0, next = 0, error: unknown;
    Array.prototype.push = function (...values: unknown[]) {
      const result = push.apply(this, values);
      if (!armed && values[0] === 'BROKEN_TASK_REFERENCE' && at('validateReferences')) {
        armed = true;
        this[0] = 'FIRST'; this[1] = 'SECOND'; this[2] = 'BROKEN_TASK_REFERENCE';
        Object.defineProperty(this, '0', { configurable: true, get() { if (!reached) { reached++; leave(b, 'work', 0); } return 'FIRST'; } });
        Object.defineProperty(this, '1', { configurable: true, get() { next++; return 'SECOND'; } });
      }
      return result;
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(armed).toBe(true); expect(reached).toBe(1); expect(next).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) it(`candidate filter reserves before native allocation and callback: ${dimension}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'chain-3'), get = Map.prototype.get, filter = Array.prototype.filter;
    let reached = 0, filters = 0, candidate: unknown, error: unknown;
    Map.prototype.get = function (key) {
      const value = get.call(this, key);
      if (!reached && key === 'R1' && Array.isArray(value) && value[0]?.tab === 'Tasks' && at('validateReferences')) { reached++; candidate = value; leave(b, dimension, 0); }
      return value;
    };
    Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) { if (this === candidate) filters++; return filter.call(this, predicate, thisArg); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.filter = filter; }
    expect(reached).toBe(1); expect(filters).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const extra of [-1, 0, 1]) it(`inner includes exact string comparison work ${extra}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'missing-3'), native = work.equalBudgetValue;
    let reached = 0, admittedComparison = 0, error: unknown;
    const spy = vi.spyOn(work, 'equalBudgetValue').mockImplementation((a, c, owner): a is typeof c => {
      if (!reached && a === 'BROKEN_TASK_REFERENCE' && c === a && at('referenceContains')) {
        reached++; expect(owner).toBe(b); leave(b, 'work', 3 + extra);
        const result = native(a, c, owner); admittedComparison++; return result;
      }
      return native(a, c, owner);
    });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(reached).toBe(1); expect(admittedComparison).toBe(extra < 0 ? 0 : 1); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  const accepted = JSON.parse(readFileSync('src/server/migration/__fixtures__/transaction-item-loop-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string } }[] };
  for (const name of ['accepted-shared-product-refs', 'accepted-16-distinct-items']) for (const guarded of [false, true]) it(`preexisting frozen Git accepted reference multiplicity ${name} context=${guarded}`, () => {
    const f = accepted.cases.find(c => c.name === name)!, b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? parseRegisteredBoundedJson(JSON.stringify(f.input), b) as Input : f.input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(result.records.transactions.length).toBeGreaterThan(0);
    expect(result.records.transaction_items.length).toBeGreaterThan(1);
  });
});


describe('reference native success and exception exits at each real seam', () => {
  for (const site of ['get', 'has', 'set', 'filter', 'slice', 'push'] as const)
    for (const mode of ['timely', 'deadline', 'abort'] as const)
      for (const failure of ['success', 'ordinary', 'exceeded', 'unavailable'] as const)
        for (const guarded of [false, true]) it(`${site} ${mode} ${failure} guarded=${guarded}`, () => {
          let now = 0; const signal = new AbortController();
          const b = guarded ? createBudgetContext({ now: () => now, signal: signal.signal }) : undefined;
          const name = site === 'get' || site === 'filter' ? 'missing-3' : 'cycle-3';
          const input = b ? admitted(b, name) : fixture(name).input;
          const get = Map.prototype.get, has = Map.prototype.has, set = Map.prototype.set;
          const filter = Array.prototype.filter, slice = Array.prototype.slice, push = Array.prototype.push;
          const sentinel = failure === 'exceeded' ? new BudgetExceededError() : failure === 'unavailable' ? new BudgetUnavailableError() : new Error('reference native');
          let reached = 0, after = 0, error: unknown, result: unknown;
          function active() { return at('validateReferences') || at('markDirectedReferenceCycles'); }
          function exit<T>(selected: boolean, value: T): T {
            if (reached || !selected) return value;
            reached++; if (mode === 'deadline') now = 6000; if (mode === 'abort') signal.abort();
            if (failure !== 'success') throw sentinel; return value;
          }
          function count() { if (reached && active()) after++; }
          Map.prototype.get = function (key) { count(); return exit(site === 'get' && key === 'MISSING' && active(), get.call(this, key)); };
          Map.prototype.has = function (key) { count(); return exit(site === 'has' && key === 'R0' && at('markDirectedReferenceCycles'), has.call(this, key)); };
          Map.prototype.set = function (key, value) { count(); return exit(site === 'set' && key === 'R0' && value === 1 && at('markDirectedReferenceCycles'), set.call(this, key, value)); };
          Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
            count(); return exit(site === 'filter' && this.length === 1 && this[0]?.tab === 'Tasks' && active(), filter.call(this, predicate, thisArg));
          };
          Array.prototype.slice = function (start?: number, end?: number) { count(); return exit(site === 'slice' && this[0] === 'R0' && active(), slice.call(this, start, end)); };
          Array.prototype.push = function (...values: unknown[]) { count(); return exit(site === 'push' && values[0] === 'R0' && at('markDirectedReferenceCycles'), push.apply(this, values)); };
          try { result = run(input, b); } catch (e) { error = e; }
          finally { Map.prototype.get = get; Map.prototype.has = has; Map.prototype.set = set; Array.prototype.filter = filter; Array.prototype.slice = slice; Array.prototype.push = push; }
          expect(reached).toBe(1);
          if (failure === 'exceeded' || failure === 'unavailable') { expect(error).toBe(sentinel); expect(after).toBe(0); }
          else if (b && mode !== 'timely') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(after).toBe(0); }
          else if (failure === 'ordinary') { expect(error).toBe(sentinel); expect(after).toBe(0); }
          else { expect(error).toBeUndefined(); expect(JSON.stringify(result)).toBe(fixture(name).outcome.json); }
        });
});


it('40-row chain naturally reaches repeated passes before a stricter work ceiling, without counter injection', () => {
  // Fixed test-only ceiling selected from the exact-helper trajectory; production remains 5M.
  const real = createBudgetContext({ now: () => 0, limits: { work: 160_000 } }); let referenceFailure = false, visits = 0, error: unknown;
  const b: BudgetContext = { ...real, spend(amount = 1) { try { real.spend(amount); } catch (e) { referenceFailure = at('validateReferences'); throw e; } } };
  const source = admitted(b, 'missing-40'), get = Map.prototype.get;
  Map.prototype.get = function (key) { if (key === 'MISSING' && at('validateReferences')) visits++; return get.call(this, key); };
  try { run(source, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
  expect(error).toBeInstanceOf(BudgetExceededError); expect(referenceFailure).toBe(true); expect(visits).toBeGreaterThan(2);
  expect(real.limits.work).toBe(160_000);
  expect(createBudgetContext({ now: () => 0 }).limits.work).toBe(5_000_000);
});
