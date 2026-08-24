import { describe, expect, it } from 'vitest';
import { processCheckout } from '@/server/checkoutService';
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
};

describe('processCheckout', () => {
  it('updates student balance, product stock, and appends a transaction row', async () => {
    const store = new FakeSheetsStore(baseRows);

    const result = await processCheckout(store, {
      studentId: 'S001',
      items: [
        { productId: 'P001', quantity: 2 },
        { productId: 'P002', quantity: 1 },
      ],
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
          { productId: 'P001', name: '연필', price: 300, quantity: 2, subtotal: 600 },
          { productId: 'P002', name: '지우개', price: 500, quantity: 1, subtotal: 500 },
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
      operator: 'teacher',
      now: () => new Date('2026-05-19T02:00:00.000Z'),
      transactionIdFactory: () => 'T-LIVE-ORDER',
    });

    expect(result.ok).toBe(true);
    expect(store.appends[0]).toEqual({
      sheetName: 'Transactions',
      values: [
        'teacher', 'COMPLETED', '3200', '3500', '300',
        JSON.stringify([{ productId: 'P001', name: '연필', price: 300, quantity: 1, subtotal: 300 }]),
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
        JSON.stringify([{ productId: 'P001', name: '연필', price: 300, quantity: 1, subtotal: 300 }]),
        '300',
        '3500',
        '3200',
        'COMPLETED',
        'kiosk',
      ],
    }]);
  });

  it('does not update sheets when balance is insufficient', async () => {
    const store = new FakeSheetsStore({
      ...baseRows,
      Students: [baseRows.Students[0], ['S001', '김민준', '1', '500', 'S001', 'ACTIVE', '']],
    });

    const result = await processCheckout(store, {
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 2 }],
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
});
