// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { stageLegacyFinalGeneration } from './finalGeneration';
import type { LegacyNormalizationManifest } from './manifest';
import { createLegacyNormalizationManifest } from './manifest';
import { makeRedis, makeSupportedSheets } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { LOCAL_DELTA_COVERAGE_CATALOG, verifyLocalFullCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';

vi.mock('server-only', () => ({}));
// Type-only references must never load an application writer or a DB connection.
vi.mock('./finalGeneration', () => { throw new Error('Unexpected preparation runtime import'); });
vi.mock('@/server/db/transaction', () => { throw new Error('Unexpected DB runtime import'); });

type Records = LegacyNormalizationManifest['records'];
type Plan = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>['plan'];
type Change = Plan['changes'][number];
const refused = 'Local delta coverage refused.';
const identities = {
  students: ['studentId'], accounts: ['studentId'], products: ['productId'], settings: ['key'],
  tasks: ['taskInstanceId'], task_allowed_students: ['taskInstanceId', 'studentId'],
  promotions: ['promotionId'], promotion_products: ['promotionProductId'], transactions: ['transactionId'],
  transaction_items: ['itemId'], adjustments: ['adjustmentId'], task_assignments: ['assignmentId'],
  task_completions: ['completionId'], legacy_operation_bindings: ['operationId'],
  padlet_evidence_claims: ['tupleDigest'], padlet_claim_digest_tombstones: ['tupleDigest'],
} as const;
const tables = Object.keys(identities) as (keyof typeof identities)[];
function added(table: keyof typeof identities, row: Readonly<Record<string, unknown>>): Change {
  return { table, identity: canonicalJson(identities[table].map((key) => row[key])), kind: 'ADDED',
    beforeDigest: null, afterDigest: sha256(canonicalJson(row)) };
}
const plan = (changes: readonly Change[] = []): Plan => ({ status: 'DIFF_VALIDATED', changes, blockers: [] });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const p1 = { productId: 'P1', name: 'Pencil', stock: 5 };
const p2 = { productId: 'P2', name: 'Notebook', stock: 5 };

// This is a fixed normalization-table catalog, NOT the 27 report/diagnostic
// categories. The real plan has table changes, not a mandatory category list.
describe('local full-category normalized delta coverage', () => {
  it('pins every identity recipe to the current private planner catalog without running it', () => {
    const source = ts.createSourceFile('finalGeneration.ts', readFileSync(new URL('./finalGeneration.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const declarations = source.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations]);
    const initializer = declarations.find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'IDENTITIES')?.initializer;
    expect(initializer && ts.isObjectLiteralExpression(initializer)).toBe(true);
    if (!initializer || !ts.isObjectLiteralExpression(initializer)) throw new Error('Planner catalog shape changed');
    const actual = initializer.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !ts.isArrayLiteralExpression(property.initializer)) {
        throw new Error('Unsupported planner catalog declaration');
      }
      return { table: property.name.text, identityKeys: property.initializer.elements.map((element) => {
        if (!ts.isStringLiteral(element)) throw new Error('Unsupported identity recipe');
        return element.text;
      }) };
    });
    expect(LOCAL_DELTA_COVERAGE_CATALOG).toEqual(actual);
    expect(Object.fromEntries(actual.map(({ table, identityKeys }) => [table, identityKeys]))).toEqual(identities);
    expect(Object.isFrozen(LOCAL_DELTA_COVERAGE_CATALOG)).toBe(true);
    for (const entry of LOCAL_DELTA_COVERAGE_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.identityKeys)).toBe(true);
    }
  });

  it('visits the full fixed catalog for sparse empty inputs without certifying source absence', () => {
    const result = verifyLocalFullCategoryDeltaCoverage({}, {}, plan());
    expect(result).toEqual({
      status: 'COVERED_LOCAL_INPUTS', scope: 'LOCAL_NORMALIZED_ADDED_DELTA_COVERAGE_ONLY',
      authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', complete: false, activationAllowed: false,
      sourceReconciliation: 'NOT_PERFORMED', targetReconciliation: 'NOT_PERFORMED',
      coverage: tables.map((table) => ({ table, originalCount: 0, candidateCount: 0, addedCount: 0 })),
    });
  });

  it.each(tables)('checks an ADDED identity in %s independently of the supplied plan', (table) => {
    const row = Object.fromEntries(identities[table].map((key, index) => [key, `id-${index}`]));
    const result = verifyLocalFullCategoryDeltaCoverage({}, { [table]: [row] }, plan([added(table, row)]));
    expect(result.coverage.find((entry) => entry.table === table)).toEqual({ table, originalCount: 0, candidateCount: 1, addedCount: 1 });
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { [table]: [row] }, plan())).toThrow(refused);
  });

  it('accepts distinct identities in the same category, independent ordering and frozen inputs', () => {
    const original = freeze({ products: [p1] });
    const candidate = freeze({ products: [p2, p1, { ...p2, productId: 'P3' }] });
    const expected = freeze(plan([added('products', candidate.products[2]), added('products', p2)]));
    const before = canonicalJson({ original, candidate, expected });
    const result = verifyLocalFullCategoryDeltaCoverage(original, candidate, expected);
    expect(result.coverage.find((entry) => entry.table === 'products')).toEqual({ table: 'products', originalCount: 1, candidateCount: 3, addedCount: 2 });
    expect(canonicalJson({ original, candidate, expected })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.coverage)).toBe(true);
    expect(result.coverage.every(Object.isFrozen)).toBe(true);
  });

  it('handles actual normalized records using the real manifest types, not a production plan receipt', () => {
    const binding = { tenantId: '10000000-0000-4000-8000-000000000001', migrationJobId: '20000000-0000-4000-8000-000000000019' };
    const original = createLegacyNormalizationManifest({ ...binding, sheets: makeSupportedSheets(3), redis: makeRedis({ operationBindings: [], v2Claims: [] }) });
    const candidate = createLegacyNormalizationManifest({ ...binding, sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', 'Notebook', '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
    }), redis: makeRedis({ operationBindings: [], v2Claims: [] }) });
    expect(original.status).toBe('READY_FOR_IMPORT');
    expect(candidate.status).toBe('READY_FOR_IMPORT');
    const row = candidate.records.products.find((record) => record.productId === 'P2')!;
    expect(verifyLocalFullCategoryDeltaCoverage(original.records, candidate.records, plan([added('products', row)])))
      .toMatchObject({ authority: 'NONAUTHORITY', complete: false, activationAllowed: false });
  });

  it('rejects a missing changed category even when other categories match', () => {
    const student = { studentId: 'S1' };
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { products: [p1], students: [student] }, plan([added('products', p1)]))).toThrow(refused);
  });
  it('rejects a duplicated category/identity instead of deduplicating the multiset', () => {
    const change = added('products', p1);
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { products: [p1, p2] }, plan([change, change]))).toThrow(refused);
  });
  it.each(['original', 'candidate', 'plan'] as const)('rejects an unknown category in %s including an empty unknown table', (where) => {
    const unknown: Records = { not_a_table: [] };
    expect(() => verifyLocalFullCategoryDeltaCoverage(where === 'original' ? unknown : {}, where === 'candidate' ? unknown : where === 'plan' ? { products: [p1] } : {},
      where === 'plan' ? plan([{ ...added('products', p1), table: 'not_a_table' }]) : plan())).toThrow(refused);
  });
  it('does not confuse a report category with a normalized table', () => {
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { PRODUCTS: [p1] }, plan())).toThrow(refused);
  });
  it('rejects same-count identity substitution and an extra plan row', () => {
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { products: [p1] }, plan([added('products', p2)]))).toThrow(refused);
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, {}, plan([added('products', p1)]))).toThrow(refused);
  });
  it('preserves composite tuple boundaries rather than comparing joined strings', () => {
    const first = { taskInstanceId: 'a,b', studentId: 'c' };
    const second = { taskInstanceId: 'a', studentId: 'b,c' };
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { task_allowed_students: [first] }, plan([added('task_allowed_students', second)]))).toThrow(refused);
  });
  it.each(['MUTATED', 'REMOVED'] as const)('rejects explicit %s even for mutable tables', (kind) => {
    const change: Change = { ...added('products', p1), kind, beforeDigest: sha256(canonicalJson(p1)), afterDigest: kind === 'REMOVED' ? null : sha256(canonicalJson(p2)) };
    // Same expected/declared change count: refusal must not rely on cardinality.
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { products: [p1] }, plan([change]))).toThrow(refused);
  });
  it.each(['products', 'transactions'] as const)('rejects hidden mutation, removal and count-preserving replacement in %s', (table) => {
    const key = identities[table][0];
    const row = { [key]: 'one', value: 5 };
    for (const rows of [[], [{ ...row, value: 6 }], [{ ...row, [key]: 'two' }]]) {
      expect(() => verifyLocalFullCategoryDeltaCoverage({ [table]: [row] }, { [table]: rows }, plan())).toThrow(refused);
    }
  });
  it.each(['original', 'candidate'] as const)('rejects duplicate normalized identities in %s', (where) => {
    expect(() => verifyLocalFullCategoryDeltaCoverage(where === 'original' ? { products: [p1, p1] } : {},
      where === 'candidate' ? { products: [p1, p1] } : {}, plan())).toThrow(refused);
  });
  it.each(['BLOCKED', 'MATCH', 'FINAL_IMPORT'])('rejects unsupported status %s without echoing diagnostics', (status) => {
    const invalid = { ...plan(), status } as Plan;
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, {}, invalid)).toThrow(new Error(refused));
  });
  it('rejects DIFF_VALIDATED with nonempty blockers and never leaks them', () => {
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, {}, { ...plan(), blockers: ['PRIVATE_SENTINEL'] })).toThrow(new Error(refused));
  });
  it.each(['before', 'after', 'identity'])('rejects an invalid %s change field', (field) => {
    const change = added('products', p1);
    const altered = field === 'before' ? { ...change, beforeDigest: 'a'.repeat(64) }
      : field === 'after' ? { ...change, afterDigest: 'a'.repeat(64) } : { ...change, identity: '[ "P1" ]' };
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { products: [p1] }, plan([altered]))).toThrow(refused);
  });
  it.each([{}, { productId: '' }, { productId: 1 }])('rejects an invalid identity field %j', (row) => {
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { products: [row] }, plan())).toThrow(refused);
  });
  it('rejects extra plan fields instead of forwarding authority flags', () => {
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, {}, { ...plan(), complete: true } as Plan)).toThrow(refused);
  });
  it('does not coerce or normalize arbitrary strings as dates', () => {
    expect(() => verifyLocalFullCategoryDeltaCoverage({ products: [{ ...p1, name: '2026-09-01T00:00:00Z' }] },
      { products: [{ ...p1, name: '2026-09-01T00:00:00.000Z' }] }, plan())).toThrow(refused);
  });

  it('admits at most 4000 row occurrences per input side and 4000 changes', () => {
    const rows = Array.from({ length: 4000 }, (_, index) => ({ productId: `P${index}` }));
    expect(verifyLocalFullCategoryDeltaCoverage({}, { products: rows }, plan(rows.map((row) => added('products', row)))).coverage
      .find((entry) => entry.table === 'products')?.addedCount).toBe(4000);
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, { products: [...rows, { productId: 'overflow' }] }, plan())).toThrow(refused);
    expect(() => verifyLocalFullCategoryDeltaCoverage({}, {}, plan(Array.from({ length: 4001 }, () => added('products', p1))))).toThrow(refused);
    expect(() => verifyLocalFullCategoryDeltaCoverage({ products: rows, students: [{ studentId: 'overflow' }] }, {}, plan())).toThrow(refused);
  });
  it('rejects oversized strings, excessive depth, cycles and sparse arrays', () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 20; depth++) nested = { nested };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of ['x'.repeat(8193), nested, cycle, new Array(2)]) {
      const records = { products: [{ ...p1, value }] };
      expect(() => verifyLocalFullCategoryDeltaCoverage(records, records, plan())).toThrow(refused);
    }
  });
  it('bounds aggregate input text rather than just each string', () => {
    const products = Array.from({ length: 140 }, (_, index) => ({ productId: `P${index}`, name: 'x'.repeat(8192) }));
    expect(() => verifyLocalFullCategoryDeltaCoverage({ products }, { products }, plan())).toThrow(refused);
  });
  it('bounds cumulative node visits, not only array arity or text', () => {
    const products = Array.from({ length: 4000 }, (_, index) => ({ productId: `P${index}`, values: Array.from({ length: 20 }, () => 0) }));
    expect(() => verifyLocalFullCategoryDeltaCoverage({ products }, { products }, plan())).toThrow(refused);
  });
  it('distinguishes accepted string/key-width/identity boundaries from overflow', () => {
    const within = { productId: 'p'.repeat(512), text: 'x'.repeat(8192) };
    expect(() => verifyLocalFullCategoryDeltaCoverage({ products: [within] }, { products: [within] }, plan())).not.toThrow();
    const wide = { productId: 'P1', ...Object.fromEntries(Array.from({ length: 127 }, (_, index) => [`key-${index}`, 0])) };
    expect(() => verifyLocalFullCategoryDeltaCoverage({ products: [wide] }, { products: [wide] }, plan())).not.toThrow();
    for (const row of [{ ...wide, extra: 0 }, { ...within, productId: 'p'.repeat(513) }]) {
      expect(() => verifyLocalFullCategoryDeltaCoverage({ products: [row] }, { products: [row] }, plan())).toThrow(refused);
    }
  });
  it('rejects accessors and proxies without executing them', () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE_SENTINEL'); });
    const record = Object.defineProperty({ ...p1 }, 'name', { get: getter, enumerable: true });
    expect(() => verifyLocalFullCategoryDeltaCoverage({ products: [record] }, { products: [record] }, plan())).toThrow(refused);
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => { throw new Error('PRIVATE_SENTINEL'); });
    const proxy = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap });
    expect(() => verifyLocalFullCategoryDeltaCoverage(proxy, {}, plan())).toThrow(refused);
    expect(trap).not.toHaveBeenCalled();
  });
  it('rejects symbols, nonenumerable payload fields, class instances and nonfinite numbers', () => {
    for (const value of [{ [Symbol('hidden')]: true }, Object.defineProperty({}, 'hidden', { value: true }), new Date(), NaN, Infinity]) {
      const records = { products: [{ ...p1, value }] };
      expect(() => verifyLocalFullCategoryDeltaCoverage(records, records, plan())).toThrow(refused);
    }
  });
});
