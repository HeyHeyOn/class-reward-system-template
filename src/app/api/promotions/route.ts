import { randomUUID } from 'node:crypto';
import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredCatalogReader } from '@/server/repositories/configuredCatalog';
import {
  createPromotion,
  replacePromotionProducts,
} from '@/server/repositories/sheets/promotionCommands';
import {
  haveSameProductIds,
  parseCreatePromotionPayload,
  PromotionPayloadError,
} from './payload';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const catalog = await createConfiguredCatalogReader(request);
    return Response.json(await catalog.getPromotions());
  } catch (error) {
    console.error('Failed to get promotions', error);
    return safeErrorResponse(500, '행사 목록을 불러오지 못했습니다.');
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  let payload: ReturnType<typeof parseCreatePromotionPayload>;
  try {
    payload = parseCreatePromotionPayload(await request.json());
  } catch (error) {
    if (error instanceof PromotionPayloadError || error instanceof SyntaxError) {
      return safeErrorResponse(400, '행사 요청 형식이 올바르지 않습니다.');
    }
    console.error('Unexpected promotion payload parsing failure', error);
    return safeErrorResponse(500, '행사를 추가하지 못했습니다.');
  }

  const promotionId = payload.promotionId ?? `PROMO-${randomUUID()}`;
  try {
    const store = await createConfiguredSheetsStore(request);
    const created = await createPromotion(store, { promotionId, ...payload.definition });
    let promotion = created;
    if (!haveSameProductIds(created.productIds, payload.productIds)) {
      try {
        promotion = await replacePromotionProducts(store, promotionId, payload.productIds);
      } catch (error) {
        console.error('Failed to replace promotion products after create', error);
        return safeErrorResponse(
          500,
          '행사 정보는 저장되었을 수 있지만 대상 상품 저장에 실패했습니다. 새로고침 후 확인하고 다시 시도해 주세요.',
        );
      }
    }
    return Response.json(promotion, { status: 201 });
  } catch (error) {
    console.error('Failed to create promotion', error);
    return safeErrorResponse(500, '행사를 추가하지 못했습니다.');
  }
}

function safeErrorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
