import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as json from './boundedJson';
import { createBudgetContext, BudgetExceededError, BudgetUnavailableError, type BudgetContext } from './boundedWork';

// Stage 1: literal independent O ledger, not candidate-derived usage.
const operator = { nodes: 1, slots: 8, contentBytes: 0, structuralBytes: 80, work: 8 };
function prepare(left: unknown, right: unknown, budget: BudgetContext): void {
  const entry = (json as unknown as { reserveBoundedJsonRelational: (a: unknown, b: unknown, context: BudgetContext) => void }).reserveBoundedJsonRelational;
  entry(left, right, budget);
}

describe('relational stage 1: fast operator frame', () => {
  it('has the callable declaration (declaration gate, not guard RED)', () => {
    expect((json as unknown as Record<string, unknown>).reserveBoundedJsonRelational).toBeTypeOf('function');
  });
  it('reserves exactly O for zero and missing undefined without scratch', () => {
    const budget = createBudgetContext({ now: () => 0 });
    expect(prepare(0, undefined, budget)).toBeUndefined();
    expect(budget.usage()).toEqual(operator);
  });
  for (const key of ['nodes', 'slots', 'structuralBytes', 'work'] as const) {
    for (const difference of [-1, 0, 1]) {
      it(`O ${key} independent allowance ${difference}`, () => {
        const budget = createBudgetContext({ now: () => 0, limits: { [key]: operator[key] + difference } });
        let returned = false;
        const run = () => { prepare(0, undefined, budget); returned = true; };
        if (difference < 0) { expect(run).toThrow(BudgetExceededError); expect(returned).toBe(false); }
        else { run(); expect(returned).toBe(true); expect(budget.usage()).toEqual(operator); }
      });
    }
  }
  it('records routing/left/right/final as four separate two-work debits', () => {
    const base = createBudgetContext({ now: () => 0 });
    const debits: number[] = [];
    const budget: BudgetContext = { ...base, spend(amount = 1) { debits.push(amount); base.spend(amount); } };
    prepare(0, undefined, budget);
    expect(debits).toEqual([2, 2, 2, 2]);
  });
});

describe('relational stage 1: owned boundary', () => {
  it('entry check runs before reservation operand', () => {
    const base = createBudgetContext({ now: () => 0 });
    const sentinel = new BudgetUnavailableError();
    let reservations = 0;
    const budget = { ...base, check() { throw sentinel; }, reserve(cost: Parameters<BudgetContext['reserve']>[0]) { reservations++; base.reserve(cost); } };
    expect(() => prepare(0, undefined, budget)).toThrow(sentinel);
    expect(reservations).toBe(0);
  });
  for (const mode of ['expired', 'aborted'] as const) {
    for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
      it(`final dispatch ${mode}/${outcome} forbids local late return; budget identity dominates`, () => {
        let clock = 0, count = 0, returned = false, reached = false;
        const signal = { aborted: false };
        const base = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('ordinary dispatch');
        const budget: BudgetContext = { ...base, spend(amount = 1) {
          base.spend(amount);
          if (++count === 4) {
            reached = true;
            if (mode === 'expired') clock = 5000; else signal.aborted = true;
            if (outcome !== 'success') throw sentinel;
          }
        } };
        let caught: unknown;
        try { prepare(0, undefined, budget); returned = true; } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(returned).toBe(false);
        if (outcome === 'exceeded' || outcome === 'unavailable') expect(caught).toBe(sentinel);
        else expect(caught).toBeInstanceOf(BudgetUnavailableError);
      });
    }
  }
  it('timely ordinary dispatch error retains identity (control)', () => {
    const base = createBudgetContext({ now: () => 0 });
    const sentinel = new RangeError('ordinary timely');
    const budget = { ...base, spend() { throw sentinel; } };
    expect(() => prepare(0, undefined, budget)).toThrow(sentinel);
  });
});

describe('relational stage 1: scalar domain and root depth', () => {
  for (const value of [0, -0, -3, 0.125, Number.MIN_VALUE, Number.MAX_VALUE, true, false, null, undefined]) {
    it(`fast native scalar control ${String(value)}`, () => {
      const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: 0 } });
      prepare(value, undefined, budget); expect(budget.usage()).toEqual(operator);
    });
  }
  for (const value of [NaN, Infinity, -Infinity, Symbol('unsupported'), BigInt(1), () => 0]) {
    for (const side of ['left', 'right']) it(`rejects ${typeof value}/${String(value)} on ${side} without native conversion`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      expect(() => prepare(side === 'left' ? value : 0, side === 'right' ? value : 0, budget)).toThrow('Legacy bounded JSON is invalid.');
    });
  }
  it('checks both scalar roots at depth one', () => {
    const base = createBudgetContext({ now: () => 0 });
    const depths: number[] = [];
    const budget = { ...base, checkDepth(depth: number) { depths.push(depth); base.checkDepth(depth); } };
    prepare(0, undefined, budget); expect(depths).toEqual([1, 1]);
  });
  it('root depth zero ceiling refuses before local return', () => {
    const budget = createBudgetContext({ now: () => 0, limits: { depth: 0 } });
    expect(() => prepare(0, undefined, budget)).toThrow(BudgetExceededError);
  });
});

type Vector = [number, number, number, number, number];
type Bound = { u: number; b: number; text: boolean };
type Event = { label: string; vector: Vector };

// Independent specimen model: iterative postorder stack, native Buffer UTF8
// measurement, literal recipes. No candidate private helpers/constants/usage.
function ledger(left: unknown, right: unknown) {
  const events: Event[] = [];
  const emit = (label: string, vector: Vector) => events.push({ label, vector });
  const q = (u: number) => Math.ceil(u / 256);
  const flatten = (u: number) => emit('F', [1, 0, 0, 16 + 2 * u, 0]);
  const materialize = (u: number, b: number) => {
    emit('string occurrence', [1, 0, b, 4, 0]); flatten(u);
    emit('M dispatch/copy/flatten', [0, 0, 0, 0, 2 + 2 * q(u)]);
  };
  emit('O allocation', [1, 8, 0, 80, 0]);
  emit('routing', [0, 0, 0, 0, 2]);
  emit('left classification', [0, 0, 0, 0, 2]);
  emit('right classification', [0, 0, 0, 0, 2]);
  const fast = (v: unknown) => v == null || typeof v === 'boolean' || typeof v === 'number';
  let maxDepth = 1;
  const roots: Bound[] = [];
  if (!(fast(left) && fast(right))) {
    emit('H allocation', [1, 12, 0, 112, 0]); emit('H construction', [0, 0, 0, 0, 1]);
    if ([left, right].some(v => v !== null && typeof v === 'object')) {
      emit('old stack', [64, 256, 0, 8192, 0]);
      emit('supplement', [0, 768, 0, 8192, 0]); emit('G dispatch', [0, 0, 0, 0, 1]);
    }
    for (const root of [left, right]) {
      type Frame = { value: unknown; depth: number; element: boolean; entered: boolean; index: number; u: number; b: number };
      const stack: Frame[] = [{ value: root, depth: 1, element: false, entered: false, index: 0, u: 0, b: 0 }];
      let out: Bound = { u: 0, b: 0, text: false };
      while (stack.length) {
        const frame = stack[stack.length - 1], value = frame.value;
        maxDepth = Math.max(maxDepth, frame.depth);
        if (!frame.entered) {
          frame.entered = true; emit('visit', [0, 0, 0, 0, 1]);
          if (Array.isArray(value)) {
            emit('shape', [0, 0, 0, 0, 1]); emit('method dispatch', [0, 0, 0, 0, 4]); emit('length', [0, 0, 0, 0, 1]);
            frame.u = frame.b = Math.max(0, value.length - 1);
            emit('J allocation', [1, value.length, 0, 16 + 4 * value.length, 0]);
            emit('J work', [0, 0, 0, 0, value.length + q(frame.u)]);
          } else {
            if (typeof value === 'string') {
              emit('string length', [0, 0, 0, 0, 1]); flatten(value.length);
              emit('source flatten', [0, 0, 0, 0, q(value.length)]);
              emit('UTF8 scan', [0, 0, 0, 0, q(value.length)]);
              out = { u: value.length, b: Buffer.byteLength(value, 'utf8'), text: true };
            } else if (value !== null && typeof value === 'object') {
              emit('shape', [0, 0, 0, 0, 1]); emit('method dispatch', [0, 0, 0, 0, 4]);
              materialize(15, 15); out = { u: 15, b: 15, text: true };
            } else if (frame.element && value != null) {
              materialize(32, 32); out = { u: 32, b: 32, text: true };
            } else out = { u: 0, b: 0, text: false };
            stack.pop();
            if (stack.length) { stack[stack.length - 1].u += out.u; stack[stack.length - 1].b += out.b; }
            continue;
          }
        }
        const array = value as unknown[];
        if (frame.index < array.length) {
          emit('index', [0, 0, 0, 0, 1]);
          stack.push({ value: array[frame.index++], depth: frame.depth + 1, element: true, entered: false, index: 0, u: 0, b: 0 });
        } else {
          materialize(frame.u, frame.b); out = { u: frame.u, b: frame.b, text: true }; stack.pop();
          if (stack.length) { stack[stack.length - 1].u += out.u; stack[stack.length - 1].b += out.b; }
        }
      }
      roots.push(out);
    }
    if (roots.some(v => v.text)) { emit('P0 allocation', [1, 0, 0, 8192, 0]); emit('P0 dispatch', [0, 0, 0, 0, 1]); }
    for (const root of roots) if (root.text) {
      flatten(root.u); emit('R workspace', [1, root.u, 0, 16 + 8 * root.u, 0]);
      emit('R four scans/dispatches', [0, 0, 0, 0, 4 + 4 * q(root.u)]);
    }
  }
  emit('final dispatch', [0, 0, 0, 0, 2]);
  const total: Vector = [0, 0, 0, 0, 0];
  for (const event of events) for (let i = 0; i < 5; i++) total[i] += event.vector[i];
  return { events, roots, maxDepth, total };
}

// Byte-exact original declaration seam, not a handwritten comparator and not
// normalizer integration. This declaration has no imported/lexical dependencies.
function originalComparator(): (a: unknown, b: unknown) => number {
  const root = 'test-support/frozen-oracles/448cbed7bd303ad0f9ef3fd4c974c313bf4c8da8/';
  const manifestBytes = readFileSync(root + 'manifest.json');
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  expect(hash(manifestBytes)).toBe('1b20d13ac257dadd41d714012ef8d45f04d133f0c45d0f8e5b6f3025e3729e8e');
  const manifest = JSON.parse(manifestBytes.toString()) as { modules: { path: string; payload: string; sha256: string; bytes: number }[] };
  let source = '';
  for (const item of manifest.modules) {
    const bytes = readFileSync(root + item.payload);
    expect(hash(bytes)).toBe(item.sha256); expect(bytes.length).toBe(item.bytes);
    if (item.path === 'src/server/migration/validators.ts') source = bytes.toString();
  }
  const parsed = ts.createSourceFile('original-validators.ts', source, ts.ScriptTarget.ES2022, true);
  const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'compareCodeUnits');
  if (!declaration) throw new Error('Pinned original comparator declaration missing');
  const text = source.slice(declaration.getStart(parsed), declaration.end);
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { compareCodeUnits?: (a: unknown, b: unknown) => number } = {};
  new Function('exports', compiled)(exports);
  if (!exports.compareCodeUnits) throw new Error('Pinned original comparator was not exported');
  return exports.compareCodeUnits;
}

describe('preimplementation independent controls', () => {
  const examples: [unknown, unknown, Vector][] = [
    [0, undefined, [1, 8, 0, 80, 8]], ['', '', [9, 20, 0, 8480, 22]],
    [[], [], [77, 1044, 0, 24904, 37]], [[[], [], [], []], '', [87, 1051, 3, 25080, 81]],
    [[[['A']]], '', [82, 1048, 3, 25002, 68]],
    [['한', '😀', '\ud800', 1, true, null], '', [82, 1123, 143, 26008, 72]],
  ];
  it.each(examples)('independent iterative ledger specimen %#', (left, right, expected) => {
    expect(ledger(left, right).total).toEqual(expected);
  });
  it('fresh second operator doubles independent empty-array recipe', () => {
    expect(ledger([], []).total.map(n => n * 2)).toEqual([154, 2088, 0, 49808, 74]);
  });
  it('freezes actual original raw comparator outcomes, not string-both or number-both', () => {
    const compare = originalComparator();
    expect(compare('100', '3')).toBe(-1);
    expect(compare('3', 20)).toBe(-1);
    expect(compare(20, '100')).toBe(-1);
    expect(compare(undefined, 0)).toBe(0);
    expect(compare([], '')).toBe(0);
    expect(compare([2], '10')).toBe(1);
    expect(() => compare(Object.create(null), 0)).toThrow(TypeError);
    expect(() => compare({ toString: [] }, 0)).toThrow(TypeError);
  });
  it('same actual module decoder/owner succeeds; foreign context control fails', () => {
    const owner = createBudgetContext({ now: () => 0 });
    const value = json.parseRegisteredBoundedJson('[[]]', owner) as object;
    expect(json.registeredBoundedKeys(value, owner)).toEqual(['0']);
    expect(() => json.registeredBoundedKeys(value, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.');
  });
});

// Private arithmetic probes execute the entire actual module in memory. Only
// exports and observation wrappers are injected; no production file is exported
// or rewritten by this loader, and no shape certificates cross module instances.
type ArithmeticName = 'relationalAdd' | 'relationalMul' | 'relationalBlocks' | 'relationalCommas';
function arithmeticProbe() {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const names: ArithmeticName[] = ['relationalAdd', 'relationalMul', 'relationalBlocks', 'relationalCommas'];
  const edits: { at: number; text: string }[] = [];
  const events: { expression: string; value: number }[] = [];
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !names.includes(declaration.name?.text as ArithmeticName)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.MinusToken].includes(node.operatorToken.kind)) {
        edits.push({ at: node.getStart(parsed), text: `__observe(${JSON.stringify(node.getText(parsed))}, (` });
        edits.push({ at: node.end, text: '))' });
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  let instrumented = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
  instrumented += '\n' + names.map(name => `exports.${name} = typeof ${name} === "function" ? ${name} : undefined;`).join('\n');
  const compiled = ts.transpileModule(instrumented, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Partial<Record<ArithmeticName, (...args: number[]) => number>> = {};
  new Function('exports', 'require', '__observe', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected actual-module dependency ${id}`);
    return { BudgetExceededError, BudgetUnavailableError };
  }, (expression: string, value: number) => { events.push({ expression, value }); return value; });
  return { exports, events };
}

describe('relational private arithmetic increment', () => {
  const probe = arithmeticProbe();
  const call = (name: ArithmeticName, ...args: number[]) => {
    const operation = probe.exports[name];
    if (!operation) throw new Error(`Missing private declaration: ${name}`);
    probe.events.length = 0;
    return operation(...args);
  };
  for (const name of ['relationalAdd', 'relationalMul', 'relationalBlocks', 'relationalCommas'] as const) {
    it(`${name} private declaration gate (not protection RED)`, () => {
      expect(probe.exports[name]).toBeTypeOf('function');
      expect((json as unknown as Record<string, unknown>)[name]).toBeUndefined();
    });
  }
  const valid: [ArithmeticName, number[], number][] = [
    ['relationalAdd', [0, 0], 0], ['relationalAdd', [9007199254740991, 0], 9007199254740991],
    ['relationalAdd', [0, 9007199254740991], 9007199254740991],
    ['relationalAdd', [9007199254740990, 1], 9007199254740991],
    ['relationalMul', [0, 9007199254740991], 0], ['relationalMul', [9007199254740991, 0], 0],
    ['relationalMul', [9007199254740991, 1], 9007199254740991],
    ['relationalMul', [1, 9007199254740991], 9007199254740991],
    ['relationalMul', [4503599627370495, 2], 9007199254740990],
    ['relationalCommas', [0], 0], ['relationalCommas', [1], 0], ['relationalCommas', [2], 1],
    ['relationalCommas', [9007199254740991], 9007199254740990],
    ...([ [0, 0], [1, 1], [255, 1], [256, 1], [257, 2], [511, 2], [512, 2], [513, 3],
      [9007199254740736, 35184372088831], [9007199254740991, 35184372088832] ] as [number, number][])
      .map(([u, expected]): [ArithmeticName, number[], number] => ['relationalBlocks', [u], expected]),
  ];
  it.each(valid)('%s literal safe result %#', (name, args, expected) => {
    expect(call(name, ...args)).toBe(expected);
  });
  for (const name of ['relationalAdd', 'relationalMul', 'relationalBlocks', 'relationalCommas'] as const) {
    for (const invalid of [-1, 0.5, NaN, Infinity, -Infinity, 9007199254740992]) {
      for (const side of name === 'relationalAdd' || name === 'relationalMul' ? [0, 1] : [0]) {
        it(`${name} rejects invalid ${String(invalid)} operand ${side} before any arithmetic`, () => {
          const args = name === 'relationalAdd' || name === 'relationalMul' ? [0, 0] : [0];
          args[side] = invalid;
          let result: number | undefined, error: unknown;
          try { result = call(name, ...args); } catch (caught) { error = caught; }
          expect({ result, budgetError: error instanceof BudgetExceededError, arithmetic: probe.events })
            .toEqual({ result: undefined, budgetError: true, arithmetic: [] });
        });
      }
    }
  }
  for (const [name, a, b, forbidden] of [
    ['relationalAdd', 9007199254740991, 1, 'a + b'],
    ['relationalAdd', 1, 9007199254740991, 'a + b'],
    ['relationalMul', 4503599627370496, 2, 'a * b'],
    ['relationalMul', 2, 4503599627370496, 'a * b'],
    ['relationalMul', 9007199254740991, 9007199254740991, 'a * b'],
  ] as const) {
    it(`${name} overflow ${a}/${b} refuses before actual ${forbidden}`, () => {
      let result: number | undefined, error: unknown;
      try { result = call(name, a, b); } catch (caught) { error = caught; }
      expect({ result, budgetError: error instanceof BudgetExceededError,
        forbidden: probe.events.filter(event => event.expression === forbidden) })
        .toEqual({ result: undefined, budgetError: true, forbidden: [] });
    });
  }
  it('q MAX avoids U+255 and reaches guarded remainder add only after quotient', () => {
    expect(call('relationalBlocks', 9007199254740991)).toBe(35184372088832);
    expect(probe.events).toEqual([
      { expression: 'u / 256', value: 35184372088831.996 },
      { expression: 'u % 256', value: 255 },
      { expression: 'Number.MAX_SAFE_INTEGER - b', value: 9007199254740990 },
      { expression: 'a + b', value: 35184372088832 },
    ]);
  });
  it('q exact block and zero never add; comma zero never decrements', () => {
    for (const u of [0, 256]) {
      call('relationalBlocks', u);
      expect(probe.events.map(event => event.expression)).toEqual(['u / 256', 'u % 256']);
    }
    call('relationalCommas', 0); expect(probe.events).toEqual([]);
  });
});

import * as relationalWork from './boundedWork';

// B.2 H-only subincrement: no W/G/M/J/P0/R acceptance is implied. The
// existing independent ledger above remains the complete prospective model.
const metadataInitial = {
  leftU: 0, leftB: 0, leftText: false,
  rightU: 0, rightB: 0, rightText: false,
  outU: 0, outB: 0, outText: false,
  graphScratch: false, parserScratch: false, phase: 0,
};
type RelationalMetadataProbe = typeof metadataInitial;
type MetadataMarker = 'entry' | 'before construction' | 'constructed' | 'returned';
function metadataProbe(observe: (marker: MetadataMarker, value?: RelationalMetadataProbe) => void = () => {}) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || declaration.name?.text !== 'relationalMetadata' || !declaration.body) continue;
    edits.push({ at: declaration.body.getStart(parsed) + 1, text: '\n__observe("entry");\n' });
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'metadata' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        edits.push({ at: node.initializer.getStart(parsed), text: '(__observe("before construction"), __constructed(' });
        edits.push({ at: node.initializer.end, text: '))' });
      }
      if (ts.isReturnStatement(node) && node.expression) {
        edits.push({ at: node.expression.getStart(parsed), text: '__returned(' });
        edits.push({ at: node.expression.end, text: ')' });
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let instrumented = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
  instrumented += '\nexports.metadata = typeof relationalMetadata === "function" ? relationalMetadata : undefined;';
  const compiled = ts.transpileModule(instrumented, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { metadata?: (budget: BudgetContext) => RelationalMetadataProbe; reserveBoundedJsonRelational?: typeof json.reserveBoundedJsonRelational } = {};
  new Function('exports', 'require', '__observe', '__constructed', '__returned', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected actual-module dependency ${id}`);
    return relationalWork;
  }, observe, (value: RelationalMetadataProbe) => { observe('constructed', value); return value; },
  (value: RelationalMetadataProbe) => { observe('returned', value); return value; });
  return exports;
}

describe('relational B.2 H private declaration', () => {
  it('H constructor declaration exists privately (not protection RED)', () => {
    expect(metadataProbe().metadata).toBeTypeOf('function');
    expect((json as unknown as Record<string, unknown>).relationalMetadata).toBeUndefined();
  });
});

// Literal partial ledger: H only, excluding O, both W visits, G/M/J/P0/R.
// This is deliberately not a claim that the public relation prepares strings.
const metadataCost = { nodes: 1, slots: 12, contentBytes: 0, structuralBytes: 112, work: 1 };
describe('relational B.2 H reached allocation and completion', () => {
  it('constructs exactly one fresh twelve-field zero/false object per call', () => {
    const objects: RelationalMetadataProbe[] = [];
    const markers: MetadataMarker[] = [];
    const probe = metadataProbe((marker, value) => {
      markers.push(marker);
      if (marker === 'constructed') objects.push(value!);
    });
    const budget = createBudgetContext({ now: () => 0 });
    const first = probe.metadata!(budget), second = probe.metadata!(budget);
    expect(markers).toEqual(['entry', 'before construction', 'constructed', 'returned', 'entry', 'before construction', 'constructed', 'returned']);
    expect(objects).toHaveLength(2);
    expect(first).toBe(objects[0]); expect(second).toBe(objects[1]); expect(first).not.toBe(second);
    expect(first).toEqual(metadataInitial); expect(second).toEqual(metadataInitial);
    expect(Object.keys(first)).toEqual(['leftU', 'leftB', 'leftText', 'rightU', 'rightB', 'rightText', 'outU', 'outB', 'outText', 'graphScratch', 'parserScratch', 'phase']);
    expect(budget.usage()).toEqual({ nodes: 2, slots: 24, contentBytes: 0, structuralBytes: 224, work: 2 });
  });
  it('reserves H then spends one before the actual literal and checks before local return', () => {
    const order: string[] = [];
    const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base,
      reserve(cost) { order.push('reserve'); expect(cost).toEqual({ nodes: 1, slots: 12, structuralBytes: 112 }); base.reserve(cost); },
      spend(amount) { order.push('spend'); expect(amount).toBe(1); base.spend(amount); },
      check() { order.push('check'); base.check(); },
    };
    const probe = metadataProbe(marker => {
      order.push(marker);
      if (marker === 'before construction') expect(base.usage()).toEqual(metadataCost);
    });
    probe.metadata!(budget);
    expect(order).toEqual(['entry', 'reserve', 'spend', 'before construction', 'constructed', 'check', 'returned']);
  });
  for (const dimension of ['nodes', 'slots', 'structuralBytes', 'work'] as const) {
    for (const difference of [-1, 0, 1]) {
      it(`H ${dimension} reached literal allowance ${difference}`, () => {
        const markers: MetadataMarker[] = [];
        const budget = createBudgetContext({ now: () => 0, limits: { [dimension]: metadataCost[dimension] + difference } });
        const probe = metadataProbe(marker => { markers.push(marker); });
        let value: RelationalMetadataProbe | undefined, caught: unknown;
        try { value = probe.metadata!(budget); } catch (error) { caught = error; }
        expect(markers[0]).toBe('entry');
        if (difference < 0) {
          expect({ exceeded: caught instanceof BudgetExceededError, value, markers }).toEqual({ exceeded: true, value: undefined, markers: ['entry'] });
        } else {
          expect(caught).toBeUndefined(); expect(value).toEqual(metadataInitial);
          expect(markers).toEqual(['entry', 'before construction', 'constructed', 'returned']);
          expect(budget.usage()).toEqual(metadataCost);
        }
      });
    }
  }
  for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
      it(`H actual construction ${mode}/${outcome}: local return and own catch dominance`, () => {
        let clock = 0;
        const signal = { aborted: false };
        const budget = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('H construction sentinel');
        const markers: MetadataMarker[] = [];
        const probe = metadataProbe(marker => {
          markers.push(marker);
          if (marker === 'constructed') {
            if (mode === 'expired') clock = 5000;
            if (mode === 'aborted') signal.aborted = true;
            if (outcome !== 'success') throw sentinel;
          }
        });
        let result: RelationalMetadataProbe | undefined, caught: unknown;
        try { result = probe.metadata!(budget); } catch (error) { caught = error; }
        expect(markers.slice(0, 3)).toEqual(['entry', 'before construction', 'constructed']);
        if (mode === 'timely' && outcome === 'success') {
          expect(result).toEqual(metadataInitial); expect(caught).toBeUndefined(); expect(markers[3]).toBe('returned');
        } else {
          expect(result).toBeUndefined(); expect(markers).not.toContain('returned');
          if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
          else expect(caught).toBeInstanceOf(BudgetUnavailableError);
        }
      });
    }
  }
});

