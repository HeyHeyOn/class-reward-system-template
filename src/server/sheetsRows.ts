import type {
  CheckoutLineItem,
  ClassTask,
  Product,
  Student,
  StudentStatus,
  TaskCompletion,
  Transaction,
} from '@/domain/types';

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
  const studentId = getRowCell(row, headerIndex, 'studentId');
  const name = getRowCell(row, headerIndex, 'name');
  const balance = parseNumberCell(getRowCell(row, headerIndex, 'balance'));
  const status = parseStudentStatus(getRowCell(row, headerIndex, 'status'));

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
  const productId = getRowCell(row, headerIndex, 'productId');
  const name = getRowCell(row, headerIndex, 'name');
  const price = parseNumberCell(getRowCell(row, headerIndex, 'price'));
  const stock = parseNumberCell(getRowCell(row, headerIndex, 'stock'));
  const isActive = parseBooleanCell(getRowCell(row, headerIndex, 'isActive'));
  const imageUrl = getRowCell(row, headerIndex, 'imageUrl') || undefined;
  const category = getRowCell(row, headerIndex, 'category') || undefined;
  const sortOrder = parseNumberCell(getRowCell(row, headerIndex, 'sortOrder')) ?? 0;

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
  const taskId = getRowCell(row, headerIndex, 'taskId');
  const title = getRowCell(row, headerIndex, 'title');
  const reward = parseNumberCell(getRowCell(row, headerIndex, 'reward'));
  const sortOrder = parseNumberCell(getRowCell(row, headerIndex, 'sortOrder')) ?? 0;

  if (!taskId || !title || reward === null) return null;

  const createdAt = getRowCell(row, headerIndex, 'createdAt');
  return {
    taskId,
    title,
    description: getRowCell(row, headerIndex, 'description'),
    reward,
    isActive: parseTaskBooleanCell(getRowCell(row, headerIndex, 'isActive')),
    sortOrder,
    allowedStudentIds: parseAllowedStudentIds(getRowCell(row, headerIndex, 'allowedStudentIds')),
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

export function parseTransactionRow(row: string[], headerIndex: HeaderIndex): Transaction | null {
  const transactionId = getRowCell(row, headerIndex, 'transactionId');
  const timestamp = getRowCell(row, headerIndex, 'timestamp');
  const studentId = getRowCell(row, headerIndex, 'studentId');
  const studentName = getRowCell(row, headerIndex, 'studentName');
  const totalAmount = parseNumberCell(getRowCell(row, headerIndex, 'totalAmount'));
  const balanceBefore = parseNumberCell(getRowCell(row, headerIndex, 'balanceBefore'));
  const balanceAfter = parseNumberCell(getRowCell(row, headerIndex, 'balanceAfter'));

  if (!transactionId || !timestamp || !studentId || !studentName || totalAmount === null || balanceBefore === null || balanceAfter === null) {
    return null;
  }

  const itemsValue = getRowCell(row, headerIndex, 'items')
    || getRowCell(row, headerIndex, 'itemsJson')
    || getRowCell(row, headerIndex, 'itemJson')
    || getRowCell(row, headerIndex, 'products');
  return {
    transactionId,
    timestamp,
    studentId,
    studentName,
    items: parseTransactionItems(itemsValue),
    totalAmount,
    balanceBefore,
    balanceAfter,
    status: getRowCell(row, headerIndex, 'status') || 'UNKNOWN',
    operator: getRowCell(row, headerIndex, 'operator') || 'unknown',
  };
}

export function buildTransactionAppendRow(headers: string[], transaction: Transaction): string[] {
  const serializedItems = JSON.stringify(transaction.items);
  const valuesByHeader: Record<string, string> = {
    transactionId: transaction.transactionId,
    timestamp: transaction.timestamp,
    studentId: transaction.studentId,
    studentName: transaction.studentName,
    items: serializedItems,
    itemsJson: serializedItems,
    itemJson: serializedItems,
    products: serializedItems,
    totalAmount: String(transaction.totalAmount),
    balanceBefore: String(transaction.balanceBefore),
    balanceAfter: String(transaction.balanceAfter),
    status: transaction.status,
    operator: transaction.operator,
  };
  return headers.map((header) => valuesByHeader[header.trim()] ?? '');
}

export function parseTaskCompletionRow(row: string[], headerIndex: HeaderIndex): TaskCompletion | null {
  const completionId = getRowCell(row, headerIndex, 'completionId');
  const timestamp = getRowCell(row, headerIndex, 'timestamp');
  const taskId = getRowCell(row, headerIndex, 'taskId');
  const studentId = getRowCell(row, headerIndex, 'studentId');
  const studentName = getRowCell(row, headerIndex, 'studentName');
  const reward = parseNumberCell(getRowCell(row, headerIndex, 'reward'));
  const balanceBefore = parseNumberCell(getRowCell(row, headerIndex, 'balanceBefore'));
  const balanceAfter = parseNumberCell(getRowCell(row, headerIndex, 'balanceAfter'));
  if (!completionId || !timestamp || !taskId || !studentId || !studentName || reward === null || balanceBefore === null || balanceAfter === null) return null;
  return {
    completionId,
    timestamp,
    taskId,
    studentId,
    studentName,
    reward,
    balanceBefore,
    balanceAfter,
    status: getRowCell(row, headerIndex, 'status') || 'UNKNOWN',
    note: getRowCell(row, headerIndex, 'note'),
  };
}

export function buildTaskCompletionAppendRow(headers: string[], completion: TaskCompletion): string[] {
  const valuesByHeader: Record<string, string> = {
    completionId: completion.completionId,
    timestamp: completion.timestamp,
    taskId: completion.taskId,
    studentId: completion.studentId,
    studentName: completion.studentName,
    reward: String(completion.reward),
    balanceBefore: String(completion.balanceBefore),
    balanceAfter: String(completion.balanceAfter),
    status: completion.status,
    note: completion.note,
  };
  return headers.map((header) => valuesByHeader[header.trim()] ?? '');
}

function getRowCell(row: string[], headerIndex: HeaderIndex, column: string): string {
  const index = headerIndex.get(column);
  if (index === undefined) return '';
  return String(row[index] ?? '').trim();
}

function parseTransactionItems(value: string): CheckoutLineItem[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CheckoutLineItem => Boolean(item && typeof item === 'object' && 'productId' in item));
  } catch {
    return [];
  }
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
