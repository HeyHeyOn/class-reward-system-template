import { parseCheckoutLineSnapshot } from '@/lib/checkoutSnapshotClient';
import { canonicalId, canonicalJson, isPlainRecord } from './validators';
import { type BudgetContext, BudgetExceededError, BudgetUnavailableError, trimBudgetString, equalBudgetValue, utf8ByteLength } from '@/lib/boundedWork';
import { createBoundedParserProjection, registeredBoundedKeys, parseRegisteredBoundedJson, serializeBoundedOperationalKey, stringBoundedJson } from '@/lib/boundedJson';

// Pure historical invariants shared by normalization and pre-transaction import.
// Never compare snapshots to today's task rewards, products, or promotions.
const LEGACY_TRANSACTION_ITEM_KEYS = ['productId', 'name', 'price', 'quantity', 'subtotal'] as const;
const EXTENDED_TRANSACTION_ITEM_KEYS = [
  ...LEGACY_TRANSACTION_ITEM_KEYS, 'regularUnitPrice', 'regularTotal', 'totalQuantity',
  'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustments', 'appliedPromotions',
] as const;

/** Nested cell admission used by normalize.ts when a request context is present.
 * JSON syntax errors retain the historical null/malformed result; budget failures
 * never do. This bounds parsing, not the normalizer's remaining canonical output
 * allocation, item-ID serialization, joins or output category expansion. */
export function parseTransactionItemsJson(text: string, budget?: BudgetContext): unknown {
  try { return budget ? parseRegisteredBoundedJson(text, budget) : JSON.parse(text); }
  catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    return null;
  }
}

/** Historical Sheets writer representation, not a fresh TASK_REWARD command. */
export function isSheetsBankRewardLedger(status: string, operator: string, id: string, itemCount: number,
  total: number, delta: number, budget?: BudgetContext): boolean {
  budget?.spend(12 + Math.ceil(id.length / 256));
  return equalBudgetValue(status, 'TASK_REWARD', budget) && equalBudgetValue(operator, 'bank', budget)
    && id.startsWith('TASK-') && itemCount === 1 && total <= 0 && delta >= 0 && delta === -total;
}

type CanonicalTransactionItem = { productId: string; name: string; price: number; quantity: number; subtotal: number } & Record<string, unknown>;
export function canonicalTransactionItem(value: unknown, signedLegacy = false, budget?: BudgetContext): CanonicalTransactionItem | null {
  budget?.spend();
  if (budget && value !== null && typeof value === 'object') registeredBoundedKeys(value, budget);
  if (!isPlainRecord(value)) return null;
  const keys = budget ? registeredBoundedKeys(value, budget) : Object.keys(value);
  const legacy = exactKeys(keys, LEGACY_TRANSACTION_ITEM_KEYS, budget);
  const extended = exactKeys(keys, EXTENDED_TRANSACTION_ITEM_KEYS, budget);
  if (!legacy && !extended) return null;
  const productId = typeof value.productId === 'string' ? canonicalId(value.productId, budget) : null;
  const name = typeof value.name === 'string' && value.name.length > 0 && equalBudgetValue(value.name, trimBudgetString(value.name, budget), budget) ? value.name : null;
  const price = typeof value.price === 'number' && Number.isSafeInteger(value.price) ? value.price : null;
  const subtotal = typeof value.subtotal === 'number' && Number.isSafeInteger(value.subtotal) ? value.subtotal : null;
  if (!productId || !name || price === null || subtotal === null
    || (!signedLegacy && (price < 0 || subtotal < 0)) || !positiveSafeInteger(value.quantity)
    || !Number.isSafeInteger(price * value.quantity)) return null;
  if (legacy) {
    if (price * value.quantity !== subtotal) return null;
    return budget ? createBoundedParserProjection('legacyItem', () => value, budget) as CanonicalTransactionItem
      : { productId, name, price, quantity: value.quantity, subtotal };
  }
  if (signedLegacy) return null;
  if (!exactExtendedItemChildren(value, budget)) return null;
  const parsed = parseCheckoutLineSnapshot(value, budget);
  if (parsed && budget) return createBoundedParserProjection('checkout', () => value, budget) as CanonicalTransactionItem;
  return parsed ? {
    productId: parsed.productId, name: parsed.name, price: parsed.price, quantity: parsed.quantity,
    subtotal: parsed.subtotal, regularUnitPrice: parsed.regularUnitPrice, regularTotal: parsed.regularTotal,
    totalQuantity: parsed.totalQuantity, paidQuantity: parsed.paidQuantity, freeQuantity: parsed.freeQuantity,
    finalTotal: parsed.finalTotal, totalDiscount: parsed.totalDiscount,
    adjustments: parsed.adjustments.map((adjustment) => ({ ...adjustment })),
    appliedPromotions: parsed.appliedPromotions.map((promotion) => ({ ...promotion, productIds: [...promotion.productIds] })),
  } : null;
}

