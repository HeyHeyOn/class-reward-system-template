import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as work from '@/lib/boundedWork';
import { createBudgetContext, BudgetExceededError, BudgetUnavailableError, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as operational from './operationalProjection';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/operational-integration-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; counts: Record<string, number> }; operationalTrace: { assignments: Record<string, unknown>[]; completions: Record<string, unknown>[] } }[] };
function admitted(b: BudgetContext, name = 'supported-carry') { return parseRegisteredBoundedJson(JSON.stringify(golden.cases.find(f => f.name === name)!.input), b) as Input; }
const dimensions = ['nodes', 'slots', 'structuralBytes', 'work'] as const;
function leave(b: BudgetContext, d: typeof dimensions[number], n: number) { const cost = b.limits[d] - b.usage()[d] - n; if (d === 'work') b.spend(cost); else b.reserve({ [d]: cost }); }

describe('actual normalizer operational join frozen Git parity', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} context=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.name) : f.input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    for (const [table, count] of Object.entries(f.outcome.counts)) expect(result.records[table]?.length ?? 0).toBe(count);
    for (const s of result.sourceRecords) if (s.canonicalRecord && s.source.kind === 'SHEET' && ['TaskAssignments', 'TaskCompletions'].includes(s.source.tab)) {
      expect(Object.isFrozen(s.canonicalRecord)).toBe(false);
      if (b) expect(() => assertRegisteredBoundedJson(s.canonicalRecord, b)).toThrow('Legacy bounded JSON is invalid.');
    }
  });
});

describe('actual helper receives safe immutable views and identical cumulative context', () => {
  for (const f of golden.cases) it(`Git helper input order, full fields and multiplicity ${f.name}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, f.name), native = operational.unsupportedOperationalRecords;
    let reached = 0;
    const spy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((assignments, completions, owner) => {
      reached++; expect(owner).toBe(b); expect({ assignments, completions }).toEqual(f.operationalTrace);
      return native(assignments, completions, owner);
    });
    try { run(input, b); expect(reached).toBe(1); } finally { spy.mockRestore(); }
  });
  for (const name of ['supported-carry', 'duplicate-assignment', 'duplicate-completion', 'evidence-evidenceBoardId-"bad"', 'legacy-v1-completion']) it(name, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), native = operational.unsupportedOperationalRecords;
    let calls = 0;
    const spy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((assignments, completions, owner) => {
      calls++; expect(owner).toBe(b);
      for (const list of [assignments, completions]) {
        expect(Object.isFrozen(list)).toBe(true); assertRegisteredBoundedJson(list, b);
        for (const row of list) { expect(Object.isFrozen(row)).toBe(true); assertRegisteredBoundedJson(row, b); }
      }
      const before = b.usage(); const result = native(assignments, completions, owner); expect(b.usage().work).toBeGreaterThan(before.work);
      return result;
    });
    try { run(input, b); expect(calls).toBe(1); } finally { spy.mockRestore(); }
  });
  it('chronology uses the actual guarded stable sort and original tie comparator', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'chronology-equal-tie'), native = work.stableBudgetSort;
    let calls = 0;
    const spy = vi.spyOn(work, 'stableBudgetSort').mockImplementation((list, compare, owner) => {
      if ((list[0] as { tab?: string } | undefined)?.tab === 'TaskCompletions') { calls++; expect(owner).toBe(b); }
      return native(list, compare, owner);
    });
    try { run(input, b); expect(calls).toBe(1); } finally { spy.mockRestore(); }
  });
  for (const dimension of dimensions) it(`refuses inside reached helper before native assignment index: ${dimension}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), native = operational.unsupportedOperationalRecords;
    const set = Map.prototype.set; let reached = 0, index = 0, error: unknown;
    const spy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((a, c, owner) => { reached++; leave(b, dimension, 0); return native(a, c, owner); });
    Map.prototype.set = function (key, value) { if (reached && key === 'AS0') index++; return set.call(this, key, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.set = set; spy.mockRestore(); }
    expect(reached).toBe(1); expect(index).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const mode of ['deadline', 'abort', 'exceeded', 'unavailable'] as const) it(`reached helper exit ${mode}`, () => {
    let now = 0; const signal = new AbortController(), b = createBudgetContext({ now: () => now, signal: signal.signal });
    const input = admitted(b), native = operational.unsupportedOperationalRecords, errorObject = mode === 'exceeded' ? new BudgetExceededError() : new BudgetUnavailableError();
    let reached = 0, error: unknown;
    const spy = vi.spyOn(operational, 'unsupportedOperationalRecords').mockImplementation((a, c, owner) => {
      reached++; expect(owner).toBe(b); if (mode === 'abort') signal.abort(); else now = 6000;
      if (mode === 'exceeded' || mode === 'unavailable') throw errorObject;
      return native(a, c, owner);
    });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(reached).toBe(1); if (mode === 'exceeded' || mode === 'unavailable') expect(error).toBe(errorObject); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});
