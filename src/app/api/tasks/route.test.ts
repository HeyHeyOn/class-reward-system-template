import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createTask } from '@/server/sheetsRepository';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import type { ClassTask, TaskAssignment } from '@/domain/types';
import { GET, POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(),
  unauthorizedAdminResponse: vi.fn(() => new Response(null, { status: 401 })),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn(), createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ createTask: vi.fn() }));
vi.mock('@/server/repositories/sheets/taskHistoryQueries', () => ({ listTaskCycleProjections: vi.fn() }));

const projected = [{
  taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: true, sortOrder: 1,
  allowedStudentIds: [], currentCycle: { cycleId: 'cycle-1' },
}];

describe('GET /api/tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('rejects unauthenticated raw task projections before opening Sheets', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);

    const response = await GET(new Request('http://localhost/api/tasks'));

    expect(response.status).toBe(401);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
  });

  it('passes the request to a reader and returns active raw tasks with additive current cycle', async () => {
    const reader = {};
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue(reader as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue(projected as never);
    const request = new Request('http://localhost/api/tasks');

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(listTaskCycleProjections).toHaveBeenCalledWith(reader, {});
    await expect(response.json()).resolves.toEqual(projected);
  });

  it('passes one trimmed studentId for authoritative current-cycle status', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue(projected as never);
    const response = await GET(new Request('http://localhost/api/tasks?studentId=%20S1%20'));

    expect(response.status).toBe(200);
    expect(listTaskCycleProjections).toHaveBeenCalledWith({}, { studentId: 'S1', includeInactive: true });
  });

  it('returns only the requested student status and hides other students from the public student projection', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue([{
      ...projected[0],
      allowedStudentIds: ['S1', 'S2'],
      currentCycle: {
        cycleId: 'cycle-1', startsAt: '2026-08-25T00:00:00.000Z', endsAt: '2026-08-26T00:00:00.000Z',
        assignedStudentIds: ['S1', 'S2'], completedStudentIds: ['S2'],
        students: [
          { studentId: 'S1', assigned: true, completed: false, assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT' },
          { studentId: 'S2', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' },
        ],
      },
    }] as never);

    const response = await GET(new Request('http://localhost/api/tasks?studentId=S1'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload[0]).toEqual(expect.objectContaining({
      taskId: 'T1',
      studentStatus: { studentId: 'S1', assigned: true, completed: false },
    }));
    expect(payload[0]).not.toHaveProperty('allowedStudentIds');
    expect(payload[0]).not.toHaveProperty('currentCycle');
    expect(JSON.stringify(payload)).not.toContain('S2');
  });

  it('returns the effective pending recurrence and prerequisite completion state for the requested student', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue([
      {
        ...projected[0], taskId: 'A', title: '먼저 할 일',
        currentCycle: { cycleId: 'a-cycle', students: [{ studentId: 'S1', assigned: true, completed: false }] },
      },
      {
        ...projected[0], taskId: 'B', title: '다음 할 일', prerequisiteTaskId: 'A',
        taskInstanceId: 'internal-instance', scheduleReadWarnings: ['Tasks!A:ZZ provider detail'],
        schedule: { ruleVersion: 1, effectiveFrom: '2000-01-01T00:00:00Z', timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
        pendingSchedule: { ruleVersion: 2, effectiveFrom: '2001-01-01T00:00:00Z', timeZone: 'Asia/Seoul', recurrence: { type: 'WEEKLY', weekdays: [1, 4], time: '10:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
        currentCycle: { cycleId: 'b-cycle', students: [{ studentId: 'S1', assigned: true, completed: false }] },
      },
    ] as never);

    const response = await GET(new Request('http://localhost/api/tasks?studentId=S1'));
    const payload = await response.json();

    expect(listTaskCycleProjections).toHaveBeenCalledWith({}, { studentId: 'S1', includeInactive: true });
    expect(payload.find((task: { taskId: string }) => task.taskId === 'B')).toMatchObject({
      recurrence: { type: 'WEEKLY', weekdays: [1, 4], time: '10:00' },
      prerequisiteTaskId: 'A',
      prerequisiteTitle: '먼저 할 일',
      prerequisiteStatus: 'REQUIRED',
      prerequisiteMessage: "선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요.",
    });
    const studentTask = payload.find((task: { taskId: string }) => task.taskId === 'B');
    expect(studentTask).not.toHaveProperty('taskInstanceId');
    expect(studentTask).not.toHaveProperty('schedule');
    expect(studentTask).not.toHaveProperty('pendingSchedule');
    expect(studentTask).not.toHaveProperty('scheduleReadWarnings');
    expect(studentTask).not.toHaveProperty('currentCycle');
  });

  it('omits a relation to an unassigned prerequisite without dropping compatible task rows', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue([
      {
        ...projected[0], taskId: 'A', title: '배정되지 않은 선행 과제',
        allowedStudentIds: [],
        currentCycle: { cycleId: 'a-cycle', students: [{ studentId: 'S1', assigned: false, completed: false }] },
      },
      {
        ...projected[0], taskId: 'B', title: '다음 할 일', prerequisiteTaskId: 'A',
        currentCycle: { cycleId: 'b-cycle', students: [{ studentId: 'S1', assigned: true, completed: false }] },
      },
    ] as never);

    const response = await GET(new Request('http://localhost/api/tasks?studentId=S1'));
    const payload = await response.json();
    const dependent = payload.find((task: { taskId: string }) => task.taskId === 'B');

    expect(payload.map((task: { taskId: string }) => task.taskId)).toEqual(['A', 'B']);
    expect(dependent).not.toHaveProperty('prerequisiteTaskId');
    expect(dependent).toMatchObject({
      prerequisiteTitle: '배정되지 않은 선행 과제',
      prerequisiteStatus: 'REQUIRED',
      prerequisiteMessage: "선행 과제 '배정되지 않은 선행 과제'을(를) 먼저 완료해 주세요.",
    });
  });

  it('preserves a linked relation for an unseeded legacy student during partial assignment materialization', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    const schedule = {
      ruleVersion: 1, effectiveFrom: '2026-08-20T00:00:00.000Z', timeZone: 'UTC',
      recurrence: { type: 'DAILY' as const, time: '00:00' },
      resetAssignmentOnCycle: false, resetCompletionOnCycle: false,
    };
    const baseTask: ClassTask = {
      taskId: 'A', taskInstanceId: 'IA', title: '선행 과제', description: '', reward: 1,
      isActive: true, sortOrder: 1, allowedStudentIds: ['S1', 'S2'],
      createdAt: '2026-08-20T00:00:00.000Z', schedule,
    };
    const seed: TaskAssignment = {
      assignmentId: 'seed-s2', taskId: 'A', taskInstanceId: 'IA',
      cycleId: 'v1|IA|r1|2026-08-27T00:00:00Z', cycleStartsAt: '2026-08-27T00:00:00Z',
      cycleEndsAt: '2026-08-28T00:00:00Z', ruleVersion: 1, timeZone: 'UTC', studentId: 'S2',
      status: 'ASSIGNED', source: 'LEGACY_SEED', previousAssignmentId: '',
      createdAt: '2026-08-27T01:00:00Z', schemaVersion: 2, note: '',
    };
    const project = (value: ClassTask, assignments: TaskAssignment[] = []) => {
      const state = projectTaskCycleState({
        task: value, now: '2026-08-27T12:00:00Z', assignments, completions: [],
      });
      return {
        ...value,
        currentCycle: {
          ...state.cycle,
          transition: state.transition,
          assignedStudentIds: state.assignedStudentIds,
          completedStudentIds: state.completedStudentIds,
          students: Object.entries(state.students).map(([studentId, status]) => ({ studentId, ...status })),
        },
      };
    };
    const dependent = { ...baseTask, taskId: 'B', taskInstanceId: 'IB', title: '후행 과제', prerequisiteTaskId: 'A' };
    vi.mocked(listTaskCycleProjections).mockResolvedValue([
      project(baseTask, [seed]),
      project(dependent),
    ] as never);

    const response = await GET(new Request('http://localhost/api/tasks?studentId=S1'));
    const payload = await response.json();

    expect(payload.find((item: { taskId: string }) => item.taskId === 'B')).toMatchObject({
      prerequisiteTaskId: 'A',
      studentStatus: { studentId: 'S1', assigned: true },
    });
  });

  it('omits a relation from an unassigned dependent even when its prerequisite is assigned', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue([
      {
        ...projected[0], taskId: 'A', title: '배정된 선행 과제',
        currentCycle: { cycleId: 'a-cycle', students: [{ studentId: 'S1', assigned: true, completed: false }] },
      },
      {
        ...projected[0], taskId: 'B', title: '배정되지 않은 후행 과제', prerequisiteTaskId: 'A',
        allowedStudentIds: [],
        currentCycle: { cycleId: 'b-cycle', students: [{ studentId: 'S1', assigned: false, completed: false }] },
      },
    ] as never);

    const response = await GET(new Request('http://localhost/api/tasks?studentId=S1'));
    const payload = await response.json();
    const dependent = payload.find((task: { taskId: string }) => task.taskId === 'B');

    expect(dependent.studentStatus.assigned).toBe(false);
    expect(dependent).not.toHaveProperty('prerequisiteTaskId');
    expect(dependent).toMatchObject({
      prerequisiteTitle: '배정된 선행 과제',
      prerequisiteStatus: 'REQUIRED',
    });
  });

  it('omits a relation to a prerequisite excluded from returned cards while preserving unavailable semantics', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue([
      {
        ...projected[0], taskId: 'A', title: '비활성 선행 과제', isActive: false,
        currentCycle: { cycleId: 'a-cycle', students: [{ studentId: 'S1', assigned: true, completed: false }] },
      },
      {
        ...projected[0], taskId: 'B', title: '다음 할 일', prerequisiteTaskId: 'A',
        currentCycle: { cycleId: 'b-cycle', students: [{ studentId: 'S1', assigned: true, completed: false }] },
      },
    ] as never);

    const response = await GET(new Request('http://localhost/api/tasks?studentId=S1'));
    const payload = await response.json();
    const dependent = payload.find((task: { taskId: string }) => task.taskId === 'B');

    expect(payload.map((task: { taskId: string }) => task.taskId)).toEqual(['B']);
    expect(dependent).not.toHaveProperty('prerequisiteTaskId');
    expect(dependent).toMatchObject({
      prerequisiteTitle: '비활성 선행 과제',
      prerequisiteStatus: 'UNAVAILABLE',
      prerequisiteMessage: "선행 과제 '비활성 선행 과제'을(를) 완료할 수 없습니다. 교사에게 문의해 주세요.",
    });
  });

  it('preserves includeInactive=1 compatibility', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue(projected as never);

    const response = await GET(new Request('http://localhost/api/tasks?includeInactive=1'));

    expect(response.status).toBe(200);
    expect(listTaskCycleProjections).toHaveBeenCalledWith({}, { includeInactive: true });
  });

  it('rejects the unsupported studentId and includeInactive combination before opening Sheets', async () => {
    const response = await GET(new Request('http://localhost/api/tasks?includeInactive=1&studentId=%20S1%20'));

    expect(response.status).toBe(400);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(listTaskCycleProjections).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: '과제 조회 요청 형식이 올바르지 않습니다.' });
  });

  it.each([
    ['blank', 'http://localhost/api/tasks?studentId=%20'],
    ['duplicate', 'http://localhost/api/tasks?studentId=S1&studentId=S2'],
    ['unknown', 'http://localhost/api/tasks?unexpected=1'],
  ])('rejects %s query before opening Sheets', async (_label, url) => {
    const response = await GET(new Request(url));
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: '과제 조회 요청 형식이 올바르지 않습니다.' });
  });

  it('does not expose provider errors to unauthenticated student callers', async () => {
    vi.mocked(createConfiguredSheetsReader).mockRejectedValue(new Error('Tasks!A:ZZ credential secret'));
    const response = await GET(new Request('http://localhost/api/tasks?studentId=S1'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '과제 목록을 불러오지 못했습니다.' });
  });
});

