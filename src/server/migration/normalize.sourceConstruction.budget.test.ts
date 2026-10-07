/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-this-alias -- Observe the original native receiver identity. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson, canonicalBoundedJson } from '@/lib/boundedJson';
import * as outputModule from './normalizationOutput';
import * as workModule from '@/lib/boundedWork';
import * as validatorsModule from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

// ORACLE_OBSERVER_BEGIN
function observe(normalize: (input: any) => any, input: any, hooked = true, probe?: string) {
  const push = Array.prototype.push, set = Map.prototype.set;
  const entries: any[] = [], received: number[] = [], sources: any[] = [], trace: string[] = [];
  const seen = new Set<any>();
  let receiver: any, result: any, error: any, armed = false;
  const stop = new RangeError('source getter');
  function instrument(e: any) {
    let targetHooked = false;
    function getter(object: any, key: string, label: string) {
      const value = object[key];
      Object.defineProperty(object, key, { configurable: true, get() {
        if (new Error().stack?.includes('toSourceRecord')) {
          if (label === 'targets' && !targetHooked && value[0]) {
            targetHooked = true; getter(value[0], 'table', 'table'); getter(value[0], 'id', 'id'); getter(value, '0', 'first');
          }
          armed = true; push.call(trace, label); if (probe === label) throw stop;
        }
        return value;
      } });
    }
    const first = e.targets[0];
    if (first) { targetHooked = true; getter(first, 'table', 'table'); getter(first, 'id', 'id'); getter(e.targets, '0', 'first'); }
    for (const k of ['errors', 'warnings', 'targets', 'source', 'redacted', 'canonical']) getter(e, k, k);
  }
  function remember(e: any) {
    if (e && Array.isArray(e.errors) && Array.isArray(e.targets) && e.source && !seen.has(e)) {
      seen.add(e); push.call(entries, e);
      if (probe && e.tab === 'Students') instrument(e);
    }
  }
  try {
    Array.prototype.push = function(...items: any[]) {
      if (hooked || probe) for (const e of items) {
        remember(e);
        if (!receiver && seen.has(e) && e.source.kind === 'SHEET') receiver = this;
        if (receiver === this && seen.has(e)) push.call(received, entries.indexOf(e));
        if (e?.mappingStatus && 'errorCodes' in e) {
          push.call(sources, e);
          if (probe && armed) { push.call(trace, 'push'); throw stop; }
        }
      }
      return push.apply(this, items);
    };
    Map.prototype.set = function(k: any, v: any) {
      if (hooked && Array.isArray(v)) for (const e of v) remember(e);
      return set.call(this, k, v);
    };
    result = normalize(input);
  } catch (e) { error = e; }
  finally { Array.prototype.push = push; Map.prototype.set = set; }
  if (probe) return { trace, reached: armed, errorIdentity: error === stop };
  if (error) throw error;
  return {
    raw: entries.map(e => ({ source: e.source, tab: e.tab, errors: e.errors, warnings: e.warnings, refs: e.refs, canonical: e.canonical, targets: e.targets,
      canonicalOwner: e.canonical ? entries.findIndex(other => other.canonical === e.canonical) : null,
      aliases: e.targets.map((t: any) => t.record === e.canonical) })), received,
    sources: sources.map(s => ({ value: s, keys: Object.keys(s), owner: entries.findIndex(e => e.source === s.source),
      redactedAlias: entries.some(e => e.source === s.source && e.redacted === s.redactedSourceRecord),
      canonicalAlias: s.canonicalRecord === null ? null : entries.some(e => e.source === s.source && e.canonical === s.canonicalRecord),
      mutable: !Object.isFrozen(s) && !Object.isFrozen(s.errorCodes) && !Object.isFrozen(s.warningCodes),
      independentCodes: entries.every(e => s.errorCodes !== e.errors && s.warningCodes !== e.warnings) })),
    json: JSON.stringify(result), nullPrototype: Object.getPrototypeOf(result.records) === null,
    counts: Object.fromEntries(Object.entries(result.records).map(([k, v]) => [k, (v as any[]).length])),
  };
}
// ORACLE_OBSERVER_END

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/source-construction-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: ReturnType<typeof observe> }[];
  getters: { probe: string; hooked: boolean; outcome: ReturnType<typeof observe> }[];
};
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
function seamInput(): Input {
  const input = clone(golden.cases.find(c => c.name === 'supported-v3')!.input);
  const students = input.sheets.tabs.Students;
  const second = { rowNumber: 3, cells: ['S2', 'Bob', '100', 'ACTIVE'], hash: 'b'.repeat(64) };
  return { ...input, sheets: { ...input.sheets, tabs: { Students: { ...students, rows: [...students.rows, second] } } } };
}
const realCreate = outputModule.createNormalizationOutput;
function consume(budget: BudgetContext, key: 'nodes' | 'slots' | 'structuralBytes' | 'work', remaining: number) {
  const amount = budget.limits[key] - budget.usage()[key] - remaining;
  if (key === 'work') budget.spend(amount); else budget.reserve({ [key]: amount });
}
function captureEntries() {
  const entries: any[] = [], push = Array.prototype.push;
  Array.prototype.push = function(...items: any[]) {
    for (const e of items) if (e && Array.isArray(e.errors) && Array.isArray(e.targets) && e.source && !entries.includes(e)) push.call(entries, e);
    return push.apply(this, items);
  };
  return { entries, restore() { Array.prototype.push = push; } };
}
function inputWith(budget: BudgetContext) { return parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input; }

