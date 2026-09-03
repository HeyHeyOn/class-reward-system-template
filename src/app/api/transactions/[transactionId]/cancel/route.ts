import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredTransactionCancellation } from '@/server/repositories/configuredTransactionCancellation';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ transactionId: string }>;
};

type CancellationBody = { operationId: string };

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANCELLATION_FAILURE_REASONS = new Map<string, string>([
  ['거래 ID를 입력해 주세요.', 'transaction-id-missing'],
  ['현재 Sheets 저장소가 원자적 거래 취소를 지원하지 않습니다.', 'atomic-cancellation-unsupported'],
  ['거래 내역을 찾을 수 없습니다.', 'transaction-not-found'],
  ['거래 ID가 중복되어 무결성을 확인할 수 없습니다.', 'transaction-id-duplicate'],
  ['거래 내역의 무결성을 확인할 수 없습니다.', 'transaction-integrity-invalid'],
  ['거래 취소 기록의 무결성을 확인할 수 없어 수동 조정이 필요합니다.', 'cancellation-record-invalid'],
  ['거래 취소 기록의 무결성이 일치하지 않아 수동 조정이 필요합니다.', 'cancellation-record-integrity-mismatch'],
  ['취소 작업 ID 기록의 무결성을 확인할 수 없어 수동 조정이 필요합니다.', 'cancellation-operation-invalid'],
  ['취소 작업 ID가 다른 거래에 사용되었습니다.', 'operation-id-conflict'],
  ['이미 취소된 거래이거나 취소 기록의 무결성을 확인할 수 없습니다.', 'already-cancelled-or-invalid'],
  ['이미 취소된 거래입니다.', 'already-cancelled'],
  ['취소할 수 없는 거래입니다.', 'transaction-not-cancellable'],
  ['거래 상품 스냅샷이 올바르지 않습니다.', 'item-snapshot-invalid'],
  ['학생 정보를 찾을 수 없습니다.', 'student-not-found'],
  ['학생 ID가 중복되어 무결성을 확인할 수 없습니다.', 'student-id-duplicate'],
  ['학생 정보의 무결성을 확인할 수 없습니다.', 'student-integrity-invalid'],
  ['Products 시트에 필수 컬럼이 없습니다.', 'products-schema-invalid'],
  ['Cancellation balance delta exceeds the safe integer range', 'balance-delta-unsafe'],
  ['Cancellation restoration requires safe integer values', 'restoration-values-unsafe'],
  ['Safe integer overflow: 안전한 정수 범위를 벗어났습니다.', 'safe-integer-overflow'],
  ['과제 보상 거래 연결 ID를 해석할 수 없어 취소하지 않았습니다.', 'task-link-id-invalid'],
  ['과제 보상 거래와 완료 기록을 연결할 수 없어 취소하지 않았습니다.', 'task-link-missing'],
  ['과제 완료 기록이 없거나 중복되어 무결성을 확인할 수 없습니다.', 'task-completion-missing-or-duplicate'],
  ['레거시 과제 보상 거래 상품의 무결성이 일치하지 않아 취소하지 않았습니다.', 'legacy-task-item-invalid'],
  ['레거시 과제 보상 거래의 현재 과제를 하나로 확인할 수 없어 취소하지 않았습니다.', 'legacy-task-definition-ambiguous'],
  ['레거시 과제 보상 거래와 현재 과제의 무결성이 일치하지 않아 취소하지 않았습니다.', 'legacy-task-definition-mismatch'],
  ['과제 완료 기록이 손상되어 무결성을 확인할 수 없습니다.', 'task-completion-invalid'],
  ['과제 보상 거래와 완료 기록의 무결성이 일치하지 않아 취소하지 않았습니다.', 'task-reward-completion-mismatch'],
  ['과제 완료 기록 스냅샷이 손상되어 취소하지 않았습니다.', 'task-completion-snapshot-invalid'],
  ['과제 완료 RESET 기록의 무결성을 확인할 수 없어 취소하지 않았습니다.', 'task-reset-integrity-unverifiable'],
  ['과제 완료 RESET 기록의 무결성이 일치하지 않아 취소하지 않았습니다.', 'task-reset-integrity-mismatch'],
  ['연결된 완료 기록이 현재 유효한 과제 완료가 아니어서 취소하지 않았습니다.', 'task-completion-not-effective'],
  ['과제 완료 기록의 과제를 찾을 수 없습니다.', 'task-not-found'],
  ['과제 스케줄 스냅샷을 안전하게 만들 수 없어 취소하지 않았습니다.', 'task-schedule-snapshot-invalid'],
  ['연결된 레거시 완료 기록이 현재 유효한 과제 완료가 아니어서 취소하지 않았습니다.', 'legacy-task-completion-not-effective'],
]);
const CANCELLATION_FAILURE_PREFIX_REASONS: ReadonlyArray<readonly [string, string]> = [
  ['거래 상품을 찾을 수 없어 수동 조정이 필요합니다:', 'transaction-product-missing'],
  ['TaskCompletions 템플릿/스키마를 업데이트해 주세요. 필수 컬럼이 없습니다:', 'task-completions-schema-invalid'],
  ['Transactions 시트에 필수 컬럼이 없습니다:', 'transactions-schema-invalid'],
  ['Students 시트에 필수 컬럼이 없습니다:', 'students-schema-invalid'],
  ['Products 시트에 필수 컬럼이 없습니다:', 'products-schema-invalid'],
];

export async function POST(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const body = await parseCancellationBody(request);
  if (!body) return Response.json({ error: '올바른 취소 요청이 아닙니다.' }, { status: 400 });

  let transactionId = 'unknown';
  try {
    const params = await context.params;
    transactionId = transactionIdFromRequestPath(request) ?? params.transactionId;
    const cancellation = await createConfiguredTransactionCancellation(request);
    const result = await cancellation.cancel({
      transactionId,
      operationId: body.operationId,
    });

    return Response.json(result);
  } catch (error) {
    console.error('transaction_cancellation_failed', {
      reason: cancellationFailureReason(error),
    });
    return Response.json({ error: '거래를 취소하지 못했습니다.' }, { status: 400 });
  }
}

function transactionIdFromRequestPath(request: Request): string | null {
  try {
    const pathname = new URL(request.url).pathname;
    const prefix = '/api/transactions/';
    const suffix = '/cancel';
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;

    const encodedTransactionId = pathname.slice(prefix.length, -suffix.length);
    if (!encodedTransactionId || encodedTransactionId.includes('/')) return null;
    return decodeURIComponent(encodedTransactionId);
  } catch {
    return null;
  }
}

function cancellationFailureReason(error: unknown): string {
  try {
    if (!(error instanceof Error) || typeof error.message !== 'string') return 'unexpected';
    const exactReason = CANCELLATION_FAILURE_REASONS.get(error.message);
    if (exactReason) return exactReason;
    return CANCELLATION_FAILURE_PREFIX_REASONS.find(([prefix]) => error.message.startsWith(prefix))?.[1]
      ?? 'unexpected';
  } catch {
    return 'unexpected';
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
