import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import * as semantic from './semanticValidators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const frozen = JSON.parse(readFileSync('src/server/migration/__fixtures__/normalization-budget-golden.json', 'utf8')) as {
  results: { name: string; input: Input }[];
};
function fixture(): Input {
  const input = JSON.parse(JSON.stringify(frozen.results[0].input)) as Input;
  const transaction = input.sheets.tabs.Transactions;
  return { ...input, sheets: { ...input.sheets, tabs: { ...input.sheets.tabs,
    Transactions: { ...transaction, rows: [transaction.rows[0]] },
  } } };
}

describe('transaction construction preallocation at the actual accepted item subtree', () => {
  for (const dimension of ['nodes', 'slots', 'structuralBytes', 'work'] as const) {
    it(`ref/item-ID expansion refuses exhausted ${dimension} after real product Set insertion`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      const input = parseRegisteredBoundedJson(JSON.stringify(fixture()), budget) as Input;
      const nativeAdd = Set.prototype.add;
      const nativeCanonicalItem = semantic.canonicalTransactionItem;
      let product: string | undefined;
      let reached = false;
      const item = vi.spyOn(semantic, 'canonicalTransactionItem').mockImplementation((value, signed, context) => {
        const result = nativeCanonicalItem(value, signed, context);
        if (result && context === budget) product = result.productId;
        return result;
      });
      const add = vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value: unknown) {
        const result = nativeAdd.call(this, value);
        if (!reached && product !== undefined && value === product) {
          reached = true;
          const remaining = budget.limits[dimension] - budget.usage()[dimension];
          if (dimension === 'work') budget.spend(remaining);
          else budget.reserve({ [dimension]: remaining });
        }
        return result;
      });
      const legacyHash = vi.spyOn(validators, 'deterministicId');
      const boundedHash = vi.spyOn(validators, 'deterministicIdWithBudget');
      let error: unknown, calls = 0;
      try { run(input, budget); } catch (e) { error = e; }
      finally {
        calls = legacyHash.mock.calls.filter((parts) => parts[2] === 'transaction_items').length
          + boundedHash.mock.calls.filter((parts) => parts[3] === 'transaction_items').length;
        item.mockRestore(); add.mockRestore(); legacyHash.mockRestore(); boundedHash.mockRestore();
      }
      expect(reached).toBe(true);
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect(calls).toBe(0);
    });
  }
});


type Golden = { name: string; input: Input; itemOracles: { inputCanonicalJson: string; canonicalJson: string }[]; outcome: { json: string; canonicalItemRows: number } };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/transaction-item-loop-golden.json', 'utf8')) as {
  cases: Golden[]; signed: { value: unknown; json: string; canonicalJson: string; inputCanonicalJson: string }[];
};
const dimensions = ['nodes', 'slots', 'structuralBytes', 'work'] as const;
type Dimension = typeof dimensions[number];
function leave(b: BudgetContext, dimension: Dimension | 'contentBytes', remaining: number): void {
  const amount = b.limits[dimension] - b.usage()[dimension] - remaining;
  if (dimension === 'work') b.spend(amount); else b.reserve({ [dimension]: amount });
}
function admitted(b: BudgetContext, input = golden.cases[0].input): Input {
  return parseRegisteredBoundedJson(JSON.stringify(input), b) as Input;
}

describe('frozen HEAD transaction item byte contract', () => {
  for (const f of golden.cases) for (const bounded of [false, true]) it(`${f.name}: budget=${bounded}`, () => {
    const b = bounded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.input) : f.input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(result.records.transaction_items?.length ?? 0).toBe(f.outcome.canonicalItemRows);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    expect(Object.isFrozen(result.sourceRecords)).toBe(false);
    for (const oracle of f.itemOracles) expect(oracle.inputCanonicalJson).toBe(oracle.canonicalJson);
    for (const row of result.records.transaction_items ?? []) expect(Object.isFrozen(row)).toBe(false);
  });
  for (const [i, f] of golden.signed.entries()) it(`signed legacy ${i}: source bytes and mutable parser output`, () => {
    const b = createBudgetContext({ now: () => 0 });
    const source = parseRegisteredBoundedJson(JSON.stringify(f.value), b);
    const item = semantic.canonicalTransactionItem(source, true, b)!;
    expect(JSON.stringify(item)).toBe(f.json);
    expect(validators.canonicalJson(source, b)).toBe(f.canonicalJson);
    expect(f.inputCanonicalJson).toBe(f.canonicalJson);
    expect(Object.isFrozen(item)).toBe(false);
    item.name = 'mutated';
    expect(() => validators.canonicalJson(item, b)).toThrow();
  });
});

