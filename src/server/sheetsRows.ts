import type {
  CheckoutLineItem,
  ClassTask,
  Product,
  Student,
  StudentStatus,
  TaskAssignment,
  TaskAssignmentSource,
  TaskAssignmentStatusValue,
  TaskCompletion,
  TaskCompletionSource,
  Transaction,
} from '@/domain/types';
import { parseTaskScheduleCells, serializeTaskScheduleCells } from '@/domain/taskSchedule';

export type HeaderIndex = Map<string, number>;

export type RequiredColumnsResult =
  | { ok: true }
  | { ok: false; missingColumns: string[] };

export function createHeaderIndex(headers: string[]): HeaderIndex {
  return new Map(headers.map((header, index) => [header.trim(), index]));
}

export function requireColumns(headerIndex: HeaderIndex, requiredColumns: readonly string[]): RequiredColumnsResult {
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

export function parseTaskRow(row: string[], headerIndex: HeaderIndex, classTimeZone = 'Asia/Seoul'): ClassTask | null {
  const taskId = getRowCell(row, headerIndex, 'taskId');
  const title = getRowCell(row, headerIndex, 'title');
  const reward = parseNumberCell(getRowCell(row, headerIndex, 'reward'));
  const sortOrder = parseNumberCell(getRowCell(row, headerIndex, 'sortOrder')) ?? 0;

  if (!taskId || !title || reward === null) return null;

  const createdAt = getRowCell(row, headerIndex, 'createdAt');
  const schedule = parseTaskScheduleCells(
    Object.fromEntries(Array.from(headerIndex, ([header, index]) => [header, String(row[index] ?? '').trim()])),
    { taskId, createdAt, classTimeZone },
  );
  return {
    taskId,
    title,
    description: getRowCell(row, headerIndex, 'description'),
    reward,
    isActive: parseTaskBooleanCell(getRowCell(row, headerIndex, 'isActive')),
    sortOrder,
    allowedStudentIds: parseAllowedStudentIds(getRowCell(row, headerIndex, 'allowedStudentIds')),
    taskInstanceId: schedule.taskInstanceId,
    schedule: schedule.currentSchedule,
    pendingSchedule: schedule.pendingSchedule,
    ...(schedule.readWarnings ? { scheduleReadWarnings: schedule.readWarnings } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function parseAllowedStudentIds(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,;]/).map((id) => id.trim()).filter(Boolean)));
}

