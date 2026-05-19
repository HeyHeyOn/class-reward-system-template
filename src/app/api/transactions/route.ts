import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { getTransactions } from '@/server/sheetsRepository';

export async function GET() {
  try {
    const store = await createConfiguredSheetsStore();
    const transactions = await getTransactions(store);

    return Response.json(transactions);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '결제 내역을 불러오지 못했습니다.' },
      { status: 500 },
    );
  }
}
