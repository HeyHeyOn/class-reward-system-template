import { parsePromotionRow, parseTaskRow, createHeaderIndex } from '@/server/sheetsRows';
import { parseCheckoutLineSnapshot } from '@/lib/checkoutSnapshotClient';
import type { SheetsSnapshot, SheetSnapshotRow } from './sheetsSnapshot';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import {
  canonicalId, canonicalInstant, canonicalJson, compareCodeUnits, deterministicId,
  isHexDigest, isPlainRecord, safeInteger, sha256, strictBoolean,
} from './validators';

export type Diagnostic = Readonly<{ code: string; path: string; sourceDigest: string }>;
export type SourcePointer =
  | Readonly<{ kind: 'SHEET'; artifactDigest: string; tab: string; rowNumber: number; rowHash: string }>
  | Readonly<{ kind: 'REDIS'; artifactDigest: string; provenance: string; sourceDigest: string }>;
export type NormalizedSourceRecord = Readonly<{
  source: SourcePointer;
  redactedSourceRecord: Readonly<{ identityDigest: string; recognizedFieldCount: number; omittedFieldCount: number }>;
  canonicalRecord: Readonly<Record<string, unknown>> | null;
  mappingStatus: 'STAGED' | 'QUARANTINED';
  targetTable?: string;
  targetId?: string;
  warningCodes: readonly string[];
  errorCodes: readonly string[];
}>;
export type SourceMapping = Readonly<{ sourceDigest: string; targetTable: string; targetId: string; status: 'STAGED' }>;

type Target = { table: string; id: string; record: Record<string, unknown> };
type Ref = { code: string; table: string; id: string };
type Entry = {
  source: SourcePointer; tab: string; identity: string; sourcePrimaryIdentity: string | null;
  redacted: NormalizedSourceRecord['redactedSourceRecord'];
  canonical: Record<string, unknown> | null; targets: Target[]; refs: Ref[]; warnings: string[]; errors: string[];
};

