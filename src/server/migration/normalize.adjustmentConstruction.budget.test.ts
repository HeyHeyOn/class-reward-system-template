import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as work from '@/lib/boundedWork';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
type Entry = { tab: string; source: unknown; errors: string[]; refs: unknown[]; canonical: unknown; targets: { record: unknown }[] };
type Dimension = 'nodes' | 'slots' | 'structuralBytes' | 'contentBytes' | 'work';
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/adjustment-construction-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; raw: unknown[] } }[]; constructorGetters: { fail: number; trace: number[]; json: string | null; errorIdentity: boolean }[] };
const fixture = (name = 'accepted') => golden.cases.find(c => c.name === name)!;
const admitted = (b: BudgetContext, name = 'accepted') => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: Dimension, amount: number) { const rest = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(rest); else b.reserve({ [dimension]: rest }); }
function isModes(value: unknown): boolean { return Array.isArray(value) && value.length === 3 && value[0] === 'add' && value[1] === 'subtract' && value[2] === 'set'; }
afterEach(() => vi.restoreAllMocks());

describe('malformed constructor native predicate and occurrence completion', () => {
  for (const stage of ['predicate', 'append'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController(), b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b, 'bad-mode') : structuredClone(fixture('bad-mode').input), includes = Array.prototype.includes, push = Array.prototype.push, has = Set.prototype.has;
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('malformed native');
    let selected = false, armed = 0, after = 0, error: unknown;
    function hit() { armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; }
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (isModes(this)) selected = true; return result; };
    Set.prototype.has = function (value: unknown) { const result = has.call(this, value); if (selected && !armed && stage === 'predicate' && value === 'Adjustments') hit(); return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (selected && armed && (items[0] === 'MALFORMED_REQUIRED_HISTORY' || (items[0] as Entry)?.tab === 'Adjustments')) after++; const result = push.apply(this, items); if (selected && !armed && stage === 'append' && items[0] === 'MALFORMED_REQUIRED_HISTORY') hit(); return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Array.prototype.push = push; Set.prototype.has = has; }
    expect(armed).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(after).toBe(0); }
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else expect(error).toBeUndefined();
  });
});

describe('actual operator hash native update completion', () => {
  for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController(), b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b) : structuredClone(fixture().input), includes = Array.prototype.includes;
    const proto = Object.getPrototypeOf(createHash('sha256')), update = Object.getOwnPropertyDescriptor(proto, 'update')!, digest = Object.getOwnPropertyDescriptor(proto, 'digest')!;
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('hash update');
    let selected = false, armed = 0, after = 0, error: unknown; const chosen = new WeakSet<object>();
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (isModes(this)) selected = true; return result; };
    Object.defineProperty(proto, 'update', { ...update, value: function (this: unknown, ...args: unknown[]) { const result = Reflect.apply(update.value, this, args); if (selected && !armed && args[0] === 'admin') { chosen.add(this as object); armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; } return result; } });
    Object.defineProperty(proto, 'digest', { ...digest, value: function (this: unknown, ...args: unknown[]) { if (armed && chosen.has(this as object)) after++; return Reflect.apply(digest.value, this, args); } });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Object.defineProperty(proto, 'update', update); Object.defineProperty(proto, 'digest', digest); }
    expect(armed).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(after).toBe(0); }
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else { expect(error).toBeUndefined(); expect(after).toBe(1); }
  });
});

