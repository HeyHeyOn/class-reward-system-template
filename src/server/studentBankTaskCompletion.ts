import 'server-only';

import { TaskRewardCommandError } from '@/server/repositories/database/taskCompletionCommands';
import { studentBankJson } from '@/server/studentBankSession';

/**
 * Maps a configured task-completion failure to the personal bank's response. The categories
 * mirror POST /api/tasks/[taskId]/complete exactly (terminal policy, operation conflict,
 * manual reconciliation, otherwise a retryable "status unknown" for the same operation ID);
 * only the student-facing copy is friendlier.
 */

export const STUDENT_BANK_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type StudentBankCompletionPolicyReason = 'SUBMISSION_REQUIRED' | 'NOT_ALLOWED' | 'ALREADY_COMPLETED';

const POLICY_MESSAGES: Record<StudentBankCompletionPolicyReason, string> = {
  SUBMISSION_REQUIRED: '제출한 글을 찾지 못했어요. 패들렛에 먼저 올린 뒤 다시 눌러 주세요.',
  NOT_ALLOWED: '지금은 이 과제를 완료할 수 없어요.',
  ALREADY_COMPLETED: '이미 완료한 과제예요.',
};

// Legacy (Sheets) completion messages that are safe to show; same allowlist as the old route.
const LEGACY_POLICY_MESSAGES = new Set([
  '완료할 수 있는 과제가 아니에요.',
  '현재 완료할 수 있는 과제가 아니에요.',
  '학생 정보를 찾을 수 없어요.',
  '선행 과제를 찾을 수 없어요.',
  '부여된 학생이 없어요.',
  '허가되지 않은 과제예요.',
  '이미 완료한 과제예요.',
  '과제 완료 요청 형식이 올바르지 않아요.',
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

export function studentBankCompletionPolicy(operationId: string, reason: StudentBankCompletionPolicyReason, message = POLICY_MESSAGES[reason]): Response {
  return studentBankJson({ error: message, code: 'POLICY_FAILURE', reason, operationId }, { status: 400 });
}

export const STUDENT_BANK_NOT_READY_MESSAGE = '아직 완료할 수 없는 과제예요. 선생님이 확인하면 완료할 수 있어요.';

/** Same status/code as POST /api/tasks/[taskId]/complete: 409 NOT_READY. */
export function studentBankCompletionNotReady(operationId: string): Response {
  return studentBankJson({ error: STUDENT_BANK_NOT_READY_MESSAGE, code: 'NOT_READY', operationId }, { status: 409 });
}

export function studentBankCompletionStatusUnknown(operationId: string): Response {
  return studentBankJson({
    error: '완료 결과를 확인하고 있어요.',
    code: 'COMPLETION_STATUS_UNKNOWN',
    operationId,
    retryable: true,
  }, { status: 503 });
}

export function studentBankCompletionErrorResponse(error: unknown, operationId: string): Response {
  if (error instanceof TaskRewardCommandError) {
    const code = error.code;
    if (code === 'POLICY') return studentBankCompletionPolicy(operationId, 'NOT_ALLOWED');
    if (code === 'SUBMISSION_REQUIRED') return studentBankCompletionPolicy(operationId, 'SUBMISSION_REQUIRED');
    // 미완료 (PENDING): a definite refusal, nothing was written. Same contract as the old route.
    if (code === 'NOT_READY') return studentBankCompletionNotReady(operationId);
    if (code === 'OPERATION_CONFLICT') return operationConflict(operationId);
    console.warn('[bank-completion] outcome not confirmed', code);
    return studentBankCompletionStatusUnknown(operationId);
  }

  const message = error instanceof Error ? error.message : '';
  if (message === '이미 완료한 과제예요.') return studentBankCompletionPolicy(operationId, 'ALREADY_COMPLETED');
  if (LEGACY_POLICY_MESSAGES.has(message)
    || (message.startsWith("선행 과제 '")
      && (message.endsWith('을(를) 먼저 완료해 주세요.') || message.endsWith('은(는) 현재 완료할 수 없어요.')))) {
    return studentBankCompletionPolicy(operationId, 'NOT_ALLOWED', message);
  }
  if (LEGACY_OPERATION_CONFLICTS.has(message)) return operationConflict(operationId);
  if (error instanceof Error && error.name === 'TaskCompletionReconciliationError' && RECONCILIATION_ERRORS.has(message)) {
    return studentBankJson({
      error: '완료 결과를 자동으로 확인할 수 없어요. 선생님께 알려 주세요.',
      code: 'COMPLETION_RECONCILIATION_REQUIRED',
      operationId,
      retryable: false,
    }, { status: 409 });
  }
  // Unexpected: keep a trace (no student data) so a recurring failure is visible in the logs.
  console.error('[bank-completion] unexpected failure', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
  return studentBankCompletionStatusUnknown(operationId);
}

function operationConflict(operationId: string): Response {
  return studentBankJson({
    error: '같은 완료 요청의 내용이 맞지 않아요. 선생님께 알려 주세요.',
    code: 'COMPLETION_OPERATION_CONFLICT',
    operationId,
  }, { status: 409 });
}