const REQUIRED: Record<number, Record<string, readonly string[]>> = {
  1: {
    Students: ['studentId', 'name', 'balance', 'status'], Products: ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
    Transactions: ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
    Adjustments: ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator'], Settings: ['key', 'value'],
    Tasks: ['taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds'],
    TaskCompletions: ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note'],
  },
  2: {}, 3: {},
};
const TASK_V2 = [
  ...REQUIRED[1].Tasks, 'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
  'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
  'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime',
  'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
] as const;
const COMPLETION_SNAPSHOT_HEADERS = ['taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion', 'operationId', 'operationPayloadHash'];
REQUIRED[2] = { ...REQUIRED[1], Tasks: TASK_V2,
  TaskAssignments: ['assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'],
  TaskCompletions: [...REQUIRED[1].TaskCompletions, ...COMPLETION_SNAPSHOT_HEADERS],
};
REQUIRED[3] = { ...REQUIRED[2], Tasks: [...TASK_V2, 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays'],
  Promotions: ['promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion'],
  PromotionProducts: ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'],
};
const EVIDENCE_HEADERS = ['operationId', 'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName'];
const OPERATIONAL_SETTINGS = new Set(['schemaVersion', 'systemVersion', 'systemName', 'appTitle', 'bankTitle', 'currencyUnit', 'classTimeZone', 'themeColor', 'qrManualInputEnabled']);
const FINANCIAL_TABS = new Set(['Transactions', 'Adjustments', 'TaskAssignments', 'TaskCompletions']);
const TAB_COLLECTIONS: Record<string, readonly string[]> = {
  Students: ['students', 'accounts'], Products: ['products'], Transactions: ['transactions', 'transaction_items'],
  Adjustments: ['adjustments'], Tasks: ['tasks', 'task_allowed_students'], TaskAssignments: ['task_assignments'],
  TaskCompletions: ['task_completions'], Promotions: ['promotions'], PromotionProducts: ['promotion_products'],
};
const MAX_DIAGNOSTICS = 4_096;

function knownHeaders(schemaVersion: number, tab: string): ReadonlySet<string> {
  return new Set([
    ...(REQUIRED[schemaVersion]?.[tab] ?? []),
    ...(tab === 'TaskCompletions' ? EVIDENCE_HEADERS : []),
  ]);
}

export function normalizeLegacySnapshots(input: { tenantId: string; migrationJobId: string; sheets: SheetsSnapshot; redis?: RedisClaimSnapshot }) {
  const entries: Entry[] = [];
  const warnings: Diagnostic[] = [];
  const conflicts: Diagnostic[] = [];
  let diagnosticCount = 0;
  const pushDiagnostics = (target: Diagnostic[], ...items: Diagnostic[]) => {
    if (diagnosticCount + items.length > MAX_DIAGNOSTICS) {
      throw new Error('Legacy migration output exceeds normalization bounds.');
    }
    diagnosticCount += items.length;
    target.push(...items);
  };
  const collections = new Set<string>();
  const headerIndexes = new Map<string, Map<string, number>>();

  for (const tab of Object.keys(input.sheets.tabs).sort(compareCodeUnits)) {
    const snapshot = input.sheets.tabs[tab];
    for (const collection of TAB_COLLECTIONS[tab] ?? []) collections.add(collection);
    const normalized = snapshot.headers.map((header) => header.trim());
    const counts = new Map<string, number>();
    normalized.forEach((header) => counts.set(header, (counts.get(header) ?? 0) + 1));
    const required = REQUIRED[input.sheets.schemaVersion][tab] ?? [];
    const known = knownHeaders(input.sheets.schemaVersion, tab);
    normalized.forEach((header, index) => {
      if (!header) pushDiagnostics(warnings, diag('BLANK_HEADER', `${tab}.headers[${index}]`, input.sheets.digest));
      else if (!known.has(header)) pushDiagnostics(warnings, diag('UNKNOWN_HEADER', `${tab}.headers[${index}]`, input.sheets.digest));
      if (header && counts.get(header)! > 1 && normalized.indexOf(header) === index) pushDiagnostics(conflicts, diag('DUPLICATE_HEADER', `${tab}.${header}`, input.sheets.digest));
    });
    for (const column of required) {
      if ((counts.get(column) ?? 0) !== 1) pushDiagnostics(conflicts, diag('MISSING_REQUIRED_COLUMN', `${tab}.${column}`, input.sheets.digest));
    }
    const index = createHeaderIndex([...snapshot.headers]);
    headerIndexes.set(tab, index);
    const badHeader = required.some((column) => (index.get(column) ?? -1) < 0);
    for (const row of snapshot.rows) {
      const entry = makeEntry(input.sheets, tab, row, snapshot.headers, index, input.tenantId, input.migrationJobId, badHeader);
      entries.push(entry);
      entry.targets.forEach((target) => collections.add(target.table));
    }
  }

  const claimOutput = normalizeClaims(input, entries);
  entries.push(...claimOutput.entries);
  pushDiagnostics(conflicts, ...claimOutput.conflicts);
  claimOutput.collections.forEach((name) => collections.add(name));
  markDuplicates(entries);
  validateRequiredSettings(entries, input.sheets.schemaVersion, (code, path) => {
    pushDiagnostics(conflicts, diag(code, path, input.sheets.digest));
  });
  validateTransactionCancellations(entries);
  correlateAdjustments(entries, input.tenantId);
  validateReferences(entries);
  propagateClaimErrors(entries);

  const targetsByCollection: Record<string, Target[]> = Object.create(null);
  for (const name of [...collections].sort(compareCodeUnits)) targetsByCollection[name] = [];
  const sourceRecords: NormalizedSourceRecord[] = [];
  const mappings: SourceMapping[] = [];
  for (const entry of entries) {
    if (entry.errors.length) {
      sourceRecords.push(toSourceRecord(entry));
      for (const code of [...new Set(entry.errors)].sort(compareCodeUnits)) pushDiagnostics(conflicts, diag(code, sourcePath(entry.source), sourceDigest(entry.source)));
      continue;
    }
    for (const target of entry.targets) {
      targetsByCollection[target.table] ??= [];
      targetsByCollection[target.table].push(target);
      mappings.push({ sourceDigest: sourceDigest(entry.source), targetTable: target.table, targetId: target.id, status: 'STAGED' });
    }
    sourceRecords.push(toSourceRecord(entry));
  }
  const records: Record<string, Record<string, unknown>[]> = Object.create(null);
  for (const [name, targets] of Object.entries(targetsByCollection)) {
    targets.sort((a, b) => compareCodeUnits(a.id, b.id));
    const unique = new Map<string, Target>();
    for (const target of targets) unique.set(target.id, target);
    records[name] = [...unique.values()].map((target) => target.record);
  }
  mappings.sort((a, b) => compareCodeUnits(`${a.targetTable}\0${a.targetId}\0${a.sourceDigest}`, `${b.targetTable}\0${b.targetId}\0${b.sourceDigest}`));
  sourceRecords.sort((a, b) => compareCodeUnits(sourcePath(a.source), sourcePath(b.source)) || compareCodeUnits(sourceDigest(a.source), sourceDigest(b.source)));
  return { records, sourceRecords, mappings, warnings: stableDiagnostics(warnings), blockingConflicts: stableDiagnostics(conflicts) };
}

function makeEntry(sheets: SheetsSnapshot, tab: string, row: SheetSnapshotRow, headers: readonly string[], index: Map<string, number>, tenantId: string, jobId: string, badHeader: boolean): Entry {
  const cell = (name: string) => { const position = index.get(name); return position === undefined || position < 0 ? '' : String(row.cells[position] ?? '').trim(); };
  const source: SourcePointer = { kind: 'SHEET', artifactDigest: sheets.digest, tab, rowNumber: row.rowNumber, rowHash: row.hash };
  const sourcePrimaryIdentity = canonicalId(cell(primaryField(tab)));
  const identity = cell(primaryField(tab)) || row.hash;
  const known = knownHeaders(sheets.schemaVersion, tab);
  const recognizedFieldCount = headers.filter((header) => known.has(header.trim())).length;
  const entry: Entry = { source, tab, identity, sourcePrimaryIdentity, redacted: { identityDigest: sha256(identity), recognizedFieldCount, omittedFieldCount: headers.length - recognizedFieldCount }, canonical: null, targets: [], refs: [], warnings: [], errors: badHeader ? ['INVALID_HEADER'] : [] };
  if (badHeader) return entry;
  const target = (table: string, id: string, record: Record<string, unknown>) => entry.targets.push({ table, id, record: { ...record } });
  const requiredId = (name: string) => canonicalId(cell(name));
  const malformed = () => entry.errors.push(FINANCIAL_TABS.has(tab) ? 'MALFORMED_REQUIRED_HISTORY' : 'MALFORMED_REQUIRED_RECORD');

  if (tab === 'Students') {
    const id = requiredId('studentId'), name = cell('name'), balance = safeInteger(cell('balance'));
    const status = cell('status');
    if (!id || !name || balance === null || !['ACTIVE', 'INACTIVE'].includes(status)) malformed();
    else { entry.canonical = { studentId: id, name, balance, status }; target('students', id, { tenantId, studentId: id, name, status }); target('accounts', id, { tenantId, studentId: id, balance }); }
  } else if (tab === 'Products') {
    const id = requiredId('productId'), name = cell('name'), price = safeInteger(cell('price'), { min: 0 }), stock = safeInteger(cell('stock'), { min: 0 }), active = strictBoolean(cell('isActive')), sort = safeInteger(cell('sortOrder'));
    if (!id || !name || price === null || stock === null || active === null || sort === null) malformed();
    else { entry.canonical = { productId: id, name, price, stock, isActive: active, imageUrl: cell('imageUrl') || null, category: cell('category') || null, sortOrder: sort }; target('products', id, { tenantId, ...entry.canonical }); }
  } else if (tab === 'Transactions') {
    normalizeTransaction(entry, cell, tenantId, jobId, target, malformed);
  } else if (tab === 'Adjustments') {
    const id = requiredId('adjustmentId'), timestamp = canonicalInstant(cell('timestamp')), studentId = requiredId('studentId'), amount = safeInteger(cell('amount')), mode = cell('mode'), operator = cell('operator');
    if (!id || !timestamp || !studentId || amount === null || !['add', 'subtract', 'set'].includes(mode) || !operator
      || (mode !== 'set' && amount < 0)) malformed();
    else { entry.canonical = { adjustmentId: id, timestamp, studentId, amount, mode, operator, operatorDigest: sha256(operator) }; entry.refs.push({ code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId }); }
  } else if (tab === 'Settings') {
    const key = cell('key'), value = cell('value');
    if (!key) malformed();
    else if (OPERATIONAL_SETTINGS.has(key)) { entry.canonical = { key, value }; target('settings', key, { tenantId, key, value }); }
    else { entry.canonical = { key, valueDigest: sha256(value) }; entry.warnings.push('SETTING_OMITTED'); }
  } else if (tab === 'Tasks') {
    normalizeTask(entry, cell, index, row, sheets.schemaVersion, tenantId, target, malformed);
  } else if (tab === 'TaskAssignments') {
    normalizeAssignment(entry, cell, tenantId, target, malformed);
  } else if (tab === 'TaskCompletions') {
    normalizeCompletion(entry, cell, row, index, sheets.schemaVersion, tenantId, target, malformed);
  } else if (tab === 'Promotions') {
    normalizePromotion(entry, row, index, tenantId, target, malformed);
  } else if (tab === 'PromotionProducts') {
    const id = requiredId('promotionProductId'), promotionId = requiredId('promotionId'), productId = requiredId('productId'), createdAt = canonicalInstant(cell('createdAt')), version = safeInteger(cell('schemaVersion'), { min: 1 });
    if (!id || !promotionId || !productId || !createdAt || version !== 3) malformed();
    else { entry.canonical = { promotionProductId: id, promotionId, productId, createdAt, schemaVersion: version }; entry.refs.push({ code: 'BROKEN_PROMOTION_REFERENCE', table: 'promotions', id: promotionId }, { code: 'BROKEN_PRODUCT_REFERENCE', table: 'products', id: productId }); target('promotion_products', id, { tenantId, ...entry.canonical }); }
  } else entry.warnings.push('UNSUPPORTED_TAB');
  return entry;
}

function normalizeTransaction(entry: Entry, cell: (name: string) => string, tenantId: string, jobId: string, target: (table: string, id: string, record: Record<string, unknown>) => void, malformed: () => void) {
  const id = canonicalId(cell('transactionId')), timestamp = canonicalInstant(cell('timestamp')), studentId = canonicalId(cell('studentId')), studentName = cell('studentName');
  const total = safeInteger(cell('totalAmount')), before = safeInteger(cell('balanceBefore')), after = safeInteger(cell('balanceAfter')), status = cell('status'), operator = cell('operator');
  let items: unknown;
  try { items = JSON.parse(cell('items')); } catch { items = null; }
  const supportedStatuses = new Set(['COMPLETED', 'CANCELLED', 'TASK_REWARD', 'ADMIN_ADJUSTMENT', 'CANCEL_REVERSAL']);
  if (!id || !timestamp || !studentId || !studentName || total === null || before === null || after === null
    || !operator || !supportedStatuses.has(status) || !Array.isArray(items)) { malformed(); return; }
  const balanceDelta = after - before;
  if (!Number.isSafeInteger(balanceDelta)) { malformed(); return; }

  if (status === 'CANCEL_REVERSAL') {
    const originalId = cancellationOriginalId(operator);
    entry.canonical = { transactionId: id, timestamp, studentId, studentName, items: [], totalAmount: total, balanceBefore: before, balanceAfter: after, status, operator, reversesTransactionId: originalId };
    if (!originalId || originalId === id || items.length !== 0 || total >= 0 || balanceDelta <= 0 || total !== -balanceDelta) {
      entry.errors.push('MALFORMED_CANCELLATION_HISTORY');
      return;
    }
    entry.refs.push(
      { code: 'BROKEN_TRANSACTION_REFERENCE', table: 'transactions', id: originalId },
      { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId },
    );
    target('transactions', id, { tenantId, transactionId: id, occurredAt: timestamp, studentId, studentNameSnapshot: studentName, kind: 'CANCELLATION', legacyTotalAmount: total, balanceDelta, balanceBefore: before, balanceAfter: after, operatorSnapshot: operator, legacyStatusSnapshot: status, reversesTransactionId: originalId });
    return;
  }

  const purchase = status === 'COMPLETED' || status === 'CANCELLED';
  const adminAdjustment = status === 'ADMIN_ADJUSTMENT';
  if ((purchase && (!items.length || total < 0 || balanceDelta !== -total))
    || (adminAdjustment ? items.length !== 1 : !purchase && items.length !== 0)
    || (status === 'TASK_REWARD' && balanceDelta !== total)
    || (status === 'ADMIN_ADJUSTMENT' && balanceDelta !== -total)) { malformed(); return; }
  const canonicalItems: Record<string, unknown>[] = [];
  const productIds = new Set<string>();
  let itemTotal = 0;
  for (let line = 0; line < items.length; line += 1) {
    const item = canonicalTransactionItem(items[line], adminAdjustment);
    if (!item || productIds.has(item.productId)) { malformed(); return; }
    const productId = item.productId;
    productIds.add(productId);
    const nextTotal = itemTotal + item.subtotal;
    if (!Number.isSafeInteger(nextTotal)) { malformed(); return; }
    itemTotal = nextTotal;
    if (!adminAdjustment) entry.refs.push({ code: 'BROKEN_PRODUCT_REFERENCE', table: 'products', id: productId });
    const itemId = deterministicId(tenantId, jobId, 'transaction_items', id, String(line + 1), canonicalJson(item));
    canonicalItems.push({ ...item, itemId, transactionId: id, lineNumber: line + 1 });
  }
  if (purchase && itemTotal !== total) { malformed(); return; }
  entry.canonical = { transactionId: id, timestamp, studentId, studentName, items: canonicalItems, totalAmount: total, balanceBefore: before, balanceAfter: after, status, operator };
  entry.refs.push({ code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId });
  target('transactions', id, { tenantId, transactionId: id, occurredAt: timestamp, studentId, studentNameSnapshot: studentName, kind: transactionKind(status), legacyTotalAmount: total, balanceDelta, balanceBefore: before, balanceAfter: after, operatorSnapshot: operator, legacyStatusSnapshot: status });
  canonicalItems.forEach((item) => target(
    'transaction_items', String(item.itemId), stagedTransactionItem(item, tenantId, adminAdjustment),
  ));
}

function stagedTransactionItem(item: Record<string, unknown>, tenantId: string, adminAdjustment: boolean) {
  const record: Record<string, unknown> = {
    tenantId,
    itemId: item.itemId,
    transactionId: item.transactionId,
    lineNumber: item.lineNumber,
    productIdSnapshot: item.productId,
    currentProductId: adminAdjustment ? null : item.productId,
    productNameSnapshot: item.name,
    quantity: item.quantity,
    unitPriceSnapshot: item.price,
    subtotalSnapshot: item.subtotal,
  };
  if ('regularUnitPrice' in item) Object.assign(record, {
    regularUnitPrice: item.regularUnitPrice,
    regularTotal: item.regularTotal,
    totalQuantity: item.totalQuantity,
    paidQuantity: item.paidQuantity,
    freeQuantity: item.freeQuantity,
    finalTotal: item.finalTotal,
    totalDiscount: item.totalDiscount,
    adjustmentsSnapshot: item.adjustments,
    appliedPromotionsSnapshot: item.appliedPromotions,
  });
  return record;
}

const LEGACY_TRANSACTION_ITEM_KEYS = ['productId', 'name', 'price', 'quantity', 'subtotal'] as const;
const EXTENDED_TRANSACTION_ITEM_KEYS = [
  ...LEGACY_TRANSACTION_ITEM_KEYS, 'regularUnitPrice', 'regularTotal', 'totalQuantity',
  'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustments', 'appliedPromotions',
] as const;

function canonicalTransactionItem(value: unknown, signedLegacy = false): ({ productId: string; name: string; price: number; quantity: number; subtotal: number } & Record<string, unknown>) | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  const legacy = exactKeys(keys, LEGACY_TRANSACTION_ITEM_KEYS);
  const extended = exactKeys(keys, EXTENDED_TRANSACTION_ITEM_KEYS);
  if (!legacy && !extended) return null;
  const productId = typeof value.productId === 'string' ? canonicalId(value.productId) : null;
  const name = typeof value.name === 'string' && value.name.length > 0 && value.name === value.name.trim() ? value.name : null;
  const price = typeof value.price === 'number' && Number.isSafeInteger(value.price) ? value.price : null;
  const subtotal = typeof value.subtotal === 'number' && Number.isSafeInteger(value.subtotal) ? value.subtotal : null;
  if (!productId || !name || price === null || subtotal === null
    || (!signedLegacy && (price < 0 || subtotal < 0)) || !positiveSafeInteger(value.quantity)
    || !Number.isSafeInteger(price * value.quantity)) return null;
  if (legacy) {
    if (price * value.quantity !== subtotal) return null;
    return { productId, name, price, quantity: value.quantity, subtotal };
  }
  if (signedLegacy) return null;
  if (!exactExtendedItemChildren(value)) return null;
  const parsed = parseCheckoutLineSnapshot(value);
  return parsed ? {
    productId: parsed.productId, name: parsed.name, price: parsed.price, quantity: parsed.quantity,
    subtotal: parsed.subtotal, regularUnitPrice: parsed.regularUnitPrice, regularTotal: parsed.regularTotal,
    totalQuantity: parsed.totalQuantity, paidQuantity: parsed.paidQuantity, freeQuantity: parsed.freeQuantity,
    finalTotal: parsed.finalTotal, totalDiscount: parsed.totalDiscount,
    adjustments: parsed.adjustments.map((adjustment) => ({ ...adjustment })),
    appliedPromotions: parsed.appliedPromotions.map((promotion) => ({ ...promotion, productIds: [...promotion.productIds] })),
  } : null;
}

