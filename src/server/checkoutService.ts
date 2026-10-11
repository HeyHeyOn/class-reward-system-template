import { createHash } from 'node:crypto';
import type { CartItem, CheckoutLineSnapshot, Promotion, Transaction } from '@/domain/types';
import {
  checkoutPricingMatches,
  createCartPricingPreview,
  createCheckoutPreview,
  type CartPricingPreviewSuccess,
  type CartPricingPreviewResult,
  type CheckoutPreviewResult,
} from '@/domain/checkout';
import { buildTransactionAppendRow } from '@/server/sheetsRows';
import type { ProductRecord } from '@/server/sheetsRepository';
import type { TabularStore } from '@/server/storage/tabularStore';
const getActivePromotions: typeof import('@/server/repositories/sheets/promotionQueries').getActivePromotions = async (...args) =>
  (await import('@/server/repositories/sheets/promotionQueries')).getActivePromotions(...args);

const getProductRecords: typeof import('@/server/sheetsRepository').getProductRecords = async (...args) =>
  (await import('@/server/sheetsRepository')).getProductRecords(...args);
const getStudentRecordById: typeof import('@/server/sheetsRepository').getStudentRecordById = async (...args) =>
  (await import('@/server/sheetsRepository')).getStudentRecordById(...args);

export type ProcessCheckoutInput = {
  studentId: string;
  items: CartItem[];
  operator?: string;
  now?: () => Date;
  transactionIdFactory?: () => string;
  expectedPricing: CartPricingPreviewSuccess;
  /** 교환권 (storage items) the student chose to use; PostgreSQL classes only. */
  voucherItemIds?: string[];
};

export type ProcessCheckoutSuccess = {
  ok: true;
  transactionId: string;
  studentId: string;
  studentName: string;
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  items: CheckoutLineSnapshot[];
};

export type ProcessCheckoutResult =
  | ProcessCheckoutSuccess
  | Exclude<CheckoutPreviewResult, { ok: true }>
  | { ok: false; code: 'STUDENT_NOT_FOUND'; message: string }
  | { ok: false; code: 'STUDENT_INACTIVE'; message: string }
  | { ok: false; code: 'VOUCHER_UNAVAILABLE'; message: string }
  | { ok: false; code: 'DIGITAL_ITEM_LIMIT'; message: string }
  | { ok: false; code: 'PRICE_CHANGED'; message: string; latestPricing: CartPricingPreviewSuccess };

export type CheckoutCommandInput = ProcessCheckoutInput & {
  operationId: string;
  payloadHash: string;
};

export type CheckoutOperationFailure = {
  ok: false;
  code: 'OPERATION_CONFLICT' | 'OPERATION_PENDING' | 'OPERATION_FAILED';
  message: string;
  failureCode?: string;
};

export type CheckoutCommandResult = ProcessCheckoutResult | CheckoutOperationFailure;

/** Storage-neutral mutation seam. Sheets remains the default route composition. */
export type CheckoutCommand = {
  execute(input: CheckoutCommandInput): Promise<CheckoutCommandResult>;
};

export function createSheetsCheckoutCommand(store: TabularStore): CheckoutCommand {
  return {
    execute(input) {
      return processCheckout(store, {
        studentId: input.studentId,
        items: input.items,
        expectedPricing: input.expectedPricing,
        voucherItemIds: input.voucherItemIds,
        operator: input.operator,
        now: input.now,
        transactionIdFactory: input.transactionIdFactory,
      });
    },
  };
}

/** The chosen 교환권 IDs in canonical order (trimmed, unique, sorted). */
export function canonicalVoucherItemIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()))].sort((left, right) => left.localeCompare(right));
}

export function createCheckoutPayloadHash(
  input: Pick<CheckoutCommandInput, 'studentId' | 'items' | 'expectedPricing' | 'operator' | 'voucherItemIds'>,
): string {
  const quantities = new Map<string, number>();
  for (const item of input.items) {
    const productId = item.productId.trim();
    const quantity = (quantities.get(productId) ?? 0) + item.quantity;
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error('Cannot hash an invalid checkout payload.');
    }
    quantities.set(productId, quantity);
  }
  const canonicalPayload = {
    studentId: input.studentId.trim(),
    items: [...quantities]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([productId, quantity]) => ({ productId, quantity })),
    expectedPricing: input.expectedPricing,
    operator: input.operator?.trim() || 'kiosk',
  };
  // A checkout without 교환권 hashes exactly as before they existed.
  const voucherItemIds = canonicalVoucherItemIds(input.voucherItemIds);
  if (voucherItemIds.length > 0) Object.assign(canonicalPayload, { voucherItemIds });
  if (!canonicalPayload.studentId || !input.expectedPricing?.ok || voucherItemIds.some((id) => !id)) {
    throw new Error('Cannot hash an invalid checkout payload.');
  }
  return createHash('sha256').update(stableJson(canonicalPayload), 'utf8').digest('hex');
}

export type PreviewCheckoutCartInput = {
  items: CartItem[];
  /** 교환권 counts per product (PostgreSQL classes only). */
  vouchers?: Readonly<Record<string, number>>;
  now?: () => Date;
};