export function buildTaskAppendRow(headers: string[], task: ClassTask, timestamp: string, existingRow?: string[]): string[] {
  const valuesByHeader: Record<string, string> = {
    ...Object.fromEntries(headers.map((header, index) => [header.trim(), String(existingRow?.[index] ?? '')])),
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    reward: String(task.reward),
    maxCompletionsPerStudent: existingRow ? String(existingRow[headers.findIndex((header) => header.trim() === 'maxCompletionsPerStudent')] ?? '') : '1',
    isActive: task.isActive ? 'TRUE' : 'FALSE',
    sortOrder: String(task.sortOrder),
    createdAt: timestamp,
    updatedAt: timestamp,
    allowedStudentIds: task.allowedStudentIds.join(','),
    ...(task.taskInstanceId && task.schedule
      ? serializeTaskScheduleCells({
          taskInstanceId: task.taskInstanceId,
          currentSchedule: task.schedule,
          pendingSchedule: task.pendingSchedule ?? null,
          ...(task.scheduleReadWarnings ? { readWarnings: task.scheduleReadWarnings } : {}),
        })
      : {}),
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
  const completion: TaskCompletion = {
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
  const snapshotValues = TASK_COMPLETION_SNAPSHOT_FIELDS.map((field) => getRowCell(row, headerIndex, field));
  if (snapshotValues.every((value) => !value)) return completion;

  const [taskInstanceId, cycleId, cycleStartsAt, cycleEndsAt, ruleVersionCell, timeZone, sourceCell, assignmentId, schemaVersionCell] = snapshotValues;
  const ruleVersion = parsePositiveIntegerCell(ruleVersionCell);
  const schemaVersion = parsePositiveIntegerCell(schemaVersionCell);
  const source = parseTaskCompletionSource(sourceCell);
  if (!taskInstanceId || !cycleId || !cycleStartsAt || !timeZone || !source || ruleVersion === null
    || schemaVersion !== LEDGER_SCHEMA_VERSION) return null;
  if (source === 'CARRY_FORWARD' && (reward !== 0 || balanceBefore !== balanceAfter)) return null;
  return {
    ...completion,
    taskInstanceId,
    cycleId,
    cycleStartsAt,
    cycleEndsAt: cycleEndsAt || null,
    ruleVersion,
    timeZone,
    source,
    assignmentId,
    schemaVersion,
  };
}

export function buildTaskCompletionAppendRow(headers: string[], completion: TaskCompletion): string[] {
  validateRequiredHeaders(headers, REQUIRED_TASK_COMPLETION_COLUMNS);
  validateTaskCompletionBase(completion);
  validateTaskCompletionSnapshot(completion);
  const snapshot = completion as TaskCompletion & Record<(typeof TASK_COMPLETION_SNAPSHOT_FIELDS)[number], unknown>;
  if (TASK_COMPLETION_SNAPSHOT_FIELDS.some((field) => snapshot[field] !== undefined)) {
    validateRequiredHeaders(headers, TASK_COMPLETION_SNAPSHOT_FIELDS);
  }
  if (completion.source === 'CARRY_FORWARD' && (completion.reward !== 0 || completion.balanceBefore !== completion.balanceAfter)) {
    throw new Error('CARRY_FORWARD completion must have reward 0 and an unchanged balance');
  }
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
    taskInstanceId: completion.taskInstanceId ?? '',
    cycleId: completion.cycleId ?? '',
    cycleStartsAt: completion.cycleStartsAt ?? '',
    cycleEndsAt: completion.cycleEndsAt ?? '',
    ruleVersion: completion.ruleVersion === undefined ? '' : String(completion.ruleVersion),
    timeZone: completion.timeZone ?? '',
    source: completion.source ?? '',
    assignmentId: completion.assignmentId ?? '',
    schemaVersion: completion.schemaVersion === undefined ? '' : String(completion.schemaVersion),
  };
  return headers.map((header) => valuesByHeader[header.trim()] ?? '');
}

const TASK_COMPLETION_SNAPSHOT_FIELDS = [
  'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source',
  'assignmentId', 'schemaVersion',
] as const;
export const REQUIRED_TASK_COMPLETION_COLUMNS = [
  'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore',
  'balanceAfter', 'status', 'note',
] as const;
export const REQUIRED_TASK_ASSIGNMENT_COLUMNS = [
  'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
  'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note',
] as const;
const LEDGER_SCHEMA_VERSION = 2;

export function parseTaskAssignmentRow(row: string[], headerIndex: HeaderIndex): TaskAssignment | null {
  const assignmentId = getRowCell(row, headerIndex, 'assignmentId');
  const taskId = getRowCell(row, headerIndex, 'taskId');
  const taskInstanceId = getRowCell(row, headerIndex, 'taskInstanceId');
  const cycleId = getRowCell(row, headerIndex, 'cycleId');
  const cycleStartsAt = getRowCell(row, headerIndex, 'cycleStartsAt');
  const cycleEndsAt = getRowCell(row, headerIndex, 'cycleEndsAt');
  const ruleVersion = parsePositiveIntegerCell(getRowCell(row, headerIndex, 'ruleVersion'));
  const timeZone = getRowCell(row, headerIndex, 'timeZone');
  const studentId = getRowCell(row, headerIndex, 'studentId');
  const status = parseTaskAssignmentStatus(getRowCell(row, headerIndex, 'status'));
  const source = parseTaskAssignmentSource(getRowCell(row, headerIndex, 'source'));
  const createdAt = getRowCell(row, headerIndex, 'createdAt');
  const schemaVersion = parsePositiveIntegerCell(getRowCell(row, headerIndex, 'schemaVersion'));
  if (!assignmentId || !taskId || !taskInstanceId || !cycleId || !cycleStartsAt
    || ruleVersion === null || !timeZone || !studentId || !status || !source || !createdAt
    || schemaVersion !== LEDGER_SCHEMA_VERSION) return null;
  return {
    assignmentId, taskId, taskInstanceId, cycleId, cycleStartsAt, cycleEndsAt: cycleEndsAt || null, ruleVersion, timeZone,
    studentId, status, source,
    previousAssignmentId: getRowCell(row, headerIndex, 'previousAssignmentId'),
    createdAt, schemaVersion, note: getRowCell(row, headerIndex, 'note'),
  };
}

/** Deliberately maps without sorting: physical append order is the ledger order. */
export function parseTaskAssignmentRows(rows: string[][], headerIndex: HeaderIndex): TaskAssignment[] {
  return rows.map((row) => parseTaskAssignmentRow(row, headerIndex)).filter((event): event is TaskAssignment => event !== null);
}

export function buildTaskAssignmentAppendRow(headers: string[], assignment: TaskAssignment): string[] {
  validateRequiredHeaders(headers, REQUIRED_TASK_ASSIGNMENT_COLUMNS);
  validateTaskAssignment(assignment);
  const valuesByHeader: Record<string, string> = {
    ...assignment,
    cycleEndsAt: assignment.cycleEndsAt ?? '',
    ruleVersion: String(assignment.ruleVersion),
    schemaVersion: String(assignment.schemaVersion),
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

function parsePositiveIntegerCell(value: string): number | null {
  const parsed = parseNumberCell(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRequiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRequiredHeaders(headers: string[], requiredHeaders: readonly string[]): void {
  const normalizedHeaders = headers.map((header) => header.trim());
  const missing = requiredHeaders.filter((header) => !normalizedHeaders.includes(header));
  const duplicates = requiredHeaders.filter(
    (header) => normalizedHeaders.filter((candidate) => candidate === header).length > 1,
  );
  if (missing.length > 0 || duplicates.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
      ...(duplicates.length > 0 ? [`duplicate: ${duplicates.join(', ')}`] : []),
    ].join('; ');
    throw new Error(`Ledger headers are invalid (${details})`);
  }
}

function validateTaskCompletionBase(completion: TaskCompletion): void {
  if (!isRequiredString(completion.completionId) || !isRequiredString(completion.timestamp)
    || !isRequiredString(completion.taskId) || !isRequiredString(completion.studentId)
    || !isRequiredString(completion.studentName) || !isRequiredString(completion.status)
    || typeof completion.note !== 'string' || !Number.isFinite(completion.reward)
    || !Number.isFinite(completion.balanceBefore) || !Number.isFinite(completion.balanceAfter)) {
    throw new Error('TaskCompletion must contain all required legacy fields');
  }
}

function validateTaskCompletionSnapshot(completion: TaskCompletion): void {
  const snapshot = completion as TaskCompletion & Record<(typeof TASK_COMPLETION_SNAPSHOT_FIELDS)[number], unknown>;
  if (TASK_COMPLETION_SNAPSHOT_FIELDS.every((field) => snapshot[field] === undefined)) return;
  if (!isRequiredString(snapshot.taskInstanceId) || !isRequiredString(snapshot.cycleId)
    || !isRequiredString(snapshot.cycleStartsAt)
    || !(snapshot.cycleEndsAt === null || isRequiredString(snapshot.cycleEndsAt))
    || !isPositiveInteger(snapshot.ruleVersion) || !isRequiredString(snapshot.timeZone)
    || parseTaskCompletionSource(String(snapshot.source ?? '')) === null
    || snapshot.schemaVersion !== LEDGER_SCHEMA_VERSION
    || !(snapshot.assignmentId === undefined || typeof snapshot.assignmentId === 'string')) {
    throw new Error('TaskCompletion snapshot must be entirely absent or a valid complete versioned snapshot');
  }
}

function validateTaskAssignment(assignment: TaskAssignment): void {
  if (!isRequiredString(assignment.assignmentId) || !isRequiredString(assignment.taskId)
    || !isRequiredString(assignment.taskInstanceId) || !isRequiredString(assignment.cycleId)
    || !isRequiredString(assignment.cycleStartsAt)
    || !(assignment.cycleEndsAt === null || isRequiredString(assignment.cycleEndsAt))
    || !isPositiveInteger(assignment.ruleVersion) || !isRequiredString(assignment.timeZone)
    || !isRequiredString(assignment.studentId) || parseTaskAssignmentStatus(String(assignment.status ?? '')) === null
    || parseTaskAssignmentSource(String(assignment.source ?? '')) === null || !isRequiredString(assignment.createdAt)
    || assignment.schemaVersion !== LEDGER_SCHEMA_VERSION
    || typeof assignment.previousAssignmentId !== 'string' || typeof assignment.note !== 'string') {
    throw new Error('TaskAssignment must contain a valid complete versioned snapshot');
  }
}

function parseTaskAssignmentStatus(value: string): TaskAssignmentStatusValue | null {
  return value === 'ASSIGNED' || value === 'UNASSIGNED' ? value : null;
}

function parseTaskAssignmentSource(value: string): TaskAssignmentSource | null {
  return value === 'ADMIN' || value === 'QR' || value === 'LEGACY_SEED' || value === 'CARRY_FORWARD' ? value : null;
}

function parseTaskCompletionSource(value: string): TaskCompletionSource | null {
  return value === 'BANK' || value === 'ADMIN' || value === 'CARRY_FORWARD' || value === 'ADMIN_RESET' ? value : null;
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
