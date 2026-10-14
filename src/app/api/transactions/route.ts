import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredTransactionReader } from '@/server/repositories/configuredTransactions';
import { pageSheetTransactions, parseTransactionPageRequest, TransactionPageRequestError } from '@/server/transactionPagination';

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const params = new URL(request.url).searchParams;
    const page = params.get('paged') === '1' ? parseTransactionPageRequest(params) : null;
    const reader = await createConfiguredTransactionReader();
    if (page) {
      const result = reader.getTransactionPage ? await reader.getTransactionPage(page)
        : pageSheetTransactions(await reader.getTransactions(), page);
      return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const transactions = await reader.getTransactions();

    return Response.json(transactions);
  } catch (error) {
    if (error instanceof TransactionPageRequestError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json(
      { error: error instanceof Error ? error.message : '결제 내역을 불러오지 못했어요.' },
      { status: 500 },
    );
  }
}
