import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteTasksBatch, updateTaskDetailsBatch } from '@/server/sheetsRepository';
import { parseOptionalTaskScheduleEdit } from '../taskScheduleEdit';
import { parseStrictBatchTaskFields } from '../taskPayload';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const payload: unknown = await request.json();
    if (!isPlainObject(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'tasks')
      || !Array.isArray(payload.tasks)) throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
    const tasks = payload.tasks.map((task) => parseBatchTask(task));
    const store = await createConfiguredSheetsStore(request);
    const result = await updateTaskDetailsBatch(store, tasks);

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 목록을 일괄 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

function parseBatchTask(value: unknown) {
  if (!isPlainObject(value)) throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
  const task = value;
  const fields = parseStrictBatchTaskFields(task);
  return { ...fields, taskId: fields.taskId!, ...parseScheduleProperty(task) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScheduleProperty(task: Record<string, unknown>) {
  const schedule = parseOptionalTaskScheduleEdit(task.schedule);
  return schedule === undefined ? {} : { schedule };
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
