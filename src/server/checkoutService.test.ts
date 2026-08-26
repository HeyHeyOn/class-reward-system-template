import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewCheckoutCart, processCheckout } from '@/server/checkoutService';
import * as promotionQueries from '@/server/repositories/sheets/promotionQueries';
import type { OperationalSheetName, TabularStore } from '@/server/storage/tabularStore';

class FakeSheetsStore implements TabularStore {
  public rows: Record<string, string[][]>;
  public updates: Array<{ sheetName: OperationalSheetName; rowNumber: number; columnName: string; value: string | number }> = [];
  public appends: Array<{ sheetName: OperationalSheetName; values: string[] }> = [];

  constructor(rows: Record<string, string[][]>) {
    this.rows = structuredClone(rows);
  }

  async getRows(sheetName: OperationalSheetName): Promise<string[][]> {
    return this.rows[sheetName];
  }

  async updateCell(sheetName: OperationalSheetName, rowNumber: number, columnName: string, value: string | number): Promise<void> {
    this.updates.push({ sheetName, rowNumber, columnName, value });
    const headers = this.rows[sheetName][0];
    const columnIndex = headers.indexOf(columnName);
    this.rows[sheetName][rowNumber - 1][columnIndex] = String(value);
  }

  async appendRow(sheetName: OperationalSheetName, values: string[]): Promise<void> {
    this.appends.push({ sheetName, values });
    this.rows[sheetName].push(values);
  }
}

const baseRows: Record<string, string[][]> = {
  Students: [
    ['studentId', 'name', 'number', 'balance', 'qrValue', 'status', 'note'],
    ['S001', '김민준', '1', '3500', 'S001', 'ACTIVE', ''],
  ],
  Products: [
    ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
    ['P001', '연필', '300', '20', 'TRUE', '', '문구', '1'],
    ['P002', '지우개', '500', '15', 'TRUE', '', '문구', '2'],
  ],
  Transactions: [
    ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
  ],
  Adjustments: [['adjustmentId', 'timestamp', 'studentId', 'amount', 'reason', 'balanceBefore', 'balanceAfter', 'operator']],
  Promotions: [[
    'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
    'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
  ]],
  PromotionProducts: [['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion']],
};

