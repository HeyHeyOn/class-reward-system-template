import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { completeTaskForStudent } from '@/server/sheetsRepository';
import { POST } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ completeTaskForStudent: vi.fn() }));

const operationId = '11111111-1111-4111-8111-111111111111';
const request = (body: unknown, taskId = 'T1') => new Request(`http://localhost/api/tasks/${taskId}/complete`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const context = (taskId = 'T1') => ({ params: Promise.resolve({ taskId }) });

describe('POST /api/tasks/[taskId]/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
  });

  it('requires an immutable operation ID and returns only the safe authoritative projection', async () => {
    vi.mocked(completeTaskForStudent).mockResolvedValue({
      task: { taskId: 'T 1', title: '읽기', reward: 5, allowedStudentIds: ['SECRET'], taskInstanceId: 'SECRET' },
      student: { studentId: 'S1', name: '김학생', balance: 999, status: 'ACTIVE' },
      completion: { completionId: 'SECRET', cycleId: 'SECRET' },
      tasks: [{ taskId: 'T 1', title: '읽기', description: '', reward: 5, sortOrder: 1, studentStatus: { studentId: 'S1', assigned: true, completed: true } }],
      operation: { operationId, state: 'SUCCESS' },
    } as never);

    const response = await POST(request({ studentId: ' S1 ', operationId }, 'T%201'), context('T%201'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(completeTaskForStudent).toHaveBeenCalledWith(
      expect.anything(), 'T 1', 'S1',
      expect.objectContaining({ operationId, operationPayloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }),
    );
    expect(body).toEqual({
      task: { taskId: 'T 1', title: '읽기', reward: 5 },
      student: { studentId: 'S1', name: '김학생' },
      tasks: expect.any(Array),
      operation: { operationId, state: 'SUCCESS' },
    });
    expect(JSON.stringify(body)).not.toMatch(/allowedStudentIds|taskInstanceId|completionId|cycleId|balance|status.*ACTIVE/);
  });

  it.each([
    null,
    [],
    {},
    { studentId: 'S1' },
    { studentId: 'S1', operationId: 'not-a-uuid' },
    { studentId: 1, operationId },
    { studentId: '   ', operationId },
    { studentId: 'S1', operationId, completed: true },
  ])('rejects malformed payload before store creation', async (body) => {
    const response = await POST(request(body), context());
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('preserves definite policy errors with an explicit terminal code', async () => {
    vi.mocked(completeTaskForStudent).mockRejectedValue(new Error("선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요."));

    const response = await POST(request({ studentId: 'S1', operationId }), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요.", code: 'POLICY_FAILURE', operationId,
    });
  });

  it('returns a retryable ambiguous outcome without leaking provider errors', async () => {
    vi.mocked(createConfiguredSheetsStore).mockRejectedValue(new Error('Google credential secret for Tasks!A:ZZ'));

    const response = await POST(request({ studentId: 'S1', operationId }), context());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: '완료 상태를 확인하고 있습니다.', code: 'COMPLETION_STATUS_UNKNOWN', operationId, retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain('credential secret');
  });

  it.each([
    'TASK_COMPLETION_OPERATION_PAYLOAD_CONFLICT',
    'TASK_COMPLETION_OPERATION_IDENTITY_CONFLICT',
    'TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT',
  ])('rejects same-operation conflicts before exposing internals: %s', async (message) => {
    vi.mocked(completeTaskForStudent).mockRejectedValue(new Error(message));

    const response = await POST(request({ studentId: 'S1', operationId }), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '같은 완료 요청의 내용이 일치하지 않습니다.', code: 'COMPLETION_OPERATION_CONFLICT', operationId,
    });
  });

  it.each([
    'TASK_COMPLETION_BALANCE_OUTCOME_UNKNOWN_MANUAL_RECONCILIATION_REQUIRED',
    'TASK_COMPLETION_LOGICAL_OPERATION_IN_PROGRESS_MANUAL_RECONCILIATION_REQUIRED',
  ])('returns terminal manual reconciliation for an irreconcilable completion outcome: %s', async (message) => {
    const error = Object.assign(
      new Error(message),
      { name: 'TaskCompletionReconciliationError' },
    );
    vi.mocked(completeTaskForStudent).mockRejectedValue(error);

    const response = await POST(request({ studentId: 'S1', operationId }), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: '완료 상태를 자동으로 확인할 수 없습니다. 관리자에게 문의해 주세요.',
      code: 'COMPLETION_RECONCILIATION_REQUIRED', operationId, retryable: false,
    });
  });

  it('does not return partial 200 when the authoritative projection is malformed', async () => {
    vi.mocked(completeTaskForStudent).mockResolvedValue({
      task: { taskId: 'T1', title: '읽기', reward: 5 }, student: { studentId: 'S1', name: '김학생' },
      tasks: null, operation: { operationId, state: 'SUCCESS' },
    } as never);

    const response = await POST(request({ studentId: 'S1', operationId }), context());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'COMPLETION_STATUS_UNKNOWN', operationId });
  });
});
