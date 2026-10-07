import ExcelJS from 'exceljs';

type GoogleCell = {
  formattedValue?: string;
  userEnteredValue?: { formulaValue?: string };
  effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; errorValue?: { type?: string } };
  effectiveFormat?: { numberFormat?: { type?: string; pattern?: string } };
};
type GoogleGrid = { sheets: { properties: { title: string }; data?: { startRow?: number; startColumn?: number; rowData?: { values?: GoogleCell[] }[] }[] }[] };

const DATE_FORMATS: Record<string, string> = { DATE: 'yyyy-mm-dd', DATE_TIME: 'yyyy-mm-dd hh:mm:ss', TIME: 'hh:mm' };

/** Excel serial (wall clock) → the Date ExcelJS writes back as that serial. */
function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86_400_000));
}

/**
 * Test utility: renders a recorded Sheets API `includeGridData` capture as Google's
 * "Download → Microsoft Excel (.xlsx)" would type it (text stays text, numbers stay numbers,
 * booleans, date-formatted numbers as dates, formulas with cached results).
 */
export async function googleGridToXlsx(gridJson: string): Promise<Buffer> {
  const grid = JSON.parse(gridJson) as GoogleGrid;
  const workbook = new ExcelJS.Workbook();
  for (const sheet of grid.sheets) {
    const worksheet = workbook.addWorksheet(sheet.properties.title);
    for (const block of sheet.data ?? []) {
      const startRow = block.startRow ?? 0, startColumn = block.startColumn ?? 0;
      (block.rowData ?? []).forEach((row, rowOffset) => {
        (row.values ?? []).forEach((cell, columnOffset) => {
          const target = worksheet.getCell(startRow + rowOffset + 1, startColumn + columnOffset + 1);
          const effective = cell.effectiveValue;
          const format = cell.effectiveFormat?.numberFormat?.type;
          let value: ExcelJS.CellValue = null;
          if (effective?.stringValue !== undefined) value = effective.stringValue;
          else if (effective?.numberValue !== undefined) {
            if (format && DATE_FORMATS[format]) { value = serialToDate(effective.numberValue); target.numFmt = DATE_FORMATS[format]; }
            else value = effective.numberValue;
          } else if (effective?.boolValue !== undefined) value = effective.boolValue;
          else if (effective?.errorValue) value = { error: '#N/A' } as ExcelJS.CellErrorValue;
          else if (cell.formattedValue) value = cell.formattedValue;
          const formula = cell.userEnteredValue?.formulaValue;
          if (formula && value !== null && !(typeof value === 'object' && 'error' in (value as object))) {
            target.value = { formula: formula.replace(/^=/, ''), result: value as string | number | boolean | Date } as ExcelJS.CellFormulaValue;
          } else if (value !== null) target.value = value;
        });
      });
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