const NO_VOUCHERS = {
  ok: false, code: 'INVALID_VOUCHERS', message: '교환권은 새 방식(PostgreSQL) 학급에서만 쓸 수 있습니다.',
} as const;
const hasVouchers = (vouchers: Readonly<Record<string, number>> | readonly string[] | undefined) =>
  vouchers !== undefined && Object.keys(vouchers).length > 0;

export async function previewCheckoutCart(
  store: TabularStore,
  input: PreviewCheckoutCartInput,
): Promise<CartPricingPreviewResult> {
  if (hasVouchers(input.vouchers)) return NO_VOUCHERS;
  const now = input.now?.() ?? new Date();
  const productRecords = await getProductRecords(store);
  const productRecordsById = new Map(productRecords.map((record) => [record.product.productId, record]));
  const selectedProductRecords = selectProductRecords(productRecordsById, input.items);
  const promotions: Promotion[] = await getActivePromotions(store);

  return createCartPricingPreview({
    products: selectedProductRecords.map((record) => record.product),
    cartItems: input.items,
    promotions,
    now,
  });
}

export async function processCheckout(
  store: TabularStore,
  input: ProcessCheckoutInput,
): Promise<ProcessCheckoutResult> {
  if (hasVouchers(input.voucherItemIds)) return NO_VOUCHERS;
  const now = input.now?.() ?? new Date();
  const studentRecord = await getStudentRecordById(store, input.studentId);

  if (!studentRecord) {
    return { ok: false, code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다.' };
  }

  if (studentRecord.student.status !== 'ACTIVE') {
    return { ok: false, code: 'STUDENT_INACTIVE', message: '현재 이용할 수 없는 학생입니다.' };
  }

  const productRecords = await getProductRecords(store);
  const productRecordsById = new Map(productRecords.map((record) => [record.product.productId, record]));
  const selectedProductRecords = selectProductRecords(productRecordsById, input.items);
  const promotions: Promotion[] = await getActivePromotions(store);

  const authoritativePricing = createCartPricingPreview({
    products: selectedProductRecords.map((record) => record.product),
    cartItems: input.items,
    promotions,
    now,
  });
  if (!authoritativePricing.ok) return authoritativePricing;

  if (!input.expectedPricing || !checkoutPricingMatches(input.expectedPricing, authoritativePricing)) {
    return {
      ok: false,
      code: 'PRICE_CHANGED',
      message: '상품 가격 또는 행사가 변경되었습니다. 최신 금액을 확인해 주세요.',
      latestPricing: authoritativePricing,
    };
  }

  const preview = createCheckoutPreview({
    student: studentRecord.student,
    products: selectedProductRecords.map((record) => record.product),
    cartItems: input.items,
    promotions,
    now,
  });

  if (!preview.ok) {
    return preview;
  }

  const transactionId = input.transactionIdFactory?.() ?? createTransactionId(now);
  const timestamp = now.toISOString();
  const operator = input.operator ?? 'kiosk';
  let transactionHeaders = [
    'transactionId', 'timestamp', 'studentId', 'studentName', 'items',
    'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
  ];
  try {
    transactionHeaders = (await store.getRows('Transactions'))[0] ?? transactionHeaders;
  } catch {
    // Preserve checkout availability by appending with the canonical schema.
  }

  // Sequential provider writes are non-atomic and not exactly-once: each later failure can
  // leave all prior writes applied. R2 deliberately adds no outbox or idempotency schema.
  await store.updateCell('Students', studentRecord.rowNumber, 'balance', preview.balanceAfter);

  for (const item of preview.items) {
    const productRecord = productRecordsById.get(item.productId);

    if (!productRecord) continue;

    await store.updateCell('Products', productRecord.rowNumber, 'stock', productRecord.product.stock - item.totalQuantity);
  }

  const transaction: Transaction = {
    transactionId,
    timestamp,
    studentId: studentRecord.student.studentId,
    studentName: studentRecord.student.name,
    items: preview.items,
    totalAmount: preview.totalAmount,
    balanceBefore: preview.balanceBefore,
    balanceAfter: preview.balanceAfter,
    status: 'COMPLETED',
    operator,
  };
  await store.appendRow('Transactions', buildTransactionAppendRow(transactionHeaders, transaction));

  return {
    ok: true,
    transactionId,
    studentId: studentRecord.student.studentId,
    studentName: studentRecord.student.name,
    totalAmount: preview.totalAmount,
    balanceBefore: preview.balanceBefore,
    balanceAfter: preview.balanceAfter,
    items: preview.items,
  };
}

function selectProductRecords(
  recordsById: Map<string, ProductRecord>,
  items: CartItem[],
): ProductRecord[] {
  const selected = new Map<string, ProductRecord>();
  for (const item of items) {
    const record = recordsById.get(item.productId);
    if (record) selected.set(item.productId, record);
  }
  return [...selected.values()];
}

function createTransactionId(date: Date): string {
  return `T${date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot hash an invalid checkout payload.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('Cannot hash an invalid checkout payload.');
  if (ancestors.has(value)) throw new Error('Cannot hash an invalid checkout payload.');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('Cannot hash an invalid checkout payload.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableJson(entry, ancestors)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key], ancestors)}`
    )).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
