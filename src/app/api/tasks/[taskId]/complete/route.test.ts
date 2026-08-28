import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { completeTaskForStudent } from '@/server/sheetsRepository';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import { buildEnrichedStudentTaskProjection } from '@/server/studentTaskProjection';
import { claimPadletEvidenceForTask, PadletTaskVerificationError } from '@/server/padletTaskVerification';
import { POST } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ completeTaskForStudent: vi.fn() }));
vi.mock('@/server/repositories/sheets/taskHistoryQueries', () => ({ listTaskCycleProjections: vi.fn() }));
vi.mock('@/server/studentTaskProjection', () => ({ buildEnrichedStudentTaskProjection: vi.fn() }));
vi.mock('@/server/padletTaskVerification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/padletTaskVerification')>()),
  claimPadletEvidenceForTask: vi.fn(),
}));

const operationId = '11111111-1111-4111-8111-111111111111';
const request = (body: unknown, taskId = 'T1') => new Request(`http://localhost/api/tasks/${taskId}/complete`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const context = (taskId = 'T1') => ({ params: Promise.resolve({ taskId }) });

describe('POST /api/tasks/[taskId]/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue([]);
    vi.mocked(buildEnrichedStudentTaskProjection).mockResolvedValue([]);
    vi.mocked(claimPadletEvidenceForTask).mockResolvedValue({
      evidenceProvider: 'PADLET', evidenceBoardId: 'BOARD000000000001', evidencePostId: 'POST1',
      evidenceCreatedAt: '2026-08-27T01:00:00.000Z', evidenceAuthorFullName: '김학생',
    });
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
    const operation = vi.mocked(completeTaskForStudent).mock.calls[0]?.[3];
    if (!operation?.resolveEvidence) throw new Error('Expected completion evidence resolver.');
    await expect(operation.resolveEvidence({
      task: { taskId: 'T 1' } as never,
      student: { studentId: 'S1', name: '김학생', balance: 0, status: 'ACTIVE' },
      now: '2026-08-27T00:00:00.000Z',
    })).resolves.toMatchObject({ evidencePostId: 'POST1' });
    expect(listTaskCycleProjections).toHaveBeenCalledWith(expect.anything(), {
      studentId: 'S1', includeInactive: true, now: '2026-08-27T00:00:00.000Z',
    });
    expect(claimPadletEvidenceForTask).toHaveBeenCalledWith({
      tasks: [], taskId: 'T 1', studentId: 'S1', studentName: '김학생', operationId,
      now: '2026-08-27T00:00:00.000Z',
    });
    await operation.buildSafeProjection(
      '2026-08-27T02:00:00.000Z',
      { studentId: 'S1', name: '최신 이름', balance: 0, status: 'ACTIVE' },
    );
    expect(listTaskCycleProjections).toHaveBeenLastCalledWith(expect.anything(), {
      studentId: 'S1', includeInactive: true, now: '2026-08-27T02:00:00.000Z',
    });
    expect(buildEnrichedStudentTaskProjection).toHaveBeenCalledWith(
      [], 'S1', '최신 이름', '2026-08-27T02:00:00.000Z',
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
    ['SUBMISSION_REQUIRED', 400, {
      error: '승인된 Padlet 게시물을 제출한 뒤 다시 시도해 주세요.',
      code: 'PADLET_SUBMISSION_REQUIRED', operationId,
    }],
    ['CHECK_UNAVAILABLE', 503, {
      error: 'Padlet 게시물 확인이 일시적으로 불가능합니다.',
      code: 'PADLET_CHECK_UNAVAILABLE', operationId, retryable: true,
    }],
    ['OPERATION_CONFLICT', 409, {
      error: '같은 완료 요청의 내용이 일치하지 않습니다.',
      code: 'COMPLETION_OPERATION_CONFLICT', operationId,
    }],
    ['POLICY', 400, {
      error: '완료할 수 있는 과제가 아닙니다.', code: 'POLICY_FAILURE', operationId,
    }],
  ] as const)('maps safe Padlet verifier error %s', async (code, status, expectedBody) => {
    vi.mocked(completeTaskForStudent).mockRejectedValue(new PadletTaskVerificationError(code));
    const response = await POST(request({ studentId: 'S1', operationId }), context());
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual(expectedBody);
    expect(JSON.stringify(body)).not.toMatch(/POST1|김학생|evidenceProvider|evidencePostId/);
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
