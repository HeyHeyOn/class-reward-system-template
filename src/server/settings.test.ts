import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractSpreadsheetId,
  getAppSettings,
  saveAppSettings,
  validateSpreadsheetId,
} from '@/server/settings';

let settingsPath: string;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'class-store-settings-'));
  settingsPath = join(tempDir, 'settings.json');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

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

  it('uses env spreadsheet id when runtime settings file does not exist', async () => {
    const settings = await getAppSettings({
      settingsPath,
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(settings).toEqual({ spreadsheetId: 'env-sheet-id', source: 'env' });
  });

  it('saves normalized spreadsheet id and prefers runtime settings over env', async () => {
    const id = '1AbC_defGhijKlmnopQRstuVwxyz-1234567890';

    await saveAppSettings({
      settingsPath,
      spreadsheetIdOrUrl: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
    });

    const settings = await getAppSettings({
      settingsPath,
      env: { GOOGLE_SHEET_ID: 'env-sheet-id' },
    });

    expect(settings).toEqual({ spreadsheetId: id, source: 'runtime' });
  });
});
