import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteTask, getTaskById, updateTaskDetails, updateTaskSchedule, updateTaskScheduleSettings } from '@/server/sheetsRepository';
import { getTaskCycleProjection } from '@/server/repositories/sheets/taskHistoryQueries';
import { parseOptionalTaskScheduleEdit } from '../taskScheduleEdit';
import { parseStrictTaskFields } from '../taskPayload';

type RouteContext = { params: Promise<{ taskId: string }> };

const FULL_EDIT_REQUIRED_KEYS = [
  'title', 'description', 'reward', 'isActive', 'sortOrder', 'allowedStudentIds',
] as const;
const FULL_EDIT_ALLOWED_KEYS = new Set([...FULL_EDIT_REQUIRED_KEYS, 'schedule', 'availableFrom', 'dueAt', 'prerequisiteTaskId']);

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

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
    const decodedTaskId = decodeURIComponent(taskId);
    const payload: unknown = await request.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
    }
    const input = payload as Record<string, unknown>;
    const keys = Object.keys(input);
    const isScheduleOnly = keys.length === 1 && keys[0] === 'schedule';
    const scheduleSettingsKeys = new Set(['schedule', 'availableFrom', 'dueAt', 'prerequisiteTaskId']);
    const isScheduleSettings = Object.hasOwn(input, 'schedule')
      && keys.every((key) => scheduleSettingsKeys.has(key));
    const isFullEdit = FULL_EDIT_REQUIRED_KEYS.every((key) => Object.hasOwn(input, key))
      && keys.every((key) => FULL_EDIT_ALLOWED_KEYS.has(key));
    if (!isScheduleSettings && !isFullEdit) {
      throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
    }
    const schedule = parseOptionalTaskScheduleEdit(input.schedule);
    const store = await createConfiguredSheetsStore(request);
    if (isScheduleOnly) {
      const task = await updateTaskSchedule(store, decodedTaskId, schedule!);
      return Response.json(task);
    }
    if (isScheduleSettings) {
      const optional = (key: 'availableFrom' | 'dueAt' | 'prerequisiteTaskId') => {
        const value = input[key];
        if (value !== null && typeof value !== 'string') throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
        return value === null ? undefined : value;
      };
      const task = await updateTaskScheduleSettings(store, decodedTaskId, {
        schedule: schedule!,
        ...(Object.hasOwn(input, 'availableFrom') ? { availableFrom: optional('availableFrom') } : {}),
        ...(Object.hasOwn(input, 'dueAt') ? { dueAt: optional('dueAt') } : {}),
        ...(Object.hasOwn(input, 'prerequisiteTaskId') ? { prerequisiteTaskId: optional('prerequisiteTaskId') } : {}),
      });
      return Response.json(task);
    }
    const source = input;
    const update = {
      ...parseStrictTaskFields(source, 'update'),
      ...(schedule === undefined ? {} : { schedule }),
    };
    const task = await updateTaskDetails(store, decodedTaskId, update);
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