function sourceSeam(budget: BudgetContext, action: (entry: any, list: any[], factory: () => any, original: ReturnType<typeof realCreate>, quarantine: boolean) => void) {
  const capture = captureEntries(); let calls = 0;
  const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
    expect(context).toBe(budget); const output = realCreate(context);
    return { ...output, sourceRecord(list, quarantine, factory) {
      calls++; action(capture.entries[calls - 1], list, factory, output, quarantine);
    } };
  });
  return () => { spy.mockRestore(); capture.restore(); };
}

describe('original Git source output and raw occurrence oracle', () => {
  for (const enabled of [false, true]) for (const f of golden.cases) it(`${f.name} budget=${enabled}`, () => {
    const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
    const actual = observe(i => run(i, budget), budget ? parseRegisteredBoundedJson(JSON.stringify(f.input), budget) : clone(f.input));
    expect(actual.raw).toEqual(f.outcome.raw); expect(actual.received).toEqual(f.outcome.received);
    expect(actual.sources).toEqual(f.outcome.sources); expect(actual).toEqual(f.outcome);
  });
  for (const f of golden.getters) it(`no-budget getter ${f.probe} hooked=${f.hooked}`, () => {
    expect(observe(run, clone(golden.cases.find(c => c.name === 'supported-v3')!.input), f.hooked, f.probe)).toEqual(f.outcome);
  });
});

