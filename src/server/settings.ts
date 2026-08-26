import type { SheetsReader, SheetsStore } from '@/server/sheetsRepository';
import type { RecurringSchemaMigrationStore } from '@/server/storage/tabularStore';
import { changeClassTimeZone, type ClassTimeZoneChangeResult } from '@/server/repositories/sheets/taskScheduleCommands';
import { getSheetSettings, parseSheetSettingsRows, upsertSheetSettings } from '@/server/sheetsRepository';
import { createAdminPasswordHash, verifyAdminPasswordHash } from '@/server/adminAuth';
import { SYSTEM_NAME_KO, SYSTEM_VERSION } from '@/generator/config/versions';
import { normalizeFontFamily, type FontFamily } from '@/lib/fontSettings';
import { DEFAULT_CLASS_TIME_ZONE, normalizeLegacyTimeZone } from '@/domain/taskSchedule';
import { isValidNamedTimeZone } from '@/domain/timeZone';

export type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple' | 'white' | 'black' | 'navy';

export type AppSettings = {
  spreadsheetId: string;
  currencyUnit: string;
  appTitle: string;
  bankTitle: string;
  themeColor: ThemeColor;
  fontFamily: FontFamily;
  qrManualInputEnabled: boolean;
  classTimeZone: string;
  schemaVersion: number;
  systemVersion: string;
  systemName: string;
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
  appTitle?: string;
  bankTitle?: string;
  themeColor?: string;
  fontFamily?: string;
  qrManualInputEnabled?: boolean;
  classTimeZone?: string;
  env?: SettingsEnv;
};

type ValidationResult =
  | { ok: true; spreadsheetId: string }
  | { ok: false; message: string };

export type ClassTimeZoneValidationResult =
  | { ok: true; classTimeZone: string }
  | { ok: false; message: string };

const SHEETS_URL_ID_PATTERN = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
const PLAIN_ID_PATTERN = /^[a-zA-Z0-9-_]{8,}$/;
const DEFAULT_CURRENCY_UNIT = '원';
const DEFAULT_APP_TITLE = '학급 매점';
const DEFAULT_BANK_TITLE = '학급 은행';
const DEFAULT_THEME_COLOR: ThemeColor = 'white';
const LEGACY_DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_SYSTEM_VERSION = SYSTEM_VERSION;
const DEFAULT_SYSTEM_NAME = SYSTEM_NAME_KO;
const DEFAULT_QR_MANUAL_INPUT_ENABLED = false;
const THEME_COLORS = new Set<ThemeColor>(['blue', 'pink', 'yellow', 'green', 'purple', 'white', 'black', 'navy']);

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

export function validateClassTimeZone(value: unknown): ClassTimeZoneValidationResult {
  const classTimeZone = typeof value === 'string' ? value.trim() : '';
  if (!isValidNamedTimeZone(classTimeZone)) {
    return { ok: false, message: '올바른 IANA 시간대를 입력해 주세요.' };
  }
  return { ok: true, classTimeZone };
}

export async function updateClassTimeZone(
  store: RecurringSchemaMigrationStore,
  value: unknown,
): Promise<ClassTimeZoneChangeResult> {
  const validation = validateClassTimeZone(value);
  if (validation.ok === false) throw new Error(validation.message);
  return changeClassTimeZone(store, validation.classTimeZone);
}

export function getEnvSpreadsheetId(env: SettingsEnv = process.env): string {
  return env.GOOGLE_SHEET_ID?.trim() ?? '';
}

