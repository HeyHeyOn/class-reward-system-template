import { describe, expect, it } from 'vitest';
import type { Promotion } from '@/domain/types';
import type {
  AdditiveSchemaMigrationStore,
  OperationalSheetName,
  SheetCellUpdate,
  SheetLookupResult,
} from '@/server/storage/tabularStore';
import {
  createPromotion,
  replacePromotionProducts,
  setPromotionActive,
  updatePromotion,
  validatePromotionDefinitionInput,
  type PromotionCreateInput,
  type PromotionDefinitionInput,
} from './promotionCommands';
import { PROMOTIONS_HEADERS, PROMOTION_PRODUCTS_HEADERS } from './promotionSchemaMigrator';

const now = '2026-08-26T01:02:03.000Z';
const createdAt = '2026-08-01T00:00:00.000Z';
const base = {
  promotionId: ' P-1 ',
  name: ' Summer sale ',
  description: ' details ',
  type: 'PERCENT_DISCOUNT',
  percent: 10,
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-08-31T00:00:00.000Z',
  isActive: true,
  sortOrder: 1,
} satisfies PromotionCreateInput;

function promotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    promotionId: 'P-1', name: 'Old', description: 'old description', productIds: [],
    type: 'PERCENT_DISCOUNT', percent: 5,
    startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-31T00:00:00.000Z',
    isActive: true, sortOrder: 2, createdAt, updatedAt: createdAt, schemaVersion: 3,
    ...overrides,
  } as Promotion;
}

function rowFor(headers: readonly string[], values: Record<string, unknown>): string[] {
  return headers.map((header) => String(values[header.trim()] ?? ''));
}

function promotionRow(value = promotion(), headers: readonly string[] = PROMOTIONS_HEADERS): string[] {
  const specific = value.type === 'N_PLUS_ONE'
    ? { value: '', buyQuantity: value.buyQuantity, freeQuantity: value.freeQuantity }
    : value.type === 'PROMOTIONAL_PRICE'
      ? { value: value.promotionalUnitPrice, buyQuantity: '', freeQuantity: '' }
      : value.type === 'PERCENT_DISCOUNT'
        ? { value: value.percent, buyQuantity: '', freeQuantity: '' }
        : { value: value.discountAmount, buyQuantity: '', freeQuantity: '' };
  return rowFor(headers, {
    ...value, ...specific, isActive: value.isActive ? 'TRUE' : 'FALSE', productIds: undefined,
  });
}

function linkRow(id: string, productId: string, promotionId = 'P-1', headers = PROMOTION_PRODUCTS_HEADERS) {
  return rowFor(headers, { promotionProductId: id, promotionId, productId, createdAt, schemaVersion: 3 });
}

class StatefulStore implements AdditiveSchemaMigrationStore {
  rows: Partial<Record<OperationalSheetName, string[][]>>;
  calls: string[] = [];
  updateBatches: SheetCellUpdate[][] = [];
  deleted: number[][] = [];
  failAppend = false;

  constructor(rows?: Partial<Record<OperationalSheetName, string[][]>>) {
    this.rows = rows ?? {
      Promotions: [[...PROMOTIONS_HEADERS]],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS]],
    };
  }

  async getRows(name: OperationalSheetName) {
    this.calls.push(`getRows:${name}`);
    return structuredClone(this.rows[name] ?? []);
  }
  async lookupSheet(name: OperationalSheetName): Promise<SheetLookupResult> {
    this.calls.push(`lookup:${name}`);
    return this.rows[name]
      ? { found: true, info: { sheetId: 1, title: name, columnCount: this.rows[name]![0]?.length ?? 0 } }
      : { found: false, reason: 'SHEET_NOT_FOUND' };
  }
  async createSheetWithHeader(name: OperationalSheetName, headers: readonly string[]) {
    this.calls.push(`create:${name}`);
    this.rows[name] = [[...headers]];
  }
  async appendRow(name: OperationalSheetName, values: string[]) {
    this.calls.push(`append:${name}`);
    if (this.failAppend) throw new Error('injected append failure');
    (this.rows[name] ??= []).push([...values]);
  }
  async updateCell(name: OperationalSheetName, rowNumber: number, columnName: string, value: string | number) {
    this.calls.push(`updateCell:${name}:${columnName}`);
    this.apply(name, { rowNumber, columnName, value });
  }
  async updateCells(name: OperationalSheetName, updates: SheetCellUpdate[]) {
    this.calls.push(`updateCells:${name}`);
    this.updateBatches.push(structuredClone(updates));
    updates.forEach((update) => this.apply(name, update));
  }
  async deleteRows(name: OperationalSheetName, rowNumbers: number[]) {
    this.calls.push(`deleteRows:${name}`);
    this.deleted.push([...rowNumbers]);
    for (const rowNumber of [...rowNumbers].sort((a, b) => b - a)) this.rows[name]!.splice(rowNumber - 1, 1);
  }

  private apply(name: OperationalSheetName, update: SheetCellUpdate) {
    const rows = this.rows[name]!;
    const column = rows[0].findIndex((header) => header.trim() === update.columnName);
    if (column < 0) throw new Error(`missing column ${update.columnName}`);
    rows[update.rowNumber - 1][column] = String(update.value);
  }
}

