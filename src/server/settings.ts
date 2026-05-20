import type { SheetsReader, SheetsStore } from '@/server/sheetsRepository';
import { getSheetSettings, saveSheetSetting } from '@/server/sheetsRepository';
import { saveAdminPassword } from '@/server/adminAuth';

export type AppSettings = {
  spreadsheetId: string;
  currencyUnit: string;
  source: 'sheet' | 'env' | 'unset';
  adminPasswordConfigured?: boolean;
};

type SettingsEnv = { [key: string]: string | undefined; GOOGLE_SHEET_ID?: string };

type SettingsOptions = {
  env?: SettingsEnv;
  settingsReader?: SheetsReader;
};

type SaveSettingsOptions = {
  settingsStore: SheetsStore;
  spreadsheetIdOrUrl: string;
  currencyUnit?: string;
  adminPassword?: string;
  env?: SettingsEnv;
};

type ValidationResult =
  | { ok: true; spreadsheetId: string }
  | { ok: false; message: string };

const SHEETS_URL_ID_PATTERN = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
const PLAIN_ID_PATTERN = /^[a-zA-Z0-9-_]{8,}$/;
const DEFAULT_CURRENCY_UNIT = '원';

export function extractSpreadsheetId(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) return null;

  const urlMatch = trimmed.match(SHEETS_URL_ID_PATTERN);
  if (urlMatch?.[1]) return urlMatch[1];

  if (PLAIN_ID_PATTERN.test(trimmed)) return trimmed;

  return null;
}

export function validateSpreadsheetId(value: string): ValidationResult {
  if (!value.trim()) {
    return { ok: false, message: '시트 ID를 입력해 주세요.' };
  }

  const spreadsheetId = extractSpreadsheetId(value);

  if (!spreadsheetId) {
    return { ok: false, message: '올바른 Google Sheets 주소 또는 시트 ID가 아닙니다.' };
  }

  return { ok: true, spreadsheetId };
}

export function getEnvSpreadsheetId(env: SettingsEnv = process.env): string {
  return env.GOOGLE_SHEET_ID?.trim() ?? '';
}

export async function getAppSettings(options: SettingsOptions = {}): Promise<AppSettings> {
  const envSpreadsheetId = getEnvSpreadsheetId(options.env ?? process.env);

  if (!envSpreadsheetId) {
    return { spreadsheetId: '', currencyUnit: DEFAULT_CURRENCY_UNIT, source: 'unset' };
  }

  if (options.settingsReader) {
    try {
      const sheetSettings = await getSheetSettings(options.settingsReader);
      return {
        spreadsheetId: envSpreadsheetId,
        currencyUnit: normalizeCurrencyUnit(sheetSettings.currencyUnit),
        source: 'sheet',
        ...(sheetSettings.adminPasswordHash ? { adminPasswordConfigured: true } : {}),
      };
    } catch (error) {
      if (isMissingSettingsSheetError(error)) {
        return { spreadsheetId: envSpreadsheetId, currencyUnit: DEFAULT_CURRENCY_UNIT, source: 'env' };
      }
      throw error;
    }
  }

  return { spreadsheetId: envSpreadsheetId, currencyUnit: DEFAULT_CURRENCY_UNIT, source: 'env' };
}

export async function saveAppSettings(options: SaveSettingsOptions): Promise<AppSettings> {
  const configuredSpreadsheetId = getEnvSpreadsheetId(options.env ?? process.env);
  const validation = validateSpreadsheetId(options.spreadsheetIdOrUrl);

  if (validation.ok === false) {
    throw new Error(validation.message);
  }

  if (!configuredSpreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다. Vercel 환경변수에 기본 시트 ID를 등록해 주세요.');
  }

  if (validation.spreadsheetId !== configuredSpreadsheetId) {
    throw new Error('Vercel 배포판에서는 시트 ID를 관리자 화면에서 영구 변경할 수 없습니다. Vercel의 GOOGLE_SHEET_ID 환경변수를 변경한 뒤 재배포해 주세요.');
  }

  const currencyUnit = normalizeCurrencyUnit(options.currencyUnit);
  await saveSheetSetting(options.settingsStore, { key: 'currencyUnit', value: currencyUnit });
  if (options.adminPassword?.trim()) {
    await saveAdminPassword(options.settingsStore, options.adminPassword);
  }

  return {
    spreadsheetId: configuredSpreadsheetId,
    currencyUnit,
    source: 'sheet',
    ...(options.adminPassword?.trim() ? { adminPasswordConfigured: true } : {}),
  };
}

export function normalizeCurrencyUnit(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CURRENCY_UNIT;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 12) : DEFAULT_CURRENCY_UNIT;
}

function isMissingSettingsSheetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Settings|Unable to parse range|not found/i.test(error.message);
}
