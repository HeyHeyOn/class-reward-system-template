import 'server-only';

import type {
  CheckoutLineItem,
  CheckoutLineSnapshot,
  ClassTask,
  Product,
  Student,
  Transaction,
} from '@/domain/types';
import { parseCheckoutLineSnapshot } from '@/lib/checkoutSnapshotClient';

export function safeInteger(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
  } else if (typeof value === 'bigint') {
    const projected = Number(value);
    if (Number.isSafeInteger(projected) && BigInt(projected) === value) return projected;
  } else if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const projected = Number(value);
    if (Number.isSafeInteger(projected) && BigInt(value) === BigInt(projected)) return projected;
  }
  throw new Error(`${label} must be an exact JavaScript safe integer.`);
}

export function isoString(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new Error(`${label} must be a valid date value.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a valid date value.`);
  }
  return date.toISOString();
}

export function nullableString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string when present.`);
  return value;
}

export function nullableIsoString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return isoString(value, label);
}

export function compareStudentsLikeSheets(left: Student, right: Student): number {
  return left.studentId.localeCompare(right.studentId, 'ko-KR', { numeric: true })
    || left.name.localeCompare(right.name);
}

export function compareProductsLikeSheets(left: Product, right: Product): number {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name);
}

export function compareTasksLikeSheets(left: ClassTask, right: ClassTask): number {
  return left.sortOrder - right.sortOrder || left.title.localeCompare(right.title);
}

export function compareTransactionsLikeSheets(left: Transaction, right: Transaction): number {
  return right.timestamp.localeCompare(left.timestamp);
}

export type TransactionItemRow = {
  product_id_snapshot: unknown;
  product_name_snapshot: unknown;
  quantity: unknown;
  unit_price_snapshot: unknown;
  subtotal_snapshot: unknown;
  regular_unit_price: unknown;
  regular_total: unknown;
  total_quantity: unknown;
  paid_quantity: unknown;
  free_quantity: unknown;
  final_total: unknown;
  total_discount: unknown;
  adjustments_snapshot: unknown;
  applied_promotions_snapshot: unknown;
};

export function projectTransactionItem(row: TransactionItemRow): CheckoutLineItem | CheckoutLineSnapshot {
  if (typeof row.product_id_snapshot !== 'string' || !row.product_id_snapshot.trim()
      || typeof row.product_name_snapshot !== 'string' || !row.product_name_snapshot.trim()) {
    throw new Error('Transaction item snapshot integrity check failed.');
  }

  const quantity = safeInteger(row.quantity, 'quantity');
  if (quantity < 1) throw new Error('Transaction item quantity integrity check failed.');
  const base: CheckoutLineItem = {
    productId: row.product_id_snapshot,
    name: row.product_name_snapshot,
    price: safeInteger(row.unit_price_snapshot, 'unit price snapshot'),
    quantity,
    subtotal: safeInteger(row.subtotal_snapshot, 'subtotal snapshot'),
  };
  const extendedValues = [
    row.regular_unit_price,
    row.regular_total,
    row.total_quantity,
    row.paid_quantity,
    row.free_quantity,
    row.final_total,
    row.total_discount,
    row.adjustments_snapshot,
    row.applied_promotions_snapshot,
  ];
  if (extendedValues.every((value) => value === null || value === undefined)) return base;
  if (extendedValues.some((value) => value === null || value === undefined)) {
    throw new Error('Transaction item extended snapshot integrity check failed.');
  }

  const projected = parseCheckoutLineSnapshot({
    ...base,
    regularUnitPrice: safeInteger(row.regular_unit_price, 'regular unit price'),
    regularTotal: safeInteger(row.regular_total, 'regular total'),
    totalQuantity: safeInteger(row.total_quantity, 'total quantity'),
    paidQuantity: safeInteger(row.paid_quantity, 'paid quantity'),
    freeQuantity: safeInteger(row.free_quantity, 'free quantity'),
    finalTotal: safeInteger(row.final_total, 'final total'),
    totalDiscount: safeInteger(row.total_discount, 'total discount'),
    adjustments: row.adjustments_snapshot,
    appliedPromotions: row.applied_promotions_snapshot,
  });
  if (!projected) throw new Error('Transaction item extended snapshot integrity check failed.');
  return projected;
}
