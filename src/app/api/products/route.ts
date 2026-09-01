import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredCatalogReader } from '@/server/repositories/configuredCatalog';
import {
  createConfiguredProductCreation,
  type ConfiguredProductCreationInput,
} from '@/server/repositories/configuredProductCreation';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get('includeInactive') === '1';
    const catalog = await createConfiguredCatalogReader();
    const products = includeInactive
      ? await catalog.getProducts()
      : await catalog.getActiveProducts();

    return Response.json(products);
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품 목록을 불러오지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUIRED_CREATE_KEYS = [
  'isActive', 'name', 'operationId', 'price', 'productId', 'sortOrder', 'stock',
] as const;
const OPTIONAL_CREATE_KEYS = ['category', 'imageUrl'] as const;
const CREATE_KEYS = new Set<string>([...REQUIRED_CREATE_KEYS, ...OPTIONAL_CREATE_KEYS]);
const CREATE_ERROR = '상품을 추가하지 못했습니다.';

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const payload = await parseProductCreationBody(request);
  if (!payload) return Response.json({ error: CREATE_ERROR }, { status: 400 });

  try {
    const command = await createConfiguredProductCreation(request);
    const product = await command.create(payload);
    return Response.json(product, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : CREATE_ERROR;
    return Response.json({ error: message }, { status: 400 });
  }
}

async function parseProductCreationBody(
  request: Request,
): Promise<ConfiguredProductCreationInput | null> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return null;
  }
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => !CREATE_KEYS.has(key))
      || REQUIRED_CREATE_KEYS.some((key) => !Object.hasOwn(record, key))
      || typeof record.operationId !== 'string'
      || !CANONICAL_UUID.test(record.operationId)
      || typeof record.productId !== 'string'
      || !record.productId.trim()
      || typeof record.name !== 'string'
      || !record.name.trim()
      || !Number.isSafeInteger(record.price)
      || (record.price as number) < 0
      || !Number.isSafeInteger(record.stock)
      || (record.stock as number) < 0
      || typeof record.isActive !== 'boolean'
      || !Number.isInteger(record.sortOrder)
      || (record.sortOrder as number) < -2147483648
      || (record.sortOrder as number) > 2147483647
      || (Object.hasOwn(record, 'imageUrl') && typeof record.imageUrl !== 'string')
      || (Object.hasOwn(record, 'category') && typeof record.category !== 'string')) {
      return null;
    }
    return record as ConfiguredProductCreationInput;
  } catch {
    return null;
  }
}
