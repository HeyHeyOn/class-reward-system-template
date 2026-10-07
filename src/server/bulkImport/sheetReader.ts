import 'server-only';

import { BulkImportFileError } from './errors';
import { ExcelJS, type CellValue, type Worksheet } from './excel';
import { assertSafeXlsxContainer } from './xlsxContainer';

/** A spreadsheet cell reduced to what the import validators need. */
export type RawCell =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'text'; text: string }>
  /** `display` keeps zero padding shown by formats like "00" (typed 1, shown "01"). */
  | Readonly<{ kind: 'number'; value: number; display?: string }>
  | Readonly<{ kind: 'boolean'; value: boolean }>
  | Readonly<{ kind: 'date' }>
  | Readonly<{ kind: 'error'; code: string }>;

export type ImportColumn<TField extends string> = Readonly<{
  field: TField;
  /** Label without the (필수)/(선택) suffix, e.g. '학생 번호'. */
  label: string;
  required: boolean;
  /** Other header spellings accepted (normalized the same way as headers). */
  aliases: readonly string[];
}>;

export type SheetRow<TField extends string> = Readonly<{
  rowNumber: number;
  cells: Readonly<Record<TField, RawCell>>;
  hyperlinks: Readonly<Partial<Record<TField, string>>>;
}>;

export type ImportSheet<TField extends string> = Readonly<{
  sheetName: string;
  headerRowNumber: number;
  rows: ReadonlyArray<SheetRow<TField>>;
  /** Header labels that did not match any known column (ignored). */
  ignoredHeaders: ReadonlyArray<string>;
}>;

const HEADER_SEARCH_ROWS = 10;
const EMPTY: RawCell = Object.freeze({ kind: 'empty' });

/** Lower-cases and strips spaces, punctuation and parenthesised remarks like "(필수)". */
export function normalizeHeader(value: string): string {
  return value.normalize('NFKC')
    .replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）/g, '')
    .replace(/[\s*※:：_\-.·・/]/g, '')
    .toLowerCase();
}

export async function readImportSheet<TField extends string>(
  bytes: Uint8Array,
  columns: ReadonlyArray<ImportColumn<TField>>,
  preferredSheetName: string,
): Promise<ImportSheet<TField>> {
  assertSafeXlsxContainer(bytes);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as never);
  } catch {
    throw new BulkImportFileError('INVALID_FILE',
      "엑셀 파일을 읽지 못했어요. 엑셀에서 '다른 이름으로 저장 → Excel 통합 문서(*.xlsx)'로 저장한 뒤 다시 올려 주세요.");
  }

  const sheets = workbook.worksheets
    .filter((sheet) => sheet.state !== 'hidden' && sheet.state !== 'veryHidden');
  sheets.sort((left, right) => Number(right.name.trim() === preferredSheetName)
    - Number(left.name.trim() === preferredSheetName));

  let bestMissing: string[] | null = null;
  for (const sheet of sheets) {
    const header = findHeaderRow(sheet, columns);
    if (header.kind === 'found') {
      return {
        sheetName: sheet.name,
        headerRowNumber: header.rowNumber,
        rows: readDataRows(sheet, header.rowNumber, header.mapping, columns),
        ignoredHeaders: header.ignored,
      };
    }
    if (header.kind === 'duplicate') {
      throw new BulkImportFileError('NO_MATCHING_SHEET',
        `'${sheet.name}' 시트에 '${header.label}' 열이 두 번 있어요. 하나만 남겨 주세요.`);
    }
    if (header.missing.length && (!bestMissing || header.missing.length < bestMissing.length)) {
      bestMissing = header.missing;
    }
  }

  const required = columns.filter((column) => column.required).map((column) => `'${column.label}'`);
  const missing = bestMissing && bestMissing.length < required.length
    ? ` ${bestMissing.map((label) => `'${label}'`).join(', ')} 열을 찾지 못했어요.`
    : '';
  throw new BulkImportFileError('NO_MATCHING_SHEET',
    `양식에 맞는 시트를 찾지 못했어요.${missing} 첫 줄에 ${required.join(', ')} 제목이 있어야 해요. '양식 다운로드'로 받은 파일에 적어 올려 주세요.`);
}

type HeaderSearch<TField extends string> =
  | Readonly<{ kind: 'found'; rowNumber: number; mapping: ReadonlyMap<TField, number>; ignored: string[] }>
  | Readonly<{ kind: 'duplicate'; label: string }>
  | Readonly<{ kind: 'missing'; missing: string[] }>;

