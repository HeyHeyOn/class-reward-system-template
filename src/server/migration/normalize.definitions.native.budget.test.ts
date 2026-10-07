import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import * as bounded from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import * as rows from '@/server/sheetsRows';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/definition-construction-golden.json', 'utf8')) as { cases: { name: string; input: Input }[] };
function input(b?: BudgetContext, name = 'N_PLUS_ONE') {
  const value = golden.cases.find(f => f.name === name)!.input;
  return b ? parseRegisteredBoundedJson(JSON.stringify(value), b) as Input : value;
}

// These are independent fixed recipe costs, not measurements used as an oracle.
const sites = [
  ['student canonical', 74, 5], ['student Target', 214, 14], ['account Target', 192, 12],
  ['product canonical', 136, 9], ['product Target', 368, 24], ['link canonical', 116, 6],
  ['link Target', 328, 18], ['promotion Target', 1024, 34], ['link refs', 110, 8],
  ['student statuses', 32, 12],
  ['Students error', 8, 1, 'student-long-status'], ['Products error', 8, 1, 'product-invalid-sort'],
  ['Promotions error', 8, 1, 'promotion-invalid-type'], ['PromotionProducts error', 8, 1, 'link-invalid-version'],
] as const;
describe('definition closed recipe work before lazy factory', () => {
  for (const [name, bytes, work, fixture] of sites) for (const delta of [-1, 0, 1]) it(`${name} work ${delta}`, () => {
    const native = bounded.allocate, stop = new Error('reached factory');
    // Locate the real last spend by ordinal only. The asserted cost above is
    // fixed independently. Delegation retains real cumulative counters; no
    // mutation of a frozen context, counter replacement, reset or refund.
    let ordinal = 0, selected = 0, last = 0, armed = false;
    const real = createBudgetContext({ now: () => 0 });
    const b: BudgetContext = { ...real, spend(amount = 1) { if (armed) { ordinal++; last = amount; } real.spend(amount); } };
    const admitted = input(b, fixture); armed = true;
    const locate = vi.spyOn(bounded, 'allocate').mockImplementation((context, cost, make) => {
      if (context === b && cost.structuralBytes === bytes) { selected = ordinal; throw stop; }
      return native(context, cost, make);
    });
    try { run(admitted, b); } catch (e) { expect(e).toBe(stop); } finally { locate.mockRestore(); }
    expect(selected).toBeGreaterThan(0); expect(last).toBe(work);
    let current = 0, active = false, factories = 0, reached = false, error: unknown;
    const counter = createBudgetContext({ now: () => 0 });
    const context: BudgetContext = { ...counter, spend(amount = 1) {
      if (active && ++current === selected) {
        reached = true; counter.spend(counter.limits.work - counter.usage().work - work - delta);
      }
      counter.spend(amount);
    } };
    const next = input(context, fixture); active = true;
    const factory = vi.spyOn(bounded, 'allocate').mockImplementation((owner, cost, make) => {
      if (owner === context && cost.structuralBytes === bytes) return native(owner, cost, () => { factories++; throw stop; });
      return native(owner, cost, make);
    });
    try { run(next, context); } catch (e) { error = e; } finally { factory.mockRestore(); }
    expect(reached).toBe(true); expect(factories).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('definition scalar native success and exception exits', () => {
  for (const [tab, fixture] of [['Students', 'student-long-status'], ['Products', 'product-invalid-sort'], ['Promotions', 'promotion-invalid-type'], ['PromotionProducts', 'link-invalid-version']] as const)
    it(`${tab} no-budget original malformed native predicate precedes append`, () => {
      const value = input(undefined, fixture), has = Set.prototype.has, push = Array.prototype.push;
      const sentinel = new RangeError('original financial predicate'); let reached = 0, appended = 0, error: unknown;
      Set.prototype.has = function (key) {
        if (key === tab && this.size === 4 && has.call(this, 'Transactions') && has.call(this, 'TaskCompletions')) { reached++; throw sentinel; }
        return has.call(this, key);
      };
      Array.prototype.push = function (...values: unknown[]) { if (values[0] === 'MALFORMED_REQUIRED_RECORD') appended++; return push.apply(this, values); };
      try { run(value); } catch (e) { error = e; } finally { Set.prototype.has = has; Array.prototype.push = push; }
      expect(reached).toBe(1); expect(error).toBe(sentinel); expect(appended).toBe(0);
    });
  for (const [tab, fixture, expected] of [['Students', 'student-invalid-balance', 4], ['Products', 'product-invalid-sort', 7], ['Promotions', 'promotion-invalid-type', 3], ['PromotionProducts', 'link-invalid-version', 6]] as const)
    it(`${tab} rejects only after charging its scalar condition`, () => {
      const b = createBudgetContext({ now: () => 0 }), value = input(b, fixture), alloc = bounded.allocate;
      const integer = validators.safeInteger, trim = bounded.trimBudgetString, parser = rows.parsePromotionRow;
      let marked = false, start = 0, reached = false, work = 0;
      const mark = () => { marked = true; start = b.usage().work; };
      const i = vi.spyOn(validators, 'safeInteger').mockImplementation((v, o, owner) => { const result = integer(v, o, owner); if (owner === b && ((tab === 'Products' && v === 'bad') || (tab === 'PromotionProducts' && v === '2'))) mark(); return result; });
      const t = vi.spyOn(bounded, 'trimBudgetString').mockImplementation((v, owner) => { const result = trim(v, owner); if (tab === 'Students' && v === 'ACTIVE' && owner === b) mark(); return result; });
      const p = vi.spyOn(rows, 'parsePromotionRow').mockImplementation((v, index, owner) => { const result = parser(v, index, owner); if (tab === 'Promotions' && owner === b) mark(); return result; });
      const a = vi.spyOn(bounded, 'allocate').mockImplementation((owner, cost, make) => { if (marked && owner === b && cost.structuralBytes === 8) { reached = true; work = b.usage().work - start; } return alloc(owner, cost, make); });
      try { run(value, b); } finally { i.mockRestore(); t.mockRestore(); p.mockRestore(); a.mockRestore(); }
      expect(reached).toBe(true); expect(work).toBeGreaterThanOrEqual(expected);
    });
  it('precharges canonicalId predicates and both equality operands', () => {
    const b = createBudgetContext({ now: () => 0 });
    expect(validators.canonicalId('S1', b)).toBe('S1'); expect(b.usage().work).toBeGreaterThanOrEqual(9);
  });
  it('precharges safeInteger final native validation and bounds', () => {
    const b = createBudgetContext({ now: () => 0 });
    expect(validators.safeInteger('-10', undefined, b)).toBe(-10); expect(b.usage().work).toBeGreaterThanOrEqual(8);
  });
  it('precharges canonicalInstant native finite check, formatting and equality', () => {
    const b = createBudgetContext({ now: () => 0 }), v = '2026-08-31T00:00:00.000Z';
    expect(validators.canonicalInstant(v, b)).toBe(v); expect(b.usage().work).toBeGreaterThanOrEqual(12);
  });
  it('charges the closed promotion projection discriminant comparisons', () => {
    const b = createBudgetContext({ now: () => 0 }), value = input(b), id = validators.canonicalId, alloc = bounded.allocate;
    let start = 0, reached = false, work = 0;
    const helper = vi.spyOn(validators, 'canonicalId').mockImplementation((v, owner) => { const result = id(v, owner); if (v === 'PR1' && owner === b) start = b.usage().work; return result; });
    const factory = vi.spyOn(bounded, 'allocate').mockImplementation((owner, cost, make) => { if (owner === b && cost.structuralBytes === 1024) { reached = true; work = b.usage().work - start; } return alloc(owner, cost, make); });
    try { run(value, b); } finally { helper.mockRestore(); factory.mockRestore(); }
    expect(reached).toBe(true); expect(work).toBeGreaterThanOrEqual(73);
  });
  for (const helper of ['canonicalId', 'safeInteger', 'canonicalInstant'] as const)
    for (const state of ['no-budget', 'timely', 'expired', 'aborted'] as const)
      for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${helper} ${state} ${exit}`, () => {
        let now = 0, entered = false, reached = 0;
        const signal = { aborted: false }, b = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal });
        const value = input(b, 'student-negative');
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native scalar');
        const originalId = validators.canonicalId, originalInt = validators.safeInteger, originalInstant = validators.canonicalInstant;
        const armId = vi.spyOn(validators, 'canonicalId').mockImplementation((v, owner) => { entered = helper === 'canonicalId' && v === 'S1'; try { return originalId(v, owner); } finally { entered = false; } });
        const armInt = vi.spyOn(validators, 'safeInteger').mockImplementation((v, options, owner) => { entered = helper === 'safeInteger' && v === '-10'; try { return originalInt(v, options, owner); } finally { entered = false; } });
        const armInstant = vi.spyOn(validators, 'canonicalInstant').mockImplementation((v, owner) => { entered = helper === 'canonicalInstant'; try { return originalInstant(v, owner); } finally { entered = false; } });
        function hit() { reached++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw sentinel; }
        const trim = String.prototype.trim, safe = Number.isSafeInteger, parse = Date.parse;
        String.prototype.trim = function () { if (entered && helper === 'canonicalId') hit(); return trim.call(this); };
        Number.isSafeInteger = function (v) { if (entered && helper === 'safeInteger' && v === -10) hit(); return safe(v); };
        Date.parse = function (v) { if (entered && helper === 'canonicalInstant') hit(); return parse(v); };
        let error: unknown;
        try { run(value, b); } catch (e) { error = e; }
        finally { String.prototype.trim = trim; Number.isSafeInteger = safe; Date.parse = parse; armId.mockRestore(); armInt.mockRestore(); armInstant.mockRestore(); }
        expect(reached).toBeGreaterThan(0);
        if (exit === 'exceeded' || exit === 'unavailable' || ((state === 'timely' || state === 'no-budget') && exit === 'ordinary')) expect(error).toBe(sentinel);
        else if (state === 'expired' || state === 'aborted') expect(error).toBeInstanceOf(BudgetUnavailableError);
        else expect(error).toBeUndefined();
      });

  it('charges both long rejected strictBoolean comparisons', () => {
    const short = createBudgetContext({ now: () => 0 }), long = createBudgetContext({ now: () => 0 });
    expect(validators.strictBoolean('x', short)).toBe(null); expect(validators.strictBoolean('x'.repeat(513), long)).toBe(null);
    expect(long.usage().work - short.usage().work).toBeGreaterThanOrEqual(4);
  });

  for (const state of ['timely', 'expired', 'aborted', 'no-budget'] as const)
    for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`actual student status membership ${state} ${exit}`, () => {
      let now = 0, reached = 0; const signal = { aborted: false };
      const b = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal }), value = input(b);
      const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('status includes');
      const includes = Array.prototype.includes;
      Array.prototype.includes = function (search, from) {
        if (this.length === 2 && this[0] === 'ACTIVE' && this[1] === 'INACTIVE' && search === 'ACTIVE') {
          reached++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw sentinel;
        }
        return includes.call(this, search, from);
      };
      let error: unknown;
      try { run(value, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; }
      expect(reached).toBe(1);
      if (exit === 'exceeded' || exit === 'unavailable' || ((state === 'timely' || state === 'no-budget') && exit === 'ordinary')) expect(error).toBe(sentinel);
      else if (state === 'expired' || state === 'aborted') expect(error).toBeInstanceOf(BudgetUnavailableError);
      else expect(error).toBeUndefined();
    });
});