const stackedPromotionRows = (): Record<string, string[][]> => ({
  ...baseRows,
  Promotions: [
    baseRows.Promotions[0],
    ['N21', '2+1', '', 'N_PLUS_ONE', '', '2', '1', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'TRUE', '1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '3'],
    ['P10', '10% 할인', '', 'PERCENT_DISCOUNT', '10', '', '', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'TRUE', '1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '3'],
  ],
  PromotionProducts: [
    baseRows.PromotionProducts[0],
    ['L1', 'N21', 'P001', '2026-08-01T00:00:00.000Z', '3'],
    ['L2', 'P10', 'P001', '2026-08-01T00:00:00.000Z', '3'],
  ],
});

const noPromotionSnapshot = (productId: string, name: string, price: number, quantity: number) => ({
  productId, name, price, quantity, subtotal: price * quantity,
  regularUnitPrice: price, regularTotal: price * quantity, totalQuantity: quantity,
  paidQuantity: quantity, freeQuantity: 0, finalTotal: price * quantity, totalDiscount: 0,
  adjustments: [], appliedPromotions: [],
});

const noPromotionQuote = (...items: ReturnType<typeof noPromotionSnapshot>[]) => ({
  ok: true as const,
  totalAmount: items.reduce((total, item) => total + item.finalTotal, 0),
  items,
});

describe('processCheckout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('updates student balance, product stock, and appends a transaction row', async () => {
    const store = new FakeSheetsStore(baseRows);

    const result = await processCheckout(store, {
      studentId: 'S001',
      items: [
        { productId: 'P001', quantity: 2 },
        { productId: 'P002', quantity: 1 },
      ],
      expectedPricing: noPromotionQuote(
        noPromotionSnapshot('P001', '연필', 300, 2),
        noPromotionSnapshot('P002', '지우개', 500, 1),
      ),
      operator: 'kiosk',
      now: () => new Date('2026-05-19T02:00:00.000Z'),
      transactionIdFactory: () => 'T-TEST-001',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected checkout to succeed');
    expect(result.transactionId).toBe('T-TEST-001');
    expect(result.balanceBefore).toBe(3500);
    expect(result.balanceAfter).toBe(2400);
    expect(store.updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 2400 },
      { sheetName: 'Products', rowNumber: 2, columnName: 'stock', value: 18 },
      { sheetName: 'Products', rowNumber: 3, columnName: 'stock', value: 14 },
    ]);
    expect(store.appends).toHaveLength(1);
    expect(store.appends[0]).toEqual({
      sheetName: 'Transactions',
      values: [
        'T-TEST-001',
        '2026-05-19T02:00:00.000Z',
        'S001',
        '김민준',
        JSON.stringify([
          noPromotionSnapshot('P001', '연필', 300, 2),
          noPromotionSnapshot('P002', '지우개', 500, 1),
        ]),
        '1100',
        '3500',
        '2400',
        'COMPLETED',
        'kiosk',
      ],
    });
  });

  it('appends a transaction using the live Transactions header order', async () => {
    const transactionHeaders = [
      'operator', 'status', 'balanceAfter', 'balanceBefore', 'totalAmount',
      'items', 'studentName', 'studentId', 'timestamp', 'transactionId',
    ];
    const store = new FakeSheetsStore({ ...baseRows, Transactions: [transactionHeaders] });

    const result = await processCheckout(store, {
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 1)),
      operator: 'teacher',
      now: () => new Date('2026-05-19T02:00:00.000Z'),
      transactionIdFactory: () => 'T-LIVE-ORDER',
    });

    expect(result.ok).toBe(true);
    expect(store.appends[0]).toEqual({
      sheetName: 'Transactions',
      values: [
        'teacher', 'COMPLETED', '3200', '3500', '300',
        JSON.stringify([noPromotionSnapshot('P001', '연필', 300, 1)]),
        '김민준', 'S001', '2026-05-19T02:00:00.000Z', 'T-LIVE-ORDER',
      ],
    });
  });

  it('falls back to canonical transaction headers when the pre-mutation header read fails', async () => {
    const store = new FakeSheetsStore(baseRows);
    const getRows = store.getRows.bind(store);
    const events: string[] = [];
    store.getRows = async (sheetName) => {
      if (sheetName === 'Transactions') {
        events.push('read:Transactions');
        throw new Error('Transactions header read failed');
      }
      return getRows(sheetName);
    };
    const updateCell = store.updateCell.bind(store);
    store.updateCell = async (...args) => {
      events.push(`update:${args[0]}`);
      return updateCell(...args);
    };

    await expect(processCheckout(store, {
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 1)),
      operator: 'kiosk',
      now: () => new Date('2026-05-19T02:00:00.000Z'),
      transactionIdFactory: () => 'T-FALLBACK',
    })).resolves.toMatchObject({ ok: true, balanceBefore: 3500, balanceAfter: 3200 });
    expect(events).toEqual(['read:Transactions', 'update:Students', 'update:Products']);
    expect(store.updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 3200 },
      { sheetName: 'Products', rowNumber: 2, columnName: 'stock', value: 19 },
    ]);
    expect(store.appends).toEqual([{
      sheetName: 'Transactions',
      values: [
        'T-FALLBACK',
        '2026-05-19T02:00:00.000Z',
        'S001',
        '김민준',
        JSON.stringify([noPromotionSnapshot('P001', '연필', 300, 1)]),
        '300',
        '3500',
        '3200',
        'COMPLETED',
        'kiosk',
      ],
    }]);
  });

  it('reads active stacked promotions, persists the exact preview snapshot, and decrements received stock', async () => {
    const store = new FakeSheetsStore({
      ...baseRows,
      Promotions: [
        baseRows.Promotions[0],
        ['N21', '2+1', '', 'N_PLUS_ONE', '', '2', '1', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'TRUE', '1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '3'],
        ['P10', '10% 할인', '', 'PERCENT_DISCOUNT', '10', '', '', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'TRUE', '1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '3'],
      ],
      PromotionProducts: [
        baseRows.PromotionProducts[0],
        ['L1', 'N21', 'P001', '2026-08-01T00:00:00.000Z', '3'],
        ['L2', 'P10', 'P001', '2026-08-01T00:00:00.000Z', '3'],
      ],
    });
    let nowCalls = 0;
    const now = new Date('2026-08-15T00:00:00.000Z');
    const expectedPricing = await previewCheckoutCart(store, {
      items: [{ productId: 'P001', quantity: 3 }],
      now: () => now,
    });
    if (!expectedPricing.ok) throw new Error('expected pricing preview to succeed');

    const result = await processCheckout(store, {
      studentId: 'S001', items: [{ productId: 'P001', quantity: 3 }],
      expectedPricing,
      now: () => { nowCalls += 1; return now; }, transactionIdFactory: () => 'T-PROMO',
    });

    expect(result).toMatchObject({ ok: true, totalAmount: 540, balanceBefore: 3500, balanceAfter: 2960 });
    expect(nowCalls).toBe(1);
    expect(store.updates).toEqual([
      { sheetName: 'Students', rowNumber: 2, columnName: 'balance', value: 2960 },
      { sheetName: 'Products', rowNumber: 2, columnName: 'stock', value: 17 },
    ]);
    if (!result.ok) throw new Error('expected checkout success');
    const persisted = JSON.parse(store.appends[0].values[4]);
    expect(persisted).toEqual(result.items);
    expect(persisted[0]).toMatchObject({
      quantity: 3, totalQuantity: 3, paidQuantity: 2, freeQuantity: 1,
      subtotal: 540, finalTotal: 540, totalDiscount: 360,
      adjustments: [
        { promotionId: 'N21', discountAmount: 300, freeQuantity: 1 },
        { promotionId: 'P10', discountAmount: 60 },
      ],
      appliedPromotions: [{ promotionId: 'N21' }, { promotionId: 'P10' }],
    });
  });

  it('captures now once even when deriving the transaction ID', async () => {
    const store = new FakeSheetsStore(baseRows);
    let calls = 0;
    const result = await processCheckout(store, {
      studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 1)),
      now: () => { calls += 1; return new Date('2026-08-15T12:34:56.000Z'); },
    });
    expect(result).toMatchObject({ ok: true, transactionId: 'T20260815123456' });
    expect(calls).toBe(1);
    expect(store.appends[0].values[1]).toBe('2026-08-15T12:34:56.000Z');
  });

  it('does not mutate any sheet when active promotion pricing is malformed', async () => {
    vi.spyOn(promotionQueries, 'getActivePromotions').mockResolvedValueOnce([{
      promotionId: 'BAD', name: 'broken', description: '', productIds: ['P001'],
      type: 'PERCENT_DISCOUNT', percent: 200,
      startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z',
      isActive: true, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3,
    }]);
    const store = new FakeSheetsStore(baseRows);
    await expect(processCheckout(store, {
      studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 1)),
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    })).resolves.toMatchObject({ ok: false, code: 'PRICING_FAILED', promotionId: 'BAD' });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('treats missing promotion sheets as no active promotions', async () => {
    const store = new FakeSheetsStore(baseRows);
    const getRows = store.getRows.bind(store);
    store.getRows = async (sheetName) => {
      if (sheetName === 'Promotions' || sheetName === 'PromotionProducts') return [];
      return getRows(sheetName);
    };
    await expect(processCheckout(store, {
      studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 1)),
      now: () => new Date('2026-08-15T00:00:00.000Z'), transactionIdFactory: () => 'T-NO-PROMO',
    })).resolves.toMatchObject({ ok: true, totalAmount: 300 });
    expect(JSON.parse(store.appends[0].values[4])).toEqual([noPromotionSnapshot('P001', '연필', 300, 1)]);
  });

  it('fails closed without writes when an existing promotion sheet has missing required columns', async () => {
    const store = new FakeSheetsStore({
      ...baseRows,
      Promotions: [['promotionId']],
      PromotionProducts: [],
    });

    await expect(processCheckout(store, {
      studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 1)),
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    })).rejects.toThrow('필수 컬럼');
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('does not update sheets when balance is insufficient', async () => {
    const store = new FakeSheetsStore({
      ...baseRows,
      Students: [baseRows.Students[0], ['S001', '김민준', '1', '500', 'S001', 'ACTIVE', '']],
    });

    const result = await processCheckout(store, {
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 2 }],
      expectedPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 2)),
      operator: 'kiosk',
      now: () => new Date('2026-05-19T02:00:00.000Z'),
      transactionIdFactory: () => 'T-TEST-002',
    });

    expect(result).toEqual({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      message: '잔액이 부족합니다.',
      currentBalance: 500,
      requiredAmount: 600,
    });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('returns the latest authoritative quote without writes when expected pricing changed', async () => {
    const store = new FakeSheetsStore(baseRows);
    const staleQuote = {
      ok: true as const,
      totalAmount: 299,
      items: [{ ...noPromotionSnapshot('P001', '연필', 300, 1), subtotal: 299, finalTotal: 299, totalDiscount: 1 }],
    };

    const result = await processCheckout(store, {
      studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }], expectedPricing: staleQuote,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(result).toEqual({
      ok: false, code: 'PRICE_CHANGED',
      message: '상품 가격 또는 행사가 변경되었습니다. 최신 금액을 확인해 주세요.',
      latestPricing: { ok: true, totalAmount: 300, items: [noPromotionSnapshot('P001', '연필', 300, 1)] },
    });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('does not allow a direct caller to omit expected pricing', async () => {
    const store = new FakeSheetsStore(baseRows);

    const result = await processCheckout(store, {
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 1 }],
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    } as Parameters<typeof processCheckout>[1]);

    expect(result).toEqual({
      ok: false,
      code: 'PRICE_CHANGED',
      message: '상품 가격 또는 행사가 변경되었습니다. 최신 금액을 확인해 주세요.',
      latestPricing: noPromotionQuote(noPromotionSnapshot('P001', '연필', 300, 1)),
    });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });
});

