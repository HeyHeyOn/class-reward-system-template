/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as work from '@/lib/boundedWork';

type B = work.BudgetContext;
type Event = { name: string; value?: any; caller: string; helper?: string };
type Hook = (event: Event) => void;
const sourcePath = 'src/server/migration/normalize.ts';
const graphPath = 'src/lib/boundedJson.ts';
const pin = '448cbed7bd303ad0f9ef3fd4c974c313bf4c8da8';
const originalRoot = 'test-support/frozen-oracles/' + pin;
const nativeRequire = createRequire(path.resolve('package.json'));
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function originalSource(rel: string): string {
  const bytes = readFileSync(originalRoot + '/manifest.json');
  if (hash(bytes) !== '1b20d13ac257dadd41d714012ef8d45f04d133f0c45d0f8e5b6f3025e3729e8e') throw new Error('Frozen manifest integrity');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.originalPin !== pin) throw new Error('Frozen pin integrity');
  const item = manifest.modules.find((item: any) => item.path === rel);
  if (!item || item.payload !== rel + '.txt') throw new Error('Unknown frozen module ' + rel);
  const payload = readFileSync(originalRoot + '/' + item.payload);
  if (payload.length !== item.bytes || hash(payload) !== item.sha256) throw new Error('Frozen payload integrity ' + rel);
  return payload.toString('utf8');
}
const fixtures = JSON.parse(readFileSync('src/server/migration/__fixtures__/mapping-metadata-original-golden.json', 'utf8')).cases as any[];
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const fixture = (name = 'rowHash/number/distinct-path') => clone(fixtures.find(c => c.name === name).input);
const context = () => work.createBudgetContext({ now: () => 0 });
const counters = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const;
const delta = (after: work.BudgetUsage, before: work.BudgetUsage) => Object.fromEntries(counters.map(k => [k, after[k] - before[k]]));
const vector = (nodes: number, slots: number, contentBytes: number, structuralBytes: number, work: number) => ({ nodes, slots, contentBytes, structuralBytes, work });

