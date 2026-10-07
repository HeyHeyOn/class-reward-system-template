import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ createTask: vi.fn() }));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { LegacyTaskWriterUnsupportedError } from '@/server/legacyTaskWriters';
import {
  createConfiguredTaskCreation,
  createTaskCreationRepositoryCreators,
} from '@/server/repositories/configuredTaskCreation';
import { createTask } from '@/server/sheetsRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const INPUT = {
  operationId: OPERATION_ID,
  taskId: 'T001',
  title: '읽기',
  description: '책 10쪽',
  reward: 100,
  isActive: true,
  sortOrder: 2,
  allowedStudentIds: ['S001', 'S002'],
  availableFrom: null,
  dueAt: '2026-09-02T00:00:00.000Z',
  prerequisiteTaskId: null,
  schedule: {
    recurrence: { type: 'WEEKLY' as const, weekdays: [1, 5] as const, time: '09:00' },
    timeZone: 'Asia/Seoul' as const,
    resetCompletionOnCycle: true,
    resetAssignmentOnCycle: false,
  },
};

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('configured task creation composition root', () => {
  it('answers PostgreSQL authority as unsupported without inspecting Sheets', async () => {
    const createSheetsStore = vi.fn();
    const createLegacyTask = vi.fn();
    const creators = createTaskCreationRepositoryCreators({
      createConfiguredSheetsStore: createSheetsStore, createTask: createLegacyTask,
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredTaskCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    await expect(command.create(INPUT)).rejects.toBeInstanceOf(LegacyTaskWriterUnsupportedError);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createSheetsStore).not.toHaveBeenCalled();
    expect(createLegacyTask).not.toHaveBeenCalled();
  });

  it('keeps Sheets lazy, forwards the exact Request, strips operationId, and preserves omitted schedule compatibility', async () => {
    const request = new Request('http://localhost/api/tasks', { method: 'POST' });
    const store = { marker: 'sheets' };
    const legacy = { taskId: 'T001', title: '읽기', description: '', reward: 1, isActive: true, sortOrder: 1, allowedStudentIds: [] };
    const createSheetsStore = vi.fn(async () => store as never);
    const createLegacyTask = vi.fn(async () => legacy);
    const creators = createTaskCreationRepositoryCreators({
      createConfiguredSheetsStore: createSheetsStore, createTask: createLegacyTask,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const input = { ...INPUT, schedule: undefined };

    const command = await createConfiguredTaskCreation({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(), creators,
    });
    expect(createSheetsStore).not.toHaveBeenCalled();
    await expect(command.create(input)).resolves.toBe(legacy);
    expect(createSheetsStore).toHaveBeenCalledWith(request);
    expect(createLegacyTask).toHaveBeenCalledWith(store, {
      taskId: 'T001', title: '읽기', description: '책 10쪽', reward: 100,
      isActive: true, sortOrder: 2, allowedStudentIds: ['S001', 'S002'],
      availableFrom: undefined, dueAt: '2026-09-02T00:00:00.000Z',
      prerequisiteTaskId: undefined,
    });
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('recognizes a decorated Request before options and rejects malformed supplied options without production fallback', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/tasks', { method: 'POST' });
    Object.defineProperties(request, {
      env: { value: { CLASS_STORE_STORAGE: 'postgresql' } },
      getCentralTenantContext: { value: vi.fn() },
      creators: { value: {} },
    });
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(createTask).mockResolvedValue({ taskId: 'T001' } as never);
    const command = await createConfiguredTaskCreation(request);
    await command.create({ ...INPUT, schedule: undefined });
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);

    await expect(createConfiguredTaskCreation({} as never)).rejects.toThrow(/invalid configured task creation options/i);
  });
});
