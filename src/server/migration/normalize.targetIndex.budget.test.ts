import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as work from '@/lib/boundedWork';
import * as graph from '@/lib/boundedJson';
import { createNormalizationOutput } from './normalizationOutput';

// The complete real module is compiled, with real recursively resolved dependencies.
// Appending a lexical entry point does not replace the assembly algorithm. In
// particular future targetIndex* declarations are loaded without naming/stubbing them.
const nativeRequire = createRequire(path.resolve('package.json'));
type Target = { table: string; id: string; record: Record<string, unknown> };
type Entry = { source: Record<string, unknown>; tab: string; identity: string; sourcePrimaryIdentity: null; redacted: Record<string, unknown>; canonical: Record<string, unknown> | null; targets: Target[]; refs: never[]; warnings: string[]; errors: string[] };
type Result = { records: Record<string, Record<string, unknown>[]>; targetsByCollection: Record<string, Target[]>; sourceRecords: unknown[]; mappings: unknown[]; conflicts: unknown[] };
type Event = { name: string; value?: unknown };
type Hook = (event: Event) => void;
const counters = ['nodes', 'slots', 'structuralBytes', 'contentBytes', 'work'] as const;
type Usage = Record<typeof counters[number], number>;
const zero = (): Usage => ({ nodes: 0, slots: 0, structuralBytes: 0, contentBytes: 0, work: 0 });
const subtract = (a: Usage, b: Usage): Usage => Object.fromEntries(counters.map(k => [k, a[k] - b[k]])) as Usage;
const evidence = '/home/haeon/.hermes/profiles/secondbot/cache/task19-bounded-normalization/normalizer-target-index';
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/target-index-golden.json', 'utf8')) as {
  cases: { name: string; input: unknown; json: string; classification: { acceptedDuplicateContributors: number[] } }[];
  native: { seam: string; exit: Exit; outcome: { reached: number; trace: string[]; json: string | null; error: { name: string; message: string; sameInjected: boolean } | null } }[];
  mutations: { kind: string; outcome: ReturnType<typeof mutationProbe> }[];
  naturalRaw: { name: string; outcome: ReturnType<typeof naturalRawProbe> }[];
  synthetic: { name: string; names: string[]; targets?: string[][]; errors?: string[]; json: string; recordKeys: string[]; bucketIndices?: Record<string, number[]>; rowIndices?: Record<string, number[]> }[];
};

// Instrument actual lexical operands, never supply a grouping/sorting algorithm.
// The extra mode is isolated from the historical 1007 assertion observers.
function completionTransformer(context: ts.TransformationContext): ts.Transformer<ts.SourceFile> {
  const f = context.factory;
  let owned = false, functionName = '', variableRole = '';
  let sourceFile: ts.SourceFile;
  const checkpoint = (name: string) => f.createExpressionStatement(f.createCallExpression(f.createIdentifier('__checkpoint'), undefined, [f.createStringLiteral(name)]));
  const factory = (name: string, expression: ts.Expression) => f.createCallExpression(f.createIdentifier('__factory'), undefined, [f.createStringLiteral(name), f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), expression)]);
  const variable = (s: ts.Statement) => ts.isVariableStatement(s) && s.declarationList.declarations.length === 1 && ts.isIdentifier(s.declarationList.declarations[0].name) ? s.declarationList.declarations[0].name.text : undefined;
  const visitor: ts.Visitor = node => {
    if (ts.isFunctionDeclaration(node)) {
      const before = owned, beforeName = functionName;
      functionName = beforeName === 'utf8ByteLength' && node.name?.text === 'codeAt' ? beforeName : node.name?.text ?? '';
      owned = functionName === '__assembly' || functionName === 'referenceList' || functionName === 'compareCodeUnits' || functionName === 'utf8ByteLength' || functionName.startsWith('targetIndex');
      let next = ts.visitEachChild(node, visitor, context);
      if (functionName === 'compareCodeUnits' && next.body) next = f.updateFunctionDeclaration(next, next.modifiers, next.asteriskToken, next.name, next.typeParameters, next.parameters, next.type, f.updateBlock(next.body, [checkpoint('compareCodeUnits:admit'), ...next.body.statements]));
      owned = before; functionName = beforeName; return next;
    }
    if (!owned) return ts.visitEachChild(node, visitor, context);
    if (ts.isBlock(node)) {
      const statements: ts.Statement[] = [];
      for (const statement of node.statements) {
        const name = variable(statement);
        let marker = name && ['targetsByCollection', 'sourceRecords', 'mappings', 'records', 'rows', 'unique', 'ledger', 'keys', 'names', 'bucket', 'sorted'].includes(name) ? `${name}:admit` : undefined;
        if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
          const left = statement.expression.left;
          if (ts.isElementAccessExpression(left) && ts.isIdentifier(left.expression)) {
            if (left.expression.text === 'targetsByCollection' && functionName === '__assembly') marker = 'bucket:admit';
            if (left.expression.text === 'records' && functionName === '__assembly') marker = 'records.assign:admit';
          }
        }
        if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
          const call = statement.expression;
          if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'push' && call.arguments.length === 1 && call.arguments[0].getText(sourceFile) === 'target') marker = 'target.append:admit';
        }
        if (name === 'bucket' && ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Let) marker = undefined;
        if (functionName === 'targetIndexRows' && ts.isExpressionStatement(statement) && statement.getText(sourceFile).startsWith('referenceNative(budget, () => { records[name] = rows; })')) marker = 'records.assign:admit';
        if (marker) {
          // Put the observation before contiguous real reservation/work statements.
          // No marker is itself a debit, factory, branch or implementation seam.
          let position = statements.length;
          while (position > 0) {
            const prior = statements[position - 1];
            if (prior.pos < 0) break;
            const text = prior.getText(sourceFile);
            if (/^budget[?!.]*\.(reserve|spend)/.test(text) || /^if \(budget && !targetsByCollection/.test(text)) position--; else break;
          }
          statements.splice(position, 0, checkpoint(marker));
        }
        statements.push(ts.visitNode(statement, visitor) as ts.Statement);
      }
      return f.updateBlock(node, statements);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer, name = node.name.text;
      const isContainer = ts.isArrayLiteralExpression(init) || ts.isNewExpression(init) || (ts.isCallExpression(init) && /^(Object\.create|referenceList|referenceMap)/.test(init.expression.getText(sourceFile))) || (ts.isConditionalExpression(init) && ts.isCallExpression(init.whenTrue) && init.whenTrue.expression.getText(sourceFile) === 'referenceList');
      const previousRole = variableRole; variableRole = name;
      const value = isContainer ? factory(name, ts.visitEachChild(init, visitor, context)) : ts.visitNode(init, visitor) as ts.Expression;
      variableRole = previousRole;
      return f.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, value);
    }
    if (functionName === 'utf8ByteLength' && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'charCodeAt') return f.createCallExpression(f.createIdentifier('__utfRead'), undefined, [node.arguments[0], f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node)]);
    if (functionName === 'compareCodeUnits' && ts.isReturnStatement(node) && node.expression) return f.updateReturnStatement(node, factory('compare.primitive', node.expression));
    if (functionName === 'referenceList' && ts.isArrayLiteralExpression(node)) return factory('@list', node);
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 0 && variableRole) return factory(variableRole, node);
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'Object.create' && variableRole) return factory(variableRole, node);
    if (ts.isArrayLiteralExpression(node) && node.elements.some(ts.isSpreadElement)) return factory('collections', ts.visitEachChild(node, visitor, context));
    if (ts.isBinaryExpression(node) && ts.isElementAccessExpression(node.left) && ts.isIdentifier(node.left.expression) && node.left.expression.text === 'targetsByCollection' && ts.isArrayLiteralExpression(node.right)) {
      return f.updateBinaryExpression(node, node.left, node.operatorToken, factory('bucket', node.right));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'referenceAppend' && node.arguments.length >= 2) {
      const name = node.arguments[1].getText(sourceFile) === 'target' ? 'target' : node.arguments[0].getText(sourceFile);
      return f.createCommaListExpression([f.createCallExpression(f.createIdentifier('__checkpoint'), undefined, [f.createStringLiteral(`${name}.append:admit`)]), ts.visitEachChild(node, visitor, context)]);
    }
    return ts.visitEachChild(node, visitor, context);
  };
  return source => { sourceFile = source; return ts.visitNode(source, visitor) as ts.SourceFile; };
}

