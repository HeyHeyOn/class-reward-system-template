import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBoundedJson, parseRegisteredBoundedJson, registeredBoundedKeys } from '@/lib/boundedJson';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext } from '@/lib/boundedWork';
import { parseTaskScheduleCells } from '@/domain/taskSchedule';
import { parseTransactionItemsJson } from './semanticValidators';
import { canonicalJson, clonePlainData } from './validators';

afterEach(() => vi.restoreAllMocks());
const decoders = [parseBoundedJson, parseRegisteredBoundedJson, parseTransactionItemsJson];
describe('native JSON failure boundaries', () => {
  for (const decode of decoders) {
    for (const NativeError of [SyntaxError, RangeError]) {
      it.each(['deadline', 'abort'])(`${decode.name} checks %s after ${NativeError.name}`, (mode) => {
        let clock = 0; const signal = { aborted: false };
        const budget = createBudgetContext({ now: () => clock, signal });
        let calls = 0;
        vi.spyOn(JSON, 'parse').mockImplementation(() => {
          calls++; if (mode === 'deadline') clock = budget.limits.deadlineMs; else signal.aborted = true;
          throw new NativeError('native failure');
        });
        expect(() => decode('[]', budget)).toThrow(BudgetUnavailableError);
        expect(calls).toBe(1);
      });
    }
    it.each([BudgetExceededError, BudgetUnavailableError])(`${decode.name} preserves budget error identity`, (ErrorClass) => {
      let clock = 0; const budget = createBudgetContext({ now: () => clock }); const error = new ErrorClass();
      vi.spyOn(JSON, 'parse').mockImplementation(() => { clock = budget.limits.deadlineMs; throw error; });
      let caught: unknown;
      try { decode('[]', budget); } catch (failure) { caught = failure; }
      expect(caught).toBe(error);
    });
    it(`${decode.name} preserves ordinary malformed semantics`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      if (decode === parseTransactionItemsJson) expect(decode('{', budget)).toBeNull();
      else expect(() => decode('{', budget)).toThrow('Legacy bounded JSON is invalid.');
    });
    it.each([SyntaxError, RangeError])(`${decode.name} preserves timely native failure semantics`, (ErrorClass) => {
      const budget = createBudgetContext({ now: () => 0 });
      vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new ErrorClass('native failure'); });
      if (decode === parseTransactionItemsJson) expect(decode('[]', budget)).toBeNull();
      else expect(() => decode('[]', budget)).toThrow('Legacy bounded JSON is invalid.');
    });
  }
});

describe('generic mutable clone order', () => {
  it.each([
    '{"z":1,"a":{"y":2,"b":3}}',
    '{"10":"ten","2":"two","z":[{"y":2,"1":1,"b":3}],"a":{"toString":1,"valueOf":2,"hasOwnProperty":3}}',
  ])('preserves native nested own-key bytes: %s', (text) => {
    const budget = createBudgetContext({ now: () => 0 });
    const source = parseRegisteredBoundedJson(text, budget);
    const legacy = clonePlainData(source); const clone = clonePlainData(source, budget) as Record<string, unknown>;
    expect(JSON.stringify(clone)).toBe(JSON.stringify(legacy));
    expect(Object.keys(clone)).toEqual(Object.keys(legacy as object));
    expect(Object.getPrototypeOf(clone)).toBeNull();
    expect(canonicalJson(clone)).toBe(canonicalJson(source, budget));
    expect(Object.isFrozen(clone)).toBe(false);
    clone.extra = 4; expect(clone.extra).toBe(4);
    expect(() => registeredBoundedKeys(clone, budget)).toThrow('Legacy bounded JSON is invalid.');
    const nested = (clone.a ?? (clone.z as unknown[])[0]) as Record<string, unknown>;
    expect(Object.isFrozen(nested)).toBe(false); nested.extra = 5;
    expect(() => registeredBoundedKeys(nested, budget)).toThrow('Legacy bounded JSON is invalid.');
  });
  it.each(['__proto__', 'constructor', 'prototype'])('retains poison-key admission refusal: %s', (key) => {
    expect(() => parseRegisteredBoundedJson(`{"${key}":1}`, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.');
  });
  it('reserves native key-order scratch before enumeration', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const source = parseRegisteredBoundedJson('{"z":1,"a":2}', budget);
    // Recursive stack scratch needs 256 slots, result two, then native keys two.
    budget.reserve({ slots: budget.limits.slots - budget.usage().slots - 258 });
    const native = vi.spyOn(Object, 'keys');
    expect(() => clonePlainData(source, budget)).toThrow(BudgetExceededError);
    expect(native.mock.calls.filter(([value]) => value === source)).toHaveLength(0);
  });
});

type Fixture = { input: { cells: Record<string, unknown>; legacy: { taskId: string } }; outcome: { json?: string; error?: { name: string; message: string } } };
const fixtures: Fixture[] = JSON.parse(readFileSync('src/server/migration/__fixtures__/interim-review-golden.json', 'utf8'));
describe('native-target frozen taskInstanceId oracle', () => {
  it.each(fixtures)('no-budget parity for $input.cells.taskInstanceId', ({ input, outcome }) => {
    let actual;
    try { actual = { json: JSON.stringify(parseTaskScheduleCells(input.cells as never, input.legacy)) }; }
    catch (error) { const e = error as Error; actual = { error: { name: e.name, message: e.message } }; }
    expect(actual).toEqual(outcome);
  });
  it.each(fixtures.filter(f => f.outcome.json))('budget accepted parity for $input.cells.taskInstanceId', ({ input, outcome }) => {
    const budget = createBudgetContext({ now: () => 0 });
    const source = parseRegisteredBoundedJson(JSON.stringify(input), budget) as typeof input;
    expect(JSON.stringify(parseTaskScheduleCells(source.cells as never, source.legacy, budget))).toBe(outcome.json);
  });
});
