import { LATEST_SCHEMA_VERSION, SYSTEM_NAME_KO, SYSTEM_VERSION } from './versions.ts';

export const GENERATED_SHEET_NAMES = [
  'Students',
  'Products',
  'Transactions',
  'Adjustments',
  'Settings',
  'Tasks',
  'TaskAssignments',
  'TaskCompletions',
  'Recovery',
] as const;
export type GeneratedSheetName = (typeof GENERATED_SHEET_NAMES)[number];

export const OPERATIONAL_SHEET_NAMES = [
  'Students',
  'Products',
  'Transactions',
  'Adjustments',
  'Settings',
  'Tasks',
  'TaskAssignments',
  'TaskCompletions',
] as const satisfies readonly Exclude<GeneratedSheetName, 'Recovery'>[];
export type OperationalSheetName = (typeof OPERATIONAL_SHEET_NAMES)[number];

/** @deprecated Use OperationalSheetName. Kept until the Task 3 repository type move. */
export type SheetName = OperationalSheetName;

export const THEME_COLORS = ['blue', 'pink', 'yellow', 'green', 'purple', 'white', 'black', 'navy'] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];

export const REQUIRED_SHEETS: Record<GeneratedSheetName, string[]> = {
  Students: ['studentId', 'name', 'balance', 'status'],
  Products: ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
  Transactions: ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
  Adjustments: ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator'],
  Settings: ['key', 'value'],
  Tasks: [
    'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds',
    'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
    'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
    'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime',
    'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
  ],
  TaskAssignments: [
    'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
    'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
  ],
  TaskCompletions: [
    'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note',
    'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion',
  ],
  Recovery: ['key', 'value'],
};

export const DEFAULT_SETTINGS: Array<{ key: string; value: string }> = [
  { key: 'schemaVersion', value: String(LATEST_SCHEMA_VERSION) },
  { key: 'systemVersion', value: SYSTEM_VERSION },
  { key: 'systemName', value: SYSTEM_NAME_KO },
  { key: 'appTitle', value: '학급 매점' },
  { key: 'bankTitle', value: '학급 은행' },
  { key: 'currencyUnit', value: '원' },
  { key: 'classTimeZone', value: 'Asia/Seoul' },
  { key: 'themeColor', value: 'blue' },
  { key: 'qrManualInputEnabled', value: 'FALSE' },
];
