import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/claim-construction-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; counts: Record<string, number> } }[] };
const fixture = (name: string) => golden.cases.find(c => c.name === name)!;
const admitted = (b: BudgetContext, name: string) => parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input;
function leave(b: BudgetContext, dimension: 'work' | 'nodes' | 'slots' | 'structuralBytes', amount: number) { const spend = b.limits[dimension] - b.usage()[dimension] - amount; if (dimension === 'work') b.spend(spend); else b.reserve({ [dimension]: spend }); }
const at = (name: string) => { const old = Error.stackTraceLimit; Error.stackTraceLimit = 60; try { return new Error().stack?.includes(name) ?? false; } finally { Error.stackTraceLimit = old; } };
afterEach(() => vi.restoreAllMocks());

describe('executed original Git claim construction parity', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const result = run(b ? admitted(b, f.name) : structuredClone(f.input), b);
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    if (f.name === 'redis-duplicate-1') {
      expect(result.records.padlet_evidence_claims).toHaveLength(1);
      expect(result.records.legacy_operation_bindings).toHaveLength(1);
    }
    for (const s of result.sourceRecords) if (s.canonicalRecord) expect(Object.isFrozen(s.canonicalRecord)).toBe(false);
  });
});

describe('actual derivedEntry shell before identity hash', () => {
  // Closed Entry + redacted + Target + shallow canonical clone + four lists.
  // These independent fixed bounds include every primitive occurrence and key.
  const variants = [
    { name: 'redis-duplicate-1', table: 'legacy_operation_bindings', identity: 'op-1', work: 24, nodes: 24, slots: 25, structuralBytes: 521 },
    { name: 'orphan-only', table: 'padlet_claim_digest_tombstones', identity: 'a'.repeat(64), work: 19, nodes: 19, slots: 20, structuralBytes: 421 },
  ];
  for (const variant of variants) for (const dimension of ['work', 'nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`${variant.name} ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, variant.name);
    const id = validators.deterministicId, boundedId = validators.deterministicIdWithBudget, sha = validators.sha256;
    let armed = 0, reached = 0, error: unknown;
    function arm(parts: string[]) { if (!armed && at('normalizeClaims') && parts.includes(variant.table)) { armed++; leave(b, dimension, variant[dimension] + delta); } }
    vi.spyOn(validators, 'deterministicId').mockImplementation((...parts: string[]) => { const result = id(...parts); arm(parts); return result; });
    vi.spyOn(validators, 'deterministicIdWithBudget').mockImplementation((context, ...parts) => { const result = boundedId(context, ...parts); arm(parts); return result; });
    vi.spyOn(validators, 'sha256').mockImplementation((value, context) => {
      if (armed && value === variant.identity && at('derivedEntry')) { reached++; throw new Error('stop at identity hash'); }
      return sha(value, context);
    });
    try { run(input, b); } catch (e) { error = e; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('Redis source factory and caller canonical/ID argument reservations', () => {
  for (const dimension of ['work', 'nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`source pre-encoder ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1');
    const native = Array.prototype[Symbol.iterator], encode = validators.canonicalJson;
    // Includes the newly guarded outer binding visit before the source shell.
    const cost = { work: 6, nodes: 5, slots: 4, structuralBytes: 88 };
    let armed = 0, reached = 0;
    Array.prototype[Symbol.iterator] = function <T>(this: T[]) {
      const iterator = native.call(this) as ArrayIterator<T>;
      if (this !== input.redis!.operationBindings) return iterator;
      const next = iterator.next.bind(iterator);
      iterator.next = () => { const result = next(); if (!armed && !result.done) { armed++; leave(b, dimension, cost[dimension] + delta); } return result; };
      return iterator;
    };
    vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => {
      if (value === input.redis!.operationBindings[0]) { reached++; throw new Error('stop before source encoding'); }
      return encode(value, context);
    });
    try { run(input, b); } catch { /* stop at the observed boundary */ }
    finally { Array.prototype[Symbol.iterator] = native; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
  });

  for (const dimension of ['work', 'nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`binding canonical and rest arguments pre-ID ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1');
    const sha = validators.sha256, id = validators.deterministicId, boundedId = validators.deterministicIdWithBudget;
    const cost = { work: 9, nodes: 10, slots: 12, structuralBytes: 197 };
    let armed = 0, reached = 0;
    vi.spyOn(validators, 'sha256').mockImplementation((value, context) => {
      const result = sha(value, context);
      if (!armed && at('redisPointer')) { armed++; leave(b, dimension, cost[dimension] + delta); }
      return result;
    });
    vi.spyOn(validators, 'deterministicId').mockImplementation((...parts: string[]) => { if (armed && parts.includes('legacy_operation_bindings')) { reached++; throw new Error('stop at ID'); } return id(...parts); });
    vi.spyOn(validators, 'deterministicIdWithBudget').mockImplementation((context, ...parts) => { if (armed && parts.includes('legacy_operation_bindings')) { reached++; expect(context).toBe(b); throw new Error('stop at ID'); } return boundedId(context, ...parts); });
    try { run(input, b); } catch { /* stop at the observed boundary */ }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
  });
});

describe('derived binding refs reserve before literal and native append', () => {
  for (const dimension of ['work', 'nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`refs ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1');
    const sha = validators.sha256, push = Array.prototype.push, cost = { work: 8, nodes: 8, slots: 8, structuralBytes: 110 };
    let armed = 0, reached = 0, error: unknown;
    vi.spyOn(validators, 'sha256').mockImplementation((value, context) => {
      const result = sha(value, context);
      if (!armed && value === 'op-1' && at('derivedEntry')) { armed++; leave(b, dimension, cost[dimension] + delta); }
      return result;
    });
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      if (armed && (items[0] as { code?: string })?.code === 'BROKEN_TASK_REFERENCE' && at('normalizeClaims')) { reached++; throw new Error('stop at ref append'); }
      return push.apply(this, items);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = push; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});


describe('claim output intermediate destination before append', () => {
  for (const delta of [-1, 0, 1]) it(`binding destination slots exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1'), native = Array.prototype.push, set = Map.prototype.set;
    let armed = 0, reached = 0, error: unknown;
    // Group storage now has its own reservation after refs. Arm at that real
    // storage exit, immediately before the independently tested Entry destination.
    Map.prototype.set = function (key: unknown, value: unknown) {
      const result = set.call(this, key, value);
      if (!armed && key === 'op-1' && Array.isArray(value) && value[0]?.binding && value[0]?.entry && at('normalizeClaims')) { armed++; leave(b, 'slots', 1 + delta); }
      return result;
    };
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      const first = items[0] as { tab?: string };
      if (armed && first?.tab === 'RedisOperationBinding' && at('normalizeClaims')) { reached++; throw new Error('stop at Entry append'); }
      return native.apply(this, items);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = native; Map.prototype.set = set; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});


describe('actual native hash exits preserve deadline and budget error identity', () => {
  for (const stage of ['derivedEntry', 'redisPointer', 'deterministicIdWithBudget']) {
    for (const state of ['timely', 'expired', 'aborted'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${stage} ${state} ${exit}`, () => {
      let now = 0; const controller = new AbortController();
      const b = createBudgetContext({ now: () => now, signal: controller.signal }), input = admitted(b, 'redis-duplicate-1');
      const prototype = Object.getPrototypeOf(createHash('sha256')) as { digest(encoding?: string): unknown }, native = prototype.digest;
      const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native hash sentinel');
      let reached = 0, error: unknown;
      vi.spyOn(prototype, 'digest').mockImplementation(function (this: unknown, encoding?: string) {
        if (!reached && at(stage) && at('normalizeClaims')) {
          reached++;
          if (state === 'expired') now = 6000;
          if (state === 'aborted') controller.abort();
          if (exit !== 'success') throw sentinel;
        }
        return native.call(this, encoding);
      });
      try { run(input, b); } catch (e) { error = e; }
      expect(reached).toBe(1);
      if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(sentinel);
      else if (state !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError);
      else if (exit === 'ordinary') expect(error).toBe(sentinel);
      else expect(error).toBeUndefined();
    });
  }
});

it('same context accumulates two accepted claim runs without refund or reset', () => {
  const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'redis-duplicate-1');
  const before = b.usage(); const first = run(input, b); const middle = b.usage(); const second = run(input, b); const after = b.usage();
  expect(JSON.stringify(first)).toBe(fixture('redis-duplicate-1').outcome.json);
  expect(JSON.stringify(second)).toBe(fixture('redis-duplicate-1').outcome.json);
  for (const dimension of ['work', 'nodes', 'slots', 'structuralBytes', 'contentBytes'] as const) {
    expect(middle[dimension]).toBeGreaterThan(before[dimension]);
    expect(after[dimension] - middle[dimension]).toBe(middle[dimension] - before[dimension]);
  }
});


describe('claim error occurrences reserve separately, preserving duplicate order', () => {
  for (const dimension of ['work', 'nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`next conflict ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'binding-conflict'), native = Array.prototype.push;
    // Native forEach admission + candidate visit precede the unchanged append.
    const cost = { work: 3, nodes: 1, slots: 1, structuralBytes: 8 };
    let armed = 0, reached = 0, error: unknown;
    Array.prototype.push = function <T>(this: T[], ...items: T[]) {
      if (items[0] === 'CLAIM_BINDING_CONFLICT' && at('normalizeClaims')) {
        if (armed) { reached++; throw new Error('stop at next error append'); }
        const result = native.apply(this, items); armed++; leave(b, dimension, cost[dimension] + delta); return result;
      }
      return native.apply(this, items);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.push = native; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError);
  });
});


it('no-budget Redis encoding precedes source digest getter, frozen Git error order', () => {
  const input = structuredClone(fixture('redis-duplicate-1').input), events: string[] = [], encode = validators.canonicalJson;
  const ordinary = new RangeError('digest getter');
  vi.spyOn(validators, 'canonicalJson').mockImplementation((value, context) => { if (value === input.redis!.operationBindings[0]) events.push('encode'); return encode(value, context); });
  Object.defineProperty(input.redis!, 'digest', { get() { events.push('digest'); throw ordinary; } });
  expect(() => run(input)).toThrow(ordinary);
  expect(events).toEqual(['encode', 'digest']);
});
