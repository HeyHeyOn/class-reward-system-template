import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConfiguredCatalogReader: vi.fn(),
  createConfiguredProductCreation: vi.fn(),
  createConfiguredSheetsReader: vi.fn(),
  createConfiguredSheetsStore: vi.fn(),
  getProducts: vi.fn(),
  getActiveProducts: vi.fn(),
  createProduct: vi.fn(),
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: vi.fn(() => Response.json(
    { error: '관리자 로그인이 필요합니다.' }, { status: 401 },
  )),
}));

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: mocks.isAuthorizedAdminRequest,
  unauthorizedAdminResponse: mocks.unauthorizedAdminResponse,
}));
vi.mock('@/server/repositories/configuredCatalog', () => ({
  createConfiguredCatalogReader: mocks.createConfiguredCatalogReader,
}));
vi.mock('@/server/repositories/configuredProductCreation', () => ({
  createConfiguredProductCreation: mocks.createConfiguredProductCreation,
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsReader: mocks.createConfiguredSheetsReader,
  createConfiguredSheetsStore: mocks.createConfiguredSheetsStore,
}));
vi.mock('@/server/sheetsRepository', () => ({
  getProducts: mocks.getProducts,
  getActiveProducts: mocks.getActiveProducts,
  createProduct: mocks.createProduct,
}));

import { GET, POST } from '@/app/api/products/route';

const allProducts = [{
  productId: 'P001', name: '연필', price: 100, stock: 5, isActive: false, sortOrder: 1,
}];
const activeProducts = [{
  productId: 'P002', name: '지우개', price: 200, stock: 3, isActive: true, sortOrder: 2,
}];

describe('products GET catalog authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['0', 'getActiveProducts', activeProducts],
    ['1', 'getProducts', allProducts],
  ] as const)('delegates includeInactive=%s to the active catalog adapter', async (
    includeInactive,
    selectedMethod,
    expected,
  ) => {
    const catalog = {
      getProducts: vi.fn(async () => allProducts),
      getActiveProducts: vi.fn(async () => activeProducts),
    };
    mocks.createConfiguredCatalogReader.mockResolvedValueOnce(catalog);

    const response = await GET(new Request(
      `https://example.test/api/products?includeInactive=${includeInactive}`,
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(catalog[selectedMethod]).toHaveBeenCalledOnce();
    expect(catalog[selectedMethod === 'getProducts' ? 'getActiveProducts' : 'getProducts'])
      .not.toHaveBeenCalled();
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(mocks.getProducts).not.toHaveBeenCalled();
    expect(mocks.getActiveProducts).not.toHaveBeenCalled();
  });

  it('preserves the existing GET error projection', async () => {
    mocks.createConfiguredCatalogReader.mockRejectedValueOnce(new Error('catalog unavailable'));

    const response = await GET(new Request('https://example.test/api/products'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'catalog unavailable' });
    expect(mocks.createConfiguredSheetsReader).not.toHaveBeenCalled();
  });
});

const validCreateBody = {
  operationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  productId: ' P003 ',
  name: ' 간식 쿠폰 ',
  price: 1000,
  stock: 5,
  isActive: true,
  imageUrl: '',
  category: '쿠폰',
  sortOrder: -1,
};

