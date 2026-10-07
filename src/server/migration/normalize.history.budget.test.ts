import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as bounded from '@/lib/boundedWork';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/history-construction-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; counts: Record<string, number> } }[] };
const dimensions = ['nodes', 'slots', 'structuralBytes', 'work'] as const;
type Dimension = typeof dimensions[number];
function leave(b: BudgetContext, d: Dimension, left: number) { const debit = b.limits[d] - b.usage()[d] - left; if (d === 'work') b.spend(debit); else b.reserve({ [d]: debit }); }
function admitted(b: BudgetContext, name = 'supported-carry') { return parseRegisteredBoundedJson(JSON.stringify(golden.cases.find(f => f.name === name)!.input), b) as Input; }
function record(v: unknown): Record<string, unknown> | undefined { return v !== null && typeof v === 'object' ? v as Record<string, unknown> : undefined; }
const recipes = {
  assignmentCanonical: { nodes: 16, slots: 15, structuralBytes: 285, work: 16 },
  assignmentStaged: { nodes: 38, slots: 36, structuralBytes: 658, work: 38 },
  completionCanonical: { nodes: 28, slots: 27, structuralBytes: 542, work: 28 },
  completionStaged: { nodes: 62, slots: 60, structuralBytes: 1170, work: 62 },
  pairRefs: { nodes: 8, slots: 8, structuralBytes: 110, work: 8 },
  previousRef: { nodes: 4, slots: 4, structuralBytes: 55, work: 4 },
} as const;

describe('history frozen Git parity (accepted counts are independent of quarantine)', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} context=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.name) : f.input, b);
    expect(JSON.stringify(result)).toBe(f.outcome.json); expect(Object.getPrototypeOf(result.records)).toBe(null);
    for (const [table, count] of Object.entries(f.outcome.counts)) {
      expect(result.records[table]?.length ?? 0).toBe(count);
      for (const row of result.records[table] ?? []) {
        expect(Object.getPrototypeOf(row)).toBe(Object.prototype); expect(Object.isFrozen(row)).toBe(false);
        const key = table === 'task_assignments' ? 'assignmentId' : 'completionId';
        const canonical = result.sourceRecords.find(s => s.canonicalRecord?.[key] === row[key])!.canonicalRecord!;
        expect(row).not.toBe(canonical); row.note = 'mutable'; expect(canonical.note).not.toBe('mutable');
        if (b) expect(() => assertRegisteredBoundedJson(row, b)).toThrow('Legacy bounded JSON is invalid.');
      }
    }
  });
});

