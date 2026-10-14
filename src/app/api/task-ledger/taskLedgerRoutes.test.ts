// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantAdminContextDependencies } from '@/server/tenantAuth';
import { currentLegalRevision } from '@/lib/legalDocuments';

const m = vi.hoisted(() => ({ access: {} as TenantAdminContextDependencies, ledger: {} as Record<string, ReturnType<typeof vi.fn>>,
  create: vi.fn(), query: vi.fn(), sessionValid: true,
  padlet: {} as Record<string, ReturnType<typeof vi.fn>>, createPadlet: vi.fn(), syncPadlet: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: () => m.access }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => ({ pool: { query: m.query } }) }));
vi.mock('@/server/repositories/configuredTaskLedger', () => ({ createConfiguredTaskLedger: m.create }));
vi.mock('@/server/repositories/configuredPadlet', () => ({ createConfiguredPadlet: m.createPadlet, syncPadletBoardsIfStale: m.syncPadlet }));

import { GET, PATCH, POST } from '@/app/api/c/[slug]/[...path]/route';
import { TaskLedgerError } from '@/server/repositories/database/taskLedger/store';

const A = 'e1300000-0000-4000-8000-000000000001';
const OPERATION = 'e1300000-0000-4000-8000-000000000011';
const SESSION = { subject: 'teacher', email: 'teacher@example.test', issuedAt: Date.now(),
  accountGeneration: 'e1300000-0000-4000-8000-000000000021', sessionId: 'e1300000-0000-4000-8000-000000000022',
  agreement: currentLegalRevision().version };
