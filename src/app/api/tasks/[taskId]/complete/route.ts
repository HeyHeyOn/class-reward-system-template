import { createHash, randomUUID } from 'node:crypto';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { completeTaskForStudent } from '@/server/sheetsRepository';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import { buildStudentTaskProjection } from '@/server/studentTaskProjection';

type RouteContext = { params: Promise<{ taskId: string }> };

export const dynamic = 'force-dynamic';

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function payloadHash(taskId: string, studentId: string): string {
  const normalized = JSON.stringify({ taskId, studentId });
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = randomUUID();
  let operationId = '';
  try {
    const { taskId: encodedTaskId } = await context.params;
    const taskId = decodeURIComponent(encodedTaskId).trim();
    const payload: unknown = await request.json();
    if (
      typeof payload !== 'object'
      || payload === null
      || Array.isArray(payload)
      || Object.keys(payload).length !== 2
      || !Object.prototype.hasOwnProperty.call(payload, 'studentId')
      || !Object.prototype.hasOwnProperty.call(payload, 'operationId')
    ) {
      return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    }
    const input = payload as Record<string, unknown>;
    if (typeof input.studentId !== 'string' || typeof input.operationId !== 'string') {
      return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    }
    const studentId = input.studentId.trim();
    operationId = input.operationId.trim();
    if (!taskId || !studentId || !OPERATION_ID_PATTERN.test(operationId)) {
      return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    }

    const store = await createConfiguredSheetsStore(request);
    const result = await completeTaskForStudent(store, taskId, studentId, {
      requestId,
      operationId,
      operationPayloadHash: payloadHash(taskId, studentId),
      buildSafeProjection: async (projectionNow) => buildStudentTaskProjection(
        await listTaskCycleProjections(store, { studentId, includeInactive: false, now: projectionNow }),
        studentId,
        projectionNow,
      ),
    });
    if (
      !Array.isArray(result.tasks)
      || result.operation?.operationId !== operationId
      || result.operation.state !== 'SUCCESS'
      || result.task?.taskId !== taskId
      || result.student?.studentId !== studentId
      || typeof result.task.title !== 'string'
      || typeof result.task.reward !== 'number'
      || typeof result.student.name !== 'string'
    ) {
      throw new Error('completion projection is not authoritative');
    }
    return Response.json({
      task: { taskId: result.task.taskId, title: result.task.title, reward: result.task.reward },
      student: { studentId: result.student.studentId, name: result.student.name },
      tasks: result.tasks,
      operation: { operationId, state: 'SUCCESS' },
    });
  } catch (error) {
    if (error instanceof SyntaxError || !operationId) {
      return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : '';
    if (isSafeCompletionError(message)) {
      return Response.json({ error: message, code: 'POLICY_FAILURE', operationId }, { status: 400 });
    }
    if (error instanceof Error && new Set([
      'TASK_COMPLETION_OPERATION_PAYLOAD_CONFLICT',
      'TASK_COMPLETION_OPERATION_IDENTITY_CONFLICT',
      'TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT',
    ]).has(error.message)) {
      return Response.json({
        error: '같은 완료 요청의 내용이 일치하지 않습니다.', code: 'COMPLETION_OPERATION_CONFLICT', operationId,
      }, { status: 409 });
    }
    if (error instanceof Error
      && error.name === 'TaskCompletionReconciliationError'
      && new Set([
        'TASK_COMPLETION_BALANCE_OUTCOME_UNKNOWN_MANUAL_RECONCILIATION_REQUIRED',
        'TASK_COMPLETION_LOGICAL_OPERATION_IN_PROGRESS_MANUAL_RECONCILIATION_REQUIRED',
      ]).has(error.message)) {
      return Response.json({
        error: '완료 상태를 자동으로 확인할 수 없습니다. 관리자에게 문의해 주세요.',
        code: 'COMPLETION_RECONCILIATION_REQUIRED', operationId, retryable: false,
      }, { status: 409 });
    }
    return Response.json({
      error: '완료 상태를 확인하고 있습니다.', code: 'COMPLETION_STATUS_UNKNOWN', operationId, retryable: true,
    }, { status: 503 });
  }
}
