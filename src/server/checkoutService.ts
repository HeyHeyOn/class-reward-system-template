import type { CartItem, CheckoutLineItem, Transaction } from '@/domain/types';
import { createCheckoutPreview, type CheckoutPreviewResult } from '@/domain/checkout';
import { buildTransactionAppendRow } from '@/server/sheetsRows';
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
  items: CheckoutLineItem[];
};

export type ProcessCheckoutResult =
  | ProcessCheckoutSuccess
  | Exclude<CheckoutPreviewResult, { ok: true }>
  | { ok: false; code: 'STUDENT_NOT_FOUND'; message: string }
  | { ok: false; code: 'STUDENT_INACTIVE'; message: string };

export async function processCheckout(
  store: TabularStore,
  input: ProcessCheckoutInput,
): Promise<ProcessCheckoutResult> {
  const studentRecord = await getStudentRecordById(store, input.studentId);

  if (!studentRecord) {
    return { ok: false, code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다.' };
  }

  if (studentRecord.student.status !== 'ACTIVE') {
    return { ok: false, code: 'STUDENT_INACTIVE', message: '현재 이용할 수 없는 학생입니다.' };
  }

  const productRecords = await getProductRecords(store);
  const productRecordsById = new Map(productRecords.map((record) => [record.product.productId, record]));
  const selectedProductRecords = input.items
    .map((item) => productRecordsById.get(item.productId))
    .filter((record): record is ProductRecord => Boolean(record));

  const preview = createCheckoutPreview({
    student: studentRecord.student,
    products: selectedProductRecords.map((record) => record.product),
    cartItems: input.items,
  });

  if (!preview.ok) {
    return preview;
  }

  const transactionId = input.transactionIdFactory?.() ?? createTransactionId(input.now?.() ?? new Date());
  const timestamp = (input.now?.() ?? new Date()).toISOString();
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

  await store.updateCell('Students', studentRecord.rowNumber, 'balance', preview.balanceAfter);

  for (const item of preview.items) {
    const productRecord = productRecordsById.get(item.productId);

    if (!productRecord) continue;

    await store.updateCell('Products', productRecord.rowNumber, 'stock', productRecord.product.stock - item.quantity);
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

function createTransactionId(date: Date): string {
  return `T${date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
}
