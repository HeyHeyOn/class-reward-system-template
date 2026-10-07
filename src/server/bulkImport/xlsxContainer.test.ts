// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { assertSafeXlsxContainer } from './xlsxContainer';
import { BulkImportFileError } from './errors';
import {
  MACRO_CONTENT_TYPES,
  SPREADSHEET_CONTENT_TYPES,
  workbookBytes,
  zipBytes,
} from './testing/workbookFixtures';

vi.mock('server-only', () => ({}));

function refusal(bytes: Uint8Array): BulkImportFileError {
  try {
    assertSafeXlsxContainer(bytes);
  } catch (error) {
    if (error instanceof BulkImportFileError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const minimalWorkbook = '<?xml version="1.0"?><workbook/>';

describe('xlsx container guard', () => {
  it('accepts a real workbook written by exceljs', async () => {
    const bytes = await workbookBytes([{ name: '학생 명단', rows: [['학생 번호', '이름'], ['01', '김하늘']] }]);
    expect(() => assertSafeXlsxContainer(bytes)).not.toThrow();
  });

  it('refuses empty and oversized uploads', () => {
    expect(refusal(new Uint8Array()).message).toContain('빈 파일');
    const big = refusal(new Uint8Array(2 * 1024 * 1024 + 1));
    expect(big.code).toBe('FILE_TOO_LARGE');
  });

  it('explains legacy .xls / encrypted OLE files', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const error = refusal(ole);
    expect(error.code).toBe('INVALID_FILE');
    expect(error.message).toContain('.xls');
  });

  it('refuses CSV / plain text renamed to .xlsx', () => {
    const error = refusal(new TextEncoder().encode('학생 번호,이름\n01,김하늘\n'));
    expect(error.code).toBe('INVALID_FILE');
    expect(error.message).toContain('CSV');
  });

  it('refuses ZIP files that are not spreadsheets (e.g. a .docx)', () => {
    const docx = zipBytes([
      { name: '[Content_Types].xml', data: '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
      { name: 'word/document.xml', data: '<document/>' },
    ]);
    expect(refusal(docx).message).toContain('엑셀 통합 문서');
    const fakeXl = zipBytes([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: minimalWorkbook },
    ]);
    expect(refusal(fakeXl).message).toContain('엑셀 통합 문서');
  });

  it('refuses macro workbooks by part name and by content type', () => {
    const withVba = zipBytes([
      { name: '[Content_Types].xml', data: SPREADSHEET_CONTENT_TYPES },
      { name: 'xl/workbook.xml', data: minimalWorkbook },
      { name: 'xl/vbaProject.bin', data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(refusal(withVba).message).toContain('매크로');
    const macroType = zipBytes([
      { name: '[Content_Types].xml', data: MACRO_CONTENT_TYPES },
      { name: 'xl/workbook.xml', data: minimalWorkbook },
    ]);
    expect(refusal(macroType).message).toContain('매크로');
    const activeX = zipBytes([
      { name: '[Content_Types].xml', data: SPREADSHEET_CONTENT_TYPES },
      { name: 'xl/workbook.xml', data: minimalWorkbook },
      { name: 'xl/activeX/activeX1.xml', data: '<ax/>' },
    ]);
    expect(refusal(activeX).message).toContain('ActiveX');
  });

  it('refuses encrypted entries', () => {
    const encrypted = zipBytes([
      { name: '[Content_Types].xml', data: SPREADSHEET_CONTENT_TYPES },
      { name: 'xl/workbook.xml', data: minimalWorkbook, encrypted: true },
    ]);
    expect(refusal(encrypted).message).toContain('암호');
  });

  it('refuses zip bombs whose real size exceeds the declared size', () => {
    const bomb = zipBytes([
      { name: '[Content_Types].xml', data: SPREADSHEET_CONTENT_TYPES },
      { name: 'xl/workbook.xml', data: minimalWorkbook },
      // 4 MB of zeros compresses to a few KB but claims to be 100 bytes.
      { name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(4 * 1024 * 1024), declaredSize: 100 },
    ]);
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    expect(refusal(bomb).code).toBe('INVALID_FILE');
  });

  it('refuses containers that honestly declare too much uncompressed data', () => {
    const huge = zipBytes([
      { name: '[Content_Types].xml', data: SPREADSHEET_CONTENT_TYPES },
      { name: 'xl/workbook.xml', data: minimalWorkbook },
      { name: 'xl/worksheets/sheet1.xml', data: new Uint8Array(17 * 1024 * 1024) },
    ]);
    expect(refusal(huge).code).toBe('FILE_TOO_LARGE');
  });

  it('refuses truncated archives', async () => {
    const bytes = await workbookBytes([{ name: 'S', rows: [['a']] }]);
    expect(refusal(bytes.subarray(0, bytes.byteLength - 30)).code).toBe('INVALID_FILE');
  });
});
