import 'server-only';

import { BULK_IMPORT_MAX_ROWS } from '@/lib/bulkImport';
import { ExcelJS, type CellValue, type DataValidation, type Worksheet } from './excel';

export type TemplateColumn = Readonly<{
  label: string;
  required: boolean;
  width: number;
  /** How to fill the column (작성 방법 sheet). */
  description: string;
  examples: readonly [CellValue, CellValue];
  /** Store typed values as text so "01" keeps its leading zero. */
  text?: boolean;
  /** Number format for the column, e.g. '#,##0'. */
  numFmt?: string;
  /** Excel data validation applied to the data area (also shows the input prompt). */
  validation?: DataValidation;
}>;

export type TemplateSpec = Readonly<{
  sheetName: string;
  guideTitle: string;
  columns: ReadonlyArray<TemplateColumn>;
  notes: ReadonlyArray<string>;
}>;

export const TEMPLATE_GUIDE_SHEET_NAME = '작성 방법';
export const TEMPLATE_EXAMPLE_NOTE = '← 예시 줄이에요. 지우고 적어 주세요.';

const HEADER_TEXT = 'FF1F2937';
const REQUIRED_FILL = 'FFDBEAFE';
const OPTIONAL_FILL = 'FFF1F5F9';
const EXAMPLE_TEXT = 'FF94A3B8';
const EXAMPLE_FILL = 'FFF8FAFC';
const LINE = 'FF94A3B8';

const GUIDE_DESCRIPTION_WIDTH = 64;

type ValidationTarget = { dataValidations: { add(address: string, validation: DataValidation): void } };

export function templateHeaderLabel(column: Pick<TemplateColumn, 'label' | 'required'>): string {
  return `${column.label} (${column.required ? '필수' : '선택'})`;
}

export async function buildTemplateWorkbook(spec: TemplateSpec): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '딴쌤 클래스';
  workbook.title = spec.sheetName;

  const sheet = workbook.addWorksheet(spec.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    ...spec.columns.map((column) => ({ width: column.width, style: columnStyle(column) })),
    { width: 36 },
  ];
  writeHeader(sheet, spec.columns);
  writeExamples(sheet, spec.columns);
  writeValidations(sheet, spec.columns);
  writeGuide(workbook.addWorksheet(TEMPLATE_GUIDE_SHEET_NAME), spec);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function writeHeader(sheet: Worksheet, columns: ReadonlyArray<TemplateColumn>) {
  const header = sheet.getRow(1);
  header.height = 26;
  columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = templateHeaderLabel(column);
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column.required ? REQUIRED_FILL : OPTIONAL_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: LINE } } };
  });
}

function writeExamples(sheet: Worksheet, columns: ReadonlyArray<TemplateColumn>) {
  for (const exampleIndex of [0, 1] as const) {
    const row = sheet.getRow(2 + exampleIndex);
    columns.forEach((column, index) => {
      const cell = row.getCell(index + 1);
      cell.value = column.examples[exampleIndex] ?? null;
      cell.font = { italic: true, color: { argb: EXAMPLE_TEXT } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXAMPLE_FILL } };
      const style = columnStyle(column);
      if (style.numFmt) cell.numFmt = style.numFmt;
    });
    const note = row.getCell(columns.length + 1);
    note.value = TEMPLATE_EXAMPLE_NOTE;
    note.font = { italic: true, color: { argb: EXAMPLE_TEXT } };
  }
}

function writeValidations(sheet: Worksheet, columns: ReadonlyArray<TemplateColumn>) {
  const lastRow = BULK_IMPORT_MAX_ROWS + 3;
  const target = sheet as unknown as ValidationTarget;
  columns.forEach((column, index) => {
    if (!column.validation) return;
    const letter = sheet.getColumn(index + 1).letter;
    target.dataValidations.add(`${letter}2:${letter}${lastRow}`, column.validation);
  });
}

function writeGuide(sheet: Worksheet, spec: TemplateSpec) {
  sheet.columns = [{ width: 18 }, { width: 18 }, { width: GUIDE_DESCRIPTION_WIDTH }, { width: 30 }];
  const title = sheet.getCell('A1');
  title.value = spec.guideTitle;
  title.font = { bold: true, size: 14 };

  const header = sheet.getRow(3);
  ['열 이름', '꼭 적기', '적는 방법', '예시'].forEach((label, index) => {
    const cell = header.getCell(index + 1);
    cell.value = label;
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: OPTIONAL_FILL } };
    cell.border = { bottom: { style: 'thin', color: { argb: LINE } } };
  });

  spec.columns.forEach((column, index) => {
    const row = sheet.getRow(4 + index);
    const example = column.examples.find((value) => value !== null && value !== undefined);
    row.getCell(1).value = column.label;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = column.required ? '필수' : '선택 (비워도 돼요)';
    row.getCell(3).value = column.description;
    row.getCell(4).value = example === undefined ? '' : String(example);
    for (const cellNumber of [1, 2, 3, 4]) {
      row.getCell(cellNumber).alignment = { vertical: 'top', wrapText: cellNumber === 3 };
    }
    // Excel does not auto-fit wrapped rows on open, so size them from the text length.
    row.height = wrappedRowHeight(column.description, GUIDE_DESCRIPTION_WIDTH);
  });

  const notesStart = 4 + spec.columns.length + 1;
  const notesTitle = sheet.getCell(`A${notesStart}`);
  notesTitle.value = '알아 두세요';
  notesTitle.font = { bold: true };
  spec.notes.forEach((note, index) => {
    const rowNumber = notesStart + 1 + index;
    sheet.mergeCells(`A${rowNumber}:D${rowNumber}`);
    const cell = sheet.getCell(`A${rowNumber}`);
    const text = `• ${note}`;
    cell.value = text;
    cell.alignment = { wrapText: true, vertical: 'top' };
    sheet.getRow(rowNumber).height = wrappedRowHeight(text, 18 + 18 + GUIDE_DESCRIPTION_WIDTH + 30);
  });
}

function columnStyle(column: TemplateColumn): { numFmt?: string } {
  if (column.text) return { numFmt: '@' };
  return column.numFmt ? { numFmt: column.numFmt } : {};
}

/** Rough row height (points) for wrapped text; Hangul glyphs are about two width units wide. */
function wrappedRowHeight(text: string, columnWidth: number): number {
  const units = Array.from(text).reduce((total, character) => total + (character.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
  const lines = Math.max(1, Math.ceil(units / Math.max(10, columnWidth - 2)));
  return Math.max(20, lines * 16 + 6);
}
