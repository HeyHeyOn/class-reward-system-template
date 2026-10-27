import { createConfiguredCatalogReader } from '@/server/repositories/configuredCatalog';
import { logFailure } from '@/server/log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    void request;
    const catalog = await createConfiguredCatalogReader(request);
    const promotions = await catalog.getActivePromotions();
    return Response.json(promotions, { headers: { 'x-server-now': new Date().toISOString() } });
  } catch (error) {
    logFailure('Failed to get active promotions', error);
    return Response.json(
      { error: '진행 중인 행사를 불러오지 못했어요.' },
      { status: 500 },
    );
  }
}
