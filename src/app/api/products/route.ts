import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { createConfiguredCatalogReader } from '@/server/repositories/configuredCatalog';
import { createProduct } from '@/server/sheetsRepository';

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

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore();
    const payload = await request.json();
    const product = await createProduct(store, {
      productId: String(payload.productId ?? ''),
      name: String(payload.name ?? ''),
      price: Number(payload.price),
      stock: Number(payload.stock),
      isActive: Boolean(payload.isActive),
      imageUrl: payload.imageUrl ? String(payload.imageUrl) : undefined,
      category: payload.category ? String(payload.category) : undefined,
      sortOrder: Number(payload.sortOrder),
    });

    return Response.json(product, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품을 추가하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