const VALIDATE_SESSION_SQL = 'SELECT public.platform_validate_teacher_session($1,$2::uuid,$3::uuid,$4,$5) AS valid';
const SESSION_BINDING = [SESSION.subject, SESSION.accountGeneration, SESSION.sessionId, false, SESSION.agreement];
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
  vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
  m.sessionValid = true;
  m.query.mockImplementation(async (text: string, values: unknown[]) => {
    expect(text).toBe(VALIDATE_SESSION_SQL);
    expect(values).toEqual(SESSION_BINDING);
    return { rows: [{ valid: m.sessionValid }] };
  });
  Object.assign(m.access, {
    findBySlug: vi.fn(async () => ({ id: A, slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' })),
    getSession: vi.fn(() => SESSION),
    findByTenantAndSubject: vi.fn(async () => ({ id: 'm', tenantId: A, userId: 'u', googleSubject: 'teacher', role: 'OWNER' })),
  });
  m.ledger = {
    board: vi.fn(async () => ({ now: '2026-10-06T00:00:00.000Z', tasks: [] })),
    setStages: vi.fn(async () => ({ tasks: [] })),
    updateTask: vi.fn(async () => ({ taskId: 'T001' })),
    history: vi.fn(async () => ({ taskId: 'T001', title: '책', entries: [], truncated: false })),
  };
  m.create.mockResolvedValue(m.ledger);
  const status = { now: '2026-10-06T00:00:00.000Z', key: { saved: true, hint: '9876', readable: true }, boards: [] };
  m.padlet = {
    status: vi.fn(async () => status),
    setKey: vi.fn(async () => status),
    previewBoard: vi.fn(async () => ({ boardId: 'mvbij1byfal6f0ik', title: '칭찬', url: 'https://padlet.com/x/y-mvbij1byfal6f0ik', sections: [], postCount: 0 })),
    link: vi.fn(async () => ({ tasks: [] })),
    unlink: vi.fn(async () => ({ tasks: [] })),
    syncNow: vi.fn(async () => status),
  };
  m.createPadlet.mockResolvedValue(m.padlet);
  m.syncPadlet.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('task ledger routes for classes', () => {
  it('serves the board and history to the class administrator', async () => {
    const board = await call('GET', ['task-ledger']);
    expect(board.status).toBe(200);
    expect(await board.json()).toEqual({ now: '2026-10-06T00:00:00.000Z', tasks: [] });
    expect(board.headers.get('cache-control')).toBe('no-store');
    expect(m.syncPadlet.mock.invocationCallOrder[0]).toBeLessThan(m.ledger.board.mock.invocationCallOrder[0]);
    expect(m.query).toHaveBeenCalledExactlyOnceWith(VALIDATE_SESSION_SQL, SESSION_BINDING);
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
    expect(await invalid.json()).toEqual({ error: '보상은 완료로 바꿀 때만 지급할 수 있어요.', code: 'INVALID_REQUEST' });
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

  it('serves the Padlet link routes and refuses malformed bodies before storage', async () => {
    expect(await (await call('GET', ['task-ledger', 'padlet'])).json()).toMatchObject({ key: { hint: '9876' } });
    const address = 'https://padlet.com/gdteacher5/5-6-mvbij1byfal6f0ik';
    expect((await call('GET', ['task-ledger', 'padlet', 'preview'], undefined, `?address=${encodeURIComponent(address)}`)).status).toBe(200);
    expect(m.padlet.previewBoard).toHaveBeenCalledWith(address);
    expect((await call('POST', ['task-ledger', 'padlet', 'key'], { apiKey: ' pdltp_abcdef1234 ' })).status).toBe(200);
    expect(m.padlet.setKey).toHaveBeenCalledWith('pdltp_abcdef1234');
    expect((await call('POST', ['task-ledger', 'padlet', 'links'], { taskIds: ['T001', 'T002'], address, sectionId: 'sec_1' })).status).toBe(200);
    expect(m.padlet.link).toHaveBeenCalledWith({ taskIds: ['T001', 'T002'], address, sectionId: 'sec_1' });
    expect((await call('POST', ['task-ledger', 'padlet', 'unlink'], { taskIds: ['T001'] })).status).toBe(200);
    expect(m.padlet.unlink).toHaveBeenCalledWith(['T001']);
    expect((await call('POST', ['task-ledger', 'padlet', 'sync'], {})).status).toBe(200);
    expect(m.padlet.syncNow).toHaveBeenCalledTimes(1);

    for (const [path, body] of [
      ['key', { apiKey: 'short' }], ['key', { apiKey: 'pdltp_abcdef1234', extra: 1 }],
      ['links', { taskIds: [], address, sectionId: null }], ['links', { taskIds: ['T001'], address: '', sectionId: null }],
      ['links', { taskIds: ['T001'], address, sectionId: 'bad id!' }], ['unlink', { taskIds: 'T001' }],
    ] as const) expect((await call('POST', ['task-ledger', 'padlet', path], body)).status, path).toBe(400);
    expect(m.padlet.setKey).toHaveBeenCalledTimes(1);
    expect(m.padlet.link).toHaveBeenCalledTimes(1);
  });

  it('passes Padlet refusals through with their code', async () => {
    m.padlet.link.mockRejectedValueOnce(new TaskLedgerError('PADLET_NOT_PAYING', 'Padlet API는 유료(Gold, Platinum) 계정의 키로만 쓸 수 있어요.', 409));
    const refused = await call('POST', ['task-ledger', 'padlet', 'links'], { taskIds: ['T001'], address: 'https://padlet.com/a/b-mvbij1byfal6f0ik', sectionId: null });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'Padlet API는 유료(Gold, Platinum) 계정의 키로만 쓸 수 있어요.', code: 'PADLET_NOT_PAYING' });
  });

  it('requires the class administrator', async () => {
    vi.mocked(m.access.getSession).mockReturnValueOnce(null);
    expect((await call('GET', ['task-ledger'])).status).toBe(401);
    expect(m.ledger.board).not.toHaveBeenCalled();
  });

  it('refuses a revoked teacher session before membership lookup or ledger storage', async () => {
    m.sessionValid = false;
    const response = await call('GET', ['task-ledger']);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(m.query).toHaveBeenCalledExactlyOnceWith(VALIDATE_SESSION_SQL, SESSION_BINDING);
    expect(m.access.findByTenantAndSubject).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
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