describe('accepted item loop native boundaries', () => {
  for (const dimension of dimensions) it(`containers and first visit reserve ${dimension} before validator`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const native = semantic.parseTransactionItemsJson;
    let reached = false;
    const parse = vi.spyOn(semantic, 'parseTransactionItemsJson').mockImplementation((text, context) => {
      const result = native(text, context); reached = true; leave(b, dimension, 0); return result;
    });
    const item = vi.spyOn(semantic, 'canonicalTransactionItem');
    let error: unknown, calls: number;
    try { run(input, b); } catch (e) { error = e; }
    finally { calls = item.mock.calls.length; parse.mockRestore(); item.mockRestore(); }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError); expect(calls!).toBe(0);
  });

  // Closed ref: object + 3 scalar occurrences, 3 properties + destination;
  // keys code/table/id total 11 bytes. Addition/safe-integer visit + ref work = 6.
  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`ref ${dimension} boundary ${delta}`, () => {
    const costs = { nodes: 4, slots: 4, structuralBytes: 55, work: 6 };
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const nativeItem = semantic.canonicalTransactionItem, nativeAdd = Set.prototype.add, nativePush = Array.prototype.push;
    let product: string | undefined, reached = false, refs = 0;
    const item = vi.spyOn(semantic, 'canonicalTransactionItem').mockImplementation((value, signed, context) => {
      const result = nativeItem(value, signed, context); if (result && context === b) product = result.productId; return result;
    });
    const add = vi.spyOn(Set.prototype, 'add').mockImplementation(function(this: Set<unknown>, value: unknown) {
      const result = nativeAdd.call(this, value);
      if (!reached && product !== undefined && value === product) { reached = true; leave(b, dimension, costs[dimension] + delta); }
      return result;
    });
    // Native synchronous wrapper avoids recursive Vitest array-spy bookkeeping.
    Array.prototype.push = function(...values: unknown[]) {
      if (reached && values.some(v => v && typeof v === 'object' && (v as {code?: string}).code === 'BROKEN_PRODUCT_REFERENCE')) refs++;
      return nativePush.apply(this, values);
    };
    try { run(input, b); } catch (e) { expect(e).toBeInstanceOf(BudgetExceededError); }
    finally { Array.prototype.push = nativePush; item.mockRestore(); add.mockRestore(); }
    expect(reached).toBe(true); expect(refs).toBe(delta < 0 ? 0 : 1);
  });

  for (const dimension of ['contentBytes', 'slots'] as const) it(`line String and rest frame refuse ${dimension} before native operands`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const nativePush = Array.prototype.push, nativeString = String;
    let reached = false, strings = 0, serializations = 0;
    const str = vi.spyOn(globalThis, 'String').mockImplementation((value) => { if (reached && value === 1) strings++; return nativeString(value); });
    const nativeCanonical = validators.canonicalJson;
    const json = vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => { if (reached) serializations++; return nativeCanonical(value, context); });
    Array.prototype.push = function(...values: unknown[]) {
      const result = nativePush.apply(this, values);
      if (!reached && values.some(v => v && typeof v === 'object' && (v as {code?: string}).code === 'BROKEN_PRODUCT_REFERENCE')) { reached = true; leave(b, dimension, 0); }
      return result;
    };
    let error: unknown;
    try { run(input, b); } catch (e) { error = e; }
    finally { Array.prototype.push = nativePush; str.mockRestore(); json.mockRestore(); }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
    expect(strings).toBe(0); expect(serializations).toBe(0);
  });

  it('serializes only the immutable validated source and hashes with the identical context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, golden.cases[3].input);
    const native = semantic.canonicalTransactionItem;
    let source: unknown, mutable: unknown;
    const item = vi.spyOn(semantic, 'canonicalTransactionItem').mockImplementation((value, signed, context) => {
      const result = native(value, signed, context); if (result && context === b) { source = value; mutable = result; } return result;
    });
    const json = vi.spyOn(validators, 'canonicalJson'), hash = vi.spyOn(validators, 'deterministicIdWithBudget');
    let sourceCalls = 0, mutableCalls = 0, hashCalls = 0;
    try { run(input, b); }
    finally {
      sourceCalls = json.mock.calls.filter(([v, context]) => v === source && context === b).length;
      mutableCalls = json.mock.calls.filter(([v]) => v === mutable).length;
      hashCalls = hash.mock.calls.filter(([context, , , table]) => context === b && table === 'transaction_items').length;
      item.mockRestore(); json.mockRestore(); hash.mockRestore();
    }
    expect(Object.isFrozen(source)).toBe(true); expect(Object.isFrozen(mutable)).toBe(false);
    expect(sourceCalls).toBe(1); expect(mutableCalls).toBe(0); expect(hashCalls).toBe(1);
  });

  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`canonical copy ${dimension} boundary ${delta}`, () => {
    const costs = { nodes: 18, slots: 17, structuralBytes: 331, work: 18 };
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const nativeLegacy = validators.deterministicId, nativeBounded = validators.deterministicIdWithBudget, nativePush = Array.prototype.push;
    let reached = false, itemId: string | undefined, copies = 0;
    function arm(id: string, table: string) { if (table === 'transaction_items') { reached = true; itemId = id; leave(b, dimension, costs[dimension] + delta); } return id; }
    const legacy = vi.spyOn(validators, 'deterministicId').mockImplementation((...parts: string[]) => arm(nativeLegacy(...parts), parts[2]));
    const bounded = vi.spyOn(validators, 'deterministicIdWithBudget').mockImplementation((context, ...parts) => arm(nativeBounded(context, ...parts), parts[2]));
    Array.prototype.push = function(...values: unknown[]) {
      if (reached && values.some(v => v && typeof v === 'object' && 'productId' in v && (v as {itemId?: string}).itemId === itemId)) copies++;
      return nativePush.apply(this, values);
    };
    try { run(input, b); } catch (e) { expect(e).toBeInstanceOf(BudgetExceededError); }
    finally { Array.prototype.push = nativePush; legacy.mockRestore(); bounded.mockRestore(); }
    expect(reached).toBe(true); expect(copies).toBe(delta < 0 ? 0 : 1);
  });

  for (const mode of ['late', 'abort', 'ordinary', 'exceeded', 'unavailable'] as const) it(`native item hash ${mode} preserves deadline/error identity`, () => {
    let now = 0, reached = false, digests = 0;
    const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal }), input = admitted(b);
    const failure = mode === 'unavailable' ? new BudgetUnavailableError() : new BudgetExceededError();
    const prototype = Object.getPrototypeOf(createHash('sha256'));
    const nativeUpdate = prototype.update, nativeDigest = prototype.digest;
    const update = vi.spyOn(prototype, 'update').mockImplementation(function(this: unknown, ...args: unknown[]) {
      const result = nativeUpdate.apply(this, args);
      if (!reached && typeof args[0] === 'string' && args[0].includes('transaction_items')) {
        reached = true; if (mode === 'abort') signal.aborted = true; else now = 5000;
        if (mode === 'ordinary') throw new RangeError('late native hash');
        if (mode === 'exceeded' || mode === 'unavailable') throw failure;
      }
      return result;
    });
    const digest = vi.spyOn(prototype, 'digest').mockImplementation(function(this: unknown, ...args: unknown[]) { if (reached) digests++; return nativeDigest.apply(this, args); });
    let error: unknown;
    try { run(input, b); } catch (e) { error = e; }
    finally { update.mockRestore(); digest.mockRestore(); }
    expect(reached).toBe(true); expect(digests).toBe(0);
    if (mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(failure);
    else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});


