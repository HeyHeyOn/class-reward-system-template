import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { updateTaskAssignmentsBatch } from '@/server/sheetsRepository';
import { POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ updateTaskAssignmentsBatch: vi.fn() }));

const operations = [{ studentId: 'S1', assigned: true, completed: false, source: 'ADMIN' as const }];
const targets = [{ taskId: 'T1', operations }];
function request(body: unknown) {
  return new Request('http://localhost/api/tasks/assignments/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/assignments/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('authorizes before parsing or opening Sheets', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await POST(new Request('http://localhost/api/tasks/assignments/batch', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('uses one request store and returns the honest partial result unchanged', async () => {
    const store = {};
    const result = { appliedCount: 1, failures: [{ taskId: 'T2', studentId: 'S1', code: 'OPERATION_FAILED' as const }] };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskAssignmentsBatch).mockResolvedValue(result);
    const sparseTargets = [
      { taskId: 'T1', operations },
      { taskId: 'T2', operations: [{ studentId: 'S2', completed: true, source: 'ADMIN' as const }] },
    ];
    const input = request({ targets: sparseTargets });

    const response = await POST(input);

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledTimes(1);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(input);
    expect(updateTaskAssignmentsBatch).toHaveBeenCalledWith(store, sparseTargets);
    await expect(response.json()).resolves.toEqual(result);
  });

  it.each([
    ['unknown root key', { targets, transaction: true }],
    ['empty targets', { targets: [] }],
    ['duplicate task ID', { targets: [targets[0], targets[0]] }],
    ['too many targets', { targets: Array.from({ length: 21 }, (_, index) => ({ taskId: `T${index}`, operations })) }],
    ['empty operations', { targets: [{ taskId: 'T1', operations: [] }] }],
    ['too many operations', { targets: [{ taskId: 'T1', operations: Array.from({ length: 41 }, (_, index) => ({ studentId: `S${index}`, assigned: true, source: 'ADMIN' })) }] }],
    ['too many total operations', { targets: [40, 40, 21].map((count, task) => ({ taskId: `T${task}`, operations: Array.from({ length: count }, (_, index) => ({ studentId: `S${index}`, assigned: true, source: 'ADMIN' })) })) }],
    ['unknown operation key', { targets: [{ taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN', note: 'x' }] }] }],
    ['missing boolean', { targets: [{ taskId: 'T1', operations: [{ studentId: 'S1', source: 'ADMIN' }] }] }],
    ['wrong source', { targets: [{ taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, source: 'QR' }] }] }],
    ['duplicate operation in target', { targets: [{ taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN' }, { studentId: 'S1', assigned: true, source: 'ADMIN' }] }] }],
  ])('rejects %s before opening Sheets', async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updateTaskAssignmentsBatch).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 total operations at the route boundary', async () => {
    const store = {};
    const exactLimitTargets = [40, 40, 20].map((count, task) => ({
      taskId: `T${task}`,
      operations: Array.from({ length: count }, (_, index) => ({
        studentId: `S${index}`, assigned: true, source: 'ADMIN' as const,
      })),
    }));
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateTaskAssignmentsBatch).mockResolvedValue({ appliedCount: 0, failures: [] });

    const response = await POST(request({ targets: exactLimitTargets }));

    expect(response.status).toBe(200);
    expect(updateTaskAssignmentsBatch).toHaveBeenCalledWith(store, exactLimitTargets);
  });

  it('sanitizes store and provider failures without leaking secrets or ranges', async () => {
    vi.mocked(createConfiguredSheetsStore).mockRejectedValueOnce(new Error('token=private A1:Z999'));
    const storeResponse = await POST(request({ targets }));
    expect(storeResponse.status).toBe(503);
    expect(JSON.stringify(await storeResponse.json())).not.toMatch(/private|A1:Z999/);

    vi.mocked(createConfiguredSheetsStore).mockResolvedValueOnce({} as never);
    vi.mocked(updateTaskAssignmentsBatch).mockRejectedValueOnce(new Error('sheet secret Tasks!A1:Z999'));
    const commandResponse = await POST(request({ targets }));
    expect(commandResponse.status).toBe(500);
    expect(JSON.stringify(await commandResponse.json())).not.toMatch(/secret|A1:Z999/);
  });
});
