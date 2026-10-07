import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseAllowedStudentIds } from './sheetsRows';
const parse = parseAllowedStudentIds as (value: string, budget?: BudgetContext) => string[];
const oracle = JSON.parse(readFileSync('src/server/migration/__fixtures__/allowed-budget-golden.json', 'utf8')) as {value: string; result: string[]}[];
afterEach(() => vi.restoreAllMocks());
describe('Sheets allowed-ID budget', () => {
  it.each(oracle)('preserves original source-specific list $value', ({value, result}) => {
    expect(parse(value)).toEqual(result);
    const output = parse(value, createBudgetContext());
    expect(output).toEqual(result);
    expect(Object.isFrozen(output)).toBe(false);
    output.push('mutable');
  });
  it('refuses fanout before native split', () => {
    const split = vi.spyOn(String.prototype, 'split');
    expect(() => parse('a,b;c\nd', createBudgetContext({ limits: { slots: 3 } }))).toThrow(BudgetExceededError);
    expect(split).not.toHaveBeenCalled();
  });
  it('charges even an empty input before native split', () => {
    const split = vi.spyOn(String.prototype, 'split');
    expect(() => parse('', createBudgetContext({ limits: { work: 0 } }))).toThrow(BudgetExceededError);
    expect(split).not.toHaveBeenCalled();
  });
  it('discards late native split result', () => {
    let now = 0;
    const budget = createBudgetContext({ now: () => now });
    const original = String.prototype.split;
    vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args); now = 5000; return result;
    });
    expect(() => parse('a,b', budget)).toThrow(BudgetUnavailableError);
  });
  it.each(['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const)('enforces exact cumulative %s boundaries', (key) => {
    const probe = createBudgetContext(); parse(' 학생 ,a;a\n👩', probe);
    const required = probe.usage()[key];
    expect(required).toBeGreaterThan(0);
    for (const delta of [-1, 0, 1]) {
      const budget = createBudgetContext({ limits: { [key]: required + delta } });
      if (delta < 0) expect(() => parse(' 학생 ,a;a\n👩', budget)).toThrow(BudgetExceededError);
      else expect(parse(' 학생 ,a;a\n👩', budget)).toEqual(['학생', 'a', '👩']);
    }
  });
  it('shares work cumulatively across acquisitions', () => {
    const probe = createBudgetContext(); parse('a,b;c', probe);
    const work = probe.usage().work;
    expect(work).toBeGreaterThan(0);
    const budget = createBudgetContext({ limits: { work } });
    expect(parse('a,b;c', budget)).toEqual(['a','b','c']);
    expect(() => parse('a,b;c', budget)).toThrow(BudgetExceededError);
  });
});
