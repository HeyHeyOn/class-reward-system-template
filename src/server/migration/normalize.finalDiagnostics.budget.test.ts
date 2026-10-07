/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as work from '@/lib/boundedWork';
import * as validators from './validators';
import { createNormalizationOutput } from './normalizationOutput';
import * as outputModule from './normalizationOutput';
import { normalizeLegacySnapshots } from './normalize';
import { parseRegisteredBoundedJson, canonicalBoundedJson } from '@/lib/boundedJson';

type D = { code: string; path: string; sourceDigest: string };
type B = work.BudgetContext;
const source = readFileSync(process.env.FINAL_DIAGNOSTICS_SOURCE ?? 'src/server/migration/normalize.ts', 'utf8');
// Read-only transform of actual private declarations, not a reimplementation.
const ast = ts.createSourceFile('normalize.ts', source, ts.ScriptTarget.ESNext, true);
const names = ['stableDiagnostics', 'finalDiagnosticKey', 'finalDiagnosticsBudget', 'referenceNative', 'referenceMap', 'referenceList', 'referenceHas', 'referenceGet', 'referenceAppend'];
const declarations = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name!.text)).map(s => s.getText(ast)).join('\n');
function load(overrides: Record<string, any> = {}, instrumentFrames = false) {
  const bindings = { ...work, ...validators, Map, createNormalizationOutput, ...overrides };
  // Synthetic native-exit injection evaluates the actual four primitive '+'
  // expressions first. Only the completion probe is added; guards stay real.
  const frames = ["code + '\\0'", 'first + path', "second + '\\0'", 'third + digest'];
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => root => {
    const visit: ts.Visitor = node => {
      if (instrumentFrames && ts.isBinaryExpression(node)) {
        const index = frames.indexOf(node.getText(root));
        if (index >= 0) return ts.factory.createCallExpression(ts.factory.createIdentifier('__frameProbe'), undefined, [ts.factory.createNumericLiteral(index + 1), node]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  };
  const js = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: { before: [transformer] } }).outputText;
  return new Function(...Object.keys(bindings), js + ';return { run: stableDiagnostics, key: typeof finalDiagnosticKey === "undefined" ? undefined : finalDiagnosticKey };')(...Object.values(bindings)) as {run: (items: D[], output?: ReturnType<typeof createNormalizationOutput>, budget?: B) => D[]; key?: (item: D, budget: B) => string};
}
const helper = load();
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/final-diagnostics-golden.json', 'utf8'));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const d = (code = 'A', path = 'p', sourceDigest = 'd'): D => ({ code, path, sourceDigest });
const key = (x: D) => `${x.code}\0${x.path}\0${x.sourceDigest}`;
const context = () => work.createBudgetContext({ now: () => 0 });
function consume(b: B, counter: keyof work.BudgetUsage, left: number) {
  const amount = b.limits[counter] - b.usage()[counter] - left;
  if (counter === 'work') b.spend(amount); else b.reserve({ [counter]: amount });
}
// Independent insertion sort counts merge comparisons by simulating merge runs;
// its accounting table is the approved recipe, never sampled candidate usage.
function expected(items: D[]) {
  const unique = new Map(items.map(x => [key(x), x]));
  const builds = [...items]; let a = [...unique.values()], sortWork = a.length, q = 0, compareWork = 0;
  for (let width = 1; width < a.length; width *= 2) {
    sortWork++; const next: D[] = [];
    for (let start = 0; start < a.length; start += 2 * width) {
      sortWork++; const left = a.slice(start, start + width), right = a.slice(start + width, start + 2 * width);
      while (left.length || right.length) {
        sortWork += 2;
        let takeLeft = !right.length;
        if (left.length && right.length) {
          q++; sortWork++; builds.push(left[0], right[0]); compareWork += 1 + Math.ceil((key(left[0]).length + key(right[0]).length) / 256);
          takeLeft = key(left[0]) <= key(right[0]);
        }
        next.push((takeLeft ? left : right).shift()!);
      }
    }
    a = next;
  }
  let contentBytes = 0, keyWork = 0;
  for (const x of builds) {
    const C = Buffer.byteLength(x.code), P = Buffer.byteLength(x.path), D = Buffer.byteLength(x.sourceDigest);
    contentBytes += 4 * C + 3 * P + D + 6;
    keyWork += 3 + [x.code, x.path, x.sourceDigest].reduce((n, s) => n + Math.ceil(s.length / 256), 0);
    for (const len of [x.code.length + 1, x.code.length + 1 + x.path.length, x.code.length + x.path.length + 2, key(x).length]) keyWork += 1 + Math.ceil(len / 256);
  }
  const r = items.length, u = unique.size, b = r + 2 * q, H = (x: D) => 1 + Math.ceil(key(x).length / 256);
  return { nodes: 5 + 4 * b, slots: 6 * u, structuralBytes: 80 + 24 * u + 16 * b, contentBytes,
    work: 3 + 3 * r + 1 + 3 * u + 1 + keyWork + items.reduce((n, x) => n + 2 * H(x), 0) + u + [...unique.values()].reduce((n, x) => n + H(x) + 1, 0) + sortWork + compareWork };
}

describe('executed original Git final diagnostics natural oracle', () => {
  for (const c of golden.cases) for (const bounded of [false, true]) it(`${c.name} budget=${bounded}`, () => {
    const budget = bounded ? context() : undefined;
    const input = budget ? parseRegisteredBoundedJson(JSON.stringify(c.input), budget) : clone(c.input);
    const actual = normalizeLegacySnapshots(input as any, budget);
    expect(JSON.stringify(actual)).toBe(c.json); expect(Object.getPrototypeOf(actual.records)).toBe(null);
  });
});
describe('synthetic actual private helper: original values and ownership', () => {
  for (const c of golden.synthetic) for (const bounded of [false, true]) it(`${c.name} budget=${bounded}`, () => {
    const items = clone(c.items), saved = [...items]; const result = helper.run(items, undefined, bounded ? context() : undefined);
    expect(result.map(x => items.indexOf(x))).toEqual(c.indices); expect(items).toEqual(saved);
    expect(result).not.toBe(items); expect(Object.isFrozen(result)).toBe(false);
    for (const x of result) expect(Object.isFrozen(x)).toBe(false);
    if (result.length) { result[0].path = 'changed'; expect(items.includes(result[0])).toBe(true); }
    result.push(d()); expect(items).toHaveLength(saved.length);
  });
});
const fixtures = [[], [d()], [d('B'), d('A')], [d(), d(), d('Z'), d('B')], [d('A\0B', 'C', 'D'), d('A', 'B\0C', 'D')], [d('', '', '')], [d('한글😀\ud800', '\0', 'é')], [d('x'.repeat(255) + '😀', 'y'.repeat(256), '\ud800')], [d('Z'), d('D'), d('A'), d('B'), d('C')]];
describe('exact independently calculated allocations and work', () => {
  for (const [i, items] of fixtures.entries()) for (const conflict of [false, true]) it(`recipe ${i} conflict=${conflict}`, () => {
    const b = context(); helper.run(clone(items), conflict ? createNormalizationOutput(b) : undefined, b);
    expect(b.usage()).toEqual(expected(items));
  });
  for (const [i, items] of fixtures.entries()) for (const counter of ['nodes', 'slots', 'structuralBytes', 'contentBytes', 'work'] as const) for (const delta of [-1, 0, 1]) {
    const cap = expected(items)[counter] + delta; if (cap < 0) continue;
    it(`total ${i} ${counter} ${delta}`, () => {
      const b = work.createBudgetContext({ now: () => 0, limits: { [counter]: cap } });
      if (delta < 0) expect(() => helper.run(clone(items), undefined, b)).toThrow(work.BudgetExceededError);
      else { helper.run(clone(items), undefined, b); expect(b.usage()).toEqual(expected(items)); }
    });
  }
});

describe('construction and key admission before lazy fields', () => {
  for (const counter of ['nodes', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`initial Map and keys ${counter} ${delta}`, () => {
    const budget = context(), item = d(), stop = new RangeError('first item'); let reached = 0;
    const cost = { nodes: 2, structuralBytes: 32, work: 6 };
    consume(budget, counter, cost[counter] + delta);
    Object.defineProperty(item, 'code', { get() { reached++; throw stop; } });
    let error: unknown; try { helper.run([item], undefined, budget); } catch (e) { error = e; }
    expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(work.BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const field of ['code', 'path', 'sourceDigest'] as const) it(`field ${field} checked before successor lookup`, () => {
    let late = false, lookups = 0, reached = 0;
    const base = work.createBudgetContext({ now: () => late ? 5000 : 0 });
    const budget = new Proxy({ ...base }, { get(target, prop: keyof B) { if (late && (prop === 'spend' || prop === 'reserveString')) lookups++; return target[prop]; } });
    const item = d(); Object.defineProperty(item, field, { get() { reached++; late = true; return 'a'; } });
    expect(() => helper.run([item], undefined, budget)).toThrow(work.BudgetUnavailableError);
    expect(reached).toBe(1); expect(lookups).toBe(0);
  });
  for (const item of [d(), d('한글😀\ud800', '\0é', '😀'), d('x'.repeat(255) + '😀', 'p', 'd')]) for (const frame of [1, 2, 3, 4]) for (const counter of ['nodes', 'structuralBytes', 'contentBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`frame ${JSON.stringify(item)} ${frame} ${counter} ${delta}`, () => {
    const b = context(); let ordinal = 0, reached = 0, has = 0, reads = '';
    const C = Buffer.byteLength(item.code), P = Buffer.byteLength(item.path), D = Buffer.byteLength(item.sourceDigest);
    const bytes = [C + 1, C + 1 + P, C + P + 2, C + P + D + 2];
    const lengths = [item.code.length + 1, item.code.length + item.path.length + 1, item.code.length + item.path.length + 2, key(item).length];
    const stop = new RangeError('frame accepted');
    const budget: B = { ...b, reserveString(n) {
      ordinal++; if (ordinal === frame) { reached++; expect(n).toBe(bytes[frame - 1]); consume(b, counter, ({nodes:1, structuralBytes:4, contentBytes:n, work:1 + Math.ceil(lengths[frame - 1] / 256)})[counter] + delta); }
      b.reserveString(n);
    }, check() { b.check(); if (ordinal === frame && reached && counter !== 'work') throw stop; } };
    // Counter exact tests above prove cumulative completion. This reached sentinel
    // isolates each reserve; work is isolated by stopping at its next spend.
    if (counter === 'work') budget.spend = n => { b.spend(n); if (ordinal === frame) throw stop; };
    const value = { ...item };
    for (const field of ['code', 'path', 'sourceDigest'] as const) Object.defineProperty(value, field, { get() { reads += field + ','; return item[field]; } });
    const nativeHas = Map.prototype.has;
    const local = load({ Map: class extends Map { has(k: any) { has++; return nativeHas.call(this, k); } } });
    let error: unknown; try { local.run([value], undefined, budget); } catch(e) { error = e; }
    expect(reached).toBe(1); if (delta < 0) expect(error).toBeInstanceOf(work.BudgetExceededError); else expect(error).toBe(stop); expect(has).toBe(0);
    expect(reads).toBe(frame === 1 ? 'code,' : frame < 4 ? 'code,path,' : 'code,path,sourceDigest,');
  });
});

describe('same-owner distinct category and mutable comparator ownership', () => {
  for (const fill of [7999, 8000]) for (const count of [1, 2]) for (const warnings of [false, true]) it(`category fill=${fill} distinct=${count} warnings=${warnings}`, () => {
    const b = context(), output = createNormalizationOutput(b), list: D[] = [];
    for (let i = 0; i < fill; i++) output.errorCode(list, () => d());
    const items = count === 1 ? [d(), d()] : [d(), d('B'), d()];
    if (!warnings && fill + count > 8000) expect(() => helper.run(items, output, b)).toThrow(work.BudgetExceededError);
    else { helper.run(items, warnings ? undefined : output, b); if (warnings && fill === 7999) expect(() => output.conflict([], () => d())).not.toThrow(); }
  });
  for (const equal of [false, true]) it(`rereads mutable comparator keys equal=${equal}`, () => {
    const items = [d('B'), d('A')], b = context(), real = createNormalizationOutput(b), emitted: D[] = [];
    const output = { ...real, conflict<T>(list: T[], factory: () => T) { real.conflict(list, factory); emitted.push(list.at(-1) as D); if (emitted.length === 2) { items[0].code = equal ? 'Z' : 'A'; items[1].code = 'Z'; } } };
    const result = helper.run(items, output, b); expect(emitted).toEqual(items); expect(result[0]).toBe(items[0]); expect(result[1]).toBe(items[1]);
  });
  it('no final SHA or clone or raw in-place native sort', () => {
    let hashes = 0; const h = load({ sha256() { hashes++; throw new Error('unexpected final hash'); } });
    const items = [d('Z'), d('A'), d('A')], saved = [...items], budget = context(); const result = h.run(items, undefined, budget);
    expect(hashes).toBe(0); expect(result).toEqual([items[2], items[0]]); expect(items).toEqual(saved);
    for (const value of [result, result[0]]) {
      let error: any; try { canonicalBoundedJson(value, budget); } catch (e) { error = e; }
      expect(error?.name).toBe('InvalidBoundedJsonError'); expect(error?.message).toBe('Legacy bounded JSON is invalid.');
    }
  });
});

describe('native success ordinary failure and budget identity immediate exits', () => {
  for (const seam of ['code', 'path', 'sourceDigest', 'has', 'set', 'get', 'push', 'result-push', 'conflict', 'utf8', 'utf8-path', 'utf8-digest', 'compare', 'sort'] as const)
    for (const state of ['timely', 'expired', 'aborted'] as const)
      for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${seam} ${state} ${exit}`, () => {
        let late = false, reached = 0, successor = 0; const signal = { aborted: false };
        const real = work.createBudgetContext({ now: () => late && state === 'expired' ? 5000 : 0, signal });
        const budget = new Proxy({ ...real }, { get(target, prop: keyof B) { if (late && prop !== 'check' && prop !== 'usage') successor++; return target[prop]; } });
        const error = exit === 'ordinary' ? new RangeError('native') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
        const fire = () => { reached++; late = true; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw error; };
        const items = [d('B'), d('A')];
        if (['code', 'path', 'sourceDigest'].includes(seam)) Object.defineProperty(items[0], seam, { get() { if (!reached) fire(); return 'B'; } });
        const NativeMap = Map;
        class LocalMap extends NativeMap<string, D> {
          has(k: string) { const v = super.has(k); if (seam === 'has' && !reached) fire(); return v; }
          set(k: string, v: D) { const result = super.set(k, v); if (seam === 'set' && !reached) fire(); return result; }
          get(k: string) { const v = super.get(k); if (seam === 'get' && !reached) fire(); return v; }
        }
        const local = load({ Map: LocalMap, utf8ByteLength(v: string, b: B) { const n = work.utf8ByteLength(v, b); if (((seam === 'utf8') || (seam === 'utf8-path' && v === 'p') || (seam === 'utf8-digest' && v === 'd')) && !reached) fire(); return n; },
          compareCodeUnits(a: string, b: string, c: B) { const result = validators.compareCodeUnits(a, b, c); if (seam === 'compare' && !reached) fire(); return result; },
          stableBudgetSort(a: D[], cmp: any, b: B) { const result = work.stableBudgetSort(a, cmp, b); if (seam === 'sort' && !reached) fire(); return result; } });
        const nativePush = Array.prototype.push; let caught: unknown;
        try {
          if (seam === 'push' || seam === 'result-push') Array.prototype.push = function(...values: any[]) { const n = nativePush.apply(this, values); if (!reached && values.length === 1 && ((seam === 'push' && typeof values[0] === 'string' && values[0].includes('\0')) || (seam === 'result-push' && values[0] === items[0]))) fire(); return n; };
          const realOutput = createNormalizationOutput(budget);
          const output = seam === 'conflict' ? { ...realOutput, conflict<T>(list: T[], factory: () => T) { realOutput.conflict(list, factory); if (!reached) fire(); } } : undefined;
          local.run(items, output, budget);
        } catch(e) { caught = e; } finally { Array.prototype.push = nativePush; }
        expect(reached).toBe(1);
        if (exit === 'exceeded' || exit === 'unavailable' || (state === 'timely' && exit === 'ordinary')) expect(caught).toBe(error);
        else if (state !== 'timely') expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
        else expect(caught).toBeUndefined();
        if (state !== 'timely' || exit !== 'success') expect(successor).toBe(0);
      });
});


describe('per-string ceilings and native earliest method lookup', () => {
  for (const frame of [1, 2, 3, 4]) for (const delta of [-1, 0, 1]) it(`per string frame=${frame} delta=${delta}`, () => {
    const item = d('AAA', 'PPP', 'DDD'), bytes = [4, 7, 8, 11], base = work.createBudgetContext({ now: () => 0, limits: { stringBytes: bytes[frame - 1] + delta } });
    let ordinal = 0, reached = 0; const stop = new RangeError('admitted');
    const b: B = { ...base, reserveString(n) { ordinal++; if (ordinal === frame) reached++; base.reserveString(n); if (ordinal === frame) throw stop; } };
    let error: unknown; try { helper.run([item], undefined, b); } catch(e) { error = e; }
    expect(reached).toBe(1); if (delta < 0) expect(error).toBeInstanceOf(work.BudgetExceededError); else expect(error).toBe(stop);
  });
  for (const seam of ['has', 'set', 'get'] as const) for (const state of ['expired', 'aborted'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`next method LOOKUP ${seam} ${state} ${exit}`, () => {
    let late = false, reached = 0, next = 0; const signal = { aborted: false };
    const b = work.createBudgetContext({ now: () => late && state === 'expired' ? 5000 : 0, signal });
    const error = exit === 'ordinary' ? new RangeError('native') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    const fire = () => { reached++; late = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw error; };
    const NativeMap = Map;
    const local = load({ Map: class extends NativeMap<string, D> {
      constructor() { super(); for (const name of ['has', 'set', 'get'] as const) Object.defineProperty(this, name, { get() { if (late) next++; return (...args: any[]) => { const v = (NativeMap.prototype[name] as any).apply(this, args); if (name === seam && !reached) fire(); return v; }; } }); }
    } });
    const real = createNormalizationOutput(b), output = { ...real };
    Object.defineProperty(output, 'conflict', { get() { if (late) next++; return real.conflict; } });
    const push = Object.getOwnPropertyDescriptor(Array.prototype, 'push')!;
    let caught: unknown;
    try {
      Object.defineProperty(Array.prototype, 'push', { configurable: true, get() { if (late) next++; return push.value; } });
      local.run([d()], output, b);
    } catch(e) { caught = e; } finally { Object.defineProperty(Array.prototype, 'push', push); }
    expect(reached).toBe(1); expect(next).toBe(0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(error); else expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
  });
});

describe('independent reached Map/key/emission/sort reservation controls', () => {
  for (const seam of ['map-slot', 'key-slot', 'result-node', 'result-slot', 'sort'] as const)
    for (const counter of (seam === 'result-node' ? ['nodes', 'structuralBytes', 'work'] : seam === 'sort' ? ['nodes', 'slots', 'structuralBytes'] : ['slots', 'structuralBytes', 'work']) as (keyof work.BudgetUsage)[])
      for (const delta of [-1, 0, 1]) it(`${seam} ${counter} ${delta}`, () => {
        const base = context(), stop = new RangeError('next operand'); let reached = 0, operand = 0, has = 0, sets = 0;
        const costs: Record<string, Partial<work.BudgetUsage>> = { 'map-slot': {slots:2, structuralBytes:8, work:2}, 'key-slot': {slots:1, structuralBytes:4, work:1}, 'result-node': {nodes:1, structuralBytes:16, work:1}, 'result-slot': {slots:1, structuralBytes:4, work:1}, sort: {nodes:2, slots:2, structuralBytes:40} };
        const arm = () => { reached++; consume(base, counter, costs[seam][counter]! + delta); };
        let resultReserved = false;
        const b: B = { ...base, reserve(cost) { if (seam === 'sort' && cost.nodes === 2 && cost.slots === 2) arm(); base.reserve(cost); if (seam === 'result-node' && reached && cost.nodes === 1) resultReserved = true; }, check() { base.check(); if (resultReserved) { resultReserved = false; operand++; throw stop; } } };
        const NativeMap = Map;
        const local = load({ Map: class extends NativeMap<string, D> {
          has(k: string) { const v = super.has(k); has++; if (seam === 'map-slot') arm(); return v; }
          set(k: string, v: D) { sets++; if (seam === 'map-slot') { operand++; throw stop; } const r = super.set(k,v); if (seam === 'key-slot') arm(); return r; }
          get(k: string) { const v = super.get(k); if (seam === 'result-slot') arm(); return v; }
        }, stableBudgetSort(list: D[], compare: any, budget: B) { if (seam === 'sort') { work.stableBudgetSort(list, compare, budget); operand++; throw stop; } return work.stableBudgetSort(list, compare, budget); } });
        const items = [d()];
        const input = new Proxy(items, { get(target, prop, receiver) { if (prop === 'length' && sets && seam === 'result-node' && !reached) arm(); return Reflect.get(target, prop, receiver); } });
        const nativePush = Array.prototype.push; let caught: unknown;
        try {
          Array.prototype.push = function(...values: any[]) { if (reached && (seam === 'key-slot' || seam === 'result-slot')) { operand++; throw stop; } return nativePush.apply(this, values); };
          local.run(input, undefined, b);
        } catch(e) { caught = e; } finally { Array.prototype.push = nativePush; }
        expect(has).toBe(1); expect(reached).toBe(1); expect(operand).toBe(delta < 0 ? 0 : 1);
        if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
      });
});

describe('real normalization warnings same context and final completion', () => {
  it('warnings receive the original context without another output owner', () => {
    const c = golden.cases.find((x: any) => x.classification.warnings > 0); expect(c).toBeDefined();
    const b = context(), original = outputModule.createNormalizationOutput;
    let owners = 0, finalKeys = 0; const spend = b.spend;
    const delegated: B = { ...b, spend(n) { if (new Error().stack?.includes('finalDiagnosticKey')) finalKeys++; return spend(n); } };
    const input = parseRegisteredBoundedJson(JSON.stringify(c.input), delegated);
    const spy = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation(actual => { owners++; expect(actual).toBe(delegated); return original(actual); });
    try { normalizeLegacySnapshots(input as any, delegated); } finally { spy.mockRestore(); }
    expect(owners).toBe(1); expect(finalKeys).toBeGreaterThan(0);
  // Capturing a stack on each budget spend is instrumentation overhead; the
  // production deadline is checked separately through the controlled clock.
  }, 15_000);
  for (const phase of ['warnings', 'conflicts'] as const) for (const state of ['expired', 'aborted'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`actual final ${phase} ${state} ${exit}`, () => {
    let late = false, reached = 0, nextLookups = 0, returned = 0; const signal = {aborted:false};
    const base = work.createBudgetContext({now: () => late && state === 'expired' ? 5000 : 0, signal});
    const b = new Proxy({...base}, {get(target, prop: keyof B) { if (late && (prop === 'reserve' || prop === 'spend')) nextLookups++; return target[prop]; }});
    const c = golden.cases.find((x: any) => x.classification.warnings > 0 && x.classification.conflicts > 0); expect(c).toBeDefined();
    const input = parseRegisteredBoundedJson(JSON.stringify(c.input), b);
    const native = work.stableBudgetSort, original = exit === 'ordinary' ? new RangeError('final sort') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    const spy = vi.spyOn(work, 'stableBudgetSort').mockImplementation((items: readonly any[], compare: any, actual?: B) => {
      const result = native(items, compare, actual);
      if (items.length && typeof items[0]?.sourceDigest === 'string' && typeof items[0]?.path === 'string' && new Error().stack?.includes('finalDiagnosticsBudget')) {
        const warning = c.classification.warnings && items.some(x => JSON.parse(c.json).warnings.some((w: D) => key(w) === key(x)));
        if ((phase === 'warnings') === !!warning && !reached) { expect(actual).toBe(b); reached++; late = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw original; }
      }
      return result;
    });
    let caught: unknown; try { normalizeLegacySnapshots(input as any,b); returned++; } catch(e) { caught = e; } finally { spy.mockRestore(); }
    expect(reached).toBe(1); expect(nextLookups).toBe(0); expect(returned).toBe(0);
    if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(original); else expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
  });
});


// FINAL_NATIVE_ORACLE_BEGIN
function finalNativeTrace(make: (MapValue: typeof Map) => (items: D[]) => D[], probe = 'success', hooked = true) {
  const trace: string[] = [], push = Array.prototype.push, sort = Array.prototype.sort;
  const sortDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'sort')!;
  const stop = new RangeError('original native stop'); let reached = 0, error: unknown, result: D[] | undefined;
  const record = (label: string) => { if (hooked) push.call(trace, label); if (probe === label) { reached++; throw stop; } };
  const raw = [d('Z'), d('A'), d('A')];
  for (const [i,item] of raw.entries()) for (const field of ['code','path','sourceDigest'] as const) {
    const value = item[field]; Object.defineProperty(item,field,{get() {record(`${i}.${field}`); return value;}});
  }
  Object.defineProperty(raw,'map',{get() { record('map.lookup'); return function(callback: any) { record('map.call'); const indexed = new Proxy(raw, { get(target, prop, receiver) { if (typeof prop === 'string' && /^(0|[1-9][0-9]*)$/.test(prop)) record('map.index.' + prop); return Reflect.get(target, prop, receiver); } }); const result = Array.prototype.map.call(indexed,(item,index) => { record(`map.callback.${index}`); return callback(item,index,raw); }); record('map.return'); return result; }; }});
  const NativeMap = Map;
  const MapValue = new Proxy(NativeMap, {construct(target,args) {
    record('Map.construct'); const entries = args[0];
    if (entries) {
      const iterator = entries[Symbol.iterator]; Object.defineProperty(entries,Symbol.iterator,{get() {record('tuples.iterator.lookup');return function() {record('tuples.iterator.call');const iter = iterator.call(entries); return {next() {record('tuples.next');const next = iter.next();if (!next.done) for (const index of [0,1]) {const value=next.value[index];Object.defineProperty(next.value,index,{get() {record(`tuple.${index}`);return value;}});}return next;}};};}});
    }
    const map = Reflect.construct(target,args); record('Map.return');
    Object.defineProperty(map,'values',{get() {record('values.lookup');return function() {record('values.call');const iter=NativeMap.prototype.values.call(map);return {[Symbol.iterator]() {record('values.iterator');return this;},next() {record('values.next');return iter.next();}};};}});
    return map;
  } });
  try {
    Object.defineProperty(Array.prototype, 'sort', { configurable: true, get() {
      if (!this.length || !raw.includes(this[0])) return sort;
      record('sort.lookup');
      return function(this: D[], compare: any) { record('sort.call'); const result = sort.call(this,(a,b)=>{record('sort.compare');return compare(a,b);});record('sort.return');return result; };
    } });
    result = make(MapValue)(raw);
  } catch(e) { error=e; } finally {Object.defineProperty(Array.prototype, 'sort', sortDescriptor);}
  return {trace,indices:result?.map(x=>raw.indexOf(x)) ?? null,identity:error===stop,reached};
}
// FINAL_NATIVE_ORACLE_END

describe('executed original native map tuple iterator values sort and ordinary stop trace', () => {
  for (const c of golden.native) it(`native ${c.probe}`, () => {
    expect(finalNativeTrace(m=>load({Map:m}).run,c.probe)).toEqual(c.outcome);
    const plain=finalNativeTrace(m=>load({Map:m}).run,c.probe,false);
    expect({...plain,trace:c.outcome.trace}).toEqual(c.outcome);
  });
});


describe('primitive frame completion before earliest successor lookup', () => {
  for (const frame of [1,2,3,4]) for (const state of ['timely','expired','aborted'] as const) it(`frame completion ${frame} ${state}`, () => {
    let ordinal=0, armed=false, reached=0, next=0; const signal={aborted:false};
    const base=work.createBudgetContext({now:()=>armed && state==='expired'?5000:0,signal});
    const stop=new RangeError('earliest successor');
    const b = new Proxy({...base, reserveString(n:number) { ordinal++;base.reserveString(n); }, spend(n?:number) {base.spend(n);if(ordinal===frame && !armed){armed=true;reached++;signal.aborted=state==='aborted';}}}, {get(target,prop:keyof B){if(armed&&(prop==='spend'||prop==='reserveString')){next++;throw stop;}return target[prop];}});
    let caught:unknown;try{helper.run([d()],undefined,b);}catch(e){caught=e;}
    expect(reached).toBe(1);expect(next).toBe(state==='timely'?1:0);
    if(state==='timely')expect(caught).toBe(stop);else expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
  });
});

describe('comparator sides and compare work reached admission', () => {
  for (const side of ['left','right'] as const) for(const counter of ['nodes','contentBytes','structuralBytes','work'] as const) for(const delta of [-1,0,1]) it(`${side} key ${counter} ${delta}`,()=>{
    const base=context();let sorting=false,reads=0,reached=0,compares=0;const stop=new RangeError('comparator key complete');
    const local=load({stableBudgetSort(items:D[],cmp:any,b:B){sorting=true;return work.stableBudgetSort(items,cmp,b);},compareCodeUnits(){compares++;throw stop;}});
    const items=[d('B'),d('A')];const selected=side==='left'?items[0]:items[1];
    let frames=0, stopped=false;
    const b:B={...base,check(){base.check();if(frames===4&&!stopped){stopped=true;throw stop;}},reserveString(n){base.reserveString(n);if(reached)frames++;}};
    const fieldCost={nodes:4,contentBytes:14,structuralBytes:16,work:13};
    // First code read has already spent one; remaining complete-key work=13.
    Object.defineProperty(selected,'code',{get(){if(sorting){reads++;if(!reached){reached++;consume(base,counter,fieldCost[counter]+delta);}}return side==='left'?'B':'A';}});
    if(side==='left')Object.defineProperty(items[1],'code',{get(){if(sorting)throw stop;return 'A';}});
    let caught:unknown;try{local.run(items,undefined,b);}catch(e){caught=e;}
    expect(reached).toBe(1);expect(reads).toBe(1);expect(compares).toBe(0);
    if(delta<0)expect(caught).toBeInstanceOf(work.BudgetExceededError);else expect(caught).toBe(stop);
  });
  for(const delta of [-1,0,1])it(`compareCodeUnits work ${delta}`,()=>{
    const b=context();let reached=0;const stop=new RangeError('compared');
    const local=load({compareCodeUnits(a:string,c:string,budget:B){reached++;consume(b,'work',1+Math.ceil((a.length+c.length)/256)+delta);const result=validators.compareCodeUnits(a,c,budget);void result;throw stop;}});
    let caught:unknown;try{local.run([d('B'),d('A')],undefined,b);}catch(e){caught=e;}
    expect(reached).toBe(1);if(delta<0)expect(caught).toBeInstanceOf(work.BudgetExceededError);else expect(caught).toBe(stop);
  });
});

describe('category destination and factory are separate, no reset or double charge',()=>{
  for(const counter of ['slots','structuralBytes','work'] as const)for(const delta of [-1,0,1])it(`conflict destination ${counter} ${delta}`,()=>{
    const b=context(),real=createNormalizationOutput(b), stop=new RangeError('factory reached');let emit=0,factory=0;
    const output={...real,conflict<T>(list:T[],f:()=>T){emit++;consume(b,counter,({slots:1,structuralBytes:4,work:1})[counter]+delta);real.conflict(list,()=>{factory++;void f();throw stop;});}};
    let caught:unknown;try{helper.run([d(),d()],output,b);}catch(e){caught=e;}
    expect(emit).toBe(1);expect(factory).toBe(delta<0?0:1);if(delta<0)expect(caught).toBeInstanceOf(work.BudgetExceededError);else expect(caught).toBe(stop);
  });
  it('complete dedup precedes distinct insertion-order category and sorting follows',()=>{
    const events:string[]=[],items=[d('Z'),d('A'),d('Z')],base=context(),real=createNormalizationOutput(base);
    const NativeMap=Map;const local=load({Map:class extends NativeMap<string,D>{set(k:string,v:D){events.push('set:'+items.indexOf(v));return super.set(k,v);}},stableBudgetSort(a:D[],cmp:any,b:B){events.push('sort');return work.stableBudgetSort(a,cmp,b);}});
    const output={...real,conflict<T>(list:T[],factory:()=>T){events.push('emit');real.conflict(list,()=>{const v=factory();events.push('factory:'+items.indexOf(v as D));return v;});}};
    const result=local.run(items,output,base);expect(events).toEqual(['set:0','set:1','set:2','emit','factory:2','emit','factory:1','sort']);expect(result).toEqual([items[1],items[2]]);
  });
});


// Post-GREEN survivor strengthening: preserve the first controls and baseline
// replay separately; this is not retroactive chronological RED.
describe('comparator local completion cannot rely on sort or normalizer catch',()=>{
  for(const state of ['timely','expired','aborted'] as const)for(const exit of ['success','ordinary','exceeded','unavailable'] as const)it(`comparator local ${state} ${exit}`,()=>{
    let late=false,reached=0,returned=0;const signal={aborted:false};const b=work.createBudgetContext({now:()=>late&&state==='expired'?5000:0,signal});
    const error=exit==='ordinary'?new RangeError('compare native'):exit==='exceeded'?new work.BudgetExceededError():new work.BudgetUnavailableError();let localError:unknown;
    const local=load({compareCodeUnits(a:string,c:string,budget:B){const value=validators.compareCodeUnits(a,c,budget);if(!reached){reached++;late=true;signal.aborted=state==='aborted';if(exit!=='success')throw error;}return value;},stableBudgetSort(items:D[],cmp:any,budget:B){return work.stableBudgetSort(items,(a,c)=>{try{const result=cmp(a,c);returned++;return result;}catch(e){localError=e;throw e;}},budget);}});
    let caught:unknown;try{local.run([d('B'),d('A')],undefined,b);}catch(e){caught=e;}
    expect(reached).toBe(1);expect(returned).toBe(state==='timely'&&exit==='success'?1:0);
    if(exit==='exceeded'||exit==='unavailable'||(state==='timely'&&exit==='ordinary')){expect(localError).toBe(error);expect(caught).toBe(error);}
    else if(state!=='timely'){expect(localError).toBeInstanceOf(work.BudgetUnavailableError);expect(caught).toBeInstanceOf(work.BudgetUnavailableError);}
    else expect(caught).toBeUndefined();
  });
  it('actual normalizer invokes the original output owner exactly for distinct conflicts, not warnings',()=>{
    const c=golden.cases.find((x:any)=>x.classification.warnings>0&&x.classification.conflicts>0),b=context(),input=parseRegisteredBoundedJson(JSON.stringify(c.input),b);
    const real=outputModule.createNormalizationOutput;let owners=0;const emitted:D[]=[];
    const spy=vi.spyOn(outputModule,'createNormalizationOutput').mockImplementation(actual=>{owners++;expect(actual).toBe(b);const output=real(actual);return {...output,conflict<T>(list:T[],factory:()=>T){output.conflict(list,()=>{const item=factory();emitted.push(item as D);return item;});}};});
    let result:ReturnType<typeof normalizeLegacySnapshots>;try{result=normalizeLegacySnapshots(input as any,b);}finally{spy.mockRestore();}
    expect(owners).toBe(1);expect(emitted).toHaveLength(c.classification.conflicts);expect(new Set(emitted)).toEqual(new Set(result!.blockingConflicts));
  });
});


describe('synthetic actual primitive concat exits through original checked callback',()=>{
  for(const frame of [1,2,3,4])for(const state of ['timely','expired','aborted'] as const)for(const exit of ['success','ordinary','exceeded','unavailable'] as const)it(`primitive ${frame} ${state} ${exit}`,()=>{
    let late=false,reached=0,next=0;const signal={aborted:false};const base=work.createBudgetContext({now:()=>late&&state==='expired'?5000:0,signal});
    const b=new Proxy({...base},{get(target,prop:keyof B){if(late&&(prop==='spend'||prop==='reserveString'))next++;return target[prop];}});
    const error=exit==='ordinary'?new RangeError('synthetic completed concat'):exit==='exceeded'?new work.BudgetExceededError():new work.BudgetUnavailableError();
    const values=['A\0','A\0p','A\0p\0','A\0p\0d'];
    const local=load({__frameProbe(ordinal:number,value:string){if(ordinal===frame&&!reached){expect(value).toBe(values[frame-1]);reached++;late=true;signal.aborted=state==='aborted';if(exit!=='success')throw error;}return value;}},true);
    let caught:unknown;try{local.run([d()],undefined,b);}catch(e){caught=e;}
    expect(reached).toBe(1);
    if(exit==='exceeded'||exit==='unavailable'||(state==='timely'&&exit==='ordinary'))expect(caught).toBe(error);
    else if(state!=='timely')expect(caught).toBeInstanceOf(work.BudgetUnavailableError);else expect(caught).toBeUndefined();
    if(state!=='timely'||exit!=='success')expect(next).toBe(0);
  });
});
