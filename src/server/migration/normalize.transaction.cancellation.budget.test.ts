import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import * as bounded from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as semantic from './semanticValidators';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/transaction-cancellation-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json: string; transactions: number } }[];
};
const dimensions = ['nodes', 'slots', 'structuralBytes', 'work'] as const;
type Dimension = typeof dimensions[number];
function leave(b: BudgetContext, d: Dimension, remaining: number) {
  const debit = b.limits[d] - b.usage()[d] - remaining;
  if (d === 'work') b.spend(debit); else b.reserve({ [d]: debit });
}
function admitted(b: BudgetContext, name = 'accepted') {
  return parseRegisteredBoundedJson(JSON.stringify(golden.cases.find(f => f.name === name)!.input), b) as Input;
}
function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? v as Record<string, unknown> : undefined;
}

describe('frozen Git cancellation semantics', () => {
  for (const f of golden.cases) for (const bounded of [false, true]) it(`${f.name} budget=${bounded}`, () => {
    const b = bounded ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = b ? admitted(b, f.name) : f.input;
    const result = run(input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(result.records.transactions).toHaveLength(f.outcome.transactions);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    if (f.name === 'accepted') {
      expect(result.records.transactions).toHaveLength(2);
      const staged = result.records.transactions.find(r => r.kind === 'CANCELLATION')!;
      const canonical = result.sourceRecords.find(r => r.canonicalRecord?.status === 'CANCEL_REVERSAL')!.canonicalRecord!;
      expect(staged.reversesTransactionId).toBe(canonical.reversesTransactionId);
      expect(staged).not.toBe(canonical);
      expect(Object.getPrototypeOf(staged)).toBe(Object.prototype);
      expect(Object.isFrozen(staged)).toBe(false);
      expect(Object.isFrozen(canonical.items)).toBe(false);
      if (b) {
        expect(() => assertRegisteredBoundedJson(staged, b)).toThrow('Legacy bounded JSON is invalid.');
        expect(() => assertRegisteredBoundedJson(canonical, b)).toThrow('Legacy bounded JSON is invalid.');
      }
      staged.operatorSnapshot = 'mutable';
      expect(canonical.operator).not.toBe('mutable');
    }
  });
});

describe('cancellation actual caller context and preallocation', () => {
  it('passes the identical cumulative context to cancellation and scalar validators', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const original = vi.spyOn(semantic, 'cancellationOriginalId');
    const id = vi.spyOn(validators, 'canonicalId');
    const instant = vi.spyOn(validators, 'canonicalInstant');
    const integer = vi.spyOn(validators, 'safeInteger');
    try {
      const start = b.usage(); run(input, b); const first = b.usage(); run(input, b); const second = b.usage();
      expect(original.mock.calls).toHaveLength(2);
      for (const call of original.mock.calls) expect(call[1]).toBe(b);
      for (const call of id.mock.calls.filter(c => c[0] === 'C1')) expect(call[1]).toBe(b);
      for (const call of instant.mock.calls.filter(c => c[0] === '2026-08-31T00:01:00.000Z')) expect(call[1]).toBe(b);
      for (const call of integer.mock.calls.filter(c => c[0] === '-20')) expect(call[2]).toBe(b);
      for (const d of [...dimensions, 'contentBytes'] as const) { expect(first[d]).toBeGreaterThan(start[d]); expect(second[d]).toBeGreaterThan(first[d]); }
    } finally { original.mockRestore(); id.mockRestore(); instant.mockRestore(); integer.mockRestore(); }
  });

  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) {
    it(`canonical empty items factory ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      const cost = { nodes: 13, slots: 11, structuralBytes: 238, work: 13 };
      const original = semantic.cancellationOriginalId, allocate = bounded.allocate;
      let reached = false, factories = 0, error: unknown;
      const helper = vi.spyOn(semantic, 'cancellationOriginalId').mockImplementation((operator, context) => {
        const value = original(operator, context); reached = true; leave(b, dimension, cost[dimension] + delta); return value;
      });
      const factory = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => allocate(context, amount, () => {
        if (reached && amount.structuralBytes === 238) factories++;
        return make();
      }));
      try { run(input, b); } catch (e) { error = e; }
      finally { helper.mockRestore(); factory.mockRestore(); }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(factories).toBe(delta < 0 ? 0 : 1);
    });
    it(`two refs factory ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      const cost = { nodes: 8, slots: 8, structuralBytes: 110, work: 8 };
      const allocate = bounded.allocate, push = Array.prototype.push;
      let reached = false, factories = 0, refs = 0, error: unknown;
      // Same-context canonical factory precedes the bounded condition and refs.
      const factory = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
        const result = allocate(context, amount, () => { if (amount.structuralBytes === 110) factories++; return make(); });
        if (amount.structuralBytes === 238) { reached = true; leave(b, dimension, cost[dimension] + (dimension === 'work' ? 12 : 0) + delta); }
        return result;
      });
      Array.prototype.push = function(...values: unknown[]) {
        for (const v of values) if (record(v)?.code === 'BROKEN_TRANSACTION_REFERENCE' && record(v)?.table === 'transactions') refs++;
        return push.apply(this, values);
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; factory.mockRestore(); vi.restoreAllMocks(); }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(factories).toBe(delta < 0 ? 0 : 1); expect(refs).toBe(delta < 0 ? 0 : 1);
    });
    it(`staged payload clone Target destination ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
      const cost = { nodes: 32, slots: 30, structuralBytes: 645, work: 32 };
      const push = Array.prototype.push, allocate = bounded.allocate;
      let reached = false, factories = 0, targets = 0, error: unknown;
      const factory = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => allocate(context, amount, () => {
        if (amount.structuralBytes === 645) factories++;
        return make();
      }));
      Array.prototype.push = function(...values: unknown[]) {
        const result = push.apply(this, values);
        for (const value of values) {
          const r = record(value);
          if (!reached && r?.code === 'BROKEN_TRANSACTION_REFERENCE' && r.table === 'transactions') { reached = true; leave(b, dimension, cost[dimension] + delta); }
          if (reached && r?.table === 'transactions' && record(r.record)?.kind === 'CANCELLATION') targets++;
        }
        return result;
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { Array.prototype.push = push; factory.mockRestore(); }
      expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
      expect(factories).toBe(delta < 0 ? 0 : 1); expect(targets).toBe(delta < 0 ? 0 : 1);
    });
  }

  for (const dimension of dimensions) for (const delta of [-1, 0, 1])
    it(`malformed cancellation error slot ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'self-original');
      const cost = { nodes: 1, slots: 1, structuralBytes: 8, work: 13 }, allocate = bounded.allocate, push = Array.prototype.push;
      let reached = false, errors = 0, error: unknown;
      const factory = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
        const result = allocate(context, amount, make);
        if (amount.structuralBytes === 238) { reached = true; leave(b, dimension, cost[dimension] + delta); }
        return result;
      });
      const stop = new RangeError('stop after first malformed cancellation occurrence');
      Array.prototype.push = function(...values: unknown[]) {
        if (values.includes('MALFORMED_CANCELLATION_HISTORY')) { errors++; throw stop; }
        return push.apply(this, values);
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { factory.mockRestore(); Array.prototype.push = push; }
      expect(reached).toBe(true);
      if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
      expect(errors).toBe(delta < 0 ? 0 : 1);
    });

  it('charges long rejected status membership before Set.has', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'bad-status');
    const parse = semantic.parseTransactionItemsJson, has = Set.prototype.has;
    let reached = false, lookups = 0, error: unknown;
    const parser = vi.spyOn(semantic, 'parseTransactionItemsJson').mockImplementation((text, context) => {
      const result = parse(text, context);
      if (text === '[]') { reached = true; leave(b, 'work', 0); }
      return result;
    });
    Set.prototype.has = function(value: unknown) { if (typeof value === 'string' && value.length === 513) lookups++; return has.call(this, value); };
    try { run(input, b); } catch (e) { error = e; }
    finally { parser.mockRestore(); Set.prototype.has = has; }
    expect(reached).toBe(true); expect(lookups).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('supplemental cancellation closed boundaries', () => {
  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`rejected status malformed occurrence ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'bad-status');
    const cost = { nodes: 1, slots: 1, structuralBytes: 8, work: 1 };
    const has = Set.prototype.has, push = Array.prototype.push, stop = new RangeError('first malformed occurrence');
    let reached = false, errors = 0, error: unknown;
    Set.prototype.has = function(value: unknown) {
      const result = has.call(this, value);
      if (typeof value === 'string' && value.length === 513) { reached = true; leave(b, dimension, cost[dimension] + delta); }
      return result;
    };
    Array.prototype.push = function(...values: unknown[]) {
      if (reached && values.includes('MALFORMED_REQUIRED_HISTORY')) { errors++; throw stop; }
      return push.apply(this, values);
    };
    try { run(input, b); } catch (e) { error = e; }
    finally { Set.prototype.has = has; Array.prototype.push = push; }
    expect(reached).toBe(true); expect(errors).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });

  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`supported Set factory ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const cost = { nodes: 7, slots: 10, structuralBytes: 92, work: 11 };
    const parse = semantic.parseTransactionItemsJson, allocate = bounded.allocate, stop = new RangeError('Set reached');
    let reached = false, factories = 0, error: unknown;
    const parser = vi.spyOn(semantic, 'parseTransactionItemsJson').mockImplementation((text, context) => {
      const result = parse(text, context);
      if (text === '[]') { reached = true; leave(b, dimension, cost[dimension] + delta); }
      return result;
    });
    const factory = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => allocate(context, amount, () => {
      const result = make();
      if (reached && amount.structuralBytes === 92) { factories++; throw stop; }
      return result;
    }));
    try { run(input, b); } catch (e) { error = e; }
    finally { parser.mockRestore(); factory.mockRestore(); }
    expect(reached).toBe(true); expect(factories).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });

  for (const mode of ['timely-error', 'late-success', 'late-error', 'abort-error', 'exceeded', 'unavailable'] as const)
    it(`actual staged record clone ${mode} never appends late`, () => {
      let now = 0;
      const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal }), input = admitted(b);
      const failure = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : new RangeError('clone sentinel');
      const allocate = bounded.allocate, push = Array.prototype.push;
      let reached = false, appends = 0, error: unknown;
      const factory = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
        const result = allocate(context, amount, make);
        if (context === b && amount.structuralBytes === 645 && record(result)?.kind === 'CANCELLATION') {
          const tenant = record(result)!.tenantId;
          Object.defineProperty(result, 'tenantId', { enumerable: true, configurable: true, get() {
            reached = true;
            if (mode === 'abort-error') signal.aborted = true; else if (mode !== 'timely-error') now = 5000;
            if (mode !== 'late-success') throw failure;
            return tenant;
          } });
        }
        return result;
      });
      Array.prototype.push = function(...values: unknown[]) {
        if (reached && values.some(v => record(record(v)?.record)?.kind === 'CANCELLATION')) appends++;
        return push.apply(this, values);
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { factory.mockRestore(); Array.prototype.push = push; }
      expect(reached).toBe(true); expect(appends).toBe(0);
      if (mode === 'timely-error' || mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(failure);
      else expect(error).toBeInstanceOf(BudgetUnavailableError);
    });

  for (const boundary of ['status', 'balance-delta', 'malformed'] as const)
    for (const mode of ['timely-error', 'late-success', 'late-error', 'abort-error', 'exceeded', 'unavailable'] as const)
      it(`${boundary} native exit ${mode}`, () => {
        let now = 0;
        const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal });
        const input = admitted(b, boundary === 'malformed' ? 'bad-status' : 'accepted');
        const failure = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native sentinel');
        const has = Set.prototype.has, integer = Number.isSafeInteger, push = Array.prototype.push;
        let armed = false, reached = false, later = 0, error: unknown;
        const parse = semantic.parseTransactionItemsJson;
        const parser = vi.spyOn(semantic, 'parseTransactionItemsJson').mockImplementation((text, context) => {
          const value = parse(text, context); if (text === '[]') armed = true; return value;
        });
        function hit() {
          if (reached) return; reached = true;
          if (mode === 'abort-error') signal.aborted = true; else if (mode !== 'timely-error') now = 5000;
          if (mode !== 'late-success') throw failure;
        }
        Set.prototype.has = function(value: unknown) {
          const result = has.call(this, value);
          if (armed && value === 'CANCEL_REVERSAL' && boundary === 'status') hit();
          return result;
        };
        Number.isSafeInteger = function(value: unknown) {
          const result = integer(value);
          if (armed && value === 20 && boundary === 'balance-delta') hit();
          return result;
        };
        Array.prototype.push = function(...values: unknown[]) {
          const result = push.apply(this, values);
          if (armed && boundary === 'malformed' && values.includes('MALFORMED_REQUIRED_HISTORY')) hit();
          if (reached && values.some(v => record(v)?.code === 'BROKEN_TRANSACTION_REFERENCE')) later++;
          return result;
        };
        try { run(input, b); } catch (e) { error = e; }
        finally { parser.mockRestore(); Set.prototype.has = has; Number.isSafeInteger = integer; Array.prototype.push = push; }
        expect(reached).toBe(true); expect(later).toBe(0);
        if (mode === 'timely-error' || mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(failure);
        else expect(error).toBeInstanceOf(BudgetUnavailableError);
      });

  for (const boundary of ['prefix', 'slice', 'refs', 'target', 'malformed'] as const) it(`no-budget native error identity ${boundary}`, () => {
    const failure = new RangeError('original native error'), input = golden.cases.find(f => f.name === (boundary === 'malformed' ? 'self-original' : 'accepted'))!.input;
    const prefix = String.prototype.startsWith, slice = String.prototype.slice, push = Array.prototype.push;
    let reached = false, error: unknown;
    function hit(): never { reached = true; throw failure; }
    String.prototype.startsWith = function(value: string, position?: number) {
      if (boundary === 'prefix' && String(this) === 'cancel:TX1') hit();
      return prefix.call(this, value, position);
    };
    String.prototype.slice = function(start?: number, end?: number) {
      if (boundary === 'slice' && String(this) === 'cancel:TX1') hit();
      return slice.call(this, start, end);
    };
    Array.prototype.push = function(...values: unknown[]) {
      for (const v of values) {
        if (boundary === 'refs' && record(v)?.code === 'BROKEN_TRANSACTION_REFERENCE'
          || boundary === 'target' && record(record(v)?.record)?.kind === 'CANCELLATION'
          || boundary === 'malformed' && v === 'MALFORMED_CANCELLATION_HISTORY') hit();
      }
      return push.apply(this, values);
    };
    try { run(input); } catch (e) { error = e; }
    finally { String.prototype.startsWith = prefix; String.prototype.slice = slice; Array.prototype.push = push; }
    expect(reached).toBe(true); expect(error).toBe(failure);
  });
});

