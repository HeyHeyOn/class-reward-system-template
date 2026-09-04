import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredProductDeletion } from '@/server/repositories/configuredProductDeletion';
import { updateProductDetails } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ productId: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { productId } = await context.params;
    const store = await createConfiguredSheetsStore();
    const payload = await request.json();
    const product = await updateProductDetails(store, decodeURIComponent(productId), {
      name: String(payload.name ?? ''),
      price: Number(payload.price),
      stock: Number(payload.stock),
      isActive: Boolean(payload.isActive),
      imageUrl: payload.imageUrl ? String(payload.imageUrl) : undefined,
      category: payload.category ? String(payload.category) : undefined,
      sortOrder: Number(payload.sortOrder),
    });

    return Response.json(product);
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품 정보를 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}


export async function DELETE(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return productDeletionErrorResponse(400, '상품 삭제 요청 형식이 올바르지 않습니다.');
  }

  let payload: { operationId: string; expectedProductVersion: number };
  try {
    const candidate: unknown = await request.json();
    if (!isDeleteProductPayload(candidate)) {
      return productDeletionErrorResponse(400, '상품 삭제 요청 형식이 올바르지 않습니다.');
    }
    payload = candidate;
  } catch {
    return productDeletionErrorResponse(400, '상품 삭제 요청 형식이 올바르지 않습니다.');
  }

  try {
    const { productId } = await context.params;
    const command = await createConfiguredProductDeletion(request);
    const deleted = exactProductDeletionResult(await command.delete({
      operationId: payload.operationId,
      productId,
      expectedProductVersion: payload.expectedProductVersion,
    }), productId);
    return Response.json(deleted);
  } catch {
    return productDeletionErrorResponse(500, '상품을 삭제하지 못했습니다.');
  }
}

const CANONICAL_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isDeleteProductPayload(
  value: unknown,
): value is { operationId: string; expectedProductVersion: number } {
  const descriptors = exactOrdinaryDataDescriptors(value, ['operationId', 'expectedProductVersion']);
  if (!descriptors) return false;
  const operationId = descriptors.operationId.value;
  const expectedProductVersion = descriptors.expectedProductVersion.value;
  return typeof operationId === 'string' && CANONICAL_OPERATION_ID.test(operationId)
    && Number.isSafeInteger(expectedProductVersion) && (expectedProductVersion as number) > 0
    && (expectedProductVersion as number) < Number.MAX_SAFE_INTEGER;
}

function exactProductDeletionResult(value: unknown, productId: string): { productId: string } {
  const descriptors = exactOrdinaryDataDescriptors(value, ['productId']);
  if (!descriptors || descriptors.productId.value !== productId) {
    throw new Error('Invalid configured product deletion result.');
  }
  return { productId };
}

function exactOrdinaryDataDescriptors(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, PropertyDescriptor & { value: unknown }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return undefined;
  const actualKeys = [...keys as string[]].sort();
  const canonicalExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== canonicalExpectedKeys.length
    || actualKeys.some((key, index) => key !== canonicalExpectedKeys[index])) return undefined;
  const result: Record<string, PropertyDescriptor & { value: unknown }> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !descriptor.writable || !descriptor.configurable
      || !Object.hasOwn(descriptor, 'value')) return undefined;
    result[key] = descriptor as PropertyDescriptor & { value: unknown };
  }
  return result;
}

function productDeletionErrorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