// The first input getter follows the base shell AND Set/scratch construction.
// Independent schema: base 2/6/120/7, predecessors 2/0/32/2;
// real source admission adds 0/1/4/1, never a second category charge.
describe('source shell plus actual predecessor admission', () => {
  const payload = { nodes: 4, slots: 6, structuralBytes: 152, work: 9 };
  const total = { nodes: 4, slots: 7, structuralBytes: 156, work: 10 };
  for (const boundary of ['method', 'factory'] as const) for (const key of Object.keys(payload) as (keyof typeof payload)[]) for (const delta of [-1, 0, 1]) it(`${boundary} ${key} first errors getter delta ${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('first input');
    let methods = 0, factories = 0, getters = 0;
    const restore = sourceSeam(budget, (e, list, factory, output, q) => {
      methods++;
      if (boundary === 'method') consume(budget, key, total[key] + delta);
      output.sourceRecord(list, q, () => {
        factories++; if (boundary === 'factory') consume(budget, key, payload[key] + delta);
        Object.defineProperty(e, 'errors', { get() { getters++; throw stop; } }); return factory();
      });
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); }
    expect(methods).toBe(1); expect(factories).toBe(1); expect(getters).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
  });
});

describe('source operand immediate completion, synthetic reached factory sentinels', () => {
  const all = ['errors', 'warnings', 'targets', 'first', 'source', 'redacted', 'canonical', 'table', 'id'];
  for (const field of all) for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`${field} ${state} ${exit}`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
    const input = inputWith(budget), stop = new RangeError('completed factory');
    const error = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('getter');
    let returned = 0, methods = 0; const trace: string[] = [];
    const restore = sourceSeam(budget, (e, list, factory, output, q) => {
      methods++; output.sourceRecord(list, q, () => {
        const first = e.targets[0];
        const operands = [[e, 'errors', 'errors', []], [e, 'warnings', 'warnings', []], [e, 'targets', 'targets', e.targets], [e.targets, '0', 'first', first], [e, 'source', 'source', e.source], [e, 'redacted', 'redacted', e.redacted], [e, 'canonical', 'canonical', e.canonical], [first, 'table', 'table', first.table], [first, 'id', 'id', first.id]];
        for (const [object, key, label, value] of operands) Object.defineProperty(object, key, { configurable: true, get() {
          trace.push(label);
          if (label === field) { if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw error; }
          return value;
        } });
        const value = factory(); returned++; void value; throw stop;
      });
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); }
    const complete = state === 'timely' && exit === 'success';
    expect(methods).toBe(1); expect(trace).toEqual(complete ? all : all.slice(0, all.indexOf(field) + 1)); expect(returned).toBe(complete ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
    else expect(caught).toBe(complete ? stop : error);
  });
});

describe('closed payload, unique code containers and alias topology', () => {
  for (const errors of [[], ['Z'], ['Z', 'A'], ['Z', 'Z', 'A']]) for (const warnings of [[], ['W'], ['W', 'A', 'W']]) for (const topology of ['target', 'zero', 'unsupported', 'mixed']) it(`synthetic ${JSON.stringify(errors)} ${JSON.stringify(warnings)} ${topology}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('source completed');
    let result: any, entry: any, before: any, after: any, calls = 0;
    const codes = topology === 'unsupported' ? ['UNSUPPORTED_LEGACY_BANK_AUTHORITY'] : topology === 'mixed' ? ['Z', 'UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY', 'Z'] : errors;
    const restore = sourceSeam(budget, (e, list, factory, output, q) => {
      calls++; entry = e;
      output.sourceRecord(list, q, () => {
        e.errors = [...codes]; e.warnings = [...warnings]; if (topology === 'zero') e.targets = [];
        before = budget.usage(); result = factory(); after = budget.usage(); throw stop;
      });
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); }
    expect(caught).toBe(stop); expect(calls).toBe(1);
    const u = new Set(codes).size + new Set(warnings).size;
    const retained = codes.length === 0 || topology === 'unsupported' || topology === 'mixed';
    const optional = codes.length === 0 && topology !== 'zero';
    // Two code kinds each own five containers; per unique: one scalar, five slots, 24 bytes.
    expect(after.nodes - before.nodes).toBe(12 + u + (retained ? 0 : 1) + (optional ? 2 : 0));
    expect(after.slots - before.slots).toBe(6 + 5 * u + (optional ? 2 : 0));
    expect(after.structuralBytes - before.structuralBytes).toBe(280 + 24 * u + (retained ? 0 : 4) + (optional ? 35 : 0));
    expect(after.contentBytes - before.contentBytes).toBe(0);
    // Independent short-code table: empty=3 containers+2 terminal loop tests;
    // one unique=19; two unique=42 (11 merge-sort work); a duplicate adds 5.
    const codeWork = (list: string[]) => list.length === 0 ? 5 : list.length === 1 ? 19 : list.length === 2 ? 42 : 47;
    const retentionWork = codes.length === 0 ? 0 : topology === 'unsupported' ? 4 : topology === 'mixed' ? 7 : 7 * new Set(codes).size + 1;
    expect(after.work - before.work).toBe(7 + codeWork(codes) + codeWork(warnings) + retentionWork + (optional ? 2 : 0));
    expect(result.source).toBe(entry.source); expect(result.redactedSourceRecord).toBe(entry.redacted); expect(result.canonicalRecord).toBe(retained ? entry.canonical : null);
    expect(result.errorCodes).toEqual([...new Set(codes)].sort()); expect(result.warningCodes).toEqual([...new Set(warnings)].sort());
    expect(Object.keys(result)).toEqual(['source', 'redactedSourceRecord', 'canonicalRecord', 'mappingStatus', ...(optional ? ['targetTable', 'targetId'] : []), 'warningCodes', 'errorCodes']);
    if (optional) { expect(result.targetTable).toBe(entry.targets[0].table); expect(result.targetId).toBe(entry.targets[0].id); }
    expect(Object.isFrozen(result)).toBe(false); expect(Object.isFrozen(result.errorCodes)).toBe(false); expect(Object.isFrozen(result.warningCodes)).toBe(false);
    result.errorCodes.push('mutable'); result.warningCodes.push('mutable'); expect(entry.errors).toEqual(codes); expect(entry.warnings).toEqual(warnings);
    if (result.canonicalRecord) {
      expect(Object.isFrozen(result.canonicalRecord)).toBe(false);
      result.canonicalRecord.sourceAliasProbe = 'owner-visible'; expect(entry.canonical.sourceAliasProbe).toBe('owner-visible'); delete result.canonicalRecord.sourceAliasProbe;
    }
    let invalid: any; try { canonicalBoundedJson(result, budget); } catch (e) { invalid = e; }
    expect(invalid?.name).toBe('InvalidBoundedJsonError'); expect(invalid?.message).toBe('Legacy bounded JSON is invalid.');
  });
});

