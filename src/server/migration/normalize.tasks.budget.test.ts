import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import * as bounded from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import * as rows from '@/server/sheetsRows';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/task-construction-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json: string; counts: Record<string, number> } }[];
};
const dimensions = ['nodes', 'slots', 'structuralBytes', 'work'] as const;
type Dimension = typeof dimensions[number];
function leave(b: BudgetContext, d: Dimension, remaining: number) {
  const debit = b.limits[d] - b.usage()[d] - remaining;
  if (d === 'work') b.spend(debit); else b.reserve({ [d]: debit });
}
function admitted(b: BudgetContext, name = 'current-none') {
  return parseRegisteredBoundedJson(JSON.stringify(golden.cases.find(f => f.name === name)!.input), b) as Input;
}
function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? v as Record<string, unknown> : undefined;
}
const recipes = {
  canonical: { nodes: 17, slots: 16, structuralBytes: 317, work: 17 },
  taskStaged: { nodes: 40, slots: 38, structuralBytes: 720, work: 40 },
  linkStaged: { nodes: 12, slots: 10, structuralBytes: 196, work: 12 },
  ref: { nodes: 4, slots: 4, structuralBytes: 55, work: 4 },
} as const;

describe('Tasks frozen Git accepted and quarantined parity', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} budget=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.name) : f.input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    for (const [table, count] of Object.entries(f.outcome.counts)) expect(result.records[table]).toHaveLength(count);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    for (const r of result.records.tasks) {
      expect(Object.getPrototypeOf(r)).toBe(Object.prototype); expect(Object.isFrozen(r)).toBe(false);
      const canonical = result.sourceRecords.find(s => s.canonicalRecord?.taskInstanceId === r.taskInstanceId)!.canonicalRecord!;
      expect(r.currentSchedule).toBe(canonical.currentSchedule); expect(r.pendingSchedule).toBe(canonical.pendingSchedule);
      expect(r.allowedStudentIds).toBe(canonical.allowedStudentIds);
      r.title = 'mutable'; expect(canonical.title).not.toBe('mutable');
      if (b) expect(() => assertRegisteredBoundedJson(r, b)).toThrow('Legacy bounded JSON is invalid.');
    }
  });
});

