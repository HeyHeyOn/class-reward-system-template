import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { createTask } from '@/server/sheetsRepository';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
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
  beforeEach(() => vi.clearAllMocks());

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
    expect(listTaskCycleProjections).toHaveBeenCalledWith({}, { studentId: 'S1' });
  });

  it('preserves includeInactive=1 compatibility', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue(projected as never);

    const response = await GET(new Request('http://localhost/api/tasks?includeInactive=1'));

    expect(response.status).toBe(200);
    expect(listTaskCycleProjections).toHaveBeenCalledWith({}, { includeInactive: true });
  });

  it('combines includeInactive=1 with a student projection', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue(projected as never);

    const response = await GET(new Request('http://localhost/api/tasks?includeInactive=1&studentId=%20S1%20'));

    expect(response.status).toBe(200);
    expect(listTaskCycleProjections).toHaveBeenCalledWith({}, { includeInactive: true, studentId: 'S1' });
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

  it('preserves the public 500 error response', async () => {
    vi.mocked(createConfiguredSheetsReader).mockRejectedValue(new Error('reader failed'));
    const response = await GET(new Request('http://localhost/api/tasks'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'reader failed' });
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
