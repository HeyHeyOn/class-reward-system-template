import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import * as checkoutService from '@/server/checkoutService';
import { createConfiguredCheckoutPreviewService } from '@/server/repositories/configuredCheckoutPreview';
import type { OperationalSheetName, TabularStore } from '@/server/storage/tabularStore';
import { POST as commitCheckout } from '../route';
import { POST as previewCheckout } from './route';

vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsStore: vi.fn(),
  createConfiguredSheetsReader: vi.fn(),
}));
vi.mock('@/server/repositories/configuredCheckoutPreview', () => ({
  createConfiguredCheckoutPreviewService: vi.fn(),
}));

class FakeSheetsStore implements TabularStore {
  public updates: unknown[] = [];
  public appends: unknown[] = [];

  constructor(public rows: Record<string, string[][]>) {}

  async getRows(sheetName: OperationalSheetName): Promise<string[][]> {
    return this.rows[sheetName] ?? [];
  }

  async updateCell(sheetName: OperationalSheetName, rowNumber: number, columnName: string, value: string | number) {
    this.updates.push({ sheetName, rowNumber, columnName, value });
  }

  async appendRow(sheetName: OperationalSheetName, values: string[]) {
    this.appends.push({ sheetName, values });
  }
}

const promotionHeaders = [
  'promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity',
  'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion',
];

