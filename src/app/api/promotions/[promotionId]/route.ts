import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredPromotionDeletion } from '@/server/repositories/configuredPromotionDeletion';
import {
  createConfiguredPromotionMutation,
  PROMOTION_MUTATION_TARGET_PARTIAL_FAILURE_MESSAGE,
  PromotionMutationTargetPartialFailure,
} from '@/server/repositories/configuredPromotionMutation';
import {
  PROMOTION_DELETE_PARTIAL_FAILURE_MESSAGE,
  PromotionDeletePartialFailure,
} from '@/server/repositories/sheets/promotionCommands';
import {
  parsePatchPromotionPayload,
  PromotionPayloadError,
} from '../payload';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ promotionId: string }> };

const CANONICAL_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function PATCH(request: Request, { params }: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return safeErrorResponse(400, '행사 요청 형식이 올바르지 않습니다.');
  }

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
    const command = await createConfiguredPromotionMutation(request);
    const result = await command.patch(payload.kind === 'activation'
      ? { kind: 'activation', operationId: payload.operationId, promotionId,
        expectedPromotionVersion: payload.expectedPromotionVersion, isActive: payload.isActive }
      : { kind: 'definition', operationId: payload.operationId, promotionId,
        expectedPromotionVersion: payload.expectedPromotionVersion,
        definition: payload.definition, productIds: payload.productIds });
    const acknowledgement = configuredMutationAcknowledgement(result, promotionId);
    return Response.json(acknowledgement);
  } catch (error) {
    console.error('Failed to update promotion', error);
    if (error instanceof PromotionMutationTargetPartialFailure) {
      return safeErrorResponse(500, PROMOTION_MUTATION_TARGET_PARTIAL_FAILURE_MESSAGE);
    }
    return safeErrorResponse(500, '행사를 수정하지 못했습니다.');
  }
}

function configuredMutationAcknowledgement(
  value: unknown,
  promotionId: string,
): { promotionId: string; mutationPrecondition: { promotionId: string; expectedVersion: number } } {
  const result = exactDataRecord(value, ['mutationPrecondition', 'promotionId']);
  if (result.promotionId.value !== promotionId) {
    throw new Error('Invalid promotion mutation result.');
  }
  const condition = exactDataRecord(result.mutationPrecondition.value, ['expectedVersion', 'promotionId']);
  const expectedVersion = condition.expectedVersion.value;
  if (condition.promotionId.value !== promotionId || !Number.isSafeInteger(expectedVersion)
    || (expectedVersion as number) <= 0) throw new Error('Invalid promotion mutation result.');
  return { promotionId, mutationPrecondition: { promotionId, expectedVersion: expectedVersion as number } };
}

function exactDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, PropertyDescriptor & { value: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid promotion mutation result.');
  const keys = Reflect.ownKeys(value);
  const actualKeys = keys.every((key): key is string => typeof key === 'string')
    ? [...keys].sort()
    : [];
  const canonicalExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== canonicalExpectedKeys.length
    || canonicalExpectedKeys.some((key, index) => actualKeys[index] !== key)) {
    throw new Error('Invalid promotion mutation result.');
  }
  const result: Record<string, PropertyDescriptor & { value: unknown }> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isOrdinaryDataDescriptor(descriptor)) throw new Error('Invalid promotion mutation result.');
    result[key] = descriptor;
  }
  return result;
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
