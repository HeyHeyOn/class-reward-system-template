/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-this-alias -- Observe the original native receiver identity. */
import * as tsModule from 'typescript';
import * as projectionModule from './operationalProjection';
import * as rowsModule from '@/server/sheetsRows';
import * as semanticModule from './semanticValidators';
import * as boundedModule from '@/lib/boundedJson';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as outputModule from './normalizationOutput';
import * as workModule from '@/lib/boundedWork';
import * as validatorsModule from './validators';
import { normalizeLegacySnapshots as run } from './normalize';
import { createHash as nativeCreateHash } from 'node:crypto';
// Vitest's native import binding is not replaceable by export spies here. Bind
// the byte-exact real SHA declaration to a delegated native factory instead.
// This is a test-only import seam; the body and same-context accounting are real.
const validatorText = readFileSync('src/server/migration/validators.ts', 'utf8');
const validatorAST = tsModule.createSourceFile('validators.ts', validatorText, tsModule.ScriptTarget.ESNext, true);
const shaDeclaration = validatorAST.statements.find(s => tsModule.isFunctionDeclaration(s) && s.name?.text === 'sha256')!.getText(validatorAST);
function nativeBoundSHA(createHash: typeof nativeCreateHash): typeof validatorsModule.sha256 {
  const js = tsModule.transpileModule(shaDeclaration, { compilerOptions: { module: tsModule.ModuleKind.CommonJS, target: tsModule.ScriptTarget.ESNext } }).outputText;
  const loaded = { exports: {} as any };
  new Function('module', 'exports', 'createHash', 'utf8ByteLength', 'BudgetExceededError', 'BudgetUnavailableError', js)(loaded, loaded.exports, createHash, workModule.utf8ByteLength, BudgetExceededError, BudgetUnavailableError);
  return loaded.exports.sha256;
}

// ORACLE_OBSERVER_BEGIN
function observe(normalize: (input: any) => any, input: any, hooked = true, probe?: string, bookkeepingPush?: typeof Array.prototype.push) {
  const forwardPush = Array.prototype.push, push = bookkeepingPush ?? forwardPush, set = Map.prototype.set;
  const entries: any[] = [], received: number[] = [], sources: any[] = [], trace: string[] = [];
  const diagnostics: any[] = [];
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
      for (const d of items) if (hooked && d && typeof d.code === 'string' && typeof d.path === 'string' && typeof d.sourceDigest === 'string' && new Error().stack?.includes('pushDiagnostics')) push.call(diagnostics, { ...d });
      return forwardPush.apply(this, items);
    };
    Map.prototype.set = function(k: any, v: any) {
      if (hooked && Array.isArray(v)) for (const e of v) remember(e);
      return set.call(this, k, v);
    };
    result = normalize(input);
  } catch (e) { error = e; }
  finally { Array.prototype.push = forwardPush; Map.prototype.set = set; }
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
    diagnostics, json: JSON.stringify(result), nullPrototype: Object.getPrototypeOf(result.records) === null,
    counts: Object.fromEntries(Object.entries(result.records).map(([k, v]) => [k, (v as any[]).length])),
  };
}
// ORACLE_OBSERVER_END
type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/raw-diagnostics-golden.json', 'utf8')) as { cases: {name: string; input: Input; outcome: ReturnType<typeof observe>}[] };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
function seamInput(): Input {
  const input = clone(golden.cases.find(c => c.name === 'supported-v3')!.input);
  const students = input.sheets.tabs.Students;
  return { ...input, sheets: { ...input.sheets, tabs: { Students: { ...students, rows: [{ ...students.rows[0], cells: ['', 'Alice', '100', 'ACTIVE'] }] } } } };
}
const realCreate = outputModule.createNormalizationOutput;
function consume(budget: BudgetContext, key: keyof ReturnType<BudgetContext['usage']>, remaining: number) {
  const amount = budget.limits[key] - budget.usage()[key] - remaining;
  if (key === 'work') budget.spend(amount); else budget.reserve({ [key]: amount });
}
// Synthetic sentinels arm AFTER the real source emitter has appended and returned.
// This is deliberately not a source-path-sort or source factory-entry sentinel.
function rawSeam(budget: BudgetContext, action: (entry: any, source: any, output: ReturnType<typeof realCreate>) => void) {
  const push = Array.prototype.push, entries: any[] = [], seen = new Set<any>(); let armed = false;
  Array.prototype.push = function(...items: any[]) {
    for (const e of items) if (e && typeof e === 'object' && !seen.has(e) && Array.isArray(e.errors) && Array.isArray(e.targets) && e.source) {
      seen.add(e); push.call(entries, e);
    }
    return push.apply(this, items);
  };
  const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(context => {
    expect(context).toBe(budget); const output = realCreate(context);
    return { ...output, conflict: (list, factory) => output.conflict(list, factory), sourceRecord(list, quarantine, factory) {
      output.sourceRecord(list, quarantine, factory);
      if (!armed && quarantine) {
        const source = list[list.length - 1] as any;
        const entry = entries.find(e => e.source === source.source);
        if (!entry) throw new Error('raw seam did not find original Entry');
        armed = true; action(entry, source, output);
      }
    } };
  });
  return () => { spy.mockRestore(); Array.prototype.push = push; };
}
function execute(budget: BudgetContext, action: Parameters<typeof rawSeam>[1]) {
  const input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
  const restore = rawSeam(budget, action);
  let error: unknown, result: any;
  try { result = run(input, budget); } catch (e) { error = e; } finally { restore(); }
  return { error, result };
}
const sheet = { kind: 'SHEET', artifactDigest: 'a'.repeat(64), tab: 'Students', rowNumber: 2, rowHash: 'row-한글😀\ud800' };
const redis = { kind: 'REDIS', artifactDigest: 'b'.repeat(64), provenance: 'claim.한글😀\ud800', sourceDigest: 'redis-선택\u0000' };

describe('executed original Git raw append and source/Entry identity oracle', () => {
  for (const enabled of [false, true]) for (const f of golden.cases) it(`${f.name} budget=${enabled}`, () => {
    const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
    const actual = observe(i => run(i, budget), budget ? parseRegisteredBoundedJson(JSON.stringify(f.input), budget) : clone(f.input));
    // Check before final JSON: final dedup can hide changed raw multiplicity.
    expect(actual.diagnostics).toEqual(f.outcome.diagnostics);
    expect(actual.raw).toEqual(f.outcome.raw); expect(actual.received).toEqual(f.outcome.received);
    expect(actual.sources).toEqual(f.outcome.sources); expect(actual).toEqual(f.outcome);
  });
});

