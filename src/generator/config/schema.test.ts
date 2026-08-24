import { describe, expect, it } from 'vitest';
import { REQUIRED_SHEETS } from './schema';

const EXPECTED_SHEETS = [
  ['Students', ['studentId', 'name', 'balance', 'status']],
  ['Products', ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder']],
  [
    'Transactions',
    ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
  ],
  ['Adjustments', ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator']],
  ['Settings', ['key', 'value']],
  ['Tasks', ['taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds']],
  [
    'TaskCompletions',
    ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'],
  ],
  ['Recovery', ['key', 'value']],
] as const;

describe('REQUIRED_SHEETS', () => {
  it('defines exactly the eight canonical sheets and columns in order', () => {
    expect(Object.entries(REQUIRED_SHEETS)).toEqual(EXPECTED_SHEETS);
  });

  it('uses items as the canonical Transactions item column', () => {
    expect(REQUIRED_SHEETS.Transactions[4]).toBe('items');
  });

  it('starts Recovery with key/value columns', () => {
    expect(REQUIRED_SHEETS.Recovery).toEqual(['key', 'value']);
  });

  it('does not add maxCompletionsPerStudent to newly generated Tasks sheets', () => {
    expect(REQUIRED_SHEETS.Tasks).not.toContain('maxCompletionsPerStudent');
  });
});
