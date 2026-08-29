import { describe, expect, it, vi } from 'vitest';
import {
  compareProductsLikeSheets,
  compareStudentsLikeSheets,
  compareTasksLikeSheets,
  compareTransactionsLikeSheets,
  isoString,
  nullableIsoString,
  nullableString,
  projectTransactionItem,
  safeInteger,
} from './queryProjection';

vi.mock('server-only', () => ({}));

describe('database query projection guards', () => {
  it('projects exact safe integers from PostgreSQL scalar representations', () => {
    expect(safeInteger(42, 'amount')).toBe(42);
    expect(safeInteger('42', 'amount')).toBe(42);
    expect(safeInteger(BigInt(42), 'amount')).toBe(42);
    expect(safeInteger('-0', 'amount')).toBe(-0);
  });

  it.each([
    null,
    undefined,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '1.5',
    '1e3',
    ' 1',
    Number.MAX_SAFE_INTEGER + 1,
    '9007199254740992',
    BigInt('9007199254740992'),
  ])('rejects non-exact or unsafe integer value %s', (value) => {
    expect(() => safeInteger(value, 'balance')).toThrow(/balance.*safe integer/i);
  });

  it('normalizes Date objects and parseable date strings to ISO strings', () => {
    expect(isoString(new Date('2026-08-29T01:02:03.456Z'), 'occurredAt'))
      .toBe('2026-08-29T01:02:03.456Z');
    expect(isoString('2026-08-29T10:02:03.456+09:00', 'occurredAt'))
      .toBe('2026-08-29T01:02:03.456Z');
  });

  it.each([new Date(Number.NaN), 'not-a-date', null, 0])('rejects invalid date value %s', (value) => {
    expect(() => isoString(value as never, 'occurredAt')).toThrow(/occurredAt.*date/i);
  });

  it('preserves nullable string absence as undefined without coercion', () => {
    expect(nullableString(null, 'note')).toBeUndefined();
    expect(nullableString(undefined, 'note')).toBeUndefined();
    expect(nullableString('', 'note')).toBe('');
    expect(nullableString('memo', 'note')).toBe('memo');
    expect(() => nullableString(1, 'note')).toThrow(/note.*string/i);
  });

  it('preserves nullable date absence as undefined and normalizes present values', () => {
    expect(nullableIsoString(null, 'cancelledAt')).toBeUndefined();
    expect(nullableIsoString(undefined, 'cancelledAt')).toBeUndefined();
    expect(nullableIsoString(new Date('2026-08-29T01:02:03Z'), 'cancelledAt'))
      .toBe('2026-08-29T01:02:03.000Z');
    expect(() => nullableIsoString('invalid', 'cancelledAt')).toThrow(/cancelledAt.*date/i);
  });

  it('orders students with the Sheets numeric Korean ID comparator', () => {
    const students = [
      { studentId: 'S10', name: '가', balance: 0, status: 'ACTIVE' as const },
      { studentId: 'S2', name: '나', balance: 0, status: 'ACTIVE' as const },
    ];
    expect(students.sort(compareStudentsLikeSheets).map(({ studentId }) => studentId))
      .toEqual(['S2', 'S10']);
  });

  it('orders products by sort order then name like Sheets', () => {
    const products = [
      { productId: 'P2', name: '나', price: 1, stock: 1, isActive: true, sortOrder: 2 },
      { productId: 'P1', name: '가', price: 1, stock: 1, isActive: true, sortOrder: 2 },
      { productId: 'P3', name: '다', price: 1, stock: 1, isActive: true, sortOrder: 1 },
    ];
    expect(products.sort(compareProductsLikeSheets).map(({ productId }) => productId))
      .toEqual(['P3', 'P1', 'P2']);
  });

  it('orders tasks by sort order then title like Sheets', () => {
    const tasks = [
      { taskId: 'T2', title: '나', description: '', reward: 1, isActive: true, sortOrder: 2, allowedStudentIds: [] },
      { taskId: 'T1', title: '가', description: '', reward: 1, isActive: true, sortOrder: 2, allowedStudentIds: [] },
    ];
    expect(tasks.sort(compareTasksLikeSheets).map(({ taskId }) => taskId)).toEqual(['T1', 'T2']);
  });

  it('orders transactions newest first like Sheets', () => {
    const base = { studentId: 'S1', studentName: '학생', items: [], totalAmount: 0, balanceBefore: 0, balanceAfter: 0, status: 'OK', operator: 'admin' };
    const transactions = [
      { ...base, transactionId: 'old', timestamp: '2026-01-01T00:00:00.000Z' },
      { ...base, transactionId: 'new', timestamp: '2026-02-01T00:00:00.000Z' },
    ];
    expect(transactions.sort(compareTransactionsLikeSheets).map(({ transactionId }) => transactionId))
      .toEqual(['new', 'old']);
  });

  it('projects legacy base items and validates complete extended snapshots with the client parser', () => {
    const base = {
      product_id_snapshot: 'P1', product_name_snapshot: '연필', quantity: '3',
      unit_price_snapshot: BigInt(300), subtotal_snapshot: '600', regular_unit_price: null,
      regular_total: null, total_quantity: null, paid_quantity: null, free_quantity: null,
      final_total: null, total_discount: null, adjustments_snapshot: null,
      applied_promotions_snapshot: null,
    };
    expect(projectTransactionItem(base)).toEqual({ productId: 'P1', name: '연필', price: 300, quantity: 3, subtotal: 600 });
    expect(() => projectTransactionItem({ ...base, quantity: '0' })).toThrow(/quantity|integrity/i);
    expect(() => projectTransactionItem({ ...base, quantity: '-1' })).toThrow(/quantity|integrity/i);

    const promotion = {
      promotionId: 'N21', name: '2+1', description: '', type: 'N_PLUS_ONE', buyQuantity: 2,
      freeQuantity: 1, productIds: ['P1'], startsAt: '2020-01-01T00:00:00.000Z',
      endsAt: '2099-01-01T00:00:00.000Z', isActive: true, sortOrder: 1,
      createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 3,
    };
    const extended = {
      ...base, regular_unit_price: '300', regular_total: '900', total_quantity: '3',
      paid_quantity: '2', free_quantity: '1', final_total: '600', total_discount: '300',
      adjustments_snapshot: [{ promotionId: 'N21', type: 'N_PLUS_ONE', beforeAmount: 900, afterAmount: 600, discountAmount: 300, freeQuantity: 1 }],
      applied_promotions_snapshot: [promotion],
    };
    expect(projectTransactionItem(extended)).toMatchObject({ productId: 'P1', finalTotal: 600, appliedPromotions: [promotion] });
    expect(() => projectTransactionItem({ ...extended, paid_quantity: null })).toThrow(/snapshot|integrity/i);
    expect(() => projectTransactionItem({ ...extended, final_total: '601' })).toThrow(/snapshot|integrity/i);
  });
});
