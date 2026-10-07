import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, mapBudgetList, uniqueBudgetStrings, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as boundedJson from '@/lib/boundedJson';
const projection = boundedJson.createBoundedParserProjection;
import { parsePromotionResponse } from '@/lib/promotionClient';
import { parseCheckoutLineSnapshot } from '@/lib/checkoutSnapshotClient';
import { canonicalTransactionItem } from './semanticValidators';
import * as semanticValidators from './semanticValidators';
const parseItemsJson = semanticValidators.parseTransactionItemsJson;
const load = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `src/server/migration/__fixtures__/parser-budget-${name}.json`), 'utf8'));
const cases = load('cases') as { promotions: unknown[]; items: unknown[] };
const golden = load('golden') as { promotions: unknown[]; checkout: unknown[]; semantic: unknown[]; signed: unknown[] };
const edgeCases = load('edge-cases') as typeof cases;
const edgeGolden = load('edge-golden') as typeof golden;
const budget = (limits = {}) => createBudgetContext({ limits, now: () => 0 });
const promotion = parsePromotionResponse;
const checkout = parseCheckoutLineSnapshot;
const semantic = (value: unknown, b?: BudgetContext) => canonicalTransactionItem(value, false, b);
const parsers = [
  { name: 'promotion', parse: promotion, fixture: cases.promotions[3] },
  { name: 'checkout', parse: checkout, fixture: cases.items[0] },
  { name: 'semantic', parse: semantic, fixture: cases.items[0] },
];
afterEach(() => vi.restoreAllMocks());
describe('frozen-HEAD parser edge oracle', () => {
  it.each(edgeCases.promotions.map((value, index) => ({ value, index })))('promotion $index preserves original bytes', ({ value, index }) => {
    expect(JSON.stringify(promotion(value))).toBe(JSON.stringify(edgeGolden.promotions[index]));
    const b = budget(); expect(JSON.stringify(promotion(parseRegisteredBoundedJson(JSON.stringify(value), b), b))).toBe(JSON.stringify(edgeGolden.promotions[index]));
  });
  it.each(edgeCases.items.map((value, index) => ({ value, index })))('item $index preserves original bytes', ({ value, index }) => {
    for (const [parse, expected] of [[checkout, edgeGolden.checkout[index]], [semantic, edgeGolden.semantic[index]]] as const) {
      expect(JSON.stringify(parse(value))).toBe(JSON.stringify(expected));
      const b = budget(); expect(JSON.stringify(parse(parseRegisteredBoundedJson(JSON.stringify(value), b), b))).toBe(JSON.stringify(expected));
    }
    expect(JSON.stringify(canonicalTransactionItem(value, true))).toBe(JSON.stringify(edgeGolden.signed[index]));
    const b = budget(); expect(JSON.stringify(canonicalTransactionItem(parseRegisteredBoundedJson(JSON.stringify(value), b), true, b))).toBe(JSON.stringify(edgeGolden.signed[index]));
  });
});
describe('bounded parser propagation (not normalization)', () => {
  it('precharges the native empty mapping operation', () => {
    expect(() => mapBudgetList([], (value) => value, budget({ work: 0 }))).toThrow(BudgetExceededError);
  });
  it('precharges creation of an empty uniqueness index', () => {
    expect(() => uniqueBudgetStrings([], budget({ work: 0 }))).toThrow(BudgetExceededError);
  });
  it('reserves mapped fanout before its first payload callback', () => {
    const factory = vi.fn((value: number) => value);
    expect(() => mapBudgetList([1, 2], factory, budget({ slots: 1 }))).toThrow(BudgetExceededError);
    expect(factory).not.toHaveBeenCalled();
    expect(mapBudgetList([1, 2], factory, budget({ slots: 2 }))).toEqual([1, 2]);
  });
  it('admits nested items JSON before native parse, including depth 64/65', () => {
    const native = vi.spyOn(JSON, 'parse');
    expect(() => parseItemsJson('['.repeat(64) + '0' + ']'.repeat(64), budget())).toThrow(BudgetExceededError);
    expect(native).not.toHaveBeenCalled();
    // Container depth 63 plus its scalar is the inclusive graph depth 64.
    expect(parseItemsJson('['.repeat(63) + '0' + ']'.repeat(63), budget())).not.toBeNull();
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('refuses maximum nested JSON fanout before the native call', () => {
    const text = '[' + '0,'.repeat(300_000) + '0]';
    const native = vi.spyOn(JSON, 'parse');
    expect(() => parseItemsJson(text, budget())).toThrow(BudgetExceededError);
    expect(native).not.toHaveBeenCalled();
  });
  it.each([BudgetExceededError, BudgetUnavailableError])('does not quarantine nested native %s', (ErrorType) => {
    vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new ErrorType(); });
    expect(() => parseItemsJson('[]', budget())).toThrow(ErrorType);
  });
  it('rejects late nested JSON results instead of returning null', () => {
    let clock = 0; const b = createBudgetContext({ now: () => clock });
    const native = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation((text) => { const result = native(text); clock = 5_000; return result; });
    expect(() => parseItemsJson('[]', b)).toThrow(BudgetUnavailableError);
  });
  it('preserves malformed cell null, duplicate keys and downstream parser semantics', () => {
    expect(parseItemsJson('not-json')).toBeNull(); expect(parseItemsJson('not-json', budget())).toBeNull();
    const text = '[{"a":1,"a":2}]'; expect(parseItemsJson(text)).toEqual([{ a: 2 }]); expect(parseItemsJson(text, budget())).toEqual([{ a: 2 }]);
    const b = budget(); const items = parseItemsJson(JSON.stringify([cases.items[0]]), b) as unknown[];
    expect(JSON.stringify(semantic(items[0], b))).toBe(JSON.stringify(golden.semantic[0]));
  });
  it('reserves a closed projection before evaluating its lazy source', () => {
    const source = vi.fn(() => cases.promotions[3]);
    expect(() => projection('promotion', source, budget({ nodes: 0 }))).toThrow(BudgetExceededError);
    expect(source).not.toHaveBeenCalled();
  });
  it('rejects foreign projection sources before property access', () => {
    const trap = vi.fn(() => { throw new Error('trap'); });
    expect(() => projection('promotion', () => new Proxy({}, { get: trap }), budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(trap).not.toHaveBeenCalled();
  });
  it('copies nested projection payloads without minting mutable graph certificates', () => {
    const b = budget(); const source = parseRegisteredBoundedJson(JSON.stringify(cases.items[0]), b);
    const result = projection('checkout', () => source, b);
    expect(JSON.stringify(result)).toBe(JSON.stringify(golden.checkout[0]));
    const children = result.appliedPromotions as { productIds: string[] }[];
    children[0].productIds.push('mutable');
    expect((source as { appliedPromotions: { productIds: string[] }[] }).appliedPromotions[0].productIds).toEqual(['P001']);
    expect(() => boundedJson.registeredBoundedKeys(result, b)).toThrow('Legacy bounded JSON is invalid.');
  });
  it.each(parsers)('$name enforces inclusive cumulative allocation/work boundaries', ({ parse, fixture }) => {
    const probe = budget(); const admitted = parseRegisteredBoundedJson(JSON.stringify(fixture), probe);
    const start = probe.usage(); const expected = parse(admitted, probe); const end = probe.usage();
    for (const key of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) {
      const needed = end[key] - start[key]; expect(needed).toBeGreaterThan(0);
      for (const difference of [-1, 0, 1]) {
        const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify(fixture), b);
        const debit = b.limits[key] - b.usage()[key] - needed - difference;
        if (key === 'work') b.spend(debit); else b.reserve({ [key]: debit });
        if (difference < 0) expect(() => parse(value, b)).toThrow(BudgetExceededError);
        else expect(parse(value, b)).toEqual(expected);
      }
    }
  });
  it('checks the exact legacy projection node recipe before its source callback', () => {
    for (const remaining of [5, 6, 7]) {
      const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify(cases.items[4]), b);
      b.reserve({ nodes: b.limits.nodes - b.usage().nodes - remaining });
      const source = vi.fn(() => value);
      if (remaining === 5) { expect(() => projection('legacyItem', source, b)).toThrow(BudgetExceededError); expect(source).not.toHaveBeenCalled(); }
      else { expect(projection('legacyItem', source, b)).toEqual(golden.semantic[4]); expect(source).toHaveBeenCalledOnce(); }
    }
  });
  it.each(parsers)('$name refuses exhausted work instead of returning a parser result', ({ parse, fixture }) => {
    const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify(fixture), b);
    b.spend(b.limits.work - b.usage().work);
    expect(() => parse(value, b)).toThrow(BudgetExceededError);
  });
  it.each(parsers)('$name rejects foreign certificates before source access', ({ parse }) => {
    const trap = vi.fn(() => { throw new Error('source trap'); });
    const value = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
    expect(() => parse(value, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(trap).not.toHaveBeenCalled();
  });
  it.each(parsers)('$name accounts for derived objects and returns mutable detached data', ({ parse, fixture }) => {
    const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify(fixture), b);
    const before = b.usage(); const result = parse(value, b)!;
    expect(result).not.toBeNull(); expect(result).not.toBe(value);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.isFrozen(result)).toBe(false);
    expect(b.usage().nodes).toBeGreaterThan(before.nodes);
    expect(b.usage().slots).toBeGreaterThan(before.slots);
    Object.assign(result, { mutable: true }); expect(result).toHaveProperty('mutable', true);
  });
  it('charges input-length work for rejected promotion type comparisons', () => {
    const work = (type: string) => {
      const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify({ ...(cases.promotions[3] as object), type }), b);
      const start = b.usage().work; expect(promotion(value, b)).toBeNull(); return b.usage().work - start;
    };
    expect(work('x'.repeat(65_536))).toBeGreaterThan(work('x') + 255);
  });
  it('charges input-length work for rejected semantic promotion type comparisons', () => {
    const work = (type: string) => {
      const fixture = structuredClone(cases.items[0]) as { appliedPromotions: { type: string }[] };
      fixture.appliedPromotions[0].type = type;
      const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify(fixture), b);
      const start = b.usage().work; expect(semantic(value, b)).toBeNull(); return b.usage().work - start;
    };
    expect(work('x'.repeat(65_536))).toBeGreaterThan(work('x') + 255);
  });
  it('charges input-length work for rejected adjustment type comparisons', () => {
    const work = (type: string) => {
      const fixture = structuredClone(cases.items[0]) as { adjustments: { type: string }[] };
      fixture.adjustments[0].type = type;
      const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify(fixture), b);
      const start = b.usage().work; expect(checkout(value, b)).toBeNull(); return b.usage().work - start;
    };
    expect(work('x'.repeat(65_536))).toBeGreaterThan(work('x') + 255);
  });
  it('does not allocate a native iterator for admitted product fanout', () => {
    const b = budget(); const value = parseRegisteredBoundedJson(JSON.stringify(cases.promotions[3]), b) as { productIds: string[] };
    const native = Array.prototype[Symbol.iterator]; let calls = 0;
    // Vitest's spy bookkeeping itself iterates arrays; use a synchronous native
    // wrapper and restore before assertions to avoid recursive harness allocation.
    let result: ReturnType<typeof promotion>;
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      if (this === value.productIds) calls++;
      return native.call(this);
    };
    try { result = promotion(value, b); } finally { Array.prototype[Symbol.iterator] = native; }
    expect(result).not.toBeNull(); expect(calls).toBe(0);
  });
  it('precharges the next product trim after a prior native trim exhausts work', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson(JSON.stringify({ ...(cases.promotions[3] as object), productIds: ['first-product', 'second-product'] }), b);
    const native = String.prototype.trim; const visited: string[] = [];
    vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      const text = String(this); visited.push(text);
      if (text === 'first-product') b.spend(b.limits.work - b.usage().work);
      return native.call(this);
    });
    expect(() => promotion(value, b)).toThrow(BudgetExceededError);
    expect(visited).not.toContain('second-product');
  });
  it('discards late promotion native date results', () => {
    let clock = 0; const b = createBudgetContext({ now: () => clock });
    const value = parseRegisteredBoundedJson(JSON.stringify(cases.promotions[3]), b);
    const native = Date.prototype.toISOString;
    vi.spyOn(Date.prototype, 'toISOString').mockImplementation(function (this: Date) { const result = native.call(this); clock = 5_000; return result; });
    expect(() => promotion(value, b)).toThrow(BudgetUnavailableError);
  });
  it('shares cumulative work across two parsed acquisitions', () => {
    const b = budget(); const one = parseRegisteredBoundedJson(JSON.stringify(cases.items[0]), b);
    const two = parseRegisteredBoundedJson(JSON.stringify(cases.items[0]), b);
    const before = b.usage().work; expect(semantic(one, b)).not.toBeNull();
    const cost = b.usage().work - before; expect(cost).toBeGreaterThan(0);
    b.spend(b.limits.work - b.usage().work - cost + 1);
    expect(() => semantic(two, b)).toThrow(BudgetExceededError);
  });
  it('preserves frozen-HEAD no-budget and accepted budget parser outputs', () => {
    cases.promotions.forEach((value, i) => {
      expect(JSON.stringify(promotion(value))).toBe(JSON.stringify(golden.promotions[i]));
      const b = budget(); expect(JSON.stringify(promotion(parseRegisteredBoundedJson(JSON.stringify(value), b), b))).toBe(JSON.stringify(golden.promotions[i]));
    });
    cases.items.forEach((value, i) => {
      expect(JSON.stringify(checkout(value))).toBe(JSON.stringify(golden.checkout[i]));
      expect(JSON.stringify(semantic(value))).toBe(JSON.stringify(golden.semantic[i]));
      expect(JSON.stringify(canonicalTransactionItem(value, true))).toBe(JSON.stringify(golden.signed[i]));
      for (const [parse, expected] of [[checkout, golden.checkout[i]], [semantic, golden.semantic[i]]] as const) {
        const b = budget(); expect(JSON.stringify(parse(parseRegisteredBoundedJson(JSON.stringify(value), b), b))).toBe(JSON.stringify(expected));
      }
    });
  });
});
