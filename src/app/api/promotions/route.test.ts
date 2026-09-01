import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredCatalogReader } from '@/server/repositories/configuredCatalog';
import {
  PromotionCreationTargetPartialFailure,
  createConfiguredPromotionCreation,
} from '@/server/repositories/configuredPromotionCreation';
import { getPromotions } from '@/server/repositories/sheets/promotionQueries';
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
vi.mock('@/server/repositories/configuredPromotionCreation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/repositories/configuredPromotionCreation')>(),
  createConfiguredPromotionCreation: vi.fn(),
}));

const OPERATION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const common = {
  name: '행사',
  description: '설명',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  isActive: true,
  sortOrder: 2,
};

function request(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/promotions', {
    method: 'POST',
    headers: contentType ? { 'content-type': contentType } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION_ID,
    ...common,
    type: 'FIXED_DISCOUNT' as const,
    discountAmount: 100,
    productIds: [],
    ...overrides,
  };
}

function bodyWithoutOperationId() {
  return Object.fromEntries(Object.entries(validBody()).filter(([key]) => key !== 'operationId'));
}

describe('GET /api/promotions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('rejects unauthorized requests without resolving a catalog', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await GET(new Request('http://localhost/api/promotions'));

    expect(response.status).toBe(401);
    expect(unauthorizedAdminResponse).toHaveBeenCalledOnce();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(getPromotions).not.toHaveBeenCalled();
    expect(createConfiguredCatalogReader).not.toHaveBeenCalled();
  });

  it('uses the configured catalog and returns every deterministic joined row', async () => {
    const exactRequest = new Request('http://localhost/api/promotions');
    const rows = [
      { promotionId: 'P1', isActive: false, productIds: ['B', 'A'] },
      { promotionId: 'P2', isActive: true, productIds: [] },
    ];
    const catalog = { getPromotions: vi.fn(async () => rows) };
    vi.mocked(createConfiguredCatalogReader).mockResolvedValue(catalog as never);

    const response = await GET(exactRequest);

    expect(response.status).toBe(200);
    expect(createConfiguredCatalogReader).toHaveBeenCalledWith(exactRequest);
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
  const create = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredPromotionCreation).mockResolvedValue({ create });
  });

  it('rejects unauthorized requests before media-type checks, JSON parsing, or configured root resolution', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);

    const response = await POST(request('{', 'text/plain'));

    expect(response.status).toBe(401);
    expect(createConfiguredPromotionCreation).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it.each([
    ['N_PLUS_ONE', { buyQuantity: 2, freeQuantity: 1 }],
    ['PROMOTIONAL_PRICE', { promotionalUnitPrice: 350 }],
    ['PERCENT_DISCOUNT', { percent: 12.5 }],
    ['FIXED_DISCOUNT', { discountAmount: 100 }],
  ] as const)('forwards exact %s configured input and returns the full legacy promotion', async (type, rule) => {
    const body = {
      operationId: OPERATION_ID,
      promotionId: `PROMO-${type}`,
      ...common,
      type,
      ...rule,
      productIds: ['P2', 'P1'],
    };
    const definition = { ...common, type, ...rule };
    const final = {
      promotionId: body.promotionId,
      ...definition,
      productIds: ['P1', 'P2'],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      schemaVersion: 3,
    };
    create.mockResolvedValue(final);
    const exactRequest = request(body, 'application/json; charset=utf-8');

    const response = await POST(exactRequest);

    expect(response.status).toBe(201);
    expect(createConfiguredPromotionCreation).toHaveBeenCalledWith(exactRequest);
    expect(create).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      promotionId: body.promotionId,
      definition,
      productIds: ['P2', 'P1'],
    });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(final);
  });

  it('generates only the fallback promotion ID server-side when it is omitted', async () => {
    create.mockImplementation(async (input) => ({
      promotionId: input.promotionId,
      ...input.definition,
      productIds: input.productIds,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      schemaVersion: 3,
    }));

    const response = await POST(request(validBody()));

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      promotionId: `PROMO-${OPERATION_ID}`,
      definition: { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100 },
      productIds: [],
    });
  });

  it('keeps a generated fallback promotion ID stable for operation retries', async () => {
    create.mockImplementation(async (input) => ({
      promotionId: input.promotionId,
      ...input.definition,
      productIds: input.productIds,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      schemaVersion: 3,
    }));

    await POST(request(validBody()));
    await POST(request(validBody()));

    const firstId = create.mock.calls[0][0].promotionId;
    const secondId = create.mock.calls[1][0].promotionId;
    expect(secondId).toBe(firstId);
  });

  it.each([
    ['missing media type', validBody(), ''],
    ['wrong media type', validBody(), 'text/json'],
    ['lookalike media type', validBody(), 'application/json-patch+json'],
    ['malformed JSON', '{', 'application/json'],
    ['missing operationId', bodyWithoutOperationId(), 'application/json'],
    ['uppercase operationId', validBody({ operationId: OPERATION_ID.toUpperCase() }), 'application/json'],
    ['noncanonical operationId', validBody({ operationId: '11111111-1111-0111-8111-111111111111' }), 'application/json'],
    ['unknown key', validBody({ surprise: true }), 'application/json'],
    ['irrelevant rule key', validBody({ percent: 10 }), 'application/json'],
    ['non-array targets', validBody({ productIds: 'P1' }), 'application/json'],
    ['boolean string', validBody({ isActive: 'false' }), 'application/json'],
    ['array body', [], 'application/json'],
    ['sortOrder string', validBody({ sortOrder: '2' }), 'application/json'],
    ['rule numeric string', validBody({ discountAmount: '100' }), 'application/json'],
    ['blank name', validBody({ name: '   ' }), 'application/json'],
    ['invalid date', validBody({ startsAt: 'not-a-date' }), 'application/json'],
    ['invalid date range', validBody({ startsAt: '2026-10-01T00:00:00.000Z' }), 'application/json'],
    ['explicit null promotionId', validBody({ promotionId: null }), 'application/json'],
    ['normalized duplicate targets', validBody({ productIds: [' P1 ', 'P1'] }), 'application/json'],
  ])('returns exact safe 400 for %s before resolving configured authority', async (_label, body, contentType) => {
    const response = await POST(request(body, contentType));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '행사 요청 형식이 올바르지 않습니다.' });
    expect(createConfiguredPromotionCreation).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('trims explicit promotion and product IDs before the command runs', async () => {
    create.mockResolvedValue({ promotionId: 'PROMO-1' });

    const response = await POST(request(validBody({
      promotionId: ' PROMO-1 ',
      productIds: [' P2 ', 'P1 '],
    })));

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      promotionId: 'PROMO-1',
      definition: { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100 },
      productIds: ['P2', 'P1'],
    });
  });

  it('maps only the typed target partial failure to the existing exact warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    create.mockRejectedValue(new PromotionCreationTargetPartialFailure({ cause: new Error('secret') }));

    const response = await POST(request(validBody()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: '행사 정보는 저장되었을 수 있지만 대상 상품 저장에 실패했습니다. 새로고침 후 확인하고 다시 시도해 주세요.',
    });
  });

  it.each([
    ['root resolution', 'root'],
    ['command or domain', 'command'],
  ])('maps %s errors to generic safe 500 without details', async (_label, failureAt) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    if (failureAt === 'root') {
      vi.mocked(createConfiguredPromotionCreation).mockRejectedValue(new Error('private root detail'));
    } else {
      create.mockRejectedValue(new Error('private command detail'));
    }

    const response = await POST(request(validBody()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '행사를 추가하지 못했습니다.' });
  });
});
