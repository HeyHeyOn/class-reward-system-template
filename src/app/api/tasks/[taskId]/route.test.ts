import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader, createConfiguredSheetsStore } from '@/server/googleSheets';
import { deleteTask, getTaskById, updateTaskDetails } from '@/server/sheetsRepository';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { getTaskCycleProjection } from '@/server/repositories/sheets/taskHistoryQueries';
import { DELETE, GET, PATCH } from './route';

vi.mock('@/server/apiAuth', () => ({ isAuthorizedAdminRequest: vi.fn(() => true), unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }) }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn(), createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ deleteTask: vi.fn(), getTaskById: vi.fn(), updateTaskDetails: vi.fn() }));
vi.mock('@/server/repositories/sheets/taskHistoryQueries', () => ({ getTaskCycleProjection: vi.fn() }));

describe('GET /api/tasks/[taskId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the request-aware reader and returns raw task fields with additive current cycle', async () => {
    const reader = {};
    const task = { taskId: 'T 1', title: 'Read', isActive: true };
    const projected = { ...task, currentCycle: { cycleId: 'cycle-1' } };
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue(reader as never);
    vi.mocked(getTaskById).mockResolvedValue(task as never);
    vi.mocked(getTaskCycleProjection).mockResolvedValue(projected as never);
    const request = new Request('http://localhost/api/tasks/T%201');

    const response = await GET(request, { params: Promise.resolve({ taskId: 'T%201' }) });

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(getTaskById).toHaveBeenCalledWith(reader, 'T 1');
    expect(getTaskCycleProjection).toHaveBeenCalledWith(reader, task, {});
    await expect(response.json()).resolves.toEqual(projected);
  });

  it('adds one trimmed studentId to the current-cycle projection', async () => {
    const task = { taskId: 'T1', isActive: true };
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTaskById).mockResolvedValue(task as never);
    vi.mocked(getTaskCycleProjection).mockResolvedValue({ ...task, currentCycle: {} } as never);
    const request = new Request('http://localhost/api/tasks/T1?studentId=%20S1%20');

    const response = await GET(request, { params: Promise.resolve({ taskId: 'T1' }) });

    expect(response.status).toBe(200);
    expect(getTaskCycleProjection).toHaveBeenCalledWith({}, task, { studentId: 'S1' });
  });

  it.each([
    ['blank', 'http://localhost/api/tasks/T1?studentId=%20'],
    ['duplicate', 'http://localhost/api/tasks/T1?studentId=S1&studentId=S2'],
    ['unknown', 'http://localhost/api/tasks/T1?history=1'],
  ])('rejects %s query before opening Sheets', async (_label, url) => {
    const response = await GET(new Request(url), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: '과제 조회 요청 형식이 올바르지 않습니다.' });
  });

  it.each([
    ['missing', null],
    ['inactive', { taskId: 'T1', isActive: false }],
  ])('returns active-only 404 for %s definitions', async (_label, task) => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTaskById).mockResolvedValue(task as never);
    const response = await GET(new Request('http://localhost/api/tasks/T1'), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(404);
    expect(getTaskCycleProjection).not.toHaveBeenCalled();
  });

  it('preserves the public 500 error response', async () => {
    vi.mocked(createConfiguredSheetsReader).mockRejectedValue(new Error('reader failed'));
    const response = await GET(new Request('http://localhost/api/tasks/T1'), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'reader failed' });
  });
});

describe('DELETE /api/tasks/[taskId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awaits params and reports only the current definition deletion with audit ledgers preserved', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(deleteTask).mockResolvedValue({ taskId: 'T 1', taskDefinitionDeleted: true, deletedCompletionCount: 0 });
    const request = new Request('http://localhost/api/tasks/T%201', { method: 'DELETE' });
    const response = await DELETE(request, { params: Promise.resolve({ taskId: 'T%201' }) });
    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(deleteTask).toHaveBeenCalledWith(store, 'T 1');
    await expect(response.json()).resolves.toEqual({ taskId: 'T 1', taskDefinitionDeleted: true, deletedCompletionCount: 0 });
  });
});

describe('PATCH /api/tasks/[taskId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  const legacyPayload = {
    title: 'Read', description: 'Ten pages', reward: 5, isActive: true, sortOrder: 2,
    allowedStudentIds: ['S1'],
  };

  it('keeps the legacy payload unchanged, awaits Next 16 params, and passes request to the store factory', async () => {
    const store = {};
    const saved = { taskId: 'T 1', ...legacyPayload };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskDetails).mockResolvedValue(saved as never);
    const request = new Request('http://localhost/api/tasks/T%201', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(legacyPayload),
    });

    const response = await PATCH(request, { params: Promise.resolve({ taskId: 'T%201' }) });

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(updateTaskDetails).toHaveBeenCalledWith(store, 'T 1', legacyPayload);
    await expect(response.json()).resolves.toEqual(saved);
  });

  it('accepts only editable schedule fields and rejects client-controlled versioning', async () => {
    const store = {};
    const schedule = {
      recurrence: { type: 'WEEKLY', time: '09:30', weekday: 2 }, timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: false,
    };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskDetails).mockResolvedValue({ taskId: 'T1', pendingSchedule: { ruleVersion: 2 } } as never);
    const request = new Request('http://localhost/api/tasks/T1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...legacyPayload, schedule }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(200);
    expect(updateTaskDetails).toHaveBeenCalledWith(store, 'T1', { ...legacyPayload, schedule });

    const invalid = new Request('http://localhost/api/tasks/T1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...legacyPayload, schedule: { ...schedule, effectiveFrom: '2000-01-01T00:00:00Z', ruleVersion: 99 } }),
    });
    const invalidResponse = await PATCH(invalid, { params: Promise.resolve({ taskId: 'T1' }) });
    expect(invalidResponse.status).toBe(400);
    expect(updateTaskDetails).toHaveBeenCalledTimes(1);
  });

  it('strictly rejects malformed schedule values with 400 before opening Sheets', async () => {
    const request = new Request('http://localhost/api/tasks/T1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...legacyPayload, schedule: { recurrence: { type: 'DAILY', time: '25:00' }, timeZone: 'UTC', resetCompletionOnCycle: true, resetAssignmentOnCycle: false } }),
    });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updateTaskDetails).not.toHaveBeenCalled();
  });

  it('requires admin authorization', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const request = new Request('http://localhost/api/tasks/T1', { method: 'PATCH' });
    const response = await PATCH(request, { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(401);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });
});