const ADJUSTMENT_KEYS = ['promotionId', 'type', 'beforeAmount', 'afterAmount', 'discountAmount'] as const;
const ADJUSTMENT_FREE_KEYS = [...ADJUSTMENT_KEYS, 'freeQuantity'] as const;
const PROMOTION_COMMON_KEYS = ['promotionId', 'name', 'description', 'productIds', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion', 'type'] as const;
const PROMOTION_N_PLUS_ONE_KEYS = [...PROMOTION_COMMON_KEYS, 'buyQuantity', 'freeQuantity'] as const;
const PROMOTION_PRICE_KEYS = [...PROMOTION_COMMON_KEYS, 'promotionalUnitPrice'] as const;
const PROMOTION_PERCENT_KEYS = [...PROMOTION_COMMON_KEYS, 'percent'] as const;
const PROMOTION_FIXED_KEYS = [...PROMOTION_COMMON_KEYS, 'discountAmount'] as const;
function exactExtendedItemChildren(value: Record<string, unknown>, budget?: BudgetContext): boolean {
  if (!Array.isArray(value.adjustments) || !Array.isArray(value.appliedPromotions)) return false;
  const keys = (record: Record<string, unknown>) => budget ? registeredBoundedKeys(record, budget) : Object.keys(record);
  const adjustmentsExact = value.adjustments.every((adjustment) => {
    budget?.spend();
    return isPlainRecord(adjustment) && exactKeys(keys(adjustment), equalBudgetValue(adjustment.type, 'N_PLUS_ONE', budget) ? ADJUSTMENT_FREE_KEYS : ADJUSTMENT_KEYS, budget);
  });
  const promotionsExact = value.appliedPromotions.every((promotion) => {
    budget?.spend();
    if (!isPlainRecord(promotion)) return false;
    const expected = equalBudgetValue(promotion.type, 'N_PLUS_ONE', budget) ? PROMOTION_N_PLUS_ONE_KEYS
      : equalBudgetValue(promotion.type, 'PROMOTIONAL_PRICE', budget) ? PROMOTION_PRICE_KEYS
        : equalBudgetValue(promotion.type, 'PERCENT_DISCOUNT', budget) ? PROMOTION_PERCENT_KEYS
          : equalBudgetValue(promotion.type, 'FIXED_DISCOUNT', budget) ? PROMOTION_FIXED_KEYS : null;
    return expected !== null && exactKeys(keys(promotion), expected, budget);
  });
  return adjustmentsExact && promotionsExact;
}

function exactKeys(actual: readonly string[], expected: readonly string[], budget?: BudgetContext): boolean {
  return actual.length === expected.length && expected.every((key) => {
    budget?.spend(); return actual.some((candidate) => equalBudgetValue(candidate, key, budget));
  });
}
function positiveSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }


export function adjustmentKey(adjustment: Record<string, unknown>, budget?: BudgetContext): string | null {
  return operationalNative(() => {
    admitOperationalRecord(adjustment, budget);
    const { timestamp, studentId, operator, mode, amount } = adjustment;
    if (typeof timestamp !== 'string' || typeof studentId !== 'string' || typeof operator !== 'string'
      || !adjustmentMode(mode, budget) || !adjustmentSafeInteger(amount, budget)
      || (!equalBudgetValue(mode, 'set', budget) && (amount as number) < 0)) return null;
    return budget ? serializeBoundedOperationalKey('adjustment', adjustment, budget)
      : canonicalJson([timestamp, studentId, operator, mode, amount]);
  }, budget);
}

