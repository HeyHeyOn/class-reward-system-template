import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { updateProductDetails } from '@/server/sheetsRepository';

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
      category: payload.category ? String(payload.category) : undefined,
      sortOrder: Number(payload.sortOrder),
    });

    return Response.json(product);
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품 정보를 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
