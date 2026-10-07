import { describe, expect, it, vi } from 'vitest';
import * as bounded from './boundedWork';

const make = (limits: Partial<bounded.BudgetLimits> = {}) => bounded.createBudgetContext({ limits, now: () => 0 });

describe('request-owned logical budget', () => {
  it('has the exact approved immutable request limits', () => {
    expect(bounded.NORMALIZATION_BUDGET_LIMITS).toEqual({
      nodes: 1_200_000, slots: 1_200_000, contentBytes: 32_000_000,
      structuralBytes: 32_000_000, work: 5_000_000, stringBytes: 8_000_000,
      depth: 64, deadlineMs: 5_000,
    });
    expect(Object.isFrozen(bounded.NORMALIZATION_BUDGET_LIMITS)).toBe(true);
  });
  it.each(['nodes', 'slots', 'contentBytes', 'structuralBytes'] as const)('reserves %s cumulatively at limit-1/limit/limit+1', (key) => {
    const budget = make({ [key]: 3 });
    budget.reserve({ [key]: 2 });
    expect(budget.usage()[key]).toBe(2);
    budget.reserve({ [key]: 1 });
    expect(budget.usage()[key]).toBe(3);
    expect(() => budget.reserve({ [key]: 1 })).toThrow(bounded.BudgetExceededError);
    expect(budget.usage()[key]).toBe(3);
  });
  it.each(['nodes', 'slots', 'contentBytes', 'structuralBytes'] as const)('checks the actual approved %s ceiling without allocating the graph', (key) => {
    const budget = make();
    const limit = bounded.NORMALIZATION_BUDGET_LIMITS[key];
    budget.reserve({ [key]: limit - 1 });
    budget.reserve({ [key]: 1 });
    expect(budget.usage()[key]).toBe(limit);
    expect(() => budget.reserve({ [key]: 1 })).toThrow(bounded.BudgetExceededError);
  });
  it('checks 4,999,999 / 5,000,000 / 5,000,001 logical operations exactly', () => {
    const budget = make();
    budget.spend(4_999_999); budget.spend();
    expect(budget.usage().work).toBe(5_000_000);
    expect(() => budget.spend()).toThrow(bounded.BudgetExceededError);
  });
  it('checks the entire reservation atomically before the factory can run', () => {
    const budget = make({ nodes: 1, slots: 1 });
    const factory = vi.fn(() => ({ payload: 'not-created' }));
    expect(() => bounded.allocate(budget, { nodes: 1, slots: 2 }, factory)).toThrow(bounded.BudgetExceededError);
    expect(factory).not.toHaveBeenCalled();
    expect(budget.usage().nodes).toBe(0);
  });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid reservation %s before any factory', (nodes) => {
    const factory = vi.fn();
    expect(() => bounded.allocate(make(), { nodes }, factory)).toThrow(bounded.BudgetExceededError);
    expect(factory).not.toHaveBeenCalled();
  });
  it('never refunds a reservation when a factory throws', () => {
    const budget = make({ nodes: 1 });
    expect(() => bounded.allocate(budget, { nodes: 1 }, () => { throw new Error('factory'); })).toThrow('factory');
    expect(budget.usage().nodes).toBe(1);
    expect(() => bounded.allocate(budget, { nodes: 1 }, vi.fn())).toThrow(bounded.BudgetExceededError);
  });
  it('checks work inclusive boundaries before the next callback', () => {
    const budget = make({ work: 3 });
    budget.spend(2); budget.spend(1);
    expect(budget.usage().work).toBe(3);
    expect(() => budget.spend()).toThrow(bounded.BudgetExceededError);
  });
  it('does not recycle capacity across two acquisitions sharing a context', () => {
    const budget = make({ contentBytes: 6 });
    const acquisition = () => budget.reserve({ contentBytes: 4 });
    acquisition();
    expect(acquisition).toThrow(bounded.BudgetExceededError);
    expect(budget.usage().contentBytes).toBe(4);
    expect(() => make({ contentBytes: 6 }).reserve({ contentBytes: 4 })).not.toThrow();
  });
  it('permits only tightened limits, never a relaxed production ceiling', () => {
    expect(() => make({ work: 5_000_001 })).toThrow(bounded.BudgetExceededError);
    expect(() => make({ depth: 65 })).toThrow(bounded.BudgetExceededError);
    expect(() => make({ deadlineMs: 5_001 })).toThrow(bounded.BudgetExceededError);
  });
  it('enforces depth 64/65 without spending or releasing capacity', () => {
    const budget = make();
    budget.checkDepth(63); budget.checkDepth(64);
    expect(() => budget.checkDepth(65)).toThrow(bounded.BudgetExceededError);
  });
  it('rejects over-limit strings before the lazy allocation', () => {
    const budget = make();
    budget.reserveString(7_999_999); budget.reserveString(8_000_000);
    const factory = vi.fn();
    expect(() => { budget.reserveString(8_000_001); factory(); }).toThrow(bounded.BudgetExceededError);
    expect(factory).not.toHaveBeenCalled();
    expect(budget.usage().contentBytes).toBe(15_999_999);
  });
  it('checks cooperative deadline at each boundary, including after native work', () => {
    let now = 0;
    const budget = bounded.createBudgetContext({ now: () => now });
    now = 4_999; budget.check();
    now = 5_000; expect(() => budget.check()).toThrow(bounded.BudgetUnavailableError);
    expect(() => budget.reserve({ nodes: 1 })).toThrow(bounded.BudgetUnavailableError);
    expect(budget.usage().nodes).toBe(0);
  });
  it('checks abort and non-monotonic clocks without leaking payloads or site labels', () => {
    const signal = { aborted: false }; let now = 10;
    const budget = bounded.createBudgetContext({ now: () => now, signal });
    now = 9; expect(() => budget.check()).toThrow('Legacy normalization budget unavailable.');
    const cancelled = bounded.createBudgetContext({ signal, now: () => 0 });
    signal.aborted = true;
    expect(() => cancelled.check()).toThrow('Legacy normalization budget unavailable.');
  });
  it('charges a surrogate pair crossing a 256-code-unit boundary before scanning the next block', () => {
    const budget = make({ work: 1 });
    expect(() => bounded.utf8ByteLength('x'.repeat(255) + '😀', budget)).toThrow(bounded.BudgetExceededError);
    const accepted = make();
    expect(bounded.utf8ByteLength('x'.repeat(255) + '😀', accepted)).toBe(259);
    expect(accepted.usage().work).toBe(2);
  });
  it('counts UTF-8 accurately without materializing encoded strings', () => {
    const budget = make();
    expect(bounded.utf8ByteLength('A한😀\ud800\udc00\ud800', budget)).toBe(15);
    expect(bounded.utf8ByteLength('x'.repeat(257), budget)).toBe(257);
    expect(budget.usage().work).toBe(3);
  });
});

