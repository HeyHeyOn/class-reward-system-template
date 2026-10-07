/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as work from '@/lib/boundedWork';
import * as graph from '@/lib/boundedJson';
import * as validators from './validators';
import { createNormalizationOutput } from './normalizationOutput';

type M = { targetTable: string; targetId: string; sourceDigest: string; status: string };
type B = work.BudgetContext;
type Hook = (name: string, value?: any) => void;
const nativeRequire = createRequire(path.resolve('package.json'));
const frozenOriginalPin = '448cbed7bd303ad0f9ef3fd4c974c313bf4c8da8';
const frozenOriginalRoot = 'test-support/frozen-oracles/' + frozenOriginalPin;
// Pin the manifest bytes as well as every payload: editing a hash cannot bless
// candidate source. Logical names stay unchanged for relative imports/cycles.
const frozenOriginalPaths = new Set([
  "src/domain/taskAvailability.ts",
  "src/domain/taskCompletionPolicy.ts",
  "src/domain/taskCycleHistory.ts",
  "src/domain/taskCycleState.ts",
  "src/domain/taskPrerequisite.ts",
  "src/domain/taskRecurrence.ts",
  "src/domain/taskSchedule.ts",
  "src/domain/timeZone.ts",
  "src/lib/checkoutSnapshotClient.ts",
  "src/lib/promotionClient.ts",
  "src/server/migration/normalize.ts",
  "src/server/migration/operationalProjection.ts",
  "src/server/migration/semanticValidators.ts",
  "src/server/migration/sensitiveRedaction.ts",
  "src/server/migration/sheetsSnapshot.ts",
  "src/server/migration/validators.ts",
  "src/server/operationTelemetry.ts",
  "src/server/repositories/sheets/recurringSchemaMigrator.ts",
  "src/server/repositories/sheets/taskAssignmentCommands.ts",
  "src/server/repositories/sheets/taskCommandQueue.ts",
  "src/server/repositories/sheets/taskCompletionCommands.ts",
  "src/server/repositories/sheets/taskCycleQueries.ts",
  "src/server/repositories/sheets/taskScheduleCommands.ts",
  "src/server/sheetsRepository.ts",
  "src/server/sheetsRows.ts",
  "src/server/storage/tabularStore.ts"
]);
function readFrozenOriginal(rel: string, read: (file: string) => Buffer = file => readFileSync(file)): string {
  if (!frozenOriginalPaths.has(rel)) throw new Error('Unknown frozen original module ' + rel);
  const manifestBytes = read(frozenOriginalRoot + '/manifest.json');
  if (createHash('sha256').update(manifestBytes).digest('hex') !== '1b20d13ac257dadd41d714012ef8d45f04d133f0c45d0f8e5b6f3025e3729e8e') throw new Error('Frozen original manifest integrity');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { originalPin: string; modules: { path: string; payload: string; sha256: string; bytes: number }[] };
  if (manifest.originalPin !== frozenOriginalPin) throw new Error('Frozen original pin integrity');
  const entry = manifest.modules.find(entry => entry.path === rel);
  if (!entry || entry.payload !== rel + '.txt') throw new Error('Unknown frozen original module ' + rel);
  const bytes = read(frozenOriginalRoot + '/' + entry.payload);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Frozen original payload integrity ' + rel);
  return bytes.toString('utf8');
}
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/mapping-sort-golden.json', 'utf8'));
const sourcePath = 'src/server/migration/normalize.ts';
const source = readFileSync(process.env.MAPPING_SORT_SOURCE ?? sourcePath, 'utf8');
const d = (targetTable = 'A', targetId = 'i', sourceDigest = 'd', status = 'stageable'): M => ({ targetTable, targetId, sourceDigest, status });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const key = (x: M) => `${x.targetTable}\0${x.targetId}\0${x.sourceDigest}`;
const context = () => work.createBudgetContext({ now: () => 0 });
const counters = ['nodes', 'slots', 'structuralBytes', 'contentBytes', 'work'] as const;
function consume(b: B, counter: keyof work.BudgetUsage, left: number) {
  const amount = b.limits[counter] - b.usage()[counter] - left;
  if (counter === 'work') b.spend(amount); else b.reserve({ [counter]: amount });
}
// These observers wrap actual AST operands/declarations, never implement a key,
// sort, admission, or copyback. Completion events are outside each real guard.
function transformer(context: ts.TransformationContext): ts.Transformer<ts.SourceFile> {
  const f = context.factory; let fn = ''; let root: ts.SourceFile;
  const wrap = (name: string, expression: ts.Expression) => f.createCallExpression(f.createIdentifier('__call'), undefined, [f.createStringLiteral(name), f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), expression)]);
  const visit: ts.Visitor = node => {
    if (ts.isFunctionDeclaration(node)) { const previous = fn; fn = node.name?.text.startsWith('finalMappingKey') ? 'finalMappingKey' : node.name?.text ?? ''; const out = ts.visitEachChild(node, visit, context); fn = previous; return out; }
    if (ts.isCallExpression(node) && node.expression.getText(root) === 'referenceNative' && node.arguments.length === 2 && ts.isArrowFunction(node.arguments[1])) {
      const arrow = node.arguments[1], text = arrow.body.getText(root);
      let label = '';
      if (fn === 'finalMappingKey') label = ({ 'item.targetTable': 'table', 'item.targetId': 'id', 'item.sourceDigest': 'digest', 'utf8ByteLength(table, budget)': 'utf8:table', 'utf8ByteLength(id, budget)': 'utf8:id', 'utf8ByteLength(digest, budget)': 'utf8:digest', "table + '\\0'": 'f1', 'first + id': 'f2', "second + '\\0'": 'f3', 'third + digest': 'f4' } as Record<string, string>)[text] ?? '';
      if (fn === 'finalMappingSort') label = text === 'sorted.length' ? 'copy:length' : text === 'sorted[i]' ? 'copy:index' : text.includes('mappings[i] = item') ? 'copy:write' : '';
      if (fn === 'normalizeLegacySnapshots' && text === 'tableEntries.length') label = 'target:terminal';
      if (label) return wrap(label + ':checked', ts.visitEachChild(node, visit, context));
    }
    // Observe the operand even when an external mutant removes its guard. A
    // missing referenceNative must not turn a reached mutation into harness absence.
    let operand = '';
    const text = node.getText(root);
    if (fn === 'finalMappingKey') operand = ({ 'item.targetTable': 'table', 'item.targetId': 'id', 'item.sourceDigest': 'digest', 'utf8ByteLength(table, budget)': 'utf8:table', 'utf8ByteLength(id, budget)': 'utf8:id', 'utf8ByteLength(digest, budget)': 'utf8:digest', "table + '\\0'": 'f1', 'first + id': 'f2', "second + '\\0'": 'f3', 'third + digest': 'f4' } as Record<string, string>)[text] ?? '';
    if (fn === 'finalMappingSort') operand = text === 'sorted.length' ? 'copy:length' : text === 'sorted[i]' ? 'copy:index' : text === 'mappings[i] = item' ? 'copy:write' : '';
    if (fn === 'normalizeLegacySnapshots' && text === 'tableEntries.length') operand = 'target:terminal';
    if (operand && ts.isExpression(node)) return wrap(operand, ts.visitEachChild(node, visit, context));
    if (ts.isCallExpression(node) && (['finalMappingSort', 'targetIndexEntries'].includes(node.expression.getText(root)) || node.expression.getText(root).startsWith('finalMappingKey'))) return wrap(node.expression.getText(root).startsWith('finalMappingKey') ? 'finalMappingKey' : node.expression.getText(root), ts.visitEachChild(node, visit, context));
    return ts.visitEachChild(node, visit, context);
  };
  return file => { root = file; return ts.visitNode(file, visit) as ts.SourceFile; };
}
const jsCache = new Map<string, string>();
function compile(text: string, observed = true) {
  const cacheKey = String(observed) + text; if (jsCache.has(cacheKey)) return jsCache.get(cacheKey)!;
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: observed ? { before: [transformer] } : undefined }).outputText;
  jsCache.set(cacheKey, js); return js;
}
function finalStatement(text: string) {
  const ast = ts.createSourceFile('normalize.ts', text, ts.ScriptTarget.ESNext, true);
  const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'normalizeLegacySnapshots') as ts.FunctionDeclaration;
  const statements = (fn.body!.statements.find(ts.isTryStatement)?.tryBlock ?? fn.body!).statements;
  const statement = statements.find(s => s.getText(ast).startsWith('mappings.sort(') || (ts.isIfStatement(s) && s.expression.getText(ast) === 'budget' && s.thenStatement.getText(ast) === 'finalMappingSort(mappings, budget);'));
  if (!statement) throw new Error('Actual mapping statement absent');
  return { ast, statement };
}
function load(hook: Hook = () => {}, original = false, publicCaller = false, overrides: Record<string, any> = {}) {
  let active = true;
  const emit: Hook = (n, v) => { if (active) hook(n, v); };
  const call = <T,>(name: string, operation: () => T): T => {
    emit(name + ':enter');
    try { const value = operation(); emit(name + ':return', value); return value; }
    catch (error) { emit(name + ':throw', error); throw error; }
  };
  const observedWork = { ...work,
    utf8ByteLength(s: string, b?: B) { emit('utf8:context', b); return call('utf8', () => work.utf8ByteLength(s, b)); },
    stableBudgetSort<T>(items: T[], cmp: (a: T, b: T) => number, b?: B) {
      emit('sort:context', b); emit('sort:input', items);
      const sorted = call('sort', () => work.stableBudgetSort(items, (a, c) => call('comparator', () => { emit('comparator:pair', [a, c]); return cmp(a, c); }), b));
      return new Proxy(sorted, { get(t, k, r) { if (k === 'length' || (typeof k === 'string' && /^\d+$/.test(k))) emit('returned:' + (k === 'length' ? 'length' : 'index') + ':lookup', k); return Reflect.get(t, k, r); } });
    },
  };
  const observedValidators = { ...validators, compareCodeUnits(a: string, b: string, budget?: B) { emit('compare:context', budget); return call('compare', () => validators.compareCodeUnits(a, b, budget)); } };
  const fullText = original ? readFrozenOriginal(sourcePath) : source;
  const { ast, statement } = finalStatement(fullText);
  const declarations = ast.statements.filter(s => ts.isFunctionDeclaration(s) && (s.name!.text.startsWith('finalMapping') || ['referenceNative', 'referenceString'].includes(s.name!.text))).map(s => s.getText(ast)).join('\n');
  const lexical = `\nfunction __run(mappings, budget) { ${statement.getText(ast)}; __call('successor', () => mappings); return mappings; }\nexports.__run=__run; exports.__key=typeof finalMappingKey==='undefined'?undefined:finalMappingKey;`;
  let api: Record<string, any>;
  if (!publicCaller) {
    const bindings = { ...observedWork, ...observedValidators, stringBoundedJson: graph.stringBoundedJson, __call: call, exports: {}, ...overrides };
    api = bindings.exports;
    new Function(...Object.keys(bindings), compile(declarations + lexical))(...Object.values(bindings));
  } else {
    const cache = new Map<string, Record<string, any>>();
    function module(rel: string): Record<string, any> {
      if (cache.has(rel)) return cache.get(rel)!;
      if (!original && rel === 'src/lib/boundedWork.ts') return { ...observedWork, ...overrides };
      if (!original && rel === 'src/lib/boundedJson.ts') return graph;
      if (!original && rel === 'src/server/migration/normalizationOutput.ts') return { createNormalizationOutput };
      let text = rel === sourcePath ? fullText : (original ? readFrozenOriginal(rel) : readFileSync(rel, 'utf8'));
      if (rel === sourcePath) {
        text = text.slice(0, statement.end) + '\n__call("public:after", () => ({mappings, sourceRecords}));' + text.slice(statement.end);
        text = text.slice(0, statement.getStart(ast)) + '\n__call("public:before", () => ({mappings, sourceRecords}));' + text.slice(statement.getStart(ast));
      }
      const m = { exports: {} }; cache.set(rel, m.exports);
      const resolve = (id: string) => { if (id === 'server-only') return {}; if (!id.startsWith('.') && !id.startsWith('@/')) return nativeRequire(id); let local = id.startsWith('@/') ? 'src/' + id.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(rel), id)); if (!local.endsWith('.ts')) local += '.ts'; if (original) { if (!frozenOriginalPaths.has(local)) throw new Error('Unknown frozen original module ' + local); } else if (!existsSync(local)) throw new Error('Missing real dependency ' + local); return module(local); };
      new Function('require', 'module', 'exports', '__call', compile(text, rel === sourcePath))(resolve, m, m.exports, call);
      return m.exports;
    }
    api = module(sourcePath);
  }
  return { run: api.__run as (m: M[], b?: B) => M[], key: api.__key as ((m: M, b: B) => string) | undefined, normalize: api.normalizeLegacySnapshots as (input: any, b?: B) => any, observe(value: boolean) { active = value; } };
}
const helper = load();
// Independent merge-run/Buffer model: no candidate usage or native comparison
// count is ever used as an expected debit. Shared references remain occurrences.
function expected(items: M[]) {
  const builds: M[] = []; let a = items.slice(), sortWork = a.length, compareWork = 0;
  for (let width = 1; width < a.length; width *= 2) {
    sortWork++; const next: M[] = [];
    for (let start = 0; start < a.length; start += 2 * width) {
      sortWork++; const left = a.slice(start, start + width), right = a.slice(start + width, start + 2 * width);
      while (left.length || right.length) {
        sortWork += 2; let takeLeft = !right.length;
        if (left.length && right.length) { sortWork++; builds.push(left[0], right[0]); compareWork += 1 + Math.ceil((key(left[0]).length + key(right[0]).length) / 256); takeLeft = key(left[0]) <= key(right[0]); }
        next.push((takeLeft ? left : right).shift()!);
      }
    }
    a = next;
  }
  let contentBytes = 0, keyWork = 0;
  for (const x of builds) {
    const T = Buffer.byteLength(x.targetTable), I = Buffer.byteLength(x.targetId), D = Buffer.byteLength(x.sourceDigest);
    contentBytes += 4 * T + 3 * I + D + 6;
    keyWork += 3 + [x.targetTable, x.targetId, x.sourceDigest].reduce((n, s) => n + Math.ceil(s.length / 256), 0);
    for (const length of [x.targetTable.length + 1, x.targetTable.length + x.targetId.length + 1, x.targetTable.length + x.targetId.length + 2, key(x).length]) keyWork += 1 + Math.ceil(length / 256);
  }
  return { nodes: 2 + 4 * builds.length, slots: 2 * items.length, structuralBytes: 32 + 8 * items.length + 16 * builds.length, contentBytes, work: 1 + sortWork + 4 * items.length + 1 + keyWork + compareWork };
}
const specimens = [[], [d()], [d('B'), d('A')], [d(), d(), d('Z'), d('B')], [d('A\0B', 'C', 'D'), d('A', 'B\0C', 'D')], [d('', '', ''), d('')], [d('한글😀\ud800', '\0', 'é'), d('\udc00')], [d('x'.repeat(255) + '😀', 'y'.repeat(256), '\ud800'), d('x'.repeat(257))], [d('Z'), d('D'), d('A'), d('B'), d('C')]];
const shared = d(); specimens.push([shared, d('B'), shared]);

