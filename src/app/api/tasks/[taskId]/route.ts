import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteTask, getTaskById, updateTaskDetails } from '@/server/sheetsRepository';
import { getTaskCycleProjection } from '@/server/repositories/sheets/taskHistoryQueries';
import { parseOptionalTaskScheduleEdit } from '../taskScheduleEdit';

type RouteContext = { params: Promise<{ taskId: string }> };

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext) {
  try {
    const { searchParams } = new URL(request.url);
    const keys = Array.from(searchParams.keys());
    const studentIds = searchParams.getAll('studentId');
    if (keys.some((key) => key !== 'studentId')
      || studentIds.length > 1
      || (studentIds.length === 1 && !studentIds[0].trim())) {
      return Response.json({ error: '과제 조회 요청 형식이 올바르지 않습니다.' }, { status: 400 });
    }
    const { taskId } = await context.params;
    const reader = await createConfiguredSheetsReader(request);
    const task = await getTaskById(reader, decodeURIComponent(taskId));
    if (!task || !task.isActive) return Response.json({ error: '과제를 찾을 수 없습니다.' }, { status: 404 });
    const projected = await getTaskCycleProjection(reader, task, {
      ...(studentIds.length === 1 ? { studentId: studentIds[0].trim() } : {}),
    });
    return Response.json(projected);
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
    const schedule = parseOptionalTaskScheduleEdit(payload.schedule);
    const update = {
      title: String(payload.title ?? ''),
      description: String(payload.description ?? ''),
      reward: Number(payload.reward),
      isActive: Boolean(payload.isActive),
      sortOrder: Number(payload.sortOrder),
      allowedStudentIds: Array.isArray(payload.allowedStudentIds) ? payload.allowedStudentIds.map((id: unknown) => String(id)) : [],
      ...(schedule === undefined ? {} : { schedule }),
    };
    const store = await createConfiguredSheetsStore(request);
    const task = await updateTaskDetails(store, decodeURIComponent(taskId), update);
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
    const store = await createConfiguredSheetsStore(_request);
    const result = await deleteTask(store, decodeURIComponent(taskId));
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 삭제하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