describe('guarded stable merge sort', () => {
  it('preserves ties, input, and code-unit comparator semantics', () => {
    const input = [{ key: 'b', id: 0 }, { key: 'a', id: 1 }, { key: 'b', id: 2 }];
    const result = bounded.stableBudgetSort(input, (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0, make());
    expect(result.map((item) => item.id)).toEqual([1, 0, 2]);
    expect(input.map((item) => item.id)).toEqual([0, 1, 2]);
  });
  it('reserves output and scratch slots before even invoking comparison', () => {
    const compare = vi.fn(() => 0);
    expect(() => bounded.stableBudgetSort([2, 1], compare, make({ slots: 3 }))).toThrow(bounded.BudgetExceededError);
    expect(compare).not.toHaveBeenCalled();
  });
  it('charges comparisons and moves before the next operation', () => {
    const compare = vi.fn((a: number, b: number) => a - b);
    expect(() => bounded.stableBudgetSort([2, 1], compare, make({ work: 2 }))).toThrow(bounded.BudgetExceededError);
    expect(compare).not.toHaveBeenCalled();
  });
  it('checks deadline after a comparator and preserves default no-budget sorting', () => {
    let now = 0;
    const budget = bounded.createBudgetContext({ now: () => now });
    expect(() => bounded.stableBudgetSort([2, 1], () => { now = 5_000; return -1; }, budget)).toThrow(bounded.BudgetUnavailableError);
    expect(bounded.stableBudgetSort([2, 1], (a, b) => a - b)).toEqual([1, 2]);
  });
});
