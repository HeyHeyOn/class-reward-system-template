import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createBudgetContext, BudgetExceededError, BudgetUnavailableError, type BudgetContext, type BudgetUsage } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as operational from './operationalProjection';
import * as semantic from './semanticValidators';

vi.mock('server-only', () => ({}));
type Fixture = { fn: string; args: unknown[]; outcome: { json?: string; error?: { name: string; message: string } } };
const fixtures: Fixture[] = JSON.parse(readFileSync('src/server/migration/__fixtures__/operational-budget-golden.json', 'utf8'));
const apis = { ...operational, ...semantic } as unknown as Record<string, (...args: unknown[]) => unknown>;
function invoke(fixture: Fixture, args = fixture.args, budget?: BudgetContext) { return apis[fixture.fn](...args, ...(budget ? [budget] : [])); }
function admitted(fixture: Fixture, budget: BudgetContext): unknown[] { return parseRegisteredBoundedJson(JSON.stringify(fixture.args), budget) as unknown[]; }
function outcome(fixture: Fixture, args: unknown[], budget?: BudgetContext) {
  try {
    const value = invoke(fixture, args, budget);
    return { json: JSON.stringify(value instanceof Set ? [...value].map((row) => [...args[0] as unknown[], ...args[1] as unknown[]].indexOf(row)) : value) };
  } catch (error) { const e = error as Error; return { error: { name: e.name, message: e.message } }; }
}
const rich = fixtures[2];
const keys: (keyof BudgetUsage)[] = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'];
function consume(budget: BudgetContext, key: keyof BudgetUsage, amount: number) { if (key === 'work') budget.spend(amount); else budget.reserve({ [key]: amount }); }

describe('frozen committed operational and semantic helper oracles', () => {
  fixtures.forEach((fixture, i) => {
    it(`no-budget oracle ${i}: ${fixture.fn}`, () => expect(outcome(fixture, fixture.args)).toEqual(fixture.outcome));
    it(`registered budget oracle ${i}: ${fixture.fn}`, () => {
      const budget = createBudgetContext(); expect(outcome(fixture, admitted(fixture, budget), budget)).toEqual(fixture.outcome);
    });
  });
});

