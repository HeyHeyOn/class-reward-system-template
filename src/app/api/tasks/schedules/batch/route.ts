import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { updateTaskSchedulesBatch } from '@/server/sheetsRepository';
import { parseOptionalTaskScheduleEdit } from '../../taskScheduleEdit';

const MAX_BATCH_TASKS = 20;
const ROOT_KEYS = new Set(['taskIds', 'schedule']);
const INVALID_REQUEST = '과제 일정 일괄 요청 형식이 올바르지 않습니다.';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  let taskIds: string[];
  let schedule: NonNullable<ReturnType<typeof parseOptionalTaskScheduleEdit>>;
  try {
    const payload: unknown = await request.json();
    if (!isPlainObject(payload)
      || Object.keys(payload).length !== ROOT_KEYS.size
      || Object.keys(payload).some((key) => !ROOT_KEYS.has(key))) {
      throw new Error(INVALID_REQUEST);
    }
    taskIds = parseExactTaskIds(payload.taskIds);
    if (!isPlainObject(payload.schedule) || payload.schedule.timeZone !== 'Asia/Seoul') {
      throw new Error(INVALID_REQUEST);
    }
    const parsedSchedule = parseOptionalTaskScheduleEdit(payload.schedule);
    if (!parsedSchedule) throw new Error(INVALID_REQUEST);
    schedule = parsedSchedule;
  } catch {
    return Response.json({ error: INVALID_REQUEST }, { status: 400 });
  }

  let store: Awaited<ReturnType<typeof createConfiguredSheetsStore>>;
  try {
    store = await createConfiguredSheetsStore(request);
  } catch {
    return Response.json({ error: '과제 저장소에 연결할 수 없습니다.' }, { status: 503 });
  }

  try {
    return Response.json(await updateTaskSchedulesBatch(store, taskIds, schedule));
  } catch {
    return Response.json({ error: '과제 일정 일괄 처리에 실패했습니다.' }, { status: 500 });
  }
}

function parseExactTaskIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_TASKS) {
    throw new Error(INVALID_REQUEST);
  }
  if (value.some((taskId) => typeof taskId !== 'string' || !taskId || taskId !== taskId.trim())) {
    throw new Error(INVALID_REQUEST);
  }
  if (new Set(value).size !== value.length) throw new Error(INVALID_REQUEST);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