function productPost(body: unknown, contentType = 'application/json') {
  return new Request('https://example.test/api/products', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function withoutCreateFields(...fields: string[]) {
  return Object.fromEntries(Object.entries(validCreateBody).filter(([key]) => !fields.includes(key)));
}

describe('products POST configured mutation authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorizedAdminRequest.mockReturnValue(true);
  });

  it('authenticates first and does not inspect an unauthorized body or resolve authority', async () => {
    mocks.isAuthorizedAdminRequest.mockReturnValueOnce(false);
    const request = productPost('{');

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: '관리자 로그인이 필요합니다.' });
    expect(mocks.unauthorizedAdminResponse).toHaveBeenCalledOnce();
    expect(mocks.createConfiguredProductCreation).not.toHaveBeenCalled();
  });

  it('validates the exact body, passes it unchanged with the same Request, and returns legacy output', async () => {
    const created = {
      productId: 'P003', name: '간식 쿠폰', price: 1000, stock: 5,
      isActive: true, category: '쿠폰', sortOrder: -1,
    };
    const create = vi.fn(async () => created);
    mocks.createConfiguredProductCreation.mockResolvedValueOnce({ create });
    const request = productPost(validCreateBody, 'application/json; charset=utf-8');

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(mocks.createConfiguredProductCreation).toHaveBeenCalledWith(request);
    expect(create).toHaveBeenCalledWith(validCreateBody);
    expect(mocks.createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(mocks.createProduct).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong content type', validCreateBody, 'text/plain'],
    ['JSONP content type', validCreateBody, 'application/jsonp'],
    ['JSON sequence content type', validCreateBody, 'application/json-seq'],
    ['malformed JSON', '{', 'application/json'],
    ['array body', [], 'application/json'],
    ['unknown key', { ...validCreateBody, extra: true }, 'application/json'],
    ['missing key', withoutCreateFields('stock'), 'application/json'],
    ['uppercase operation UUID', { ...validCreateBody, operationId: validCreateBody.operationId.toUpperCase() }, 'application/json'],
    ['noncanonical operation UUID', { ...validCreateBody, operationId: '11111111-1111-0111-8111-111111111111' }, 'application/json'],
    ['blank product ID', { ...validCreateBody, productId: '  ' }, 'application/json'],
    ['blank name', { ...validCreateBody, name: '\t' }, 'application/json'],
    ['coerced price', { ...validCreateBody, price: '1000' }, 'application/json'],
    ['negative price', { ...validCreateBody, price: -1 }, 'application/json'],
    ['unsafe stock', { ...validCreateBody, stock: Number.MAX_SAFE_INTEGER + 1 }, 'application/json'],
    ['coerced active flag', { ...validCreateBody, isActive: 1 }, 'application/json'],
    ['fractional sort order', { ...validCreateBody, sortOrder: 1.5 }, 'application/json'],
    ['sort order below int32', { ...validCreateBody, sortOrder: -2147483649 }, 'application/json'],
    ['non-string optional image', { ...validCreateBody, imageUrl: null }, 'application/json'],
    ['non-string optional category', { ...validCreateBody, category: 7 }, 'application/json'],
  ])('rejects %s before resolving the configured root', async (_label, body, contentType) => {
    const response = await POST(productPost(body, contentType));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '상품을 추가하지 못했습니다.' });
    expect(mocks.createConfiguredProductCreation).not.toHaveBeenCalled();
  });

  it('accepts absent optional text and signed int32 boundaries', async () => {
    const required = withoutCreateFields('imageUrl', 'category');
    const create = vi.fn(async (input) => input);
    mocks.createConfiguredProductCreation.mockResolvedValue({ create });

    for (const sortOrder of [-2147483648, 2147483647]) {
      const body = { ...required, sortOrder };
      const response = await POST(productPost(body));
      expect(response.status).toBe(201);
      expect(create).toHaveBeenCalledWith(body);
    }
  });

  it('preserves Error messages and the non-Error generic fallback as 400 responses', async () => {
    mocks.createConfiguredProductCreation
      .mockRejectedValueOnce(new Error('configured unavailable'))
      .mockRejectedValueOnce('non-error');

    const configuredError = await POST(productPost(validCreateBody));
    const fallbackError = await POST(productPost(validCreateBody));

    expect(configuredError.status).toBe(400);
    expect(await configuredError.json()).toEqual({ error: 'configured unavailable' });
    expect(fallbackError.status).toBe(400);
    expect(await fallbackError.json()).toEqual({ error: '상품을 추가하지 못했습니다.' });
  });
});
