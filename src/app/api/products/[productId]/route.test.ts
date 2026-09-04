import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredProductDeletion } from '@/server/repositories/configuredProductDeletion';
import { deleteProduct } from '@/server/sheetsRepository';
import { DELETE } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(),
  unauthorizedAdminResponse: vi.fn(() => Response.json({ error: 'unauthorized' }, { status: 401 })),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/repositories/configuredProductDeletion', () => ({
  createConfiguredProductDeletion: vi.fn(),
}));
vi.mock('@/server/sheetsRepository', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/sheetsRepository')>(),
  deleteProduct: vi.fn(),
}));

const OPERATION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function productDeleteRequest(
  body: unknown = { operationId: OPERATION_ID, expectedProductVersion: 4 },
  productId = 'P-1',
  contentType = 'application/json',
): Request {
  return new Request(`http://localhost/api/products/${productId}`, {
    method: 'DELETE',
    headers: contentType ? { 'content-type': contentType } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function remove(
  body: unknown = { operationId: OPERATION_ID, expectedProductVersion: 4 },
  productId = 'P-1',
  contentType = 'application/json',
  params: Promise<{ productId: string }> = Promise.resolve({ productId }),
) {
  const request = productDeleteRequest(body, productId, contentType);
  return { request, response: DELETE(request, { params }) };
}

describe('DELETE /api/products/[productId]', () => {
  const removeCommand = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredProductDeletion).mockResolvedValue({ delete: removeCommand });
  });

  it('authenticates before hostile headers, body, params, or configured authority', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const hostile = vi.fn(() => { throw new Error('must not inspect'); });
    const request = Object.create(null) as Request;
    Object.defineProperties(request, {
      headers: { get: hostile },
      json: { get: hostile },
    });
    const then = vi.fn();
    const params = { then } as unknown as Promise<{ productId: string }>;

    const result = await DELETE(request, { params });

    expect(result.status).toBe(401);
    expect(hostile).not.toHaveBeenCalled();
    expect(then).not.toHaveBeenCalled();
    expect(createConfiguredProductDeletion).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(deleteProduct).not.toHaveBeenCalled();
    expect(removeCommand).not.toHaveBeenCalled();
  });

  it.each(['application/json', 'Application/JSON', ' APPLICATION/JSON ; charset=utf-8'])(
    'accepts exact JSON media token %s case-insensitively with parameters', async (contentType) => {
      removeCommand.mockResolvedValue({ productId: 'P-1' });
      expect((await remove(undefined, 'P-1', contentType).response).status).toBe(200);
    },
  );

  it.each(['', 'application/jsonp', 'application/json-seq', 'text/json'])(
    'rejects non-JSON media type %s before body, params, or configured authority', async (contentType) => {
      const then = vi.fn();
      const params = { then } as unknown as Promise<{ productId: string }>;
      const request = productDeleteRequest(undefined, 'P-1', contentType);
      const json = vi.spyOn(request, 'json');

      const result = await DELETE(request, { params });

      expect(result.status).toBe(400);
      await expect(result.json()).resolves.toEqual({ error: '상품 삭제 요청 형식이 올바르지 않습니다.' });
      expect(json).not.toHaveBeenCalled();
      expect(then).not.toHaveBeenCalled();
      expect(createConfiguredProductDeletion).not.toHaveBeenCalled();
    },
  );

  it('passes the exact Request and unchanged framework product ID and returns a fresh exact projection', async () => {
    removeCommand.mockResolvedValue({ productId: 'P%2F1' });
    const { request, response } = remove(undefined, 'P%2F1');

    const result = await response;

    expect(result.status).toBe(200);
    expect(createConfiguredProductDeletion).toHaveBeenCalledWith(request);
    expect(removeCommand).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      productId: 'P%2F1',
      expectedProductVersion: 4,
    });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(deleteProduct).not.toHaveBeenCalled();
    await expect(result.json()).resolves.toEqual({ productId: 'P%2F1' });
  });

  it.each(['P%2F1', '%25', '%'])(
    'passes framework product ID %s unchanged', async (productId) => {
      removeCommand.mockResolvedValue({ productId });
      const result = await remove(undefined, productId).response;
      expect(result.status).toBe(200);
      expect(removeCommand).toHaveBeenCalledWith(expect.objectContaining({ productId }));
    },
  );

  it.each([
    ['malformed JSON', '{'],
    ['null body', null],
    ['array body', []],
    ['primitive body', 4],
    ['extra key', { operationId: OPERATION_ID, expectedProductVersion: 4, extra: true }],
    ['missing operation ID', { expectedProductVersion: 4 }],
    ['missing version', { operationId: OPERATION_ID }],
    ['boxed operation ID', { operationId: {}, expectedProductVersion: 4 }],
    ['boxed version', { operationId: OPERATION_ID, expectedProductVersion: {} }],
    ['uppercase operation ID', { operationId: OPERATION_ID.toUpperCase(), expectedProductVersion: 4 }],
    ['padded operation ID', { operationId: ` ${OPERATION_ID}`, expectedProductVersion: 4 }],
    ['UUID version zero', { operationId: 'aaaaaaaa-1111-0111-8111-111111111111', expectedProductVersion: 4 }],
    ['UUID version six', { operationId: 'aaaaaaaa-1111-6111-8111-111111111111', expectedProductVersion: 4 }],
    ['invalid UUID variant', { operationId: 'aaaaaaaa-1111-4111-7111-111111111111', expectedProductVersion: 4 }],
    ['zero version', { operationId: OPERATION_ID, expectedProductVersion: 0 }],
    ['negative version', { operationId: OPERATION_ID, expectedProductVersion: -1 }],
    ['fractional version', { operationId: OPERATION_ID, expectedProductVersion: 1.5 }],
    ['string version', { operationId: OPERATION_ID, expectedProductVersion: '4' }],
    ['unsafe successor', { operationId: OPERATION_ID, expectedProductVersion: Number.MAX_SAFE_INTEGER }],
  ])('rejects %s before params or configured authority', async (_label, body) => {
    const then = vi.fn();
    const params = { then } as unknown as Promise<{ productId: string }>;
    const result = await remove(body, 'P-1', 'application/json', params).response;
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({ error: '상품 삭제 요청 형식이 올바르지 않습니다.' });
    expect(then).not.toHaveBeenCalled();
    expect(createConfiguredProductDeletion).not.toHaveBeenCalled();
    expect(removeCommand).not.toHaveBeenCalled();
  });

  it('rejects accessor, symbol, custom-prototype, and nonordinary descriptors before params or authority without hooks', async () => {
    const hook = vi.fn(() => { throw new Error('hook invoked'); });
    const getter = { expectedProductVersion: 4 } as Record<string, unknown>;
    Object.defineProperty(getter, 'operationId', { enumerable: true, get: hook });
    const symbol = { operationId: OPERATION_ID, expectedProductVersion: 4 } as Record<PropertyKey, unknown>;
    symbol[Symbol('extra')] = true;
    const custom = Object.assign(Object.create({}), { operationId: OPERATION_ID, expectedProductVersion: 4 });
    const readonly = { operationId: OPERATION_ID, expectedProductVersion: 4 };
    Object.defineProperty(readonly, 'operationId', { value: OPERATION_ID, enumerable: true, writable: false, configurable: true });
    for (const candidate of [getter, symbol, custom, readonly]) {
      const then = vi.fn();
      const params = { then } as unknown as Promise<{ productId: string }>;
      const request = productDeleteRequest();
      vi.spyOn(request, 'json').mockResolvedValue(candidate);
      const result = await DELETE(request, { params });
      expect(result.status).toBe(400);
      expect(then).not.toHaveBeenCalled();
      expect(createConfiguredProductDeletion).not.toHaveBeenCalled();
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('treats any JSON read failure as a generic malformed request before params or authority', async () => {
    const then = vi.fn();
    const params = { then } as unknown as Promise<{ productId: string }>;
    const request = productDeleteRequest();
    vi.spyOn(request, 'json').mockRejectedValue(new Error('private body failure'));

    const result = await DELETE(request, { params });

    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toEqual({ error: '상품 삭제 요청 형식이 올바르지 않습니다.' });
    expect(then).not.toHaveBeenCalled();
    expect(createConfiguredProductDeletion).not.toHaveBeenCalled();
  });

  it.each(['params', 'root', 'command', 'result'])(
    'returns the same generic safe 500 for %s failure without leaking details', async (failureAt) => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let params = Promise.resolve({ productId: 'P-1' });
      if (failureAt === 'params') params = Promise.reject(new Error('private params detail'));
      else if (failureAt === 'root') vi.mocked(createConfiguredProductDeletion).mockRejectedValue(new Error('private root detail'));
      else if (failureAt === 'command') removeCommand.mockRejectedValue(new Error('private command detail'));
      else removeCommand.mockResolvedValue({ productId: 'OTHER' });

      const result = await remove(undefined, 'P-1', 'application/json', params).response;

      expect(result.status).toBe(500);
      await expect(result.json()).resolves.toEqual({ error: '상품을 삭제하지 못했습니다.' });
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it('rejects decorated or accessor-backed command results without invoking hooks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = vi.fn(() => { throw new Error('hook invoked'); });
    const accessor = {};
    Object.defineProperty(accessor, 'productId', { enumerable: true, get: hook });
    for (const commandResult of [accessor, { productId: 'P-1', extra: true }]) {
      removeCommand.mockResolvedValueOnce(commandResult);
      const result = await remove().response;
      expect(result.status).toBe(500);
      await expect(result.json()).resolves.toEqual({ error: '상품을 삭제하지 못했습니다.' });
    }
    expect(hook).not.toHaveBeenCalled();
  });
});