// B.2 continuation: observation only, executing the full actual module. No
// candidate evaluator, coercion, converted-string cache or forged graph owner.
type ScalarMarker = 'scalar entry' | 'before length' | 'length' | 'before scan' | 'scan'
  | 'scalar output' | 'string output' | 'scalar returned' | 'walker returned' | 'left retained' | 'right retained'
  | 'before arithmetic' | 'arithmetic' | 'raw relation';
function scalarProbe(observe: (marker: ScalarMarker, value?: unknown, metadata?: RelationalMetadataProbe) => void = () => {}) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  const wrap = (node: ts.Node, marker: ScalarMarker, before?: ScalarMarker) => {
    edits.push({ at: node.getStart(parsed), text: `(${before ? `__observe(${JSON.stringify(before)}), ` : ''}__after(${JSON.stringify(marker)}, (` });
    edits.push({ at: node.end, text: '), metadata))' });
  };
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body) continue;
    const name = declaration.name?.text;
    if (name !== 'relationalScalar' && name !== 'reserveBoundedJsonRelational') continue;
    if (name === 'relationalScalar') edits.push({ at: declaration.body.getStart(parsed) + 1, text: '\n__observe("scalar entry", input, metadata);\n' });
    const visit = (node: ts.Node) => {
      if (name === 'relationalScalar') {
        if (ts.isPropertyAccessExpression(node) && node.getText(parsed) === 'input.length') wrap(node, 'length', 'before length');
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'utf8ByteLength') wrap(node, 'scan', 'before scan');
        if (ts.isCallExpression(node) && ['relationalAdd', 'relationalMul'].includes(node.expression.getText(parsed))) wrap(node, 'arithmetic', 'before arithmetic');
        if (ts.isBinaryExpression(node) && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken].includes(node.operatorToken.kind)
          && [node.left.getText(parsed), node.right.getText(parsed)].includes('input')) wrap(node, 'raw relation');
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(parsed) === 'metadata.outText') {
          wrap(node, node.right.kind === ts.SyntaxKind.TrueKeyword ? 'string output' : 'scalar output');
        }
        if (ts.isReturnStatement(node) && !node.expression) edits.push({ at: node.getStart(parsed), text: '__observe("scalar returned", input, metadata); ' });
      } else {
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'relationalScalar') wrap(node, 'walker returned');
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (node.left.getText(parsed) === 'metadata.leftText') wrap(node, 'left retained');
          if (node.left.getText(parsed) === 'metadata.rightText') wrap(node, 'right retained');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let instrumented = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
  instrumented += '\nexports.scalar = typeof relationalScalar === "function" ? relationalScalar : undefined;\nexports.metadata = relationalMetadata;';
  const compiled = ts.transpileModule(instrumented, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { scalar?: (input: unknown, budget: BudgetContext, metadata: RelationalMetadataProbe) => void; metadata?: (budget: BudgetContext) => RelationalMetadataProbe; reserveBoundedJsonRelational?: typeof json.reserveBoundedJsonRelational } = {};
  new Function('exports', 'require', '__observe', '__after', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected actual-module dependency ${id}`);
    return relationalWork;
  }, observe, (marker: ScalarMarker, value: unknown, metadata: RelationalMetadataProbe) => { observe(marker, value, metadata); return value; });
  if (!exports.metadata || !exports.reserveBoundedJsonRelational) throw new Error('Missing actual H/public prerequisite');
  return { scalar: exports.scalar, metadata: exports.metadata, reserveBoundedJsonRelational: exports.reserveBoundedJsonRelational };
}

describe('relational B.2 scalar/string declaration', () => {
  it('scalar/string walker is privately callable (declaration gate only)', () => {
    expect(scalarProbe().scalar).toBeTypeOf('function');
    expect((json as unknown as Record<string, unknown>).relationalScalar).toBeUndefined();
  });
  it('nontrivial public path reaches both actual operands but still refuses pending P0/R (path gate only)', () => {
    const inputs: unknown[] = [];
    const probe = scalarProbe((marker, value) => { if (marker === 'scalar entry') inputs.push(value); });
    expect(() => probe.reserveBoundedJsonRelational('left', 'right', createBudgetContext({ now: () => 0 }))).not.toThrow();
    expect(inputs).toEqual(['left', 'right']);
  });
});

describe('relational B.2 string length admission', () => {
  for (const side of ['left', 'right'] as const) {
    for (const allowance of [0, 1, 2]) {
      it(`${side} length work1 allowance ${allowance} after reached visit before length get`, () => {
        const base = createBudgetContext({ now: () => 0 });
        let entries = 0, selected = false, armed = false, gotLength = false;
        const stop = new Error('before actual length');
        const budget: BudgetContext = { ...base, spend(amount) {
          base.spend(amount);
          if (selected && !armed) { armed = true; base.spend(base.limits.work - base.usage().work - allowance); }
        } };
        const probe = scalarProbe(marker => {
          if (marker === 'scalar entry') selected = ++entries === (side === 'left' ? 1 : 2);
          if (selected && marker === 'before length') { gotLength = true; throw stop; }
        });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? 'abc' : 0, side === 'right' ? 'abc' : 0, budget); } catch (error) { caught = error; }
        expect(armed).toBe(true);
        if (allowance === 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(gotLength).toBe(false); }
        else { expect(caught).toBe(stop); expect(gotLength).toBe(true); expect(base.usage().work).toBe(base.limits.work - allowance + 1); }
      });
    }
    for (const cap of [2, 3, 4]) {
      it(`${side} U=3 at C=${cap} caps before source scan (not conservative 3U)`, () => {
        const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: cap } });
        let reached = false, scanned = false;
        const probe = scalarProbe(marker => { if (marker === 'length') reached = true; if (marker === 'before scan') scanned = true; });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? 'abc' : 0, side === 'right' ? 'abc' : 0, budget); } catch (error) { caught = error; }
        expect(reached).toBe(true);
        if (cap === 2) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(scanned).toBe(false); }
        else { expect(caught).toBeUndefined(); expect(scanned).toBe(true); }
      });
    }
    for (const cap of [-1, 0.5, NaN, Infinity, 9007199254740992]) {
      it(`${side} invalid private context string limit ${String(cap)} refuses before scan`, () => {
        const base = createBudgetContext({ now: () => 0 });
        const budget = { ...base, limits: { ...base.limits, stringBytes: cap } };
        let reached = false, scanned = false;
        const probe = scalarProbe(marker => { if (marker === 'length') reached = true; if (marker === 'before scan') scanned = true; });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? 'A' : 0, side === 'right' ? 'A' : 0, budget); } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(caught).toBeInstanceOf(BudgetExceededError); expect(scanned).toBe(false);
      });
    }
    it(`${side} actual U=8000001 refuses at fixed ceiling even with permissive private limit`, () => {
      const base = createBudgetContext({ now: () => 0 });
      const budget = { ...base, limits: { ...base.limits, stringBytes: 9000000 } };
      const value = 'A'.repeat(8000001);
      let reached = false, scanned = false;
      const probe = scalarProbe(marker => { if (marker === 'length') reached = true; if (marker === 'before scan') scanned = true; });
      let caught: unknown;
      try { probe.reserveBoundedJsonRelational(side === 'left' ? value : 0, side === 'right' ? value : 0, budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(caught).toBeInstanceOf(BudgetExceededError); expect(scanned).toBe(false);
    });
    for (const mode of ['timely', 'expired', 'aborted'] as const) {
      for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
        it(`${side} length return ${mode}/${outcome} before scan; catch controls inherited from scalar`, () => {
          let clock = 0, reached = false, scanned = false;
          const signal = { aborted: false };
          const budget = createBudgetContext({ now: () => clock, signal });
          const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('length boundary');
          const probe = scalarProbe(marker => {
            if (marker === 'before scan') scanned = true;
            if (marker === 'length') {
              reached = true;
              if (mode === 'expired') clock = 5000;
              if (mode === 'aborted') signal.aborted = true;
              if (outcome !== 'success') throw sentinel;
            }
          });
          let caught: unknown;
          try { probe.reserveBoundedJsonRelational(side === 'left' ? 'A' : 0, side === 'right' ? 'A' : 0, budget); } catch (error) { caught = error; }
          expect(reached).toBe(true);
          if (mode === 'timely' && outcome === 'success') { expect(scanned).toBe(true); expect(caught).toBeUndefined(); }
          else {
            expect(scanned).toBe(false);
            if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
            else expect(caught).toBeInstanceOf(BudgetUnavailableError);
          }
        });
      }
    }
  }
});

describe('relational B.2 source F allocation', () => {
  for (const side of ['left', 'right'] as const) {
    for (const [u, structural] of [[0, 16], [1, 18], [257, 530]] as const) {
      for (const dimension of ['nodes', 'structuralBytes'] as const) {
        for (const difference of [-1, 0, 1]) {
          it(`${side} F U=${u} ${dimension} allowance ${difference} after length before native scan`, () => {
            const budget = createBudgetContext({ now: () => 0 });
            const cost = dimension === 'nodes' ? 1 : structural;
            const allowance = cost + difference;
            const stop = new Error('source scan entry');
            let reached = false, scanned = false;
            const probe = scalarProbe(marker => {
              if (marker === 'length') {
                reached = true;
                budget.reserve({ [dimension]: budget.limits[dimension] - budget.usage()[dimension] - allowance });
              }
              if (marker === 'before scan') { scanned = true; throw stop; }
            });
            let caught: unknown;
            const value = 'A'.repeat(u);
            try { probe.reserveBoundedJsonRelational(side === 'left' ? value : 0, side === 'right' ? value : 0, budget); } catch (error) { caught = error; }
            expect(reached).toBe(true);
            if (difference < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(scanned).toBe(false); }
            else { expect(caught).toBe(stop); expect(scanned).toBe(true); expect(budget.usage()[dimension]).toBe(budget.limits[dimension] - difference); }
          });
        }
      }
    }
  }
});

// Literal approved-V2 W requirements, not obtained from candidate execution.
// Columns U, q(U), F structure, W work, Hangul/lone B, astral+odd-lone B.
const stringRequirements = [
  [0, 0, 16, 2, 0, 0], [1, 1, 18, 4, 3, 3],
  [255, 1, 526, 4, 765, 511], [256, 1, 528, 4, 768, 512],
  [257, 2, 530, 6, 771, 515], [511, 2, 1038, 6, 1533, 1023],
  [512, 2, 1040, 6, 1536, 1024], [513, 3, 1042, 8, 1539, 1027],
] as const;
describe('relational B.2 source flatten work and exact UTF8', () => {
  for (const side of ['left', 'right'] as const) {
    for (const [u, q, structural] of stringRequirements) {
      for (const difference of q === 0 ? [0, 1] : [-1, 0, 1]) {
        it(`${side} source flatten q(${u})=${q} work allowance ${difference} after actual F before scan`, () => {
          const base = createBudgetContext({ now: () => 0 });
          let lengthReached = false, armed = false, scanned = false;
          const stop = new Error('flatten before scan');
          const budget: BudgetContext = { ...base, reserve(cost) {
            base.reserve(cost);
            if (lengthReached && !armed) {
              expect(cost).toEqual({ nodes: 1, structuralBytes: structural });
              armed = true; base.spend(base.limits.work - base.usage().work - q - difference);
            }
          } };
          const probe = scalarProbe(marker => {
            if (marker === 'length') lengthReached = true;
            if (marker === 'before scan') { scanned = true; throw stop; }
          });
          let caught: unknown;
          const value = 'A'.repeat(u);
          try { probe.reserveBoundedJsonRelational(side === 'left' ? value : 0, side === 'right' ? value : 0, budget); } catch (error) { caught = error; }
          expect(lengthReached).toBe(true); expect(armed).toBe(true);
          if (difference < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(scanned).toBe(false); }
          else { expect(caught).toBe(stop); expect(scanned).toBe(true); expect(base.usage().work).toBe(base.limits.work - difference); }
        });
      }
    }
    for (const [u, q, structural, work, tripleB, astralB] of stringRequirements) {
      const specimens: [string, string, number][] = [
        ['ASCII', 'A'.repeat(u), u], ['Hangul', '한'.repeat(u), tripleB],
        ['astral', '😀'.repeat(Math.floor(u / 2)) + (u % 2 ? '\ud800' : ''), astralB],
        ['lone-high', '\ud800'.repeat(u), tripleB], ['lone-low', '\udc00'.repeat(u), tripleB],
      ];
      if (u >= 257) specimens.push(['cross-boundary-pair', 'A'.repeat(255) + '😀' + 'A'.repeat(u - 257), u + 2]);
      for (const [kind, value, bytes] of specimens) {
        it(`${side} ${kind} U=${u} exact W ledger and inherited unchanged UTF8 q blocks`, () => {
          const base = createBudgetContext({ now: () => 0, limits: { stringBytes: bytes } });
          let entries = 0, selected = false;
          const debits: number[] = [];
          let before: ReturnType<BudgetContext['usage']> | undefined, scanBefore = 0, scanAfter = 0;
          const stop = new Error('W complete before caller');
          const budget: BudgetContext = { ...base, spend(amount = 1) { if (selected) debits.push(amount); base.spend(amount); } };
          const probe = scalarProbe((marker, measured, metadata) => {
            if (marker === 'scalar entry') {
              selected = ++entries === (side === 'left' ? 1 : 2);
              if (selected) before = base.usage();
            }
            if (!selected) return;
            if (marker === 'before scan') scanBefore = base.usage().work;
            if (marker === 'scan') { scanAfter = base.usage().work; expect(measured).toBe(bytes); }
            if (marker === 'scalar returned') {
              expect(metadata).toMatchObject({ outU: u, outB: bytes, outText: true });
              throw stop;
            }
          });
          let caught: unknown;
          try { probe.reserveBoundedJsonRelational(side === 'left' ? value : 0, side === 'right' ? value : 0, budget); } catch (error) { caught = error; }
          expect(caught).toBe(stop); expect(before).toBeDefined();
          expect(base.usage()).toEqual({ nodes: before!.nodes + 1, slots: before!.slots, contentBytes: before!.contentBytes, structuralBytes: before!.structuralBytes + structural, work: before!.work + work });
          expect(scanAfter - scanBefore).toBe(q);
          expect(debits).toEqual([1, 1, q, ...Array<number>(q).fill(1)]);
        });
      }
    }
  }
});

describe('relational B.2 byte cap and string completion', () => {
  for (const side of ['left', 'right'] as const) {
    for (const cap of [2, 3, 4]) {
      it(`${side} actual U=1 B=3 at C=${cap} checks B after charged scan before output`, () => {
        const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: cap } });
        let reached = false, output = false, measured: unknown;
        const probe = scalarProbe((marker, value) => {
          if (marker === 'scan') { reached = true; measured = value; }
          if (marker === 'string output') output = true;
        });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? '한' : 0, side === 'right' ? '한' : 0, budget); } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(measured).toBe(3);
        if (cap === 2) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(output).toBe(false); }
        else { expect(caught).toBeUndefined(); expect(output).toBe(true); }
      });
    }
    it(`${side} actual B=9000000 refuses fixed byte ceiling after real scan under permissive private limit`, () => {
      const base = createBudgetContext({ now: () => 0 });
      const budget = { ...base, limits: { ...base.limits, stringBytes: 9000000 } };
      const value = '한'.repeat(3000000);
      let reached = false, output = false;
      const probe = scalarProbe((marker, bytes) => {
        if (marker === 'scan') { reached = true; expect(bytes).toBe(9000000); }
        if (marker === 'string output') output = true;
      });
      let caught: unknown;
      try { probe.reserveBoundedJsonRelational(side === 'left' ? value : 0, side === 'right' ? value : 0, budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(output).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
  for (const route of ['left', 'right', 'private'] as const) {
    for (const seam of ['length', 'scan', 'string output'] as const) {
      for (const mode of ['timely', 'expired', 'aborted'] as const) {
        for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
          it(`${route} ${seam} ${mode}/${outcome} owns immediate completion and budget identity`, () => {
            let clock = 0, reached = false;
            const signal = { aborted: false };
            const budget = createBudgetContext({ now: () => clock, signal });
            const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('string completion');
            const successors: ScalarMarker[] = [];
            const probe = scalarProbe(marker => {
              if (reached) successors.push(marker);
              if (!reached && marker === seam) {
                reached = true;
                if (mode === 'expired') clock = 5000;
                if (mode === 'aborted') signal.aborted = true;
                if (outcome !== 'success') throw sentinel;
              }
            });
            let caught: unknown;
            try {
              if (route === 'private') probe.scalar!('A', budget, probe.metadata(budget));
              else probe.reserveBoundedJsonRelational(route === 'left' ? 'A' : 0, route === 'right' ? 'A' : 0, budget);
            } catch (error) { caught = error; }
            expect(reached).toBe(true);
            if (mode === 'timely' && outcome === 'success') {
              if (route === 'private') expect(caught).toBeUndefined();
              else expect(caught).toBeUndefined();
              expect(successors).toContain('scalar returned');
            } else {
              expect(successors).toEqual([]);
              if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
              else expect(caught).toBeInstanceOf(BudgetUnavailableError);
            }
          });
        }
      }
    }
  }
});

describe('relational B.2 supplemental prefix and isolation controls', () => {
  for (const side of ['left', 'right'] as const) {
    it(`${side} reaches actual string preparation without native String/Number or raw evaluation (control)`, () => {
      let entries = 0, raw = 0, strings = 0, numbers = 0;
      const budget = createBudgetContext({ now: () => 0 });
      const probe = scalarProbe(marker => { if (marker === 'scalar entry') entries++; if (marker === 'raw relation') raw++; });
      const nativeString = globalThis.String, nativeNumber = globalThis.Number;
      let caught: unknown;
      try {
        globalThis.String = new Proxy(nativeString, { apply(target, receiver, args) { strings++; return Reflect.apply(target, receiver, args); } });
        globalThis.Number = new Proxy(nativeNumber, { apply(target, receiver, args) { numbers++; return Reflect.apply(target, receiver, args); } });
        probe.reserveBoundedJsonRelational(side === 'left' ? '123' : 7, side === 'right' ? '123' : 7, budget);
      } catch (error) { caught = error; }
      finally { globalThis.String = nativeString; globalThis.Number = nativeNumber; }
      expect(caught).toBeUndefined();
      expect(entries).toBe(2); expect({ strings, numbers, raw }).toEqual({ strings: 0, numbers: 0, raw: 0 });
    });
  }
  const specimens: [unknown, unknown, Vector][] = [
    ['', 0, [3, 20, 0, 208, 10]], ['A', 0, [3, 20, 0, 210, 12]],
    ['', '', [4, 20, 0, 224, 11]], ['한', '😀', [4, 20, 0, 230, 15]],
    ['A'.repeat(255) + '😀', undefined, [3, 20, 0, 722, 14]],
  ];
  for (const [index, specimen] of specimens.entries()) {
    for (const reverse of [false, true]) {
      it(`actual refused prefix specimen ${index} reverse=${reverse} retains left then right in one H; excludes P0/R/final2`, () => {
        const [a, b, expected] = specimen;
        const left = reverse ? b : a, right = reverse ? a : b;
        const model = ledger(left, right);
        const end = model.events.findIndex(event => event.label === 'P0 allocation');
        expect(end).toBeGreaterThan(0);
        const total: Vector = [0, 0, 0, 0, 0];
        for (const event of model.events.slice(0, end)) for (let i = 0; i < 5; i++) total[i] += event.vector[i];
        expect(total).toEqual(expected);
        const budget = createBudgetContext({ now: () => 0, limits: { contentBytes: 0 } });
        const roots: unknown[] = [], objects: RelationalMetadataProbe[] = [];
        const prefixStop = new Error('explicit pre-P0 right-retained prefix stop');
        let retained: RelationalMetadataProbe | undefined;
        const probe = scalarProbe((marker, value, metadata) => {
          if (marker === 'scalar entry') {
            roots.push(value); objects.push(metadata!);
            if (roots.length === 2) expect(metadata).toMatchObject({ leftU: model.roots[0].u, leftB: model.roots[0].b, leftText: model.roots[0].text, rightU: 0, rightB: 0, rightText: false });
          }
          if (marker === 'right retained') { retained = { ...metadata! }; throw prefixStop; }
        });
        expect(() => probe.reserveBoundedJsonRelational(left, right, budget)).toThrow(prefixStop);
        expect(roots).toEqual([left, right]); expect(objects[0]).toBe(objects[1]);
        expect(retained).toEqual({ leftU: model.roots[0].u, leftB: model.roots[0].b, leftText: model.roots[0].text,
          rightU: model.roots[1].u, rightB: model.roots[1].b, rightText: model.roots[1].text,
          outU: model.roots[1].u, outB: model.roots[1].b, outText: model.roots[1].text,
          graphScratch: false, parserScratch: false, phase: 0 });
        expect(budget.usage()).toEqual({ nodes: expected[0], slots: expected[1], contentBytes: expected[2], structuralBytes: expected[3], work: expected[4] });
      });
    }
  }
  for (const [dimension, exact] of [['nodes', 4], ['slots', 20], ['structuralBytes', 230], ['work', 15]] as const) {
    for (const difference of [-1, 0, 1]) {
      it(`literal aggregate refused-prefix ${dimension} ${difference} never claims full relation success`, () => {
        const budget = createBudgetContext({ now: () => 0, limits: { [dimension]: exact + difference, contentBytes: 0 } });
        let completed = false;
        const prefixStop = new Error('explicit pre-P0 allowance boundary stop');
        const probe = scalarProbe(marker => { if (marker === 'right retained') { completed = true; throw prefixStop; } });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational('한', '😀', budget); } catch (error) { caught = error; }
        if (difference < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(completed).toBe(false); }
        else {
          expect(caught).toBe(prefixStop); expect(completed).toBe(true);
          expect(budget.usage()).toEqual({ nodes: 4, slots: 20, contentBytes: 0, structuralBytes: 230, work: 15 });
        }
      });
    }
  }
  for (const side of ['left', 'right'] as const) {
    for (const fault of ['over-U', 'invalid-limit'] as const) {
      it(`${side} ${fault} refuses before F arithmetic/reserve, supplemental stronger successor marker`, () => {
        const base = createBudgetContext({ now: () => 0 });
        const budget = { ...base, limits: { ...base.limits, stringBytes: fault === 'over-U' ? 2 : NaN } };
        let reached = false, arithmetic = false, scanned = false;
        const probe = scalarProbe(marker => {
          if (marker === 'length') reached = true;
          if (marker === 'before arithmetic') arithmetic = true;
          if (marker === 'before scan') scanned = true;
        });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? 'abc' : 0, side === 'right' ? 'abc' : 0, budget); } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(arithmetic).toBe(false); expect(scanned).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError);
      });
    }
    it(`${side} reached string error wins before unsupported opposite root traversal (order control)`, () => {
      // Right-side selected-string control has a valid left scalar; left failure
      // independently proves right semantic classification cannot run early.
      const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: 2 } });
      const entries: unknown[] = [];
      const probe = scalarProbe((marker, value) => { if (marker === 'scalar entry') entries.push(value); });
      expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? 'abc' : 0, side === 'left' ? NaN : 'abc', budget)).toThrow(BudgetExceededError);
      expect(entries).toEqual(side === 'left' ? ['abc'] : [0, 'abc']);
    });
    for (const dimension of ['nodes', 'slots', 'structuralBytes', 'work'] as const) {
      for (const difference of [-1, 0, 1]) {
        it(`${side} public H ${dimension} ${difference} at reached factory before literal (integration control)`, () => {
          const budget = createBudgetContext({ now: () => 0 });
          const stop = new Error('H before W');
          let reached = false, constructed = false;
          const probe = metadataProbe(marker => {
            if (marker === 'entry') {
              reached = true;
              const allowance = metadataCost[dimension] + difference;
              if (dimension === 'work') budget.spend(budget.limits.work - budget.usage().work - allowance);
              else budget.reserve({ [dimension]: budget.limits[dimension] - budget.usage()[dimension] - allowance });
            }
            if (marker === 'constructed') { constructed = true; throw stop; }
          });
          let caught: unknown;
          try { probe.reserveBoundedJsonRelational!(side === 'left' ? 'A' : 0, side === 'right' ? 'A' : 0, budget); } catch (error) { caught = error; }
          expect(reached).toBe(true);
          if (difference < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(constructed).toBe(false); }
          else { expect(caught).toBe(stop); expect(constructed).toBe(true); expect(budget.usage()[dimension]).toBe(budget.limits[dimension] - difference); }
        });
      }
    }
  }
  it('scalar/string source uses only O reused positions and no graph/recursive/coercion operations (source contract)', () => {
    const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
    const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
    const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'relationalScalar');
    expect(declaration).toBeDefined();
    const locals: string[] = [], calls: string[] = [], loops: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && !ts.isCatchClause(node.parent)) locals.push(node.name.getText(parsed));
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(parsed));
      if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) loops.push(node.getText(parsed));
      ts.forEachChild(node, visit);
    };
    visit(declaration!);
    expect(declaration!.parameters.map(parameter => parameter.name.getText(parsed))).toEqual(['input', 'budget', 'metadata']);
    expect(locals).toEqual(['u', 'b']); expect(loops).toEqual([]);
    for (const forbidden of ['relationalScalar', 'shapeOf', 'stackScratch', 'String', 'Number', 'parseFloat', 'parseInt', 'Array.isArray', 'Object.keys', 'Object.getPrototypeOf']) expect(calls).not.toContain(forbidden);
    expect(calls).toContain('relationalMul'); expect(calls).toContain('relationalAdd'); expect(calls).toContain('relationalBlocks');
    expect(declaration!.getText(parsed)).toContain('utf8ByteLength(input, budget)');
  });
});

describe('relational B.2 inherited actual UTF8 native controls', () => {
  for (const side of ['left', 'right'] as const) {
    for (const mode of ['timely', 'expired', 'aborted'] as const) {
      for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
        it(`${side} real charCodeAt ${mode}/${outcome}: inherited scanner guard and same-owner scalar catch`, () => {
          const value = 'W-native-sentinel';
          let clock = 0, calls = 0, scanReturned = false, output = false;
          const signal = { aborted: false };
          const budget = createBudgetContext({ now: () => clock, signal });
          const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('UTF8 native sentinel');
          const probe = scalarProbe(marker => { if (marker === 'scan') scanReturned = true; if (marker === 'string output') output = true; });
          const native = String.prototype.charCodeAt;
          let caught: unknown;
          try {
            String.prototype.charCodeAt = function (this: string, index: number): number {
              if (this === value && ++calls === 1) {
                if (mode === 'expired') clock = 5000;
                if (mode === 'aborted') signal.aborted = true;
                if (outcome !== 'success') throw sentinel;
              }
              return Reflect.apply(native, this, [index]);
            };
            probe.reserveBoundedJsonRelational(side === 'left' ? value : 0, side === 'right' ? value : 0, budget);
          } catch (error) { caught = error; }
          finally { String.prototype.charCodeAt = native; }
          expect(calls).toBeGreaterThan(0);
          if (mode === 'timely' && outcome === 'success') { expect(scanReturned).toBe(true); expect(output).toBe(true); expect(caught).toBeUndefined(); }
          else {
            expect(scanReturned).toBe(false); expect(output).toBe(false);
            if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
            else expect(caught).toBeInstanceOf(BudgetUnavailableError);
          }
        });
      }
    }
  }
});

const pendingRelationMessage = 'Legacy bounded JSON is invalid.';
describe('relational B.2 scalar visit/domain and pair boundaries', () => {
  // Scope clarification after run024: graph routing is B.3, so object entry
  // assertions belong to this private scalar-only seam, not the public route.
  for (const [index, value] of [{}, []].entries()) {
    it(`private scalar rejects object ${index} before output (already-green scope control)`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      const markers: ScalarMarker[] = [];
      const probe = scalarProbe(marker => { markers.push(marker); });
      const metadata = probe.metadata(budget);
      expect(() => probe.scalar!(value, budget, metadata)).toThrow(pendingRelationMessage);
      expect(markers).toEqual(['scalar entry']);
    });
  }
  for (const side of ['left', 'right'] as const) {
    it(`${side} public unregistered objects refuse without traps, independent of future graph routing (control)`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      let traps = 0;
      const value = new Proxy({}, { get() { traps++; throw new Error('forbidden get'); }, ownKeys() { traps++; throw new Error('forbidden keys'); }, getPrototypeOf() { traps++; throw new Error('forbidden prototype'); } });
      expect(() => prepare(side === 'left' ? value : 'A', side === 'right' ? value : 'A', budget)).toThrow(pendingRelationMessage);
      expect(traps).toBe(0);
    });
  }
  for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
      it(`private scalar output ${mode}/${outcome} owns its catch without public protection`, () => {
        let clock = 0, reached = false, returned = false;
        const signal = { aborted: false };
        const budget = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('private scalar output');
        const probe = scalarProbe(marker => {
          if (marker === 'scalar returned') returned = true;
          if (marker === 'scalar output') {
            reached = true;
            if (mode === 'expired') clock = 5000;
            if (mode === 'aborted') signal.aborted = true;
            if (outcome !== 'success') throw sentinel;
          }
        });
        const metadata = probe.metadata(budget);
        let caught: unknown;
        try { probe.scalar!(7, budget, metadata); } catch (error) { caught = error; }
        expect(reached).toBe(true);
        if (mode === 'timely' && outcome === 'success') { expect(returned).toBe(true); expect(caught).toBeUndefined(); }
        else {
          expect(returned).toBe(false);
          if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
          else expect(caught).toBeInstanceOf(BudgetUnavailableError);
        }
      });
    }
  }
  for (const side of ['left', 'right'] as const) {
    for (const allowance of [0, 1, 2]) {
      it(`${side} root scalar visit work1 allowance ${allowance} before actual output`, () => {
        const base = createBudgetContext({ now: () => 0 });
        const stop = new Error('selected scalar output');
        let entries = 0, armed = false, output = false;
        const probe = scalarProbe(marker => {
          if (marker === 'scalar entry' && ++entries === (side === 'left' ? 1 : 2)) {
            armed = true; base.spend(base.limits.work - base.usage().work - allowance);
          }
          if (armed && marker === 'scalar output') { output = true; throw stop; }
        });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? 7 : 'A', side === 'right' ? 7 : 'A', base); } catch (error) { caught = error; }
        expect(armed).toBe(true);
        if (allowance === 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(output).toBe(false); }
        else { expect(caught).toBe(stop); expect(output).toBe(true); expect(base.usage().work).toBe(base.limits.work - allowance + 1); }
      });
    }
    for (const [index, value] of [0, -0, -3, 0.125, Number.MIN_VALUE, Number.MAX_VALUE, true, false, null, undefined].entries()) {
      it(`${side} nonfast scalar root ${index} has literal W=(0,0,0,0,1) and no text`, () => {
        const budget = createBudgetContext({ now: () => 0 });
        let before: ReturnType<BudgetContext['usage']> | undefined;
        let entries = 0, result: unknown;
        const stop = new Error('selected scalar complete');
        const probe = scalarProbe((marker, _value, metadata) => {
          if (marker === 'scalar entry' && ++entries === (side === 'left' ? 1 : 2)) before = budget.usage();
          if (before && marker === 'scalar returned') { result = { ...metadata }; throw stop; }
        });
        expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? value : 'A', side === 'right' ? value : 'A', budget)).toThrow(stop);
        expect(result).toMatchObject({ outU: 0, outB: 0, outText: false });
        expect(before).toBeDefined();
        expect(budget.usage()).toEqual({ ...before!, work: before!.work + 1 });
      });
    }
    for (const [index, value] of [NaN, Infinity, -Infinity, Symbol('unsupported'), BigInt(1), () => 0].entries()) {
      it(`${side} rejects unsupported scalar root ${index} before output/next operand`, () => {
        const budget = createBudgetContext({ now: () => 0 });
        let entries = 0, selected = false, outputs = 0;
        const probe = scalarProbe(marker => {
          if (marker === 'scalar entry') { entries++; selected = entries === (side === 'left' ? 1 : 2); }
          if (selected && (marker === 'scalar output' || marker === 'string output')) outputs++;
        });
        expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? value : 'A', side === 'right' ? value : 'A', budget)).toThrow(pendingRelationMessage);
        expect(entries).toBe(side === 'left' ? 1 : 2); expect(outputs).toBe(0);
      });
    }
    it(`${side} checks depth1 before entering the selected scalar frame`, () => {
      const base = createBudgetContext({ now: () => 0 });
      const stop = new BudgetExceededError();
      let depths = 0, entries = 0;
      const budget: BudgetContext = { ...base, checkDepth(depth) {
        expect(depth).toBe(1);
        if (++depths === (side === 'left' ? 1 : 2)) throw stop;
        base.checkDepth(depth);
      } };
      const probe = scalarProbe(marker => { if (marker === 'scalar entry') entries++; });
      let caught: unknown;
      try { probe.reserveBoundedJsonRelational('A', 'B', budget); } catch (error) { caught = error; }
      expect(caught).toBe(stop); expect(depths).toBe(side === 'left' ? 1 : 2); expect(entries).toBe(side === 'left' ? 0 : 1);
    });
    for (const seam of ['scalar output', 'walker returned'] as const) {
      for (const mode of ['timely', 'expired', 'aborted'] as const) {
        for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
          it(`${side} ${seam} ${mode}/${outcome} checks local completion before successor`, () => {
            let clock = 0, entries = 0, armed = false, reached = false;
            const signal = { aborted: false };
            const budget = createBudgetContext({ now: () => clock, signal });
            const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('scalar seam');
            const successors: ScalarMarker[] = [];
            const probe = scalarProbe(marker => {
              if (marker === 'scalar entry') armed = ++entries === (side === 'left' ? 1 : 2);
              if (reached) successors.push(marker);
              if (armed && !reached && marker === seam) {
                reached = true;
                if (mode === 'expired') clock = 5000;
                if (mode === 'aborted') signal.aborted = true;
                if (outcome !== 'success') throw sentinel;
              }
            });
            let caught: unknown;
            try { probe.reserveBoundedJsonRelational(side === 'left' ? 7 : 'A', side === 'right' ? 7 : 'A', budget); } catch (error) { caught = error; }
            expect(reached).toBe(true);
            if (mode === 'timely' && outcome === 'success') {
              expect(caught).toBeUndefined();
              expect(successors).toContain(side === 'left' ? 'left retained' : 'right retained');
            } else {
              expect(successors).toEqual([]);
              if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
              else expect(caught).toBeInstanceOf(BudgetUnavailableError);
            }
          });
        }
      }
    }
  }
});


// B.3 arena prefix only. A first real scalar walker is the forbidden successor;
// these tests do not claim graph-frame/access/M/J implementation or public success.
type ArenaMarker = 'H ready' | 'stack ready' | 'supplement ready' | 'flag set' | 'walker entry';
function arenaProbe(observe: (marker: ArenaMarker, value?: unknown, metadata?: RelationalMetadataProbe) => void) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  const wrap = (node: ts.Node, marker: ArenaMarker, metadata = 'undefined') => {
    edits.push({ at: node.getStart(parsed), text: `__arenaAfter(${JSON.stringify(marker)}, (` });
    edits.push({ at: node.end, text: `), ${metadata})` });
  };
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body) continue;
    const name = declaration.name?.text;
    if (name === 'relationalScalar' || name === 'relationalGraph') {
      edits.push({ at: declaration.body.getStart(parsed) + 1, text: '\n__arenaObserve("walker entry", input, metadata);\n' });
    }
    if (name !== 'reserveBoundedJsonRelational') continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const called = node.expression.getText(parsed);
        if (called === 'relationalMetadata') wrap(node, 'H ready');
        if (called === 'stackScratch') wrap(node, 'stack ready', 'metadata');
        if (called === 'budget.reserve' && node.arguments[0]?.getText(parsed).includes('slots: 768')) wrap(node, 'supplement ready', 'metadata');
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText(parsed) === 'metadata.graphScratch') wrap(node, 'flag set', 'metadata');
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let instrumented = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
  const compiled = ts.transpileModule(instrumented, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json;
  new Function('exports', 'require', '__arenaObserve', '__arenaAfter', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected actual-module dependency ${id}`);
    return relationalWork;
  }, observe, (marker: ArenaMarker, value: unknown, metadata?: RelationalMetadataProbe) => { observe(marker, value, metadata); return value; });
  return exports;
}

