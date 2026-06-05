import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { getTaskAssignmentStatus, updateTaskAssignmentStatus } from '@/server/sheetsRepository';

type RouteContext = { params: Promise<{ taskId: string }> };

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
    const store = await createConfiguredSheetsStore(request);
    const status = await updateTaskAssignmentStatus(store, decodeURIComponent(taskId), {
      assignedStudentIds: Array.isArray(payload.assignedStudentIds) ? payload.assignedStudentIds.map((id: unknown) => String(id)) : [],
      completedStudentIds: Array.isArray(payload.completedStudentIds) ? payload.completedStudentIds.map((id: unknown) => String(id)) : [],
    });
    return Response.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 부여 상태를 저장하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
