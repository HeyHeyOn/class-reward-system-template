import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_SHEETS, DEFAULT_SETTINGS } from './config/schema';
import type { SheetName } from './config/schema';
import { LATEST_SCHEMA_VERSION, SYSTEM_VERSION } from './config/versions';
import { buildSpreadsheetValueRanges, createClassRewardSpreadsheet } from './createSpreadsheet';

const api = vi.hoisted(() => ({
  create: vi.fn(async (payload: unknown) => { void payload; return { data: { spreadsheetId: 'fake-sheet' } }; }),
  batchUpdate: vi.fn(async (payload: unknown) => { void payload; return {}; }),
}));
vi.mock('googleapis', () => ({ google: { sheets: () => ({ spreadsheets: {
  create: api.create, values: { batchUpdate: api.batchUpdate },
} }) } }));
vi.mock('@/server/googleOAuth', () => ({
  isGoogleOAuthEnabled: () => true,
  createUserSheetsAuth: () => ({ auth: {}, session: { email: 'teacher@example.test' } }),
  createDeploymentSheetsAuth: vi.fn(), createGoogleOAuthClient: vi.fn(),
}));

// Explicit template efa9a32 contract: do not derive expected headers from the generator.
const expected: Record<string, string[]> = {
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
    'availableFrom', 'dueAt', 'prerequisiteTaskId', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays',
  ],
  TaskAssignments: [
    'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
    'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
  ],
  TaskCompletions: [
    'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note',
    'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion',
    'operationId', 'operationPayloadHash',
  ],
  Promotions: [
    'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
    'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
  ],
  PromotionProducts: [
    'promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion',
  ],
  Recovery: ['key', 'value'],
};
const options = { appTitle: '학급 매점', bankTitle: '학급 은행', currencyUnit: '원', themeColor: 'blue', adminPasswordConfigured: false };

describe('latest generated-sheet contract with legacy type compatibility', () => {
  it('matches all eleven latest headers exactly while retaining Recovery in legacy SheetName', () => {
    const legacyRecovery: SheetName = 'Recovery';
    expect(legacyRecovery).toBe('Recovery');
    expect(REQUIRED_SHEETS).toEqual(expected);
    expect(Object.keys(REQUIRED_SHEETS)).toHaveLength(11);
    expect(REQUIRED_SHEETS.Tasks).toHaveLength(33);
  });
  it('initializes schema 4, system 0.4.1, timezone and manual QR defaults', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(4);
    expect(SYSTEM_VERSION).toBe('0.4.1');
    expect(DEFAULT_SETTINGS).toEqual(expect.arrayContaining([
      { key: 'schemaVersion', value: '4' }, { key: 'systemVersion', value: '0.4.1' },
      { key: 'classTimeZone', value: 'Asia/Seoul' }, { key: 'qrManualInputEnabled', value: 'FALSE' },
    ]));
  });
  it('keeps a real Recovery header and sizes the metadata range from its actual rows', () => {
    const ranges = buildSpreadsheetValueRanges(options, { recoveryCode: 'TEST-ONLY-CODE' });
    const recovery = ranges.filter(row => row.range.startsWith('Recovery!'));
    const last = recovery.at(-1)!;
    expect(last.values[0]).toEqual(['key', 'value']);
    expect(last.range).toBe(`Recovery!A1:B${last.values.length}`);
    expect(last.values.flat()).toContain('TEST-ONLY-CODE');
  });
  it('sends real create and batchUpdate payloads with room for every latest header', async () => {
    const result = await createClassRewardSpreadsheet(options, new Request('https://generator.example.test'));
    const payload = api.create.mock.calls.at(-1)![0] as { requestBody: { sheets: Array<{ properties: { title: string; gridProperties: { columnCount: number } } }> } };
    expect(payload.requestBody.sheets.map(sheet => sheet.properties.title)).toEqual(Object.keys(expected));
    for (const { properties } of payload.requestBody.sheets) {
      expect(properties.gridProperties?.columnCount).toBeGreaterThanOrEqual(expected[properties.title].length);
    }
    expect(payload.requestBody.sheets.find(sheet => sheet.properties.title === 'Tasks')?.properties.gridProperties.columnCount).toBe(33);
    const batch = api.batchUpdate.mock.calls.at(-1)![0] as { spreadsheetId: string; requestBody: { valueInputOption: string; data: Array<{ range: string; values: string[][] }> } };
    expect(batch.spreadsheetId).toBe('fake-sheet');
    expect(batch.requestBody.valueInputOption).toBe('RAW');
    for (const [name, headers] of Object.entries(expected)) {
      const writes = batch.requestBody.data.filter(row => row.range.startsWith(`${name}!A1:`));
      expect(writes.length).toBeGreaterThan(0);
      for (const write of writes) expect(write.values[0]).toEqual(headers);
    }
    expect(batch.requestBody.data.find(row => row.range === 'Tasks!A1:AG1')?.values[0]).toHaveLength(33);
    const settings = batch.requestBody.data.find(row => row.range.startsWith('Settings!A2:'))!;
    expect(settings.values).toEqual(expect.arrayContaining([['schemaVersion', '4'], ['systemVersion', '0.4.1'], ['classTimeZone', 'Asia/Seoul'], ['qrManualInputEnabled', 'FALSE']]));
    expect(result.initializedSheets).toEqual(Object.keys(expected));
  });
});
