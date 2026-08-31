import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createPromotion, replacePromotionProducts } from '@/server/repositories/sheets/promotionCommands';
import { getPromotions } from '@/server/repositories/sheets/promotionQueries';
import { createConfiguredCatalogReader } from '@/server/repositories/configuredCatalog';
import { GET, POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(),
  unauthorizedAdminResponse: vi.fn(() => Response.json({ error: 'unauthorized' }, { status: 401 })),
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsReader: vi.fn(),
  createConfiguredSheetsStore: vi.fn(),
}));
vi.mock('@/server/repositories/sheets/promotionQueries', () => ({ getPromotions: vi.fn() }));
vi.mock('@/server/repositories/configuredCatalog', () => ({ createConfiguredCatalogReader: vi.fn() }));
vi.mock('@/server/repositories/sheets/promotionCommands', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/repositories/sheets/promotionCommands')>(),
  createPromotion: vi.fn(),
  replacePromotionProducts: vi.fn(),
}));

const common = {
  name: '행사',
  description: '설명',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  isActive: true,
  sortOrder: 2,
};

function post(body: unknown) {
  return POST(new Request('http://localhost/api/promotions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('GET /api/promotions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('rejects unauthorized requests without resolving a catalog', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const request = new Request('http://localhost/api/promotions');

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(unauthorizedAdminResponse).toHaveBeenCalledOnce();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(getPromotions).not.toHaveBeenCalled();
    expect(createConfiguredCatalogReader).not.toHaveBeenCalled();
  });

  it('uses the configured catalog and returns every deterministic joined row', async () => {
    const request = new Request('http://localhost/api/promotions');

    const rows = [
      { promotionId: 'P1', isActive: false, productIds: ['B', 'A'] },
      { promotionId: 'P2', isActive: true, productIds: [] },
    ];
    const catalog = { getPromotions: vi.fn(async () => rows) };
    vi.mocked(createConfiguredCatalogReader).mockResolvedValue(catalog as never);

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(createConfiguredCatalogReader).toHaveBeenCalledWith(request);
    expect(catalog.getPromotions).toHaveBeenCalledOnce();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(getPromotions).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(rows);
  });

  it('returns a safe 500 when a query fails without leaking schema details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createConfiguredCatalogReader).mockRejectedValue(
      new Error('Promotions storage has invalid schema detail'),
    );

    const response = await GET(new Request('http://localhost/api/promotions'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '행사 목록을 불러오지 못했습니다.' });
  });
});

