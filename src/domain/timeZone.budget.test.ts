import { readFileSync } from 'node:fs';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { isValidNamedTimeZone } from './timeZone';

const parse = isValidNamedTimeZone as (value: unknown, budget?: BudgetContext) => boolean;
const oracle = JSON.parse(readFileSync('src/server/migration/__fixtures__/timezone-budget-golden.json', 'utf8')) as { value: unknown; result: boolean }[];
afterEach(() => vi.restoreAllMocks());
describe('bounded named time zone boundary', () => {
  it.each(oracle)('retains original oracle $value', ({ value, result }) => {
    expect(parse(value)).toBe(result);
    expect(parse(value, createBudgetContext())).toBe(result);
  });
  it('refuses before trim when work is exhausted', () => {
    const budget = createBudgetContext({ limits: { work: 0 } });
    const trim = vi.spyOn(String.prototype, 'trim');
    expect(() => parse('UTC', budget)).toThrow(BudgetExceededError);
    expect(trim).not.toHaveBeenCalled();
  });
  it('reserves the native argument before Temporal', () => {
    const native = vi.spyOn(Temporal.ZonedDateTime, 'from');
    expect(() => parse('UTC', createBudgetContext({ limits: { slots: 5 } }))).toThrow(BudgetExceededError);
    expect(native).not.toHaveBeenCalled();
  });
  it('discards a late successful Temporal result', () => {
    let now = 0;
    const budget = createBudgetContext({ now: () => now });
    const original = Temporal.ZonedDateTime.from;
    vi.spyOn(Temporal.ZonedDateTime, 'from').mockImplementation((...args) => {
      const result = original(...args); now = 5000; return result;
    });
    expect(() => parse('UTC', budget)).toThrow(BudgetUnavailableError);
  });
  it.each([BudgetExceededError, BudgetUnavailableError])('does not swallow %s from native boundary', (ErrorType) => {
    vi.spyOn(Temporal.ZonedDateTime, 'from').mockImplementation(() => { throw new ErrorType(); });
    expect(() => parse('UTC', createBudgetContext())).toThrow(ErrorType);
  });
  it('checks the deadline after an invalid native result too', () => {
    let now = 0;
    const budget = createBudgetContext({ now: () => now });
    vi.spyOn(Temporal.ZonedDateTime, 'from').mockImplementation(() => { now = 5000; throw new RangeError(); });
    expect(() => parse('Mars/Olympus', budget)).toThrow(BudgetUnavailableError);
  });
  it.each(['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const)('enforces exact %s boundaries', (key) => {
    const probe = createBudgetContext(); parse(' Asia/Seoul ', probe);
    const required = probe.usage()[key];
    expect(required).toBeGreaterThan(0);
    for (const delta of [-1, 0, 1]) {
      const budget = createBudgetContext({ limits: { [key]: required + delta } });
      if (delta < 0) expect(() => parse(' Asia/Seoul ', budget)).toThrow(BudgetExceededError);
      else expect(parse(' Asia/Seoul ', budget)).toBe(true);
    }
    const shared = createBudgetContext({ limits: { [key]: required } });
    expect(parse(' Asia/Seoul ', shared)).toBe(true);
    expect(() => parse(' Asia/Seoul ', shared)).toThrow(BudgetExceededError);
  });
  it('rejects aborted requests even for non-string input', () => {
    const signal = { aborted: false };
    const budget = createBudgetContext({ signal }); signal.aborted = true;
    expect(() => parse(null, budget)).toThrow(BudgetUnavailableError);
  });
});