function exactExtendedItemChildren(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.adjustments) || !Array.isArray(value.appliedPromotions)) return false;
  const adjustmentsExact = value.adjustments.every((adjustment) => isPlainRecord(adjustment)
    && exactKeys(Object.keys(adjustment), adjustment.type === 'N_PLUS_ONE'
      ? ['promotionId', 'type', 'beforeAmount', 'afterAmount', 'discountAmount', 'freeQuantity']
      : ['promotionId', 'type', 'beforeAmount', 'afterAmount', 'discountAmount']));
  const promotionsExact = value.appliedPromotions.every((promotion) => {
    if (!isPlainRecord(promotion)) return false;
    const common = ['promotionId', 'name', 'description', 'productIds', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion', 'type'];
    const typeKey = promotion.type === 'N_PLUS_ONE' ? ['buyQuantity', 'freeQuantity']
      : promotion.type === 'PROMOTIONAL_PRICE' ? ['promotionalUnitPrice']
        : promotion.type === 'PERCENT_DISCOUNT' ? ['percent']
          : promotion.type === 'FIXED_DISCOUNT' ? ['discountAmount'] : [];
    return typeKey.length > 0 && exactKeys(Object.keys(promotion), [...common, ...typeKey]);
  });
  return adjustmentsExact && promotionsExact;
}

function exactKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}
function positiveSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

function normalizeTask(entry: Entry, cell: (name: string) => string, index: Map<string, number>, row: SheetSnapshotRow, version: number, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>) => void, malformed: () => void) {
  const id = canonicalId(cell('taskId')), title = cell('title'), reward = safeInteger(cell('reward'), { min: 0 }), active = strictBoolean(cell('isActive')), sort = safeInteger(cell('sortOrder'));
  const createdAt = canonicalInstant(cell('createdAt')), updatedAt = canonicalInstant(cell('updatedAt'));
  const availableFrom = cell('availableFrom') ? canonicalInstant(cell('availableFrom')) : null;
  const dueAt = cell('dueAt') ? canonicalInstant(cell('dueAt')) : null;
  if (!id || !title || reward === null || active === null || sort === null || !createdAt || !updatedAt
    || (cell('availableFrom') && !availableFrom) || (cell('dueAt') && !dueAt)
    || Date.parse(updatedAt) < Date.parse(createdAt)
    || (availableFrom && dueAt && Date.parse(dueAt) <= Date.parse(availableFrom))) { malformed(); return; }
  const parsed = parseTaskRow([...row.cells], index, 'Asia/Seoul');
  if (!parsed || parsed.scheduleReadWarnings?.length) { malformed(); return; }
  const instanceId = canonicalId(parsed.taskInstanceId) ?? `legacy:${id}:${createdAt}`;
  const allowed = cell('allowedStudentIds').split(/[\n,;]/).map((studentId) => studentId.trim()).filter(Boolean);
  if (allowed.some((studentId) => !canonicalId(studentId))) { malformed(); return; }
  if (new Set(allowed).size !== allowed.length) { entry.errors.push('DUPLICATE_ALLOWED_STUDENT_ID'); return; }
  const prerequisiteTaskId = cell('prerequisiteTaskId') ? canonicalId(cell('prerequisiteTaskId')) : null;
  if (cell('prerequisiteTaskId') && !prerequisiteTaskId) { malformed(); return; }
  if (prerequisiteTaskId === id) { entry.errors.push('SELF_TASK_REFERENCE'); return; }
  allowed.sort(compareCodeUnits);
  entry.canonical = { taskId: id, taskInstanceId: instanceId, title, description: cell('description'), reward, isActive: active, sortOrder: sort, createdAt, updatedAt, allowedStudentIds: allowed, currentSchedule: parsed.schedule, pendingSchedule: parsed.pendingSchedule ?? null, availableFrom, dueAt, prerequisiteTaskId, schemaVersion: version };
  for (const studentId of allowed) entry.refs.push({ code: 'BROKEN_ALLOWED_STUDENT_REFERENCE', table: 'students', id: studentId });
  if (prerequisiteTaskId) entry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'task_business', id: prerequisiteTaskId });
  target('tasks', instanceId, { tenantId, ...entry.canonical });
  for (const studentId of allowed) { const linkId = deterministicId(tenantId, 'task_allowed_students', instanceId, studentId); target('task_allowed_students', linkId, { tenantId, taskInstanceId: instanceId, studentId }); }
}

