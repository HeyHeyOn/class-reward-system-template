import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, createBudgetContext, type Allocation, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson, assertRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/normalizer-rows-budget-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json?: string; error?: { name: string; message: string } } }[];
};
function fixture(badHeader = false): Input {
  const input = JSON.parse(JSON.stringify(golden.cases[0].input)) as Input;
  const tabs = { [badHeader ? 'Students' : 'Unrecognized']: { headers: ['construction-sentinel'], rows: [{ rowNumber: 2, hash: 'construction-identity', cells: [''] }] } } as Input['sheets']['tabs'];
  return { tenantId: input.tenantId, migrationJobId: input.migrationJobId, sheets: { ...input.sheets, tabs } };
}
function admit(input: Input, budget: BudgetContext): Input { return parseRegisteredBoundedJson(JSON.stringify(input), budget) as Input; }

describe('sheet Entry shell construction only; target/claim/output categories remain separate', () => {
  for (const badHeader of [false, true]) for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) {
    const cost = (badHeader ? { nodes: 14, slots: 14, structuralBytes: 315 } : { nodes: 13, slots: 13, structuralBytes: 307 })[dimension];
    for (const delta of [-1, 0, 1]) it(`Entry shell badHeader=${badHeader} reserves ${dimension} before identity hash with remaining cost${delta >= 0 ? '+' : ''}${delta}`, () => {
      const budget = createBudgetContext({ now: () => 0 }), input = admit(fixture(badHeader), budget);
      const native = Set.prototype.has;
      let armed = false, reached = false;
      const get = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
        if (key === (badHeader ? 'studentId' : '')) armed = true;
        return MapGet.call(this, key);
      });
      const has = vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, key: unknown) {
        const result = native.call(this, key);
        if (armed && key === 'construction-sentinel') {
          reached = true;
          budget.reserve({ [dimension]: budget.limits[dimension] - budget.usage()[dimension] - cost - delta });
        }
        return result;
      });
      const hash = vi.spyOn(validators, 'sha256');
      let error: unknown;
      let identityCalls = 0;
      try { run(input, budget); } catch (e) { error = e; } finally { identityCalls = hash.mock.calls.filter(([value, context]) => value === 'construction-identity' && context === budget).length; get.mockRestore(); has.mockRestore(); hash.mockRestore(); }
      expect(reached).toBe(true);
      // The identity hash needs another node/four structural units: exact shell
      // capacity admits the shell but may then refuse its separately charged hash.
      if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(identityCalls).toBe(0); }
      else expect(identityCalls).toBe(1);
    });
  }
  it('reserves the fixed source recipe and destination slot before first identity cell lookup', () => {
    const base = createBudgetContext({ now: () => 0 });
    const reservations: Allocation[] = [];
    const budget: BudgetContext = { ...base, reserve(cost) { base.reserve(cost); reservations.push(cost); } };
    const input = admit(fixture(), budget); reservations.length = 0;
    let atLookup: Allocation[] = [];
    const get = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      if (key === '' && atLookup.length === 0) atLookup = reservations.slice();
      return MapGet.call(this, key);
    });
    try { run(input, budget); } finally { get.mockRestore(); }
    expect(atLookup).toContainEqual({ nodes: 6, slots: 5, structuralBytes: 93 });
    expect(atLookup).toContainEqual({ slots: 1, structuralBytes: 4 });
  });
  it('reuses the request context across normalizations and keeps mutable shells uncertified', () => {
    const budget = createBudgetContext({ now: () => 0 }), input = admit(fixture(), budget);
    const start = budget.usage(), first = run(input, budget), middle = budget.usage();
    const second = run(input, budget), end = budget.usage();
    for (const key of ['nodes', 'slots', 'structuralBytes', 'contentBytes', 'work'] as const) expect(end[key] - middle[key]).toBe(middle[key] - start[key]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(Object.getPrototypeOf(first.records)).toBe(null);
    expect(Object.isFrozen(first.sourceRecords[0].source)).toBe(false);
    expect(Object.isFrozen(first.sourceRecords[0].redactedSourceRecord)).toBe(false);
    expect(() => assertRegisteredBoundedJson(first.sourceRecords[0].source, budget)).toThrow('Legacy bounded JSON is invalid.');
    const source = first.sourceRecords[0].source as { tab: string }; source.tab = 'mutated';
    expect(second.sourceRecords[0].source).not.toEqual(source);
  });
  for (const enabled of [false, true]) it.each(golden.cases)(`frozen Git construction bytes/errors budget=${enabled}: $name`, (f) => {
    const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = budget ? admit(f.input, budget) : JSON.parse(JSON.stringify(f.input)) as Input;
    if (f.outcome.error) {
      try { run(input, budget); expect.fail('expected original error'); } catch (e) { expect({ name: (e as Error).name, message: (e as Error).message }).toEqual(f.outcome.error); }
    } else expect(JSON.stringify(run(input, budget))).toBe(f.outcome.json);
  });
});
const MapGet = Map.prototype.get;
