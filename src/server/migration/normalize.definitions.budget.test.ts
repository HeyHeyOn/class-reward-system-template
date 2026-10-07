import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import * as bounded from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import * as rows from '@/server/sheetsRows';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/definition-construction-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json: string; counts: Record<string, number> } }[];
};
const dimensions = ['nodes', 'slots', 'structuralBytes', 'work'] as const;
type Dimension = typeof dimensions[number];
function leave(b: BudgetContext, d: Dimension, remaining: number) {
  const debit = b.limits[d] - b.usage()[d] - remaining;
  if (d === 'work') b.spend(debit); else b.reserve({ [d]: debit });
}
function admitted(b: BudgetContext, name = 'N_PLUS_ONE') {
  return parseRegisteredBoundedJson(JSON.stringify(golden.cases.find(f => f.name === name)!.input), b) as Input;
}
function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? v as Record<string, unknown> : undefined;
}
const recipes = {
  studentStatuses: { nodes: 3, slots: 2, structuralBytes: 32, work: 12 },
  studentCanonical: { nodes: 5, slots: 4, structuralBytes: 74, work: 5 },
  studentStaged: { nodes: 14, slots: 12, structuralBytes: 214, work: 14 },
  accountStaged: { nodes: 12, slots: 10, structuralBytes: 192, work: 12 },
  productCanonical: { nodes: 9, slots: 8, structuralBytes: 136, work: 9 },
  productStaged: { nodes: 24, slots: 22, structuralBytes: 368, work: 24 },
  linkCanonical: { nodes: 6, slots: 5, structuralBytes: 116, work: 6 },
  linkStaged: { nodes: 18, slots: 16, structuralBytes: 328, work: 18 },
  promotionStaged: { nodes: 34, slots: 32, structuralBytes: 1024, work: 34 },
  linkRefs: { nodes: 8, slots: 8, structuralBytes: 110, work: 8 },
} as const;

describe('definition frozen Git parity', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} budget=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.name) : f.input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    for (const [table, count] of Object.entries(f.outcome.counts)) expect(result.records[table]).toHaveLength(count);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    for (const table of ['students', 'accounts', 'products', 'promotions', 'promotion_products']) for (const r of result.records[table]) {
      expect(Object.getPrototypeOf(r)).toBe(Object.prototype); expect(Object.isFrozen(r)).toBe(false);
      if (b) expect(() => assertRegisteredBoundedJson(r, b)).toThrow('Legacy bounded JSON is invalid.');
    }
    if (f.name === 'N_PLUS_ONE') {
      for (const table of ['students', 'accounts', 'products', 'promotions', 'promotion_products']) expect(result.records[table]).toHaveLength(1);
      const student = result.sourceRecords.find(s => s.canonicalRecord?.studentId === 'S1')!.canonicalRecord!;
      result.records.students[0].name = 'changed'; expect(student.name).toBe('Alice');
      result.records.accounts[0].balance = -999; expect(student.balance).toBe(100);
      expect(f.input.sheets.tabs.Students.rows[0].cells[1]).toBe('Alice');
    }
  });
});

describe('definition same-context scalar propagation', () => {
  it('threads one cumulative context through actual definition validators', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b);
    const id = vi.spyOn(validators, 'canonicalId'), integer = vi.spyOn(validators, 'safeInteger');
    const instant = vi.spyOn(validators, 'canonicalInstant'), boolean = vi.spyOn(validators, 'strictBoolean');
    const promotion = vi.spyOn(rows, 'parsePromotionRow');
    try {
      const start = b.usage(); run(input, b); const first = b.usage(); run(input, b); const second = b.usage();
      for (const call of id.mock.calls.filter(c => ['S1', 'P1', 'PP1', 'PR1'].includes(c[0] as string))) expect(call[1]).toBe(b);
      expect(integer.mock.calls.length).toBeGreaterThan(0); for (const call of integer.mock.calls) expect(call[2]).toBe(b);
      expect(instant.mock.calls.length).toBeGreaterThan(0); for (const call of instant.mock.calls) expect(call[1]).toBe(b);
      expect(boolean.mock.calls.length).toBeGreaterThan(0); for (const call of boolean.mock.calls) expect(call[1]).toBe(b);
      expect(promotion.mock.calls).toHaveLength(2); for (const call of promotion.mock.calls) expect(call[2]).toBe(b);
      for (const d of [...dimensions, 'contentBytes'] as const) { expect(first[d]).toBeGreaterThan(start[d]); expect(second[d]).toBeGreaterThan(first[d]); }
    } finally { vi.restoreAllMocks(); }
  });
});

