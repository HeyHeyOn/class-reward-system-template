import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, createBudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import { createNormalizationOutput, type NormalizationOutput } from './normalizationOutput';
import * as outputModule from './normalizationOutput';
import { normalizeLegacySnapshots as run } from './normalize';

const limits = { target: 4_000, sourceRecord: 4_000, mapping: 8_000, conflict: 8_000, errorCode: 8_000 } as const;
type Kind = keyof typeof limits;
function emit(output: ReturnType<typeof createNormalizationOutput>, kind: Kind, list: number[], factory: () => number) {
  if (kind === 'sourceRecord') output.sourceRecord(list, false, factory);
  else output[kind](list, factory);
}

describe('internal production output emissions, not intermediate payload recipes', () => {
  for (const kind of Object.keys(limits) as Kind[]) for (const delta of [-1, 0, 1]) {
    it(`${kind}: inclusive ${limits[kind]} at delta ${delta}, before factory and append`, () => {
      const budget = createBudgetContext({ now: () => 0 }), output = createNormalizationOutput(budget), list: number[] = [];
      const count = limits[kind] + delta, factory = vi.fn(() => 7);
      const execute = () => { for (let i = 0; i < count; i++) emit(output, kind, list, factory); };
      if (delta > 0) expect(execute).toThrow(BudgetExceededError); else execute();
      expect(list).toHaveLength(Math.min(count, limits[kind]));
      expect(factory).toHaveBeenCalledTimes(Math.min(count, limits[kind]));
      expect(budget.usage().slots).toBe(list.length);
      expect(budget.usage().structuralBytes).toBe(4 * list.length);
    });
  }
  for (const delta of [-1, 0, 1]) it(`quarantine + conflict + error-code aggregate delta ${delta}`, () => {
    const budget = createBudgetContext({ now: () => 0 }), output = createNormalizationOutput(budget), sources: number[] = [], conflicts: number[] = [], errors: number[] = [];
    for (let i = 0; i < 2_000; i++) output.sourceRecord(sources, true, () => i);
    for (let i = 0; i < 3_000; i++) output.errorCode(errors, () => i);
    const factory = vi.fn(() => 0), execute = () => { for (let i = 0; i < 3_000 + delta; i++) output.conflict(conflicts, factory); };
    if (delta > 0) expect(execute).toThrow(BudgetExceededError); else execute();
    expect(factory).toHaveBeenCalledTimes(Math.min(3_000 + delta, 3_000));
    expect(conflicts).toHaveLength(Math.min(3_000 + delta, 3_000));
  });
  it('all categories can simultaneously reach their independent ceilings', () => {
    const output = createNormalizationOutput(createBudgetContext({ now: () => 0 })), list: number[] = [];
    for (const kind of ['target', 'sourceRecord', 'mapping', 'conflict'] as const) {
      for (let i = 0; i < limits[kind]; i++) emit(output, kind, list, () => 1);
    }
    expect(list).toHaveLength(24_000);
    for (const kind of Object.keys(limits) as Kind[]) expect(() => emit(output, kind, list, () => { throw new Error('factory reached'); })).toThrow(BudgetExceededError);
  });
  it('quarantine shares diagnostics but is not counted again as an error-code flag', () => {
    const output = createNormalizationOutput(createBudgetContext({ now: () => 0 })), list: number[] = [];
    for (let i = 0; i < 8_000; i++) output.errorCode(list, () => i);
    const factory = vi.fn(() => 0);
    expect(() => output.sourceRecord(list, true, factory)).toThrow(BudgetExceededError);
    expect(factory).not.toHaveBeenCalled();
    output.sourceRecord(list, false, factory);
    expect(factory).toHaveBeenCalledOnce();
  });
  it('new invocation resets only categories, never request allocation/work counters', () => {
    const budget = createBudgetContext({ now: () => 0 }), list: number[] = [];
    for (let invocation = 1; invocation <= 2; invocation++) {
      const output = createNormalizationOutput(budget);
      for (let i = 0; i < 4_000; i++) output.target(list, () => i);
      expect(budget.usage().slots).toBe(4_000 * invocation);
      expect(budget.usage().structuralBytes).toBe(16_000 * invocation);
      expect(budget.usage().work).toBe(4_000 * invocation);
      expect(() => output.target(list, () => 0)).toThrow(BudgetExceededError);
    }
  });
  it('reserves the actual destination before calling a factory', () => {
    const budget = createBudgetContext({ now: () => 0, limits: { slots: 0 } }), output = createNormalizationOutput(budget), factory = vi.fn(() => 1), list: number[] = [];
    expect(() => output.mapping(list, factory)).toThrow(BudgetExceededError);
    expect(factory).not.toHaveBeenCalled(); expect(list).toEqual([]);
  });
  for (const kind of Object.keys(limits) as Kind[]) it(`no-budget ${kind} has no category ceiling`, () => {
    const output = createNormalizationOutput(), list: number[] = [];
    for (let i = 0; i <= limits[kind]; i++) emit(output, kind, list, () => i);
    expect(list).toHaveLength(limits[kind] + 1);
  });
});

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/normalizer-rows-budget-golden.json', 'utf8')) as {
  cases: { name: string; input: Input; outcome: { json?: string; error?: { name: string; message: string } } }[];
};
describe('actual normalizer frozen Git bytes, IDs, defaults, order and mutable outputs', () => {
  for (const enabled of [false, true]) it.each(golden.cases)(`original Git parity budget=${enabled}: $name`, (f) => {
    const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = budget ? parseRegisteredBoundedJson(JSON.stringify(f.input), budget) as Input : JSON.parse(JSON.stringify(f.input)) as Input;
    if (f.outcome.error) {
      try { run(input, budget); expect.fail('expected original error'); } catch (error) { expect({ name: (error as Error).name, message: (error as Error).message }).toEqual(f.outcome.error); }
    } else {
      const result = run(input, budget);
      expect(JSON.stringify(result)).toBe(f.outcome.json);
      expect(Object.getPrototypeOf(result.records)).toBe(null);
      expect(Object.isFrozen(result.sourceRecords)).toBe(false);
      if (result.sourceRecords[0]) expect(Object.isFrozen(result.sourceRecords[0].errorCodes)).toBe(false);
    }
  });
});