function findHeaderRow<TField extends string>(
  sheet: Worksheet,
  columns: ReadonlyArray<ImportColumn<TField>>,
): HeaderSearch<TField> {
  const lookup = new Map<string, ImportColumn<TField>>();
  for (const column of columns) {
    for (const alias of [column.label, ...column.aliases]) lookup.set(normalizeHeader(alias), column);
  }
  const requiredCount = columns.filter((column) => column.required).length;
  let fewestMissing: string[] = columns.filter((column) => column.required).map((column) => column.label);

  const lastRow = Math.min(sheet.rowCount, HEADER_SEARCH_ROWS);
  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const mapping = new Map<TField, number>();
    const ignored: string[] = [];
    let duplicate: string | null = null;
    const lastColumn = Math.min(row.cellCount, 64);
    for (let columnNumber = 1; columnNumber <= lastColumn; columnNumber += 1) {
      const cell = toRawCell(row.getCell(columnNumber).value).cell;
      if (cell.kind !== 'text') continue;
      const column = lookup.get(normalizeHeader(cell.text));
      if (!column) {
        ignored.push(cell.text.trim());
        continue;
      }
      if (mapping.has(column.field)) duplicate ??= column.label;
      else mapping.set(column.field, columnNumber);
    }
    const missing = columns.filter((column) => column.required && !mapping.has(column.field))
      .map((column) => column.label);
    if (missing.length === 0) {
      if (duplicate) return { kind: 'duplicate', label: duplicate };
      return { kind: 'found', rowNumber, mapping, ignored };
    }
    if (missing.length < requiredCount && missing.length < fewestMissing.length) fewestMissing = missing;
  }
  return { kind: 'missing', missing: fewestMissing };
}

function readDataRows<TField extends string>(
  sheet: Worksheet,
  headerRowNumber: number,
  mapping: ReadonlyMap<TField, number>,
  columns: ReadonlyArray<ImportColumn<TField>>,
): SheetRow<TField>[] {
  const rows: SheetRow<TField>[] = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells = {} as Record<TField, RawCell>;
    const hyperlinks: Partial<Record<TField, string>> = {};
    let empty = true;
    for (const column of columns) {
      const columnNumber = mapping.get(column.field);
      const source = columnNumber === undefined ? undefined : row.getCell(columnNumber);
      const read = source ? toRawCell(source.value, source.numFmt) : { cell: EMPTY };
      cells[column.field] = read.cell;
      if (read.hyperlink) hyperlinks[column.field] = read.hyperlink;
      if (read.cell.kind !== 'empty') empty = false;
    }
    if (!empty) rows.push({ rowNumber, cells, hyperlinks });
  }
  return rows;
}

export function toRawCell(value: CellValue, numFmt?: string): { cell: RawCell; hyperlink?: string } {
  if (value === null || value === undefined) return { cell: EMPTY };
  if (typeof value === 'string') return { cell: textCell(value) };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { cell: { kind: 'error', code: '#NUM!' } };
    const padding = typeof numFmt === 'string' && /^0+$/.test(numFmt.trim()) ? numFmt.trim().length : 0;
    return {
      cell: padding > 1 && Number.isSafeInteger(value) && value >= 0
        ? { kind: 'number', value, display: String(value).padStart(padding, '0') }
        : { kind: 'number', value },
    };
  }
  if (typeof value === 'boolean') return { cell: { kind: 'boolean', value } };
  if (value instanceof Date) return { cell: { kind: 'date' } };
  if (typeof value !== 'object') return { cell: EMPTY };
  if ('error' in value) return { cell: { kind: 'error', code: String(value.error) } };
  if ('richText' in value && Array.isArray(value.richText)) {
    return { cell: textCell(value.richText.map((part) => part?.text ?? '').join('')) };
  }
  if ('hyperlink' in value) {
    const text = value.text as unknown;
    const display = typeof text === 'string' ? text
      : text && typeof text === 'object' && Array.isArray((text as { richText?: unknown }).richText)
        ? ((text as { richText: Array<{ text?: string }> }).richText).map((part) => part?.text ?? '').join('')
        : '';
    const hyperlink = typeof value.hyperlink === 'string' ? value.hyperlink : undefined;
    return { cell: textCell(display || hyperlink || ''), hyperlink };
  }
  if ('formula' in value || 'sharedFormula' in value) {
    const result = (value as { result?: unknown }).result;
    if (result === undefined || result === null) return { cell: { kind: 'error', code: 'FORMULA' } };
    return toRawCell(result as CellValue, numFmt);
  }
  return { cell: EMPTY };
}

function textCell(text: string): RawCell {
  return text.trim() ? { kind: 'text', text } : EMPTY;
}
