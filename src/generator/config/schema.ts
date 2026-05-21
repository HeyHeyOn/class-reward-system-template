import { LATEST_SCHEMA_VERSION, SYSTEM_NAME_KO, SYSTEM_VERSION } from './versions.ts';

export type SheetName = 'Students' | 'Products' | 'Transactions' | 'Adjustments' | 'Settings' | 'Tasks' | 'TaskCompletions' | 'Recovery';

export const THEME_COLORS = ['blue', 'pink', 'yellow', 'green', 'purple', 'white', 'black', 'navy'] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];

export const REQUIRED_SHEETS: Record<SheetName, string[]> = {
  Students: ['studentId', 'name', 'number', 'balance', 'status'],
  Products: ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
  Transactions: ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
  Adjustments: ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator'],
  Settings: ['key', 'value'],
  Tasks: ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt'],
  TaskCompletions: ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'],
  Recovery: ['key', 'value'],
};

export const DEFAULT_SETTINGS: Array<{ key: string; value: string }> = [
  { key: 'schemaVersion', value: String(LATEST_SCHEMA_VERSION) },
  { key: 'systemVersion', value: SYSTEM_VERSION },
  { key: 'systemName', value: SYSTEM_NAME_KO },
  { key: 'appTitle', value: '학급 매점' },
  { key: 'bankTitle', value: '학급 은행' },
  { key: 'currencyUnit', value: '원' },
  { key: 'themeColor', value: 'blue' },
];
