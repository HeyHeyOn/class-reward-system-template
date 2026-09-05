import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/repositories/configuredTaskCompletion', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/repositories/configuredTaskCompletion')>(),
  createConfiguredTaskCompletion: vi.fn(),
}));

import { createConfiguredTaskCompletion } from '@/server/repositories/configuredTaskCompletion';
import { TaskRewardCommandError,
  type TaskRewardCommandErrorCode } from '@/server/repositories/database/taskCompletionCommands';
import { resolveStudentQrForCurrentTenant, StudentQrValidationError } from '@/server/studentQr';
import { POST } from './route';

vi.mock('@/server/studentQr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/studentQr')>()),
  resolveStudentQrForCurrentTenant: vi.fn(),
}));

const operationId = '11111111-1111-4111-8111-111111111111';
const task = {
  taskId: 'T 1', title: '읽기', description: '', reward: 5, sortOrder: 1,
  studentStatus: { studentId: 'S1', assigned: true, completed: true },
};
const safeResult = {
  task: { taskId: 'T 1', title: '읽기', reward: 5 },
  student: { studentId: 'S1', name: '김학생' },
  tasks: [task],
  operation: { operationId, state: 'SUCCESS' as const },
};
const execute = vi.fn();

function request(
  body: unknown,
  options: { taskId?: string; contentType?: string | null; rawBody?: string } = {},
): Request {
  const taskId = options.taskId ?? 'T%201';
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set('content-type', options.contentType ?? 'application/json');
  }
  return new Request(`http://localhost/api/tasks/${taskId}/complete`, {
    method: 'POST',
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  });
}

function context(taskId = 'T%201') {
  return { params: Promise.resolve({ taskId }) };
}

async function responseFor(body: unknown = { studentId: ' S1 ', operationId }) {
  return POST(request(body), context());
}

