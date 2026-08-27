import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { completeTaskForStudent } from '@/server/sheetsRepository';
import { POST } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ completeTaskForStudent: vi.fn() }));

describe('POST /api/tasks/[taskId]/complete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awaits Next 16 params and delegates the BANK completion command', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(completeTaskForStudent).mockResolvedValue({} as never);
    const response = await POST(new Request('http://localhost/api/tasks/T%201/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentId: ' S1 ' }),
    }), { params: Promise.resolve({ taskId: 'T%201' }) });
    expect(response.status).toBe(200);
    expect(completeTaskForStudent).toHaveBeenCalledWith(store, 'T 1', 'S1');
  });

  it.each([
    null,
    [],
    {},
    { studentId: 1 },
    { studentId: '   ' },
    { studentId: 'S1', completed: true },
    { studentId: 'S1', taskId: 'T1' },
  ])('rejects malformed payload before store creation', async (body) => {
    const response = await POST(new Request('http://localhost/api/tasks/T1/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('preserves safe policy errors for student guidance', async () => {
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(completeTaskForStudent).mockRejectedValue(new Error("선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요."));
    const response = await POST(new Request('http://localhost/api/tasks/T1/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentId: 'S1' }),
    }), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "선행 과제 '먼저 할 일'을(를) 먼저 완료해 주세요." });
  });

  it('does not expose provider errors to unauthenticated callers', async () => {
    vi.mocked(createConfiguredSheetsStore).mockRejectedValue(new Error('Google credential secret for Tasks!A:ZZ'));
    const response = await POST(new Request('http://localhost/api/tasks/T1/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ studentId: 'S1' }),
    }), { params: Promise.resolve({ taskId: 'T1' }) });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '과제 완료 처리에 실패했습니다.' });
  });
});
