/* Native observers keep real receiver identities and restore before assertions. */
/* eslint-disable @typescript-eslint/no-this-alias */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext, type BudgetUsage } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
type Target = { table: string; record: unknown };
type Entry = { tab: string; source: { kind: string; tab: string; rowNumber: number }; errors: string[]; refs: unknown[]; canonical: Record<string, unknown> | null; targets: Target[] };
type Outcome = { json: string; raw: unknown[]; received: number[]; callbacks: { row: number; table: string }[]; targetAdds: { row: number; table: string }[]; collections: string[]; nullPrototype: boolean; counts: Record<string, number> };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/row-handoff-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: Outcome }[]; getters: { probe: string; hooked: boolean; trace: string[]; errorIdentity: boolean }[] };
const fixture = (name = 'supported-v3') => golden.cases.find(c => c.name === name)!;
const inputFor = (b?: BudgetContext, name?: string) => b ? parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input : structuredClone(fixture(name).input);
function leave(b: BudgetContext, dimension: 'work' | 'slots' | 'structuralBytes', amount: number) {
  const remaining = b.limits[dimension] - b.usage()[dimension] - amount;
  if (dimension === 'work') b.spend(remaining); else b.reserve({ [dimension]: remaining });
}
afterEach(() => vi.restoreAllMocks());

describe('executed original Git row multiplicity, callbacks and public aliases', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined, input = inputFor(b, f.name);
    const push = Array.prototype.push, set = Map.prototype.set, each = Array.prototype.forEach, add = Set.prototype.add;
    const entries: Entry[] = [], received: Entry[] = [], callbacks: Outcome['callbacks'] = [], targetAdds: Outcome['targetAdds'] = [], seen = new Set<Entry>();
    let outer: unknown, collections: Set<string> | undefined, active: Entry | undefined, result: ReturnType<typeof run>;
    const remember = (value: unknown) => { const e = value as Entry; if (e?.source && Array.isArray(e.errors) && Array.isArray(e.targets) && !seen.has(e)) { seen.add(e); push.call(entries, e); } };
    try {
      Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (!outer && e?.source?.kind === 'SHEET' && Array.isArray(e.targets)) outer = this; if (this === outer) for (const item of items) { remember(item); push.call(received, item as Entry); } else for (const item of items) remember(item); return push.apply(this, items); };
      Map.prototype.set = function (key: unknown, value: unknown) { if (Array.isArray(value)) for (const e of value) remember(e); return set.call(this, key, value); };
      Array.prototype.forEach = function (callback, thisArg) { const e = entries.find(e => e.targets === this); if (e) { active = e; try { return each.call(this, (t: Target, i, a) => { push.call(callbacks, { row: entries.indexOf(e), table: t.table }); return callback.call(thisArg, t, i, a); }); } finally { active = undefined; } } return each.call(this, callback, thisArg); };
      Set.prototype.add = function (key: string) { if (active) { if (!collections) collections = this; push.call(targetAdds, { row: entries.indexOf(active), table: key }); } return add.call(this, key); };
      result = run(input, b);
    } finally { Array.prototype.push = push; Map.prototype.set = set; Array.prototype.forEach = each; Set.prototype.add = add; }
    // Before final JSON: dedup must not conceal lost/duplicated received occurrences.
    expect(received.map(e => entries.indexOf(e))).toEqual(f.outcome.received);
    expect(callbacks).toEqual(f.outcome.callbacks);
    expect(targetAdds).toEqual(f.outcome.targetAdds);
    expect(entries.map(e => ({ canonicalOwner: e.canonical ? entries.findIndex(other => other.canonical === e.canonical) : null, tab: e.tab, source: e.source, errors: e.errors, refs: e.refs, canonical: e.canonical, targets: e.targets, aliases: e.targets.map(t => t.record === e.canonical) }))).toEqual(f.outcome.raw);
    expect(collections ? [...collections] : []).toEqual(f.outcome.collections);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    for (const [tab, snapshot] of Object.entries(input.sheets.tabs)) for (const row of snapshot.rows) expect(entries.some(e => e.source.kind === 'SHEET' && e.source.tab === tab && e.source.rowNumber === row.rowNumber)).toBe(true);
    for (const e of entries) if (e.canonical) expect(Object.isFrozen(e.canonical)).toBe(false);
    if (f.name === 'supported-v3') for (const table of ['students', 'accounts', 'products', 'transactions', 'transaction_items', 'tasks', 'task_allowed_students', 'task_assignments', 'task_completions', 'promotions', 'promotion_products']) expect(result.records[table].length).toBeGreaterThan(0);
    if (f.name === 'BANK-quarantine') expect(result.records.task_completions).toHaveLength(0);
    if (['bad-header', 'malformed-id', 'unknown'].includes(f.name)) expect(entries.some(e => e.tab !== 'Settings' && e.targets.length === 0)).toBe(true);
  });
});

