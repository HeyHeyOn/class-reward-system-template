import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertNormalizationInput, canonicalJson, clonePlainData } from './validators';
import { parseRegisteredBoundedJson, canonicalBoundedJson, cloneFreezeBoundedJson } from '@/lib/boundedJson';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext } from '@/lib/boundedWork';

import * as boundedJson from '@/lib/boundedJson';
import * as boundedWork from '@/lib/boundedWork';
import * as validators from './validators';
import { stableRowHash } from './sheetsSnapshot';
import { deepFreeze, isSensitiveTabName } from './sensitiveRedaction';
const validatorGolden = JSON.parse(readFileSync(resolve(process.cwd(), 'src/server/migration/__fixtures__/validator-budget-golden.json'), 'utf8')) as {
  strings: { value: string; hash: string }[]; ids: { parts: string[]; id: string }[];
  names: { value: string; sensitive: boolean }[]; row: { cells: string[]; hash: string };
  inputs: { value: unknown; bytes: string }[];
};

const budget = (limits = {}) => createBudgetContext({ now: () => 0, limits });
afterEach(() => vi.restoreAllMocks());

describe('registered immutable graph foundation (NOT bounded normalization)', () => {
  it('guards the structural validator object entrypoint before enumeration', () => {
    const keys = vi.spyOn(Reflect, 'ownKeys');
    expect(() => assertNormalizationInput({}, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(keys).not.toHaveBeenCalled();
  });
  it('charges structural validation work and propagates exhaustion without enumeration', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson('{"a":[1,2]}', b);
    assertNormalizationInput(value, b);
    b.spend(b.limits.work - b.usage().work);
    const keys = vi.spyOn(Reflect, 'ownKeys');
    expect(() => assertNormalizationInput(value, b)).toThrow(BudgetExceededError);
    expect(keys).not.toHaveBeenCalled();
  });
  it('rejects unregistered objects before ownKeys or getter invocation', () => {
    const getter = vi.fn(() => 'private');
    const value = Object.defineProperty({}, 'x', { enumerable: true, get: getter });
    const ownKeys = vi.spyOn(Reflect, 'ownKeys');
    expect(() => canonicalBoundedJson(value, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(ownKeys).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects unregistered proxies without invoking traps', () => {
    const trap = vi.fn(() => { throw new Error('trap'); });
    const value = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, get: trap });
    expect(() => cloneFreezeBoundedJson(value, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(trap).not.toHaveBeenCalled();
  });
  it('registers and freezes the decoded graph, with private request ownership', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson('{"z":[{"a":1}]}', b) as { z: object[] };
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.z)).toBe(true);
    expect(Object.isFrozen(value.z[0])).toBe(true);
    expect(() => canonicalBoundedJson(value, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(canonicalBoundedJson(value, b)).toBe('{"z":[{"a":1}]}');
  });
  it.each(['__proto__', 'constructor', 'prototype'])('rejects poison property %s', (key) => {
    expect(() => parseRegisteredBoundedJson(`{"${key}":1}`, budget())).toThrow('Legacy bounded JSON is invalid.');
  });
  it('rejects nonfinite native numbers', () => {
    expect(() => parseRegisteredBoundedJson('1e999', budget())).toThrow('Legacy bounded JSON is invalid.');
  });
  it('reserves native array index-key payloads before ownKeys materializes them', () => {
    const b = budget();
    const ownKeys = Reflect.ownKeys;
    const observed: number[] = [];
    vi.spyOn(Reflect, 'ownKeys').mockImplementation((value) => {
      if (Array.isArray(value)) observed.push(b.usage().contentBytes);
      return ownKeys(value);
    });
    parseRegisteredBoundedJson('[0,1,2]', b);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeGreaterThanOrEqual(3 * 32);
  });
  it('reserves descriptor/key scratch before enumeration', () => {
    // Native parse fits; the subsequent scratch must not be allocated.
    const b = budget({ slots: 131 });
    const keys = vi.spyOn(Reflect, 'ownKeys');
    expect(() => parseRegisteredBoundedJson('{"a":1,"b":2,"c":3}', b)).toThrow(BudgetExceededError);
    expect(keys).not.toHaveBeenCalled();
  });
  it('rejects a replaced native parser result before getter invocation', () => {
    const getter = vi.fn(() => 1);
    vi.spyOn(JSON, 'parse').mockReturnValue(Object.defineProperty({}, 'a', { get: getter, enumerable: true }));
    expect(() => parseRegisteredBoundedJson('{"a":1}', budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects native parser exotic prototypes', () => {
    vi.spyOn(JSON, 'parse').mockReturnValue(Object.create({ x: 1 }));
    expect(() => parseRegisteredBoundedJson('{}', budget())).toThrow('Legacy bounded JSON is invalid.');
  });
  it('matches scalar escaping, code-unit key ordering and duplicate last-key wins', () => {
    const text = '{"z":-0,"10":true,"2":null,"a":"\\u0000\\b\\t\\n\\f\\r\\\"\\\\한😀\\ud800\\udfff","z":2,"😀":0,"\ue000":1}';
    const b = budget();
    const value = parseRegisteredBoundedJson(text, b);
    expect(canonicalBoundedJson(value, b)).toBe(canonicalJson(JSON.parse(text)));
  });
  it.each([63, 64])('accepts root-inclusive depth %i', (depth) => {
    const b = budget();
    const text = '['.repeat(depth - 1) + '0' + ']'.repeat(depth - 1);
    expect(canonicalBoundedJson(parseRegisteredBoundedJson(text, b), b)).toBe(text);
  });
  it('checks complete output cap even for a scalar root', () => {
    const b = budget({ depth: 1 });
    expect(() => canonicalBoundedJson('ok', b, 3)).toThrow(BudgetExceededError);
  });
  it.each([524_288, 8_000_000])('enforces exact complete canonical byte cap %i before allocation', (cap) => {
    // Escaping expands a legal <=4MB decoded scalar beyond the 8MB writer cap.
    const text = JSON.stringify('\u0000'.repeat(Math.floor((cap - 2) / 6)) + 'x'.repeat((cap - 2) % 6));
    const b = budget();
    const value = parseRegisteredBoundedJson(text, b);
    const allocate = vi.spyOn(globalThis, 'Uint8Array');
    expect(() => canonicalBoundedJson(value, b, cap - 1)).toThrow(BudgetExceededError);
    expect(allocate).not.toHaveBeenCalled();
    allocate.mockRestore();
    expect(Buffer.byteLength(canonicalBoundedJson(value, b, cap))).toBe(cap);
  });
  it('reserves both buffer and decoded output copy before constructing either', () => {
    const b = budget({ contentBytes: 10 });
    const value = parseRegisteredBoundedJson('"abcd"', b);
    const allocate = vi.spyOn(globalThis, 'Uint8Array');
    expect(() => canonicalBoundedJson(value, b)).toThrow(BudgetExceededError);
    expect(allocate).not.toHaveBeenCalled();
  });
  it('pre-reserves clone work and creates a detached frozen registered clone', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson('{"a":[1,{"b":"c"}]}', b) as { a: unknown[] };
    const copy = cloneFreezeBoundedJson(value, b);
    expect(copy).toEqual(clonePlainData(value));
    expect(copy).not.toBe(value);
    expect(copy.a).not.toBe(value.a);
    expect(Object.getPrototypeOf(copy)).toBe(null);
    expect(Object.isFrozen(copy.a[1])).toBe(true);
    expect(canonicalBoundedJson(copy, b)).toBe(canonicalJson(value));
  });
  it('rejects clone overflow before creating a derived object', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson('{"a":[]}', b);
    b.reserve({ nodes: b.limits.nodes - b.usage().nodes });
    const create = vi.spyOn(Object, 'create');
    expect(() => cloneFreezeBoundedJson(value, b)).toThrow(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });
  it('uses the validator canonical optional seam without callback-index leakage', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson('[1,{"z":2,"a":3}]', b);
    expect(canonicalJson(value, b)).toBe('[1,{"a":3,"z":2}]');
    expect(canonicalJson([1, { z: 2, a: 3 }])).toBe('[1,{"a":3,"z":2}]');
    expect(() => canonicalJson({}, b)).toThrow('Legacy bounded JSON is invalid.');
  });
  it('matches every UTF-16 code unit and surrogate lookahead across a scan block', () => {
    const text = 'a'.repeat(255) + '😀' + Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i)).join('');
    expect(canonicalBoundedJson(text, budget())).toBe(JSON.stringify(text));
  });
  it.each([0, -0, Number.MIN_VALUE, -Number.MAX_VALUE, 1e21, 1e-7])('matches finite numeric formatting %s', (value) => {
    expect(canonicalBoundedJson(value, budget())).toBe(JSON.stringify(value));
  });
  it.each([524_288, 8_000_000])('accepts cap-1 and refuses cap+1 complete bytes for %i', (cap) => {
    const value = '\u0000'.repeat(Math.floor((cap - 3) / 6)) + 'x'.repeat((cap - 3) % 6);
    expect(Buffer.byteLength(canonicalBoundedJson(value, budget(), cap))).toBe(cap - 1);
    expect(() => canonicalBoundedJson(value + 'xx', budget(), cap)).toThrow(BudgetExceededError);
  });
  it('rejects depth 65 before native parse and permits no stale certificate mutation', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => parseRegisteredBoundedJson('['.repeat(64) + '0' + ']'.repeat(64), budget())).toThrow(BudgetExceededError);
    expect(parse).not.toHaveBeenCalled();
    const b = budget();
    const root = parseRegisteredBoundedJson('{"a":1}', b) as object;
    expect(Reflect.defineProperty(root, 'b', { get: () => 2 })).toBe(false);
    expect(Reflect.setPrototypeOf(root, { b: 2 })).toBe(false);
    expect(canonicalBoundedJson(root, b)).toBe('{"a":1}');
  });
  it('propagates native budget failures and rejects late decoded output', () => {
    const error = new BudgetUnavailableError();
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw error; });
    expect(() => parseRegisteredBoundedJson('{}', budget())).toThrow(error);
    parse.mockRestore();
    let now = 0;
    const b = createBudgetContext({ now: () => now });
    const decode = TextDecoder.prototype.decode;
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (this: TextDecoder, input, options) {
      now = 5000;
      return decode.call(this, input, options);
    });
    expect(() => canonicalBoundedJson('ok', b)).toThrow(BudgetUnavailableError);
  });
  it('shares cumulative accounting across two admitted acquisition envelopes', () => {
    const raw = readFileSync(resolve('src/server/migration/__fixtures__/normalization-budget-golden.json'), 'utf8');
    const golden = JSON.parse(raw) as { results: { input: unknown }[] };
    const b = budget();
    for (const row of golden.results.slice(0, 2)) {
      const prior = b.usage();
      const value = parseRegisteredBoundedJson(JSON.stringify(row.input), b);
      assertNormalizationInput(value, b);
      expect(canonicalJson(value, b)).toBe(canonicalJson(row.input));
      expect(b.usage().nodes).toBeGreaterThan(prior.nodes);
      expect(b.usage().contentBytes).toBeGreaterThan(prior.contentBytes);
      expect(b.usage().work).toBeGreaterThan(prior.work);
    }
    b.spend(b.limits.work - b.usage().work);
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => parseRegisteredBoundedJson('{}', b)).toThrow(BudgetExceededError);
    expect(parse).not.toHaveBeenCalled();
  });
  it('pins actual frozen HEAD preparation oracle bytes independently', () => {
    const raw = readFileSync(resolve('src/server/migration/__fixtures__/preparation-budget-golden.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe('550aacc7b282f4de0f2e480dce7cc1d6fe645171944173c87e50c3fd758f0702');
  });
  it('pins admitted helper bytes and hashes to all six immutable HEAD manifest goldens', () => {
    const raw = readFileSync(resolve('src/server/migration/__fixtures__/normalization-budget-golden.json'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe('4e1d3373da7297819c2b20850b37d36c67b33d3ef981519d0a0a89c7e54d2487');
    const golden = JSON.parse(raw.toString()) as { results: { bytes: string }[] };
    for (const row of golden.results) {
      const b = budget();
      const admitted = parseRegisteredBoundedJson(row.bytes, b);
      expect(canonicalJson(admitted, b)).toBe(row.bytes);
      expect(canonicalJson(cloneFreezeBoundedJson(admitted, b), b)).toBe(row.bytes);
    }
  });
});


describe('derived graph recipes and mutable clone seams', () => {
  const sourceText = '{"snapshotVersion":1,"capturedAt":"now","sourceRevision":"r","v2Claims":[],"operationBindings":[],"v1Tombstones":[],"orphanedClaimDigests":[],"digest":"excluded"}';
  it('reserves the exact schema before invoking lazy source operands', () => {
    const operand = vi.fn(() => ({}));
    expect(() => boundedJson.createBoundedProjection('redisArtifact', operand, budget({ slots: 0 }))).toThrow(BudgetExceededError);
    expect(operand).not.toHaveBeenCalled();
  });
  it('registers a fixed-schema immutable projection without ownKeys', () => {
    const b = budget();
    const source = parseRegisteredBoundedJson(sourceText, b);
    const keys = vi.spyOn(Reflect, 'ownKeys');
    const result = boundedJson.createBoundedProjection('redisArtifact', () => source, b);
    expect(keys).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(canonicalJson(result, b)).toBe('{"capturedAt":"now","operationBindings":[],"orphanedClaimDigests":[],"snapshotVersion":1,"sourceRevision":"r","v1Tombstones":[],"v2Claims":[]}');
    expect(() => canonicalJson(result, budget())).toThrow('Legacy bounded JSON is invalid.');
  });
  it('does not grant a certificate to an unregistered or foreign operand', () => {
    const trap = vi.fn();
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    expect(() => boundedJson.createBoundedProjection('redisArtifact', () => proxy, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(trap).not.toHaveBeenCalled();
    const source = parseRegisteredBoundedJson(sourceText, budget());
    expect(() => boundedJson.createBoundedProjection('redisArtifact', () => source, budget())).toThrow('Legacy bounded JSON is invalid.');
  });
  it('returns a mutable detached clone without minting a stale certificate', () => {
    const b = budget();
    const source = parseRegisteredBoundedJson('{"a":[{"b":1}]}', b) as { a: { b: number }[] };
    const result = clonePlainData(source, b);
    expect(result).not.toBe(source);
    expect(result.a).not.toBe(source.a);
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(Object.isFrozen(result.a[0])).toBe(false);
    result.a[0].b = 2;
    expect(source.a[0].b).toBe(1);
    expect(() => canonicalJson(result, b)).toThrow('Legacy bounded JSON is invalid.');
  });
  it('refuses mutable cloning before native container allocation on exhausted budget', () => {
    const b = budget();
    const source = parseRegisteredBoundedJson('{"a":1}', b);
    b.reserve({ nodes: b.limits.nodes - b.usage().nodes });
    const create = vi.spyOn(Object, 'create');
    expect(() => clonePlainData(source, b)).toThrow(BudgetExceededError);
    expect(create).not.toHaveBeenCalled();
  });
});


describe('validator helper budgets and frozen HEAD parity', () => {
  it('refuses sha256 before native hash update when work is exhausted', () => {
    expect(() => validators.sha256('abc', budget({ work: 0 }))).toThrow(BudgetExceededError);
  });
  it('reserves the fixed digest payload before producing it', () => {
    expect(() => validators.sha256('abc', budget({ contentBytes: 63 }))).toThrow(BudgetExceededError);
    expect(validators.sha256('abc', budget({ contentBytes: 64 }))).toBe(validators.sha256('abc'));
  });
  it('preserves rest arguments through a distinct budgeted deterministic ID API', () => {
    expect(() => validators.deterministicIdWithBudget(budget({ work: 0 }), 'abc')).toThrow(BudgetExceededError);
    for (const item of validatorGolden.ids) {
      expect(validators.deterministicId(...item.parts)).toBe(item.id);
      expect(validators.deterministicIdWithBudget(budget(), ...item.parts)).toBe(item.id);
    }
  });
  it('preserves frozen hash and row bytes with budget on and off', () => {
    for (const item of validatorGolden.strings) {
      expect(validators.sha256(item.value)).toBe(item.hash);
      expect(validators.sha256(item.value, budget())).toBe(item.hash);
    }
    const b = budget();
    const cells = parseRegisteredBoundedJson(JSON.stringify(validatorGolden.row.cells), b) as string[];
    expect(stableRowHash(cells)).toBe(validatorGolden.row.hash);
    expect(stableRowHash(cells, b)).toBe(validatorGolden.row.hash);
  });
  it('rejects a row hash unregistered array before spread or iteration', () => {
    const iterator = vi.fn(() => { throw new Error('iterator'); });
    const cells: string[] = [];
    cells[Symbol.iterator] = iterator;
    expect(() => stableRowHash(cells, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(iterator).not.toHaveBeenCalled();
  });
  it('charges deepFreeze without enumerating unregistered objects', () => {
    const trap = vi.fn();
    const input = new Proxy({}, { ownKeys: trap, preventExtensions: trap });
    expect(() => deepFreeze(input, budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(trap).not.toHaveBeenCalled();
  });
  it('retains same-object deepFreeze identity and propagates budget failure', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson('{"a":[1]}', b);
    expect(deepFreeze(value, b)).toBe(value);
    b.spend(b.limits.work-b.usage().work);
    expect(() => deepFreeze(value, b)).toThrow(BudgetExceededError);
  });
  it('refuses sensitive-name transformations before native replace on exhausted content', () => {
    const replace = vi.spyOn(String.prototype, 'replace');
    expect(() => isSensitiveTabName('secret', budget({ contentBytes: 0 }))).toThrow(BudgetExceededError);
    expect(replace).not.toHaveBeenCalled();
  });
  it('retains classifier policy for frozen names with budget on and off', () => {
    for (const item of validatorGolden.names) {
      expect(isSensitiveTabName(item.value)).toBe(item.sensitive);
      expect(isSensitiveTabName(item.value, budget())).toBe(item.sensitive);
    }
  });
});


describe('complete snapshot business validator seam (not normalization)', () => {
  it('rejects unregistered inputs before prototype/key traps', () => {
    const trap = vi.fn();
    expect(() => validators.assertManifestInputShape(new Proxy({}, { getPrototypeOf: trap, ownKeys: trap }), budget())).toThrow('Legacy bounded JSON is invalid.');
    expect(trap).not.toHaveBeenCalled();
  });
  it('uses registered keys instead of native object enumeration through real validation', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson(validatorGolden.inputs[0].bytes, b);
    const keys = vi.spyOn(Object, 'keys');
    validators.assertManifestInputShape(value, b);
    expect(keys).not.toHaveBeenCalled();
  });
  it('charges the complete Sheets and Redis business path, not only root admission', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson(validatorGolden.inputs[0].bytes, b);
    validators.assertNormalizationInput(value, b);
    const structuralWork = b.usage().work;
    validators.assertNormalizationInput(value, b);
    const structuralCost = b.usage().work - structuralWork;
    const before = b.usage();
    validators.assertManifestInputShape(value, b);
    expect(b.usage().work-before.work).toBeGreaterThan(structuralCost);
    expect(b.usage().contentBytes-before.contentBytes).toBeGreaterThan(128);
  });
  it('preserves all frozen schema-version validation positives in one cumulative request', () => {
    const b = budget();
    for (const item of validatorGolden.inputs) {
      validators.assertManifestInputShape(item.value);
      const value = parseRegisteredBoundedJson(item.bytes, b);
      validators.assertManifestInputShape(value, b);
      expect(canonicalJson(value, b)).toBe(item.bytes);
    }
  });
  it('propagates work exhaustion instead of treating it as invalid business data', () => {
    const b = budget();
    const value = parseRegisteredBoundedJson(validatorGolden.inputs[0].bytes, b);
    b.spend(b.limits.work-b.usage().work);
    expect(() => validators.assertManifestInputShape(value, b)).toThrow(BudgetExceededError);
  });
});


describe('general lazy collections and string recipes', () => {
  it('reserves Map insertion before evaluating a lazy derived value', () => {
    const value = vi.fn(() => 'new'); const map = new Map<string, string>();
    expect(() => boundedWork.setBudgetMap(map, 'k', value, budget({ slots: 1 }))).toThrow(BudgetExceededError);
    expect(value).not.toHaveBeenCalled(); expect(map.size).toBe(0);
  });
  it('does not allocate entry slots for Map replacement or duplicate Set values', () => {
    const b = budget({ slots: 3 }); const map = new Map<string, string>(); const set = new Set<string>();
    boundedWork.setBudgetMap(map, 'k', () => 'one', b);
    boundedWork.setBudgetMap(map, 'k', () => 'two', b);
    boundedWork.addBudgetSet(set, 'v', b); boundedWork.addBudgetSet(set, 'v', b);
    expect(map.get('k')).toBe('two'); expect(b.usage().slots).toBe(3);
    expect(() => boundedWork.addBudgetSet(set, 'w', b)).toThrow(BudgetExceededError);
    expect(set.has('w')).toBe(false);
  });
  it('reserves a list slot before invoking the element factory', () => {
    const value = vi.fn(() => 'new'); const list: string[] = [];
    expect(() => boundedWork.appendBudgetList(list, value, budget({ slots: 0 }))).toThrow(BudgetExceededError);
    expect(value).not.toHaveBeenCalled(); expect(list).toEqual([]);
    boundedWork.appendBudgetList(list, value, budget()); expect(list).toEqual(['new']);
  });
  it('preflights delimiter count before native split with empty-item/order parity', () => {
    const split = vi.spyOn(String.prototype, 'split');
    expect(() => boundedWork.splitBudgetString('a,,한', ',', budget({ slots: 2 }))).toThrow(BudgetExceededError);
    expect(split).not.toHaveBeenCalled();
    expect(boundedWork.splitBudgetString('a,,한', ',', budget({ slots: 3 }))).toEqual(['a', '', '한']);
  });
});


const validatorCases = JSON.parse(readFileSync(resolve(process.cwd(), 'src/server/migration/__fixtures__/validator-budget-cases.json'), 'utf8')) as { name: string; input: unknown; error: string | null }[];
describe('frozen business-shape and Settings/Redis edge parity', () => {
  it.each(validatorCases)('$name matches frozen error or acceptance with budget on/off', ({ input, error }) => {
    const b = budget(); const registered = parseRegisteredBoundedJson(JSON.stringify(input), b);
    if (error === null) {
      expect(() => validators.assertManifestInputShape(input)).not.toThrow();
      expect(() => validators.assertManifestInputShape(registered, b)).not.toThrow();
    } else {
      expect(() => validators.assertManifestInputShape(input)).toThrow(error);
      expect(() => validators.assertManifestInputShape(registered, b)).toThrow(error);
    }
  });
  it('precharges EACH UUID regexp, not just structural admission', () => {
    const b = budget(); const input = parseRegisteredBoundedJson(validatorGolden.inputs[0].bytes, b);
    const original = RegExp.prototype.test; let uuidCalls = 0;
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, value: string) {
      if (this.source.startsWith('^[0-9a-f]{8}')) {
        uuidCalls++;
        if (uuidCalls === 1) b.spend(b.limits.work - b.usage().work);
      }
      return original.call(this, value);
    });
    expect(() => validators.assertManifestInputShape(input, b)).toThrow(BudgetExceededError);
    expect(uuidCalls).toBe(1);
  });
  it('discards a deterministic ID if the final native slicing crosses the deadline', () => {
    let now = 0; const b = createBudgetContext({ now: () => now });
    const original = String.prototype.slice;
    vi.spyOn(String.prototype, 'slice').mockImplementation(function (this: string, start?: number, end?: number) {
      if (this.length === 64) now = 5_000;
      return original.call(this, start, end);
    });
    expect(() => validators.deterministicIdWithBudget(b, 'one')).toThrow(BudgetUnavailableError);
  });
});


describe('normalizer-facing scalar validator leaves', () => {
  it('charges ID trimming before creating a copy', () => {
    expect(() => validators.canonicalId('value', budget({ contentBytes: 0 }))).toThrow(BudgetExceededError);
  });
  it('charges integer and decimal parsing before native conversion', () => {
    expect(() => validators.safeInteger('42', {}, budget({ work: 0 }))).toThrow(BudgetExceededError);
    expect(() => validators.finiteNumber('4.2', 0, 10, budget({ work: 0 }))).toThrow(BudgetExceededError);
  });
  it('propagates scalar boolean/date work exhaustion', () => {
    expect(() => validators.strictBoolean('TRUE', budget({ work: 0 }))).toThrow(BudgetExceededError);
    expect(() => validators.canonicalInstant('2026-09-01T00:00:00.000Z', budget({ work: 0 }))).toThrow(BudgetExceededError);
  });
  it.each(['', '0', '-0', '0042', '42', '-42', '4.2', ' 42', 'NaN', 'Infinity', '한', undefined])('preserves scalar acceptance for %s', (value) => {
    expect(validators.canonicalId(value, budget())).toBe(validators.canonicalId(value));
    expect(validators.safeInteger(value, {}, budget())).toBe(validators.safeInteger(value));
    expect(validators.finiteNumber(value, -100, 100, budget())).toBe(validators.finiteNumber(value, -100, 100));
    expect(validators.strictBoolean(value, budget())).toBe(validators.strictBoolean(value));
    expect(validators.canonicalInstant(value, budget())).toBe(validators.canonicalInstant(value));
  });
});


it('charges the exported digest predicate before native regexp work', () => {
  expect(() => validators.isHexDigest('a'.repeat(64), budget({ work: 0 }))).toThrow(BudgetExceededError);
});

it.each([12, 13, 14])('uses the exact fixed redis projection slot recipe at %i available slots', (available) => {
  const b = budget();
  const source = parseRegisteredBoundedJson('{"capturedAt":"x","operationBindings":[],"orphanedClaimDigests":[],"snapshotVersion":1,"sourceRevision":"r","v1Tombstones":[],"v2Claims":[]}', b);
  b.reserve({ slots: b.limits.slots - b.usage().slots - available });
  const operand = vi.fn(() => source);
  if (available < 7 + 6) {
    expect(() => boundedJson.createBoundedProjection('redisArtifact', operand, b)).toThrow(BudgetExceededError);
    expect(operand).not.toHaveBeenCalled();
  } else {
    const before = b.usage().slots;
    expect(Object.isFrozen(boundedJson.createBoundedProjection('redisArtifact', operand, b))).toBe(true);
    expect(b.usage().slots - before).toBe(7 + 6);
  }
});


it('reserves Date.parse scalar output before entering the native boundary', () => {
  const parse = vi.spyOn(Date, 'parse');
  expect(() => validators.canonicalInstant('2026-09-01T00:00:00.000Z', budget({ nodes: 0 }))).toThrow(BudgetExceededError);
  expect(parse).not.toHaveBeenCalled();
});

it('charges sensitive-word hash lookup by input blocks before every native Set lookup', () => {
  const base = budget(); let lastSpend = 0;
  const b = { ...base, spend(amount = 1) { lastSpend = amount; base.spend(amount); } };
  const word = 'x'.repeat(512), observed: number[] = [];
  const has = Set.prototype.has;
  vi.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value: unknown) {
    if (value === word) observed.push(lastSpend);
    return has.call(this, value);
  });
  expect(isSensitiveTabName(word, b)).toBe(false);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((amount) => amount >= 1 + Math.ceil(word.length / 256))).toBe(true);
});


it('charges the lazy Map value callback independently of has/set operations', () => {
  const value = vi.fn(() => 'new');
  expect(() => boundedWork.setBudgetMap(new Map(), '', value, budget({ work: 2 }))).toThrow(BudgetExceededError);
  expect(value).not.toHaveBeenCalled();
});

it('reserves explicit Redis Map iterator objects before constructing them', () => {
  const base = budget(); let lastReservation: boundedWork.Allocation = {};
  const b = { ...base, reserve(cost: boundedWork.Allocation) { lastReservation = cost; base.reserve(cost); } };
  const input = parseRegisteredBoundedJson(validatorGolden.inputs[0].bytes, b);
  const values = Map.prototype.values; const observed: boundedWork.Allocation[] = [];
  vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
    observed.push(lastReservation); return values.call(this);
  });
  validators.assertManifestInputShape(input, b);
  expect(observed).toHaveLength(1);
  expect(observed[0].nodes).toBeGreaterThanOrEqual(1);
  expect(observed[0].structuralBytes).toBeGreaterThanOrEqual(16);
});