const options = { now: () => now, idFactory: () => 'LINK-1' };

function definition(overrides: Partial<PromotionDefinitionInput> = {}): PromotionDefinitionInput {
  const common = {
    name: base.name,
    description: base.description,
    startsAt: base.startsAt,
    endsAt: base.endsAt,
    isActive: base.isActive,
    sortOrder: base.sortOrder,
  };
  if (overrides.type === 'FIXED_DISCOUNT') return { ...common, ...overrides } as PromotionDefinitionInput;
  if (overrides.type === 'N_PLUS_ONE') return { ...common, ...overrides } as PromotionDefinitionInput;
  if (overrides.type === 'PROMOTIONAL_PRICE') return { ...common, ...overrides } as PromotionDefinitionInput;
  return { ...common, type: 'PERCENT_DISCOUNT', percent: base.percent, ...overrides } as PromotionDefinitionInput;
}

describe('promotion Sheets commands', () => {
  it('purely validates and normalizes a definition without store access', () => {
    expect(validatePromotionDefinitionInput(definition({ name: '  Normalized  ' }))).toEqual({
      ...definition({ name: 'Normalized', description: 'details' }),
    });
  });

  it.each([
    { ...definition(), sortOrder: '1' },
    { ...definition(), percent: '10' },
    { ...definition(), name: '   ' },
    { ...definition(), startsAt: '2026-09-02T00:00:00.000Z' },
  ])('pure validator rejects malformed and semantically invalid definitions', (input) => {
    expect(() => validatePromotionDefinitionInput(input as PromotionDefinitionInput)).toThrow();
  });

  it.each([
    { ...base, name: '   ' },
    { ...base, startsAt: 'bad-date' },
    { ...base, startsAt: '2026-09-01T00:00:00Z' },
    { ...base, isActive: 'true' },
    { ...base, sortOrder: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, percent: 0 },
    { ...base, percent: 101 },
    { ...base, discountAmount: 5 },
  ])('rejects invalid or inexact create input before migration/read/write', async (input) => {
    const store = new StatefulStore();
    await expect(createPromotion(store, input as PromotionCreateInput, options)).rejects.toThrow();
    expect(store.calls).toEqual([]);
  });

  it('creates missing schemas, normalizes input, and appends schema-v3 metadata in live header order', async () => {
    const store = new StatefulStore({});
    const result = await createPromotion(store, base, options);

    expect(store.calls).toEqual(expect.arrayContaining([
      'create:Promotions', 'create:PromotionProducts', 'append:Promotions',
    ]));
    expect(result).toEqual({
      promotionId: 'P-1', name: 'Summer sale', description: 'details', productIds: [],
      type: 'PERCENT_DISCOUNT', percent: 10, startsAt: base.startsAt, endsAt: base.endsAt,
      isActive: true, sortOrder: 1, createdAt: now, updatedAt: now, schemaVersion: 3,
    });
    expect(store.rows.Promotions![1]).toEqual(promotionRow(result));
  });

  it('appends against a live header with unknown columns left blank', async () => {
    const headers = [...PROMOTIONS_HEADERS, 'futureColumn'];
    const store = new StatefulStore({
      Promotions: [headers], PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS, 'futureLinkColumn']],
    });
    await createPromotion(store, base, options);
    expect(store.rows.Promotions![1].at(-1)).toBe('');
  });

  it('rejects duplicate normalized promotion IDs after migration without appending', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS]],
    });
    await expect(createPromotion(store, base, options)).rejects.toThrow(/P-1|duplicate|중복/i);
    expect(store.calls).not.toContain('append:Promotions');
  });

  it('updates only canonical cells in one batch while preserving createdAt, targets, and unknown cells', async () => {
    const headers = [...PROMOTIONS_HEADERS, 'unknown'];
    const store = new StatefulStore({
      Promotions: [headers, [...promotionRow(promotion(), headers).slice(0, -1), 'keep-me']],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS], linkRow('L-old', 'PRODUCT-2')],
    });
    const result = await updatePromotion(store, ' P-1 ', definition({
      name: ' New name ', type: 'FIXED_DISCOUNT', discountAmount: 7,
    } as Partial<PromotionDefinitionInput>), options);

    expect(result).toMatchObject({
      promotionId: 'P-1', name: 'New name', type: 'FIXED_DISCOUNT', discountAmount: 7,
      createdAt, updatedAt: now, productIds: ['PRODUCT-2'], schemaVersion: 3,
    });
    expect(store.updateBatches).toHaveLength(1);
    expect(store.updateBatches[0].map((update) => update.columnName).sort())
      .toEqual([...PROMOTIONS_HEADERS].sort());
    expect(store.rows.Promotions![1].at(-1)).toBe('keep-me');
  });

  it('falls back to canonical updateCell writes when batch updates are unavailable', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS]],
    });
    store.updateCells = undefined as never;
    await updatePromotion(store, 'P-1', definition(), options);
    const cellWrites = store.calls.filter((call) => call.startsWith('updateCell:Promotions:'));
    expect(cellWrites).toHaveLength(PROMOTIONS_HEADERS.length);
  });

  it('toggles only isActive and updatedAt and returns the full promotion with targets', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS], linkRow('L-1', 'Z')],
    });
    const result = await setPromotionActive(store, ' P-1 ', false, options);
    expect(store.updateBatches[0]).toEqual([
      { rowNumber: 2, columnName: 'isActive', value: 'FALSE' },
      { rowNumber: 2, columnName: 'updatedAt', value: now },
    ]);
    expect(result).toMatchObject({ isActive: false, updatedAt: now, productIds: ['Z'] });
  });

  it('normalizes, deduplicates, replaces, and UTF-16 sorts promotion targets', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [
        [...PROMOTION_PRODUCTS_HEADERS, 'unknown'],
        [...linkRow('OLD-1', 'OLD'), 'keep-old'],
      ],
    });
    const ids = ['LINK-b', 'LINK-Z', 'LINK-emoji'];
    const result = await replacePromotionProducts(store, ' P-1 ', [' 😀 ', 'Z', '😀', 'a'], {
      now: () => now, idFactory: () => ids.shift()!,
    });

    expect(store.deleted).toEqual([[2]]);
    expect(store.calls.filter((call) => call === 'append:PromotionProducts')).toHaveLength(3);
    expect(store.rows.PromotionProducts!.slice(1).every((row) => row.at(-1) === '')).toBe(true);
    expect(result.productIds).toEqual(['Z', 'a', '😀']);
  });

  it('does not rewrite links when the normalized target set is unchanged', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS], linkRow('L-1', 'A'), linkRow('L-2', 'B')],
    });
    const result = await replacePromotionProducts(store, 'P-1', [' B ', 'A', 'A'], options);
    expect(store.deleted).toEqual([]);
    expect(store.calls).not.toContain('append:PromotionProducts');
    expect(result.productIds).toEqual(['A', 'B']);
  });

  it('removes every old target for an empty replacement', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS], linkRow('L-1', 'A'), linkRow('L-2', 'B')],
    });
    const result = await replacePromotionProducts(store, 'P-1', [], options);
    expect(store.deleted).toEqual([[2, 3]]);
    expect(result.productIds).toEqual([]);
  });

  it('requires deleteRows before mutation when old target links exist', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS], linkRow('L-1', 'OLD')],
    });
    store.deleteRows = undefined as never;
    await expect(replacePromotionProducts(store, 'P-1', ['NEW'], options)).rejects.toThrow(/delete/i);
    expect(store.calls).not.toContain('append:PromotionProducts');
  });

  it('rejects blank product IDs and duplicate generated link IDs before delete/append', async () => {
    const invalid = new StatefulStore();
    await expect(replacePromotionProducts(invalid, 'P-1', ['OK', '  '], options)).rejects.toThrow();
    expect(invalid.calls).toEqual([]);

    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS], linkRow('L-1', 'OLD')],
    });
    await expect(replacePromotionProducts(store, 'P-1', ['A', 'B'], {
      now: () => now, idFactory: () => 'DUP',
    })).rejects.toThrow(/DUP|duplicate|중복/i);
    expect(store.deleted).toEqual([]);
    expect(store.calls).not.toContain('append:PromotionProducts');
  });

  it('propagates malformed-header, duplicate-record, and provider failures', async () => {
    const malformed = new StatefulStore({
      Promotions: [['promotionId']], PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS]],
    });
    await expect(updatePromotion(malformed, 'P-1', definition(), options)).rejects.toThrow();

    const duplicate = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow(), promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS]],
    });
    await expect(setPromotionActive(duplicate, 'P-1', false, options)).rejects.toThrow(/중복/);

    const failed = new StatefulStore();
    failed.failAppend = true;
    await expect(createPromotion(failed, base, options)).rejects.toThrow('injected append failure');
  });

  it('fails closed on malformed nonblank physical rows before any business mutation', async () => {
    const malformedPromotion = promotionRow({ ...promotion(), name: '' });
    const createStore = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], malformedPromotion],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS]],
    });
    await expect(createPromotion(createStore, base, options)).rejects.toThrow(/Promotions.*2|2.*Promotions/);
    expect(createStore.calls).not.toContain('append:Promotions');

    const replaceStore = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS], linkRow('BROKEN', '')],
    });
    await expect(replacePromotionProducts(replaceStore, 'P-1', ['NEW'], options))
      .rejects.toThrow(/PromotionProducts.*2|2.*PromotionProducts/);
    expect(replaceStore.deleted).toEqual([]);
    expect(replaceStore.calls).not.toContain('append:PromotionProducts');
  });

  it('serializes concurrent creates so the same normalized ID is appended only once', async () => {
    const store = new StatefulStore();
    const append = store.appendRow.bind(store);
    store.appendRow = async (sheetName, values) => {
      if (sheetName === 'Promotions') await new Promise((resolve) => setTimeout(resolve, 15));
      await append(sheetName, values);
    };

    const results = await Promise.allSettled([
      createPromotion(store, base, options),
      createPromotion(store, base, options),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(store.rows.Promotions).toHaveLength(2);
  });

  it('serializes fallback updates without interleaving canonical cell sequences', async () => {
    const store = new StatefulStore({
      Promotions: [[...PROMOTIONS_HEADERS], promotionRow()],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS]],
    });
    store.updateCells = undefined as never;
    const updateCell = store.updateCell.bind(store);
    let activeName = '';
    let interleaved = false;
    store.updateCell = async (sheetName, rowNumber, columnName, value) => {
      if (sheetName === 'Promotions' && columnName === 'name') {
        const name = String(value);
        if (activeName && activeName !== name) interleaved = true;
        activeName = name;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      await updateCell(sheetName, rowNumber, columnName, value);
      if (sheetName === 'Promotions' && columnName === 'schemaVersion') activeName = '';
    };

    await Promise.all([
      updatePromotion(store, 'P-1', definition({ name: 'First' }), options),
      updatePromotion(store, 'P-1', definition({ name: 'Second' }), options),
    ]);

    expect(interleaved).toBe(false);
  });

  it('serializes target replacement globally so row shifts cannot delete another promotion link', async () => {
    const store = new StatefulStore({
      Promotions: [
        [...PROMOTIONS_HEADERS],
        promotionRow(),
        promotionRow({ ...promotion(), promotionId: 'P-2' }),
      ],
      PromotionProducts: [
        [...PROMOTION_PRODUCTS_HEADERS],
        linkRow('OLD-1', 'OLD-A', 'P-1'),
        linkRow('OLD-2', 'OLD-B', 'P-2'),
      ],
    });
    const deleteRows = store.deleteRows.bind(store);
    store.deleteRows = async (sheetName, rowNumbers) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await deleteRows(sheetName, rowNumbers);
    };
    const generated = ['NEW-1', 'NEW-2'];

    const [first, second] = await Promise.all([
      replacePromotionProducts(store, 'P-1', ['NEW-A'], { now: () => now, idFactory: () => generated.shift()! }),
      replacePromotionProducts(store, 'P-2', ['NEW-B'], { now: () => now, idFactory: () => generated.shift()! }),
    ]);

    expect(first.productIds).toEqual(['NEW-A']);
    expect(second.productIds).toEqual(['NEW-B']);
    expect(store.rows.PromotionProducts!.slice(1).map((row) => [row[1], row[2]]).sort())
      .toEqual([['P-1', 'NEW-A'], ['P-2', 'NEW-B']]);
  });
});
