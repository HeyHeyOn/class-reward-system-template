import { describe, expect, it } from 'vitest';
import {
  extractSpreadsheetId,
  getAppSettings,
  saveAppSettings,
  validateSpreadsheetId,
} from '@/server/settings';
import type { SheetName } from '@/server/sheetsRepository';

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

    expect(settings).toEqual({ spreadsheetId: 'env-sheet-id', currencyUnit: '원', appTitle: '학급 매점', themeColor: 'blue', source: 'env' });
  });

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
            ['themeColor', 'purple'],
          ];
        },
      },
    });

    expect(settings).toEqual({ spreadsheetId: 'env-sheet-id', currencyUnit: '별', appTitle: '햇살반 매점', themeColor: 'purple', source: 'sheet' });
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

  it('saves currency unit and app title to Settings sheet and rejects changing deployment spreadsheet id', async () => {
    const updates: Array<{ sheetName: SheetName; rowNumber: number; columnName: string; value: string | number }> = [];
    const appends: Array<{ sheetName: SheetName; values: string[] }> = [];
    const settingsStore = {
      async getRows(sheetName: SheetName) {
        expect(sheetName).toBe('Settings');
        return [
          ['key', 'value'],
          ['currencyUnit', '원'],
        ];
      },
      async updateCell(sheetName: SheetName, rowNumber: number, columnName: string, value: string | number) {
        updates.push({ sheetName, rowNumber, columnName, value });
      },
      async appendRow(sheetName: SheetName, values: string[]) {
        appends.push({ sheetName, values });
      },
    };

    await expect(
      saveAppSettings({
        settingsStore,
        spreadsheetIdOrUrl: 'env-sheet-id',
        currencyUnit: '달란트',
        appTitle: '햇살반 매점',
        themeColor: 'green',
        env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
      }),
    ).resolves.toEqual({ spreadsheetId: 'env-sheet-id', currencyUnit: '달란트', appTitle: '햇살반 매점', themeColor: 'green', source: 'sheet' });

    expect(updates).toEqual([{ sheetName: 'Settings', rowNumber: 2, columnName: 'value', value: '달란트' }]);
    expect(appends).toEqual([
      { sheetName: 'Settings', values: ['appTitle', '햇살반 매점'] },
      { sheetName: 'Settings', values: ['themeColor', 'green'] },
    ]);

    await expect(
      saveAppSettings({
        settingsStore,
        spreadsheetIdOrUrl: 'other-sheet-id',
        currencyUnit: '별',
        env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
      }),
    ).rejects.toThrow('Vercel 배포판에서는 시트 ID를 관리자 화면에서 영구 변경할 수 없습니다.');
  });
});