describe('original actually hooked/unhooked ordinary getter and method errors', () => {
  for (const expected of golden.getters) it(`${expected.probe} hooked=${expected.hooked}`, () => {
    const input = inputFor(), push = Array.prototype.push, set = Map.prototype.set, trace: string[] = [], seen = new Set<unknown>();
    const stop = new RangeError('row getter'); let error: unknown;
    const note = (value: unknown) => { const e = value as Entry; if (e?.source && Array.isArray(e.errors) && !seen.has(e)) seen.add(e); };
    try {
      Array.prototype.push = function <T>(this: T[], ...items: T[]) { for (const item of items) { const e = item as Entry; if (expected.hooked) note(e); if (e?.tab === 'Students' && e.source?.kind === 'SHEET' && Array.isArray(e.targets)) { const targets = e.targets; Object.defineProperty(e, 'targets', { get() { push.call(trace, 'targets'); if (expected.probe === 'targets') throw stop; return targets; } }); Object.defineProperty(targets, 'forEach', { get() { push.call(trace, 'forEach'); if (expected.probe === 'method') throw stop; return Array.prototype.forEach; } }); Object.defineProperty(targets[0], 'table', { get() { push.call(trace, 'table'); throw stop; } }); } } return push.apply(this, items); };
      if (expected.hooked) Map.prototype.set = function (key: unknown, value: unknown) { if (Array.isArray(value)) for (const e of value) note(e); return set.call(this, key, value); };
      run(input);
    } catch (e) { error = e; } finally { Array.prototype.push = push; Map.prototype.set = set; }
    expect(trace).toEqual(expected.trace); expect(error === stop).toBe(expected.errorIdentity); if (expected.hooked) expect(seen.size).toBeGreaterThan(0);
  });
});