describe('Tasks actual caller preallocation', () => {
  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`canonical before description operand ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), sort = bounded.stableBudgetSort, get = Map.prototype.get;
    let reached = false, operands = 0, factories = 0, error: unknown;
    const nativeAllocate = bounded.allocate;
    const allocation = vi.spyOn(bounded, 'allocate').mockImplementation((owner, amount, make) => nativeAllocate(owner, amount, () => { if (owner === b && amount.structuralBytes === recipes.canonical.structuralBytes) factories++; return make(); }));
    const spy = vi.spyOn(bounded, 'stableBudgetSort').mockImplementation((values, compare, owner) => {
      const result = sort(values, compare, owner);
      if (!reached && owner === b && values.length === 1 && values[0] === 'S1') { reached = true; leave(b, dimension, recipes.canonical[dimension] + delta); }
      return result;
    });
    Map.prototype.get = function (key) { if (reached && key === 'description') operands++; return get.call(this, key); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; spy.mockRestore(); allocation.mockRestore(); }
    expect(reached).toBe(true); expect(error).toBeInstanceOf(BudgetExceededError);
    // Cell access has its own pre-Map work; exact shell work admits the real
    // literal factory but does not also fund that subsequent cell operation.
    if (dimension === 'work') expect(factories).toBe(delta < 0 ? 0 : 1);
    else expect(operands).toBe(delta < 0 ? 0 : 1);
  });
  for (const [name, cost] of Object.entries(recipes)) for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) it(`${name} closed factory ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), native = bounded.allocate;
    const stop = new Error('after reached factory'); let reached = 0, factories = 0, error: unknown;
    const spy = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
      if (context !== b || amount.structuralBytes !== cost.structuralBytes) return native(context, amount, make);
      reached++; leave(b, dimension, cost[dimension] + delta);
      native(context, amount, () => { factories++; return make(); }); throw stop;
    });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(reached).toBe(1); expect(factories).toBe(delta < 0 ? 0 : 1);
    if (delta < 0 || name === 'canonical') expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) it(`link rest arguments before hash ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), push = Array.prototype.push;
    const hash = vi.spyOn(validators, 'deterministicIdWithBudget'), legacy = vi.spyOn(validators, 'deterministicId'); let reached = false, error: unknown, hashes = 0;
    Array.prototype.push = function (...values: unknown[]) {
      const result = push.apply(this, values);
      if (!reached && record(values[0])?.table === 'tasks' && record(values[0])?.record) { reached = true; leave(b, dimension, ({ nodes: 1, slots: 4, structuralBytes: 32 })[dimension] + delta); }
      return result;
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; hashes = hash.mock.calls.filter(c => c[0] === b && c[2] === 'task_allowed_students').length + legacy.mock.calls.filter(c => c[1] === 'task_allowed_students').length; hash.mockRestore(); legacy.mockRestore(); }
    expect(reached).toBe(true); expect(hashes).toBe(delta < 0 ? 0 : 1); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('Tasks staged Target clone native exits', () => {
  for (const [name, table] of [['taskStaged', 'tasks'], ['linkStaged', 'task_allowed_students']] as const)
    for (const state of ['timely', 'expired', 'aborted'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const)
      it(`${table} staged getter ${state} ${exit}`, () => {
        let now = 0; const signal = { aborted: false }, b = createBudgetContext({ now: () => now, signal }), input = admitted(b);
        const native = bounded.allocate, push = Array.prototype.push;
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('staged getter');
        let reached = 0, appended = 0, error: unknown;
        const seen = new Set<unknown>();
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
          if (record(values[0])?.table === table && record(values[0])?.record && !seen.has(values[0])) { seen.add(values[0]); appended++; }
          return push.apply(this, values);
        };
        try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; spy.mockRestore(); }
        expect(reached).toBe(1); expect(appended).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
        if (exit === 'exceeded' || exit === 'unavailable' || (state === 'timely' && exit === 'ordinary')) expect(error).toBe(sentinel);
        else if (state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError); else expect(error).toBeUndefined();
      });
});

describe('Tasks reached native ref and Target append boundaries', () => {
  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`link staged native append ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), hash = validators.deterministicIdWithBudget, legacy = validators.deterministicId, push = Array.prototype.push;
    let reached = 0, emitted = 0, error: unknown;
    const stop = new Error('first link Target append');
    const mark = () => { reached++; leave(b, dimension, recipes.linkStaged[dimension] + delta); };
    const h = vi.spyOn(validators, 'deterministicIdWithBudget').mockImplementation((owner, ...parts) => { const result = hash(owner, ...parts); if (owner === b && parts[1] === 'task_allowed_students') mark(); return result; });
    const l = vi.spyOn(validators, 'deterministicId').mockImplementation((...parts: string[]) => { const result = legacy(...parts); if (parts[1] === 'task_allowed_students') mark(); return result; });
    Array.prototype.push = function (...values: unknown[]) { const result = push.apply(this, values); if (record(values[0])?.table === 'task_allowed_students' && record(values[0])?.record) { emitted++; throw stop; } return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; h.mockRestore(); l.mockRestore(); }
    expect(reached).toBe(1); expect(emitted).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const site of ['ref', 'taskStaged'] as const) for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`${site} native append ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), sort = bounded.stableBudgetSort, trim = String.prototype.trim, push = Array.prototype.push;
    let armed = false, reached = false, emitted = 0, error: unknown;
    const stop = new Error('first scoped ref/Target append');
    const spy = vi.spyOn(bounded, 'stableBudgetSort').mockImplementation((values, compare, owner) => { const result = sort(values, compare, owner); if (owner === b && values.length === 1 && values[0] === 'S1') armed = true; return result; });
    String.prototype.trim = function () {
      const result = trim.call(this);
      if (site === 'ref' && armed && !reached && result === 'Read') { reached = true; leave(b, dimension, (dimension === 'work' ? 5 : recipes.ref[dimension]) + delta); }
      return result;
    };
    Array.prototype.push = function (...values: unknown[]) {
      const value = record(values[0]);
      const result = push.apply(this, values);
      if (reached && ((site === 'ref' && value?.code === 'BROKEN_ALLOWED_STUDENT_REFERENCE' && value?.table === 'students') || (site === 'taskStaged' && value?.table === 'tasks' && value?.record))) { emitted++; throw stop; }
      if (site === 'taskStaged' && !reached && value?.code === 'BROKEN_ALLOWED_STUDENT_REFERENCE' && value?.table === 'students') { reached = true; leave(b, dimension, recipes.taskStaged[dimension] + delta); }
      return result;
    };
    try { run(input, b); } catch (e) { error = e; } finally { String.prototype.trim = trim; Array.prototype.push = push; spy.mockRestore(); }
    expect(reached).toBe(true); expect(emitted).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const fixture of ['duplicate-allowed', 'self-prerequisite', 'invalid-current']) for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) it(`${fixture} error occurrence ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, fixture), native = bounded.allocate, push = Array.prototype.push;
    const stop = new Error('first scoped error'); let reached = false, emitted = 0, error: unknown;
    const code = fixture === 'duplicate-allowed' ? 'DUPLICATE_ALLOWED_STUDENT_ID' : fixture === 'self-prerequisite' ? 'SELF_TASK_REFERENCE' : 'MALFORMED_REQUIRED_RECORD';
    const spy = vi.spyOn(bounded, 'allocate').mockImplementation((context, amount, make) => {
      if (context !== b || amount.structuralBytes !== 8) return native(context, amount, make);
      reached = true; leave(b, dimension, (dimension === 'structuralBytes' ? 8 : 1) + delta); native(context, amount, make); throw stop;
    });
    Array.prototype.push = function (...values: unknown[]) { if (values[0] === code) emitted++; return push.apply(this, values); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; spy.mockRestore(); }
    expect(reached).toBe(true); expect(emitted).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('Tasks defensive fallback and prerequisite ref', () => {
  for (const dimension of ['nodes', 'structuralBytes', 'contentBytes'] as const) for (const delta of [-1, 0, 1]) it(`accepted long-instance fallback literal ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'fallback-long-instance'), parser = rows.parseTaskRow, native = bounded.allocate;
    const stop = new Error('fallback factory'); let parsed = 0, reached = 0, factories = 0, error: unknown;
    const row = vi.spyOn(rows, 'parseTaskRow').mockImplementation((cells, index, zone, owner) => { const result = parser(cells, index, zone, owner); if (owner === b && result) parsed++; return result; });
    const spy = vi.spyOn(bounded, 'allocate').mockImplementation((owner, amount, make) => {
      if (owner !== b || amount.contentBytes !== 34 || amount.structuralBytes !== 4) return native(owner, amount, make);
      reached++; const cost = dimension === 'contentBytes' ? 34 : dimension === 'nodes' ? 1 : 4;
      b.reserve({ [dimension]: b.limits[dimension] - b.usage()[dimension] - cost - delta });
      native(owner, amount, () => { factories++; return make(); }); throw stop;
    });
    try { run(input, b); } catch (e) { error = e; } finally { row.mockRestore(); spy.mockRestore(); }
    expect(parsed).toBe(1); expect(reached).toBe(1); expect(factories).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  it('precharges each prerequisite ref before its literal and append', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'prerequisite'), native = bounded.allocate, push = Array.prototype.push;
    let refs = 0, emitted = 0, error: unknown;
    const spy = vi.spyOn(bounded, 'allocate').mockImplementation((owner, amount, make) => { if (owner === b && amount.structuralBytes === 55 && ++refs === 2) leave(b, 'slots', 3); return native(owner, amount, make); });
    Array.prototype.push = function (...values: unknown[]) { if (record(values[0])?.code === 'BROKEN_TASK_REFERENCE' && record(values[0])?.table === 'task_business') emitted++; return push.apply(this, values); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; spy.mockRestore(); }
    expect(refs).toBe(2); expect(emitted).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('Tasks same context and mutable schedule ownership', () => {
  it('propagates context to actual instance/prerequisite IDs and link encoder cumulatively', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'prerequisite');
    const id = vi.spyOn(validators, 'canonicalId'), hash = vi.spyOn(validators, 'deterministicIdWithBudget'), parser = rows.parseTaskRow;
    const results: NonNullable<ReturnType<typeof parser>>[] = [];
    vi.spyOn(rows, 'parseTaskRow').mockImplementation((row, index, zone, owner) => { expect(owner).toBe(b); const result = parser(row, index, zone, owner); if (result) results.push(result); return result; });
    try {
      const before = b.usage(); run(input, b); const first = b.usage(); run(input, b); const second = b.usage();
      const instanceCalls = id.mock.calls.filter(c => c[0] === 'TI1' || c[0] === 'TI2'); expect(instanceCalls.length).toBeGreaterThan(0);
      for (const c of instanceCalls) expect(c[1]).toBe(b);
      for (const c of id.mock.calls.filter(c => c[0] === 'T2')) expect(c[1]).toBe(b);
      expect(hash.mock.calls.filter(c => c[0] === b && c[2] === 'task_allowed_students')).toHaveLength(4);
      for (const d of [...dimensions, 'contentBytes'] as const) { expect(first[d]).toBeGreaterThan(before[d]); expect(second[d]).toBeGreaterThan(first[d]); }
      for (const parsed of results) { expect(Object.isFrozen(parsed)).toBe(false); expect(() => assertRegisteredBoundedJson(parsed, b)).toThrow('Legacy bounded JSON is invalid.'); }
    } finally { vi.restoreAllMocks(); }
  });
});