function loader(original = false, completion = false) {
  const loaded = new Map<string, Record<string, unknown>>();
  let hook: Hook = () => {}, active = false, observing = false;
  let owner: ReturnType<typeof createNormalizationOutput> | undefined;
  let lane = zero();
  let naturalObserver: ((entries: Entry[]) => void) | undefined;
  let naturalIndexObserver: ((buckets: Record<string, Target[]>) => void) | undefined;
  const emit = (name: string, value?: unknown) => { if (active) hook({ name, value }); };
  const call = <T>(name: string, fn: () => T): T => {
    emit(`${name}:enter`);
    try { const value = fn(); emit(`${name}:return`, value); return value; }
    catch (error) { emit(`${name}:throw`, error); throw error; }
  };
  // Execute the actual complete shared module with only its native Array
  // constructor rebound. This observes the TWO real merge allocations, not a
  // replacement sort and not a process-global Array/iterator mutation.
  const sortExports: { stableBudgetSort?: typeof work.stableBudgetSort; utf8ByteLength?: typeof work.utf8ByteLength } = {};
  if (completion && !original) {
    const code = ts.transpileModule(readFileSync('src/lib/boundedWork.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: { before: [completionTransformer] } }).outputText;
    new Function('exports', 'Array', '__utfRead', code)(sortExports, new Proxy(Array, { construct(target, args) {
      const value = call('sort.array.factory', () => Reflect.construct(target, args));
      return new Proxy(value, {
        get(t,k,r) { if (typeof k === 'string' && /^\d+$/.test(k)) emit('review.scratch.index:lookup', t); return Reflect.get(t,k,r); },
        set(t,k,v,r) { if (typeof k === 'string' && /^\d+$/.test(k)) emit('review.scratch.write:lookup',t); const result=Reflect.set(t,k,v,r); if (typeof k === 'string' && /^\d+$/.test(k)) emit('review.scratch.write:return',t); return result; }
      });
    } }), (index: number, operation: () => number) => { emit('utf8.char:lookup', index); return operation(); });
  }
  const observedSort = sortExports.stableBudgetSort ?? work.stableBudgetSort;
  const observedUtf = sortExports.utf8ByteLength ?? work.utf8ByteLength;
  const watchedWork = { ...work,
    utf8ByteLength: (value: string, budget?: work.BudgetContext) => call(`utf8:${JSON.stringify(value)}`, () => (completion ? observedUtf : work.utf8ByteLength)(value, budget)),
    stableBudgetSort: <T>(values: T[], compare: (a: T, b: T) => number, budget?: work.BudgetContext) => {
      const table = completion ? bucketSet.has(values) : values.length > 0 && typeof values[0] === 'object';
      if (table) emit('targetSort:enter', values); else if (completion) emit('collectionSort:enter', values);
      const result = call('stableSort', () => (completion ? observedSort : work.stableBudgetSort)(values, (a, b) => call('comparator', () => compare(a, b)), budget));
      if (table) emit('bucket.sort:return', result); else if (completion) emit('collection.sort:return', result);
      return new Proxy(result, { get(t, k, r) {
        const value = Reflect.get(t, k, r);
        if (k === 'length' || (typeof k === 'string' && /^\d+$/.test(k))) emit(`${table ? 'review.sorted' : 'review.names'}.${k === 'length' ? 'length' : 'index'}:return`);
        return value;
      } });
    },
  };
  function outputFactory(budget?: work.BudgetContext) {
    emit('output.owner:create');
    const real = owner ?? createNormalizationOutput(budget);
    if (!active) return real;
    const result = { ...real };
    for (const key of ['mapping', 'sourceRecord'] as const) {
      Object.defineProperty(result, key, { get() {
        emit(`output.${key}:lookup`);
        return (...args: unknown[]) => {
          const before = budget?.usage() ?? zero();
          try { return Reflect.apply(real[key], real, args); }
          finally { const diff = subtract(budget?.usage() ?? zero(), before); for (const k of counters) lane[k] += diff[k]; }
        };
      } });
    }
    Object.defineProperty(result, 'target', { get() {
      emit('output.target:lookup');
      return (rows: unknown[], factory: () => unknown) => call('output.target', () => {
        if (observing && !Object.hasOwn(rows, 'push')) Object.defineProperty(rows, 'push', { configurable: true, get() {
          emit('rows.push:lookup');
          return (...items: unknown[]) => call('rows.push', () => Array.prototype.push.apply(rows, items));
        } });
        return real.target(rows, () => call('record.factory', factory));
      });
    } });
    return result;
  }
  let listRole = '';
  let boundedRun = false;
  const observedArrays = new WeakSet<object>();
  const bucketSet = new WeakSet<object>();
  function bucket(array: Target[]) {
    if (bucketSet.has(array)) return array;
    const proxy = new Proxy(array, {
      get(target, key, receiver) {
        if (key === 'push') { emit('bucket.push:lookup'); return (...items: Target[]) => call('bucket.push', () => Array.prototype.push.apply(target, items)); }
        if (key === 'sort') { emit('bucket.sort:lookup', receiver); return (compare: (a: Target, b: Target) => number) => call('bucket.sort', () => Array.prototype.sort.call(receiver, (a, b) => call('comparator', () => compare(a, b)))); }
        if (key === 'length') emit('bucket.length:lookup', receiver);
        if (completion && typeof key === 'string' && /^\d+$/.test(key)) emit('bucket.index:lookup', receiver);
        return Reflect.get(target, key, receiver);
      },
      set(target, key, value, receiver) { if (completion) emit('bucket.write:lookup', key); const result = Reflect.set(target, key, value, receiver); emit('bucket.write:return', key); return result; },
    });
    bucketSet.add(proxy); return proxy;
  }
  const endOfIndex = {}; // Test-only stop before out-of-scope mapping sort invocation.
  let shells = 0;
  const localObject = new Proxy(Object, { get(target, key, receiver) {
    if (key === 'create') return (proto: object | null) => {
      const value = Object.create(proto);
      if (!active || !observing || proto !== null) return value;
      const kind = ++shells === 1 ? 'buckets' : 'records';
      emit(`${kind}.create:return`, value);
      return new Proxy(value, {
        ownKeys(t) { emit(`${kind}.ownKeys:enter`); return Reflect.ownKeys(t); },
        get(t, k, r) { emit(`${kind}.get:lookup`, k); const v = Reflect.get(t, k, r); emit(`${kind}.get:return`, k); return v; },
        set(t, k, v, r) { if (completion) emit(`${kind}.write:lookup`, k); const result = Reflect.set(t, k, kind === 'buckets' && Array.isArray(v) ? bucket(v) : v, r); emit(`${kind}.write:return`, k); return result; },
      });
    };
    if (key === 'entries') { if (!observing) return Object.entries; emit('Object.entries:lookup'); return (value: object) => call('Object.entries', () => {
      const result = Object.entries(value).map(tuple => new Proxy(tuple, { get(t, k, r) {
        if (k === '0' || k === '1') { const label = k === '0' ? 'tuple.name' : 'tuple.targets'; emit(`${label}:lookup`); const v = Reflect.get(t, k, r); emit(`${label}:return`); return v; }
        if (k === Symbol.iterator) emit('tuple.iterator:lookup');
        return Reflect.get(t, k, r);
      } }));
      return new Proxy(result, { get(t, k, r) { if (k === 'length') emit('entries.length:lookup'); else if (typeof k === 'string' && /^\d+$/.test(k)) emit('entries.index:lookup'); return Reflect.get(t, k, r); } });
    }); }
    return Reflect.get(target, key, receiver);
  } });
  const localMap = new Proxy(Map, { construct(target, args) {
    if (completion && active && observing) emit('Map.create:enter');
    const map = Reflect.construct(target, args) as Map<unknown, unknown>;
    if (!active || !observing) return map;
    emit('Map.create:return', map);
    return new Proxy(map, { get(t, k) {
      if (['has', 'set', 'get', 'values', 'delete'].includes(String(k))) {
        emit(`Map.${String(k)}:lookup`);
        return (...values: unknown[]) => call(`Map.${String(k)}`, () => {
          const result = Reflect.apply(Reflect.get(t, k), t, values);
          if (k !== 'values') return result;
          return { [Symbol.iterator]() { emit('Map.values.iterator:lookup'); return this; }, next: () => call('Map.values.next', () => (result as Iterator<unknown>).next()) };
        });
      }
      const value = Reflect.get(t, k, t); return typeof value === 'function' ? value.bind(t) : value;
    } });
  } });
  function load(rel: string): Record<string, unknown> {
    if (loaded.has(rel)) return loaded.get(rel)!;
    if (!original && rel === 'src/lib/boundedWork.ts') return watchedWork;
    if (!original && rel === 'src/lib/boundedJson.ts') return graph;
    if (!original && rel === 'src/server/migration/normalizationOutput.ts') return { createNormalizationOutput: outputFactory };
    const filename = original ? `${evidence}/oracle-source/${rel}` : rel;
    let text = readFileSync(filename, 'utf8');
    if (rel === 'src/server/migration/normalize.ts') {
      const ast = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
      const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'normalizeLegacySnapshots') as ts.FunctionDeclaration;
      const block = fn.body!.statements.find(ts.isTryStatement)?.tryBlock ?? fn.body!;
      const statements = [...block.statements];
      const declaration = (s: ts.Statement, name: string) => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name);
      let start = statements.findIndex(s => declaration(s, 'targetsByCollection'));
      const end = statements.findIndex((s, i) => i > start && (s.getText(ast).startsWith('mappings.sort(') || (ts.isIfStatement(s) && s.expression.getText(ast) === 'budget' && s.thenStatement.getText(ast) === 'finalMappingSort(mappings, budget);' && s.elseStatement?.getText(ast).startsWith('mappings.sort('))));
      if (start < 0 || end < 0) throw new Error('Actual assembly AST anchors absent');
      while (start > 0 && /^budget[?!.]*\.(reserve|spend)\(/.test(statements[start - 1].getText(ast))) start--;
      const assembly = text.slice(statements[start].getStart(ast), statements[end].getStart(ast));
      const diagnostics = statements.filter(s => declaration(s, 'diagnosticCount') || declaration(s, 'pushDiagnostics')).map(s => s.getText(ast)).join('\n');
      const naturalEnd = statements[end].getStart(ast);
      text = text.slice(0, naturalEnd) + '__naturalIndex(targetsByCollection);\n' + text.slice(naturalEnd);
      const naturalStart = statements[start].getStart(ast);
      text = text.slice(0, naturalStart) + '__naturalEntries(entries);\n' + text.slice(naturalStart);
      text += `\nexport function __assembly(collections, entries, budget) {
        const output = budget ? createNormalizationOutput(budget) : undefined;
        const conflicts = []; ${diagnostics}
        ${assembly}
        __successor(mappings);
        try { ${ts.isIfStatement(statements[end]) ? (statements[end] as ts.IfStatement).elseStatement!.getText(ast) : statements[end].getText(ast)} } catch (error) { if (error !== __endOfIndex) throw error; }
        return {records, sourceRecords, mappings, targetsByCollection, conflicts};
      }`;
    }
    const mod = { exports: {} as Record<string, unknown> }; loaded.set(rel, mod.exports);
    const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }, transformers: completion && (rel.endsWith('/normalize.ts') || rel.endsWith('/validators.ts')) ? { before: [completionTransformer] } : undefined }).outputText;
    const resolve = (id: string) => {
      if (id === 'server-only') return {};
      if (!id.startsWith('.') && !id.startsWith('@/')) return nativeRequire(id);
      let local = id.startsWith('@/') ? 'src/' + id.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(rel), id));
      if (!local.endsWith('.ts')) local += '.ts';
      if (!existsSync(original ? `${evidence}/oracle-source/${local}` : local)) throw new Error(`Real dependency missing: ${local}`);
      return load(local);
    };
    new Function('require', 'module', 'exports', 'Object', 'Map', '__successor', '__endOfIndex', '__naturalEntries', '__checkpoint', '__factory', '__naturalIndex', js)(resolve, mod, mod.exports, rel.endsWith('/normalize.ts') ? localObject : Object, rel.endsWith('/normalize.ts') ? localMap : Map,
      (mappings: unknown[]) => { Object.defineProperty(mappings, 'sort', { get() { emit('mappings.sort:lookup'); throw endOfIndex; } }); }, endOfIndex,
      (entries: Entry[]) => naturalObserver?.(entries),
      (name: string) => emit(name),
      (label: string, factory: () => unknown) => {
        const previous = listRole, name = label === '@list' ? `${listRole}.array` : label;
        if (label !== '@list') listRole = label;
        try { return call(`${name}.factory`, () => {
        const value = factory();
        if (!Array.isArray(value) || observedArrays.has(value)) return value;
        if (name === 'bucket' && boundedRun) return bucket(value as Target[]);
        const proxy = new Proxy(value, {
          get(t, k, r) {
            if (k === 'sort' && name === 'collections') { emit('collection.sort:lookup'); return (compare: (a: string, b: string) => number) => call('collection.sort', () => Array.prototype.sort.call(r, compare)); }
            if (k === 'push') { emit(`${name}.push:lookup`); return (...items: unknown[]) => call(`${name}.push`, () => Array.prototype.push.apply(t, items)); }
            if (k === 'length') emit(`${name}.length:lookup`);
            else if (typeof k === 'string' && /^\d+$/.test(k)) emit(`${name}.index:lookup`);
            const result = Reflect.get(t, k, r);
            if (k === 'length') emit(`${name}.length:return`);
            else if (typeof k === 'string' && /^\d+$/.test(k)) emit(`${name}.index:return`);
            return result;
          },
          set(t, k, v, r) { emit(`${name}.write:lookup`, k); const result = Reflect.set(t, k, v, r); emit(`${name}.write:return`, k); return result; },
        });
        observedArrays.add(proxy); return proxy;
      }); } finally { listRole = previous; }
      }, (buckets: Record<string, Target[]>) => naturalIndexObserver?.(buckets));
    loaded.set(rel, mod.exports); return mod.exports;
  }
  const api = load('src/server/migration/normalize.ts');
  return {
    completion,
    normalize: api.normalizeLegacySnapshots as (input: unknown, budget?: work.BudgetContext) => unknown,
    natural(input: unknown, budget: work.BudgetContext | undefined, observer: (entries: Entry[]) => void, indexObserver?: (buckets: Record<string, Target[]>) => void) {
      naturalObserver = observer; naturalIndexObserver = indexObserver;
      try { return (api.normalizeLegacySnapshots as (input: unknown, budget?: work.BudgetContext) => Result)(input, budget); }
      finally { naturalObserver = undefined; naturalIndexObserver = undefined; }
    },
    run(names: string[], entries: Entry[], budget?: work.BudgetContext, observer?: Hook, output?: ReturnType<typeof createNormalizationOutput>) {
      hook = observer ?? (() => {}); boundedRun = budget !== undefined; active = true; observing = observer !== undefined; shells = 0; lane = zero(); owner = output;
      try {
        const collections = new Set(names);
        if (observing) Object.defineProperty(collections, 'forEach', { get() {
          emit('Set.forEach:lookup');
          return (fn: (value: string) => void) => call('Set.forEach', () => Set.prototype.forEach.call(collections, value => call('collection.callback', () => fn(value))));
        } });
        if (observing) Object.defineProperty(collections, Symbol.iterator, { get() {
          emit('Set.iterator:lookup');
          return () => { const iterator = Set.prototype[Symbol.iterator].call(collections); return { next: () => call('Set.iterator.next', () => iterator.next()) }; };
        } });
        return (api.__assembly as (names: Set<string>, entries: Entry[], budget?: work.BudgetContext) => Result)(collections, entries, budget);
      }
      finally { active = false; owner = undefined; }
    },
    lane: () => ({ ...lane }),
  };
}
const candidate = loader();
// Original execution belongs to the oracle tool; maintained assertions use frozen values.
function entry(targets: Target[], errors: string[] = []): Entry {
  return { source: { kind: 'SHEET', artifactDigest: 'a', tab: 'Synthetic', rowNumber: 1, rowHash: 'h' }, tab: 'Synthetic', identity: 'i', sourcePrimaryIdentity: null,
    redacted: { identityDigest: 'i', recognizedFieldCount: 1, omittedFieldCount: 0 }, canonical: targets[0]?.record ?? null, targets, refs: [], warnings: [], errors };
}
function materialize(f: typeof golden.synthetic[number]) {
  const targets: Target[] = (f.targets ?? []).map(([table, id, tag]) => ({ table, id, record: { tag } }));
  return { targets, entries: targets.length ? [entry(targets, f.errors)] : [] };
}
function allocation(names: string[], entries: Entry[]) {
  const buckets = new Map(names.map(name => [name, [] as string[]]));
  for (const e of entries) if (!e.errors.length) for (const t of e.targets) { if (!buckets.has(t.table)) buckets.set(t.table, []); buckets.get(t.table)!.push(t.id); }
  const C = names.length, K = buckets.size, T = [...buckets.values()].reduce((s, ids) => s + ids.length, 0);
  const U = [...buckets.values()].reduce((s, ids) => s + new Set(ids).size, 0);
  const B = [...buckets.keys()].reduce((s, name) => s + Buffer.byteLength(name), 0);
  return { nodes: 10 + 8 * K, slots: 3 * C + 7 * K + 3 * T + 4 * U, structuralBytes: 160 + 12 * C + 144 * K + 12 * T + 16 * U + 2 * B, contentBytes: B };
}

