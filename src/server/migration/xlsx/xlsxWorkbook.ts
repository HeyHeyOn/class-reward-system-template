import { inflateRawSync } from 'node:zlib';
import { Temporal } from '@js-temporal/polyfill';
import ExcelJS from 'exceljs';
import { isSensitiveTabName } from '../sensitiveRedaction';

/** Upload limit for a saved CRS workbook (.xlsx). */
export const XLSX_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
const MAX_SHEETS = 64;
const MAX_ROWS_PER_SHEET = 250_000;
const MAX_COLUMNS = 256;
const MAX_CELLS = 2_000_000;
const MAX_CELL_LENGTH = 100_000;
const CLASS_TIME_ZONE = 'Asia/Seoul';

export type XlsxImportErrorCode =
  | 'TOO_LARGE' | 'NOT_XLSX' | 'UNSAFE_ARCHIVE' | 'UNREADABLE' | 'TOO_MANY_CELLS';

/** A refusal whose message is safe to show to the teacher as-is. */
export class XlsxImportInputError extends Error {
  constructor(readonly code: XlsxImportErrorCode, message: string) {
    super(message);
    this.name = 'XlsxImportInputError';
  }
}

/** Cells whose text was derived rather than read verbatim (dates, formulas, errors). */
export type XlsxCellNote = Readonly<{
  sheet: string; row: number; column: number; kind: 'DATE' | 'TIME' | 'FORMULA' | 'ERROR';
}>;

/**
 * The same shape the Google Sheets snapshot readers produce: one dense string grid per tab,
 * cell text equal to what Sheets displays (FORMATTED_VALUE) for the values CRS writes.
 */
export type XlsxWorkbookGrid = Readonly<{
  tabs: Readonly<Record<string, string[][]>>;
  sheetNames: readonly string[];
  notes: readonly XlsxCellNote[];
}>;

function refuse(code: XlsxImportErrorCode, message: string): never {
  throw new XlsxImportInputError(code, message);
}

/**
 * Bounds the archive BEFORE any XML parser sees it: entry count, declared sizes, no ZIP64 or
 * encryption, and every entry really inflates to exactly its declared size (zip-bomb guard).
 */
export function assertSafeXlsxArchive(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    refuse('NOT_XLSX', '엑셀(.xlsx) 파일만 올릴 수 있어요. 구글 시트에서 [파일 → 다운로드 → Microsoft Excel(.xlsx)]로 저장해 주세요.');
  }
  let end = -1;
  // Match JSZip's raw last-signature selection; a later invalid record is a
  // refusal, never a reason to validate an earlier, different directory.
  for (let offset = buffer.length - 4; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 > buffer.length || offset + 22 + buffer.readUInt16LE(offset + 20) !== buffer.length) {
      refuse('UNSAFE_ARCHIVE', '파일 구조가 올바르지 않아요. 다시 저장해 주세요.');
    }
    end = offset; break;
  }
  if (end < 0) refuse('NOT_XLSX', '파일이 손상되었거나 엑셀(.xlsx) 파일이 아니에요.');
  const entries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (entries === 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0
    || buffer.readUInt16LE(end + 8) !== entries || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
    || entries > MAX_ZIP_ENTRIES || directoryOffset + directorySize !== end) {
    refuse('UNSAFE_ARCHIVE', '파일 구조가 지원하지 않는 형식이에요. 구글 시트에서 다시 다운로드해 주세요.');
  }
  const names = new Set<string>();
  const offsets = new Set<number>();
  let total = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      refuse('UNSAFE_ARCHIVE', '파일이 손상되었어요. 구글 시트에서 다시 다운로드해 주세요.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > end
      || buffer.readUInt16LE(cursor + 34) !== 0 || offsets.has(localOffset)) {
      refuse('UNSAFE_ARCHIVE', '파일 구조가 올바르지 않아요. 다시 저장해 주세요.');
    }
    offsets.add(localOffset);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (!name || names.has(name)) refuse('UNSAFE_ARCHIVE', '파일 구조가 올바르지 않아요. 다시 저장해 주세요.');
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || uncompressed === 0xffffffff
      || (method !== 0 && method !== 8) || uncompressed > MAX_ENTRY_BYTES) {
      refuse('UNSAFE_ARCHIVE', '암호가 걸렸거나 지원하지 않는 형식의 파일이에요.');
    }
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES) refuse('TOO_MANY_CELLS', '파일 내용이 너무 커요. 사용하지 않는 시트를 지운 뒤 다시 저장해 주세요.');
    names.add(name);
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      refuse('UNSAFE_ARCHIVE', '파일이 손상되었어요. 구글 시트에서 다시 다운로드해 주세요.');
    }
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart > directoryOffset || dataStart + compressed > directoryOffset
      || buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method
      || buffer.toString('utf8', localOffset + 30, localOffset + 30 + buffer.readUInt16LE(localOffset + 26)) !== name) refuse('UNSAFE_ARCHIVE', '파일이 손상되었어요. 구글 시트에서 다시 다운로드해 주세요.');
    if (method === 8) {
      let inflated: Buffer;
      try {
        inflated = inflateRawSync(buffer.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, uncompressed) });
      } catch {
        refuse('UNSAFE_ARCHIVE', '파일이 손상되었거나 크기가 맞지 않아요. 구글 시트에서 다시 다운로드해 주세요.');
      }
      if (inflated.length !== uncompressed) refuse('UNSAFE_ARCHIVE', '파일이 손상되었거나 크기가 맞지 않아요.');
    } else if (compressed !== uncompressed) {
      refuse('UNSAFE_ARCHIVE', '파일이 손상되었어요. 구글 시트에서 다시 다운로드해 주세요.');
    }
  }
  if (cursor !== end) refuse('UNSAFE_ARCHIVE', '파일 구조가 올바르지 않아요. 다시 저장해 주세요.');
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    refuse('NOT_XLSX', '엑셀(.xlsx) 파일만 올릴 수 있어요. 구글 시트에서 [파일 → 다운로드 → Microsoft Excel(.xlsx)]로 저장해 주세요.');
  }
}

