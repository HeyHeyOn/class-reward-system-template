// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { assertSafeXlsxContainer } from './bulkImport/xlsxContainer';
import { readImportSheet } from './bulkImport/sheetReader';
import { assertSafeXlsxArchive, readXlsxWorkbookGrid } from './migration/xlsx/xlsxWorkbook';
import { SPREADSHEET_CONTENT_TYPES, zipBytes } from './bulkImport/testing/workbookFixtures';

vi.mock('server-only', () => ({}));

function sample(): Buffer {
  return Buffer.from(zipBytes([
    { name: '[Content_Types].xml', data: SPREADSHEET_CONTENT_TYPES },
    { name: 'xl/workbook.xml', data: '<workbook/>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>' },
  ]));
}

describe.each([
  ['bulk import', assertSafeXlsxContainer],
  ['migration', assertSafeXlsxArchive],
] as const)('%s complete ZIP directory validation', (_name, validate) => {
  it('accepts consistent small archives', () => expect(() => validate(sample())).not.toThrow());
  it('accepts ordinary ZIP comments but rejects an ambiguous later end signature', () => {
    const bytes = sample();
    bytes.writeUInt16LE(4, bytes.length - 2);
    expect(() => validate(Buffer.concat([bytes, Buffer.from('note')]))).not.toThrow();
    expect(() => validate(Buffer.concat([bytes, Buffer.from([0x50, 0x4b, 0x05, 0x06])]))).toThrow();
  });
  it.each(['entry count', 'directory size', 'comment length', 'local name', 'local method', 'disk number'])(
    'rejects inconsistent %s before parsing the workbook', (field) => {
      const bytes = sample();
      const end = bytes.length - 22;
      switch (field) {
        case 'entry count': bytes.writeUInt16LE(2, end + 8); bytes.writeUInt16LE(2, end + 10); break;
        case 'directory size': bytes.writeUInt32LE(bytes.readUInt32LE(end + 12) - 1, end + 12); break;
        case 'comment length': bytes.writeUInt16LE(1, end + 20); break;
        case 'local name': bytes[30] = 0x58; break;
        case 'local method': bytes.writeUInt16LE(99, 8); break;
        case 'disk number': bytes.writeUInt16LE(1, end + 4); break;
      }
      expect(() => validate(bytes)).toThrow();
    },
  );
});

it('both importers read merged values without materializing formatting-only cells', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('학생 명단');
  sheet.addRow(['학생 번호', '이름']);
  sheet.addRow(['01', '검증용']);
  sheet.mergeCells('D4:M13');
  sheet.getCell('D4').value = '안내';
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  // A real parser regression check: neither importer may call the allocator used
  // by ExcelJS to expand each merged rectangle after parsing.
  const probe = new ExcelJS.Workbook().addWorksheet('probe');
  const prototype = Object.getPrototypeOf(probe) as { _mergeCellsInternal: (...args: unknown[]) => void };
  const merge = vi.spyOn(prototype, '_mergeCellsInternal').mockImplementation(() => { throw new Error('Merge allocation forbidden'); });
  try {
    const grid = await readXlsxWorkbookGrid(bytes);
    expect(grid.tabs['학생 명단'][1].slice(0, 2)).toEqual(['01', '검증용']);
    expect(grid.tabs['학생 명단'][3][3]).toBe('안내');
    const imported = await readImportSheet(bytes, [
      { field: 'id', label: '학생 번호', required: true, aliases: [] },
      { field: 'name', label: '이름', required: true, aliases: [] },
    ], '학생 명단');
    expect(imported.rows).toHaveLength(1);
    expect(merge).not.toHaveBeenCalled();
  } finally { merge.mockRestore(); }
});
