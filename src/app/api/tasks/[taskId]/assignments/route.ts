import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { updateTaskAssignmentStatus } from '@/server/sheetsRepository';
import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';

type RouteContext = { params: Promise<{ taskId: string }> };
const INVALID_ASSIGNMENT_REQUEST = '과제 부여 요청 형식이 올바르지 않습니다.';
const ASSIGNMENT_KEYS = new Set(['studentId', 'assigned', 'completed', 'source']);

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { taskId } = await context.params;
    const reader = await createConfiguredTaskReader(request);
    const status = await reader.getTaskAssignmentStatus(decodeURIComponent(taskId));
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
      || Object.keys(payload).some((key) => !ASSIGNMENT_KEYS.has(key))
      || typeof payload.studentId !== 'string'
      || payload.studentId.trim().length === 0
      || (payload.assigned !== undefined && typeof payload.assigned !== 'boolean')
      || (payload.completed !== undefined && typeof payload.completed !== 'boolean')
      || (payload.assigned === undefined && payload.completed === undefined)
      || (payload.source !== undefined && payload.source !== 'ADMIN' && payload.source !== 'QR')
      || (payload.source === 'QR' && payload.completed !== undefined)
    ) {
      return Response.json({ error: INVALID_ASSIGNMENT_REQUEST }, { status: 400 });
    }
    const store = await createConfiguredSheetsStore(request);
    const status = await updateTaskAssignmentStatus(store, decodeURIComponent(taskId), {
      studentId: payload.studentId,
      ...(payload.assigned !== undefined ? { assigned: payload.assigned } : {}),
      ...(payload.completed !== undefined ? { completed: payload.completed } : {}),
      source: payload.source ?? 'ADMIN',
    });
    return Response.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 부여 상태를 저장하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