describe('relational B.3 reached pair arena', () => {
  for (const arrangement of ['object-left', 'string-left-object-right', 'two-objects'] as const) {
    for (const dimension of ['nodes', 'slots', 'structuralBytes', 'work'] as const) {
      for (const difference of [-1, 0, 1]) {
        it(`${arrangement} G ${dimension} allowance ${difference} after H before FIRST actual walker`, () => {
          const base = createBudgetContext({ now: () => 0 });
          const expected = { nodes: 64, slots: 1024, contentBytes: 0, structuralBytes: 16384, work: 1 };
          const markers: ArenaMarker[] = [];
          const stop = new Error('first actual walker');
          let armed = false, atWalker: ReturnType<BudgetContext['usage']> | undefined, flag: boolean | undefined;
          let start = base.usage();
          const probe = arenaProbe((marker, _value, metadata) => {
            markers.push(marker);
            if (marker === 'H ready') {
              const allowance = expected[dimension] + difference;
              const remaining = base.limits[dimension] - base.usage()[dimension] - allowance;
              if (dimension === 'work') base.spend(remaining); else base.reserve({ [dimension]: remaining });
              start = base.usage(); armed = true;
            }
            if (marker === 'walker entry') { atWalker = base.usage(); flag = metadata!.graphScratch; throw stop; }
          });
          const graph = probe.parseRegisteredBoundedJson('[]', base);
          markers.length = 0;
          let caught: unknown;
          try { probe.reserveBoundedJsonRelational(arrangement === 'string-left-object-right' ? '' : graph, arrangement === 'object-left' ? '' : graph, base); } catch (error) { caught = error; }
          expect(armed).toBe(true); expect(markers[0]).toBe('H ready');
          if (difference < 0) {
            expect(caught).toBeInstanceOf(BudgetExceededError); expect(atWalker).toBeUndefined(); expect(markers).not.toContain('flag set');
          } else {
            expect(caught).toBe(stop); expect(flag).toBe(true);
            expect(markers).toEqual(['H ready', 'stack ready', 'supplement ready', 'flag set', 'walker entry']);
            expect(Object.fromEntries(Object.keys(expected).map(key => [key, atWalker![key as keyof typeof expected] - start[key as keyof typeof expected]]))).toEqual(expected);
          }
        });
      }
    }
  }
  for (const pair of [[0, undefined], ['', 0], ['', 'A']] as const) {
    it(`object-free ${JSON.stringify(pair)} never reserves G (inherited routing control)`, () => {
      const markers: ArenaMarker[] = [];
      const probe = arenaProbe(marker => { markers.push(marker); });
      try { probe.reserveBoundedJsonRelational(pair[0], pair[1], createBudgetContext({ now: () => 0 })); } catch (error) { expect((error as Error).message).toBe(pendingRelationMessage); }
      expect(markers).not.toContain('stack ready'); expect(markers).not.toContain('supplement ready'); expect(markers).not.toContain('flag set');
    });
  }
});

// Same actual module/registry, observation-only graph seam. No certificates minted.
type GraphMarker = 'graph entry' | 'before shape' | 'shape' | 'shape flag'
  | 'before graph length' | 'graph length' | 'graph pending' | 'graph returned';