describe('frozen Git constructor bytes raw errors refs keys and aliases', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const entries: Entry[] = [], seen = new Set<Entry>(), set = Map.prototype.set;
    Map.prototype.set = function (key: unknown, value: unknown) {
      if (Array.isArray(value)) for (const e of value as Entry[]) if (e && e.source && Array.isArray(e.errors) && !seen.has(e)) { seen.add(e); entries.push(e); }
      return set.call(this, key, value);
    };
    let result: ReturnType<typeof run>;
    try { result = run(b ? admitted(b, f.name) : structuredClone(f.input), b); } finally { Map.prototype.set = set; }
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    expect(JSON.parse(JSON.stringify(entries.map(e => ({ tab: e.tab, source: e.source, errors: e.errors, refs: e.refs, canonical: e.canonical, targets: e.targets, aliases: e.targets.map(t => t.record === e.canonical) }))))).toEqual(f.outcome.raw);
    for (const e of entries) if (e.canonical) { expect(Object.isFrozen(e.canonical)).toBe(false); if (b) expect(() => assertRegisteredBoundedJson(e.canonical, b)).toThrow(); }
    if (['accepted', 'subtract', 'set', 'unicode'].includes(f.name)) expect(result.records.adjustments).toHaveLength(1);
  });
  for (const f of golden.constructorGetters) it(`original no-context cell getters fail=${f.fail}`, () => {
    const input = structuredClone(fixture().input), cells = input.sheets.tabs.Adjustments.rows[0].cells, trace: number[] = [], sentinel = new RangeError('constructor getter');
    for (let i = 0; i < 6; i++) { const value = cells[i]; Object.defineProperty(cells, i, { enumerable: true, configurable: true, get() { trace.push(i); if (i === f.fail) throw sentinel; return value; } }); }
    let result: ReturnType<typeof run> | undefined, error: unknown;
    try { result = run(input); } catch (e) { error = e; }
    expect(trace).toEqual(f.trace); expect(result ? JSON.stringify(result) : null).toBe(f.json); expect(error === sentinel).toBe(f.errorIdentity);
  });
});

describe('reached constructor allocation and work reservations', () => {
  for (const [dimension, cost] of [['nodes', 4], ['slots', 3], ['structuralBytes', 40], ['work', 9]] as const) for (const delta of [-1, 0, 1]) it(`mode literal ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), get = Map.prototype.get, trim = work.trimBudgetString, includes = Array.prototype.includes;
    let mode = false, armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { if (key === 'mode') mode = true; return get.call(this, key); };
    vi.spyOn(work, 'trimBudgetString').mockImplementation((value, owner) => { const result = trim(value, owner); if (mode && value === 'admin' && !armed) { expect(owner).toBe(b); armed++; leave(b, dimension, cost + delta); } return result; });
    Array.prototype.includes = function (value: unknown, from?: number) { if (isModes(this)) { reached++; throw new Error('mode operand'); } return includes.call(this, value, from); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.includes = includes; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 8], ['slots', 7], ['structuralBytes', 134], ['work', 8]] as const) for (const delta of [-1, 0, 1]) it(`canonical shell ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), includes = Array.prototype.includes, allocate = work.allocate;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (isModes(this)) { armed++; leave(b, dimension, cost + delta); } return result; };
    vi.spyOn(work, 'allocate').mockImplementation((owner, recipe, factory) => allocate(owner, recipe, () => { if (armed && recipe.slots === 7 && recipe.structuralBytes === 134) { reached++; throw new Error('canonical factory'); } return factory(); }));
    const hash = validators.sha256;
    // Baseline has no factory: observe its actual unguarded hash too.
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (armed && value === 'admin') { reached++; throw new Error('canonical legacy operand'); } return hash(value, owner); });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 4], ['slots', 4], ['structuralBytes', 55], ['work', 4]] as const) for (const delta of [-1, 0, 1]) it(`student Ref plus destination ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), hash = validators.sha256, includes = Array.prototype.includes, push = Array.prototype.push;
    let selected = false, armed = 0, reached = 0, error: unknown;
    Array.prototype.includes = function (value: unknown, from?: number) { if (isModes(this)) selected = true; return includes.call(this, value, from); };
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { const result = hash(value, owner); if (selected && value === 'admin' && !armed) { armed++; leave(b, dimension, cost + delta); } return result; });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as { code?: string })?.code === 'BROKEN_STUDENT_REFERENCE') { reached++; throw new Error('Ref append'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 1], ['slots', 1], ['structuralBytes', 8], ['work', 2]] as const) for (const delta of [-1, 0, 1]) it(`malformed destination ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'bad-mode'), includes = Array.prototype.includes, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (isModes(this)) { armed++; leave(b, dimension, cost + delta); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'MALFORMED_REQUIRED_HISTORY') { reached++; throw new Error('malformed append'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`Entry append work exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), push = Array.prototype.push, includes = Array.prototype.includes;
    let selected = false, armed = 0, reached = 0, error: unknown;
    Array.prototype.includes = function (value: unknown, from?: number) { if (isModes(this)) selected = true; return includes.call(this, value, from); };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { const item = items[0] as { code?: string; tab?: string }; if (armed && item?.tab === 'Adjustments') { reached++; throw new Error('Entry append'); } const result = push.apply(this, items); if (selected && !armed && item?.code === 'BROKEN_STUDENT_REFERENCE') { armed++; leave(b, 'work', 1 + delta); } return result; };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('hash input frame admission before encoder evaluation', () => {
  for (const [dimension, cost] of [['nodes', 9], ['structuralBytes', 150], ['contentBytes', 5], ['work', 9]] as const) for (const delta of [-1, 0, 1]) it(`${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), includes = Array.prototype.includes, hash = validators.sha256;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (isModes(this)) { armed++; leave(b, dimension, cost + delta); } return result; };
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (armed && value === 'admin') { reached++; throw new Error('hash encoder input'); } return hash(value, owner); });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('initial required scalar operands use the same cumulative context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), hash = validators.sha256, id = validators.canonicalId, instant = validators.canonicalInstant, integer = validators.safeInteger;
    let armed = false; const trace: string[] = [];
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { const result = hash(value, owner); if (value === 'ADJ1' && owner === b) armed = true; return result; });
    vi.spyOn(validators, 'canonicalId').mockImplementation((value, owner) => { if (armed && (value === 'ADJ1' || value === 'S1')) { trace.push(String(value)); expect(owner).toBe(b); } return id(value, owner); });
    vi.spyOn(validators, 'canonicalInstant').mockImplementation((value, owner) => { if (armed) { trace.push('timestamp'); expect(owner).toBe(b); } return instant(value, owner); });
    vi.spyOn(validators, 'safeInteger').mockImplementation((value, limits, owner) => { if (armed) { trace.push('amount'); expect(owner).toBe(b); armed = false; } return integer(value, limits, owner); });
    run(input, b); expect(trace).toEqual(['ADJ1', 'timestamp', 'S1', 'amount']);
  });
});

