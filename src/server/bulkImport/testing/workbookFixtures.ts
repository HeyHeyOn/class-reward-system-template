// Test-only helpers that build .xlsx uploads (via exceljs) and hand-made ZIP containers.
import { crc32, deflateRawSync } from 'node:zlib';
import * as ExcelJSNamespace from 'exceljs';

type ExcelJSModule = typeof ExcelJSNamespace;
const ExcelJS: ExcelJSModule = (ExcelJSNamespace as unknown as { default?: ExcelJSModule }).default ?? ExcelJSNamespace;

export type FixtureCell = ExcelJSNamespace.CellValue;

export type FixtureSheet = Readonly<{
  name: string;
  rows: ReadonlyArray<ReadonlyArray<FixtureCell>>;
  state?: 'visible' | 'hidden';
  /** 1-based column numbers whose cells are stored as text ('@'). */
  textColumns?: ReadonlyArray<number>;
  /** Number formats by cell address, e.g. { A2: '00' }. */
  formats?: Readonly<Record<string, string>>;
}>;

export async function workbookBytes(sheets: ReadonlyArray<FixtureSheet>): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name, { state: sheet.state ?? 'visible' });
    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => {
        if (value === undefined) return;
        const cell = worksheet.getCell(rowIndex + 1, columnIndex + 1);
        cell.value = value;
        if (sheet.textColumns?.includes(columnIndex + 1)) cell.numFmt = '@';
      });
    });
    for (const [address, format] of Object.entries(sheet.formats ?? {})) worksheet.getCell(address).numFmt = format;
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
}

/** Loads bytes back with exceljs (for asserting on generated templates). */
export async function loadWorkbook(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  return workbook;
}

export type ZipFixtureEntry = Readonly<{
  name: string;
  data: string | Uint8Array;
  /** Override the declared uncompressed size (to forge zip bombs). */
  declaredSize?: number;
  stored?: boolean;
  encrypted?: boolean;
}>;

/** Minimal ZIP writer: enough to forge containers the xlsx guard must refuse. */
export function zipBytes(entries: ReadonlyArray<ZipFixtureEntry>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const data = entry.stored ? raw : deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.declaredSize ?? raw.byteLength;
    const crc = crc32(raw);
    const flags = entry.encrypted ? 1 : 0;
    const method = entry.stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.byteLength + name.byteLength + data.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

export const SPREADSHEET_CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
export const MACRO_CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>';
