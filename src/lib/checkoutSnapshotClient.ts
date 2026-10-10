import type { CartItem, CheckoutAdjustment, CheckoutLineSnapshot, PromotionAdjustment, VoucherAdjustment } from '@/domain/types';
import { parsePromotionResponse } from './promotionClient';
import { type BudgetContext, trimBudgetString, mapBudgetList, uniqueBudgetStrings, equalBudgetValue } from './boundedWork';
import { createBoundedParserProjection, registeredBoundedKeys } from './boundedJson';

export type CheckoutPreviewPayload = {
  ok: true;
  totalAmount: number;
  items: CheckoutLineSnapshot[];
};

export type CheckoutSuccessPayload = CheckoutPreviewPayload & {
  transactionId: string;
  studentId: string;
  studentName: string;
  balanceBefore: number;
  balanceAfter: number;
};

export function checkoutPreviewMatchesCart(preview: CheckoutPreviewPayload, requestedItems: CartItem[]): boolean {
  if (preview.items.length !== requestedItems.length) return false;

  const seen = new Set<string>();
  for (let index = 0; index < requestedItems.length; index += 1) {
    const requested = requestedItems[index];
    const quoted = preview.items[index];
    if (typeof requested.productId !== 'string' || requested.productId.trim() === ''
      || !positiveQuantity(requested.quantity) || seen.has(requested.productId)
      || quoted.productId !== requested.productId || quoted.totalQuantity !== requested.quantity) return false;
    seen.add(requested.productId);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeMoney(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function positiveQuantity(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
function nonnegativeQuantity(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function promotionType(value: unknown, budget?: BudgetContext): value is PromotionAdjustment['type'] {
  return equalBudgetValue(value, 'N_PLUS_ONE', budget) || equalBudgetValue(value, 'PROMOTIONAL_PRICE', budget)
    || equalBudgetValue(value, 'PERCENT_DISCOUNT', budget) || equalBudgetValue(value, 'FIXED_DISCOUNT', budget);
}

/** A 교환권 step (runtime snapshots only; migrated legacy history never has one). */
function parseVoucherAdjustment(value: Record<string, unknown>): VoucherAdjustment | null {
  if (value.promotionId !== undefined || value.freeQuantity !== undefined
    || !safeMoney(value.beforeAmount) || !safeMoney(value.afterAmount) || !safeMoney(value.discountAmount)
    || value.afterAmount > value.beforeAmount || value.discountAmount !== value.beforeAmount - value.afterAmount
    || !positiveQuantity(value.voucherCount)) return null;
  return {
    type: 'VOUCHER', beforeAmount: value.beforeAmount, afterAmount: value.afterAmount,
    discountAmount: value.discountAmount, voucherCount: value.voucherCount,
  };
}

function parseAdjustment(value: unknown, budget?: BudgetContext): CheckoutAdjustment | null {
  if (!budget && isRecord(value) && value.type === 'VOUCHER') return parseVoucherAdjustment(value);
  budget?.spend();
  if (budget && value !== null && typeof value === 'object') registeredBoundedKeys(value, budget);
  if (!isRecord(value) || typeof value.promotionId !== 'string' || !trimBudgetString(value.promotionId, budget)
    || !promotionType(value.type, budget) || !safeMoney(value.beforeAmount) || !safeMoney(value.afterAmount)
    || !safeMoney(value.discountAmount) || value.afterAmount > value.beforeAmount
    || value.discountAmount !== value.beforeAmount - value.afterAmount
    || (value.freeQuantity !== undefined && !positiveQuantity(value.freeQuantity))) return null;
  return budget ? createBoundedParserProjection('adjustment', () => value, budget) as unknown as PromotionAdjustment : {
    promotionId: value.promotionId, type: value.type, beforeAmount: value.beforeAmount,
    afterAmount: value.afterAmount, discountAmount: value.discountAmount,
    ...(value.freeQuantity === undefined ? {} : { freeQuantity: value.freeQuantity }),
  };
}

export function parseCheckoutLineSnapshot(value: unknown, budget?: BudgetContext): CheckoutLineSnapshot | null {
  budget?.spend();
  if (budget && value !== null && typeof value === 'object') registeredBoundedKeys(value, budget);
  if (!isRecord(value) || typeof value.productId !== 'string' || !trimBudgetString(value.productId, budget)
    || typeof value.name !== 'string' || !trimBudgetString(value.name, budget)
    || !safeMoney(value.price) || !positiveQuantity(value.quantity) || !safeMoney(value.subtotal)
    || !safeMoney(value.regularUnitPrice) || !safeMoney(value.regularTotal)
    || !positiveQuantity(value.totalQuantity) || !nonnegativeQuantity(value.paidQuantity)
    || !nonnegativeQuantity(value.freeQuantity) || !safeMoney(value.finalTotal) || !safeMoney(value.totalDiscount)
    || value.price !== value.regularUnitPrice || value.quantity !== value.totalQuantity
    || value.subtotal !== value.finalTotal || value.paidQuantity + value.freeQuantity !== value.totalQuantity
    || value.regularUnitPrice * value.totalQuantity !== value.regularTotal
    || value.regularTotal - value.finalTotal !== value.totalDiscount
    || !Array.isArray(value.adjustments) || !Array.isArray(value.appliedPromotions)) return null;
  const productId = value.productId;
  const adjustments = mapBudgetList(value.adjustments, (item) => parseAdjustment(item, budget), budget);
  const appliedPromotions = mapBudgetList(value.appliedPromotions, (item) => parsePromotionResponse(item, budget), budget);
  if (!adjustments.every((item): item is CheckoutAdjustment => { budget?.spend(); return item !== null; })) return null;
  // Promotion steps pair with the applied promotions; a 교환권 step may only come last.
  const last = adjustments[adjustments.length - 1];
  const voucher = last?.type === 'VOUCHER' ? last : null;
  const steps = voucher ? adjustments.slice(0, -1) : adjustments;
  if (!budget && steps.some((adjustment) => adjustment.type === 'VOUCHER')) return null;
  const promotionSteps = steps as PromotionAdjustment[];
  if ((voucher !== null && voucher.voucherCount > value.totalQuantity)
    || !appliedPromotions.every((item): item is NonNullable<ReturnType<typeof parsePromotionResponse>> => { budget?.spend(); return item !== null; })
    || promotionSteps.length !== appliedPromotions.length
    || !uniqueBudgetStrings(mapBudgetList(appliedPromotions, (item) => item.promotionId, budget), budget)
    || promotionSteps.some((adjustment, index) => {
      budget?.spend();
      const promotion = appliedPromotions[index];
      return !equalBudgetValue(adjustment.promotionId, promotion?.promotionId, budget)
        || !equalBudgetValue(adjustment.type, promotion.type, budget)
        || !promotion.productIds.some((id) => equalBudgetValue(id, productId, budget))
        || (adjustment.type === 'N_PLUS_ONE' ? adjustment.freeQuantity === undefined : adjustment.freeQuantity !== undefined);
    })
    || promotionSteps.reduce((sum, adjustment) => { budget?.spend(); return sum + (adjustment.freeQuantity ?? 0); }, 0) !== value.freeQuantity
    || (adjustments.length > 0 && (adjustments[0].beforeAmount !== value.regularTotal
      || adjustments[adjustments.length - 1].afterAmount !== value.finalTotal
      || adjustments.some((adjustment, index) => { budget?.spend(); return index > 0 && adjustment.beforeAmount !== adjustments[index - 1].afterAmount; })))) return null;
  return budget ? createBoundedParserProjection('checkout', () => value, budget) as unknown as CheckoutLineSnapshot : {
    productId, name: value.name, price: value.price, quantity: value.quantity,
    subtotal: value.subtotal, regularUnitPrice: value.regularUnitPrice, regularTotal: value.regularTotal,
    totalQuantity: value.totalQuantity, paidQuantity: value.paidQuantity, freeQuantity: value.freeQuantity,
    finalTotal: value.finalTotal, totalDiscount: value.totalDiscount,
    adjustments, appliedPromotions,
  };
}

export function parseCheckoutPreviewResponse(value: unknown): CheckoutPreviewPayload | null {
  if (!isRecord(value) || value.ok !== true || !safeMoney(value.totalAmount) || !Array.isArray(value.items) || value.items.length === 0) return null;
  const items = value.items.map((item) => parseCheckoutLineSnapshot(item));
  if (!items.every((item): item is CheckoutLineSnapshot => item !== null)
    || new Set(items.map((item) => item.productId)).size !== items.length
    || items.reduce((sum, item) => sum + item.finalTotal, 0) !== value.totalAmount) return null;
  return { ok: true, totalAmount: value.totalAmount, items };
}

export function parseCheckoutSuccessResponse(value: unknown): CheckoutSuccessPayload | null {
  const preview = parseCheckoutPreviewResponse(value);
  if (!preview || !isRecord(value) || typeof value.transactionId !== 'string' || !value.transactionId.trim()
    || typeof value.studentId !== 'string' || !value.studentId.trim()
    || typeof value.studentName !== 'string' || !value.studentName.trim()
    || !safeMoney(value.balanceBefore) || !safeMoney(value.balanceAfter)
    || value.balanceBefore - preview.totalAmount !== value.balanceAfter) return null;
  return {
    ...preview, transactionId: value.transactionId, studentId: value.studentId,
    studentName: value.studentName, balanceBefore: value.balanceBefore, balanceAfter: value.balanceAfter,
  };
}
