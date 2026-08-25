import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { completeTaskForStudent } from '@/server/sheetsRepository';

type RouteContext = { params: Promise<{ taskId: string }> };

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const payload = await request.json();
    if (
      typeof payload !== 'object'
      || payload === null
      || Array.isArray(payload)
      || Object.keys(payload).length !== 1
      || !Object.prototype.hasOwnProperty.call(payload, 'studentId')
      || typeof payload.studentId !== 'string'
      || payload.studentId.trim().length === 0
    ) {
      return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    }
    const studentId = payload.studentId.trim();

    const store = await createConfiguredSheetsStore();
    const result = await completeTaskForStudent(store, decodeURIComponent(taskId), studentId);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 완료 처리에 실패했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
