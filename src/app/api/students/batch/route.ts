import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteStudentsBatch, updateStudentDetailsBatchWithBalanceTransactions } from '@/server/sheetsRepository';
import type { StudentBatchUpdate } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATCH_BODY_KEYS = ['operationId', 'students'];
const PATCH_STUDENT_KEYS = ['balance', 'name', 'status', 'studentId'];

export async function PATCH(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const payload: unknown = await request.json();
    if (!isRecord(payload)
      || Object.keys(payload).sort().join('|') !== PATCH_BODY_KEYS.join('|')
      || typeof payload.operationId !== 'string'
      || !CANONICAL_UUID.test(payload.operationId)
      || !Array.isArray(payload.students)) {
      return Response.json({ error: '올바른 학생 명단 저장 요청이 아닙니다.' }, { status: 400 });
    }
    if (!payload.students.every(isStudentBatchUpdate)) {
      return Response.json({ error: '올바른 학생 명단 저장 요청이 아닙니다.' }, { status: 400 });
    }
    const students = payload.students;
    const store = await createConfiguredSheetsStore(request);
    const result = await updateStudentDetailsBatchWithBalanceTransactions(
      store,
      students,
      payload.operationId,
    );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생 명단을 일괄 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const result = await deleteStudentsBatch(
      store,
      Array.isArray(payload.studentIds) ? payload.studentIds.map((id: unknown) => String(id)) : [],
    );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생을 일괄 삭제하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStudentBatchUpdate(value: unknown): value is StudentBatchUpdate {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== PATCH_STUDENT_KEYS.join('|')) return false;
  return typeof value.studentId === 'string'
    && typeof value.name === 'string'
    && Number.isSafeInteger(value.balance)
    && (value.status === 'ACTIVE' || value.status === 'INACTIVE');
}