// Observe real caller expressions, not extracted declarations or replacement
// algorithms. The import statement is compiled verbatim. Full graph evaluation
// shares its private registry with this instance's real decoder/constructors.
const compiled = new Map<string, string>();
function compile(text: string, observed: boolean): string {
  const key = String(observed) + text;
  if (compiled.has(key)) return compiled.get(key)!;
  const observe: ts.TransformerFactory<ts.SourceFile> = ctx => {
    const f = ctx.factory;
    let fn = '';
    let root: ts.SourceFile;
    const visit: ts.Visitor = node => {
      if (ts.isFunctionDeclaration(node)) {
        const previous = fn; fn = node.name?.text ?? '';
        const result = ts.visitEachChild(node, visit, ctx); fn = previous; return result;
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(root);
        let label = ['readNormalizationCell', 'referenceString', 'finalMappingKey', 'finalMappingSort'].includes(callee) ? callee : '';
        if (callee === 'sourceRecords.sort') label = 'finalSourceSort';
        if (callee === 'sourceDigest') label = 'sourceDigest';
        if (callee === 'finalMappingKey') label = 'finalMappingKey:' + (node.arguments[0]?.getText(root) === 'a' ? 'left' : 'right');
        if (callee === 'referenceString') label = fn + ':referenceString';
        if (callee === 'stringBoundedJson') label = fn + ':import';
        if (fn === 'finalMappingKey' && node.getText(root) === 'utf8ByteLength(digest, budget)') label = 'next:digestUTF8';
        if (fn === 'readNormalizationCell' && callee === 'trimBudgetString') label = 'next:trim';
        if (label) {
          let operation = ts.visitEachChild(node, visit, ctx);
          if (callee === 'referenceString') operation = f.updateCallExpression(operation, operation.expression, operation.typeArguments,
            operation.arguments.map((arg, index) => index ? arg : f.createCallExpression(f.createIdentifier('__call'), undefined, [f.createStringLiteral('next:referenceOperand'), f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), arg)])));
          return f.createCallExpression(f.createIdentifier('__call'), undefined, [f.createStringLiteral(label), f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), operation)]);
        }
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return file => { root = file; return ts.visitNode(file, visit) as ts.SourceFile; };
  };
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: observed ? { before: [observe] } : undefined }).outputText;
  compiled.set(key, js); return js;
}
function load(hook: Hook = () => {}, original = false, observed = true) {
  const modules = new Map<string, any>();
  const calls: string[] = [], helpers: string[] = [];
  const emit = (name: string, value?: any) => hook({ name, value, caller: calls.join('/'), helper: helpers.at(-1) });
  function call<T>(name: string, operation: () => T): T {
    calls.push(name);
    try { emit(name + ':enter'); const value = operation(); emit(name + ':return', value); return value; }
    catch (error) { emit(name + ':throw', error); throw error; }
    finally { calls.pop(); }
  }
  const nativeString = new Proxy(String, { apply(target, receiver, args) {
    if (!helpers.length) return Reflect.apply(target, receiver, args);
    emit('native:enter', args[0]);
    try { const result = Reflect.apply(target, receiver, args); emit('native:return', result); return result; }
    catch (error) { emit('native:throw', error); throw error; }
  } });
  function module(rel: string): any {
    if (modules.has(rel)) return modules.get(rel);
    if (!original && rel === 'src/lib/boundedWork.ts') return work;
    const m = { exports: {} as any }; modules.set(rel, m.exports); // cycles
    const text = original ? originalSource(rel) : readFileSync(rel === sourcePath ? process.env.STRING_EXACT_NORMALIZE_SOURCE ?? rel : rel === graphPath ? process.env.STRING_EXACT_GRAPH_SOURCE ?? rel : rel, 'utf8');
    const resolve = (id: string) => {
      if (id === 'server-only') return {};
      if (!id.startsWith('.') && !id.startsWith('@/')) return nativeRequire(id);
      let local = id.startsWith('@/') ? 'src/' + id.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(rel), id));
      if (!local.endsWith('.ts')) local += '.ts';
      return module(local);
    };
    new Function('require', 'module', 'exports', '__call', 'String', compile(text, observed && rel === sourcePath))(resolve, m, m.exports, call, rel === graphPath && observed ? nativeString : String);
    if (rel === graphPath && observed) for (const name of ['stringBoundedJson', 'stringBoundedJsonExact']) {
      const real = m.exports[name];
      m.exports[name] = (value: unknown, budget: B) => {
        helpers.push(name);
        try { emit('helper:enter', { value, budget }); const result = real(value, budget); emit('helper:return', result); return result; }
        catch (error) { emit('helper:throw', error); throw error; }
        finally { helpers.pop(); }
      };
    }
    return m.exports;
  }
  const api = module(sourcePath);
  return { normalize: api.normalizeLegacySnapshots as (input: any, budget?: B) => any, graph: original ? undefined : module(graphPath) };
}
// Describe the complete returned graph without collapsing aliases, undefined,
// prototype, property attributes or mutability into JSON value equality.
function topology(value: any) {
  const seen = new Map<object, number>();
  function visit(item: any): any {
    if (item === null || typeof item !== 'object') return { type: typeof item, value: item };
    if (seen.has(item)) return { ref: seen.get(item) };
    const id = seen.size; seen.set(item, id);
    return { id, array: Array.isArray(item), prototype: Object.getPrototypeOf(item) === null ? 'null' : Object.getPrototypeOf(item).constructor.name,
      frozen: Object.isFrozen(item), sealed: Object.isSealed(item), extensible: Object.isExtensible(item),
      properties: Reflect.ownKeys(item).map(key => {
        const d = Object.getOwnPropertyDescriptor(item, key)!;
        return { key, enumerable: d.enumerable, configurable: d.configurable, writable: d.writable,
          getter: Boolean(d.get), setter: Boolean(d.set), value: visit(d.value) };
      }) };
  }
  return visit(value);
}
function outcome(operation: () => any) {
  try { const value = operation(); return { json: JSON.stringify(value), topology: topology(value) }; }
  catch (error) { return { error: { name: (error as Error).name, message: (error as Error).message } }; }
}

