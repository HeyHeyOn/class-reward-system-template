import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { updateTaskSchedulesBatch } from '@/server/sheetsRepository';
import { POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ updateTaskSchedulesBatch: vi.fn() }));

const schedule = {
  recurrence: { type: 'DAILY', time: '08:00' },
  timeZone: 'Asia/Seoul',
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: false,
};

function request(body: unknown) {
  return new Request('http://localhost/api/tasks/schedules/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/schedules/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('authorizes before parsing or opening Sheets', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await POST(new Request('http://localhost/api/tasks/schedules/batch', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('opens one request-aware store and applies exact task IDs with a complete Seoul schedule', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskSchedulesBatch).mockResolvedValue({ updatedTaskIds: ['T1', 'T2'] });
    const input = request({ taskIds: ['T1', 'T2'], schedule });

    const response = await POST(input);

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledTimes(1);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(input);
    expect(updateTaskSchedulesBatch).toHaveBeenCalledWith(store, ['T1', 'T2'], schedule);
    await expect(response.json()).resolves.toEqual({ updatedTaskIds: ['T1', 'T2'] });
  });

  it.each([
    ['unknown root key', { taskIds: ['T1'], schedule, extra: true }],
    ['missing schedule', { taskIds: ['T1'] }],
    ['empty IDs', { taskIds: [], schedule }],
    ['non-string ID', { taskIds: [1], schedule }],
    ['blank ID', { taskIds: [' '], schedule }],
    ['duplicate ID', { taskIds: ['T1', 'T1'], schedule }],
    ['too many IDs', { taskIds: Array.from({ length: 21 }, (_, index) => `T${index}`), schedule }],
    ['wrong timezone', { taskIds: ['T1'], schedule: { ...schedule, timeZone: 'UTC' } }],
    ['incomplete schedule', { taskIds: ['T1'], schedule: { recurrence: schedule.recurrence } }],
  ])('rejects %s before opening Sheets', async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updateTaskSchedulesBatch).not.toHaveBeenCalled();
  });

  it('sanitizes store and command failures without leaking provider details', async () => {
    vi.mocked(createConfiguredSheetsStore).mockRejectedValueOnce(new Error('oauth-secret Tasks!A1:Z99'));
    const storeResponse = await POST(request({ taskIds: ['T1'], schedule }));
    expect(storeResponse.status).toBe(503);
    expect(JSON.stringify(await storeResponse.json())).not.toMatch(/oauth-secret|A1:Z99/);

    vi.mocked(createConfiguredSheetsStore).mockResolvedValueOnce({} as never);
    vi.mocked(updateTaskSchedulesBatch).mockRejectedValueOnce(new Error('provider-secret B2:Q22'));
    const commandResponse = await POST(request({ taskIds: ['T1'], schedule }));
    expect(commandResponse.status).toBe(500);
    expect(JSON.stringify(await commandResponse.json())).not.toMatch(/provider-secret|B2:Q22/);
  });
});