describe('executed Git natural oracle (not accepted duplicate-ID evidence)', () => {
  for (const f of golden.cases) for (const bounded of [false, true]) it(`${f.name} budget=${bounded}`, () => {
    const budget = bounded ? work.createBudgetContext({ now: () => 0 }) : undefined;
    const input = budget ? graph.parseRegisteredBoundedJson(JSON.stringify(f.input), budget) : JSON.parse(JSON.stringify(f.input));
    expect(JSON.stringify(candidate.normalize(input, budget))).toBe(f.json);
  });
});
describe('synthetic actual assembly semantics and observer noninterference', () => {
  for (const f of golden.synthetic) for (const bounded of [false, true]) it(`${f.name} budget=${bounded}`, () => {
    const { targets, entries } = materialize(f);
    const result = candidate.run(f.names, entries, bounded ? work.createBudgetContext({ now: () => 0 }) : undefined);
    expect(JSON.stringify(result)).toBe(f.json);
    expect(Object.keys(result.records)).toEqual(f.recordKeys);
    expect(Object.getPrototypeOf(result.records)).toBe(null);
    expect(Object.getPrototypeOf(result.targetsByCollection)).toBe(null);
    if (f.bucketIndices) expect(Object.fromEntries(Object.entries(result.targetsByCollection).map(([k, v]) => [k, v.map(t => targets.indexOf(t))]))).toEqual(f.bucketIndices);
    if (f.rowIndices) expect(Object.fromEntries(Object.entries(result.records).map(([k, v]) => [k, v.map(r => targets.findIndex(t => t.record === r))]))).toEqual(f.rowIndices);
    expect(Object.isFrozen(result.records)).toBe(false);
    for (const rows of Object.values(result.records)) { expect(Object.isFrozen(rows)).toBe(false); for (const record of rows) expect(Object.isFrozen(record)).toBe(false); }
  });
  for (const f of golden.synthetic) for (const runtime of [candidate]) it(`${f.name} candidate observer on/off`, () => {
    const trace: Event[] = [];
    const observed = runtime.run(f.names, materialize(f).entries, undefined, e => trace.push(e));
    const unobserved = runtime.run(f.names, materialize(f).entries);
    expect(JSON.stringify(observed)).toBe(JSON.stringify(unobserved));
    expect(JSON.stringify(observed)).toBe(f.json);
    expect(trace.some(e => e.name === 'Object.entries:enter')).toBe(true);
  });
});
describe('independent closed allocation (source/mapping payload lane subtracted)', () => {
  for (const f of golden.synthetic.filter(f => !f.errors?.length)) it(`${f.name} C/K/T/U fixed formula`, () => {
    const { entries } = materialize(f), budget = work.createBudgetContext({ now: () => 0 });
    candidate.run(f.names, entries, budget);
    expect(subtract(budget.usage(), candidate.lane())).toMatchObject(allocation(f.names, entries));
  });
  for (const f of golden.synthetic.filter(f => !f.targets?.length)) for (const counter of counters.filter(c => c !== 'work')) for (const delta of [-1, 0, 1]) {
    const expected = allocation(f.names, []), limit = expected[counter] + delta;
    if (limit < 0) continue;
    it(`${f.name} total ${counter} delta=${delta}`, () => {
      const budget = work.createBudgetContext({ now: () => 0, limits: { [counter]: limit } });
      if (delta < 0) expect(() => candidate.run(f.names, [], budget)).toThrow(work.BudgetExceededError);
      else { candidate.run(f.names, [], budget); expect(budget.usage()).toMatchObject(expected); }
    });
  }
});


type State = 'timely' | 'expired' | 'aborted' | 'no-budget';
type Exit = 'success' | 'ordinary' | 'exceeded' | 'unavailable';
const states: State[] = ['timely', 'expired', 'aborted', 'no-budget'];
const exits: Exit[] = ['success', 'ordinary', 'exceeded', 'unavailable'];
const nativeSeams = [
  'buckets.create:return', 'buckets.get:return', 'buckets.write:return',
  'bucket.push:return', 'Object.entries:return', 'bucket.sort:return',
  'Map.create:return', 'Map.set:return', 'records.create:return',
  'rows.push:return', 'output.target:return', 'records.write:return',
  'entry.errors:return', 'errors.length:return', 'entry.targets:return',
  'target.table:return', 'comparator.left:return', 'comparator.right:return',
  'target.id:return', 'target.record:return', 'tuple.name:return', 'tuple.targets:return',
] as const;
function nativeProbe(runtime: ReturnType<typeof loader>, seam: string, state: State, exit: Exit, observer = true, capacity?: { arm: string; operand: string; remaining: number; ids?: string[]; table?: string; occurrence?: number }, variant?: { names?: string[]; ids?: string[]; occurrence?: number }) {
  let seamVisits = 0;
  let capacityArmed = 0, capacityReached = 0, capacityVisits = 0;
  const capacityStop = new RangeError('scalar capacity operand');
  let late = false, reached = 0, sort = false, map = false, targetOutput = false, comparatorReads = 0;
  const signal = { aborted: false }, trace: string[] = [];
  const injected = exit === 'ordinary' ? new RangeError('target-index native sentinel') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
  const base = work.createBudgetContext({ now: () => late && state === 'expired' ? 5000 : 0, signal });
  const budget = state === 'no-budget' ? undefined : new Proxy({ ...base }, { get(t, k: keyof work.BudgetContext) {
    if (late && ['spend', 'reserve', 'reserveString'].includes(k)) trace.push(`budget.${k}:lookup`);
    return t[k];
  } });
  const handle: Hook = event => {
    if (capacity && event.name === capacity.arm && ++capacityVisits === (capacity.occurrence ?? 1)) { capacityArmed++; leave(base, 'work', capacity.remaining); }
    if (capacityArmed && event.name === capacity?.operand) { capacityReached++; throw capacityStop; }
    if (event.name === 'bucket.sort:lookup' || event.name === 'targetSort:enter') sort = true;
    if (event.name === 'comparator:enter') comparatorReads = 0;
    if (event.name === 'Map.create:return') { sort = false; map = true; }
    if (event.name === 'output.target:lookup') targetOutput = true;
    if (late && observer && (event.name.endsWith(':lookup') || ['comparator:return', 'record.factory:return'].includes(event.name) || (runtime.completion && (event.name === 'collection.callback:return' || event.name.endsWith('.factory:return'))))) trace.push(event.name);
    if (!reached && event.name === seam && ++seamVisits === (variant?.occurrence ?? 1)) {
      reached++; late = true;
      if (state === 'aborted') signal.aborted = true;
      if (exit !== 'success') throw injected;
    }
  };
  const targets: Target[] = [ { table: 't', id: 'b', record: { tag: 'first' } }, { table: 't', id: 'a', record: { tag: 'last' } } ];
  if (variant?.ids) { targets.splice(0, targets.length, ...variant.ids.map(id => ({ table: 't', id, record: {} }))); }
  if (capacity?.ids) { targets.splice(0, targets.length, ...capacity.ids.map(id => ({ table: capacity.table ?? 't', id, record: {} }))); }
  const e = entry(targets);
  const errors = new Proxy(e.errors, { get(t, key, r) { if (key === 'length') { handle({ name: 'errors.length:lookup' }); const value = Reflect.get(t, key, r); handle({ name: 'errors.length:return' }); return value; } return Reflect.get(t, key, r); } });
  Object.defineProperty(e, 'errors', { get() { handle({ name: 'entry.errors:lookup' }); handle({ name: 'entry.errors:return' }); return errors; } });
  Object.defineProperty(e, 'targets', { get() { handle({ name: 'entry.targets:lookup' }); handle({ name: 'entry.targets:return' }); return targets; } });
  for (const target of targets) {
    const { table, id, record } = target;
    Object.defineProperty(target, 'table', { get() { handle({ name: 'target.table:lookup' }); handle({ name: 'target.table:return' }); return table; } });
    Object.defineProperty(target, 'id', { get() {
      const name = sort ? (++comparatorReads === 1 ? 'comparator.left' : 'comparator.right') : map ? 'target.id' : 'mapping.id';
      handle({ name: name + ':lookup' }); handle({ name: name + ':return' }); return id;
    } });
    Object.defineProperty(target, 'record', { get() { if (targetOutput || state === 'no-budget') { handle({ name: 'target.record:lookup' }); handle({ name: 'target.record:return' }); } return record; } });
  }
  let caught: unknown, result: Result | undefined;
  try { result = runtime.run(variant?.names ?? [capacity?.table ?? 't'], [e], budget, handle); } catch (error) { caught = error; }
  return { reached, trace, caught, injected, json: result ? JSON.stringify(result) : undefined, capacityArmed, capacityReached, capacityStop };
}
describe('reached native/getter exits: earliest lookup and local callback return', () => {
  for (const seam of nativeSeams) for (const state of states) for (const exit of exits) {
    // These are budget-only emitter operations, not invented no-budget calls.
    if (state === 'no-budget' && ['rows.push:return', 'output.target:return'].includes(seam)) continue;
    it(`${seam} ${state} ${exit}`, () => {
      const result = nativeProbe(candidate, seam, state, exit);
      expect(result.reached, 'the actual native/getter must be reached').toBe(1);
      if (state === 'no-budget') {
        const oracle = golden.native.find(f => f.seam === seam && f.exit === exit)!.outcome;
        expect(result.trace).toEqual(oracle.trace); expect(result.json ?? null).toBe(oracle.json);
        expect(result.caught === result.injected).toBe(oracle.error?.sameInjected ?? false);
      } else if (state === 'timely') {
        if (exit === 'success') expect(result.caught).toBeUndefined();
        else expect(result.caught).toBe(result.injected);
      } else {
        if (exit === 'exceeded' || exit === 'unavailable') expect(result.caught).toBe(result.injected);
        else expect(result.caught).toBeInstanceOf(work.BudgetUnavailableError);
        expect(result.trace, 'no successor method lookup or late local callback return').toEqual([]);
      }
    });
  }
});
describe('per-key UTF8 local completion, including later keys and final property', () => {
  for (const names of [['a', 'z'], ['한글', '\0', '\ud800'], ['x'.repeat(255) + '😀']]) for (const name of names) for (const occurrence of [1, 2, 3]) for (const state of ['expired', 'aborted'] as const) for (const exit of exits) {
    it(`${JSON.stringify(name)} UTF8 occurrence=${occurrence} ${state} ${exit}`, () => {
      let count = 0, reached = 0, late = false, next = 0;
      const signal = { aborted: false };
      const base = work.createBudgetContext({ now: () => late && state === 'expired' ? 5000 : 0, signal });
      const budget = new Proxy({ ...base }, { get(t, k: keyof work.BudgetContext) { if (late && ['reserve', 'reserveString', 'spend'].includes(k)) next++; return t[k]; } });
      const injected = exit === 'ordinary' ? new RangeError('UTF8 return') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
      let caught: unknown;
      try { candidate.run(names, [], budget, event => {
        if (event.name === `utf8:${JSON.stringify(name)}:return` && ++count === occurrence) {
          reached++; late = true; if (state === 'aborted') signal.aborted = true;
          if (exit !== 'success') throw injected;
        }
      }); } catch (error) { caught = error; }
      expect(reached, 'each actual name scan must be present').toBe(1);
      expect(next, 'UTF8 completion must precede next budget-method lookup').toBe(0);
      if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(injected);
      else expect(caught).toBeInstanceOf(work.BudgetUnavailableError);
    });
  }
});
function mutationProbe(runtime: ReturnType<typeof loader>, kind: 'post-sort-id' | 'post-map-record', bounded: boolean) {
  const targets: Target[] = [
    { table: 't', id: 'b', record: { tag: 'b' } },
    { table: 't', id: 'a', record: { tag: 'first' } },
    { table: 't', id: 'a', record: { tag: 'last' } },
  ];
  const replacement = { tag: 'replacement' };
  let sets = 0, reached = 0;
  const result = runtime.run(['t'], [entry(targets)], bounded ? work.createBudgetContext({ now: () => 0 }) : undefined, event => {
    if (kind === 'post-sort-id' && event.name === 'Map.create:return') { reached++; targets[1].id = 'z'; targets[2].id = 'z'; }
    if (kind === 'post-map-record' && event.name === 'Map.set:return' && ++sets === targets.length) { reached++; targets[2].record = replacement; }
  });
  return { reached, json: JSON.stringify(result), indices: result.records.t.map(r => targets.findIndex(t => t.record === r)), mappingCount: result.mappings.length,
    bucketIndices: result.targetsByCollection.t.map(t => targets.indexOf(t)), replacementAlias: result.records.t.includes(replacement) };
}
describe('synthetic fixed mutation seams and public mutable aliases', () => {
  for (const kind of ['post-sort-id', 'post-map-record'] as const) for (const bounded of [false, true]) it(`${kind} budget=${bounded}`, () => {
    const expected = golden.mutations.find(f => f.kind === kind)!.outcome;
    const actual = mutationProbe(candidate, kind, bounded);
    expect(actual.reached).toBe(1); expect(actual).toEqual(expected); expect(actual.mappingCount).toBe(3);
  });
  for (const bounded of [false, true]) it(`rows separate, canonical records shared, invalid graph budget=${bounded}`, () => {
    const budget = work.createBudgetContext({ now: () => 0 });
    const canonical = { tag: 'shared' }, targets: Target[] = [{ table: 't', id: 'a', record: canonical }];
    const e = entry(targets), result = candidate.run(['t'], [e], bounded ? budget : undefined);
    expect(result.records.t[0]).toBe(canonical); expect(e.canonical).toBe(canonical);
    canonical.tag = 'mutated'; expect(result.records.t[0].tag).toBe('mutated');
    result.records.t.push({ tag: 'row-only' }); expect(e.targets).toHaveLength(1);
    expect(() => graph.assertRegisteredBoundedJson(result.records, budget)).toThrow('Legacy bounded JSON is invalid.');
    expect(() => graph.assertRegisteredBoundedJson(canonical, budget)).toThrow('Legacy bounded JSON is invalid.');
  });
});


