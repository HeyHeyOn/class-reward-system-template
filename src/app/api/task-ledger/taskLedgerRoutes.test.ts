// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantAdminContextDependencies } from '@/server/tenantAuth';

const m = vi.hoisted(() => ({ access: {} as TenantAdminContextDependencies, ledger: {} as Record<string, ReturnType<typeof vi.fn>>, create: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: () => m.access }));
vi.mock('@/server/repositories/configuredTaskLedger', () => ({ createConfiguredTaskLedger: m.create }));

import { GET, PATCH, POST } from '@/app/api/c/[slug]/[...path]/route';
import { TaskLedgerError } from '@/server/repositories/database/taskLedger/store';

const A = 'e1300000-0000-4000-8000-000000000001';
const OPERATION = 'e1300000-0000-4000-8000-000000000011';
const call = (method: 'GET' | 'POST' | 'PATCH', path: string[], body?: unknown, query = '') => {
  const handler = method === 'GET' ? GET : method === 'POST' ? POST : PATCH;
  const request = new Request(`https://test.invalid/api/c/class-a/${path.join('/')}${query}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return handler(request, { params: Promise.resolve({ slug: 'class-a', path }) });
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ['ADMIN_PASSWORD', 'AUTH_SECRET', 'MIGRATION_READ_ONLY']) vi.stubEnv(key, '');
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  Object.assign(m.access, {
    findBySlug: vi.fn(async () => ({ id: A, slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' })),
    getSession: vi.fn(() => ({ subject: 'teacher', email: 'teacher@example.test', issuedAt: Date.now() })),
    findByTenantAndSubject: vi.fn(async () => ({ id: 'm', tenantId: A, userId: 'u', googleSubject: 'teacher', role: 'OWNER' })),
  });
  m.ledger = {
    board: vi.fn(async () => ({ now: '2026-10-06T00:00:00.000Z', tasks: [] })),
    setStages: vi.fn(async () => ({ tasks: [] })),
    updateTask: vi.fn(async () => ({ taskId: 'T001' })),
    history: vi.fn(async () => ({ taskId: 'T001', title: '책', entries: [], truncated: false })),
  };
  m.create.mockResolvedValue(m.ledger);
});
afterEach(() => vi.unstubAllEnvs());

describe('task ledger routes for classes', () => {
  it('serves the board and history to the class administrator', async () => {
    const board = await call('GET', ['task-ledger']);
    expect(board.status).toBe(200);
    expect(await board.json()).toEqual({ now: '2026-10-06T00:00:00.000Z', tasks: [] });
    expect(board.headers.get('cache-control')).toBe('no-store');
    expect((await call('GET', ['task-ledger', 'tasks', 'T001', 'history'])).status).toBe(200);
    expect(m.ledger.history).toHaveBeenCalledWith('T001', { limit: 50, cursor: null, studentId: '' });
  });

  it('passes bounded history filters and rejects malformed page requests before storage', async () => {
    expect((await call('GET', ['task-ledger', 'tasks', 'T001', 'history'], undefined, '?limit=25&studentId=S1')).status).toBe(200);
    expect(m.ledger.history).toHaveBeenCalledWith('T001', { limit: 25, cursor: null, studentId: 'S1' });
    for (const query of ['?limit=101', '?limit=2&limit=3', '?cursor=bad', '?studentId=%20S1'])
      expect((await call('GET', ['task-ledger', 'tasks', 'T001', 'history'], undefined, query)).status).toBe(400);
    expect(m.ledger.history).toHaveBeenCalledTimes(1);
  });

  it('passes a valid stage change and refuses an invalid one before storage, in Korean', async () => {
    const body = { operationId: OPERATION, changes: [{ taskId: 'T001', studentId: 'S1', stage: 'COMPLETED', withReward: true }] };
    expect((await call('POST', ['task-ledger', 'stages'], body)).status).toBe(200);
    expect(m.ledger.setStages).toHaveBeenCalledWith(body);
    const invalid = await call('POST', ['task-ledger', 'stages'], { operationId: OPERATION, changes: [{ taskId: 'T001', studentId: 'S1', stage: 'READY', withReward: true }] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: '보상은 완료로 바꿀 때만 지급할 수 있습니다.', code: 'INVALID_REQUEST' });
    expect(m.ledger.setStages).toHaveBeenCalledTimes(1);
  });

  it('maps ledger refusals to their status and code, and hides unexpected errors', async () => {
    m.ledger.setStages.mockRejectedValueOnce(new TaskLedgerError('TASK_NOT_FOUND', '없거나 삭제된 과제가 있어요.', 404));
    const body = { operationId: OPERATION, changes: [{ taskId: 'T009', studentId: 'S1', stage: 'READY' }] };
    const refused = await call('POST', ['task-ledger', 'stages'], body);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: '없거나 삭제된 과제가 있어요.', code: 'TASK_NOT_FOUND' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.ledger.setStages.mockRejectedValueOnce(new Error('private detail'));
    const failed = await call('POST', ['task-ledger', 'stages'], body);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('private');
    errors.mockRestore();
  });

  it('requires the class administrator', async () => {
    vi.mocked(m.access.getSession).mockReturnValueOnce(null);
    expect((await call('GET', ['task-ledger'])).status).toBe(401);
    expect(m.ledger.board).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', ['tasks', 'assignments', 'batch']],
    ['POST', ['tasks', 'completions', 'reset']],
    ['POST', ['tasks', 'schedules', 'batch']],
    ['POST', ['tasks', 'admin-completion']],
    ['POST', ['tasks', 'qr-assignment']],
    ['POST', ['tasks']],
    ['PATCH', ['tasks', 'batch']],
    ['PATCH', ['tasks', 'T001']],
    ['GET', ['tasks', 'T001', 'history']],
  ] as const)('no longer routes the earlier per-cycle task writer %s %j for classes', async (method, path) => {
    const response = await call(method, [...path], method === 'GET' ? undefined : {});
    expect(response.status).toBe(404);
  });
});
