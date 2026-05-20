import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { bulkAdjustStudentBalances } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const result = await bulkAdjustStudentBalances(store, {
      studentIds: Array.isArray(payload.studentIds) ? payload.studentIds.map((id: unknown) => String(id)) : [],
      mode: payload.mode,
      amount: Number(payload.amount),
    });

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생 재화를 일괄 수정하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
