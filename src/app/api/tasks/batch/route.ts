import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteTasksBatch, updateTaskDetailsBatch } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const tasks = Array.isArray(payload.tasks)
      ? payload.tasks.map((task: Record<string, unknown>) => ({
          taskId: String(task.taskId ?? ''),
          title: String(task.title ?? ''),
          description: String(task.description ?? ''),
          reward: Number(task.reward),
          maxCompletionsPerStudent: Number(task.maxCompletionsPerStudent),
          isActive: Boolean(task.isActive),
          sortOrder: Number(task.sortOrder),
        }))
      : [];
    const result = await updateTaskDetailsBatch(store, tasks);

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 목록을 일괄 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const store = await createConfiguredSheetsStore(request);
    const payload = await request.json();
    const result = await deleteTasksBatch(
      store,
      Array.isArray(payload.taskIds) ? payload.taskIds.map((id: unknown) => String(id)) : [],
    );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 일괄 삭제하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
