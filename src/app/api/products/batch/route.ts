import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteProductsBatch } from '@/server/sheetsRepository';
import { createConfiguredProductMutation } from '@/server/repositories/configuredProductMutation';
import { createConfiguredProductBatchDeletion } from '@/server/repositories/configuredProductBatchDeletion';
import { ProductAdminConflictError, ProductBatchDeletionError, ProductBatchDeletionInputError } from '@/server/repositories/database/catalogCommands';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;

  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const payload: unknown = await request.json();
    const command = await createConfiguredProductMutation(request);
    const result = await command.updateBatch(payload);

    return Response.json(result);
  } catch (error) {
    if (error instanceof ProductAdminConflictError) {
      return Response.json({ code: error.code, error: '상품 정보 또는 저장 요청이 변경됐어요. 새로고침 후 다시 편집해 주세요.' }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : '재고 목록을 일괄 저장하지 못했어요.';

    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;

  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const scoped = Boolean(getOptionalTrustedTenantRequestContext());
  try {
    if (scoped) {
      const payload: unknown = await request.json();
      const command = await createConfiguredProductBatchDeletion(request);
      return Response.json(await command.deleteBatch(payload));
    }
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const result = await deleteProductsBatch(
      store,
      Array.isArray(payload.productIds) ? payload.productIds.map((id: unknown) => String(id)) : [],
    );

    return Response.json(result);
  } catch (error) {
    if (scoped) {
      if (error instanceof ProductAdminConflictError || error instanceof ProductBatchDeletionError) {
        return Response.json({ code: error.code, error: '상품 목록 또는 삭제 요청이 변경됐어요. 새로고침 후 다시 선택해 주세요.' }, {
          status: error instanceof ProductBatchDeletionError && error.code === 'PRODUCT_NOT_FOUND' ? 404 : 409,
        });
      }
      if (error instanceof ProductBatchDeletionInputError || error instanceof SyntaxError) {
        return Response.json({ error: '올바른 상품 삭제 요청이 아니에요. 새로고침해 주세요.' }, { status: 400 });
      }
      // Provider/internal errors are never echoed and never trigger legacy fallback.
      return Response.json({ error: '상품을 일괄 삭제하지 못했어요. 같은 요청으로 다시 시도하거나 새로고침해 주세요.' }, { status: 500 });
    }
    const message = error instanceof Error ? error.message : '상품을 일괄 삭제하지 못했어요.';

    return Response.json({ error: message }, { status: 400 });
  }
}