describe('optional and null occurrence exact boundaries', () => {
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`optional ${key} delta ${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('optional table');
    let canonical = 0, table = 0, id = 0;
    const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
      const value = e.canonical, first = e.targets[0];
      Object.defineProperty(e, 'canonical', { get() { canonical++; consume(budget, key, ({ nodes: 2, slots: 2, structuralBytes: 35, work: 2 })[key] + delta); return value; } });
      Object.defineProperty(first, 'table', { get() { table++; throw stop; } }); Object.defineProperty(first, 'id', { get() { id++; throw stop; } });
      return factory();
    }));
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); }
    expect(canonical).toBe(1); expect(table).toBe(delta < 0 ? 0 : 1); expect(id).toBe(0);
    if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
  });
  for (const key of ['nodes', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`null ${key} delta ${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('null returned');
    let reached = 0, returned = 0, canonical = 0;
    const equal = workModule.equalBudgetValue;
    const spy = vi.spyOn(workModule, 'equalBudgetValue').mockImplementation((left, right, context) => {
      const value = equal(left, right, context);
      if (left === 'Z' && right === 'UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY') {
        reached++; consume(budget, key, ({ nodes: 1, structuralBytes: 4, work: 1 })[key] + delta);
      }
      return value;
    });
    const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
      e.errors = ['Z']; Object.defineProperty(e, 'canonical', { get() { canonical++; throw stop; } });
      const value = factory(); returned++; expect(value.canonicalRecord).toBeNull(); throw stop;
    }));
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); spy.mockRestore(); }
    expect(reached).toBe(1); expect(canonical).toBe(0); expect(returned).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
  });
});

describe('source native receiver completion before the raw successor', () => {
  for (const quarantine of [false, true]) for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`${quarantine} ${state} ${exit}`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
    const raw = seamInput(); if (quarantine) (raw.sheets.tabs.Students.rows[0].cells as string[])[0] = '';
    const input = parseRegisteredBoundedJson(JSON.stringify(raw), budget) as Input;
    const error = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('push');
    const stop = new RangeError('successor'), push = Array.prototype.push;
    let pushes = 0, successors = 0, size = 0, receiver: any[], qSeen: boolean;
    const capture = captureEntries();
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); const output = realCreate(context);
      return { ...output, sourceRecord(list, q, factory) {
        qSeen = q; receiver = list; size = list.length;
        const next = capture.entries[q ? 0 : 1]; const errors = next?.errors;
        if (next) Object.defineProperty(next, 'errors', { configurable: true, get() { if (pushes) { successors++; throw stop; } return errors; } });
        Object.defineProperty(list, 'push', { configurable: true, value(...values: any[]) {
          pushes++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true;
          if (exit !== 'success') throw error; return push.apply(list, values);
        } });
        output.sourceRecord(list, q, factory);
      } };
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { spy.mockRestore(); capture.restore(); }
    expect(qSeen!).toBe(quarantine); expect(pushes).toBe(1); expect(receiver!).toHaveLength(size + (exit === 'success' ? 1 : 0));
    expect(successors).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
    else expect(caught).toBe(exit === 'success' ? stop : error);
  });
});