function graphProbe(observe: (marker: GraphMarker, value?: unknown) => void = () => {}) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  const wrap = (node: ts.Node, marker: GraphMarker, before?: GraphMarker) => {
    edits.push({ at: node.getStart(parsed), text: `(${before ? `__graphObserve(${JSON.stringify(before)}, input), ` : ''}__graphAfter(${JSON.stringify(marker)}, (` });
    edits.push({ at: node.end, text: ')))' });
  };
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || declaration.name?.text !== 'relationalGraph' || !declaration.body) continue;
    edits.push({ at: declaration.body.getStart(parsed) + 1, text: '\n__graphObserve("graph entry", input);\n' });
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'shapeOf') wrap(node, 'shape', 'before shape');
      if (ts.isPropertyAccessExpression(node)) {
        if (node.getText(parsed) === 'shape.array') wrap(node, 'shape flag');
        if (node.name.text === 'length' && node.expression.getText(parsed).includes('input')) wrap(node, 'graph length', 'before graph length');
      }
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'invalid') {
        edits.push({ at: node.getStart(parsed), text: '(__graphObserve("graph pending"), ' });
        edits.push({ at: node.end, text: ')' });
      }
      if (ts.isReturnStatement(node) && !node.expression) edits.push({ at: node.getStart(parsed), text: '__graphObserve("graph returned"); ' });
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let instrumented = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
  instrumented += '\nexports.graph = typeof relationalGraph === "function" ? relationalGraph : undefined;';
  const compiled = ts.transpileModule(instrumented, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json & { graph?: (input: object, budget: BudgetContext, metadata: RelationalMetadataProbe, depth: number) => void };
  new Function('exports', 'require', '__graphObserve', '__graphAfter', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected actual-module dependency ${id}`);
    return relationalWork;
  }, observe, (marker: GraphMarker, value: unknown) => { observe(marker, value); return value; });
  return exports;
}

describe('relational B.3 graph operand path gate', () => {
  it('private graph declaration exists (not protection RED)', () => { expect(graphProbe().graph).toBeTypeOf('function'); });
  for (const side of ['left', 'right'] as const) {
    it(`${side} actual same-owner graph reaches length before deliberate pending refusal (path gate only)`, () => {
      const markers: GraphMarker[] = [];
      const probe = graphProbe(marker => { markers.push(marker); });
      const budget = createBudgetContext({ now: () => 0 });
      const graph = probe.parseRegisteredBoundedJson('[]', budget);
      expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget)).not.toThrow();
      expect(markers).toContain('graph entry'); expect(markers).toContain('graph length');
      expect(markers).toContain('graph returned'); // Empty W completes; public suffix still refuses.
    });
  }
});

describe('relational B.3 reached owner before input reads', () => {
  for (const side of ['left', 'right'] as const) {
    for (const kind of ['mutable array', 'mutable record', 'frozen unregistered', 'foreign', 'proxy', 'revoked'] as const) {
      it(`${side} ${kind} reaches graph entry but rejects before operand read/trap`, () => {
        const markers: GraphMarker[] = [];
        let traps = 0;
        const probe = graphProbe(marker => { markers.push(marker); });
        const budget = createBudgetContext({ now: () => 0 });
        let graph: object;
        if (kind === 'foreign') graph = probe.parseRegisteredBoundedJson('[]', createBudgetContext({ now: () => 0 })) as object;
        else if (kind === 'mutable array') graph = [];
        else if (kind === 'mutable record') graph = { get length() { traps++; return 0; } };
        else if (kind === 'frozen unregistered') graph = Object.freeze({ get length() { traps++; return 0; } });
        else {
          const target = probe.parseRegisteredBoundedJson('[]', budget) as object;
          const proxy = Proxy.revocable(target, {
            get() { traps++; return 0; }, getPrototypeOf() { traps++; return null; },
            ownKeys() { traps++; return []; }, getOwnPropertyDescriptor() { traps++; return undefined; },
          });
          graph = proxy.proxy;
          if (kind === 'revoked') proxy.revoke();
        }
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
        expect(markers[0]).toBe('graph entry');
        expect({ message: (caught as Error).message, traps, reads: markers.includes('before graph length') }).toEqual({ message: pendingRelationMessage, traps: 0, reads: false });
        expect(markers).not.toContain('graph returned');
      });
    }
    for (const text of ['{}', '{"valueOf":[],"toString":{}}']) {
      it(`${side} registered record ${text} does not inspect length or method fields`, () => {
        const markers: GraphMarker[] = [];
        const probe = graphProbe(marker => { markers.push(marker); });
        const budget = createBudgetContext({ now: () => 0 });
        const graph = probe.parseRegisteredBoundedJson(text, budget);
        expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget)).not.toThrow();
        expect(markers[0]).toBe('graph entry'); expect(markers).not.toContain('before graph length');
        expect(markers.filter(marker => marker === 'graph returned')).toHaveLength(1);
      });
    }
  }
});

describe('relational B.3 reached access prefix debits and boundaries', () => {
  for (const side of ['left', 'right'] as const) {
    for (const step of [
      { start: 'graph entry', stop: 'before shape', cost: 1, label: 'visit' },
      { start: 'shape', stop: 'shape flag', cost: 4, label: 'method dispatch' },
      { start: 'shape flag', stop: 'before graph length', cost: 1, label: 'length' },
    ] as const) {
      for (const difference of [-1, 0, 1]) {
        it(`${side} ${step.label} work${step.cost} allowance ${difference} at actual predecessor`, () => {
          const budget = createBudgetContext({ now: () => 0 });
          const stop = new Error('represented access step');
          let reached = false, successor = false, caught: unknown;
          const probe = graphProbe(marker => {
            if (marker === step.start) { reached = true; budget.spend(budget.limits.work - budget.usage().work - step.cost - difference); }
            if (marker === step.stop) { successor = true; throw stop; }
          });
          const graph = probe.parseRegisteredBoundedJson('[]', budget);
          try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
          expect(reached).toBe(true);
          if (difference < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(successor).toBe(false); }
          else { expect(caught).toBe(stop); expect(successor).toBe(true); }
        });
      }
    }
  }
  for (const seam of ['shape', 'graph length'] as const) {
    for (const mode of ['timely', 'expired', 'aborted'] as const) {
      for (const outcome of ['success', 'ordinary', 'range', 'exceeded', 'unavailable'] as const) {
        it(`private ${seam} ${mode}/${outcome} owns immediate completion/catch before successor`, () => {
          let clock = 0, reached = false;
          const signal = { aborted: false };
          const base = createBudgetContext({ now: () => clock, signal });
          const successors: string[] = [];
          const budget: BudgetContext = { ...base, spend(amount) { if (reached) successors.push('spend'); base.spend(amount); } };
          const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
            : outcome === 'range' ? new RangeError('graph native boundary') : new Error('graph native boundary');
          const probe = graphProbe(marker => {
            if (reached) successors.push(marker);
            if (marker === seam) {
              reached = true;
              if (mode === 'expired') clock = 5000;
              if (mode === 'aborted') signal.aborted = true;
              if (outcome !== 'success') throw sentinel;
            }
          });
          const graph = probe.parseRegisteredBoundedJson('[]', budget) as object;
          let caught: unknown;
          try { probe.graph!(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
          expect(reached).toBe(true);
          if (mode === 'timely' && outcome === 'success') {
            expect(caught).toBeUndefined(); expect(successors).toContain('graph returned');
          } else {
            expect(successors).toEqual([]);
            if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
            else expect(caught).toBeInstanceOf(BudgetUnavailableError);
          }
        });
      }
    }
  }
});

// Completion probes transform reads in memory only. The real module and its private
// owner registry still create every supported graph. Count substitution is a
// private-capacity probe, never an assertion that such a graph can be registered.
function completionProbe(observe: (marker: string, value: unknown) => unknown = (_marker, value) => value) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  const wrap = (node: ts.Node, marker: string) => {
    edits.push({ at: node.getStart(parsed), text: `(${marker.endsWith(':commas') ? '__completion("relationalGraph:before:commas", count), ' : ''}__completion(${JSON.stringify(marker)}, (` });
    edits.push({ at: node.end, text: ')))' });
  };
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body || !declaration.name) continue;
    const name = declaration.name.text;
    if (name !== 'relationalGraph') continue;
    edits.push({ at: declaration.body.getStart(parsed) + 1, text: '\n__completion("relationalGraph:entry", input);\n' });
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) wrap(node.initializer, `${name}:init:${node.name.getText(parsed)}`);
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'relationalCommas') wrap(node, `${name}:commas`);
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let transformed = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) transformed = transformed.slice(0, edit.at) + edit.text + transformed.slice(edit.at);
  transformed += '\nexports.graph = relationalGraph;';
  const compiled = ts.transpileModule(transformed, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json & { graph: (input: object, budget: BudgetContext, metadata: RelationalMetadataProbe, depth: number) => void };
  new Function('exports', 'require', '__completion', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected completion dependency ${id}`);
    return relationalWork;
  }, observe);
  return exports;
}

describe('relational B.4 genuine comma and J consumer path', () => {
  for (const text of ['[]', '[null]', '[null,null,null]']) {
    it(`${text} consumes actual array count into comma construction and native slot work (not count guard RED)`, () => {
      let armed = false, reached = false;
      const work: number[] = [];
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, spend(amount = 1) { if (armed) work.push(amount); base.spend(amount); } };
      const probe = completionProbe((marker, value) => {
        if (marker === 'relationalGraph:init:count') { armed = true; reached = true; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson(text, budget) as object;
      expect(() => probe.graph(graph, budget, { ...metadataInitial }, 1)).not.toThrow();
      expect(reached).toBe(true);
      expect(work).toEqual(text === '[]' ? [0, 2] : text === '[null]' ? [1, 1, 1, 2] : [4, 1, 1, 1, 1, 1, 1, 4]);
    });
  }
});

describe('relational B.3 reached count before genuine comma consumer', () => {
  for (const side of ['left', 'right'] as const) {
    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, 2]) {
      it(`${side} private count ${String(count)} rejects before comma call; no forged registration`, () => {
        let reached = false, successor = false, caught: unknown;
        const probe = completionProbe((marker, value) => {
          if (marker === 'relationalGraph:init:count') { reached = true; return count; }
          if (marker === 'relationalGraph:before:commas') successor = true;
          return value;
        });
        const budget = createBudgetContext({ now: () => 0 });
        const graph = probe.parseRegisteredBoundedJson('[null]', budget);
        try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(successor).toBe(false);
        if (!Number.isSafeInteger(count) || count < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
        else expect((caught as Error).message).toBe(pendingRelationMessage);
      });
    }
    for (const text of ['[]', '[null]', '[null,null]']) {
      it(`${side} real ${text} agrees with its actual private arity and reaches comma consumer`, () => {
        let reached = false, successor = false;
        const stop = new Error('genuine comma consumer');
        const probe = completionProbe((marker, value) => {
          if (marker === 'relationalGraph:init:count') reached = true;
          if (marker === 'relationalGraph:before:commas') { successor = true; throw stop; }
          return value;
        });
        const budget = createBudgetContext({ now: () => 0 });
        const graph = probe.parseRegisteredBoundedJson(text, budget);
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
        expect({ reached, successor }).toEqual({ reached: true, successor: true }); expect(caught).toBe(stop);
      });
    }
  }
});

describe('relational B.4 reached comma seed and J allocation', () => {
  for (const n of [0, 1, 4, 257, 258]) {
    for (const key of ['nodes', 'slots', 'structuralBytes'] as const) {
      const cost = key === 'nodes' ? 1 : key === 'slots' ? n : 16 + 4 * n;
      for (const difference of cost === 0 ? [0, 1] : [-1, 0, 1]) {
        it(`J(${n}) ${key} allowance ${difference} before actual native-slot debit`, () => {
          const base = createBudgetContext({ now: () => 0 });
          let reached = false, successor = false, caught: unknown;
          const stop = new Error('J work after allocation');
          const budget: BudgetContext = { ...base, spend(amount = 1) {
            if (reached) { successor = true; throw stop; }
            base.spend(amount);
          } };
          const probe = completionProbe((marker, value) => {
            if (marker === 'relationalGraph:init:u') {
              reached = true;
              base.reserve({ [key]: base.limits[key] - base.usage()[key] - cost - difference });
            }
            return value;
          });
          const graph = probe.parseRegisteredBoundedJson('[' + Array(n).fill('null').join(',') + ']', budget) as object;
          const before = base.usage();
          try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
          expect(reached).toBe(true);
          if (difference < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(successor).toBe(false); }
          else {
            expect(caught).toBe(stop); expect(successor).toBe(true);
            expect(base.limits[key] - base.usage()[key]).toBe(difference);
            for (const other of ['nodes', 'slots', 'structuralBytes'] as const) {
              if (other !== key) expect(base.usage()[other] - before[other]).toBe(other === 'nodes' ? 1 : other === 'slots' ? n : 16 + 4 * n);
            }
          }
        });
      }
    }
  }
  for (const side of ['left', 'right'] as const) {
    for (const c of [2, 3, 4]) {
      it(`${side} actual comma seed3 at C=${c} caps before J allocation/work`, () => {
        let reached = false, successor = false;
        const base = createBudgetContext({ now: () => 0 });
        const stop = new Error('seed cap successor');
        const budget: BudgetContext = { ...base,
          get limits() { return reached ? { ...base.limits, stringBytes: c } : base.limits; },
          reserve(cost) { if (reached) { successor = true; throw stop; } base.reserve(cost); },
          spend(amount = 1) { if (reached) { successor = true; throw stop; } base.spend(amount); },
        };
        const probe = completionProbe((marker, value) => { if (marker === 'relationalGraph:init:u') reached = true; return value; });
        const graph = probe.parseRegisteredBoundedJson('[null,null,null,null]', budget);
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
        expect(reached).toBe(true);
        if (c < 3) { expect(successor).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError); }
        else { expect(successor).toBe(true); expect(caught).toBe(stop); }
      });
    }
  }
  for (const limit of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    it(`private malformed C limit ${String(limit)} refuses before J consumer`, () => {
      let reached = false, successor = false;
      const base = createBudgetContext({ now: () => 0 });
      const stop = new Error('J consumer');
      const budget: BudgetContext = { ...base,
        get limits() { return reached ? { ...base.limits, stringBytes: limit } : base.limits; },
        reserve(cost) { if (reached) { successor = true; throw stop; } base.reserve(cost); },
        spend(amount = 1) { if (reached) { successor = true; throw stop; } base.spend(amount); },
      };
      const probe = completionProbe((marker, value) => { if (marker === 'relationalGraph:init:u') reached = true; return value; });
      const graph = probe.parseRegisteredBoundedJson('[]', budget) as object;
      let caught: unknown;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(successor).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});

describe('relational B.4 J work and seed supplemental controls', () => {
  // Work was exposed in 003 before count/seed/J guards. These are additional
  // boundary controls, not retroactively claimed RED for those guards.
  for (const side of ['left', 'right'] as const) {
    for (const n of [0, 1, 2, 256, 257, 258, 513, 514]) {
      const cost = n + (n < 2 ? 0 : Math.ceil((n - 1) / 256));
      for (const difference of cost === 0 ? [0, 1] : [-1, 0, 1]) {
        it(`${side} J(${n}) native slot plus comma work ${cost} allowance ${difference}`, () => {
          const budget = createBudgetContext({ now: () => 0 });
          let reached = false, successor = false, caught: unknown;
          const stop = new Error('post-J pending boundary');
          const probe = completionProbe((marker, value) => {
            if (marker === 'relationalGraph:init:u') {
              reached = true;
              budget.spend(budget.limits.work - budget.usage().work - cost - difference);
            }
            return value;
          });
          // Empty arrays now reach M: stop at its first result reservation.
          // Nonempty arrays now stop at the next spend entry, immediately after J.
          // The old catch is no longer adjacent to J. Allowances stay fixed.
          const originalCheck = budget.check;
          const expectedWork = budget.limits.work - difference;
          const wrapped: BudgetContext = { ...budget, spend(amount = 1) {
            if (n > 0 && reached && budget.usage().work === expectedWork) { successor = true; throw stop; }
            budget.spend(amount);
          }, reserveString(bytes) {
            if (n === 0 && reached && budget.usage().work === expectedWork) { successor = true; throw stop; }
            budget.reserveString(bytes);
          }, check() {
            originalCheck();
            if (reached && budget.usage().work === expectedWork) { successor = true; throw stop; }
          } };
          const graph = probe.parseRegisteredBoundedJson('[' + Array(n).fill('null').join(',') + ']', wrapped);
          try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', wrapped); } catch (error) { caught = error; }
          expect(reached).toBe(true);
          if (difference < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(successor).toBe(false); }
          else { expect(successor).toBe(true); expect(caught).toBe(stop); expect(budget.limits.work - budget.usage().work).toBe(difference); }
        });
      }
    }
  }
  for (const n of [0, 1]) {
    it(`J(${n}) zero comma seed accepts C0 with zero content and positive J node/header`, () => {
      let reached = false;
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, get limits() { return reached ? { ...base.limits, stringBytes: 0 } : base.limits; } };
      const probe = completionProbe((marker, value) => { if (marker === 'relationalGraph:init:u') reached = true; return value; });
      const graph = probe.parseRegisteredBoundedJson(n === 0 ? '[]' : '[null]', budget) as object;
      const before = base.usage();
      const metadata = { ...metadataInitial, outU: 101, outB: 103, outText: true };
      expect(() => probe.graph(graph, budget, metadata, 1)).not.toThrow();
      expect(reached).toBe(true);
      expect(base.usage().contentBytes - before.contentBytes).toBe(0);
      expect(base.usage().nodes - before.nodes).toBe(3);
      expect(base.usage().structuralBytes - before.structuralBytes).toBe(16 + 4 * n + 20);
      // Both completed arrays now publish their zero-text bound after M.
      expect(metadata).toEqual({ ...metadataInitial, outU: 0, outB: 0, outText: true });
    });
  }
  for (const u of [7_999_999, 8_000_000, 8_000_001]) {
    it(`private comma capacity U=${u} applies hard8m before real J, not natural graph registration`, () => {
      let reached = false, successor = false;
      const base = createBudgetContext({ now: () => 0 });
      const stop = new Error('hard cap successor J');
      const budget: BudgetContext = { ...base,
        get limits() { return { ...base.limits, stringBytes: Number.MAX_SAFE_INTEGER }; },
        reserve(cost) { if (reached) { successor = true; throw stop; } base.reserve(cost); },
      };
      const probe = completionProbe((marker, value) => { if (marker === 'relationalGraph:init:u') { reached = true; return u; } return value; });
      const graph = probe.parseRegisteredBoundedJson('[]', budget) as object;
      let caught: unknown;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true);
      if (u > 8_000_000) { expect(successor).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError); }
      else { expect(successor).toBe(true); expect(caught).toBe(stop); }
    });
  }
  for (const seam of ['J reserve', 'J work'] as const) {
    for (const mode of ['timely', 'expired', 'aborted'] as const) {
      for (const outcome of ['success', 'ordinary', 'range', 'exceeded', 'unavailable'] as const) {
        it(`private ${seam} ${mode}/${outcome} retains graph-owned catch without escaped bounds`, () => {
          let clock = 0, armed = false, reached = false, completedWork = 0;
          const signal = { aborted: false };
          const base = createBudgetContext({ now: () => clock, signal });
          const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
            : outcome === 'range' ? new RangeError('J ordinary boundary') : new Error('J ordinary boundary');
          const boundary = () => {
            reached = true;
            if (mode === 'expired') clock = 5000;
            if (mode === 'aborted') signal.aborted = true;
            if (outcome !== 'success') throw sentinel;
          };
          const budget: BudgetContext = { ...base,
            reserve(cost) { base.reserve(cost); if (armed && seam === 'J reserve') boundary(); },
            spend(amount = 1) { base.spend(amount); if (armed) { completedWork++; if (seam === 'J work') boundary(); } },
          };
          const probe = completionProbe((marker, value) => { if (marker === 'relationalGraph:init:u') armed = true; return value; });
          const graph = probe.parseRegisteredBoundedJson('[null,null]', budget) as object;
          const metadata = { ...metadataInitial, outU: 101, outB: 103, outText: true };
          let caught: unknown, returned = false;
          try { probe.graph(graph, budget, metadata, 1); returned = true; } catch (error) { caught = error; }
          expect(reached).toBe(true); expect(returned).toBe(mode === 'timely' && outcome === 'success');
          expect(metadata).toEqual(mode === 'timely' && outcome === 'success'
            ? { ...metadataInitial, outU: 1, outB: 1, outText: true } // completed two-null parent
            : { ...metadataInitial, outU: 101, outB: 103, outText: true });
          if (seam === 'J reserve' && (mode !== 'timely' || outcome !== 'success')) expect(completedWork).toBe(0);
          if (outcome === 'exceeded' || outcome === 'unavailable' || (mode === 'timely' && outcome !== 'success')) expect(caught).toBe(sentinel);
          else if (mode !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
          else expect(caught).toBeUndefined();
        });
      }
    }
  }
});


// M probes expose declarations only in memory, sharing the real module registry.
function materializationProbe(observe: (name: string) => void = () => {}, observeAmount: (value: number) => void = () => {},
  observeGraph: (marker: 'entry' | 'return', metadata: RelationalMetadataProbe) => void = () => {}) {
  let source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  source = source.replace(/(function relationalMaterialize\([^)]*\): void \{)/, '$1\n__materialization("entry");');
  source = source.replace('function relationalAmount(value: number): void {', 'function relationalAmount(value: number): void {\n__materialization("amount", value);');
  source += '\nconst __realMGraph = relationalGraph; relationalGraph = (...args) => { __graphObserve("entry", args[2]); const result = __realMGraph(...args); __graphObserve("return", args[2]); return result; };';
  source += '\nexports.materialize = typeof relationalMaterialize === "function" ? relationalMaterialize : undefined; exports.graph = relationalGraph;';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json & {
    materialize: (u: number, b: number, budget: BudgetContext) => void;
    graph: (input: object, budget: BudgetContext, metadata: RelationalMetadataProbe, depth: number) => void;
  };
  new Function('exports', 'require', '__materialization', '__graphObserve', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected M dependency ${id}`);
    return relationalWork;
  }, (name: string, value: number) => { if (name === 'entry') observe(name); else observeAmount(value); }, observeGraph);
  return exports;
}

describe('relational M declaration and genuine record consumer', () => {
  it('declares private callable M (declaration evidence only)', () => {
    expect(materializationProbe().materialize).toBeTypeOf('function');
  });
});


describe('relational M genuine work consumer (not allocation protection RED)', () => {
  for (const side of ['left', 'right'] as const) it(`${side} real registered record enters M and consumes fixed/copy/flatten work`, () => {
    let entered = false;
    const work: number[] = [];
    const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base, spend(amount = 1) { if (entered) work.push(amount); base.spend(amount); } };
    const probe = materializationProbe(() => { entered = true; });
    const graph = probe.parseRegisteredBoundedJson('{}', budget);
    expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget)).not.toThrow();
    // Existing observed M/W prefix, then P0=1, ordered R15=8/R0=4, final2.
    expect(entered).toBe(true); expect(work).toEqual(side === 'left' ? [4, 1, 1, 0, 1, 8, 4, 2] : [4, 1, 4, 8, 2]);
  });
});


describe('relational M reached ordered caps and allocation before work', () => {
  for (const [u, b] of [[0, 0], [1, 3], [15, 15], [257, 771]]) {
    for (const key of ['nodes', 'contentBytes', 'structuralBytes', 'slots'] as const) {
      const cost = key === 'nodes' ? 2 : key === 'contentBytes' ? b : key === 'structuralBytes' ? 20 + 2 * u : 0;
      for (const delta of cost === 0 ? [0, 1] : [-1, 0, 1]) it(`M(${u},${b}) ${key} allowance ${delta} before represented work`, () => {
        let entered = false, successor = false, caught: unknown;
        const stop = new Error('M actual work successor');
        const base = createBudgetContext({ now: () => 0 });
        const budget: BudgetContext = { ...base, spend() { successor = true; throw stop; } };
        base.reserve({ [key]: base.limits[key] - cost - delta });
        const before = base.usage();
        const probe = materializationProbe(() => { entered = true; });
        try { probe.materialize(u, b, budget); } catch (error) { caught = error; }
        expect(entered).toBe(true);
        if (delta < 0) { expect(successor).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError); }
        else {
          expect(successor).toBe(true); expect(caught).toBe(stop);
          expect(base.limits[key] - base.usage()[key]).toBe(delta);
          for (const other of ['nodes', 'contentBytes', 'structuralBytes', 'slots'] as const) if (other !== key) {
            expect(base.usage()[other] - before[other]).toBe(other === 'nodes' ? 2 : other === 'contentBytes' ? b : other === 'structuralBytes' ? 20 + 2 * u : 0);
          }
        }
      });
    }
  }
  for (const field of ['u', 'b', 'limit'] as const) {
    for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 14, 15, 16]) {
      it(`private M ${field}=${String(amount)} validated/capped before real work`, () => {
        let entered = false, successor = false, caught: unknown;
        const stop = new Error('M cap successor');
        const base = createBudgetContext({ now: () => 0 });
        const budget: BudgetContext = { ...base,
          limits: { ...base.limits, stringBytes: field === 'limit' ? amount : 15 },
          reserveString() { successor = true; throw stop; },
          reserve() { successor = true; throw stop; },
          spend() { successor = true; throw stop; },
        };
        const probe = materializationProbe(() => { entered = true; });
        try { probe.materialize(field === 'u' ? amount : 15, field === 'b' ? amount : 15, budget); } catch (error) { caught = error; }
        const valid = Number.isSafeInteger(amount) && amount >= 0 && (field === 'limit' ? amount >= 15 : amount <= 15);
        expect(entered).toBe(true); expect(successor).toBe(valid);
        if (valid) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
      });
    }
  }
  for (const field of ['u', 'b'] as const) for (const amount of [7_999_999, 8_000_000, 8_000_001]) {
    it(`private M hard ceiling ${field}=${amount} before allocation (not natural registration)`, () => {
      let entered = false, successor = false, caught: unknown;
      const stop = new Error('M hard-cap successor');
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, limits: { ...base.limits, stringBytes: Number.MAX_SAFE_INTEGER },
        reserveString() { successor = true; throw stop; }, reserve() { successor = true; throw stop; }, spend() { successor = true; throw stop; } };
      const probe = materializationProbe(() => { entered = true; });
      try { probe.materialize(field === 'u' ? amount : 0, field === 'b' ? amount : 0, budget); } catch (error) { caught = error; }
      expect(entered).toBe(true); expect(successor).toBe(amount <= 8_000_000);
      if (amount <= 8_000_000) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational M own completion and error boundary', () => {
  for (const seam of ['string', 'F', 'work'] as const) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['success', 'ordinary', 'range', 'exceeded', 'unavailable'] as const) {
      it(`direct M ${seam} ${mode}/${outcome} owns local exit without outer graph check`, () => {
        let clock = 0, reached = false, returned = false, completedF = 0, completedWork = 0;
        const signal = { aborted: false };
        const base = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
          : outcome === 'range' ? new RangeError('M ordinary exit') : new Error('M ordinary exit');
        const boundary = () => {
          reached = true;
          if (mode === 'expired') clock = 5000;
          if (mode === 'aborted') signal.aborted = true;
          if (outcome !== 'success') throw sentinel;
        };
        const budget: BudgetContext = { ...base,
          reserveString(bytes) { base.reserveString(bytes); if (seam === 'string') boundary(); },
          reserve(cost) { base.reserve(cost); completedF++; if (seam === 'F') boundary(); },
          spend(amount = 1) { base.spend(amount); completedWork++; if (seam === 'work') boundary(); },
        };
        let caught: unknown;
        try { materializationProbe().materialize(15, 15, budget); returned = true; } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(returned).toBe(mode === 'timely' && outcome === 'success');
        if (outcome === 'exceeded' || outcome === 'unavailable' || (mode === 'timely' && outcome !== 'success')) expect(caught).toBe(sentinel);
        else if (mode !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
        else expect(caught).toBeUndefined();
        if (mode !== 'timely' || outcome !== 'success') {
          if (seam === 'string') expect(completedF).toBe(0);
          if (seam !== 'work') expect(completedWork).toBe(0);
        }
      });
    }
  }
});

describe('relational M inherited work consumer supplemental controls', () => {
  for (const u of [0, 1, 255, 256, 257, 511, 512, 513]) for (const b of [0, 771]) {
    const cost = 2 + 2 * Math.ceil(u / 256);
    for (const delta of [-1, 0, 1]) it(`M U${u}/B${b} work allowance ${delta} uses U blocks not B`, () => {
      let entered = false, returned = false, caught: unknown;
      const base = createBudgetContext({ now: () => 0, limits: { work: cost + delta } });
      const probe = materializationProbe(() => { entered = true; });
      try { probe.materialize(u, b, base); returned = true; } catch (error) { caught = error; }
      expect(entered).toBe(true); expect(returned).toBe(delta >= 0);
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
      else expect(base.usage()).toEqual({ nodes: 2, slots: 0, contentBytes: b, structuralBytes: 20 + 2 * u, work: cost });
    });
  }
  it('orders result occurrence then F then fixed2 plus output-copy-q and flatten-q', () => {
    const trace: unknown[] = [];
    const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base,
      reserveString(b) { trace.push(['string', b]); base.reserveString(b); },
      reserve(cost) { trace.push(['F', cost]); base.reserve(cost); },
      spend(amount = 1) { trace.push(['work', amount]); base.spend(amount); },
    };
    materializationProbe().materialize(257, 771, budget);
    expect(trace).toEqual([['string', 771], ['F', { nodes: 1, structuralBytes: 530 }], ['work', 6]]);
  });
});


describe('relational record15 reached caps before genuine M', () => {
  for (const side of ['left', 'right'] as const) for (const cap of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 14, 15, 16]) {
    it(`${side} fixed U=B15 at C${String(cap)} stops before M entry`, () => {
      let armed = false, entered = false, dispatch = false, caught: unknown;
      const stop = new Error('record15 M entry');
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base,
        get limits() { return armed ? { ...base.limits, stringBytes: cap } : base.limits; },
        spend(amount = 1) { base.spend(amount); if (armed && amount === 4) dispatch = true; },
      };
      const probe = materializationProbe(() => { entered = true; throw stop; });
      const graph = probe.parseRegisteredBoundedJson('{}', budget);
      armed = true;
      // A scalar zero on the other side does not need a string ceiling.
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : 0, side === 'right' ? graph : 0, budget); } catch (error) { caught = error; }
      const valid = Number.isSafeInteger(cap) && cap >= 15;
      expect(dispatch).toBe(true); expect(entered).toBe(valid);
      if (valid) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational record15 genuine output consumer', () => {
  for (const kind of ['ordinary', 'null-prototype', 'shadow valueOf', 'shadow both'] as const) {
    it(`${kind} completes private record W with literal15 bounds and no field traversal`, () => {
      let entered = false;
      const probe = materializationProbe(() => { entered = true; });
      const budget = createBudgetContext({ now: () => 0 });
      const text = kind === 'shadow valueOf' ? '{"valueOf":[[1]]}' : kind === 'shadow both' ? '{"valueOf":[],"toString":{"nested":[1,2]}}' : '{}';
      const parsed = probe.parseRegisteredBoundedJson(text, budget) as object;
      const graph = kind === 'null-prototype' ? probe.cloneFreezeBoundedJson(parsed, budget) : parsed;
      expect(Object.getPrototypeOf(graph) === null).toBe(kind === 'null-prototype');
      const metadata = { ...metadataInitial, outU: 101, outB: 103, outText: false };
      const before = budget.usage();
      let caught: unknown, returned = false;
      try { probe.graph(graph, budget, metadata, 1); returned = true; } catch (error) { caught = error; }
      expect(entered).toBe(true); expect(caught).toBeUndefined(); expect(returned).toBe(true);
      expect(metadata).toEqual({ ...metadataInitial, outU: 15, outB: 15, outText: true });
      expect((['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const).map(key => budget.usage()[key] - before[key])).toEqual([2, 0, 15, 50, 10]);
    });
  }
});


describe('relational record15 reached own successful output exit', () => {
  for (const mode of ['timely', 'expired', 'aborted'] as const) for (const outcome of ['success', 'ordinary', 'range', 'exceeded', 'unavailable'] as const) {
    it(`private output assignment ${mode}/${outcome} checks before graph return`, () => {
      let clock = 0, reached = false, returned = false;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => clock, signal });
      const probe = materializationProbe();
      const graph = probe.parseRegisteredBoundedJson('{}', budget) as object;
      const metadata = { ...metadataInitial };
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
        : outcome === 'range' ? new RangeError('record output') : new Error('record output');
      // Private metadata boundary sentinel, not admitted user getters or a certificate.
      Object.defineProperty(metadata, 'outText', { set() {
        reached = true;
        if (mode === 'expired') clock = 5000;
        if (mode === 'aborted') signal.aborted = true;
        if (outcome !== 'success') throw sentinel;
      } });
      let caught: unknown;
      try { probe.graph(graph, budget, metadata, 1); returned = true; } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(returned).toBe(mode === 'timely' && outcome === 'success');
      if (outcome === 'exceeded' || outcome === 'unavailable' || (mode === 'timely' && outcome !== 'success')) expect(caught).toBe(sentinel);
      else if (mode !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
      else expect(caught).toBeUndefined();
    });
  }
});


describe('relational record15 complete subgroup supplemental acceptance', () => {
  for (const side of ['left', 'right'] as const) for (const kind of ['ordinary', 'null-prototype', 'shadow valueOf', 'shadow both'] as const) {
    it(`${side} ${kind} preserves actual frozen Git comparator outcome without completing public helper`, () => {
      const compare = originalComparator();
      let entries = 0;
      const probe = materializationProbe(() => { entries++; });
      const budget = createBudgetContext({ now: () => 0 });
      const text = kind === 'shadow valueOf' ? '{"valueOf":[]}' : kind === 'shadow both' ? '{"valueOf":[],"toString":{}}' : '{}';
      const parsed = probe.parseRegisteredBoundedJson(text, budget) as object;
      const graph = kind === 'null-prototype' ? probe.cloneFreezeBoundedJson(parsed, budget) : parsed;
      const left = side === 'left' ? graph : 'z', right = side === 'right' ? graph : 'z';
      const outcome = () => { try { return { result: compare(left, right) }; } catch (error) { return { error: (error as Error).name, message: (error as Error).message }; } };
      const original = outcome();
      const before = budget.usage();
      expect(() => probe.reserveBoundedJsonRelational(left, right, budget)).not.toThrow();
      expect(entries).toBe(1);
      // Complete independent L; preserved historical test name and native oracle.
      expect((['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const).map(key => budget.usage()[key] - before[key])).toEqual(ledger(left, right).total);
      expect(outcome()).toEqual(original);
      if (kind === 'ordinary' || kind === 'shadow valueOf') expect(original).toEqual({ result: side === 'left' ? -1 : 1 });
      else expect(original.error).toBe('TypeError');
    });
  }
  it('same record twice pays two complete W occurrences but one pair arena, on every fresh preparation', () => {
    let entries = 0;
    const probe = materializationProbe(() => { entries++; });
    const budget = createBudgetContext({ now: () => 0 });
    const graph = probe.parseRegisteredBoundedJson('{}', budget);
    for (let pass = 0; pass < 2; pass++) {
      const before = budget.usage();
      expect(() => probe.reserveBoundedJsonRelational(graph, graph, budget)).not.toThrow();
      expect((['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const).map(key => budget.usage()[key] - before[key])).toEqual(ledger(graph, graph).total);
      expect(entries).toBe((pass + 1) * 2);
    }
  });
  for (const side of ['left', 'right'] as const) for (const key of ['nodes', 'contentBytes', 'structuralBytes', 'work'] as const) {
    const cost = key === 'nodes' ? 2 : key === 'contentBytes' ? 15 : key === 'structuralBytes' ? 50 : 4;
    for (const delta of [-1, 0, 1]) it(`${side} real record M ${key} shortage/exact/plus ${delta}`, () => {
      let entered = false, completed = false, caught: unknown;
      const base = createBudgetContext({ now: () => 0 });
      const stop = new Error('record M work finished');
      const budget: BudgetContext = { ...base, check() {
        base.check();
        if (entered && base.usage().work === expectedWork) { completed = true; throw stop; }
      } };
      let expectedWork = -1;
      const probe = materializationProbe(() => {
        entered = true;
        const rest = base.limits[key] - base.usage()[key] - cost - delta;
        if (key === 'work') base.spend(rest); else base.reserve({ [key]: rest });
        expectedWork = base.usage().work + 4;
      });
      const graph = probe.parseRegisteredBoundedJson('{}', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : 0, side === 'right' ? graph : 0, budget); } catch (error) { caught = error; }
      expect(entered).toBe(true); expect(completed).toBe(delta >= 0);
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
      else { expect(caught).toBe(stop); expect(base.limits[key] - base.usage()[key]).toBe(delta); }
    });
  }
});


describe('relational M ordered validation supplemental controls', () => {
  for (const [u, b, expected] of [[13, 14, [13, 12]], [11, 13, [11, 12, 13]]] as const) {
    it(`U${u}/B${b} validates and caps U before validating B`, () => {
      const amounts: number[] = [];
      let entered = false, successor = false;
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, limits: { ...base.limits, stringBytes: 12 },
        reserveString() { successor = true; }, reserve() { successor = true; }, spend() { successor = true; } };
      const probe = materializationProbe(() => { entered = true; }, value => { amounts.push(value); });
      expect(() => probe.materialize(u, b, budget)).toThrow(BudgetExceededError);
      expect(entered).toBe(true); expect(successor).toBe(false); expect(amounts).toEqual(expected);
    });
  }
  for (const seam of ['string', 'F'] as const) for (const u of [0, 15]) {
    for (const key of ['nodes', 'contentBytes', 'structuralBytes'] as const) {
      const cost = key === 'nodes' ? 1 : key === 'contentBytes' ? (seam === 'string' ? u : 0) : seam === 'string' ? 4 : 16 + 2 * u;
      for (const delta of cost ? [-1, 0, 1] : [0, 1]) it(`${seam}(${u}) independent ${key} allowance ${delta} before next actual consumer`, () => {
        let entered = false, successor = false, caught: unknown;
        const stop = new Error('next M consumer');
        const base = createBudgetContext({ now: () => 0 });
        const exhaust = () => base.reserve({ [key]: base.limits[key] - base.usage()[key] - cost - delta });
        const budget: BudgetContext = { ...base,
          reserveString(bytes) { if (seam === 'string') { entered = true; exhaust(); } base.reserveString(bytes); },
          reserve(cost) {
            if (seam === 'string') { successor = true; throw stop; }
            entered = true; exhaust(); base.reserve(cost);
          },
          spend() { successor = true; throw stop; },
        };
        try { materializationProbe().materialize(u, u, budget); } catch (error) { caught = error; }
        expect(entered).toBe(true); expect(successor).toBe(delta >= 0);
        if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
        else { expect(caught).toBe(stop); expect(base.limits[key] - base.usage()[key]).toBe(delta); }
      });
    }
  }
});


describe('relational record15 both-root local exit supplemental matrix', () => {
  for (const side of ['left', 'right'] as const) for (const seam of ['string', 'F', 'work', 'output'] as const) {
    for (const mode of ['timely', 'expired', 'aborted'] as const) for (const outcome of ['success', 'ordinary', 'range', 'exceeded', 'unavailable'] as const) {
      it(`${side} record ${seam} ${mode}/${outcome} forbids graph escape before intact public boundary`, () => {
        let clock = 0, armed = false, reached = false, graphReturned = false, publicReturned = false;
        const signal = { aborted: false };
        const base = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
          : outcome === 'range' ? new RangeError('record root boundary') : new Error('record root boundary');
        const boundary = () => {
          reached = true;
          if (mode === 'expired') clock = 5000;
          if (mode === 'aborted') signal.aborted = true;
          if (outcome !== 'success') throw sentinel;
        };
        const budget: BudgetContext = { ...base,
          reserveString(bytes) { base.reserveString(bytes); if (armed && seam === 'string') boundary(); },
          reserve(cost) { base.reserve(cost); if (armed && seam === 'F') boundary(); },
          spend(amount = 1) { base.spend(amount); if (armed && seam === 'work' && !reached) boundary(); },
        };
        const probe = materializationProbe(() => { armed = true; }, () => {}, (marker, metadata) => {
          if (marker === 'return') graphReturned = true;
          if (marker === 'entry' && seam === 'output') {
            Object.defineProperty(metadata, 'outText', { configurable: true, set(value: boolean) {
              Object.defineProperty(metadata, 'outText', { configurable: true, writable: true, value });
              boundary();
            } });
          }
        });
        const graph = probe.parseRegisteredBoundedJson('{}', budget);
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : 0, side === 'right' ? graph : 0, budget); publicReturned = true; } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(publicReturned).toBe(mode === 'timely' && outcome === 'success');
        expect(graphReturned).toBe(mode === 'timely' && outcome === 'success');
        if (outcome === 'exceeded' || outcome === 'unavailable' || (mode === 'timely' && outcome !== 'success')) expect(caught).toBe(sentinel);
        else if (mode !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
        else expect(caught).toBeUndefined();
      });
    }
  }
});


// New physical S1 restart: these assertions are first executed with callable M's
// spend absent. Prior supplemental controls above retain their original labels.
describe('relational M S1 chronological work restart', () => {
  // Literal independent recipes: U, B, fixed dispatch, copy q(U), flatten q(U).
  // Private capacity probes do not claim these U/B pairs are record outputs.
  const recipes = [[0, 771, 2, 0, 0], [1, 0, 2, 1, 1], [255, 771, 2, 1, 1],
    [256, 0, 2, 1, 1], [257, 0, 2, 2, 2], [257, 771, 2, 2, 2]] as const;
  for (const [u, b, fixed, copy, flatten] of recipes) {
    for (const component of ['fixed2', 'copy-q', 'flatten-q'] as const) {
      const selected = component === 'fixed2' ? fixed : component === 'copy-q' ? copy : flatten;
      const other = component === 'fixed2' ? copy + flatten : component === 'copy-q' ? fixed + flatten : fixed + copy;
      for (const delta of selected === 0 ? [0, 1] : [-1, 0, 1]) {
        it(`S1 direct U${u}/B${b} ${component} allowance ${delta} owns local return`, () => {
          let entered = false, allocated = false, returned = false, successor = false, caught: unknown;
          const base = createBudgetContext({ now: () => 0 });
          const allowance = other + selected + delta;
          base.spend(base.limits.work - allowance);
          const budget: BudgetContext = { ...base,
            reserve(cost) { base.reserve(cost); allocated = true; },
          };
          const probe = materializationProbe(() => { entered = true; });
          try { probe.materialize(u, b, budget); returned = true; successor = true; } catch (error) { caught = error; }
          expect(entered).toBe(true); expect(allocated).toBe(true);
          expect(returned).toBe(delta >= 0); expect(successor).toBe(delta >= 0);
          if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
          else {
            expect(caught).toBeUndefined();
            expect(base.limits.work - base.usage().work).toBe(delta);
          }
        });
      }
    }
  }
  for (const side of ['left', 'right'] as const) for (const delta of [-1, 0, 1]) {
    it(`S1 ${side} genuine record M fixed2/copy1/flatten1 allowance ${delta} before graph return`, () => {
      let entered = false, allocated = false, successor = false, caught: unknown;
      const stop = new Error('S1 admitted graph return; stop before remaining root/public refusal');
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base,
        reserve(cost) { base.reserve(cost); if (entered) allocated = true; },
      };
      const probe = materializationProbe(() => {
        entered = true;
        base.spend(base.limits.work - base.usage().work - (2 + 1 + 1 + delta));
      }, () => {}, (marker) => {
        if (entered && marker === 'return') { successor = true; throw stop; }
      });
      const record = probe.parseRegisteredBoundedJson('{}', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? record : '', side === 'right' ? record : '', budget); }
      catch (error) { caught = error; }
      expect(entered).toBe(true); expect(allocated).toBe(true);
      expect(successor).toBe(delta >= 0);
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
      else { expect(caught).toBe(stop); expect(base.limits.work - base.usage().work).toBe(delta); }
    });
  }
});


describe('relational empty array real M consumer checkpoint', () => {
  for (const side of ['left', 'right'] as const) it(`${side} empty array reaches its own M before retained public suffix refusal`, () => {
    let entered = 0;
    const budget = createBudgetContext({ now: () => 0 });
    const probe = materializationProbe(() => { entered++; });
    const array = probe.parseRegisteredBoundedJson('[]', budget);
    expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? array : '', side === 'right' ? array : '', budget)).not.toThrow();
    expect(entered).toBe(1);
  });
});


describe('relational empty array caller cap before real M', () => {
  for (const side of ['left', 'right'] as const) for (const limit of [-1, 0.5, NaN, Infinity, 0, 1]) {
    it(`${side} private post-J limit ${String(limit)} is validated before M entry`, () => {
      let armed = false, predecessor = false, entered = false, caught: unknown;
      const base = createBudgetContext({ now: () => 0 });
      const limits = { ...base.limits };
      const stop = new Error('empty caller M entry');
      const budget: BudgetContext = { ...base, limits,
        spend(amount = 1) {
          base.spend(amount);
          if (armed && amount === 0) { predecessor = true; limits.stringBytes = limit; }
        },
      };
      const probe = materializationProbe(() => { entered = true; throw stop; });
      const array = probe.parseRegisteredBoundedJson('[]', budget);
      armed = true;
      try { probe.reserveBoundedJsonRelational(side === 'left' ? array : 0, side === 'right' ? array : 0, budget); }
      catch (error) { caught = error; }
      const valid = Number.isSafeInteger(limit) && limit >= 0;
      expect(predecessor).toBe(true); expect(entered).toBe(valid);
      if (valid) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational empty array output consumer', () => {
  it('completed empty M publishes zero bounds and text true at the real graph return', () => {
    let materializations = 0, returns = 0;
    const probe = materializationProbe(() => { materializations++; }, undefined, marker => { if (marker === 'return') returns++; });
    const budget = createBudgetContext({ now: () => 0 });
    const array = probe.parseRegisteredBoundedJson('[]', budget) as object;
    const metadata = { ...metadataInitial, outU: 101, outB: 103 };
    expect(() => probe.graph(array, budget, metadata, 1)).not.toThrow();
    expect(materializations).toBe(1); expect(returns).toBe(1);
    expect(metadata).toEqual({ ...metadataInitial, outU: 0, outB: 0, outText: true });
  });
});


describe('relational empty array owned output return boundary', () => {
  for (const mode of ['timely', 'expired', 'aborted'] as const) for (const outcome of ['success', 'ordinary', 'range', 'exceeded', 'unavailable'] as const) {
    it(`${mode}/${outcome} final output assignment forbids late graph return with outer checks retained`, () => {
      let clock = 0, assigned = false, returned = false, caught: unknown;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => clock, signal });
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
        : outcome === 'range' ? new RangeError('empty output') : new Error('empty output');
      const probe = materializationProbe(undefined, undefined, marker => { if (marker === 'return') returned = true; });
      const array = probe.parseRegisteredBoundedJson('[]', budget) as object;
      const metadata = { ...metadataInitial };
      Object.defineProperty(metadata, 'outText', { set(value) {
        expect(value).toBe(true); assigned = true;
        if (mode === 'expired') clock = 5000;
        if (mode === 'aborted') signal.aborted = true;
        if (outcome !== 'success') throw sentinel;
      } });
      try { probe.graph(array, budget, metadata, 1); budget.check(); } catch (error) { caught = error; }
      expect(assigned).toBe(true); expect(returned).toBe(mode === 'timely' && outcome === 'success');
      if (outcome === 'exceeded' || outcome === 'unavailable' || (mode === 'timely' && outcome !== 'success')) expect(caught).toBe(sentinel);
      else if (mode !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
      else expect(caught).toBeUndefined();
    });
  }
});


// Private post-J state injection is not a naturally registered oversized array.
// The same actual module still admits the empty array and owns all M operations.
function emptyStateProbe(state: number, observeM: () => void) {
  let source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  source = source.replace('const u = relationalCommas(count);', 'let u = relationalCommas(count);');
  source = source.replace('budget.spend(relationalAdd(count, relationalBlocks(u)));', 'budget.spend(relationalAdd(count, relationalBlocks(u))); u = __state;');
  source = source.replace(/(function relationalMaterialize\([^)]*\): void \{)/, '$1\n__observeM();');
  source += '\nexports.graph = relationalGraph;';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json & { graph: (input: object, budget: BudgetContext, metadata: RelationalMetadataProbe, depth: number) => void };
  new Function('exports', 'require', '__state', '__observeM', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected empty-state dependency ${id}`);
    return relationalWork;
  }, state, observeM);
  return exports;
}

