import type { ClassTask, Product, Student, StudentStatus } from '@/domain/types';

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
  const balance = parseNumberCell(getCell(row, headerIndex, 'balance'));
  const status = parseStudentStatus(getCell(row, headerIndex, 'status'));

  if (!studentId || !name || balance === null || !status) {
    return null;
  }

  return {
    studentId,
    name,
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

export function parseTaskRow(row: string[], headerIndex: HeaderIndex): ClassTask | null {
  const taskId = getCell(row, headerIndex, 'taskId');
  const title = getCell(row, headerIndex, 'title');
  const reward = parseNumberCell(getCell(row, headerIndex, 'reward'));
  const sortOrder = parseNumberCell(getCell(row, headerIndex, 'sortOrder')) ?? 0;

  if (!taskId || !title || reward === null) return null;

  const createdAt = getCell(row, headerIndex, 'createdAt');
  return {
    taskId,
    title,
    description: getCell(row, headerIndex, 'description'),
    reward,
    isActive: parseTaskBooleanCell(getCell(row, headerIndex, 'isActive')),
    sortOrder,
    allowedStudentIds: parseAllowedStudentIds(getCell(row, headerIndex, 'allowedStudentIds')),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function parseAllowedStudentIds(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,;]/).map((id) => id.trim()).filter(Boolean)));
}

export function buildTaskAppendRow(headers: string[], task: ClassTask, timestamp: string): string[] {
  const valuesByHeader: Record<string, string> = {
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    reward: String(task.reward),
    maxCompletionsPerStudent: '1',
    isActive: task.isActive ? 'TRUE' : 'FALSE',
    sortOrder: String(task.sortOrder),
    createdAt: timestamp,
    updatedAt: timestamp,
    allowedStudentIds: task.allowedStudentIds.join(','),
  };

  return headers.map((header) => valuesByHeader[header.trim()] ?? '');
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

function parseTaskBooleanCell(value: string): boolean {
  return /^(true|1|yes|y|활성)$/i.test(value.trim());
}

function parseStudentStatus(value: string): StudentStatus | null {
  if (value === 'ACTIVE' || value === 'INACTIVE') return value;

  return null;
}
