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
import { getActivePromotions } from '@/server/repositories/sheets/promotionQueries';
import {
  getProductRecords,
  getStudentRecordById,
  type ProductRecord,
} from '@/server/sheetsRepository';
import type { TabularStore } from '@/server/storage/tabularStore';

export type ProcessCheckoutInput = {
  studentId: string;
  items: CartItem[];
  operator?: string;
  now?: () => Date;
  transactionIdFactory?: () => string;
  expectedPricing: CartPricingPreviewSuccess;
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
        operator: input.operator,
        now: input.now,
        transactionIdFactory: input.transactionIdFactory,
      });
    },
  };
}

export function createCheckoutPayloadHash(
  input: Pick<CheckoutCommandInput, 'studentId' | 'items' | 'expectedPricing' | 'operator'>,
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
  if (!canonicalPayload.studentId || !input.expectedPricing?.ok) {
    throw new Error('Cannot hash an invalid checkout payload.');
  }
  return createHash('sha256').update(stableJson(canonicalPayload), 'utf8').digest('hex');
}

export type PreviewCheckoutCartInput = {
  items: CartItem[];
  now?: () => Date;
};

export async function previewCheckoutCart(
  store: TabularStore,
  input: PreviewCheckoutCartInput,
): Promise<CartPricingPreviewResult> {
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
