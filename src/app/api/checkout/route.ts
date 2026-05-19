import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { processCheckout } from '@/server/checkoutService';
import type { CartItem } from '@/domain/types';

export const dynamic = 'force-dynamic';

type CheckoutRequestBody = {
  studentId?: unknown;
  items?: unknown;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CheckoutRequestBody;
    const validation = validateCheckoutBody(body);

    if (validation.ok === false) {
      return Response.json({ error: validation.message }, { status: 400 });
    }

    const store = await createConfiguredSheetsStore();
    const result = await processCheckout(store, {
      studentId: validation.studentId,
      items: validation.items,
      operator: 'kiosk',
    });

    if (!result.ok) {
      return Response.json(result, { status: 400 });
    }

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '결제를 처리하지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}

type CheckoutBodyValidation =
  | { ok: true; studentId: string; items: CartItem[] }
  | { ok: false; message: string };

function validateCheckoutBody(body: CheckoutRequestBody): CheckoutBodyValidation {
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

  return { ok: true, studentId: body.studentId.trim(), items };
}

function isCartItemLike(value: unknown): value is CartItem {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as { productId?: unknown; quantity?: unknown };

  return (
    typeof candidate.productId === 'string' &&
    candidate.productId.trim().length > 0 &&
    typeof candidate.quantity === 'number' &&
    Number.isInteger(candidate.quantity) &&
    candidate.quantity > 0
  );
}