describe('row native completion and original error precedence before any successor', () => {
  for (const stage of ['push', 'targets', 'method', 'forEach', 'table', 'has-true', 'has-false', 'add'] as const)
    for (const state of ['timely', 'expired', 'aborted', 'no-budget'] as const)
      for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
        let now = 0, fired = false, successor = 0, reached = 0, selected = false;
        const controller = new AbortController(), owner = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
        const b: BudgetContext | undefined = owner ? { ...owner, spend(n) { if (fired) successor++; owner.spend(n); }, reserve(cost) { if (fired) successor++; owner.reserve(cost); } } : undefined;
        const input = inputFor(b), push = Array.prototype.push, each = Array.prototype.forEach, has = Set.prototype.has, add = Set.prototype.add, del = Set.prototype.delete;
        let outer: Set<string> | undefined, targets: Target[] | undefined, error: unknown, deleted = false, membership: boolean | undefined;
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('row native');
        const next = () => { if (fired) successor++; };
        const trigger = () => { reached++; fired = true; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; };
        try {
          Set.prototype.add = function (key: string) { if (!selected && key === 'students') outer = this; if (selected && this === outer) { next(); const value = add.call(this, key); if (stage === 'add' && !fired) trigger(); return value; } return add.call(this, key); };
          Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry;
            if (!selected && e?.source?.kind === 'SHEET' && e.tab === 'Students' && e.source.rowNumber === 2 && Array.isArray(e.targets)) {
              selected = true; targets = e.targets;
              if (stage === 'has-false') deleted = del.call(outer!, 'students'); // synthetic missing membership, not a natural new name
              Object.defineProperty(e, 'targets', { get() { next(); if (stage === 'targets' && !fired) trigger(); return targets; } });
              const method = (callback: (t: Target, i: number, a: Target[]) => void, arg: unknown) => { next(); each.call(targets, callback, arg); if (stage === 'forEach' && !fired) trigger(); };
              Object.defineProperty(targets, 'forEach', { get() { next(); if (stage === 'method' && !fired) trigger(); return method; } });
              for (const t of targets) { const table = t.table; Object.defineProperty(t, 'table', { get() { next(); if (stage === 'table' && !fired) trigger(); return table; } }); }
              const value = push.apply(this, items); if (stage === 'push') trigger(); return value;
            }
            if (selected && (e?.source?.kind === 'SHEET' || e?.source?.kind === 'REDIS')) next(); return push.apply(this, items);
          };
          Set.prototype.has = function (key: string) { if (selected && this === outer) { next(); const value = has.call(this, key); if (stage.startsWith('has-') && !fired) { membership = value; trigger(); } return value; } return has.call(this, key); };
          run(input, b);
        } catch (e) { error = e; } finally { Array.prototype.push = push; Set.prototype.has = has; Set.prototype.add = add; }
        expect(selected).toBe(true); if (stage === 'has-false') expect(deleted).toBe(true);
        if (state === 'no-budget' && stage.startsWith('has-')) { expect(reached).toBe(0); return; }
        expect(reached).toBe(1); if (stage.startsWith('has-')) expect(membership).toBe(stage === 'has-true');
        if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
        else if (b && state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError);
        else if (exit === 'ordinary') expect(error).toBe(sentinel);
        else expect(error).toBeUndefined();
        if (b && (state !== 'timely' || exit !== 'success')) expect(successor).toBe(0);
      });
});

describe('empty ordinary and already-guarded Adjustment native exits', () => {
  for (const [name, tab] of [['bad-header', 'Students'], ['unknown', 'Unknown'], ['malformed-adjustment', 'Adjustments'], ['supported-v3', 'Adjustments']])
    for (const state of ['expired', 'aborted']) for (const stage of ['targets', 'forEach']) it(`${name} ${stage} ${state}`, () => {
      let now = 0, selected = 0, reached = 0, successor = 0, fired = false, length = -1;
      const controller = new AbortController(), owner = createBudgetContext({ now: () => now, signal: controller.signal });
      const b: BudgetContext = { ...owner, spend(n) { if (fired) successor++; owner.spend(n); }, reserve(c) { if (fired) successor++; owner.reserve(c); } };
      const input = inputFor(b, name), push = Array.prototype.push, each = Array.prototype.forEach; let error: unknown;
      try { Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (!selected && e?.tab === tab && e.source?.kind === 'SHEET') { selected++; const targets = e.targets; length = targets.length; const trigger = () => { reached++; fired = true; if (state === 'expired') now = 6000; else controller.abort(); }; Object.defineProperty(e, 'targets', { get() { if (stage === 'targets') trigger(); return targets; } }); Object.defineProperty(targets, 'forEach', { value(callback: (t: Target, i: number, a: Target[]) => void, arg: unknown) { if (fired) successor++; const result = each.call(targets, callback, arg); if (stage === 'forEach') trigger(); return result; } }); } return push.apply(this, items); }; run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
      expect(selected).toBe(1); expect(length).toBe(0); expect(reached).toBe(1); expect(successor).toBe(0); expect(error).toBeInstanceOf(BudgetUnavailableError);
    });
});

