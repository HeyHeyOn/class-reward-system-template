import { createHash, randomBytes } from 'node:crypto';
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
  recoveryCode: string;
  ownerEmail?: string;
  authMode: 'google-login' | 'deployment-oauth' | 'service-account';
};

type RecoveryMetadata = {
  ownerEmail?: string;
  recoveryCode: string;
};

export function buildSpreadsheetTitle(options: ClassRewardInstanceOptions): string {
  const prefix = options.className?.trim() || options.appTitle.trim() || '학급 보상 시스템';
  return `${prefix} - 학급 보상 시스템`;
}

export function buildSpreadsheetValueRanges(options: ClassRewardInstanceOptions, recovery?: RecoveryMetadata) {
  const settings = recovery ? withRecoverySettings(buildSettingsRows(options), recovery) : buildSettingsRows(options);
  const recoveryRows = recovery ? buildRecoveryRows(recovery) : [];
  return [
    ...Object.entries(REQUIRED_SHEETS).map(([name, columns]) => ({
      range: `${name}!A1:${columnIndexToLetter(columns.length - 1)}1`,
      values: [columns],
    })),
    {
      range: `Settings!A2:B${settings.length + 1}`,
      values: settings.map((row) => [row.key, row.value]),
    },
    ...(recovery
      ? [
          {
            range: 'Recovery!A1:B8',
            values: recoveryRows,
          },
        ]
      : []),
  ];
}

export async function createClassRewardSpreadsheet(optionsInput: Partial<ClassRewardInstanceOptions>, request: Request): Promise<GeneratedSpreadsheet> {
  const options = normalizeClassRewardCreateOptions(optionsInput);
  const { auth, authMode, ownerEmail } = createGeneratorSheetsAuth(request);
  const recovery: RecoveryMetadata = { ownerEmail, recoveryCode: generateRecoveryCode() };
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

  const settings = withRecoverySettings(buildSettingsRows(options), recovery);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: buildSpreadsheetValueRanges(options, recovery),
    },
  });

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    title,
    initializedSheets: sheetNames,
    settings,
    recoveryCode: recovery.recoveryCode,
    ownerEmail: recovery.ownerEmail,
    authMode,
  };
}

function withRecoverySettings(settings: Array<{ key: string; value: string }>, recovery: RecoveryMetadata) {
  return [
    ...settings,
    ...(recovery.ownerEmail ? [{ key: 'ownerEmail', value: recovery.ownerEmail }] : []),
    { key: 'recoveryCodeHash', value: hashRecoveryCode(recovery.recoveryCode) },
  ];
}

function buildRecoveryRows(recovery: RecoveryMetadata) {
  return [
    ['학급 보상 시스템 복구 코드', ''],
    ['안내', '관리자 비밀번호를 잊었을 때 아래 recoveryCode 값을 입력하세요.'],
    ['주의', '이 탭은 관리자 전용입니다. 학생 또는 외부인에게 공유하지 마세요.'],
    ['ownerEmail', recovery.ownerEmail ?? ''],
    ['recoveryCode', recovery.recoveryCode],
    ['createdAt', new Date().toISOString()],
    ['사용 위치', '관리자 로그인 화면 > 비밀번호를 잊으셨나요?'],
    ['재발급 안내', '복구 코드를 노출했다면 관리자 화면에서 새 비밀번호와 복구 코드를 재설정하세요.'],
  ];
}

export function generateRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = Array.from(randomBytes(16), (byte) => alphabet[byte % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12), chars.slice(12, 16)].map((part) => part.join('')).join('-');
}

function hashRecoveryCode(value: string): string {
  return createHash('sha256').update(value.trim().toUpperCase()).digest('hex');
}

function createGeneratorSheetsAuth(request: Request) {
  if (isGoogleOAuthEnabled()) {
    const origin = new URL(request.url).origin;
    const userAuth = createUserSheetsAuth(request, origin);
    if (userAuth) return { auth: userAuth.auth, authMode: 'google-login' as const, ownerEmail: userAuth.session.email };
    throw new Error('선생님 개인 Google 계정 로그인이 필요합니다. 먼저 Google 로그인 후 다시 생성해 주세요.');
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