/** Excel stores wall-clock dates; CRS classes live in Asia/Seoul. */
function wallClockToInstant(value: Date): string {
  const plain = new Temporal.PlainDateTime(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
    value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds());
  return new Date(plain.toZonedDateTime(CLASS_TIME_ZONE).epochMilliseconds).toISOString();
}

function dateText(value: Date): { text: string; kind: 'DATE' | 'TIME' } {
  if (!Number.isFinite(value.getTime())) return { text: '', kind: 'DATE' };
  // Excel's day zero (1899-12-30/31): a time of day without a date, e.g. a recurrence time.
  if (value.getUTCFullYear() < 1901) {
    const hh = String(value.getUTCHours()).padStart(2, '0');
    const mm = String(value.getUTCMinutes()).padStart(2, '0');
    const ss = value.getUTCSeconds();
    return { text: ss ? `${hh}:${mm}:${String(ss).padStart(2, '0')}` : `${hh}:${mm}`, kind: 'TIME' };
  }
  return { text: wallClockToInstant(value), kind: 'DATE' };
}

function numberText(value: number, numFmt: string | undefined): string {
  if (!Number.isFinite(value)) return '';
  // Raw numbers keep validators simple ("1,000" would not be an integer). A zero-only
  // format such as "0000" is part of an ID ("0101"), as Google Sheets displays it.
  const text = Object.is(value, -0) ? '0' : String(value);
  if (numFmt && /^0+$/.test(numFmt) && Number.isInteger(value) && value >= 0) return text.padStart(numFmt.length, '0');
  return text;
}

type CellOutcome = { text: string; kind?: XlsxCellNote['kind'] };

function richText(value: unknown): string | null {
  if (value && typeof value === 'object' && Array.isArray((value as { richText?: unknown }).richText)) {
    return ((value as { richText: { text?: unknown }[] }).richText).map(part => typeof part.text === 'string' ? part.text : '').join('');
  }
  return null;
}

