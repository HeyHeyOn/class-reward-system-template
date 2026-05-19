import type { CartItem, CheckoutLineItem } from '@/domain/types';
import { createCheckoutPreview, type CheckoutPreviewResult } from '@/domain/checkout';
import {
  getProductRecords,
  getStudentRecordById,
  type ProductRecord,
  type SheetsStore,
} from '@/server/sheetsRepository';

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
  store: SheetsStore,
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

  await store.updateCell('Students', studentRecord.rowNumber, 'balance', preview.balanceAfter);

  for (const item of preview.items) {
    const productRecord = productRecordsById.get(item.productId);

    if (!productRecord) continue;

    await store.updateCell('Products', productRecord.rowNumber, 'stock', productRecord.product.stock - item.quantity);
  }

  await store.appendRow('Transactions', [
    transactionId,
    timestamp,
    studentRecord.student.studentId,
    studentRecord.student.name,
    JSON.stringify(preview.items),
    String(preview.totalAmount),
    String(preview.balanceBefore),
    String(preview.balanceAfter),
    'COMPLETED',
    operator,
  ]);

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