function sourceRows(): Record<string, string[][]> {
  return {
    Students: [
      ['studentId', 'name', 'number', 'balance', 'qrValue', 'status', 'note'],
      ['S001', '김민준', '1', '3500', 'S001', 'ACTIVE', ''],
    ],
    Products: [
      ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
      ['P001', '연필', '300', '20', 'TRUE', '', '문구', '1'],
    ],
    Promotions: [
      promotionHeaders,
      ['N21', '2+1', '', 'N_PLUS_ONE', '', '2', '1', '2020-01-01T00:00:00.000Z', '2099-09-01T00:00:00.000Z', 'TRUE', '1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '3'],
      ['P10', '10%', '', 'PERCENT_DISCOUNT', '10', '', '', '2020-01-01T00:00:00.000Z', '2099-09-01T00:00:00.000Z', 'TRUE', '1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '3'],
    ],
    PromotionProducts: [
      ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'],
      ['L1', 'N21', 'P001', '2020-01-01T00:00:00.000Z', '3'],
      ['L2', 'P10', 'P001', '2020-01-01T00:00:00.000Z', '3'],
    ],
    Transactions: [[
      'transactionId', 'timestamp', 'studentId', 'studentName', 'items',
      'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator',
    ]],
  };
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/checkout/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/checkout/preview', () => {
  beforeEach(() => {
    vi.mocked(createConfiguredSheetsStore).mockReset();
    vi.mocked(createConfiguredCheckoutPreviewService).mockReset();
    vi.mocked(createConfiguredCheckoutPreviewService).mockResolvedValue({
      previewCheckoutCart: async (input) => checkoutService.previewCheckoutCart(
        await createConfiguredSheetsStore(),
        input,
      ),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ['non-object body', []],
    ['unknown top-level key', { items: [{ productId: 'P001', quantity: 1 }], extra: true }],
    ['missing items', {}],
    ['empty items', { items: [] }],
    ['unknown item key', { items: [{ productId: 'P001', quantity: 1, extra: true }] }],
    ['blank product ID', { items: [{ productId: '  ', quantity: 1 }] }],
    ['zero quantity', { items: [{ productId: 'P001', quantity: 0 }] }],
    ['unsafe quantity', { items: [{ productId: 'P001', quantity: Number.MAX_SAFE_INTEGER + 1 }] }],
  ])('rejects %s before creating a store', async (_label, body) => {
    const response = await previewCheckout(request(body));

    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before creating a store', async () => {
    const response = await previewCheckout(new Request('http://localhost/api/checkout/preview', {
      method: 'POST', body: '{', headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('accepts duplicate IDs, trims them, preserves first-seen order, and returns the exact pricing DTO without writes', async () => {
    const store = new FakeSheetsStore(sourceRows());
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);

    const response = await previewCheckout(request({
      items: [
        { productId: ' P001 ', quantity: 1 },
        { productId: 'P001', quantity: 2 },
      ],
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledOnce();
    expect(body).toEqual({
      ok: true,
      totalAmount: 540,
      items: [expect.objectContaining({
        productId: 'P001', quantity: 3, totalQuantity: 3,
        paidQuantity: 2, freeQuantity: 1, subtotal: 540, finalTotal: 540,
      })],
    });
    expect(Object.keys(body)).toEqual(['ok', 'totalAmount', 'items']);
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('returns domain pricing failures as 400 without writes', async () => {
    const rows = sourceRows();
    rows.Products[1][3] = '1';
    const store = new FakeSheetsStore(rows);
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);

    const response = await previewCheckout(request({ items: [{ productId: 'P001', quantity: 2 }] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: 'INSUFFICIENT_STOCK' });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('sanitizes and logs PRICING_FAILED details from checkout pricing', async () => {
    const store = new FakeSheetsStore(sourceRows());
    const failure = {
      ok: false as const,
      code: 'PRICING_FAILED' as const,
      message: 'secret pricing formula detail',
      productId: 'SECRET-PRODUCT',
      pricingCode: 'SECRET_PRICING_CODE',
      promotionId: 'SECRET-PROMOTION',
    };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.spyOn(checkoutService, 'previewCheckoutCart').mockResolvedValue(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await previewCheckout(request({ items: [{ productId: 'P001', quantity: 1 }] }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: '결제 예상 금액을 계산하지 못했습니다.' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(consoleError).toHaveBeenCalledWith('Checkout preview domain failure', failure);
  });

  it.each([
    [{ ok: false as const, code: 'INVALID_PRODUCTS' as const, message: 'secret product sheet detail' }],
    [{ ok: false as const, code: 'INVALID_PROMOTIONS' as const, message: 'secret promotion sheet detail' }],
    [{ ok: false as const, code: 'ARITHMETIC_OVERFLOW' as const, message: 'secret arithmetic detail', productId: 'SECRET-PRODUCT' }],
  ])('sanitizes and logs server-controlled %s failures', async (failure) => {
    const store = new FakeSheetsStore(sourceRows());
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.spyOn(checkoutService, 'previewCheckoutCart').mockResolvedValue(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await previewCheckout(request({ items: [{ productId: 'P001', quantity: 1 }] }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: '결제 예상 금액을 계산하지 못했습니다.' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(consoleError).toHaveBeenCalledWith('Checkout preview domain failure', failure);
  });

  it.each([
    [{ ok: false as const, code: 'PRODUCT_NOT_FOUND' as const, message: '상품을 찾을 수 없습니다.', productId: 'P404' }],
    [{ ok: false as const, code: 'PRODUCT_INACTIVE' as const, message: '판매 중지된 상품입니다.', productId: 'P001' }],
    [{ ok: false as const, code: 'INSUFFICIENT_STOCK' as const, message: '재고가 부족합니다.', productId: 'P001', requestedQuantity: 2, currentStock: 1 }],
    [{ ok: false as const, code: 'INVALID_QUANTITY' as const, message: '상품 수량은 1개 이상이어야 합니다.', productId: 'P001' }],
    [{ ok: false as const, code: 'EMPTY_CART' as const, message: '장바구니가 비어 있습니다.' }],
    [{ ok: false as const, code: 'INVALID_CART' as const, message: '장바구니가 올바르지 않습니다.' }],
  ])('preserves client or stale-cart %s failures as structured 400 responses', async (failure) => {
    const store = new FakeSheetsStore(sourceRows());
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.spyOn(checkoutService, 'previewCheckoutCart').mockResolvedValue(failure);

    const response = await previewCheckout(request({ items: [{ productId: 'P001', quantity: 1 }] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(failure);
  });

  it('sanitizes and logs provider failures without leaking raw details', async () => {
    const error = new Error('private provider credential');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new FakeSheetsStore(sourceRows());
    store.getRows = vi.fn(async () => {
      throw error;
    });
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);

    const response = await previewCheckout(request({ items: [{ productId: 'P001', quantity: 1 }] }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: '결제 예상 금액을 계산하지 못했습니다.' });
    expect(JSON.stringify(body)).not.toContain('private provider credential');
    expect(consoleError).toHaveBeenCalledWith('Failed to preview checkout', error);
  });

  it('sanitizes malformed promotion schemas as 500 and never writes', async () => {
    const rows = sourceRows();
    rows.Promotions = [['promotionId']];
    const store = new FakeSheetsStore(rows);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);

    const response = await previewCheckout(request({ items: [{ productId: 'P001', quantity: 1 }] }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '결제 예상 금액을 계산하지 못했습니다.' });
    expect(store.updates).toEqual([]);
    expect(store.appends).toEqual([]);
  });

  it('matches successful checkout items and total for the same mocked source snapshot', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const previewStore = new FakeSheetsStore(sourceRows());
    const checkoutStore = new FakeSheetsStore(sourceRows());
    vi.mocked(createConfiguredSheetsStore)
      .mockResolvedValueOnce(previewStore as never)
      .mockResolvedValueOnce(checkoutStore as never);
    const items = [{ productId: 'P001', quantity: 3 }];

    const previewResponse = await previewCheckout(request({ items }));
    const previewBody = await previewResponse.json();
    const checkoutResponse = await commitCheckout(new Request('http://localhost/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: '11111111-1111-4111-8111-111111111111',
        studentId: 'S001',
        items,
        expectedPricing: previewBody,
      }),
    }));
    const checkoutBody = await checkoutResponse.json();

    expect(previewResponse.status).toBe(200);
    expect(checkoutResponse.status).toBe(200);
    expect(previewBody.totalAmount).toBe(checkoutBody.totalAmount);
    expect(previewBody.items).toEqual(checkoutBody.items);
    expect(previewStore.updates).toEqual([]);
    expect(previewStore.appends).toEqual([]);
    expect(checkoutStore.updates.length).toBeGreaterThan(0);
    expect(checkoutStore.appends).toHaveLength(1);
  });
});