// Literal L examples from the approved independent ledger, not measured usage.
const mappingCases = [
  ['rowHash/number/distinct-path', vector(4, 12, 32, 212, 7)],
  ['rowHash/boolean/distinct-path', vector(4, 12, 5, 158, 7)],
  ['rowHash/null/distinct-path', vector(4, 12, 4, 156, 7)],
  ['rowHash/empty-array/distinct-path', vector(71, 1036, 0, 16568, 14)],
  ['metadata/object', vector(68, 1036, 15, 16562, 13)],
] as const;
describe('GS10 real normalize import binding and same-owner ledger', () => {
  for (const [name, expected] of mappingCases) it(`mapping ${name}`, () => {
    const b = context(); let before: work.BudgetUsage | undefined;
    const debits: unknown[] = [], bindings: string[] = []; let native = 0;
    const local = load(e => {
      if (!e.caller.includes('finalMappingKey')) return;
      if (e.name === 'helper:enter' && e.value.value === raw) { expect(e.value.budget).toBe(b); before = b.usage(); bindings.push(e.helper!); }
      if (e.name === 'native:enter' && e.value === raw) native++;
      if (e.name === 'helper:return' && before) { debits.push(delta(b.usage(), before)); before = undefined; }
    });
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(fixture(name)), b);
    const raw = input.sheets.tabs.Products.rows[0].hash;
    const result = local.normalize(input, b);
    expect(native).toBeGreaterThan(0);
    expect(debits.length).toBe(native);
    expect(debits).toEqual(Array.from({ length: native }, () => expected));
    expect(bindings).toEqual(Array.from({ length: native }, () => 'stringBoundedJsonExact'));
    expect(result.mappings.some((item: any) => item.sourceDigest === raw)).toBe(true);
    expect(Object.isFrozen(result.mappings)).toBe(false);
    for (const item of result.mappings) expect(Object.isFrozen(item)).toBe(false);
  });
  for (const text of ['A', '한', '😀', '\ud800', 'x'.repeat(255) + '😀', 'x'.repeat(257)]) it(`cell U=${text.length} B=${Buffer.byteLength(text)}`, () => {
    const b = context(); let before: work.BudgetUsage | undefined; const debits: unknown[] = [], bindings: string[] = [];
    const local = load(e => {
      if (!e.caller.includes('readNormalizationCell:import')) return;
      if (e.name === 'helper:enter' && e.value.value === text) { expect(e.value.budget).toBe(b); before = b.usage(); bindings.push(e.helper!); }
      if (e.name === 'helper:return' && before) { debits.push(delta(b.usage(), before)); before = undefined; }
    });
    const specimen = fixture(); specimen.sheets.tabs.Products.rows[0].cells[1] = text;
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b);
    local.normalize(input, b);
    expect(debits.length).toBeGreaterThan(0);
    expect(debits).toEqual(Array.from({ length: debits.length }, () => vector(5, 12, Buffer.byteLength(text), 164 + 4 * text.length, 6 + 4 * Math.ceil(text.length / 256))));
    expect(bindings).toEqual(Array.from({ length: debits.length }, () => 'stringBoundedJsonExact'));
  });
});