describe('closed definition caller recipes before literal evaluation', () => {
  for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) it(`product canonical before imageUrl operand ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), integer = validators.safeInteger, get = Map.prototype.get;
    let reached = false, operands = 0, error: unknown;
    const helper = vi.spyOn(validators, 'safeInteger').mockImplementation((v, options, owner) => {
      const value = integer(v, options, owner);
      if (!reached && v === '1' && owner === b) { reached = true; leave(b, dimension, recipes.productCanonical[dimension] + delta); }
      return value;
    });
    Map.prototype.get = function (key) { if (reached && key === 'imageUrl') operands++; return get.call(this, key); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; helper.mockRestore(); }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError); expect(operands).toBe(delta < 0 ? 0 : 1);
  });
  for (const tab of ['Students', 'Products', 'Promotions', 'PromotionProducts'] as const)
    for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`existing ${tab} Entry prehash ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 });
      const raw = JSON.parse(JSON.stringify(golden.cases[0].input)) as Input;
      const isolated = { ...raw, sheets: { ...raw.sheets, tabs: { [tab]: raw.sheets.tabs[tab] } } };
      const input = parseRegisteredBoundedJson(JSON.stringify(isolated), b) as Input;
      const headers = input.sheets.tabs[tab].headers, last = headers[headers.length - 1], identity = input.sheets.tabs[tab].rows[0].cells[0];
      const canonicalId = validators.canonicalId, has = Set.prototype.has, hash = vi.spyOn(validators, 'sha256');
      let armed = false, reached = false, hashes = 0, error: unknown;
      const id = vi.spyOn(validators, 'canonicalId').mockImplementation((v, owner) => { const result = canonicalId(v, owner); if (v === identity && owner === b) armed = true; return result; });
      Set.prototype.has = function (key) {
        const value = has.call(this, key);
        if (armed && !reached && key === last && value) { reached = true; leave(b, dimension, ({ nodes: 13, slots: 13, structuralBytes: 307, work: 13 })[dimension] + delta); }
        return value;
      };
      try { run(input, b); } catch (e) { error = e; }
      finally { hashes = hash.mock.calls.filter(([v, owner]) => v === identity && owner === b).length; id.mockRestore(); Set.prototype.has = has; hash.mockRestore(); }
      expect(reached).toBe(true); expect(hashes).toBe(delta < 0 ? 0 : 1);
      if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
    });
  for (const [name, cost] of Object.entries(recipes)) for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) {
    it(`${name} ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b), native = bounded.allocate;
      const stop = new Error('after reached recipe');
      let reached = 0, factories = 0, error: unknown;
      const spy = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
        if (context !== b || amount.structuralBytes !== cost.structuralBytes) return native(context, amount, make);
        reached++; leave(b, dimension, cost[dimension] + delta);
        native(context, amount, () => { factories++; return make(); });
        throw stop;
      });
      try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
      expect(reached).toBe(1); expect(factories).toBe(delta < 0 ? 0 : 1);
      // Product's two lazy cell operands have their own reservations after the
      // shell. Exact shell admission reaches the factory, then refuses there.
      if (delta < 0 || name === 'productCanonical') expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
    });
  }

  for (const [name, fixture] of [['Students', 'student-long-status'], ['Products', 'product-invalid-sort'], ['Promotions', 'promotion-invalid-type'], ['PromotionProducts', 'link-invalid-version']])
    for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) it(`${name} malformed occurrence ${dimension} ${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b, fixture), native = bounded.allocate, push = Array.prototype.push;
      const stop = new Error('first malformed occurrence'); let reached = false, emitted = 0, error: unknown;
      const spy = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
        if (amount.structuralBytes !== 8 || context !== b) return native(context, amount, make);
        reached = true; leave(b, dimension, (dimension === 'structuralBytes' ? 8 : 1) + delta);
        native(context, amount, make); throw stop;
      });
      Array.prototype.push = function (...values: unknown[]) {
        if (values[0] === 'MALFORMED_REQUIRED_RECORD') emitted++;
        return push.apply(this, values);
      };
      try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; spy.mockRestore(); }
      // structural recipe includes one scalar plus its destination slot.
      expect(reached).toBe(true); expect(emitted).toBe(delta < 0 ? 0 : 1);
      if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
    });
});

describe('definition staged operands and Target native exit', () => {
  for (const [name, table] of [['studentStaged', 'students'], ['accountStaged', 'accounts'], ['productStaged', 'products'], ['linkStaged', 'promotion_products'], ['promotionStaged', 'promotions']] as const)
    for (const state of ['timely', 'expired', 'aborted'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const)
      it(`${table} real staged getter ${state} ${exit}`, () => {
        let now = 0; const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal }), input = admitted(b);
        const native = bounded.allocate, push = Array.prototype.push;
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('staged getter');
        const seen = new Set<unknown>();
        let reached = 0, appended = 0, error: unknown;
        const spy = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
          const value = native(context, amount, make);
          if (context === b && amount.structuralBytes === recipes[name].structuralBytes) {
            const staged = record(value)!; const tenant = staged.tenantId;
            Object.defineProperty(staged, 'tenantId', { enumerable: true, configurable: true, get() {
              reached++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true;
              if (exit !== 'success') throw sentinel; return tenant;
            } });
          }
          return value;
        });
        Array.prototype.push = function (...values: unknown[]) {
          for (const value of values) if (record(value)?.table === table && record(value)?.record && !seen.has(value)) { seen.add(value); appended++; }
          return push.apply(this, values);
        };
        try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; spy.mockRestore(); }
        expect(reached).toBe(1); expect(appended).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
        if (exit === 'exceeded' || exit === 'unavailable' || (state === 'timely' && exit === 'ordinary')) expect(error).toBe(sentinel);
        else if (state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError);
        else expect(error).toBeUndefined();
      });
});
