import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  createCheckoutPayloadHash,
  createSheetsCheckoutCommand,
} from '@/server/checkoutService';
import type { CartItem } from '@/domain/types';
import { checkoutPreviewMatchesCart, parseCheckoutPreviewResponse, type CheckoutPreviewPayload } from '@/lib/checkoutSnapshotClient';

export const dynamic = 'force-dynamic';

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CheckoutRequestBody = {
  operationId?: unknown;
  studentId?: unknown;
  items?: unknown;
  expectedPricing?: unknown;
};

export async function POST(request: Request) {
  try {
    const rawBody: unknown = await request.json();
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return Response.json({ error: '결제 요청 형식이 올바르지 않습니다.' }, { status: 400 });
    }
    const body = rawBody as CheckoutRequestBody;
    const validation = validateCheckoutBody(body);

    if (validation.ok === false) {
      return Response.json({ error: validation.message }, { status: 400 });
    }

    const store = await createConfiguredSheetsStore();
    const command = createSheetsCheckoutCommand(store);
    const checkoutInput = {
      operationId: validation.operationId,
      studentId: validation.studentId,
      items: validation.items,
      expectedPricing: validation.expectedPricing,
      operator: 'kiosk',
    };
    const result = await command.execute({
      ...checkoutInput,
      payloadHash: createCheckoutPayloadHash(checkoutInput),
    });

    if (!result.ok) {
      const conflictCodes = new Set([
        'PRICE_CHANGED', 'OPERATION_CONFLICT', 'OPERATION_PENDING', 'OPERATION_FAILED',
      ]);
      return Response.json(result, { status: conflictCodes.has(result.code) ? 409 : 400 });
    }

    return Response.json(result);
  } catch {
    console.error('checkout_failed');
    return Response.json({ error: '결제를 처리하지 못했습니다.' }, { status: 500 });
  }
}

type CheckoutBodyValidation =
  | { ok: true; operationId: string; studentId: string; items: CartItem[]; expectedPricing: CheckoutPreviewPayload }
  | { ok: false; message: string };

function validateCheckoutBody(body: CheckoutRequestBody): CheckoutBodyValidation {
  if (typeof body.operationId !== 'string' || !OPERATION_ID.test(body.operationId)) {
    return { ok: false, message: '결제 작업 ID 형식이 올바르지 않습니다.' };
  }

  if (typeof body.studentId !== 'string' || !body.studentId.trim()) {
    return { ok: false, message: '학생 ID가 필요합니다.' };
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, message: '장바구니가 비어 있습니다.' };
  }

  const items: CartItem[] = [];
  for (const item of body.items) {
    if (!isCartItemLike(item)) {
      return { ok: false, message: '장바구니 형식이 올바르지 않습니다.' };
    }
    items.push({ productId: item.productId.trim(), quantity: item.quantity });
  }

  const expectedPricing = parseCheckoutPreviewResponse(body.expectedPricing);
  if (!expectedPricing || !checkoutPreviewMatchesCart(expectedPricing, items)) {
    return { ok: false, message: '예상 결제 금액 형식이 올바르지 않습니다.' };
  }

  return {
    ok: true,
    operationId: body.operationId,
    studentId: body.studentId.trim(),
    items,
    expectedPricing,
  };
}

function isCartItemLike(value: unknown): value is CartItem {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { productId?: unknown; quantity?: unknown };
  return (
    typeof candidate.productId === 'string' &&
    candidate.productId.trim().length > 0 &&
    typeof candidate.quantity === 'number' &&
    Number.isSafeInteger(candidate.quantity) &&
    candidate.quantity > 0
  );
}
