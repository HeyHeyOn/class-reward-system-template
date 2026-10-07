// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { createConfiguredTaskCompletion } from '@/server/repositories/configuredTaskCompletion';
import { TaskRewardCommandError } from '@/server/repositories/database/taskCompletionCommands';
import { createStudentBankSession, sealStudentBankSession, STUDENT_BANK_SESSION_COOKIE } from '@/server/studentBankSession';
import type { TenantRecord } from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { POST } from './route';

vi.mock('server-only', () => ({}));
vi.mock('@/server/repositories/configuredStudentBank', () => ({ createConfiguredStudentBankReader: vi.fn(), STUDENT_BANK_TRANSACTION_LIMIT: 100 }));
vi.mock('@/server/repositories/configuredTaskCompletion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/repositories/configuredTaskCompletion')>()),
  createConfiguredTaskCompletion: vi.fn(),
}));

const TENANT: TenantRecord = { id: '11111111-1111-4111-8111-111111111111', slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const SECRET = 'complete-route-test-secret-long-enough-12';
const OPERATION_ID = '10000000-0000-4000-8000-000000000001';
const confirmStudent = vi.fn();
const execute = vi.fn();

function cookieFor(studentId: string) {
  const scope = { tenantId: TENANT.id, cookiePath: '/api/c/class-a/bank' };
  return `${STUDENT_BANK_SESSION_COOKIE}=${sealStudentBankSession(createStudentBankSession(scope, studentId), { AUTH_SECRET: SECRET })}`;
}

function call(body: unknown, options: { cookie?: string | null; taskId?: string; url?: string; tenant?: TenantRecord | null } = {}) {
  const cookie = options.cookie === undefined ? cookieFor('S001') : options.cookie;
  const request = new Request(options.url ?? 'https://example.test/api/bank/me/tasks/T1/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const run = () => POST(request, { params: Promise.resolve({ taskId: options.taskId ?? 'T1' }) });
  return options.tenant === null ? run() : runWithTrustedTenantRequestContext({ tenant: options.tenant ?? TENANT }, run);
}

function success(operationId = OPERATION_ID) {
  return {
    task: { taskId: 'T1', title: '책 읽기', reward: 5 },
    student: { studentId: 'S001', name: '김민준' },
    tasks: [{
      taskId: 'T1', title: '책 읽기', description: '', reward: 5, sortOrder: 1,
      studentStatus: { studentId: 'S001', assigned: true, completed: true, ready: true, stage: 'COMPLETED' },
    }],
    operation: { operationId, state: 'SUCCESS' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  confirmStudent.mockResolvedValue({ status: 'FOUND', student: { studentId: 'S001', name: '김민준', balance: 105, status: 'ACTIVE' } });
  vi.mocked(createConfiguredStudentBankReader).mockResolvedValue({ confirmStudent, getTransactions: vi.fn() });
  execute.mockResolvedValue(success());
  vi.mocked(createConfiguredTaskCompletion).mockResolvedValue({ execute });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/bank/me/tasks/[taskId]/complete', () => {
  it('completes for the session student with the client operation ID and returns the new balance and tasks', async () => {
    const response = await call({ operationId: OPERATION_ID });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ requestId: expect.any(String), operationId: OPERATION_ID, taskId: 'T1', studentId: 'S001' });
    await expect(response.json()).resolves.toEqual({
      operation: { operationId: OPERATION_ID, state: 'SUCCESS' },
      task: { taskId: 'T1', title: '책 읽기', reward: 5 },
      tasks: [{ taskId: 'T1', title: '책 읽기', description: '', reward: 5, stage: 'COMPLETED', completable: false }],
      student: { name: '김민준', balance: 105 },
    });
  });

  it.each([
    [{ operationId: OPERATION_ID, studentId: 'S999' }],
    [{ operationId: OPERATION_ID, studentQr: 'S999' }],
    [{ studentId: 'S999' }],
    [{ operationId: 'not-a-uuid' }],
    [{}],
  ])('refuses bodies that name a student or lack a valid operation ID: %j', async (body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('cannot be redirected to another student through the URL', async () => {
    const response = await call({ operationId: OPERATION_ID }, { url: 'https://example.test/api/bank/me/tasks/T1/complete?studentId=S999' });
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a valid session before parsing or completing anything', async () => {
    const response = await call({ operationId: OPERATION_ID }, { cookie: null });
    expect(response.status).toBe(401);
    expect(createConfiguredTaskCompletion).not.toHaveBeenCalled();
  });

  it('does not complete for a student deactivated after login', async () => {
    confirmStudent.mockResolvedValue({ status: 'INACTIVE' });
    const response = await call({ operationId: OPERATION_ID });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['POLICY', 400, 'POLICY_FAILURE', 'NOT_ALLOWED'],
    ['SUBMISSION_REQUIRED', 400, 'POLICY_FAILURE', 'SUBMISSION_REQUIRED'],
    ['NOT_READY', 409, 'NOT_READY', undefined],
    ['OPERATION_CONFLICT', 409, 'COMPLETION_OPERATION_CONFLICT', undefined],
    ['OPERATION_PENDING', 503, 'COMPLETION_STATUS_UNKNOWN', undefined],
    ['PROVIDER_UNAVAILABLE', 503, 'COMPLETION_STATUS_UNKNOWN', undefined],
    ['CONFLICT', 503, 'COMPLETION_STATUS_UNKNOWN', undefined],
  ])('maps command error %s to %s %s', async (code, status, responseCode, reason) => {
    execute.mockRejectedValue(new TaskRewardCommandError(code as never));
    const response = await call({ operationId: OPERATION_ID });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ code: responseCode, operationId: OPERATION_ID });
    if (reason) expect(body.reason).toBe(reason);
    if (code === 'NOT_READY') {
      expect(body).toEqual({ error: '아직 완료할 수 없는 과제예요. 선생님이 확인하면 완료할 수 있어요.', code: 'NOT_READY', operationId: OPERATION_ID });
    }
    if (status === 503) expect(body.retryable).toBe(true);
  });

  it('keeps manual reconciliation terminal and non-retryable', async () => {
    const error = new Error('TASK_COMPLETION_BALANCE_OUTCOME_UNKNOWN_MANUAL_RECONCILIATION_REQUIRED');
    error.name = 'TaskCompletionReconciliationError';
    execute.mockRejectedValue(error);
    const response = await call({ operationId: OPERATION_ID });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'COMPLETION_RECONCILIATION_REQUIRED', retryable: false });
  });

  it('treats an unverifiable command result as unknown so the same operation is re-checked', async () => {
    execute.mockResolvedValue(success('20000000-0000-4000-8000-000000000002'));
    const response = await call({ operationId: OPERATION_ID });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'COMPLETION_STATUS_UNKNOWN', retryable: true });
  });

  it('still reports success when only the balance re-read fails', async () => {
    confirmStudent
      .mockResolvedValueOnce({ status: 'FOUND', student: { studentId: 'S001', name: '김민준', balance: 100, status: 'ACTIVE' } })
      .mockRejectedValueOnce(new Error('read failed'));
    const response = await call({ operationId: OPERATION_ID });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.operation).toEqual({ operationId: OPERATION_ID, state: 'SUCCESS' });
    expect(body.student).toBeUndefined();
  });

  it('honours the legacy write freeze before reading the session or body', async () => {
    vi.stubEnv('MIGRATION_READ_ONLY', 'true');
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const response = await call({ operationId: OPERATION_ID }, { tenant: null });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('MIGRATION_READ_ONLY');
    expect(createConfiguredStudentBankReader).not.toHaveBeenCalled();
  });
});
