import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createTask } from '@/server/sheetsRepository';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import { parseOptionalTaskScheduleEdit } from './taskScheduleEdit';
import { parseStrictTaskFields } from './taskPayload';
import { isTaskAvailable } from '@/domain/taskAvailability';
import { resolveTaskSchedule } from '@/domain/taskSchedule';

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
    const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
    const getStudentStatus = (task: typeof tasks[number]) => {
      const directStatus = task.currentCycle?.students?.find((student) => student.studentId === studentId);
      const assigned = directStatus?.assigned
        ?? (Array.isArray(task.currentCycle?.assignedStudentIds)
          ? task.currentCycle.assignedStudentIds.includes(studentId)
          : task.allowedStudentIds.includes(studentId));
      const completed = directStatus?.completed
        ?? (Array.isArray(task.currentCycle?.completedStudentIds)
          ? task.currentCycle.completedStudentIds.includes(studentId)
          : undefined);
      return { assigned, completed };
    };
    return Response.json(tasks.filter((task) => task.isActive && isTaskAvailable(task, now)).map((task) => {
      const { assigned, completed } = getStudentStatus(task);
      const effectiveSchedule = task.schedule ? resolveTaskSchedule({
        currentSchedule: task.schedule,
        pendingSchedule: task.pendingSchedule ?? null,
        now,
      }) : undefined;
      const prerequisite = task.prerequisiteTaskId ? tasksById.get(task.prerequisiteTaskId) : undefined;
      const prerequisiteUnavailable = Boolean(task.prerequisiteTaskId
        && (!prerequisite || !prerequisite.isActive || !isTaskAvailable(prerequisite, now)));
      const prerequisiteCompleted = prerequisite ? getStudentStatus(prerequisite).completed === true : false;
      const prerequisiteTitle = prerequisite?.title ?? '선행 과제';
      const prerequisiteStatus = !task.prerequisiteTaskId
        ? undefined
        : prerequisiteUnavailable ? 'UNAVAILABLE'
          : prerequisiteCompleted ? 'SATISFIED' : 'REQUIRED';
      const prerequisiteMessage = prerequisiteStatus === 'REQUIRED'
        ? `선행 과제 '${prerequisiteTitle}'을(를) 먼저 완료해 주세요.`
        : prerequisiteStatus === 'UNAVAILABLE'
          ? `선행 과제 '${prerequisiteTitle}'을(를) 완료할 수 없습니다. 교사에게 문의해 주세요.`
          : undefined;
      return {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        reward: task.reward,
        sortOrder: task.sortOrder,
        ...(task.availableFrom ? { availableFrom: task.availableFrom } : {}),
        ...(task.dueAt ? { dueAt: task.dueAt } : {}),
        ...(effectiveSchedule ? { recurrence: effectiveSchedule.recurrence } : {}),
        ...(task.prerequisiteTaskId ? {
          prerequisiteTitle,
          prerequisiteStatus,
          ...(prerequisiteMessage ? { prerequisiteMessage } : {}),
        } : {}),
        studentStatus: {
          studentId,
          assigned,
          ...(completed === undefined ? {} : { completed }),
        },
      };
    }));
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