describe('actual constructor exit and independently charged work admission', () => {
  for (const allowance of [0, 1, 2]) it(`push pre-work ${allowance}: bad-header constructor has returned its final hash`, () => {
    const owner = createBudgetContext({ now: () => 0 }); let armed = 0, reached = 0, allocations = 0, work = 0, error: unknown;
    const b: BudgetContext = { ...owner, spend(n = 1) { if (armed) work += n; owner.spend(n); }, reserve(c) { if (armed) allocations++; owner.reserve(c); } };
    const input = inputFor(b, 'bad-header'), hash = input.sheets.tabs.Students.rows[0].hash, sha = validators.sha256, push = Array.prototype.push, stop = new RangeError('initial Entry push');
    vi.spyOn(validators, 'sha256').mockImplementation((value, context) => { const result = sha(value, context); if (value === hash && context === b) { leave(owner, 'work', allowance); armed++; } return result; });
    try { Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (e?.tab === 'Students' && e.source?.kind === 'SHEET') { reached++; throw stop; } return push.apply(this, items); }; run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(armed).toBe(1); expect(allocations).toBe(0); expect(work).toBe(1); expect(reached).toBe(allowance === 0 ? 0 : 1); if (allowance === 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const stage of ['forEach', 'callback', 'has', 'add'] as const) for (const delta of [-1, 0, 1]) it(`${stage} work exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b, stage === 'forEach' ? 'bad-header' : undefined), push = Array.prototype.push, each = Array.prototype.forEach, has = Set.prototype.has, add = Set.prototype.add;
    let armed = 0, reached = 0, selected = false, outer: Set<string> | undefined, error: unknown; const stop = new RangeError('admitted native operand');
    const arm = (cost: number) => { armed++; leave(b, 'work', cost + delta); };
    try {
      Set.prototype.add = function (key: string) { if (!selected && key === 'students') outer = this; if (selected && this === outer && stage === 'add') { reached++; throw stop; } return add.call(this, key); };
      Set.prototype.has = function (key: string) { if (selected && this === outer) { if (stage === 'has') { reached++; throw stop; } const result = has.call(this, key); if (stage === 'add' && !armed) arm(2); return result; } return has.call(this, key); };
      Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (!selected && e?.tab === 'Students' && e.source?.kind === 'SHEET') { selected = true; const targets = e.targets; if (stage === 'forEach') { arm(1); Object.defineProperty(e, 'targets', { get() { reached++; throw stop; } }); } else {
        Object.defineProperty(targets, 'forEach', { value(callback: (t: Target, i: number, a: Target[]) => void, arg: unknown) { return each.call(targets, (t: Target, i, a) => { if (i === 0 && stage === 'callback') arm(1); return callback.call(arg, t, i, a as Target[]); }); } });
        const table = targets[0].table; Object.defineProperty(targets[0], 'table', { get() { if (stage === 'callback') { reached++; throw stop; } if (stage === 'has' && !armed) arm(2); return table; } });
      } } return push.apply(this, items); };
      run(input, b);
    } catch (e) { error = e; } finally { Array.prototype.push = push; Set.prototype.has = has; Set.prototype.add = add; }
    expect(selected).toBe(true); expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('synthetic actual-deletion missing membership capacity versus natural duplicate add', () => {
  for (const present of [false, true]) for (const dimension of ['slots', 'structuralBytes'] as const) for (const delta of present ? [0] : [-1, 0, 1]) it(`${present ? 'natural-present zero allowance' : 'synthetic-deleted membership'} ${dimension} exact${delta}`, () => {
    const owner = createBudgetContext({ now: () => 0 }); let active = false, reservations = 0;
    const b: BudgetContext = { ...owner, reserve(c) { if (active) reservations++; owner.reserve(c); } }, input = inputFor(b);
    const push = Array.prototype.push, has = Set.prototype.has, add = Set.prototype.add, del = Set.prototype.delete;
    let outer: Set<string> | undefined, selected = false, armed = 0, reached = 0, deleted = false, membership: boolean | undefined, before: BudgetUsage | undefined, after: BudgetUsage | undefined, error: unknown;
    const stop = new RangeError('real collection add');
    try {
      Set.prototype.add = function (key: string) { if (!selected && key === 'students') outer = this; if (selected && this === outer) { reached++; after = b.usage(); add.call(this, key); throw stop; } return add.call(this, key); };
      Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (!selected && e?.tab === 'Students' && e.source?.kind === 'SHEET') { selected = true; if (!present) deleted = del.call(outer!, 'students'); if (present) { leave(owner, 'slots', 0); leave(owner, 'structuralBytes', 0); active = true; } } return push.apply(this, items); };
      Set.prototype.has = function (key: string) { const result = has.call(this, key); if (selected && this === outer && !armed) { armed++; membership = result; const cost = dimension === 'slots' ? 1 : 4; if (!present) leave(owner, dimension, cost + delta); before = b.usage(); active = true; } return result; };
      run(input, b);
    } catch (e) { error = e; } finally { Array.prototype.push = push; Set.prototype.has = has; Set.prototype.add = add; }
    const refused = !present && delta < 0;
    expect(selected).toBe(true); expect(armed).toBe(1); expect(membership).toBe(present); expect(deleted).toBe(!present); expect(reached).toBe(refused ? 0 : 1); expect(reservations).toBe(present ? 0 : 1);
    if (refused) expect(error).toBeInstanceOf(BudgetExceededError); else { expect(error).toBe(stop); expect(has.call(outer!, 'students')).toBe(true); expect(after!.nodes).toBe(before!.nodes); expect(after!.contentBytes).toBe(before!.contentBytes); expect(after!.slots - before!.slots).toBe(present ? 0 : 1); expect(after!.structuralBytes - before!.structuralBytes).toBe(present ? 0 : 4); }
  });
});

it('same owner multirow local trace is 2 + 5n with no handoff graph reservation', () => {
  const owner = createBudgetContext({ now: () => 0 }); let phase = false, debit = 0, reserved = 0, precedingDebit = 0;
  const b: BudgetContext = { ...owner, spend(n = 1) { precedingDebit = n; if (phase) debit += n; owner.spend(n); }, reserve(c) { if (phase) reserved++; owner.reserve(c); } };
  const input = inputFor(b), push = Array.prototype.push, each = Array.prototype.forEach, traces: { tab: string; n: number; work: number; reserved: number }[] = [];
  try { Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (e?.source?.kind === 'SHEET' && e.tab !== 'Settings' && Array.isArray(e.targets)) { phase = true; debit = precedingDebit; reserved = 0; const targets = e.targets; Object.defineProperty(targets, 'forEach', { value(callback: (t: Target, i: number, a: Target[]) => void, arg: unknown) { const result = each.call(targets, callback, arg); push.call(traces, { tab: e.tab, n: targets.length, work: debit, reserved }); phase = false; return result; }, configurable: true }); } return push.apply(this, items); }; run(input, b); } finally { Array.prototype.push = push; }
  expect(traces.length).toBeGreaterThan(8); expect(traces.some(t => t.n === 0)).toBe(true); expect(traces.some(t => t.n === 2)).toBe(true);
  for (const t of traces) { expect(t.work, t.tab).toBe(2 + 5 * t.n); expect(t.reserved, t.tab).toBe(0); }
});

describe('cumulative exhaustion after real row native callbacks', () => {
  for (const boundary of ['push', 'first-callback']) it(`${boundary} leaves zero: no next target operand`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = inputFor(b), push = Array.prototype.push, each = Array.prototype.forEach;
    let selected = 0, callbacks = 0, reads = 0, error: unknown;
    try { Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (!selected && e?.tab === 'Students' && e.source?.kind === 'SHEET') { selected++; const targets = e.targets;
      for (const t of targets) { const table = t.table; Object.defineProperty(t, 'table', { get() { reads++; return table; } }); }
      Object.defineProperty(targets, 'forEach', { value(callback: (t: Target, i: number, a: Target[]) => void, arg: unknown) { return each.call(targets, (t: Target, i, a) => { callbacks++; callback.call(arg, t, i, a as Target[]); if (i === 0 && boundary === 'first-callback') leave(b, 'work', 0); }); } });
      if (boundary === 'push') leave(b, 'work', 0);
    } return push.apply(this, items); }; run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(selected).toBe(1); expect(reads).toBe(boundary === 'push' ? 0 : 1); expect(callbacks).toBe(boundary === 'push' ? 0 : 2); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

it('outer Entry destination is reserved before the actual selected constructor source shell', () => {
  const owner = createBudgetContext({ now: () => 0 }), recipes: unknown[] = [], nativePush = Array.prototype.push;
  const b: BudgetContext = { ...owner, reserve(cost) { nativePush.call(recipes, cost); owner.reserve(cost); } }, input = inputFor(b, 'bad-header');
  const stop = new RangeError('selected constructed Entry'), sha = validators.sha256; let atHash: unknown[] = [], reached = 0, error: unknown;
  vi.spyOn(validators, 'sha256').mockImplementation((value, context) => { const result = sha(value, context); if (context === b && value === input.sheets.tabs.Students.rows[0].hash) atHash = recipes.slice(); return result; });
  try { Array.prototype.push = function <T>(this: T[], ...items: T[]) { const e = items[0] as Entry; if (e?.tab === 'Students' && e.source?.kind === 'SHEET') { reached++; throw stop; } return nativePush.apply(this, items); }; run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = nativePush; }
  const index = atHash.map(x => JSON.stringify(x)).lastIndexOf(JSON.stringify({ nodes: 6, slots: 5, structuralBytes: 93 }));
  expect(reached).toBe(1); expect(error).toBe(stop); expect(index).toBeGreaterThan(0); expect(atHash[index - 1]).toEqual({ slots: 1, structuralBytes: 4 }); expect(recipes).toEqual(atHash);
});

it('frozen fixture coverage distinguishes accepted fanout from quarantine and retains real raw errors/refs/aliases', () => {
  for (const version of [1, 2, 3]) expect(fixture(`supported-v${version}`).outcome.counts.students).toBe(1);
  const accepted = fixture('transaction-final-records-golden.json:accepted-mixed-legacy-and-all-four-promotion-variants').outcome;
  expect(accepted.counts.transactions).toBe(1); expect(accepted.counts.transaction_items).toBe(5);
  expect(fixture('transaction-cancellation-golden.json:accepted').outcome.counts.transactions).toBe(2);
  expect(fixture('task-construction-golden.json:allowed-sorted').outcome.counts.task_allowed_students).toBe(2);
  expect(fixture('BANK-quarantine').outcome.counts.task_completions).toBe(0);
  const raws = golden.cases.flatMap(c => c.outcome.raw) as (Entry & { aliases: boolean[]; canonicalOwner: number | null })[];
  expect(raws.some(e => e.errors.length > 0)).toBe(true); expect(raws.some(e => e.refs.length > 0)).toBe(true);
  expect(raws.some(e => e.aliases.some(Boolean))).toBe(true); expect(raws.some(e => e.aliases.some(a => !a))).toBe(true);
  expect(raws.some(e => e.tab === 'Unknown' && e.targets.length === 0)).toBe(true);
  expect(golden.cases.some(c => c.outcome.raw.some((e, i) => (e as { canonicalOwner: number | null }).canonicalOwner !== null && (e as { canonicalOwner: number }).canonicalOwner !== i))).toBe(true);
});