function normalizeAssignment(entry: Entry, cell: (name: string) => string, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>) => void, malformed: () => void) {
  const id = canonicalId(cell('assignmentId')), taskId = canonicalId(cell('taskId')), instanceId = canonicalId(cell('taskInstanceId')), studentId = canonicalId(cell('studentId'));
  const starts = canonicalInstant(cell('cycleStartsAt')), ends = cell('cycleEndsAt') ? canonicalInstant(cell('cycleEndsAt')) : null, created = canonicalInstant(cell('createdAt'));
  const rule = safeInteger(cell('ruleVersion'), { min: 1 }), schema = safeInteger(cell('schemaVersion'), { min: 1 }), status = cell('status'), source = cell('source');
  const previousAssignmentId = cell('previousAssignmentId') ? canonicalId(cell('previousAssignmentId')) : null;
  if (!id || !taskId || !instanceId || !studentId || !starts || (cell('cycleEndsAt') && !ends) || (ends && Date.parse(ends) <= Date.parse(starts)) || !created || rule === null || schema !== 2 || cell('timeZone') !== 'Asia/Seoul' || !['ASSIGNED', 'UNASSIGNED'].includes(status) || !['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(source) || !canonicalId(cell('cycleId')) || (cell('previousAssignmentId') && !previousAssignmentId)) { malformed(); return; }
  if (previousAssignmentId === id) { entry.errors.push('SELF_ASSIGNMENT_REFERENCE'); return; }
  entry.canonical = { assignmentId: id, taskId, taskInstanceId: instanceId, cycleId: cell('cycleId'), cycleStartsAt: starts, cycleEndsAt: ends, ruleVersion: rule, timeZone: 'Asia/Seoul', studentId, status, source, previousAssignmentId, createdAt: created, schemaVersion: schema, note: cell('note') };
  entry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'tasks', id: instanceId }, { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId });
  if (previousAssignmentId) entry.refs.push({ code: 'BROKEN_ASSIGNMENT_REFERENCE', table: 'task_assignments', id: previousAssignmentId });
  target('task_assignments', id, { tenantId, ...entry.canonical });
}

function normalizeCompletion(entry: Entry, cell: (name: string) => string, row: SheetSnapshotRow, index: Map<string, number>, sourceSchemaVersion: number, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>) => void, malformed: () => void) {
  const raw = (name: string) => { const position = index.get(name); return position === undefined || position < 0 ? '' : String(row.cells[position] ?? ''); };
  const id = canonicalId(cell('completionId')), taskId = canonicalId(cell('taskId')), studentId = canonicalId(cell('studentId')), timestamp = canonicalInstant(cell('timestamp'));
  const reward = safeInteger(cell('reward')), before = safeInteger(cell('balanceBefore')), after = safeInteger(cell('balanceAfter')), status = cell('status');
  if (!id || !taskId || !studentId || !timestamp || !cell('studentName') || reward === null || before === null || after === null || !status) { malformed(); return; }
  const snapshotRequired = ['taskInstanceId', 'cycleId', 'cycleStartsAt', 'ruleVersion', 'timeZone', 'source', 'schemaVersion'];
  const hasSnapshot = sourceSchemaVersion >= 2;
  const instanceId = hasSnapshot ? canonicalId(cell('taskInstanceId')) : null;
  const starts = canonicalInstant(cell('cycleStartsAt'));
  const ends = cell('cycleEndsAt') ? canonicalInstant(cell('cycleEndsAt')) : null;
  if (hasSnapshot && (snapshotRequired.some((name) => !cell(name)) || !instanceId || !canonicalId(cell('cycleId')) || !starts
    || (cell('cycleEndsAt') && !ends) || (ends && starts && Date.parse(ends) <= Date.parse(starts))
    || safeInteger(cell('ruleVersion'), { min: 1 }) === null || cell('timeZone') !== 'Asia/Seoul'
    || !['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'].includes(cell('source')) || safeInteger(cell('schemaVersion')) !== 2)) { malformed(); return; }
  const operationId = cell('operationId'), operationPayloadHash = cell('operationPayloadHash').toLowerCase();
  if (Boolean(operationId) !== Boolean(operationPayloadHash) || (operationId && (!canonicalId(operationId) || !/^sha256:[a-f0-9]{64}$/.test(operationPayloadHash)))) { malformed(); return; }
  const evidenceValues = EVIDENCE_HEADERS.slice(2).map(cell);
  const rememberInvalidEvidence = () => { entry.canonical = { completionId: id, taskId, studentId, taskInstanceId: instanceId, cycleId: cell('cycleId') || null, cycleStartsAt: starts, operationId: operationId || null, operationPayloadHash: operationPayloadHash || null, tupleDigest: sha256(`${cell('evidenceBoardId')}\0${cell('evidencePostId')}`) }; malformed(); };
  if (evidenceValues.some(Boolean) && (!evidenceValues.every(Boolean) || !operationId || cell('evidenceProvider') !== 'PADLET'
    || !/^[A-Za-z0-9]{16,22}$/.test(cell('evidenceBoardId')) || !/^[A-Za-z0-9_-]{3,128}$/.test(cell('evidencePostId'))
    || !canonicalInstant(cell('evidenceCreatedAt')) || raw('evidenceAuthorFullName') !== cell('evidenceAuthorFullName')
    || cell('evidenceAuthorFullName').length > 200)) { rememberInvalidEvidence(); return; }
  const source = cell('source');
  if (hasSnapshot && source === 'CARRY_FORWARD' && (reward !== 0 || before !== after)) { malformed(); return; }
  if (hasSnapshot && source === 'BANK' && operationId && after - before !== reward) { malformed(); return; }
  if (source === 'ADMIN_RESET') {
    const administratorReset = reward === 0 && before === after;
    const cancellationReset = Boolean(operationId) && reward > 0 && Number.isSafeInteger(before - reward) && after === before - reward;
    if (status !== 'RESET' || (!administratorReset && !cancellationReset)) { malformed(); return; }
  }
  const binding = evidenceValues.every(Boolean) ? { taskId, studentId, cycleStartsAt: starts, evidence: { evidenceProvider: 'PADLET', evidenceBoardId: cell('evidenceBoardId'), evidencePostId: cell('evidencePostId'), evidenceCreatedAt: cell('evidenceCreatedAt'), evidenceAuthorFullName: cell('evidenceAuthorFullName') } } : null;
  if (binding && operationPayloadHash !== `sha256:${sha256(canonicalJson(binding))}`) { rememberInvalidEvidence(); return; }
  entry.canonical = { completionId: id, timestamp, taskId, studentId, studentName: cell('studentName'), reward, balanceBefore: before, balanceAfter: after, status, note: cell('note'), taskInstanceId: instanceId, cycleId: cell('cycleId') || null, cycleStartsAt: starts, cycleEndsAt: ends, ruleVersion: hasSnapshot ? safeInteger(cell('ruleVersion')) : null, timeZone: cell('timeZone') || null, source: source || null, assignmentId: cell('assignmentId') || null, schemaVersion: hasSnapshot ? 2 : 1, operationId: operationId || null, operationPayloadHash: operationPayloadHash || null, ...(binding ? { ...binding.evidence, tupleDigest: sha256(`${binding.evidence.evidenceBoardId}\0${binding.evidence.evidencePostId}`) } : {}) };
  entry.refs.push({ code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: studentId }, { code: 'BROKEN_TASK_REFERENCE', table: instanceId ? 'tasks' : 'task_business', id: instanceId ?? taskId });
  if (cell('assignmentId')) entry.refs.push({ code: 'BROKEN_ASSIGNMENT_REFERENCE', table: 'task_assignments', id: cell('assignmentId') });
  target('task_completions', id, { tenantId, ...entry.canonical });
}

