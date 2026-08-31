import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getTasks } from '@/server/sheetsRepository';
import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';
import { buildBankTaskProjection } from '@/server/taskReadProjection';
import { GET } from './route';

vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsReader: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ getTasks: vi.fn() }));
vi.mock('@/server/repositories/configuredTasks', () => ({ createConfiguredTaskReader: vi.fn() }));

describe('GET /api/bank/tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
    vi.mocked(createConfiguredTaskReader).mockResolvedValue({
      async getBankTasks(now: string) {
        return buildBankTaskProjection(await getTasks({} as never, { includeInactive: true }), now);
      },
    } as never);
  });
  afterEach(() => vi.useRealTimers());

  it('delegates the public projection without opening Sheets directly', async () => {
    const projected = [{ taskId: 'A', title: 'Available', description: '', reward: 5, sortOrder: 1 }];
    const getBankTasks = vi.fn(async () => projected);
    vi.mocked(createConfiguredTaskReader).mockResolvedValue({ getBankTasks } as never);

    const request = new Request('http://localhost/api/bank/tasks');
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projected);
    expect(createConfiguredTaskReader).toHaveBeenCalledWith(request);
    expect(getBankTasks).toHaveBeenCalledWith('2026-08-27T00:00:00.000Z');
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(getTasks).not.toHaveBeenCalled();
  });

  it('includes a prerequisite relation when both tasks are visible', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    const common = { description: '', reward: 5, sortOrder: 1, isActive: true };
    vi.mocked(getTasks).mockResolvedValue([
      { ...common, taskId: 'A', title: 'Available', prerequisiteTaskId: 'P' },
      { ...common, taskId: 'P', title: 'Prerequisite' },
    ] as never);

    const response = await GET(new Request('http://localhost/api/bank/tasks'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0]).toMatchObject({ prerequisiteTaskId: 'P', prerequisiteTitle: 'Prerequisite' });
  });

  it.each([
    ['inactive', { isActive: false }],
    ['upcoming', { availableFrom: '2026-08-28T00:00:00Z' }],
    ['expired', { dueAt: '2026-08-26T00:00:00Z' }],
  ])('omits the relation ID when the prerequisite is %s but preserves its title', async (_state, prerequisiteOverrides) => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    const common = { description: '', reward: 5, sortOrder: 1, isActive: true };
    vi.mocked(getTasks).mockResolvedValue([
      { ...common, taskId: 'A', title: 'Available', prerequisiteTaskId: 'P' },
      { ...common, taskId: 'P', title: 'Prerequisite', ...prerequisiteOverrides },
    ] as never);

    const response = await GET(new Request('http://localhost/api/bank/tasks'));
    const body = await response.json();

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ taskId: 'A', prerequisiteTitle: 'Prerequisite' });
    expect(body[0]).not.toHaveProperty('prerequisiteTaskId');
  });

  it('omits relation metadata when the prerequisite is missing', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTasks).mockResolvedValue([{
      taskId: 'A', title: 'Available', description: '', reward: 5, sortOrder: 1,
      isActive: true, prerequisiteTaskId: 'MISSING',
    }] as never);

    const response = await GET(new Request('http://localhost/api/bank/tasks'));
    const body = await response.json();

    expect(body[0]).not.toHaveProperty('prerequisiteTaskId');
    expect(body[0]).not.toHaveProperty('prerequisiteTitle');
  });

  it('returns only the explicit public-safe task DTO', async () => {
    vi.mocked(createConfiguredSheetsReader).mockResolvedValue({} as never);
    vi.mocked(getTasks).mockResolvedValue([{
      taskId: 'A', title: 'Available', description: '', reward: 5, sortOrder: 1,
      availableFrom: '2026-08-26T00:00:00Z', dueAt: '2026-08-28T00:00:00Z', isActive: true,
      allowedStudentIds: ['SECRET'], warnings: ['PRIVATE'], cycleKey: 'CYCLE', studentId: 'STUDENT',
      taskInstanceId: 'INSTANCE', pendingSchedule: null,
      schedule: { ruleVersion: 1, effectiveFrom: '2026-08-01T00:00:00Z', timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
    }] as never);

    const request = new Request('http://localhost/api/bank/tasks');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createConfiguredTaskReader).toHaveBeenCalledWith(request);
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    expect(body).toEqual([{
      taskId: 'A', title: 'Available', description: '', reward: 5, sortOrder: 1,
      availableFrom: '2026-08-26T00:00:00Z', dueAt: '2026-08-28T00:00:00Z',
      recurrence: { type: 'NONE' },
    }]);
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(body[0]).not.toHaveProperty('schedule');
    expect(body[0]).not.toHaveProperty('pendingSchedule');
    expect(body[0]).not.toHaveProperty('warnings');
    expect(body[0]).not.toHaveProperty('allowedStudentIds');
    expect(body[0]).not.toHaveProperty('cycleKey');
    expect(body[0]).not.toHaveProperty('studentId');
    expect(body[0]).not.toHaveProperty('taskInstanceId');
    expect(body[0]).not.toHaveProperty('isActive');
  });

  it('does not expose provider or credential errors to unauthenticated callers', async () => {
    vi.mocked(createConfiguredTaskReader).mockRejectedValue(new Error('Google range Tasks!A:ZZ credential secret'));
    const response = await GET(new Request('http://localhost/api/bank/tasks'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '과제 목록을 불러오지 못했습니다.' });
  });
});
