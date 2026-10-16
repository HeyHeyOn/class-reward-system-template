// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { requestBoardLinks } from '@/server/repositories/configuredBoardLinks';
import { createStudentBankSession, sealStudentBankSession, STUDENT_BANK_SESSION_COOKIE } from '@/server/studentBankSession';
import type { TenantRecord } from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { POST } from './route';

vi.mock('server-only', () => ({}));
vi.mock('@/server/repositories/configuredStudentBank', () => ({ createConfiguredStudentBankReader: vi.fn(), STUDENT_BANK_TRANSACTION_LIMIT: 100 }));
vi.mock('@/server/repositories/configuredBoardLinks', () => ({ requestBoardLinks: vi.fn() }));

const TENANT: TenantRecord = { id: '11111111-1111-4111-8111-111111111111', slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const SECRET = 'board-ticket-route-secret-long-enough-1';
const LINK_SECRET = 'l'.repeat(40);
const confirmStudent = vi.fn();
const boardForTask = vi.fn();

function cookieFor(studentId: string) {
  const scope = { tenantId: TENANT.id, cookiePath: '/api/c/class-a/bank' };
  return `${STUDENT_BANK_SESSION_COOKIE}=${sealStudentBankSession(createStudentBankSession(scope, studentId), { AUTH_SECRET: SECRET })}`;
}

function call(body: unknown, cookie: string | null = cookieFor('S001')) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return runWithTrustedTenantRequestContext({ tenant: TENANT }, () => POST(new Request('https://example.test/api/bank/me/board-ticket', {
    method: 'POST', headers, body: JSON.stringify(body),
  })));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('DDANSSAEM_BOARD_URL', 'https://board.example');
  vi.stubEnv('DDANSSAEM_LINK_SECRET', LINK_SECRET);
  confirmStudent.mockResolvedValue({ status: 'FOUND', student: { studentId: 'S001', name: '김민준', balance: 10, status: 'ACTIVE' } });
  vi.mocked(createConfiguredStudentBankReader).mockResolvedValue({ confirmStudent, getTransactions: vi.fn() });
  boardForTask.mockResolvedValue({ boardId: 'b1', code: 'f48ggq' });
  vi.mocked(requestBoardLinks).mockReturnValue({ service: { enabled: () => true, boardForTask } as never, sub: null });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/bank/me/board-ticket', () => {
  it('gives the session student a signed 60-second way into the board their task links to', async () => {
    const response = await call({ taskId: 'T001' });
    expect(response.status).toBe(200);
    const { url } = await response.json() as { url: string };
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://board.example/f48ggq/enter');
    const [payload, signature] = parsed.searchParams.get('ticket')!.split('.');
    expect(signature).toBe(createHmac('sha256', LINK_SECRET).update(payload).digest('hex'));
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toMatchObject({ v: 1, classId: TENANT.id, studentId: 'S001', boardId: 'b1' });
    expect(boardForTask).toHaveBeenCalledWith('T001');
  });

  it('refuses without a bank session, a malformed body, or a task with no board', async () => {
    expect((await call({ taskId: 'T001' }, null)).status).toBe(401);
    expect((await call({ task: 'T001' })).status).toBe(400);
    boardForTask.mockResolvedValueOnce(null);
    const missing = await call({ taskId: 'T009' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'BOARD_NOT_FOUND' });
    vi.mocked(requestBoardLinks).mockReturnValueOnce({ service: { enabled: () => false, boardForTask } as never, sub: null });
    expect((await call({ taskId: 'T001' })).status).toBe(404);
  });

  it('does not open the board for a student no longer in the class', async () => {
    confirmStudent.mockResolvedValueOnce({ status: 'NOT_FOUND' });
    const response = await call({ taskId: 'T001' });
    expect(response.status).not.toBe(200);
    expect(boardForTask).not.toHaveBeenCalled();
  });
});
