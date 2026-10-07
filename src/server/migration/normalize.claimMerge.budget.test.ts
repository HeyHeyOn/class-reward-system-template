/* Native-hook tests retain actual receiver identities to distinguish local and outer ownership. */
/* eslint-disable @typescript-eslint/no-this-alias */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as work from '@/lib/boundedWork';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
type Entry = { tab: string; source: Record<string, unknown>; errors: string[]; refs: unknown[]; canonical?: Record<string, unknown>; targets: { record: unknown }[] };
type Bundle = { entries: Entry[]; conflicts: unknown[]; collections: Set<string> };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/claim-merge-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; raw: unknown[]; received: number[]; union: { names: unknown[]; before: unknown[] | null; after: unknown[] | null }[]; counts: Record<string, number> } }[]; getters: { hooked: boolean; fail: boolean; trace: string[]; json: string | null; errorIdentity: boolean }[] };
const fixture = (name = 'redis-duplicate-1') => golden.cases.find(c => c.name === name)!;
const inputFor = (b?: BudgetContext, name?: string) => b ? parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input : structuredClone(fixture(name).input);
function leave(b: BudgetContext, dimension: 'work' | 'slots' | 'structuralBytes', amount: number) {
  const remaining = b.limits[dimension] - b.usage()[dimension] - amount;
  if (dimension === 'work') b.spend(remaining); else b.reserve({ [dimension]: remaining });
}
function shell(b: BudgetContext | undefined, callback: (bundle: Bundle) => void, onAllocation?: () => void) {
  const allocate = work.allocate;
  return vi.spyOn(work, 'allocate').mockImplementation((context, cost, factory) => {
    onAllocation?.();
    const result = allocate(context, cost, factory);
    if (context === b && result && typeof result === 'object' && Object.keys(result).join(',') === 'entries,conflicts,collections') callback(result as Bundle);
    return result;
  });
}
afterEach(() => vi.restoreAllMocks());

describe('original Git natural claim receiving parity', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined, input = inputFor(b, f.name);
    const push = Array.prototype.push, set = Map.prototype.set, entries: Entry[] = [], received: Entry[] = [], seen = new Set<Entry>();
    let outer: unknown, activeUnion: Set<unknown> | undefined, unionOuter: Set<unknown> | undefined;
    const each = Set.prototype.forEach, add = Set.prototype.add, union: typeof f.outcome.union = [];
    const observe = (e: unknown) => { const entry = e as Entry; if (entry?.source && Array.isArray(entry.errors) && Array.isArray(entry.targets) && !seen.has(entry)) { seen.add(entry); push.call(entries, entry); } };
    let result: ReturnType<typeof run>;
    try {
      Set.prototype.forEach = function (callback, thisArg) {
        if (new Error().stack?.includes('targetIndexNames')) return each.call(this, callback, thisArg);
        const observation = { names: [...this], before: null as unknown[] | null, after: null as unknown[] | null }; push.call(union, observation); activeUnion = this;
        try { return each.call(this, callback, thisArg); } finally { observation.after = unionOuter ? [...unionOuter] : null; activeUnion = undefined; unionOuter = undefined; }
      };
      Set.prototype.add = function (name: unknown) { if (activeUnion && this !== activeUnion && !unionOuter) { unionOuter = this; union[union.length - 1].before = [...this]; } return add.call(this, name); };
      Array.prototype.push = function <T>(this: T[], ...items: T[]) { for (const e of items) observe(e); const first = items[0] as Entry; if (!outer && first?.source?.kind === 'SHEET' && Array.isArray(first.targets)) outer = this; if (this === outer) for (const e of items) push.call(received, e as Entry); return push.apply(this, items); };
      Map.prototype.set = function (key: unknown, value: unknown) { if (Array.isArray(value)) for (const e of value) observe(e); return set.call(this, key, value); };
      result = run(input, b);
    } finally { Array.prototype.push = push; Map.prototype.set = set; Set.prototype.forEach = each; Set.prototype.add = add; }
    expect(union).toEqual(f.outcome.union);
    expect(union).toHaveLength(1);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    expect(entries.length).toBe(f.outcome.raw.length);
    expect(received.map(e => entries.indexOf(e))).toEqual(f.outcome.received);
    expect(entries.map(e => ({ canonicalOwner: e.canonical ? entries.findIndex(other => other.canonical === e.canonical) : null, tab: e.tab, source: e.source, errors: e.errors, refs: e.refs, canonical: e.canonical, targets: e.targets, aliases: e.targets.map(t => t.record === e.canonical) }))).toEqual(f.outcome.raw);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    for (const entry of entries) if (entry.canonical) expect(Object.isFrozen(entry.canonical)).toBe(false);
    for (const [tab, snapshot] of Object.entries(input.sheets.tabs)) for (const row of snapshot.rows) expect(entries.some(e => e.source.kind === 'SHEET' && e.source.tab === tab && e.source.rowNumber === row.rowNumber)).toBe(true);
    if (f.name.startsWith('agreeing-')) { const claims = entries.filter(e => e.tab === 'SheetPadletClaim' || e.tab === 'RedisPadletClaim'); expect(claims).toHaveLength(2); expect(claims[0].canonical).toBe(claims[1].canonical); expect(result.records.padlet_evidence_claims).toHaveLength(0); }
    if (f.name === 'v1-only') expect(result.records.padlet_claim_digest_tombstones).toHaveLength(1);
    if (f.name === 'redis-duplicate-1') {
      expect(result.records.padlet_evidence_claims).toHaveLength(1); expect(result.records.legacy_operation_bindings).toHaveLength(1);
      expect(entries.filter(e => e.source.kind === 'REDIS').map(e => e.source.provenance)).toEqual(['upstash:padlet:evidence-bindings:v2', 'upstash:padlet:evidence-bindings:v2']);
    }
  });
});