describe('POST /api/tasks/[taskId]/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveStudentQrForCurrentTenant).mockReturnValue({ studentId: 'S1', format: 'SIGNED' });
    execute.mockResolvedValue(safeResult);
    vi.mocked(createConfiguredTaskCompletion).mockResolvedValue({ execute });
  });

  it('resolves the body QR in the trusted tenant before selecting or executing completion authority', async () => {
    const response = await responseFor({ studentId: 'csq1.signed-token', operationId });

    expect(response.status).toBe(200);
    expect(resolveStudentQrForCurrentTenant).toHaveBeenCalledWith('csq1.signed-token');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'S1' }));
  });

  it('rejects an invalid or wrong-tenant QR without selecting completion authority', async () => {
    vi.mocked(resolveStudentQrForCurrentTenant).mockImplementation(() => { throw new StudentQrValidationError(); });
    const response = await responseFor({ studentId: 'csq1.wrong-tenant', operationId });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '학생 QR을 인식해 주세요.' });
    expect(createConfiguredTaskCompletion).not.toHaveBeenCalled();
  });

  it('resolves the configured authority once with the identical Request and executes the exact command', async () => {
    const originalRequest = request({ studentId: ' S1 ', operationId });

    const response = await POST(originalRequest, context());

    expect(response.status).toBe(200);
    expect(createConfiguredTaskCompletion).toHaveBeenCalledTimes(1);
    expect(createConfiguredTaskCompletion).toHaveBeenCalledWith(originalRequest);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      operationId,
      taskId: 'T 1',
      studentId: 'S1',
    });
    await expect(response.json()).resolves.toEqual(safeResult);
  });

  it.each<[string | null, string]>([
    [null, 'missing'],
    ['text/plain', 'wrong media type'],
    ['application/jsonp', 'JSONP'],
    ['application/json-seq', 'JSON sequence'],
  ])('rejects %s content type before parsing or resolving the root (%s)', async (contentType) => {
    const originalRequest = request({ studentId: 'S1', operationId }, { contentType });
    const json = vi.fn(() => { throw new Error('body should not be parsed'); });
    Object.defineProperty(originalRequest, 'json', { value: json });

    const response = await POST(originalRequest, context());

    expect(response.status).toBe(400);
    expect(json).not.toHaveBeenCalled();
    expect(createConfiguredTaskCompletion).not.toHaveBeenCalled();
  });

  it('accepts a trimmed case-insensitive JSON token with parameters', async () => {
    const originalRequest = request(
      { studentId: ' S1 ', operationId },
      { contentType: '  Application/JSON  ; charset=utf-8' },
    );

    const response = await POST(originalRequest, context());

    expect(response.status).toBe(200);
    expect(createConfiguredTaskCompletion).toHaveBeenCalledWith(originalRequest);
  });

  it.each([
    ['null body', null, context()],
    ['array body', [], context()],
    ['missing student', { operationId }, context()],
    ['missing operation', { studentId: 'S1' }, context()],
    ['extra body field', { studentId: 'S1', operationId, completed: true }, context()],
    ['numeric student', { studentId: 1, operationId }, context()],
    ['blank student', { studentId: '   ', operationId }, context()],
    ['blank task', { studentId: 'S1', operationId }, context('   ')],
    ['non-UUID operation', { studentId: 'S1', operationId: 'not-a-uuid' }, context()],
    ['padded operation', { studentId: 'S1', operationId: ` ${operationId}` }, context()],
    ['uppercase operation', { studentId: 'S1', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() }, context()],
    ['version 9 operation', { studentId: 'S1', operationId: '11111111-1111-9111-8111-111111111111' }, context()],
  ])('rejects malformed preflight before configured-root resolution: %s', async (_label, body, routeContext) => {
    const response = await POST(request(body), routeContext);

    expect(response.status).toBe(400);
    expect(createConfiguredTaskCompletion).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts canonical lowercase UUID version %s', async (version) => {
    const versioned = `11111111-1111-${version}111-8111-111111111111`;
    execute.mockResolvedValue({ ...safeResult, operation: { operationId: versioned, state: 'SUCCESS' } });

    const response = await responseFor({ studentId: ' S1 ', operationId: versioned });

    expect(response.status).toBe(200);
    expect(createConfiguredTaskCompletion).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operationId: versioned }));
  });

  it('catches malformed JSON, route encoding, and rejected params before resolving the root', async () => {
    const cases: Array<[Request, { params: Promise<{ taskId: string }> }]> = [
      [request(undefined, { rawBody: '{' }), context()],
      [request({ studentId: 'S1', operationId }), context('%E0%A4%A')],
      [request({ studentId: 'S1', operationId }), { params: Promise.reject(new Error('secret params')) }],
    ];

    for (const [originalRequest, routeContext] of cases) {
      const response = await POST(originalRequest, routeContext);
      expect(response.status).toBe(400);
    }
    expect(createConfiguredTaskCompletion).not.toHaveBeenCalled();
  });

  it('rejects accessor and custom-prototype payloads without invoking them', async () => {
    const getter = vi.fn(() => { throw new Error('secret getter'); });
    const accessor = { studentId: 'S1', operationId };
    Object.defineProperty(accessor, 'studentId', { enumerable: true, get: getter });
    const custom = Object.assign(Object.create({ inherited: true }), { studentId: 'S1', operationId });

    for (const body of [accessor, custom]) {
      const originalRequest = request({ studentId: 'S1', operationId });
      Object.defineProperty(originalRequest, 'json', { value: vi.fn(async () => body) });
      const response = await POST(originalRequest, context());
      expect(response.status).toBe(400);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(createConfiguredTaskCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ['완료할 수 있는 과제가 아닙니다.'],
    ["선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요."],
  ])('preserves legacy safe policy errors: %s', async (message) => {
    execute.mockRejectedValue(new Error(message));

    const response = await responseFor();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message, code: 'POLICY_FAILURE', operationId });
  });

  it.each([
    'TASK_COMPLETION_OPERATION_PAYLOAD_CONFLICT',
    'TASK_COMPLETION_OPERATION_IDENTITY_CONFLICT',
    'TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT',
  ])('preserves legacy operation conflict mapping: %s', async (message) => {
    execute.mockRejectedValue(new Error(message));

    const response = await responseFor();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '같은 완료 요청의 내용이 일치하지 않습니다.',
      code: 'COMPLETION_OPERATION_CONFLICT',
      operationId,
    });
  });

  it.each([
    'TASK_COMPLETION_BALANCE_OUTCOME_UNKNOWN_MANUAL_RECONCILIATION_REQUIRED',
    'TASK_COMPLETION_LOGICAL_OPERATION_IN_PROGRESS_MANUAL_RECONCILIATION_REQUIRED',
  ])('preserves nonretryable reconciliation mapping: %s', async (message) => {
    execute.mockRejectedValue(Object.assign(new Error(message), { name: 'TaskCompletionReconciliationError' }));

    const response = await responseFor();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '완료 상태를 자동으로 확인할 수 없습니다. 관리자에게 문의해 주세요.',
      code: 'COMPLETION_RECONCILIATION_REQUIRED',
      operationId,
      retryable: false,
    });
  });

  it.each<[TaskRewardCommandErrorCode, number, string, string, boolean | undefined]>([
    ['POLICY', 400, '완료할 수 있는 과제가 아닙니다.', 'POLICY_FAILURE', undefined],
    ['SUBMISSION_REQUIRED', 400, '과제 제출물을 찾을 수 없습니다.', 'POLICY_FAILURE', undefined],
    ['OPERATION_CONFLICT', 409, '같은 완료 요청의 내용이 일치하지 않습니다.', 'COMPLETION_OPERATION_CONFLICT', undefined],
    ['CONFLICT', 503, '완료 상태를 확인하고 있습니다.', 'COMPLETION_STATUS_UNKNOWN', true],
    ['OPERATION_PENDING', 503, '완료 상태를 확인하고 있습니다.', 'COMPLETION_STATUS_UNKNOWN', true],
    ['PROVIDER_UNAVAILABLE', 503, '완료 상태를 확인하고 있습니다.', 'COMPLETION_STATUS_UNKNOWN', true],
    ['EVIDENCE_CONFLICT', 503, '완료 상태를 확인하고 있습니다.', 'COMPLETION_STATUS_UNKNOWN', true],
  ])('maps DB command error %s without leaking its message', async (code, status, error, responseCode, retryable) => {
    const thrown = new TaskRewardCommandError(code);
    Object.defineProperty(thrown, 'message', { value: `DB secret for ${code}` });
    execute.mockRejectedValue(thrown);

    const response = await responseFor();
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body).toEqual({ error, code: responseCode, operationId, ...(retryable === undefined ? {} : { retryable }) });
    expect(JSON.stringify(body)).not.toContain('DB secret');
  });

  it.each(['root resolution secret', 'root execution secret'])('sanitizes configured-root failures without retry or fallback: %s', async (secret) => {
    if (secret.startsWith('root resolution')) {
      vi.mocked(createConfiguredTaskCompletion).mockRejectedValue(new Error(secret));
    } else {
      execute.mockRejectedValue(new Error(secret));
    }

    const response = await responseFor();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: '완료 상태를 확인하고 있습니다.', code: 'COMPLETION_STATUS_UNKNOWN', operationId, retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(createConfiguredTaskCompletion).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(secret.startsWith('root resolution') ? 0 : 1);
  });

  it('fails closed without exposing sensitive keys from malformed nested task projections', async () => {
    const getter = vi.fn(() => { throw new Error('nested secret getter'); });
    const accessorTask = { ...task };
    Object.defineProperty(accessorTask, 'title', { enumerable: true, get: getter });
    const customTask = Object.assign(Object.create({ inherited: true }), task);
    const decoratedTask = { ...task, providerToken: 'secret' };

    for (const malformedTask of [decoratedTask, accessorTask, customTask]) {
      execute.mockResolvedValue({ ...safeResult, tasks: [malformedTask] });
      const response = await responseFor();
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(JSON.stringify(body)).not.toMatch(/providerToken|nested secret|secret/);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('fails closed without exposing sensitive keys from a malformed root result', async () => {
    execute.mockResolvedValue({
      ...safeResult,
      task: { ...safeResult.task, balance: 999 },
      evidence: { providerToken: 'secret' },
    });

    const response = await responseFor();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toMatch(/balance|evidence|providerToken|secret/);
  });
});
