import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/claim-joins-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string } }[] };
const fixture = (name: string) => golden.cases.find(c => c.name === name)!;
const admitted = (b: BudgetContext, name: string) => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: 'work' | 'slots' | 'contentBytes', amount: number) { const rest = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(rest); else b.reserve({ [dimension]: rest }); }
const at = (name: string) => { const old = Error.stackTraceLimit; Error.stackTraceLimit = 60; try { return new Error().stack?.includes(name) ?? false; } finally { Error.stackTraceLimit = old; } };
afterEach(() => vi.restoreAllMocks());

describe('executed frozen Git claim joins parity', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.name) : structuredClone(f.input), b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    for (const source of result.sourceRecords) if (source.canonicalRecord) expect(Object.isFrozen(source.canonicalRecord)).toBe(false);
    if (f.name === 'redis-duplicate-1') { expect(result.records.padlet_evidence_claims).toHaveLength(1); expect(result.records.legacy_operation_bindings).toHaveLength(1); }
  });
});

describe('supplemental frozen Git raw grouping, multiplicity and alias parity', () => {
  type Member = { errors: string[]; refs: unknown[]; canonical: unknown; targets: { record: unknown }[] };
  type Group = { record: { provider?: string }; members: Member[]; sheetEntries: Member[] };
  const raw = JSON.parse(readFileSync('src/server/migration/__fixtures__/claim-joins-raw-golden.json', 'utf8')) as { cases: { name: string; groups: unknown[] }[] };
  for (const f of raw.cases) for (const guarded of [false, true]) it(`${f.name} raw guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined, input = b ? admitted(b, f.name) : structuredClone(fixture(f.name).input);
    const set = Map.prototype.set, groups: Group[] = [];
    Map.prototype.set = function (key: unknown, value: unknown) {
      const group = value as Group | undefined;
      if (group?.record?.provider === 'PADLET' && Array.isArray(group.members) && Array.isArray(group.sheetEntries)) groups.push(group);
      return set.call(this, key, value);
    };
    try { run(input, b); } finally { Map.prototype.set = set; }
    expect(groups.map(g => ({ record: JSON.stringify(g.record), members: g.members.map(m => ({ errors: m.errors, refs: m.refs, canonicalShared: m.canonical === g.record, targetShared: m.targets[0].record === g.record })), sheetEntries: g.sheetEntries.map(m => ({ errors: m.errors, refs: m.refs })) }))).toEqual(f.groups);
  });
});

describe('reached claim grouping allocation and nested work', () => {
  for (const delta of [-1, 0, 1]) it(`binding bucket destination slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1');
    const get = Map.prototype.get, push = Array.prototype.push;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && key === 'op-1' && at('normalizeClaims')) { armed++; leave(b, 'slots', 3 + delta); } return result; };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) { if (armed && (items[0] as { binding?: unknown; entry?: unknown })?.binding && (items[0] as { entry?: unknown }).entry && at('normalizeClaims')) { reached++; throw new Error('bucket append sentinel'); } return push.apply(this, items); };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('claim × sheet second predicate precharges the same exhausted work owner', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1');
    const filter = Array.prototype.filter;
    let filters = 0, armed = 0, reached = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T[] {
      const target = at('normalizeClaims') && ++filters === 2;
      if (target && this.length > 1) { const next = this[1] as { tab: string }; const tab = next.tab; Object.defineProperty(next, 'tab', { configurable: true, get: () => { if (armed) reached++; return tab; } }); }
      return filter.call(this, (value: T, index: number, array: T[]) => { const result = callback.call(thisArg, value, index, array); if (target && !armed) { armed++; leave(b, 'work', 0); } return result; }) as T[];
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('reached collision, key and provenance boundaries', () => {
  for (const name of ['v1-repeated-binding', 'orphan-repeated-binding']) it(`${name} inner comparison precharges after a nonmatching candidate`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), set = Map.prototype.set;
    let armed = 0, reached = 0, error: unknown;
    const installed = new WeakSet<object>();
    Map.prototype.set = function (key: unknown, value: unknown) {
      if (key === 'op-1' && Array.isArray(value) && at('normalizeClaims')) for (const candidate of value) {
        if (!candidate || installed.has(candidate) || !candidate.binding) continue;
        const binding = candidate.binding; installed.add(candidate);
        Object.defineProperty(candidate, 'binding', { configurable: true, get: () => {
          if (at('normalizeClaims')) { if (armed) reached++; else { armed++; leave(b, 'work', 0); } }
          return binding;
        } });
      }
      return set.call(this, key, value);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.set = set; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`provenance stable sort scratch slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-3'), map = Array.prototype.map, compare = validators.compareCodeUnits;
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.map = function <T, U>(this: T[], callback: (value: T, index: number, array: T[]) => U, thisArg?: unknown): U[] {
      const result = map.call(this, callback, thisArg) as U[];
      if (!armed && result.length === 3 && (result[0] as { kind?: string })?.kind === 'REDIS' && at('normalizeClaims')) { armed++; leave(b, 'slots', 2 * result.length + delta); }
      return result;
    };
    vi.spyOn(validators, 'compareCodeUnits').mockImplementation((a, c) => { if (armed && at('normalizeClaims')) { reached++; throw new Error('sort comparison sentinel'); } return compare(a, c); });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.map = map; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('provenance sort next move/comparison checks the same exhausted work context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-3'), compare = validators.compareCodeUnits;
    let armed = 0, reached = 0, error: unknown;
    vi.spyOn(validators, 'compareCodeUnits').mockImplementation((a, c) => {
      const result = compare(a, c);
      if (a.length === 64 && c.length === 64 && at('normalizeClaims')) { if (armed) reached++; else { armed++; leave(b, 'work', 0); } }
      return result;
    });
    try { run(input, b); } catch (e) { error = e; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const delta of [-1, 0, 1]) it(`closed binding key projection slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1'), get = Map.prototype.get, encode = validators.canonicalJson;
    let armed = 0, reached = 0, error: unknown, owner: BudgetContext | undefined;
    Map.prototype.get = function (key: unknown) { const result = get.call(this, key); if (!armed && key === input.redis!.v2Claims[0].tupleDigest && at('addClaim')) { armed++; leave(b, 'slots', 20 + delta); } return result; };
    vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => { if (armed && at('claimBindingKey')) { reached++; owner = context; throw new Error('key scalar encoder sentinel'); } return encode(value, context); });
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(owner).toBe(b);
  });
  for (const delta of [-1, 0, 1]) it(`actual affected sheet filter slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1'), filter = Array.prototype.filter, sha = validators.sha256;
    const payload = validators.canonicalJson(input.redis!.operationBindings[0].binding);
    let length = 0, armed = 0, reached = 0, error: unknown;
    Array.prototype.filter = function <T>(this: T[], callback: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T[] {
      if (at('normalizeClaims')) { if (armed) { reached++; throw new Error('affected filter sentinel'); } length = this.length; }
      return filter.call(this, callback, thisArg) as T[];
    };
    vi.spyOn(validators, 'sha256').mockImplementation((value, context) => { const result = sha(value, context); if (!armed && value === payload && at('normalizeClaims')) { armed++; leave(b, 'slots', length + delta); } return result; });
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = filter; }
    expect(length).toBeGreaterThan(1); expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
  it('claim binding key refuses before native unbudgeted projection encoding', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1'), get = Map.prototype.get, encode = validators.canonicalJson;
    let armed = 0, reached = 0, error: unknown;
    Map.prototype.get = function (key: unknown) { const value = get.call(this, key); if (!armed && key === input.redis!.v2Claims[0].tupleDigest && at('addClaim')) { armed++; leave(b, 'slots', 0); } return value; };
    vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => { if (armed && at('claimBindingKey')) reached++; return encode(value, context); });
    try { run(input, b); } catch (e) { error = e; } finally { Map.prototype.get = get; }
    expect(armed).toBe(1); expect(reached).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('claim validation native boundaries', () => {
  it('tuple and owner hashes use the identical request context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1'), sha = validators.sha256, claim = input.redis!.v2Claims[0];
    let reached = 0;
    vi.spyOn(validators, 'sha256').mockImplementation((value, context) => {
      if (at('normalizeClaims') && !at('derivedEntry') && !at('redisPointer') && !at('deterministicIdWithBudget') && (value === `${claim.boardId}\0${claim.postId}` || value === claim.operationId)) { reached++; expect(context).toBe(b); }
      return sha(value, context);
    });
    expect(JSON.stringify(run(input, b))).toBe(fixture('redis-duplicate-1').outcome.json); expect(reached).toBe(2);
  });
  for (const delta of [-1, 0, 1]) it(`tuple string prehash content bytes exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1'), test = RegExp.prototype.test, sha = validators.sha256, claim = input.redis!.v2Claims[0];
    const tuple = `${claim.boardId}\0${claim.postId}`;
    let armed = 0, reached = 0, error: unknown, owner: BudgetContext | undefined;
    RegExp.prototype.test = function (value: string) { const result = test.call(this, value); if (!armed && value === claim.postId && at('normalizeClaims')) { armed++; leave(b, 'contentBytes', Buffer.byteLength(tuple) + delta); } return result; };
    vi.spyOn(validators, 'sha256').mockImplementation((value, context) => { if (armed && value === tuple) { reached++; owner = context; throw new Error('tuple hash sentinel'); } return sha(value, context); });
    try { run(input, b); } catch (e) { error = e; } finally { RegExp.prototype.test = test; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(owner).toBe(b);
  });
  for (const state of ['timely', 'expired', 'aborted'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`board regex ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController();
    const b = createBudgetContext({ now: () => now, signal: controller.signal }), input = admitted(b, 'redis-duplicate-1'), test = RegExp.prototype.test, claim = input.redis!.v2Claims[0];
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('board predicate');
    let armed = 0, reached = 0, error: unknown;
    RegExp.prototype.test = function (value: string) {
      // Stack formatting itself runs regexes; reject unrelated/already-armed calls first.
      if (!armed && value === claim.boardId && at('normalizeClaims')) { armed++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort(); if (exit !== 'success') throw sentinel; }
      if (armed && value === claim.postId && at('normalizeClaims')) reached++;
      return test.call(this, value);
    };
    try { run(input, b); } catch (e) { error = e; } finally { RegExp.prototype.test = test; }
    expect(armed).toBe(1); expect(reached).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError);
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else expect(error).toBeUndefined();
  });
});

describe('supplemental reached native collection/key exit matrix', () => {
  for (const stage of ['get', 'set', 'add', 'filter', 'map', 'join', 'compare'] as const) for (const state of ['timely', 'expired', 'aborted'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
    let now = 0; const controller = new AbortController();
    const b = createBudgetContext({ now: () => now, signal: controller.signal }), input = admitted(b, 'redis-duplicate-3');
    const owner = (stage === 'get' || stage === 'set' ? Map.prototype : stage === 'add' ? Set.prototype : stage === 'compare' ? validators : Array.prototype) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const method = stage === 'compare' ? 'compareCodeUnits' : stage, native = owner[method];
    const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native join boundary');
    let reached = 0, error: unknown;
    vi.spyOn(owner, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      const array = this as { 0?: { tab?: string } | string };
      const selected = (stage === 'get' || stage === 'set' ? args[0] === 'op-1'
        : stage === 'add' ? args[0] === 'padlet_evidence_claims'
        : stage === 'filter' ? typeof array[0] === 'object' && !!array[0]?.tab
        : stage === 'map' ? typeof array[0] === 'object' && array[0]?.tab === 'RedisPadletClaim'
        : stage === 'join' ? typeof array[0] === 'string' && array[0].startsWith('"boardId":') && at('claimBindingKey')
        : typeof args[0] === 'string' && args[0].length === 64 && typeof args[1] === 'string' && args[1].length === 64) && at('normalizeClaims');
      if (!reached && selected) {
        reached++; if (state === 'expired') now = 6000; if (state === 'aborted') controller.abort();
        if (exit !== 'success') throw sentinel;
      }
      return native.apply(this, args);
    });
    try { run(input, b); } catch (e) { error = e; }
    vi.restoreAllMocks();
    expect(reached).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
    else if (state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError);
    else if (exit === 'ordinary') expect(error).toBe(sentinel); else expect(error).toBeUndefined();
  });
});

describe('actual claim key encoding propagates context and native exit failures', () => {
  it('payload native canonical encoder uses the admitted binding and identical context', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1'), encode = validators.canonicalJson;
    let reached = 0;
    vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => { if (value === input.redis!.operationBindings[0].binding && at('normalizeClaims')) { reached++; expect(context).toBe(b); } return encode(value, context); });
    expect(JSON.stringify(run(input, b))).toBe(fixture('redis-duplicate-1').outcome.json); expect(reached).toBe(1);
  });
  for (const errorKind of ['ordinary', 'exceeded', 'unavailable'] as const) it(`payload late native ${errorKind} retains budget identity`, () => {
    let now = 0;
    const b = createBudgetContext({ now: () => now }), input = admitted(b, 'redis-duplicate-1'), encode = validators.canonicalJson;
    const sentinel = errorKind === 'ordinary' ? new RangeError('late payload') : errorKind === 'exceeded' ? new BudgetExceededError() : new BudgetUnavailableError();
    let reached = 0, error: unknown;
    vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => { if (value === input.redis!.operationBindings[0].binding && at('normalizeClaims')) { reached++; now = 6000; throw sentinel; } return encode(value, context); });
    try { run(input, b); } catch (e) { error = e; }
    expect(reached).toBe(1); if (errorKind === 'ordinary') expect(error).toBeInstanceOf(BudgetUnavailableError); else expect(error).toBe(sentinel);
  });
});
