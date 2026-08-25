import { describe, expect, it } from 'vitest';
import { REQUIRED_SHEETS } from './config/schema';
import { buildSpreadsheetSheetDefinitions, buildSpreadsheetValueRanges } from './createSpreadsheet';

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

  it('creates all nine physical sheets with enough explicit grid columns', () => {
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
