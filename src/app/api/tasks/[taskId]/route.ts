import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteTask, getTaskById, updateTaskDetails } from '@/server/sheetsRepository';

type RouteContext = { params: Promise<{ taskId: string }> };

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { taskId } = await context.params;
    const reader = await createConfiguredSheetsReader();
    const task = await getTaskById(reader, decodeURIComponent(taskId));
    if (!task || !task.isActive) return Response.json({ error: '과제를 찾을 수 없습니다.' }, { status: 404 });
    return Response.json(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const { taskId } = await context.params;
    const payload = await request.json();
    const store = await createConfiguredSheetsStore();
    const task = await updateTaskDetails(store, decodeURIComponent(taskId), {
      title: String(payload.title ?? ''),
      description: String(payload.description ?? ''),
      reward: Number(payload.reward),
      maxCompletionsPerStudent: Number(payload.maxCompletionsPerStudent),
      isActive: Boolean(payload.isActive),
      sortOrder: Number(payload.sortOrder),
      allowedStudentIds: Array.isArray(payload.allowedStudentIds) ? payload.allowedStudentIds.map((id: unknown) => String(id)) : [],
    });
    return Response.json(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 저장하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(_request)) return unauthorizedAdminResponse();

  try {
    const { taskId } = await context.params;
    const store = await createConfiguredSheetsStore();
    const result = await deleteTask(store, decodeURIComponent(taskId));
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 삭제하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