describe('real normalize routes every returned occurrence through the shared emitter', () => {
  const realCreate = createNormalizationOutput;
  it.each(golden.cases.filter((f) => f.outcome.json))('exact emission categories: $name', (f) => {
    const expected = JSON.parse(f.outcome.json!) as ReturnType<typeof run>;
    const budget = createBudgetContext({ now: () => 0 });
    const input = parseRegisteredBoundedJson(JSON.stringify(f.input), budget) as Input;
    const counts = { target: 0, sourceRecord: 0, mapping: 0, conflict: 0, errorCode: 0, quarantine: 0 };
    function observe(name: Exclude<Kind, 'sourceRecord'>, original: NormalizationOutput[typeof name]) {
      return <T,>(list: T[], factory: () => T): void => { counts[name]++; original(list, factory); };
    }
    const create = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation((context) => {
      expect(context).toBe(budget);
      const output = realCreate(context);
      return {
        target: observe('target', output.target), mapping: observe('mapping', output.mapping),
        conflict: observe('conflict', output.conflict), errorCode: observe('errorCode', output.errorCode),
        sourceRecord<T>(list: T[], quarantined: boolean, factory: () => T) {
          counts.sourceRecord++; if (quarantined) counts.quarantine++;
          output.sourceRecord(list, quarantined, factory);
        },
      };
    });
    let result: ReturnType<typeof run>;
    try { result = run(input, budget); expect(create).toHaveBeenCalledOnce(); } finally { create.mockRestore(); }
    expect(JSON.stringify(result)).toBe(f.outcome.json);
    expect(counts).toEqual({
      target: Object.values(expected.records).reduce((n, rows) => n + rows.length, 0),
      sourceRecord: expected.sourceRecords.length, mapping: expected.mappings.length,
      conflict: expected.blockingConflicts.length,
      errorCode: expected.sourceRecords.reduce((n, source) => n + source.errorCodes.length, 0),
      quarantine: expected.sourceRecords.filter((source) => source.mappingStatus === 'QUARANTINED').length,
    });
  });
  for (const kind of ['target', 'mapping', 'sourceRecord', 'conflict', 'errorCode', 'quarantine'] as const) {
    it(`real ${kind} boundary rejects before the next result factory/append`, () => {
      const budget = createBudgetContext({ now: () => 0 });
      const f = golden.cases.find((item) => item.name === (kind === 'errorCode' || kind === 'quarantine' ? 'promotion:INVALID' : kind === 'conflict' ? 'task-default' : 'supported-v1'))!;
      const input = parseRegisteredBoundedJson(JSON.stringify(f.input), budget) as Input;
      const output = realCreate(budget), scratch: number[] = [];
      if (kind === 'quarantine' || kind === 'errorCode') {
        for (let i = 0; i < (kind === 'errorCode' ? 7_999 : 8_000); i++) output.conflict(scratch, () => i);
      } else for (let i = 0; i < limits[kind]; i++) emit(output, kind, scratch, () => i);
      const method = kind === 'quarantine' ? 'sourceRecord' : kind;
      let factoryCalls = 0, reached = 0, destination: unknown[] | undefined, sizeBefore = -1;
      function observe<T>(list: T[], factory: () => T, original: () => void): void {
        reached++; destination = list; sizeBefore = list.length; void factory; original();
      }
      const wrapped: NormalizationOutput = { ...output };
      if (method === 'sourceRecord') wrapped.sourceRecord = <T,>(list: T[], quarantine: boolean, factory: () => T) => {
        observe(list, factory, () => output.sourceRecord(list, quarantine, () => { factoryCalls++; return factory(); }));
      };
      else wrapped[method] = <T,>(list: T[], factory: () => T) => {
        observe(list, factory, () => output[method](list, () => { factoryCalls++; return factory(); }));
      };
      const create = vi.spyOn(outputModule, 'createNormalizationOutput').mockReturnValue(wrapped);
      let error: unknown;
      try { run(input, budget); } catch (e) { error = e; } finally { create.mockRestore(); }
      expect(reached).toBe(1); expect(factoryCalls).toBe(0);
      expect(destination).toHaveLength(sizeBefore);
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect((error as Error).message).toBe('Legacy normalization budget exceeded.');
    });
  }
  it('actual new normalization gets new categories while request usage continues', () => {
    const budget = createBudgetContext({ now: () => 0 }), f = golden.cases[0];
    const input = parseRegisteredBoundedJson(JSON.stringify(f.input), budget) as Input;
    const instances: NormalizationOutput[] = [];
    const create = vi.spyOn(outputModule, 'createNormalizationOutput').mockImplementation((context) => {
      const instance = realCreate(context); instances.push(instance); return instance;
    });
    try {
      const before = budget.usage(), first = run(input, budget), middle = budget.usage(), second = run(input, budget), end = budget.usage();
      expect(instances).toHaveLength(2); expect(instances[0]).not.toBe(instances[1]);
      for (const key of ['nodes', 'slots', 'structuralBytes', 'contentBytes', 'work'] as const) expect(end[key] - middle[key]).toBe(middle[key] - before[key]);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      (first.sourceRecords[0].errorCodes as string[]).push('mutable');
      expect(second.sourceRecords[0].errorCodes).not.toContain('mutable');
    } finally { create.mockRestore(); }
  });
});


