import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as work from '@/lib/boundedWork';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
type Entry = { tab: string; source: unknown; errors: string[]; refs: unknown[]; canonical: unknown; targets: { record: unknown }[] };
type Dimension = 'nodes' | 'slots' | 'structuralBytes' | 'contentBytes' | 'work';
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/settings-construction-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; raw: unknown[] } }[]; constructorGetters: { name: string; fail: number; trace: number[]; json: string | null; errorIdentity: boolean }[] };
const fixture = (name = 'operational') => golden.cases.find(c => c.name === name)!;
const admitted = (b: BudgetContext, name = 'operational') => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: Dimension, amount: number) { const rest = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(rest); else b.reserve({ [dimension]: rest }); }
afterEach(() => vi.restoreAllMocks());
describe('frozen Git constructor bytes raw errors refs keys and aliases', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = b ? admitted(b, f.name) : structuredClone(f.input);
    const entries: Entry[] = [], seen = new Set<Entry>(), set = Map.prototype.set, push = Array.prototype.push;
    // Map-only observation misses Entries without grouping Targets. Mirror the
    // executed Git oracle: retain initial append identities until final serialization.
    function observe(e: Entry) {
      if (e && e.source && Array.isArray(e.errors) && !seen.has(e)) { seen.add(e); push.call(entries, e); }
    }
    let result: ReturnType<typeof run>;
    try {
      Map.prototype.set = function (key: unknown, value: unknown) {
        if (Array.isArray(value)) for (const e of value as Entry[]) observe(e);
        return set.call(this, key, value);
      };
      Array.prototype.push = function <T>(this: T[], ...items: T[]) {
        for (const e of items) observe(e as Entry);
        return push.apply(this, items);
      };
      result = run(input, b);
    } finally { Map.prototype.set = set; Array.prototype.push = push; }
    // Check every selected occurrence explicitly; parity must not pass vacuously
    // if a future observer or oracle drops these non-grouped Settings rows.
    const selectedRows = entries.filter(e => e.tab === 'Settings').map(e => (e.source as { rowNumber: number }).rowNumber).filter(row => row >= 50);
    expect(selectedRows).toEqual(f.name === 'duplicate' ? [50, 51] : [50]);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    expect(JSON.parse(JSON.stringify(entries.map(e => ({ tab: e.tab, source: e.source, errors: e.errors, refs: e.refs, canonical: e.canonical, targets: e.targets, aliases: e.targets.map(t => t.record === e.canonical) }))))).toEqual(f.outcome.raw);
    for (const e of entries) if (e.canonical) { expect(Object.isFrozen(e.canonical)).toBe(false); if (b) expect(() => assertRegisteredBoundedJson(e.canonical, b)).toThrow('Legacy bounded JSON is invalid.'); }

  });
  for (const f of golden.constructorGetters) it(`original no-context cell getters ${f.name} fail=${f.fail}`, () => {
    const input = structuredClone(fixture(f.name).input), cells = input.sheets.tabs.Settings.rows.at(-1)!.cells, trace: number[] = [], sentinel = new RangeError('constructor getter');
    for (let i = 0; i < 2; i++) { const value = cells[i]; Object.defineProperty(cells, i, { enumerable: true, configurable: true, get() { trace.push(i); if (i === f.fail) throw sentinel; return value; } }); }
    let result: ReturnType<typeof run> | undefined, error: unknown;
    try { result = run(input); } catch (e) { error = e; }
    expect(trace).toEqual(f.trace); expect(result ? JSON.stringify(result) : null).toBe(f.json); expect(error === sentinel).toBe(f.errorIdentity);
  });
});


