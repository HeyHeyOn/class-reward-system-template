import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getActivePromotions } from '@/server/repositories/sheets/promotionQueries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const reader = await createConfiguredSheetsReader(request);
    return Response.json(await getActivePromotions(reader));
  } catch (error) {
    console.error('Failed to get active promotions', error);
    return Response.json(
      { error: '진행 중인 행사를 불러오지 못했습니다.' },
      { status: 500 },
    );
  }
}