describe('relational empty array private result cap caller', () => {
  for (const state of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, 1, 2]) {
    it(`private post-J U=B=${String(state)} validates and caps before actual M entry`, () => {
      let entered = false, caught: unknown;
      const stop = new Error('empty result caller M');
      const probe = emptyStateProbe(state, () => { entered = true; throw stop; });
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, limits: { ...base.limits, stringBytes: 1 } };
      const array = probe.parseRegisteredBoundedJson('[]', budget) as object;
      try { probe.graph(array, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      const valid = Number.isSafeInteger(state) && state >= 0 && state <= 1;
      expect(entered).toBe(valid);
      if (valid) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


// ELEMENT32 private seam: the whole actual module retains its real M/scalar and
// registry. Observers/setters below are private instrumentation, not input data.
function element32Probe(observe: (marker: string, u?: number, b?: number) => void = () => {}, afterScalar = false) {
  let source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  source = source.replace(/(function relationalMaterialize\([^)]*\): void \{)/, '$1\n__observe("M", u, b);');
  source = source.replace(/(function relationalScalar\([^)]*\): void \{)/, '$1\n__observe("scalar");');
  if (afterScalar) source = source.replace('relationalScalar(input, budget, metadata);', 'relationalScalar(input, budget, metadata); __observe("scalar-return");');
  source += '\nexports.element = typeof relationalElement === "undefined" ? undefined : relationalElement;';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json & { element: (input: unknown, budget: BudgetContext, metadata: RelationalMetadataProbe) => void };
  new Function('exports', 'require', '__observe', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected element dependency ${id}`);
    return relationalWork;
  }, observe);
  return exports;
}

describe('relational ELEMENT32 declaration and consumer', () => {
  it('private callable declaration exists (not protection RED)', () => {
    expect(element32Probe().element).toBeTypeOf('function');
  });
});


describe('relational ELEMENT32 actual consumers', () => {
  for (const input of [0, -0, -3, 0.125, Number.MIN_VALUE, Number.MAX_VALUE, true, false]) {
    it(`numeric or boolean ${String(input)} genuinely completes real M32 and publishes bounds`, () => {
      const materialized: unknown[] = [];
      const probe = element32Probe((marker, u, b) => { if (marker === 'M') materialized.push([u, b]); });
      const budget = createBudgetContext({ now: () => 0 });
      const metadata = { ...metadataInitial };
      probe.element(input, budget, metadata);
      expect(materialized).toEqual([[32, 32]]);
      expect(metadata).toEqual({ ...metadataInitial, outU: 32, outB: 32, outText: true });
      // Existing M only at this consumer stage; visit is tested next.
      expect(budget.usage()).toMatchObject({ nodes: 2, slots: 0, contentBytes: 32, structuralBytes: 84 });
    });
  }
  for (const input of ['', '한😀\ud800', null, undefined]) {
    it(`string/nullish ${String(input)} delegates unchanged scalar without M`, () => {
      const events: string[] = [];
      const probe = element32Probe(marker => { events.push(marker); });
      const budget = createBudgetContext({ now: () => 0 });
      const metadata = { ...metadataInitial };
      probe.element(input, budget, metadata);
      expect(events).toEqual(['scalar']);
      const u = typeof input === 'string' ? input.length : 0;
      const b = input === '한😀\ud800' ? 10 : 0;
      expect(metadata).toEqual({ ...metadataInitial, outU: u, outB: b, outText: typeof input === 'string' });
      expect(budget.usage()).toEqual(typeof input === 'string'
        ? { nodes: 1, slots: 0, contentBytes: 0, structuralBytes: 16 + 2 * u, work: 2 + 2 * Math.ceil(u / 256) }
        : { nodes: 0, slots: 0, contentBytes: 0, structuralBytes: 0, work: 1 });
    });
  }
});


describe('relational ELEMENT32 visit work chronological guard', () => {
  for (const input of [1, true]) for (const delta of [-1, 0, 1]) {
    it(`${typeof input} visit1 allowance ${delta} before already-callable M`, () => {
      const base = createBudgetContext({ now: () => 0 });
      base.spend(base.limits.work - (1 + delta));
      let entered = false, returned = false, caught: unknown;
      const stop = new Error('visit admitted: stop at genuine M entry');
      const probe = element32Probe(marker => { if (marker === 'M') { entered = true; throw stop; } });
      try { probe.element(input, base, { ...metadataInitial }); returned = true; } catch (error) { caught = error; }
      expect(entered).toBe(delta >= 0); expect(returned).toBe(false);
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
      else { expect(caught).toBe(stop); expect(base.limits.work - base.usage().work).toBe(delta); }
    });
  }
});


describe('relational ELEMENT32 finite chronological guard', () => {
  for (const input of [NaN, Infinity, -Infinity]) it(`${String(input)} visit reaches numeric rejection before M or result`, () => {
    let visited = false, entered = false, returned = false, caught: unknown;
    const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base, spend(n = 1) { base.spend(n); visited = true; } };
    const probe = element32Probe(marker => { if (marker === 'M') entered = true; });
    const metadata = { ...metadataInitial };
    try { probe.element(input, budget, metadata); returned = true; } catch (error) { caught = error; }
    expect(visited).toBe(true); expect(entered).toBe(false); expect(returned).toBe(false);
    expect((caught as Error).message).toBe('Legacy bounded JSON is invalid.');
    expect(metadata).toEqual(metadataInitial);
  });
});


describe('relational ELEMENT32 caller limit validation chronological guard', () => {
  // Malformed context limits are private-state probes, not normal contexts.
  for (const input of [1, false]) for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it(`${typeof input} private limit ${String(limit)} rejects before M entry`, () => {
      let visited = false, entered = false, caught: unknown;
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, limits: { ...base.limits, stringBytes: limit }, spend(n = 1) { base.spend(n); visited = true; } };
      const probe = element32Probe(marker => { if (marker === 'M') entered = true; });
      try { probe.element(input, budget, { ...metadataInitial }); } catch (error) { caught = error; }
      expect(visited).toBe(true); expect(entered).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational ELEMENT32 fixed bounds cap chronological guard', () => {
  for (const input of [1, true]) for (const limit of [31, 32, 33]) {
    it(`${typeof input} fixed U=B32 cap ${limit} before M with unchanged inherited M caps`, () => {
      let visited = false, entered = false, caught: unknown;
      const base = createBudgetContext({ now: () => 0, limits: { stringBytes: limit } });
      const budget: BudgetContext = { ...base, spend(n = 1) { base.spend(n); visited = true; } };
      const stop = new Error('fixed bounds admitted M');
      const probe = element32Probe(marker => { if (marker === 'M') { entered = true; throw stop; } });
      try { probe.element(input, budget, { ...metadataInitial }); } catch (error) { caught = error; }
      expect(visited).toBe(true); expect(entered).toBe(limit >= 32);
      if (limit < 32) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
    });
  }
});


describe('relational ELEMENT32 owned output return chronological guard', () => {
  for (const input of [1, false]) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    it(`${typeof input} ${mode} M completed output assignment prevents local late return`, () => {
      let clock = 0, assigned = false, returned = false, materialized = false, caught: unknown;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => clock, signal });
      const probe = element32Probe(marker => { if (marker === 'M') materialized = true; });
      const metadata = { ...metadataInitial };
      Object.defineProperty(metadata, 'outText', { set(value) {
        expect(value).toBe(true); expect(materialized).toBe(true); assigned = true;
        if (mode === 'expired') clock = 5000;
        if (mode === 'aborted') signal.aborted = true;
      } });
      try { probe.element(input, budget, metadata); returned = true; budget.check(); } catch (error) { caught = error; }
      expect(assigned).toBe(true); expect(returned).toBe(mode === 'timely');
      if (mode === 'timely') expect(caught).toBeUndefined(); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});


describe('relational ELEMENT32 owned error boundary chronological guard', () => {
  for (const seam of ['visit', 'M', 'output'] as const) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['ordinary', 'range', 'exceeded', 'unavailable'] as const) {
      it(`${seam} ${mode}/${outcome} own catch dominates ordinary errors and retains budget identity`, () => {
        let clock = 0, reached = false, returned = false, caught: unknown;
        const signal = { aborted: false };
        const base = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
          : outcome === 'range' ? new RangeError('element boundary') : new Error('element boundary');
        const boundary = () => {
          reached = true;
          if (mode === 'expired') clock = 5000;
          if (mode === 'aborted') signal.aborted = true;
          throw sentinel;
        };
        const budget: BudgetContext = { ...base, spend(n = 1) { base.spend(n); if (seam === 'visit') boundary(); } };
        const probe = element32Probe(marker => { if (seam === 'M' && marker === 'M') boundary(); });
        const metadata = { ...metadataInitial };
        if (seam === 'output') Object.defineProperty(metadata, 'outText', { set: boundary });
        try { probe.element(1, budget, metadata); returned = true; } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(returned).toBe(false);
        if (mode === 'timely' || outcome === 'exceeded' || outcome === 'unavailable') expect(caught).toBe(sentinel);
        else expect(caught).toBeInstanceOf(BudgetUnavailableError);
      });
    }
  }
});


describe('relational ELEMENT32 own reused scalar return chronological guard', () => {
  // Late successful actual scalar completion is private instrumentation; its
  // inherited checks remain intact. Undefined is a direct private leaf specimen.
  for (const input of ['한', null, undefined]) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    it(`${String(input)} ${mode} completed scalar cannot escape element late`, () => {
      let clock = 0, reached = false, returned = false, caught: unknown;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => clock, signal });
      const probe = element32Probe(marker => {
        if (marker === 'scalar-return') {
          reached = true;
          if (mode === 'expired') clock = 5000;
          if (mode === 'aborted') signal.aborted = true;
        }
      }, true);
      try { probe.element(input, budget, { ...metadataInitial }); returned = true; budget.check(); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(returned).toBe(mode === 'timely');
      if (mode === 'timely') expect(caught).toBeUndefined(); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});


describe('relational ELEMENT32 supplemental inherited recipe and admission controls', () => {
  for (const input of [1, true]) for (const key of ['nodes', 'contentBytes', 'structuralBytes', 'work'] as const) {
    const recipe = { nodes: 2, slots: 0, contentBytes: 32, structuralBytes: 84, work: 5 };
    for (const delta of [-1, 0, 1]) it(`${typeof input} complete W32 independent ${key} allowance ${delta}`, () => {
      const budget = createBudgetContext({ now: () => 0, limits: { [key]: recipe[key] + delta } });
      const metadata = { ...metadataInitial };
      let returned = false, caught: unknown;
      try { element32Probe().element(input, budget, metadata); returned = true; } catch (error) { caught = error; }
      expect(returned).toBe(delta >= 0);
      if (delta < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(metadata).toEqual(metadataInitial); }
      else { expect(caught).toBeUndefined(); expect(budget.usage()).toEqual(recipe); }
    });
  }
  for (const u of [0, 1, 255, 256, 257, 511, 512, 513]) for (const kind of ['ASCII', 'Hangul', 'lone', 'cross-pair'] as const) {
    it(`reused string ${kind} U${u} exact source F and UTF8 blocks with no extra visit or M`, () => {
      const input = kind === 'ASCII' ? 'a'.repeat(u) : kind === 'Hangul' ? '한'.repeat(u) : kind === 'lone' ? '\ud800'.repeat(u)
        : u >= 257 ? 'a'.repeat(255) + '😀' + 'a'.repeat(u - 257) : 'a'.repeat(u);
      const b = kind === 'Hangul' || kind === 'lone' ? 3 * u : kind === 'cross-pair' && u >= 257 ? u + 2 : u;
      const budget = createBudgetContext({ now: () => 0 });
      const metadata = { ...metadataInitial };
      const events: string[] = [];
      element32Probe(marker => events.push(marker)).element(input, budget, metadata);
      expect(events).toEqual(['scalar']);
      expect(metadata).toEqual({ ...metadataInitial, outU: u, outB: b, outText: true });
      expect(budget.usage()).toEqual({ nodes: 1, slots: 0, contentBytes: 0, structuralBytes: 16 + 2 * u, work: 2 + 2 * Math.ceil(u / 256) });
    });
  }
  it('unsupported private leaves reject without method or coercion probes; root-public nontrivial refusal remains', () => {
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps++; throw new Error('not a data operand'); }, getPrototypeOf() { traps++; return null; } });
    const revocable = Proxy.revocable({}, {}); revocable.revoke();
    const probe = element32Probe();
    for (const input of [Symbol('unsupported'), BigInt(1), () => 1, {}, [], proxy, revocable.proxy]) {
      const budget = createBudgetContext({ now: () => 0 });
      expect(() => probe.element(input, budget, { ...metadataInitial })).toThrow('Legacy bounded JSON is invalid.');
      expect(budget.usage()).toEqual({ nodes: 0, slots: 0, contentBytes: 0, structuralBytes: 0, work: 1 });
    }
    expect(traps).toBe(0);
    const budget = createBudgetContext({ now: () => 0 });
    const array = probe.parseRegisteredBoundedJson('[1,true]', budget);
    expect(() => probe.reserveBoundedJsonRelational(array, 0, budget)).not.toThrow();
  });
  for (const input of ['', null, undefined]) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['ordinary', 'range', 'exceeded', 'unavailable'] as const) {
      it(`reused scalar completion ${String(input)} ${mode}/${outcome} preserves owned catch and identity`, () => {
        let clock = 0, reached = false, returned = false, caught: unknown;
        const signal = { aborted: false };
        const budget = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
          : outcome === 'range' ? new RangeError('scalar completion') : new Error('scalar completion');
        const probe = element32Probe(marker => {
          if (marker !== 'scalar-return') return;
          reached = true;
          if (mode === 'expired') clock = 5000;
          if (mode === 'aborted') signal.aborted = true;
          throw sentinel;
        }, true);
        try { probe.element(input, budget, { ...metadataInitial }); returned = true; } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(returned).toBe(false);
        if (mode === 'timely' || outcome === 'exceeded' || outcome === 'unavailable') expect(caught).toBe(sentinel);
        else expect(caught).toBeInstanceOf(BudgetUnavailableError);
      });
    }
  }
});


describe('relational ELEMENT32 own entry chronological guard', () => {
  for (const input of ['', null, undefined, 1, true]) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    it(`${String(input)} ${mode} own entry refuses before scalar consumer or numeric visit`, () => {
      let clock = 0, consumed = false, returned = false, caught: unknown;
      const signal = { aborted: false };
      const base = createBudgetContext({ now: () => clock, signal });
      const stop = new Error('element entry admitted first actual consumer');
      const budget: BudgetContext = { ...base, spend() { consumed = true; throw stop; } };
      const probe = element32Probe(marker => { if (marker === 'scalar') { consumed = true; throw stop; } });
      if (mode === 'expired') clock = 5000;
      if (mode === 'aborted') signal.aborted = true;
      try { probe.element(input, budget, { ...metadataInitial }); returned = true; } catch (error) { caught = error; }
      expect(consumed).toBe(mode === 'timely'); expect(returned).toBe(false);
      if (mode === 'timely') expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});


// Partition3 extends the established whole-module observation seam only in memory.
// Actual decoder, registry, graph/element bodies and budget dependencies stay real.
function indexDepthProbe(observe: (marker: string, value: unknown, depth?: number) => unknown = (_marker, value) => value) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  const wrap = (node: ts.Node, marker: string) => {
    edits.push({ at: node.getStart(parsed), text: `__indexObserve(${JSON.stringify(marker)}, (` });
    edits.push({ at: node.end, text: '))' });
  };
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body || !declaration.name) continue;
    const name = declaration.name.text;
    if (name !== 'relationalGraph' && name !== 'relationalElement') continue;
    edits.push({ at: declaration.body.getStart(parsed) + 1, text: `\n__indexObserve("${name}:entry", input${name === 'relationalGraph' ? ', depth' : ''});\n` });
    if (name !== 'relationalGraph') continue;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && node.name.getText(parsed) === 'childDepth') wrap(node.initializer, 'child depth calculated');
      if (ts.isElementAccessExpression(node) && node.expression.getText(parsed).includes('input')) {
        edits.push({ at: node.getStart(parsed), text: '(__indexObserve("before index", i), ' });
        edits.push({ at: node.end, text: ')' });
        wrap(node, 'index returned');
      }
      if (ts.isExpressionStatement(node) && node.getText(parsed) === 'budget.spend(relationalAdd(count, relationalBlocks(u)));') {
        edits.push({ at: node.end, text: '\n__indexObserve("J completed", count);' });
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let transformed = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) transformed = transformed.slice(0, edit.at) + edit.text + transformed.slice(edit.at);
  transformed += '\nexports.graph = relationalGraph;';
  const compiled = ts.transpileModule(transformed, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json & { graph: (input: object, budget: BudgetContext, metadata: RelationalMetadataProbe, depth: number) => void };
  new Function('exports', 'require', '__indexObserve', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected index dependency ${id}`);
    return relationalWork;
  }, observe);
  return exports;
}

describe('relational INDEX3 consumer connectivity', () => {
  for (const text of ['[null]', '[1,2]']) it(`${text} reads actual index0 after J and retains terminal refusal`, () => {
    const markers: string[] = [], indices: unknown[] = [], values: unknown[] = [];
    const probe = indexDepthProbe((marker, value) => {
      markers.push(marker);
      if (marker === 'before index') indices.push(value);
      if (marker === 'index returned') values.push(value);
      return value;
    });
    const budget = createBudgetContext({ now: () => 0 });
    const graph = probe.parseRegisteredBoundedJson(text, budget) as object;
    expect(() => probe.graph(graph, budget, { ...metadataInitial }, 1)).not.toThrow();
    expect(indices).toEqual(text === '[null]' ? [0] : [0, 1]); expect(values).toEqual(text === '[null]' ? [null] : [1, 2]);
    expect(markers.indexOf('J completed')).toBeLessThan(markers.indexOf('before index'));
  });
});

describe('relational INDEX3 spend chronological guard', () => {
  for (const side of ['left', 'right'] as const) for (const delta of [-1, 0, 1]) {
    it(`${side} J completed then index spend1 allowance ${delta} before real get`, () => {
      const base = createBudgetContext({ now: () => 0 });
      const stop = new Error('actual indexed get entry');
      let reached = false, entered = false, caught: unknown;
      const probe = indexDepthProbe((marker, value) => {
        if (marker === 'J completed') { reached = true; base.spend(base.limits.work - base.usage().work - 1 - delta); }
        if (marker === 'before index') { entered = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null]', base);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', base); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(entered).toBe(delta >= 0);
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
      else { expect(caught).toBe(stop); expect(base.limits.work - base.usage().work).toBe(delta); }
    });
  }
});


describe('relational INDEX3 post-get chronological guard', () => {
  for (const side of ['left', 'right'] as const) for (const state of ['timely', 'expired', 'aborted'] as const) {
    it(`${side} ${state} actual get success is checked before child-depth processing`, () => {
      let now = 0, reached = false, successor = false, caught: unknown;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => now, signal });
      const stop = new Error('child processing');
      const probe = indexDepthProbe((marker, value) => {
        if (marker === 'index returned') { reached = true; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; }
        if (marker === 'child depth calculated') { successor = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null]', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(successor).toBe(state === 'timely');
      if (state === 'timely') expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});

describe('relational DEPTH3 actual dispatch connectivity', () => {
  for (const text of ['[null]', '["A"]', '[1]', '[true]', '[{}]', '[[]]']) {
    it(`${text} checked get reaches actual appropriate child body without parent completion`, () => {
      const entries: unknown[] = [];
      let graphEntries = 0;
      const probe = indexDepthProbe((marker, value, depth) => {
        if (marker === 'relationalGraph:entry' && ++graphEntries > 1) entries.push(['graph', value, depth]);
        if (marker === 'relationalElement:entry') entries.push(['element', value]);
        return value;
      });
      const budget = createBudgetContext({ now: () => 0 });
      const graph = probe.parseRegisteredBoundedJson(text, budget) as readonly unknown[];
      expect(() => probe.graph(graph, budget, { ...metadataInitial }, 1)).not.toThrow();
      expect(entries).toEqual(graph[0] !== null && typeof graph[0] === 'object' ? [['graph', graph[0], 2]] : [['element', graph[0]]]);
    });
  }
});

describe('relational DEPTH3 safe-add chronological guard', () => {
  // Malformed/MAX caller depths are private call-site probes, not decoded depths.
  for (const depth of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    it(`private depth ${String(depth)} refuses safe-add before calculated value or child entry`, () => {
      let reached = false, calculated = false, entered = false, caught: unknown, graphEntries = 0;
      const probe = indexDepthProbe((marker, value) => {
        if (marker === 'index returned') reached = true;
        if (marker === 'child depth calculated') calculated = true;
        if (marker === 'relationalGraph:entry' && ++graphEntries > 1 || marker === 'relationalElement:entry') entered = true;
        return value;
      });
      const budget = createBudgetContext({ now: () => 0 });
      const graph = probe.parseRegisteredBoundedJson('[null]', budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, depth); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(calculated).toBe(false); expect(entered).toBe(false);
      expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational DEPTH3 fixed64 chronological guard', () => {
  for (const text of ['[null]', '["A"]', '[1]', '[{}]', '[[]]']) for (const depth of [62, 63, 64]) {
    it(`private ${text} parent depth${depth} checks fixed64 before child frame and context`, () => {
      let reached = false, entered = false, graphEntries = 0, caught: unknown;
      const contextDepths: number[] = [];
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, checkDepth(n) { if (reached) contextDepths.push(n); base.checkDepth(n); } };
      const probe = indexDepthProbe((marker, value) => {
        if (marker === 'index returned') reached = true;
        if (marker === 'relationalGraph:entry' && ++graphEntries > 1 || marker === 'relationalElement:entry') entered = true;
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson(text, budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, depth); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(entered).toBe(depth < 64);
      if (depth === 64) { expect(contextDepths).toEqual([]); expect(caught).toBeInstanceOf(BudgetExceededError); }
      else expect(caught).toBeUndefined();
    });
  }
  for (const scalar of ['0', 'null', '"A"']) {
    it(`natural same-owner decoded64containers plus ${scalar} depth65 rejects before leaf under custom128`, () => {
      const base = createBudgetContext({ now: () => 0 });
      const depths: number[] = [], entries: number[] = [];
      let armed = false, leafEntered = false, gets = 0;
      // Private permissive test context only; normal context ceilings remain unchanged.
      const budget: BudgetContext = { ...base, limits: { ...base.limits, depth: 128 }, checkDepth(n) {
        base.check();
        if (!Number.isSafeInteger(n) || n < 0 || n > 128) throw new BudgetExceededError();
        if (armed) depths.push(n);
      } };
      const probe = indexDepthProbe((marker, value, depth) => {
        if (marker === 'relationalGraph:entry') entries.push(depth!);
        if (marker === 'relationalElement:entry') leafEntered = true;
        if (marker === 'index returned') gets++;
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('['.repeat(64) + scalar + ']'.repeat(64), budget);
      armed = true;
      expect(() => probe.reserveBoundedJsonRelational(graph, '', budget)).toThrow(BudgetExceededError);
      expect(entries).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
      expect(gets).toBe(64); expect(leafEntered).toBe(false); expect(depths).not.toContain(65);
    });
  }
});


describe('relational DEPTH3 context chronological guard', () => {
  for (const text of ['[null]', '["A"]', '[1]', '[{}]', '[[]]']) for (const ceiling of [1, 2, 3]) {
    it(`${text} child depth2 at context ceiling${ceiling} before every child entry`, () => {
      let reached = false, entered = false, graphEntries = 0, caught: unknown;
      const depths: number[] = [];
      const base = createBudgetContext({ now: () => 0 });
      // Same-owner delegating private capacity sentinel; admission remains sufficient.
      const budget: BudgetContext = { ...base, checkDepth(n) {
        base.checkDepth(n);
        if (reached) { depths.push(n); if (n > ceiling) throw new BudgetExceededError(); }
      } };
      const probe = indexDepthProbe((marker, value) => {
        if (marker === 'index returned') reached = true;
        if (marker === 'relationalGraph:entry' && ++graphEntries > 1 || marker === 'relationalElement:entry') entered = true;
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson(text, budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(entered).toBe(ceiling >= 2); expect(depths).toEqual([2]);
      if (ceiling < 2) expect(caught).toBeInstanceOf(BudgetExceededError);
      else expect(caught).toBeUndefined();
    });
  }
});


describe('relational INDEX3 dispatch inherited error boundary matrix', () => {
  // Native/entry sentinels are in-memory instrumentation, not accessor admission.
  // Existing graph/element catches are controls, not newly implemented guards.
  for (const boundary of ['before index', 'index returned', 'graph child', 'element child'] as const) {
    for (const state of ['timely', 'expired', 'aborted'] as const) {
      for (const outcome of ['success', 'Error', 'RangeError', 'BudgetExceededError', 'BudgetUnavailableError'] as const) {
        it(`${boundary} ${state} ${outcome} preserves reached error identity and forbids parent output`, () => {
          let now = 0, reached = false, graphEntries = 0, returned = false, caught: unknown;
          const signal = { aborted: false };
          const budget = createBudgetContext({ now: () => now, signal });
          const injected = outcome === 'Error' ? new Error('indexed ordinary') : outcome === 'RangeError' ? new RangeError('indexed ordinary')
            : outcome === 'BudgetExceededError' ? new BudgetExceededError() : new BudgetUnavailableError();
          const probe = indexDepthProbe((marker, value) => {
            const childGraph = marker === 'relationalGraph:entry' && ++graphEntries > 1;
            if (!reached && (marker === boundary || boundary === 'graph child' && childGraph || boundary === 'element child' && marker === 'relationalElement:entry')) {
              reached = true;
              if (state === 'expired') now = 5000;
              if (state === 'aborted') signal.aborted = true;
              if (outcome !== 'success') throw injected;
            }
            return value;
          });
          const graph = probe.parseRegisteredBoundedJson(boundary === 'graph child' ? '[{}]' : '["A"]', budget) as object;
          const metadata = { ...metadataInitial };
          try { probe.graph(graph, budget, metadata, 1); returned = true; } catch (error) { caught = error; }
          expect(reached).toBe(true); expect(returned).toBe(state === 'timely' && outcome === 'success');
          if (outcome === 'BudgetExceededError' || outcome === 'BudgetUnavailableError') expect(caught).toBe(injected);
          else if (state !== 'timely') expect(caught).toBeInstanceOf(BudgetUnavailableError);
          else if (outcome !== 'success') expect(caught).toBe(injected);
          else expect(caught).toBeUndefined();
          if (outcome !== 'success' || state !== 'timely') expect(metadata).toEqual(metadataInitial);
          else expect(metadata).toEqual({ ...metadataInitial, outU: boundary === 'graph child' ? 15 : 1, outB: boundary === 'graph child' ? 15 : 1, outText: true });
        });
      }
    }
  }
});

describe('relational INDEX3 bounded partial dispatch controls', () => {
  for (const text of ['[]', '[null]', '[1]', '[{}]', '[[]]', '[[null]]', '[null,0]']) {
    it(`${text} literal partial W cost and only completed child metadata, no parent result or next index`, () => {
      const base = createBudgetContext({ now: () => 0 });
      const indices: unknown[] = [], frames: number[] = [], depths: number[] = [];
      const budget: BudgetContext = { ...base, checkDepth(n) { depths.push(n); base.checkDepth(n); } };
      const probe = indexDepthProbe((marker, value, depth) => {
        if (marker === 'before index') indices.push(value);
        if (marker === 'relationalGraph:entry') frames.push(depth!);
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson(text, budget) as object;
      const start = base.usage(); depths.length = 0;
      const metadata = { ...metadataInitial };
      expect(() => probe.graph(graph, budget, metadata, 1)).not.toThrow();
      // Spec ledger constants, excluding separately tested pair O/H/G and decoder.
      const expected = text === '[]' ? [3, 0, 0, 36, 9]
        : text === '[null]' ? [3, 1, 0, 40, 12]
        : text === '[1]' ? [5, 1, 64, 188, 18]
        : text === '[{}]' ? [5, 1, 30, 120, 23]
        : text === '[[]]' ? [6, 1, 0, 76, 20]
        : text === '[[null]]' ? [6, 2, 0, 80, 23]
        : [5, 2, 65, 194, 22];
      const end = base.usage();
      expect(['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].map(key => end[key as keyof typeof end] - start[key as keyof typeof start])).toEqual(expected);
      expect(indices).toEqual(text === '[]' ? [] : text === '[[null]]' ? [0, 0] : text === '[null,0]' ? [0, 1] : [0]);
      expect(frames).toEqual(text === '[[]]' || text === '[{}]' || text === '[[null]]' ? [1, 2] : [1]);
      expect(depths).toEqual(text === '[]' ? [] : text === '[[null]]' ? [2, 3] : text === '[null,0]' ? [2, 2] : [2]);
      expect(metadata).toEqual({ ...metadataInitial,
        outU: text === '[1]' ? 32 : text === '[{}]' ? 15 : text === '[null,0]' ? 33 : 0,
        outB: text === '[1]' ? 32 : text === '[{}]' ? 15 : text === '[null,0]' ? 33 : 0,
        outText: true,
      });
    });
  }
});


describe('relational DEPTH3 deepest empty reuse control', () => {
  it('natural64 container chain enters empty array at depth64 without requesting depth65', () => {
    const depths: number[] = [], entries: number[] = [];
    let armed = false, leafEntered = false;
    const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base, checkDepth(n) { base.checkDepth(n); if (armed) depths.push(n); } };
    const probe = indexDepthProbe((marker, value, depth) => {
      if (marker === 'relationalGraph:entry') entries.push(depth!);
      if (marker === 'relationalElement:entry') leafEntered = true;
      return value;
    });
    const graph = probe.parseRegisteredBoundedJson('['.repeat(64) + ']'.repeat(64), budget);
    armed = true;
    expect(() => probe.reserveBoundedJsonRelational(graph, '', budget)).not.toThrow();
    expect(entries).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(depths).toEqual([...entries, 1]); expect(leafEntered).toBe(false);
  });
});


// Partition4 observes actual calls/reads in the real same-owner module. No
// substituted child algorithm or registered hostile getter is involved.
function arrayCompletionProbe(observe: (marker: string, value: unknown) => unknown = (_marker, value) => value, rightRetained: () => void = () => {}) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  for (const declaration of parsed.statements) {
    if (ts.isFunctionDeclaration(declaration) && declaration.name?.text === 'reserveBoundedJsonRelational' && declaration.body) {
      const publicVisit = (node: ts.Node) => {
        if (ts.isExpressionStatement(node) && node.getText(parsed) === 'metadata.rightText = metadata.outText;') edits.push({ at: node.end, text: '__rightRetained();' });
        ts.forEachChild(node, publicVisit);
      };
      publicVisit(declaration.body);
    }
    if (!ts.isFunctionDeclaration(declaration) || declaration.name?.text !== 'relationalGraph' || !declaration.body) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ['relationalGraph', 'relationalElement'].includes(node.expression.getText(parsed))) {
        edits.push({ at: node.getStart(parsed), text: '(' });
        edits.push({ at: node.end, text: ', __completionObserve("child returned", metadata))' });
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(parsed) === 'metadata' && ['outU', 'outB', 'outText'].includes(node.name.text)
        && !(ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
        edits.push({ at: node.getStart(parsed), text: `(__completionObserve("read ${node.name.text}", undefined), ` });
        edits.push({ at: node.end, text: ')' });
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ['childU', 'childB'].includes(node.name.getText(parsed))) {
        edits.push({ at: node.initializer.getStart(parsed), text: `__completionObserve("${node.name.getText(parsed)} calculated", (` });
        edits.push({ at: node.initializer.end, text: '))' });
      }
      if (ts.isExpressionStatement(node) && /^([ub]) = child[UB];$/.test(node.getText(parsed))) {
        edits.push({ at: node.getStart(parsed), text: `__completionObserve("store ${node.getText(parsed)[0]}", [u, b]);` });
      }
      if (ts.isElementAccessExpression(node) && node.expression.getText(parsed).includes('input')) {
        edits.push({ at: node.getStart(parsed), text: '(__completionObserve("before index", i), ' });
        edits.push({ at: node.end, text: ')' });
      }
      if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(parsed) === 'i') {
        edits.push({ at: node.getStart(parsed), text: 'i = __completionObserve("increment operand", i);' });
        edits.push({ at: node.expression.right.getStart(parsed), text: '__completionObserve("increment calculated", (' });
        edits.push({ at: node.expression.right.end, text: '))' });
      }
      if (ts.isWhileStatement(node)) {
        edits.push({ at: node.end, text: '\nu = __completionObserve("final U", u); b = __completionObserve("final B", b);' });
      }
      if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'relationalMaterialize') {
        edits.push({ at: node.getStart(parsed), text: `(__completionObserve("M entry", [${node.arguments[0].getText(parsed)}, ${node.arguments[1].getText(parsed)}, input]), ` });
        edits.push({ at: node.end, text: ', __completionObserve("M returned", input))' });
      }
      if (ts.isExpressionStatement(node) && node.getText(parsed) === 'metadata.outText = true;') edits.push({ at: node.end, text: '__completionObserve("output written", input);' });
      if (ts.isReturnStatement(node) && !node.expression) edits.push({ at: node.getStart(parsed), text: '__completionObserve("graph return", input);' });
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let transformed = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) transformed = transformed.slice(0, edit.at) + edit.text + transformed.slice(edit.at);
  transformed += '\nexports.graph = relationalGraph;';
  const compiled = ts.transpileModule(transformed, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof json & { graph: (input: object, budget: BudgetContext, metadata: RelationalMetadataProbe, depth: number) => void };
  new Function('exports', 'require', '__completionObserve', '__rightRetained', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected completion dependency ${id}`);
    return relationalWork;
  }, observe, rightRetained);
  return exports;
}

describe('relational COMPLETE4 child completion chronological guard', () => {
  for (const side of ['left', 'right'] as const) for (const text of ['[null]', '["한"]', '[1]', '[{}]', '[[]]']) {
    for (const state of ['timely', 'expired', 'aborted'] as const) it(`${side} ${text} ${state} child success checked before output read`, () => {
      let now = 0, reached = false, caught: unknown;
      const signal = { aborted: false }, reads: string[] = [];
      const stop = new Error('first actual child output read');
      const budget = createBudgetContext({ now: () => now, signal });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'child returned') { reached = true; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; }
        if (marker.startsWith('read ')) { reads.push(marker); throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson(text, budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(reads).toEqual(state === 'timely' ? ['read outU'] : []);
      if (state === 'timely') expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});


describe('relational TOTAL4 U safe-add chronological guard', () => {
  for (const childU of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    it(`private child U ${String(childU)} refuses before unsafe sum or store`, () => {
      let reached = false, calculated = false, stored = false, caught: unknown;
      const budget = createBudgetContext({ now: () => 0 });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'child returned') { reached = true; (value as RelationalMetadataProbe).outU = childU; }
        if (marker === 'childU calculated') calculated = true;
        if (marker === 'store u') stored = true;
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null]', budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(calculated).toBe(false); expect(stored).toBe(false);
      expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational TOTAL4 U cap chronological guard', () => {
  for (const side of ['left', 'right'] as const) for (const delta of [-1, 0, 1]) {
    it(`${side} private sum U=32${delta < 0 ? '-1' : delta > 0 ? '+1' : ''} caps before running total store`, () => {
      let reached = false, calculated = false, stored = false, caught: unknown;
      const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: 32 } });
      const stop = new Error('U total store');
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'child returned') { reached = true; (value as RelationalMetadataProbe).outU = 31 + delta; }
        if (marker === 'childU calculated') { calculated = true; expect(value).toBe(32 + delta); }
        if (marker === 'store u') { stored = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null]', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(calculated).toBe(true); expect(stored).toBe(delta <= 0);
      if (delta <= 0) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational TOTAL4 B safe-add chronological guard', () => {
  for (const childB of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    it(`private child B ${String(childB)} admits valid sum or refuses before unsafe sum and B store`, () => {
      let reached = false, calculated = false, stored = false, caught: unknown;
      const budget = createBudgetContext({ now: () => 0 });
      const stop = new Error('B total store');
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'child returned') { reached = true; (value as RelationalMetadataProbe).outB = childB; }
        if (marker === 'childB calculated') calculated = true;
        if (marker === 'store b') { stored = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null]', budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(calculated).toBe(childB === 0); expect(stored).toBe(childB === 0);
      if (childB === 0) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});

describe('relational TOTAL4 B cap chronological guard', () => {
  for (const side of ['left', 'right'] as const) for (const delta of [-1, 0, 1]) {
    it(`${side} private sum B=32${delta < 0 ? '-1' : delta > 0 ? '+1' : ''} caps before running total store`, () => {
      let reached = false, calculated = false, stored = false, caught: unknown;
      const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: 32 } });
      const stop = new Error('B total store');
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'child returned') { reached = true; (value as RelationalMetadataProbe).outB = 31 + delta; }
        if (marker === 'childB calculated') { calculated = true; expect(value).toBe(32 + delta); }
        if (marker === 'store b') { stored = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null]', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(calculated).toBe(true); expect(stored).toBe(delta <= 0);
      if (delta <= 0) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});




describe('relational TOTAL4 atomic stores chronological guard', () => {
  for (const side of ['left', 'right'] as const) for (const failure of ['U overflow', 'U cap', 'B overflow', 'B cap', 'B malformed', 'valid nontext'] as const) {
    it(`${side} ${failure} preserves old totals until both bounds succeed`, () => {
      let reached = false, caught: unknown;
      const events: string[] = [];
      const stop = new Error('first completed totals before increment');
      const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: 32 } });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'child returned') {
          reached = true;
          const metadata = value as RelationalMetadataProbe;
          metadata.outU = failure === 'U overflow' ? Number.MAX_SAFE_INTEGER : failure === 'U cap' ? 32 : 1;
          metadata.outB = failure === 'B overflow' ? Number.MAX_SAFE_INTEGER : failure === 'B cap' ? 32 : failure === 'B malformed' ? -1 : 3;
          metadata.outText = false;
        }
        if (marker === 'increment operand') throw stop;
        if (marker.startsWith('read ') || marker.startsWith('store ') || marker === 'childU calculated' || marker === 'childB calculated') events.push(marker);
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null]', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(reached).toBe(true);
      expect(events.filter(event => event.startsWith('store '))).toEqual(failure === 'valid nontext' ? ['store u', 'store b'] : []);
      if (failure.startsWith('U')) expect(events).not.toContain('read outB');
      if (failure === 'valid nontext') {
        expect(events).toEqual(['read outU', 'childU calculated', 'read outB', 'childB calculated', 'store u', 'store b']);
        expect(caught).toBe(stop);
      } else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational PARTIAL4 natural totals and inherited error controls', () => {
  const specimens = [
    { text: '[null,null]', u: 1, b: 1 },
    { text: '["한",null]', u: 2, b: 4 },
    { text: '["😀",null]', u: 3, b: 5 },
    { text: '[1,null]', u: 33, b: 33 },
    { text: '[true,null]', u: 33, b: 33 },
    { text: '[{},null]', u: 16, b: 16 },
    { text: '[[],null]', u: 1, b: 1 },
    { text: '["",null,null,null]', u: 3, b: 3 },
  ];
  for (const side of ['left', 'right'] as const) for (const specimen of specimens) {
    it(`${side} natural ${specimen.text} consumes first child bounds without publishing parent output`, () => {
      const totals: unknown[] = [], stores: string[] = [];
      const stop = new Error('next index after first child totals');
      let returns = 0, caught: unknown;
      const budget = createBudgetContext({ now: () => 0 });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'increment operand') throw stop;
        if (marker === 'child returned') returns++;
        if (marker === 'childU calculated' || marker === 'childB calculated') totals.push(value);
        if (marker.startsWith('store ')) stores.push(marker);
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson(specimen.text, budget);
      const before = budget.usage();
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(returns).toBe(1); expect(totals).toEqual([specimen.u, specimen.b]);
      expect(stores).toEqual(['store u', 'store b']); expect(caught).toBe(stop);
      // Independent ledger prefix: pair O/H/G, optional left empty string,
      // parent entry/J/index, and first child's complete W. Stop before index1.
      const model = ledger(side === 'left' ? JSON.parse(specimen.text) : '', side === 'right' ? JSON.parse(specimen.text) : '');
      let indices = 0;
      const prefix: Vector = [0, 0, 0, 0, 0];
      for (const event of model.events) {
        if (event.label === 'index' && ++indices === 2) break;
        event.vector.forEach((value, i) => { prefix[i] += value; });
      }
      const after = budget.usage();
      expect([after.nodes - before.nodes, after.slots - before.slots, after.contentBytes - before.contentBytes, after.structuralBytes - before.structuralBytes, after.work - before.work]).toEqual(prefix);
    });
  }
  for (const side of ['left', 'right'] as const) for (const text of ['[null]', '[{}]', '[[]]']) {
    for (const state of ['timely', 'expired', 'aborted'] as const) for (const kind of ['Error', 'RangeError', 'exceeded', 'unavailable'] as const) {
      it(`${side} ${text} ${state} child exit ${kind} preserves inherited error policy before totals`, () => {
        let now = 0, reached = false, caught: unknown;
        const signal = { aborted: false }, successors: string[] = [];
        const sentinel = kind === 'exceeded' ? new BudgetExceededError() : kind === 'unavailable' ? new BudgetUnavailableError() : kind === 'RangeError' ? new RangeError('child exit') : new Error('child exit');
        const budget = createBudgetContext({ now: () => now, signal });
        const probe = arrayCompletionProbe((marker, value) => {
          if (marker === 'child returned') { reached = true; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; throw sentinel; }
          if (marker.startsWith('read ') || marker.startsWith('store ')) successors.push(marker);
          return value;
        });
        const graph = probe.parseRegisteredBoundedJson(text, budget);
        try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
        expect(reached).toBe(true); expect(successors).toEqual([]);
        if (state === 'timely' || kind === 'exceeded' || kind === 'unavailable') expect(caught).toBe(sentinel);
        else expect(caught).toBeInstanceOf(BudgetUnavailableError);
      });
    }
  }
  // Decoder admission is separate: tighten only the same-owner W string cap
  // after real decoding; this is a capacity sentinel with natural child data.
  for (const limit of [3, 4, 5]) it(`postdecode Unicode child B>U sum4 tightened cap${limit} has atomic totals`, () => {
    const stores: string[] = [], bounds: unknown[] = [];
    const stop = new Error('next index after Unicode total');
    const base = createBudgetContext({ now: () => 0 });
    let admitted = false;
    const budget: BudgetContext = { ...base, get limits() { return admitted ? { ...base.limits, stringBytes: limit } : base.limits; } };
    const probe = arrayCompletionProbe((marker, value) => {
      if (marker === 'increment operand') throw stop;
      if (marker.startsWith('store ')) stores.push(marker);
      if (marker === 'childU calculated' || marker === 'childB calculated') bounds.push(value);
      return value;
    });
    const graph = probe.parseRegisteredBoundedJson('["한",null]', budget) as object;
    admitted = true;
    let caught: unknown;
    try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
    expect(bounds).toEqual([2, 4]); expect(stores).toEqual(limit >= 4 ? ['store u', 'store b'] : []);
    if (limit < 4) expect(caught).toBeInstanceOf(BudgetExceededError); else expect(caught).toBe(stop);
  });
});


describe('relational LOOP4 next-child connectivity', () => {
  for (const side of ['left', 'right'] as const) it(`${side} two natural children get0 then1 never count2`, () => {
    const indices: unknown[] = [], bounds: unknown[] = [];
    const budget = createBudgetContext({ now: () => 0 });
    const probe = arrayCompletionProbe((marker, value) => {
      if (marker === 'before index') indices.push(value);
      if (marker.endsWith(' calculated') && marker !== 'increment calculated') bounds.push(value);
      return value;
    });
    const graph = probe.parseRegisteredBoundedJson('["한",true]', budget);
    expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget)).not.toThrow();
    expect(indices).toEqual([0, 1]); expect(bounds).toEqual([2, 4, 34, 36]);
  });
});

describe('relational LOOP4 safe-index chronological guard', () => {
  // Inject only at the reached private increment operand, after real totals.
  for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    it(`private index ${String(index)} refuses before unsafe increment result or next get`, () => {
      let reached = false, calculated = false, caught: unknown;
      const indices: unknown[] = [];
      const budget = createBudgetContext({ now: () => 0 });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'before index') indices.push(value);
        if (marker === 'increment operand') { reached = true; return index; }
        if (marker === 'increment calculated') { calculated = true; throw new Error('unsafe increment result'); }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null]', budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(calculated).toBe(false); expect(indices).toEqual([0]);
      expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational FINAL5 M consumer and shared return controls', () => {
  for (const text of ['[]', '[null]', '[["한"]]', '[{},true,null]']) it(`${text} completes every array M and exact outer bounds`, () => {
    const calls: unknown[] = [];
    const budget = createBudgetContext({ now: () => 0 });
    const probe = arrayCompletionProbe((marker, value) => { if (marker === 'M entry') calls.push((value as unknown[]).slice(0, 2)); return value; });
    const graph = probe.parseRegisteredBoundedJson(text, budget) as object;
    const metadata = { ...metadataInitial };
    probe.graph(graph, budget, metadata, 1);
    const expected = ledger(JSON.parse(text), '');
    expect([metadata.outU, metadata.outB, metadata.outText]).toEqual([expected.roots[0].u, expected.roots[0].b, true]);
    expect(calls).toEqual(text === '[]' || text === '[null]' ? [[0, 0]] : text === '[["한"]]' ? [[1, 3], [1, 3]] : [[15, 15], [49, 49]]);
  });
  for (const text of ['[]', '[null]', '[[null]]']) for (const state of ['timely', 'expired', 'aborted'] as const) {
    it(`${text} ${state} shared array output check prevents own late return`, () => {
      let now = 0, reached = false, returned = false, caught: unknown;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => now, signal });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'output written' && value === graph) { reached = true; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; }
        if (marker === 'graph return' && value === graph) returned = true;
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson(text, budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(returned).toBe(state === 'timely');
      if (state === 'timely') expect(caught).toBeUndefined(); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});

describe('relational FINAL5 B caller chronological guard', () => {
  for (const bound of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 33, 31, 32]) {
    it(`private completed B ${String(bound)} is validated and capped before final M entry`, () => {
      let reached = false, entered = false, caught: unknown;
      const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: 32 } });
      const stop = new Error('final M actual entry');
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'final B') { reached = true; return bound; }
        if (marker === 'M entry') { entered = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null]', budget) as object;
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(entered).toBe(bound === 31 || bound === 32);
      if (bound === 31 || bound === 32) expect(caught).toBe(stop); else expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


// Independent historical W prefix, explicitly stopped before the now-complete P0/R/final2 suffix.
function preparedWPrefix(left: unknown, right: unknown): Vector {
  const total: Vector = [0, 0, 0, 0, 0];
  for (const event of ledger(left, right).events) {
    if (event.label === 'P0 allocation') break;
    event.vector.forEach((value, i) => { total[i] += value; });
  }
  return total;
}

describe('relational WHOLE5 independent W ledger and occurrence controls', () => {
  const prefixStop = new Error('explicit full-W right-retained prefix stop before P0');
  const stopAtPrefix = () => { throw prefixStop; };
  const specimens = ['[]', '[null]', '[[],[],[],[]]', '[[["A"]]]', '["한","😀","\\ud800",1,true,null]', '[{},[1,false],null]', '["' + 'a'.repeat(255) + '😀",[]]', '[' + Array(257).fill('[]').join(',') + ']'];
  for (const side of ['left', 'right'] as const) for (const text of specimens) {
    it(`${side} full W ${text.slice(0, 45)} length${text.length} has independent exact prepared prefix without native suffix`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      const probe = arrayCompletionProbe(undefined, stopAtPrefix);
      const graph = probe.parseRegisteredBoundedJson(text, budget);
      const left = side === 'left' ? graph : '', right = side === 'right' ? graph : '';
      const before = budget.usage();
      expect(() => probe.reserveBoundedJsonRelational(left, right, budget)).toThrow(prefixStop);
      const after = budget.usage();
      expect([after.nodes - before.nodes, after.slots - before.slots, after.contentBytes - before.contentBytes, after.structuralBytes - before.structuralBytes, after.work - before.work]).toEqual(preparedWPrefix(left, right));
    });
  }
  it('same registered array on both roots and fresh repeated calls charges every occurrence with one pair G/H each time', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const roots: unknown[] = [], calls: unknown[] = [];
    const probe = arrayCompletionProbe((marker, value) => { if (marker === 'graph return') roots.push(value); if (marker === 'M entry') calls.push(value); return value; }, stopAtPrefix);
    const graph = probe.parseRegisteredBoundedJson('[[],[null],{}]', budget) as object;
    for (let attempt = 0; attempt < 2; attempt++) {
      roots.length = 0; calls.length = 0;
      const before = budget.usage();
      expect(() => probe.reserveBoundedJsonRelational(graph, graph, budget)).toThrow(prefixStop);
      const after = budget.usage();
      expect([after.nodes - before.nodes, after.slots - before.slots, after.contentBytes - before.contentBytes, after.structuralBytes - before.structuralBytes, after.work - before.work]).toEqual(preparedWPrefix(graph, graph));
      expect(roots.filter(value => value === graph)).toHaveLength(2); expect(calls).toHaveLength(8);
      expect(roots.slice(0, 4)).toEqual(roots.slice(4));
    }
  });
  it('existing closed history list retains repeated same-record references and materializes each occurrence on both roots', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const calls: unknown[] = [];
    const probe = arrayCompletionProbe((marker, value) => { if (marker === 'M entry') calls.push(value); return value; }, stopAtPrefix);
    const mutable = probe.createBoundedHistoryInvalidCompletion(budget, 'c', 't', 's', 'i', 'y', 'at', 'o', 'hash', 'digest');
    const list = probe.createBoundedOperationalHistoryList(3, () => mutable, budget);
    expect(list[0]).toBe(list[1]); expect(list[1]).toBe(list[2]);
    const before = budget.usage();
    expect(() => probe.reserveBoundedJsonRelational(list, list, budget)).toThrow(prefixStop);
    const after = budget.usage();
    expect([after.nodes - before.nodes, after.slots - before.slots, after.contentBytes - before.contentBytes, after.structuralBytes - before.structuralBytes, after.work - before.work]).toEqual(preparedWPrefix(list, list));
    expect(calls.filter(value => (value as unknown[])[2] === list[0])).toHaveLength(6);
    expect(calls.filter(value => (value as unknown[])[2] === list)).toHaveLength(2);
  });
  for (const key of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) {
    it(`both mixed Unicode roots independent W ${key} cumulative allowance ${delta}`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      const probe = arrayCompletionProbe(undefined, stopAtPrefix);
      const graph = probe.parseRegisteredBoundedJson('["한",[1,null],{}]', budget);
      const costs = preparedWPrefix(graph, graph);
      const index = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].indexOf(key);
      const consume = budget.limits[key] - budget.usage()[key] - costs[index] - delta;
      if (key === 'work') budget.spend(consume); else budget.reserve({ [key]: consume });
      let caught: unknown;
      try { probe.reserveBoundedJsonRelational(graph, graph, budget); } catch (error) { caught = error; }
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
      else { expect(caught).toBe(prefixStop); expect(budget.limits[key] - budget.usage()[key]).toBe(delta); }
    });
  }
  for (const side of ['left', 'right'] as const) for (const delta of [-1, 0, 1]) {
    it(`${side} second real index reused spend1 allowance ${delta} after first atomic totals`, () => {
      let reached = false, entered = false, caught: unknown;
      const stop = new Error('second actual index');
      const budget = createBudgetContext({ now: () => 0 });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'increment operand' && value === 0) { reached = true; budget.spend(budget.limits.work - budget.usage().work - 1 - delta); }
        if (marker === 'before index' && value === 1) { entered = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null]', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(entered).toBe(delta >= 0);
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else { expect(caught).toBe(stop); expect(budget.limits.work - budget.usage().work).toBe(delta); }
    });
  }
  for (const target of ['inner', 'outer'] as const) for (const delta of [-1, 0, 1]) {
    it(`${target} array independent M work4 allowance ${delta} before local result return`, () => {
      let reached = false, returned = false, parentEntered = false, caught: unknown;
      const base = createBudgetContext({ now: () => 0 });
      const budget: BudgetContext = { ...base, reserveString(bytes) { base.reserveString(bytes); if (reached) base.spend(base.limits.work - base.usage().work - 4 - delta); } };
      const stop = new Error('target M returned');
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'M entry') {
          const input = (value as unknown[])[2];
          if (input === graph) parentEntered = true;
          if (input === (target === 'inner' ? graph[0] : graph)) reached = true;
        }
        if (marker === 'M returned' && value === (target === 'inner' ? graph[0] : graph)) { returned = true; throw stop; }
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[["한"]]', budget) as readonly unknown[];
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(returned).toBe(delta >= 0); expect(parentEntered).toBe(target === 'outer');
      if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError); else { expect(caught).toBe(stop); expect(base.limits.work - base.usage().work).toBe(delta); }
    });
  }
});


describe('relational WHOLE5 supplemental later-child atomic refusal', () => {
  for (const side of ['left', 'right'] as const) for (const failure of ['U overflow', 'U cap', 'B overflow', 'B cap', 'B malformed'] as const) {
    it(`${side} second child ${failure} leaves both previous totals and forbids next get/final M`, () => {
      let child = 0, caught: unknown;
      const indices: unknown[] = [], stores: unknown[] = [], reads: string[] = [], materializations: unknown[] = [];
      const budget = createBudgetContext({ now: () => 0, limits: { stringBytes: 32 } });
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'child returned') {
          child++;
          const metadata = value as RelationalMetadataProbe;
          metadata.outU = child === 2 && failure === 'U overflow' ? Number.MAX_SAFE_INTEGER : child === 2 && failure === 'U cap' ? 32 : 1;
          metadata.outB = child === 2 && failure === 'B overflow' ? Number.MAX_SAFE_INTEGER : child === 2 && failure === 'B cap' ? 32 : child === 2 && failure === 'B malformed' ? -1 : 3;
        }
        if (marker === 'before index') indices.push(value);
        if (marker.startsWith('store ')) stores.push([marker, value]);
        if (marker.startsWith('read ') && child === 2) reads.push(marker);
        if (marker === 'M entry') materializations.push(value);
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[null,null,null]', budget);
      try { probe.reserveBoundedJsonRelational(side === 'left' ? graph : '', side === 'right' ? graph : '', budget); } catch (error) { caught = error; }
      expect(child).toBe(2); expect(indices).toEqual([0, 1]); expect(materializations).toEqual([]);
      expect(stores).toEqual([['store u', [2, 2]], ['store b', [3, 2]]]);
      expect(reads).toEqual(failure.startsWith('U') ? ['read outU'] : ['read outU', 'read outB']);
      expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});

describe('relational WHOLE5 shared final array inherited error controls', () => {
  for (const target of ['inner', 'outer'] as const) for (const state of ['timely', 'expired', 'aborted'] as const) {
    for (const kind of ['Error', 'RangeError', 'exceeded', 'unavailable'] as const) it(`${target} ${state} output exit ${kind} retains catch identity without local return`, () => {
      let now = 0, reached = false, returned = false, caught: unknown;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => now, signal });
      const sentinel = kind === 'Error' ? new Error('array output') : kind === 'RangeError' ? new RangeError('array output') : kind === 'exceeded' ? new BudgetExceededError() : new BudgetUnavailableError();
      const probe = arrayCompletionProbe((marker, value) => {
        if (marker === 'output written' && value === (target === 'inner' ? graph[0] : graph)) {
          reached = true; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; throw sentinel;
        }
        if (marker === 'graph return' && value === (target === 'inner' ? graph[0] : graph)) returned = true;
        return value;
      });
      const graph = probe.parseRegisteredBoundedJson('[["한"]]', budget) as readonly unknown[];
      try { probe.graph(graph, budget, { ...metadataInitial }, 1); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(returned).toBe(false);
      if (state === 'timely' || kind === 'exceeded' || kind === 'unavailable') expect(caught).toBe(sentinel);
      else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});


// P0/R suffix probes instrument only real operands in the actual module. No
// fabricated terminal refusal, coercion, registry entry or replacement walker.
type SuffixObserver = (marker: string, value: unknown, metadata?: RelationalMetadataProbe) => void;
function suffixProbe(observe: SuffixObserver = () => {}) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const parsed = ts.createSourceFile('boundedJson.ts', source, ts.ScriptTarget.ES2022, true);
  const edits: { at: number; text: string }[] = [];
  for (const declaration of parsed.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body) continue;
    const name = declaration.name?.text;
    if (name !== 'reserveBoundedJsonRelational' && name !== 'relationalRoot') continue;
    const meta = name === 'relationalRoot' ? 'undefined' : 'metadata';
    if (name === 'relationalRoot') edits.push({ at: declaration.body.getStart(parsed) + 1, text: '__observe("R entry", u);' });
    const wrap = (node: ts.Node, marker: string, m = meta) => {
      edits.push({ at: node.getStart(parsed), text: `__after(${JSON.stringify(marker)}, (` });
      edits.push({ at: node.end, text: `), ${m})` });
    };
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (node.left.getText(parsed) === 'metadata.rightText') wrap(node, 'right retained');
        if (node.left.getText(parsed) === 'metadata.parserScratch') wrap(node, 'P0 flag');
      }
      if (name === 'relationalRoot') {
        if (ts.isCallExpression(node) && ['relationalAdd', 'relationalMul', 'relationalBlocks'].includes(node.expression.getText(parsed))) wrap(node, 'R arithmetic');
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'budget.reserve') wrap(node, node.arguments[0].getText(parsed).includes('slots') ? 'R workspace' : 'R F');
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'budget.spend') wrap(node, 'R work');
        if (ts.isReturnStatement(node) && !node.expression) edits.push({ at: node.getStart(parsed), text: '__observe("R returned", u);' });
      } else if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'relationalRoot') {
        wrap(node, node.arguments[0].getText(parsed).includes('left') ? 'left R returned' : 'right R returned');
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.body);
  }
  let instrumented = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) instrumented = instrumented.slice(0, edit.at) + edit.text + instrumented.slice(edit.at);
  instrumented += '\nexports.root = typeof relationalRoot === "function" ? relationalRoot : undefined;';
  const compiled = ts.transpileModule(instrumented, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as { reserveBoundedJsonRelational: typeof json.reserveBoundedJsonRelational; parseRegisteredBoundedJson: typeof json.parseRegisteredBoundedJson; root?: (u: number, budget: BudgetContext) => void };
  new Function('exports', 'require', '__observe', '__after', compiled)(exports, (id: string) => {
    if (id !== './boundedWork') throw new Error(`Unexpected actual-module dependency ${id}`);
    return relationalWork;
  }, observe, (marker: string, value: unknown, metadata?: RelationalMetadataProbe) => { observe(marker, value, metadata); return value; });
  return exports;
}

describe('relational SUFFIX P0 consumer', () => {
  it('reaches actual parser flag after both retained triples (connectivity only)', () => {
    const markers: string[] = [];
    const stop = new Error('explicit P0 flag boundary stop');
    const probe = suffixProbe(marker => { markers.push(marker); if (marker === 'P0 flag') throw stop; });
    let caught: unknown;
    try { probe.reserveBoundedJsonRelational('', '', createBudgetContext({ now: () => 0 })); } catch (error) { caught = error; }
    expect(markers).toEqual(['right retained', 'P0 flag']); expect(caught).toBe(stop);
  });
});


describe('relational SUFFIX P0 reached guards', () => {
  for (const [label, left, right] of [['left empty', '', 0], ['right empty', 0, ''], ['both text', '한', '😀']] as const) {
    for (const [dimension, cost] of [['nodes', 1], ['structuralBytes', 8192], ['work', 1]] as const) {
      for (const delta of [-1, 0, 1]) it(`${label} ${dimension} flag allowance ${delta}`, () => {
        const base = createBudgetContext({ now: () => 0 });
        const stop = new Error('explicit stop after real P0 flag, before R');
        let reached = false, flagged = false;
        const probe = suffixProbe((marker, _value, metadata) => {
          if (marker === 'right retained') {
            reached = true;
            expect(metadata!.parserScratch).toBe(false);
            const remaining = base.limits[dimension] - base.usage()[dimension] - cost - delta;
            if (dimension === 'work') base.spend(remaining); else base.reserve({ [dimension]: remaining });
          }
          if (marker === 'P0 flag') { flagged = true; expect(metadata!.parserScratch).toBe(true); throw stop; }
        });
        let caught: unknown;
        try { probe.reserveBoundedJsonRelational(left, right, base); } catch (error) { caught = error; }
        expect(reached).toBe(true);
        if (delta < 0) { expect(flagged).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError); }
        else { expect(flagged).toBe(true); expect(caught).toBe(stop); expect(base.limits[dimension] - base.usage()[dimension]).toBe(delta); }
      });
    }
  }
});


describe('relational SUFFIX R consumer', () => {
  it('calls separate left and right root consumers after one P0 (connectivity only)', () => {
    const markers: string[] = [];
    const inputs: unknown[] = [];
    const stop = new Error('explicit stop after second real R return');
    const probe = suffixProbe((marker, value) => {
      if (['right retained', 'P0 flag', 'R entry', 'R returned', 'left R returned', 'right R returned'].includes(marker)) markers.push(marker);
      if (marker === 'R entry') inputs.push(value);
      if (marker === 'right R returned') throw stop;
    });
    let caught: unknown;
    try { probe.reserveBoundedJsonRelational('A', '한한', createBudgetContext({ now: () => 0 })); } catch (error) { caught = error; }
    expect(inputs).toEqual([1, 2]);
    expect(markers).toEqual(['right retained', 'P0 flag', 'R entry', 'R returned', 'left R returned', 'R entry', 'R returned', 'right R returned']);
    expect(caught).toBe(stop);
  });
});


// Independent literal root costs: U, q, F bytes, workspace bytes, work.
const rootRequirements = [[0, 0, 16, 16, 4], [1, 1, 18, 24, 8], [255, 1, 526, 2056, 8],
  [256, 1, 528, 2064, 8], [257, 2, 530, 2072, 12], [511, 2, 1038, 4104, 12],
  [512, 2, 1040, 4112, 12], [513, 3, 1042, 4120, 16]] as const;
describe('relational SUFFIX R reached recipe', () => {
  for (const side of ['left', 'right'] as const) {
    for (const [u, , f, workspace, work] of rootRequirements) {
      for (const [dimension, cost] of [['nodes', 2], ['slots', u], ['structuralBytes', f + workspace], ['work', work]] as const) {
        for (const delta of cost === 0 ? [0, 1] : [-1, 0, 1]) it(`${side} U=${u} ${dimension} root-return allowance ${delta}`, () => {
          const budget = createBudgetContext({ now: () => 0 });
          let reached = false, returned = false;
          const stop = new Error('explicit root return boundary before successor');
          const probe = suffixProbe(marker => {
            if (marker === 'R entry') {
              reached = true;
              const remaining = budget.limits[dimension] - budget.usage()[dimension] - cost - delta;
              if (dimension === 'work') budget.spend(remaining); else budget.reserve({ [dimension]: remaining });
            }
            if (marker === 'R returned') { returned = true; throw stop; }
          });
          let caught: unknown;
          try { probe.reserveBoundedJsonRelational(side === 'left' ? '한'.repeat(u) : 0, side === 'right' ? '한'.repeat(u) : 0, budget); } catch (error) { caught = error; }
          expect(reached).toBe(true);
          if (delta < 0) { expect(returned).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError); }
          else { expect(returned).toBe(true); expect(caught).toBe(stop); expect(budget.limits[dimension] - budget.usage()[dimension]).toBe(delta); }
        });
      }
    }
  }
  for (const u of [-1, 0.5, NaN, Infinity, 9007199254740992, 8000001]) {
    it(`private reached root U=${String(u)} refuses before derived arithmetic or return`, () => {
      let reached = false, returned = false, arithmetic = false;
      const probe = suffixProbe(marker => { if (marker === 'R entry') reached = true; if (marker === 'R returned') returned = true; if (marker === 'R arithmetic') arithmetic = true; });
      let caught: unknown;
      try { probe.root!(u, createBudgetContext({ now: () => 0 })); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(returned).toBe(false); expect(arithmetic).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
  for (const cap of [-1, 0.5, NaN, Infinity, 9007199254740992, 0]) {
    it(`private reached root cap=${String(cap)} refuses U=1 before derived arithmetic or return`, () => {
      let reached = false, returned = false, arithmetic = false;
      const base = createBudgetContext({ now: () => 0 });
      const budget = { ...base, limits: { ...base.limits, stringBytes: cap } };
      const probe = suffixProbe(marker => { if (marker === 'R entry') reached = true; if (marker === 'R returned') returned = true; if (marker === 'R arithmetic') arithmetic = true; });
      let caught: unknown;
      try { probe.root!(1, budget); } catch (error) { caught = error; }
      expect(reached).toBe(true); expect(returned).toBe(false); expect(arithmetic).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError);
    });
  }
});


describe('relational SUFFIX R own completion', () => {
  for (const route of ['left', 'right', 'private'] as const) {
    for (const mode of ['timely', 'expired', 'aborted'] as const) {
      for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${route} R work exit ${mode}/${outcome} before local return`, () => {
        let clock = 0, reached = false, returned = false, callerReturned = false;
        const signal = { aborted: false };
        const budget = createBudgetContext({ now: () => clock, signal });
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('R native-work exit');
        const stop = new Error('explicit timely R successor stop');
        const probe = suffixProbe(marker => {
          if (marker === 'R work') {
            reached = true;
            if (mode === 'expired') clock = 5000;
            if (mode === 'aborted') signal.aborted = true;
            if (outcome !== 'success') throw sentinel;
          }
          if (marker === 'R returned') returned = true;
          if (marker === 'left R returned' || marker === 'right R returned') { callerReturned = true; throw stop; }
        });
        let caught: unknown;
        try {
          if (route === 'private') probe.root!(1, budget);
          else probe.reserveBoundedJsonRelational(route === 'left' ? 'A' : 0, route === 'right' ? 'A' : 0, budget);
        } catch (error) { caught = error; }
        expect(reached).toBe(true);
        if (mode === 'timely' && outcome === 'success') {
          expect(returned).toBe(true); expect(callerReturned).toBe(route !== 'private'); expect(caught).toBe(route === 'private' ? undefined : stop);
        } else {
          expect(returned).toBe(false); expect(callerReturned).toBe(false);
          if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
          else expect(caught).toBeInstanceOf(BudgetUnavailableError);
        }
      });
    }
  }
});

describe('relational SUFFIX final consumer', () => {
  it('completes both roots and returns void (connectivity only)', () => {
    const markers: string[] = [];
    const probe = suffixProbe(marker => { if (marker === 'right R returned') markers.push(marker); });
    let caught: unknown, returned = false, value: unknown;
    try { value = probe.reserveBoundedJsonRelational('', '', createBudgetContext({ now: () => 0 })); returned = true; } catch (error) { caught = error; }
    expect(markers).toEqual(['right R returned']); expect(returned).toBe(true); expect(value).toBeUndefined(); expect(caught).toBeUndefined();
  });
});


describe('relational SUFFIX final work', () => {
  for (const side of ['left', 'right', 'both'] as const) for (const allowance of [1, 2, 3]) {
    it(`${side} final2 allowance ${allowance} after last real root return`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      let reached = false, returned = false;
      const probe = suffixProbe(marker => {
        if (marker === (side === 'left' ? 'left R returned' : 'right R returned')) {
          reached = true; budget.spend(budget.limits.work - budget.usage().work - allowance);
        }
      });
      let caught: unknown;
      try { probe.reserveBoundedJsonRelational(side === 'right' ? 0 : '', side === 'left' ? 0 : '', budget); returned = true; } catch (error) { caught = error; }
      expect(reached).toBe(true);
      if (allowance === 1) { expect(returned).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError); }
      else { expect(returned).toBe(true); expect(caught).toBeUndefined(); expect(budget.limits.work - budget.usage().work).toBe(allowance - 2); }
    });
  }
});


describe('relational SUFFIX final completion', () => {
  for (const side of ['left', 'right', 'both'] as const) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${side} final2 exit ${mode}/${outcome} own void boundary`, () => {
      let clock = 0, armed = false, reached = false, returned = false;
      const signal = { aborted: false };
      const base = createBudgetContext({ now: () => clock, signal });
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('public final2 exit');
      const budget: BudgetContext = { ...base, spend(amount) {
        base.spend(amount);
        if (armed) {
          expect(amount).toBe(2); reached = true;
          if (mode === 'expired') clock = 5000;
          if (mode === 'aborted') signal.aborted = true;
          if (outcome !== 'success') throw sentinel;
        }
      } };
      const probe = suffixProbe(marker => { if (marker === (side === 'left' ? 'left R returned' : 'right R returned')) armed = true; });
      let caught: unknown;
      try { probe.reserveBoundedJsonRelational(side === 'right' ? 0 : '', side === 'left' ? 0 : '', budget); returned = true; } catch (error) { caught = error; }
      expect(armed).toBe(true); expect(reached).toBe(true);
      if (mode === 'timely' && outcome === 'success') { expect(returned).toBe(true); expect(caught).toBeUndefined(); }
      else {
        expect(returned).toBe(false);
        if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
        else expect(caught).toBeInstanceOf(BudgetUnavailableError);
      }
    });
  }
});


// Test-only caller-shaped seam. This is NOT a production integration or permit.
function relationalCaller(source: { left: unknown; right: unknown }, budget: BudgetContext,
  reservation: typeof json.reserveBoundedJsonRelational = json.reserveBoundedJsonRelational,
  observe: (phase: string) => void = () => {}): number {
  const left = source.left, right = source.right;
  reservation(left, right, budget);
  try {
    observe('< entry');
    const less = (left as never) < (right as never);
    observe('< exit');
    budget.check();
    if (less) return -1;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
  reservation(left, right, budget);
  try {
    observe('> entry');
    const greater = (left as never) > (right as never);
    observe('> exit');
    budget.check();
    return greater ? 1 : 0;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

describe('relational CALLER fresh reservation guard', () => {
  for (const [left, right, expected, calls] of [['100', '3', -1, 1], ['3', '100', 1, 2], ['', '', 0, 2], [undefined, 0, 0, 2], [20, '100', -1, 1]] as const) {
    it(`raw ${String(left)}/${String(right)} capture once full recipe per reached operator`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      const trace: string[] = [], operands: unknown[][] = [];
      const source = { get left() { trace.push('read left'); return left; }, get right() { trace.push('read right'); return right; } };
      const actual = relationalCaller(source, budget, (a, b, context) => { trace.push('prepare'); operands.push([a, b, context]); prepare(a, b, context); }, phase => trace.push(phase));
      expect(actual).toBe(expected); expect(actual).toBe(originalComparator()(left, right));
      expect(operands).toHaveLength(calls);
      for (const pair of operands) { expect(pair[0]).toBe(left); expect(pair[1]).toBe(right); expect(pair[2]).toBe(budget); }
      expect(trace).toEqual(calls === 1 ? ['read left', 'read right', 'prepare', '< entry', '< exit'] : ['read left', 'read right', 'prepare', '< entry', '< exit', 'prepare', '> entry', '> exit']);
      const cost = ledger(left, right).total.map(n => n * calls);
      expect((['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const).map(k => budget.usage()[k])).toEqual(cost);
    });
  }
  for (const phase of ['first', 'second'] as const) for (const delta of [-1, 0, 1]) {
    it(`${phase} complete L work allowance ${delta} blocks raw operator before evaluation`, () => {
      // Equal raw operands force the second operation. Independent L('', '')=22.
      const budget = createBudgetContext({ now: () => 0, limits: { work: (phase === 'first' ? 22 : 44) + delta } });
      const entries: string[] = [];
      let returned = false, caught: unknown;
      try { relationalCaller({ left: '', right: '' }, budget, prepare, marker => { if (marker.endsWith('entry')) entries.push(marker); }); returned = true; } catch (error) { caught = error; }
      if (phase === 'first') {
        expect(caught).toBeInstanceOf(BudgetExceededError); expect(returned).toBe(false); expect(entries).toEqual(delta < 0 ? [] : ['< entry']);
      } else if (delta < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(returned).toBe(false); expect(entries).toEqual(['< entry']); }
      else { expect(caught).toBeUndefined(); expect(returned).toBe(true); expect(entries).toEqual(['< entry', '> entry']); }
    });
  }
});


describe('relational CALLER native completion', () => {
  for (const branch of ['less true', 'less false', 'greater true', 'greater false'] as const) {
    for (const side of ['left', 'right'] as const) for (const mode of ['timely', 'expired', 'aborted'] as const) {
      for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${branch} ${side} native conversion ${mode}/${outcome} owned exit`, () => {
        let clock = 0, phase = '', reached = false, returned = false, preparations = 0;
        const signal = { aborted: false };
        const budget = createBudgetContext({ now: () => clock, signal });
        const left = json.parseRegisteredBoundedJson(branch === 'less true' ? '[1]' : '[2]', budget);
        const right = json.parseRegisteredBoundedJson(branch === 'greater false' ? '[2]' : branch === 'less true' ? '[2]' : '[1]', budget);
        const target = branch.startsWith('less') ? '< entry' : '> entry';
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('actual native valueOf');
        const saved = Object.prototype.valueOf;
        const trace: string[] = [];
        let caught: unknown, result: unknown;
        try {
          Object.prototype.valueOf = function () {
            if (this === left || this === right) {
              const currentSide = this === left ? 'left' : 'right';
              trace.push(`${phase}:${currentSide}`);
              if (phase === target && currentSide === side) {
                reached = true;
                if (mode === 'expired') clock = 5000;
                if (mode === 'aborted') signal.aborted = true;
                if (outcome !== 'success') throw sentinel;
              }
            }
            return Reflect.apply(saved, this, []);
          };
          result = relationalCaller({ left, right }, budget, (a, b, owner) => { preparations++; prepare(a, b, owner); }, marker => { phase = marker; });
          returned = true;
        } catch (error) { caught = error; }
        finally { Object.prototype.valueOf = saved; }
        // All observers restored before assertions, including frozen oracle execution.
        expect(reached).toBe(true);
        const expectedPreparations = target === '> entry' ? 2 : 1;
        if (mode === 'timely' && outcome === 'success') {
          expect(returned).toBe(true); expect(caught).toBeUndefined(); expect(result).toBe(originalComparator()(left, right));
          expect(preparations).toBe(branch === 'less true' ? 1 : 2);
        } else {
          expect(returned).toBe(false); expect(preparations).toBe(expectedPreparations);
          if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
          else expect(caught).toBeInstanceOf(BudgetUnavailableError);
        }
        const expected: string[] = target === '> entry' ? ['< entry:left', '< entry:right'] : [];
        expected.push(`${target}:left`);
        if (side === 'right' || outcome === 'success') expected.push(`${target}:right`);
        if (mode === 'timely' && outcome === 'success' && branch === 'less false') expected.push('> entry:left', '> entry:right');
        expect(trace).toEqual(expected);
      });
    }
  }
});


describe('relational SUFFIX ordered component controls', () => {
  for (const side of ['left', 'right'] as const) for (const [u, , f, workspace, work] of rootRequirements) {
    for (const component of ['F', 'workspace'] as const) {
      for (const dimension of component === 'F' ? ['nodes', 'structuralBytes'] as const : ['nodes', 'slots', 'structuralBytes'] as const) {
        const cost = dimension === 'nodes' ? 1 : dimension === 'slots' ? u : component === 'F' ? f : workspace;
        for (const delta of cost === 0 ? [0, 1] : [-1, 0, 1]) it(`${side} R ${component} U=${u} ${dimension} ${delta} before actual next component`, () => {
          const base = createBudgetContext({ now: () => 0 });
          let active = false, reservations = 0, reached = false, successor = false;
          const stop = new Error('explicit next real R component stop');
          const budget: BudgetContext = { ...base,
            reserve(amount) {
              if (active) {
                reservations++;
                if (component === 'F' && reservations === 2) { successor = true; throw stop; }
                if (reservations === (component === 'F' ? 1 : 2)) {
                  reached = true; base.reserve({ [dimension]: base.limits[dimension] - base.usage()[dimension] - cost - delta });
                }
              }
              base.reserve(amount);
            },
            spend(amount) { if (active && component === 'workspace') { successor = true; throw stop; } base.spend(amount); },
          };
          const probe = suffixProbe(marker => { if (marker === 'R entry') active = true; });
          let caught: unknown;
          try { probe.reserveBoundedJsonRelational(side === 'left' ? '한'.repeat(u) : 0, side === 'right' ? '한'.repeat(u) : 0, budget); } catch (error) { caught = error; }
          expect(reached).toBe(true); expect(successor).toBe(delta >= 0);
          if (delta < 0) expect(caught).toBeInstanceOf(BudgetExceededError);
          else { expect(caught).toBe(stop); expect(base.limits[dimension] - base.usage()[dimension]).toBe(delta); }
        });
      }
    }
    it(`${side} R U=${u} exact separate ordered events no content debit`, () => {
      const base = createBudgetContext({ now: () => 0 });
      const events: unknown[] = [];
      let active = false;
      const stop = new Error('explicit R completed event stop');
      const budget: BudgetContext = { ...base,
        reserve(cost) { if (active) events.push(cost); base.reserve(cost); },
        reserveString(bytes) { if (active) events.push(['forbidden string', bytes]); base.reserveString(bytes); },
        spend(amount) { if (active) events.push(['work', amount]); base.spend(amount); },
      };
      const probe = suffixProbe(marker => { if (marker === 'R entry') active = true; if (marker === 'R returned') throw stop; });
      expect(() => probe.reserveBoundedJsonRelational(side === 'left' ? '한'.repeat(u) : 0, side === 'right' ? '한'.repeat(u) : 0, budget)).toThrow(stop);
      expect(events).toEqual([{ nodes: 1, structuralBytes: f }, { nodes: 1, slots: u, structuralBytes: workspace }, ['work', work]]);
    });
  }
  for (const pair of [[0, undefined], ['', 0], [0, ''], ['', ''], ['A', '한']] as const) it(`P0 once and ordered ${String(pair[0])}/${String(pair[1])}`, () => {
    const base = createBudgetContext({ now: () => 0 });
    const events: unknown[] = [];
    let retained: RelationalMetadataProbe | undefined, flagged: RelationalMetadataProbe | undefined, active = false;
    const budget: BudgetContext = { ...base, reserve(cost) { if (active) events.push(cost); base.reserve(cost); }, spend(amount) { if (active) events.push(amount); base.spend(amount); } };
    const probe = suffixProbe((marker, _value, metadata) => {
      if (marker === 'right retained') { active = true; retained = metadata; expect(metadata!.parserScratch).toBe(false); }
      if (marker === 'P0 flag') { flagged = metadata; events.push('flag'); }
      if (marker === 'R entry') active = false;
    });
    expect(probe.reserveBoundedJsonRelational(pair[0], pair[1], budget)).toBeUndefined();
    if (typeof pair[0] === 'string' || typeof pair[1] === 'string') {
      expect(events).toEqual([{ nodes: 1, structuralBytes: 8192 }, 1, 'flag']); expect(flagged).toBe(retained); expect(flagged!.parserScratch).toBe(true);
    } else { expect(events).toEqual([]); expect(flagged).toBeUndefined(); }
  });
});

describe('relational SUFFIX full independent L', () => {
  const specimens: [unknown, unknown, Vector][] = [
    [0, undefined, [1, 8, 0, 80, 8]], ['', '', [9, 20, 0, 8480, 22]],
    [[], [], [77, 1044, 0, 24904, 37]], [[[], [], [], []], '', [87, 1051, 3, 25080, 81]],
    [[[['A']]], '', [82, 1048, 3, 25002, 68]],
    [['한', '😀', '\ud800', 1, true, null], '', [82, 1123, 143, 26008, 72]],
  ];
  const keys = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const;
  for (const [index, [a, b, literal]] of specimens.entries()) for (const reverse of [false, true]) {
    for (const [dimension, key] of keys.entries()) for (const delta of literal[dimension] === 0 ? [0, 1] : [-1, 0, 1]) {
      it(`literal V2 specimen ${index} reverse=${reverse} full ${key} allowance ${delta}`, () => {
        const budget = createBudgetContext({ now: () => 0 });
        const admit = (v: unknown) => v !== null && typeof v === 'object' ? json.parseRegisteredBoundedJson(JSON.stringify(v), budget) : v;
        const left = admit(reverse ? b : a), right = admit(reverse ? a : b);
        expect(ledger(left, right).total).toEqual(literal);
        const remaining = budget.limits[key] - budget.usage()[key] - literal[dimension] - delta;
        if (key === 'work') budget.spend(remaining); else budget.reserve({ [key]: remaining });
        const before = budget.usage();
        let caught: unknown, returned = false;
        try { prepare(left, right, budget); returned = true; } catch (error) { caught = error; }
        if (delta < 0) { expect(returned).toBe(false); expect(caught).toBeInstanceOf(BudgetExceededError); }
        else { expect(returned).toBe(true); expect(caught).toBeUndefined(); expect(keys.map(k => budget.usage()[k] - before[k])).toEqual(literal); }
      });
    }
  }
  it('same registered empty roots repeated invocation fully recharges exact literal V2 pair', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const graph = json.parseRegisteredBoundedJson('[]', budget);
    const before = budget.usage();
    prepare(graph, graph, budget); prepare(graph, graph, budget);
    expect(keys.map(k => budget.usage()[k] - before[k])).toEqual([154, 2088, 0, 49808, 74]);
  });
});

describe('relational CALLER frozen native domain parity', () => {
  it('executes pinned Git comparator across raw primitives and registered array/record pairs in both directions', () => {
    const compare = originalComparator();
    const descriptions: unknown[] = [0, -0, -3, 0.125, Number.MIN_VALUE, Number.MAX_VALUE, true, false, null, undefined,
      '', ' ', '0x10', '1e2', 'invalid', '100', '3', 'a\0b', '한😀\ud800', 'a'.repeat(256) + '😀',
      [], [null], [2], [[1], [], true], ['한', {}, null], {}, { valueOf: [] }, { toString: [] }, { valueOf: [], toString: {} }];
    const outcome = (call: () => number) => { try { return { result: call() }; } catch (error) { return { name: (error as Error).name, message: (error as Error).message }; } };
    for (const description of descriptions) for (const other of [0, '10', undefined, []]) for (const reverse of [false, true]) {
      const budget = createBudgetContext({ now: () => 0 });
      const admit = (v: unknown) => v !== null && typeof v === 'object' ? json.parseRegisteredBoundedJson(JSON.stringify(v), budget) : v;
      const left = admit(reverse ? other : description), right = admit(reverse ? description : other);
      expect(outcome(() => relationalCaller({ left, right }, budget))).toEqual(outcome(() => compare(left, right)));
    }
    for (const side of ['left', 'right'] as const) {
      const budget = createBudgetContext({ now: () => 0 });
      const parsed = json.parseRegisteredBoundedJson('{}', budget);
      const graph = json.cloneFreezeBoundedJson(parsed, budget);
      const left = side === 'left' ? graph : 0, right = side === 'right' ? graph : 0;
      let reservations = 0; const phases: string[] = [];
      const actual = outcome(() => relationalCaller({ left, right }, budget, (a, b, owner) => { reservations++; prepare(a, b, owner); }, p => phases.push(p)));
      expect(actual).toEqual(outcome(() => compare(left, right))); expect(actual.name).toBe('TypeError');
      expect(reservations).toBe(1); expect(phases).toEqual(['< entry']);
    }
  });
  it('preparation invokes zero native conversion or method probes for real registered graphs', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const left = json.parseRegisteredBoundedJson('[[1],{},null]', budget), right = json.parseRegisteredBoundedJson('{"valueOf":[],"toString":{}}', budget);
    const savedValue = Object.prototype.valueOf, savedString = Object.prototype.toString, savedArray = Array.prototype.toString;
    let conversions = 0, caught: unknown;
    try {
      Object.prototype.valueOf = function () { conversions++; return Reflect.apply(savedValue, this, []); };
      Object.prototype.toString = function () { conversions++; return Reflect.apply(savedString, this, []); };
      Array.prototype.toString = function () { conversions++; return Reflect.apply(savedArray, this, []); };
      prepare(left, right, budget);
    } catch (error) { caught = error; }
    finally { Object.prototype.valueOf = savedValue; Object.prototype.toString = savedString; Array.prototype.toString = savedArray; }
    expect(caught).toBeUndefined(); expect(conversions).toBe(0);
  });
});


describe('relational SUFFIX record full L capacity', () => {
  for (const text of ['{}', '{"valueOf":[],"toString":{}}']) for (const side of ['left', 'right'] as const) {
    for (const key of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) for (const delta of [-1, 0, 1]) {
      it(`${side} ${text} full independent ${key} allowance ${delta}`, () => {
        const budget = createBudgetContext({ now: () => 0 });
        const graph = json.parseRegisteredBoundedJson(text, budget);
        const left = side === 'left' ? graph : '한', right = side === 'right' ? graph : '한';
        const keys = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const;
        const expected = ledger(left, right).total;
        const cost = expected[keys.indexOf(key)];
        const remaining = budget.limits[key] - budget.usage()[key] - cost - delta;
        if (key === 'work') budget.spend(remaining); else budget.reserve({ [key]: remaining });
        const before = budget.usage();
        let caught: unknown, returned = false;
        try { prepare(left, right, budget); returned = true; } catch (error) { caught = error; }
        if (delta < 0) { expect(caught).toBeInstanceOf(BudgetExceededError); expect(returned).toBe(false); }
        else { expect(caught).toBeUndefined(); expect(returned).toBe(true); expect(keys.map(k => budget.usage()[k] - before[k])).toEqual(expected); }
      });
    }
  }
});

describe('relational CALLER actual original conversion and TypeError exits', () => {
  it('matches actual Git native source-left conversion traces for both operators without preparation conversions', () => {
    const compare = originalComparator();
    const budget = createBudgetContext({ now: () => 0 });
    const left = json.parseRegisteredBoundedJson('[2]', budget), right = json.parseRegisteredBoundedJson('[1]', budget);
    const saved = Object.prototype.valueOf;
    let trace: string[] = [], originalTrace: string[] = [], candidateTrace: string[] = [];
    let original: unknown, candidate: unknown, caught: unknown;
    try {
      Object.prototype.valueOf = function () {
        if (this === left) trace.push('left');
        if (this === right) trace.push('right');
        return Reflect.apply(saved, this, []);
      };
      original = compare(left, right); originalTrace = trace; trace = [];
      candidate = relationalCaller({ left, right }, budget); candidateTrace = trace;
    } catch (error) { caught = error; }
    finally { Object.prototype.valueOf = saved; }
    expect(caught).toBeUndefined(); expect(candidate).toBe(original);
    expect(originalTrace).toEqual(['left', 'right', 'left', 'right']); expect(candidateTrace).toEqual(originalTrace);
  });
  for (const side of ['left', 'right'] as const) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    it(`${side} actual shadow-method TypeError ${mode} forbids second preparation`, () => {
      let clock = 0, reached = false, reservations = 0;
      const signal = { aborted: false };
      const budget = createBudgetContext({ now: () => clock, signal });
      const graph = json.parseRegisteredBoundedJson('{"toString":[]}', budget);
      const left = side === 'left' ? graph : 0, right = side === 'right' ? graph : 0;
      const compare = originalComparator();
      let original: unknown;
      try { compare(left, right); } catch (error) { original = error; }
      const saved = Object.prototype.valueOf;
      let caught: unknown;
      try {
        Object.prototype.valueOf = function () {
          if (this === graph) { reached = true; if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; }
          return Reflect.apply(saved, this, []);
        };
        relationalCaller({ left, right }, budget, (a, b, context) => { reservations++; prepare(a, b, context); });
      } catch (error) { caught = error; }
      finally { Object.prototype.valueOf = saved; }
      expect(reached).toBe(true); expect(reservations).toBe(1); expect(original).toBeInstanceOf(TypeError);
      if (mode === 'timely') { expect(caught).toBeInstanceOf(TypeError); expect((caught as Error).message).toBe((original as Error).message); }
      else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});
