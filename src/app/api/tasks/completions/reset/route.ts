import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { resetTaskCompletionsBatch } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const result = await resetTaskCompletionsBatch(
      store,
      Array.isArray(payload.taskIds) ? payload.taskIds.map((id: unknown) => String(id)) : [],
    );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 완료 기록을 초기화하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
