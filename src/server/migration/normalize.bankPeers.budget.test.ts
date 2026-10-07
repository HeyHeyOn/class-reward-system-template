import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { assertRegisteredBoundedJson, parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
type Row = { tab: string; identity: string; canonical?: Record<string, unknown>; errors: string[]; refs: { code: string }[]; warnings: string[]; targets: { record: Record<string, unknown> }[] };
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/bank-peer-guards-golden.json', 'utf8')) as { cases: { name: string; input: Input; outcome: { json: string; counts: Record<string, number>; raw: unknown } }[] };
const fixture = (name: string) => golden.cases.find(c => c.name === name)!;
function at(name: string) {
  // Observe every call, but do not format/source-map thousands of diagnostic
  // stacks in the spend wrapper. Caller identity needs only structured frames.
  const limit = Error.stackTraceLimit, prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  let found = false;
  try {
    Error.stackTraceLimit = 60;
    Error.prepareStackTrace = (_error, sites) => { found = sites.some(site => site.getFunctionName()?.includes(name)); return ''; };
    void new Error().stack;
    return found;
  } finally {
    Error.stackTraceLimit = limit;
    if (prepare) Object.defineProperty(Error, 'prepareStackTrace', prepare);
    else Reflect.deleteProperty(Error, 'prepareStackTrace');
  }
}
function admitted(b: BudgetContext, name: string) { return parseRegisteredBoundedJson(JSON.stringify(fixture(name).input), b) as Input; }
function leave(b: BudgetContext, dimension: 'work' | 'slots' | 'nodes' | 'structuralBytes', amount: number) {
  const n = b.limits[dimension] - b.usage()[dimension] - amount;
  if (dimension === 'work') b.spend(n); else b.reserve({ [dimension]: n });
}

describe('budget stack observer', () => {
  it('observes named ancestors without formatting diagnostic stacks and restores Error hooks', () => {
    const limit = Error.stackTraceLimit, prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    let formatted = 0, present = false, absent = true;
    const formatter = () => { formatted++; return 'diagnostic text is not caller identity'; };
    try {
      Error.stackTraceLimit = 1;
      Error.prepareStackTrace = formatter;
      function namedBudgetAncestor() { return [0].map(() => at('namedBudgetAncestor'))[0]; }
      present = namedBudgetAncestor();
      absent = at('nonexistentBudgetAncestor');
      expect(Error.stackTraceLimit).toBe(1);
      expect(Error.prepareStackTrace).toBe(formatter);
    } finally {
      Error.stackTraceLimit = limit;
      if (prepare) Object.defineProperty(Error, 'prepareStackTrace', prepare);
      else Reflect.deleteProperty(Error, 'prepareStackTrace');
    }
    expect(present).toBe(true); expect(absent).toBe(false); expect(formatted).toBe(0);
  });
  it('restores an absent formatter property without installing a lasting global hook', () => {
    const limit = Error.stackTraceLimit, prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    let observed = false, installed = true;
    try {
      Reflect.deleteProperty(Error, 'prepareStackTrace');
      function namedBudgetAncestor() { return at('namedBudgetAncestor'); }
      observed = namedBudgetAncestor();
      installed = Object.hasOwn(Error, 'prepareStackTrace');
      expect(Error.stackTraceLimit).toBe(limit);
    } finally {
      if (prepare) Object.defineProperty(Error, 'prepareStackTrace', prepare);
      else Reflect.deleteProperty(Error, 'prepareStackTrace');
    }
    expect(observed).toBe(true); expect(installed).toBe(false);
  });
});

describe('BANK and peer frozen original Git parity, not authority promotion', () => {
  for (const f of golden.cases) for (const guarded of [false, true]) it(`${f.name} guarded=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = b ? admitted(b, f.name) : structuredClone(f.input), filter = Array.prototype.filter;
    let entries: Row[] | undefined;
    Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Observe exact mutable Entry identities, not a copied list.
      if (!entries && at('propagateClaimErrors')) entries = this;
      return filter.call(this, predicate, thisArg);
    };
    let r: ReturnType<typeof run>;
    try { r = run(input, b); } finally { Array.prototype.filter = filter; }
    expect(JSON.stringify(r)).toBe(f.outcome.json);
    expect(entries).toBeDefined();
    expect(entries!.map((e, index) => ({ tab: e.tab, identity: e.identity, errors: e.errors, refs: e.refs, warnings: e.warnings, canonicalKeys: e.canonical ? Object.keys(e.canonical) : null, canonicalAlias: e.canonical ? entries!.findIndex(p => p.canonical === e.canonical) : index, targetAliases: e.targets.map(t => t.record === e.canonical) }))).toEqual(f.outcome.raw);
    expect(Object.getPrototypeOf(r.records)).toBe(null);
    for (const [key, count] of Object.entries(f.outcome.counts)) expect(r.records[key]?.length ?? 0).toBe(count);
    for (const s of r.sourceRecords) if (s.canonicalRecord) {
      expect(Object.isFrozen(s.canonicalRecord)).toBe(false);
      if (b) expect(() => assertRegisteredBoundedJson(s.canonicalRecord, b)).toThrow('Legacy bounded JSON is invalid.');
    }
    if (f.name === 'supported-carry') expect(r.records.task_completions).toHaveLength(1);
    if (f.name === 'redis-duplicate-1') { expect(r.records.legacy_operation_bindings).toHaveLength(1); expect(r.records.padlet_evidence_claims).toHaveLength(1); }
    if (f.name === 'actual-bank-redis') {
      expect(r.records.task_completions ?? []).toHaveLength(0);
      expect(r.sourceRecords.some(s => s.errorCodes.includes('UNSUPPORTED_LEGACY_BANK_AUTHORITY') && s.canonicalRecord)).toBe(true);
    }
  });
});

describe('reached validation filters reserve destination before native allocation', () => {
  for (const stage of ['quarantineUnsupportedBankAuthority', 'propagateClaimErrors']) {
    for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`${stage} filter ${dimension} exact${delta}`, () => {
      const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'actual-bank-redis'), native = Array.prototype.filter;
      let reached = 0, second = 0, cost = 0;
      Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
        if (at(stage)) {
          if (reached) { second++; throw new Error('stop after next native allocation'); }
          const result = native.call(this, predicate, thisArg); reached++;
          // BANK's next allocation is its map result. Peer propagation's next
          // allocation is its failed-source map result, with identical list cost.
          cost = dimension === 'nodes' ? 1 : dimension === 'slots' ? result.length : 16 + 4 * result.length;
          leave(b, dimension, cost + delta);
          return result;
        }
        return native.call(this, predicate, thisArg);
      };
      const map = Array.prototype.map;
      Array.prototype.map = function <T, U>(this: T[], callback: (value: T, index: number, array: T[]) => U, thisArg?: unknown) {
        if (reached && at(stage)) { second++; throw new Error('stop at reserved map'); }
        return map.call(this, callback, thisArg) as U[];
      };
      try { run(input, b); } catch { /* later allocation exhaustion is expected */ }
      finally { Array.prototype.filter = native; Array.prototype.map = map; }
      expect(reached).toBe(1); expect(cost).toBeGreaterThan(0); expect(second).toBe(delta < 0 ? 0 : 1);
    });
  }
});

describe('actual nested peer reference and peer comparison visits', () => {
  for (const mode of ['ref', 'peer'] as const) for (const name of ['peer-ref-3', 'peer-ref-12', 'peer-ref-40']) it(`${mode} next getter refuses after same default counter exhausted ${name}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), native = Array.prototype.filter;
    let armed = false, installing = false, reached = 0, after = 0, error: unknown;
    Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      const result = native.call(this, predicate, thisArg);
      if (!armed && at('propagateClaimErrors') && result.length && result.every((r: Row) => r?.tab === 'RedisPadletClaim' || r?.tab === 'RedisOperationBinding')) {
        armed = true; installing = true;
        for (const row of result as Row[]) {
          const operands = mode === 'ref' ? row.refs : row.canonical ? [row.canonical] : [];
          const key = mode === 'ref' ? 'code' : 'operationId';
          for (const operand of operands) {
            const value = (operand as Record<string, unknown>)[key];
            Object.defineProperty(operand, key, { configurable: true, get() {
              if (!installing && at('propagateClaimErrors')) { if (reached) after++; else { reached++; leave(b, 'work', 0); } }
              return value;
            } });
          }
        }
        installing = false;
      }
      return result;
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = native; }
    expect(armed).toBe(true); expect(reached).toBe(1); expect(after).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('source discriminator fixed work recipe', () => {
  it('charges helper visit plus comparison and both fixed string blocks before the source operand', () => {
    const owner = createBudgetContext({ now: () => 0 }), spends: number[] = [];
    const b: BudgetContext = { ...owner, spend(amount = 1) { if (at('claimSourceDigest')) spends.push(amount); owner.spend(amount); } };
    const result = run(admitted(b, 'actual-bank-redis'), b);
    expect(JSON.stringify(result)).toBe(fixture('actual-bank-redis').outcome.json);
    expect(spends.length).toBeGreaterThan(0); expect(spends.every(n => n >= 4)).toBe(true);
  });
});

describe('peer propagated error destination preallocation', () => {
  for (const [dimension, cost] of [['nodes', 1], ['slots', 1], ['structuralBytes', 8]] as const) for (const delta of [-1, 0, 1]) it(`peer error append ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'peer-ref-3'), filter = Array.prototype.filter, push = Array.prototype.push;
    let installed = false, reached = 0, appended = 0;
    Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      const result = filter.call(this, predicate, thisArg);
      if (!installed && at('propagateClaimErrors') && result.length && result.every((r: Row) => r?.tab === 'RedisPadletClaim' || r?.tab === 'RedisOperationBinding')) {
        installed = true;
        const claim = (result as Row[]).find(r => r.tab === 'RedisPadletClaim')!;
        const value = claim.errors[0];
        Object.defineProperty(claim.errors, 0, { configurable: true, get() {
          if (!reached && at('propagateClaimErrors')) { reached++; leave(b, dimension, cost + delta); }
          return value;
        } });
      }
      return result;
    };
    Array.prototype.push = function (...values) {
      if (reached && at('propagateClaimErrors') && values[0] === 'BROKEN_TASK_REFERENCE') { appended++; throw new Error('stop at peer append'); }
      return push.apply(this, values);
    };
    try { run(input, b); } catch { /* isolate peer append */ } finally { Array.prototype.filter = filter; Array.prototype.push = push; }
    expect(installed).toBe(true); expect(reached).toBe(1); expect(appended).toBe(delta < 0 ? 0 : 1);
  });
});

describe('cumulative peer scans, not admission-only work', () => {
  function measure(name: string, twice = false) {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, name), filter = Array.prototype.filter;
    const checkpoints: number[] = [];
    Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      const result = filter.call(this, predicate, thisArg);
      if (at('propagateClaimErrors') && result.length && result.every((r: Row) => r?.tab === 'RedisPadletClaim' || r?.tab === 'RedisOperationBinding')) checkpoints.push(b.usage().work);
      return result;
    };
    let first = '', second = '';
    try { first = JSON.stringify(run(input, b)); if (twice) second = JSON.stringify(run(input, b)); }
    finally { Array.prototype.filter = filter; }
    expect(first).toBe(fixture(name).outcome.json);
    if (twice) expect(second).toBe(first);
    return checkpoints;
  }
  it('small sheet plus 80 Redis peers retains quadratic scans and charges their inner visits', () => {
    const small = measure('peer-ref-3'), large = measure('peer-ref-40');
    expect(small).toHaveLength(2); expect(large).toHaveLength(2);
    expect(small[1] - small[0]).toBeGreaterThan(36);
    expect(large[1] - large[0]).toBeGreaterThan((small[1] - small[0]) * 40);
  });
  it('same context across two normalizations retains previous peer spend with identical bytes', () => {
    const trace = measure('peer-ref-3', true);
    expect(trace).toHaveLength(4);
    expect(trace[1]).toBeGreaterThan(trace[0]); expect(trace[2]).toBeGreaterThan(trace[1]); expect(trace[3]).toBeGreaterThan(trace[2]);
    expect(trace[3] - trace[2]).toBe(trace[1] - trace[0]);
  });
});

describe('BANK membership and allocation chronology', () => {
  it('bank.includes inner entry read cannot append after exhausting the default counter', () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'actual-bank-redis'), map = Array.prototype.map, push = Array.prototype.push;
    let maps = 0, reached = 0, appended = 0, error: unknown;
    Array.prototype.map = function <T, U>(this: T[], callback: (value: T, index: number, array: T[]) => U, thisArg?: unknown) {
      const result = map.call(this, callback, thisArg) as U[];
      if ((this[0] as Row)?.tab === 'TaskCompletions' && at('quarantineUnsupportedBankAuthority') && ++maps === 2) {
        const row = this[0];
        Object.defineProperty(this, 0, { configurable: true, get() { reached++; leave(b, 'work', 0); return row; } });
      }
      return result;
    };
    Array.prototype.push = function (...values) { if (reached && at('quarantineUnsupportedBankAuthority')) appended++; return push.apply(this, values); };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.map = map; Array.prototype.push = push; }
    expect(maps).toBe(2); expect(reached).toBe(1); expect(appended).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const [dimension, cost] of [['nodes', 1], ['slots', 1], ['structuralBytes', 8]] as const) for (const delta of [-1, 0, 1]) it(`BANK error append ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'actual-bank-redis'), has = Set.prototype.has, push = Array.prototype.push;
    let reached = 0, appended = 0;
    Set.prototype.has = function (key) {
      const result = has.call(this, key);
      if (!reached && result && key === 'op-1' && at('quarantineUnsupportedBankAuthority')) { reached++; leave(b, dimension, cost + delta); }
      return result;
    };
    Array.prototype.push = function (...values) {
      if (reached && at('quarantineUnsupportedBankAuthority') && values[0] === 'UNSUPPORTED_LEGACY_BANK_AUTHORITY') { appended++; throw new Error('stop at append'); }
      return push.apply(this, values);
    };
    try { run(input, b); } catch { /* isolate first destination */ } finally { Set.prototype.has = has; Array.prototype.push = push; }
    expect(reached).toBe(1); expect(appended).toBe(delta < 0 ? 0 : 1);
  });
  for (const dimension of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) it(`BANK Set shell and entries ${dimension} exact${delta}`, () => {
    const b = createBudgetContext({ now: () => 0 }), input = admitted(b, 'actual-bank-redis'), filter = Array.prototype.filter, NativeSet = globalThis.Set;
    let filters = 0, reached = 0, constructed = 0;
    Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      const result = filter.call(this, predicate, thisArg);
      if (at('quarantineUnsupportedBankAuthority') && ++filters === 2) {
        reached++; const cost = dimension === 'nodes' ? 1 : dimension === 'slots' ? result.length : 16 + 4 * result.length;
        leave(b, dimension, cost + delta);
      }
      return result;
    };
    globalThis.Set = new Proxy(NativeSet, { construct(target, args, newTarget) {
      if (reached && at('quarantineUnsupportedBankAuthority')) { constructed++; throw new Error('stop at constructor'); }
      return Reflect.construct(target, args, newTarget);
    } });
    try { run(input, b); } catch { /* isolate Set constructor */ } finally { Array.prototype.filter = filter; globalThis.Set = NativeSet; }
    expect(reached).toBe(1); expect(constructed).toBe(delta < 0 ? 0 : 1);
  });
});