describe('GS10 source metadata and unchanged constructor controls', () => {
  for (const digest of [123, null, [1, true]]) it(`single-mapping source fallback ${JSON.stringify(digest)}`, () => {
    const specimen = fixture(); delete specimen.sheets.tabs.Students;
    const row = specimen.sheets.tabs.Products.rows[0]; row.hash = digest;
    const invalid = clone(row); invalid.cells[0] = 'P2'; invalid.cells[2] = 'invalid-price'; invalid.hash = 'ordinary-invalid-digest';
    specimen.sheets.tabs.Products.rows.push(invalid);
    const b = context(); const fallback: unknown[] = []; let keys = 0;
    const local = load(e => {
      if (e.name === 'sourceDigest:return' && e.caller.includes('finalSourceSort')) fallback.push(e.value);
      if (e.name.startsWith('finalMappingKey:') && e.name.endsWith(':enter')) keys++;
    });
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b);
    const result = local.normalize(input, b);
    expect(result.mappings).toHaveLength(1); expect(keys).toBe(0); expect(result.sourceRecords).toHaveLength(2);
    expect(fallback).toContain(input.sheets.tabs.Products.rows[0].hash);
    expect(fallback).toContain('ordinary-invalid-digest');
    expect(outcome(() => result)).toEqual(outcome(() => load(() => {}, true, false).normalize(input)));
  });
  for (const field of ['rowNumber', 'redisProvenance']) it(`registered graph ${field} original outcome, not inferred mapping acceptance`, () => {
    const specimen = field === 'rowNumber' ? fixture() : clone(JSON.parse(readFileSync('src/server/migration/__fixtures__/claim-joins-golden.json', 'utf8')).cases[0].input);
    if (field === 'rowNumber') specimen.sheets.tabs.Products.rows[0].rowNumber = [[1, true]];
    else specimen.redis.v2Claims[0].sourceProvenance = [[1, true]];
    const b = context(), local = load();
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b);
    const expected = outcome(() => load(() => {}, true, false).normalize(input));
    expect(outcome(() => local.normalize(input, b))).toEqual(expected);
    const plain = load(() => {}, false, false), other = context();
    expect(outcome(() => plain.normalize(plain.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), other), other))).toEqual(expected);
  });
  it('cloneFreeze null-prototype uses the actual helper local native error identity', () => {
    const b = context(); let nativeError: unknown, helperError: unknown;
    const local = load(e => { if (e.name === 'native:throw') nativeError = e.value; if (e.name === 'helper:throw') helperError = e.value; });
    const raw = local.graph.cloneFreezeBoundedJson(local.graph.parseRegisteredBoundedJson('{"a":1}', b), b);
    expect(Object.getPrototypeOf(raw)).toBeNull(); expect(Object.isFrozen(raw)).toBe(true);
    let thrown: unknown; try { local.graph.stringBoundedJsonExact(raw, b); } catch (error) { thrown = error; }
    expect(nativeError).toBeInstanceOf(TypeError); expect(helperError).toBe(nativeError); expect(thrown).toBe(nativeError);
  });
  it('existing closed history list retains repeated same-owner record identity before native failure', () => {
    const b = context(); let native = 0; const local = load(e => { if (e.name === 'native:enter') native++; });
    const record = local.graph.createBoundedHistoryAssignment(b, 'AS1', 'T1', 'TI1', 'cycle', 'start', null, 1, 'UTC', 'S1', 'ASSIGNED', 'ADMIN', null, 'created', 2, '');
    const indices: number[] = [];
    const list = local.graph.createBoundedOperationalHistoryList(2, (index: number) => { indices.push(index); return record; }, b);
    expect(indices).toEqual([0, 1]); expect(list[0]).toBe(list[1]); expect(Object.getPrototypeOf(list[0])).toBeNull();
    expect(Object.isFrozen(record)).toBe(false); expect(Object.isFrozen(list)).toBe(true);
    expect(() => local.graph.stringBoundedJsonExact(list, b)).toThrow(TypeError); expect(native).toBe(1);
  });
});

