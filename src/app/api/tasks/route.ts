import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredTaskCreation } from '@/server/repositories/configuredTaskCreation';
import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';
import { buildStudentTaskProjection } from '@/server/studentTaskProjection';
import { parseOptionalTaskScheduleEdit } from './taskScheduleEdit';
import { parseStrictTaskCreate } from './taskPayload';

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
    const reader = await createConfiguredTaskReader(request);
    const includeInactive = searchParams.get('includeInactive') === '1';
    const tasks = await reader.listTaskCycleProjections({
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
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
    const payload: unknown = await request.json();
    const fields = parseStrictTaskCreate(payload);
    const input = payload as Record<string, unknown>;
    if (input.schedule && typeof input.schedule === 'object' && !Array.isArray(input.schedule)
      && (input.schedule as Record<string, unknown>).timeZone !== 'Asia/Seoul') {
      throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
    }
    const schedule = parseOptionalTaskScheduleEdit(input.schedule);
    const command = await createConfiguredTaskCreation(request);
    const task = await command.create({
      ...fields,
      ...(schedule === undefined ? {} : { schedule: { ...schedule, timeZone: 'Asia/Seoul' as const } }),
    });
    return Response.json(task, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 추가하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
