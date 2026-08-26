import { describe, expect, it } from 'vitest';
import {
  extractSpreadsheetId,
  getAppSettings,
  saveAppSettings,
  validateClassTimeZone,
  validateSpreadsheetId,
} from '@/server/settings';
import type { SheetName, SheetsReader, SheetsStore } from '@/server/sheetsRepository';
import { SYSTEM_VERSION } from '@/generator/config/versions';
import { createAdminPasswordHash, verifyAdminPasswordHash } from '@/server/adminAuth';

describe('settings', () => {
  it('extracts spreadsheet id from a plain id or Google Sheets URL', () => {
    const id = '1AbC_defGhijKlmnopQRstuVwxyz-1234567890';

    expect(extractSpreadsheetId(id)).toBe(id);
    expect(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
  });

  it('rejects invalid spreadsheet id values', () => {
    expect(validateSpreadsheetId('')).toEqual({ ok: false, message: '시트 ID를 입력해 주세요.' });
    expect(validateSpreadsheetId('https://example.com/not-a-sheet')).toEqual({
      ok: false,
      message: '올바른 Google Sheets 주소 또는 시트 ID가 아닙니다.',
    });
  });

  it('uses env spreadsheet id and default currency unit when Settings sheet is unavailable', async () => {
    const settings = await getAppSettings({ env: { GOOGLE_SHEET_ID: 'env-sheet-id' } });

    expect(settings).toEqual({ spreadsheetId: 'env-sheet-id', currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false, classTimeZone: 'Asia/Seoul', schemaVersion: 1, systemVersion: SYSTEM_VERSION, systemName: '학급 보상 시스템', source: 'env' });
  });

  it('uses legacy schema version 1 when the deployment spreadsheet id is unset', async () => {
    const settings = await getAppSettings({ env: {} });

    expect(settings.schemaVersion).toBe(1);
    expect(settings.source).toBe('unset');
  });

  it('uses legacy schema version 1 when the Settings sheet is missing', async () => {
    const settings = await getAppSettings({
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
      settingsReader: {
        async getRows() {
          throw new Error('Unable to parse range: Settings!A:B');
        },
      },
    });

    expect(settings.schemaVersion).toBe(1);
    expect(settings.source).toBe('env');
  });

  it.each([undefined, '', 'not-a-version', '2oops', '2.5', '0', '-1'])(
    'uses legacy schema version 1 when the Settings schemaVersion is missing or invalid: %s',
    async (schemaVersion) => {
      const settings = await getAppSettings({
        env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
        settingsReader: {
          async getRows() {
            return [
              ['key', 'value'],
              ...(schemaVersion === undefined ? [] : [['schemaVersion', schemaVersion]]),
            ];
          },
        },
      });

      expect(settings.schemaVersion).toBe(1);
      expect(settings.source).toBe('sheet');
    },
  );

  it('reads currency unit and app title from Settings sheet when present', async () => {
    const settings = await getAppSettings({
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
      settingsReader: {
        async getRows(sheetName: SheetName) {
          expect(sheetName).toBe('Settings');
          return [
            ['key', 'value'],
            ['currencyUnit', '별'],
            ['appTitle', '햇살반 매점'],
            ['bankTitle', '햇살반 은행'],
            ['themeColor', 'purple'],
            ['fontFamily', 'school-safe-notice'],
            ['qrManualInputEnabled', 'TRUE'],
            ['classTimeZone', 'America/New_York'],
            ['schemaVersion', '7'],
            ['systemVersion', '0.2.0-phase1'],
            ['systemName', '햇살반 보상 시스템'],
          ];
        },
      },
    });

    expect(settings).toEqual({ spreadsheetId: 'env-sheet-id', currencyUnit: '별', appTitle: '햇살반 매점', bankTitle: '햇살반 은행', themeColor: 'purple', fontFamily: 'school-safe-notice', qrManualInputEnabled: true, classTimeZone: 'America/New_York', schemaVersion: 7, systemVersion: '0.2.0-phase1', systemName: '햇살반 보상 시스템', source: 'sheet' });
  });

  it('accepts white, black, and navy theme colors from Settings sheet', async () => {
    for (const themeColor of ['white', 'black', 'navy'] as const) {
      const settings = await getAppSettings({
        env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
        settingsReader: {
          async getRows() {
            return [
              ['key', 'value'],
              ['themeColor', themeColor],
            ];
          },
        },
      });

      expect(settings.themeColor).toBe(themeColor);
    }
  });

  it('falls back invalid legacy class time zones on read without writing', async () => {
    const settingsReader: SheetsReader = {
      async getRows() { return [['key', 'value'], ['classTimeZone', '+09:00']]; },
    };
    const settings = await getAppSettings({
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
      settingsReader,
    });
    expect(settings.classTimeZone).toBe('Asia/Seoul');
  });

  it.each(['Mars/Olympus', '+09:00', '-0500', ''])('rejects invalid new class time zone %s', (value) => {
    expect(validateClassTimeZone(value).ok).toBe(false);
  });

  it.each(['Asia/Seoul', 'America/New_York', 'UTC', 'Etc/GMT+9'])('accepts named IANA class time zone %s', (value) => {
    expect(validateClassTimeZone(value)).toEqual({ ok: true, classTimeZone: value });
  });

  it('reads Settings once, batches changed values, and minimally appends missing keys', async () => {
    let reads = 0;
    const updates: Array<{ sheetName: SheetName; rowNumber: number; columnName: string; value: string | number }> = [];
    const appendedBatches: Array<{ sheetName: SheetName; rows: string[][] }> = [];
    const settingsStore: SheetsStore = {
      async getRows(sheetName: SheetName) {
        reads += 1;
        expect(sheetName).toBe('Settings');
        return [
          ['key', ' value ', 'unknown'],
          ['currencyUnit', '원'],
        ];
      },
      async updateCell(sheetName: SheetName, rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async updateCells(sheetName, batch) {
        updates.push(...batch.map((update) => ({ sheetName, ...update })));
      },
      async appendRow(sheetName: SheetName, values: string[]) {
        appendedBatches.push({ sheetName, rows: [values] });
      },
      async appendRows(sheetName, rows) {
        appendedBatches.push({ sheetName, rows });
      },
    };

    await expect(
      saveAppSettings({
        settingsStore,
        spreadsheetIdOrUrl: 'env-sheet-id',
        currencyUnit: '달란트',
        appTitle: '햇살반 매점',
        bankTitle: '햇살반 은행',
        themeColor: 'green',
        fontFamily: 'school-safe-board-marker',
        qrManualInputEnabled: true,
        classTimeZone: 'Asia/Tokyo',
        env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
      }),
    ).resolves.toEqual({ spreadsheetId: 'env-sheet-id', currencyUnit: '달란트', appTitle: '햇살반 매점', bankTitle: '햇살반 은행', themeColor: 'green', fontFamily: 'school-safe-board-marker', qrManualInputEnabled: true, classTimeZone: 'Asia/Tokyo', schemaVersion: 1, systemVersion: SYSTEM_VERSION, systemName: '학급 보상 시스템', source: 'sheet' });

    expect(reads).toBe(1);
    expect(updates).toEqual([{ sheetName: 'Settings', rowNumber: 2, columnName: ' value ', value: '달란트' }]);
    expect(appendedBatches).toEqual([{ sheetName: 'Settings', rows: [
      ['appTitle', '햇살반 매점', ''],
      ['bankTitle', '햇살반 은행', ''],
      ['themeColor', 'green', ''],
      ['fontFamily', 'school-safe-board-marker', ''],
      ['qrManualInputEnabled', 'TRUE', ''],
      ['classTimeZone', 'Asia/Tokyo', ''],
      ['schemaVersion', '1', ''],
      ['systemVersion', SYSTEM_VERSION, ''],
      ['systemName', '학급 보상 시스템', ''],
    ] }]);

    await expect(
      saveAppSettings({
        settingsStore,
        spreadsheetIdOrUrl: 'other-sheet-id',
        currencyUnit: '별',
        env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
      }),
    ).rejects.toThrow('Vercel 배포판에서는 시트 ID를 관리자 화면에서 영구 변경할 수 없습니다.');
  });

  it('preserves an existing class time zone when an older settings route omits it', async () => {
    const timeZoneWrites: string[] = [];
    const settingsStore: SheetsStore = {
      async getRows() {
        return [['key', 'value'], ['classTimeZone', 'America/New_York']];
      },
      async updateCell(_sheetName: SheetName, rowNumber: number, _columnName: string, value: string | number) {
        if (rowNumber === 2) timeZoneWrites.push(String(value));
      },
      async appendRow(_sheetName: SheetName, values: string[]) {
        if (values[0] === 'classTimeZone') timeZoneWrites.push(values[1]);
      },
    };

    const result = await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      appTitle: '제목만 변경',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(result.classTimeZone).toBe('America/New_York');
    expect(timeZoneWrites).toEqual([]);
  });

  it.each([
    ['2', 2],
    ['1', 1],
    ['future', 1],
  ])('preserves valid schemaVersion %s on ordinary settings save and defaults invalid legacy to %i', async (storedVersion, expectedVersion) => {
    const schemaWrites: string[] = [];
    let reads = 0;
    const settingsStore: SheetsStore = {
      async getRows() {
        reads += 1;
        return [['key', 'value'], ['classTimeZone', 'America/New_York'], ['schemaVersion', storedVersion]];
      },
      async updateCell(_sheetName, rowNumber, _columnName, value) {
        if (rowNumber === 3) schemaWrites.push(String(value));
      },
      async appendRow(_sheetName, values) {
        if (values[0] === 'schemaVersion') schemaWrites.push(values[1]);
      },
    };

    const result = await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      appTitle: '일반 설정 변경',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(result.classTimeZone).toBe('America/New_York');
    expect(result.schemaVersion).toBe(expectedVersion);
    expect(schemaWrites).toEqual(storedVersion === String(expectedVersion) ? [] : [String(expectedVersion)]);
    expect(reads).toBe(1);
  });

  it('performs no write when every normalized setting and metadata value is unchanged', async () => {
    let reads = 0;
    let writes = 0;
    const settingsStore: SheetsStore = {
      async getRows() {
        reads += 1;
        return [['key', 'value'],
          ['currencyUnit', '원'], ['appTitle', '학급 매점'], ['bankTitle', '학급 은행'],
          ['themeColor', 'white'], ['fontFamily', 'default'], ['qrManualInputEnabled', 'FALSE'],
          ['classTimeZone', 'Asia/Seoul'], ['schemaVersion', '1'],
          ['systemVersion', SYSTEM_VERSION], ['systemName', '학급 보상 시스템']];
      },
      async updateCell() { writes += 1; },
      async updateCells() { writes += 1; },
      async appendRow() { writes += 1; },
      async appendRows() { writes += 1; },
    };

    await saveAppSettings({
      settingsStore, spreadsheetIdOrUrl: 'env-sheet-id', env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(reads).toBe(1);
    expect(writes).toBe(0);
  });

  it('batches a changed admin password into the same provider write as ordinary settings', async () => {
    const existingHash = createAdminPasswordHash('old-password');
    let reads = 0;
    let writes = 0;
    const updates: Array<{ rowNumber: number; columnName: string; value: string | number }> = [];
    const settingsStore: SheetsStore = {
      async getRows() {
        reads += 1;
        return completeSettingsRows([
          ['appTitle', '이전 제목'],
          ['adminPasswordHash', existingHash],
        ]);
      },
      async updateCell(_sheetName, rowNumber, columnName, value) {
        writes += 1;
        updates.push({ rowNumber, columnName, value });
      },
      async updateCells(_sheetName, batch) {
        writes += 1;
        updates.push(...batch);
      },
      async appendRow() { writes += 1; },
      async appendRows() { writes += 1; },
    };

    const result = await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      appTitle: '새 제목',
      adminPassword: 'new-password',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    const passwordUpdate = updates.find(({ rowNumber }) => rowNumber === 12);
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect(updates).toHaveLength(2);
    expect(passwordUpdate?.value).not.toBe('new-password');
    expect(verifyAdminPasswordHash('new-password', String(passwordUpdate?.value))).toBe(true);
    expect(result.adminPasswordConfigured).toBe(true);
  });

  it('does not rewrite an unchanged admin password hash', async () => {
    const existingHash = createAdminPasswordHash('same-password');
    let reads = 0;
    let writes = 0;
    const settingsStore: SheetsStore = {
      async getRows() {
        reads += 1;
        return completeSettingsRows([['adminPasswordHash', existingHash]]);
      },
      async updateCell() { writes += 1; },
      async updateCells() { writes += 1; },
      async appendRow() { writes += 1; },
      async appendRows() { writes += 1; },
    };

    const result = await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      adminPassword: 'same-password',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(reads).toBe(1);
    expect(writes).toBe(0);
    expect(result.adminPasswordConfigured).toBe(true);
  });

  it('preserves an existing admin password when the submitted password is blank', async () => {
    const existingHash = createAdminPasswordHash('kept-password');
    let writes = 0;
    const settingsStore: SheetsStore = {
      async getRows() { return completeSettingsRows([['adminPasswordHash', existingHash]]); },
      async updateCell() { writes += 1; },
      async updateCells() { writes += 1; },
      async appendRow() { writes += 1; },
      async appendRows() { writes += 1; },
    };

    const result = await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      adminPassword: '   ',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(writes).toBe(0);
    expect(result.adminPasswordConfigured).toBe(true);
  });

  it('appends a missing admin password hash with the settings batch', async () => {
    let writes = 0;
    const appended: string[][] = [];
    const settingsStore: SheetsStore = {
      async getRows() { return completeSettingsRows(); },
      async updateCell() { writes += 1; },
      async updateCells() { writes += 1; },
      async appendRow(_sheetName, row) { writes += 1; appended.push(row); },
      async appendRows(_sheetName, rows) { writes += 1; appended.push(...rows); },
    };

    await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      adminPassword: 'first-password',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(writes).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0][0]).toBe('adminPasswordHash');
    expect(verifyAdminPasswordHash('first-password', appended[0][1])).toBe(true);
  });

  it('safely replaces a malformed stored admin password hash', async () => {
    let replacement = '';
    const settingsStore: SheetsStore = {
      async getRows() { return completeSettingsRows([['adminPasswordHash', 'scrypt$broken']]); },
      async updateCell(_sheetName, _rowNumber, _columnName, value) { replacement = String(value); },
      async appendRow() { throw new Error('unexpected append'); },
    };

    await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      adminPassword: 'replacement-password',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(verifyAdminPasswordHash('replacement-password', replacement)).toBe(true);
  });

  it.each([undefined, '', '+09:00'])('returns the Seoul fallback without repairing omitted legacy time zone %s', async (legacyValue) => {
    const timeZoneWrites: string[] = [];
    const settingsStore: SheetsStore = {
      async getRows() {
        return [['key', 'value'], ...(legacyValue === undefined ? [] : [['classTimeZone', legacyValue]])];
      },
      async updateCell(_sheetName: SheetName, rowNumber: number, _columnName: string, value: string | number) {
        if (rowNumber === 2) timeZoneWrites.push(String(value));
      },
      async appendRow(_sheetName: SheetName, values: string[]) {
        if (values[0] === 'classTimeZone') timeZoneWrites.push(values[1]);
      },
    };

    const result = await saveAppSettings({
      settingsStore,
      spreadsheetIdOrUrl: 'env-sheet-id',
      appTitle: '제목만 변경',
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(result.classTimeZone).toBe('Asia/Seoul');
    expect(timeZoneWrites).toEqual([]);
  });
});

function completeSettingsRows(overrides: string[][] = []): string[][] {
  const values = new Map<string, string>([
    ['currencyUnit', '원'], ['appTitle', '학급 매점'], ['bankTitle', '학급 은행'],
    ['themeColor', 'white'], ['fontFamily', 'default'], ['qrManualInputEnabled', 'FALSE'],
    ['classTimeZone', 'Asia/Seoul'], ['schemaVersion', '1'],
    ['systemVersion', SYSTEM_VERSION], ['systemName', '학급 보상 시스템'],
  ]);
  for (const [key, value] of overrides) values.set(key, value);
  return [['key', 'value'], ...values.entries()];
}