describe('native validation boundaries discard late success and ordinary failure, preserve budget identity', () => {
  for (const stage of ['quarantineUnsupportedBankAuthority', 'propagateClaimErrors']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) for (const expiry of ['timely', 'expired', 'aborted'] as const) it(`${stage} filter ${exit}/${expiry}`, () => {
    let now = 0; const controller = new AbortController();
    const b = createBudgetContext({ now: () => now, signal: controller.signal }), input = admitted(b, 'actual-bank-redis'), native = Array.prototype.filter;
    const marker = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('ordinary native failure');
    let reached = 0, later = 0, error: unknown;
    Array.prototype.filter = function (predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      if (at(stage)) {
        if (reached) later++;
        if (!reached) {
          reached++;
          const result = native.call(this, predicate, thisArg);
          if (expiry === 'expired') now = 5001;
          if (expiry === 'aborted') controller.abort();
          if (exit !== 'success') throw marker;
          return result;
        }
      }
      return native.call(this, predicate, thisArg);
    };
    try { run(input, b); } catch (e) { error = e; } finally { Array.prototype.filter = native; }
    expect(reached).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable' || (exit === 'ordinary' && expiry === 'timely')) expect(error).toBe(marker);
    else if (expiry !== 'timely') expect(error).toBeInstanceOf(BudgetUnavailableError);
    else expect(error).toBeUndefined();
    if (expiry !== 'timely' || exit !== 'success') expect(later).toBe(0);
  });
});
