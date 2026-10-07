import 'server-only';

import * as ExcelJSNamespace from 'exceljs';

type ExcelJSModule = typeof ExcelJSNamespace;

// exceljs is CommonJS. Bundlers expose its exports on the namespace while native Node ESM
// (Vitest) only exposes `default`, so resolve both shapes once.
export const ExcelJS: ExcelJSModule = (ExcelJSNamespace as unknown as { default?: ExcelJSModule }).default
  ?? ExcelJSNamespace;

export type { CellValue, DataValidation, Workbook, Worksheet } from 'exceljs';