function normalizePromotion(entry: Entry, row: SheetSnapshotRow, index: Map<string, number>, tenantId: string, target: (table: string, id: string, record: Record<string, unknown>) => void, malformed: () => void) {
  const parsed = parsePromotionRow([...row.cells], index);
  const id = parsed && canonicalId(parsed.promotionId);
  if (!parsed || !id) { malformed(); return; }
  const promotion = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'productIds'));
  entry.canonical = promotion;
  target('promotions', id, { tenantId, ...promotion });
}

function correlateAdjustments(entries: Entry[], tenantId: string) {
  const transactionIndex = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.tab !== 'Transactions' || !entry.canonical
      || entry.canonical.status !== 'ADMIN_ADJUSTMENT') continue;
    const key = adjustmentTransactionKey(entry.canonical);
    if (!key) {
      if (!entry.errors.includes('MALFORMED_REQUIRED_HISTORY')) entry.errors.push('MALFORMED_REQUIRED_HISTORY');
      continue;
    }
    const group = transactionIndex.get(key) ?? [];
    group.push(entry);
    transactionIndex.set(key, group);
  }

  const adjustmentIndex = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.tab !== 'Adjustments' || !entry.canonical) continue;
    const key = adjustmentKey(entry.canonical);
    if (!key) continue;
    const group = adjustmentIndex.get(key) ?? [];
    group.push(entry);
    adjustmentIndex.set(key, group);
  }

  const keys = new Set([...adjustmentIndex.keys(), ...transactionIndex.keys()]);
  for (const key of keys) {
    const adjustments = adjustmentIndex.get(key) ?? [];
    const transactions = transactionIndex.get(key) ?? [];
    if (adjustments.length !== 1 || transactions.length !== 1) {
      for (const implicated of [...adjustments, ...transactions]) {
        if (!implicated.errors.includes('AMBIGUOUS_ADJUSTMENT_TRANSACTION')) {
          implicated.errors.push('AMBIGUOUS_ADJUSTMENT_TRANSACTION');
        }
      }
      continue;
    }
    const adjustment = adjustments[0];
    const transaction = transactions[0];
    if (adjustment.errors.length > 0 || transaction.errors.length > 0) {
      for (const implicated of [adjustment, transaction]) {
        if (!implicated.errors.includes('AMBIGUOUS_ADJUSTMENT_TRANSACTION')) {
          implicated.errors.push('AMBIGUOUS_ADJUSTMENT_TRANSACTION');
        }
      }
      continue;
    }
    const transactionId = String(transaction.canonical!.transactionId);
    const value = adjustment.canonical!;
    value.transactionId = transactionId;
    adjustment.refs.push({ code: 'BROKEN_TRANSACTION_REFERENCE', table: 'transactions', id: transactionId });
    adjustment.targets.push({
      table: 'adjustments', id: String(value.adjustmentId), record: {
        tenantId, adjustmentId: value.adjustmentId, transactionId,
        mode: value.mode, requestedAmount: value.amount, operatorSnapshot: value.operator,
        legacyAdjustmentId: value.adjustmentId,
      },
    });
  }
}

function adjustmentKey(adjustment: Record<string, unknown>): string | null {
  const { timestamp, studentId, operator, mode, amount } = adjustment;
  if (typeof timestamp !== 'string' || typeof studentId !== 'string' || typeof operator !== 'string'
    || !['add', 'subtract', 'set'].includes(String(mode)) || !Number.isSafeInteger(amount)
    || (mode !== 'set' && (amount as number) < 0)) return null;
  return canonicalJson([timestamp, studentId, operator, mode, amount]);
}

function adjustmentTransactionKey(transaction: Record<string, unknown>): string | null {
  const { timestamp, studentId, operator, status, totalAmount, balanceBefore, balanceAfter } = transaction;
  if (status !== 'ADMIN_ADJUSTMENT' || typeof timestamp !== 'string' || typeof studentId !== 'string'
    || typeof operator !== 'string' || !Number.isSafeInteger(totalAmount)
    || !Number.isSafeInteger(balanceBefore) || !Number.isSafeInteger(balanceAfter)
    || !Array.isArray(transaction.items) || transaction.items.length !== 1) return null;
  const item = transaction.items[0] as Record<string, unknown>;
  const before = balanceBefore as number;
  const after = balanceAfter as number;
  const total = totalAmount as number;
  let mode: 'add' | 'subtract' | 'set';
  let requested: number;
  if (item.productId === 'ADMIN-ADD' && item.name === '관리자 지급') {
    mode = 'add'; requested = after - before;
    if (!Number.isSafeInteger(requested) || requested < 0 || total !== -requested) return null;
  } else if (item.productId === 'ADMIN-SUBTRACT' && item.name === '관리자 회수') {
    mode = 'subtract'; requested = before - after;
    if (!Number.isSafeInteger(requested) || requested < 0 || total !== requested) return null;
  } else if (item.productId === 'ADMIN-SET' && item.name === '관리자 잔액 지정') {
    mode = 'set'; requested = after;
    if (!Number.isSafeInteger(requested) || !Number.isSafeInteger(before - after) || total !== before - after) return null;
  } else return null;
  if (item.price !== total || item.quantity !== 1 || item.subtotal !== total) return null;
  return canonicalJson([timestamp, studentId, operator, mode, requested]);
}

function markDuplicates(entries: Entry[]) {
  const byTarget = new Map<string, Entry[]>();
  for (const entry of entries) for (const target of entry.targets) {
    if (target.table === 'padlet_evidence_claims') continue;
    const key = `${target.table}\0${target.id}`;
    const group = byTarget.get(key) ?? []; group.push(entry); byTarget.set(key, group);
  }
  for (const group of byTarget.values()) if (group.length > 1) {
    for (const entry of group) entry.errors.push(FINANCIAL_TABS.has(entry.tab) ? 'DUPLICATE_LEDGER_ID'
      : entry.tab === 'Settings' ? 'DUPLICATE_SETTING_KEY' : 'DUPLICATE_PRIMARY_ID');
  }
  markBusinessDuplicate(entries.filter((entry) => entry.tab === 'Tasks' && entry.canonical), (entry) => String(entry.canonical!.taskId));
  markBusinessDuplicate(
    entries.filter((entry) => FINANCIAL_TABS.has(entry.tab) && entry.sourcePrimaryIdentity),
    (entry) => `${entry.tab}\0${entry.sourcePrimaryIdentity}`,
    'DUPLICATE_LEDGER_ID',
  );
  markBusinessDuplicate(entries.filter((entry) => entry.tab === 'PromotionProducts' && entry.canonical), (entry) => `${entry.canonical!.promotionId}\0${entry.canonical!.productId}`);
  markBusinessDuplicate(entries.filter((entry) => entry.tab === 'TaskCompletions' && entry.canonical?.operationId), (entry) => String(entry.canonical!.operationId), 'DUPLICATE_LEDGER_ID');
}

function validateRequiredSettings(entries: Entry[], schemaVersion: number, missing: (code: string, path: string) => void) {
  const settings = entries.filter((entry) => entry.tab === 'Settings' && entry.canonical);
  const validateOne = (key: string, code: string, valid: (value: unknown) => boolean) => {
    const matches = settings.filter((entry) => entry.canonical!.key === key);
    if (matches.length === 0) {
      missing(code, `Settings.${key}`);
      return;
    }
    if (matches.length !== 1 || !valid(matches[0].canonical!.value)) {
      matches.forEach((entry) => entry.errors.push(code));
    }
  };
  validateOne('schemaVersion', 'INVALID_SCHEMA_VERSION_SETTING', (value) => value === String(schemaVersion));
  validateOne('classTimeZone', 'INVALID_CLASS_TIME_ZONE_SETTING', (value) => typeof value === 'string' && isSupportedTimeZone(value));
}

