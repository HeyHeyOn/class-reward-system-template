import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getTasks } from '@/server/sheetsRepository';
import { GET } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ getTasks: vi.fn() }));

describe('GET /api/bank/tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('is unauthenticated, filters inactive/upcoming/expired tasks, and returns only the safe DTO', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    const common = { description: '', reward: 5, sortOrder: 1, allowedStudentIds: ['SECRET'], isActive: true };
    vi.mocked(getTasks).mockResolvedValue([
      { ...common, taskId: 'A', title: 'Available', availableFrom: '2026-08-26T00:00:00Z', dueAt: '2026-08-28T00:00:00Z', prerequisiteTaskId: 'P', taskInstanceId: 'I', schedule: { ruleVersion: 1, effectiveFrom: '2026-08-01T00:00:00Z', timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false } },
      { ...common, taskId: 'P', title: 'Prerequisite', dueAt: '2026-08-26T00:00:00Z' },
      { ...common, taskId: 'U', title: 'Upcoming', availableFrom: '2026-08-28T00:00:00Z' },
      { ...common, taskId: 'I', title: 'Inactive', isActive: false },
    ] as never);

    const request = new Request('http://localhost/api/bank/tasks');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(body).toEqual([{
      taskId: 'A', title: 'Available', description: '', reward: 5, sortOrder: 1,
      availableFrom: '2026-08-26T00:00:00Z', dueAt: '2026-08-28T00:00:00Z',
      recurrence: { type: 'NONE' }, prerequisiteTitle: 'Prerequisite',
    }]);
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(body[0]).not.toHaveProperty('prerequisiteTaskId');
    expect(body[0]).not.toHaveProperty('schedule');
    expect(body[0]).not.toHaveProperty('isActive');
  });

  it('does not expose provider or credential errors to unauthenticated callers', async () => {
    vi.mocked(createConfiguredSheetsReader).mockRejectedValue(new Error('Google range Tasks!A:ZZ credential secret'));
    const response = await GET(new Request('http://localhost/api/bank/tasks'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '과제 목록을 불러오지 못했습니다.' });
  });
});
