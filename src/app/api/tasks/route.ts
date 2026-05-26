import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createTask, getTasks } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get('includeInactive') === '1';
    const reader = await createConfiguredSheetsReader();
    const tasks = await getTasks(reader, { includeInactive });
    return Response.json(tasks);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 목록을 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const payload = await request.json();
    const store = await createConfiguredSheetsStore();
    const task = await createTask(store, {
      taskId: String(payload.taskId ?? ''),
      title: String(payload.title ?? ''),
      description: String(payload.description ?? ''),
      reward: Number(payload.reward),
      maxCompletionsPerStudent: Number(payload.maxCompletionsPerStudent),
      isActive: Boolean(payload.isActive),
      sortOrder: Number(payload.sortOrder),
      allowedStudentIds: Array.isArray(payload.allowedStudentIds) ? payload.allowedStudentIds.map((id: unknown) => String(id)) : [],
    });
    return Response.json(task, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 추가하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
