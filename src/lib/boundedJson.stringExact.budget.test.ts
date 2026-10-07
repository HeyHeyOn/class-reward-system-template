import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import * as graph from './boundedJson';
import * as work from './boundedWork';
import { createBudgetContext, BudgetExceededError, BudgetUnavailableError, type BudgetContext } from './boundedWork';

type Vector = [number, number, number, number, number];
type Event = { label: string; cost: Vector };
const specimens = [undefined, null, 0, -0, -3, 0.125, Number.MIN_VALUE, Number.MAX_VALUE, true, false,
  '', '0', ' \t', '\0', '0xff', '1e2', '한', '😀', '\ud800', '\udc00',
  ...[1, 255, 256, 257, 511, 512, 513].map(n => 'a'.repeat(n)), 'a'.repeat(255) + '😀'];

// Arithmetic-only independent iterative occurrence model, never native String.
function model(value: unknown) {
  const events: Event[] = [];
  const emit = (label: string, cost: Vector) => events.push({ label, cost });
  const q = (u: number) => Math.ceil(u / 256);
  const f = (u: number) => emit('F', [1, 0, 0, 16 + 2 * u, 0]);
  const m = (u: number, b: number) => {
    emit('result', [1, 0, b, 4, 0]); f(u); emit('M work', [0, 0, 0, 0, 2 + 2 * q(u)]);
  };
  emit('O', [1, 8, 0, 80, 0]); emit('O work', [0, 0, 0, 0, 1]);
  emit('H', [1, 4, 0, 48, 0]); emit('H work', [0, 0, 0, 0, 1]);
  if (value !== null && typeof value === 'object') {
    emit('G base', [64, 256, 0, 8192, 0]); emit('G supplement', [0, 768, 0, 8192, 0]); emit('G work', [0, 0, 0, 0, 1]);
  }
  const stack = [{ value, element: false, entered: false, index: 0, u: 0, b: 0 }];
  let u = 0, b = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1], v = frame.value;
    if (!frame.entered) {
      frame.entered = true; emit('visit', [0, 0, 0, 0, 1]);
      if (Array.isArray(v)) {
        emit('shape/method/length', [0, 0, 0, 0, 6]); frame.u = frame.b = Math.max(0, v.length - 1);
        emit('J', [1, v.length, 0, 16 + 4 * v.length, 0]); emit('J work', [0, 0, 0, 0, v.length + q(frame.u)]);
      } else {
        if (typeof v === 'string') {
          u = v.length; b = Buffer.byteLength(v, 'utf8'); emit('length', [0, 0, 0, 0, 1]); f(u);
          emit('source flatten', [0, 0, 0, 0, q(u)]);
          for (let block = 0; block < q(u); block++) emit('scan block', [0, 0, 0, 0, 1]);
        } else {
          u = b = v === null ? (frame.element ? 0 : 4) : v === undefined ? (frame.element ? 0 : 9)
            : typeof v === 'boolean' ? 5 : typeof v === 'number' ? 32 : 15;
          if (v !== null && typeof v === 'object') emit('record shape/method', [0, 0, 0, 0, 5]);
          if (frame.element && v != null) m(u, b);
        }
        stack.pop();
        if (stack.length) { stack[stack.length - 1].u += u; stack[stack.length - 1].b += b; }
        continue;
      }
    }
    const array = v as unknown[];
    if (frame.index < array.length) {
      emit('index', [0, 0, 0, 0, 1]); stack.push({ value: array[frame.index++], element: true, entered: false, index: 0, u: 0, b: 0 });
    } else {
      u = frame.u; b = frame.b; m(u, b); stack.pop();
      if (stack.length) { stack[stack.length - 1].u += u; stack[stack.length - 1].b += b; }
    }
  }
  m(u, b);
  const total: Vector = [0, 0, 0, 0, 0];
  for (const event of events) event.cost.forEach((n, i) => { total[i] += n; });
  return { u, b, events, total };
}
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const oracleRoot = 'test-support/frozen-oracles/448cbed7bd303ad0f9ef3fd4c974c313bf4c8da8/';
function originalCaller(value: unknown): string {
  const source = readFileSync(oracleRoot + 'src/server/migration/normalize.ts.txt', 'utf8');
  const ast = ts.createSourceFile('original.ts', source, ts.ScriptTarget.ES2022, true);
  const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'sourcePath');
  if (!declaration) throw new Error('missing pinned original sourcePath');
  const code = ts.transpile(declaration.getText(ast), { target: ts.ScriptTarget.ES2022 });
  const stop = {}, output: string[] = [];
  const invoke = new Function('String', code + '; return sourcePath;')((operand: unknown) => {
    expect(operand).toBe(value); output.push(String(operand)); throw stop;
  });
  try { invoke({ kind: 'SHEET', tab: 'oracle', rowNumber: value }); } catch (error) { if (error !== stop) throw error; }
  expect(output).toHaveLength(1); return output[0];
}
function call(value: unknown, budget: BudgetContext): string {
  return (graph as unknown as { stringBoundedJsonExact(v: unknown, b: BudgetContext): string }).stringBoundedJsonExact(value, budget);
}
function usage(budget: BudgetContext): Vector {
  const u = budget.usage(); return [u.nodes, u.slots, u.contentBytes, u.structuralBytes, u.work];
}
// Only the new island is transformed; full real graph module retains registry/dependencies.
function load(transform: (source: string) => string = s => s, hooks: Record<string, unknown> = {}) {
  const source = readFileSync('src/lib/boundedJson.ts', 'utf8');
  const begin = source.indexOf('/** Exact String scalar increment.');
  const end = source.indexOf('const SHEET_LEGACY_KEYS');
  if (begin < 0 || end < begin) throw new Error('new island absent');
  const island = transform(source.slice(begin, end));
  const modified = source.slice(0, begin) + island + source.slice(end);
  const output = ts.transpile(modified, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const exports: Record<string, (...args: never[]) => unknown> = {};
  new Function('exports', 'require', ...Object.keys(hooks), output)(exports, (name: string) => {
    if (name === './boundedWork') return work; throw new Error('unexpected dependency ' + name);
  }, ...Object.values(hooks));
  return exports as unknown as { stringBoundedJsonExact(v: unknown, b: BudgetContext): string; [name: string]: unknown };
}
function replace(source: string, from: string, to: string) {
  if (source.split(from).length !== 2) throw new Error('nonunique boundary ' + from);
  return source.replace(from, to);
}


describe('GS01 root admission', () => {
  for (const [i, value] of [NaN, Infinity, -Infinity, Symbol('bad'), BigInt(1), () => 0, {}, [], Object.freeze({})].entries()) {
    it(`unsupported root ${i} refuses before native`, () => {
      let native = 0;
      const entry = load(s => s, { String(v: unknown) { native++; return String(v); } });
      expect(() => entry.stringBoundedJsonExact(value, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.');
      expect(native).toBe(0);
    });
  }
  it('revoked proxy is rejected without property access', () => {
    const pair = Proxy.revocable({}, {}); pair.revoke();
    expect(() => call(pair.proxy, createBudgetContext({ now: () => 0 }))).toThrow('Legacy bounded JSON is invalid.');
  });
  it('entry refuses before native or reservation', () => {
    let native = 0, reservations = 0;
    const sentinel = new BudgetUnavailableError();
    const base = createBudgetContext({ now: () => 0 });
    const entry = load(s => s, { String(v: unknown) { native++; return String(v); } });
    expect(() => entry.stringBoundedJsonExact(null, { ...base, check() { throw sentinel; }, reserve(c) { reservations++; base.reserve(c); } })).toThrow(sentinel);
    expect(native).toBe(0); expect(reservations).toBe(0);
  });
  it('root depth is requested once and refuses before native', () => {
    let native = 0; const depths: number[] = [];
    const base = createBudgetContext({ now: () => 0, limits: { depth: 0 } });
    const entry = load(s => s, { String(v: unknown) { native++; return String(v); } });
    expect(() => entry.stringBoundedJsonExact(null, { ...base, checkDepth(d) { depths.push(d); base.checkDepth(d); } })).toThrow(BudgetExceededError);
    expect(depths).toEqual([1]); expect(native).toBe(0);
  });
});


describe('GS02 preparation declaration setup only', () => {
  it('constructs and consumes actual four-field metadata before native String', () => {
    let metadata: unknown;
    const entry = load(s => replace(s, 'const result = String(value);', 'capture(metadata); const result = String(value);'), {
      capture(v: unknown) { metadata = v; },
    });
    expect(entry.stringBoundedJsonExact('한', createBudgetContext({ now: () => 0 }))).toBe('한');
    expect(metadata).toEqual({ outU: 1, outB: 3, rootU: 1, rootB: 3 });
  });
});


describe('GS02 reached fixed frames and visit', () => {
  const boundaries: [string, string, string, Vector][] = [
    ['O', "  if (value !== null && value !== undefined", "  hit(); if (value !== null && value !== undefined", [1, 8, 0, 80, 1]],
    ['H', '{ outU: 0, outB: 0, rootU: 0, rootB: 0 };', '(hit(), { outU: 0, outB: 0, rootU: 0, rootB: 0 });', [2, 12, 0, 128, 2]],
    ['W', "  if (typeof value === 'string') {", "  hit(); if (typeof value === 'string') {", [2, 12, 0, 128, 3]],
  ];
  for (const [name, from, to, prefix] of boundaries) {
    for (const [index, key] of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].entries()) {
      if (!prefix[index]) continue;
      for (const delta of [-1, 0, 1]) it(`${name} prefix ${key}/${delta} before real consumer`, () => {
        let reached = 0; const stop = new Error('selected real consumer');
        const entry = load(s => replace(s, from, to), { hit() { reached++; throw stop; } });
        const budget = createBudgetContext({ now: () => 0, limits: { [key]: prefix[index] + delta } });
        let error: unknown;
        try { entry.stringBoundedJsonExact(null, budget); } catch (e) { error = e; }
        if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(reached).toBe(0); }
        else { expect(error).toBe(stop); expect(reached).toBe(1); expect(usage(budget)).toEqual(prefix); }
      });
    }
  }
});


function math() {
  return load(s => s + '\nexport { exactStringAmount, exactStringAdd, exactStringMul, exactStringBlocks };\n') as unknown as {
    exactStringAmount(n: number): number; exactStringAdd(a: number, b: number): number;
    exactStringMul(a: number, b: number): number; exactStringBlocks(n: number): number;
  };
}
describe('GS01 arithmetic declaration setup only', () => {
  it('executes actual arithmetic expressions', () => {
    const a = math(); expect(a.exactStringAmount(0)).toBe(0); expect(a.exactStringAdd(2, 3)).toBe(5);
    expect(a.exactStringMul(2, 3)).toBe(6); expect(a.exactStringBlocks(257)).toBe(2);
  });
});


describe('GS01 reached safe arithmetic', () => {
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid amount ${n} in every arithmetic operand`, () => {
      const a = math();
      for (const invoke of [() => a.exactStringAmount(n), () => a.exactStringAdd(n, 0), () => a.exactStringAdd(0, n),
        () => a.exactStringMul(n, 0), () => a.exactStringMul(0, n), () => a.exactStringBlocks(n)]) expect(invoke).toThrow(BudgetExceededError);
    });
  }
  for (const operation of ['Add', 'Mul'] as const) it(`rejects ${operation} overflow before represented arithmetic`, () => {
    let reached = 0;
    const expression = operation === 'Add' ? 'return left + right;' : 'return left * right;';
    const entry = load(s => replace(s, expression, 'hit(); ' + expression) + `\nexport { exactString${operation} };\n`, { hit() { reached++; } });
    const fn = entry['exactString' + operation] as (a: number, b: number) => number;
    expect(() => fn(Number.MAX_SAFE_INTEGER, 2)).toThrow(BudgetExceededError); expect(reached).toBe(0);
    expect(fn(Number.MAX_SAFE_INTEGER, operation === 'Add' ? 0 : 1)).toBe(Number.MAX_SAFE_INTEGER); expect(reached).toBe(1);
  });
  it('MAX blocks avoids an overflowing numerator and zero arithmetic stays valid', () => {
    const a = math(); expect(a.exactStringBlocks(Number.MAX_SAFE_INTEGER)).toBe(35184372088832);
    expect(a.exactStringBlocks(0)).toBe(0); expect(a.exactStringMul(Number.MAX_SAFE_INTEGER, 0)).toBe(0);
    expect(a.exactStringAdd(0, 0)).toBe(0);
  });
});


describe('GS03 reached caps and length', () => {
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) it(`invalid C ${n} before H construction`, () => {
    let metadata = 0;
    const entry = load(s => replace(s, '{ outU: 0, outB: 0, rootU: 0, rootB: 0 };', '(hit(), { outU: 0, outB: 0, rootU: 0, rootB: 0 });'), { hit() { metadata++; } });
    const base = createBudgetContext({ now: () => 0 });
    expect(() => entry.stringBoundedJsonExact('', { ...base, limits: { ...base.limits, stringBytes: n } })).toThrow(BudgetExceededError);
    expect(metadata).toBe(0);
  });
  for (const delta of [-1, 0, 1]) it(`length work prefix ${delta}`, () => {
    let reached = 0; const stop = new Error('length');
    const entry = load(s => replace(s, 'const units = value.length;', 'const units = (hit(), value.length);'), { hit() { reached++; throw stop; } });
    const budget = createBudgetContext({ now: () => 0, limits: { work: 4 + delta } });
    let error: unknown; try { entry.stringBoundedJsonExact('a', budget); } catch (e) { error = e; }
    if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(reached).toBe(0); }
    else { expect(error).toBe(stop); expect(reached).toBe(1); expect(usage(budget)).toEqual([2, 12, 0, 128, 4]); }
  });
  it('U is capped before the actual scanner', () => {
    let scan = 0;
    const entry = load(s => replace(s, 'const bytes = utf8ByteLength(value, budget);', 'scan(); const bytes = utf8ByteLength(value, budget);'), { scan() { scan++; } });
    expect(() => entry.stringBoundedJsonExact('aa', createBudgetContext({ now: () => 0, limits: { stringBytes: 1 } }))).toThrow(BudgetExceededError);
    expect(scan).toBe(0);
  });
  for (const [i, value] of ['aa', '한한', '😀', '\ud800', 1, true, null, undefined].entries()) {
    const bound = typeof value === 'string' ? Buffer.byteLength(value) : value === null ? 4 : value === undefined ? 9 : typeof value === 'boolean' ? 5 : 32;
    for (const delta of [-1, 0, 1]) it(`exact B or fixed bound ${i}/${delta}`, () => {
      let native = 0;
      const entry = load(s => s, { String(v: unknown) { native++; return String(v); } });
      const run = () => entry.stringBoundedJsonExact(value, createBudgetContext({ now: () => 0, limits: { stringBytes: bound + delta } }));
      if (delta < 0) { expect(run).toThrow(BudgetExceededError); expect(native).toBe(0); }
      else { expect(run()).toBe(originalCaller(value)); expect(native).toBe(1); }
    });
  }
  it('hard C rejects U above eight million even under a forwarding larger string ceiling', () => {
    let scan = 0; const base = createBudgetContext({ now: () => 0 });
    const entry = load(s => replace(s, 'const bytes = utf8ByteLength(value, budget);', 'scan(); const bytes = utf8ByteLength(value, budget);'), { scan() { scan++; } });
    expect(() => entry.stringBoundedJsonExact('a'.repeat(8_000_001), { ...base, limits: { ...base.limits, stringBytes: 9_000_000 } })).toThrow(BudgetExceededError);
    expect(scan).toBe(0);
  });
});


describe('GS03 reached source F and root M', () => {
  for (const value of ['', '한'.repeat(257), 'a'.repeat(255) + '😀']) {
    const u = value.length, q = Math.ceil(u / 256), prefix: Vector = [3, 12, 0, 144 + 2 * u, 4 + q];
    for (const [index, key] of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].entries()) {
      if (!prefix[index]) continue;
      for (const delta of [-1, 0, 1]) it(`source F/flatten before scan U${u} ${key}/${delta}`, () => {
        let reached = 0; const stop = new Error('scan entered');
        const entry = load(s => replace(s, 'const bytes = utf8ByteLength(value, budget);', 'hit(); const bytes = utf8ByteLength(value, budget);'), { hit() { reached++; throw stop; } });
        const budget = createBudgetContext({ now: () => 0, limits: { [key]: prefix[index] + delta } });
        let error: unknown; try { entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
        if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(reached).toBe(0); }
        else { expect(error).toBe(stop); expect(reached).toBe(1); expect(usage(budget)).toEqual(prefix); }
      });
    }
  }
  for (const [i, value] of specimens.entries()) it(`actual original text and complete ordered ledger ${i}`, () => {
    const events: Vector[] = [];
    const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base,
      reserve(cost) { events.push([cost.nodes ?? 0, cost.slots ?? 0, cost.contentBytes ?? 0, cost.structuralBytes ?? 0, 0]); base.reserve(cost); },
      reserveString(bytes) { events.push([1, 0, bytes, 4, 0]); base.reserveString(bytes); },
      spend(n = 1) { events.push([0, 0, 0, 0, n]); base.spend(n); },
    };
    let native = 0;
    const entry = load(s => s, { String(v: unknown) { native++; expect(usage(budget)).toEqual(model(value).total); return String(v); } });
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value)); expect(native).toBe(1);
    expect(events).toEqual(model(value).events.map(e => e.cost)); expect(usage(budget)).toEqual(model(value).total);
  });
  for (const [i, value] of [null, undefined, 1, true, '', '한'.repeat(257)].entries()) {
    const expected = model(value).total;
    for (const [index, key] of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].entries()) {
      for (const delta of expected[index] ? [-1, 0, 1] : [0, 1]) it(`root M aggregate ${i} ${key}/${delta}`, () => {
        let native = 0;
        const entry = load(s => s, { String(v: unknown) { native++; return String(v); } });
        const budget = createBudgetContext({ now: () => 0, limits: { [key]: expected[index] + delta } });
        const run = () => entry.stringBoundedJsonExact(value, budget);
        if (delta < 0) { expect(run).toThrow(BudgetExceededError); expect(native).toBe(0); }
        else { expect(run()).toBe(originalCaller(value)); expect(native).toBe(1); expect(usage(budget)).toEqual(expected); }
      });
    }
  }
});


describe('GS08 GS09 reached preparation and native exits', () => {
  const points: [string, string, string, string, boolean][] = [
    ['metadata', 'const metadata: exactStringMetadata = { outU: 0, outB: 0, rootU: 0, rootB: 0 };', 'budget.checkDepth(1);', 'root', false],
    ['length', 'const units = value.length;', 'exactStringCap(units, cap);', 'scalar', true],
    ['scan', 'const bytes = utf8ByteLength(value, budget);', 'exactStringCap(bytes, cap);', 'scalar', true],
    ['scalar final', 'metadata.outU = units; metadata.outB = bytes;', '', 'scalar', true],
    ['size return', 'exactStringScalar(value, budget, metadata, cap);', 'metadata.rootU = metadata.outU;', 'root', false],
    ['preparation', 'budget.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(metadata.rootU))));', 'const result = String(value);', 'root', false],
    ['native success', 'const result = String(value);', 'return result;', 'root', false],
  ];
  for (const [name, after, successor, local, scalar] of points) {
    for (const mode of ['timely', 'expired', 'aborted'] as const) for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
      it(`${name} ${mode}/${outcome} immediate local boundary`, () => {
        let clock = 0, reached = 0, successors = 0, native = 0, returned = false, localReturned = false;
        let localError: unknown, caught: unknown;
        const signal = { aborted: false };
        const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError('boundary ' + name);
        const budget = createBudgetContext({ now: () => clock, signal });
        const entry = load(s => {
          let changed = replace(s, after, after + ' advance();');
          if (successor) changed = replace(changed, successor, 'successor(); ' + successor);
          if (scalar) changed = replace(changed, 'exactStringScalar(value, budget, metadata, cap);', 'observeScalar(() => exactStringScalar(value, budget, metadata, cap));');
          return changed;
        }, {
          advance() { reached++; if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; if (outcome !== 'success') throw sentinel; },
          successor() { successors++; },
          observeScalar(fn: () => void) { try { fn(); localReturned = true; } catch (error) { localError = error; throw error; } },
          String(v: unknown) { native++; return String(v); },
        });
        try { expect(entry.stringBoundedJsonExact('한', budget)).toBe('한'); returned = true; } catch (error) { caught = error; }
        expect(reached).toBe(1);
        if (mode === 'timely' && outcome === 'success') { expect(caught).toBeUndefined(); expect(returned).toBe(true); }
        else {
          expect(returned).toBe(false);
          const error = local === 'scalar' ? localError : caught;
          if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(error).toBe(sentinel);
          else expect(error).toBeInstanceOf(BudgetUnavailableError);
          if (scalar) expect(localReturned).toBe(false);
          expect(successors).toBe(0);
          if (name !== 'native success') expect(native).toBe(0);
        }
      });
    }
  }
  for (const mode of ['timely', 'expired', 'aborted'] as const) for (const kind of ['ordinary', 'exceeded', 'unavailable'] as const) {
    it(`native actual throw ${mode}/${kind} identity`, () => {
      let clock = 0, native = 0; const signal = { aborted: false };
      const sentinel = kind === 'ordinary' ? new TypeError('native') : kind === 'exceeded' ? new BudgetExceededError() : new BudgetUnavailableError();
      const budget = createBudgetContext({ now: () => clock, signal });
      const entry = load(s => s, { String() { native++; if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; throw sentinel; } });
      let caught: unknown; try { entry.stringBoundedJsonExact(null, budget); } catch (error) { caught = error; }
      expect(native).toBe(1);
      if (kind !== 'ordinary' || mode === 'timely') expect(caught).toBe(sentinel); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
});


describe('GS09 reached final helper and scalar admission', () => {
  for (const mode of ['expired', 'aborted'] as const) for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
    it(`final helper after native check ${mode}/${outcome}`, () => {
      let clock = 0, reached = 0, returned = false; const signal = { aborted: false };
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new Error('return phase');
      const entry = load(s => replace(s, 'budget.check(); // native success', 'budget.check(); advance(); // native success'), {
        advance() { reached++; if (mode === 'expired') clock = 5000; else signal.aborted = true; if (outcome !== 'success') throw sentinel; },
      });
      let caught: unknown; try { entry.stringBoundedJsonExact(null, createBudgetContext({ now: () => clock, signal })); returned = true; } catch (error) { caught = error; }
      expect(reached).toBe(1); expect(returned).toBe(false);
      if (outcome === 'exceeded' || outcome === 'unavailable') expect(caught).toBe(sentinel); else expect(caught).toBeInstanceOf(BudgetUnavailableError);
    });
  }
  for (const key of ['rootU', 'rootB']) for (const n of [-1, 0.5, NaN, Infinity, 8_000_001]) it(`retained ${key}/${n} refuses before result occurrence`, () => {
    let occurrences = 0; const base = createBudgetContext({ now: () => 0 });
    const entry = load(s => replace(s, 'metadata.rootB = metadata.outB;', 'metadata.rootB = metadata.outB; corrupt(metadata);'), { corrupt(m: Record<string, number>) { m[key] = n; } });
    expect(() => entry.stringBoundedJsonExact(null, { ...base, reserveString(b) { occurrences++; base.reserveString(b); } })).toThrow(BudgetExceededError);
    expect(occurrences).toBe(0);
  });
  it('scalar own entry refuses before spend method lookup', () => {
    let entered = 0, spends = 0; const stop = new BudgetUnavailableError(); const base = createBudgetContext({ now: () => 0 });
    const entry = load(s => s + '\nexport { exactStringScalar };\n') as unknown as { exactStringScalar(v: unknown, b: BudgetContext, m: object, c: number): void };
    const budget = { ...base, check() { entered++; throw stop; }, get spend() { spends++; return base.spend; } };
    expect(() => entry.exactStringScalar(null, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000)).toThrow(stop);
    expect(entered).toBe(1); expect(spends).toBe(0);
  });
  for (const [i, v] of [NaN, Infinity, -Infinity, Symbol('bad'), BigInt(1), () => 0, {}, []].entries()) it(`scalar own noncoercing domain ${i}`, () => {
    const entry = load(s => s + '\nexport { exactStringScalar };\n') as unknown as { exactStringScalar(v: unknown, b: BudgetContext, m: object, c: number): void };
    expect(() => entry.exactStringScalar(v, createBudgetContext({ now: () => 0 }), { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000)).toThrow('Legacy bounded JSON is invalid.');
  });
});


describe('GS03 reached scalar bound before metadata use', () => {
  for (const [i, v] of [null, undefined, true, 1].entries()) it(`scalar bound ${i} capped before either metadata write`, () => {
    const cap = v === null ? 3 : v === undefined ? 8 : typeof v === 'boolean' ? 4 : 31;
    let writes = 0; const stop = new Error('metadata write');
    const metadata = { set outU(_n: number) { writes++; throw stop; }, set outB(_n: number) { writes++; throw stop; }, rootU: 0, rootB: 0 };
    const entry = load(s => s + '\nexport { exactStringScalar };\n') as unknown as { exactStringScalar(v: unknown, b: BudgetContext, m: object, c: number): void };
    expect(() => entry.exactStringScalar(v, createBudgetContext({ now: () => 0 }), metadata, cap)).toThrow(BudgetExceededError);
    expect(writes).toBe(0);
  });
});


describe('GS09 supplemental nonmasked native and reuse controls', () => {
  for (const mode of ['expired', 'aborted'] as const) it(`native success refuses before final-helper phase ${mode}`, () => {
    let clock = 0, native = 0, finalPhase = 0; const signal = { aborted: false };
    const budget = createBudgetContext({ now: () => clock, signal });
    const entry = load(s => replace(s, 'budget.check(); // final helper completion', 'finalPhase(); budget.check(); // final helper completion'), {
      finalPhase() { finalPhase++; },
      String(v: unknown) { native++; const result = String(v); if (mode === 'expired') clock = 5000; else signal.aborted = true; return result; },
    });
    expect(() => entry.stringBoundedJsonExact(null, budget)).toThrow(BudgetUnavailableError);
    expect(native).toBe(1); expect(finalPhase).toBe(0);
  });
  for (const value of [null, 'a'.repeat(255) + '😀']) it(`two calls charge twice for ${typeof value}`, () => {
    const budget = createBudgetContext({ now: () => 0 }); let native = 0;
    const entry = load(s => s, { String(v: unknown) { native++; return String(v); } });
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(usage(budget)).toEqual(model(value).total.map(n => n * 2)); expect(native).toBe(2);
  });
  it('same-owner registered array supports native text and the independent full graph ledger', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const value = graph.parseRegisteredBoundedJson('[1,true,null]', budget); const before = usage(budget);
    expect(call(value, budget)).toBe(originalCaller(value));
    expect(usage(budget).map((n, i) => n - before[i])).toEqual(model(value).total);
  });
  it('old broader nonfinite-root export remains unchanged', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(graph.stringBoundedJson(value, createBudgetContext({ now: () => 0 }))).toBe(String(value));
  });
});


describe('GS03 supplemental local scan cap', () => {
  it('exact B cap refuses before scalar metadata output even with a later root cap', () => {
    let writes = 0;
    const entry = load(s => replace(s, 'metadata.outU = units; metadata.outB = bytes;', 'write(); metadata.outU = units; metadata.outB = bytes;'), { write() { writes++; } });
    expect(() => entry.stringBoundedJsonExact('한한', createBudgetContext({ now: () => 0, limits: { stringBytes: 5 } }))).toThrow(BudgetExceededError);
    expect(writes).toBe(0);
  });
});

describe('GS01 declaration gate only', () => {
  it('exports a callable native consumer', () => {
    expect((graph as unknown as Record<string, unknown>).stringBoundedJsonExact).toBeTypeOf('function');
    expect(call(null, createBudgetContext({ now: () => 0 }))).toBe('null');
  });
});

describe('GS04 graph consumer declaration', () => {
  it('executes registered empty-array preparation and unchanged native operand', () => {
    let seen: unknown;
    const entry = load(s => s, { String(v: unknown) { seen = v; return String(v); } });
    const budget = createBudgetContext({ now: () => 0 });
    const decode = entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson;
    const value = decode('[]', budget); seen = undefined;
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(seen).toBe(value);
  });
});

describe('GS04 reached arena and ownership', () => {
  for (const [dimension, cost] of [['nodes', 66], ['slots', 1036], ['structuralBytes', 16512], ['work', 3]] as const) {
    for (const delta of [-1, 0, 1]) it(`graph arena ${dimension}/${delta} before recursive frame`, () => {
      let entered = 0; const stop = new Error('graph frame');
      const entry = load(s => replace(s, 'exactStringGraph(value, budget, metadata, cap, 1);', '(enter(), exactStringGraph(value, budget, metadata, cap, 1));'), { enter() { entered++; throw stop; } });
      const base = createBudgetContext({ now: () => 0 });
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[]', base);
      const before = usage(base), keys = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'];
      base.reserve({ [dimension]: dimension === 'work' ? 0 : base.limits[dimension] - before[keys.indexOf(dimension)] - cost - delta });
      if (dimension === 'work') base.spend(base.limits.work - usage(base)[4] - cost - delta);
      const start = usage(base); let error: unknown;
      try { entry.stringBoundedJsonExact(value, base); } catch (e) { error = e; }
      if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(entered).toBe(0); }
      else { expect(error).toBe(stop); expect(entered).toBe(1); expect(usage(base).map((n, i) => n - start[i])).toEqual([66, 1036, 0, 16512, 3]); }
    });
  }
  for (const kind of ['array proxy', 'record', 'frozen', 'foreign', 'mutable clone', 'revoked'] as const) it(`owner before operand access ${kind}`, () => {
    let traps = 0, native = 0; const budget = createBudgetContext({ now: () => 0 });
    const entry = load(s => s, { String(v: unknown) { native++; return String(v); } });
    const decode = entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson;
    const pair = Proxy.revocable([], {}); pair.revoke();
    const value = kind === 'array proxy' ? new Proxy([], { get() { traps++; throw new Error('operand read'); } })
      : kind === 'record' ? {} : kind === 'frozen' ? Object.freeze([]) : kind === 'revoked' ? pair.proxy
      : kind === 'foreign' ? decode('[]', createBudgetContext({ now: () => 0 }))
      : (entry.cloneMutableBoundedJson as typeof graph.cloneMutableBoundedJson)(decode('[]', budget), budget);
    native = 0;
    expect(() => entry.stringBoundedJsonExact(value, budget)).toThrow('Legacy bounded JSON is invalid.');
    expect(traps).toBe(0); expect(native).toBe(0);
  });
});

describe('GS04 GS08 GS09 reached graph local exits', () => {
  const points: [string, string, string, string][] = [
    ['shape', 'const shape = shapeOf(input, context);', 'context.spend(4);', '[[]]'],
    ['length', 'const count = array.length;', 'let units =', '[[]]'],
    ['index', 'const child = array[index];', 'const childDepth = exactStringAdd(depth, 1);', '[[]]'],
    ['child', 'exactStringGraph(child, context, state, ceiling, depth + 1);', 'units += state.outU;', '[[]]'],
    ['array final', 'state.outU = units; state.outB = bytes;', '', '[]'],
    ['record final', 'state.outU = state.outB = 15;', '', '{}'],
    ['scalar wrapper', 'exactStringScalar(input, context, state, ceiling);', '', '"a"'],
  ];
  for (const [name, after, successor, json] of points) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) it(`${name} graph local ${mode}/${outcome}`, () => {
      let reached = 0, next = 0, clock = 0; const signal = { aborted: false };
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new RangeError(name);
      const entry = load(s => {
        const resolve = (marker: string) => marker === 'exactStringGraph(child, context, state, ceiling, depth + 1);'
          ? s.match(/exactStringGraph\(child, context, state, ceiling, [^;]+;/)![0]
          : marker === 'units += state.outU;' ? s.match(/units (?:\+=|= exactStringAdd)[^;]+;/)![0] : marker;
        let t = replace(s, resolve(after), resolve(after) + ' advance();');
        if (successor) t = replace(t, resolve(successor), 'successor(); ' + resolve(successor));
        return t + '\nexport { exactStringGraph };\n';
      }, { advance() { reached++; if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; if (outcome !== 'success') throw sentinel; }, successor() { next++; } });
      const budget = createBudgetContext({ now: () => clock, signal });
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget);
      let caught: unknown, returned = false;
      try { (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, 1); returned = true; } catch (e) { caught = e; }
      expect(reached).toBeGreaterThan(0);
      if (mode === 'timely' && outcome === 'success') expect(returned).toBe(true);
      else {
        expect(returned).toBe(false); expect(next).toBe(0);
        if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(caught).toBe(sentinel);
        else expect(caught).toBeInstanceOf(BudgetUnavailableError);
      }
    });
  }
});

describe('GS04 reached child depth', () => {
  for (const kind of ['fixed64', 'context'] as const) it(`pre-child ${kind} prevents scalar frame entry`, () => {
    let armed = false, scalar = 0; const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base, checkDepth(d) { if (armed && kind === 'context' && d > 1) throw new BudgetExceededError(); } };
    const entry = load(s => replace(s, 'exactStringScalar(input, context, state, ceiling);', 'enterScalar(); exactStringScalar(input, context, state, ceiling);') + '\nexport { exactStringGraph };\n', { enterScalar() { scalar++; } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[1]', budget); armed = true;
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, kind === 'fixed64' ? 64 : 1)).toThrow(BudgetExceededError);
    expect(scalar).toBe(0);
  });
});

const graphSpecimens = ['{}', '[]', '[[],[],[],[]]', '[[["A"]]]', '["한","😀","\\ud800",1,true,null]', '[null,[12,"한😀",null]]', '[1]', '[true]', '[{}]', '[null]', '["a"]', '[[1],[true],[{}]]', '{"valueOf":{}}', '{"toString":{}}', '{"toString":{},"valueOf":{}}',
  ...[255, 256, 257, 511, 512, 513].map(n => JSON.stringify(['한'.repeat(n), null])), JSON.stringify(Array(257).fill(null)), JSON.stringify(['a'.repeat(255) + '😀'])];
describe('GS05 GS06 GS07 reached complete graph ledger', () => {
  for (const [i, json] of graphSpecimens.entries()) it(`graph original/native/model ${i}`, () => {
    let native = 0, active = false; const budget = createBudgetContext({ now: () => 0 });
    const entry = load(s => s, { String(v: unknown) {
      if (active) { native++; expect(v).toBe(value); expect(usage(budget).map((n, k) => n - before[k])).toEqual(model(value).total); }
      return String(v);
    } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget);
    const before = usage(budget); let expected: unknown, expectedError: unknown;
    try { expected = originalCaller(value); } catch (e) { expectedError = e; }
    active = true; let result: unknown, error: unknown;
    try { result = entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
    expect(native).toBe(1);
    if (expectedError) { expect(error).toBeInstanceOf(TypeError); expect((error as Error).message).toBe((expectedError as Error).message); }
    else { expect(error).toBeUndefined(); expect(result).toBe(expected); }
    expect(usage(budget).map((n, k) => n - before[k])).toEqual(model(value).total);
  });
  for (const json of ['[]', '[1]', '[true]', '[{}]', '[[1],[true],[{}]]']) for (const key of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const) {
    const component = model(JSON.parse(json)).total[['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].indexOf(key)];
    for (const delta of component ? [-1, 0, 1] : [0, 1]) it(`graph aggregate ${json} ${key}/${delta}`, () => {
      const budget = createBudgetContext({ now: () => 0 }); let active = false, native = 0;
      const entry = load(s => s, { String(v: unknown) { if (active) native++; return String(v); } });
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget);
      const expected = model(value).total; const k = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].indexOf(key);
      const remaining = budget.limits[key] - usage(budget)[k] - expected[k] - delta;
      if (key === 'work') budget.spend(remaining); else budget.reserve({ [key]: remaining });
      active = true;
      if (delta < 0) { expect(() => entry.stringBoundedJsonExact(value, budget)).toThrow(BudgetExceededError); expect(native).toBe(0); }
      else { expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value)); expect(native).toBe(1); }
    });
  }
});

describe('GS05 reached graph arithmetic before use', () => {
  for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) it(`private length capacity ${count} rejects before child`, () => {
    let child = 0;
    const entry = load(s => replace(replace(s, 'const count = array.length;', 'const count = change(array.length);'), 'const child = array[index];', 'hit(); const child = array[index];') + '\nexport { exactStringGraph };\n', { change() { return count; }, hit() { child++; throw new Error('index reached'); } });
    const budget = createBudgetContext({ now: () => 0 });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[]', budget);
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, 1)).toThrow();
    expect(child).toBe(0);
  });
  for (const [json, cap] of [['[null,null]', 0], ['["aa",null]', 1], ['["한",null]', 2], ['{}', 14]] as const) it(`local accumulation cap ${json}/${cap} prevents output`, () => {
    let writes = 0;
    const entry = load(s => replace(replace(s, 'state.outU = units; state.outB = bytes;', 'hit(); state.outU = units; state.outB = bytes;'), 'state.outU = state.outB = 15;', 'hit(); state.outU = state.outB = 15;') + '\nexport { exactStringGraph };\n', { hit() { writes++; } });
    const budget = createBudgetContext({ now: () => 0 });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget);
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, cap, 1)).toThrow(BudgetExceededError);
    expect(writes).toBe(0);
  });
  for (const field of ['outU', 'outB']) for (const n of [-1, NaN, Number.MAX_SAFE_INTEGER]) it(`child ${field}/${n} refuses before next indexed read`, () => {
    let reads = 0;
    const entry = load(s => {
      const statement = s.match(/exactStringGraph\(child, context, state, ceiling, [^;]+;/)![0];
      return replace(replace(s, statement, statement + ' corrupt(state);'), 'const child = array[index];', 'hit(); const child = array[index];') + '\nexport { exactStringGraph };\n';
    }, { corrupt(m: Record<string, number>) { m[field] = n; }, hit() { reads++; } });
    const budget = createBudgetContext({ now: () => 0 });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('["a","b"]', budget);
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, 1)).toThrow(BudgetExceededError);
    expect(reads).toBe(1);
  });
});

describe('GS05 seed and nullish element reach', () => {
  it('comma seed refuses before first indexed read', () => {
    let reads = 0; const entry = load(s => replace(s, 'const child = array[index];', 'hit(); const child = array[index];') + '\nexport { exactStringGraph };\n', { hit() { reads++; } });
    const budget = createBudgetContext({ now: () => 0 });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[null,null]', budget);
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 0, 1)).toThrow(BudgetExceededError);
    expect(reads).toBe(0);
  });
  it('null element at zero cap has no leaf result', () => {
    const base = createBudgetContext({ now: () => 0 }); let armed = false;
    const budget = { ...base, get limits() { return { ...base.limits, stringBytes: armed ? 0 : base.limits.stringBytes }; } };
    const value = graph.parseRegisteredBoundedJson('[null]', budget); armed = true; const before = usage(budget);
    expect(call(value, budget)).toBe(''); expect(usage(budget).map((n, i) => n - before[i])).toEqual(model(value).total);
  });
});

describe('GS09 reached graph own entry', () => {
  for (const json of ['[]', '"a"', 'null']) it(`graph entry ${json} refuses before routing`, () => {
    let routing = 0, clock = 0;
    const entry = load(s => replace(s, "if (input === null || typeof input !== 'object') {", "route(); if (input === null || typeof input !== 'object') {") + '\nexport { exactStringGraph };\n', { route() { routing++; } });
    const budget = createBudgetContext({ now: () => clock });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget); clock = 5000;
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, 1)).toThrow(BudgetUnavailableError);
    expect(routing).toBe(0);
  });
});

describe('GS07 reached final join bounds', () => {
  for (const field of ['units', 'bytes']) it(`post-loop ${field} cap before join materialization`, () => {
    let results = 0;
    const entry = load(s => replace(s, 'index = exactStringAdd(index, 1)', `index = (${field} = corrupt(${field}), exactStringAdd(index, 1))`) + '\nexport { exactStringGraph };\n', { corrupt() { return 2; } });
    const base = createBudgetContext({ now: () => 0 });
    const budget = { ...base, reserveString(n: number) { results++; base.reserveString(n); } };
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[null]', budget); results = 0;
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 1, 1)).toThrow(BudgetExceededError);
    expect(results).toBe(0);
  });
});

describe('GS08 supplemental graph identities and native order', () => {
  it('same parsed identity is fully prepared and converted twice', () => {
    const budget = createBudgetContext({ now: () => 0 }); let native = 0, armed = false;
    const entry = load(s => s, { String(v: unknown) { if (armed) native++; return String(v); } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[[1,"한"],true,null]', budget);
    const before = usage(budget); armed = true;
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(native).toBe(2); expect(usage(budget).map((n, i) => n - before[i])).toEqual(model(value).total.map(n => n * 2));
  });
  it('closed history list repeats preparation identity before the first native record error', () => {
    const visited: unknown[] = []; let armed = false, native = 0;
    const entry = load(s => replace(s, 'const shape = shapeOf(input, context);', 'visit(input); const shape = shapeOf(input, context);'), { visit(v: unknown) { visited.push(v); }, String(v: unknown) { if (armed) native++; return String(v); } });
    const budget = createBudgetContext({ now: () => 0 });
    const record = (entry.createBoundedHistoryInvalidCompletion as typeof graph.createBoundedHistoryInvalidCompletion)(budget, 'c', 't', 's', 'i', 'y', 'z', 'o', 'h', 'd');
    const list = (entry.createBoundedOperationalHistoryList as typeof graph.createBoundedOperationalHistoryList)(3, () => record, budget);
    expect(list[0]).toBe(list[1]); expect(list[1]).toBe(list[2]); expect(Object.getPrototypeOf(list[0])).toBeNull();
    const before = usage(budget); armed = true;
    expect(() => entry.stringBoundedJsonExact(list, budget)).toThrow(TypeError);
    expect(visited).toEqual([list, list[0], list[0], list[0]]); expect(native).toBe(1);
    expect(usage(budget).map((n, i) => n - before[i])).toEqual(model(list).total);
    expect(() => entry.stringBoundedJsonExact(record, budget)).toThrow('Legacy bounded JSON is invalid.');
  });
  it('native root and nested joins begin only after the entire model debit', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const value = graph.parseRegisteredBoundedJson('[[1,"한"],[true,{}],null]', budget) as unknown[][];
    const before = usage(budget), expected = model(value).total;
    const intrinsic = Array.prototype.join, push = Array.prototype.push;
    const calls: unknown[] = []; const at: Vector[] = [];
    Array.prototype.join = function(separator?: string) {
      if (this === value || this === value[0] || this === value[1]) { push.call(calls, this); push.call(at, usage(budget).map((n, i) => n - before[i])); }
      return intrinsic.call(this, separator);
    };
    let result: unknown;
    try { result = call(value, budget); } finally { Array.prototype.join = intrinsic; }
    expect(result).toBe(originalCaller(value)); expect(calls).toEqual([value, value[0], value[1]]); expect(at).toEqual([expected, expected, expected]);
  });
  it('record method-shadow graphs are leaves and preserve string-hint method order', () => {
    const budget = createBudgetContext({ now: () => 0 });
    const value = graph.parseRegisteredBoundedJson('{"toString":[[[1,"unvisited"]]]}', budget);
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'valueOf')!;
    let calls = 0, native = false, early = false;
    const entry = load(s => s, { String(v: unknown) { native = true; return String(v); } });
    const owned = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('{"toString":[[[1,"unvisited"]]]}', budget); native = false;
    Object.defineProperty(Object.prototype, 'valueOf', { ...descriptor, value: function() { if (this === owned) { calls++; if (!native) early = true; } return descriptor.value.call(this); } });
    let caught: unknown;
    try { entry.stringBoundedJsonExact(owned, budget); } catch (e) { caught = e; } finally { Object.defineProperty(Object.prototype, 'valueOf', descriptor); }
    let original: unknown; try { originalCaller(value); } catch (e) { original = e; }
    expect(caught).toBeInstanceOf(TypeError); expect((caught as Error).message).toBe((original as Error).message);
    expect(calls).toBe(1); expect(early).toBe(false);
  });
  for (const depth of [63, 64, 65]) it(`natural default admission depth ${depth}`, () => {
    const budget = createBudgetContext({ now: () => 0 });
    const text = '['.repeat(depth - 1) + '0' + ']'.repeat(depth - 1);
    if (depth > 64) expect(() => graph.parseRegisteredBoundedJson(text, budget)).toThrow(BudgetExceededError);
    else { const value = graph.parseRegisteredBoundedJson(text, budget); const before = usage(budget); expect(call(value, budget)).toBe('0'); expect(usage(budget).map((n, i) => n - before[i])).toEqual(model(value).total); }
  });
  it('forwarding depth128 admission does not enlarge the fixed64 graph arena', () => {
    const base = createBudgetContext({ now: () => 0 }); const requested: number[] = [];
    const budget = { ...base, checkDepth(d: number) { if (d > 128) throw new BudgetExceededError(); requested.push(d); } };
    const value = graph.parseRegisteredBoundedJson('['.repeat(64) + '0' + ']'.repeat(64), budget); requested.length = 0;
    expect(() => call(value, budget)).toThrow(BudgetExceededError); expect(Math.max(...requested)).toBe(64);
  });
  it('private undefined-element branch pays a visit but no leaf M', () => {
    const entry = load(s => s + '\nexport { exactStringGraph };\n');
    const budget = createBudgetContext({ now: () => 0 }); const metadata = { outU: -1, outB: -1, rootU: 0, rootB: 0 };
    (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number, e: boolean) => void)(undefined, budget, metadata, 0, 2, true);
    expect(metadata).toEqual({ outU: 0, outB: 0, rootU: 0, rootB: 0 }); expect(usage(budget)).toEqual([0, 0, 0, 0, 1]);
  });
  for (const json of graphSpecimens) it(`ordered graph events ${json}`, () => {
    const events: Vector[] = []; let armed = false; const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base,
      reserve(c) { if (armed) events.push([c.nodes ?? 0, c.slots ?? 0, c.contentBytes ?? 0, c.structuralBytes ?? 0, 0]); base.reserve(c); },
      reserveString(b) { if (armed) events.push([1, 0, b, 4, 0]); base.reserveString(b); },
      spend(n = 1) { if (armed) events.push([0, 0, 0, 0, n]); base.spend(n); },
    };
    const value = graph.parseRegisteredBoundedJson(json, budget); armed = true;
    try { call(value, budget); } catch (e) { expect(e).toBeInstanceOf(TypeError); }
    const expected = model(value).events.flatMap(e => e.label === 'shape/method/length' ? [1, 4, 1].map(n => [0, 0, 0, 0, n]) : e.label === 'record shape/method' ? [1, 4].map(n => [0, 0, 0, 0, n]) : [e.cost]);
    expect(events).toEqual(expected);
  });
});

describe('GS07 supplemental occurrence prefix capacities', () => {
  const targets: [string, string, number, number][] = [
    ['[[],[],[]]', 'state.outU = units; state.outB = bytes;', 0, 0],
    ['[[],[],[]]', 'state.outU = units; state.outB = bytes;', 1, 1],
    ['[[],[],[]]', 'state.outU = units; state.outB = bytes;', 2, 2],
    ['[[],[],[]]', 'state.outU = units; state.outB = bytes;', 3, 3],
    ['[1]', 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(state.outU))));', 0, 0],
    ['[true]', 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(state.outU))));', 0, 0],
    ['[{}]', 'state.outU = state.outB = 15;', 0, 0],
  ];
  for (const [json, point, occurrence, modelOccurrence] of targets) {
    const specimen = JSON.parse(json), expected: Vector = [0, 0, 0, 0, 0]; let m = 0;
    for (const event of model(specimen).events) { event.cost.forEach((n, i) => { expected[i] += n; }); if (event.label === 'M work' && m++ === modelOccurrence) break; }
    for (const [k, key] of ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'].entries()) {
      for (const delta of expected[k] ? [-1, 0, 1] : [0, 1]) it(`prefix ${json} occurrence${occurrence} ${key}/${delta}`, () => {
        let reached = 0, stopped = 0; const stop = new Error('actual local completion');
        const insertion = point.startsWith('context.spend') ? point + ' hit();' : 'hit(); ' + point;
        const entry = load(s => replace(s, point, insertion), { hit() { if (reached++ === occurrence) { stopped++; throw stop; } } });
        const budget = createBudgetContext({ now: () => 0 });
        const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget);
        const remaining = budget.limits[key as keyof typeof budget.limits] - usage(budget)[k] - expected[k] - delta;
        if (key === 'work') budget.spend(remaining); else budget.reserve({ [key]: remaining });
        const before = usage(budget); let error: unknown;
        try { entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
        if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(stopped).toBe(0); }
        else { expect(error).toBe(stop); expect(stopped).toBe(1); expect(usage(budget).map((n, i) => n - before[i])).toEqual(expected); }
      });
    }
  }
});

describe('GS09 supplemental graph native and root-size exits', () => {
  for (const json of ['[]', '[1,true,null]', '{}']) for (const mode of ['timely', 'expired', 'aborted'] as const) for (const outcome of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
    it(`graph native ${json} ${mode}/${outcome}`, () => {
      let active = false, native = 0, clock = 0; const signal = { aborted: false };
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError() : new TypeError('native graph');
      const entry = load(s => s, { String(v: unknown) {
        if (!active) return String(v);
        native++; const result = String(v);
        if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true;
        if (outcome !== 'success') throw sentinel; return result;
      } });
      const budget = createBudgetContext({ now: () => clock, signal });
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget); active = true;
      let result: unknown, error: unknown; try { result = entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
      expect(native).toBe(1);
      if (mode === 'timely' && outcome === 'success') { expect(error).toBeUndefined(); expect(result).toBe(originalCaller(value)); }
      else if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(error).toBe(sentinel);
      else expect(error).toBeInstanceOf(BudgetUnavailableError);
    });
  }
  for (const mode of ['expired', 'aborted'] as const) it(`graph root-size success ${mode} before retained metadata`, () => {
    let clock = 0, active = false, native = 0, retained = 0, reached = 0; const signal = { aborted: false };
    const entry = load(s => replace(replace(s, 'exactStringGraph(value, budget, metadata, cap, 1);', '(exactStringGraph(value, budget, metadata, cap, 1), advance());'), 'metadata.rootU = metadata.outU;', 'retain(); metadata.rootU = metadata.outU;'), {
      advance() { reached++; if (mode === 'expired') clock = 5000; else signal.aborted = true; }, retain() { retained++; }, String(v: unknown) { if (active) native++; return String(v); },
    });
    const budget = createBudgetContext({ now: () => clock, signal });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[]', budget); active = true;
    expect(() => entry.stringBoundedJsonExact(value, budget)).toThrow(BudgetUnavailableError);
    expect(reached).toBe(1); expect(retained).toBe(0); expect(native).toBe(0);
  });
});

describe('GS08 supplemental native method lookup trace', () => {
  it('full original string-hint lookup and call order occurs only in the native phase', () => {
    const budget = createBudgetContext({ now: () => 0 }); let active = false;
    const entry = load(s => s, { String(v: unknown) { active = true; return String(v); } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[[{}]]', budget) as unknown[][];
    active = false;
    const descriptors = [[Array.prototype, 'toString'], [Array.prototype, 'join'], [Object.prototype, 'toString'], [Object.prototype, 'valueOf']] as const;
    const saved = descriptors.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key)!);
    const trace: string[] = [], push = Array.prototype.push; let early = 0;
    for (const [i, [owner, key]] of descriptors.entries()) Object.defineProperty(owner, key, { configurable: true, enumerable: saved[i].enumerable, get() {
      const id = this === value ? 'root' : this === value[0] ? 'inner' : this === value[0][0] ? 'record' : '';
      if (id) { if (!active) early++; push.call(trace, 'get ' + id + '.' + key); }
      return function(this: unknown, ...args: unknown[]) { if (id) push.call(trace, 'call ' + id + '.' + key); return Reflect.apply(saved[i].value, this, args); };
    } });
    let candidate: unknown, original: unknown; let candidateTrace: string[] = [];
    try {
      candidate = entry.stringBoundedJsonExact(value, budget); candidateTrace = trace.slice(); trace.length = 0;
      original = originalCaller(value);
    } finally { for (const [i, [owner, key]] of descriptors.entries()) Object.defineProperty(owner, key, saved[i]); }
    expect(candidate).toBe(original); expect(early).toBe(0); expect(trace).toEqual(candidateTrace);
    expect(candidateTrace).toEqual(['get root.toString', 'call root.toString', 'get root.join', 'call root.join', 'get inner.toString', 'call inner.toString', 'get inner.join', 'call inner.join', 'get record.toString', 'call record.toString']);
  });
});

describe('GS00 frozen original and independent model', () => {
  it('verifies every portable original payload against pinned manifest', () => {
    const bytes = readFileSync(oracleRoot + 'manifest.json');
    expect(digest(bytes)).toBe('1b20d13ac257dadd41d714012ef8d45f04d133f0c45d0f8e5b6f3025e3729e8e');
    const manifest = JSON.parse(bytes.toString());
    expect(manifest.originalPin).toBe('448cbed7bd303ad0f9ef3fd4c974c313bf4c8da8');
    for (const original of manifest.modules) {
      const payload = readFileSync(oracleRoot + original.payload);
      expect(payload.length).toBe(original.bytes); expect(digest(payload)).toBe(original.sha256);
    }
  });
  for (const [i, value] of specimens.entries()) it(`original sourcePath native operand ${i}`, () => {
    expect(originalCaller(value)).toBe(String(value));
  });
  const literals: [unknown, Vector][] = [
    [undefined, [4, 12, 9, 166, 7]], [null, [4, 12, 4, 156, 7]], [1, [4, 12, 32, 212, 7]],
    [true, [4, 12, 5, 158, 7]], ['', [5, 12, 0, 164, 6]], [{}, [68, 1036, 15, 16562, 13]],
    [[], [71, 1036, 0, 16568, 14]], [[[], [], [], []], [83, 1040, 6, 16740, 63]],
    [[[['A']]], [78, 1039, 4, 16678, 50]], [['한', '😀', '\ud800', 1, true, null], [78, 1042, 141, 16946, 54]],
    [[null, [12, '한😀', null]], [77, 1041, 157, 16956, 52]],
  ];
  for (const [i, [value, expected]] of literals.entries()) it(`literal ledger ${i}`, () => expect(model(value).total).toEqual(expected));
});


// Post-implementation SPEC R1–R5 coverage, not retrospective protection RED.
// Fixed event costs below are PLAN §5 constants; usage is only positioning/actual.
const repairDimensions = ['nodes', 'slots', 'contentBytes', 'structuralBytes', 'work'] as const;
describe('GSR1 separate graph event admission', () => {
  const rows: [string, string, string, Vector][] = [
    ['G base', '[]', 'stackScratch(budget);', [64, 256, 0, 8192, 0]],
    ['G supplement', '[]', 'budget.reserve({ slots: 768, structuralBytes: 8192 });', [0, 768, 0, 8192, 0]],
    ['G work', '[]', 'budget.spend();\n    }\n    budget.checkDepth(1);', [0, 0, 0, 0, 1]],
    ['object visit', '[1]', 'context.spend();\n    const shape = shapeOf(input, context);', [0, 0, 0, 0, 1]],
    ['method dispatch', '[1]', 'context.spend(4);', [0, 0, 0, 0, 4]],
    ['array length', '[1]', 'context.spend();\n    const count = array.length;', [0, 0, 0, 0, 1]],
    ['index read', '[1,1,1]', 'context.spend();\n      const child = array[index];', [0, 0, 0, 0, 1]],
    ['J', '[[1],[1],[1]]', 'context.reserve({ nodes: 1, slots: count, structuralBytes: exactStringAdd(16, exactStringMul(4, count)) });', [1, 1, 0, 20, 0]],
    ['J work', '[[1],[1],[1]]', 'context.spend(exactStringAdd(count, exactStringBlocks(commas)));', [0, 0, 0, 0, 1]],
    ['number result', '[1,1,1]', 'context.reserveString(state.outB);', [1, 0, 32, 4, 0]],
    ['number F', '[1,1,1]', 'context.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, state.outU)) });', [1, 0, 0, 80, 0]],
    ['number M work', '[1,1,1]', 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(state.outU))));', [0, 0, 0, 0, 4]],
    ['boolean result', '[true,true,true]', 'context.reserveString(state.outB);', [1, 0, 5, 4, 0]],
    ['boolean F', '[true,true,true]', 'context.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, state.outU)) });', [1, 0, 0, 26, 0]],
    ['boolean M work', '[true,true,true]', 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(state.outU))));', [0, 0, 0, 0, 4]],
    ['record result', '[{},{},{}]', 'context.reserveString(15);', [1, 0, 15, 4, 0]],
    ['record F', '[{},{},{}]', 'context.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, 15)) });', [1, 0, 0, 46, 0]],
    ['record M work', '[{},{},{}]', 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(15))));', [0, 0, 0, 0, 4]],
    ['inner join result', '[[1],[1],[1]]', 'context.reserveString(bytes);', [1, 0, 32, 4, 0]],
    ['inner join F', '[[1],[1],[1]]', 'context.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, units)) });', [1, 0, 0, 80, 0]],
    ['inner join M work', '[[1],[1],[1]]', 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(units))));', [0, 0, 0, 0, 4]],
    ['repeated object visit', '[[1],[1],[1]]', 'context.spend();\n    const shape = shapeOf(input, context);', [0, 0, 0, 0, 1]],
    ['repeated method dispatch', '[{},{},{}]', 'context.spend(4);', [0, 0, 0, 0, 4]],
    ['repeated array length', '[[1],[1],[1]]', 'context.spend();\n    const count = array.length;', [0, 0, 0, 0, 1]],
    ['element visit', '[1,1,1]', "budget.spend();\n    if (typeof value === 'string') {", [0, 0, 0, 0, 1]],
    ['source length', '["a","a","a"]', 'budget.spend();\n      const units = value.length;', [0, 0, 0, 0, 1]],
    ['source F', '["a","a","a"]', 'budget.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, units)) });', [1, 0, 0, 18, 0]],
    ['source flatten work', '["a","a","a"]', 'budget.spend(exactStringBlocks(units));', [0, 0, 0, 0, 1]],
    ['outer root result', '[1]', 'budget.reserveString(metadata.rootB);', [1, 0, 32, 4, 0]],
    ['outer root F', '[1]', 'budget.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, metadata.rootU)) });', [1, 0, 0, 80, 0]],
    ['outer root M work', '[1]', 'budget.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(metadata.rootU))));', [0, 0, 0, 0, 4]],
  ];
  for (const [name, json, anchor, cost] of rows) {
    const repeated = json.includes(',');
    for (const position of repeated ? [0, 1, 2] : [0]) for (const [k, key] of repairDimensions.entries()) {
      if (!cost[k]) continue;
      for (const delta of [-1, 0, 1]) it(`${name} position${position} ${key}/${delta} immediate consumer`, () => {
        let ordinal = 0, armed = false, predecessor = 0, consumer = 0, native = 0;
        let before: Vector = [0, 0, 0, 0, 0]; const stop = new Error('selected consumer');
        const budget = createBudgetContext({ now: () => 0 });
        const entry = load(s => {
          // Multi-statement anchors retain the real following consumer and place
          // its observation immediately after the selected debit, not its suffix.
          const split = anchor.indexOf(';') + 1;
          const debit = anchor.slice(0, split), suffix = anchor.slice(split);
          const eligible = name === 'J' || name === 'J work' ? 'count === 1' : name.startsWith('repeated ') ? 'depth === 2' : 'true';
          return replace(s, anchor, `repairBefore(${eligible}); ${debit} repairConsumer();${suffix}`);
        }, {
          repairBefore(eligible: boolean) {
            armed = false;
            if (!eligible || ordinal++ !== position) return;
            predecessor++; armed = true;
            const remaining = budget.limits[key] - usage(budget)[k] - cost[k] - delta;
            if (key === 'work') budget.spend(remaining); else budget.reserve({ [key]: remaining });
            before = usage(budget);
          },
          repairConsumer() { if (armed) { consumer++; throw stop; } },
          String(v: unknown) { native++; return String(v); },
        });
        const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget); native = 0;
        let error: unknown; try { entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
        expect(predecessor).toBe(1); expect(native).toBe(0);
        if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(consumer).toBe(0); }
        else { expect(error).toBe(stop); expect(consumer).toBe(1); expect(usage(budget).map((n, i) => n - before[i])).toEqual(cost); }
      });
    }
  }
});

describe('GSR2 exact doubled L identity capacity', () => {
  it('same identity twice simultaneous exact doubled L vector', () => {
    const budget = createBudgetContext({ now: () => 0 }); let active = false, native = 0;
    const entry = load(s => s, { String(v: unknown) { if (active) { native++; expect(v).toBe(value); } return String(v); } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[[1,"한"],true,null]', budget);
    const doubled = model(value).total.map(n => 2 * n);
    for (const [k, key] of repairDimensions.entries()) {
      const remaining = budget.limits[key] - usage(budget)[k] - doubled[k];
      if (key === 'work') budget.spend(remaining); else budget.reserve({ [key]: remaining });
    }
    const before = usage(budget); active = true;
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(native).toBe(2); expect(usage(budget).map((n, i) => n - before[i])).toEqual(doubled);
    expect(usage(budget)).toEqual(repairDimensions.map(key => budget.limits[key]));
  });
  for (const [k, key] of repairDimensions.entries()) it(`same identity twice exact doubled L ${key}`, () => {
    const budget = createBudgetContext({ now: () => 0 }); let active = false, native = 0;
    const entry = load(s => s, { String(v: unknown) { if (active) { native++; expect(v).toBe(value); } return String(v); } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[[1,"한"],true,null]', budget);
    const doubled = model(value).total.map(n => 2 * n);
    const remaining = budget.limits[key] - usage(budget)[k] - doubled[k];
    if (key === 'work') budget.spend(remaining); else budget.reserve({ [key]: remaining });
    const before = usage(budget); active = true;
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(entry.stringBoundedJsonExact(value, budget)).toBe(originalCaller(value));
    expect(native).toBe(2); expect(usage(budget).map((n, i) => n - before[i])).toEqual(doubled);
    expect(usage(budget)[k]).toBe(budget.limits[key]);
  });
});

// Artificial AST exception seams on the real new graph declaration, not
// arbitrary accessor graph admission. Checkpoint expectations are independent
// of the accepted arithmetic-only model. Successor getters observe LOOKUP.
describe('GSR3 uncovered graph local checkpoint exits', () => {
  const rows: [string, unknown, string][] = [
    ['null element', null, 'state.outU = state.outB = 0;'],
    ['undefined element branch seam', undefined, 'state.outU = state.outB = 0;'],
    ['number element', 1, 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(state.outU))));'],
    ['boolean element', true, 'context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(state.outU))));'],
  ];
  for (const [name, value, anchor] of rows) for (const mode of ['timely', 'expired', 'aborted'] as const) {
    for (const outcome of ['success', 'Error', 'RangeError', 'TypeError', 'exceeded', 'unavailable'] as const) it(`${name} artificial local ${mode}/${outcome}`, () => {
      let clock = 0, reached = 0, lookups = 0, returned = false; const signal = { aborted: false }; const trace: string[] = [];
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
        : outcome === 'TypeError' ? new TypeError(name) : outcome === 'RangeError' ? new RangeError(name) : new Error(name);
      const entry = load(s => {
        let t = replace(s, anchor, anchor + ' repairExit();');
        t = replace(t, '      return;\n    }\n    context.spend();', '      repairSuccessor.next(); return;\n    }\n    context.spend();');
        return t + '\nexport { exactStringGraph };\n';
      }, {
        repairExit() { reached++; trace.push('metadata/M complete'); if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; if (outcome !== 'success') throw sentinel; },
        repairSuccessor: { get next() { lookups++; trace.push('local return lookup'); return () => {}; } },
      });
      const base = createBudgetContext({ now: () => clock, signal });
      const budget: BudgetContext = { ...base, check() { if (reached) trace.push('check'); base.check(); } };
      let error: unknown;
      try { (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number, e: boolean) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, 2, true); returned = true; } catch (e) { error = e; }
      expect(reached).toBe(1);
      if (mode === 'timely' && outcome === 'success') {
        expect(returned).toBe(true); expect(error).toBeUndefined(); expect(lookups).toBe(1);
        expect(trace).toEqual(['metadata/M complete', 'check', 'local return lookup']);
      } else {
        expect(returned).toBe(false); expect(lookups).toBe(0);
        if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(error).toBe(sentinel);
        else expect(error).toBeInstanceOf(BudgetUnavailableError);
        expect(trace).toEqual(outcome === 'exceeded' || outcome === 'unavailable' ? ['metadata/M complete'] : ['metadata/M complete', 'check']);
      }
    });
  }
  for (const json of ['[]', '{}', '[null]']) it(`aborted graph own entry ${json} before routing lookup`, () => {
    let lookups = 0; const signal = { aborted: false };
    const entry = load(s => replace(s, "if (input === null || typeof input !== 'object') {", "repairRoute.next(); if (input === null || typeof input !== 'object') {") + '\nexport { exactStringGraph };\n', {
      repairRoute: { get next() { lookups++; return () => {}; } },
    });
    const budget = createBudgetContext({ now: () => 0, signal });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget); signal.aborted = true;
    expect(() => (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, 1)).toThrow(BudgetUnavailableError);
    expect(lookups).toBe(0);
  });
  for (const mode of ['timely', 'expired', 'aborted'] as const) for (const outcome of ['success', 'Error', 'RangeError', 'TypeError', 'exceeded', 'unavailable'] as const) {
    it(`root-size artificial ${mode}/${outcome} before metadata lookup`, () => {
      let clock = 0, reached = 0, lookups = 0, native = 0, active = false; const signal = { aborted: false }; const trace: string[] = [];
      const sentinel = outcome === 'exceeded' ? new BudgetExceededError() : outcome === 'unavailable' ? new BudgetUnavailableError()
        : outcome === 'TypeError' ? new TypeError('root-size') : outcome === 'RangeError' ? new RangeError('root-size') : new Error('root-size');
      const entry = load(s => replace(replace(s, 'exactStringGraph(value, budget, metadata, cap, 1);', '(exactStringGraph(value, budget, metadata, cap, 1), repairExit());'), 'metadata.rootU = metadata.outU;', 'repairSuccessor.next(); metadata.rootU = metadata.outU;'), {
        repairExit() { reached++; trace.push('graph returned'); if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; if (outcome !== 'success') throw sentinel; },
        repairSuccessor: { get next() { lookups++; trace.push('retain lookup'); return () => {}; } },
        String(v: unknown) { if (active) native++; return String(v); },
      });
      const base = createBudgetContext({ now: () => clock, signal });
      const budget: BudgetContext = { ...base, check() { if (reached && !lookups) trace.push('check'); base.check(); } };
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[]', budget); active = true;
      let error: unknown, result: unknown; try { result = entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
      expect(reached).toBe(1);
      if (mode === 'timely' && outcome === 'success') { expect(result).toBe(''); expect(error).toBeUndefined(); expect(native).toBe(1); expect(lookups).toBe(1); expect(trace).toEqual(['graph returned', 'check', 'retain lookup']); }
      else {
        expect(native).toBe(0); expect(lookups).toBe(0);
        if (outcome === 'exceeded' || outcome === 'unavailable' || mode === 'timely') expect(error).toBe(sentinel); else expect(error).toBeInstanceOf(BudgetUnavailableError);
        expect(trace).toEqual(outcome === 'exceeded' || outcome === 'unavailable' ? ['graph returned'] : ['graph returned', 'check']);
      }
    });
  }
});


describe('GSR1 owner and comma work consumers', () => {
  for (const position of [-1, 0, 1, 2]) for (const delta of [-1, 0, 1]) it(`owner lookup position${position} work/${delta} before real WeakMap get`, () => {
    let armed = false, predecessor = 0, gets = 0, ordinal = 0; const stop = new Error('owner lookup');
    const budget = createBudgetContext({ now: () => 0 });
    const entry = load(s => replace(s, 'const shape = shapeOf(input, context);', 'repairOwner(depth); const shape = shapeOf(input, context);'), {
      repairOwner(depth: number) { if ((position < 0 && depth !== 1) || (position >= 0 && (depth !== 2 || ordinal++ !== position))) return; predecessor++; budget.spend(budget.limits.work - usage(budget)[4] - 1 - delta); armed = true; },
    });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[{},{},{}]', budget) as object[];
    const selected = position < 0 ? value : value[position];
    const intrinsic = WeakMap.prototype.get; let error: unknown;
    WeakMap.prototype.get = function(key: object) { if (armed && key === selected) { gets++; throw stop; } return intrinsic.call(this, key); };
    try { entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; } finally { WeakMap.prototype.get = intrinsic; }
    expect(predecessor).toBe(1);
    if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(gets).toBe(0); }
    else { expect(error).toBe(stop); expect(gets).toBe(1); expect(budget.limits.work - usage(budget)[4]).toBe(delta); }
  });
  for (const count of [2, 257]) for (const position of [0, 1, 2]) for (const delta of [-1, 0, 1]) {
    it(`J native slots and comma count${count} position${position} work/${delta}`, () => {
      let ordinal = 0, armed = false, predecessor = 0, successor = 0; const stop = new Error('J consumer');
      // count2: two native slots plus one comma block; count257: 257 slots plus q(256)=1.
      const cost = count === 2 ? 3 : 258;
      const budget = createBudgetContext({ now: () => 0 });
      const entry = load(s => replace(s, 'context.spend(exactStringAdd(count, exactStringBlocks(commas)));', 'repairBefore(count); context.spend(exactStringAdd(count, exactStringBlocks(commas))); repairNext.get();'), {
        repairBefore(n: number) { armed = false; if (n !== count || ordinal++ !== position) return; predecessor++; armed = true; budget.spend(budget.limits.work - usage(budget)[4] - cost - delta); },
        repairNext: { get get() { if (armed) { successor++; throw stop; } return () => {}; } },
      });
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(JSON.stringify([Array(count).fill(null), Array(count).fill(null), Array(count).fill(null)]), budget);
      let error: unknown; try { entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
      expect(predecessor).toBe(1);
      if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(successor).toBe(0); }
      else { expect(error).toBe(stop); expect(successor).toBe(1); expect(budget.limits.work - usage(budget)[4]).toBe(delta); }
    });
  }
});

describe('GSR2 named graph cap admission', () => {
  // Context/AST capacity seams alter only the selected local limit or final
  // metadata operand. They do not certify oversized or accessor input graphs.
  const rows: [string, string, number, string, string, string][] = [
    ['comma seed U before J', '[null,null,null]', 2, 'let units = commas, bytes = commas;', '', 'context.reserve({ nodes: 1, slots: count, structuralBytes: exactStringAdd(16, exactStringMul(4, count)) });'],
    ['U accumulation before B', '["aa",null]', 3, 'units = exactStringAdd(units, state.outU);', '', 'bytes = exactStringAdd(bytes, state.outB);'],
    ['B accumulation before next child', '["한",null]', 4, 'bytes = exactStringAdd(bytes, state.outB);', '', 'index = exactStringAdd(index, 1)'],
    ['U accumulation position0 before B', '["aa","aa","aa",null]', 5, 'units = exactStringAdd(units, state.outU);', '', 'bytes = exactStringAdd(bytes, state.outB);'],
    ['U accumulation position1 before B', '["aa","aa","aa",null]', 7, 'units = exactStringAdd(units, state.outU);', '', 'bytes = exactStringAdd(bytes, state.outB);'],
    ['U accumulation position2 before B', '["aa","aa","aa",null]', 9, 'units = exactStringAdd(units, state.outU);', '', 'bytes = exactStringAdd(bytes, state.outB);'],
    ['B accumulation position0 before next child', '["한","한","한",null]', 6, 'bytes = exactStringAdd(bytes, state.outB);', '', 'index = exactStringAdd(index, 1)'],
    ['B accumulation position1 before next child', '["한","한","한",null]', 9, 'bytes = exactStringAdd(bytes, state.outB);', '', 'index = exactStringAdd(index, 1)'],
    ['B accumulation position2 before next child', '["한","한","한",null]', 12, 'bytes = exactStringAdd(bytes, state.outB);', '', 'index = exactStringAdd(index, 1)'],
    ['number32 before inner M', '[1]', 32, 'exactStringScalar(input, context, state, ceiling);', '', 'context.reserveString(state.outB);'],
    ['boolean5 before inner M', '[true]', 5, 'exactStringScalar(input, context, state, ceiling);', '', 'context.reserveString(state.outB);'],
    ['record15 before inner M', '[{}]', 15, 'exactStringCap(15, ceiling);', '', 'context.reserveString(15);'],
    ["number32 position0 before inner M", "[1,1,1]", 32, "exactStringScalar(input, context, state, ceiling);", "", "context.reserveString(state.outB);"],
    ["number32 position1 before inner M", "[1,1,1]", 32, "exactStringScalar(input, context, state, ceiling);", "", "context.reserveString(state.outB);"],
    ["number32 position2 before inner M", "[1,1,1]", 32, "exactStringScalar(input, context, state, ceiling);", "", "context.reserveString(state.outB);"],
    ["boolean5 position0 before inner M", "[true,true,true]", 5, "exactStringScalar(input, context, state, ceiling);", "", "context.reserveString(state.outB);"],
    ["boolean5 position1 before inner M", "[true,true,true]", 5, "exactStringScalar(input, context, state, ceiling);", "", "context.reserveString(state.outB);"],
    ["boolean5 position2 before inner M", "[true,true,true]", 5, "exactStringScalar(input, context, state, ceiling);", "", "context.reserveString(state.outB);"],
    ["record15 position0 before inner M", "[{},{},{}]", 15, "exactStringCap(15, ceiling);", "", "context.reserveString(15);"],
    ["record15 position1 before inner M", "[{},{},{}]", 15, "exactStringCap(15, ceiling);", "", "context.reserveString(15);"],
    ["record15 position2 before inner M", "[{},{},{}]", 15, "exactStringCap(15, ceiling);", "", "context.reserveString(15);"],
    ["inner join U position0 before M", "[[null],[null],[null]]", 2, "index = exactStringAdd(index, 1)", "units = 2;", "context.reserveString(bytes);"],
    ["inner join U position1 before M", "[[null],[null],[null]]", 2, "index = exactStringAdd(index, 1)", "units = 2;", "context.reserveString(bytes);"],
    ["inner join U position2 before M", "[[null],[null],[null]]", 2, "index = exactStringAdd(index, 1)", "units = 2;", "context.reserveString(bytes);"],
    ["inner join B position0 before M", "[[null],[null],[null]]", 2, "index = exactStringAdd(index, 1)", "bytes = 2;", "context.reserveString(bytes);"],
    ["inner join B position1 before M", "[[null],[null],[null]]", 2, "index = exactStringAdd(index, 1)", "bytes = 2;", "context.reserveString(bytes);"],
    ["inner join B position2 before M", "[[null],[null],[null]]", 2, "index = exactStringAdd(index, 1)", "bytes = 2;", "context.reserveString(bytes);"],
    ['final join U before M', '[null]', 2, 'index = exactStringAdd(index, 1)', 'units = 2;', 'context.reserveString(bytes);'],
    ['final join B before M', '[null]', 2, 'index = exactStringAdd(index, 1)', 'bytes = 2;', 'context.reserveString(bytes);'],
    ['outer root U before M', '[]', 2, 'metadata.rootU = metadata.outU; metadata.rootB = metadata.outB;', 'metadata.rootU = 2;', 'budget.reserveString(metadata.rootB);'],
    ['outer root B before M', '[]', 2, 'metadata.rootU = metadata.outU; metadata.rootB = metadata.outB;', 'metadata.rootB = 2;', 'budget.reserveString(metadata.rootB);'],
  ];
  for (const [name, json, bound, predecessorAnchor, change, nextAnchor] of rows) for (const delta of [-1, 0, 1]) {
    it(`${name} C${delta < 0 ? '-1' : delta ? '+1' : ''} selected lookup`, () => {
      let predecessor = 0, lookups = 0, active = false, native = 0, ordinal = 0; const stop = new Error('cap successor');
      const position = Number(name.match(/position(\d)/)?.[1] ?? 0);
      const outer = name.startsWith('outer root');
      const entry = load(s => {
        let t = s;
        if (predecessorAnchor.startsWith('index =')) {
          const field = change.startsWith('units') ? 'units' : 'bytes';
          t = replace(t, predecessorAnchor, `index = (repairBefore(depth), ceiling = repairCap(), ${field} = repairBound(${field}), exactStringAdd(index, 1))`);
          // Every child accumulation is admitted at the original ceiling;
          // selected final U/B is introduced only in the real loop increment.
        } else if (outer) {
          t = replace(t, predecessorAnchor, predecessorAnchor + ` repairBefore(); ${change}`);
        } else {
          t = replace(t, predecessorAnchor, `repairBefore(); ${predecessorAnchor}`);
        }
        if (nextAnchor.startsWith('index =')) t = replace(t, nextAnchor, 'index = (repairNext.get(), exactStringAdd(index, 1))');
        else t = replace(t, nextAnchor, 'repairNext.get(); ' + nextAnchor);
        if (outer) t = replace(t, 'exactStringCap(metadata.rootU, cap); exactStringCap(metadata.rootB, cap);', 'exactStringCap(metadata.rootU, repairCap()); exactStringCap(metadata.rootB, repairCap());');
        else if (!predecessorAnchor.startsWith('index =')) {
          // Change the local ceiling only at the selected predecessor. Earlier
          // seed/leaf caps therefore cannot masquerade as the selected cap.
          t = replace(t, `repairBefore(); ${predecessorAnchor}`, `repairBefore(); ceiling = repairCap(); ${predecessorAnchor}`);
        }
        return t;
      }, {
        repairBefore(depth = 0) { active = false; if (name.startsWith('inner join') && depth !== 2) return; active = ordinal++ === position; if (active) predecessor++; },
        repairCap() { return active ? bound + delta : 8_000_000; }, repairBound(current: number) { return active ? bound : current; },
        repairNext: { get get() { if (active) { lookups++; throw stop; } return () => {}; } },
        String(v: unknown) { native++; return String(v); },
      });
      const budget = createBudgetContext({ now: () => 0 });
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget); native = 0;
      let error: unknown; try { entry.stringBoundedJsonExact(value, budget); } catch (e) { error = e; }
      expect(predecessor).toBe(1); expect(native).toBe(0);
      if (delta < 0) { expect(error).toBeInstanceOf(BudgetExceededError); expect(lookups).toBe(0); }
      else { expect(error).toBe(stop); expect(lookups).toBe(1); }
    });
  }
});

describe('GSR3 artificial ordinary alternatives at graph seams', () => {
  const rows: [string, string, string, string][] = [
    ['shape', '[[]]', 'const shape = shapeOf(input, context);', 'context.spend(4);'],
    ['length', '[[]]', 'const count = array.length;', 'exactStringAmount(count);'],
    ['index', '[[]]', 'const child = array[index];', 'const childDepth = exactStringAdd(depth, 1);'],
    ['child', '[[]]', 'exactStringGraph(child, context, state, ceiling, childDepth, true);', 'units = exactStringAdd(units, state.outU);'],
    ['array final', '[]', 'state.outU = units; state.outB = bytes;', ''],
    ['record final', '{}', 'state.outU = state.outB = 15;', ''],
    ['scalar wrapper', '"a"', 'exactStringScalar(input, context, state, ceiling);', ''],
  ];
  for (const [name, json, anchor, next] of rows) for (const mode of ['timely', 'expired', 'aborted'] as const) for (const outcome of ['Error', 'TypeError'] as const) {
    it(`${name} labeled AST ${mode}/${outcome} local identity`, () => {
      let clock = 0, reached = 0, lookups = 0, returned = false; const signal = { aborted: false };
      const sentinel = outcome === 'Error' ? new Error(name) : new TypeError(name);
      const entry = load(s => {
        let t = replace(s, anchor, anchor + ' repairExit();');
        if (next) t = replace(t, next, 'repairNext.get(); ' + next);
        return t + '\nexport { exactStringGraph };\n';
      }, {
        repairExit() { reached++; if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; throw sentinel; },
        repairNext: { get get() { lookups++; return () => {}; } },
      });
      const budget = createBudgetContext({ now: () => clock, signal });
      const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(json, budget);
      let error: unknown; try { (entry.exactStringGraph as (v: unknown, b: BudgetContext, m: object, c: number, d: number) => void)(value, budget, { outU: 0, outB: 0, rootU: 0, rootB: 0 }, 8_000_000, 1); returned = true; } catch (e) { error = e; }
      expect(reached).toBe(1); expect(returned).toBe(false); expect(lookups).toBe(0);
      if (mode === 'timely') expect(error).toBe(sentinel); else expect(error).toBeInstanceOf(BudgetUnavailableError);
    });
  }
  for (const mode of ['expired', 'aborted'] as const) it(`length success ${mode} forbids immediate amount lookup`, () => {
    let clock = 0, reached = 0, lookups = 0; const signal = { aborted: false };
    const entry = load(s => replace(replace(s, 'const count = array.length;', 'const count = array.length; repairExit();'), 'exactStringAmount(count);', 'repairNext.get(); exactStringAmount(count);'), {
      repairExit() { reached++; if (mode === 'expired') clock = 5000; else signal.aborted = true; }, repairNext: { get get() { lookups++; return () => {}; } },
    });
    const budget = createBudgetContext({ now: () => clock, signal });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[]', budget);
    expect(() => entry.stringBoundedJsonExact(value, budget)).toThrow(BudgetUnavailableError); expect(reached).toBe(1); expect(lookups).toBe(0);
  });
});


describe('GSR3 independent graph checkpoint order', () => {
  it('null child full explicit checkpoint and successor order', () => {
    const trace: string[] = []; let active = false;
    const base = createBudgetContext({ now: () => 0 });
    const budget: BudgetContext = { ...base, check() { if (active) trace.push('check'); base.check(); }, checkDepth(d) { if (active) trace.push('depth' + d); base.checkDepth(d); } };
    const entry = load(s => {
      const points: [string, string][] = [
        ['const metadata: exactStringMetadata = { outU: 0, outB: 0, rootU: 0, rootB: 0 };', 'H'],
        ['const shape = shapeOf(input, context);', 'shape'],
        ['const count = array.length;', 'length'],
        ['const child = array[index];', 'index'],
        ['state.outU = state.outB = 0;', 'null metadata'],
        ['exactStringGraph(child, context, state, ceiling, childDepth, true);', 'child returned'],
        ['state.outU = units; state.outB = bytes;', 'join metadata'],
        ['metadata.rootU = metadata.outU; metadata.rootB = metadata.outB;', 'retained'],
      ];
      let t = s;
      for (const [anchor, label] of points) t = replace(t, anchor, anchor + ` repairMark('${label}');`);
      t = replace(t, 'exactStringGraph(value, budget, metadata, cap, 1);', "(exactStringGraph(value, budget, metadata, cap, 1), repairMark('graph returned'));");
      t = replace(t, 'element = false): void {', "element = false): void { repairMark('graph enter');");
      return t;
    }, { repairMark(label: string) { trace.push(label); }, String(v: unknown) { if (active) trace.push('native'); return String(v); } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[null]', budget); active = true;
    expect(entry.stringBoundedJsonExact(value, budget)).toBe('');
    expect(trace).toEqual(['check', 'H', 'check', 'depth1', 'graph enter', 'check', 'shape', 'check', 'length', 'check', 'index', 'check', 'depth2', 'graph enter', 'check', 'null metadata', 'check', 'child returned', 'check', 'join metadata', 'check', 'graph returned', 'check', 'retained', 'check', 'native', 'check', 'check']);
  });
});

describe('GSR5 graph enumeration exclusion', () => {
  it('registered operand keys are never enumerated during preparation', () => {
    const budget = createBudgetContext({ now: () => 0 }); let native = false, enumerated = 0;
    const entry = load(s => s, { String(v: unknown) { native = true; return String(v); } });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[[1],{}]', budget) as unknown[];
    native = false; const intrinsic = Object.keys; let result: unknown;
    Object.keys = function(v: object) { if (!native && (v === value || v === value[0] || v === value[1])) enumerated++; return intrinsic(v); };
    try { result = entry.stringBoundedJsonExact(value, budget); } finally { Object.keys = intrinsic; }
    expect(result).toBe(originalCaller(value)); expect(enumerated).toBe(0);
  });
  for (const mode of ['timely', 'expired', 'aborted'] as const) it(`scalar wrapper success ${mode} before element predicate lookup`, () => {
    let reached = 0, lookups = 0, clock = 0; const signal = { aborted: false };
    const entry = load(s => replace(replace(s, 'exactStringScalar(input, context, state, ceiling);', 'exactStringScalar(input, context, state, ceiling); repairExit();'), "if (element && (typeof input === 'number' || typeof input === 'boolean')) {", "repairNext.get(); if (element && (typeof input === 'number' || typeof input === 'boolean')) {"), {
      repairExit() { reached++; if (mode === 'expired') clock = 5000; if (mode === 'aborted') signal.aborted = true; }, repairNext: { get get() { lookups++; return () => {}; } },
    });
    const budget = createBudgetContext({ now: () => clock, signal });
    const value = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)('[1]', budget);
    if (mode === 'timely') { expect(entry.stringBoundedJsonExact(value, budget)).toBe('1'); expect(lookups).toBe(1); }
    else { expect(() => entry.stringBoundedJsonExact(value, budget)).toThrow(BudgetUnavailableError); expect(lookups).toBe(0); }
    expect(reached).toBe(1);
  });
});

// R1 consumer connectivity: supplemental to frozen013's admission-marker rows.
// The private input remains the real same-owner immutable decoder result. Read
// observers wrap only the selected expression, not graph admission or native input.
// Deferred charges use a labeled artificial single-debit lower-capacity lens:
// an independent predecessor arms it, the real budget primitive checks cost-1/C/C+1,
// and every original charge still goes once to the original owner context. The
// lens ends on return from that debit; no counters are refunded or caps enlarged.
// Unlike the old post-debit stop, the suffix executes through real native joins.
// Optional debit annotation is NOT an instrumentation boundary: deleting a debit
// leaves all predecessors, reads, recursive declarations and native hooks intact.
const r1Fixtures: Record<string, { json: string; total: Vector }> = {
  empty: { json: '[]', total: [71, 1036, 0, 16568, 14] },
  number: { json: '[1,1,1]', total: [77, 1039, 292, 17224, 40] },
  boolean: { json: '[true,true,true]', total: [77, 1039, 49, 16738, 40] },
  record: { json: '[{},{},{}]', total: [77, 1039, 139, 16918, 55] },
  inner: { json: '[[1],[1],[1]]', total: [86, 1042, 388, 17536, 79] },
  source: { json: '["a","a","a"]', total: [74, 1039, 10, 16654, 37] },
  comma2: { json: '[[null,null],[null,null],[null,null]]', total: [80, 1045, 13, 16738, 79] },
  comma257: { json: JSON.stringify([Array(257).fill(null), Array(257).fill(null), Array(257).fill(null)]), total: [80, 1810, 2308, 24388, 2386] },
};
// Literal suffix recipes, not candidate-derived usage: O/H/G = 66/1036/0/16512/3;
// array entry = 7 work; index+null = 2; index+number/boolean = 6;
// index+record = 11; result/F/M = [2,0,B,20+2U,2+2ceil(U/256)].
// Each array pays J=[1,n,0,16+4n,n+ceil((n-1)/256)], its own M,
// and the root pays a distinct outer M. These equations yield the literal totals.
type R1ConsumerRow = { name: string; fixture: string; group: string; debit: string; cost: Vector; consumer: 'frame' | 'child frame' | 'finite' | 'source length' | 'owner' | 'dispatch' | 'length' | 'index' | 'join' | 'record' | 'scan' | 'String'; root?: boolean };
const r1ConsumerRows: R1ConsumerRow[] = [
  { name: 'G base', fixture: 'empty', group: 'G', debit: 'G base', cost: [64, 256, 0, 8192, 0], consumer: 'frame', root: true },
  { name: 'G supplement', fixture: 'empty', group: 'G', debit: 'G supplement', cost: [0, 768, 0, 8192, 0], consumer: 'frame', root: true },
  { name: 'G work', fixture: 'empty', group: 'G', debit: 'G work', cost: [0, 0, 0, 0, 1], consumer: 'frame', root: true },
  { name: 'object visit', fixture: 'inner', group: 'graph', debit: 'object visit', cost: [0, 0, 0, 0, 1], consumer: 'owner' },
  { name: 'method dispatch', fixture: 'record', group: 'method', debit: 'method', cost: [0, 0, 0, 0, 4], consumer: 'dispatch' },
  { name: 'array length', fixture: 'inner', group: 'length', debit: 'length', cost: [0, 0, 0, 0, 1], consumer: 'length' },
  { name: 'index read', fixture: 'number', group: 'index', debit: 'index', cost: [0, 0, 0, 0, 1], consumer: 'index' },
  { name: 'J', fixture: 'inner', group: 'J', debit: 'J', cost: [1, 1, 0, 20, 0], consumer: 'join' },
  { name: 'J work', fixture: 'inner', group: 'J', debit: 'J work', cost: [0, 0, 0, 0, 1], consumer: 'join' },
  { name: 'J comma2', fixture: 'comma2', group: 'J', debit: 'J work', cost: [0, 0, 0, 0, 3], consumer: 'join' },
  { name: 'J comma257', fixture: 'comma257', group: 'J', debit: 'J work', cost: [0, 0, 0, 0, 258], consumer: 'join' },
  ...(['number', 'boolean', 'record', 'inner'] as const).flatMap(fixture => {
    const bound = fixture === 'boolean' ? 5 : fixture === 'record' ? 15 : 32;
    const group = fixture === 'inner' ? 'join' : fixture === 'record' ? 'record' : 'leaf';
    const consumer = fixture === 'record' ? 'record' as const : 'join' as const;
    return [
      { name: fixture + ' result', fixture, group, debit: group + ' result', cost: [1, 0, bound, 4, 0] as Vector, consumer },
      { name: fixture + ' F', fixture, group, debit: group + ' F', cost: [1, 0, 0, 16 + 2 * bound, 0] as Vector, consumer },
      { name: fixture + ' M work', fixture, group, debit: group + ' M', cost: [0, 0, 0, 0, 4] as Vector, consumer },
    ];
  }),
  { name: 'J before descendant', fixture: 'inner', group: 'J', debit: 'J', cost: [1, 1, 0, 20, 0], consumer: 'child frame' },
  { name: 'J work before descendant', fixture: 'inner', group: 'J', debit: 'J work', cost: [0, 0, 0, 0, 1], consumer: 'child frame' },
  { name: 'element visit', fixture: 'number', group: 'scalar', debit: 'scalar visit', cost: [0, 0, 0, 0, 1], consumer: 'finite' },
  { name: 'source length', fixture: 'source', group: 'source length', debit: 'source length', cost: [0, 0, 0, 0, 1], consumer: 'source length' },
  { name: 'native method dispatch', fixture: 'record', group: 'method', debit: 'method', cost: [0, 0, 0, 0, 4], consumer: 'record' },
  { name: 'source F', fixture: 'source', group: 'source', debit: 'source F', cost: [1, 0, 0, 18, 0], consumer: 'scan' },
  { name: 'source flatten', fixture: 'source', group: 'source', debit: 'source flatten', cost: [0, 0, 0, 0, 1], consumer: 'scan' },
  { name: 'outer root result', fixture: 'number', group: 'root', debit: 'root result', cost: [1, 0, 98, 4, 0], consumer: 'String', root: true },
  { name: 'outer root F', fixture: 'number', group: 'root', debit: 'root F', cost: [1, 0, 0, 212, 0], consumer: 'String', root: true },
  { name: 'outer root M', fixture: 'number', group: 'root', debit: 'root M', cost: [0, 0, 0, 0, 4], consumer: 'String', root: true },
];
function r1ConsumerTransform(s: string): string {
  // Only these non-debit boundaries are mandatory and exact. A debit-free mutant
  // must still compile the real consumer and all its independent predecessors.
  const anchors: [string, string][] = [
    ['element = false): void {', "element = false): void { r1Frame(input, depth); r1At('graph', input, depth);"],
    ['const metadata: exactStringMetadata = { outU: 0, outB: 0, rootU: 0, rootB: 0 };', "const metadata: exactStringMetadata = { outU: 0, outB: 0, rootU: 0, rootB: 0 }; r1At('G', value, 1);"],
    ['const shape = shapeOf(input, context);', "const shape = shapeOf(input, context); r1At('method', input, depth);"],
    ['if (!shape.array) {', "if (!r1Read(shape, input, 'dispatch').array) {"],
    ['const array = input as unknown[];', "const array = input as unknown[]; r1At('length', input, depth);"],
    ['const count = array.length;', "const count = r1Read(array, input, 'length').length;"],
    ['let units = commas, bytes = commas;', "let units = commas, bytes = commas; r1At('J', input, depth);"],
    ['for (let index = 0; index < count; index = exactStringAdd(index, 1)) {', "for (let index = 0; index < count; index = exactStringAdd(index, 1)) { r1At('index', input, depth, index);"],
    ['const child = array[index];', "const child = r1Read(array, input, 'index')[index];"],
    ["if (element && (typeof input === 'number' || typeof input === 'boolean')) {", "if (element && (typeof input === 'number' || typeof input === 'boolean')) { r1At('leaf', input, depth);"],
    ['exactStringCap(15, ceiling);', "exactStringCap(15, ceiling); r1At('record', input, depth);"],
    ['    }\n    exactStringCap(units, ceiling); exactStringCap(bytes, ceiling);', "    }\n    exactStringCap(units, ceiling); exactStringCap(bytes, ceiling); r1At('join', input, depth);"],
    ['metadata.rootU = metadata.outU; metadata.rootB = metadata.outB;', "metadata.rootU = metadata.outU; metadata.rootB = metadata.outB; r1At('root', value, 1);"],
    ['exactStringCap(units, cap);', "exactStringCap(units, cap); r1At('source', value, 2);"],
    ['function exactStringScalar(value: unknown, budget: BudgetContext, metadata: exactStringMetadata, cap: number): void {', "function exactStringScalar(value: unknown, budget: BudgetContext, metadata: exactStringMetadata, cap: number): void { r1At('scalar', value, 2);"],
    ["if (typeof value === 'string') {", "if (typeof value === 'string') { r1At('source length', value, 2);"],
    ['const units = value.length;', 'const units = r1Length(value.length);'],
  ];
  for (const [from, to] of anchors) s = replace(s, from, to);
  const annotations: [string, string][] = [
    ['stackScratch(budget);', "stackScratch(r1Debit('G base', budget));"],
    ["budget.spend();\n    if (typeof value === 'string')", "r1Debit('scalar visit', budget).spend();\n    if (typeof value === 'string')"],
    ['budget.spend();\n      const units', "r1Debit('source length', budget).spend();\n      const units"],
    ['budget.reserve({ slots: 768, structuralBytes: 8192 });', "r1Debit('G supplement', budget).reserve({ slots: 768, structuralBytes: 8192 });"],
    ['budget.spend();\n    }\n    budget.checkDepth(1);', "r1Debit('G work', budget).spend();\n    }\n    budget.checkDepth(1);"],
    ['context.spend();\n    const shape', "r1Debit('object visit', context).spend();\n    const shape"],
    ['context.spend(4);', "r1Debit('method', context).spend(4);"],
    ['context.spend();\n    const count', "r1Debit('length', context).spend();\n    const count"],
    ['context.spend();\n      const child', "r1Debit('index', context).spend();\n      const child"],
    ['context.reserve({ nodes: 1, slots: count, structuralBytes: exactStringAdd(16, exactStringMul(4, count)) });', "r1Debit('J', context).reserve({ nodes: 1, slots: count, structuralBytes: exactStringAdd(16, exactStringMul(4, count)) });"],
    ['context.spend(exactStringAdd(count, exactStringBlocks(commas)));', "r1Debit('J work', context).spend(exactStringAdd(count, exactStringBlocks(commas)));"],
  ];
  for (const [group, receiver, u, b] of [
    ['leaf', 'context', 'state.outU', 'state.outB'], ['record', 'context', '15', '15'],
    ['join', 'context', 'units', 'bytes'], ['root', 'budget', 'metadata.rootU', 'metadata.rootB'],
  ]) {
    annotations.push([`${receiver}.reserveString(${b});`, `r1Debit('${group} result', ${receiver}).reserveString(${b});`]);
    annotations.push([`${receiver}.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, ${u})) });`, `r1Debit('${group} F', ${receiver}).reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, ${u})) });`]);
    annotations.push([`${receiver}.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(${u}))));`, `r1Debit('${group} M', ${receiver}).spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(${u}))));`]);
  }
  annotations.push(['budget.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, units)) });', "r1Debit('source F', budget).reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, units)) });"]);
  annotations.push(['budget.spend(exactStringBlocks(units));', "r1Debit('source flatten', budget).spend(exactStringBlocks(units));"]);
  for (const [from, to] of annotations) s = s.replace(from, to);
  return s;
}

describe('GSR1C independently anchored actual consumers', () => {
  for (const [name, fixture] of Object.entries(r1Fixtures)) it(`literal suffix recipe ${name}`, () => {
    expect(model(JSON.parse(fixture.json)).total).toEqual(fixture.total);
  });
  for (const row of r1ConsumerRows) for (const position of row.root ? [0] : [0, 1, 2]) {
    for (const [k, key] of repairDimensions.entries()) {
      if (!row.cost[k]) continue;
      for (const delta of [-1, 0, 1]) it(`${row.name} position${position} ${key}/${delta} real ${row.consumer}`, () => {
        const fixture = r1Fixtures[row.fixture], stop = new Error('actual ' + row.consumer);
        const budget = createBudgetContext({ now: () => 0 });
        const direct = ['length', 'index', 'dispatch', 'finite', 'source length'].includes(row.consumer);
        let active = false, inGroup = false, ordinal = 0, predecessor = 0, admitted = 0, attempted = 0, consumers = 0, sameOwner = true;
        let selected: unknown, before: Vector = [0, 0, 0, 0, 0], nativeUsage: Vector | undefined;
        const hit = () => { consumers++; throw stop; };
        const entry = load(r1ConsumerTransform, {
          r1At(group: string, value: unknown, depth: number, index = -1) {
            if (!active || group !== row.group) return;
            const eligible = row.root ? depth === 1 : group === 'index' ? depth === 1 : depth === 2;
            inGroup = eligible && ordinal++ === position;
            if (inGroup) {
              predecessor++; selected = group === 'index' ? index : value;
              // These immediate work consumers need no artificial admission lens.
              if (direct) budget.spend(budget.limits.work - usage(budget)[4] - row.cost[4] - delta);
            }
          },
          r1Debit(label: string, original: BudgetContext): BudgetContext {
            if (!active || !inGroup || label !== row.debit) return original;
            sameOwner = sameOwner && original === budget;
            // Explicit artificial lower-capacity/restoration lens. The extra real
            // primitive is NOT another request owner or a certificate. Only its
            // chosen debit is checked at a stricter ceiling; the owner usage and
            // full independently fixed suffix capacity are never reset/refunded.
            const lens = direct ? undefined : createBudgetContext({ now: () => 0, limits: { [key]: row.cost[k] + delta } });
            return { ...original,
              reserve(c) { attempted++; lens?.reserve(c); original.reserve(c); admitted++; },
              reserveString(n) { attempted++; lens?.reserveString(n); original.reserveString(n); admitted++; },
              spend(n = 1) { attempted++; lens?.spend(n); original.spend(n); admitted++; },
            };
          },
          r1Frame(_value: unknown, depth: number) {
            if (active && predecessor && row.consumer === 'frame' && depth === 1) {
              nativeUsage = usage(budget).map((n, i) => n - before[i]) as Vector; hit();
            }
            if (active && inGroup && row.consumer === 'child frame' && depth === 3) { nativeUsage = usage(budget).map((n, i) => n - before[i]) as Vector; hit(); }
          },
          r1Length(result: number) { if (active && inGroup && row.consumer === 'source length') hit(); return result; },
          r1Read(value: object, input: unknown, kind: string) {
            return new Proxy(value, { get(target, property, receiver) {
              const result = Reflect.get(target, property, receiver); // actual read first
              if (active && inGroup && row.consumer === kind && (kind === 'index' ? property === String(selected) : input === selected)) hit();
              return result;
            } });
          },
          String(v: unknown) {
            const result = String(v);
            if (active && row.consumer === 'String') { nativeUsage = usage(budget).map((n, i) => n - before[i]) as Vector; hit(); }
            return result;
          },
        });
        const root = (entry.parseRegisteredBoundedJson as typeof graph.parseRegisteredBoundedJson)(fixture.json, budget);
        // Exact full-fixture headroom is independent of observed candidate charges.
        // Usage positions after decoder setup only; expected recipe is literal.
        for (const [i, dimension] of repairDimensions.entries()) {
          const remaining = budget.limits[dimension] - usage(budget)[i] - fixture.total[i];
          if (dimension === 'work') budget.spend(remaining); else budget.reserve({ [dimension]: remaining });
        }
        before = usage(budget);
        const join = Array.prototype.join, objectString = Object.prototype.toString;
        const weakGet = WeakMap.prototype.get, charCodeAt = String.prototype.charCodeAt, finite = Number.isFinite;
        Array.prototype.join = function(separator?: string) {
          const result = join.call(this, separator); // includes real slot reads, commas and leaf conversion
          const target = row.group === 'leaf' ? root : selected;
          if (active && predecessor && row.consumer === 'join' && this === target) {
            nativeUsage = usage(budget).map((n, i) => n - before[i]) as Vector; hit();
          }
          return result;
        };
        Object.prototype.toString = function() {
          const result = objectString.call(this);
          if (active && predecessor && row.consumer === 'record' && this === selected) { nativeUsage = usage(budget).map((n, i) => n - before[i]) as Vector; hit(); }
          return result;
        };
        WeakMap.prototype.get = function(value: object) {
          const result = weakGet.call(this, value);
          if (active && inGroup && row.consumer === 'owner' && value === selected) { nativeUsage = usage(budget).map((n, i) => n - before[i]) as Vector; hit(); }
          return result;
        };
        String.prototype.charCodeAt = function(index: number) {
          const result = charCodeAt.call(this, index);
          if (active && inGroup && row.consumer === 'scan' && this.valueOf() === selected) { nativeUsage = usage(budget).map((n, i) => n - before[i]) as Vector; hit(); }
          return result;
        };
        Number.isFinite = function(value: unknown) {
          const result = finite(value);
          if (active && inGroup && row.consumer === 'finite' && value === selected) hit();
          return result;
        };
        let error: unknown; active = true;
        try { entry.stringBoundedJsonExact(root, budget); } catch (e) { error = e; }
        finally { active = false; Array.prototype.join = join; Object.prototype.toString = objectString; WeakMap.prototype.get = weakGet; String.prototype.charCodeAt = charCodeAt; Number.isFinite = finite; }
        expect(predecessor, 'independent predecessor').toBe(1);
        expect(sameOwner, 'all original charges retain actual graph owner').toBe(true);
        if (delta < 0) {
          expect(consumers, 'zero actual consumer entries at shortage').toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
          expect(attempted, 'real reservation/spend primitive attempted').toBe(1); expect(admitted).toBe(0);
        }
        else {
          expect(consumers, 'one actual consumer entry at exact/+1').toBe(1); expect(error).toBe(stop);
          expect(admitted, 'selected real debit executed').toBe(1);
          // Complete ordered prefix at an early consumer, complete literal L at
          // native consumers. All values below are independently source-derived.
          const prefixes: Record<string, Vector[]> = {
            frame: [[66, 1036, 0, 16512, 3]],
            'child frame': [[68, 1040, 0, 16560, 24], [73, 1041, 64, 16748, 43], [78, 1042, 128, 16936, 62]],
            scan: [[68, 1039, 0, 16558, 19], [69, 1039, 0, 16576, 24], [70, 1039, 0, 16594, 29]],
            owner: [[67, 1039, 0, 16540, 17], [72, 1040, 64, 16728, 36], [77, 1041, 128, 16916, 55]],
          };
          if (nativeUsage) expect(nativeUsage, 'literal suffix headroom at real consumer').toEqual(prefixes[row.consumer]?.[position] ?? fixture.total);
        }
      });
    }
  }
});