// Capacity probes stop at the FIRST actual operand. Exact/+1 are not inferred
// from a later outer budget exception, and expectations never sample usage.
function leave(budget: work.BudgetContext, counter: typeof counters[number], remaining: number) {
  const amount = budget.limits[counter] - budget.usage()[counter] - remaining;
  if (amount < 0) throw new Error('Capacity probe cannot arm at this reached predecessor');
  if (counter === 'work') budget.spend(amount); else budget.reserve({ [counter]: amount });
}
describe('reached Object.entries upfront own-key + tuple scratch', () => {
  for (const names of [[], ['t'], ['a', '한글'], ['x'.repeat(255) + '😀', '\ud800', '\0']]) {
    const K = names.length, B = names.reduce((s, name) => s + Buffer.byteLength(name), 0);
    const cost = { nodes: 2 + 2 * K, slots: 4 * K, structuralBytes: 32 + 36 * K, contentBytes: B };
    for (const counter of ['nodes', 'slots', 'structuralBytes', 'contentBytes'] as const) for (const delta of [-1, 0, 1]) {
      if (cost[counter] + delta < 0) continue;
      it(`K=${K} ${JSON.stringify(names)} ${counter} delta=${delta} earliest ownKeys`, () => {
        const budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('Object.entries operand');
        let armed = 0, reached = 0, caught: unknown;
        try { candidate.run(names, [], budget, event => {
          if (event.name === 'records.create:return') { armed++; leave(budget, counter, cost[counter] + delta); }
          if (event.name === 'buckets.ownKeys:enter') { reached++; throw stop; }
        }); } catch (error) { caught = error; }
        expect(armed).toBe(1);
        if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
        else { expect(reached).toBe(1); expect(caught).toBe(stop); }
      });
    }
  }
});
describe('reached first Map entry capacity and native hashing work', () => {
  for (const id of ['a', '', '\0', 'x'.repeat(257) + '😀']) for (const counter of ['slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) {
    const cost = counter === 'slots' ? 2 : counter === 'structuralBytes' ? 8 : 5 + 2 * (1 + Math.ceil(id.length / 256));
    it(`${JSON.stringify(id)} ${counter} delta=${delta} before first set lookup`, () => {
      const budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('Map.set lookup');
      let armed = 0, reached = 0, caught: unknown;
      const target: Target = { table: 't', id, record: { tag: 'one' } };
      try { completionCandidate.run(['t'], [entry([target])], budget, event => {
        if (event.name === (counter === 'work' ? 'Map.create:return' : 'keys.factory:return')) { armed++; leave(budget, counter, cost + delta); }
        if (event.name === 'Map.set:lookup') { reached++; throw stop; }
      }); } catch (error) { caught = error; }
      expect(armed).toBe(1);
      if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
      else { expect(reached).toBe(1); expect(caught).toBe(stop); }
    });
  }
});
describe('same output owner category/destination/factory and no refund', () => {
  for (const prefill of [3999, 4000]) it(`category prefill=${prefill} before record getter`, () => {
    const budget = work.createBudgetContext({ now: () => 0 }), output = createNormalizationOutput(budget);
    for (let i = 0; i < prefill; i++) output.target([], () => null);
    let getters = 0, outputCalls = 0, caught: unknown;
    const target: Target = { table: 't', id: 'a', record: {} };
    Object.defineProperty(target, 'record', { get() { getters++; return {}; } });
    try { candidate.run(['t'], [entry([target])], budget, event => { if (event.name === 'output.target:enter') outputCalls++; }, output); } catch (error) { caught = error; }
    // entry() reads the record once before execution; only the actual emission
    // getter is counted below, separately from fixture setup.
    expect(outputCalls).toBe(1); expect(getters - 1).toBe(prefill === 3999 ? 1 : 0);
    if (prefill === 4000) expect(caught).toBeInstanceOf(work.BudgetExceededError); else expect(caught).toBeUndefined();
  });
  for (const counter of ['slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) it(`target emitter ${counter} delta=${delta} factory entry`, () => {
    const budget = work.createBudgetContext({ now: () => 0 });
    const cost = counter === 'structuralBytes' ? 4 : 1;
    let armed = 0, reached = 0, caught: unknown;
    const stop = new RangeError('delegated record factory');
    try { candidate.run(['t'], [entry([{ table: 't', id: 'a', record: {} }])], budget, event => {
      if (event.name === 'output.target:enter') { armed++; leave(budget, counter, cost + delta); }
      if (event.name === 'record.factory:enter') { reached++; throw stop; }
    }); } catch (error) { caught = error; }
    expect(armed).toBe(1);
    if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
    else { expect(reached).toBe(1); expect(caught).toBe(stop); }
  });
  it('failed record factory consumes the same owner category and destination without refund', () => {
    const budget = work.createBudgetContext({ now: () => 0 }), output = createNormalizationOutput(budget);
    for (let i = 0; i < 3999; i++) output.target([], () => null);
    const stop = new RangeError('record factory'); let armed = 0;
    expect(() => candidate.run(['t'], [entry([{ table: 't', id: 'a', record: {} }])], budget, event => {
      if (event.name === 'record.factory:enter') { armed++; throw stop; }
    }, output)).toThrow(stop);
    expect(armed).toBe(1); const before = budget.usage();
    expect(() => output.target([], () => null)).toThrow(work.BudgetExceededError);
    expect(budget.usage()).toEqual(before);
  });
  it('all contributors map but only distinct IDs consume category', () => {
    const budget = work.createBudgetContext({ now: () => 0 }), output = createNormalizationOutput(budget);
    for (let i = 0; i < 3999; i++) output.target([], () => null);
    const targets = [0, 1, 2].map(tag => ({ table: 't', id: 'a', record: { tag } }));
    const result = candidate.run(['t'], [entry(targets)], budget, undefined, output);
    expect(result.mappings).toHaveLength(3); expect(result.records.t).toEqual([targets[2].record]);
    expect(() => output.target([], () => null)).toThrow(work.BudgetExceededError);
  });
});


describe('frozen original native iterator/getter/ordinary-stop oracle', () => {
  for (const fixture of golden.native) it(`${fixture.seam} ${fixture.exit} frozen original trace`, () => {
    const result = nativeProbe(candidate, fixture.seam, 'no-budget', fixture.exit);
    const error = result.caught as Error | undefined;
    expect({ reached: result.reached, trace: result.trace, json: result.json ?? null,
      error: error ? { name: error.name, message: error.message, sameInjected: error === result.injected } : null }).toEqual(fixture.outcome);
  });
});


// Independent section-5D ledger. This models the specified merge RUNS, not
// candidate usage or native engine comparison counts. It is not a JSON oracle.
function mergeWork(input: string[], idReads: boolean) {
  let source = input.slice(), cost = input.length;
  for (let width = 1; width < input.length; width *= 2) {
    cost++;
    const next = new Array<string>(input.length);
    for (let start = 0; start < input.length; start += width * 2) {
      cost++;
      const mid = Math.min(start + width, input.length), end = Math.min(start + 2 * width, input.length);
      let left = start, right = mid;
      for (let out = start; out < end; out++) {
        cost += 2;
        let takeLeft = right >= end;
        if (left < mid && right < end) {
          cost += 1 + (idReads ? 2 : 0) + 1 + Math.ceil((source[left].length + source[right].length) / 256);
          takeLeft = source[left] <= source[right];
        }
        next[out] = takeLeft ? source[left++] : source[right++];
      }
    }
    source = next;
  }
  return cost;
}
function indexWork(names: string[], entries: Entry[]) {
  const H = (key: string) => 1 + Math.ceil(key.length / 256), utf = (key: string) => Math.ceil(key.length / 256);
  const loop = (n: number) => 1 + 3 * n;
  const buckets = new Map<string, string[]>(names.map(name => [name, []]));
  // Four existing shells, collection list, ledger, Set admission/callback/append.
  let cost = 4 + 1 + 1 + 1 + 2 * names.length + mergeWork(names, false) + loop(names.length);
  for (const name of names) cost += utf(name) + 1 + H(name) + 1;
  cost += loop(entries.length);
  for (const e of entries) {
    cost += 2; // errors property and length
    if (e.errors.length) throw new Error('Quarantine diagnostic lane is outside this independent model');
    cost += 1 + loop(e.targets.length);
    for (const target of e.targets) {
      cost += 1 + H(target.table);
      if (!buckets.has(target.table)) { buckets.set(target.table, []); cost += utf(target.table) + 1 + H(target.table) + 1; }
      buckets.get(target.table)!.push(target.id); cost++;
    }
  }
  cost += loop(buckets.size) + [...buckets.keys()].reduce((s, key) => s + utf(key), 0);
  cost += 2 + 2 * buckets.size + loop(buckets.size) + 2 * buckets.size;
  for (const [name, ids] of buckets) {
    cost += mergeWork(ids, true) + loop(ids.length) + ids.length;
    cost += 2 + loop(ids.length);
    const keys = new Set<string>();
    for (const id of ids) { cost += 1 + 2 * H(id); if (!keys.has(id)) { keys.add(id); cost++; } }
    cost += utf(name) + 1 + loop(keys.size) + H(name);
    for (const id of keys) cost += H(id) + 1 + 1;
  }
  return cost;
}
describe('independent complete section-5D work ledger', () => {
  for (const f of golden.synthetic.filter(f => !f.errors?.length)) it(`${f.name} fixed work (no candidate-derived expectation)`, () => {
    const { entries } = materialize(f), expected = indexWork(f.names, entries);
    const budget = work.createBudgetContext({ now: () => 0 });
    candidate.run(f.names, entries, budget);
    expect(budget.usage().work - candidate.lane().work).toBe(expected);
  });
});

// Natural exported-caller oracle: retain real native receiver identities until
// after hooks are restored. Bookkeeping uses the saved intrinsic, never a spy.
function naturalRawProbe(runtime: ReturnType<typeof loader>, input: unknown, bounded = false, getters = false) {
  const push = Array.prototype.push;
  const initial: { receiver: unknown[]; value: Entry }[] = [];
  const targetPushes: { receiver: unknown[]; value: Target }[] = [];
  const mappingPushes: { receiver: unknown[]; value: unknown }[] = [];
  const reads: string[] = [];
  let finalEntries: Entry[] = [], inside = false, indexBuckets: Record<string, Target[]> = Object.create(null);
  const budget = bounded ? work.createBudgetContext({ now: () => 0 }) : undefined;
  const fresh = budget ? graph.parseRegisteredBoundedJson(JSON.stringify(input), budget) : JSON.parse(JSON.stringify(input));
  Array.prototype.push = function (...items: unknown[]) {
    if (!inside) {
      inside = true;
      try { for (const value of items) {
        if (!value || typeof value !== 'object') continue;
        if (Object.hasOwn(value, 'source') && Object.hasOwn(value, 'targets') && Object.hasOwn(value, 'redacted')) push.call(initial, { receiver: this, value: value as Entry });
        else if (Object.hasOwn(value, 'table') && Object.hasOwn(value, 'record') && Object.hasOwn(value, 'id')) push.call(targetPushes, { receiver: this, value: value as Target });
        else if (Object.hasOwn(value, 'sourceDigest') && Object.hasOwn(value, 'targetTable') && Object.hasOwn(value, 'targetId')) push.call(mappingPushes, { receiver: this, value });
      } } finally { inside = false; }
    }
    return Reflect.apply(push, this, items);
  };
  let result: Result;
  try { result = runtime.natural(fresh, budget, entries => {
    finalEntries = entries;
    if (getters) {
      const seen = new WeakSet<object>();
      const watch = (object: object, fields: string[], label: string) => {
        if (seen.has(object)) return; seen.add(object);
        for (const key of fields) {
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (!descriptor || !('value' in descriptor)) continue;
          let value = descriptor.value;
          Object.defineProperty(object, key, { configurable: true, enumerable: descriptor.enumerable,
            get() { push.call(reads, `${label}.${key}`); return value; }, set(next) { value = next; } });
        }
      };
      // Snapshot all operands before installing any getter on aliased objects.
      const targets = entries.map(e => e.targets.slice());
      entries.forEach((e, i) => watch(e, ['errors', 'targets', 'source', 'canonical'], `entry:${i}`));
      targets.forEach((list, i) => list.forEach((t, j) => watch(t, ['table', 'id', 'record'], `target:${i}:${j}`)));
    }
  }, buckets => { indexBuckets = buckets; }); } finally { Array.prototype.push = push; }
  const getterTrace = reads.slice(); // serialization reads below are not production trace
  const objectIds = new Map<object, number>();
  const identity = (value: object | null) => { if (!value) return null; if (!objectIds.has(value)) objectIds.set(value, objectIds.size); return objectIds.get(value)!; };
  const raw = finalEntries.map(e => ({ source: e.source, tab: e.tab, identity: e.identity, errors: e.errors, warnings: e.warnings, refs: e.refs,
    canonical: e.canonical, canonicalAlias: identity(e.canonical), targetReceiver: identity(e.targets),
    targets: e.targets.map(t => ({ table: t.table, id: t.id, targetAlias: identity(t), recordAlias: identity(t.record), record: t.record })) }));
  const initialAppends = initial.filter(e => e.receiver === finalEntries).map(e => finalEntries.indexOf(e.value));
  const receiverIds = new Map<unknown[], number>();
  const receiver = (value: unknown[]) => { if (!receiverIds.has(value)) receiverIds.set(value, receiverIds.size); return receiverIds.get(value)!; };
  const stageableTargets = new Set(finalEntries.filter(e => !e.errors.length).flatMap(e => e.targets));
  const targetAppends = targetPushes.filter(e => stageableTargets.has(e.value)).map(e => ({ receiver: receiver(e.receiver), receiverAlias: identity(e.receiver), receiverKind: Object.values(indexBuckets).includes(e.receiver as Target[]) ? 'index' : finalEntries.some(entry => entry.targets === e.receiver) ? 'entry-targets' : 'other', targetAlias: identity(e.value), recordAlias: identity(e.value.record) }));
  const bucketReceivers = Object.fromEntries(Object.entries(indexBuckets).map(([name, bucket]) => [name, identity(bucket)]));
  const contributorAppends = mappingPushes.filter(e => e.receiver === result.mappings).map(e => e.value);
  const rowAliases = Object.fromEntries(Object.entries(result.records).map(([name, rows]) => [name, rows.map(identity)]));
  return { json: JSON.stringify(result), raw, initialAppends, targetAppends, bucketReceivers, contributorAppends, rowAliases, getterTrace };
}

describe('natural exported raw receivers and aliases against executed Git', () => {
  for (const fixture of golden.naturalRaw ?? []) {
    const input = golden.cases.find(f => f.name === fixture.name)!.input;
    for (const bounded of [false, true]) it(`${fixture.name} raw topology budget=${bounded}`, () => {
      const actual = naturalRawProbe(candidate, input, bounded);
      expect(actual).toEqual(fixture.outcome);
      expect(actual.json).toBe(golden.cases.find(f => f.name === fixture.name)!.json);
    });
    it(`${fixture.name} getter observer noninterference no-budget`, () => {
      const actual = naturalRawProbe(candidate, input, false, true);
      expect({ ...actual, getterTrace: [] }).toEqual({ ...fixture.outcome, getterTrace: [] });
      expect(actual.getterTrace).toEqual((golden as unknown as { naturalGetters: Record<string, string[]> }).naturalGetters[fixture.name]);
    });
  }
});
const completionCandidate = loader(false, true);
type Boundary = { name: string; arm: string; operand: string; cost: Partial<Usage>; names?: string[]; targets?: string[][]; future?: boolean; occurrence?: number; phase?: UtfPhase };
const boundaryCases: Boundary[] = [
  { name: 'A targets record shell', arm: 'targetsByCollection:admit', operand: 'targetsByCollection.factory:enter', cost: { nodes: 1, structuralBytes: 16, work: 1 } },
  { name: 'A source and mapping existing shell bundle', arm: 'sourceRecords:admit', operand: 'sourceRecords.factory:enter', cost: { nodes: 2, structuralBytes: 32 } },
  { name: 'A source shell work', arm: 'sourceRecords:admit', operand: 'sourceRecords.factory:enter', cost: { work: 1 } },
  { name: 'A mapping shell work', arm: 'mappings:admit', operand: 'mappings.factory:enter', cost: { work: 1 } },
  { name: 'A final records shell', arm: 'records:admit', operand: 'records.factory:enter', cost: { nodes: 1, structuralBytes: 16, work: 1 } },
  { name: 'A initial names list', arm: 'names:admit', operand: 'names.array.factory:enter', cost: { nodes: 1, structuralBytes: 16, work: 1 }, future: true },
  { name: 'A Set.forEach native admission', arm: 'names.factory:return', operand: 'Set.forEach:lookup', cost: { work: 1 }, names: ['t'], future: true },
  { name: 'A Set.forEach callback visit', arm: 'collection.callback:enter', operand: 'names.append:admit', cost: { work: 1 }, names: ['t'], future: true },
  { name: 'A private name ledger list', arm: 'ledger:admit', operand: 'ledger.array.factory:enter', cost: { nodes: 1, structuralBytes: 16, work: 1 }, future: true },
  { name: 'A collection append', arm: 'names.append:admit', operand: 'names.array.push:lookup', cost: { slots: 1, structuralBytes: 4, work: 1 }, names: ['t'], future: true },
  { name: 'A ledger append initial', arm: 'ledger.append:admit', operand: 'ledger.array.push:lookup', cost: { slots: 1, structuralBytes: 4, work: 1 }, names: ['t'], future: true },
  { name: 'A ledger append dynamic', arm: 'ledger.append:admit', operand: 'ledger.array.push:lookup', cost: { slots: 1, structuralBytes: 4, work: 1 }, targets: [['t', 'a']], future: true },
  { name: 'A intermediate Target destination', arm: 'target.append:admit', operand: 'bucket.push:lookup', cost: { slots: 1, structuralBytes: 4, work: 1 }, names: ['t'], targets: [['t', 'a']] },
  { name: 'C Map constructor', arm: 'unique:admit', operand: 'Map.create:enter', cost: { nodes: 1, structuralBytes: 16, work: 1 }, names: ['t'] },
  { name: 'C first ID key list', arm: 'keys:admit', operand: 'keys.array.factory:enter', cost: { nodes: 1, structuralBytes: 16, work: 1 }, names: ['t'], future: true },
  { name: 'C first ID key append', arm: 'keys.append:admit', operand: 'keys.array.push:lookup', cost: { slots: 1, structuralBytes: 4, work: 1 }, names: ['t'], targets: [['t', 'a']], future: true },
];
for (const name of ['', 't', '한\0\ud800', 'x'.repeat(255) + '😀']) {
  for (const dynamic of [false, true]) boundaryCases.push({ name: `A ${dynamic ? 'dynamic' : 'initial'} bucket ${JSON.stringify(name)}`, arm: `utf8:${JSON.stringify(name)}:return`, phase: dynamic ? 'dynamic' : 'initial', operand: 'bucket.factory:enter', names: dynamic ? [] : [name], targets: dynamic ? [[name, 'a']] : [], cost: { nodes: 1, slots: 1, structuralBytes: 20 + Buffer.byteLength(name), work: 1 } });
  for (const dynamic of [false, true]) boundaryCases.push({ name: `A ${dynamic ? 'dynamic' : 'initial'} bucket assignment ${JSON.stringify(name)}`, arm: 'bucket.factory:return', operand: 'buckets.write:lookup', names: dynamic ? [] : [name], targets: dynamic ? [[name, 'a']] : [], cost: { work: 1 + Math.ceil(name.length / 256) } });
  boundaryCases.push({ name: `C rows shell/property ${JSON.stringify(name)}`, arm: `utf8:${JSON.stringify(name)}:return`, phase: 'rows', operand: 'rows.factory:enter', names: [name], cost: { nodes: 1, slots: 1, structuralBytes: 20 + Buffer.byteLength(name), work: 1 } });
  boundaryCases.push({ name: `C final records assignment ${JSON.stringify(name)}`, arm: 'records.assign:admit', operand: 'records.write:lookup', names: [name], cost: { work: 1 + Math.ceil(name.length / 256) } });
}
function capacityProbe(boundary: Boundary, counter: keyof Usage, delta: number) {
  const budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('local first operand');
  let armed = 0, reached = 0, count = 0, caught: unknown;
  const track = phaseTracker();
  const targets = (boundary.targets ?? []).map(([table, id]) => ({ table, id, record: {} }));
  try { completionCandidate.run(boundary.names ?? [], targets.length ? [entry(targets)] : [], budget, event => {
    const phase = track(event);
    if (event.name === boundary.arm && (!boundary.phase || phase === boundary.phase) && ++count === (boundary.occurrence ?? 1)) { armed++; leave(budget, counter, boundary.cost[counter]! + delta); }
    if (armed && event.name === boundary.operand) { reached++; throw stop; }
  }); } catch (error) { caught = error; }
  expect(armed, boundary.future ? 'FUTURE_OPERATION_ABSENT: required local admission' : 'existing lexical admission must be reached').toBe(1);
  if (delta < 0) { expect(reached, 'refuse before first local operand').toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
  else { expect(reached, 'exact/+1 must reach first local operand').toBe(1); expect(caught).toBe(stop); }
}
describe('completion A/C independent local admission boundaries', () => {
  for (const boundary of boundaryCases) for (const counter of Object.keys(boundary.cost) as (keyof Usage)[]) for (const delta of [-1, 0, 1]) it(`${boundary.name} ${counter} delta=${delta}`, () => capacityProbe(boundary, counter, delta));
});

describe('completion per-table merge scratch before original receiver index', () => {
  for (const ids of [[], ['a'], ['b', 'a'], ['b', 'a', 'a']]) for (const counter of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) { if (counter === 'slots' && ids.length === 0 && delta < 0) continue; it(`n=${ids.length} ${counter} delta=${delta}`, () => {
    const budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('first sort receiver index');
    const cost = { nodes: 2, slots: 2 * ids.length, structuralBytes: 32 + 8 * ids.length };
    let armed = 0, reached = 0, caught: unknown;
    try { completionCandidate.run(['t'], [entry(ids.map(id => ({ table: 't', id, record: {} })))], budget, event => {
      if (!armed && (event.name === 'bucket.sort:lookup' || event.name === 'targetSort:enter')) { armed++; leave(budget, counter, cost[counter] + delta); }
      if (armed && (['bucket.index:lookup', 'sort.array.factory:enter'].includes(event.name) || (ids.length === 0 && event.name === 'bucket.sort:enter'))) { reached++; throw stop; }
    }); } catch (error) { caught = error; }
    expect(armed).toBe(1);
    if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
    else { expect(reached).toBe(1); expect(caught).toBe(stop); }
  }); }
});

const futureNativeSeams = ['Set.forEach:lookup', 'Map.has:lookup', 'Map.get:lookup', 'names.array.push:lookup', 'ledger.array.push:lookup', 'keys.array.push:lookup', 'Set.forEach:return', 'names.array.factory:return', 'names.array.push:return', 'ledger.array.factory:return', 'ledger.array.push:return', 'ledger.array.index:return', 'keys.array.factory:return', 'keys.array.push:return', 'keys.array.index:return', 'Map.has:return', 'Map.get:return'];
describe('completion future-only native exits frozen before implementation', () => {
  // These operations intentionally do not exist in the preserved no-budget
  // branch. Its real iterator/native matrix remains in the original 1007.
  for (const seam of futureNativeSeams) for (const state of states.filter(s => s !== 'no-budget')) for (const exit of exits) it(`${seam} ${state} ${exit}`, () => {
    const result = nativeProbe(completionCandidate, seam, state, exit);
    expect(result.reached, 'FUTURE_OPERATION_ABSENT: desired real operation must be reached after implementation').toBe(1);
    if (state === 'timely') { if (exit === 'success') expect(result.caught).toBeUndefined(); else expect(result.caught).toBe(result.injected); }
    else {
      if (exit === 'exceeded' || exit === 'unavailable') expect(result.caught).toBe(result.injected); else expect(result.caught).toBeInstanceOf(work.BudgetUnavailableError);
      expect(result.trace, 'earliest successor method lookup and local factory/comparator returns').toEqual([]);
    }
  });
});

type UtfPhase = 'initial' | 'dynamic' | 'ledger' | 'rows';
function phaseTracker() {
  let phase: UtfPhase = 'initial';
  return (event: Event) => {
    if (event.name === 'sourceRecords.factory:enter') phase = 'dynamic';
    if (event.name === 'records.create:return') phase = 'ledger';
    if (event.name === 'Object.entries:lookup') phase = 'rows';
    return phase;
  };
}
const phaseNames = ['a', 'x'.repeat(255) + '😀'], dynamicName = '한\0\ud800';
describe('completion independently labeled UTF8 phases', () => {
  for (const phase of ['initial', 'dynamic', 'ledger', 'rows'] as const) for (const name of phase === 'dynamic' ? [dynamicName] : phase === 'initial' ? phaseNames : [...phaseNames, dynamicName]) for (const state of ['timely', 'expired', 'aborted'] as const) for (const exit of exits) it(`${phase} ${JSON.stringify(name)} ${state} ${exit}`, () => {
    const track = phaseTracker(), signal = { aborted: false }, trace: string[] = [];
    let late = false, reached = 0, caught: unknown;
    const base = work.createBudgetContext({ now: () => late && state === 'expired' ? 5000 : 0, signal });
    const budget = new Proxy({ ...base }, { get(t, key: keyof work.BudgetContext) { if (late && ['spend', 'reserve', 'reserveString'].includes(key)) trace.push(`budget.${key}:lookup`); return t[key]; } });
    const injected = exit === 'ordinary' ? new RangeError('phase UTF8') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
    try { completionCandidate.run(phaseNames, [entry([{ table: dynamicName, id: 'a', record: {} }])], budget, event => {
      const current = track(event);
      if (late && event.name.endsWith(':lookup')) trace.push(event.name);
      if (!reached && current === phase && event.name === `utf8:${JSON.stringify(name)}:return`) {
        reached++; late = true; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw injected;
      }
    }); } catch (error) { caught = error; }
    expect(reached, phase === 'ledger' ? 'FUTURE_OPERATION_ABSENT: per-key ledger UTF8' : 'existing phase UTF8 must be reached').toBe(1);
    if (state === 'timely') { if (exit === 'success') expect(caught).toBeUndefined(); else expect(caught).toBe(injected); }
    else { expect(trace).toEqual([]); if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(injected); else expect(caught).toBeInstanceOf(work.BudgetUnavailableError); }
  });
});

describe('completion B each key string occurrence independent limits', () => {
  for (const name of ['z', '한\0\ud800', 'x'.repeat(255) + '😀']) for (const counter of ['nodes', 'structuralBytes', 'contentBytes', 'stringBytes'] as const) for (const delta of [-1, 0, 1]) it(`${JSON.stringify(name)} ${counter} delta=${delta}`, () => {
    const bytes = Buffer.byteLength(name), track = phaseTracker();
    const base = work.createBudgetContext({ now: () => 0, limits: counter === 'stringBytes' ? { stringBytes: bytes + delta } : undefined });
    const cost = { nodes: 1, structuralBytes: 4, contentBytes: bytes };
    let armed = 0, reached = 0, ownKeys = 0, caught: unknown, reservationError: unknown;
    const requested: number[] = [], stop = new RangeError('per-key string admitted');
    const budget = { ...base, reserveString(value: number) {
      if (armed) requested.push(value);
      try { base.reserveString(value); } catch (error) { if (armed) reservationError = error; throw error; }
      if (armed) { reached++; throw stop; }
    } };
    try { completionCandidate.run(['', name], [], budget, event => {
      if (event.name === 'buckets.ownKeys:enter') ownKeys++;
      if (track(event) === 'ledger' && event.name === `utf8:${JSON.stringify(name)}:return`) {
        armed++; if (counter !== 'stringBytes') leave(base, counter, cost[counter] + delta);
      }
    }); } catch (error) { caught = error; }
    expect(armed, 'FUTURE_OPERATION_ABSENT: independently scanned ledger key').toBe(1);
    expect(requested).toEqual([bytes]); expect(ownKeys).toBe(0);
    if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); expect(caught).toBe(reservationError); }
    else { expect(reached).toBe(1); expect(caught).toBe(stop); }
  });
});