describe('fanout multiplicity and cumulative-context controls', () => {
  for (const name of ['accepted-shared-product-refs', 'large-512-item-loop-missing-product-refs']) it(name, () => {
    const f = golden.cases.find(c => c.name === name)!;
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, f.input);
    const native = validators.deterministicIdWithBudget, nativePush = Array.prototype.push;
    const samples: ReturnType<BudgetContext['usage']>[] = [];
    let refs = 0;
    const hash = vi.spyOn(validators, 'deterministicIdWithBudget').mockImplementation((context, ...parts) => {
      const result = native(context, ...parts);
      if (parts[2] === 'transaction_items') { expect(context).toBe(b); samples.push(context.usage()); }
      return result;
    });
    Array.prototype.push = function(...values: unknown[]) {
      if (values.some(v => v && typeof v === 'object' && (v as {code?: string; table?: string}).code === 'BROKEN_PRODUCT_REFERENCE' && (v as {table?: string}).table === 'products')) refs++;
      return nativePush.apply(this, values);
    };
    let result: ReturnType<typeof run>;
    try { result = run(input, b); }
    finally { Array.prototype.push = nativePush; hash.mockRestore(); }
    const count = name === 'accepted-shared-product-refs' ? 2 : 512;
    expect(refs).toBe(count); expect(samples).toHaveLength(count);
    for (let i = 1; i < samples.length; i++) for (const dimension of [...dimensions, 'contentBytes'] as const) expect(samples[i][dimension]).toBeGreaterThan(samples[i - 1][dimension]);
    expect(JSON.stringify(result!)).toBe(f.outcome.json);
    // The 512-item loop really executes, but missing product refs quarantine it.
    expect(result!.records.transaction_items?.length ?? 0).toBe(name === 'accepted-shared-product-refs' ? 2 : 0);
  });
});


