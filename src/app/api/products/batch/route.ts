import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteProductsBatch, updateProductDetailsBatch } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const products = Array.isArray(payload.products)
      ? payload.products.map((product: Record<string, unknown>) => ({
          productId: String(product.productId ?? ''),
          name: String(product.name ?? ''),
          price: Number(product.price),
          stock: Number(product.stock),
          isActive: Boolean(product.isActive),
          imageUrl: product.imageUrl ? String(product.imageUrl) : undefined,
          category: product.category ? String(product.category) : undefined,
          sortOrder: Number(product.sortOrder),
        }))
      : [];
    const result = await updateProductDetailsBatch(store, products);

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '재고 목록을 일괄 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const result = await deleteProductsBatch(
      store,
      Array.isArray(payload.productIds) ? payload.productIds.map((id: unknown) => String(id)) : [],
    );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품을 일괄 삭제하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
