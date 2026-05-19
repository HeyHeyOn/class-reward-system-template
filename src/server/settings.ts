import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type AppSettings = {
  spreadsheetId: string;
  source: 'runtime' | 'env' | 'unset';
};

type SettingsEnv = Pick<NodeJS.ProcessEnv, 'GOOGLE_SHEET_ID'>;

type SettingsOptions = {
  settingsPath?: string;
  env?: SettingsEnv;
};

type SaveSettingsOptions = {
  settingsPath?: string;
  spreadsheetIdOrUrl: string;
};

type ValidationResult =
  | { ok: true; spreadsheetId: string }
  | { ok: false; message: string };

const DEFAULT_SETTINGS_PATH = join(process.cwd(), 'data', 'settings.json');
const SHEETS_URL_ID_PATTERN = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
const PLAIN_ID_PATTERN = /^[a-zA-Z0-9-_]{8,}$/;

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

export async function getAppSettings(options: SettingsOptions = {}): Promise<AppSettings> {
  const settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;
  const env = options.env ?? process.env;

  const runtimeSpreadsheetId = await readRuntimeSpreadsheetId(settingsPath);
  if (runtimeSpreadsheetId) {
    return { spreadsheetId: runtimeSpreadsheetId, source: 'runtime' };
  }

  const envSpreadsheetId = env.GOOGLE_SHEET_ID?.trim();
  if (envSpreadsheetId) {
    return { spreadsheetId: envSpreadsheetId, source: 'env' };
  }

  return { spreadsheetId: '', source: 'unset' };
}

export async function saveAppSettings(options: SaveSettingsOptions): Promise<AppSettings> {
  const settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;
  const validation = validateSpreadsheetId(options.spreadsheetIdOrUrl);

  if (validation.ok === false) {
    throw new Error(validation.message);
  }

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({ spreadsheetId: validation.spreadsheetId }, null, 2),
    'utf8',
  );

  return { spreadsheetId: validation.spreadsheetId, source: 'runtime' };
}

async function readRuntimeSpreadsheetId(settingsPath: string): Promise<string | null> {
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { spreadsheetId?: unknown };

    if (typeof parsed.spreadsheetId !== 'string') return null;

    return extractSpreadsheetId(parsed.spreadsheetId);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}
