import type { Product, Student, StudentStatus } from '@/domain/types';

export type HeaderIndex = Map<string, number>;

export type RequiredColumnsResult =
  | { ok: true }
  | { ok: false; missingColumns: string[] };

export function createHeaderIndex(headers: string[]): HeaderIndex {
  return new Map(headers.map((header, index) => [header.trim(), index]));
}

export function requireColumns(headerIndex: HeaderIndex, requiredColumns: string[]): RequiredColumnsResult {
  const missingColumns = requiredColumns.filter((column) => !headerIndex.has(column));

  if (missingColumns.length > 0) {
    return { ok: false, missingColumns };
  }

  return { ok: true };
}

export function parseStudentRow(row: string[], headerIndex: HeaderIndex): Student | null {
  const studentId = getCell(row, headerIndex, 'studentId');
  const name = getCell(row, headerIndex, 'name');
  const number = parseNumberCell(getCell(row, headerIndex, 'number'));
  const balance = parseNumberCell(getCell(row, headerIndex, 'balance'));
  const status = parseStudentStatus(getCell(row, headerIndex, 'status'));

  if (!studentId || !name || number === null || balance === null || !status) {
    return null;
  }

  return {
    studentId,
    name,
    number,
    balance,
    status,
  };
}

export function parseProductRow(row: string[], headerIndex: HeaderIndex): Product | null {
  const productId = getCell(row, headerIndex, 'productId');
  const name = getCell(row, headerIndex, 'name');
  const price = parseNumberCell(getCell(row, headerIndex, 'price'));
  const stock = parseNumberCell(getCell(row, headerIndex, 'stock'));
  const isActive = parseBooleanCell(getCell(row, headerIndex, 'isActive'));
  const imageUrl = getCell(row, headerIndex, 'imageUrl') || undefined;
  const category = getCell(row, headerIndex, 'category') || undefined;
  const sortOrder = parseNumberCell(getCell(row, headerIndex, 'sortOrder')) ?? 0;

  if (!productId || !name || price === null || stock === null || isActive === null) {
    return null;
  }

  return {
    productId,
    name,
    price,
    stock,
    isActive,
    imageUrl,
    category,
    sortOrder,
  };
}

function getCell(row: string[], headerIndex: HeaderIndex, column: string): string {
  const index = headerIndex.get(column);

  if (index === undefined) return '';

  return String(row[index] ?? '').trim();
}

function parseNumberCell(value: string): number | null {
  if (!value) return null;

  const parsed = Number(value.replace(/,/g, ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanCell(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();

  if (['true', 'yes', 'y', '1'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0'].includes(normalized)) return false;

  return null;
}

function parseStudentStatus(value: string): StudentStatus | null {
  if (value === 'ACTIVE' || value === 'INACTIVE') return value;

  return null;
}