describe('POST /api/promotions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
  });

  it('rejects unauthorized requests before parsing JSON or opening Sheets', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await POST(new Request('http://localhost/api/promotions', { method: 'POST', body: '{' }));

    expect(response.status).toBe(401);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(createPromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it.each([
    ['N_PLUS_ONE', { buyQuantity: 2, freeQuantity: 1 }],
    ['PROMOTIONAL_PRICE', { promotionalUnitPrice: 350 }],
    ['PERCENT_DISCOUNT', { percent: 12.5 }],
    ['FIXED_DISCOUNT', { discountAmount: 100 }],
  ] as const)('forwards the exact %s definition and returns the final joined promotion', async (type, rule) => {
    const payload = { promotionId: `PROMO-${type}`, ...common, type, ...rule, productIds: ['P2', 'P1'] };
    const definition = { promotionId: payload.promotionId, ...common, type, ...rule };
    const created = { ...definition, productIds: [] };
    const final = { ...definition, productIds: ['P1', 'P2'] };
    vi.mocked(createPromotion).mockResolvedValue(created as never);
    vi.mocked(replacePromotionProducts).mockResolvedValue(final as never);
    const request = new Request('http://localhost/api/promotions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(createPromotion).toHaveBeenCalledWith({}, definition);
    expect(replacePromotionProducts).toHaveBeenCalledWith({}, payload.promotionId, ['P2', 'P1']);
    await expect(response.json()).resolves.toEqual(final);
  });

  it('generates a stable prefixed server ID when promotionId is omitted', async () => {
    const payload = { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] };
    vi.mocked(createPromotion).mockImplementation(async (_store, definition) => ({ ...definition, productIds: [] }) as never);

    const response = await post(payload);

    expect(response.status).toBe(201);
    const definition = vi.mocked(createPromotion).mock.calls[0][1];
    expect(definition).toEqual({
      promotionId: expect.stringMatching(/^PROMO-[0-9a-f-]{36}$/),
      ...common,
      type: 'FIXED_DISCOUNT',
      discountAmount: 100,
    });
    expect(replacePromotionProducts).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ...definition, productIds: [] });
  });

  it.each([
    ['null', null],
    ['number', 123],
    ['blank', ''],
    ['whitespace', '   '],
  ])('rejects an explicit %s promotionId before creating a store', async (_label, promotionId) => {
    const response = await post({
      promotionId,
      ...common,
      type: 'FIXED_DISCOUNT',
      discountAmount: 100,
      productIds: [],
    });

    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(createPromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it.each([
    ['a number', ['P1', 123]],
    ['null', ['P1', null]],
    ['a blank ID', ['P1', '   ']],
    ['normalized duplicates', [' P1 ', 'P1']],
  ])('rejects productIds containing %s before creating a store', async (_label, productIds) => {
    const response = await post({
      ...common,
      type: 'FIXED_DISCOUNT',
      discountAmount: 100,
      productIds,
    });

    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(createPromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('trims explicit promotion and product IDs before commands run', async () => {
    const payload = {
      promotionId: ' PROMO-1 ',
      ...common,
      type: 'FIXED_DISCOUNT' as const,
      discountAmount: 100,
      productIds: [' P2 ', 'P1 '],
    };
    vi.mocked(createPromotion).mockResolvedValue({
      promotionId: 'PROMO-1',
      ...common,
      type: 'FIXED_DISCOUNT',
      discountAmount: 100,
      productIds: [],
    } as never);
    vi.mocked(replacePromotionProducts).mockResolvedValue({ promotionId: 'PROMO-1' } as never);

    const response = await post(payload);

    expect(response.status).toBe(201);
    expect(createPromotion).toHaveBeenCalledWith({}, {
      promotionId: 'PROMO-1',
      ...common,
      type: 'FIXED_DISCOUNT',
      discountAmount: 100,
    });
    expect(replacePromotionProducts).toHaveBeenCalledWith({}, 'PROMO-1', ['P2', 'P1']);
  });

  it.each([
    ['unknown key', { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [], surprise: true }],
    ['irrelevant rule key', { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, percent: 10, productIds: [] }],
    ['non-array targets', { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: 'P1' }],
    ['boolean string', { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [], isActive: 'false' }],
    ['array body', []],
  ])('rejects %s before creating a store', async (_label, payload) => {
    const response = await post(payload);

    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(createPromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it.each([
    ['sortOrder string', { ...common, sortOrder: '2', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
    ['rule numeric string', { ...common, type: 'FIXED_DISCOUNT', discountAmount: '100', productIds: [] }],
    ['blank name', { ...common, name: '   ', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
    ['invalid date', { ...common, startsAt: 'not-a-date', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
    ['invalid date range', { ...common, startsAt: '2026-10-01T00:00:00.000Z', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
  ])('rejects malformed or semantic %s before opening Sheets', async (_label, payload) => {
    const response = await post(payload);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '행사 요청 형식이 올바르지 않습니다.' });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(createPromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('returns a safe 500 when store creation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createConfiguredSheetsStore).mockRejectedValue(new Error('private provider credential'));

    const response = await post({ ...common, type: 'PERCENT_DISCOUNT', percent: 10, productIds: [] });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '행사를 추가하지 못했습니다.' });
    expect(createPromotion).not.toHaveBeenCalled();
  });

  it('returns a safe 500 and does not write targets after failed metadata creation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createPromotion).mockRejectedValue(new Error('provider secret detail'));

    const response = await post({ ...common, type: 'PERCENT_DISCOUNT', percent: 10, productIds: ['P1'] });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '행사를 추가하지 못했습니다.' });
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('warns that metadata may be saved when target replacement fails after create', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sequence: string[] = [];
    vi.mocked(createPromotion).mockImplementation(async (_store, definition) => {
      sequence.push('create');
      return { ...definition, productIds: [] } as never;
    });
    vi.mocked(replacePromotionProducts).mockImplementation(async () => {
      sequence.push('replace');
      throw new Error('provider target secret');
    });

    const response = await post({ ...common, type: 'PERCENT_DISCOUNT', percent: 10, productIds: ['P1'] });

    expect(sequence).toEqual(['create', 'replace']);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: '행사 정보는 저장되었을 수 있지만 대상 상품 저장에 실패했습니다. 새로고침 후 확인하고 다시 시도해 주세요.',
    });
  });
});
