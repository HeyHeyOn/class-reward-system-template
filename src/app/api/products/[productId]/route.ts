import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteProduct, updateProductDetails } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ productId: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { productId } = await context.params;
    const store = await createConfiguredSheetsStore(request);
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
  try {
    const { productId } = await context.params;
    const store = await createConfiguredSheetsStore(request);
    const result = await deleteProduct(store, decodeURIComponent(productId));

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품을 삭제하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
