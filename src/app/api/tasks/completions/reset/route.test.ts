import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { resetTaskCompletionsBatch } from '@/server/sheetsRepository';
import { POST } from './route';

vi.mock('@/server/apiAuth', () => ({ isAuthorizedAdminRequest: () => true, unauthorizedAdminResponse: () => new Response(null, { status: 401 }) }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ resetTaskCompletionsBatch: vi.fn() }));

describe('POST /api/tasks/completions/reset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('truthfully reports appended reset events while retaining the compatibility property', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(resetTaskCompletionsBatch).mockResolvedValue({ taskIds: ['T1'], resetEventsAppended: 2, deletedCount: 2 });
    const request = new Request('http://localhost/api/tasks/completions/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskIds: ['T1'] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    await expect(response.json()).resolves.toEqual({ taskIds: ['T1'], resetEventsAppended: 2, deletedCount: 2 });
  });
});