describe('Settings reached native completion and original error identity', () => {
  for (const stage of ['predicate', 'hash', 'warning', 'target', 'entry', 'visit', 'collection', 'collection-has', 'financial', 'error', 'clone'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbounded'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
    const name = stage === 'hash' || stage === 'warning' ? 'omitted' : stage === 'financial' || stage === 'error' ? 'missing-key' : 'operational';
    let now = 0; const controller = new AbortController(), b = state === 'unbounded' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
    const input = b ? admitted(b, name) : structuredClone(fixture(name).input);
    const has = Set.prototype.has, add = Set.prototype.add, push = Array.prototype.push, each = Array.prototype.forEach, trim = String.prototype.trim, hash = validators.sha256, alloc = work.allocate;
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('Settings native');
    let selected = false, armed = 0, after = 0, error: unknown, targetList: unknown;
    function hit() { armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; }
    String.prototype.trim = function () { const result = trim.call(this); if (result === (name === 'omitted' ? 'secret-value' : name === 'missing-key' ? 'value' : 'title')) selected = true; return result; };
    Set.prototype.has = function (value: unknown) { const result = has.call(this, value); if (selected && !armed && ((stage === 'predicate' && this.size === 9 && value === 'appTitle') || (stage === 'financial' && this.size === 4 && value === 'Settings') || (stage === 'collection-has' && targetList && value === 'settings'))) hit(); return result; };
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (selected && value === 'secret-value') { if (armed) after++; const result = hash(value, owner); if (stage === 'hash' && !armed) hit(); return result; } return hash(value, owner); });
    vi.spyOn(work, 'allocate').mockImplementation((owner, recipe, factory) => alloc(owner, recipe, () => { const result = factory(); if (selected && stage === 'clone' && result && typeof result === 'object' && 'tenantId' in result && 'key' in result && result.key === 'appTitle') { Object.defineProperty(result, 'value', { enumerable: true, configurable: true, get() { if (!armed) hit(); return 'title'; } }); } return result; }));
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      const item = items[0] as { table?: string; tab?: string; source?: { rowNumber?: number }; targets?: unknown };
      const entry = item?.tab === 'Settings' && item?.source?.rowNumber === 50, target = selected && item?.table === 'settings', warning = selected && items[0] === 'SETTING_OMITTED', malformed = selected && items[0] === 'MALFORMED_REQUIRED_RECORD';
      if (selected && armed && (entry || target || warning || malformed)) after++;
      if (entry) targetList = item.targets;
      const result = push.apply(this, items);
      if (!armed && ((stage === 'entry' && entry) || (stage === 'target' && target) || (stage === 'warning' && warning) || (stage === 'error' && malformed))) hit();
      return result;
    };
    Array.prototype.forEach = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => void, thisArg?: unknown) { if (selected && this === targetList) { if (armed) after++; if (stage === 'visit' && !armed) hit(); } return each.call(this, callback, thisArg); };
    Set.prototype.add = function <T>(this: Set<T>, value: T) { if (selected && value === 'settings' && targetList) { if (armed) after++; const result = add.call(this, value); if (stage === 'collection' && !armed) hit(); return result; } return add.call(this, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Set.prototype.has = has; Set.prototype.add = add; Array.prototype.push = push; Array.prototype.forEach = each; String.prototype.trim = trim; }
    if ((stage === 'clone' || stage === 'collection-has') && !b) { expect(armed).toBe(0); expect(error).toBeUndefined(); return; }
    expect(armed).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state === 'expired' || state === 'aborted') { expect(error).toBeInstanceOf(BudgetUnavailableError); expect(after).toBe(0); }
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else expect(error).toBeUndefined();
  });
});

