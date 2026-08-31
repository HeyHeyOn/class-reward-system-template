import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getTaskHistoryDetail } from '@/server/repositories/sheets/taskHistoryQueries';
import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';
import { GET } from './route';

vi.mock('@/server/apiAuth', () => ({ isAuthorizedAdminRequest: vi.fn(), unauthorizedAdminResponse: () => new Response(null, { status: 401 }) }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/repositories/sheets/taskHistoryQueries', () => ({ getTaskHistoryDetail: vi.fn() }));
vi.mock('@/server/repositories/configuredTasks', () => ({ createConfiguredTaskReader: vi.fn() }));

const dto = {
  taskId: 'T 1', requestedTaskInstanceId: null,
  currentLifecycle: { taskDefinitionExists: false, taskInstanceId: null, currentCycleStatus: null },
  cumulativeHistory: { eventCount: 1, lifecycles: [] },
};

describe('GET /api/tasks/[taskId]/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredTaskReader).mockResolvedValue({
      getTaskHistoryDetail: (filter: never) => getTaskHistoryDetail({} as never, filter),
    } as never);
  });

  it('rejects unauthenticated history before query validation or opening Sheets', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await GET(new Request('http://localhost/api/tasks/T1/history?unknown=1'), {
      params: Promise.resolve({ taskId: 'T1' }),
    });
    expect(response.status).toBe(401);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(getTaskHistoryDetail).not.toHaveBeenCalled();
  });

  it('is an authenticated reader-only Next 16 route and returns deleted-task ledger history', async () => {
    const getHistory = vi.fn(async () => dto);
    vi.mocked(createConfiguredTaskReader).mockResolvedValue({ getTaskHistoryDetail: getHistory } as never);
    const request = new Request('http://localhost/api/tasks/T%201/history');
    const response = await GET(request, { params: Promise.resolve({ taskId: 'T%201' }) });
    expect(response.status).toBe(200);
    expect(createConfiguredTaskReader).toHaveBeenCalledWith(request);
    expect(getHistory).toHaveBeenCalledWith({ taskId: 'T 1' });
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(getTaskHistoryDetail).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(dto);
  });

  it('filters an exact nonblank taskInstanceId lifecycle', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTaskHistoryDetail).mockResolvedValue({ ...dto, requestedTaskInstanceId: 'old instance' } as never);
    const response = await GET(new Request('http://localhost/api/tasks/T1/history?taskInstanceId=old%20instance'), {
      params: Promise.resolve({ taskId: 'T1' }),
    });
    expect(response.status).toBe(200);
    expect(getTaskHistoryDetail).toHaveBeenCalledWith({}, { taskId: 'T1', taskInstanceId: 'old instance' });
  });

  it('preserves surrounding characters when applying the exact lifecycle ID filter', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTaskHistoryDetail).mockResolvedValue({ ...dto, requestedTaskInstanceId: ' old ' } as never);
    const response = await GET(new Request('http://localhost/api/tasks/T1/history?taskInstanceId=%20old%20'), {
      params: Promise.resolve({ taskId: 'T1' }),
    });
    expect(response.status).toBe(200);
    expect(getTaskHistoryDetail).toHaveBeenCalledWith({}, { taskId: 'T1', taskInstanceId: ' old ' });
  });

  it.each([
    ['blank', 'http://localhost/api/tasks/T1/history?taskInstanceId=%20%20'],
    ['duplicate', 'http://localhost/api/tasks/T1/history?taskInstanceId=a&taskInstanceId=b'],
    ['unknown', 'http://localhost/api/tasks/T1/history?instanceId=a'],
  ])('rejects %s query without opening Sheets', async (_label, url) => {
    const response = await GET(new Request(url), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: '과제 기록 조회 요청 형식이 올바르지 않습니다.' });
  });

  it('returns 404 only when neither a definition nor ledger events exist', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTaskHistoryDetail).mockResolvedValue({ ...dto, cumulativeHistory: { eventCount: 0, lifecycles: [] } } as never);
    const response = await GET(new Request('http://localhost/api/tasks/T1/history'), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(404);
  });

  it('returns a provider error as 500 with its Korean message', async () => {
    vi.mocked(createConfiguredTaskReader).mockRejectedValue(new Error('Google Sheets 인증에 실패했습니다.'));
    const response = await GET(new Request('http://localhost/api/tasks/T1/history'), {
      params: Promise.resolve({ taskId: 'T1' }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Google Sheets 인증에 실패했습니다.' });
    expect(getTaskHistoryDetail).not.toHaveBeenCalled();
  });

  it('returns an unexpected repository failure as 500 with the Korean fallback message', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTaskHistoryDetail).mockRejectedValue('quota failure');
    const response = await GET(new Request('http://localhost/api/tasks/T1/history'), {
      params: Promise.resolve({ taskId: 'T1' }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '과제 기록을 불러오지 못했습니다.' });
  });
});
