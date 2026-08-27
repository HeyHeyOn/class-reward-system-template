import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { completeTaskForStudent } from '@/server/sheetsRepository';

type RouteContext = { params: Promise<{ taskId: string }> };

export const dynamic = 'force-dynamic';

const SAFE_COMPLETION_ERRORS = new Set([
  '완료할 수 있는 과제가 아닙니다.',
  '현재 완료할 수 있는 과제가 아닙니다.',
  '학생 정보를 찾을 수 없습니다.',
  '선행 과제를 찾을 수 없습니다.',
  '부여된 학생이 없습니다.',
  '허가되지 않은 과제입니다.',
  '이미 완료한 과제입니다.',
  '과제 완료 요청 형식이 올바르지 않습니다.',
]);

function isSafeCompletionError(message: string): boolean {
  return SAFE_COMPLETION_ERRORS.has(message)
    || (message.startsWith("선행 과제 '")
      && (message.endsWith('을(를) 먼저 완료해 주세요.') || message.endsWith('은(는) 현재 완료할 수 없습니다.')));
}

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
    if (error instanceof SyntaxError) return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    const message = error instanceof Error ? error.message : '';
    if (isSafeCompletionError(message)) return Response.json({ error: message }, { status: 400 });
    return Response.json({ error: '과제 완료 처리에 실패했습니다.' }, { status: 500 });
  }
}