describe('POST /api/tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('passes a strict recurring schedule to task creation', async () => {
    const store = {};
    const created = { ...projected[0], schedule: { ruleVersion: 1 } };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(createTask).mockResolvedValue(created as never);
    const request = new Request('http://localhost/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: true,
        sortOrder: 1, allowedStudentIds: ['S1'],
        schedule: {
          timeZone: 'Asia/Seoul',
          recurrence: { type: 'MONTHLY', time: '17:45', dayOfMonth: 31 },
          resetCompletionOnCycle: true,
          resetAssignmentOnCycle: false,
        },
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(createTask).toHaveBeenCalledWith(store, expect.objectContaining({
      taskId: 'T1',
      schedule: {
        timeZone: 'Asia/Seoul',
        recurrence: { type: 'MONTHLY', time: '17:45', dayOfMonth: 31 },
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: false,
      },
    }));
  });

  it('rejects malformed schedules before opening Sheets', async () => {
    const response = await POST(new Request('http://localhost/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'T1', title: 'Read', reward: 5, isActive: true, sortOrder: 1,
        schedule: { timeZone: 'Asia/Seoul', recurrence: { type: 'MONTHLY', time: '09:00', dayOfMonth: 32 }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
      }),
    }));

    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown field', { taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: true, sortOrder: 1, allowedStudentIds: [], surprise: true }],
    ['coerced reward', { taskId: 'T1', title: 'Read', description: '', reward: '5', isActive: true, sortOrder: 1, allowedStudentIds: [] }],
    ['coerced active flag', { taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: 'true', sortOrder: 1, allowedStudentIds: [] }],
    ['non-string availability', { taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: true, sortOrder: 1, allowedStudentIds: [], availableFrom: 123 }],
  ])('strictly rejects %s before opening Sheets', async (_label, body) => {
    const response = await POST(new Request('http://localhost/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('keeps omitted schedules backward compatible', async () => {
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(createTask).mockResolvedValue(projected[0] as never);

    const response = await POST(new Request('http://localhost/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: true, sortOrder: 1, allowedStudentIds: [] }),
    }));

    expect(response.status).toBe(201);
    const create = vi.mocked(createTask).mock.calls[0][1];
    expect(create).not.toHaveProperty('schedule');
  });
});