export async function getAppSettings(options: SettingsOptions = {}): Promise<AppSettings> {
  const envSpreadsheetId = getEnvSpreadsheetId(options.env ?? process.env);

  if (!envSpreadsheetId) {
    return defaultAppSettings('', 'unset');
  }

  if (options.settingsReader) {
    try {
      const sheetSettings = await getSheetSettings(options.settingsReader);
      return {
        spreadsheetId: envSpreadsheetId,
        currencyUnit: normalizeCurrencyUnit(sheetSettings.currencyUnit),
        appTitle: normalizeAppTitle(sheetSettings.appTitle),
        bankTitle: normalizeBankTitle(sheetSettings.bankTitle),
        themeColor: normalizeThemeColor(sheetSettings.themeColor),
        fontFamily: normalizeFontFamily(sheetSettings.fontFamily),
        qrManualInputEnabled: normalizeQrManualInputEnabled(sheetSettings.qrManualInputEnabled),
        classTimeZone: normalizeLegacyTimeZone(sheetSettings.classTimeZone),
        schemaVersion: normalizeSchemaVersion(sheetSettings.schemaVersion),
        systemVersion: normalizeSystemVersion(sheetSettings.systemVersion),
        systemName: normalizeSystemName(sheetSettings.systemName),
        source: 'sheet',
        ...(sheetSettings.adminPasswordHash ? { adminPasswordConfigured: true } : {}),
      };
    } catch (error) {
      if (isMissingSettingsSheetError(error)) {
        return defaultAppSettings(envSpreadsheetId, 'env');
      }
      throw error;
    }
  }

  return defaultAppSettings(envSpreadsheetId, 'env');
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
  const appTitle = normalizeAppTitle(options.appTitle);
  const bankTitle = normalizeBankTitle(options.bankTitle);
  const themeColor = normalizeThemeColor(options.themeColor);
  const fontFamily = normalizeFontFamily(options.fontFamily);
  const qrManualInputEnabled = normalizeQrManualInputEnabled(options.qrManualInputEnabled);
  const settingsRows = await options.settingsStore.getRows('Settings');
  const existingSettings = parseSheetSettingsRows(settingsRows);
  const submittedAdminPassword = options.adminPassword?.trim() ?? '';
  const existingAdminPasswordHash = existingSettings.adminPasswordHash?.trim() ?? '';
  const passwordSettings = [];
  if (submittedAdminPassword) {
    if (submittedAdminPassword.length < 4) throw new Error('관리자 암호는 4자 이상으로 입력해 주세요.');
    if (!existingAdminPasswordHash
      || !verifyAdminPasswordHash(submittedAdminPassword, existingAdminPasswordHash)) {
      passwordSettings.push({
        key: 'adminPasswordHash',
        value: createAdminPasswordHash(submittedAdminPassword),
      });
    }
  }
  const schemaVersion = normalizeSchemaVersion(existingSettings.schemaVersion);
  let classTimeZone: string;
  if (options.classTimeZone === undefined) {
    classTimeZone = normalizeLegacyTimeZone(existingSettings.classTimeZone);
  } else {
    const classTimeZoneValidation = validateClassTimeZone(options.classTimeZone);
    if (classTimeZoneValidation.ok === false) throw new Error(classTimeZoneValidation.message);
    classTimeZone = classTimeZoneValidation.classTimeZone;
  }
  await upsertSheetSettings(options.settingsStore, settingsRows, [
    { key: 'currencyUnit', value: currencyUnit },
    { key: 'appTitle', value: appTitle },
    { key: 'bankTitle', value: bankTitle },
    { key: 'themeColor', value: themeColor },
    { key: 'fontFamily', value: fontFamily },
    { key: 'qrManualInputEnabled', value: qrManualInputEnabled ? 'TRUE' : 'FALSE' },
    ...(options.classTimeZone === undefined ? [] : [{ key: 'classTimeZone', value: classTimeZone }]),
    { key: 'schemaVersion', value: String(schemaVersion) },
    { key: 'systemVersion', value: DEFAULT_SYSTEM_VERSION },
    { key: 'systemName', value: DEFAULT_SYSTEM_NAME },
    ...passwordSettings,
  ]);

  return {
    spreadsheetId: configuredSpreadsheetId,
    currencyUnit,
    appTitle,
    bankTitle,
    themeColor,
    fontFamily,
    qrManualInputEnabled,
    classTimeZone,
    schemaVersion,
    systemVersion: DEFAULT_SYSTEM_VERSION,
    systemName: DEFAULT_SYSTEM_NAME,
    source: 'sheet',
    ...(existingAdminPasswordHash || submittedAdminPassword ? { adminPasswordConfigured: true } : {}),
  };
}

export function normalizeCurrencyUnit(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CURRENCY_UNIT;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 12) : DEFAULT_CURRENCY_UNIT;
}

export function normalizeAppTitle(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_APP_TITLE;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 30) : DEFAULT_APP_TITLE;
}

export function normalizeBankTitle(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BANK_TITLE;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 30) : DEFAULT_BANK_TITLE;
}

export function normalizeQrManualInputEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return DEFAULT_QR_MANUAL_INPUT_ENABLED;
  const trimmed = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'enabled', '허용', '켜기'].includes(trimmed)) return true;
  if (['false', '0', 'no', 'n', 'off', 'disabled', '차단', '끄기'].includes(trimmed)) return false;
  return DEFAULT_QR_MANUAL_INPUT_ENABLED;
}

export function normalizeSchemaVersion(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : LEGACY_DEFAULT_SCHEMA_VERSION;
}

export function normalizeSystemVersion(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SYSTEM_VERSION;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 40) : DEFAULT_SYSTEM_VERSION;
}

export function normalizeSystemName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SYSTEM_NAME;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 30) : DEFAULT_SYSTEM_NAME;
}

function defaultAppSettings(spreadsheetId: string, source: AppSettings['source']): AppSettings {
  return {
    spreadsheetId,
    currencyUnit: DEFAULT_CURRENCY_UNIT,
    appTitle: DEFAULT_APP_TITLE,
    bankTitle: DEFAULT_BANK_TITLE,
    themeColor: DEFAULT_THEME_COLOR,
    fontFamily: 'default',
    qrManualInputEnabled: DEFAULT_QR_MANUAL_INPUT_ENABLED,
    classTimeZone: DEFAULT_CLASS_TIME_ZONE,
    schemaVersion: LEGACY_DEFAULT_SCHEMA_VERSION,
    systemVersion: DEFAULT_SYSTEM_VERSION,
    systemName: DEFAULT_SYSTEM_NAME,
    source,
  };
}

function isMissingSettingsSheetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Settings|Unable to parse range|not found/i.test(error.message);
}

export function normalizeThemeColor(value: unknown): ThemeColor {
  if (typeof value !== 'string') return DEFAULT_THEME_COLOR;
  const trimmed = value.trim() as ThemeColor;
  return THEME_COLORS.has(trimmed) ? trimmed : DEFAULT_THEME_COLOR;
}
