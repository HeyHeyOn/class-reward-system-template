// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';
import { padletBoardsForStudent } from '@/server/repositories/configuredPadlet';
import type { TaskCycleProjectionDto } from '@/server/repositories/sheets/taskHistoryQueries';
import { createStudentBankSession, sealStudentBankSession, STUDENT_BANK_SESSION_COOKIE } from '@/server/studentBankSession';
import type { TenantRecord } from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { GET } from './route';

vi.mock('server-only', () => ({}));
vi.mock('@/server/repositories/configuredStudentBank', () => ({ createConfiguredStudentBankReader: vi.fn(), STUDENT_BANK_TRANSACTION_LIMIT: 100 }));
vi.mock('@/server/repositories/configuredTasks', () => ({ createConfiguredTaskReader: vi.fn() }));
vi.mock('@/server/repositories/configuredPadlet', () => ({ padletBoardsForStudent: vi.fn() }));

const TENANT: TenantRecord = { id: '11111111-1111-4111-8111-111111111111', slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const SECRET = 'tasks-route-test-secret-long-enough-1234';
const confirmStudent = vi.fn();
const listTaskCycleProjections = vi.fn();

function cookieFor(studentId: string) {
  const scope = { tenantId: TENANT.id, cookiePath: '/api/c/class-a/bank' };
  return `${STUDENT_BANK_SESSION_COOKIE}=${sealStudentBankSession(createStudentBankSession(scope, studentId), { AUTH_SECRET: SECRET })}`;
}

function call(url = 'https://example.test/api/bank/me/tasks', cookie: string | null = cookieFor('S001')) {
  return runWithTrustedTenantRequestContext({ tenant: TENANT }, () => GET(new Request(url, cookie ? { headers: { cookie } } : undefined)));
}

function cycleTask(taskId: string, title: string, student: { assigned: boolean; ready?: boolean; completed?: boolean }, extra: Partial<TaskCycleProjectionDto> = {}): TaskCycleProjectionDto {
  return {
    taskId, title, description: `${title} 설명`, reward: 5, isActive: true, sortOrder: 1, allowedStudentIds: [],
    currentCycle: {
      cycleId: `c-${taskId}`, startsAt: '2026-10-01T00:00:00.000Z', endsAt: null,
      assignedStudentIds: student.assigned ? ['S001'] : [], completedStudentIds: student.completed ? ['S001'] : [],
      students: [{ studentId: 'S001', assigned: student.assigned, completed: student.completed ?? false, ready: student.ready ?? false }],
    },
    ...extra,
  } as TaskCycleProjectionDto;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  confirmStudent.mockResolvedValue({ status: 'FOUND', student: { studentId: 'S001', name: '김민준', balance: 10, status: 'ACTIVE' } });
  vi.mocked(createConfiguredStudentBankReader).mockResolvedValue({ confirmStudent, getTransactions: vi.fn() });
  vi.mocked(createConfiguredTaskReader).mockResolvedValue({ listTaskCycleProjections } as never);
  vi.mocked(padletBoardsForStudent).mockResolvedValue(new Map());
  listTaskCycleProjections.mockResolvedValue([
    cycleTask('hidden', '내 과제가 아님', { assigned: false }),
    cycleTask('done', '완료한 과제', { assigned: true, completed: true }),
    cycleTask('waiting', '기다리는 과제', { assigned: true, ready: false }),
    cycleTask('ready', '할 수 있는 과제', { assigned: true, ready: true }),
  ]);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('GET /api/bank/me/tasks', () => {
  it('lists only the session student\'s tasks from 미완료 upward, 완료 가능 first', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json() as { tasks: Array<{ taskId: string; stage: string; completable: boolean }> };
    expect(body.tasks.map((task) => [task.taskId, task.stage, task.completable])).toEqual([
      ['ready', 'READY', true], ['waiting', 'PENDING', false], ['done', 'COMPLETED', false],
    ]);
    expect(JSON.stringify(body)).not.toContain('내 과제가 아님');
    expect(listTaskCycleProjections).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'S001', includeInactive: true }));
  });

  it('reads linked Padlet boards first and tells the student where to post', async () => {
    vi.mocked(padletBoardsForStudent).mockResolvedValue(new Map([
      ['waiting', { title: '5학년 6반 칭찬 게시판', url: 'https://padlet.com/t/board-abc123def456', sectionTitle: '우리 반' }],
    ]));
    const response = await call();
    const body = await response.json() as { tasks: Array<{ taskId: string; padlet?: unknown }> };
    expect(body.tasks.find((task) => task.taskId === 'waiting')?.padlet)
      .toEqual({ title: '5학년 6반 칭찬 게시판', url: 'https://padlet.com/t/board-abc123def456', sectionTitle: '우리 반' });
    expect(body.tasks.find((task) => task.taskId === 'ready')).not.toHaveProperty('padlet');
    expect(padletBoardsForStudent).toHaveBeenCalledWith(expect.any(Request), { sync: true });
    expect(vi.mocked(padletBoardsForStudent).mock.invocationCallOrder[0])
      .toBeLessThan(listTaskCycleProjections.mock.invocationCallOrder[0]);
  });

  it('never takes the student from the query string', async () => {
    const response = await call('https://example.test/api/bank/me/tasks?studentId=S999');
    expect(response.status).toBe(200);
    expect(listTaskCycleProjections).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'S001' }));
  });

  it('requires a session', async () => {
    const response = await call('https://example.test/api/bank/me/tasks?studentId=S001', null);
    expect(response.status).toBe(401);
    expect(createConfiguredTaskReader).not.toHaveBeenCalled();
  });

  it('logs out a deactivated student without reading tasks', async () => {
    confirmStudent.mockResolvedValue({ status: 'NOT_FOUND' });
    const response = await call();
    expect(response.status).toBe(401);
    expect(listTaskCycleProjections).not.toHaveBeenCalled();
  });

  it('returns a retryable error when tasks cannot be read', async () => {
    listTaskCycleProjections.mockRejectedValue(new Error('boom'));
    const response = await call();
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('BANK_DATA_UNAVAILABLE');
  });
});
