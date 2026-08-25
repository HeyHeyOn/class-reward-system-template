import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { getTaskAssignmentStatus, updateTaskAssignmentStatus } from '@/server/sheetsRepository';

type RouteContext = { params: Promise<{ taskId: string }> };
const INVALID_ASSIGNMENT_REQUEST = '과제 부여 요청 형식이 올바르지 않습니다.';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { taskId } = await context.params;
    const reader = await createConfiguredSheetsReader(request);
    const status = await getTaskAssignmentStatus(reader, decodeURIComponent(taskId));
    return Response.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 부여 상태를 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { taskId } = await context.params;
    const payload = await request.json();
    if (
      typeof payload !== 'object'
      || payload === null
      || Array.isArray(payload)
      || typeof payload.studentId !== 'string'
      || payload.studentId.trim().length === 0
      || typeof payload.assigned !== 'boolean'
    ) {
      return Response.json({ error: INVALID_ASSIGNMENT_REQUEST }, { status: 400 });
    }
    const store = await createConfiguredSheetsStore(request);
    const status = await updateTaskAssignmentStatus(store, decodeURIComponent(taskId), {
      studentId: payload.studentId,
      assigned: payload.assigned,
      source: 'ADMIN',
    });
    return Response.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 부여 상태를 저장하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