export function adjustmentTransactionKey(transaction: Record<string, unknown>, budget?: BudgetContext): string | null {
  return operationalNative(() => {
    admitOperationalRecord(transaction, budget);
    const { timestamp, studentId, operator, status, totalAmount, balanceBefore, balanceAfter } = transaction;
    if (!equalBudgetValue(status, 'ADMIN_ADJUSTMENT', budget) || typeof timestamp !== 'string' || typeof studentId !== 'string'
      || typeof operator !== 'string' || !adjustmentSafeInteger(totalAmount, budget)
      || !adjustmentSafeInteger(balanceBefore, budget) || !adjustmentSafeInteger(balanceAfter, budget)
      || !Array.isArray(transaction.items) || transaction.items.length !== 1) return null;
    budget?.spend();
    const item = transaction.items[0] as Record<string, unknown>;
    // Registered immutable root certifies descendants. Preserve native null-item
    // property-access errors rather than substituting a shape assertion.
    const before = balanceBefore as number;
    const after = balanceAfter as number;
    const total = totalAmount as number;
    let mode: 'add' | 'subtract' | 'set';
    let requested: number;
    if (equalBudgetValue(item.productId, 'ADMIN-ADD', budget) && equalBudgetValue(item.name, '관리자 지급', budget)) {
      budget?.spend(3);
      mode = 'add'; requested = after - before;
      if (!adjustmentSafeInteger(requested, budget) || requested < 0 || total !== -requested) return null;
    } else if (equalBudgetValue(item.productId, 'ADMIN-SUBTRACT', budget) && equalBudgetValue(item.name, '관리자 회수', budget)) {
      budget?.spend(3);
      mode = 'subtract'; requested = before - after;
      if (!adjustmentSafeInteger(requested, budget) || requested < 0 || total !== requested) return null;
    } else if (equalBudgetValue(item.productId, 'ADMIN-SET', budget) && equalBudgetValue(item.name, '관리자 잔액 지정', budget)) {
      budget?.spend(3);
      mode = 'set'; requested = after;
      if (!adjustmentSafeInteger(requested, budget) || !adjustmentSafeInteger(before - after, budget) || total !== before - after) return null;
    } else return null;
    if (!equalBudgetValue(item.price, total, budget) || !equalBudgetValue(item.quantity, 1, budget) || !equalBudgetValue(item.subtotal, total, budget)) return null;
    return budget ? serializeBoundedOperationalKey('transaction', transaction, budget, mode, requested)
      : canonicalJson([timestamp, studentId, operator, mode, requested]);
  }, budget);
}

function adjustmentSafeInteger(value: unknown, budget?: BudgetContext): boolean {
  budget?.spend();
  return operationalNative(() => Number.isSafeInteger(value), budget);
}

export function sameAssignmentCompletionTuple(assignment: Record<string, unknown>, completion: Record<string, unknown>, budget?: BudgetContext): boolean {
  admitOperationalRecord(assignment, budget); admitOperationalRecord(completion, budget);
  return equalBudgetValue(assignment.taskId, completion.taskId, budget)
    && equalBudgetValue(assignment.taskInstanceId, completion.taskInstanceId, budget)
    && equalBudgetValue(assignment.studentId, completion.studentId, budget)
    && equalBudgetValue(assignment.cycleId, completion.cycleId, budget)
    && equalBudgetValue(assignment.cycleStartsAt, completion.cycleStartsAt, budget)
    && equalBudgetValue(assignment.cycleEndsAt, completion.cycleEndsAt, budget)
    && equalBudgetValue(assignment.ruleVersion, completion.ruleVersion, budget)
    && equalBudgetValue(assignment.timeZone, completion.timeZone, budget);
}

const CANCELLATION_PREFIXES = ['cancel-task-pre-reset:', 'cancel-task-unlinked:', 'cancel-task:', 'cancel:'] as const;
export function cancellationOriginalId(operator: string, budget?: BudgetContext): string | null {
  budget?.spend();
  if (budget && operator !== null && (typeof operator === 'object' || typeof operator === 'function')) registeredBoundedKeys(operator, budget);
  for (const prefix of CANCELLATION_PREFIXES) {
    budget?.spend(2 + (typeof operator === 'string' ? Math.ceil(operator.length / 256) : 0));
    if (operationalNative(() => operator.startsWith(prefix), budget)) {
      if (budget) { budget.reserveString(utf8ByteLength(operator, budget)); budget.spend(1 + Math.ceil(operator.length / 256)); }
      const id = operationalNative(() => operator.slice(prefix.length), budget);
      return operationalNative(() => canonicalId(id, budget), budget);
    }
  }
  return null;
}

function admitOperationalRecord(value: object, budget?: BudgetContext): void {
  budget?.spend(12); // Fixed scalar/type/arity checks in the closed schema.
  if (budget) registeredBoundedKeys(value, budget);
}
function adjustmentMode(mode: unknown, budget?: BudgetContext): boolean {
  // Preserve String(mode), including admitted array modes and native errors.
  const text = budget ? stringBoundedJson(mode, budget) : String(mode);
  return equalBudgetValue('add', text, budget) || equalBudgetValue('subtract', text, budget) || equalBudgetValue('set', text, budget);
}
function operationalNative<T>(call: () => T, budget?: BudgetContext): T {
  try { const result = call(); budget?.check(); return result; }
  catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget?.check(); throw error;
  }
}
