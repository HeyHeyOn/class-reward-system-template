import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_SHEETS } from './config/schema';
import { buildSpreadsheetSheetDefinitions, buildSpreadsheetValueRanges, createGeneratorSheetsAuth } from './createSpreadsheet';

const OPTIONS = {
  appTitle: '학급 매점',
  bankTitle: '학급 은행',
  currencyUnit: '원',
  themeColor: 'blue' as const,
  adminPasswordConfigured: false,
  className: '4학년 1반',
};

const RECOVERY_CODE = 'ABCD-1234-EFGH-5678';

function columnIndexToLetter(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

describe('spreadsheet initialization values', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('authenticates generator Sheets calls as the consenting user rather than the deployment account', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', 'generator-client-id.apps.googleusercontent.com');
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_SECRET', 'generator-client-secret');
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'central-deployment-refresh-token');
    const request = new Request('https://generator.example/api/generator/create');

    const result = createGeneratorSheetsAuth(request, {
      purpose: 'generator',
      subject: 'google-subject-123',
      email: 'teacher@example.com',
      refreshToken: 'consenting-user-refresh-token',
      grantId: 'grant-id-that-is-at-least-thirty-two-characters',
      expiresAt: Date.now() + 600_000,
      clientFingerprint: 'a'.repeat(64),
      issuedAt: Date.now(),
    });

    expect(result.authMode).toBe('google-login');
    expect(result.ownerEmail).toBe('teacher@example.com');
    expect(result.auth.credentials.refresh_token).toBe('consenting-user-refresh-token');
    expect(result.auth.credentials.refresh_token).not.toBe(process.env.GOOGLE_REFRESH_TOKEN);
    expect(result.auth._clientId).toBe('generator-client-id.apps.googleusercontent.com');
  });

  it('does not use legacy Google client credentials for a generator grant', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'legacy-client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'legacy-client-secret');
    const issuedAt = Date.now();

    expect(() => createGeneratorSheetsAuth(new Request('https://generator.example/api/generator/create'), {
      purpose: 'generator', subject: 'google-subject-123', email: 'teacher@example.com',
      refreshToken: 'consenting-user-refresh-token', grantId: 'grant-id-that-is-at-least-thirty-two-characters',
      expiresAt: issuedAt + 600_000, clientFingerprint: 'a'.repeat(64), issuedAt,
    })).toThrow(/GENERATOR_GOOGLE_CLIENT_ID/);
  });

  it('includes a canonical header range for every required sheet', () => {
    const ranges = buildSpreadsheetValueRanges(OPTIONS);

    for (const [sheetName, columns] of Object.entries(REQUIRED_SHEETS)) {
      const lastColumn = columnIndexToLetter(columns.length - 1);
      expect(ranges).toContainEqual({
        range: `${sheetName}!A1:${lastColumn}1`,
        values: [columns],
      });
    }
  });

  it('creates all eleven physical sheets with enough explicit grid columns', () => {
    const definitions = buildSpreadsheetSheetDefinitions();
    expect(definitions.map(({ properties }) => properties.title)).toEqual(Object.keys(REQUIRED_SHEETS));
    for (const { properties } of definitions) {
      const name = properties.title as keyof typeof REQUIRED_SHEETS;
      expect(properties.gridProperties.columnCount).toBeGreaterThanOrEqual(REQUIRED_SHEETS[name].length);
    }
  });

  it('keeps the canonical Recovery header and plain recovery code only in Recovery data', () => {
    const ranges = buildSpreadsheetValueRanges(OPTIONS, {
      ownerEmail: 'teacher@example.com',
      recoveryCode: RECOVERY_CODE,
    });

    const recoveryRange = ranges.find((range) => range.range.startsWith('Recovery!A1:') && range.values.length > 1);
    expect(recoveryRange).toEqual({
      range: 'Recovery!A1:B9',
      values: [
        ['key', 'value'],
        ['학급 보상 시스템 복구 코드', ''],
        ['안내', '관리자 비밀번호를 잊었을 때 아래 recoveryCode 값을 입력하세요.'],
        ['주의', '이 탭은 관리자 전용입니다. 학생 또는 외부인에게 공유하지 마세요.'],
        ['ownerEmail', 'teacher@example.com'],
        ['recoveryCode', RECOVERY_CODE],
        ['createdAt', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)],
        ['사용 위치', '관리자 로그인 화면 > 비밀번호를 잊으셨나요?'],
        ['재발급 안내', '복구 코드를 노출했다면 관리자 화면에서 새 비밀번호와 복구 코드를 재설정하세요.'],
      ],
    });

    const rangesContainingPlainCode = ranges.filter((range) => range.values.flat().includes(RECOVERY_CODE));
    expect(rangesContainingPlainCode).toEqual([recoveryRange]);
  });

  it('stores only the recovery code hash, never the plain code, in Settings', () => {
    const ranges = buildSpreadsheetValueRanges(OPTIONS, {
      ownerEmail: 'teacher@example.com',
      recoveryCode: RECOVERY_CODE,
    });

    const settingsRange = ranges.find((range) => range.range.startsWith('Settings!A2:B'));
    const settingsRows = settingsRange?.values ?? [];
    expect(settingsRows).toContainEqual(['ownerEmail', 'teacher@example.com']);
    expect(settingsRows.filter(([key]) => key.startsWith('recoveryCode'))).toEqual([
      ['recoveryCodeHash', expect.stringMatching(/^[a-f0-9]{64}$/)],
    ]);
    expect(settingsRows.flat()).not.toContain(RECOVERY_CODE);
  });
});
