import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createTask } from '@/server/sheetsRepository';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import { parseOptionalTaskScheduleEdit } from './taskScheduleEdit';

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
      ...(includeInactive ? { includeInactive: true } : {}),
      ...(studentId ? { studentId } : {}),
    });
    if (!studentId) return Response.json(tasks);
    return Response.json(tasks.map((task) => {
      const { allowedStudentIds, currentCycle, ...publicTask } = task;
      const directStatus = currentCycle?.students?.find((student) => student.studentId === studentId);
      const hasAssignedCycleStatus = Array.isArray(currentCycle?.assignedStudentIds);
      const hasCompletedCycleStatus = Array.isArray(currentCycle?.completedStudentIds);
      const assigned = directStatus?.assigned
        ?? (hasAssignedCycleStatus
          ? currentCycle.assignedStudentIds.includes(studentId)
          : allowedStudentIds.includes(studentId));
      const completed = directStatus?.completed
        ?? (hasCompletedCycleStatus ? currentCycle.completedStudentIds.includes(studentId) : undefined);
      return {
        ...publicTask,
        ...(currentCycle ? {
          currentCycle: {
            cycleId: currentCycle.cycleId,
            startsAt: currentCycle.startsAt,
            endsAt: currentCycle.endsAt,
            transition: currentCycle.transition,
          },
        } : {}),
        studentStatus: {
          studentId,
          assigned,
          ...(completed === undefined ? {} : { completed }),
        },
      };
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 목록을 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const payload = await request.json();
    const schedule = parseOptionalTaskScheduleEdit(payload.schedule);
    const store = await createConfiguredSheetsStore(request);
    const task = await createTask(store, {
      taskId: String(payload.taskId ?? ''),
      title: String(payload.title ?? ''),
      description: String(payload.description ?? ''),
      reward: Number(payload.reward),
      isActive: Boolean(payload.isActive),
      sortOrder: Number(payload.sortOrder),
      allowedStudentIds: Array.isArray(payload.allowedStudentIds) ? payload.allowedStudentIds.map((id: unknown) => String(id)) : [],
      ...(schedule === undefined ? {} : { schedule }),
    });
    return Response.json(task, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제를 추가하지 못했습니다.';
    return Response.json({ error: message }, { status: 400 });
  }
}