describe('operational request guards', () => {
  for (const key of keys) {
    it(`charges ${key} on actual chronology/map/tuple path`, () => {
      const budget = createBudgetContext(), args = admitted(rich, budget), before = budget.usage(); invoke(rich, args, budget);
      expect(budget.usage()[key] - before[key]).toBeGreaterThan(0);
    });
    for (const offset of [-1, 0, 1]) it(`${key}: measured inclusive boundary ${offset}`, () => {
      const measured = createBudgetContext(), original = admitted(rich, measured), before = measured.usage(); invoke(rich, original, measured);
      const cost = measured.usage()[key] - before[key]; expect(cost).toBeGreaterThan(0);
      const budget = createBudgetContext(), args = admitted(rich, budget);
      consume(budget, key, budget.limits[key] - budget.usage()[key] - cost - offset);
      if (offset < 0) expect(() => invoke(rich, args, budget)).toThrow(BudgetExceededError);
      else expect(outcome(rich, args, budget)).toEqual(rich.outcome);
    });
  }
  it('accumulates across repeated calls without resetting owner', () => {
    const budget = createBudgetContext(), args = admitted(rich, budget), before = budget.usage(); invoke(rich, args, budget); const first = budget.usage(); invoke(rich, args, budget);
    for (const key of keys) expect(budget.usage()[key] - first[key]).toBe(first[key] - before[key]);
    expect(first.work).toBeGreaterThan(before.work);
  });
  for (const name of ['unsupportedOperationalRecords', 'adjustmentKey', 'adjustmentTransactionKey', 'sameAssignmentCompletionTuple']) {
    const fixture = fixtures.find((f) => f.fn === name)!;
    it(`${name}: rejects unregistered inputs`, () => expect(() => invoke(fixture, fixture.args, createBudgetContext())).toThrow());
    it(`${name}: rejects a foreign request certificate`, () => {
      const args = admitted(fixture, createBudgetContext()); expect(() => invoke(fixture, args, createBudgetContext())).toThrow();
    });
    it(`${name}: checks cancellation before property access`, () => {
      const signal = { aborted: false }, budget = createBudgetContext({ signal }), args = admitted(fixture, budget); signal.aborted = true;
      expect(() => invoke(fixture, args, budget)).toThrow(BudgetUnavailableError);
    });
  }
  it('refuses before input-derived map allocation', () => {
    const budget = createBudgetContext(), args = admitted(rich, budget); consume(budget, 'nodes', budget.limits.nodes - budget.usage().nodes - 1);
    const native = globalThis.Map; let calls = 0;
    globalThis.Map = new Proxy(native, { construct(target, args, newTarget) { calls++; return Reflect.construct(target, args, newTarget); } });
    let error: unknown; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { globalThis.Map = native; }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(calls).toBe(0);
  });
  it('refuses before subject JSON.stringify', () => {
    const budget = createBudgetContext(), args = admitted(rich, budget); consume(budget, 'contentBytes', budget.limits.contentBytes - budget.usage().contentBytes);
    const spy = vi.spyOn(JSON, 'stringify'); let error: unknown; let calls = 0; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { calls = spy.mock.calls.length; spy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(calls).toBe(0);
  });
  for (const kind of ['success', 'ordinary-error', 'exceeded', 'unavailable']) it(`checks subject native ${kind} exit, retaining budget error identity`, () => {
    let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(rich, budget), native = JSON.stringify;
    const original = kind === 'exceeded' ? new BudgetExceededError() : kind === 'unavailable' ? new BudgetUnavailableError() : new SyntaxError('native sentinel');
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown) => { now = 5000; if (kind !== 'success') throw original; return native(value); }) as typeof JSON.stringify);
    let error: unknown; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
    if (kind === 'exceeded' || kind === 'unavailable') expect(error).toBe(original); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  for (const kind of ['success', 'error']) it(`checks chronology Date.parse ${kind} exit`, () => {
    let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(rich, budget), native = Date.parse;
    const spy = vi.spyOn(Date, 'parse').mockImplementation((text) => { now = 5000; if (kind === 'error') throw new RangeError('native'); return native(text); });
    let error: unknown; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  for (const fn of ['adjustmentKey', 'adjustmentTransactionKey', 'sameAssignmentCompletionTuple', 'cancellationOriginalId']) {
    it(`${fn} has its own nonzero work debit`, () => {
      const f = fixtures.find((item) => item.fn === fn)!, budget = createBudgetContext(), args = admitted(f, budget), start = budget.usage().work;
      invoke(f, args, budget); expect(budget.usage().work).toBeGreaterThan(start);
    });
  }
  it('cancellation precharges prefix/slice work and returns no late ID', () => {
    let now = 0; const budget = createBudgetContext({ now: () => now }); const native = String.prototype.slice;
    const spy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (this: string, start, end) { if (this === 'cancel:abc') now = 5000; return native.call(this, start, end); });
    let error: unknown; try { apis.cancellationOriginalId('cancel:abc', budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});

describe('nested native and ownership boundaries', () => {
  for (const method of ['replace', 'trim'] as const) for (const kind of ['success', 'ordinary', 'exceeded', 'unavailable']) {
    it(`${method} ${kind} is checked on both native exits`, () => {
      const input = JSON.parse(JSON.stringify(rich)) as Fixture;
      (input.args[1] as Record<string, unknown>[])[0].note = 'note';
      let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(input, budget);
      const original = kind === 'exceeded' ? new BudgetExceededError() : kind === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native');
      const originalMethod = String.prototype[method];
      const spy = vi.spyOn(String.prototype, method).mockImplementation(function (this: string, ...params: unknown[]) {
        now = 5000; if (kind !== 'success') throw original;
        return Reflect.apply(originalMethod, this, params);
      });
      let error: unknown; try { invoke(input, args, budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
      if (kind === 'exceeded' || kind === 'unavailable') expect(error).toBe(original); else expect(error).toBeInstanceOf(BudgetUnavailableError);
    });
  }
  for (const kind of ['ordinary', 'exceeded', 'unavailable']) it(`String(mode) preserves ${kind} native exit`, () => {
    const input = fixtures.find((f) => f.fn === 'adjustmentKey')!;
    let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(input, budget), originalString = globalThis.String;
    const original = kind === 'exceeded' ? new BudgetExceededError() : kind === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native');
    globalThis.String = new Proxy(originalString, { apply() { now = 5000; throw original; } });
    let error: unknown; try { invoke(input, args, budget); } catch (e) { error = e; } finally { globalThis.String = originalString; }
    if (kind === 'ordinary') expect(error).toBeInstanceOf(BudgetUnavailableError); else expect(error).toBe(original);
  });
  it('cancellation checks a late exception from canonicalId trim', () => {
    let now = 0; const budget = createBudgetContext({ now: () => now });
    const spy = vi.spyOn(String.prototype, 'trim').mockImplementation(() => { now = 5000; throw new RangeError('native'); });
    let error: unknown; try { apis.cancellationOriginalId('cancel:abc', budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  for (const method of ['get', 'set', 'has'] as const) for (const kind of ['success', 'ordinary', 'exceeded', 'unavailable']) {
    it(`Map.${method} ${kind} is checked before exposing a result`, () => {
      let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(rich, budget);
      const original = kind === 'exceeded' ? new BudgetExceededError() : kind === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native');
      const originalMethod = Map.prototype[method];
      const spy = vi.spyOn(Map.prototype, method).mockImplementation(function (this: Map<unknown, unknown>, ...params: unknown[]) {
        now = 5000; if (kind !== 'success') throw original; return Reflect.apply(originalMethod, this, params);
      });
      let error: unknown; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
      if (kind === 'exceeded' || kind === 'unavailable') expect(error).toBe(original); else expect(error).toBeInstanceOf(BudgetUnavailableError);
    });
  }
  it('refuses the next subject/map work after a successful native boundary consumes remaining work', () => {
    const budget = createBudgetContext(), args = admitted(rich, budget), original = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown) => {
      budget.spend(budget.limits.work - budget.usage().work); return original(value);
    }) as typeof JSON.stringify);
    let gets = 0; const getter = Map.prototype.get;
    const getSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) { gets++; return getter.call(this, key); });
    let error: unknown; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { spy.mockRestore(); getSpy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(gets).toBe(0);
  });
  it('reserves replacement string before its native operation, not after Date.parse', () => {
    const budget = createBudgetContext(), args = admitted(rich, budget), original = Date.parse;
    const spy = vi.spyOn(Date, 'parse').mockImplementation((text) => {
      budget.reserve({ contentBytes: budget.limits.contentBytes - budget.usage().contentBytes }); return original(text);
    });
    const replacement = vi.spyOn(String.prototype, 'replace'); let calls = 0, error: unknown;
    try { invoke(rich, args, budget); } catch (e) { error = e; } finally { calls = replacement.mock.calls.length; spy.mockRestore(); replacement.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(calls).toBe(0);
  });
  it('rejects proxy inputs before any property or own-key trap', () => {
    const budget = createBudgetContext(); let touched = 0;
    const value = new Proxy({}, { get() { touched++; throw new Error('get'); }, ownKeys() { touched++; throw new Error('keys'); } });
    expect(() => apis.adjustmentKey(value, budget)).toThrow(); expect(touched).toBe(0);
  });
  it('long subject and tuple comparisons consume input-length work', () => {
    function work(length: number) {
      const budget = createBudgetContext(); const value = parseRegisteredBoundedJson(JSON.stringify({ taskId: 'a'.repeat(length) }), budget);
      const before = budget.usage().work; apis.sameAssignmentCompletionTuple(value, value, budget); return budget.usage().work - before;
    }
    expect(work(1025)).toBeGreaterThan(work(1));
  });
});

describe('final native scalar exits', () => {
  for (const kind of ['false', 'throw']) it(`adjustmentTransactionKey checks ${kind} native scalar exit`, () => {
    const f = fixtures.find((item) => item.fn === 'adjustmentTransactionKey')!;
    let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(f, budget);
    const original = Number.isSafeInteger; let intercepted = false;
    // Negative total -5 cannot be an allocation/work/depth counter.
    Number.isSafeInteger = (value: unknown) => {
      if (value === -5) { intercepted = true; now = 5000; if (kind === 'throw') throw new RangeError('scalar native'); return false; }
      return original(value);
    };
    let error: unknown; try { invoke(f, args, budget); } catch (e) { error = e; } finally { Number.isSafeInteger = original; }
    expect(intercepted).toBe(true); expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});

describe('remaining scalar and tuple native exits', () => {
  for (const fn of ['adjustmentKey', 'unsupportedOperationalRecords']) for (const kind of ['false', 'throw']) it(`${fn} checks ${kind} scalar boundary`, () => {
    const f: Fixture = fn === 'adjustmentKey'
      ? { ...fixtures.find((item) => item.fn === fn)!, args: [{ timestamp: 't', studentId: 's', operator: 'o', mode: 'set', amount: -1 }] } : rich;
    let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(f, budget);
    const method = fn === 'adjustmentKey' ? 'isSafeInteger' : 'isFinite';
    const valueToMatch = fn === 'adjustmentKey' ? -1 : Date.parse('2026-01-01T00:00:00.000Z');
    const original = Number[method]; let intercepted = false;
    Number[method] = (value: unknown) => {
      if (value === valueToMatch) { intercepted = true; now = 5000; if (kind === 'throw') throw new RangeError('scalar native'); return false; }
      return original(value);
    };
    let error: unknown; try { invoke(f, args, budget); } catch (e) { error = e; } finally { Number[method] = original; }
    expect(intercepted).toBe(true); expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  it('checks a late tuple-freeze exception', () => {
    let now = 0; const budget = createBudgetContext({ now: () => now }), args = admitted(rich, budget), original = Object.freeze;
    Object.freeze = ((value: unknown) => {
      if (Array.isArray(value) && value.length === 3) { now = 5000; throw new RangeError('freeze'); } return original(value);
    }) as typeof Object.freeze;
    let error: unknown; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { Object.freeze = original; }
    expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});

describe('closed adjustment tuple reservations', () => {
  for (const fn of ['adjustmentKey', 'adjustmentTransactionKey']) for (const key of keys) for (const offset of [-1, 0, 1]) {
    it(`${fn} ${key} inclusive boundary ${offset}`, () => {
      const f = fixtures.find((item) => item.fn === fn)!, measured = createBudgetContext(), source = admitted(f, measured), before = measured.usage();
      invoke(f, source, measured); const cost = measured.usage()[key] - before[key]; expect(cost).toBeGreaterThan(0);
      const budget = createBudgetContext(), args = admitted(f, budget); consume(budget, key, budget.limits[key] - budget.usage()[key] - cost - offset);
      if (offset < 0) expect(() => invoke(f, args, budget)).toThrow(BudgetExceededError); else expect(outcome(f, args, budget)).toEqual(f.outcome);
    });
  }
  it('refuses transaction tuple before freezing/serializing its newly allocated array', () => {
    const f = fixtures.find((item) => item.fn === 'adjustmentTransactionKey')!, budget = createBudgetContext(), args = admitted(f, budget);
    consume(budget, 'slots', budget.limits.slots - budget.usage().slots);
    const freeze = vi.spyOn(Object, 'freeze'), stringify = vi.spyOn(JSON, 'stringify');
    let error: unknown, freezes = 0, strings = 0;
    try { invoke(f, args, budget); } catch (e) { error = e; } finally { freezes = freeze.mock.calls.length; strings = stringify.mock.calls.length; freeze.mockRestore(); stringify.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetExceededError); expect(freezes).toBe(0); expect(strings).toBe(0);
  });
  for (const throws of [false, true]) it(`subject native exit checks cancellation, throws=${throws}`, () => {
    const signal = { aborted: false }, budget = createBudgetContext({ signal }), args = admitted(rich, budget), original = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown) => { signal.aborted = true; if (throws) throw new RangeError('aborted native'); return original(value); }) as typeof JSON.stringify);
    let error: unknown; try { invoke(rich, args, budget); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
  it('does not certify mutable parser results or frozen caller lookalikes', () => {
    const budget = createBudgetContext(), value = parseRegisteredBoundedJson('{"productId":"p","name":"n","price":1,"quantity":1,"subtotal":1}', budget);
    const mutable = semantic.canonicalTransactionItem(value, false, budget)!;
    expect(Object.isFrozen(mutable)).toBe(false);
    expect(() => apis.sameAssignmentCompletionTuple(mutable, value, budget)).toThrow();
    expect(() => apis.adjustmentKey(Object.freeze({ timestamp: 't', studentId: 's', operator: 'o', mode: 'set', amount: 1 }), budget)).toThrow();
  });
});

describe('cancellation scalar admission', () => {
  it('rejects an unregistered cancellation object before reading length or methods', () => {
    const budget = createBudgetContext(); let touched = 0;
    const proxy = new Proxy({}, { get() { touched++; throw new Error('getter'); } });
    expect(() => apis.cancellationOriginalId(proxy, budget)).toThrow(); expect(touched).toBe(0);
  });
});