describe('GS11 left key refuses before right key evaluation', () => {
  for (const boundary of ['preparation', 'native', 'final'] as const)
    for (const state of ['timely', 'expired', 'aborted'] as const) it(`${boundary} ${state}`, () => {
      let now = 0, active = false, nativeDone = false, poisoned = false, checks = 0;
      const signal = { aborted: false }, owner = work.createBudgetContext({ now: () => now, signal });
      const poison = () => { poisoned = true; if (state === 'expired') now = owner.limits.deadlineMs; if (state === 'aborted') signal.aborted = true; };
      const b: B = { ...owner, spend(n) { owner.spend(n); if (active && boundary === 'preparation' && n === 4 && !poisoned) poison(); },
        check() { owner.check(); if (active && nativeDone && boundary === 'final' && ++checks === 1) poison(); } };
      const order: string[] = []; let native = 0, returned = 0, localError: unknown, publicError: unknown;
      const local = load(e => {
        if (e.name === 'finalMappingKey:left:enter') order.push('left');
        if (e.name === 'finalMappingKey:right:enter') order.push('right');
        if (!e.caller.includes('finalMappingKey:left')) return;
        if (e.name === 'helper:enter') { expect(e.value.budget).toBe(b); active = true; }
        if (active && e.name === 'native:return') { native++; nativeDone = true; if (boundary === 'native') poison(); }
        if (active && e.name === 'helper:return') { returned++; active = false; }
        if (active && e.name === 'helper:throw') { localError = e.value; active = false; }
      });
      const specimen = fixture(); delete specimen.sheets.tabs.Students;
      const row = specimen.sheets.tabs.Products.rows[0], second = clone(row); second.cells[0] = 'P2'; second.hash = 456; second.rowNumber = 3;
      specimen.sheets.tabs.Products.rows.push(second);
      const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b);
      try { local.normalize(input, b); } catch (error) { publicError = error; }
      expect(poisoned).toBe(true);
      if (state === 'timely') { expect(order).toEqual(['left', 'right']); expect(returned).toBe(1); expect(native).toBe(1); expect(publicError).toBeUndefined(); }
      else { expect(order).toEqual(['left']); expect(returned).toBe(0); expect(native).toBe(boundary === 'preparation' ? 0 : 1); expect(localError).toBeInstanceOf(work.BudgetUnavailableError); expect(publicError).toBe(localError); }
    });
});

describe('GS11 preparation completion at actual mapping import', () => {
  for (const state of ['timely', 'expired', 'aborted'] as const) it(state, () => {
    let now = 0, active = false, reached = 0, native = 0, returned = 0; const signal = { aborted: false };
    const owner = work.createBudgetContext({ now: () => now, signal });
    const b: B = { ...owner, spend(n) {
      owner.spend(n);
      if (active && n === 4 && reached === 0) { reached++; if (state === 'expired') now = owner.limits.deadlineMs; if (state === 'aborted') signal.aborted = true; }
    } };
    let localError: unknown, publicError: unknown; const successors: string[] = [];
    const local = load(e => {
      if (e.name === 'helper:enter' && e.caller.includes('finalMappingKey') && e.value.value === 73219) { expect(e.value.budget).toBe(b); active = true; }
      if (!active) return;
      if (e.name === 'native:enter') native++;
      if (e.name === 'helper:return') { returned++; active = false; }
      if (e.name === 'helper:throw') localError = e.value;
      if (e.name === 'next:digestUTF8:enter' || e.name === 'finalMappingKey:right:enter') successors.push(e.name);
    });
    const specimen = fixture(); specimen.sheets.tabs.Products.rows[0].hash = 73219;
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b);
    try { local.normalize(input, b); } catch (error) { publicError = error; }
    expect(reached).toBe(1);
    if (state === 'timely') { expect(native).toBeGreaterThan(0); expect(returned).toBeGreaterThan(0); expect(publicError).toBeUndefined(); }
    else { expect(native).toBe(0); expect(returned).toBe(0); expect(successors).toEqual([]); expect(localError).toBeInstanceOf(work.BudgetUnavailableError); expect(publicError).toBe(localError); }
  });
});

