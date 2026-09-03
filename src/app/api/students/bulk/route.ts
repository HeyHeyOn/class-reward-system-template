import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredAdminAdjustmentCommand } from '@/server/repositories/configuredAdminAdjustment';
import type { StudentBulkBalanceUpdate } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BULK_BODY_KEYS = ['amount', 'mode', 'operationId', 'studentIds'];

export async function PATCH(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const payload = await parseBulkBalanceBody(request);
  if (!payload) {
    return Response.json({ error: '올바른 학생 재화 수정 요청이 아닙니다.' }, { status: 400 });
  }

  try {
    const command = await createConfiguredAdminAdjustmentCommand(request);
    const result = await command.adjust({
      operationId: payload.operationId,
      studentIds: payload.studentIds,
      mode: payload.mode,
      amount: payload.amount,
    });
    return Response.json(result.students.map(({ studentId, balanceAfter }) => ({
      studentId,
      balance: balanceAfter,
    })));
  } catch {
    return Response.json({ error: '학생 재화를 일괄 수정하지 못했습니다.' }, { status: 400 });
  }
}

async function parseBulkBalanceBody(request: Request): Promise<StudentBulkBalanceUpdate | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (Object.keys(record).sort().join('|') !== BULK_BODY_KEYS.join('|')
      || !Array.isArray(record.studentIds)
      || record.studentIds.length === 0
      || record.studentIds.some((id) => typeof id !== 'string' || !id.trim())
      || (record.mode !== 'set' && record.mode !== 'add' && record.mode !== 'subtract')
      || !Number.isSafeInteger(record.amount)
      || (record.mode !== 'set' && (record.amount as number) < 0)
      || typeof record.operationId !== 'string'
      || !CANONICAL_UUID.test(record.operationId)) {
      return null;
    }
    return {
      studentIds: record.studentIds as string[],
      mode: record.mode,
      amount: record.amount as number,
      operationId: record.operationId,
    };
  } catch {
    return null;
  }
}
