import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { cancelTransaction } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ transactionId: string }>;
};

type CancellationBody = { operationId: string };

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function POST(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const body = await parseCancellationBody(request);
  if (!body) return Response.json({ error: '올바른 취소 요청이 아닙니다.' }, { status: 400 });

  try {
    const { transactionId } = await context.params;
    const store = await createConfiguredSheetsStore();
    const result = await cancelTransaction(
      store,
      decodeURIComponent(transactionId),
      body.operationId,
    );

    return Response.json(result);
  } catch {
    return Response.json({ error: '거래를 취소하지 못했습니다.' }, { status: 400 });
  }
}

async function parseCancellationBody(request: Request): Promise<CancellationBody | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (Object.keys(record).length !== 1
      || typeof record.operationId !== 'string'
      || !CANONICAL_UUID.test(record.operationId)) {
      return null;
    }
    return { operationId: record.operationId };
  } catch {
    return null;
  }
}
