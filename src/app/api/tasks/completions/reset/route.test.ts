import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredTaskResetCommand } from '@/server/repositories/configuredTaskReset';
import { POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('@/server/repositories/configuredTaskReset', () => ({
  createConfiguredTaskResetCommand: vi.fn(),
}));

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

function resetRequest(body: unknown) {
  return new Request('http://localhost/api/tasks/completions/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/completions/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('delegates the exact Request and validated command input while preserving the reset result envelope', async () => {
    const result = { taskIds: ['T1'], resetEventsAppended: 2, deletedCount: 2 };
    const resetBatch = vi.fn(async () => result);
    vi.mocked(createConfiguredTaskResetCommand).mockResolvedValue({ resetBatch });
    const request = resetRequest({ operationId: OPERATION_ID, taskIds: ['T1'] });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(createConfiguredTaskResetCommand).toHaveBeenCalledWith(request);
    expect(resetBatch).toHaveBeenCalledWith({ operationId: OPERATION_ID, taskIds: ['T1'] });
    await expect(response.json()).resolves.toEqual(result);
  });

  it.each([
    ['missing operation ID', { taskIds: ['T1'] }],
    ['uppercase operation ID', { operationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', taskIds: ['T1'] }],
    ['non-UUID operation ID', { operationId: 'operation-1', taskIds: ['T1'] }],
    ['empty task IDs', { operationId: OPERATION_ID, taskIds: [] }],
    ['non-string task ID', { operationId: OPERATION_ID, taskIds: [1] }],
    ['padded task ID', { operationId: OPERATION_ID, taskIds: [' T1'] }],
    ['duplicate task ID', { operationId: OPERATION_ID, taskIds: ['T1', 'T1'] }],
    ['extra body property', { operationId: OPERATION_ID, taskIds: ['T1'], extra: true }],
  ])('rejects %s before opening configured mutation authority', async (_label, body) => {
    const response = await POST(resetRequest(body));

    expect(response.status).toBe(400);
    expect(createConfiguredTaskResetCommand).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toHaveProperty('error');
  });

  it('preserves administrator authorization before parsing or opening mutation authority', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const request = resetRequest({ operationId: OPERATION_ID, taskIds: ['T1'] });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(createConfiguredTaskResetCommand).not.toHaveBeenCalled();
  });

  it('preserves the command error message and 400 status', async () => {
    const error = new Error('reset failed');
    vi.mocked(createConfiguredTaskResetCommand).mockResolvedValue({
      resetBatch: vi.fn(async () => { throw error; }),
    });

    const response = await POST(resetRequest({ operationId: OPERATION_ID, taskIds: ['T1'] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'reset failed' });
  });
});