function isSupportedTimeZone(value: string): boolean {
  if (value !== value.trim() || (value !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) return false;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

function validateTransactionCancellations(entries: Entry[]) {
  const transactions = entries.filter((entry) => entry.tab === 'Transactions' && entry.canonical);
  const byId = new Map<string, Entry[]>();
  for (const entry of transactions) {
    const id = String(entry.canonical!.transactionId);
    const group = byId.get(id) ?? [];
    group.push(entry);
    byId.set(id, group);
  }
  const reversals = transactions.filter((entry) => entry.canonical!.status === 'CANCEL_REVERSAL');
  const linked = new Map<string, Entry[]>();
  for (const reversal of reversals) {
    const value = reversal.canonical!;
    const originalId = String(value.reversesTransactionId ?? '');
    const group = linked.get(originalId) ?? [];
    group.push(reversal);
    linked.set(originalId, group);
    const candidates = byId.get(originalId) ?? [];
    const original = candidates.length === 1 ? candidates[0] : null;
    const originalValue = original?.canonical;
    const valid = reversal.errors.length === 0 && original && original !== reversal
      && originalValue?.status === 'CANCELLED'
      && originalValue.studentId === value.studentId
      && Date.parse(String(value.timestamp)) > Date.parse(String(originalValue.timestamp))
      && Number(originalValue.totalAmount) === -Number(value.totalAmount)
      && Number(originalValue.balanceAfter) - Number(originalValue.balanceBefore)
        === -(Number(value.balanceAfter) - Number(value.balanceBefore));
    if (!valid) {
      if (!reversal.errors.includes('MALFORMED_CANCELLATION_HISTORY')) reversal.errors.push('MALFORMED_CANCELLATION_HISTORY');
      for (const candidate of candidates) if (!candidate.errors.includes('MALFORMED_CANCELLATION_HISTORY')) candidate.errors.push('MALFORMED_CANCELLATION_HISTORY');
    }
  }
  for (const original of transactions.filter((entry) => entry.canonical!.status === 'CANCELLED')) {
    const id = String(original.canonical!.transactionId);
    const candidates = linked.get(id) ?? [];
    if (candidates.length !== 1 || candidates[0].errors.length) {
      if (!original.errors.includes('MALFORMED_CANCELLATION_HISTORY')) original.errors.push('MALFORMED_CANCELLATION_HISTORY');
      candidates.forEach((entry) => {
        if (!entry.errors.includes('MALFORMED_CANCELLATION_HISTORY')) entry.errors.push('MALFORMED_CANCELLATION_HISTORY');
      });
    }
  }
}

function validateReferences(entries: Entry[]) {
  const ids = new Map<string, Map<string, Entry[]>>();
  const add = (table: string, id: string, entry: Entry) => { const values = ids.get(table) ?? new Map<string, Entry[]>(); const group = values.get(id) ?? []; group.push(entry); values.set(id, group); ids.set(table, values); };
  for (const entry of entries.filter((item) => item.tab === 'Tasks' && item.canonical)) add('task_business', String(entry.canonical!.taskId), entry);
  for (const entry of entries) for (const target of entry.targets) add(target.table, target.id, entry);
  const addError = (entry: Entry, code: string) => {
    if (entry.errors.includes(code)) return false;
    entry.errors.push(code); return true;
  };

  for (const entry of entries.filter((item) => item.tab === 'TaskAssignments' && item.canonical)) {
    const tasks = ids.get('tasks')?.get(String(entry.canonical!.taskInstanceId)) ?? [];
    if (tasks.length === 1 && tasks[0].canonical!.taskId !== entry.canonical!.taskId) addError(entry, 'TASK_INSTANCE_TUPLE_CONFLICT');
  }
  for (const entry of entries.filter((item) => item.tab === 'TaskCompletions' && item.canonical?.taskInstanceId)) {
    const completion = entry.canonical!;
    const tasks = ids.get('tasks')?.get(String(completion.taskInstanceId)) ?? [];
    if (tasks.length === 1 && tasks[0].canonical!.taskId !== completion.taskId) addError(entry, 'TASK_INSTANCE_TUPLE_CONFLICT');
    if (!completion.assignmentId) continue;
    const assignments = ids.get('task_assignments')?.get(String(completion.assignmentId)) ?? [];
    if (assignments.length !== 1) continue;
    const assignmentEntry = assignments[0];
    const assignment = assignmentEntry.canonical!;
    if (!sameAssignmentCompletionTuple(assignment, completion)) {
      addError(entry, 'ASSIGNMENT_TUPLE_CONFLICT');
      addError(assignmentEntry, 'ASSIGNMENT_TUPLE_CONFLICT');
    }
  }

  markDirectedReferenceCycles(entries, 'Tasks', 'taskId', 'prerequisiteTaskId', 'CYCLIC_TASK_PREREQUISITE');
  markDirectedReferenceCycles(entries, 'TaskAssignments', 'assignmentId', 'previousAssignmentId', 'CYCLIC_ASSIGNMENT_PREDECESSOR');

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) for (const ref of entry.refs) {
      const candidates = ids.get(ref.table)?.get(ref.id) ?? [];
      const stageable = candidates.filter((candidate) => candidate.errors.length === 0);
      if (stageable.length === 1) continue;
      changed = addError(entry, candidates.length > 1 ? 'AMBIGUOUS_REFERENCE' : ref.code) || changed;
    }
  }

  for (const entry of entries.filter((item) => item.tab === 'Tasks' && item.canonical?.prerequisiteTaskId && !item.errors.length)) {
    const candidates = (ids.get('task_business')?.get(String(entry.canonical!.prerequisiteTaskId)) ?? [])
      .filter((candidate) => !candidate.errors.length);
    if (candidates.length === 1) {
      const prerequisiteInstanceId = candidates[0].canonical!.taskInstanceId;
      entry.canonical!.prerequisiteTaskInstanceId = prerequisiteInstanceId;
      const target = entry.targets.find((item) => item.table === 'tasks');
      if (target) target.record.prerequisiteTaskInstanceId = prerequisiteInstanceId;
    }
  }
}

function markDirectedReferenceCycles(entries: Entry[], tab: string, idField: string, edgeField: string, code: string) {
  const stageable = entries.filter((entry) => entry.tab === tab && entry.canonical && entry.errors.length === 0)
    .sort((left, right) => compareCodeUnits(String(left.canonical![idField]), String(right.canonical![idField])));
  const groups = new Map<string, Entry[]>();
  for (const entry of stageable) {
    const id = String(entry.canonical![idField]);
    const group = groups.get(id) ?? [];
    group.push(entry);
    groups.set(id, group);
  }
  const nodes = new Map<string, Entry>();
  for (const [id, group] of groups) if (group.length === 1) nodes.set(id, group[0]);
  const edges = new Map<string, string>();
  for (const [id, entry] of nodes) {
    const destination = entry.canonical![edgeField];
    if (typeof destination === 'string' && nodes.has(destination)) edges.set(id, destination);
  }

  const state = new Map<string, 1 | 2>();
  for (const start of [...nodes.keys()].sort(compareCodeUnits)) {
    if (state.has(start)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !state.has(current)) {
      state.set(current, 1);
      positions.set(current, path.length);
      path.push(current);
      current = edges.get(current);
    }
    if (current !== undefined && state.get(current) === 1 && positions.has(current)) {
      for (const id of path.slice(positions.get(current)!)) nodes.get(id)!.errors.push(code);
    }
    for (const id of path) state.set(id, 2);
  }
}

function sameAssignmentCompletionTuple(assignment: Record<string, unknown>, completion: Record<string, unknown>): boolean {
  return assignment.taskId === completion.taskId
    && assignment.taskInstanceId === completion.taskInstanceId
    && assignment.studentId === completion.studentId
    && assignment.cycleId === completion.cycleId
    && assignment.cycleStartsAt === completion.cycleStartsAt
    && assignment.cycleEndsAt === completion.cycleEndsAt
    && assignment.ruleVersion === completion.ruleVersion
    && assignment.timeZone === completion.timeZone;
}

function markBusinessDuplicate(entries: Entry[], keyOf: (entry: Entry) => string, code = 'DUPLICATE_BUSINESS_ID') {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) { const key = keyOf(entry); const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group); }
  for (const group of groups.values()) if (group.length > 1) group.forEach((entry) => entry.errors.push(code));
}

