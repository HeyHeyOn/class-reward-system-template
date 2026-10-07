import { describe, expect, it, vi } from 'vitest';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { buildLocalMultiAddedProductPayload, inspectLocalMultiAddedProducts } from './localMultiAddedProductPlan';

vi.mock('server-only', () => ({}));
const tenantId = '10000000-0000-4000-8000-000000000001';
const migrationJobId = '20000000-0000-4000-8000-000000000019';
function fixtures(retainedName = 'Notebook', includeThird = false) {
  const sheets = makeSupportedSheets(3, (tabs) => {
    tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', retainedName, '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
  });
  const original = createLegacyNormalizationManifest({ tenantId, migrationJobId, sheets,
    redis: makeRedis({ operationBindings: [], v2Claims: [] }) });
  const nextSheets = makeSupportedSheets(3, (tabs) => {
    tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', retainedName, '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
    tabs.Products.rows.push({ rowNumber: 4, cells: ['P3', 'Pencils', '12', '3', 'TRUE', '', 'school', '2'], hash: '' });
    tabs.Products.rows.push({ rowNumber: 5, cells: ['P4', 'Erasers', '8', '3', 'TRUE', '', 'school', '2'], hash: '' });
    if (includeThird) tabs.Products.rows.push({ rowNumber: 6, cells: ['P5', 'Ruler', '10', '3', 'TRUE', '', 'school', '2'], hash: '' });
  });
  const candidate = createLegacyNormalizationManifest({ tenantId, migrationJobId, sheets: nextSheets,
    redis: makeRedis({ operationBindings: [], v2Claims: [] }) });
  const changes = (includeThird ? ['P3', 'P4', 'P5'] : ['P3', 'P4']).map((id) => ({ table: 'products', identity: canonicalJson([id]), kind: 'ADDED' as const,
    beforeDigest: null, afterDigest: sha256(canonicalJson(candidate.records.products.find((row) => row.productId === id))) }));
  return { original, candidate, changes };
}

describe('multi-product non-authoritative payload builder', () => {
  it.each([false, true])('returns exact sorted existing sources and targets (third product: %s)', (includeThird) => {
    const { original, candidate, changes } = fixtures('Notebook', includeThird);
    const shuffled = { ...candidate, sourceRecords: [...candidate.sourceRecords].reverse(),
      records: { ...candidate.records, products: [...candidate.records.products].reverse() } };
    const reversedChanges = [...changes].reverse();
    const before = canonicalJson({ original, shuffled, reversedChanges });
    const result = buildLocalMultiAddedProductPayload(original, shuffled, reversedChanges);
    expect(result).toEqual({ authority: 'NONAUTHORITY', activationAllowed: false, complete: false,
      scope: 'MULTI_ADDED_PRODUCTS', products: changes.map((change, index) => {
        const productId = includeThird ? ['P3', 'P4', 'P5'][index] : ['P3', 'P4'][index];
        const source = candidate.sourceRecords.find((record) => record.targetTable === 'products' && record.targetId === productId)!;
        if (source.source.kind !== 'SHEET') throw new Error('fixture source');
        const target = candidate.records.products.find((row) => row.productId === productId)!;
        return { productId, afterDigest: change.afterDigest, sourceRowHash: source.source.rowHash,
          sourceRowNumber: source.source.rowNumber, source, target };
      }) });
    for (const product of result.products) {
      expect(candidate.sourceRecords).toContain(product.source);
      expect(candidate.records.products).toContain(product.target);
    }
    expect(canonicalJson({ original, shuffled, reversedChanges })).toBe(before);
  });
  it('rejects forged and extra added-product sources before returning a payload', () => {
    const { original, candidate, changes } = fixtures();
    const source = candidate.sourceRecords.find((record) => record.targetTable === 'products' && record.targetId === 'P3')!;
    expect(() => buildLocalMultiAddedProductPayload(original, { ...candidate,
      sourceRecords: candidate.sourceRecords.map((record) => record === source
        ? { ...record, canonicalRecord: { ...record.canonicalRecord, name: 'Forged' } } : record) }, changes))
      .toThrow('source projection');
    expect(() => buildLocalMultiAddedProductPayload(original, { ...candidate,
      sourceRecords: [...candidate.sourceRecords, source] }, changes)).toThrow('target');
    expect(() => buildLocalMultiAddedProductPayload(original, candidate, changes.slice(0, 1))).toThrow('multi-product scope');
  });
});