describe('previewCheckoutCart', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns stacked promotion pricing, captures the clock once, and performs no writes', async () => {
    const store = new FakeSheetsStore(stackedPromotionRows());
    const now = new Date('2026-08-15T00:00:00.000Z');
    const clock = vi.fn(() => now);

    const result = await previewCheckoutCart(store, {
      items: [{ productId: 'P001', quantity: 3 }],
      now: clock,
    });

    expect(clock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      totalAmount: 540,
      items: [{
        productId: 'P001', totalQuantity: 3, paidQuantity: 2, freeQuantity: 1,
        regularTotal: 900, finalTotal: 540, totalDiscount: 360,
      }],
    });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('treats missing promotion sheets as no promotions without writing', async () => {
    const store = new FakeSheetsStore(baseRows);
    const getRows = store.getRows.bind(store);
    store.getRows = async (sheetName) => {
      if (sheetName === 'Promotions' || sheetName === 'PromotionProducts') return [];
      return getRows(sheetName);
    };

    await expect(previewCheckoutCart(store, {
      items: [{ productId: 'P001', quantity: 1 }],
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    })).resolves.toEqual({
      ok: true,
      totalAmount: 300,
      items: [noPromotionSnapshot('P001', '연필', 300, 1)],
    });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('propagates malformed promotion schemas closed without writing', async () => {
    const store = new FakeSheetsStore({
      ...baseRows,
      Promotions: [['promotionId']],
      PromotionProducts: [],
    });

    await expect(previewCheckoutCart(store, {
      items: [{ productId: 'P001', quantity: 1 }],
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    })).rejects.toThrow('필수 컬럼');
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('matches the authoritative checkout pricing snapshot under the same source snapshot', async () => {
    const store = new FakeSheetsStore(stackedPromotionRows());
    const items = [
      { productId: 'P001', quantity: 1 },
      { productId: 'P001', quantity: 2 },
    ];
    const now = () => new Date('2026-08-15T00:00:00.000Z');

    const preview = await previewCheckoutCart(store, { items, now });
    if (!preview.ok) throw new Error('expected preview to succeed');
    const checkout = await processCheckout(store, {
      studentId: 'S001', items, expectedPricing: preview,
      now, transactionIdFactory: () => 'T-CONSISTENCY',
    });

    expect(preview.ok).toBe(true);
    expect(checkout.ok).toBe(true);
    if (!preview.ok || !checkout.ok) throw new Error('expected both operations to succeed');
    expect(preview.totalAmount).toBe(checkout.totalAmount);
    expect(preview.items).toEqual(checkout.items);
  });
});
