import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredPromotionDeletion } from '@/server/repositories/configuredPromotionDeletion';
import {
  deletePromotion,
  PromotionDeletePartialFailure,
  replacePromotionProducts,
  setPromotionActive,
  updatePromotion,
} from '@/server/repositories/sheets/promotionCommands';
import { DELETE, PATCH } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(),
  unauthorizedAdminResponse: vi.fn(() => Response.json({ error: 'unauthorized' }, { status: 401 })),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/repositories/configuredPromotionDeletion', () => ({
  createConfiguredPromotionDeletion: vi.fn(),
}));
vi.mock('@/server/repositories/sheets/promotionCommands', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/repositories/sheets/promotionCommands')>(),
  deletePromotion: vi.fn(),
  replacePromotionProducts: vi.fn(),
  setPromotionActive: vi.fn(),
  updatePromotion: vi.fn(),
}));

const common = {
  name: '수정 행사',
  description: '수정 설명',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  isActive: true,
  sortOrder: 7,
};

function patch(body: unknown, promotionId = 'PROMO-1') {
  const request = new Request(`http://localhost/api/promotions/${promotionId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { request, response: PATCH(request, { params: Promise.resolve({ promotionId }) }) };
}

const DELETE_OPERATION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function remove(
  body: unknown = { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: 4 },
  promotionId = 'PROMO-1',
  contentType = 'application/json',
  params: Promise<{ promotionId: string }> = Promise.resolve({ promotionId }),
) {
  const request = new Request(`http://localhost/api/promotions/${promotionId}`, {
    method: 'DELETE',
    headers: contentType ? { 'content-type': contentType } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { request, response: DELETE(request, { params }) };
}

describe('PATCH /api/promotions/[promotionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
  });

  it('rejects unauthorized requests without opening Sheets or running commands', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const { response } = patch({ isActive: false });

    expect((await response).status).toBe(401);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(setPromotionActive).not.toHaveBeenCalled();
    expect(updatePromotion).not.toHaveBeenCalled();
  });

  it('accepts only activation state and returns the updated joined promotion', async () => {
    const saved = { promotionId: 'PROMO-1', isActive: false, productIds: ['P1'] };
    vi.mocked(setPromotionActive).mockResolvedValue(saved as never);
    const { request, response } = patch({ isActive: false });

    const result = await response;

    expect(result.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(setPromotionActive).toHaveBeenCalledWith({}, 'PROMO-1', false);
    expect(updatePromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
    await expect(result.json()).resolves.toEqual(saved);
  });

  it.each(['PROMO%2F1', '%25', '%'])(
    'passes the framework-decoded route ID %s to an activation command unchanged',
    async (promotionId) => {
      vi.mocked(setPromotionActive).mockResolvedValue({ promotionId, isActive: true } as never);
      const { response } = patch({ isActive: true }, promotionId);

      expect((await response).status).toBe(200);
      expect(setPromotionActive).toHaveBeenCalledWith({}, promotionId, true);
    },
  );

  it.each(['PROMO%2F1', '%25', '%'])(
    'passes the framework-decoded route ID %s to updatePromotion unchanged',
    async (promotionId) => {
      const definition = { ...common, type: 'FIXED_DISCOUNT' as const, discountAmount: 100 };
      vi.mocked(updatePromotion).mockResolvedValue({ promotionId, ...definition, productIds: ['P1'] } as never);

      const { response } = patch({ ...definition, productIds: ['P1'] }, promotionId);

      expect((await response).status).toBe(200);
      expect(updatePromotion).toHaveBeenCalledWith({}, promotionId, definition);
    },
  );

  it.each([
    ['N_PLUS_ONE', { buyQuantity: 2, freeQuantity: 1 }],
    ['PROMOTIONAL_PRICE', { promotionalUnitPrice: 350 }],
    ['PERCENT_DISCOUNT', { percent: 12.5 }],
    ['FIXED_DISCOUNT', { discountAmount: 100 }],
  ] as const)('forwards a full exact %s update, replaces targets, and returns the final join', async (type, rule) => {
    const payload = { ...common, type, ...rule, productIds: [] };
    const definition = { ...common, type, ...rule };
    vi.mocked(updatePromotion).mockResolvedValue({ promotionId: 'PROMO-1', ...definition, productIds: ['OLD'] } as never);
    vi.mocked(replacePromotionProducts).mockResolvedValue({ promotionId: 'PROMO-1', ...definition, productIds: [] } as never);
    const { request, response } = patch(payload);

    const result = await response;

    expect(result.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(updatePromotion).toHaveBeenCalledWith({}, 'PROMO-1', definition);
    expect(replacePromotionProducts).toHaveBeenCalledWith({}, 'PROMO-1', []);
    await expect(result.json()).resolves.toEqual({ promotionId: 'PROMO-1', ...definition, productIds: [] });
  });

  it('keeps the metadata result when the full update targets already match', async () => {
    const payload = { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: ['P1'] };
    const saved = { promotionId: 'PROMO-1', ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: ['P1'] };
    vi.mocked(updatePromotion).mockResolvedValue(saved as never);
    const { response } = patch(payload);

    const result = await response;

    expect(result.status).toBe(200);
    expect(replacePromotionProducts).not.toHaveBeenCalled();
    await expect(result.json()).resolves.toEqual(saved);
  });

  it.each([
    ['a number', ['P1', 123]],
    ['null', ['P1', null]],
    ['a blank ID', ['P1', '   ']],
    ['normalized duplicates', [' P1 ', 'P1']],
  ])('rejects full definition productIds containing %s before opening Sheets', async (_label, productIds) => {
    const { response } = patch({
      ...common,
      type: 'FIXED_DISCOUNT',
      discountAmount: 100,
      productIds,
    });

    expect((await response).status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(setPromotionActive).not.toHaveBeenCalled();
    expect(updatePromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('trims full definition product IDs before commands run', async () => {
    const definition = { ...common, type: 'FIXED_DISCOUNT' as const, discountAmount: 100 };
    vi.mocked(updatePromotion).mockResolvedValue({
      promotionId: 'PROMO-1',
      ...definition,
      productIds: [],
    } as never);
    vi.mocked(replacePromotionProducts).mockResolvedValue({ promotionId: 'PROMO-1' } as never);

    const { response } = patch({ ...definition, productIds: [' P2 ', 'P1 '] });

    expect((await response).status).toBe(200);
    expect(updatePromotion).toHaveBeenCalledWith({}, 'PROMO-1', definition);
    expect(replacePromotionProducts).toHaveBeenCalledWith({}, 'PROMO-1', ['P2', 'P1']);
  });

  it.each([
    ['partial definition', { name: 'partial' }],
    ['mixed activation and partial definition', { isActive: false, name: 'partial' }],
    ['unknown activation key', { isActive: false, unexpected: true }],
    ['promotionId in full update', { promotionId: 'OTHER', ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
    ['irrelevant type key', { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, percent: 10, productIds: [] }],
    ['non-array targets', { ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: null }],
    ['activation boolean string', { isActive: 'false' }],
  ])('rejects %s before opening Sheets', async (_label, body) => {
    const { response } = patch(body);

    expect((await response).status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(setPromotionActive).not.toHaveBeenCalled();
    expect(updatePromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it.each([
    ['sortOrder string', { ...common, sortOrder: '7', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
    ['rule numeric string', { ...common, type: 'FIXED_DISCOUNT', discountAmount: '100', productIds: [] }],
    ['blank name', { ...common, name: ' ', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
    ['invalid date', { ...common, startsAt: 'not-a-date', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
    ['invalid date range', { ...common, endsAt: '2026-07-01T00:00:00.000Z', type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: [] }],
  ])('rejects malformed or semantic %s before opening Sheets', async (_label, body) => {
    const { response } = patch(body);
    const result = await response;

    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({ error: '행사 요청 형식이 올바르지 않습니다.' });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updatePromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('returns a safe 500 when store creation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createConfiguredSheetsStore).mockRejectedValue(new Error('private provider credential'));
    const { response } = patch({ isActive: false });

    const result = await response;
    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({ error: '행사를 수정하지 못했습니다.' });
    expect(setPromotionActive).not.toHaveBeenCalled();
  });

  it('returns update command errors as a safe 500 without replacing targets', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(updatePromotion).mockRejectedValue(new Error('provider secret detail'));
    const { response } = patch({ ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: ['P1'] });

    const result = await response;
    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({ error: '행사를 수정하지 못했습니다.' });
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('warns that metadata may be saved when target replacement fails after update', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sequence: string[] = [];
    vi.mocked(updatePromotion).mockImplementation(async (_store, promotionId, definition) => {
      sequence.push('update');
      return { promotionId, ...definition, productIds: [] } as never;
    });
    vi.mocked(replacePromotionProducts).mockImplementation(async () => {
      sequence.push('replace');
      throw new Error('provider target secret');
    });

    const { response } = patch({ ...common, type: 'FIXED_DISCOUNT', discountAmount: 100, productIds: ['P1'] });
    const result = await response;

    expect(sequence).toEqual(['update', 'replace']);
    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({
      error: '행사 정보는 저장되었을 수 있지만 대상 상품 수정에 실패했습니다. 새로고침 후 확인하고 다시 시도해 주세요.',
    });
  });
});

describe('DELETE /api/promotions/[promotionId]', () => {
  const removeCommand = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredPromotionDeletion).mockResolvedValue({ delete: removeCommand });
  });

  it('rejects unauthorized requests before media type, JSON, params, or configured authority', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const then = vi.fn();
    const params = { then } as unknown as Promise<{ promotionId: string }>;

    const result = await remove('{', 'PROMO-1', 'text/plain', params).response;

    expect(result.status).toBe(401);
    expect(then).not.toHaveBeenCalled();
    expect(createConfiguredPromotionDeletion).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(deletePromotion).not.toHaveBeenCalled();
    expect(removeCommand).not.toHaveBeenCalled();
  });

  it('passes the exact Request and command input and projects only the deleted promotion ID', async () => {
    removeCommand.mockResolvedValue({ promotionId: 'PROMO-1', ignored: 'must not leak' });
    const { request, response } = remove();

    const result = await response;

    expect(result.status).toBe(200);
    expect(createConfiguredPromotionDeletion).toHaveBeenCalledWith(request);
    expect(removeCommand).toHaveBeenCalledWith({
      operationId: DELETE_OPERATION_ID,
      promotionId: 'PROMO-1',
      expectedPromotionVersion: 4,
    });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(deletePromotion).not.toHaveBeenCalled();
    await expect(result.json()).resolves.toEqual({ promotionId: 'PROMO-1' });
  });

  it.each(['PROMO%2F1', '%25', '%'])(
    'passes the framework-decoded route ID %s to the delete command unchanged',
    async (promotionId) => {
      removeCommand.mockResolvedValue({ promotionId });

      const result = await remove(undefined, promotionId).response;

      expect(result.status).toBe(200);
      expect(removeCommand).toHaveBeenCalledWith({
        operationId: DELETE_OPERATION_ID,
        promotionId,
        expectedPromotionVersion: 4,
      });
      await expect(result.json()).resolves.toEqual({ promotionId });
    },
  );

  it.each([
    'application/json',
    'Application/JSON',
    ' APPLICATION/JSON ; charset=utf-8',
  ])('accepts exact JSON media type token %s case-insensitively with parameters', async (contentType) => {
    removeCommand.mockResolvedValue({ promotionId: 'PROMO-1' });
    const result = await remove(undefined, 'PROMO-1', contentType).response;
    expect(result.status).toBe(200);
    expect(removeCommand).toHaveBeenCalledOnce();
  });

  it.each(['', 'application/jsonp', 'application/json-seq', 'text/json'])(
    'rejects non-JSON media type %s before JSON, params, or configured authority',
    async (contentType) => {
      const then = vi.fn();
      const params = { then } as unknown as Promise<{ promotionId: string }>;
      const result = await remove('{', 'PROMO-1', contentType, params).response;
      expect(result.status).toBe(400);
      await expect(result.json()).resolves.toEqual({ error: '행사 삭제 요청 형식이 올바르지 않습니다.' });
      expect(then).not.toHaveBeenCalled();
      expect(createConfiguredPromotionDeletion).not.toHaveBeenCalled();
      expect(removeCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['malformed JSON', '{'],
    ['null body', null],
    ['array body', []],
    ['primitive body', 4],
    ['extra key', { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: 4, extra: true }],
    ['missing operation ID', { expectedPromotionVersion: 4 }],
    ['missing version', { operationId: DELETE_OPERATION_ID }],
    ['boxed-looking operation ID', { operationId: {}, expectedPromotionVersion: 4 }],
    ['boxed-looking version', { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: {} }],
    ['wrong operation ID type', { operationId: 1, expectedPromotionVersion: 4 }],
    ['uppercase operation ID', { operationId: DELETE_OPERATION_ID.toUpperCase(), expectedPromotionVersion: 4 }],
    ['padded operation ID', { operationId: ` ${DELETE_OPERATION_ID}`, expectedPromotionVersion: 4 }],
    ['UUID version zero', { operationId: 'aaaaaaaa-1111-0111-8111-111111111111', expectedPromotionVersion: 4 }],
    ['invalid UUID variant', { operationId: 'aaaaaaaa-1111-4111-7111-111111111111', expectedPromotionVersion: 4 }],
    ['zero version', { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: 0 }],
    ['negative version', { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: -1 }],
    ['fractional version', { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: 1.5 }],
    ['string version', { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: '4' }],
    ['unsafe successor', { operationId: DELETE_OPERATION_ID, expectedPromotionVersion: Number.MAX_SAFE_INTEGER }],
  ])('rejects %s before params or configured authority', async (_label, body) => {
    const then = vi.fn();
    const params = { then } as unknown as Promise<{ promotionId: string }>;
    const result = await remove(body, 'PROMO-1', 'application/json', params).response;
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({ error: '행사 삭제 요청 형식이 올바르지 않습니다.' });
    expect(then).not.toHaveBeenCalled();
    expect(createConfiguredPromotionDeletion).not.toHaveBeenCalled();
    expect(removeCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['root resolution', 'root'],
    ['command', 'command'],
  ])('returns a generic safe 500 for %s errors', async (_label, failureAt) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    if (failureAt === 'root') {
      vi.mocked(createConfiguredPromotionDeletion).mockRejectedValue(new Error('private authority detail'));
    } else {
      removeCommand.mockRejectedValue(new Error('private command detail'));
    }

    const result = await remove().response;

    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({ error: '행사를 삭제하지 못했습니다.' });
  });

  it('returns the distinct safe partial-failure contract without provider details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    removeCommand.mockRejectedValue(new PromotionDeletePartialFailure());

    const result = await remove().response;

    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({
      error: '대상 상품 연결은 삭제되었지만 행사 삭제를 완료하지 못했습니다. 새로고침 후 재시도해 주세요.',
    });
  });
});
