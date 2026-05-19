import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getActiveProducts } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const reader = await createConfiguredSheetsReader();
    const products = await getActiveProducts(reader);

    return Response.json(products);
  } catch (error) {
    const message = error instanceof Error ? error.message : '상품 목록을 불러오지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}