describe('completion B tuple scratch independent of key payload and scan', () => {
  for (const names of [[], ['t'], ['a', 'z']]) for (const counter of ['nodes', 'slots', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) {
    const K = names.length, cost = { nodes: 2 + K, slots: 4 * K, structuralBytes: 32 + 32 * K, work: 2 + 2 * K };
    if (cost[counter] + delta < 0) continue;
    it(`K=${K} ${counter} delta=${delta} final ledger length to ownKeys`, () => {
      const budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('tuple ownKeys');
      let visits = 0, armed = 0, reached = 0, caught: unknown;
      try { completionCandidate.run(names, [], budget, event => {
        if (event.name === 'ledger.array.length:return' && ++visits === K + 1) { armed++; leave(budget, counter, cost[counter] + delta); }
        if (armed && event.name === 'buckets.ownKeys:enter') { reached++; throw stop; }
      }); } catch (error) { caught = error; }
      expect(armed, 'FUTURE_OPERATION_ABSENT: real ledger final length').toBe(1);
      if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
      else { expect(reached).toBe(1); expect(caught).toBe(stop); }
    });
  }
});
describe('completion C independent operand hashing and record getter work', () => {
  for (const id of ['', 'a', 'x'.repeat(257) + '\0😀']) {
    const H = 1 + Math.ceil(id.length / 256), compare = 1 + Math.ceil(2 * id.length / 256);
    const cases = [
      { name: 'outer Entry errors getter', arm: 'mappings.factory:return', operand: 'entry.errors:lookup', cost: 4 },
      { name: 'Entry errors length getter', arm: 'entry.errors:return', operand: 'errors.length:lookup', cost: 1 },
      { name: 'Entry targets getter', arm: 'errors.length:return', operand: 'entry.targets:lookup', cost: 1 },
      { name: 'outer Target table getter', arm: 'entry.targets:return', operand: 'target.table:lookup', cost: 4 },
      { name: 'tuple name checked read', arm: 'Object.entries:return', operand: 'tuple.name:lookup', cost: 4 },
      { name: 'tuple targets checked read', arm: 'tuple.name:return', operand: 'tuple.targets:lookup', cost: 1 },
      { name: 'Map target ID read', arm: 'Map.create:return', operand: 'target.id:lookup', cost: 5 },
      { name: 'already-present bucket lookup', arm: 'target.table:return', operand: 'buckets.get:lookup', cost: H, table: id },
      { name: 'comparator left getter', arm: 'comparator:enter', operand: 'comparator.left:lookup', cost: 1 },
      { name: 'comparator right getter', arm: 'comparator.left:return', operand: 'comparator.right:lookup', cost: 1 },
      { name: 'comparator primitive Hcompare', arm: 'comparator.right:return', operand: 'compare.primitive.factory:enter', cost: compare },
      { name: 'Map.has H', arm: 'target.id:return', operand: 'Map.has:lookup', cost: H, future: true },
      { name: 'Map.set H after has', arm: 'Map.has:return', operand: 'Map.set:lookup', cost: H, future: true },
      { name: 'duplicate occurrence has/set work', arm: 'Map.set:return', operand: 'Map.set:lookup', cost: 4 + 2 * H + 1 },
      { name: 'Map.get H', arm: 'keys.array.index:return', operand: 'Map.get:lookup', cost: H, future: true },
      { name: 'record getter independent of emitter', arm: 'record.factory:enter', operand: 'target.record:lookup', cost: 1 },
    ];
    for (const c of cases) for (const delta of [-1, 0, 1]) it(`${c.name} ${JSON.stringify(id)} delta=${delta}`, () => {
      const actual = nativeProbe(completionCandidate, '__capacity_only__', 'timely', 'success', true, { ...c, remaining: c.cost + delta, ids: [id, id] });
      expect(actual.capacityArmed, c.future ? 'FUTURE_OPERATION_ABSENT: native local capacity predecessor' : 'existing operand predecessor reached').toBe(1);
      if (c.future) {
        const admitted = nativeProbe(completionCandidate, c.operand, 'timely', 'ordinary');
        expect(admitted.reached, 'FUTURE_OPERATION_ABSENT: actual native operand').toBe(1);
      }
      if (delta < 0) { expect(actual.capacityReached).toBe(0); expect(actual.caught).toBeInstanceOf(work.BudgetExceededError); }
      else { expect(actual.capacityReached).toBe(1); expect(actual.caught).toBe(actual.capacityStop); }
    });
  }
});

function copyBackProbe(ids: string[], delta?: number, occurrence = 1, state: State = 'timely', exit: Exit = 'success') {
  let sortFinished = false, mapStarted = false, before: Target[] | undefined, after: Target[] | undefined, writes = 0, operandReached = 0, armed = 0, late = false, caught: unknown;
  const signal = { aborted: false }, trace: string[] = [], targets = ids.map((id, tag) => ({ table: 't', id, record: { tag } }));
  const base = work.createBudgetContext({ now: () => late && state === 'expired' ? 5000 : 0, signal });
  const budget = new Proxy({ ...base }, { get(t, key: keyof work.BudgetContext) { if (late && ['spend', 'reserve', 'reserveString'].includes(key)) trace.push(`budget.${key}:lookup`); return t[key]; } });
  const stop = new RangeError('copy-back assignment operand'), injected = exit === 'ordinary' ? new RangeError('copy-back completion') : exit === 'exceeded' ? new work.BudgetExceededError() : new work.BudgetUnavailableError();
  let result: Result | undefined;
  try { result = completionCandidate.run(['t'], [entry(targets)], budget, event => {
    if ((event.name === 'targetSort:enter' || event.name === 'bucket.sort:lookup') && !before) before = event.value as Target[];
    if (event.name === 'bucket.sort:return') { sortFinished = true; if (delta !== undefined && occurrence === 1) { armed++; leave(base, 'work', 4 + delta); } }
    if (armed && event.name === 'bucket.write:lookup' && delta !== undefined) { operandReached++; throw stop; }
    if (sortFinished && delta !== undefined && event.name === 'bucket.write:return' && ++writes === occurrence - 1) { armed++; leave(base, 'work', 4 + delta); }
    if (late && event.name.endsWith(':lookup')) trace.push(event.name);
    if (sortFinished && event.name === 'bucket.write:return' && delta === undefined && ++writes === occurrence && (state !== 'timely' || exit !== 'success')) {
      late = true; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw injected;
    }
    if (event.name === 'Map.create:enter') mapStarted = true;
    if (mapStarted && ['bucket.index:lookup', 'bucket.length:lookup'].includes(event.name)) after = event.value as Target[];
  }); } catch (error) { caught = error; }
  return { before, after, writes, operandReached, armed, caught, stop, injected, trace, result, targets };
}
describe('completion C copy-back exact original receiver and assignment', () => {
  for (const ids of [['a'], ['b', 'a'], ['b', 'a', 'a']]) {
    it(`n=${ids.length} real copy-back receiver identity before/after`, () => {
      const r = copyBackProbe(ids);
      expect(r.writes, 'FUTURE_OPERATION_ABSENT: checked copy-back assignments after sort return').toBe(ids.length);
      expect(r.result).toBeDefined(); expect(r.result!.targetsByCollection.t).toBe(r.before); expect(r.after).toBe(r.before);
      expect(r.before).toEqual(r.targets.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
    for (const occurrence of ids.map((_, i) => i + 1)) for (const delta of [-1, 0, 1]) it(`n=${ids.length} assignment=${occurrence} work delta=${delta}`, () => {
      expect(copyBackProbe(ids).writes, 'FUTURE_OPERATION_ABSENT: copy-back calibration').toBe(ids.length);
      const r = copyBackProbe(ids, delta, occurrence); expect(r.armed).toBe(1);
      if (delta < 0) { expect(r.operandReached).toBe(0); expect(r.caught).toBeInstanceOf(work.BudgetExceededError); }
      else { expect(r.operandReached).toBe(1); expect(r.caught).toBe(r.stop); }
    });
    for (const occurrence of Array.from({ length: ids.length }, (_, i) => i + 1)) for (const state of ['timely', 'expired', 'aborted'] as const) for (const exit of exits) it(`n=${ids.length} assignment=${occurrence} ${state} ${exit}`, () => {
      const r = copyBackProbe(ids, undefined, occurrence, state, exit);
      expect(r.writes >= occurrence, 'FUTURE_OPERATION_ABSENT: actual indexed copy-back').toBe(true);
      if (state === 'timely') { if (exit === 'success') expect(r.caught).toBeUndefined(); else expect(r.caught).toBe(r.injected); }
      else { expect(r.trace).toEqual([]); if (exit === 'exceeded' || exit === 'unavailable') expect(r.caught).toBe(r.injected); else expect(r.caught).toBeInstanceOf(work.BudgetUnavailableError); }
    });
  }
});

describe('completion F independent existing category ownership and preservation', () => {
  for (const lane of ['sourceRecord', 'mapping', 'target', 'conflict', 'errorCode', 'quarantine'] as const) it(`${lane} exact existing counter with mixed stageable/quarantine contributors`, () => {
    const budget = work.createBudgetContext({ now: () => 0 }), real = createNormalizationOutput(budget);
    const prefill = lane === 'sourceRecord' ? 3998 : lane === 'target' ? 3999 : lane === 'mapping' ? 7998 : 7997;
    for (let i = 0; i < prefill; i++) {
      if (lane === 'quarantine') real.errorCode([], () => null);
      else if (lane === 'sourceRecord') real.sourceRecord([], false, () => null);
      else real[lane]([], () => null);
    }
    const calls = { target: 0, mapping: 0, sourceRecord: 0, errorCode: 0, conflict: 0 }, quarantined: boolean[] = [];
    const owner = { ...real };
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) Object.defineProperty(owner, key, { value: (...args: unknown[]) => {
      calls[key]++; if (key === 'sourceRecord') quarantined.push(args[1] as boolean);
      return Reflect.apply(real[key], real, args);
    } });
    const stageable = entry([{ table: 't', id: 'a', record: { tag: 'first' } }, { table: 't', id: 'a', record: { tag: 'last' } }]);
    const rejected = entry([{ table: 't', id: 'rejected', record: {} }], ['INVALID_ID', 'INVALID_ID', 'MISSING_REQUIRED_HEADER']);
    const result = completionCandidate.run(['t'], [stageable, rejected], budget, undefined, owner);
    expect(calls).toEqual({ target: 1, mapping: 2, sourceRecord: 2, errorCode: 2, conflict: 0 });
    expect(quarantined).toEqual([false, true]); expect(result.records.t).toEqual([stageable.targets[1].record]);
    expect(result.mappings).toHaveLength(2); expect(result.sourceRecords).toHaveLength(2); expect(result.conflicts).toHaveLength(2);
    if (lane === 'sourceRecord') expect(() => real.sourceRecord([], false, () => null)).toThrow(work.BudgetExceededError);
    else if (lane === 'quarantine') expect(() => real.conflict([], () => null)).toThrow(work.BudgetExceededError);
    else expect(() => real[lane]([], () => null)).toThrow(work.BudgetExceededError);
  });
});
describe('completion A collection merge allocations at actual first factory', () => {
  for (const names of [[], ['t'], ['z', 'a']]) for (const counter of ['nodes', 'slots', 'structuralBytes'] as const) for (const delta of [-1, 0, 1]) {
    const cost = { nodes: 2, slots: 2 * names.length, structuralBytes: 32 + 8 * names.length };
    if (cost[counter] + delta < 0) continue;
    it(`C=${names.length} ${counter} delta=${delta}`, () => {
      const budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('collection sort factory');
      let armed = 0, reached = 0, caught: unknown;
      try { completionCandidate.run(names, [], budget, event => {
        if (!armed && ['collection.sort:lookup', 'collectionSort:enter'].includes(event.name)) { armed++; leave(budget, counter, cost[counter] + delta); }
        if (armed && ['collection.sort:enter', 'sort.array.factory:enter'].includes(event.name)) { reached++; throw stop; }
      }); } catch (error) { caught = error; }
      expect(armed).toBe(1);
      if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
      else { expect(reached).toBe(1); expect(caught).toBe(stop); }
    });
  }
});

describe('completion B phase-specific scan work before final native block read', () => {
  for (const phase of ['initial', 'dynamic', 'ledger', 'rows'] as const) for (const name of ['a', '한\0\ud800', 'x'.repeat(255) + '😀', 'x'.repeat(256) + '\ud800']) for (const delta of [-1, 0, 1]) it(`${phase} ${JSON.stringify(name)} work delta=${delta}`, () => {
    const track = phaseTracker(), budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('UTF8 final block read');
    const cost = Math.ceil(name.length / 256), index = 256 * (cost - 1);
    let armed = 0, reached = 0, caught: unknown;
    try { completionCandidate.run(phase === 'dynamic' ? [] : [name], phase === 'dynamic' ? [entry([{ table: name, id: 'a', record: {} }])] : [], budget, event => {
      if (!armed && track(event) === phase && event.name === `utf8:${JSON.stringify(name)}:enter`) { armed++; leave(budget, 'work', cost + delta); }
      if (armed && event.name === 'utf8.char:lookup' && event.value === index) { reached++; throw stop; }
    }); } catch (error) { caught = error; }
    expect(armed, phase === 'ledger' ? 'FUTURE_OPERATION_ABSENT: ledger scan' : 'actual phase scan entered').toBe(1);
    if (delta < 0) { expect(reached).toBe(0); expect(caught).toBeInstanceOf(work.BudgetExceededError); }
    else { expect(reached).toBe(1); expect(caught).toBe(stop); }
  });
});

describe('completion A/B closed bucket and ledger synchronization', () => {
  for (const names of [[], ['z'], ['z', '10', '__proto__']]) it(`${JSON.stringify(names)} initial/dynamic/already-present membership`, () => {
    const targetTables = ['2', 't', 't', 'z'], targets = targetTables.map((table, i) => ({ table, id: String(i), record: {} }));
    const expectedLedger = [...new Set([...names.slice().sort(), ...targetTables])];
    let ledger: string[] | undefined, rawBuckets: Record<string, Target[]> | undefined, ownKeysReached = 0;
    const writes: string[] = [], factoryReturns: unknown[] = [];
    const result = completionCandidate.run(names, [entry(targets)], work.createBudgetContext({ now: () => 0 }), event => {
      if (event.name === 'ledger.array.factory:return') ledger = event.value as string[];
      if (event.name === 'buckets.create:return') rawBuckets = event.value as Record<string, Target[]>;
      if (event.name === 'buckets.write:return') writes.push(String(event.value));
      if (event.name === 'bucket.factory:return') factoryReturns.push(event.value);
      if (event.name === 'Object.entries:lookup') {
        ownKeysReached++; expect(rawBuckets).toBeDefined();
        expect(Object.keys(rawBuckets!)).toEqual(Object.keys(Object.fromEntries(expectedLedger.map(k => [k, true]))));
      }
    });
    expect(ownKeysReached).toBe(1);
    expect(writes).toEqual(expectedLedger); expect(factoryReturns).toHaveLength(expectedLedger.length);
    expect(ledger, 'FUTURE_OPERATION_ABSENT: real private name ledger').toBeDefined();
    expect(ledger).toEqual(expectedLedger); expect(new Set(ledger).size).toBe(expectedLedger.length);
    expect(Object.keys(result.records)).toEqual(Object.keys(rawBuckets!));
    expect(result.targetsByCollection.t).toHaveLength(2);
  });
  for (const counter of ['nodes', 'slots', 'structuralBytes', 'contentBytes'] as const) it(`already-present lookup adds no bucket/key charge ${counter}`, () => {
    const budget = work.createBudgetContext({ now: () => 0 }), stop = new RangeError('existing bucket reached append boundary');
    let armed = 0, reached = 0, caught: unknown, before = zero();
    const target: Target = { table: 't', id: 'a', record: {} }, e = entry([target]);
    Object.defineProperty(target, 'table', { get() { if (!armed) { armed++; before = { ...budget.usage() }; leave(budget, counter, 0); } return 't'; } });
    try { completionCandidate.run(['t'], [e], budget, event => { if (armed && event.name === 'target.append:admit') { reached++; throw stop; } }); } catch (error) { caught = error; }
    expect(armed).toBe(1); expect(reached).toBe(1); expect(caught).toBe(stop);
    expect(budget.usage()[counter]).toBe(budget.limits[counter]); expect(before[counter]).toBeGreaterThanOrEqual(0);
  });
});

const completionExistingNative = ['sourceRecords.factory:return', 'mappings.factory:return', 'bucket.factory:return', 'rows.factory:return', 'compare.primitive.factory:return', 'bucket.push:lookup', 'Map.set:lookup', 'Object.entries:lookup', 'records.write:lookup', 'collection.sort:return'];
describe('completion native method/factory exits and actual original omission branch', () => {
  for (const seam of completionExistingNative) for (const state of states) for (const exit of exits) {
    if (state === 'no-budget' && seam === 'rows.factory:return') continue;
    it(`${seam} ${state} ${exit}`, () => {
      const r = nativeProbe(completionCandidate, seam, state, exit);
      expect(r.reached, 'actual native factory/getter reached').toBe(1);
      if (state === 'no-budget') {
        const expected = (golden as unknown as { completionNative: { seam: string; exit: Exit; outcome: { trace: string[]; json: string | null; sameInjected: boolean; errorName: string | null; errorMessage: string | null } }[] }).completionNative.find(f => f.seam === seam && f.exit === exit)!.outcome;
        expect({ trace: r.trace, json: r.json ?? null, sameInjected: r.caught === r.injected, errorName: (r.caught as Error)?.name ?? null, errorMessage: (r.caught as Error)?.message ?? null }).toEqual(expected);
      } else if (state === 'timely') { if (exit === 'success') expect(r.caught).toBeUndefined(); else expect(r.caught).toBe(r.injected); }
      else { if (exit === 'exceeded' || exit === 'unavailable') expect(r.caught).toBe(r.injected); else expect(r.caught).toBeInstanceOf(work.BudgetUnavailableError); expect(r.trace).toEqual([]); }
    });
  }
  for (const fixture of golden.synthetic) for (const bounded of [false, true]) it(`${fixture.name} extra lexical observer noninterference budget=${bounded}`, () => {
    const { entries } = materialize(fixture);
    const r = completionCandidate.run(fixture.names, entries, bounded ? work.createBudgetContext({ now: () => 0 }) : undefined, () => {});
    expect(JSON.stringify(r)).toBe(fixture.json);
  });
});

describe('completion F lazy records assignment and no post-late destination', () => {
  for (const occurrence of [1, 2, 3]) for (const delta of [-1, 0, 1]) it(`property=${occurrence} local assignment H delta=${delta}`, () => {
    capacityProbe({ name: 'final property', arm: 'records.assign:admit', operand: 'records.write:lookup', names: ['a', 'z', '한글'], occurrence, cost: { work: 2 } }, 'work', delta);
  });
  for (const phase of ['initial', 'dynamic'] as const) for (const counter of ['nodes', 'slots', 'structuralBytes'] as const) it(`${phase} refused bucket never installs property or appends ledger/Target ${counter}`, () => {
    const budget = work.createBudgetContext({ now: () => 0 }), names = phase === 'initial' ? ['t'] : [];
    const costs = { nodes: 1, slots: 1, structuralBytes: 21 };
    let armed = 0, writes = 0, appends = 0, factories = 0, caught: unknown;
    try { completionCandidate.run(names, phase === 'dynamic' ? [entry([{ table: 't', id: 'a', record: {} }])] : [], budget, event => {
      if (event.name === 'bucket:admit') { armed++; leave(budget, counter, costs[counter] - 1); }
      if (armed && event.name === 'buckets.write:lookup') writes++;
      if (armed && ['bucket.push:lookup', 'ledger.array.push:lookup'].includes(event.name)) appends++;
      if (armed && event.name === 'bucket.factory:enter') factories++;
    }); } catch (error) { caught = error; }
    expect(armed).toBe(1); expect(caught).toBeInstanceOf(work.BudgetExceededError); expect(factories).toBe(0); expect(writes).toBe(0); expect(appends).toBe(0);
  });
});
const nativeVariants = [
  { name: 'collection comparator primitive', seam: 'compare.primitive.factory:return', names: ['b', 'a'], ids: [], occurrence: 1, future: false },
  ...['buckets.get:return', 'bucket.factory:return', 'buckets.write:return', 'bucket.push:return', 'target.table:return'].map(seam => ({ name: 'dynamic missing table', seam, names: [] as string[], ids: ['b', 'a'], occurrence: 1, future: false })),
  { name: 'duplicate ID set', seam: 'Map.set:return', names: ['t'], ids: ['a', 'a'], occurrence: 2, future: false },
  { name: 'duplicate ID has', seam: 'Map.has:return', names: ['t'], ids: ['a', 'a'], occurrence: 2, future: true },
  ...[2, 3].map(occurrence => ({ name: `ledger key ${occurrence}`, seam: 'ledger.array.index:return', names: ['a', 'z'], ids: ['b', 'a'], occurrence, future: true })),
  { name: 'second first-key get', seam: 'Map.get:return', names: ['t'], ids: ['b', 'a'], occurrence: 2, future: true },
];
describe('completion branch and later-key native matrix', () => {
  for (const variant of nativeVariants) for (const state of states) for (const exit of exits) {
    if (variant.future && state === 'no-budget') continue;
    it(`${variant.name} ${variant.seam} ${state} ${exit}`, () => {
      const r = nativeProbe(completionCandidate, variant.seam, state, exit, true, undefined, variant);
      expect(r.reached, variant.future ? 'FUTURE_OPERATION_ABSENT: later key native boundary' : 'actual dynamic/duplicate native operation reached').toBe(1);
      if (state === 'no-budget') {
        const expected = (golden as unknown as { completionVariants: { name: string; seam: string; exit: Exit; outcome: { trace: string[]; json: string | null; sameInjected: boolean; errorName: string | null; errorMessage: string | null } }[] }).completionVariants.find(f => f.name === variant.name && f.seam === variant.seam && f.exit === exit)!.outcome;
        expect({ trace: r.trace, json: r.json ?? null, sameInjected: r.caught === r.injected, errorName: (r.caught as Error)?.name ?? null, errorMessage: (r.caught as Error)?.message ?? null }).toEqual(expected);
      } else if (state === 'timely') { if (exit === 'success') expect(r.caught).toBeUndefined(); else expect(r.caught).toBe(r.injected); }
      else { if (exit === 'exceeded' || exit === 'unavailable') expect(r.caught).toBe(r.injected); else expect(r.caught).toBeInstanceOf(work.BudgetUnavailableError); expect(r.trace).toEqual([]); }
    });
  }
});

describe('completion evidence inventory is not optional at collection', () => {
  it('every natural candidate has original raw and getter noninterference oracle', () => {
    expect(golden.cases).toHaveLength(122); expect(golden.naturalRaw).toHaveLength(122);
    expect(golden.naturalRaw.map(f => f.name)).toEqual(golden.cases.map(f => f.name));
    expect(Object.keys((golden as unknown as { naturalGetters: object }).naturalGetters).sort()).toEqual(golden.cases.map(f => f.name).sort());
    expect(golden.naturalRaw.every(f => f.outcome.initialAppends.length === f.outcome.raw.length)).toBe(true);
    expect(golden.cases.every(f => f.classification.acceptedDuplicateContributors.length === 0)).toBe(true);
  });
  it('supplemental ordinary native fixtures cover every omission-context case', () => {
    expect((golden as unknown as { completionNative: unknown[] }).completionNative).toHaveLength(36);
    expect((golden as unknown as { completionVariants: unknown[] }).completionVariants).toHaveLength(nativeVariants.filter(v => !v.future).length * exits.length);
  });
  it('completed native append failure does not refund owner/category/destination', () => {
    const budget = work.createBudgetContext({ now: () => 0 }), owner = createNormalizationOutput(budget), stop = new RangeError('after completed native row append');
    for (let i = 0; i < 3999; i++) owner.target([], () => null);
    let reached = 0, appendUsage: work.BudgetUsage | undefined;
    expect(() => completionCandidate.run(['t'], [entry([{ table: 't', id: 'a', record: {} }])], budget, event => {
      if (event.name === 'rows.push:return') { reached++; appendUsage = budget.usage(); throw stop; }
    }, owner)).toThrow(stop);
    expect(reached).toBe(1); expect(budget.usage()).toEqual(appendUsage);
    expect(() => owner.target([], () => null)).toThrow(work.BudgetExceededError); expect(budget.usage()).toEqual(appendUsage);
  });
});

describe('completion A collection comparator and native scratch elimination', () => {
  for (const names of [['z', 'a'], ['x'.repeat(257), '한글']]) for (const delta of [-1, 0, 1]) it(`collection Hcompare ${JSON.stringify(names)} delta=${delta}`, () => {
    const cost = 1 + Math.ceil((names[0].length + names[1].length) / 256);
    const r = nativeProbe(completionCandidate, '__capacity_only__', 'timely', 'success', true, { arm: 'compareCodeUnits:admit', operand: 'compare.primitive.factory:enter', remaining: cost + delta }, { names });
    expect(r.capacityArmed).toBe(1);
    if (delta < 0) { expect(r.capacityReached).toBe(0); expect(r.caught).toBeInstanceOf(work.BudgetExceededError); }
    else { expect(r.capacityReached).toBe(1); expect(r.caught).toBe(r.capacityStop); }
  });
  for (const forbidden of ['Set.iterator:lookup', 'Map.values:lookup', 'tuple.iterator:lookup']) it(`budget branch native allocation ${forbidden} is zero`, () => {
    let calls = 0;
    completionCandidate.run(['t'], [entry([{ table: 't', id: 'a', record: {} }])], work.createBudgetContext({ now: () => 0 }), event => { if (event.name === forbidden) calls++; });
    expect(calls, 'budget branch must remove the actual native iterator scratch').toBe(0);
  });
});

describe('supplemental mutation-discovered operand identity and indexed completion', () => {
  it('comparator reads actual left Target before actual right Target', () => {
    const runtime = loader(false, true);
    let sorting = false, comparing = false;
    const reads: string[] = [];
    const targets: Target[] = [{ table: 't', id: 'b', record: {} }, { table: 't', id: 'a', record: {} }];
    for (const target of targets) {
      const id = target.id;
      Object.defineProperty(target, 'id', { get() { if (sorting && comparing) reads.push(id); return id; } });
    }
    runtime.run(['t'], [entry(targets)], work.createBudgetContext({ now: () => 0 }), event => {
      if (event.name === 'targetSort:enter') sorting = true;
      if (event.name === 'comparator:enter') comparing = true;
      if (event.name === 'comparator:return') comparing = false;
    });
    expect(reads).toEqual(['b', 'a']);
  });
});

describe('supplemental mutation-discovered native ownership and insertion operations', () => {
  it('actual same-owner factory is created once rather than rebound for each row', () => {
    const runtime = loader(false, true);
    let owners = 0, emitted = 0;
    const result = runtime.run(['t'], [entry([{ table: 't', id: 'a', record: {} }, { table: 't', id: 'b', record: {} }])], work.createBudgetContext({ now: () => 0 }), event => {
      if (event.name === 'output.owner:create') owners++;
      if (event.name === 'output.target:enter') emitted++;
    });
    expect(result.records.t).toHaveLength(2);
    expect(emitted).toBe(2);
    expect(owners, 'actual production createNormalizationOutput calls, not rebound owner identity').toBe(1);
  });
  it('duplicate Map replacement performs set without native delete', () => {
    const runtime = loader(false, true);
    let deletes = 0, sets = 0;
    const first = { tag: 'first' }, last = { tag: 'last' };
    const result = runtime.run(['t'], [entry([{ table: 't', id: 'a', record: first }, { table: 't', id: 'a', record: last }])], work.createBudgetContext({ now: () => 0 }), event => {
      if (event.name === 'Map.delete:lookup') deletes++;
      if (event.name === 'Map.set:lookup') sets++;
    });
    expect(result.records.t).toEqual([last]);
    expect(result.records.t[0]).toBe(last);
    expect(sets).toBe(2);
    expect(deletes, 'no delete plus set replacement even when final bytes happen to match').toBe(0);
  });
});

describe('SPEC returned indexed earliest successor', () => {
 const cases = [
 ['completion-005','review.names.length:return',''], ['completion-007','review.names.index:return',''],
 ['completion-013','review.input.length:return',''], ['completion-015','review.input.index:return',''],
 ['completion-023','review.targets.length:return',''], ['completion-025','review.targets.index:return',''],
 ['completion-034','entries.length:lookup','Object.entries:return'], ['completion-036','entries.index:lookup','Object.entries:return'],
 ['completion-054','ledger.array.length:return','records.create:return'],
 ['completion-070','review.sorted.length:return','bucket.sort:return'], ['completion-072','review.sorted.index:return','bucket.sort:return'],
 ['completion-076','bucket.length:lookup','keys.factory:return'], ['completion-078','bucket.index:lookup','keys.factory:return'],
 ['completion-089','keys.array.length:return','rows.factory:return'],
 ];
 const runtime = loader(false, true);
 for (const [label,seam,arm] of cases) for (const state of ['timely','expired','aborted'] as const) for (const exit of ['success','ordinary','exceeded','unavailable'] as const) {
  it(`${label} ${state} ${exit}`, () => {
   let reached=0, ready=!arm, late=false; const trace:string[]=[];
   const signal={aborted:false}; const original=work.createBudgetContext({now:()=>late && state==='expired'?5000:0,signal});
   const budget=new Proxy({...original},{get(t,k:keyof work.BudgetContext){if(late && ['spend','reserve','reserveString'].includes(k))trace.push(String(k)); return t[k];}});
   const injected=exit==='ordinary'?new RangeError('SPEC indexed ordinary'):exit==='exceeded'?new work.BudgetExceededError():new work.BudgetUnavailableError();
   const handle:Hook=event=>{
    if(event.name===arm)ready=true;
    if(!reached && ready && event.name===seam){reached++;late=true;if(state==='aborted')signal.aborted=true;if(exit!=='success')throw injected;}
   };
   const watched=<T,>(values:T[],role:string)=>new Proxy(values,{get(t,k,r){const value=Reflect.get(t,k,r);if(k==='length'||(typeof k==='string'&&/^\d+$/.test(k)))handle({name:`review.${role}.${k==='length'?'length':'index'}:return`});return value;}});
   const item=entry([{table:'t',id:'b',record:{}},{table:'t',id:'a',record:{}}]);
   item.targets=watched(item.targets,'targets');
   let caught:unknown;
   try{runtime.run(['t'],watched([item],'input'),budget,handle);}catch(error){caught=error;}
   expect(reached,'actual scoped operand reached').toBe(1);
   if(state==='timely'){if(exit==='success')expect(caught).toBeUndefined();else expect(caught).toBe(injected);}
   else {if(exit==='exceeded'||exit==='unavailable')expect(caught).toBe(injected);else expect(caught).toBeInstanceOf(work.BudgetUnavailableError);expect(trace,'earliest successor budget METHOD LOOKUP, not eventual invocation').toEqual([]);}
  });
 }
});

describe('SPEC indexed local work admission',()=>{
 const runtime=loader(false,true);
 const cases=[
 ['operand-late-004','collection.sort:return','review.names.length:return',1],
 ['operand-late-006','review.names.length:return','review.names.index:return',2],
 ['operand-late-012','mappings.factory:return','review.input.length:return',1],
 ['operand-late-014','review.input.length:return','review.input.index:return',2],
 ['operand-late-022','review.entryTargets:return','review.targets.length:return',1],
 ['operand-late-024','review.targets.length:return','review.targets.index:return',2],
 ['operand-late-033','Object.entries:return','entries.length:lookup',1],
 ['operand-late-035','entries.length:lookup','entries.index:lookup',2],
 ['operand-late-055','ledger.array.length:return','ledger.array.index:lookup',2],
 ['operand-late-069','bucket.sort:return','review.sorted.length:return',1],
 ['operand-late-071','review.sorted.length:return','review.sorted.index:return',2],
 ['operand-late-075','keys.factory:return','bucket.length:lookup',1],
 ['operand-late-077','bucket.length:lookup','bucket.index:lookup',2],
 ['operand-late-088','rows.factory:return','keys.array.length:return',1],
 ] as const;
 for(const [label,arm,operand,cost] of cases)for(const delta of [-1,0,1])it(`${label} delta=${delta}`,()=>{
  const budget=work.createBudgetContext({now:()=>0});let armed=0,reached=0,map=false;const stop=new RangeError('SPEC local admitted operand');
  const handle:Hook=event=>{
   if(event.name==='keys.factory:return')map=true;
   if(!armed && event.name===arm && (label!=='operand-late-077'||map)){armed++;leave(budget,'work',cost+delta);}
   if(armed && event.name===operand){reached++;throw stop;}
  };
  const watched=<T,>(values:T[],role:string)=>new Proxy(values,{get(t,k,r){const value=Reflect.get(t,k,r);if(k==='length'||(typeof k==='string'&&/^\d+$/.test(k)))handle({name:`review.${role}.${k==='length'?'length':'index'}:return`});return value;}});
  const item=entry([{table:'t',id:'b',record:{}},{table:'t',id:'a',record:{}}]);const targets=watched(item.targets,'targets');
  Object.defineProperty(item,'targets',{get(){handle({name:'review.entryTargets:return'});return targets;}});
  let caught:unknown;try{runtime.run(['t'],watched([item],'input'),budget,handle);}catch(error){caught=error;}
  expect(armed,'actual predecessor').toBe(1);
  if(delta<0){expect(reached,'refuse before indexed operand').toBe(0);expect(caught).toBeInstanceOf(work.BudgetExceededError);}
  else{expect(reached,'exact/+1 actual indexed operand').toBe(1);expect(caught).toBe(stop);}
 });
});

describe('SPEC shared sort local admission',()=>{
 const runtime=loader(false,true);
 for(const mode of ['copy','merge-entry','scratch-write'] as const)for(const delta of [-1,0,1])it(`${mode} delta=${delta}`,()=>{
  const budget=work.createBudgetContext({now:()=>0});let factories=0,writes=0,armed=0,reached=0;const stop=new RangeError('SPEC shared operand');
  const cost=mode==='merge-entry'?4:1;
  const handle:Hook=event=>{
   if(event.name==='sort.array.factory:return')factories++;
   if(event.name==='review.scratch.write:return')writes++;
   const arm=mode==='copy'?event.name==='sort.array.factory:return'&&factories===2:mode==='merge-entry'?event.name==='review.scratch.write:return'&&writes===2:event.name==='comparator:return';
   if(!armed&&arm){armed++;leave(budget,'work',cost+delta);}
   const operand=mode==='merge-entry'?'review.scratch.index:lookup':'review.scratch.write:lookup';
   if(armed&&event.name===operand){reached++;throw stop;}
  };
  let caught:unknown;try{runtime.run(['b','a'],[],budget,handle);}catch(error){caught=error;}
  expect(armed,'actual shared native predecessor').toBe(1);
  if(delta<0){expect(reached,'precharge before actual shared array operand').toBe(0);expect(caught).toBeInstanceOf(work.BudgetExceededError);}
  else{expect(reached,'exact/+1 reached').toBe(1);expect(caught).toBe(stop);}
 });
});
