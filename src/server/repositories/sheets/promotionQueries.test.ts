import { describe, expect, it, vi } from 'vitest';
import type { OperationalSheetName, TabularReader } from '@/server/storage/tabularStore';
import {
  getActivePromotions,
  getPromotionProductRecords,
  getPromotionRecords,
  getPromotions,
} from './promotionQueries';

const promotionHeaders = [
  'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
  'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
];
const promotionProductHeaders = [
  'promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion',
];

const promotionDefaults: Record<string, string> = {
  promotionId: 'P-1',
  name: 'Promotion 1',
  description: 'description',
  type: 'PERCENT_DISCOUNT',
  value: '10',
  buyQuantity: '',
  freeQuantity: '',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-08-31T23:59:59.000Z',
  isActive: 'TRUE',
  sortOrder: '1',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  schemaVersion: '3',
};
const promotionProductDefaults: Record<string, string> = {
  promotionProductId: 'PP-1',
  promotionId: 'P-1',
  productId: 'PRODUCT-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  schemaVersion: '3',
};

function rowFor(
  headers: readonly string[],
  defaults: Record<string, string>,
  overrides: Record<string, string> = {},
): string[] {
  const values = { ...defaults, ...overrides };
  return headers.map((header) => values[header] ?? '');
}

function promotionRow(overrides: Record<string, string> = {}, headers = promotionHeaders): string[] {
  return rowFor(headers, promotionDefaults, overrides);
}

function promotionProductRow(
  overrides: Record<string, string> = {},
  headers = promotionProductHeaders,
): string[] {
  return rowFor(headers, promotionProductDefaults, overrides);
}

function readerWith(
  sheets: Partial<Record<OperationalSheetName, string[][]>>,
): TabularReader {
  return {
    async getRows(sheetName) {
      return sheets[sheetName] ?? [];
    },
  };
}