function propagateClaimErrors(entries: Entry[]) {
  const failedSheetDigests = new Set(entries.filter((entry) => entry.tab === 'TaskCompletions' && entry.errors.length).map((entry) => sourceDigest(entry.source)));
  const failedOperations = new Set<string>();
  const failedTuples = new Set<string>();
  for (const entry of entries.filter((item) => item.tab === 'TaskCompletions' && item.errors.length && item.canonical)) {
    if (entry.canonical!.operationId) failedOperations.add(String(entry.canonical!.operationId));
    if (entry.canonical!.tupleDigest) failedTuples.add(String(entry.canonical!.tupleDigest));
  }
  for (const entry of entries.filter((item) => item.tab === 'SheetPadletClaim' && failedSheetDigests.has(sourceDigest(item.source)))) {
    entry.errors.push('CLAIM_BINDING_CONFLICT');
    if (entry.canonical?.operationId) failedOperations.add(String(entry.canonical.operationId));
    if (entry.canonical?.tupleDigest) failedTuples.add(String(entry.canonical.tupleDigest));
  }
  const redisPairEntries = entries.filter((entry) => entry.tab === 'RedisPadletClaim' || entry.tab === 'RedisOperationBinding');
  for (const entry of redisPairEntries) {
    const referenceErrors = entry.errors.filter((code) => code === 'AMBIGUOUS_REFERENCE'
      || entry.refs.some((ref) => ref.code === code));
    if (!referenceErrors.length) continue;
    for (const peer of redisPairEntries) {
      if (peer === entry || (peer.canonical?.operationId !== entry.canonical?.operationId
        && peer.canonical?.tupleDigest !== entry.canonical?.tupleDigest)) continue;
      for (const code of referenceErrors) if (!peer.errors.includes(code)) peer.errors.push(code);
    }
  }
  for (const entry of redisPairEntries.filter((item) => item.errors.length)) {
    if (entry.canonical?.operationId) failedOperations.add(String(entry.canonical.operationId));
    if (entry.canonical?.tupleDigest) failedTuples.add(String(entry.canonical.tupleDigest));
  }
  if (!failedOperations.size && !failedTuples.size) return;
  for (const entry of entries) {
    if ((entry.tab === 'SheetPadletClaim' || entry.tab === 'RedisPadletClaim')
      && (failedOperations.has(String(entry.canonical?.operationId ?? '')) || failedTuples.has(String(entry.canonical?.tupleDigest ?? '')))) entry.errors.push('CLAIM_BINDING_CONFLICT');
    if (entry.tab === 'RedisOperationBinding'
      && (failedOperations.has(String(entry.canonical?.operationId ?? '')) || failedTuples.has(String(entry.canonical?.tupleDigest ?? '')))) entry.errors.push('CLAIM_BINDING_CONFLICT');
  }
}

function normalizeClaims(input: { tenantId: string; migrationJobId: string; sheets: SheetsSnapshot; redis?: RedisClaimSnapshot }, sheetEntries: Entry[]) {
  const entries: Entry[] = []; const conflicts: Diagnostic[] = []; const collections = new Set<string>();
  type ClaimGroup = { record: Record<string, unknown>; bindingKey: string; members: Entry[]; sheetEntries: Entry[] };
  const claims = new Map<string, ClaimGroup>();
  const addClaim = (digest: string, record: Record<string, unknown>, member: Entry, sheet?: Entry) => {
    const prior = claims.get(digest);
    if (!prior) { claims.set(digest, { record, bindingKey: claimBindingKey(record), members: [member], sheetEntries: sheet ? [sheet] : [] }); return; }
    prior.members.push(member); if (sheet) prior.sheetEntries.push(sheet);
    if (prior.bindingKey !== claimBindingKey(record)) {
      [...prior.members, ...prior.sheetEntries].forEach((entry) => entry.errors.push('CLAIM_BINDING_CONFLICT'));
    }
  };
  for (const completion of sheetEntries.filter((entry) => entry.tab === 'TaskCompletions' && entry.canonical?.tupleDigest && !entry.errors.length)) {
    const record = completion.canonical!; const digest = String(record.tupleDigest); const operationId = String(record.operationId);
    const claimRecord = { tenantId: input.tenantId, provider: 'PADLET', tupleDigest: digest, boardId: record.evidenceBoardId, postId: record.evidencePostId,
      ownerDigest: sha256(operationId), operationId, operationPayloadHash: record.operationPayloadHash, taskId: record.taskId, studentId: record.studentId,
      cycleStartsAt: record.cycleStartsAt, evidenceCreatedAt: record.evidenceCreatedAt, evidenceAuthorFullName: record.evidenceAuthorFullName, provenances: [completion.source] };
    const targetId = deterministicId(input.tenantId, input.migrationJobId, 'padlet_evidence_claims', digest);
    addClaim(digest, claimRecord, derivedEntry(completion.source, 'SheetPadletClaim', digest, 'padlet_evidence_claims', targetId, claimRecord), completion);
  }
  if (input.redis) {
    collections.add('padlet_evidence_claims');
    const bindingGroups = new Map<string, Array<{ binding: RedisClaimSnapshot['operationBindings'][number]; entry: Entry }>>();
    for (const binding of input.redis.operationBindings) {
      const source = redisPointer(input.redis, binding.sourceProvenance, canonicalJson(binding));
      const id = deterministicId(input.tenantId, input.migrationJobId, 'legacy_operation_bindings', binding.operationId);
      const entry = derivedEntry(source, 'RedisOperationBinding', binding.operationId, 'legacy_operation_bindings', id, { tenantId: input.tenantId, operationId: binding.operationId, tupleDigest: binding.tupleDigest, ownerDigest: binding.ownerDigest, payloadHash: binding.payloadHash, binding: binding.binding });
      entry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'task_business', id: binding.binding.taskId },
        { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: binding.binding.studentId });
      const group = bindingGroups.get(binding.operationId) ?? []; group.push({ binding, entry }); bindingGroups.set(binding.operationId, group);
      entries.push(entry); collections.add('legacy_operation_bindings');
    }
    const redisClaimsByOperation = new Map<string, RedisClaimSnapshot['v2Claims'][number][]>();
    for (const claim of input.redis.v2Claims) {
      const group = redisClaimsByOperation.get(claim.operationId) ?? [];
      group.push(claim); redisClaimsByOperation.set(claim.operationId, group);
    }
    for (const claim of input.redis.v2Claims) {
      const source = redisPointer(input.redis, claim.sourceProvenance, canonicalJson(claim));
      const targetId = deterministicId(input.tenantId, input.migrationJobId, 'padlet_evidence_claims', claim.tupleDigest);
      const candidates = bindingGroups.get(claim.operationId) ?? [];
      const binding = candidates.length === 1 ? candidates[0].binding : null;
      const claimRecord: Record<string, unknown> = { tenantId: input.tenantId, provider: 'PADLET', tupleDigest: claim.tupleDigest, boardId: claim.boardId, postId: claim.postId,
        ownerDigest: claim.ownerDigest, operationId: claim.operationId, operationPayloadHash: binding?.payloadHash ?? null,
        ...(binding ? { taskId: binding.binding.taskId, studentId: binding.binding.studentId, cycleStartsAt: binding.binding.cycleStartsAt, evidenceCreatedAt: binding.binding.evidence.evidenceCreatedAt, evidenceAuthorFullName: binding.binding.evidence.evidenceAuthorFullName } : {}), provenances: [source] };
      const claimEntry = derivedEntry(source, 'RedisPadletClaim', claim.tupleDigest, 'padlet_evidence_claims', targetId, claimRecord);
      if (binding) claimEntry.refs.push({ code: 'BROKEN_TASK_REFERENCE', table: 'task_business', id: binding.binding.taskId },
        { code: 'BROKEN_STUDENT_REFERENCE', table: 'students', id: binding.binding.studentId });
      const expectedPayload = binding ? `sha256:${sha256(canonicalJson(binding.binding))}` : '';
      const affectedSheets = sheetEntries.filter((entry) => entry.tab === 'TaskCompletions' && entry.canonical
        && (entry.canonical.operationId === claim.operationId || entry.canonical.tupleDigest === claim.tupleDigest
          || entry.canonical.tupleDigest === binding?.tupleDigest));
      const duplicateClaim = (redisClaimsByOperation.get(claim.operationId)?.length ?? 0) !== 1;
      const valid = Boolean(!duplicateClaim && binding && isHexDigest(claim.tupleDigest) && /^[A-Za-z0-9]{16,22}$/.test(claim.boardId)
        && /^[A-Za-z0-9_-]{3,128}$/.test(claim.postId) && sha256(`${claim.boardId}\0${claim.postId}`) === claim.tupleDigest
        && claim.ownerDigest === sha256(claim.operationId) && binding!.operationId === claim.operationId
        && binding!.tupleDigest === claim.tupleDigest && binding!.ownerDigest === claim.ownerDigest
        && binding!.claimField === `claim:${claim.tupleDigest}` && binding!.payloadHash === expectedPayload
        && binding!.binding.evidence.evidenceBoardId === claim.boardId && binding!.binding.evidence.evidencePostId === claim.postId
        && affectedSheets.every((entry) => !entry.errors.length));
      if (!valid) {
        claimEntry.errors.push('CLAIM_BINDING_CONFLICT'); candidates.forEach((candidate) => candidate.entry.errors.push('CLAIM_BINDING_CONFLICT'));
        affectedSheets.forEach((entry) => entry.errors.push('CLAIM_BINDING_CONFLICT'));
        const sheetClaim = claims.get(claim.tupleDigest); sheetClaim?.members.forEach((entry) => entry.errors.push('CLAIM_BINDING_CONFLICT')); sheetClaim?.sheetEntries.forEach((entry) => entry.errors.push('CLAIM_BINDING_CONFLICT'));
      }
      addClaim(claim.tupleDigest, claimRecord, claimEntry);
    }
    for (const [operationId, candidates] of bindingGroups) {
      if ((redisClaimsByOperation.get(operationId)?.length ?? 0) === 1 && candidates.length === 1) continue;
      candidates.forEach((candidate) => candidate.entry.errors.push('CLAIM_BINDING_CONFLICT'));
      const affectedSheets = sheetEntries.filter((entry) => entry.tab === 'TaskCompletions' && entry.canonical?.operationId === operationId);
      affectedSheets.forEach((entry) => entry.errors.push('CLAIM_BINDING_CONFLICT'));
    }
    for (const tombstone of input.redis.v1Tombstones) {
      const source = redisPointer(input.redis, tombstone.sourceProvenance, canonicalJson(tombstone));
      const id = deterministicId('global', 'padlet_claim_digest_tombstones', tombstone.tupleDigest);
      const entry = derivedEntry(source, 'RedisV1Tombstone', tombstone.tupleDigest, 'padlet_claim_digest_tombstones', id, { tupleDigest: tombstone.tupleDigest, ownerDigest: tombstone.ownerDigest, kind: 'V1_GLOBAL', provenance: tombstone.sourceProvenance });
      const collision = claims.get(tombstone.tupleDigest);
      if (collision) {
        entry.errors.push('V1_TOMBSTONE_COLLISION'); [...collision.members, ...collision.sheetEntries].forEach((item) => item.errors.push('V1_TOMBSTONE_COLLISION'));
        for (const group of bindingGroups.values()) for (const candidate of group) if (candidate.binding.tupleDigest === tombstone.tupleDigest) candidate.entry.errors.push('V1_TOMBSTONE_COLLISION');
      }
      entries.push(entry); collections.add('padlet_claim_digest_tombstones');
    }
    for (const digest of input.redis.orphanedClaimDigests) {
      const source = redisPointer(input.redis, 'upstash:padlet:evidence-bindings:v2:orphan', digest);
      const id = deterministicId('global', 'padlet_claim_digest_tombstones', digest);
      const entry = derivedEntry(source, 'RedisOrphanClaim', digest, 'padlet_claim_digest_tombstones', id, { tupleDigest: digest, kind: 'ORPHAN_V2', provenance: 'upstash:padlet:evidence-bindings:v2' });
      const collision = claims.get(digest);
      if (collision) {
        entry.errors.push('ORPHAN_CLAIM_COLLISION');
        [...collision.members, ...collision.sheetEntries].forEach((item) => item.errors.push('ORPHAN_CLAIM_COLLISION'));
        for (const group of bindingGroups.values()) for (const candidate of group) {
          if (candidate.binding.tupleDigest === digest) candidate.entry.errors.push('ORPHAN_CLAIM_COLLISION');
        }
      }
      entries.push(entry);
      collections.add('padlet_claim_digest_tombstones');
    }
  }
  for (const claim of claims.values()) {
    const provenances = claim.members.map((entry) => entry.source).sort((a, b) => compareCodeUnits(sourceDigest(a), sourceDigest(b)));
    claim.record.provenances = provenances;
    for (const member of claim.members) { member.canonical = claim.record; member.targets[0].record = claim.record; entries.push(member); }
    collections.add('padlet_evidence_claims');
  }
  return { entries, conflicts, collections };
}

