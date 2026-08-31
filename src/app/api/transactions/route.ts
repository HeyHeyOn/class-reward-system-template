import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredTransactionReader } from '@/server/repositories/configuredTransactions';

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const reader = await createConfiguredTransactionReader();
    const transactions = await reader.getTransactions();

    return Response.json(transactions);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '결제 내역을 불러오지 못했습니다.' },
      { status: 500 },
    );
  }
}
