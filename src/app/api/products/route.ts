import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createProduct, getActiveProducts, getProducts } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get('includeInactive') === '1';
    const reader = await createConfiguredSheetsReader(request);
    const products = includeInactive ? await getProducts(reader) : await getActiveProducts(reader);

    return Response.json(products);
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품 목록을 불러오지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const product = await createProduct(store, {
      productId: String(payload.productId ?? ''),
      name: String(payload.name ?? ''),
      price: Number(payload.price),
      stock: Number(payload.stock),
      isActive: Boolean(payload.isActive),
      category: payload.category ? String(payload.category) : undefined,
      sortOrder: Number(payload.sortOrder),
    });

    return Response.json(product, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품을 추가하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