describe('GS10 comparator sides and repeated raw graph identity', () => {
  it('both sides preserve each graph digest and charge every repeated occurrence', () => {
    const b = context(); const sides = new Set<string>(), counts = new Map<object, number>();
    const debits: unknown[] = []; let before: work.BudgetUsage | undefined;
    const local = load(e => {
      if (!e.caller.includes('finalMappingKey')) return;
      if (e.name === 'helper:enter') {
        expect(e.value.budget).toBe(b); expect(e.helper).toBe('stringBoundedJsonExact');
        expect(raws).toContain(e.value.value); counts.set(e.value.value, (counts.get(e.value.value) ?? 0) + 1);
        sides.add(e.caller.includes('finalMappingKey:left') ? 'left' : 'right'); before = b.usage();
      }
      if (e.name === 'helper:return' && before) { debits.push(delta(b.usage(), before)); before = undefined; }
    });
    const specimen = fixture(); delete specimen.sheets.tabs.Students;
    const row = specimen.sheets.tabs.Products.rows[0];
    specimen.sheets.tabs.Products.rows = ['P1', 'P2', 'P3'].map((id, index) => { const item = clone(row); item.cells[0] = id; item.hash = [[index]]; item.rowNumber = index + 2; return item; });
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b), raws = input.sheets.tabs.Products.rows.map((item: any) => item.hash);
    const result = local.normalize(input, b);
    expect(sides).toEqual(new Set(['left', 'right'])); expect(counts.size).toBe(3);
    expect(Math.max(...counts.values())).toBeGreaterThan(1);
    expect(debits).toEqual(Array.from({ length: [...counts.values()].reduce((a, n) => a + n, 0) }, () => vector(76, 1038, 128, 16888, 38)));
    for (const raw of raws) expect(result.mappings.filter((item: any) => item.sourceDigest === raw)).toHaveLength(1);
    expect(outcome(() => result)).toEqual(outcome(() => load(() => {}, true, false).normalize(input)));
  });
});

describe('GS10 graph operands at actual mapping and cell joins', () => {
  const cases = [
    ['number', [[1]], vector(76, 1038, 128, 16888, 38)],
    ['boolean', [[true]], vector(76, 1038, 20, 16672, 38)],
    ['record', [[{}]], vector(76, 1038, 60, 16752, 43)],
    ['mixed', [[1, true, {}]], vector(80, 1040, 214, 17108, 58)],
  ] as const;
  for (const [name, value, expected] of cases) for (const consumer of ['mapping', 'cell']) it(`${consumer} nested ${name} complete pre-native L`, () => {
    const b = context(); let before: work.BudgetUsage | undefined, active = false;
    const joins: unknown[] = [], debits: unknown[] = []; let conversions = 0;
    const local = load(e => {
      if (!e.caller.includes(consumer === 'mapping' ? 'finalMappingKey' : 'readNormalizationCell:import')) return;
      if (e.name === 'helper:enter' && e.value.value === raw) { expect(e.value.budget).toBe(b); expect(e.helper).toBe('stringBoundedJsonExact'); before = b.usage(); active = true; }
      if (active && e.name === 'native:enter' && e.value === raw) { conversions++; debits.push(delta(b.usage(), before!)); }
      if (active && (e.name === 'helper:return' || e.name === 'helper:throw')) active = false;
    });
    const specimen = fixture();
    if (consumer === 'mapping') specimen.sheets.tabs.Products.rows[0].hash = value;
    else specimen.sheets.tabs.Products.rows[0].cells[1] = value;
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b);
    const raw = consumer === 'mapping' ? input.sheets.tabs.Products.rows[0].hash : input.sheets.tabs.Products.rows[0].cells[1];
    const nativeJoin = Array.prototype.join;
    let result: any;
    try {
      Array.prototype.join = function(separator?: string) {
        if (active && (this === raw || this === raw[0])) joins.push({ inner: this === raw[0], debit: delta(b.usage(), before!) });
        return nativeJoin.call(this, separator);
      };
      result = local.normalize(input, b);
    } finally { Array.prototype.join = nativeJoin; }
    expect(conversions).toBeGreaterThan(0);
    expect(debits).toEqual(Array.from({ length: conversions }, () => expected));
    expect(joins).toEqual(Array.from({ length: conversions }, () => [{ inner: false, debit: expected }, { inner: true, debit: expected }]).flat());
    if (consumer === 'mapping') expect(result.mappings.some((item: any) => item.sourceDigest === raw)).toBe(true);
    expect(outcome(() => result)).toEqual(outcome(() => load(() => {}, true, false).normalize(input)));
  });
});

