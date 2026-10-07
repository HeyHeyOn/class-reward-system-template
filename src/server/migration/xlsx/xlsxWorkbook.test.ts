// @vitest-environment node
import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { assertSafeXlsxArchive, readXlsxWorkbookGrid, XLSX_MAX_BYTES, XlsxImportInputError } from './xlsxWorkbook';

async function xlsx(build: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** Minimal single-entry ZIP whose central directory declares `declared` bytes for the entry. */
function zipWith(name: string, content: Buffer, declared = content.length, method = 8): Buffer {
  const data = method === 8 ? deflateRawSync(content) : content;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const directoryOffset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

describe('readXlsxWorkbookGrid', () => {
  it('renders Google-exported cell types as the Sheets formatted grid', async () => {
    const bytes = await xlsx(workbook => {
      const sheet = workbook.addWorksheet('Students');
      sheet.addRow(['studentId', 'name', 'balance', 'status']);
      sheet.addRow(['S01', '가람', 12, 'ACTIVE']);
      sheet.addRow([101, { richText: [{ text: '나' }, { text: '래' }] }, -0, true]);
      const padded = sheet.getCell('A3'); padded.numFmt = '0000';
      sheet.getCell('E2').value = '';
      sheet.addRow([]);
      sheet.addRow([]);
      const tasks = workbook.addWorksheet('Tasks');
      tasks.addRow(['dueAt', 'recurrenceTime', 'formula', 'error', 'link']);
      tasks.addRow([new Date(Date.UTC(2030, 2, 9, 18, 30)), new Date(Date.UTC(1899, 11, 30, 7, 5)),
        { formula: '1+1', result: 2 }, { error: '#N/A' }, { text: 'https://example.invalid/a.png', hyperlink: 'https://example.invalid/a.png' }]);
      tasks.getCell('A2').numFmt = 'yyyy-mm-dd hh:mm';
      tasks.getCell('B2').numFmt = 'hh:mm';
    });
    const grid = await readXlsxWorkbookGrid(bytes);
    expect(grid.sheetNames).toEqual(['Students', 'Tasks']);
    expect(grid.tabs.Students).toEqual([
      ['studentId', 'name', 'balance', 'status'],
      ['S01', '가람', '12', 'ACTIVE'],
      ['0101', '나래', '0', 'TRUE'],
    ]);
    // Wall-clock 2030-03-09 18:30 in Asia/Seoul is 09:30 UTC.
    expect(grid.tabs.Tasks[1]).toEqual(['2030-03-09T09:30:00.000Z', '07:05', '2', '#N/A', 'https://example.invalid/a.png']);
    expect(grid.notes).toEqual([
      { sheet: 'Tasks', row: 2, column: 1, kind: 'DATE' },
      { sheet: 'Tasks', row: 2, column: 2, kind: 'TIME' },
      { sheet: 'Tasks', row: 2, column: 3, kind: 'FORMULA' },
      { sheet: 'Tasks', row: 2, column: 4, kind: 'ERROR' },
    ]);
  });

  it('pads ragged rows, keeps interior blank rows and drops merged-away values and credential tabs', async () => {
    const bytes = await xlsx(workbook => {
      const sheet = workbook.addWorksheet('Products');
      sheet.getCell('A1').value = 'productId'; sheet.getCell('C1').value = 'price';
      sheet.getCell('A3').value = 'P1';
      sheet.mergeCells('A5:B5'); sheet.getCell('A5').value = 'merged';
      workbook.addWorksheet('Passwords').addRow(['secret']);
    });
    const grid = await readXlsxWorkbookGrid(bytes);
    expect(grid.sheetNames).toEqual(['Products']);
    expect(grid.tabs.Products).toEqual([['productId', '', 'price'], ['', '', ''], ['P1', '', ''], ['', '', ''], ['merged', '', '']]);
  });

  it.each([
    ['plain text', Buffer.from('studentId,name\nS01,가람\n'), 'NOT_XLSX'],
    ['a zip without a workbook', zipWith('hello.txt', Buffer.from('hello')), 'NOT_XLSX'],
    ['a zip entry inflating beyond its declared size', zipWith('[Content_Types].xml', Buffer.alloc(200_000, 0x41), 100), 'UNSAFE_ARCHIVE'],
    ['a zip entry declaring an oversized payload', zipWith('[Content_Types].xml', Buffer.from('x'), 200 * 1024 * 1024, 0), 'UNSAFE_ARCHIVE'],
  ])('refuses %s before parsing', async (_label, bytes, code) => {
    await expect(readXlsxWorkbookGrid(new Uint8Array(bytes))).rejects.toMatchObject({ name: 'XlsxImportInputError', code });
  });

  it('refuses files over the upload limit', async () => {
    const error = await readXlsxWorkbookGrid(new Uint8Array(XLSX_MAX_BYTES + 1)).catch(caught => caught);
    expect(error).toBeInstanceOf(XlsxImportInputError);
    expect(error).toMatchObject({ code: 'TOO_LARGE' });
    expect(error.message).toContain('10MB');
  });

  it('accepts a genuine workbook archive', async () => {
    const bytes = await xlsx(workbook => { workbook.addWorksheet('Students').addRow(['studentId']); });
    expect(() => assertSafeXlsxArchive(bytes)).not.toThrow();
  });
});