describe('real errorCode destination and occurrence admission', () => {
  for (const boundary of ['method', 'factory'] as const) for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1].filter(d => !(key === 'slots' && boundary === 'factory' && d === -1))) it(`${boundary} ${key} delta ${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('emitted');
    const capture = captureEntries(); let methods = 0, factories = 0, returned = 0, pushes = 0;
    const cost = boundary === 'method' ? { nodes: 1, slots: 1, structuralBytes: 8, work: 2 } : { nodes: 1, slots: 0, structuralBytes: 4, work: 1 };
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); const output = realCreate(context);
      return { ...output, sourceRecord(list, q, factory) {
        output.sourceRecord(list, q, () => { capture.entries[0].errors = ['Z']; return factory(); });
      }, errorCode(list, factory) {
        methods++; if (boundary === 'method') consume(budget, key, cost[key] + delta);
        Object.defineProperty(list, 'push', { value() { pushes++; throw stop; } });
        output.errorCode(list, () => { factories++; if (boundary === 'factory') consume(budget, key, cost[key] + delta); const result = factory(); returned++; return result; });
      } };
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { spy.mockRestore(); capture.restore(); }
    expect(methods).toBe(1); expect(factories).toBe(boundary === 'method' && delta < 0 && key !== 'nodes' ? 0 + (key === 'work' || key === 'structuralBytes' ? 1 : 0) : 1);
    expect(returned).toBe(delta < 0 ? 0 : 1); expect(pushes).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
  });
  for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`errorCode push ${state} ${exit}`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal }), input = inputWith(budget);
    const error = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('code push');
    const stop = new RangeError('sort successor'), push = Array.prototype.push;
    let pushes = 0, successors = 0; const capture = captureEntries();
    const sort = workModule.stableBudgetSort;
    const sortSpy = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((list, compare, context) => { if (pushes) { successors++; throw stop; } return sort(list, compare, context); });
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); const output = realCreate(context);
      return { ...output, sourceRecord(list, q, factory) { output.sourceRecord(list, q, () => {
        const e = capture.entries[0]; e.errors = ['Z']; Object.defineProperty(e, 'warnings', { get() { successors++; throw stop; } }); return factory();
      }); }, errorCode(list, factory) {
        Object.defineProperty(list, 'push', { configurable: true, value(...values: any[]) {
          pushes++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true;
          if (exit !== 'success') throw error; return push.apply(list, values);
        } }); output.errorCode(list, factory);
      } };
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { spy.mockRestore(); sortSpy.mockRestore(); capture.restore(); }
    expect(pushes).toBe(1); expect(successors).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
    else expect(caught).toBe(exit === 'success' ? stop : error);
  });
});

describe('Set and list native exits, synthetic source-only operands', () => {
  for (const boundary of ['has', 'add', 'scratch', 'sort', 'compare', 'length', 'index']) for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`${boundary} ${state} ${exit}`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal }), input = inputWith(budget);
    const error = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native');
    const stop = new RangeError('successor');
    const has = Set.prototype.has, add = Set.prototype.add, push = Array.prototype.push, sort = workModule.stableBudgetSort;
    let armed = false, reached = 0, successors = 0, returned = 0;
    function fire() { reached++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw error; }
    function next() { if (reached) { successors++; throw stop; } }
    const sortSpy = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((list, compare, context) => {
      if (!armed) return sort(list, compare, context);
      if (boundary !== 'sort' && boundary !== 'compare') next();
      const result = sort(list, (a, b) => { const value = compare(a, b); if (boundary === 'compare') fire(); return value; }, context);
      if (boundary === 'sort') fire(); return result;
    });
    const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
      e.errors = new Proxy(['Z', 'A'], { get(target, key, receiver) {
        if (armed && key === 'length') { if (boundary === 'length' && !reached) fire(); else if (boundary === 'index') next(); }
        if (armed && key === '0') { if (boundary === 'index') fire(); else if (boundary === 'length') next(); }
        return Reflect.get(target, key, receiver);
      } });
      Object.defineProperty(e, 'warnings', { get() { next(); return []; } });
      Set.prototype.has = function(value: any) { if (armed && (value === 'Z' || value === 'A')) { if (boundary === 'index') next(); if (boundary === 'has') fire(); } return has.call(this, value); };
      Set.prototype.add = function(value: any) { if (armed && (value === 'Z' || value === 'A')) { if (boundary === 'has') next(); if (boundary === 'add') fire(); } return add.call(this, value); };
      Array.prototype.push = function(...items: any[]) {
        if (armed && items[0] === 'Z') { if (boundary === 'add') next(); if (boundary === 'scratch' && !reached) fire(); else if (boundary === 'scratch') next(); }
        return push.apply(this, items);
      };
      armed = true; const result = factory(); returned++; return result;
    }));
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally {
      armed = false; Set.prototype.has = has; Set.prototype.add = add; Array.prototype.push = push; restore(); sortSpy.mockRestore();
    }
    expect(reached).toBe(1); expect(returned).toBe(0); expect(successors).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
    else expect(caught).toBe(exit === 'success' ? stop : error);
  });
});

describe('first Set allocation preflight and completion', () => {
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`base plus first Set ${key} delta ${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('Set construction');
    const Original = globalThis.Set; let constructors = 0, operands = 0, armed = false;
    const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
      consume(budget, key, ({ nodes: 3, slots: 6, structuralBytes: 136, work: 8 })[key] + delta);
      Object.defineProperty(e, 'errors', { get() { operands++; throw stop; } });
      globalThis.Set = new Proxy(Original, { construct(target, args) { if (armed) { constructors++; throw stop; } return Reflect.construct(target, args); } });
      armed = true; return factory();
    }));
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { armed = false; globalThis.Set = Original; restore(); }
    expect(constructors).toBe(delta < 0 ? 0 : 1); expect(operands).toBe(0);
    if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
  });
  for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`Set constructor ${state} ${exit}`, () => {
    let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal }), input = inputWith(budget);
    const error = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('Set');
    const stop = new RangeError('input'), Original = globalThis.Set; let constructors = 0, operands = 0, armed = false;
    const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
      Object.defineProperty(e, 'errors', { get() { operands++; throw stop; } });
      globalThis.Set = new Proxy(Original, { construct(target, args) {
        if (armed) { constructors++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw error; }
        return Reflect.construct(target, args);
      } }); armed = true; return factory();
    }));
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { armed = false; globalThis.Set = Original; restore(); }
    expect(constructors).toBe(1); expect(operands).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
    else expect(caught).toBe(exit === 'success' ? stop : error);
  });
});

