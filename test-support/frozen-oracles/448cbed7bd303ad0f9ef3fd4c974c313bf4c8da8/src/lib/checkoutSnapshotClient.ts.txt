import type { CartItem, CheckoutLineSnapshot, PromotionAdjustment } from '@/domain/types';
import { parsePromotionResponse } from './promotionClient';

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
function promotionType(value: unknown): value is PromotionAdjustment['type'] {
  return value === 'N_PLUS_ONE' || value === 'PROMOTIONAL_PRICE' || value === 'PERCENT_DISCOUNT' || value === 'FIXED_DISCOUNT';
}

function parseAdjustment(value: unknown): PromotionAdjustment | null {
  if (!isRecord(value) || typeof value.promotionId !== 'string' || !value.promotionId.trim()
    || !promotionType(value.type) || !safeMoney(value.beforeAmount) || !safeMoney(value.afterAmount)
    || !safeMoney(value.discountAmount) || value.afterAmount > value.beforeAmount
    || value.discountAmount !== value.beforeAmount - value.afterAmount
    || (value.freeQuantity !== undefined && !positiveQuantity(value.freeQuantity))) return null;
  return {
    promotionId: value.promotionId, type: value.type, beforeAmount: value.beforeAmount,
    afterAmount: value.afterAmount, discountAmount: value.discountAmount,
    ...(value.freeQuantity === undefined ? {} : { freeQuantity: value.freeQuantity }),
  };
}

export function parseCheckoutLineSnapshot(value: unknown): CheckoutLineSnapshot | null {
  if (!isRecord(value) || typeof value.productId !== 'string' || !value.productId.trim()
    || typeof value.name !== 'string' || !value.name.trim()
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
  const adjustments = value.adjustments.map(parseAdjustment);
  const appliedPromotions = value.appliedPromotions.map(parsePromotionResponse);
  if (!adjustments.every((item): item is PromotionAdjustment => item !== null)
    || !appliedPromotions.every((item): item is NonNullable<ReturnType<typeof parsePromotionResponse>> => item !== null)
    || adjustments.length !== appliedPromotions.length
    || new Set(appliedPromotions.map((item) => item.promotionId)).size !== appliedPromotions.length
    || adjustments.some((adjustment, index) => {
      const promotion = appliedPromotions[index];
      return adjustment.promotionId !== promotion?.promotionId
        || adjustment.type !== promotion.type
        || !promotion.productIds.includes(productId)
        || (adjustment.type === 'N_PLUS_ONE' ? adjustment.freeQuantity === undefined : adjustment.freeQuantity !== undefined);
    })
    || adjustments.reduce((sum, adjustment) => sum + (adjustment.freeQuantity ?? 0), 0) !== value.freeQuantity
    || (adjustments.length > 0 && (adjustments[0].beforeAmount !== value.regularTotal
      || adjustments[adjustments.length - 1].afterAmount !== value.finalTotal
      || adjustments.some((adjustment, index) => index > 0 && adjustment.beforeAmount !== adjustments[index - 1].afterAmount)))) return null;
  return {
    productId, name: value.name, price: value.price, quantity: value.quantity,
    subtotal: value.subtotal, regularUnitPrice: value.regularUnitPrice, regularTotal: value.regularTotal,
    totalQuantity: value.totalQuantity, paidQuantity: value.paidQuantity, freeQuantity: value.freeQuantity,
    finalTotal: value.finalTotal, totalDiscount: value.totalDiscount,
    adjustments, appliedPromotions,
  };
}

export function parseCheckoutPreviewResponse(value: unknown): CheckoutPreviewPayload | null {
  if (!isRecord(value) || value.ok !== true || !safeMoney(value.totalAmount) || !Array.isArray(value.items) || value.items.length === 0) return null;
  const items = value.items.map(parseCheckoutLineSnapshot);
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
