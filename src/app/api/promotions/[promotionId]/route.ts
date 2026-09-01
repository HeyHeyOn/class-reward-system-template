import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredPromotionDeletion } from '@/server/repositories/configuredPromotionDeletion';
import {
  PROMOTION_DELETE_PARTIAL_FAILURE_MESSAGE,
  PromotionDeletePartialFailure,
  replacePromotionProducts,
  setPromotionActive,
  updatePromotion,
} from '@/server/repositories/sheets/promotionCommands';
import {
  haveSameProductIds,
  parsePatchPromotionPayload,
  PromotionPayloadError,
} from '../payload';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ promotionId: string }> };

const CANONICAL_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function PATCH(request: Request, { params }: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  let payload: ReturnType<typeof parsePatchPromotionPayload>;
  try {
    payload = parsePatchPromotionPayload(await request.json());
  } catch (error) {
    if (error instanceof PromotionPayloadError || error instanceof SyntaxError) {
      return safeErrorResponse(400, '행사 요청 형식이 올바르지 않습니다.');
    }
    console.error('Unexpected promotion payload parsing failure', error);
    return safeErrorResponse(500, '행사를 수정하지 못했습니다.');
  }

  try {
    const promotionId = (await params).promotionId;
    const store = await createConfiguredSheetsStore(request);

    if (payload.kind === 'activation') {
      return Response.json(await setPromotionActive(store, promotionId, payload.isActive));
    }

    const updated = await updatePromotion(store, promotionId, payload.definition);
    let promotion = updated;
    if (!haveSameProductIds(updated.productIds, payload.productIds)) {
      try {
        promotion = await replacePromotionProducts(store, promotionId, payload.productIds);
      } catch (error) {
        console.error('Failed to replace promotion products after update', error);
        return safeErrorResponse(
          500,
          '행사 정보는 저장되었을 수 있지만 대상 상품 수정에 실패했습니다. 새로고침 후 확인하고 다시 시도해 주세요.',
        );
      }
    }
    return Response.json(promotion);
  } catch (error) {
    console.error('Failed to update promotion', error);
    return safeErrorResponse(500, '행사를 수정하지 못했습니다.');
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return safeErrorResponse(400, '행사 삭제 요청 형식이 올바르지 않습니다.');
  }

  let payload: { operationId: string; expectedPromotionVersion: number };
  try {
    const candidate: unknown = await request.json();
    if (!isDeletePromotionPayload(candidate)) {
      return safeErrorResponse(400, '행사 삭제 요청 형식이 올바르지 않습니다.');
    }
    payload = candidate;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return safeErrorResponse(400, '행사 삭제 요청 형식이 올바르지 않습니다.');
    }
    console.error('Unexpected promotion deletion payload parsing failure', error);
    return safeErrorResponse(500, '행사를 삭제하지 못했습니다.');
  }

  try {
    const promotionId = (await params).promotionId;
    const command = await createConfiguredPromotionDeletion(request);
    const deleted = await command.delete({
      operationId: payload.operationId,
      promotionId,
      expectedPromotionVersion: payload.expectedPromotionVersion,
    });
    return Response.json({ promotionId: deleted.promotionId });
  } catch (error) {
    console.error('Failed to delete promotion', error);
    if (error instanceof PromotionDeletePartialFailure) {
      return safeErrorResponse(500, PROMOTION_DELETE_PARTIAL_FAILURE_MESSAGE);
    }
    return safeErrorResponse(500, '행사를 삭제하지 못했습니다.');
  }
}

function isDeletePromotionPayload(
  value: unknown,
): value is { operationId: string; expectedPromotionVersion: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('operationId') || !keys.includes('expectedPromotionVersion')) {
    return false;
  }
  const operationId = Object.getOwnPropertyDescriptor(value, 'operationId');
  const expectedVersion = Object.getOwnPropertyDescriptor(value, 'expectedPromotionVersion');
  if (!isOrdinaryDataDescriptor(operationId) || !isOrdinaryDataDescriptor(expectedVersion)) return false;
  return typeof operationId.value === 'string' && CANONICAL_OPERATION_ID.test(operationId.value)
    && Number.isSafeInteger(expectedVersion.value) && expectedVersion.value > 0
    && expectedVersion.value < Number.MAX_SAFE_INTEGER;
}

function isOrdinaryDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return Boolean(descriptor?.enumerable && descriptor.writable && descriptor.configurable
    && Object.hasOwn(descriptor, 'value'));
}

function safeErrorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