describe('retention short circuit, first-target semantics and input reads', () => {
  for (const code of ['Z', 'UNSUPPORTED_LEGACY_BANK_AUTHORITY', 'UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY']) it(code, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('complete');
    let firstReads = 0, canonicalReads = 0, tableReads = 0, idReads = 0, result: any;
    const comparisons: any[] = [], equal = workModule.equalBudgetValue;
    const spy = vi.spyOn(workModule, 'equalBudgetValue').mockImplementation((left, right, context) => {
      if (right === 'UNSUPPORTED_LEGACY_BANK_AUTHORITY' || right === 'UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY') comparisons.push([left, right]);
      return equal(left, right, context);
    });
    const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
      e.errors = [code, 'ZZZZ']; const first = e.targets[0], canonical = e.canonical;
      Object.defineProperty(e.targets, '0', { get() { firstReads++; return first; } });
      Object.defineProperty(e, 'canonical', { get() { canonicalReads++; return canonical; } });
      Object.defineProperty(first, 'table', { get() { tableReads++; throw stop; } });
      Object.defineProperty(first, 'id', { get() { idReads++; throw stop; } });
      result = factory(); throw stop;
    }));
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); spy.mockRestore(); }
    expect(caught).toBe(stop); expect(firstReads).toBe(1); expect(tableReads).toBe(0); expect(idReads).toBe(0);
    expect(canonicalReads).toBe(code === 'Z' ? 0 : 1); expect('targetTable' in result).toBe(false);
    expect(comparisons).toHaveLength(code === 'Z' ? 4 : code === 'UNSUPPORTED_LEGACY_BANK_AUTHORITY' ? 1 : 2);
  });
});

// Supplemental mutation-strengthening: observe the next accounting API call and
// delegated comparator/factory return, not only a later user operand.
describe('immediate native completion mutation controls', () => {
  for (const boundary of ['Set', 'has', 'add', 'scratch', 'result', 'errorCode', 'sort', 'operand', 'length', 'index', 'canonical', 'redacted', 'compare', 'distinct-index']) it(boundary, () => {
    let now = 0, reached = 0, successors = 0, returns = 0, comparatorReturns = 0, lengthAfterRedacted = 0;
    const owner = createBudgetContext({ now: () => now });
    const budget: BudgetContext = { ...owner,
      spend(amount = 1) { if (reached) successors++; owner.spend(amount); },
      reserve(cost) { if (reached) successors++; owner.reserve(cost); },
    };
    const input = inputWith(budget), stop = new RangeError('factory escaped');
    const OriginalSet = globalThis.Set, has = Set.prototype.has, add = Set.prototype.add, push = Array.prototype.push;
    const sort = workModule.stableBudgetSort, compare = validatorsModule.compareCodeUnits;
    let armed = false, warningPushes = 0, sortCalls = 0;
    function fire() { reached++; now = 5000; }
    const sortSpy = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((list, cmp, context) => {
      const value = sort(list, (a, b) => { const v = cmp(a, b); if (reached) comparatorReturns++; return v; }, context);
      if (armed) {
        sortCalls++;
        if (boundary === 'sort') fire();
        if (boundary === 'redacted' && sortCalls === 1) return new Proxy(value, { get(target, key, receiver) { if (reached && key === 'length') lengthAfterRedacted++; return Reflect.get(target, key, receiver); } });
      }
      return value;
    });
    const compareSpy = vi.spyOn(validatorsModule, 'compareCodeUnits').mockImplementation((a, b, context) => {
      const value = compare(a, b, context); if (armed && boundary === 'compare' && context === budget) fire(); return value;
    });
    const capture = captureEntries();
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); const output = realCreate(context);
      return { ...output, errorCode(list, factory) { if (reached && boundary === 'distinct-index') successors++; output.errorCode(list, factory); if (armed && boundary === 'errorCode') fire(); },
        sourceRecord(list, q, factory) { output.sourceRecord(list, q, () => {
          const e = capture.entries[0];
          e.errors = boundary === 'canonical' || boundary === 'redacted' || boundary === 'result' ? [] : boundary === 'compare' ? ['Z', 'A'] : ['Z'];
          e.warnings = boundary === 'result' ? ['W'] : [];
          if (boundary === 'canonical') e.targets = [];
          if (boundary === 'operand') { const value = e.errors; Object.defineProperty(e, 'errors', { get() { fire(); return value; } }); }
          if (boundary === 'canonical' || boundary === 'redacted') { const value = e[boundary]; Object.defineProperty(e, boundary, { get() { fire(); return value; } }); }
          if (boundary === 'length' || boundary === 'index') e.errors = new Proxy(e.errors, { get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver); if (key === (boundary === 'length' ? 'length' : '0')) fire(); return value;
          } });
          globalThis.Set = new Proxy(OriginalSet, { construct(target, args) { const value = Reflect.construct(target, args); if (armed && boundary === 'Set') fire(); return value; } });
          OriginalSet.prototype.has = function(v: any) { const value = has.call(this, v); if (armed && boundary === 'has' && v === 'Z') fire(); return value; };
          OriginalSet.prototype.add = function(v: any) { const value = add.call(this, v); if (armed && boundary === 'add' && v === 'Z') fire(); return value; };
          Array.prototype.push = function(...items: any[]) {
            const value = push.apply(this, items);
            if (armed && boundary === 'scratch' && items[0] === 'Z') fire();
            if (armed && boundary === 'distinct-index' && items[0] === 'Z') Object.defineProperty(this, '0', { get() { fire(); return 'Z'; } });
            if (armed && boundary === 'result' && items[0] === 'W' && ++warningPushes === 2) fire();
            return value;
          };
          armed = true; const value = factory(); returns++; void value; throw stop;
        }); },
      };
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally {
      armed = false; globalThis.Set = OriginalSet; OriginalSet.prototype.has = has; OriginalSet.prototype.add = add; Array.prototype.push = push;
      spy.mockRestore(); capture.restore(); sortSpy.mockRestore(); compareSpy.mockRestore();
    }
    expect(reached).toBe(1); expect(caught).toBeInstanceOf(BudgetUnavailableError);
    expect(successors).toBe(0); expect(returns).toBe(0); expect(comparatorReturns).toBe(0); expect(lengthAfterRedacted).toBe(0);
  });
});

