import { google } from 'googleapis';
import { createDeploymentSheetsAuth, createGoogleOAuthClient, createUserSheetsAuth, isGoogleOAuthEnabled } from '@/server/googleOAuth';
import { buildSettingsRows, normalizeClassRewardCreateOptions } from './createOptions.ts';
import { REQUIRED_SHEETS } from './config/schema.ts';
import type { ClassRewardInstanceOptions } from './types.ts';

export type GeneratedSpreadsheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  initializedSheets: string[];
  settings: Array<{ key: string; value: string }>;
  authMode: 'google-login' | 'deployment-oauth' | 'service-account';
};

export function buildSpreadsheetTitle(options: ClassRewardInstanceOptions): string {
  const prefix = options.className?.trim() || options.appTitle.trim() || '학급 보상 시스템';
  return `${prefix} - 학급 보상 시스템`;
}

export function buildSpreadsheetValueRanges(options: ClassRewardInstanceOptions) {
  const settings = buildSettingsRows(options);
  return [
    ...Object.entries(REQUIRED_SHEETS).map(([name, columns]) => ({
      range: `${name}!A1:${columnIndexToLetter(columns.length - 1)}1`,
      values: [columns],
    })),
    {
      range: `Settings!A2:B${settings.length + 1}`,
      values: settings.map((row) => [row.key, row.value]),
    },
  ];
}

export async function createClassRewardSpreadsheet(optionsInput: Partial<ClassRewardInstanceOptions>, request: Request): Promise<GeneratedSpreadsheet> {
  const options = normalizeClassRewardCreateOptions(optionsInput);
  const { auth, authMode } = createGeneratorSheetsAuth(request);
  const sheets = google.sheets({ version: 'v4', auth });
  const title = buildSpreadsheetTitle(options);
  const sheetNames = Object.keys(REQUIRED_SHEETS);

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheetNames.map((sheetName) => ({ properties: { title: sheetName } })),
    },
  });

  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error('Google Sheets 생성 결과에서 spreadsheetId를 받지 못했습니다.');

  const settings = buildSettingsRows(options);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: buildSpreadsheetValueRanges(options),
    },
  });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    title,
    initializedSheets: sheetNames,
    settings,
    authMode,
  };
}

function createGeneratorSheetsAuth(request: Request) {
  if (isGoogleOAuthEnabled()) {
    const origin = new URL(request.url).origin;
    const userAuth = createUserSheetsAuth(request, origin);
    if (userAuth) return { auth: userAuth.auth, authMode: 'google-login' as const };
  }

  const deploymentAuth = createDeploymentSheetsAuth();
  if (deploymentAuth) return { auth: deploymentAuth, authMode: 'deployment-oauth' as const };

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.split(String.raw`\n`).join('\n');
  if (email && privateKey) {
    return {
      auth: new google.auth.JWT({
        email,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
      }),
      authMode: 'service-account' as const,
    };
  }

  if (isGoogleOAuthEnabled()) {
    throw new Error('Google 로그인이 필요합니다. 먼저 Google 계정으로 로그인한 뒤 다시 생성해 주세요.');
  }

  // Throws the existing, user-facing OAuth env error.
  createGoogleOAuthClient(new URL(request.url).origin);
  throw new Error('Google Sheets 생성 인증을 준비하지 못했습니다.');
}

function columnIndexToLetter(index: number): string {
  let dividend = index + 1;
  let columnName = '';

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return columnName;
}
