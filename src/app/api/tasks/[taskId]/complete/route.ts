import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import {
  createConfiguredTaskCompletion,
  parseConfiguredTaskCompletionResult,
} from '@/server/repositories/configuredTaskCompletion';
import { TaskRewardCommandError } from '@/server/repositories/database/taskCompletionCommands';
import { resolveStudentQrForCurrentTenant } from '@/server/studentQr';

type RouteContext = { params: Promise<{ taskId: string }> };

export const dynamic = 'force-dynamic';

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
const LEGACY_OPERATION_CONFLICTS = new Set([
  'TASK_COMPLETION_OPERATION_PAYLOAD_CONFLICT',
  'TASK_COMPLETION_OPERATION_IDENTITY_CONFLICT',
  'TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT',
]);
const RECONCILIATION_ERRORS = new Set([
  'TASK_COMPLETION_BALANCE_OUTCOME_UNKNOWN_MANUAL_RECONCILIATION_REQUIRED',
  'TASK_COMPLETION_LOGICAL_OPERATION_IN_PROGRESS_MANUAL_RECONCILIATION_REQUIRED',
]);

function qrFailure(): Response {
  return Response.json({ error: '학생 QR을 인식해 주세요.' }, { status: 400 });
}

function isSafeCompletionError(message: string): boolean {
  return SAFE_COMPLETION_ERRORS.has(message)
    || (message.startsWith("선행 과제 '")
      && (message.endsWith('을(를) 먼저 완료해 주세요.') || message.endsWith('은(는) 현재 완료할 수 없습니다.')));
}

function exactDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || keys.some((key) => !actualKeys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  });
}

function dataValue(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function operationConflict(operationId: string): Response {
  return Response.json({
    error: '같은 완료 요청의 내용이 일치하지 않습니다.',
    code: 'COMPLETION_OPERATION_CONFLICT',
    operationId,
  }, { status: 409 });
}

function statusUnknown(operationId: string): Response {
  return Response.json({
    error: '완료 상태를 확인하고 있습니다.',
    code: 'COMPLETION_STATUS_UNKNOWN',
    operationId,
    retryable: true,
  }, { status: 503 });
}

export async function POST(request: Request, context: RouteContext) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;

  const contentType = request.headers.get('content-type');
  if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return qrFailure();

  let taskId: string;
  let studentId: string;
  let operationId: string;
  try {
    const params: unknown = await context.params;
    if (!exactDataRecord(params, ['taskId'])) return qrFailure();
    const encodedTaskId = dataValue(params, 'taskId');
    if (typeof encodedTaskId !== 'string') return qrFailure();
    taskId = decodeURIComponent(encodedTaskId).trim();

    const payload: unknown = await request.json();
    if (!exactDataRecord(payload, ['studentId', 'operationId'])) return qrFailure();
    const rawStudentId = dataValue(payload, 'studentId');
    const rawOperationId = dataValue(payload, 'operationId');
    if (typeof rawStudentId !== 'string' || typeof rawOperationId !== 'string') return qrFailure();
    const qrValue = rawStudentId.trim();
    operationId = rawOperationId;
    if (!taskId || !qrValue || !OPERATION_ID_PATTERN.test(operationId)) return qrFailure();
    studentId = resolveStudentQrForCurrentTenant(qrValue).studentId;
  } catch {
    return qrFailure();
  }

  try {
    const requestId = crypto.randomUUID();
    const command = await createConfiguredTaskCompletion(request);
    const rawResult: unknown = await command.execute({ requestId, operationId, taskId, studentId });
    const result = parseConfiguredTaskCompletionResult(rawResult, { taskId, studentId, operationId });
    return Response.json(result);
  } catch (error) {
    if (error instanceof TaskRewardCommandError) {
      if (error.code === 'POLICY' || error.code === 'SUBMISSION_REQUIRED') {
        return Response.json({
          error: error.code === 'SUBMISSION_REQUIRED'
            ? '과제 제출물을 찾을 수 없습니다.'
            : '완료할 수 있는 과제가 아닙니다.',
          code: 'POLICY_FAILURE',
          operationId,
        }, { status: 400 });
      }
      if (error.code === 'OPERATION_CONFLICT') return operationConflict(operationId);
      return statusUnknown(operationId);
    }

    const message = error instanceof Error ? error.message : '';
    if (isSafeCompletionError(message)) {
      return Response.json({ error: message, code: 'POLICY_FAILURE', operationId }, { status: 400 });
    }
    if (LEGACY_OPERATION_CONFLICTS.has(message)) return operationConflict(operationId);
    if (error instanceof Error
      && error.name === 'TaskCompletionReconciliationError'
      && RECONCILIATION_ERRORS.has(message)) {
      return Response.json({
        error: '완료 상태를 자동으로 확인할 수 없습니다. 관리자에게 문의해 주세요.',
        code: 'COMPLETION_RECONCILIATION_REQUIRED',
        operationId,
        retryable: false,
      }, { status: 409 });
    }
    return statusUnknown(operationId);
  }
}