describe('history closed construction factories', () => {
  for (const [name, cost] of Object.entries(recipes)) for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) it(`${name} ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), native = bounded.allocate, stop = new Error('factory reached');
    let reached = 0, factories = 0, error: unknown;
    const spy = vi.spyOn(bounded, 'allocate').mockImplementation((owner, amount, make) => {
      if (owner !== b || amount.structuralBytes !== cost.structuralBytes) return native(owner, amount, make);
      reached++; leave(b, dimension, cost[dimension] + delta);
      native(owner, amount, () => { factories++; return make(); }); throw stop;
    });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(reached).toBe(1); expect(factories).toBe(delta < 0 ? 0 : 1);
    // Canonical factory's cell copies need separately charged nodes/bytes.
    if (delta < 0 || name.endsWith('Canonical')) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const delta of [-1, 0, 1]) it(`assignment canonical reservation precedes cycleId argument slots ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), id = validators.canonicalId, get = Map.prototype.get;
    let reached = 0, operands = 0, error: unknown;
    const spy = vi.spyOn(validators, 'canonicalId').mockImplementation((value, owner) => {
      const result = id(value, owner);
      // Exact scalar conversion of previousAssignmentId reserves 8+4 slots before the shell.
      if (value === 'v1|TI1|r1|2026-08-30T00:00:00Z') { reached++; leave(b, 'slots', 12 + recipes.assignmentCanonical.slots + delta); }
      return result;
    });
    Map.prototype.get = function (key) { if (reached && key === 'cycleId') operands++; return get.call(this, key); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; spy.mockRestore(); }
    expect(reached).toBe(1); expect(operands).toBe(delta < 0 ? 0 : 1); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('history evidence shells and malformed occurrence', () => {
  for (const dimension of ['nodes', 'contentBytes', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`invalid raw-evidence tuple prehash ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'evidence-evidenceBoardId-"bad"'), regex = RegExp.prototype.test, trim = String.prototype.trim;
    let invalid = false, reached = 0, hashes = 0, error: unknown;
    RegExp.prototype.test = function (value) { const result = regex.call(this, value); if (this.source === '^[A-Za-z0-9]{16,22}$' && value === 'bad') invalid = true; return result; };
    String.prototype.trim = function () {
      const result = trim.call(this);
      if (invalid && result === 'POST-1' && !reached) { reached++; const left = ({ nodes: 1, contentBytes: 10, structuralBytes: 4, work: 4 })[dimension] + delta; const debit = b.limits[dimension] - b.usage()[dimension] - left; if (dimension === 'work') b.spend(debit); else b.reserve({ [dimension]: debit }); }
      return result;
    };
    const hash = vi.spyOn(validators, 'sha256');
    try { run(input, b); } catch (e) { error = e; } finally { RegExp.prototype.test = regex; String.prototype.trim = trim; hashes = hash.mock.calls.filter(c => c[0] === 'bad\0POST-1').length; hash.mockRestore(); }
    expect(reached).toBe(1); expect(hashes).toBe(delta < 0 ? 0 : 1); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const recipe of [
    { name: 'headers', fixture: 'valid-evidence-bank-quarantine', nodes: 1, slots: 5, structuralBytes: 36 },
    { name: 'binding', fixture: 'valid-evidence-bank-quarantine', nodes: 11, slots: 9, structuralBytes: 224 },
    { name: 'invalid', fixture: 'evidence-evidenceBoardId-"bad"', nodes: 10, slots: 9, structuralBytes: 191 },
    { name: 'evidence', fixture: 'valid-evidence-bank-quarantine', nodes: 7, slots: 6, structuralBytes: 159 },
  ]) for (const dimension of dimensions.filter(d => d !== 'work')) for (const delta of [-1, 0, 1]) it(`${recipe.name} factory ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, recipe.fixture), native = bounded.allocate, id = validators.canonicalId, stop = new Error('factory complete');
    let active = false, reached = 0, calls = 0, error: unknown;
    const scalar = vi.spyOn(validators, 'canonicalId').mockImplementation((value, owner) => { const result = id(value, owner); if (value === 'C1') active = true; return result; });
    const spy = vi.spyOn(bounded, 'allocate').mockImplementation((owner, amount, make) => {
      if (!active || owner !== b || amount.structuralBytes !== recipe.structuralBytes) return native(owner, amount, make);
      reached++; leave(b, dimension, recipe[dimension] + delta); native(owner, amount, () => { calls++; return make(); }); throw stop;
    });
    try { run(input, b); } catch (e) { error = e; } finally { spy.mockRestore(); scalar.mockRestore(); }
    expect(reached).toBe(1); expect(calls).toBe(delta < 0 ? 0 : 1);
    if (delta >= 0 && (recipe.name === 'headers' || (recipe.name === 'evidence' && dimension === 'slots'))) expect(error).toBe(stop); else expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`malformed occurrence before native financial predicate ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'TaskAssignments-source-BAD'), includes = Array.prototype.includes, has = Set.prototype.has, push = Array.prototype.push, stop = new Error('first error append');
    let reached = 0, predicates = 0, appends = 0, error: unknown;
    Array.prototype.includes = function (value, from) { const result = includes.call(this, value, from); if (value === 'BAD' && this[0] === 'ADMIN') { reached++; leave(b, dimension, ({ nodes: 1, slots: 1, structuralBytes: 8, work: 2 })[dimension] + delta); } return result; };
    Set.prototype.has = function (value) { if (reached && value === 'TaskAssignments') predicates++; return has.call(this, value); };
    Array.prototype.push = function (...values: unknown[]) { if (reached && values[0] === 'MALFORMED_REQUIRED_HISTORY') { appends++; throw stop; } return push.apply(this, values); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Set.prototype.has = has; Array.prototype.push = push; }
    expect(reached).toBe(1); expect(predicates).toBe(delta < 0 ? 0 : 1); expect(appends).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('history native ref and Target first-append capacity', () => {
  for (const boundary of ['assignmentPair', 'assignmentPrevious', 'assignmentTarget', 'completionPair', 'completionTarget'] as const) for (const dimension of dimensions) for (const delta of [-1, 0, 1]) it(`${boundary} ${dimension} ${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), push = Array.prototype.push, trim = String.prototype.trim, id = validators.canonicalId;
    const stop = new Error('first scoped append'); let armed = false, completion = false, appended = 0, error: unknown;
    const cost = boundary === 'assignmentPair' ? { ...recipes.pairRefs, work: 14 } : boundary === 'assignmentPrevious' ? recipes.previousRef : boundary === 'assignmentTarget' ? recipes.assignmentStaged : boundary === 'completionPair' ? recipes.pairRefs : recipes.completionStaged;
    const arm = () => { if (!armed) { armed = true; leave(b, dimension, cost[dimension] + delta); } };
    const spy = vi.spyOn(validators, 'canonicalId').mockImplementation((value, owner) => { const result = id(value, owner); if (value === 'C1') completion = true; return result; });
    // The closed immutable sibling is now constructed after the final cell.
    // Arm at the real canonical factory exit, not before its newly charged work.
    const nativeAllocate = bounded.allocate;
    const canonical = vi.spyOn(bounded, 'allocate').mockImplementation((owner, amount, make) => {
      const result = nativeAllocate(owner, amount, make);
      if (owner === b && ((boundary === 'assignmentPair' && amount.structuralBytes === recipes.assignmentCanonical.structuralBytes)
        || (boundary === 'completionPair' && amount.structuralBytes === recipes.completionCanonical.structuralBytes))) arm();
      return result;
    });
    Array.prototype.push = function (...values: unknown[]) {
      const first = record(values[0]), ref = first?.code === 'BROKEN_ASSIGNMENT_REFERENCE';
      const match = boundary === 'assignmentPair' ? values.length === 2 && first?.code === 'BROKEN_TASK_REFERENCE'
        : boundary === 'assignmentPrevious' ? ref && first?.id === 'AS0'
        : boundary === 'completionPair' ? values.length === 2 && first?.code === 'BROKEN_STUDENT_REFERENCE'
        : first?.table === (boundary === 'assignmentTarget' ? 'task_assignments' : 'task_completions') && Boolean(first?.record);
      if (armed && match) { appended++; throw stop; }
      const result = push.apply(this, values);
      if (boundary === 'assignmentPrevious' && values.length === 2 && first?.code === 'BROKEN_TASK_REFERENCE' && !completion) {
        // Only second assignment has a predecessor. The first Target marks it.
        if (secondAssignment) arm();
      }
      if (first?.table === 'task_assignments' && first?.record) secondAssignment = true;
      if (boundary === 'assignmentTarget' && ref && first?.id === 'AS0') arm();
      if (boundary === 'completionTarget' && completion && ref && first?.id === 'AS1') arm();
      return result;
    };
    let secondAssignment = false;
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; String.prototype.trim = trim; spy.mockRestore(); canonical.mockRestore(); }
    expect(armed).toBe(true); expect(appended).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('history scalar propagation and cumulative context', () => {
  it('all assignment and completion scalar helpers receive the same request', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), id = vi.spyOn(validators, 'canonicalId'), instant = vi.spyOn(validators, 'canonicalInstant'), integer = vi.spyOn(validators, 'safeInteger');
    try {
      run(input, b);
      for (const value of ['AS0', 'AS1', 'C1', 'v1|TI1|r1|2026-08-30T00:00:00Z']) { const calls = id.mock.calls.filter(c => c[0] === value); expect(calls.length).toBeGreaterThan(0); expect(calls.every(c => c[1] === b)).toBe(true); }
      expect(instant.mock.calls.every(c => c[1] === b)).toBe(true); expect(integer.mock.calls.every(c => c[2] === b)).toBe(true);
    } finally { id.mockRestore(); instant.mockRestore(); integer.mockRestore(); }
  });
  it('successive real normalizations retain cumulative work and allocations', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b); run(input, b); const first = b.usage(); run(input, b); const second = b.usage();
    for (const d of dimensions) expect(second[d]).toBeGreaterThan(first[d]);
  });
});

