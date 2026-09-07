import { parseCheckoutLineSnapshot } from '@/lib/checkoutSnapshotClient';
import { canonicalId, canonicalJson, isPlainRecord } from './validators';

// Pure historical invariants shared by normalization and pre-transaction import.
// Never compare snapshots to today's task rewards, products, or promotions.
const LEGACY_TRANSACTION_ITEM_KEYS = ['productId', 'name', 'price', 'quantity', 'subtotal'] as const;
const EXTENDED_TRANSACTION_ITEM_KEYS = [
  ...LEGACY_TRANSACTION_ITEM_KEYS, 'regularUnitPrice', 'regularTotal', 'totalQuantity',
  'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustments', 'appliedPromotions',
] as const;

export function canonicalTransactionItem(value: unknown, signedLegacy = false): ({ productId: string; name: string; price: number; quantity: number; subtotal: number } & Record<string, unknown>) | null {
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


export function adjustmentKey(adjustment: Record<string, unknown>): string | null {
  const { timestamp, studentId, operator, mode, amount } = adjustment;
  if (typeof timestamp !== 'string' || typeof studentId !== 'string' || typeof operator !== 'string'
    || !['add', 'subtract', 'set'].includes(String(mode)) || !Number.isSafeInteger(amount)
    || (mode !== 'set' && (amount as number) < 0)) return null;
  return canonicalJson([timestamp, studentId, operator, mode, amount]);
}

export function adjustmentTransactionKey(transaction: Record<string, unknown>): string | null {
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


export function sameAssignmentCompletionTuple(assignment: Record<string, unknown>, completion: Record<string, unknown>): boolean {
  return assignment.taskId === completion.taskId
    && assignment.taskInstanceId === completion.taskInstanceId
    && assignment.studentId === completion.studentId
    && assignment.cycleId === completion.cycleId
    && assignment.cycleStartsAt === completion.cycleStartsAt
    && assignment.cycleEndsAt === completion.cycleEndsAt
    && assignment.ruleVersion === completion.ruleVersion
    && assignment.timeZone === completion.timeZone;
}


export function cancellationOriginalId(operator: string): string | null {
  for (const prefix of ['cancel-task-pre-reset:', 'cancel-task-unlinked:', 'cancel-task:', 'cancel:']) {
    if (operator.startsWith(prefix)) return canonicalId(operator.slice(prefix.length));
  }
  return null;
}
