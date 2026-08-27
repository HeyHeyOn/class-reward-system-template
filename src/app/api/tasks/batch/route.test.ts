import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { updateTaskDetailsBatch } from '@/server/sheetsRepository';
import { PATCH } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ deleteTasksBatch: vi.fn(), updateTaskDetailsBatch: vi.fn() }));

const legacyTask = {
  taskId: 'T1', title: 'Read', description: '', reward: 5, isActive: true, sortOrder: 1,
  allowedStudentIds: ['S1'],
};
const schedule = {
  recurrence: { type: 'DAILY', time: '08:00' }, timeZone: 'Asia/Seoul',
  resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
};

describe('PATCH /api/tasks/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('passes the request-aware store, preserves legacy payload shape, and returns the legacy result unchanged', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskDetailsBatch).mockResolvedValue([legacyTask] as never);
    const request = new Request('http://localhost/api/tasks/batch', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tasks: [legacyTask] }),
    });
    const response = await PATCH(request);
    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(updateTaskDetailsBatch).toHaveBeenCalledWith(store, [legacyTask]);
    await expect(response.json()).resolves.toEqual([legacyTask]);
  });

  it('parses schedule edits and lets the queued repository supply one canonical editedAt for the batch', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskDetailsBatch).mockResolvedValue([]);
    const tasks = [
      { ...legacyTask, schedule },
      { ...legacyTask, taskId: 'T2', schedule: { ...schedule, recurrence: { type: 'NONE' } } },
    ];
    const request = new Request('http://localhost/api/tasks/batch', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tasks }),
    });
    const response = await PATCH(request);
    expect(response.status).toBe(200);
    const [passedStore, passedTasks] = vi.mocked(updateTaskDetailsBatch).mock.calls[0];
    expect(passedStore).toBe(store);
    expect(passedTasks).toEqual(tasks);
    expect(vi.mocked(updateTaskDetailsBatch).mock.calls[0]).toHaveLength(2);
  });

  it.each([
    ['unknown field', { ...schedule, effectiveFrom: '2000-01-01T00:00:00Z' }],
    ['bad recurrence', { ...schedule, recurrence: { type: 'WEEKLY', time: '08:00', weekdays: [0] } }],
    ['bad flags', { ...schedule, resetCompletionOnCycle: 'true' }],
  ])('rejects %s with 400 before opening Sheets', async (_label, invalidSchedule) => {
    const request = new Request('http://localhost/api/tasks/batch', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ ...legacyTask, schedule: invalidSchedule }] }),
    });
    const response = await PATCH(request);
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updateTaskDetailsBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['extra root key', { tasks: [legacyTask], extra: true }],
    ['array root', [legacyTask]],
    ['null root', null],
    ['missing tasks', {}],
  ])('rejects %s before opening Sheets', async (_label, body) => {
    const response = await PATCH(new Request('http://localhost/api/tasks/batch', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updateTaskDetailsBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['numeric taskId', 1],
    ['object taskId', { value: 'T1' }],
  ])('rejects %s before opening Sheets', async (_label, taskId) => {
    const response = await PATCH(new Request('http://localhost/api/tasks/batch', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ ...legacyTask, taskId }] }),
    }));
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('requires admin authorization', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await PATCH(new Request('http://localhost/api/tasks/batch', { method: 'PATCH' }));
    expect(response.status).toBe(401);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });
});
