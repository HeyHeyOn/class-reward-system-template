import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { normalizeLegacySnapshots } from './normalize';
import * as semantic from './semanticValidators';

type Input = Parameters<typeof normalizeLegacySnapshots>[0];
// Wished-for trailing signature permits behavioral RED against the original implementation.
const run: (input: Input, budget?: BudgetContext) => ReturnType<typeof normalizeLegacySnapshots> = normalizeLegacySnapshots;
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/normalizer-entry-budget-golden.json', 'utf8')) as {
  head: string; cases: { name: string; input: Input; outcome: { json?: string; frozen?: boolean; sourceFrozen?: boolean; recordsNullPrototype?: boolean; error?: { name: string; message: string } } }[];
};
function admit(value: unknown, budget: BudgetContext): Input { return parseRegisteredBoundedJson(JSON.stringify(value), budget) as Input; }
function empty() { return { tenantId: 't', migrationJobId: 'j', sheets: { schemaVersion: 1, digest: 'd', tabs: {} } }; }
function transaction(text: string): Input {
  const fixture = golden.cases.find((fixture) => fixture.input.sheets.tabs.Transactions?.rows.length)!;
  const input = JSON.parse(JSON.stringify(fixture.input)) as Input;
  const tab = input.sheets.tabs.Transactions;
  (tab.rows[0].cells as string[])[tab.headers.indexOf('items')] = text;
  return input;
}