describe('cancellation native exit boundaries', () => {
  for (const boundary of ['prefix', 'slice', 'refs', 'target'] as const)
    for (const mode of ['timely-error', 'late-success', 'late-error', 'abort-error', 'exceeded', 'unavailable'] as const)
      it(`${boundary} ${mode}`, () => {
        let now = 0;
        const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal }), input = admitted(b);
        const failure = mode === 'exceeded' ? new BudgetExceededError() : mode === 'unavailable' ? new BudgetUnavailableError() : new RangeError('cancellation sentinel');
        const prefix = String.prototype.startsWith, slice = String.prototype.slice, push = Array.prototype.push;
        let reached = false, later = 0, error: unknown;
        function hit() {
          if (reached) return; reached = true;
          if (mode === 'abort-error') signal.aborted = true; else if (mode !== 'timely-error') now = 5000;
          if (mode !== 'late-success') throw failure;
        }
        String.prototype.startsWith = function(search: string, position?: number) {
          const result = prefix.call(this, search, position);
          if (String(this) === 'cancel:TX1' && boundary === 'prefix') hit();
          return result;
        };
        String.prototype.slice = function(start?: number, end?: number) {
          if (reached && boundary === 'prefix' && String(this) === 'cancel:TX1') later++;
          const result = slice.call(this, start, end);
          if (String(this) === 'cancel:TX1' && boundary === 'slice') hit();
          return result;
        };
        Array.prototype.push = function(...values: unknown[]) {
          const result = push.apply(this, values);
          for (const value of values) {
            const r = record(value);
            if (reached && (boundary === 'slice' && r?.code === 'BROKEN_TRANSACTION_REFERENCE'
              || boundary === 'refs' && record(r?.record)?.kind === 'CANCELLATION')) later++;
            if (boundary === 'refs' && r?.code === 'BROKEN_TRANSACTION_REFERENCE' && r.table === 'transactions') hit();
            if (boundary === 'target' && record(r?.record)?.kind === 'CANCELLATION') hit();
          }
          return result;
        };
        try { run(input, b); } catch (e) { error = e; }
        finally { String.prototype.startsWith = prefix; String.prototype.slice = slice; Array.prototype.push = push; }
        expect(reached).toBe(true); expect(later).toBe(0);
        if (mode === 'timely-error' || mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(failure);
        else expect(error).toBeInstanceOf(BudgetUnavailableError);
      });
});