describe('multi-product non-authoritative delta guard', () => {
  it('accepts two added products with retained data unchanged', () => {
    const { original, candidate, changes } = fixtures();
    expect(inspectLocalMultiAddedProducts(original, candidate, changes)).toMatchObject({
      authority: 'NONAUTHORITY', activationAllowed: false, complete: false,
      products: [{ productId: 'P3' }, { productId: 'P4' }],
    });
  });
  it('rejects duplicate identity, extra source, and unrelated retained edits', () => {
    const { original, candidate, changes } = fixtures();
    expect(() => inspectLocalMultiAddedProducts(original, candidate, [changes[0], changes[0]])).toThrow();
    expect(() => inspectLocalMultiAddedProducts(original, { ...candidate,
      sourceRecords: [...candidate.sourceRecords, candidate.sourceRecords[0]] }, changes)).toThrow();
    const changed = fixtures('Edited retained product');
    expect(() => inspectLocalMultiAddedProducts(original, changed.candidate, changed.changes)).toThrow();
  });
  it('rejects an omitted addition even when two changes remain', () => {
    const { original, candidate, changes } = fixtures('Notebook', true);
    expect(inspectLocalMultiAddedProducts(original, candidate, changes).products).toHaveLength(3);
    expect(() => inspectLocalMultiAddedProducts(original, candidate, changes.slice(0, 2))).toThrow('product delta');
  });
  it('rejects a forged change digest by comparing the recomputed delta', () => {
    const { original, candidate, changes } = fixtures();
    expect(() => inspectLocalMultiAddedProducts(original, candidate,
      [{ ...changes[0], afterDigest: '0'.repeat(64) }, changes[1]])).toThrow('product delta');
  });
  it.each(['MUTATED', 'REMOVED'] as const)('rejects an omitted %s product delta', (kind) => {
    const { original, candidate, changes } = fixtures();
    const products = kind === 'REMOVED'
      ? candidate.records.products.filter((row) => row.productId !== 'P2')
      : candidate.records.products.map((row) => row.productId === 'P2' ? { ...row, name: 'Changed' } : row);
    expect(() => inspectLocalMultiAddedProducts(original, { ...candidate,
      records: { ...candidate.records, products } }, changes)).toThrow('product delta');
  });
  it.each(['changed', 'extra', 'missing'] as const)('rejects %s retained mappings', (kind) => {
    const { original, candidate, changes } = fixtures();
    const retained = candidate.mappings.find((mapping) => mapping.targetTable === 'products' && mapping.targetId === 'P2')!;
    const mappings = kind === 'extra' ? [...candidate.mappings, { ...retained, targetId: 'unrelated' }]
      : kind === 'missing' ? candidate.mappings.filter((mapping) => mapping !== retained)
        : candidate.mappings.map((mapping) => mapping === retained ? { ...mapping, sourceDigest: '0'.repeat(64) } : mapping);
    expect(() => inspectLocalMultiAddedProducts(original, { ...candidate, mappings }, changes)).toThrow('retained data');
  });
  it('rejects an extra added-product mapping with a different source digest', () => {
    const { original, candidate, changes } = fixtures();
    const mapping = candidate.mappings.find((mapping) => mapping.targetTable === 'products' && mapping.targetId === 'P3')!;
    expect(() => inspectLocalMultiAddedProducts(original, { ...candidate,
      mappings: [...candidate.mappings, { ...mapping, targetId: 'P3', sourceDigest: '0'.repeat(64) }] }, changes)).toThrow('source projection');
  });
  it('rejects an added product reusing an original Products source hash', () => {
    const { original, candidate, changes } = fixtures();
    const retained = original.sourceRecords.find((record) => record.source.kind === 'SHEET' && record.source.tab === 'Products')!;
    if (retained.source.kind !== 'SHEET') throw new Error('fixture source');
    const rowHash = retained.source.rowHash;
    const sourceRecords = candidate.sourceRecords.map((record) => record.source.kind === 'SHEET'
      && record.source.tab === 'Products' && record.targetId === 'P3'
      ? { ...record, source: { ...record.source, rowHash } } : record);
    const mappings = candidate.mappings.map((mapping) => mapping.targetTable === 'products' && mapping.targetId === 'P3'
      ? { ...mapping, sourceDigest: rowHash } : mapping);
    expect(() => inspectLocalMultiAddedProducts(original, { ...candidate, sourceRecords, mappings }, changes)).toThrow('source projection');
  });
  it('rejects two added products claiming one source row hash or row number', () => {
    const { original, candidate, changes } = fixtures();
    const p3 = candidate.sourceRecords.find((record) => record.source.kind === 'SHEET'
      && record.source.tab === 'Products' && record.targetId === 'P3')!;
    if (p3.source.kind !== 'SHEET') throw new Error('fixture source');
    const p4 = candidate.sourceRecords.find((record) => record.source.kind === 'SHEET'
      && record.source.tab === 'Products' && record.targetId === 'P4')!;
    if (p4.source.kind !== 'SHEET') throw new Error('fixture source');
    const p3Pointer = p3.source;
    const p4Pointer = p4.source;
    for (const field of ['rowHash', 'rowNumber'] as const) {
      const sourceRecords = candidate.sourceRecords.map((record) => record === p4
        ? { ...record, source: { ...p4Pointer, [field]: p3Pointer[field] } } : record);
      const mappings = field === 'rowHash' ? candidate.mappings.map((mapping) =>
        mapping.targetTable === 'products' && mapping.targetId === 'P4'
          ? { ...mapping, sourceDigest: p3Pointer.rowHash } : mapping) : candidate.mappings;
      expect(() => inspectLocalMultiAddedProducts(original, { ...candidate, sourceRecords, mappings }, changes))
        .toThrow('duplicate source row');
    }
  });
  it('accepts reordered changes and mappings', () => {
    const { original, candidate, changes } = fixtures();
    expect(inspectLocalMultiAddedProducts(original, { ...candidate, mappings: [...candidate.mappings].reverse() },
      [...changes].reverse()).products.map((product) => product.productId)).toEqual(['P3', 'P4']);
  });
});