describe('normalizer entry and transaction seam — NOT whole-callgraph bounded acceptance', () => {
  it('rejects an unregistered proxy before graph access', () => {
    let touched = false;
    const input = new Proxy({} as Input, { get() { touched = true; throw new Error('getter ran'); } });
    expect(() => run(input, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.');
    expect(touched).toBe(false);
  });
  it('rejects a graph owned by another request', () => {
    const input = admit(empty(), createBudgetContext({ now: () => 0 }));
    expect(() => run(input, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.');
  });
  it('refuses exhausted entry work before native header enumeration', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const input = admit(empty(), budget);
    budget.spend(budget.limits.work - budget.usage().work);
    const original = Object.keys;
    let reached = false;
    const spy = vi.spyOn(Object, 'keys').mockImplementation((value) => { if (value === input.sheets.tabs) reached = true; return original(value); });
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); } finally { spy.mockRestore(); }
    expect(reached).toBe(false);
  });
  for (const kind of ['sheets', 'redis'] as const) {
    for (const count of [1999, 2000, 2001]) {
      it(`${kind} aggregate ${count} is checked before native normalization`, () => {
        const budget = createBudgetContext({ now: () => 0 });
        const value = kind === 'sheets'
          ? { ...empty(), sheets: { ...empty().sheets, tabs: { Alpha: { headers: [], rows: Array(1000).fill(null) }, Beta: { headers: [], rows: Array(count - 1000).fill(null) } } } }
          : { ...empty(), redis: { v2Claims: Array(500).fill(null), operationBindings: Array(500).fill(null), v1Tombstones: Array(500).fill(null), orphanedClaimDigests: Array(count - 1500).fill('x') } };
        const input = admit(value, budget);
        const original = Object.keys, sentinel = new Error('native normalization reached');
        let calls = 0;
        const spy = vi.spyOn(Object, 'keys').mockImplementation((object) => { if (object === input.sheets.tabs) { calls++; throw sentinel; } return original(object); });
        try { expect(() => run(input, budget)).toThrow(count > 2000 ? BudgetExceededError : sentinel); } finally { spy.mockRestore(); }
        expect(calls).toBe(count > 2000 ? 0 : 1);
      });
    }
  }
  it('does not impose the interactive row cap on omitted contexts', () => {
    const input = { ...empty(), sheets: { ...empty().sheets, tabs: { Unknown: { headers: [], rows: Array(2001).fill(null) } } } } as unknown as Input;
    const original = Object.keys, sentinel = new Error('native normalization reached');
    const spy = vi.spyOn(Object, 'keys').mockImplementation((object) => { if (object === input.sheets.tabs) throw sentinel; return original(object); });
    try { expect(() => run(input)).toThrow(sentinel); } finally { spy.mockRestore(); }
  });
  it('accumulates real entry traversal across two calls using one request', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const input = admit(empty(), budget), before = budget.usage();
    run(input, budget); const first = budget.usage();
    run(input, budget); const second = budget.usage();
    expect(first.work).toBeGreaterThan(before.work);
    expect(first.nodes).toBeGreaterThan(before.nodes);
    expect(second.work - first.work).toBe(first.work - before.work);
    expect(second.nodes - first.nodes).toBe(first.nodes - before.nodes);
  });
  for (const remaining of [68, 69, 70]) {
    it(`initial five-container recipe reserves before native Set with ${remaining} nodes remaining`, () => {
      const budget = createBudgetContext({ now: () => 0 }), input = admit(empty(), budget);
      // Registered input admission has 64 fixed scratch nodes; initial lists/indexes have five.
      budget.reserve({ nodes: budget.limits.nodes - budget.usage().nodes - remaining });
      const native = globalThis.Set, sentinel = new Error('initial Set reached');
      let calls = 0;
      const replacement = new Proxy(native, { construct() { calls++; throw sentinel; } });
      globalThis.Set = replacement;
      let error: unknown;
      try { run(input, budget); } catch (caught) { error = caught; } finally { globalThis.Set = native; }
      if (remaining < 69) expect(error).toBeInstanceOf(BudgetExceededError);
      else expect(error).toBe(sentinel);
      expect(calls).toBe(remaining < 69 ? 0 : 1);
    });
  }
  for (const counter of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) {
    for (const offset of [-1, 0, 1]) {
      it(`entry/cell/parser cumulative ${counter} at measured limit ${offset}`, () => {
        const value = transaction('[{"productId":"p","name":"n","price":1,"quantity":1,"subtotal":1}]');
        const measurement = createBudgetContext({ now: () => 0 }), measuredInput = admit(value, measurement);
        const before = measurement.usage()[counter];
        run(measuredInput, measurement);
        const total = measurement.usage()[counter];
        expect(total).toBeGreaterThan(before);
        const budget = createBudgetContext({ now: () => 0, limits: { [counter]: total + offset } });
        const input = admit(value, budget);
        if (offset < 0) expect(() => run(input, budget)).toThrow(BudgetExceededError);
        else { expect(() => run(input, budget)).not.toThrow(); expect(budget.usage()[counter]).toBe(total); }
      });
    }
  }
  for (const depth of [63, 64, 65]) {
    it(`nested transaction cell depth ${depth} refuses before native parse only above 64`, () => {
      const text = '['.repeat(depth - 1) + '0' + ']'.repeat(depth - 1);
      const budget = createBudgetContext({ now: () => 0 }), input = admit(transaction(text), budget);
      const native = JSON.parse; let calls = 0;
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((value, reviver) => { if (value === text) calls++; return native(value, reviver); });
      try {
        if (depth > 64) expect(() => run(input, budget)).toThrow(BudgetExceededError);
        else expect(() => run(input, budget)).not.toThrow();
      } finally { spy.mockRestore(); }
      expect(calls).toBe(depth > 64 ? 0 : 1);
    });
  }
  for (const mode of ['success', 'syntax', 'budget', 'unavailable'] as const) {
    it(`nested native ${mode} cannot swallow deadline/budget failures`, () => {
      let now = 0;
      const budget = createBudgetContext({ now: () => now }), text = '[]';
      const input = admit(transaction(text), budget), native = JSON.parse;
      const failure = mode === 'budget' ? new BudgetExceededError() : new BudgetUnavailableError();
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((value, reviver) => {
        if (value !== text) return native(value, reviver);
        now = 5000;
        if (mode === 'syntax') throw new SyntaxError('ordinary native failure');
        if (mode !== 'success') throw failure;
        return native(value, reviver);
      });
      let thrown: unknown;
      try { run(input, budget); } catch (error) { thrown = error; } finally { spy.mockRestore(); }
      if (mode === 'budget' || mode === 'unavailable') expect(thrown).toBe(failure);
      else expect(thrown).toBeInstanceOf(BudgetUnavailableError);
    });
  }
  it('passes the same context into real canonical item validation', () => {
    const text = '[{"productId":"p","name":"n","price":1,"quantity":1,"subtotal":1}]';
    const budget = createBudgetContext({ now: () => 0 }), input = admit(transaction(text), budget);
    const spy = vi.spyOn(semantic, 'canonicalTransactionItem');
    try { run(input, budget); expect(spy).toHaveBeenCalledWith(expect.any(Object), expect.any(Boolean), budget); } finally { spy.mockRestore(); }
  });
  it('reserves an items-cell copy before String/trim, not merely before JSON.parse', () => {
    const text = '[{"productId":"p","name":"n","price":1,"quantity":1,"subtotal":1}]';
    const budget = createBudgetContext({ now: () => 0 }), input = admit(transaction(text), budget);
    const nativeGet = Map.prototype.get, nativeTrim = String.prototype.trim;
    let trimmed = false, exhausted = false;
    const getSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      if (key === 'items' && !exhausted) {
        exhausted = true;
        budget.reserve({ contentBytes: budget.limits.contentBytes - budget.usage().contentBytes });
      }
      return nativeGet.call(this, key);
    });
    const trimSpy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      if (String(this) === text) trimmed = true;
      return nativeTrim.call(this);
    });
    try { expect(() => run(input, budget)).toThrow(BudgetExceededError); } finally { getSpy.mockRestore(); trimSpy.mockRestore(); }
    expect(exhausted).toBe(true);
    expect(trimmed).toBe(false);
  });
  it('does not lose an ordinary late items-cell trim exception outside the parser catch', () => {
    let now = 0;
    const text = '[]', budget = createBudgetContext({ now: () => now }), input = admit(transaction(text), budget);
    const nativeTrim = String.prototype.trim;
    const spy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      if (String(this) === text) { now = 5000; throw new Error('late trim'); }
      return nativeTrim.call(this);
    });
    try { expect(() => run(input, budget)).toThrow(BudgetUnavailableError); } finally { spy.mockRestore(); }
  });
  for (const enabled of [false, true]) {
    it.each(golden.cases)(`preserves original direct normalizer bytes and mutability (budget=${enabled}): $name`, (fixture) => {
      const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
      const input = budget ? admit(fixture.input, budget) : JSON.parse(JSON.stringify(fixture.input)) as Input;
      if (fixture.outcome.error) {
        try { run(input, budget); throw new Error('expected original error'); } catch (error) { expect({ name: (error as Error).name, message: (error as Error).message }).toEqual(fixture.outcome.error); }
      } else {
        const result = run(input, budget);
        expect(JSON.stringify(result)).toBe(fixture.outcome.json);
        expect(Object.isFrozen(result)).toBe(fixture.outcome.frozen);
        expect(Object.isFrozen(result.sourceRecords)).toBe(fixture.outcome.sourceFrozen);
        expect(Object.getPrototypeOf(result.records) === null).toBe(fixture.outcome.recordsNullPrototype);
        const sourceBytes = JSON.stringify(input);
        result.sourceRecords.push({} as never);
        expect(JSON.stringify(input)).toBe(sourceBytes);
      }
    });
  }
});