function derivedEntry(source: SourcePointer, tab: string, identity: string, table: string, id: string, record: Record<string, unknown>): Entry {
  return { source, tab, identity, sourcePrimaryIdentity: null, redacted: { identityDigest: sha256(identity), recognizedFieldCount: 1, omittedFieldCount: 0 }, canonical: record, targets: [{ table, id, record: { ...record } }], refs: [], warnings: [], errors: [] };
}
function redisPointer(redis: RedisClaimSnapshot, provenance: string, value: string): SourcePointer { return { kind: 'REDIS', artifactDigest: redis.digest, provenance, sourceDigest: sha256(value) }; }
function claimBindingKey(record: Record<string, unknown>) { return canonicalJson({ boardId: record.boardId, postId: record.postId, ownerDigest: record.ownerDigest, operationId: record.operationId, operationPayloadHash: record.operationPayloadHash ?? null, taskId: record.taskId ?? null, studentId: record.studentId ?? null, cycleStartsAt: record.cycleStartsAt ?? null, evidenceCreatedAt: record.evidenceCreatedAt ?? null, evidenceAuthorFullName: record.evidenceAuthorFullName ?? null }); }
function cancellationOriginalId(operator: string): string | null {
  for (const prefix of ['cancel-task-pre-reset:', 'cancel-task-unlinked:', 'cancel-task:', 'cancel:']) {
    if (operator.startsWith(prefix)) return canonicalId(operator.slice(prefix.length));
  }
  return null;
}
function transactionKind(status: string) { return status === 'COMPLETED' || status === 'CANCELLED' ? 'CHECKOUT' : status === 'TASK_REWARD' ? 'TASK_REWARD' : status === 'ADMIN_ADJUSTMENT' ? 'ADMIN_ADJUSTMENT' : 'LEGACY'; }
function primaryField(tab: string) { return ({ Students: 'studentId', Products: 'productId', Transactions: 'transactionId', Adjustments: 'adjustmentId', Settings: 'key', Tasks: 'taskId', TaskAssignments: 'assignmentId', TaskCompletions: 'completionId', Promotions: 'promotionId', PromotionProducts: 'promotionProductId' } as Record<string, string>)[tab] ?? ''; }
function diag(code: string, path: string, digest: string): Diagnostic { return { code, path, sourceDigest: sha256(digest) }; }
function sourceDigest(source: SourcePointer) { return source.kind === 'SHEET' ? source.rowHash : source.sourceDigest; }
function sourcePath(source: SourcePointer) { return source.kind === 'SHEET' ? `${source.tab}[${String(source.rowNumber).padStart(9, '0')}]` : `${source.provenance}.${source.sourceDigest}`; }
function stableDiagnostics(items: Diagnostic[]) { const unique = new Map(items.map((item) => [`${item.code}\0${item.path}\0${item.sourceDigest}`, item])); return [...unique.values()].sort((a, b) => compareCodeUnits(`${a.code}\0${a.path}\0${a.sourceDigest}`, `${b.code}\0${b.path}\0${b.sourceDigest}`)); }
function toSourceRecord(entry: Entry): NormalizedSourceRecord {
  const errors = [...new Set(entry.errors)].sort(compareCodeUnits), warningCodes = [...new Set(entry.warnings)].sort(compareCodeUnits);
  const first = entry.targets[0];
  return { source: entry.source, redactedSourceRecord: entry.redacted, canonicalRecord: errors.length ? null : entry.canonical, mappingStatus: errors.length ? 'QUARANTINED' : 'STAGED', ...(errors.length || !first ? {} : { targetTable: first.table, targetId: first.id }), warningCodes, errorCodes: errors };
}