describe('line argument and native hash prework boundary controls', () => {
  const costs = { nodes: 8, slots: 6, structuralBytes: 68, work: 2, contentBytes: 32 };
  for (const dimension of [...dimensions, 'contentBytes'] as const) for (const delta of [-1, 0, 1]) it(`line arguments ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const nativePush = Array.prototype.push, nativeString = String;
    let reached = false, strings = 0;
    const str = vi.spyOn(globalThis, 'String').mockImplementation((value) => { if (reached && value === 1) strings++; return nativeString(value); });
    Array.prototype.push = function(...values: unknown[]) {
      const result = nativePush.apply(this, values);
      if (!reached && values.some(v => v && typeof v === 'object' && (v as {code?: string}).code === 'BROKEN_PRODUCT_REFERENCE')) { reached = true; leave(b, dimension, costs[dimension] + delta); }
      return result;
    };
    let error: unknown;
    try { run(input, b); } catch (e) { error = e; }
    finally { Array.prototype.push = nativePush; str.mockRestore(); }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
    expect(strings).toBe(delta < 0 ? 0 : 1);
  });

  for (const dimension of ['nodes', 'structuralBytes', 'work', 'contentBytes'] as const) it(`native hash refuses ${dimension} exhausted inside the reached item serializer`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const nativeJson = validators.canonicalJson;
    let reached = false, updates = 0;
    const json = vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => {
      const result = nativeJson(value, context);
      if (!reached && value && typeof value === 'object' && 'productId' in value) { reached = true; leave(b, dimension, 0); }
      return result;
    });
    const prototype = Object.getPrototypeOf(createHash('sha256')), nativeUpdate = prototype.update;
    const update = vi.spyOn(prototype, 'update').mockImplementation(function(this: unknown, ...args: unknown[]) { if (reached) updates++; return nativeUpdate.apply(this, args); });
    let error: unknown;
    try { run(input, b); } catch (e) { error = e; }
    finally { json.mockRestore(); update.mockRestore(); }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError); expect(updates).toBe(0);
  });
});