describe('A6 independently fixed full recipe', () => {
  for (const [i, items] of specimens.entries()) {
    it(`recipe ${i}`, () => { const b = context(); helper.run(items.slice(), b); expect(b.usage()).toEqual(expected(items)); });
    for (const counter of counters) for (const delta of [-1, 0, 1]) {
      const limit = expected(items)[counter] + delta; if (limit < 0) continue;
      it(`total ${i} ${counter} ${delta}`, () => { const b = work.createBudgetContext({ now: () => 0, limits: { [counter]: limit } }); if (delta < 0) expect(() => helper.run(items.slice(), b)).toThrow(work.BudgetExceededError); else { helper.run(items.slice(), b); expect(b.usage()).toEqual(expected(items)); } });
    }
  }
});
describe('O1 O2 executed original statement ownership and literal ordering', () => {
  for (const c of golden.synthetic) for (const bounded of [false, true]) it(`${c.name} budget=${bounded}`, () => {
    const items: M[] = clone(c.items); if (c.shared) items[c.shared[0]] = items[c.shared[1]]; const saved = items.slice(); const b = bounded ? context() : undefined;
    const result = helper.run(items, b); expect(result).toBe(items); expect(result.map(x => saved.indexOf(x))).toEqual(c.indices); expect(JSON.stringify(result)).toBe(c.json);
    expect(Object.isFrozen(result)).toBe(false); for (const x of result) { expect(saved.includes(x)).toBe(true); expect(Object.isFrozen(x)).toBe(false); }
    if (result.length) { result[0].targetId = 'mutated'; expect(saved.find(x => x === result[0])!.targetId).toBe('mutated'); }
    if (b) for (const x of [result, ...result]) { let caught: any; try { graph.canonicalBoundedJson(x as any, b); } catch (error) { caught = error; } expect(caught?.name).toBe('InvalidBoundedJsonError'); expect(caught?.message).toBe('Legacy bounded JSON is invalid.'); }
  });
  it('fresh left full key then right on every comparator without context loss', () => {
    const b = context(), items = [d('B'), d('A'), d('D'), d('C')], trace: string[] = [], values: string[] = [], expectedValues: string[] = []; let comparisons = 0;
    const local = load((name, value) => { if (name.endsWith(':context')) expect(value).toBe(b); if (name === 'comparator:enter') { comparisons++; if (comparisons === 2) { items[2].targetTable = '0'; items[3].targetTable = 'Z'; } } if (name === 'comparator:pair') for (const item of value as M[]) expectedValues.push(item.targetTable, item.targetId, item.sourceDigest); if (['table:return', 'id:return', 'digest:return'].includes(name)) { trace.push(name); values.push(value); } });
    const result = local.run(items, b); expect(comparisons).toBeGreaterThan(1); expect(result.map(x => x.targetTable)).toEqual(['0', 'A', 'B', 'Z']);
    expect(trace).toEqual(Array.from({ length: comparisons * 2 }, () => ['table:return', 'id:return', 'digest:return']).flat()); expect(values).toEqual(expectedValues);
  });
  for (const c of golden.native) for (const late of [false, true]) it(`no-budget native ${c.field} thrown=${c.thrown} late=${late}`, () => {
    const items = [d('B'), d('A')], saved = items.slice(), trace: string[] = [], injected = new RangeError('native'); let caught: unknown, expired = false; const unused = work.createBudgetContext({ now: () => expired ? 5000 : 0 });
    if (c.field === 'sort') Object.defineProperty(items, 'sort', { get() { trace.push('sort:lookup'); expired = late; if (c.thrown) throw injected; return Array.prototype.sort; } });
    for (const [i, item] of items.entries()) for (const field of ['targetTable', 'targetId', 'sourceDigest'] as const) { const value = item[field]; Object.defineProperty(item, field, { get() { trace.push(i + '.' + field); expired = late; if (c.field === field && c.thrown) throw injected; return value; } }); }
    try { helper.run(items); } catch (error) { caught = error; }
    if (late) expect(() => unused.check()).toThrow(work.BudgetUnavailableError); else expect(() => unused.check()).not.toThrow(); expect(trace).toEqual(c.trace); expect(caught === injected).toBe(c.identity); expect(items.map(x => saved.indexOf(x))).toEqual(c.indices);
  });
});
// Historical native sort exists before this slice. These are reached RED, not
// a missing-helper assertion. Native comparator completion is observed locally.
describe('existing-reached native mapping boundaries', () => {
  for (const field of ['targetTable', 'targetId', 'sourceDigest'] as const) it(`late ${field} stops the next operand`, () => {
    let late = false, reached = 0, successor = 0; const real = work.createBudgetContext({ now: () => late ? 5000 : 0 });
    const b = new Proxy({ ...real }, { get(t, k: keyof B) { if (late && (k === 'spend' || k === 'reserveString')) successor++; return t[k]; } });
    const items = [d('B'), d('A')]; for (const item of items) for (const name of ['targetTable', 'targetId', 'sourceDigest'] as const) { const v = item[name]; Object.defineProperty(item, name, { get() { if (late) successor++; if (!reached && name === field) { reached++; late = true; } return v; } }); }
    let caught: unknown; try { helper.run(items, b); } catch (e) { caught = e; } expect(reached).toBe(1); expect(successor).toBe(0); expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
  });
  it('key strings reserve before comparator enters real comparison', () => { const b = context(); let reached = 0, usage: work.BudgetUsage | undefined; const local = load(() => {}, false, false, { compareCodeUnits(a: string, c: string, budget?: B) { reached++; usage = b.usage(); return validators.compareCodeUnits(a, c, budget); } }); local.run([d('B'), d('A')], b); expect(reached).toBe(1); expect(usage!.nodes).toBe(10); });
});

