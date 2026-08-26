import { describe, expect, it } from 'vitest';
import {
  migratePromotionSchema,
  PROMOTION_PRODUCTS_HEADERS,
  PROMOTIONS_HEADERS,
} from '@/server/repositories/sheets/promotionSchemaMigrator';
import {
  SheetProviderError,
  type AdditiveSchemaMigrationStore,
  type OperationalSheetName,
  type SheetInfo,
} from '@/server/storage/tabularStore';

type Sheet = { info: SheetInfo; rows: string[][] };

class FakeStore implements AdditiveSchemaMigrationStore {
  readonly writes: string[] = [];
  readonly sheets = new Map<OperationalSheetName, Sheet>();
  beforeCreate?: (name: OperationalSheetName) => void;
  createError?: Partial<Record<OperationalSheetName, Error>>;

  constructor(initial: Partial<Record<OperationalSheetName, string[][]>> = {}) {
    for (const [name, rows] of Object.entries(initial)) {
      this.sheets.set(name as OperationalSheetName, {
        info: { sheetId: this.sheets.size + 1, title: name as OperationalSheetName, columnCount: rows[0]?.length ?? 0 },
        rows: structuredClone(rows),
      });
    }
  }

  async lookupSheet(name: OperationalSheetName) {
    const sheet = this.sheets.get(name);
    return sheet
      ? { found: true as const, info: { ...sheet.info } }
      : { found: false as const, reason: 'SHEET_NOT_FOUND' as const };
  }

  async getRows(name: OperationalSheetName) {
    return structuredClone(this.sheets.get(name)?.rows ?? []);
  }

  async createSheetWithHeader(name: OperationalSheetName, headers: readonly string[]) {
    this.beforeCreate?.(name);
    const error = this.createError?.[name];
    if (error) throw error;
    if (this.sheets.has(name)) throw new SheetProviderError('SHEET_ALREADY_EXISTS');
    this.writes.push(`create:${name}`);
    this.sheets.set(name, {
      info: { sheetId: 100 + this.sheets.size, title: name, columnCount: headers.length },
      rows: [[...headers]],
    });
  }

  async updateCell() { throw new Error('not used'); }
  async appendRow() { throw new Error('not used'); }
}

describe('promotion schema migrator', () => {
  it('creates both missing sheets with canonical headers', async () => {
    const store = new FakeStore();
    await migratePromotionSchema(store);
    expect(store.writes).toEqual(['create:Promotions', 'create:PromotionProducts']);
    expect(store.sheets.get('Promotions')?.rows).toEqual([[...PROMOTIONS_HEADERS]]);
    expect(store.sheets.get('PromotionProducts')?.rows).toEqual([[...PROMOTION_PRODUCTS_HEADERS]]);
  });

  it('does no writes when both canonical sheets exist with trailing columns and rows', async () => {
    const store = new FakeStore({
      Promotions: [[...PROMOTIONS_HEADERS, 'custom'], ['P-1', 'preserve']],
      PromotionProducts: [[...PROMOTION_PRODUCTS_HEADERS, 'custom'], ['PP-1', 'preserve']],
    });
    await migratePromotionSchema(store);
    expect(store.writes).toEqual([]);
  });

  it('creates only the missing sheet on retry after partial success', async () => {
    const store = new FakeStore({ Promotions: [[...PROMOTIONS_HEADERS]] });
    await migratePromotionSchema(store);
    await migratePromotionSchema(store);
    expect(store.writes).toEqual(['create:PromotionProducts']);
  });

  it.each([
    ['Promotions', []],
    ['Promotions', [['wrong']]],
    ['PromotionProducts', []],
    ['PromotionProducts', [['wrong']]],
  ] as const)('rejects existing blank or noncanonical %s without writes', async (name, rows) => {
    const other = name === 'Promotions' ? 'PromotionProducts' : 'Promotions';
    const otherHeaders = other === 'Promotions' ? PROMOTIONS_HEADERS : PROMOTION_PRODUCTS_HEADERS;
    const store = new FakeStore({ [name]: rows, [other]: [[...otherHeaders]] });
    await expect(migratePromotionSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: name, retryable: false,
    });
    expect(store.writes).toEqual([]);
    expect(store.sheets.get(name)?.rows).toEqual(rows);
  });

  it('accepts only a canonical concurrent already-exists create after re-reading', async () => {
    const store = new FakeStore({ Promotions: [[...PROMOTIONS_HEADERS]] });
    store.beforeCreate = (name) => {
      if (name === 'PromotionProducts') store.sheets.set(name, {
        info: { sheetId: 9, title: name, columnCount: PROMOTION_PRODUCTS_HEADERS.length },
        rows: [[...PROMOTION_PRODUCTS_HEADERS]],
      });
    };
    await expect(migratePromotionSchema(store)).resolves.toBeUndefined();
    expect(store.writes).toEqual([]);
  });

  it.each([
    { rows: [] as string[][] },
    { rows: [['wrong']] },
  ])('rejects a noncanonical concurrent create without initializing it', async ({ rows }) => {
    const store = new FakeStore({ Promotions: [[...PROMOTIONS_HEADERS]] });
    store.beforeCreate = (name) => store.sheets.set(name, {
      info: { sheetId: 9, title: name, columnCount: rows[0]?.length ?? 0 },
      rows: rows.map((row) => [...row]),
    });
    await expect(migratePromotionSchema(store)).rejects.toMatchObject({
      name: 'MigrationConflictError', sheetName: 'PromotionProducts', retryable: false,
    });
    expect(store.writes).toEqual([]);
    expect(store.sheets.get('PromotionProducts')?.rows).toEqual(rows);
  });

  it('rethrows create failures that are not SHEET_ALREADY_EXISTS', async () => {
    const store = new FakeStore({ Promotions: [[...PROMOTIONS_HEADERS]] });
    const failure = new Error('provider unavailable');
    store.createError = { PromotionProducts: failure };
    await expect(migratePromotionSchema(store)).rejects.toBe(failure);
  });
});
