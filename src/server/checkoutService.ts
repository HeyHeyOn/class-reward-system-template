import type { CartItem, CheckoutLineSnapshot, Promotion, Transaction } from '@/domain/types';
import {
  createCartPricingPreview,
  createCheckoutPreview,
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
  | { ok: false; code: 'STUDENT_INACTIVE'; message: string };

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