describe('receiver admission at actual claim return-shell exit', () => {
  for (const dimension of ['slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`before source element ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b, 'orphan-only');
    let armed = 0, read = 0, length = -1, error: unknown;
    shell(b, bundle => { armed++; length = bundle.entries.length; leave(b, dimension, { slots: 1, structuralBytes: 4, work: 3 }[dimension] + delta); Object.defineProperty(bundle.entries, 0, { get() { read++; throw stop; }, configurable: true }); });
    const stop = new RangeError('source operand');
    try { run(input, b); } catch (e) { error = e; }
    expect(armed).toBe(1); expect(length).toBe(1); expect(read).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  it('claim-local slots do not admit the distinct outer destination or second operand', () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b), push = Array.prototype.push;
    let bundle: Bundle | undefined, read = 0, appended = 0, error: unknown;
    shell(b, value => { bundle = value; const second = value.entries[1]; Object.defineProperty(value.entries, 1, { get() { read++; return second; }, configurable: true }); });
    try {
      Array.prototype.push = function <T>(this: T[], ...items: T[]) { const selected = bundle && this !== bundle.entries && items[0] === bundle.entries[0]; const result = push.apply(this, items); if (selected) { appended++; leave(b, 'slots', 0); } return result; };
      run(input, b);
    } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(bundle!.entries.length).toBeGreaterThan(1); expect(appended).toBe(1); expect(read).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const name of ['no-redis', 'redis-empty']) it(`empty entry traversal work ${name}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b, name); let armed = 0, successor = 0, length = -1;
    shell(b, value => { armed++; length = value.entries.length; leave(b, 'work', 0); Object.defineProperty(value, 'conflicts', { get() { successor++; return []; } }); });
    expect(() => run(input, b)).toThrow(BudgetExceededError); expect(armed).toBe(1); expect(length).toBe(0); expect(successor).toBe(0);
  });
});

describe('selected receiving native exits', () => {
  for (const stage of ['push', 'empty-conflicts', 'forEach', 'has-true', 'has-false', 'add'] as const)
    for (const state of ['timely', 'expired', 'aborted', 'no-budget'] as const)
      for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
        let now = 0, successor = 0, fired = false;
        const controller = new AbortController(), owner = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
        // Delegate to one real owner; observe even a successor debit/reservation,
        // which could otherwise mask a missing immediate native completion check.
        const b: BudgetContext | undefined = owner ? { ...owner,
          spend(amount) { if (fired) successor++; owner.spend(amount); },
          reserve(cost) { if (fired) successor++; owner.reserve(cost); },
        } : undefined;
        const input = inputFor(b), push = Array.prototype.push, each = Set.prototype.forEach, has = Set.prototype.has, add = Set.prototype.add;
        let bundle: Bundle | undefined, outer: Set<unknown> | undefined, reached = 0, error: unknown;
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('selected native');
        shell(b, value => { bundle = value; }, () => { if (fired) successor++; });
        const trigger = () => { reached++; fired = true; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; };
        try {
          Array.prototype.push = function <T>(this: T[], ...items: T[]) {
            if (bundle && this !== bundle.entries && items[0] === bundle.entries[0]) { if (fired) successor++; if (stage === 'push' && !fired) { const value = push.apply(this, items); trigger(); return value; } }
            if (bundle && items.length === 0 && stage === 'empty-conflicts' && !fired) { const value = push.apply(this, items); trigger(); return value; }
            return push.apply(this, items);
          };
          Set.prototype.forEach = function (callback, thisArg) {
            if (this === bundle?.collections) { if (fired) successor++; if (stage === 'forEach' && !fired) { const value = each.call(this, callback, thisArg); trigger(); return value; } }
            return each.call(this, callback, thisArg);
          };
          Set.prototype.has = function (key: unknown) {
            if (bundle && this !== bundle.collections && bundle.collections.size > 0 && has.call(bundle.collections, key) && !fired && stage.startsWith('has-')) { outer = this; trigger(); return stage === 'has-true'; }
            return has.call(this, key);
          };
          Set.prototype.add = function (key: unknown) {
            if (fired && this === outer) successor++;
            if (bundle && this !== bundle.collections && has.call(bundle.collections, key) && stage === 'add' && !fired) { outer = this; const value = add.call(this, key); trigger(); return value; }
            return add.call(this, key);
          };
          run(input, b);
        } catch (e) { error = e; } finally { Array.prototype.push = push; Set.prototype.forEach = each; Set.prototype.has = has; Set.prototype.add = add; }
        // The original contextless expression does not call has: no synthetic claim of reachability.
        if (state === 'no-budget' && stage.startsWith('has-')) { expect(reached).toBe(0); return; }
        expect(reached).toBe(1);
        if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
        else if (state === 'expired' || state === 'aborted') expect(error).toBeInstanceOf(BudgetUnavailableError);
        else if (exit === 'ordinary') expect(error).toBe(sentinel);
        else expect(error).toBeUndefined();
        if (b && (state !== 'timely' || exit !== 'success')) expect(successor).toBe(0);
      });
});

describe('empty receiving phases have independent fixed costs', () => {
  for (const stage of ['conflicts', 'collections'] as const) for (const dimension of ['work', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`${stage} ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b, 'no-redis'), push = Array.prototype.push, each = Set.prototype.forEach;
    let armed = 0, reached = 0, bundle: Bundle | undefined, error: unknown;
    const stop = new RangeError('empty native operand');
    shell(b, value => {
      bundle = value;
      const conflicts = value.conflicts, collections = value.collections;
      Object.defineProperty(value, stage, { get() {
        if (!armed) { armed++; leave(b, dimension, (stage === 'conflicts' ? { work: 1, slots: 0, structuralBytes: 16 } : { work: 1, slots: 0, structuralBytes: 0 })[dimension] + Math.max(delta, dimension === 'slots' || (stage === 'collections' && dimension === 'structuralBytes') ? 0 : -1)); }
        return stage === 'conflicts' ? conflicts : collections;
      } });
    });
    try {
      Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && stage === 'conflicts' && items.length === 0) { reached++; throw stop; } return push.apply(this, items); };
      Set.prototype.forEach = function (callback, thisArg) { if (armed && stage === 'collections' && this === bundle?.collections) { reached++; throw stop; } return each.call(this, callback, thisArg); };
      run(input, b);
    } catch (e) { error = e; } finally { Array.prototype.push = push; Set.prototype.forEach = each; }
    const refused = delta < 0 && (dimension === 'work' || (dimension === 'structuralBytes' && stage === 'conflicts'));
    expect(armed).toBe(1); expect(reached).toBe(refused ? 0 : 1); if (refused) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('synthetic future raw-conflict operand (not natural claim business output)', () => {
  for (const dimension of ['slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`bulk pre-operand ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b, 'no-redis'); let armed = 0, read = 0, error: unknown;
    const stop = new RangeError('synthetic conflict getter');
    shell(b, value => { const conflicts = [{ code: 'SYNTHETIC', path: 'helper', sourceDigest: 'test' }]; Object.defineProperty(conflicts, 0, { get() { read++; throw stop; } }); Object.defineProperty(value, 'conflicts', { get() { if (!armed) { armed++; leave(b, dimension, { slots: 3, structuralBytes: 60, work: 2 }[dimension] + delta); } return conflicts; } }); });
    try { run(input, b); } catch (e) { error = e; }
    expect(armed).toBe(1); expect(read).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const guarded of [false, true]) it(`legacy whole-batch 4096 rejection ordering guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined, input = inputFor(b, 'no-redis'), push = Array.prototype.push;
    let read = 0, appended = 0, error: unknown;
    const item = { code: 'SYNTHETIC', path: 'helper', sourceDigest: 'test' };
    shell(b, value => { const conflicts = Array.from({ length: 4097 }, () => item); Object.defineProperty(conflicts, 4096, { get() { read++; return item; } }); value.conflicts = conflicts; });
    try { Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (items[0] === item) appended++; return push.apply(this, items); }; run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(read).toBe(1); expect(appended).toBe(0); expect((error as Error).message).toBe('Legacy migration output exceeds normalization bounds.');
  });
});

describe('collection callback destination and name work are caller-owned', () => {
  for (const present of [false, true]) for (const dimension of ['slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`present=${present} ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b), each = Set.prototype.forEach, has = Set.prototype.has, add = Set.prototype.add;
    let bundle: Bundle | undefined, armed = 0, reached = 0, error: unknown;
    const stop = new RangeError('outer add'); let selected: unknown;
    shell(b, value => { bundle = value; });
    try {
      Set.prototype.forEach = function (callback, thisArg) {
        if (this === bundle?.collections) return each.call(this, (name, key, owner) => { if (!armed) { armed++; selected = name; const cost = dimension === 'work' ? 1 + 2 * (1 + Math.ceil(String(name).length / 256)) : present ? 0 : dimension === 'slots' ? 1 : 4; leave(b, dimension, cost + (cost === 0 ? Math.max(0, delta) : delta)); } return callback.call(thisArg, name, key, owner); });
        return each.call(this, callback, thisArg);
      };
      Set.prototype.has = function (key: unknown) { if (armed && key === selected && this !== bundle?.collections) return present; return has.call(this, key); };
      Set.prototype.add = function (key: unknown) { if (armed && key === selected && this !== bundle?.collections) { reached++; throw stop; } return add.call(this, key); };
      run(input, b);
    } catch (e) { error = e; } finally { Set.prototype.forEach = each; Set.prototype.has = has; Set.prototype.add = add; }
    const refused = delta < 0 && (dimension === 'work' || !present);
    expect(armed).toBe(1); expect(reached).toBe(refused ? 0 : 1); if (refused) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

it('same request owner accumulates receiving cost without reset or refund', () => {
  const b = createBudgetContext({ now: () => 0 }), input = inputFor(b); const start = b.usage(); run(input, b); const middle = b.usage(); run(input, b); const end = b.usage();
  for (const dimension of ['work', 'slots', 'nodes', 'structuralBytes', 'contentBytes'] as const) { expect(middle[dimension]).toBeGreaterThan(start[dimension]); expect(end[dimension] - middle[dimension]).toBe(middle[dimension] - start[dimension]); }
});

describe('receiving source-element exits before native append', () => {
  for (const state of ['timely', 'expired', 'aborted', 'no-budget'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController(), b = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal }), input = inputFor(b, 'orphan-only'), push = Array.prototype.push;
    let reached = 0, appended = 0, error: unknown, entry: Entry | undefined, local: Entry[] | undefined, receiver: unknown;
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('element getter');
    shell(b, bundle => { local = bundle.entries; entry = bundle.entries[0]; Object.defineProperty(local, 0, { get() { reached++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; return entry; } }); });
    try { Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (entry && this !== local && items[0] === entry) { receiver ??= this; if (this === receiver) appended++; } return push.apply(this, items); }; run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(reached).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel); else if (b && state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError); else if (exit === 'ordinary') expect(error).toBe(sentinel); else expect(error).toBeUndefined();
    expect(appended).toBe(exit === 'success' && (!b || state === 'timely') ? 1 : 0);
  });
});

describe('original Redis getter traces with actually enabled raw hooks', () => {
  for (const expected of golden.getters) it(`hooked=${expected.hooked} fail=${expected.fail}`, () => {
    const input = inputFor(), digest = input.redis!.digest, trace: string[] = [], stop = new RangeError('digest getter'), push = Array.prototype.push, set = Map.prototype.set;
    const seen = new Set<unknown>(), entries: unknown[] = []; let result: ReturnType<typeof run> | undefined, error: unknown;
    const observe = (e: unknown) => { const entry = e as Entry; if (entry?.source && Array.isArray(entry.errors) && Array.isArray(entry.targets) && !seen.has(entry)) { seen.add(entry); push.call(entries, entry); } };
    Object.defineProperty(input.redis, 'digest', { enumerable: true, get() { push.call(trace, 'redis.digest'); if (expected.fail) throw stop; return digest; } });
    try {
      if (expected.hooked) { Array.prototype.push = function <T>(this: T[], ...items: T[]) { for (const e of items) observe(e); return push.apply(this, items); }; Map.prototype.set = function (key: unknown, value: unknown) { if (Array.isArray(value)) for (const e of value) observe(e); return set.call(this, key, value); }; }
      result = run(input);
    } catch (e) { error = e; } finally { Array.prototype.push = push; Map.prototype.set = set; }
    expect(trace).toEqual(expected.trace); expect(result ? JSON.stringify(result) : null).toBe(expected.json); expect(error === stop).toBe(expected.errorIdentity);
    if (expected.hooked) expect(entries.length).toBeGreaterThan(0);
  });
});
