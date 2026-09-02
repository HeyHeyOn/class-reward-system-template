import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredPromotionDeletion } from '@/server/repositories/configuredPromotionDeletion';
import {
  createConfiguredPromotionMutation,
  PromotionMutationTargetPartialFailure,
} from '@/server/repositories/configuredPromotionMutation';
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
vi.mock('@/server/repositories/configuredPromotionMutation', () => ({
  createConfiguredPromotionMutation: vi.fn(),
  PROMOTION_MUTATION_TARGET_PARTIAL_FAILURE_MESSAGE:
    '행사 정보는 저장되었을 수 있지만 대상 상품 수정에 실패했습니다. 새로고침 후 확인하고 다시 시도해 주세요.',
  PromotionMutationTargetPartialFailure: class PromotionMutationTargetPartialFailure extends Error {},
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

const PATCH_OPERATION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function patch(
  body: unknown = { operationId: PATCH_OPERATION_ID, expectedPromotionVersion: 4, isActive: false },
  promotionId = 'PROMO-1',
  contentType = 'application/json',
  params: Promise<{ promotionId: string }> = Promise.resolve({ promotionId }),
) {
  const request = new Request(`http://localhost/api/promotions/${promotionId}`, {
    method: 'PATCH',
    headers: contentType ? { 'content-type': contentType } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { request, response: PATCH(request, { params }) };
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
  const patchCommand = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredPromotionMutation).mockResolvedValue({ patch: patchCommand });
  });

  it('rejects unauthorized requests before media type, JSON, params, or configured authority', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const then = vi.fn();
    const params = { then } as unknown as Promise<{ promotionId: string }>;
    const result = await patch('{', 'PROMO-1', 'text/plain', params).response;

    expect(result.status).toBe(401);
    expect(then).not.toHaveBeenCalled();
    expect(createConfiguredPromotionMutation).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(setPromotionActive).not.toHaveBeenCalled();
    expect(updatePromotion).not.toHaveBeenCalled();
  });

  it.each(['application/json', 'Application/JSON', ' APPLICATION/JSON ; charset=utf-8'])(
    'accepts exact JSON media type token %s case-insensitively with parameters', async (contentType) => {
      patchCommand.mockResolvedValue({
        promotionId: 'PROMO-1',
        mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 },
      });
      expect((await patch(undefined, 'PROMO-1', contentType).response).status).toBe(200);
    },
  );

  it.each(['', 'application/jsonp', 'application/json-seq', 'text/json'])(
    'rejects non-JSON media type %s before JSON, params, or configured authority', async (contentType) => {
      const then = vi.fn();
      const params = { then } as unknown as Promise<{ promotionId: string }>;
      const result = await patch('{', 'PROMO-1', contentType, params).response;
      expect(result.status).toBe(400);
      await expect(result.json()).resolves.toEqual({ error: '행사 요청 형식이 올바르지 않습니다.' });
      expect(then).not.toHaveBeenCalled();
      expect(createConfiguredPromotionMutation).not.toHaveBeenCalled();
    },
  );

  it('passes the exact Request and activation input and returns only the configured acknowledgement', async () => {
    const acknowledgement = {
      promotionId: 'PROMO-1',
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 },
    };
    patchCommand.mockResolvedValue(acknowledgement);
    const { request, response } = patch();

    const result = await response;
    expect(result.status).toBe(200);
    expect(createConfiguredPromotionMutation).toHaveBeenCalledWith(request);
    expect(patchCommand).toHaveBeenCalledWith({
      kind: 'activation', operationId: PATCH_OPERATION_ID, promotionId: 'PROMO-1',
      expectedPromotionVersion: 4, isActive: false,
    });
    await expect(result.json()).resolves.toEqual({
      promotionId: 'PROMO-1',
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 },
    });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(setPromotionActive).not.toHaveBeenCalled();
  });

  it.each(['PROMO%2F1', '%25', '%'])(
    'passes framework-decoded route ID %s unchanged',
    async (promotionId) => {
      patchCommand.mockResolvedValue({ promotionId, mutationPrecondition: { promotionId, expectedVersion: 5 } });
      const { response } = patch(undefined, promotionId);
      expect((await response).status).toBe(200);
      expect(patchCommand).toHaveBeenCalledWith(expect.objectContaining({ promotionId }));
    },
  );

  it('passes the exact definition input to the configured root', async () => {
    const definition = { ...common, type: 'FIXED_DISCOUNT' as const, discountAmount: 100 };
    patchCommand.mockResolvedValue({
      promotionId: 'PROMO-1',
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 },
    });
    const { response } = patch({
      operationId: PATCH_OPERATION_ID, expectedPromotionVersion: 4,
      ...definition, productIds: [' P2 ', 'P1 '],
    });
    expect((await response).status).toBe(200);
    expect(patchCommand).toHaveBeenCalledWith({
      kind: 'definition', operationId: PATCH_OPERATION_ID, promotionId: 'PROMO-1',
      expectedPromotionVersion: 4, definition, productIds: ['P2', 'P1'],
    });
    expect(updatePromotion).not.toHaveBeenCalled();
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['old activation shape', { isActive: false }],
    ['extra activation key', { operationId: PATCH_OPERATION_ID, expectedPromotionVersion: 4, isActive: false, extra: true }],
    ['invalid operation ID', { operationId: 'not-a-uuid', expectedPromotionVersion: 4, isActive: false }],
    ['unsafe successor', { operationId: PATCH_OPERATION_ID, expectedPromotionVersion: Number.MAX_SAFE_INTEGER, isActive: false }],
    ['partial definition', { operationId: PATCH_OPERATION_ID, expectedPromotionVersion: 4, name: 'partial' }],
  ])('rejects %s before params or configured authority', async (_label, body) => {
    const then = vi.fn();
    const params = { then } as unknown as Promise<{ promotionId: string }>;
    const result = await patch(body, 'PROMO-1', 'application/json', params).response;
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({ error: '행사 요청 형식이 올바르지 않습니다.' });
    expect(then).not.toHaveBeenCalled();
    expect(createConfiguredPromotionMutation).not.toHaveBeenCalled();
  });

  it('accepts the Sheets synthetic precondition instead of assuming a PostgreSQL increment', async () => {
    patchCommand.mockResolvedValue({
      promotionId: 'PROMO-1',
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 1 },
    });

    const result = await patch({
      operationId: PATCH_OPERATION_ID,
      expectedPromotionVersion: 1,
      isActive: false,
    }).response;

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      promotionId: 'PROMO-1',
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 1 },
    });
  });

  it('rejects accessor-backed configured acknowledgements without invoking hooks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = vi.fn(() => { throw new Error('hook invoked'); });
    const acknowledgement = {
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 },
    };
    Object.defineProperty(acknowledgement, 'promotionId', { enumerable: true, get: hook });
    patchCommand.mockResolvedValue(acknowledgement);

    const result = await patch().response;

    expect(result.status).toBe(500);
    expect(hook).not.toHaveBeenCalled();
    await expect(result.json()).resolves.toEqual({ error: '행사를 수정하지 못했습니다.' });
  });

  it('rejects decorated configured acknowledgements', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    patchCommand.mockResolvedValue({
      promotionId: 'PROMO-1',
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 },
      extra: true,
    });

    const result = await patch().response;

    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({ error: '행사를 수정하지 못했습니다.' });
  });

  it.each(['root', 'command', 'result'])(
    'returns a generic safe 500 for %s failures', async (failureAt) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    if (failureAt === 'root') vi.mocked(createConfiguredPromotionMutation).mockRejectedValue(new Error('secret'));
    else if (failureAt === 'command') patchCommand.mockRejectedValue(new Error('secret'));
    else patchCommand.mockResolvedValue({ promotionId: 'OTHER', mutationPrecondition: { promotionId: 'OTHER', expectedVersion: 5 } });
    const result = await patch().response;
    expect(result.status).toBe(500);
    await expect(result.json()).resolves.toEqual({ error: '행사를 수정하지 못했습니다.' });
  });

  it('maps only the typed target partial failure to the existing Korean warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    patchCommand.mockRejectedValue(new PromotionMutationTargetPartialFailure());
    const result = await patch().response;
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