describe('raw code preparation pre-admission', () => {
  for (const key of ['nodes', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`${key} delta=${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), stop = new RangeError('raw errors'); let reached = 0, calls = 0;
    const cost = { nodes: 2, structuralBytes: 32, work: 2 };
    const { error } = execute(budget, e => {
      calls++; consume(budget, key, cost[key] + delta);
      Object.defineProperty(e, 'errors', { get() { reached++; throw stop; } });
    });
    expect(calls).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('independent raw loop predecessor and fixed shell admission', () => {
  // At returned code index: length-test1 and index/visit2 have already been paid.
  // No path allocation/hash cost belongs to this closed 5/6/112/8 shell.
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`${key} delta=${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), stop = new RangeError('raw source');
    let armed = false, sorted = 0, reads = 0; const cost = { nodes: 5, slots: 6, structuralBytes: 112, work: 8 };
    const real = workModule.stableBudgetSort;
    const spy = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((values: any, cmp: any, context?: BudgetContext): any => {
      const result = real(values, cmp, context);
      if (armed) { sorted++; expect(context).toBe(budget); const code = result[0]; Object.defineProperty(result, '0', { get() { consume(budget, key, cost[key] + delta); return code; } }); }
      return result;
    });
    let error: unknown;
    try { ({ error } = execute(budget, e => { armed = true; e.errors = ['Z']; Object.defineProperty(e, 'source', { get() { reads++; throw stop; } }); })); }
    finally { spy.mockRestore(); }
    expect(sorted).toBe(1); expect(reads).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('raw code scratch distinct allocation and cumulative work', () => {
  for (const codes of [[], ['Z'], ['Z', 'A'], ['Z', 'Z', 'A'], ['x'.repeat(513), 'A', 'x'.repeat(513)]]) it(JSON.stringify(codes), () => {
    const budget = createBudgetContext({ now: () => 0 }), stop = new RangeError('sort returned'); let armed = false, before: any, delta: any, actual: any;
    const real = workModule.stableBudgetSort;
    const spy = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((values: any, cmp: any, context?: BudgetContext): any => {
      const result = real(values, cmp, context);
      if (armed) { actual = result; delta = Object.fromEntries(Object.entries(budget.usage()).map(([k, v]) => [k, v - before[k]])); throw stop; }
      return result;
    });
    let error: unknown;
    try { ({ error } = execute(budget, e => { e.errors = [...codes]; armed = true; before = budget.usage(); })); } finally { spy.mockRestore(); }
    const u = new Set(codes).size;
    expect(error).toBe(stop); expect(actual).toEqual([...new Set(codes)].sort());
    expect(delta).toMatchObject({ nodes: 5 + u, slots: 5 * u, structuralBytes: 80 + 24 * u, contentBytes: 0 });
    expect(delta.work).toBeGreaterThanOrEqual(3 + codes.length * 5 + u * 6);
  });
});

describe('raw operands immediate completion and original error priority', () => {
  for (const kind of ['SHEET', 'REDIS']) for (const field of (kind === 'SHEET' ? ['pathSource', 'pathKind', 'tab', 'rowNumber', 'digestSource', 'digestKind', 'rowHash'] : ['pathSource', 'pathKind', 'provenance', 'pathDigest', 'digestSource', 'digestKind', 'selectedDigest']))
    for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`${kind} ${field} ${state} ${exit}`, () => {
      let now = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
      const errorObject = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('raw operand');
      const stop = new RangeError('hash reached'); const trace: string[] = []; let hash = 0, sourceReads = 0;
      const all = kind === 'SHEET' ? ['pathSource', 'pathKind', 'tab', 'rowNumber', 'digestSource', 'digestKind', 'rowHash'] : ['pathSource', 'pathKind', 'provenance', 'pathDigest', 'digestSource', 'digestKind', 'selectedDigest'];
      let armed = false;
      const saved = validatorsModule.sha256;
      const hashSpy = vi.spyOn(validatorsModule, 'sha256').mockImplementation((v, b) => { if (armed) { hash++; throw stop; } return saved(v, b); });
      const nativeString = String; let numberCalls = 0;
      globalThis.String = new Proxy(nativeString, { apply(target, receiver, args) {
        if (armed && args[0] === sheet.rowNumber) numberCalls++;
        return Reflect.apply(target, receiver, args);
      } });
      let caught: unknown;
      function visit(label: string, value: any) {
        trace.push(label);
        if (label === field) { if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw errorObject; }
        return value;
      }
      try { ({ error: caught } = execute(budget, e => {
        armed = true; e.errors = ['Z'];
        const p: any = {}, d: any = {};
        Object.defineProperty(p, 'kind', { get: () => visit('pathKind', kind) }); Object.defineProperty(d, 'kind', { get: () => visit('digestKind', kind) });
        if (kind === 'SHEET') {
          Object.defineProperty(p, 'tab', { get: () => visit('tab', sheet.tab) }); Object.defineProperty(p, 'rowNumber', { get: () => visit('rowNumber', sheet.rowNumber) });
          Object.defineProperty(d, 'rowHash', { get: () => visit('rowHash', sheet.rowHash) });
        } else {
          Object.defineProperty(p, 'provenance', { get: () => visit('provenance', redis.provenance) }); Object.defineProperty(p, 'sourceDigest', { get: () => visit('pathDigest', redis.sourceDigest) });
          Object.defineProperty(d, 'sourceDigest', { get: () => visit('selectedDigest', redis.sourceDigest) });
        }
        Object.defineProperty(e, 'source', { get() { sourceReads++; return visit(sourceReads === 1 ? 'pathSource' : 'digestSource', sourceReads === 1 ? p : d); } });
      })); } finally { hashSpy.mockRestore(); globalThis.String = nativeString; }
      const complete = state === 'timely' && exit === 'success';
      expect(numberCalls).toBe(kind === 'SHEET' && (complete || all.indexOf(field) > all.indexOf('rowNumber')) ? 1 : 0);
      expect(trace).toEqual(complete ? all : all.slice(0, all.indexOf(field) + 1)); expect(hash).toBe(complete ? 1 : 0);
      if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(errorObject);
      else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
      else expect(caught).toBe(complete ? stop : errorObject);
    });
});

describe('Sheet five and Redis two separately pre-reserved string frames', () => {
  for (const kind of ['SHEET', 'REDIS']) for (const frame of (kind === 'SHEET' ? [0, 1, 2, 3, 4] : [0, 1])) for (const key of ['nodes', 'structuralBytes', 'contentBytes'] as const) for (const offset of [-1, 0, 1]) it(`${kind} frame=${frame} ${key} delta=${offset}`, () => {
    let armed = false, calls = 0, reached = 0, rowReads = 0; const stop = new RangeError('admitted frame'), base = createBudgetContext({ now: () => 0 });
    const pointer = kind === 'SHEET' ? sheet : redis;
    const t = Buffer.byteLength(sheet.tab), p = Buffer.byteLength(redis.provenance), d = Buffer.byteLength(redis.sourceDigest);
    const frames = kind === 'SHEET' ? [t + 1, 32, 32, t + 33, t + 34] : [p + 1, p + 1 + d];
    const budget: BudgetContext = { ...base, reserveString(bytes) {
      if (armed && calls++ === frame) {
        reached++; expect(bytes).toBe(frames[frame]);
        consume(base, key, (key === 'nodes' ? 1 : key === 'structuralBytes' ? 4 : frames[frame]) + offset);
        base.reserveString(bytes); throw stop;
      }
      base.reserveString(bytes);
    } };
    const { error } = execute(budget, e => {
      e.errors = ['Z']; e.source = { ...pointer }; armed = true;
      if (kind === 'SHEET') Object.defineProperty(e.source, 'rowNumber', { get() { rowReads++; return sheet.rowNumber; } });
    });
    expect(reached).toBe(1); expect(calls).toBe(frame + 1);
    if (kind === 'SHEET' && frame <= 1) expect(rowReads).toBe(0);
    if (offset < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('raw path and selected digest exact semantics, synthetic typed pointers', () => {
  for (const tab of ['A', '한글😀\ud800\u0000.[', 'x'.repeat(257)]) for (const rowNumber of [1, 123456789, 1234567890, -1.2345678901234567e-100]) it(`Sheet ${JSON.stringify(tab)} ${rowNumber}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), stop = new RangeError('raw append'); const saved = Array.prototype.push;
    let armed = false, value: any, reads = 0; const hashes: any[] = [], real = validatorsModule.sha256;
    const hashSpy = vi.spyOn(validatorsModule, 'sha256').mockImplementation((v, b) => { if (armed) hashes.push([v, b]); return real(v, b); });
    const wrapper = function(this: any[], ...items: any[]) { for (const d of items) if (armed && d?.code === 'Z' && d.path) { value = d; throw stop; } return saved.apply(this, items); };
    Array.prototype.push = wrapper;
    let error: unknown;
    try { ({ error } = execute(budget, e => { e.errors = ['Z']; armed = true; Object.defineProperty(e, 'source', { get() { reads++; return reads === 1 ? { ...sheet, tab, rowNumber } : { ...redis, sourceDigest: 'DIFFERENT\ud800' }; } }); })); }
    finally { Array.prototype.push = saved; hashSpy.mockRestore(); }
    expect(error).toBe(stop); expect(reads).toBe(2); expect(hashes).toEqual([['DIFFERENT\ud800', budget]]);
    expect(value).toEqual({ code: 'Z', path: `${tab}[${String(rowNumber).padStart(9, '0')}]`, sourceDigest: real('DIFFERENT\ud800') });
  });
});

describe('reached raw native caller completion matrix', () => {
  for (const kind of ['SHEET', 'REDIS']) {
    const stages = kind === 'SHEET' ? ['has', 'add', 'String', 'padLookup', 'padStart', 'createHash', 'updateLookup', 'update', 'digestLookup', 'digest', 'push'] : ['has', 'add', 'createHash', 'updateLookup', 'update', 'digestLookup', 'digest', 'push'];
    for (const stage of stages.filter(s => s !== 'updateLookup' && s !== 'digestLookup')) for (const state of ['timely', 'expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`${kind} ${stage} ${state} ${exit}`, () => {
      let now = 0, armed = false; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
      const errorObject = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('raw native');
      const stop = new RangeError('next source'); const trace: string[] = []; let reached = 0, sourceReads = 0, hashReturns = 0;
      const push = Array.prototype.push, has = Set.prototype.has, add = Set.prototype.add, nativeString = String;
      const pad = Object.getOwnPropertyDescriptor(String.prototype, 'padStart')!;
      function visit(label: string) { push.call(trace, label); if (stage === label) { reached++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw errorObject; } }
      Set.prototype.has = function(value) { const result = has.call(this, value); if (armed && value === 'Z') visit('has'); return result; };
      Set.prototype.add = function(value) { const result = add.call(this, value); if (armed && value === 'Z') visit('add'); return result; };
      globalThis.String = new Proxy(nativeString, { apply(target, receiver, args) { const result = Reflect.apply(target, receiver, args); if (armed && args[0] === 2) visit('String'); return result; } });
      Object.defineProperty(nativeString.prototype, 'padStart', { configurable: true, get() { if (armed && nativeString(this) === '2') visit('padLookup'); return function(this: string, ...args: any[]) { const result = pad.value.apply(this, args); if (armed && nativeString(this) === '2') visit('padStart'); return result; }; } });
      const boundSHA = nativeBoundSHA((...args: Parameters<typeof nativeCreateHash>): any => {
        const hash = nativeCreateHash(...args); if (!armed) return hash;
        visit('createHash'); const update = hash.update, digest = hash.digest;
        Object.defineProperty(hash, 'update', { get() { visit('updateLookup'); return function(...values: any[]) { const result = (update as any).apply(hash, values); visit('update'); return result; }; } });
        Object.defineProperty(hash, 'digest', { get() { visit('digestLookup'); return function(...values: any[]) { const result = (digest as any).apply(hash, values); visit('digest'); return result; }; } });
        return hash;
      });
      const savedSHA = validatorsModule.sha256;
      const hashSpy = vi.spyOn(validatorsModule, 'sha256').mockImplementation((v, b) => {
        const result = armed ? boundSHA(v, b) : savedSHA(v, b);
        if (armed) hashReturns++;
        return result;
      });
      Array.prototype.push = function(...items: any[]) { const result = push.apply(this, items); if (armed && items.some(d => d?.code === 'Z' && d.path)) { visit('push'); throw stop; } return result; };
      let caught: unknown;
      try { ({ error: caught } = execute(budget, e => { armed = true; e.errors = ['Z']; Object.defineProperty(e, 'source', { get() { sourceReads++; return kind === 'SHEET' ? sheet : redis; } }); })); }
      finally { armed = false; hashSpy.mockRestore(); globalThis.String = nativeString; Object.defineProperty(nativeString.prototype, 'padStart', pad); Set.prototype.has = has; Set.prototype.add = add; Array.prototype.push = push; }
      const complete = state === 'timely' && exit === 'success';
      expect(reached, JSON.stringify({ trace, caught: String(caught) })).toBe(1); expect(trace, String(caught)).toEqual(complete ? stages : stages.slice(0, stages.indexOf(stage) + 1));
      expect(hashReturns).toBe(complete || stage === 'push' ? 1 : 0);
      if (['has', 'add'].includes(stage) && !complete) expect(sourceReads).toBe(0);
      if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(errorObject);
      else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
      else expect(caught).toBe(complete ? stop : errorObject);
    });
  }
});

describe('raw append completion prohibits next code source operand, no rollback', () => {
  for (const state of ['expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`${state} ${exit}`, () => {
    let now = 0, armed = false; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
    const errorObject = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('append');
    const push = Array.prototype.push; let appends = 0, reads = 0, receiver: any[], before: any, after: any;
    Array.prototype.push = function(...items: any[]) {
      const result = push.apply(this, items);
      if (armed && items.some(d => d?.code === 'A' && d.path)) {
        receiver = this; appends++; before = budget.usage(); if (state === 'expired') now = 5000; else signal.aborted = true;
        if (exit !== 'success') throw errorObject;
      }
      return result;
    };
    let error: unknown;
    try { ({ error } = execute(budget, e => { armed = true; e.errors = ['Z', 'A']; Object.defineProperty(e, 'source', { get() { reads++; return sheet; } }); })); after = budget.usage(); }
    finally { Array.prototype.push = push; }
    expect(appends).toBe(1); expect(reads).toBe(2); expect(receiver!.filter(d => d.code === 'A')).toHaveLength(1); expect(after).toEqual(before);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(errorObject); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});

describe('real same-owner categories: source once, code once, raw zero, final once', () => {
  for (const allowance of [0, 1, 2]) it(`after source/error admission allowance=${allowance}`, () => {
    const budget = createBudgetContext({ now: () => 0 }); let raw = 0, reached = 0, attempts = 0, factories = 0, armed = false;
    const push = Array.prototype.push;
    Array.prototype.push = function(...items: any[]) {
      if (armed && items.some(d => d?.code === 'Z' && d.path) && new Error().stack?.includes('pushDiagnostics')) raw++;
      return push.apply(this, items);
    };
    let error: unknown;
    try { ({ error } = execute(budget, (e, s, output) => {
      reached++; armed = true; e.errors = ['Z', 'Z'];
      const used = 1 + s.errorCodes.length;
      const sink: unknown[] = [];
      for (let i = used; i < 8000 - allowance; i++) output.conflict(sink, () => null);
      const original = output.conflict;
      output.conflict = (list, factory) => { attempts++; return original(list, () => { factories++; return factory(); }); };
    })); } finally { Array.prototype.push = push; }
    expect(reached).toBe(1); expect(raw).toBe(1);
    expect(factories).toBe(allowance); expect(attempts).toBe(allowance + 1);
    expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

// Narrow read-only transform of the REAL function and its REAL local counter.
// It inserts a callback after the source emitter, not a copied pushDiagnostics.
// Synthetic prefill is explicitly not natural input reachability at the cap.
function capacityNormalizer(callback: (...args: any[]) => void, nativeBoundary?: (budget: BudgetContext | undefined, operation: () => any) => any) {
  const code = readFileSync('src/server/migration/normalize.ts', 'utf8');
  const anchor = 'else sourceRecords.push(toSourceRecord(entry));';
  if (code.split(anchor).length !== 5) throw new Error('capacity source anchor changed');
  const transformed = code.replace(anchor, `${anchor}\ncapacity(pushDiagnostics, warnings, conflicts, entry, () => diagnosticCount);`)
    .replace('try { const result = operation(); budget?.check(); return result; }', 'try { const result = nativeBoundary ? nativeBoundary(budget, operation) : operation(); budget?.check(); return result; }');
  const js = tsModule.transpileModule(transformed, { compilerOptions: { module: tsModule.ModuleKind.CommonJS, target: tsModule.ScriptTarget.ESNext } }).outputText;
  const dependencies: Record<string, any> = { './operationalProjection': projectionModule, './normalizationOutput': outputModule, '@/server/sheetsRows': rowsModule, './semanticValidators': semanticModule, '@/lib/boundedJson': boundedModule, '@/lib/boundedWork': workModule, './validators': validatorsModule };
  const loaded = { exports: {} as any };
  new Function('require', 'module', 'exports', 'capacity', 'nativeBoundary', js)((id: string) => { if (!(id in dependencies)) throw Error(`unexpected dependency ${id}`); return dependencies[id]; }, loaded, loaded.exports, callback, nativeBoundary);
  return loaded.exports.normalizeLegacySnapshots as typeof run;
}

describe('real raw4096 closure capacity and argument ordering, synthetic prefill', () => {
  for (const warningCount of [0, 1, 4095, 4096]) for (const existing of [4095, 4096].filter(n => warningCount <= n)) for (const failure of ['none', 'source', 'hash', 'budget', 'unavailable']) it(`warnings=${warningCount} existing=${existing} failure=${failure}`, () => {
    const budget = createBudgetContext({ now: () => 0 }); const input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
    const stop = new RangeError('actual append'), sourceError = new RangeError('raw source'), hashError = new RangeError('raw hash');
    const budgetError = new BudgetExceededError(), unavailable = new BudgetUnavailableError();
    let armed = false, reached = 0, reads = 0, hashes = 0, appends = 0, counter: (() => number) | undefined, usage: any;
    const savedHash = validatorsModule.sha256;
    const spy = vi.spyOn(validatorsModule, 'sha256').mockImplementation((v, b) => { if (armed) { hashes++; if (failure === 'hash') throw hashError; } return savedHash(v, b); });
    const push = Array.prototype.push;
    Array.prototype.push = function(...items: any[]) { if (armed && items.some(d => d?.code === 'Z' && d.path)) { appends++; push.apply(this, items); throw stop; } return push.apply(this, items); };
    const invoke = capacityNormalizer((emit, warnings, conflicts, entry, count) => {
      if (armed) throw Error('second capacity callback'); reached++; counter = count;
      const initial = count(); if (initial > existing) throw Error('unexpected initial raw count');
      const d = { code: 'prefill', path: 'same', sourceDigest: 'same' };
      for (let i = initial; i < existing; i++) emit(i < warningCount ? warnings : conflicts, d);
      entry.errors = ['Z']; const source = entry.source;
      Object.defineProperty(entry, 'source', { get() { reads++; if (failure === 'source') throw sourceError; if (failure === 'budget') throw budgetError; if (failure === 'unavailable') throw unavailable; return source; } });
      usage = budget.usage(); armed = true;
    });
    let error: unknown;
    try { invoke(input, budget); } catch (e) { error = e; } finally { spy.mockRestore(); Array.prototype.push = push; }
    expect(reached).toBe(1); expect(reads).toBe(failure === 'source' || failure === 'budget' || failure === 'unavailable' ? 1 : 2);
    expect(hashes).toBe(failure === 'source' || failure === 'budget' || failure === 'unavailable' ? 0 : 1);
    expect(appends).toBe(existing === 4095 && failure === 'none' ? 1 : 0);
    expect(counter!()).toBe(existing === 4095 && failure === 'none' ? 4096 : existing);
    if (failure !== 'none') expect(error).toBe(failure === 'source' ? sourceError : failure === 'hash' ? hashError : failure === 'budget' ? budgetError : unavailable);
    else if (existing === 4095) expect(error).toBe(stop);
    else expect((error as Error).message).toBe('Legacy migration output exceeds normalization bounds.');
    for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) expect(budget.usage()[key]).toBeGreaterThanOrEqual(usage[key]);
  });
});

describe('string frames work is code-unit based, independently of UTF8 reservations', () => {
  for (const kind of ['SHEET', 'REDIS']) for (const frame of (kind === 'SHEET' ? [0, 1, 2, 3, 4] : [0, 1])) for (const delta of [-1, 0, 1]) it(`${kind} frame=${frame} delta=${delta}`, () => {
    const base = createBudgetContext({ now: () => 0 }), stop = new RangeError('frame work'); let armed = false, frameIndex = 0, selected = false, spends = 0;
    const pointer = kind === 'SHEET' ? { ...sheet, tab: '한'.repeat(255) } : { ...redis, provenance: '한'.repeat(255) };
    // Prefix input includes its one ASCII separator. Number formatting fixed1;
    // pad input text1; body input prefix256+padded9; close body265+bracket1.
    const costs = kind === 'SHEET' ? [2, 1, 2, 3, 3] : [2, 1 + Math.ceil((256 + redis.sourceDigest.length) / 256)];
    const budget: BudgetContext = { ...base, reserveString(bytes) { base.reserveString(bytes); if (armed && frameIndex++ === frame) { selected = true; consume(base, 'work', costs[frame] + delta); } }, spend(amount = 1) { if (selected) { spends++; expect(amount).toBe(costs[frame]); base.spend(amount); throw stop; } base.spend(amount); } };
    const { error } = execute(budget, e => { e.errors = ['Z']; e.source = pointer; armed = true; });
    expect(frameIndex).toBe(frame + 1); expect(spends).toBe(1);
    if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('raw string maximum claims and strict selected-call ceiling controls', () => {
  // A global32 cap would reject pre-existing64 digest input before this seam.
  // These stricter selected-call sentinels audit the supplied bound, not natural
  // whole-request reachability at an independently lowered per-string limit.
  for (const rowNumber of [2, Number.MIN_VALUE, Number.MAX_VALUE, -1.2345678901234567e-100]) for (const frame of [1, 2]) for (const cap of [31, 32, 33]) it(`Number=${rowNumber} frame=${frame} cap=${cap}`, () => {
    const base = createBudgetContext({ now: () => 0 }), stop = new RangeError('bounded Number'); let armed = false, frames = 0, hit = 0;
    const budget: BudgetContext = { ...base, reserveString(bytes) {
      if (armed && frames++ === frame) { hit++; expect(bytes).toBe(32); if (bytes > cap) throw new BudgetExceededError(); base.reserveString(bytes); throw stop; }
      base.reserveString(bytes);
    } };
    const { error } = execute(budget, e => { e.errors = ['Z']; e.source = { ...sheet, rowNumber }; armed = true; });
    expect(hit).toBe(1); if (cap < 32) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
});

describe('raw code retrieval and stable comparator completion', () => {
  for (const seam of ['errors', 'index', 'compare', 'sortedIndex']) for (const state of ['expired', 'aborted']) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable']) it(`${seam} ${state} ${exit}`, () => {
    let now = 0, armed = false, hit = 0, reads = 0; const signal = { aborted: false }, budget = createBudgetContext({ now: () => now, signal });
    const errorObject = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('scratch');
    function visit<T,>(value: T): T { hit++; if (state === 'expired') now = 5000; else signal.aborted = true; if (exit !== 'success') throw errorObject; return value; }
    const compare = validatorsModule.compareCodeUnits, sort = workModule.stableBudgetSort;
    const cmp = vi.spyOn(validatorsModule, 'compareCodeUnits').mockImplementation((a, b, ctx) => { const value = compare(a, b, ctx); return armed && seam === 'compare' ? visit(value) : value; });
    const sorted = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((values: any, comparator: any, ctx?: BudgetContext): any => {
      const result = sort(values, comparator, ctx);
      if (armed && seam === 'sortedIndex') { const v = result[0]; Object.defineProperty(result, '0', { get: () => visit(v) }); }
      return result;
    });
    let error: unknown;
    try { ({ error } = execute(budget, e => {
      const codes = ['Z', 'A']; armed = true;
      if (seam === 'index') Object.defineProperty(codes, '0', { get: () => visit('Z') });
      Object.defineProperty(e, 'errors', { get: () => seam === 'errors' ? visit(codes) : codes });
      Object.defineProperty(e, 'source', { get() { reads++; return sheet; } });
    })); } finally { cmp.mockRestore(); sorted.mockRestore(); }
    expect(hit).toBe(1); expect(reads).toBe(0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(error).toBe(errorObject); else expect(error).toBeInstanceOf(BudgetUnavailableError);
  });
});

// RAW_NATIVE_ORACLE_BEGIN
function rawNativeOracle(normalize: (input: any) => any, input: any, scenario: any, hooked: boolean) {
  const push = Array.prototype.push, sort = Array.prototype.sort, nativeString = String;
  const pad = Object.getOwnPropertyDescriptor(String.prototype, 'padStart')!;
  const entries: any[] = [], trace: string[] = [], diagnostics: any[] = [];
  let armed = false, sourceReads = 0, error: any; const stop = new RangeError('raw oracle stop');
  function visit(label: string, value: any) { push.call(trace, label); if (scenario.probe === label) throw stop; return value; }
  const pointer = scenario.pointer;
  function instrument(e: any) {
    const values = scenario.codes; Object.defineProperty(e, 'errors', { configurable: true, get: () => visit('errors', values) });
    Object.defineProperty(e, 'source', { configurable: true, get() {
      sourceReads++; const source = sourceReads % 2 ? pointer : scenario.selected;
      visit('source', source);
      const result: any = {};
      for (const k of ['kind', 'tab', 'rowNumber', 'rowHash', 'provenance', 'sourceDigest']) Object.defineProperty(result, k, { get: () => visit(k, source[k]) });
      return result;
    } });
  }
  Array.prototype.push = function(...items: any[]) {
    if (!armed) for (const e of items) if (e && Array.isArray(e.errors) && Array.isArray(e.targets) && !entries.includes(e)) push.call(entries, e);
    const result = push.apply(this, items);
    for (const item of items) {
      if (!armed && item?.mappingStatus === 'QUARANTINED') {
        const entry = entries.find(e => e.source === item.source); if (!entry) throw Error('oracle raw Entry missing');
        instrument(entry); armed = true;
      } else if (armed && item && typeof item.code === 'string' && typeof item.path === 'string') {
        push.call(diagnostics, { ...item }); visit('push', item);
        if (diagnostics.length === new Set(scenario.codes).size) throw stop;
      }
    }
    return result;
  };
  Array.prototype.sort = function(compare?: any): any { if (armed) visit('sort', null); return sort.call(this, compare); };
  globalThis.String = new Proxy(nativeString, { apply(target, receiver, args) { if (armed) visit('String', args[0]); return Reflect.apply(target, receiver, args); } });
  Object.defineProperty(nativeString.prototype, 'padStart', { configurable: true, get() { if (armed) visit('padLookup', null); return function(this: string, ...args: any[]) { if (armed) visit('padStart', null); return pad.value.apply(this, args); }; } });
  try { if (hooked) observe(normalize, input, true, undefined, push); else normalize(input); } catch (e) { error = e; }
  finally { armed = false; Array.prototype.push = push; Array.prototype.sort = sort; globalThis.String = nativeString; Object.defineProperty(nativeString.prototype, 'padStart', pad); }
  return { trace, diagnostics, sourceReads, identity: error === stop };
}
// RAW_NATIVE_ORACLE_END

describe('original Git no-budget raw getter/native ordering and two distinct source reads', () => {
  const cases = (golden as any).rawNative as any[];
  for (const f of cases) for (const hooked of [false, true]) it(`${f.name} hook=${hooked}`, () => {
    expect(rawNativeOracle(run, clone(f.input), f.scenario, hooked)).toEqual(f.outcome);
  });
});

// SUPPLEMENTAL_RAW_NATIVE_BEGIN
// Same observer runs against executed Git modules and the current no-budget caller.
// Only the real raw Set/array/crypto receiver is instrumented; no global iterator spy.
function supplementalRawNativeOracle(normalize: (input: any) => any, input: any, scenario: any, hooked: boolean,
  withFactory: (factory: typeof nativeCreateHash, invoke: () => any) => any, createHash: typeof nativeCreateHash) {
  const savedPush = Array.prototype.push, savedSort = Array.prototype.sort, NativeSet = Set, NativeString = String;
  const padDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'padStart')!;
  const trace: string[] = [], diagnostics: any[] = [], entries: any[] = [];
  const stop = new RangeError('supplemental raw oracle stop');
  let armed = false, sourceReads = 0, error: any, appendReturns = 0, inspecting = false, rawReceiver: any;
  const codes = [...scenario.codes], distinct = new NativeSet(codes).size;
  function visit(label: string) { savedPush.call(trace, label); if (scenario.probe === label) throw stop; }
  function iteratorView(iterator: any, prefix: string) {
    return { next() { visit(prefix + 'Next'); return iterator.next(); } };
  }
  // An own iterator only on this test-owned raw code operand, not Array.prototype.
  const codeIterator = codes[Symbol.iterator];
  Object.defineProperty(codes, Symbol.iterator, { get() {
    visit('codesIteratorLookup'); return function(this: string[]) { visit('codesIteratorCall'); return iteratorView(codeIterator.call(this), 'codesIterator'); };
  } });
  function instrument(entry: any) {
    Object.defineProperty(entry, 'errors', { configurable: true, get() { visit('errors'); return codes; } });
    Object.defineProperty(entry, 'source', { configurable: true, get() {
      visit('source'); sourceReads++;
      const source = sourceReads % 2 ? scenario.pointer : scenario.selected, pointer: any = {};
      for (const key of ['kind', 'tab', 'rowNumber', 'rowHash', 'provenance', 'sourceDigest']) Object.defineProperty(pointer, key, { get() { visit(key); return source[key]; } });
      return pointer;
    } });
  }
  const factory = ((...args: Parameters<typeof createHash>) => {
    if (!armed) return createHash(...args);
    visit('createHash'); const hash = createHash(...args); visit('createHashReturn');
    const proxy = new Proxy(hash, { get(target, key) {
      if (key === 'update') {
        visit('updateLookup'); const update = target.update;
        return (...values: any[]) => { visit('updateCall'); Reflect.apply(update, target, values); visit('updateReturn'); return proxy; };
      }
      if (key === 'digest') {
        visit('digestLookup'); const digest = target.digest;
        return (...values: any[]) => { visit('digestCall'); const value = Reflect.apply(digest, target, values); visit('digestReturn'); return value; };
      }
      return Reflect.get(target, key, target);
    } });
    return proxy;
  }) as typeof createHash;
  function invoke(value: any) {
    const forwardPush = Array.prototype.push;
    const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!;
    const rawPush = function(this: any[], ...items: any[]) {
      if (!armed) for (const entry of items) if (entry && Array.isArray(entry.errors) && Array.isArray(entry.targets) && !entries.includes(entry)) savedPush.call(entries, entry);
      const isRaw = armed && items.some(item => item && typeof item.code === 'string' && typeof item.path === 'string' && typeof item.sourceDigest === 'string');
      if (isRaw) visit('pushCall');
      const result = forwardPush.apply(this, items);
      if (isRaw) {
        appendReturns++; for (const item of items) savedPush.call(diagnostics, { ...item }); visit('pushReturn');
        if (appendReturns === distinct) throw stop;
      }
      if (!armed) for (const item of items) if (item?.mappingStatus === 'QUARANTINED') {
        const entry = entries.find(e => e.source === item.source);
        if (!entry) throw new Error('supplemental raw Entry missing');
        instrument(entry); armed = true; break;
      }
      return result;
    };
    try {
      Object.defineProperty(Array.prototype, 'push', { configurable: true, get() {
        // The first lookup discovers the actual private conflict receiver; later
        // lookups are observed on that receiver itself. Stack inspection is guarded.
        if (armed && !rawReceiver && !inspecting) {
          inspecting = true; let raw = false;
          try { raw = !!new Error().stack?.includes('pushDiagnostics'); } finally { inspecting = false; }
          if (raw) {
            visit('pushLookup'); rawReceiver = this;
            Object.defineProperty(this, 'push', { configurable: true, get() { visit('pushLookup'); return rawPush; } });
          }
        }
        return rawPush;
      } });
      globalThis.Set = new Proxy(NativeSet, { construct(target, args) {
        if (!armed || args[0] !== codes) return Reflect.construct(target, args);
        visit('SetConstructor'); const set = Reflect.construct(target, args); visit('SetReturn');
        const iterator = NativeSet.prototype[Symbol.iterator];
        Object.defineProperty(set, Symbol.iterator, { get() { visit('setIteratorLookup'); return function(this: Set<string>) { visit('setIteratorCall'); return iteratorView(iterator.call(this), 'setIterator'); }; } });
        return set;
      } });
      Array.prototype.sort = function(compare?: any): any {
        if (!armed || !this.length || !this.every((v: any) => typeof v === 'string' && codes.includes(v))) return savedSort.call(this, compare);
        visit('sort'); const result = savedSort.call(this, (a: string, b: string) => { visit('comparator'); return compare(a, b); }); visit('sortReturn'); return result;
      };
      globalThis.String = new Proxy(NativeString, { apply(target, receiver, args) { if (armed) visit('String'); const result = Reflect.apply(target, receiver, args); if (armed) visit('StringReturn'); return result; } });
      Object.defineProperty(NativeString.prototype, 'padStart', { configurable: true, get() {
        if (armed) visit('padLookup'); return function(this: string, ...args: any[]) { if (armed) visit('padStart'); const result = padDescriptor.value.apply(this, args); if (armed) visit('padReturn'); return result; };
      } });
      return withFactory(factory, () => normalize(value));
    } finally {
      armed = false; if (rawReceiver) delete rawReceiver.push; Object.defineProperty(Array.prototype, 'push', pushDescriptor); Array.prototype.sort = savedSort;
      globalThis.Set = NativeSet; globalThis.String = NativeString; Object.defineProperty(NativeString.prototype, 'padStart', padDescriptor);
    }
  }
  try { if (hooked) observe(invoke, input, true, undefined, savedPush); else invoke(input); } catch (e) { error = e; }
  return { trace, diagnostics, sourceReads, appendReturns, identity: error === stop, errorName: error?.name, errorMessage: error?.message };
}
// SUPPLEMENTAL_RAW_NATIVE_END

describe('supplemental executed original Git raw native lookup/call/stop oracle', () => {
  for (const f of (golden as any).supplementalRawNative as any[]) for (const hooked of [false, true]) it(`${f.name} hook=${hooked}`, () => {
    const withFactory = (factory: typeof nativeCreateHash, invoke: () => any) => {
      const spy = vi.spyOn(validatorsModule, 'sha256').mockImplementation(nativeBoundSHA(factory));
      try { return invoke(); } finally { spy.mockRestore(); }
    };
    const actual = supplementalRawNativeOracle(run, clone(f.input), f.scenario, hooked, withFactory, nativeCreateHash);
    expect(actual).toEqual(f.outcome);
    if (f.scenario.probe === 'success') {
      const previous = (golden as any).rawNative.find((c: any) => c.name === f.name);
      expect(f.scenario).toEqual(previous.scenario);
      expect(actual.diagnostics).toEqual(previous.outcome.diagnostics);
      expect(actual.sourceReads).toBe(previous.outcome.sourceReads);
    }
  });
});

// Post-implementation SPEC B1 strengthening; not retroactive chronological RED.
describe('SPEC earliest successor lookup controls', () => {
  const names = ['digest-kind-check', 'number-check', 'pad-call-check', 'path-digest-check', 'path-kind-check', 'provenance-check', 'raw-push-completion', 'tab-check'];
  for (const name of names) for (const state of ['timely', 'expired', 'aborted']) it(`${name} ${state}`, () => {
    let now = 0, armed = false, hit = 0, reads = 0;
    const signal = { aborted: false }, base = createBudgetContext({ now: () => now, signal });
    const trace: string[] = [], push = Array.prototype.push, nativeString = String, pad = String.prototype.padStart;
    const stop = new RangeError('earliest successor');
    const note = (label: string) => { if (hit) { push.call(trace, label); if (state === 'timely') throw stop; } };
    const trigger = () => { hit++; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; };
    // Delegate to the real same-request frozen context; never redefine base.
    const budget: BudgetContext = { ...base };
    for (const key of ['spend', 'reserveString'] as const) Object.defineProperty(budget, key, { get() { note(key + ' lookup'); return base[key]; } });
    const equal = workModule.equalBudgetValue, utf8 = workModule.utf8ByteLength;
    const equalSpy = vi.spyOn(workModule, 'equalBudgetValue').mockImplementation((...args) => { note('equal invocation'); return equal(...args); });
    const utf8Spy = vi.spyOn(workModule, 'utf8ByteLength').mockImplementation((...args) => { note('utf8 invocation'); return utf8(...args); });
    globalThis.String = new Proxy(nativeString, { apply(target, receiver, args) { const value = Reflect.apply(target, receiver, args); if (armed && name === 'number-check' && args[0] === 2) trigger(); return value; } });
    String.prototype.padStart = function(...args) { const value = pad.apply(this, args); if (armed && name === 'pad-call-check') trigger(); return value; };
    // The real append succeeds. Its completion must block the NEXT loop lookup.
    Array.prototype.push = function(...items: any[]) { const value = push.apply(this, items); if (armed && name === 'raw-push-completion' && items.some(d => d?.code === 'A' && d.path)) trigger(); return value; };
    let error: unknown;
    try {
      ({ error } = execute(budget, entry => {
        armed = true; entry.errors = ['A', 'Z'];
        const isRedis = ['provenance-check', 'path-digest-check'].includes(name);
        const pointer: any = { ...(isRedis ? redis : sheet) };
        const field = name === 'tab-check' ? 'tab' : name === 'provenance-check' ? 'provenance' : name === 'path-digest-check' ? 'sourceDigest' : name === 'path-kind-check' || name === 'digest-kind-check' ? 'kind' : undefined;
        if (field) { const value = pointer[field]; Object.defineProperty(pointer, field, { get() { if (name !== 'digest-kind-check' || reads === 2) trigger(); return value; } }); }
        Object.defineProperty(entry, 'source', { get() { reads++; return pointer; } });
      }));
    } finally { armed = false; equalSpy.mockRestore(); utf8Spy.mockRestore(); globalThis.String = nativeString; String.prototype.padStart = pad; Array.prototype.push = push; }
    expect(hit).toBe(1);
    if (state === 'timely') { expect(trace).toEqual([name === 'number-check' || name === 'pad-call-check' ? 'reserveString lookup' : name === 'raw-push-completion' ? 'spend lookup' : name.includes('kind') ? 'equal invocation' : 'utf8 invocation']); expect(error).toBe(stop); }
    else { expect(trace).toEqual([]); expect(error).toBeInstanceOf(BudgetUnavailableError); }
  });
});

// Supplemental post-GREEN semantic coverage, not retroactive chronological RED.
describe('budget raw pointer bytes against executed original Git synthetic oracle', () => {
  for (const f of (golden as any).rawNative.filter((c: any) => c.scenario.probe === 'success')) it(f.name, () => {
    const budget = createBudgetContext({ now: () => 0 });
    const input = parseRegisteredBoundedJson(JSON.stringify(f.input), budget);
    const result = rawNativeOracle(i => run(i, budget), input, f.scenario, true);
    expect(result.diagnostics).toEqual(f.outcome.diagnostics);
    expect(result.sourceReads).toBe(f.outcome.sourceReads); expect(result.identity).toBe(true);
  });
});

describe('actual consecutive raw append reaches4096 then overflows before final dedup', () => {
  for (const warning of [false, true]) it(`synthetic warning headroom=${warning}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
    let armed = false, reads = 0, hashes = 0, appends = 0; const push = Array.prototype.push, savedHash = validatorsModule.sha256;
    const hashSpy = vi.spyOn(validatorsModule, 'sha256').mockImplementation((v, b) => { if (armed) { hashes++; expect(b).toBe(budget); } return savedHash(v, b); });
    Array.prototype.push = function(...items: any[]) { if (armed && items.some(d => ['A', 'Z'].includes(d?.code) && d.path)) appends++; return push.apply(this, items); };
    let count: () => number;
    const invoke = capacityNormalizer((emit, warnings, conflicts, entry, counter) => {
      count = counter; const d = { code: 'prefill', path: 'same', sourceDigest: 'same' };
      for (let i = counter(); i < 4095; i++) emit(warning ? warnings : conflicts, d);
      entry.errors = ['Z', 'A', 'Z']; const source = entry.source;
      Object.defineProperty(entry, 'source', { get() { reads++; return source; } }); armed = true;
    });
    let error: unknown;
    try { invoke(input, budget); } catch (e) { error = e; } finally { hashSpy.mockRestore(); Array.prototype.push = push; }
    expect(reads).toBe(4); expect(hashes).toBe(2); expect(appends).toBe(1); expect(count!()).toBe(4096);
    expect((error as Error).message).toBe('Legacy migration output exceeds normalization bounds.');
  });
});

describe('public output remains mutable and uncertified', () => {
  it('keeps null-prototype records, mutable rows and raw diagnostic payloads', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const input = parseRegisteredBoundedJson(JSON.stringify(golden.cases.find(c => c.name === 'supported-v3')!.input), budget) as Input;
    const result = run(input, budget);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    const rows = result.records.students; expect(rows.length).toBeGreaterThan(0);
    for (const value of [result, result.records, rows, rows[0], result.sourceRecords, result.sourceRecords[0], result.blockingConflicts]) {
      expect(Object.isFrozen(value)).toBe(false);
      expect(() => boundedModule.assertRegisteredBoundedJson(value, budget)).toThrow('Legacy bounded JSON is invalid.');
    }
    rows[0].testOnlyMutation = true; expect(rows[0].testOnlyMutation).toBe(true);
    delete rows[0].testOnlyMutation;
  });
});

describe('raw cap does not preempt earlier exhausted caller reservation', () => {
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) it(`synthetic cap full with ${key} exhausted`, () => {
    const budget = createBudgetContext({ now: () => 0 }), input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
    let reached = 0, reads = 0;
    const invoke = capacityNormalizer((emit, warnings, conflicts, entry, count) => {
      reached++; const d = { code: 'prefill', path: 'same', sourceDigest: 'same' };
      for (let i = count(); i < 4096; i++) emit(conflicts, d);
      entry.errors = ['Z']; const source = entry.source;
      Object.defineProperty(entry, 'source', { get() { reads++; return source; } });
      consume(budget, key, 0);
    });
    let error: unknown; try { invoke(input, budget); } catch (e) { error = e; }
    expect(reached).toBe(1); expect(reads).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

it('raw loop predecessor charges length1/index2 before the fixed shell work8', () => {
  const budget = createBudgetContext({ now: () => 0 }), stop = new RangeError('source after loop');
  const real = workModule.stableBudgetSort; let armed = false, before: any, indexed: any, source: any;
  const delta = () => Object.fromEntries(Object.entries(budget.usage()).map(([key, value]) => [key, value - before[key]]));
  const spy = vi.spyOn(workModule, 'stableBudgetSort').mockImplementation((values: any, compare: any, context?: BudgetContext): any => {
    const sorted = real(values, compare, context);
    if (armed) { before = budget.usage(); const first = sorted[0]; Object.defineProperty(sorted, '0', { get() { indexed = delta(); return first; } }); }
    return sorted;
  });
  let error: unknown;
  try { ({ error } = execute(budget, entry => { armed = true; entry.errors = ['Z']; Object.defineProperty(entry, 'source', { get() { source = delta(); throw stop; } }); })); }
  finally { spy.mockRestore(); }
  expect(error).toBe(stop);
  expect(indexed).toEqual({ nodes: 0, slots: 0, contentBytes: 0, structuralBytes: 0, work: 3 });
  expect(source).toEqual({ nodes: 5, slots: 6, contentBytes: 0, structuralBytes: 112, work: 11 });
});

// Supplemental real-factory admission probes. The read-only observer wraps the
// actual referenceNative operation, never a copied path recipe or fake result.
describe('actual raw string factory entry/return follows its own reservation', () => {
  for (const kind of ['SHEET', 'REDIS']) for (const frame of (kind === 'SHEET' ? [0, 1, 2, 3, 4] : [0, 1]))
    for (const key of ['nodes', 'structuralBytes', 'contentBytes', 'work'] as const) for (const offset of [-1, 0, 1]) it(`${kind} frame=${frame} ${key} delta=${offset}`, () => {
      const base = createBudgetContext({ now: () => 0 }), stop = new RangeError('actual frame returned');
      let armed = false, reserved = 0, factories = 0, returns = 0, value: unknown;
      const pointer = kind === 'SHEET' ? sheet : redis;
      const t = Buffer.byteLength(sheet.tab), p = Buffer.byteLength(redis.provenance), d = Buffer.byteLength(redis.sourceDigest);
      const sizes = kind === 'SHEET' ? [t + 1, 32, 32, t + 33, t + 34] : [p + 1, p + 1 + d];
      const work = kind === 'SHEET' ? [2, 1, 2, 2, 2] : [2, 2];
      const texts = kind === 'SHEET' ? ['`${tab}[`', 'String(rowNumber)', 'padStart.call(numberText, 9,', 'prefix + padded', '`${body}]`'] : ['`${provenance}.`', 'prefix + digest'];
      const expected = kind === 'SHEET' ? ['Students[', '2', '000000002', 'Students[000000002', 'Students[000000002]'] : [redis.provenance + '.', redis.provenance + '.' + redis.sourceDigest];
      const budget: BudgetContext = { ...base, reserveString(bytes) {
        if (armed && reserved++ === frame) {
          expect(bytes).toBe(sizes[frame]);
          const amount = key === 'nodes' ? 1 : key === 'structuralBytes' ? 4 : key === 'contentBytes' ? sizes[frame] : work[frame];
          consume(base, key, amount + offset);
        }
        base.reserveString(bytes);
      } };
      const input = parseRegisteredBoundedJson(JSON.stringify(seamInput()), budget) as Input;
      const invoke = capacityNormalizer((_emit, _warnings, _conflicts, entry) => { entry.errors = ['Z']; entry.source = pointer; armed = true; }, (context, operation) => {
        if (armed && operation.toString().includes(texts[frame])) {
          expect(context).toBe(budget); factories++; expect(reserved).toBe(frame + 1);
          value = operation(); returns++; throw stop;
        }
        return operation();
      });
      let error: unknown; try { invoke(input, budget); } catch (e) { error = e; }
      expect(reserved).toBe(frame + 1); expect(factories).toBe(offset < 0 ? 0 : 1); expect(returns).toBe(offset < 0 ? 0 : 1);
      if (offset < 0) expect(error).toBeInstanceOf(BudgetExceededError);
      else { expect(error).toBe(stop); expect(value).toBe(expected[frame]); }
    });
});
