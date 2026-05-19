import type { Product, Student } from '@/domain/types';
import {
  createHeaderIndex,
  parseProductRow,
  parseStudentRow,
  requireColumns,
} from '@/server/sheetsRows';

export type SheetName = 'Students' | 'Products' | 'Transactions' | 'Adjustments';

export type SheetsReader = {
  getRows(sheetName: SheetName): Promise<string[][]>;
};

const REQUIRED_STUDENT_COLUMNS = ['studentId', 'name', 'number', 'balance', 'status'];
const REQUIRED_PRODUCT_COLUMNS = ['productId', 'name', 'price', 'stock', 'isActive'];

export async function getStudentById(reader: SheetsReader, studentId: string): Promise<Student | null> {
  const rows = await reader.getRows('Students');
  const [headers, ...dataRows] = rows;

  if (!headers) return null;

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_STUDENT_COLUMNS, 'Students');

  for (const row of dataRows) {
    const student = parseStudentRow(row, headerIndex);

    if (student?.studentId === studentId) {
      return student;
    }
  }

  return null;
}

export async function getActiveProducts(reader: SheetsReader): Promise<Product[]> {
  const rows = await reader.getRows('Products');
  const [headers, ...dataRows] = rows;

  if (!headers) return [];

  const headerIndex = createHeaderIndex(headers);
  assertRequiredColumns(headerIndex, REQUIRED_PRODUCT_COLUMNS, 'Products');

  return dataRows
    .map((row) => parseProductRow(row, headerIndex))
    .filter((product): product is Product => Boolean(product?.isActive))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

function assertRequiredColumns(
  headerIndex: Map<string, number>,
  requiredColumns: string[],
  sheetName: SheetName,
) {
  const result = requireColumns(headerIndex, requiredColumns);

  if (result.ok === false) {
    throw new Error(`${sheetName} 시트에 필수 컬럼이 없습니다: ${result.missingColumns.join(', ')}`);
  }
}
