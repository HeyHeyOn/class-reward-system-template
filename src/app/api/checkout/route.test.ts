import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { processCheckout } from '@/server/checkoutService';
import { POST } from './route';

vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsStore: vi.fn(),
}));
vi.mock('@/server/checkoutService', () => ({
  processCheckout: vi.fn(),
}));

function checkoutRequest(): Request {
  return new Request('http://localhost/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      studentId: 'S001',
      items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing,
    }),
  });
}

const expectedPricing = {
  ok: true as const, totalAmount: 300,
  items: [{
    productId: 'P001', name: '연필', price: 300, quantity: 1, subtotal: 300,
    regularUnitPrice: 300, regularTotal: 300, totalQuantity: 1, paidQuantity: 1,
    freeQuantity: 0, finalTotal: 300, totalDiscount: 0, adjustments: [], appliedPromotions: [],
  }],
};

describe('POST /api/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
  });

  it('logs internal failures and returns a generic 500 without leaking exception details', async () => {
    const error = new Error('private provider credential and sheet coordinates');
    vi.mocked(processCheckout).mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await POST(checkoutRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: '결제를 처리하지 못했습니다.' });
    expect(JSON.stringify(body)).not.toContain(error.message);
    expect(consoleError).toHaveBeenCalledWith('Failed to process checkout', error);
  });

  it('preserves structured domain failures as 400 responses', async () => {
    const failure = {
      ok: false as const,
      code: 'INSUFFICIENT_STOCK' as const,
      message: '재고가 부족합니다.',
      productId: 'P001',
      requestedQuantity: 2,
      currentStock: 1,
    };
    vi.mocked(processCheckout).mockResolvedValue(failure);

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(failure);
  });

  it('rejects a missing expectedPricing quote before opening the store', async () => {
    const missingQuote = new Request('http://localhost/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }] }),
    });

    const response = await POST(missingQuote);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '예상 결제 금액 형식이 올바르지 않습니다.' });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(processCheckout).not.toHaveBeenCalled();
  });

  it('strictly validates expectedPricing before opening the store and forwards exact quotes', async () => {
    const malformed = new Request('http://localhost/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }], expectedPricing: { ...expectedPricing, totalAmount: 999 } }),
    });
    const invalidResponse = await POST(malformed);
    expect(invalidResponse.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();

    vi.mocked(processCheckout).mockResolvedValue({ ok: true, transactionId: 'T1', studentId: 'S001', studentName: '민준', totalAmount: 300, balanceBefore: 500, balanceAfter: 200, items: expectedPricing.items });
    const valid = new Request('http://localhost/api/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }], expectedPricing }),
    });
    expect((await POST(valid)).status).toBe(200);
    expect(processCheckout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedPricing }));
  });

  it('returns price changes as safe 409 responses', async () => {
    const changed = { ok: false as const, code: 'PRICE_CHANGED' as const, message: '최신 금액을 확인해 주세요.', latestPricing: expectedPricing };
    vi.mocked(processCheckout).mockResolvedValue(changed);
    const response = await POST(checkoutRequest());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(changed);
  });
});
