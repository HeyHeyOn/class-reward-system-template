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
    const result = await service.previewCheckoutCart({
      items: validation.items,
      ...(validation.vouchers ? { vouchers: validation.vouchers } : {}),
    });
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
    { error: '결제 예상 금액을 계산하지 못했어요.' },
    { status: 500 },
  );
}

type CartRequestValidation =
  | { ok: true; items: CartItem[]; vouchers?: Record<string, number> }
  | { ok: false };

function parsePreviewCartRequest(value: unknown): CartRequestValidation {
  const withVouchers = isExactObject(value, ['items', 'vouchers']);
  if ((!withVouchers && !isExactObject(value, ['items'])) || !Array.isArray(value.items) || value.items.length === 0) {
    return { ok: false };
  }
  // 교환권 counts per product: { productId: count }.
  let vouchers: Record<string, number> | undefined;
  if (withVouchers) {
    const raw = (value as { vouchers: unknown }).vouchers;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
    vouchers = {};
    for (const [productId, count] of Object.entries(raw)) {
      if (!productId.trim() || !Number.isSafeInteger(count) || (count as number) < 1) return { ok: false };
      vouchers[productId] = count as number;
    }
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

  return { ok: true, items, ...(vouchers ? { vouchers } : {}) };
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
  return Response.json({ error: '장바구니 요청 형식이 올바르지 않아요.' }, { status: 400 });
}