describe('constructor native completion and first budget-error identity', () => {
  for (const stage of ['mode', 'hash', 'ref', 'entry'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController(), b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b) : structuredClone(fixture().input), includes = Array.prototype.includes, push = Array.prototype.push, hash = validators.sha256;
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('constructor native');
    let selected = false, armed = 0, after = 0, error: unknown;
    let entryTargets: unknown;
    const forEach = Array.prototype.forEach;
    Array.prototype.forEach = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => void, thisArg?: unknown) { if (stage === 'entry' && armed && this === entryTargets) after++; return forEach.call(this, callback, thisArg); };
    function hit() { armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; }
    Array.prototype.includes = function (value: unknown, from?: number) { const result = includes.call(this, value, from); if (isModes(this)) { selected = true; if (stage === 'mode') hit(); } return result; };
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (selected && value === 'admin') { if (armed) after++; if (stage === 'hash') { const result = hash(value, owner); hit(); return result; } } return hash(value, owner); });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      const item = items[0] as { code?: string; tab?: string };
      const ref = selected && item?.code === 'BROKEN_STUDENT_REFERENCE', entry = item?.tab === 'Adjustments';
      if (entry) entryTargets = (item as unknown as Entry).targets;
      if ((ref || entry) && armed) after++;
      if ((stage === 'ref' && ref && !armed) || (stage === 'entry' && entry && !armed)) { const result = push.apply(this, items); hit(); return result; }
      return push.apply(this, items);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.includes = includes; Array.prototype.push = push; Array.prototype.forEach = forEach; }
    expect(armed).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(after).toBe(0); }
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else expect(error).toBeUndefined();
  });
  it('operator hash receives the original cumulative context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), includes = Array.prototype.includes, hash = validators.sha256;
    let selected = false, reached = 0;
    Array.prototype.includes = function (value: unknown, from?: number) { if (isModes(this)) selected = true; return includes.call(this, value, from); };
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (selected && value === 'admin') { reached++; expect(owner).toBe(b); } return hash(value, owner); });
    try { run(input, b); } finally { Array.prototype.includes = includes; }
    expect(reached).toBe(1);
  });
});