const fields = ['table', 'id', 'digest'] as const;
const states = ['timely', 'expired', 'aborted'] as const;
const exits = ['success', 'ordinary', 'exceeded', 'unavailable'] as const;
const nativeSeams = [...fields, ...fields.map(x => 'utf8:' + x), 'f1', 'f2', 'f3', 'f4', 'compare', 'sort', 'copy:length', 'copy:index', 'copy:write'];
describe('N1 future local native completion before successor METHOD LOOKUP', () => {
  for (const seam of nativeSeams) for (const side of (seam === 'sort' ? [1] : [1, 2])) for (const state of states) for (const exit of exits) it(`${side} ${seam} ${state} ${exit}`, () => {
    let fired = false, reached = 0, successor = 0, completed = 0, ordinal = 0;
    const signal = { aborted: false }; const real = work.createBudgetContext({ now: () => fired && state === 'expired' ? 5000 : 0, signal });
    const b = new Proxy({ ...real }, { get(t, k: keyof B) { if (fired && (k === 'spend' || k === 'reserveString')) successor++; return t[k]; } });
    const injected = exit === 'ordinary' ? new RangeError('native') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    const local = load((name) => {
      if (name === seam + ':return' && ++ordinal === side) { reached++; fired = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw injected; }
      if (fired && (name === 'finalMappingKey:return' || name === 'finalMappingSort:return' || name === 'successor:enter' || name === seam + ':checked:return' || (seam === 'compare' && name === 'comparator:return') || (seam === 'sort' && name === 'copy:length:enter'))) completed++;
    });
    let caught: unknown; try { local.run([d('D'), d('C'), d('B'), d('A')], b); } catch (e) { caught = e; }
    expect(reached, 'actual future operation must reach').toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable' || (state === 'timely' && exit === 'ordinary')) expect(caught).toBe(injected);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(work.BudgetUnavailableError); else expect(caught).toBeUndefined();
    if (state !== 'timely' || exit !== 'success') { expect(successor).toBe(0); expect(completed).toBe(0); }
  });
});

