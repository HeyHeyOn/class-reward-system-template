import type {
  CheckoutLineItem,
  CheckoutLineSnapshot,
  ClassTask,
  Product,
  Promotion,
  PromotionProductLink,
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
import { BudgetExceededError, BudgetUnavailableError, addBudgetSet, equalBudgetValue, trimBudgetString, utf8ByteLength, type BudgetContext } from '@/lib/boundedWork';
import { assertBoundedSheetsHeaderIndex, createBoundedSheetsHeaderIndex, createBoundedSheetsScheduleInputs, registeredBoundedKeys, stringBoundedJson } from '@/lib/boundedJson';

export type HeaderIndex = Map<string, number>;

export type RequiredColumnsResult =
  | { ok: true }
  | { ok: false; missingColumns: string[] };

export function createHeaderIndex(headers: string[], budget?: BudgetContext): HeaderIndex {
  if (budget) return createBoundedSheetsHeaderIndex(headers, budget);
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const normalized = header.trim();
    index.set(normalized, index.has(normalized) ? -1 : position);
  });
  return index;
}

export function requireColumns(headerIndex: HeaderIndex, requiredColumns: readonly string[], budget?: BudgetContext): RequiredColumnsResult {
  if (budget && requiredColumns !== null && (typeof requiredColumns === 'object' || typeof requiredColumns === 'function')) registeredBoundedKeys(requiredColumns, budget);
  return requireRowColumns(headerIndex, requiredColumns, budget);
}
function requireRowColumns(headerIndex: HeaderIndex, requiredColumns: readonly string[], budget?: BudgetContext): RequiredColumnsResult {
  if (budget) {
    assertBoundedSheetsHeaderIndex(headerIndex, budget);
    budget.reserve({ nodes: 3, slots: (Array.isArray(requiredColumns) ? requiredColumns.length : 0) + 2, structuralBytes: 80 + 4 * (Array.isArray(requiredColumns) ? requiredColumns.length : 0) });
    budget.spend();
  }
  const missingColumns = requiredColumns.filter((column) => {
    budget?.spend();
    if (budget && typeof column === 'object' && column !== null) registeredBoundedKeys(column, budget);
    budget?.spend(1 + (typeof column === 'string' ? Math.ceil(column.length / 256) : 0));
    const index = budget ? Map.prototype.get.call(headerIndex, column) as number | undefined : headerIndex.get(column);
    if (budget && index !== undefined && !Number.isSafeInteger(index)) throw new BudgetExceededError();
    const missing = (index ?? -1) < 0; budget?.check(); return missing;
  });
  budget?.spend();
  if (missingColumns.length > 0) return { ok: false, missingColumns };
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

export const REQUIRED_PROMOTION_COLUMNS = [
  'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
  'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
] as const;
export const REQUIRED_PROMOTION_PRODUCT_COLUMNS = [
  'promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion',
] as const;
// Private fixed code schema; never trusts mutation of the public compatibility array.
const PRIVATE_PROMOTION_COLUMNS = Object.freeze(REQUIRED_PROMOTION_COLUMNS.slice());
const PROMOTION_SCHEMA_VERSION = 3;

export function parsePromotionRow(row: string[], headerIndex: HeaderIndex, budget?: BudgetContext): Promotion | null {
  if (budget) { if (row !== null && (typeof row === 'object' || typeof row === 'function')) registeredBoundedKeys(row, budget); assertBoundedSheetsHeaderIndex(headerIndex, budget); }
  if (requireRowColumns(headerIndex, budget ? PRIVATE_PROMOTION_COLUMNS : REQUIRED_PROMOTION_COLUMNS, budget).ok === false) return null;
  const promotionId = getRowCell(row, headerIndex, 'promotionId', budget);
  const name = getRowCell(row, headerIndex, 'name', budget);
  const description = getRowCell(row, headerIndex, 'description', budget);
  const type = getRowCell(row, headerIndex, 'type', budget);
  const valueCell = getRowCell(row, headerIndex, 'value', budget);
  const buyQuantityCell = getRowCell(row, headerIndex, 'buyQuantity', budget);
  const freeQuantityCell = getRowCell(row, headerIndex, 'freeQuantity', budget);
  const startsAt = getRowCell(row, headerIndex, 'startsAt', budget);
  const endsAt = getRowCell(row, headerIndex, 'endsAt', budget);
  const isActive = parseStrictBooleanCell(getRowCell(row, headerIndex, 'isActive', budget), budget);
  const sortOrder = parseSafeIntegerCell(getRowCell(row, headerIndex, 'sortOrder', budget), budget);
  const createdAt = getRowCell(row, headerIndex, 'createdAt', budget);
  const updatedAt = getRowCell(row, headerIndex, 'updatedAt', budget);
  const schemaVersion = parseSafeIntegerCell(getRowCell(row, headerIndex, 'schemaVersion', budget), budget);
  if (!promotionId || !name || !isCanonicalIsoTimestamp(startsAt, budget) || !isCanonicalIsoTimestamp(endsAt, budget)
    || parseDateCell(startsAt, budget) >= parseDateCell(endsAt, budget) || isActive === null || sortOrder === null
    || !isCanonicalIsoTimestamp(createdAt, budget) || !isCanonicalIsoTimestamp(updatedAt, budget)
    || schemaVersion !== PROMOTION_SCHEMA_VERSION) return null;

  // Common record, nested empty productIds, and maximum variant spread.
  budget?.reserve({ nodes: 32, slots: 29, structuralBytes: 768 });
  budget?.spend(29);
  const common = {
    promotionId, name, description, productIds: [], startsAt, endsAt, isActive, sortOrder,
    createdAt, updatedAt, schemaVersion,
  };
  if (equalBudgetValue(type, 'N_PLUS_ONE', budget)) {
    const buyQuantity = parseSafePositiveIntegerCell(buyQuantityCell, budget);
    const freeQuantity = parseSafePositiveIntegerCell(freeQuantityCell, budget);
    return valueCell || buyQuantity === null || freeQuantity === null
      ? null
      : { ...common, type, buyQuantity, freeQuantity };
  }
  if (equalBudgetValue(type, 'PROMOTIONAL_PRICE', budget)) {
    const promotionalUnitPrice = parseSafeNonNegativeIntegerCell(valueCell, budget);
    return buyQuantityCell || freeQuantityCell || promotionalUnitPrice === null
      ? null
      : { ...common, type, promotionalUnitPrice };
  }
  if (equalBudgetValue(type, 'PERCENT_DISCOUNT', budget)) {
    const percent = parseFiniteNumberCell(valueCell, budget);
    return buyQuantityCell || freeQuantityCell || percent === null || percent <= 0 || percent > 100
      ? null
      : { ...common, type, percent };
  }
  if (equalBudgetValue(type, 'FIXED_DISCOUNT', budget)) {
    const discountAmount = parseSafePositiveIntegerCell(valueCell, budget);
    return buyQuantityCell || freeQuantityCell || discountAmount === null
      ? null
      : { ...common, type, discountAmount };
  }
  return null;
}

export function buildPromotionAppendRow(headers: string[], promotion: Promotion, existingRow?: string[]): string[] {
  validateRequiredHeaders(headers, REQUIRED_PROMOTION_COLUMNS);
  validatePromotion(promotion);
  let value = '';
  let buyQuantity = '';
  let freeQuantity = '';
  if (promotion.type === 'N_PLUS_ONE') {
    buyQuantity = String(promotion.buyQuantity);
    freeQuantity = String(promotion.freeQuantity);
  } else if (promotion.type === 'PROMOTIONAL_PRICE') {
    value = String(promotion.promotionalUnitPrice);
  } else if (promotion.type === 'PERCENT_DISCOUNT') {
    value = String(promotion.percent);
  } else {
    value = String(promotion.discountAmount);
  }
  const canonicalValues: Record<string, string> = {
    promotionId: promotion.promotionId,
    name: promotion.name,
    description: promotion.description,
    type: promotion.type,
    value,
    buyQuantity,
    freeQuantity,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    isActive: promotion.isActive ? 'TRUE' : 'FALSE',
    sortOrder: String(promotion.sortOrder),
    createdAt: promotion.createdAt,
    updatedAt: promotion.updatedAt,
    schemaVersion: String(promotion.schemaVersion),
  };
  return buildRowPreservingExistingCells(headers, canonicalValues, existingRow);
}

export function parsePromotionProductRow(row: string[], headerIndex: HeaderIndex): PromotionProductLink | null {
  if (requireColumns(headerIndex, REQUIRED_PROMOTION_PRODUCT_COLUMNS).ok === false) return null;
  const promotionProductId = getRowCell(row, headerIndex, 'promotionProductId');
  const promotionId = getRowCell(row, headerIndex, 'promotionId');
  const productId = getRowCell(row, headerIndex, 'productId');
  const createdAt = getRowCell(row, headerIndex, 'createdAt');
  const schemaVersion = parseSafeIntegerCell(getRowCell(row, headerIndex, 'schemaVersion'));
  if (!promotionProductId || !promotionId || !productId || !isCanonicalIsoTimestamp(createdAt)
    || schemaVersion !== PROMOTION_SCHEMA_VERSION) return null;
  return { promotionProductId, promotionId, productId, createdAt, schemaVersion };
}

export function buildPromotionProductAppendRow(
  headers: string[], link: PromotionProductLink, existingRow?: string[],
): string[] {
  validateRequiredHeaders(headers, REQUIRED_PROMOTION_PRODUCT_COLUMNS);
  validatePromotionProductLink(link);
  const canonicalValues: Record<string, string> = {
    promotionProductId: link.promotionProductId,
    promotionId: link.promotionId,
    productId: link.productId,
    createdAt: link.createdAt,
    schemaVersion: String(link.schemaVersion),
  };
  return buildRowPreservingExistingCells(headers, canonicalValues, existingRow);
}

export function parseTaskRow(row: string[], headerIndex: HeaderIndex, classTimeZone = 'Asia/Seoul', budget?: BudgetContext): ClassTask | null {
  if (budget) { if (row !== null && (typeof row === 'object' || typeof row === 'function')) registeredBoundedKeys(row, budget); assertBoundedSheetsHeaderIndex(headerIndex, budget); }
  const taskId = getRowCell(row, headerIndex, 'taskId', budget);
  const title = getRowCell(row, headerIndex, 'title', budget);
  const reward = parseNumberCell(getRowCell(row, headerIndex, 'reward', budget), budget);
  const sortOrder = parseNumberCell(getRowCell(row, headerIndex, 'sortOrder', budget), budget) ?? 0;

  if (!taskId || !title || reward === null) return null;

  const createdAt = getRowCell(row, headerIndex, 'createdAt', budget);
  const schedule = budget
    ? parseTaskScheduleCells(...createBoundedSheetsScheduleInputs(row, headerIndex, taskId, createdAt, classTimeZone, budget), budget)
    : parseTaskScheduleCells(
      Object.fromEntries(Array.from(headerIndex, ([header, index]) => [header, String(row[index] ?? '').trim()])),
      { taskId, createdAt, classTimeZone },
    );
  // Fixed result and all optional one-field spread operands, before any literal.
  budget?.reserve({ nodes: 24, slots: 24, structuralBytes: 768 });
  budget?.spend(24);
  return {
    taskId,
    title,
    description: getRowCell(row, headerIndex, 'description', budget),
    reward,
    isActive: parseTaskBooleanCell(getRowCell(row, headerIndex, 'isActive', budget), budget),
    sortOrder,
    allowedStudentIds: parseAllowedStudentIds(getRowCell(row, headerIndex, 'allowedStudentIds', budget), budget),
    ...(getRowCell(row, headerIndex, 'availableFrom', budget) ? { availableFrom: getRowCell(row, headerIndex, 'availableFrom', budget) } : {}),
    ...(getRowCell(row, headerIndex, 'dueAt', budget) ? { dueAt: getRowCell(row, headerIndex, 'dueAt', budget) } : {}),
    ...(getRowCell(row, headerIndex, 'prerequisiteTaskId', budget) ? { prerequisiteTaskId: getRowCell(row, headerIndex, 'prerequisiteTaskId', budget) } : {}),
    taskInstanceId: schedule.taskInstanceId,
    schedule: schedule.currentSchedule,
    pendingSchedule: schedule.pendingSchedule,
    ...(schedule.readWarnings ? { scheduleReadWarnings: schedule.readWarnings } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function parseAllowedStudentIds(value: string, budget?: BudgetContext): string[] {
  if (!budget) return Array.from(new Set(value.split(/[\n,;]/).map((id) => id.trim()).filter(Boolean)));
  // This Sheets parser deduplicates in first-occurrence order. The migration
  // normalizer's raw duplicate-rejection list is deliberately a different seam.
  let count = 1;
  budget.spend();
  for (let index = 0; index < value.length; index++) {
    if (index % 256 === 0) budget.spend();
    const code = value.charCodeAt(index);
    if (code === 10 || code === 44 || code === 59) count++;
  }
  const bytes = utf8ByteLength(value, budget);
  if (bytes > budget.limits.stringBytes) throw new BudgetExceededError();
  budget.reserve({ nodes: count + 1, slots: count, contentBytes: bytes, structuralBytes: 16 + 8 * count });
  budget.spend(1 + Math.ceil(value.length / 256));
  const pieces = value.split(/[\n,;]/);
  budget.check();
  budget.reserve({ nodes: 2, slots: count, structuralBytes: 32 + 4 * count });
  budget.spend(2);
  const seen = new Set<string>();
  const output: string[] = [];
  for (let index = 0; index < pieces.length; index++) {
    budget.spend();
    const id = trimBudgetString(pieces[index], budget);
    if (!id) continue;
    budget.spend(1 + Math.ceil(id.length / 256));
    if (seen.has(id)) { budget.check(); continue; }
    addBudgetSet(seen, id, budget);
    budget.spend();
    output.push(id);
    budget.check();
  }
  budget.check();
  return output;
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
    availableFrom: task.availableFrom ?? '',
    dueAt: task.dueAt ?? '',
    prerequisiteTaskId: task.prerequisiteTaskId ?? '',
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
  const totalAmount = parseSafeIntegerCell(getRowCell(row, headerIndex, 'totalAmount'));
  const balanceBefore = parseSafeIntegerCell(getRowCell(row, headerIndex, 'balanceBefore'));
  const balanceAfter = parseSafeIntegerCell(getRowCell(row, headerIndex, 'balanceAfter'));

  if (!transactionId || !timestamp || !studentId || !studentName || totalAmount === null || balanceBefore === null || balanceAfter === null) {
    return null;
  }

  const itemsValue = getRowCell(row, headerIndex, 'items')
    || getRowCell(row, headerIndex, 'itemsJson')
    || getRowCell(row, headerIndex, 'itemJson')
    || getRowCell(row, headerIndex, 'products');
  const parsedItems = parseTransactionItems(itemsValue);
  const transaction: Transaction = {
    transactionId,
    timestamp,
    studentId,
    studentName,
    items: parsedItems.items,
    totalAmount,
    balanceBefore,
    balanceAfter,
    status: getRowCell(row, headerIndex, 'status') || 'UNKNOWN',
    operator: getRowCell(row, headerIndex, 'operator') || 'unknown',
  };
  if (parsedItems.malformed) {
    Object.defineProperty(transaction, 'itemsMalformed', { value: true, enumerable: false });
  }
  return transaction;
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
  const operationId = getRowCell(row, headerIndex, 'operationId');
  const operationPayloadHash = getRowCell(row, headerIndex, 'operationPayloadHash');
  if (Boolean(operationId) !== Boolean(operationPayloadHash)) return null;
  const snapshotValues = TASK_COMPLETION_SNAPSHOT_FIELDS.map((field) => getRowCell(row, headerIndex, field));
  if (snapshotValues.every((value) => !value)) {
    return operationId ? null : completion;
  }

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
    ...(operationId ? { operationId, operationPayloadHash } : {}),
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
    operationId: completion.operationId ?? '',
    operationPayloadHash: completion.operationPayloadHash ?? '',
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

function getRowCell(row: string[], headerIndex: HeaderIndex, column: string, budget?: BudgetContext): string {
  if (budget) { if (row !== null && (typeof row === 'object' || typeof row === 'function')) registeredBoundedKeys(row, budget); assertBoundedSheetsHeaderIndex(headerIndex, budget); budget.spend(1 + Math.ceil(column.length / 256)); }
  const index = budget ? Map.prototype.get.call(headerIndex, column) as number | undefined : headerIndex.get(column);
  if (budget && index !== undefined && !Number.isSafeInteger(index)) throw new BudgetExceededError();
  if (index === undefined || index < 0) return '';
  if (budget && typeof row === 'string') budget.reserveString(3);
  if (budget) return trimBudgetString(stringBoundedJson(row[index] ?? '', budget), budget);
  return String(row[index] ?? '').trim();
}

function parseTransactionItems(value: string): {
  items: Array<CheckoutLineItem | CheckoutLineSnapshot>;
  malformed: boolean;
} {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return { items: [], malformed: true };
    const items: Array<CheckoutLineItem | CheckoutLineSnapshot> = [];
    let malformed = false;
    for (const item of parsed) {
      if (isCheckoutLineSnapshot(item) || isLegacyCheckoutLineItem(item)) items.push(item);
      else malformed = true;
    }
    return { items, malformed };
  } catch {
    return { items: [], malformed: true };
  }
}

const SNAPSHOT_ONLY_FIELDS = [
  'regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity',
  'finalTotal', 'totalDiscount', 'adjustments', 'appliedPromotions',
] as const;

export function isCheckoutLineSnapshot(value: unknown): value is CheckoutLineSnapshot {
  if (!isRecord(value) || !SNAPSHOT_ONLY_FIELDS.some((field) => field in value)) return false;
  if (!hasCheckoutLineBase(value)
    || !isSafeNonNegativeInteger(value.regularUnitPrice)
    || !isSafeNonNegativeInteger(value.regularTotal)
    || !isSafePositiveInteger(value.totalQuantity)
    || !isSafeNonNegativeInteger(value.paidQuantity)
    || !isSafeNonNegativeInteger(value.freeQuantity)
    || !isSafeNonNegativeInteger(value.finalTotal)
    || !isSafeNonNegativeInteger(value.totalDiscount)
    || value.price !== value.regularUnitPrice
    || value.quantity !== value.totalQuantity
    || value.subtotal !== value.finalTotal
    || value.paidQuantity + value.freeQuantity !== value.totalQuantity
    || value.regularUnitPrice * value.totalQuantity !== value.regularTotal
    || value.regularTotal - value.finalTotal !== value.totalDiscount
    || !Array.isArray(value.adjustments) || !Array.isArray(value.appliedPromotions)
    || value.adjustments.length !== value.appliedPromotions.length) return false;

  let expectedBefore = value.regularTotal;
  let discountTotal = 0;
  for (let index = 0; index < value.adjustments.length; index += 1) {
    const adjustment = value.adjustments[index];
    const promotion = value.appliedPromotions[index];
    if (!isRecord(adjustment) || !isPersistedPromotion(promotion, value.productId)
      || !isNonBlankString(adjustment.promotionId)
      || adjustment.promotionId !== promotion.promotionId || adjustment.type !== promotion.type
      || !isSafeNonNegativeInteger(adjustment.beforeAmount)
      || !isSafeNonNegativeInteger(adjustment.afterAmount)
      || !isSafeNonNegativeInteger(adjustment.discountAmount)
      || adjustment.beforeAmount !== expectedBefore
      || adjustment.beforeAmount - adjustment.afterAmount !== adjustment.discountAmount
      || ('freeQuantity' in adjustment && !isSafeNonNegativeInteger(adjustment.freeQuantity))) return false;
    expectedBefore = adjustment.afterAmount;
    discountTotal += adjustment.discountAmount;
  }
  return expectedBefore === value.finalTotal && discountTotal === value.totalDiscount;
}

function isLegacyCheckoutLineItem(value: unknown): value is CheckoutLineItem {
  return isRecord(value) && !SNAPSHOT_ONLY_FIELDS.some((field) => field in value) && hasCheckoutLineBase(value);
}

function hasCheckoutLineBase(value: Record<string, unknown>): value is Record<string, unknown> & CheckoutLineItem {
  return isNonBlankString(value.productId) && isNonBlankString(value.name)
    && Number.isSafeInteger(value.price) && Number.isSafeInteger(value.subtotal)
    && isSafePositiveInteger(value.quantity);
}

function isPersistedPromotion(value: unknown, productId: string): value is Promotion {
  if (!isRecord(value) || !isNonBlankString(value.promotionId) || !isNonBlankString(value.name)
    || typeof value.description !== 'string' || !Array.isArray(value.productIds)
    || !value.productIds.every(isNonBlankString) || !value.productIds.includes(productId)
    || !isCanonicalIsoTimestamp(value.startsAt) || !isCanonicalIsoTimestamp(value.endsAt)
    || Date.parse(value.startsAt) >= Date.parse(value.endsAt) || typeof value.isActive !== 'boolean'
    || !Number.isSafeInteger(value.sortOrder) || !isCanonicalIsoTimestamp(value.createdAt)
    || !isCanonicalIsoTimestamp(value.updatedAt) || value.schemaVersion !== PROMOTION_SCHEMA_VERSION) return false;
  if (value.type === 'N_PLUS_ONE') return isSafePositiveInteger(value.buyQuantity) && isSafePositiveInteger(value.freeQuantity);
  if (value.type === 'PROMOTIONAL_PRICE') return isSafeNonNegativeInteger(value.promotionalUnitPrice);
  if (value.type === 'PERCENT_DISCOUNT') return typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent > 0 && value.percent <= 100;
  return value.type === 'FIXED_DISCOUNT' && isSafePositiveInteger(value.discountAmount);
}

function parseDateCell(value: string, budget?: BudgetContext): number {
  budget?.reserve({ nodes: 1, structuralBytes: 4 });
  budget?.spend(1 + Math.ceil(value.length / 256));
  try { const result = Date.parse(value); budget?.check(); return result; }
  catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
}
function isCanonicalIsoTimestamp(value: unknown, budget?: BudgetContext): value is string {
  budget?.spend();
  if (typeof value !== 'string') return false;
  const timestamp = parseDateCell(value, budget);
  budget?.spend();
  if (!Number.isFinite(timestamp)) return false;
  budget?.reserve({ nodes: 1, structuralBytes: 16 });
  budget?.reserveString(27);
  budget?.spend();
  try {
    const date = new Date(timestamp); budget?.check();
    budget?.spend();
    const canonical = date.toISOString();
    budget?.check(); return equalBudgetValue(canonical, value, budget);
  } catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseNumberCell(value: string, budget?: BudgetContext): number | null {
  budget?.spend();
  if (!value) return null;
  if (budget) { budget.reserveString(utf8ByteLength(value, budget)); budget.spend(1 + Math.ceil(value.length / 256)); }
  const normalized = value.replace(/,/g, ''); budget?.check();
  budget?.reserve({ nodes: 1, structuralBytes: 4 });
  budget?.spend(1 + Math.ceil(normalized.length / 256));
  let parsed: number;
  try { parsed = Number(normalized); budget?.check(); }
  catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
  return finiteNumberResult(parsed, budget);
}

function parsePositiveIntegerCell(value: string): number | null {
  const parsed = parseNumberCell(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseFiniteNumberCell(value: string, budget?: BudgetContext): number | null {
  budget?.spend();
  if (!value) return null;
  budget?.reserve({ nodes: 1, structuralBytes: 4 });
  budget?.spend(1 + Math.ceil(value.length / 256));
  let parsed: number;
  try { parsed = Number(value); budget?.check(); }
  catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
  return finiteNumberResult(parsed, budget);
}
function finiteNumberResult(value: number, budget?: BudgetContext): number | null {
  budget?.spend();
  try {
    const finite = Number.isFinite(value); budget?.check();
    return finite ? value : null;
  } catch (error) { if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error; budget?.check(); throw error; }
}

function parseSafeIntegerCell(value: string, budget?: BudgetContext): number | null {
  budget?.spend();
  const parsed = parseFiniteNumberCell(value, budget);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSafePositiveIntegerCell(value: string, budget?: BudgetContext): number | null {
  budget?.spend();
  const parsed = parseSafeIntegerCell(value, budget);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseSafeNonNegativeIntegerCell(value: string, budget?: BudgetContext): number | null {
  budget?.spend();
  const parsed = parseSafeIntegerCell(value, budget);
  return parsed !== null && parsed >= 0 ? parsed : null;
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

function buildRowPreservingExistingCells(
  headers: string[],
  canonicalValues: Readonly<Record<string, string>>,
  existingRow?: string[],
): string[] {
  const rowLength = Math.max(headers.length, existingRow?.length ?? 0);
  const result = Array.from({ length: rowLength }, (_, index) => String(existingRow?.[index] ?? ''));
  headers.forEach((header, index) => {
    const normalized = header.trim();
    if (Object.prototype.hasOwnProperty.call(canonicalValues, normalized)) {
      result[index] = canonicalValues[normalized];
    }
  });
  return result;
}

function validatePromotion(promotion: Promotion): void {
  const candidate = promotion as Promotion & Record<string, unknown>;
  if (!Array.isArray(candidate.productIds) || candidate.productIds.length !== 0) {
    throw new Error('Promotion row productIds must be empty; persist targets through PromotionProducts');
  }
  const commonIsValid = Boolean(promotion && typeof promotion === 'object'
    && isRequiredString(candidate.promotionId) && isRequiredString(candidate.name)
    && typeof candidate.description === 'string' && isCanonicalIsoTimestamp(candidate.startsAt)
    && isCanonicalIsoTimestamp(candidate.endsAt) && Date.parse(candidate.startsAt) < Date.parse(candidate.endsAt)
    && typeof candidate.isActive === 'boolean' && Number.isSafeInteger(candidate.sortOrder)
    && isCanonicalIsoTimestamp(candidate.createdAt) && isCanonicalIsoTimestamp(candidate.updatedAt)
    && candidate.schemaVersion === PROMOTION_SCHEMA_VERSION);
  let typeIsValid = false;
  if (commonIsValid && candidate.type === 'N_PLUS_ONE') {
    typeIsValid = isSafePositiveInteger(candidate.buyQuantity) && isSafePositiveInteger(candidate.freeQuantity)
      && candidate.promotionalUnitPrice === undefined && candidate.percent === undefined && candidate.discountAmount === undefined;
  } else if (commonIsValid && candidate.type === 'PROMOTIONAL_PRICE') {
    typeIsValid = isSafeNonNegativeInteger(candidate.promotionalUnitPrice)
      && candidate.buyQuantity === undefined && candidate.freeQuantity === undefined
      && candidate.percent === undefined && candidate.discountAmount === undefined;
  } else if (commonIsValid && candidate.type === 'PERCENT_DISCOUNT') {
    typeIsValid = typeof candidate.percent === 'number' && Number.isFinite(candidate.percent)
      && candidate.percent > 0 && candidate.percent <= 100 && candidate.buyQuantity === undefined
      && candidate.freeQuantity === undefined && candidate.promotionalUnitPrice === undefined
      && candidate.discountAmount === undefined;
  } else if (commonIsValid && candidate.type === 'FIXED_DISCOUNT') {
    typeIsValid = isSafePositiveInteger(candidate.discountAmount) && candidate.buyQuantity === undefined
      && candidate.freeQuantity === undefined && candidate.promotionalUnitPrice === undefined && candidate.percent === undefined;
  }
  if (!commonIsValid || !typeIsValid) throw new Error('Promotion must be a valid complete schema-v3 promotion');
}

function validatePromotionProductLink(link: PromotionProductLink): void {
  if (!link || typeof link !== 'object' || !isRequiredString(link.promotionProductId)
    || !isRequiredString(link.promotionId) || !isRequiredString(link.productId)
    || !isCanonicalIsoTimestamp(link.createdAt) || link.schemaVersion !== PROMOTION_SCHEMA_VERSION) {
    throw new Error('PromotionProductLink must be a valid complete schema-v3 link');
  }
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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

function parseStrictBooleanCell(value: string, budget?: BudgetContext): boolean | null {
  if (equalBudgetValue(value, 'TRUE', budget)) return true;
  if (equalBudgetValue(value, 'FALSE', budget)) return false;
  return null;
}

function parseTaskBooleanCell(value: string, budget?: BudgetContext): boolean {
  const normalized = trimBudgetString(value, budget);
  budget?.spend(1 + Math.ceil(normalized.length / 256));
  const result = /^(true|1|yes|y|활성)$/i.test(normalized); budget?.check(); return result;
}

function parseStudentStatus(value: string): StudentStatus | null {
  if (value === 'ACTIVE' || value === 'INACTIVE') return value;

  return null;
}
