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

export type HeaderIndex = Map<string, number>;

export type RequiredColumnsResult =
  | { ok: true }
  | { ok: false; missingColumns: string[] };

export function createHeaderIndex(headers: string[]): HeaderIndex {
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const normalized = header.trim();
    index.set(normalized, index.has(normalized) ? -1 : position);
  });
  return index;
}

export function requireColumns(headerIndex: HeaderIndex, requiredColumns: readonly string[]): RequiredColumnsResult {
  const missingColumns = requiredColumns.filter((column) => (headerIndex.get(column) ?? -1) < 0);

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

export const REQUIRED_PROMOTION_COLUMNS = [
  'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
  'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
] as const;
export const REQUIRED_PROMOTION_PRODUCT_COLUMNS = [
  'promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion',
] as const;
const PROMOTION_SCHEMA_VERSION = 3;

export function parsePromotionRow(row: string[], headerIndex: HeaderIndex): Promotion | null {
  if (requireColumns(headerIndex, REQUIRED_PROMOTION_COLUMNS).ok === false) return null;
  const promotionId = getRowCell(row, headerIndex, 'promotionId');
  const name = getRowCell(row, headerIndex, 'name');
  const description = getRowCell(row, headerIndex, 'description');
  const type = getRowCell(row, headerIndex, 'type');
  const valueCell = getRowCell(row, headerIndex, 'value');
  const buyQuantityCell = getRowCell(row, headerIndex, 'buyQuantity');
  const freeQuantityCell = getRowCell(row, headerIndex, 'freeQuantity');
  const startsAt = getRowCell(row, headerIndex, 'startsAt');
  const endsAt = getRowCell(row, headerIndex, 'endsAt');
  const isActive = parseStrictBooleanCell(getRowCell(row, headerIndex, 'isActive'));
  const sortOrder = parseSafeIntegerCell(getRowCell(row, headerIndex, 'sortOrder'));
  const createdAt = getRowCell(row, headerIndex, 'createdAt');
  const updatedAt = getRowCell(row, headerIndex, 'updatedAt');
  const schemaVersion = parseSafeIntegerCell(getRowCell(row, headerIndex, 'schemaVersion'));
  if (!promotionId || !name || !isParseableDate(startsAt) || !isParseableDate(endsAt)
    || Date.parse(startsAt) > Date.parse(endsAt) || isActive === null || sortOrder === null
    || !isParseableDate(createdAt) || !isParseableDate(updatedAt)
    || schemaVersion !== PROMOTION_SCHEMA_VERSION) return null;

  const common = {
    promotionId, name, description, productIds: [], startsAt, endsAt, isActive, sortOrder,
    createdAt, updatedAt, schemaVersion,
  };
  if (type === 'N_PLUS_ONE') {
    const buyQuantity = parseSafePositiveIntegerCell(buyQuantityCell);
    const freeQuantity = parseSafePositiveIntegerCell(freeQuantityCell);
    return valueCell || buyQuantity === null || freeQuantity === null
      ? null
      : { ...common, type, buyQuantity, freeQuantity };
  }
  if (type === 'PROMOTIONAL_PRICE') {
    const promotionalUnitPrice = parseSafeNonNegativeIntegerCell(valueCell);
    return buyQuantityCell || freeQuantityCell || promotionalUnitPrice === null
      ? null
      : { ...common, type, promotionalUnitPrice };
  }
  if (type === 'PERCENT_DISCOUNT') {
    const percent = parseFiniteNumberCell(valueCell);
    return buyQuantityCell || freeQuantityCell || percent === null || percent <= 0 || percent > 100
      ? null
      : { ...common, type, percent };
  }
  if (type === 'FIXED_DISCOUNT') {
    const discountAmount = parseSafePositiveIntegerCell(valueCell);
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
  if (!promotionProductId || !promotionId || !productId || !isParseableDate(createdAt)
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
  if (index === undefined || index < 0) return '';
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

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

function parseFiniteNumberCell(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSafeIntegerCell(value: string): number | null {
  const parsed = parseFiniteNumberCell(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSafePositiveIntegerCell(value: string): number | null {
  const parsed = parseSafeIntegerCell(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseSafeNonNegativeIntegerCell(value: string): number | null {
  const parsed = parseSafeIntegerCell(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function isParseableDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
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
    && typeof candidate.description === 'string' && isParseableDate(candidate.startsAt)
    && isParseableDate(candidate.endsAt) && Date.parse(candidate.startsAt) <= Date.parse(candidate.endsAt)
    && typeof candidate.isActive === 'boolean' && Number.isSafeInteger(candidate.sortOrder)
    && isParseableDate(candidate.createdAt) && isParseableDate(candidate.updatedAt)
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
    || !isParseableDate(link.createdAt) || link.schemaVersion !== PROMOTION_SCHEMA_VERSION) {
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

function parseStrictBooleanCell(value: string): boolean | null {
  if (value === 'TRUE') return true;
  if (value === 'FALSE') return false;
  return null;
}

function parseTaskBooleanCell(value: string): boolean {
  return /^(true|1|yes|y|활성)$/i.test(value.trim());
}

function parseStudentStatus(value: string): StudentStatus | null {
  if (value === 'ACTIVE' || value === 'INACTIVE') return value;

  return null;
}