describe('promotion sheet read queries', () => {
  it('returns empty results for missing or blank sheets without invoking writes or migration', async () => {
    const store = {
      getRows: vi.fn(async () => [] as string[][]),
      appendRow: vi.fn(),
      updateCell: vi.fn(),
      updateCells: vi.fn(),
      updateHeaderRow: vi.fn(),
      migratePromotionSchema: vi.fn(),
    };

    await expect(getPromotionRecords(store)).resolves.toEqual([]);
    await expect(getPromotionProductRecords(store)).resolves.toEqual([]);
    await expect(getPromotions(store)).resolves.toEqual([]);
    await expect(getActivePromotions(store)).resolves.toEqual([]);

    expect(store.appendRow).not.toHaveBeenCalled();
    expect(store.updateCell).not.toHaveBeenCalled();
    expect(store.updateCells).not.toHaveBeenCalled();
    expect(store.updateHeaderRow).not.toHaveBeenCalled();
    expect(store.migratePromotionSchema).not.toHaveBeenCalled();

    const blankReader = readerWith({ Promotions: [[]], PromotionProducts: [['  ', '']] });
    await expect(getPromotionRecords(blankReader)).resolves.toEqual([]);
    await expect(getPromotionProductRecords(blankReader)).resolves.toEqual([]);
  });

  it('skips malformed rows and retains physical row numbers for valid records', async () => {
    const reader = readerWith({
      Promotions: [
        promotionHeaders,
        promotionRow({ promotionId: 'P-2', name: '' }),
        promotionRow({ promotionId: 'P-3', sortOrder: '3' }),
        promotionRow({ promotionId: 'P-4', schemaVersion: '2' }),
        promotionRow({ promotionId: 'P-5', sortOrder: '5' }),
      ],
      PromotionProducts: [
        promotionProductHeaders,
        promotionProductRow({ promotionProductId: '', productId: 'BAD' }),
        promotionProductRow({ promotionProductId: 'PP-3', productId: 'PRODUCT-3' }),
        promotionProductRow({ promotionProductId: 'PP-4', schemaVersion: '1' }),
        promotionProductRow({ promotionProductId: 'PP-5', productId: 'PRODUCT-5' }),
      ],
    });

    const promotionRecords = await getPromotionRecords(reader);
    const productRecords = await getPromotionProductRecords(reader);

    expect(promotionRecords.map(({ promotion, rowNumber }) => [promotion.promotionId, rowNumber]))
      .toEqual([['P-3', 3], ['P-5', 5]]);
    expect(productRecords.map(({ link, rowNumber }) => [link.promotionProductId, rowNumber]))
      .toEqual([['PP-3', 3], ['PP-5', 5]]);
  });

  it('reads normalized required columns from permuted headers', async () => {
    const permutedPromotionHeaders = [
      ' custom ', ' updatedAt ', 'promotionId', 'type', 'value', 'name', 'schemaVersion',
      'createdAt', 'description', 'sortOrder', 'isActive', 'endsAt', 'startsAt', 'freeQuantity',
      'buyQuantity',
    ];
    const permutedProductHeaders = [
      'productId', 'schemaVersion', ' promotionId ', 'createdAt', 'promotionProductId', 'future',
    ];
    const reader = readerWith({
      Promotions: [
        permutedPromotionHeaders,
        rowFor(permutedPromotionHeaders.map((header) => header.trim()), promotionDefaults, {
          promotionId: 'P-PERMUTED',
        }),
      ],
      PromotionProducts: [
        permutedProductHeaders,
        rowFor(permutedProductHeaders.map((header) => header.trim()), promotionProductDefaults, {
          promotionProductId: 'PP-PERMUTED', promotionId: 'P-PERMUTED', productId: 'PRODUCT-PERMUTED',
        }),
      ],
    });

    await expect(getPromotions(reader)).resolves.toMatchObject([
      { promotionId: 'P-PERMUTED', productIds: ['PRODUCT-PERMUTED'] },
    ]);
  });

  it('joins valid links, ignores dangling links, deduplicates targets, and sorts deterministically', async () => {
    const reader = readerWith({
      Promotions: [
        promotionHeaders,
        promotionRow({ promotionId: '😀', name: 'emoji', sortOrder: '2' }),
        promotionRow({ promotionId: 'b', name: 'bee', sortOrder: '1' }),
        promotionRow({ promotionId: 'A', name: 'aye', sortOrder: '1' }),
      ],
      PromotionProducts: [
        promotionProductHeaders,
        promotionProductRow({ promotionProductId: 'L-1', promotionId: 'b', productId: '😀' }),
        promotionProductRow({ promotionProductId: 'L-2', promotionId: 'b', productId: 'a' }),
        promotionProductRow({ promotionProductId: 'L-3', promotionId: 'b', productId: 'Z' }),
        promotionProductRow({ promotionProductId: 'L-4', promotionId: 'b', productId: 'a' }),
        promotionProductRow({ promotionProductId: 'L-5', promotionId: 'missing', productId: 'DANGLING' }),
      ],
    });

    const promotions = await getPromotions(reader);

    expect(promotions.map(({ promotionId }) => promotionId)).toEqual(['A', 'b', '😀']);
    expect(promotions.find(({ promotionId }) => promotionId === 'b')?.productIds).toEqual(['Z', 'a', '😀']);
    expect(promotions.find(({ promotionId }) => promotionId === 'A')?.productIds).toEqual([]);
    expect(promotions.flatMap(({ productIds }) => productIds)).not.toContain('DANGLING');
  });

  it('returns targetless promotions when PromotionProducts is missing', async () => {
    const reader = readerWith({
      Promotions: [promotionHeaders, promotionRow({ promotionId: 'P-TARGETLESS' })],
    });

    await expect(getPromotions(reader)).resolves.toMatchObject([
      { promotionId: 'P-TARGETLESS', productIds: [] },
    ]);
  });

  it('rejects duplicate valid promotion IDs deterministically', async () => {
    const reader = readerWith({
      Promotions: [
        promotionHeaders,
        promotionRow({ promotionId: 'DUP' }),
        promotionRow({ promotionId: 'DUP', name: 'duplicate' }),
      ],
    });

    await expect(getPromotionRecords(reader))
      .rejects.toThrow('Promotions 시트에 중복된 promotionId가 있습니다: DUP');
  });

  it('rejects duplicate valid promotion-product IDs deterministically', async () => {
    const reader = readerWith({
      PromotionProducts: [
        promotionProductHeaders,
        promotionProductRow({ promotionProductId: 'DUP-LINK' }),
        promotionProductRow({ promotionProductId: 'DUP-LINK', productId: 'PRODUCT-2' }),
      ],
    });

    await expect(getPromotionProductRecords(reader))
      .rejects.toThrow('PromotionProducts 시트에 중복된 promotionProductId가 있습니다: DUP-LINK');
  });

  it.each([
    {
      sheetName: 'Promotions' as const,
      rows: [[...promotionHeaders.filter((header) => !['name', 'startsAt'].includes(header))]],
      read: (reader: TabularReader) => getPromotionRecords(reader),
      message: 'Promotions 시트에 필수 컬럼이 없습니다: name, startsAt',
    },
    {
      sheetName: 'PromotionProducts' as const,
      rows: [[...promotionProductHeaders, ' productId ']],
      read: (reader: TabularReader) => getPromotionProductRecords(reader),
      message: 'PromotionProducts 시트에 필수 컬럼이 없습니다: productId',
    },
  ])('rejects structurally invalid $sheetName headers', async ({ sheetName, rows, read, message }) => {
    await expect(read(readerWith({ [sheetName]: rows }))).rejects.toThrow(message);
  });

  it('filters only by isActive and leaves time-window filtering to the price engine', async () => {
    const reader = readerWith({
      Promotions: [
        promotionHeaders,
        promotionRow({ promotionId: 'PAST-ACTIVE', startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-02T00:00:00Z', isActive: 'TRUE' }),
        promotionRow({ promotionId: 'FUTURE-ACTIVE', startsAt: '2099-01-01T00:00:00Z', endsAt: '2099-01-02T00:00:00Z', isActive: 'TRUE', sortOrder: '2' }),
        promotionRow({ promotionId: 'CURRENT-INACTIVE', isActive: 'FALSE', sortOrder: '3' }),
      ],
    });

    const active = await getActivePromotions(reader);

    expect(active.map(({ promotionId }) => promotionId)).toEqual(['PAST-ACTIVE', 'FUTURE-ACTIVE']);
  });

  it('returns fresh arrays and target arrays that do not alias mutable source or prior results', async () => {
    const sheets = {
      Promotions: [promotionHeaders, promotionRow({ promotionId: 'P-FRESH' })],
      PromotionProducts: [
        promotionProductHeaders,
        promotionProductRow({ promotionProductId: 'L-FRESH', promotionId: 'P-FRESH', productId: 'PRODUCT-FRESH' }),
      ],
    };
    const reader = readerWith(sheets);

    const first = await getPromotions(reader);
    first.push({ ...first[0], promotionId: 'MUTATED' });
    first[0].productIds.push('MUTATED-TARGET');
    const second = await getPromotions(reader);

    expect(second).toMatchObject([{ promotionId: 'P-FRESH', productIds: ['PRODUCT-FRESH'] }]);
    expect(second).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(second[0].productIds).not.toBe(first[0].productIds);
    expect(sheets.Promotions[1]).toEqual(promotionRow({ promotionId: 'P-FRESH' }));
    expect(sheets.PromotionProducts[1]).toEqual(promotionProductRow({
      promotionProductId: 'L-FRESH', promotionId: 'P-FRESH', productId: 'PRODUCT-FRESH',
    }));
  });
});
