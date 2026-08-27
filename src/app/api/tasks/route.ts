import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createTask } from '@/server/sheetsRepository';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import { buildStudentTaskProjection } from '@/server/studentTaskProjection';
import { parseOptionalTaskScheduleEdit } from './taskScheduleEdit';
import { parseStrictTaskFields } from './taskPayload';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const keys = Array.from(searchParams.keys());
    const studentIds = searchParams.getAll('studentId');
    if (keys.some((key) => key !== 'studentId' && key !== 'includeInactive')
      || studentIds.length > 1
      || (studentIds.length === 1 && (!studentIds[0].trim() || searchParams.has('includeInactive')))) {
      return Response.json({ error: '과제 조회 요청 형식이 올바르지 않습니다.' }, { status: 400 });
    }
    const studentId = studentIds.length === 1 ? studentIds[0].trim() : null;
    if (!studentId && !isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();
    const reader = await createConfiguredSheetsReader(request);
    const includeInactive = searchParams.get('includeInactive') === '1';
    const tasks = await listTaskCycleProjections(reader, {
      ...(includeInactive || studentId ? { includeInactive: true } : {}),
      ...(studentId ? { studentId } : {}),
    });
    if (!studentId) return Response.json(tasks);
    const now = new Date().toISOString();
    return Response.json(buildStudentTaskProjection(tasks, studentId, now));
  } catch (error) {
    if (new URL(request.url).searchParams.has('studentId')) {
      return Response.json({ error: '과제 목록을 불러오지 못했습니다.' }, { status: 500 });
    }
    const message = error instanceof Error ? error.message : '과제 목록을 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const payload: unknown = await request.json();
    const fields = parseStrictTaskFields(payload, 'create');
    const input = payload as Record<string, unknown>;
    const schedule = parseOptionalTaskScheduleEdit(input.schedule);
    const store = await createConfiguredSheetsStore(request);
    const task = await createTask(store, {
      ...fields,
      taskId: fields.taskId!,
      ...(schedule === undefined ? {} : { schedule }),
    });
    return Response.json(task, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 추가하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
