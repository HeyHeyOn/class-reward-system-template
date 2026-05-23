import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { cancelTransaction } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ transactionId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { transactionId } = await context.params;
    const store = await createConfiguredSheetsStore();
    const result = await cancelTransaction(store, decodeURIComponent(transactionId));

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '거래를 취소하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