describe('warning exemption and second distinct code retain real cumulative admission', () => {
  for (const warningsOnly of [false, true]) it(`synthetic warningsOnly=${warningsOnly}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), output = realCreate(budget), prefill: number[] = [];
    for (let i = 0; i < (warningsOnly ? 8000 : 7999); i++) output.errorCode(prefill, () => i);
    const capture = captureEntries(), stop = new RangeError('source returned');
    let codes = 0, codeFactories = 0, returned = 0, sourceFactory = 0, emitted: any[] = [];
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget); return { ...output,
        sourceRecord(list, q, factory) { output.sourceRecord(list, q, () => {
          sourceFactory++; const e = capture.entries[0]; e.errors = warningsOnly ? [] : ['Z', 'A', 'Z']; e.warnings = ['W', 'W'];
          const value = factory() as any; returned++; expect(value.warningCodes).toEqual(['W']); throw stop;
        }); },
        errorCode(list, factory) { codes++; emitted = list; output.errorCode(list, () => { codeFactories++; return factory(); }); },
      };
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { spy.mockRestore(); capture.restore(); }
    expect(sourceFactory).toBe(1); expect(returned).toBe(warningsOnly ? 1 : 0);
    expect(codes).toBe(warningsOnly ? 0 : 2); expect(codeFactories).toBe(warningsOnly ? 0 : 1); expect(emitted).toEqual(warningsOnly ? [] : ['Z']);
    if (warningsOnly) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    let afterFactory = 0; expect(() => output.errorCode([], () => { afterFactory++; return 1; })).toThrow(BudgetExceededError); expect(afterFactory).toBe(0);
  });
});

describe('individual code-container predecessor capacities (supplemental)', () => {
  for (const kind of ['errors', 'warnings']) for (const stage of ['scratch', 'emission', 'sort']) for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) {
    // Empty scratch/emission have no slots. Sort's one-element copy has two slots.
    if (key === 'slots' && stage !== 'sort') continue;
    it(`${kind} ${stage} ${key} delta ${delta}`, () => {
      const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('next operand');
      const Original = globalThis.Set, realSort = workModule.stableBudgetSort;
      let armed = false, sets = 0, sorts = 0, reached = 0, next = 0;
      const selected = kind === 'errors' ? 1 : 2;
      const sortSpy = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((list, compare, context) => {
        if (armed && ++sorts === selected) {
          if (stage === 'emission') { next++; throw stop; }
          if (stage === 'sort') {
            reached++; consume(budget, key, ({ nodes: 2, slots: 2, structuralBytes: 40, work: 1 })[key] + delta);
            Object.defineProperty(list, '0', { get() { next++; throw stop; } });
          }
        }
        return realSort(list, compare, context);
      });
      const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
        e.errors = []; e.warnings = [];
        if (stage === 'sort') e[kind] = ['Z'];
        if (stage === 'scratch') Object.defineProperty(e, kind, { get() { next++; throw stop; } });
        if (stage === 'emission') e[kind] = new Proxy([], { get(target, property, receiver) {
          if (property === 'length') {
            reached++; // After the input terminal length test: emission shell + its terminal test remain.
            consume(budget, key, ({ nodes: 1, slots: 0, structuralBytes: 16, work: 2 })[key] + delta);
          }
          return Reflect.get(target, property, receiver);
        } });
        globalThis.Set = new Proxy(Original, { construct(target, args) {
          const value = Reflect.construct(target, args);
          if (armed && ++sets === selected && stage === 'scratch') { reached++; consume(budget, key, ({ nodes: 1, slots: 0, structuralBytes: 16, work: 1 })[key] + delta); }
          return value;
        } });
        armed = true; return factory();
      }));
      let caught: unknown;
      try { run(input, budget); } catch (e) { caught = e; } finally { armed = false; globalThis.Set = Original; restore(); sortSpy.mockRestore(); }
      expect(reached).toBe(1); expect(next).toBe(delta < 0 ? 0 : 1);
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
    });
  }
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`warning scalar and destination ${key} delta ${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget), stop = new RangeError('warning append');
    const push = Array.prototype.push; let reached = 0, appends = 0, scratch: any[] | undefined, armed = false;
    const restore = sourceSeam(budget, (e, list, factory, output, q) => output.sourceRecord(list, q, () => {
      e.errors = []; e.warnings = ['W'];
      Array.prototype.push = function(...items: any[]) {
        if (armed && items[0] === 'W') {
          if (scratch) { appends++; throw stop; }
          const value = push.apply(this, items); scratch = this;
          Object.defineProperty(this, '0', { get() { reached++; consume(budget, key, ({ nodes: 1, slots: 1, structuralBytes: 8, work: 2 })[key] + delta); return 'W'; } });
          return value;
        }
        return push.apply(this, items);
      };
      armed = true; return factory();
    }));
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { armed = false; Array.prototype.push = push; restore(); }
    expect(reached).toBe(1); expect(appends).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
  });
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) it(`second source cumulative ${key}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = inputWith(budget);
    let methods = 0, factories = 0, getters = 0, firstUsage = 0, receiver: any[];
    const restore = sourceSeam(budget, (e, list, factory, output, q) => {
      methods++; receiver = list;
      if (methods === 2) { expect(budget.usage()[key]).toBeGreaterThanOrEqual(firstUsage); consume(budget, key, ({ nodes: 4, slots: 7, structuralBytes: 156, work: 10 })[key] - 1); }
      output.sourceRecord(list, q, () => {
        factories++; const errors = e.errors; Object.defineProperty(e, 'errors', { get() { getters++; return errors; } }); return factory();
      });
      firstUsage = budget.usage()[key];
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { restore(); }
    expect(caught).toBeInstanceOf(BudgetExceededError); expect(methods).toBe(2); expect(factories).toBe(2); expect(getters).toBe(1); expect(receiver!).toHaveLength(1);
  });
});

describe('real same-owner category capacities and no refunds', () => {
  for (const category of ['source', 'diagnostic']) for (const prefill of [0, 1]) for (const quarantine of [false, true]) it(`synthetic ${category} cap-${prefill} quarantine=${quarantine}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), raw = seamInput();
    if (quarantine) (raw.sheets.tabs.Students.rows[0].cells as string[])[0] = '';
    const input = parseRegisteredBoundedJson(JSON.stringify(raw), budget) as Input;
    const output = realCreate(budget), scratch: number[] = [];
    const count = (category === 'source' ? 4000 : 8000) - prefill;
    for (let i = 0; i < count; i++) if (category === 'source') output.sourceRecord(scratch, false, () => i); else output.errorCode(scratch, () => i);
    let methods = 0, factories = 0, codes = 0, codeFactories = 0, firstQuarantine: boolean | undefined;
    const stop = new RangeError('second source');
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
      expect(context).toBe(budget);
      return { ...output, sourceRecord(list, q, factory) {
        methods++; firstQuarantine ??= q;
        if (category === 'diagnostic' && !quarantine && methods === 2) throw stop;
        output.sourceRecord(list, q, () => { factories++; return factory(); });
      }, errorCode(list, factory) { codes++; output.errorCode(list, () => { codeFactories++; return factory(); }); } };
    });
    let caught: unknown;
    try { run(input, budget); } catch (e) { caught = e; } finally { spy.mockRestore(); }
    expect(firstQuarantine).toBe(quarantine); expect(scratch).toHaveLength(count);
    if (category === 'diagnostic' && !quarantine) { expect(caught).toBe(stop); expect(factories).toBe(1); expect(codes).toBe(0); }
    else {
      expect(caught).toBeInstanceOf(BudgetExceededError);
      expect(factories).toBe(prefill);
      if (category === 'source') expect(methods).toBe(prefill + 1);
      else { expect(methods).toBe(1); expect(codes).toBe(prefill); expect(codeFactories).toBe(0); }
    }
  });
});
