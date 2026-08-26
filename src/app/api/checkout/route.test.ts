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
    body: JSON.stringify({ studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }] }),
  });
}

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
});