function cellText(value: ExcelJS.CellValue, numFmt: string | undefined): CellOutcome {
  if (value === null || value === undefined) return { text: '' };
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'number') return { text: numberText(value, numFmt) };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
  if (value instanceof Date) return dateText(value);
  if (typeof value === 'object') {
    const rich = richText(value);
    if (rich !== null) return { text: rich };
    if ('error' in value) return { text: String(value.error ?? ''), kind: 'ERROR' };
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as { result?: unknown }).result;
      if (result === undefined || result === null) return { text: '', kind: 'FORMULA' };
      if (typeof result === 'object' && result !== null && !(result instanceof Date) && 'error' in result) {
        return { text: String((result as { error?: unknown }).error ?? ''), kind: 'ERROR' };
      }
      const inner = cellText(result as ExcelJS.CellValue, numFmt);
      return { text: inner.text, kind: inner.kind ?? 'FORMULA' };
    }
    if ('hyperlink' in value || 'text' in value) {
      const text = (value as { text?: unknown }).text;
      if (typeof text === 'string') return { text };
      const nested = richText(text);
      if (nested !== null) return { text: nested };
      const link = (value as { hyperlink?: unknown }).hyperlink;
      return { text: typeof link === 'string' ? link : '' };
    }
  }
  return { text: '' };
}

/**
 * Reads a workbook exported from Google Sheets ("Microsoft Excel (.xlsx)") into the grid
 * shape of the Sheets snapshot readers. Values are rendered the way CRS stored them: text as-is,
 * numbers without grouping, booleans as TRUE/FALSE, real date cells as UTC instants (wall clock
 * in Asia/Seoul) and time-only cells as HH:mm. Merged-away cells, trailing empty rows and
 * columns are dropped. Credential-bearing tabs are never read.
 */
export async function readXlsxWorkbookGrid(bytes: Uint8Array): Promise<XlsxWorkbookGrid> {
  if (bytes.byteLength > XLSX_MAX_BYTES) refuse('TOO_LARGE', '파일이 너무 커요. 10MB 이하의 .xlsx 파일만 올릴 수 있어요.');
  assertSafeXlsxArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try {
    const archive = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Imported values use the top-left cell only. Ignoring merge metadata avoids
    // allocating every cell of a formatting-only merged rectangle.
    await workbook.xlsx.load(archive as unknown as Parameters<typeof workbook.xlsx.load>[0], { ignoreNodes: ['mergeCells'] });
  } catch {
    refuse('UNREADABLE', '파일을 읽지 못했어요. 구글 시트에서 [파일 → 다운로드 → Microsoft Excel(.xlsx)]로 다시 저장해 주세요.');
  }
  const worksheets = workbook.worksheets;
  if (worksheets.length > MAX_SHEETS) refuse('TOO_MANY_CELLS', '시트가 너무 많아요. 사용하지 않는 시트를 지운 뒤 다시 저장해 주세요.');
  const tabs: Record<string, string[][]> = Object.create(null);
  const sheetNames: string[] = [];
  const notes: XlsxCellNote[] = [];
  let cells = 0;
  for (const sheet of worksheets) {
    const name = sheet.name;
    if (typeof name !== 'string' || !name || name.length > 200 || Object.hasOwn(tabs, name)
      || ['__proto__', 'constructor', 'prototype'].includes(name) || isSensitiveTabName(name)) continue;
    sheetNames.push(name);
    const rows: string[][] = [];
    let width = 0;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > MAX_ROWS_PER_SHEET) refuse('TOO_MANY_CELLS', `'${name}' 시트의 행이 너무 많아요.`);
      const values: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        if (columnNumber > MAX_COLUMNS) return;
        // Only the top-left cell of a merged range carries the value in Google Sheets.
        if (cell.isMerged && cell.master !== cell) return;
        const outcome = cellText(cell.value, cell.numFmt);
        if (outcome.text.length > MAX_CELL_LENGTH) refuse('TOO_MANY_CELLS', `'${name}' 시트에 너무 긴 칸이 있어요.`);
        if (!outcome.text && !outcome.kind) return;
        while (values.length < columnNumber - 1) values.push('');
        values[columnNumber - 1] = outcome.text;
        if (outcome.kind) notes.push({ sheet: name, row: rowNumber, column: columnNumber, kind: outcome.kind });
      });
      while (values.length && !values[values.length - 1]) values.pop();
      if (!values.length) return;
      while (rows.length < rowNumber - 1) rows.push([]);
      rows[rowNumber - 1] = values;
      width = Math.max(width, values.length);
    });
    cells += rows.length * Math.max(width, 1);
    if (cells > MAX_CELLS) refuse('TOO_MANY_CELLS', '파일 내용이 너무 커요. 사용하지 않는 시트를 지운 뒤 다시 저장해 주세요.');
    tabs[name] = rows.map(row => [...row, ...Array<string>(width - row.length).fill('')]);
  }
  return { tabs, sheetNames, notes };
}