describe('uncapped legacy calls and the independent existing diagnostic safety guard', () => {
  // Byte-exact HEAD execution: normalizer-output-caps/edge-oracle.cjs/json.
  for (const [count, valid, hash, targetCount, diagnosticCount] of [
    [4_001, true, 'f72cf9d726e4af6c57b0305c094d2fa65b6419dc4c59a04087c854b4b5268c0c', 8_002, 2],
    [3_000, false, 'aaa23ef8ac0103b949639991deca81cfce9ccbdc7e1a9a63e9143900220c35bb', 0, 9_002],
  ] as const) it(`real no-budget ${count} rows valid=${valid} exceeds new categories without truncation`, () => {
    const original = golden.cases[0].input;
    const input: Input = { tenantId: original.tenantId, migrationJobId: original.migrationJobId, sheets: { ...original.sheets, tabs: {
      Students: { headers: ['studentId', 'name', 'balance', 'status'], rows: Array.from({ length: count }, (_, i) => ({ rowNumber: i + 2, hash: `row-${i}`, cells: [`S${i}`, 'Alice', valid ? '100' : 'invalid', 'ACTIVE'] })) },
    } } };
    const output = run(input);
    expect(createHash('sha256').update(JSON.stringify(output)).digest('hex')).toBe(hash);
    expect(Object.values(output.records).reduce((n, rows) => n + rows.length, 0)).toBe(targetCount);
    expect(output.sourceRecords).toHaveLength(count); expect(output.mappings).toHaveLength(targetCount);
    expect(output.blockingConflicts.length + output.sourceRecords.reduce((n, s) => n + s.errorCodes.length + (s.mappingStatus === 'QUARANTINED' ? 1 : 0), 0)).toBe(diagnosticCount);
  });
  for (const enabled of [false, true]) for (const delta of [-1, 0, 1]) it(`legacy raw warnings+conflicts guard remains 4096 budget=${enabled} delta=${delta}`, () => {
    const original = golden.cases[0].input;
    const plain: Input = { tenantId: original.tenantId, migrationJobId: original.migrationJobId, sheets: { ...original.sheets, tabs: { Unknown: { headers: Array<string>(4_094 + delta).fill(''), rows: [] } } } };
    const budget = enabled ? createBudgetContext({ now: () => 0 }) : undefined;
    const input = budget ? parseRegisteredBoundedJson(JSON.stringify(plain), budget) as Input : plain;
    if (delta > 0) {
      try { run(input, budget); expect.fail('expected legacy guard'); } catch (e) {
        expect(e).not.toBeInstanceOf(BudgetExceededError);
        expect((e as Error).message).toBe('Legacy migration output exceeds normalization bounds.');
      }
    } else {
      const output = run(input, budget);
      expect(output.warnings.length + output.blockingConflicts.length).toBe(4_096 + delta);
    }
  });
  it('failed factories never refund category admission or request slot/work reservations', () => {
    const budget = createBudgetContext({ now: () => 0 }), output = createNormalizationOutput(budget), list: number[] = [];
    for (let i = 0; i < 3_999; i++) output.target(list, () => i);
    const failure = new Error('factory failure');
    expect(() => output.target(list, () => { throw failure; })).toThrow(failure);
    const usage = budget.usage();
    expect(list).toHaveLength(3_999); expect(usage.slots).toBe(4_000); expect(usage.work).toBe(4_000);
    expect(() => output.target(list, () => 0)).toThrow(BudgetExceededError);
    expect(budget.usage()).toEqual(usage);
  });
});
