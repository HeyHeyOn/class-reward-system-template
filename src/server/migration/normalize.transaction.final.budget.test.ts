import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as bounded from '@/lib/boundedWork';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/transaction-item-loop-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json: string; canonicalItemRows: number } }[];
};
const dimensions = ['nodes', 'slots', 'structuralBytes', 'work'] as const;
type Dimension = typeof dimensions[number];
function leave(b: BudgetContext, dimension: Dimension | 'contentBytes', remaining: number) {
  const debit = b.limits[dimension] - b.usage()[dimension] - remaining;
  if (dimension === 'work') b.spend(debit); else b.reserve({ [dimension]: debit });
}
function admitted(b: BudgetContext, index = 0) {
  return parseRegisteredBoundedJson(JSON.stringify(golden.cases[index].input), b) as Input;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

describe('final transaction construction reached boundaries', () => {
  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) {
    it(`canonical plus student ref ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      // Canonical 10-field upper bound + ref 3-field record/destination.
      const costs = { nodes: 15, slots: 14, structuralBytes: 248, work: 15 };
      const push = Array.prototype.push;
      let reached = false, refs = 0, error: unknown;
      Array.prototype.push = function(...values: unknown[]) {
        const result = push.apply(this, values);
        for (const value of values) {
          const r = record(value);
          if (!reached && r?.itemId && 'productId' in r) { reached = true; leave(b, dimension, costs[dimension] + delta); }
          else if (reached && r?.code === 'BROKEN_STUDENT_REFERENCE' && r.table === 'students') refs++;
        }
        return result;
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(refs).toBe(delta < 0 ? 0 : 1);
    });
    it(`staged transaction plus Target ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      const costs = { nodes: 30, slots: 28, structuralBytes: 587, work: 42 };
      const push = Array.prototype.push;
      let reached = false, targets = 0, error: unknown;
      Array.prototype.push = function(...values: unknown[]) {
        const result = push.apply(this, values);
        for (const value of values) {
          const r = record(value);
          if (!reached && r?.code === 'BROKEN_STUDENT_REFERENCE' && r.table === 'students') { reached = true; leave(b, dimension, costs[dimension] + delta); }
          else if (reached && r?.table === 'transactions' && r.record) targets++;
        }
        return result;
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(targets).toBe(delta < 0 ? 0 : 1);
    });
    it(`item Target preallocation before String argument ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      const costs = { nodes: 25, slots: 23, structuralBytes: 491, work: 28 };
      const push = Array.prototype.push, nativeString = String;
      let reached = false, strings = 0, error: unknown;
      const str = vi.spyOn(globalThis, 'String').mockImplementation(value => {
        if (reached) strings++;
        return nativeString(value);
      });
      Array.prototype.push = function(...values: unknown[]) {
        const result = push.apply(this, values);
        if (!reached && values.some(v => record(v)?.table === 'transactions' && record(v)?.record)) {
          reached = true; leave(b, dimension, costs[dimension] + delta);
        }
        return result;
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; str.mockRestore(); }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(strings).toBe(delta < 0 ? 0 : 1);
    });
    it(`base staged literal before product operands ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      const costs = { nodes: 11, slots: 10, structuralBytes: 226, work: 11 };
      const push = Array.prototype.push, nativeString = String;
      let targetReached = false, reached = false, reads = 0, itemId: unknown, error: unknown;
      const str = vi.spyOn(globalThis, 'String').mockImplementation(value => {
        const result = nativeString(value);
        if (targetReached && !reached && value === itemId) { reached = true; leave(b, dimension, costs[dimension] + delta); }
        return result;
      });
      Array.prototype.push = function(...values: unknown[]) {
        for (const value of values) {
          const r = record(value);
          if (r?.itemId && 'productId' in r) {
            itemId = r.itemId; const product = r.productId;
            Object.defineProperty(r, 'productId', { enumerable: true, configurable: true, get() { if (reached) reads++; return product; } });
          }
          if (r?.table === 'transactions' && r.record) targetReached = true;
        }
        return push.apply(this, values);
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; str.mockRestore(); }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(reads).toBe(delta < 0 ? 0 : 2);
    });
  }

  for (const dimension of dimensions) it(`extended assign operand refuses exhausted ${dimension}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 3);
    const push = Array.prototype.push, assign = Object.assign;
    let reached = false, operands = 0, assigns = 0, error: unknown;
    Object.assign = function(target: object, ...sources: unknown[]) {
      if (reached && 'unitPriceSnapshot' in target) assigns++;
      return assign(target, ...sources);
    };
    Array.prototype.push = function(...values: unknown[]) {
      for (const value of values) {
        const r = record(value);
        if (r?.itemId && 'productId' in r) {
          const subtotal = r.subtotal, regular = r.regularUnitPrice;
          Object.defineProperty(r, 'subtotal', { enumerable: true, configurable: true, get() {
            if (!reached) { reached = true; leave(b, dimension, 0); }
            return subtotal;
          } });
          Object.defineProperty(r, 'regularUnitPrice', { enumerable: true, configurable: true, get() { if (reached) operands++; return regular; } });
        }
      }
      return push.apply(this, values);
    };
    try { run(input, b); } catch (e) { error = e; }
    finally { Array.prototype.push = push; Object.assign = assign; }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
    expect(operands).toBe(0); expect(assigns).toBe(0);
  });

  for (const boundary of ['student-ref', 'transaction-target', 'item-string', 'assign', 'item-target'] as const)
    for (const mode of ['timely-error', 'late-success', 'late-error', 'abort-error', 'exceeded', 'unavailable'] as const)
      it(`${boundary} native ${mode}`, () => {
        let now = 0;
        const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal }), input = admitted(b, 3);
        const failure = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : new RangeError('sentinel');
        const push = Array.prototype.push, assign = Object.assign, nativeString = String;
        let reached = false, transactionTarget = false, afterBoundary = 0, error: unknown;
        function hit() {
          if (reached) return;
          reached = true;
          if (mode === 'abort-error') signal.aborted = true;
          else if (mode !== 'timely-error') now = 5000;
          if (mode !== 'late-success') throw failure;
        }
        const str = vi.spyOn(globalThis, 'String').mockImplementation(value => {
          if (reached && boundary === 'transaction-target') afterBoundary++;
          const result = nativeString(value);
          if (boundary === 'item-string' && transactionTarget) hit();
          return result;
        });
        Object.assign = function(target: object, ...sources: unknown[]) {
          if (reached && boundary === 'item-string' && 'unitPriceSnapshot' in target) afterBoundary++;
          const result = assign(target, ...sources);
          if (boundary === 'assign' && transactionTarget && 'unitPriceSnapshot' in target) hit();
          return result;
        };
        Array.prototype.push = function(...values: unknown[]) {
          const result = push.apply(this, values);
          for (const value of values) {
            const r = record(value);
            if (reached && ((boundary === 'student-ref' && r?.table === 'transactions' && r.record)
              || (boundary === 'assign' && r?.table === 'transaction_items' && r.record))) afterBoundary++;
            if (r?.table === 'transactions' && r.record) transactionTarget = true;
            if ((boundary === 'student-ref' && r?.code === 'BROKEN_STUDENT_REFERENCE' && r.table === 'students')
              || (boundary === 'transaction-target' && r?.table === 'transactions' && r.record)
              || (boundary === 'item-target' && r?.table === 'transaction_items' && r.record)) hit();
          }
          return result;
        };
        try { run(input, b); } catch (e) { error = e; }
        finally { Array.prototype.push = push; Object.assign = assign; str.mockRestore(); }
        expect(reached).toBe(true);
        if (mode === 'timely-error' || mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(failure);
        else expect(error).toBeInstanceOf(BudgetUnavailableError);
        expect(afterBoundary).toBe(0);
      });
});

describe('final records frozen parity and ownership', () => {
  for (const f of golden.cases) for (const bounded of [false, true]) it(`${f.name} budget=${bounded}`, () => {
    const b = bounded ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = b ? parseRegisteredBoundedJson(JSON.stringify(f.input), b) as Input : f.input;
    const result = run(input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(result.records.transaction_items?.length ?? 0).toBe(f.outcome.canonicalItemRows);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    for (const r of [...result.records.transactions ?? [], ...result.records.transaction_items ?? []]) {
      expect(Object.isFrozen(r)).toBe(false);
      r.mutable = true; expect(r.mutable).toBe(true);
    }
  });
  it('two calls share cumulative counters and preserve accepted duplicate references', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 14);
    const first = run(input, b), used = b.usage();
    const second = run(input, b);
    expect(JSON.stringify(first)).toBe(golden.cases[14].outcome.json);
    expect(JSON.stringify(second)).toBe(golden.cases[14].outcome.json);
    expect(second.records.transactions).toHaveLength(2); expect(second.records.transaction_items).toHaveLength(2);
    for (const key of [...dimensions, 'contentBytes'] as const) expect(b.usage()[key]).toBeGreaterThan(used[key]);
  });
});


describe('closed final literal factory and clone boundaries', () => {
  for (const phase of ['canonical', 'staged-transaction'] as const)
    for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`${phase} literal factory ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      const costs = phase === 'canonical'
        ? { nodes: 11, slots: 10, structuralBytes: 193, work: 11 }
        : { nodes: 30, slots: 28, structuralBytes: 587, work: 42 };
      const push = Array.prototype.push, nativeAllocate = bounded.allocate;
      let reached = false, factories = 0, error: unknown;
      const allocate = vi.spyOn(bounded, 'allocate').mockImplementation(function<T>(context: BudgetContext | undefined, cost: bounded.Allocation, factory: () => T): T {
        return nativeAllocate(context, cost, () => {
          if (context === b && cost.structuralBytes === costs.structuralBytes) factories++;
          return factory();
        });
      });
      Array.prototype.push = function(...values: unknown[]) {
        const result = push.apply(this, values);
        if (!reached && values.some(value => {
          const r = record(value);
          return phase === 'canonical' ? r?.itemId && 'productId' in r
            : r?.code === 'BROKEN_STUDENT_REFERENCE' && r.table === 'students';
        })) { reached = true; leave(b, dimension, costs[dimension] + delta); }
        return result;
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; allocate.mockRestore(); }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(factories).toBe(delta < 0 ? 0 : 1);
    });

  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`extended temporary literal and destination ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 3);
    const costs = { nodes: 19, slots: 18, structuralBytes: 424, work: 20 };
    const push = Array.prototype.push, assign = Object.assign;
    const stop = new RangeError('stop after the reached assign');
    let reached = false, operands = 0, assigns = 0, error: unknown;
    Object.assign = function(target: object, ...sources: unknown[]) {
      const result = assign(target, ...sources);
      if (reached && 'unitPriceSnapshot' in target) { assigns++; throw stop; }
      return result;
    };
    Array.prototype.push = function(...values: unknown[]) {
      for (let i = 0; i < values.length; i++) {
        const r = record(values[i]);
        if (r?.itemId && 'productId' in r) values[i] = new Proxy(r, {
          has(target, key) {
            const result = Reflect.has(target, key);
            if (!reached && key === 'regularUnitPrice') { reached = true; leave(b, dimension, costs[dimension] + delta); }
            return result;
          },
          get(target, key, receiver) { if (reached && key === 'regularUnitPrice') operands++; return Reflect.get(target, key, receiver); },
        });
      }
      return push.apply(this, values);
    };
    try { run(input, b); } catch (e) { error = e; }
    finally { Array.prototype.push = push; Object.assign = assign; }
    expect(reached).toBe(true);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
    expect(operands).toBe(delta < 0 ? 0 : 1); expect(assigns).toBe(delta < 0 ? 0 : 1);
  });

  for (const mode of ['timely-error', 'late-success', 'late-error', 'abort-error', 'exceeded', 'unavailable'] as const)
    it(`shared Target clone ${mode} never appends a late clone`, () => {
      let now = 0;
      const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal }), input = admitted(b, 3);
      const failure = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : new RangeError('clone sentinel');
      const push = Array.prototype.push, assign = Object.assign;
      let reached = false, appends = 0, error: unknown;
      Object.assign = function(target: object, ...sources: unknown[]) {
        const result = assign(target, ...sources);
        if ('unitPriceSnapshot' in target) {
          const tenant = (target as Record<string, unknown>).tenantId;
          Object.defineProperty(target, 'tenantId', { enumerable: true, configurable: true, get() {
            reached = true;
            if (mode === 'abort-error') signal.aborted = true;
            else if (mode !== 'timely-error') now = 5000;
            if (mode !== 'late-success') throw failure;
            return tenant;
          } });
        }
        return result;
      };
      Array.prototype.push = function(...values: unknown[]) {
        if (reached && values.some(value => record(value)?.table === 'transaction_items' && record(value)?.record)) appends++;
        return push.apply(this, values);
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; Object.assign = assign; }
      expect(reached).toBe(true); expect(appends).toBe(0);
      if (mode === 'timely-error' || mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(failure);
      else expect(error).toBeInstanceOf(BudgetUnavailableError);
    });
});


const finalGolden = JSON.parse(readFileSync('src/server/migration/__fixtures__/transaction-final-records-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json: string; canonicalItemRows: number; canonicalTransactionRows: number } }[];
};
describe('supplemental byte-exact Git final-stage oracles', () => {
  for (const f of finalGolden.cases) for (const bounded of [false, true]) it(`${f.name} budget=${bounded}`, () => {
    const b = bounded ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = b ? parseRegisteredBoundedJson(JSON.stringify(f.input), b) as Input : f.input;
    const result = run(input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(result.records.transactions).toHaveLength(f.outcome.canonicalTransactionRows);
    expect(result.records.transaction_items).toHaveLength(f.outcome.canonicalItemRows);
    for (const item of result.records.transaction_items) {
      if (f.name.startsWith('ADMIN_ADJUSTMENT')) expect(item.currentProductId).toBe(null);
      expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
      expect(Object.isFrozen(item)).toBe(false);
      if (b) expect(() => assertRegisteredBoundedJson(item, b)).toThrow('Legacy bounded JSON is invalid.');
    }
  });

  for (const delta of [-1, 0, 1]) it(`UUID String contentBytes ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const push = Array.prototype.push, nativeString = String, stop = new RangeError('String reached');
    let reached = false, strings = 0, error: unknown;
    const str = vi.spyOn(globalThis, 'String').mockImplementation(value => {
      if (reached) { strings++; throw stop; }
      return nativeString(value);
    });
    Array.prototype.push = function(...values: unknown[]) {
      const result = push.apply(this, values);
      if (!reached && values.some(v => record(v)?.table === 'transactions' && record(v)?.record)) {
        reached = true; leave(b, 'contentBytes', 36 + delta);
      }
      return result;
    };
    try { run(input, b); } catch (e) { error = e; }
    finally { Array.prototype.push = push; str.mockRestore(); }
    expect(reached).toBe(true); expect(strings).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });

  for (const index of [14, 15, 16]) it(`each real staged Target and duplicate ref is charged: ${golden.cases[index].name}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, index);
    const push = Array.prototype.push, seen = new Set<unknown>();
    const snapshots: bounded.BudgetUsage[] = [];
    let refs = 0;
    Array.prototype.push = function(...values: unknown[]) {
      for (const value of values) {
        const r = record(value);
        if (r?.table === 'students' && r.code === 'BROKEN_STUDENT_REFERENCE') refs++;
        if (r?.table === 'transaction_items' && r.record && !seen.has(value)) {
          seen.add(value); push.call(snapshots, b.usage());
        }
      }
      return push.apply(this, values);
    };
    let result: ReturnType<typeof run>;
    try { result = run(input, b); } finally { Array.prototype.push = push; }
    expect(JSON.stringify(result!)).toBe(golden.cases[index].outcome.json);
    expect(refs).toBe(index === 14 ? 2 : 1);
    expect(snapshots).toHaveLength(index === 14 ? 2 : index === 15 ? 16 : 512);
    for (let i = 1; i < snapshots.length; i++) for (const key of [...dimensions, 'contentBytes'] as const)
      expect(snapshots[i][key]).toBeGreaterThan(snapshots[i - 1][key]);
  });

  it('shallow staged clones preserve nested aliases while remaining detached from immutable input', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 3), result = run(input, b);
    const source = result.sourceRecords.find(r => r.source.kind === 'SHEET' && r.source.tab === 'Transactions')!;
    const canonical = (source.canonicalRecord!.items as Record<string, unknown>[])[0];
    const staged = result.records.transaction_items[0];
    expect(staged).not.toBe(canonical);
    expect(staged.adjustmentsSnapshot).toBe(canonical.adjustments);
    expect(staged.appliedPromotionsSnapshot).toBe(canonical.appliedPromotions);
    expect(Object.isFrozen(staged.appliedPromotionsSnapshot)).toBe(false);
    (staged.appliedPromotionsSnapshot as unknown[]).push('mutable');
    expect((canonical.appliedPromotions as unknown[]).at(-1)).toBe('mutable');
    expect(() => assertRegisteredBoundedJson(canonical, b)).toThrow('Legacy bounded JSON is invalid.');
    expect(Object.isFrozen(input)).toBe(true);
  });

  for (const boundary of ['student-ref', 'transaction-target', 'item-string', 'assign', 'clone', 'item-target'] as const)
    it(`no-budget ordinary native error identity: ${boundary}`, () => {
      const failure = new RangeError('unchanged native failure');
      const push = Array.prototype.push, assign = Object.assign, nativeString = String;
      let transaction = false, reached = false, error: unknown;
      function hit(): never { reached = true; throw failure; }
      const str = vi.spyOn(globalThis, 'String').mockImplementation(value => {
        if (transaction && boundary === 'item-string') hit();
        return nativeString(value);
      });
      Object.assign = function(target: object, ...sources: unknown[]) {
        const result = assign(target, ...sources);
        if ('unitPriceSnapshot' in target) {
          if (boundary === 'assign') hit();
          if (boundary === 'clone') Object.defineProperty(target, 'tenantId', { enumerable: true, get: hit });
        }
        return result;
      };
      Array.prototype.push = function(...values: unknown[]) {
        for (const value of values) {
          const r = record(value);
          if (r?.table === 'transactions' && r.record) transaction = true;
          if ((boundary === 'student-ref' && r?.table === 'students' && r.code === 'BROKEN_STUDENT_REFERENCE')
            || (boundary === 'transaction-target' && r?.table === 'transactions' && r.record)
            || (boundary === 'item-target' && r?.table === 'transaction_items' && r.record)) hit();
        }
        return push.apply(this, values);
      };
      try { run(golden.cases[3].input); } catch (e) { error = e; }
      finally { Array.prototype.push = push; Object.assign = assign; str.mockRestore(); }
      expect(reached).toBe(true); expect(error).toBe(failure);
    });
});


describe('student reference literal factory', () => {
  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`${dimension} ${delta} before ref literal and append`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const costs = { nodes: 4, slots: 4, structuralBytes: 55, work: 4 };
    const nativeAllocate = bounded.allocate;
    let reached = false, factories = 0, error: unknown;
    const allocate = vi.spyOn(bounded, 'allocate').mockImplementation(function<T>(context: BudgetContext | undefined, cost: bounded.Allocation, factory: () => T): T {
      const result = nativeAllocate(context, cost, () => {
        if (context === b && reached && cost.structuralBytes === 55) factories++;
        return factory();
      });
      if (!reached && context === b && cost.structuralBytes === 193) {
        reached = true; leave(b, dimension, costs[dimension] + delta);
      }
      return result;
    });
    try { run(input, b); } catch (e) { error = e; }
    finally { allocate.mockRestore(); }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
    expect(factories).toBe(delta < 0 ? 0 : 1);
  });
});