describe('GS10 actual reference operand families', () => {
  const cases = [
    ['reference-guards', 'chain-3', 'validateReferences'],
    ['reference-guards', 'assignment-cycle', 'markDirectedReferenceCycles'],
    ['global-index', 'duplicate-completion', 'markDuplicates'],
    ['claim-joins', 'binding-conflict', 'propagateClaimErrors'],
    ['claim-joins', 'missing-binding', 'propagateClaimErrors'],
    ['adjustment-correlation', 'accepted', 'correlate'],
    ['task-construction', 'current-DAILY', 'readNormalizationCell'],
  ];
  for (const [file, name, family] of cases) it(`${file}/${name} ${family}`, () => {
    const c = JSON.parse(readFileSync(`src/server/migration/__fixtures__/${file}-golden.json`, 'utf8')).cases.find((item: any) => item.name === name);
    expect(c).toBeDefined();
    const expected = outcome(() => load(() => {}, true, false).normalize(clone(c.input)));
    if (c.outcome.error) expect(expected).toEqual(c.outcome); else expect(expected.json).toBe(c.outcome.json);
    const b = context(); const operands: { caller: string; value: unknown }[] = []; let native = 0;
    const local = load(e => {
      if (e.name === 'helper:enter' && (e.caller.includes('referenceString') || e.caller.includes('readNormalizationCell'))) {
        expect(e.value.budget).toBe(b); expect(e.helper).toBe('stringBoundedJsonExact');
        operands.push({ caller: e.caller, value: e.value.value });
      }
      if (e.name === 'native:return') native++;
    });
    const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(c.input), b);
    const matchedOriginal = outcome(() => load(() => {}, true, false).normalize(input));
    expect(outcome(() => local.normalize(input, b))).toEqual(matchedOriginal);
    const plain = load(() => {}, false, false), other = context();
    expect(outcome(() => plain.normalize(plain.graph.parseRegisteredBoundedJson(JSON.stringify(c.input), other), other))).toEqual(matchedOriginal);
    expect(outcome(() => plain.normalize(clone(c.input)))).toEqual(expected);
    expect(native).toBeGreaterThan(0);
    expect(operands.some(item => item.caller.includes(family))).toBe(true);
  });
});

