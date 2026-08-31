import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckoutPayloadHash } from '@/server/checkoutService';
import { createConfiguredCheckoutCommand } from '@/server/repositories/configuredCheckout';
import { POST } from './route';

const executeCheckout = vi.hoisted(() => vi.fn());

vi.mock('@/server/checkoutService', () => ({
  createCheckoutPayloadHash: vi.fn(() => 'a'.repeat(64)),
}));
vi.mock('@/server/repositories/configuredCheckout', () => ({
  createConfiguredCheckoutCommand: vi.fn(() => ({ execute: executeCheckout })),
}));

const expectedPricing = {
  ok: true as const, totalAmount: 300,
  items: [{
    productId: 'P001', name: '연필', price: 300, quantity: 1, subtotal: 300,
    regularUnitPrice: 300, regularTotal: 300, totalQuantity: 1, paidQuantity: 1,
    freeQuantity: 0, finalTotal: 300, totalDiscount: 0, adjustments: [], appliedPromotions: [],
  }],
};

function checkoutRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: '11111111-1111-4111-8111-111111111111',
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing,
      ...overrides,
    }),
  });
}

describe('POST /api/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConfiguredCheckoutCommand).mockResolvedValue({ execute: executeCheckout });
  });

  it('logs internal failures and returns a generic 500 without leaking exception details', async () => {
    const error = new Error('private provider credential and sheet coordinates');
    executeCheckout.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(checkoutRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: '결제를 처리하지 못했습니다.' });
    expect(JSON.stringify(body)).not.toContain(error.message);
    expect(consoleError).toHaveBeenCalledWith('checkout_failed');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(error.message);
  });

  it('preserves structured domain failures as 400 responses', async () => {
    const failure = {
      ok: false as const,
      code: 'INSUFFICIENT_STOCK' as const,
      message: '재고가 부족합니다.',
      productId: 'P001', requestedQuantity: 2, currentStock: 1,
    };
    executeCheckout.mockResolvedValue(failure);

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(failure);
  });

  it.each([null, [], 'checkout'])(
    'rejects a non-object body before opening the store',
    async (body) => {
      const response = await POST(new Request('http://localhost/api/checkout', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
      expect(createConfiguredCheckoutCommand).not.toHaveBeenCalled();
    },
  );

  it('rejects unsafe cart quantities before hashing or opening the store', async () => {
    const response = await POST(checkoutRequest({
      items: [{ productId: 'P001', quantity: Number.MAX_SAFE_INTEGER + 1 }],
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '장바구니 형식이 올바르지 않습니다.' });
    expect(createCheckoutPayloadHash).not.toHaveBeenCalled();
    expect(createConfiguredCheckoutCommand).not.toHaveBeenCalled();
  });

  it('rejects a missing expectedPricing quote before opening the store', async () => {
    const response = await POST(checkoutRequest({ expectedPricing: undefined }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '예상 결제 금액 형식이 올바르지 않습니다.' });
    expect(createConfiguredCheckoutCommand).not.toHaveBeenCalled();
    expect(executeCheckout).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', 'not-a-uuid'])(
    'rejects invalid operation ID %s before opening the store',
    async (operationId) => {
      const response = await POST(checkoutRequest({ operationId }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: '결제 작업 ID 형식이 올바르지 않습니다.' });
      expect(createConfiguredCheckoutCommand).not.toHaveBeenCalled();
      expect(executeCheckout).not.toHaveBeenCalled();
    },
  );

  it('strictly validates pricing, computes the canonical hash server-side, and invokes the selected command', async () => {
    const malformed = await POST(checkoutRequest({
      expectedPricing: { ...expectedPricing, totalAmount: 999 },
    }));
    expect(malformed.status).toBe(400);
    expect(createConfiguredCheckoutCommand).not.toHaveBeenCalled();

    const success = {
      ok: true as const, transactionId: 'T1', studentId: 'S001', studentName: '민준',
      totalAmount: 300, balanceBefore: 500, balanceAfter: 200, items: expectedPricing.items,
    };
    executeCheckout.mockResolvedValue(success);
    const request = checkoutRequest();
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(createConfiguredCheckoutCommand).toHaveBeenCalledWith(request);
    expect(createCheckoutPayloadHash).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing,
      operator: 'kiosk',
    });
    expect(executeCheckout).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing,
      operator: 'kiosk',
      payloadHash: 'a'.repeat(64),
    });
  });

  it.each(['PRICE_CHANGED', 'OPERATION_CONFLICT', 'OPERATION_PENDING', 'OPERATION_FAILED'])(
    'returns %s as a safe 409 response',
    async (code) => {
      const changed = {
        ok: false as const,
        code,
        message: '요청을 다시 확인해 주세요.',
        ...(code === 'PRICE_CHANGED' ? { latestPricing: expectedPricing } : {}),
      };
      executeCheckout.mockResolvedValue(changed);

      const response = await POST(checkoutRequest());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(changed);
    },
  );
});