describe('history actual staged clone exits before Target append', () => {
  for (const table of ['task_assignments', 'task_completions']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) for (const state of ['timely', 'expired', 'aborted'] as const) it(`${table} ${exit} ${state}`, () => {
    let now = 0; const abort = new AbortController(), b = createBudgetContext({ now: () => now, signal: abort.signal }), input = admitted(b), native = bounded.allocate, push = Array.prototype.push;
    const injected = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native clone');
    const stop = new Error('appended'); let getter = 0, appended = 0, error: unknown;
    const cost = table === 'task_assignments' ? recipes.assignmentStaged : recipes.completionStaged;
    const spy = vi.spyOn(bounded, 'allocate').mockImplementation((owner, amount, make) => {
      const value = native(owner, amount, make);
      if (owner === b && amount.structuralBytes === cost.structuralBytes) Object.defineProperty(value, 'tenantId', { enumerable: true, get() { getter++; if (state === 'expired') now = 5001; if (state === 'aborted') abort.abort(); if (exit !== 'success') throw injected; return input.tenantId; } });
      return value;
    });
    Array.prototype.push = function (...values: unknown[]) { if (record(values[0])?.table === table && record(values[0])?.record) { appended++; throw stop; } return push.apply(this, values); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; spy.mockRestore(); }
    expect(getter).toBe(1); expect(appended).toBe(exit === 'success' && state === 'timely' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable' || (exit === 'ordinary' && state === 'timely')) expect(error).toBe(injected);
    else if (state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError); else expect(error).toBe(stop);
  });
});