// Supplemental integration coverage of inherited guards, not new chronological RED.
describe('GS11 actual import local native exits', () => {
  for (const consumer of ['mapping', 'cell', 'reference', 'claim', 'correlation', 'directed'] as const)
    for (const state of ['timely', 'expired', 'aborted'] as const)
      for (const kind of ['success', 'Error', 'RangeError', 'TypeError', 'BudgetExceededError', 'BudgetUnavailableError'] as const)
        it(`${consumer} ${state} ${kind}`, () => {
          let now = 0; const signal = { aborted: false };
          const owner = work.createBudgetContext({ now: () => now, signal });
          const b: B = { limits: owner.limits, check: () => owner.check(), reserve: c => owner.reserve(c),
            spend: n => owner.spend(n), checkDepth: d => owner.checkDepth(d), reserveString: n => owner.reserveString(n), usage: () => owner.usage() };
          const error = kind === 'BudgetExceededError' ? new work.BudgetExceededError() : kind === 'BudgetUnavailableError' ? new work.BudgetUnavailableError()
            : kind === 'RangeError' ? new RangeError('native sentinel') : kind === 'TypeError' ? new TypeError('native sentinel') : new Error('native sentinel');
          const label = { mapping: 'finalMappingKey', cell: 'readNormalizationCell:import', reference: 'validateReferences:referenceString', claim: 'propagateClaimErrors:referenceString', correlation: 'correlateAdjustments:referenceString', directed: 'markDirectedReferenceCycles:referenceString' }[consumer];
          let marker: unknown = consumer === 'mapping' ? 73219 : consumer === 'cell' ? 'marked-native-cell' : undefined;
          let reached = 0, returned = 0, thrown: unknown, publicError: unknown, armed = false;
          const successors: string[] = [];
          const local = load(e => {
            if (armed && (e.name === 'next:digestUTF8:enter' || e.name === 'next:trim:enter' || e.name === 'next:referenceOperand:enter' || e.name === 'finalMappingKey:right:enter')) successors.push(e.name);
            if (!e.caller.includes(label)) return;
            if (e.name === 'helper:enter' && marker === undefined) marker = e.value.value;
            if (e.name === 'helper:enter' && e.value.value === marker) expect(e.value.budget).toBe(b);
            if (e.name === 'native:return' && e.value === String(marker) && !armed) {
              armed = true; reached++;
              if (state === 'expired') now = owner.limits.deadlineMs;
              if (state === 'aborted') signal.aborted = true;
              if (kind !== 'success') throw error;
            }
            if (armed && e.name === 'helper:return') returned++;
            if (armed && e.name === 'helper:throw' && thrown === undefined) thrown = e.value;
          });
          const family = consumer === 'reference' ? ['reference-guards', 'chain-3'] : consumer === 'claim' ? ['claim-joins', 'binding-conflict'] : consumer === 'correlation' ? ['adjustment-correlation', 'accepted'] : ['reference-guards', 'assignment-cycle'];
          const specimen = consumer === 'mapping' || consumer === 'cell' ? fixture() : clone(JSON.parse(readFileSync(`src/server/migration/__fixtures__/${family[0]}-golden.json`, 'utf8')).cases.find((c: any) => c.name === family[1]).input);
          if (consumer === 'mapping') specimen.sheets.tabs.Products.rows[0].hash = marker;
          else if (consumer === 'cell') specimen.sheets.tabs.Products.rows[0].cells[1] = marker;
          const input = local.graph.parseRegisteredBoundedJson(JSON.stringify(specimen), b);
          try { local.normalize(input, b); } catch (e) { publicError = e; }
          expect(reached).toBe(1);
          if (state === 'timely' && kind === 'success') {
            expect(returned).toBeGreaterThan(0); expect(thrown).toBeUndefined(); expect(publicError).toBeUndefined();
            expect(successors).toContain(consumer === 'mapping' ? 'next:digestUTF8:enter' : consumer === 'cell' ? 'next:trim:enter' : 'next:referenceOperand:enter');
          } else {
            expect(returned).toBe(0); expect(successors).toEqual([]);
            if (kind.startsWith('Budget') || state === 'timely') expect(thrown).toBe(error);
            else expect(thrown).toBeInstanceOf(work.BudgetUnavailableError);
            expect(publicError).toBe(thrown);
          }
        });
});

describe('GS10 executed frozen originals and unobserved full-module parity controls', () => {
  for (const c of fixtures) for (const bounded of (c.name.endsWith('/quarantined') ? [false] : [false, true])) it(`${c.name} bounded=${bounded}`, () => {
    const originalInput = bounded ? load(() => {}, false, false).graph.parseRegisteredBoundedJson(JSON.stringify(c.input), context()) : clone(c.input);
    const expected = outcome(() => load(() => {}, true, false).normalize(originalInput));
    if (c.error) expect(expected).toEqual({ error: c.error }); else expect(expected.json).toBe(c.json);
    const run = (observed: boolean) => {
      const local = load(() => {}, false, observed), b = bounded ? context() : undefined;
      const input = b ? local.graph.parseRegisteredBoundedJson(JSON.stringify(c.input), b) : clone(c.input);
      return outcome(() => local.normalize(input, b));
    };
    expect(run(false)).toEqual(expected);
    expect(run(true)).toEqual(expected);
  });
  it('string mapping digest bypasses both conversion helpers', () => {
    let conversions = 0, keyCalls = 0;
    const local = load(e => { if (e.name.startsWith('finalMappingKey:') && e.name.endsWith(':enter')) keyCalls++; if (e.name === 'helper:enter' && e.caller.includes('finalMappingKey')) conversions++; });
    const b = context(), input = fixture(); input.sheets.tabs.Products.rows[0].hash = 'plain-digest';
    local.normalize(local.graph.parseRegisteredBoundedJson(JSON.stringify(input), b), b);
    expect(keyCalls).toBeGreaterThan(0); expect(conversions).toBe(0);
  });
});
