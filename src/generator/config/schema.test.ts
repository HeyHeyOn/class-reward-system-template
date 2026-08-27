import { describe, expect, it } from 'vitest';
import { GENERATED_SHEET_NAMES, OPERATIONAL_SHEET_NAMES, REQUIRED_SHEETS } from './schema';
import { LATEST_SCHEMA_VERSION } from './versions';

const EXPECTED_SHEETS = [
  ['Students', ['studentId', 'name', 'balance', 'status']],
  ['Products', ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder']],
  [
    'Transactions',
    ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
  ],
  ['Adjustments', ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator']],
  ['Settings', ['key', 'value']],
  ['Tasks', [
    'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds',
    'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
    'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
    'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime',
    'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
    'availableFrom', 'dueAt', 'prerequisiteTaskId', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays',
  ]],
  ['TaskAssignments', [
    'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
    'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
  ]],
  [
    'TaskCompletions',
    ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note',
      'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion'],
  ],
  ['Promotions', [
    'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
    'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
  ]],
  ['PromotionProducts', [
    'promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion',
  ]],
  ['Recovery', ['key', 'value']],
] as const;

describe('REQUIRED_SHEETS', () => {
  it('defines exactly the eleven canonical sheets and columns in order', () => {
    expect(Object.entries(REQUIRED_SHEETS)).toEqual(EXPECTED_SHEETS);
  });

  it('exposes eleven generated and ten operational sheets for schema v3', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(3);
    expect(GENERATED_SHEET_NAMES).toHaveLength(11);
    expect(OPERATIONAL_SHEET_NAMES).toHaveLength(10);
    expect(OPERATIONAL_SHEET_NAMES).toContain('Promotions');
    expect(OPERATIONAL_SHEET_NAMES).toContain('PromotionProducts');
  });

  it('uses items as the canonical Transactions item column', () => {
    expect(REQUIRED_SHEETS.Transactions[4]).toBe('items');
  });

  it('starts Recovery with key/value columns', () => {
    expect(REQUIRED_SHEETS.Recovery).toEqual(['key', 'value']);
  });

  it('defines the schema-v2 recurring ledger dimensions exactly', () => {
    expect(REQUIRED_SHEETS.Tasks).toHaveLength(33);
    expect(REQUIRED_SHEETS.TaskAssignments).toHaveLength(15);
  });

  it('does not add maxCompletionsPerStudent to newly generated Tasks sheets', () => {
    expect(REQUIRED_SHEETS.Tasks).not.toContain('maxCompletionsPerStudent');
  });
});
