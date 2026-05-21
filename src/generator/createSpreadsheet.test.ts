import { describe, expect, it } from 'vitest';
import { buildSpreadsheetValueRanges } from './createSpreadsheet';

describe('spreadsheet recovery metadata', () => {
  it('creates a Recovery sheet body with the plain recovery code and stores only its hash in Settings', () => {
    const ranges = buildSpreadsheetValueRanges(
      {
        appTitle: '학급 매점',
        bankTitle: '학급 은행',
        currencyUnit: '원',
        themeColor: 'blue',
        adminPasswordConfigured: false,
        className: '4학년 1반',
      },
      { ownerEmail: 'teacher@example.com', recoveryCode: 'ABCD-1234-EFGH-5678' },
    );

    const recoveryRange = ranges.find((range) => range.range === 'Recovery!A1:B8');
    expect(recoveryRange?.values.flat()).toEqual(expect.arrayContaining(['recoveryCode', 'ABCD-1234-EFGH-5678', 'teacher@example.com']));

    const settingsRange = ranges.find((range) => range.range.startsWith('Settings!A2:B'));
    expect(settingsRange?.values.flat()).toContain('ownerEmail');
    expect(settingsRange?.values.flat()).toContain('teacher@example.com');
    expect(settingsRange?.values.flat()).toContain('recoveryCodeHash');
    expect(settingsRange?.values.flat()).not.toContain('ABCD-1234-EFGH-5678');
  });
});