describe('Settings exact same-context capacity before operands', () => {
  for (const [name, bytes] of [['operational', 40], ['omitted', 46]] as const) for (const [dimension, cost] of [['nodes', 3], ['slots', 2], ['structuralBytes', bytes], ['work', 3]] as const) for (const delta of [-1, 0, 1]) it(`${name} canonical ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), has = Set.prototype.has, alloc = work.allocate, hash = validators.sha256, push = Array.prototype.push;
    const key = name === 'operational' ? 'appTitle' : 'private-key'; let armed = 0, reached = 0, error: unknown;
    Set.prototype.has = function (value: unknown) { const result = has.call(this, value); if (this.size === 9 && value === key) { armed++; leave(b, dimension, cost + delta); } return result; };
    vi.spyOn(work, 'allocate').mockImplementation((owner, recipe, factory) => alloc(owner, recipe, () => { if (armed && recipe.slots === 2 && recipe.structuralBytes === bytes) { expect(owner).toBe(b); reached++; throw new Error('canonical literal'); } return factory(); }));
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (armed && value === 'secret-value') { reached++; throw new Error('legacy hash operand'); } return hash(value, owner); });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as { table?: string })?.table === 'settings') { reached++; throw new Error('legacy Target'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Set.prototype.has = has; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 4], ['structuralBytes', 62], ['contentBytes', 12], ['work', 4]] as const) for (const delta of [-1, 0, 1]) it(`omitted hash frame ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'omitted'), has = Set.prototype.has, hash = validators.sha256; let armed = 0, reached = 0, error: unknown;
    Set.prototype.has = function (value: unknown) { const result = has.call(this, value); if (this.size === 9 && value === 'private-key') { armed++; leave(b, dimension, cost + delta); } return result; };
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (armed && value === 'secret-value') { reached++; if (owner) expect(owner).toBe(b); throw new Error('hash input'); } return hash(value, owner); });
    try { run(input, b); } catch (e) { error = e; } finally { Set.prototype.has = has; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 1], ['slots', 1], ['structuralBytes', 8], ['work', 1]] as const) for (const delta of [-1, 0, 1]) it(`warning destination ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'omitted'), hash = validators.sha256, push = Array.prototype.push; let armed = 0, reached = 0, error: unknown;
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { const result = hash(value, owner); if (value === 'secret-value') { armed++; leave(b, dimension, cost + delta); } return result; });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && items[0] === 'SETTING_OMITTED') { reached++; throw new Error('warning append'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 12], ['slots', 10], ['structuralBytes', 176], ['work', 12]] as const) for (const delta of [-1, 0, 1]) it(`Target staged clone shell destination ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), has = Set.prototype.has, alloc = work.allocate, push = Array.prototype.push; let selected = false, armed = 0, reached = 0, error: unknown;
    Set.prototype.has = function (value: unknown) { const result = has.call(this, value); if (this.size === 9 && value === 'appTitle') selected = true; return result; };
    vi.spyOn(work, 'allocate').mockImplementation((owner, recipe, factory) => { const result = alloc(owner, recipe, () => { if (armed && recipe.structuralBytes === 176) { expect(owner).toBe(b); reached++; throw new Error('staged literal'); } return factory(); }); if (selected && recipe.structuralBytes === 40 && !armed) { armed++; leave(b, dimension, cost + delta); } return result; });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (selected && !armed && (items[0] as { table?: string })?.table === 'settings') { armed++; reached++; throw new Error('legacy Target'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Set.prototype.has = has; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 1], ['slots', 1], ['structuralBytes', 8], ['work', 3]] as const) for (const delta of [-1, 0, 1]) it(`missing key malformed before predicate ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'missing-key'), trim = work.trimBudgetString, has = Set.prototype.has, hash = validators.sha256; let selected = false, armed = 0, reached = 0, error: unknown;
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { const result = hash(value, owner); if (value === 'a'.repeat(64) && owner === b) selected = true; return result; });
    vi.spyOn(work, 'trimBudgetString').mockImplementation((value, owner) => { const result = trim(value, owner); if (selected && value === 'value') { expect(owner).toBe(b); armed++; leave(b, dimension, cost + delta); } return result; });
    Set.prototype.has = function (value: unknown) { if (armed && this.size === 4 && value === 'Settings') { reached++; throw new Error('financial operand'); } return has.call(this, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Set.prototype.has = has; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`operational predicate work exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), trim = work.trimBudgetString, has = Set.prototype.has; let armed = 0, reached = 0, error: unknown;
    vi.spyOn(work, 'trimBudgetString').mockImplementation((value, owner) => { const result = trim(value, owner); if (value === 'title') { expect(owner).toBe(b); armed++; leave(b, 'work', 3 + delta); } return result; });
    Set.prototype.has = function (value: unknown) { if (armed && this.size === 9 && value === 'appTitle') { reached++; throw new Error('operational operand'); } return has.call(this, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Set.prototype.has = has; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('Settings native caller work and shared cell ownership', () => {
  for (const stage of ['entry', 'visit', 'collection'] as const) for (const delta of [-1, 0, 1]) it(`${stage} work exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, stage === 'entry' ? 'omitted' : 'operational'), push = Array.prototype.push, each = Array.prototype.forEach, add = Set.prototype.add, hash = validators.sha256;
    let selected = false, armed = 0, reached = 0, error: unknown, list: unknown;
    const cost = stage === 'collection' ? 6 : 1;
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { const result = hash(value, owner); if (value === 'secret-value') selected = true; return result; });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { const item = items[0] as { tab?: string; source?: { rowNumber?: number }; targets?: unknown }; const isEntry = item?.tab === 'Settings' && item.source?.rowNumber === 50;
      if (armed && stage === 'entry' && isEntry) { reached++; throw new Error('Entry operand'); }
      const result = push.apply(this, items);
      if (!armed && ((stage === 'entry' && selected && items[0] === 'SETTING_OMITTED') || (stage !== 'entry' && isEntry))) { list = item?.targets; armed++; leave(b, 'work', cost + delta); } return result;
    };
    Array.prototype.forEach = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => void, thisArg?: unknown) { if (armed && stage === 'visit' && this === list) { reached++; throw new Error('visit operand'); } return each.call(this, callback, thisArg); };
    Set.prototype.add = function <T>(this: Set<T>, value: T) { if (armed && stage === 'collection' && value === 'settings') { reached++; throw new Error('collection operand'); } return add.call(this, value); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; Array.prototype.forEach = each; Set.prototype.add = add; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('omitted hash gets identical request context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'omitted'), hash = validators.sha256; let reached = 0;
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { if (value === 'secret-value') { reached++; expect(owner).toBe(b); } return hash(value, owner); });
    run(input, b); expect(reached).toBe(1);
  });
  for (const name of ['key', 'value'] as const) for (const dimension of ['nodes', 'structuralBytes', 'contentBytes', 'work'] as const) it(`${name} cell refuses before string/trim ${dimension}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b), hash = validators.sha256, get = Map.prototype.get, trim = String.prototype.trim;
    let selected = false, armed = 0, reached = 0, error: unknown;
    vi.spyOn(validators, 'sha256').mockImplementation((value, owner) => { const result = hash(value, owner); if (value === 'appTitle' && owner === b) selected = true; return result; });
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (selected && !armed && key === name) { armed++; leave(b, dimension, 0); } return result; };
    String.prototype.trim = function () { if (armed) reached++; return trim.call(this); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; String.prototype.trim = trim; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});