describe('A2 A3 future per-side key field UTF8 frame admission', () => {
  for (const side of [1, 2]) for (const field of fields) for (const delta of [-1, 0, 1]) it(`getter ${side} ${field} work ${delta}`, () => {
    const b = context(), stop = new RangeError('getter admitted'); let keyOrdinal = 0, armed = 0, reached = 0;
    const local = load(name => {
      if (name === 'finalMappingKey:enter') { keyOrdinal++; if (keyOrdinal === side && field === 'table') { armed++; consume(b, 'work', 1 + delta); } }
      if (keyOrdinal === side && name === (field === 'id' ? 'f1:checked:return' : 'f3:checked:return') && field !== 'table') { armed++; consume(b, 'work', 1 + delta); }
      if (keyOrdinal === side && name === field + ':return') { reached++; throw stop; }
    });
    let caught: unknown; try { local.run([d('B'), d('A')], b); } catch (e) { caught = e; } expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
  for (const side of [1, 2]) for (const item of [d('AAA', 'III', 'DDD'), d('한😀\ud800', 'é\0', '\udc00'), d('x'.repeat(255) + '😀', 'i'.repeat(256), 'd'.repeat(257))]) for (const frame of [1, 2, 3, 4]) for (const counter of ['nodes', 'contentBytes', 'structuralBytes', 'work', 'stringBytes'] as const) for (const delta of [-1, 0, 1]) it(`frame ${side} ${JSON.stringify(item)} ${frame} ${counter} ${delta}`, () => {
    const T = Buffer.byteLength(item.targetTable), I = Buffer.byteLength(item.targetId), D = Buffer.byteLength(item.sourceDigest);
    const bytes = [T + 1, T + 1 + I, T + I + 2, T + I + D + 2]; const lengths = [item.targetTable.length + 1, item.targetTable.length + item.targetId.length + 1, item.targetTable.length + item.targetId.length + 2, key(item).length];
    const real = work.createBudgetContext({ now: () => 0, limits: counter === 'stringBytes' ? { stringBytes: bytes[frame - 1] + delta } : {} }); let ordinal = 0, armed = 0, reached = 0; const stop = new RangeError('actual concat admitted');
    const predecessor = ['utf8:table:checked:return', 'utf8:id:checked:return', 'f2:checked:return', 'utf8:digest:checked:return'][frame - 1];
    const b = real;
    const local = load(name => {
      if (name === 'finalMappingKey:enter') ordinal++;
      if (name === predecessor && ordinal === side) { armed++; if (counter !== 'stringBytes') consume(real, counter, ({ nodes: 1, contentBytes: bytes[frame - 1], structuralBytes: 4, work: 1 + Math.ceil(lengths[frame - 1] / 256) })[counter] + delta); }
      if (name === 'f' + frame + ':return' && ordinal === side) { reached++; throw stop; }
    });
    let caught: unknown; try { local.run([side === 2 && counter === 'stringBytes' ? d('', '', '') : { ...item }, { ...item }], b); } catch (e) { caught = e; } expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
  for (const side of [1, 2]) for (const field of fields) for (const value of ['', 'A', '한', '😀', '\0', '\ud800', '\udc00', 'a'.repeat(255) + '😀', 'a'.repeat(256), 'a'.repeat(257)]) for (const delta of [-1, 0, 1]) {
    const cost = Math.ceil(value.length / 256); if (cost + delta < 0) continue;
    it(`UTF8 ${side} ${field} ${JSON.stringify(value)} work ${delta}`, () => {
      const b = context(), stop = new RangeError('UTF8 admitted'); let ordinal = 0, armed = 0, reached = 0;
      const item = d(value, value, value);
      const local = load(name => { if (name === 'finalMappingKey:enter') ordinal++; if (ordinal === side && name === field + ':checked:return') { armed++; consume(b, 'work', cost + delta); } if (ordinal === side && name === 'utf8:' + field + ':return') { reached++; throw stop; } });
      let caught: unknown; try { local.run([{ ...item }, { ...item }], b); } catch (e) { caught = e; } expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
    });
  }
});

describe('A1 A4 A5 actual shared sort and returned-array admission', () => {
  for (const n of [0, 1, 2, 5]) for (const counter of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) {
    const cost = { nodes: 2, slots: 2 * n, structuralBytes: 32 + 8 * n }[counter]; if (cost + delta < 0) continue;
    it(`scratch ${n} ${counter} ${delta}`, () => {
      const b = context(), stop = new RangeError('scratch admitted'); let armed = 0, allocated = 0;
      const mod: Record<string, any> = {}; new Function('exports', 'Array', compile(readFileSync(process.env.MAPPING_SORT_WORK_SOURCE ?? 'src/lib/boundedWork.ts', 'utf8'), false))(mod, new Proxy(Array, { construct(t, args) { Reflect.construct(t, args); allocated++; throw stop; } }));
      const local = load(name => { if (name === 'sort:context') { armed++; consume(b, counter, cost + delta); } }, false, false, { stableBudgetSort(input: M[], cmp: any, budget: B) { armed++; consume(b, counter, cost + delta); return mod.stableBudgetSort(input, cmp, budget); } });
      let caught: unknown; try { local.run(Array.from({ length: n }, () => d()), b); } catch (e) { caught = e; } expect(armed).toBe(1); expect(allocated).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
    });
  }
  for (const delta of [-1, 0, 1]) it(`entry work ${delta}`, () => { const b = context(), stop = new RangeError('sort input admitted'); let reached = 0; consume(b, 'work', 1 + delta); const local = load(); const items = new Proxy([] as M[], { get(t, k, r) { const value = Reflect.get(t, k, r); if (k === 'length') { reached++; throw stop; } return value; } }); let caught: unknown; try { local.run(items, b); } catch (e) { caught = e; } expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop); });
  for (const position of [0, 1, 2, 3]) for (const seam of ['length', 'index', 'write'] as const) for (const delta of [-1, 0, 1]) {
    if (position === 3 && seam !== 'length') continue;
    it(`copyback ${position} ${seam} ${delta}`, () => {
      const b = context(), stop = new RangeError('actual copy operand admitted'); let index = 0, sorted = false, armed = 0, reached = 0;
      const arm = () => { armed++; consume(b, 'work', (seam === 'index' ? 2 : 1) + delta); };
      const local = load(name => {
        if (name === 'sort:return') { sorted = true; if (position === 0 && seam === 'length') arm(); }
        if (!sorted) return;
        if (name === 'copy:length:checked:return' && index === position && seam === 'index') arm();
        if (name === 'copy:index:checked:return' && index === position && seam === 'write') arm();
        if (name === 'copy:write:checked:return') { index++; if (index === position && seam === 'length') arm(); }
        if (name === 'copy:' + seam + ':return' && index === position) { reached++; throw stop; }
      });
      let caught: unknown; try { local.run([d('C'), d('B'), d('A')], b); } catch (e) { caught = e; } expect(sorted).toBe(true); expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
    });
  }
  for (const delta of [-1, 0, 1]) it(`compare work ${delta}`, () => { const b = context(), stop = new RangeError('compare admitted'); let frames = 0, armed = 0, reached = 0; const local = load(name => { if (name === 'f4:checked:return' && ++frames === 2) { armed++; consume(b, 'work', 2 + delta); } if (name === 'compare:return') { reached++; throw stop; } }); let caught: unknown; try { local.run([d('B'), d('A')], b); } catch (e) { caught = e; } expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop); });
});

describe('I1 original natural public outputs raw same-receiver and source state', () => {
  const observations: Record<string, any> = {};
  const local = load((name, value) => { if (name === 'public:before:return') { observations.receiver = value.mappings; observations.items = value.mappings.slice(); observations.pre = JSON.stringify(value.mappings); observations.sourceBefore = JSON.stringify(value.sourceRecords); } if (name === 'public:after:return') { observations.same = value.mappings === observations.receiver; observations.indices = value.mappings.map((x: M) => observations.items.indexOf(x)); observations.post = JSON.stringify(value.mappings); observations.sourceAfter = JSON.stringify(value.sourceRecords); } }, false, true);
  for (const c of golden.cases) for (const bounded of [false, true]) it(`${c.name} budget=${bounded}`, () => {
    const b = bounded ? context() : undefined; const input = b ? graph.parseRegisteredBoundedJson(JSON.stringify(c.input), b) : clone(c.input);
    local.observe(true); const actual = local.normalize(input, b); expect(JSON.stringify(actual)).toBe(c.json); expect(actual.mappings).toBe(observations.receiver);
    for (const k of ['pre', 'post', 'sourceBefore', 'sourceAfter', 'same', 'indices']) expect(observations[k]).toEqual(c.raw[k]);
    local.observe(false); const b2 = bounded ? context() : undefined; const input2 = b2 ? graph.parseRegisteredBoundedJson(JSON.stringify(c.input), b2) : clone(c.input); expect(JSON.stringify(local.normalize(input2, b2))).toBe(c.json);
  });
});

describe('I1 actual public Target completion to FIRST mapping spend METHOD LOOKUP', () => {
  for (const state of states) for (const exit of exits) it(`${state} ${exit}`, () => {
    let count = 0, length = -1, reached = 0, armed = false, successor = 0, mappingEntry = 0; const signal = { aborted: false };
    const real = work.createBudgetContext({ now: () => armed && state === 'expired' ? 5000 : 0, signal });
    const b = new Proxy({ ...real }, { get(t, k: keyof B) { if (armed && k === 'spend') successor++; return t[k]; } });
    const injected = exit === 'ordinary' ? new RangeError('terminal Target') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    const local = load((name, value) => {
      if (name === 'targetIndexEntries:return') length = value.length;
      if (name === 'target:terminal:return' && ++count === length + 1) { reached++; armed = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw injected; }
      if (name === 'finalMappingSort:enter') mappingEntry++;
      if (name === 'sort:context' && armed) { expect(value).toBe(b); throw injected; }
    }, false, true);
    const input = graph.parseRegisteredBoundedJson(JSON.stringify(golden.cases[0].input), b); let caught: unknown;
    try { local.normalize(input, b); } catch (e) { caught = e; }
    expect(reached).toBe(1); if (state === 'timely' && exit === 'success') { expect(mappingEntry).toBe(1); expect(successor).toBe(1); expect(caught).toBe(injected); }
    else { expect(successor).toBe(0); expect(mappingEntry).toBe(0); if (exit === 'exceeded' || exit === 'unavailable' || state === 'timely') expect(caught).toBe(injected); else expect(caught).toBeInstanceOf(work.BudgetUnavailableError); }
  });
});

describe('I1 final mapping copy completion blocks actual source sort PROPERTY LOOKUP', () => {
  for (const seam of ['copy:write', 'copy:length']) for (const state of states) for (const exit of exits) it(`${seam} ${state} ${exit}`, () => {
    let reached = 0, mapping = false, successor = 0, armed = false, writes = 0, lengths = 0, count = 0; const signal = { aborted: false };
    const b = work.createBudgetContext({ now: () => armed && state === 'expired' ? 5000 : 0, signal });
    const injected = exit === 'ordinary' ? new RangeError('final copy') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    const local = load((name, value) => {
      if (name === 'public:before:return') { mapping = true; count = value.mappings.length; Object.defineProperty(value.sourceRecords, 'sort', { get() { successor++; throw injected; } }); }
      if (!mapping) return;
      const last = name === 'copy:write:return' ? ++writes === count : name === 'copy:length:return' ? ++lengths === count + 1 : false;
      if (name === seam + ':return' && last) { reached++; armed = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw injected; }
    }, false, true);
    const input = graph.parseRegisteredBoundedJson(JSON.stringify(golden.cases.find((c: any) => c.classification.mappingCount > 0).input), b); let caught: unknown;
    try { local.normalize(input, b); } catch (e) { caught = e; }
    expect(reached).toBe(1); expect(successor).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable' || state === 'timely') expect(caught).toBe(injected); else expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
  });
});


describe('A4 shared implementation work before earliest owned operand', () => {
  for (const stage of ['copy', 'pass', 'block', 'output', 'comparison', 'write']) for (const delta of [-1, 0, 1]) it(`${stage} ${delta}`, () => {
    const real = context(), stop = new RangeError('shared operand admitted'); let armed = 0, reached = 0;
    const blockLabel = (block: ts.Node): string => {
      const parent = block.parent;
      if (parent && ts.isForStatement(parent) && parent.initializer && ts.isVariableDeclarationList(parent.initializer)) {
        const name = parent.initializer.declarations[0].name.getText();
        return ({ i: 'copy', width: 'pass', start: 'block', output: 'output' } as Record<string, string>)[name] ?? '';
      }
      return parent && ts.isIfStatement(parent) && parent.expression.getText() === 'left < mid && right < end' ? 'comparison' : '';
    };
    const event = (kind: string) => {
      const wanted = ({ copy: 'input', pass: 'spend:block', block: 'min', output: 'spend:comparison', comparison: 'scratch', write: 'scratch' } as Record<string, string>)[stage];
      if (armed && kind === wanted) { reached++; throw stop; }
    };
    const sharedTransformer: ts.TransformerFactory<ts.SourceFile> = ctx => root => {
      let owned = false;
      const marker = () => ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createIdentifier('__arm'), undefined, []));
      const visit: ts.Visitor = node => {
        if (ts.isFunctionDeclaration(node)) { const old = owned; owned = node.name?.text === 'stableBudgetSort'; const result = ts.visitEachChild(node, visit, ctx); owned = old; return result; }
        if (owned && ts.isBlock(node)) {
          const label = blockLabel(node); const statements: ts.Statement[] = [];
          if (label === stage) statements.push(marker());
          for (const statement of node.statements) {
            statements.push(ts.visitNode(statement, visit) as ts.Statement);
            if (stage === 'write' && label === 'output' && ts.isIfStatement(statement) && statement.expression.getText(root) === 'left < mid && right < end') statements.push(marker());
          }
          return ts.factory.updateBlock(node, statements);
        }
        if (owned && ts.isPropertyAccessExpression(node) && node.getText(root) === 'budget.spend') {
          let ancestor: ts.Node | undefined = node.parent;
          while (ancestor && !ts.isBlock(ancestor)) ancestor = ancestor.parent;
          const label = ancestor ? blockLabel(ancestor) : '';
          return ts.factory.createCallExpression(ts.factory.createIdentifier('__lookup'), undefined, [ts.factory.createStringLiteral('spend:' + label), ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node)]);
        }
        return ts.visitEachChild(node, visit, ctx);
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    };
    const mod: Record<string, any> = {};
    const js = ts.transpileModule(readFileSync(process.env.MAPPING_SORT_WORK_SOURCE ?? 'src/lib/boundedWork.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: { before: [sharedTransformer] } }).outputText;
    new Function('exports', 'Array', 'Math', '__arm', '__lookup', js)(mod,
      new Proxy(Array, { construct(t, args) { return new Proxy(Reflect.construct(t, args), { get(t, k, r) { const result = Reflect.get(t, k, r); if (typeof k === 'string' && /^\d+$/.test(k)) event('scratch'); return result; }, set(t, k, v, r) { event('scratch'); return Reflect.set(t, k, v, r); } }); } }),
      new Proxy(Math, { get(t, k, r) { if (k === 'min') event('min'); return Reflect.get(t, k, r); } }),
      () => { if (!armed) { consume(real, 'work', 1 + delta); armed++; } },
      (label: string, operation: () => B['spend']) => { event(label); return operation(); });
    const input = new Proxy([d('B'), d('A')], { get(t, k, r) { const result = Reflect.get(t, k, r); if (typeof k === 'string' && /^\d+$/.test(k)) event('input'); return result; } });
    const local = load(() => {}, false, false, { stableBudgetSort(values: M[], cmp: any, budget: B) { return mod.stableBudgetSort(values, cmp, budget); } });
    let caught: unknown; try { local.run(input, real); } catch (e) { caught = e; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
});

describe('O1 no final category emissions hash serialization or ownership reset', () => {
  it('all category methods untouched under identical context', () => {
    const b = context(); let calls = 0;
    const local = load(() => {}, false, false, { createNormalizationOutput() { calls++; throw new Error('no sort category owner'); }, sha256() { calls++; throw new Error('no sort hash'); }, canonicalJson() { calls++; throw new Error('no serialization'); } });
    const items = [d(), d(), d('B')]; local.run(items, b); expect(calls).toBe(0); expect(items).toHaveLength(3); expect(b.usage()).toEqual(expected(items));
  });
});


describe('A2 supplemental real UTF8 boundary-crossing read admission', () => {
  for (const side of [1, 2]) for (const field of fields) for (const delta of [-1, 0, 1]) it(`${side} ${field} block256 ${delta}`, () => {
    const b = context(), stop = new RangeError('low surrogate read admitted'); let keyOrdinal = 0, utfField = '', armed = 0, read = 0;
    const utfTransformer: ts.TransformerFactory<ts.SourceFile> = ctx => root => {
      const visit: ts.Visitor = node => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'charCodeAt') return ts.factory.createCallExpression(ts.factory.createIdentifier('__utfRead'), undefined, [node.arguments[0], ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node)]);
        return ts.visitEachChild(node, visit, ctx);
      }; return ts.visitNode(root, visit) as ts.SourceFile;
    };
    const mod: Record<string, any> = {};
    const js = ts.transpileModule(readFileSync(process.env.MAPPING_SORT_WORK_SOURCE ?? 'src/lib/boundedWork.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: { before: [utfTransformer] } }).outputText;
    new Function('exports', '__utfRead', js)(mod, (index: number, operation: () => number) => {
      const result = operation();
      if (keyOrdinal === side && utfField === field) { if (index === 255) { armed++; consume(b, 'work', 1 + delta); } if (index === 256) { read++; throw stop; } }
      return result;
    });
    const local = load(name => { if (name === 'finalMappingKey:enter') keyOrdinal++; for (const f of fields) if (name === 'utf8:' + f + ':enter') utfField = f; }, false, false, { utf8ByteLength: mod.utf8ByteLength });
    const value = 'a'.repeat(255) + '😀', item = d(value, value, value); let caught: unknown;
    try { local.run([{ ...item }, { ...item }], b); } catch (e) { caught = e; }
    expect(armed).toBe(1); expect(read).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
});


function naturalGetterProbe(input: unknown, bounded: boolean, original: boolean, getters = true) {
  const trace: string[] = []; let receiver: M[] | undefined, references: M[] = [], after: M[] = [];
  const b = bounded ? context() : undefined;
  const local = load((name, value) => {
    if (name === 'public:before:return') {
      receiver = value.mappings; references = value.mappings.slice();
      if (getters) for (const [i, item] of references.entries()) for (const field of ['targetTable', 'targetId', 'sourceDigest', 'status'] as const) {
        const scalar = item[field]; Object.defineProperty(item, field, { configurable: true, enumerable: true, get() { trace.push(i + ':' + field); return scalar; } });
      }
    }
    if (name === 'public:after:return') after = value.mappings.slice();
  }, original, true);
  const actual = local.normalize(b ? graph.parseRegisteredBoundedJson(JSON.stringify(input), b) : clone(input), b);
  // Freeze the native observer trace before serializing results adds its reads.
  const sortTrace = trace.slice();
  return { json: JSON.stringify(actual), sortTrace, receiverSame: actual.mappings === receiver, indices: after.map(x => references.indexOf(x)), mutable: !Object.isFrozen(receiver) && references.every(x => !Object.isFrozen(x)) };
}
describe('O1 supplemental executed original natural getter noninterference', () => {
  for (const c of golden.cases) it(c.name, () => {
    const original = naturalGetterProbe(c.input, false, true), plainOriginal = naturalGetterProbe(c.input, false, true, false);
    const omission = naturalGetterProbe(c.input, false, false), bounded = naturalGetterProbe(c.input, true, false), plainBounded = naturalGetterProbe(c.input, true, false, false);
    for (const outcome of [original, plainOriginal, omission, bounded, plainBounded]) { expect(outcome.json).toBe(c.json); expect(outcome.receiverSame).toBe(true); expect(outcome.indices).toEqual(c.raw.indices); expect(outcome.mutable).toBe(true); }
    expect(omission.sortTrace).toEqual(original.sortTrace);
    if (c.classification.mappingCount > 1) expect(bounded.sortTrace.length).toBeGreaterThan(0);
  });
});

describe('A4 supplemental actual compare primitive admission', () => {
  for (const length of [1, 255, 256, 257]) for (const delta of [-1, 0, 1]) it(`primitive ${length} ${delta}`, () => {
    const b = context(), items = [d('b'.repeat(length)), d('a'.repeat(length))], stop = new RangeError('real compare primitive completed'); let keys = 0, armed = 0, reached = 0;
    const full = readFileSync(process.env.MAPPING_SORT_VALIDATORS_SOURCE ?? 'src/server/migration/validators.ts', 'utf8');
    const ast = ts.createSourceFile('validators.ts', full, ts.ScriptTarget.ESNext, true);
    const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'compareCodeUnits')!;
    const primitive: ts.TransformerFactory<ts.SourceFile> = ctx => root => {
      const visit: ts.Visitor = node => {
        if (ts.isConditionalExpression(node) && node.getText(root) === 'left < right ? -1 : left > right ? 1 : 0') return ts.factory.createCallExpression(ts.factory.createIdentifier('__primitive'), undefined, [node]);
        return ts.visitEachChild(node, visit, ctx);
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    };
    const mod: Record<string, any> = {};
    const js = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: { before: [primitive] } }).outputText;
    new Function('exports', '__primitive', js)(mod, () => { reached++; throw stop; });
    const local = load(name => { if (name === 'f4:checked:return' && ++keys === 2) { armed++; consume(b, 'work', 1 + Math.ceil((key(items[0]).length + key(items[1]).length) / 256) + delta); } }, false, false, { compareCodeUnits: mod.compareCodeUnits });
    let caught: unknown; try { local.run(items, b); } catch (e) { caught = e; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
});


describe('restart final helper completion check', () => {
  for (const n of [0, 2]) for (const state of ['expired', 'aborted']) it(`${n} ${state}`, () => {
    let reached = 0, returned = 0; const signal = { aborted: false };
    const b = work.createBudgetContext({ now: () => reached && state === 'expired' ? 5000 : 0, signal });
    const local = load((name, value) => {
      if (name === 'copy:length:checked:return' && value === n) {
        // Only arm at the terminating length check, after all writes.
        if (++lengths === n + 1) { reached++; signal.aborted = state === 'aborted'; }
      }
      if (name === 'finalMappingSort:return' || name === 'successor:enter') returned++;
    });
    let lengths = 0; let caught: unknown;
    try { local.run(Array.from({ length: n }, () => d()), b); } catch (e) { caught = e; }
    expect(reached).toBe(1); expect(caught).toBeInstanceOf(work.BudgetUnavailableError); expect(returned).toBe(0);
  });
});



// Observe the real native String operand globally so replacing/removing a helper
// cannot erase the observation. Native work delegates unchanged; restore before assertions.
function metadataString(value: unknown, operation: () => void, body: () => void) {
  const saved = globalThis.String;
  globalThis.String = new Proxy(saved, { apply(target, receiver, args) {
    const result = Reflect.apply(target, receiver, args);
    if (args[0] === value) operation();
    return result;
  } });
  try { body(); } finally { globalThis.String = saved; }
}
const metadataRecipes = [
  { name: 'null', json: 'null', cost: { nodes: 65, slots: 256, structuralBytes: 8196, contentBytes: 9, work: 3 } },
  // Two registered arrays: inner 41 bytes, outer 42; each join and outer String
  // reserve their own payload. 64 recursion nodes + 5 string/container nodes.
  { name: 'nested', json: '[null,[12,"한😀",null]]', cost: { nodes: 69, slots: 261, structuralBytes: 8256, contentBytes: 125, work: 20 } },
];
describe('MD reached conversion reservation before native String', () => {
  for (const side of [1, 2]) for (const recipe of metadataRecipes) for (const counter of counters) for (const delta of [-1, 0, 1]) it(`${side} ${recipe.name} ${counter} ${delta}`, () => {
    const b = context(), raw = graph.parseRegisteredBoundedJson(recipe.json, b), stop = new RangeError('String reached');
    let ordinal = 0, armed = 0, reached = 0, caught: unknown;
    const local = load(name => { if (name === 'digest:checked:return' && ++ordinal === side) { armed++; consume(b, counter, recipe.cost[counter] + delta); } });
    const items = [d(), d()]; items[side - 1].sourceDigest = raw as any;
    metadataString(raw, () => { if (armed) { reached++; throw stop; } }, () => { try { local.run(items, b); } catch (e) { caught = e; } });
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
});
describe('MD reached native conversion completion before UTF8', () => {
  for (const side of [1, 2]) for (const state of states) for (const exit of exits) it(`${side} ${state} ${exit}`, () => {
    let ordinal = 0, armed = false, fired = false, reached = 0, successor = 0, caught: unknown;
    const signal = { aborted: false }, b = work.createBudgetContext({ now: () => fired && state === 'expired' ? 5000 : 0, signal });
    const raw = graph.parseRegisteredBoundedJson('[12,"한😀"]', b);
    const injected = exit === 'ordinary' ? new RangeError('String exit') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    const local = load(name => {
      if (name === 'digest:checked:return' && ++ordinal === side) armed = true;
      if (fired && name === 'utf8:digest:enter') successor++;
    });
    const items = [d(), d()]; items[side - 1].sourceDigest = raw as any;
    metadataString(raw, () => { if (armed) { reached++; fired = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw injected; } }, () => { try { local.run(items, b); } catch (e) { caught = e; } });
    expect(reached).toBe(1);
    if (exit === 'exceeded' || exit === 'unavailable' || (exit === 'ordinary' && state === 'timely')) expect(caught).toBe(injected);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(work.BudgetUnavailableError); else expect(caught).toBeUndefined();
    expect(successor).toBe(state === 'timely' && exit === 'success' ? (side === 1 ? 2 : 1) : 0);
  });
});
describe('MD raw getter completion and private graph ownership', () => {
  for (const side of [1, 2]) for (const kind of ['foreign', 'mutable']) it(`${side} ${kind} refuses before coercion`, () => {
    const b = context(), raw = kind === 'foreign' ? graph.parseRegisteredBoundedJson('[12]', context()) : [12];
    let armed = false, ordinal = 0, reached = 0, caught: any;
    const local = load(name => { if (name === 'digest:checked:return' && ++ordinal === side) armed = true; });
    const items = [d(), d()]; items[side - 1].sourceDigest = raw as any;
    metadataString(raw, () => { if (armed) reached++; }, () => { try { local.run(items, b); } catch (e) { caught = e; } });
    expect(armed).toBe(true); expect(reached).toBe(0); expect(caught?.name).toBe('InvalidBoundedJsonError');
  });
  for (const side of [1, 2]) for (const state of ['expired', 'aborted']) it(`${side} getter ${state} before conversion`, () => {
    let ordinal = 0, fired = false, reached = 0, caught: unknown;
    const signal = { aborted: false }, b = work.createBudgetContext({ now: () => fired && state === 'expired' ? 5000 : 0, signal });
    const raw = graph.parseRegisteredBoundedJson('[12]', b), items = [d(), d()]; items[side - 1].sourceDigest = raw as any;
    const local = load(name => { if (name === 'digest:return' && ++ordinal === side) { fired = true; signal.aborted = state === 'aborted'; } });
    metadataString(raw, () => { reached++; }, () => { try { local.run(items, b); } catch (e) { caught = e; } });
    expect(fired).toBe(true); expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
  });
});

const metadataGolden = JSON.parse(readFileSync('src/server/migration/__fixtures__/mapping-metadata-original-golden.json', 'utf8'));
describe('MD compatibility original Git metadata domain', () => {
  // Quarantined non-string hashes fail in an earlier, unowned hash helper.
  // Retain their executed original errors as no-budget controls, not mapping claims.
  for (const c of metadataGolden.cases) for (const bounded of (c.name.endsWith('/quarantined') ? [false] : [false, true])) it(`${c.name} budget=${bounded}`, () => {
    const b = bounded ? context() : undefined;
    const input: any = b ? graph.parseRegisteredBoundedJson(JSON.stringify(c.input), b) : clone(c.input);
    let before: M[] = [], after: M[] = [];
    const local = load((name, value) => {
      if (name === 'public:before:return') before = value.mappings.slice();
      if (name === 'public:after:return') after = value.mappings;
    }, false, true);
    let result: any, caught: any;
    try { result = local.normalize(input, b); } catch (error) { caught = error; }
    if (c.error) { expect(caught?.name).toBe(c.error.name); expect(caught?.message).toBe(c.error.message); }
    else {
      expect(caught).toBeUndefined(); expect(JSON.stringify(result)).toBe(c.json);
      expect(after.length).toBe(before.length);
      for (const item of after) { expect(before.includes(item)).toBe(true); expect(Object.isFrozen(item)).toBe(false); }
      const raw = input.sheets.tabs.Products.rows[0].hash;
      if (!c.name.endsWith('/quarantined')) expect(after.some(item => item.sourceDigest === raw)).toBe(true);
    }
  });
});

describe('A1 supplemental both real private scratch allocations', () => {
  for (const n of [0, 1, 2, 5]) it(`two actual arrays ${n}`, () => {
    const b = context(), arrays: unknown[] = [];
    const mod: Record<string, any> = {};
    new Function('exports', 'Array', compile(readFileSync(process.env.MAPPING_SORT_WORK_SOURCE ?? 'src/lib/boundedWork.ts', 'utf8'), false))(mod, new Proxy(Array, { construct(t, args) { const value = Reflect.construct(t, args); arrays.push(value); return value; } }));
    const local = load(() => {}, false, false, { stableBudgetSort: mod.stableBudgetSort });
    const items = Array.from({ length: n }, (_, i) => d(String(n - i)));
    expect(local.run(items, b)).toBe(items); expect(arrays).toHaveLength(2); expect(arrays[0]).not.toBe(arrays[1]); for (const scratch of arrays) expect(scratch).not.toBe(items);
  });
});

// MV is supplemental regression/mutation evidence on the inherited repair, NOT
// chronological implementation RED. Load the entire actual graph module so its
// decoder and conversion share the private shape table and identical owner.
function metadataGraph(hook: Hook = () => {}) {
  const text = readFileSync(process.env.MAPPING_METADATA_GRAPH_SOURCE ?? 'src/lib/boundedJson.ts', 'utf8');
  const observe: ts.TransformerFactory<ts.SourceFile> = ctx => {
    const f = ctx.factory; let inside = false;
    const event = (name: string, value: ts.Expression) => f.createCallExpression(f.createIdentifier('__md'), undefined, [f.createStringLiteral(name), value]);
    const visit: ts.Visitor = node => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'size' && node.parameters.length === 3) {
        const previous = inside; inside = true;
        const updated = ts.visitEachChild(node, visit, ctx) as ts.FunctionDeclaration;
        inside = previous;
        return f.updateFunctionDeclaration(updated, updated.modifiers, updated.asteriskToken, updated.name, updated.typeParameters, updated.parameters, updated.type, f.updateBlock(updated.body!, [
          f.createExpressionStatement(event('size:enter', f.createObjectLiteralExpression(['input', 'depth'].map(k => f.createShorthandPropertyAssignment(k))))), ...updated.body!.statements,
        ]));
      }
      if (inside && ts.isReturnStatement(node) && node.expression) return f.updateReturnStatement(node, event('size:return', f.createObjectLiteralExpression([
        f.createPropertyAssignment('value', ts.visitNode(node.expression, visit) as ts.Expression), f.createShorthandPropertyAssignment('input'), f.createShorthandPropertyAssignment('depth'),
      ])));
      return ts.visitEachChild(node, visit, ctx);
    };
    return file => ts.visitNode(file, visit) as ts.SourceFile;
  };
  const cacheKey = 'metadata-graph:' + text;
  let js = jsCache.get(cacheKey);
  if (!js) { js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: { before: [observe] } }).outputText; jsCache.set(cacheKey, js); }
  const api: Record<string, any> = {}; let converting = false;
  const nativeString = new Proxy(String, { apply(target, receiver, args) {
    if (!converting) return Reflect.apply(target, receiver, args);
    hook('native:enter', args[0]);
    let result: string;
    try { result = Reflect.apply(target, receiver, args); }
    catch (error) { hook('native:throw', error); throw error; }
    hook('native:return', result); return result;
  } });
  new Function('require', 'exports', '__md', 'String', js)(
    (id: string) => { if (id !== './boundedWork') throw new Error('Unexpected graph dependency ' + id); return work; }, api,
    (name: string, value: any) => { hook(name, value); return name === 'size:return' ? value.value : value; }, nativeString,
  );
  const convert = api.stringBoundedJson;
  api.stringBoundedJson = (value: unknown, b: B) => { converting = true; try { hook('helper:enter', b); const result = convert(value, b); hook('helper:return', result); return result; } catch (error) { hook('helper:throw', error); throw error; } finally { converting = false; } };
  return api;
}
const mvBoundaries = [
  { name: 'scratch', json: 'null', arm: 'helper:enter', stop: 'size:enter', depth: 1, cost: { nodes: 64, slots: 256, structuralBytes: 8192, contentBytes: 0, work: 0 } },
  // [null,"x"] has one comma plus one byte, raised to the existing 15-byte
  // minimum. Join payload node + container node, two slots, 4+16+8 bytes.
  { name: 'inner-join', json: '[[null,"x"]]', arm: 'size:return', armDepth: 3, stop: 'size:return', depth: 2, cost: { nodes: 2, slots: 2, structuralBytes: 28, contentBytes: 15, work: 2 } },
  { name: 'outer-join', json: '[[null,"x"]]', arm: 'size:return', armDepth: 2, stop: 'size:return', depth: 1, cost: { nodes: 2, slots: 1, structuralBytes: 24, contentBytes: 15, work: 2 } },
  { name: 'outer-conversion', json: '[[null,"x"]]', arm: 'size:return', armDepth: 1, stop: 'native:enter', depth: 0, cost: { nodes: 1, slots: 0, structuralBytes: 4, contentBytes: 15, work: 2 } },
];
describe('MV independent shared subreservations at actual mapping caller', () => {
  for (const side of [1, 2]) for (const boundary of mvBoundaries) for (const counter of counters) for (const delta of [-1, 0, 1]) {
    if (!boundary.cost[counter]) continue;
    it(`${side} ${boundary.name} ${counter} ${delta}`, () => {
      const b = context(), stop = new RangeError('independent checkpoint');
      let selected = false, ordinal = 0, armed = 0, reached = 0, caught: unknown;
      const g = metadataGraph((name, value) => {
        if (!selected) return;
        if (name === boundary.arm && (boundary.armDepth === undefined || value.depth === boundary.armDepth) && (boundary.name !== 'inner-join' || value.input === 'x')) {
          armed++; consume(b, counter, boundary.cost[counter] + delta);
        }
        if (armed && name === boundary.stop && (!boundary.depth || value.depth === boundary.depth)) { reached++; throw stop; }
      });
      const raw = g.parseRegisteredBoundedJson(boundary.json, b), items = [d(), d()]; items[side - 1].sourceDigest = raw;
      const local = load(name => { if (name === 'digest:checked:return' && ++ordinal === side) selected = true; }, false, false, { stringBoundedJson: g.stringBoundedJson });
      try { local.run(items, b); } catch (e) { caught = e; }
      expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
      if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
    });
  }
});
describe('MV same-owner depth instrumentation with default depth ceiling', () => {
  for (const side of [1, 2]) for (const delta of [-1, 0, 1]) it(`${side} depth headroom ${delta}`, () => {
    const real = context(); let active = false, reached = 0, ordinal = 0, caught: unknown;
    const depths: number[] = [], stop = new RangeError('native after depth');
    // Capacity sentinel, NOT natural decoder admission of an over-depth graph.
    // The same-owner forwarding context shifts only the real conversion's depth
    // operand; the actual unchanged checkDepth enforces its DEFAULT limit.
    const b: B = { ...real, checkDepth(depth: number) { if (active) { depths.push(depth); real.checkDepth(depth + real.limits.depth - 3 - delta); } else real.checkDepth(depth); } };
    const g = metadataGraph(name => { if (name === 'helper:enter') active = true; if (name === 'native:enter') { reached++; throw stop; } });
    const raw = g.parseRegisteredBoundedJson('[[null]]', b), items = [d(), d()]; items[side - 1].sourceDigest = raw;
    const local = load(name => { if (name === 'digest:checked:return') ordinal++; }, false, false, { stringBoundedJson: g.stringBoundedJson });
    try { local.run(items, b); } catch (e) { caught = e; }
    expect(ordinal).toBe(side); expect(reached).toBe(delta < 0 ? 0 : 1); expect(depths).toEqual([1, 2, 3]);
    if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
});
describe('MV local native completion versus redundant caller protection', () => {
  for (const side of [1, 2]) for (const state of states) for (const exit of exits) it(`${side} ${state} ${exit}`, () => {
    let fired = false, returned = 0, native = 0, successor = 0, caught: unknown, helperError: unknown;
    const signal = { aborted: false }, b = work.createBudgetContext({ now: () => fired && state === 'expired' ? 5000 : 0, signal });
    const injected = exit === 'ordinary' ? new RangeError('native exit') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    const g = metadataGraph((name, value) => {
      if (name === 'helper:throw') helperError = value;
      if (name === 'native:return') { native++; fired = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw injected; }
      if (name === 'helper:return') returned++;
    });
    const raw = g.parseRegisteredBoundedJson('[null,"한😀"]', b), items = [d(), d()]; items[side - 1].sourceDigest = raw;
    const local = load(name => { if (fired && name === 'utf8:digest:enter') successor++; }, false, false, { stringBoundedJson: g.stringBoundedJson });
    try { local.run(items, b); } catch (e) { caught = e; }
    expect(native).toBe(1); expect(returned).toBe(state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit === 'exceeded' || exit === 'unavailable' || (exit === 'ordinary' && state === 'timely')) expect(helperError).toBe(injected);
    else if (state !== 'timely') expect(helperError).toBeInstanceOf(work.BudgetUnavailableError); else expect(helperError).toBeUndefined();
    expect(successor).toBe(state === 'timely' && exit === 'success' ? (side === 1 ? 2 : 1) : 0);
    if (exit === 'exceeded' || exit === 'unavailable' || (exit === 'ordinary' && state === 'timely')) expect(caught).toBe(injected);
    else if (state !== 'timely') expect(caught).toBeInstanceOf(work.BudgetUnavailableError); else expect(caught).toBeUndefined();
  });
});

const mvValues = ['null', 'false', '12', '{}', '[null,[12,"한😀","\\ud800"]]', JSON.stringify(['a'.repeat(255) + '😀']), JSON.stringify(['a'.repeat(257)])];
describe('MV nonstring successor UTF8 and four actual frames', () => {
  for (const side of [1, 2]) for (const json of mvValues) for (const delta of [-1, 0, 1]) it(`UTF8 ${side} ${json} ${delta}`, () => {
    const b = context(), stop = new RangeError('UTF8 finished'); let ordinal = 0, armed = 0, reached = 0, caught: unknown;
    const raw = graph.parseRegisteredBoundedJson(json, b), text = String(raw);
    const g = metadataGraph(name => { if (name === 'helper:return') { armed++; consume(b, 'work', Math.ceil(text.length / 256) + delta); } });
    // Operand ownership belongs to this independently loaded actual decoder.
    const owned = g.parseRegisteredBoundedJson(json, b), items = [d(), d()]; items[side - 1].sourceDigest = owned;
    const local = load(name => { if (name === 'finalMappingKey:enter') ordinal++; if (ordinal === side && name === 'utf8:digest:return') { reached++; throw stop; } }, false, false, { stringBoundedJson: g.stringBoundedJson });
    try { local.run(items, b); } catch (e) { caught = e; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
  for (const side of [1, 2]) for (const json of mvValues) for (const frame of [1, 2, 3, 4]) for (const counter of ['nodes', 'contentBytes', 'structuralBytes', 'work', 'stringBytes'] as const) for (const delta of [-1, 0, 1]) it(`frame ${side} ${json} ${frame} ${counter} ${delta}`, () => {
    const real = context(), raw = JSON.parse(json), text = String(raw), T = Buffer.byteLength('한😀'), I = Buffer.byteLength('é\0'), D = Buffer.byteLength(text);
    const bytes = [T + 1, T + I + 1, T + I + 2, T + I + D + 2], lengths = [4, 6, 7, 7 + text.length];
    let ordinal = 0, armed = 0, reached = 0, caught: unknown; const stop = new RangeError('nonstring frame');
    // Per-string capacity sentinel only at the selected frame; actual default
    // reserveString enforces the shifted operand, never a changed limit.
    const b: B = { ...real, reserveString(n: number) { real.reserveString(counter === 'stringBytes' && armed ? n + real.limits.stringBytes - bytes[frame - 1] - delta : n); } };
    const owned = graph.parseRegisteredBoundedJson(json, b), items = [d('한😀', 'é\0'), d('한😀', 'é\0')]; items[side - 1].sourceDigest = owned as any;
    const predecessor = ['utf8:table:checked:return', 'utf8:id:checked:return', 'f2:checked:return', 'utf8:digest:checked:return'][frame - 1];
    const local = load(name => {
      if (name === 'finalMappingKey:enter') ordinal++;
      if (ordinal === side && name === predecessor) { armed++; if (counter !== 'stringBytes') consume(b, counter, ({ nodes: 1, contentBytes: bytes[frame - 1], structuralBytes: 4, work: 1 + Math.ceil(lengths[frame - 1] / 256) })[counter] + delta); }
      if (ordinal === side && name === 'f' + frame + ':return') { reached++; throw stop; }
    });
    try { local.run(items, b); } catch (e) { caught = e; }
    expect(armed).toBe(1); expect(reached).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBe(stop);
  });
});
describe('MV actual raw getter native error identity crossproduct', () => {
  for (const bounded of [false, true]) for (const side of [1, 2]) for (const state of states) for (const exit of exits) for (const json of ['null', '[12,"한😀"]']) it(`${bounded} ${side} ${state} ${exit} ${json}`, () => {
    let fired = false, reached = 0, coercions = 0, caught: unknown;
    const signal = { aborted: false }, owner = work.createBudgetContext({ now: () => fired && state === 'expired' ? 5000 : 0, signal }), b = bounded ? owner : undefined;
    const g = metadataGraph(name => { if (name === 'helper:enter') coercions++; });
    const raw = g.parseRegisteredBoundedJson(json, owner), items = [d(), d()];
    const injected = exit === 'ordinary' ? new RangeError('raw digest getter') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    Object.defineProperty(items[side - 1], 'sourceDigest', { configurable: true, enumerable: true, get() { reached++; fired = true; signal.aborted = state === 'aborted'; if (exit !== 'success') throw injected; return raw; } });
    const local = load(() => {}, false, false, { stringBoundedJson: g.stringBoundedJson });
    try { local.run(items, b); } catch (e) { caught = e; }
    expect(reached).toBe(1);
    expect(coercions).toBe(bounded && state === 'timely' && exit === 'success' ? 1 : 0);
    if (exit !== 'success' && (!bounded || state === 'timely' || exit === 'exceeded' || exit === 'unavailable')) expect(caught).toBe(injected);
    else if (bounded && state !== 'timely') expect(caught).toBeInstanceOf(work.BudgetUnavailableError); else expect(caught).toBeUndefined();
  });
});
describe('MV real shadowed toString ordinary native errors', () => {
  for (const side of [1, 2]) for (const state of states) for (const json of ['{"toString":null}', '{"toString":0,"valueOf":false}', '[{"toString":null}]']) it(`${side} ${state} ${json}`, () => {
    let fired = false, native = 0, returned = 0, successor = 0, caught: unknown, originalError: unknown;
    const signal = { aborted: false }, b = work.createBudgetContext({ now: () => fired && state === 'expired' ? 5000 : 0, signal });
    const g = metadataGraph((name, value) => { if (name === 'native:throw') { native++; originalError = value; fired = true; signal.aborted = state === 'aborted'; } if (name === 'helper:return') returned++; });
    const raw = g.parseRegisteredBoundedJson(json, b), items = [d(), d()]; items[side - 1].sourceDigest = raw;
    const local = load(name => { if (fired && name === 'utf8:digest:enter') successor++; }, false, false, { stringBoundedJson: g.stringBoundedJson });
    try { local.run(items, b); } catch (e) { caught = e; }
    expect(native).toBe(1); expect(originalError).toBeInstanceOf(TypeError); expect((originalError as Error).message).toBe('Cannot convert object to primitive value'); expect(returned).toBe(0); expect(successor).toBe(0);
    if (state === 'timely') expect(caught).toBe(originalError); else expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
  });
  for (const side of [1, 2]) for (const state of states) for (const json of ['{"toString":null}', '[{"toString":null}]']) it(`omitted budget ${side} ${state} ${json}`, () => {
    const raw = JSON.parse(json), target = Array.isArray(raw) ? raw[0] : raw, items = [d(), d()]; items[side - 1].sourceDigest = raw;
    const saved = Object.prototype.valueOf; let native = 0, fired = false, caught: any;
    const signal = { aborted: false }, b = work.createBudgetContext({ now: () => fired && state === 'expired' ? 5000 : 0, signal });
    Object.prototype.valueOf = function () { if (this === target) { native++; fired = true; signal.aborted = state === 'aborted'; } return Reflect.apply(saved, this, []); };
    try { helper.run(items); } catch (e) { caught = e; } finally { Object.prototype.valueOf = saved; }
    expect(native).toBe(1); expect(caught).toBeInstanceOf(TypeError); expect(caught.message).toBe('Cannot convert object to primitive value');
    if (state !== 'timely') expect(() => b.check()).toThrow(work.BudgetUnavailableError); else expect(() => b.check()).not.toThrow();
  });
});
describe('MV full raw public mapping noninterference original crossproduct', () => {
  for (const c of metadataGolden.cases.filter((x: any) => !x.error)) for (const bounded of [false, true]) it(`${c.name} ${bounded}`, () => {
    const capture = (original: boolean, budgeted: boolean) => {
      const b = budgeted ? context() : undefined, input = b ? graph.parseRegisteredBoundedJson(JSON.stringify(c.input), b) : clone(c.input);
      let receiver: M[] = [], before: M[] = [], fields: PropertyDescriptorMap[] = [], pre = '', post = '', sourcePre = '', sourcePost = '', indices: number[] = [], after = false;
      const local = load((name, value) => {
        if (name === 'public:before:return') { receiver = value.mappings; before = receiver.slice(); fields = before.map(x => Object.getOwnPropertyDescriptors(x)); pre = JSON.stringify(receiver); sourcePre = JSON.stringify(value.sourceRecords); }
        if (name === 'public:after:return') {
          after = true; expect(value.mappings).toBe(receiver); indices = receiver.map(x => before.indexOf(x)); post = JSON.stringify(receiver); sourcePost = JSON.stringify(value.sourceRecords);
          for (const [i, item] of before.entries()) { expect(Object.getOwnPropertyDescriptors(item)).toEqual(fields[i]); for (const [key, descriptor] of Object.entries(fields[i])) expect((item as any)[key]).toBe(descriptor.value); expect(Object.isFrozen(item)).toBe(false); }
        }
      }, original, true);
      const result = local.normalize(input, b); expect(after).toBe(true); expect(result.mappings).toBe(receiver); expect(JSON.stringify(result)).toBe(c.json); expect(Object.isFrozen(receiver)).toBe(false);
      return { pre, post, sourcePre, sourcePost, indices };
    };
    expect(capture(false, bounded)).toEqual(capture(true, false));
  });
});

describe('MV natural decoder depth domain distinguishes caller redundancy', () => {
  for (const side of [1, 2]) for (const depth of [63, 64, 65]) it(`${side} natural depth ${depth}`, () => {
    const real = context(); let converting = false, maxDepth = 0, native = 0, returned = 0, caught: unknown, raw: unknown;
    const b: B = { ...real, checkDepth(n: number) { if (converting) maxDepth = Math.max(maxDepth, n); real.checkDepth(n); } };
    const g = metadataGraph(name => { if (name === 'helper:enter') converting = true; if (name === 'native:enter') native++; if (name === 'helper:return') { returned++; converting = false; } });
    const json = '['.repeat(depth - 1) + 'null' + ']'.repeat(depth - 1);
    try { raw = g.parseRegisteredBoundedJson(json, b); } catch (e) { caught = e; }
    if (depth > real.limits.depth) { expect(caught).toBeInstanceOf(work.BudgetExceededError); expect(converting).toBe(false); expect(native).toBe(0); return; }
    expect(caught).toBeUndefined(); const items = [d(), d()]; items[side - 1].sourceDigest = raw as any;
    const local = load(() => {}, false, false, { stringBoundedJson: g.stringBoundedJson });
    expect(local.run(items, b)).toBe(items); expect(maxDepth).toBe(depth); expect(native).toBe(1); expect(returned).toBe(1);
  });
});

describe('MV actual native inner and outer joins retain precharged totals', () => {
  for (const side of [1, 2]) it(`${side} decoder-owned nested native join operands`, () => {
    const b = context(), g = metadataGraph(), raw = g.parseRegisteredBoundedJson('[null,[12,"한😀",null]]', b) as unknown[], inner = raw[1] as unknown[];
    const saved = Array.prototype.join, joins: unknown[][] = [], deltas: work.BudgetUsage[] = [];
    let active = false, ordinal = 0, start: work.BudgetUsage | undefined;
    const local = load(name => { if (name === 'digest:checked:return' && ++ordinal === side) { active = true; start = b.usage(); } }, false, false, { stringBoundedJson: g.stringBoundedJson });
    const items = [d(), d()]; items[side - 1].sourceDigest = raw as any;
    Array.prototype.join = function (separator?: string) {
      if (active && (this === raw || this === inner)) {
        const now = b.usage();
        joins.push(this); deltas.push(Object.fromEntries(counters.map(k => [k, now[k] - start![k]])) as unknown as work.BudgetUsage);
      }
      return Reflect.apply(saved, this, [separator]);
    };
    let result: M[] | undefined;
    try { result = local.run(items, b); } finally { Array.prototype.join = saved; }
    expect(result).toBe(items); expect(joins).toHaveLength(2); expect(joins[0]).toBe(raw); expect(joins[1]).toBe(inner);
    // Independent published recipe: inner 41 bytes, root 42, outer String 42.
    // Every reservation has completed BEFORE BOTH real Array.join operands.
    expect(deltas).toEqual([metadataRecipes[1].cost, metadataRecipes[1].cost]);
    expect(items.some(item => item.sourceDigest === (raw as any))).toBe(true);
  });
});

// Test-owned byte copies exercise fail-closed provenance without editing the archive.
describe('frozen original graph integrity', () => {
  const manifestPath = frozenOriginalRoot + '/manifest.json';
  const payloadPath = frozenOriginalRoot + '/' + sourcePath + '.txt';
  const copyReader = (change: (file: string, bytes: Buffer) => Buffer) => (file: string) => change(file, readFileSync(file));
  it('accepts the pinned original root bytes, never candidate bytes', () => {
    expect(readFrozenOriginal(sourcePath)).not.toBe(source);
    expect(createHash('sha256').update(readFrozenOriginal(sourcePath)).digest('hex')).toBe('2e589280a870204623ba6a86e2008cbc1bdb50654582ce3cd82bf36b4a44cdbd');
  });
  it('rejects unknown logical modules before any read', () => {
    let reads = 0;
    expect(() => readFrozenOriginal('../normalize.ts', () => { reads++; throw new Error('unexpected read'); })).toThrow('Unknown frozen original module');
    expect(reads).toBe(0);
  });
  it('rejects a missing manifest without candidate fallback', () => {
    const attempted: string[] = [];
    expect(() => readFrozenOriginal(sourcePath, file => { attempted.push(file); throw new Error('missing manifest'); })).toThrow('missing manifest');
    expect(attempted).toEqual([manifestPath]);
  });
  it('rejects a malformed manifest', () => {
    expect(() => readFrozenOriginal(sourcePath, copyReader((file, bytes) => file === manifestPath ? Buffer.from('{') : bytes))).toThrow('Frozen original manifest integrity');
  });
  it('rejects a wrong original pin', () => {
    expect(() => readFrozenOriginal(sourcePath, copyReader((file, bytes) => file === manifestPath ? Buffer.from(bytes.toString().replace(frozenOriginalPin, '0'.repeat(40))) : bytes))).toThrow('Frozen original manifest integrity');
  });
  it('rejects changed manifest module provenance', () => {
    expect(() => readFrozenOriginal(sourcePath, copyReader((file, bytes) => file === manifestPath ? Buffer.from(bytes.toString().replace('src/domain/taskAvailability.ts.txt', 'src/domain/taskAvailability.ts')) : bytes))).toThrow('Frozen original manifest integrity');
  });
  it('rejects a missing payload without current-source fallback', () => {
    const attempted: string[] = [];
    expect(() => readFrozenOriginal(sourcePath, file => { attempted.push(file); if (file === payloadPath) throw new Error('missing payload'); return readFileSync(file); })).toThrow('missing payload');
    expect(attempted).toEqual([manifestPath, payloadPath]);
  });
  it('rejects corrupt original bytes', () => {
    expect(() => readFrozenOriginal(sourcePath, copyReader((file, bytes) => file === payloadPath ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes))).toThrow('Frozen original payload integrity');
  });
  it('rejects same-length original byte corruption', () => {
    expect(() => readFrozenOriginal(sourcePath, copyReader((file, bytes) => { if (file !== payloadPath) return bytes; const copy = Buffer.from(bytes); copy[0] ^= 1; return copy; }))).toThrow('Frozen original payload integrity');
  });
});
