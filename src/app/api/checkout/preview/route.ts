import type { CartItem } from '@/domain/types';
import { createConfiguredCheckoutPreviewService } from '@/server/repositories/configuredCheckoutPreview';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidCartResponse();
  }

  const validation = parsePreviewCartRequest(body);
  if (!validation.ok) return invalidCartResponse();

  try {
    const service = await createConfiguredCheckoutPreviewService(request);
    const result = await service.previewCheckoutCart({ items: validation.items });
    if (!result.ok) {
      switch (result.code) {
        case 'PRICING_FAILED':
        case 'INVALID_PRODUCTS':
        case 'INVALID_PROMOTIONS':
        case 'ARITHMETIC_OVERFLOW':
          console.error('Checkout preview domain failure', result);
          return checkoutPreviewFailureResponse();
        default:
          return Response.json(result, { status: 400 });
      }
    }
    return Response.json({
      ok: true,
      totalAmount: result.totalAmount,
      items: result.items,
    });
  } catch (error) {
    console.error('Failed to preview checkout', error);
    return checkoutPreviewFailureResponse();
  }
}

function checkoutPreviewFailureResponse(): Response {
  return Response.json(
    { error: '결제 예상 금액을 계산하지 못했습니다.' },
    { status: 500 },
  );
}

type CartRequestValidation =
  | { ok: true; items: CartItem[] }
  | { ok: false };

function parsePreviewCartRequest(value: unknown): CartRequestValidation {
  if (!isExactObject(value, ['items']) || !Array.isArray(value.items) || value.items.length === 0) {
    return { ok: false };
  }

  const items: CartItem[] = [];
  for (const valueItem of value.items) {
    if (!isExactObject(valueItem, ['productId', 'quantity'])
      || typeof valueItem.productId !== 'string'
      || valueItem.productId.trim().length === 0
      || !Number.isSafeInteger(valueItem.quantity)
      || (valueItem.quantity as number) < 1) {
      return { ok: false };
    }
    items.push({
      productId: valueItem.productId.trim(),
      quantity: valueItem.quantity as number,
    });
  }

  return { ok: true, items };
}

function isExactObject<T extends string>(
  value: unknown,
  expectedKeys: readonly T[],
): value is Record<T, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => expectedKeys.includes(key as T));
}

function invalidCartResponse(): Response {
  return Response.json({ error: '장바구니 요청 형식이 올바르지 않습니다.' }, { status: 400 });
}
