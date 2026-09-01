import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ createTask: vi.fn() }));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  createConfiguredTaskCreation,
  createTaskCreationRepositoryCreators,
} from '@/server/repositories/configuredTaskCreation';
import {
  createTaskAdminAssignmentEventId,
  createTaskAdminTaskInstanceId,
} from '@/server/repositories/database/taskAdminCommands';
import { createTask } from '@/server/sheetsRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const COMPLETED_AT = '2026-09-01T00:00:00.000Z';
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

function databaseResult() {
  return {
    ok: true as const,
    operationId: OPERATION_ID,
    action: 'CREATE' as const,
    completedAt: COMPLETED_AT,
    tasks: [{
      taskId: 'T001',
      taskInstanceId: createTaskAdminTaskInstanceId(OPERATION_ID, 'T001'),
      versionBefore: null,
      versionAfter: 1 as const,
      assignmentEventIds: ['S001', 'S002'].map((studentId) =>
        createTaskAdminAssignmentEventId(OPERATION_ID, 'T001', studentId)),
    }],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('configured task creation composition root', () => {
  it('uses active PostgreSQL authority, forwards canonical CREATE input, and projects the frozen input without rereading', async () => {
    const create = vi.fn(async () => databaseResult());
    const createDatabaseTaskAdminCommands = vi.fn(() => ({ create }));
    const runTenantTransaction = vi.fn();
    const creators = createTaskCreationRepositoryCreators({
      createDatabaseTaskAdminCommands,
      withTenantTransaction: runTenantTransaction,
      createConfiguredSheetsStore: vi.fn(),
      createTask: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredTaskCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });
    const task = await command.create(INPUT);

    expect(createDatabaseTaskAdminCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction,
    });
    expect(create).toHaveBeenCalledWith({ ...INPUT, padletBoardId: null });
    expect(task).toEqual({
      taskId: 'T001', title: '읽기', description: '책 10쪽', reward: 100,
      isActive: true, sortOrder: 2, allowedStudentIds: ['S001', 'S002'],
      dueAt: '2026-09-02T00:00:00.000Z', createdAt: COMPLETED_AT,
      taskInstanceId: createTaskAdminTaskInstanceId(OPERATION_ID, 'T001'),
      schedule: {
        ruleVersion: 1, effectiveFrom: COMPLETED_AT, timeZone: 'Asia/Seoul',
        recurrence: { type: 'WEEKLY', weekdays: [1, 5], time: '09:00' },
        resetCompletionOnCycle: true, resetAssignmentOnCycle: false,
      },
      pendingSchedule: null,
    });
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('freezes the submitted PostgreSQL operation before awaiting command execution', async () => {
    let release!: (value: ReturnType<typeof databaseResult>) => void;
    const pending = new Promise<ReturnType<typeof databaseResult>>((resolve) => { release = resolve; });
    const create = vi.fn(() => pending);
    const creators = createTaskCreationRepositoryCreators({
      createDatabaseTaskAdminCommands: vi.fn(() => ({ create })),
      withTenantTransaction: vi.fn(), createConfiguredSheetsStore: vi.fn(), createTask: vi.fn(),
    });
    const command = await createConfiguredTaskCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => activeTenant(), creators,
    });
    const input = {
      ...INPUT,
      allowedStudentIds: [...INPUT.allowedStudentIds],
      schedule: { ...INPUT.schedule, recurrence: { ...INPUT.schedule.recurrence, weekdays: [...INPUT.schedule.recurrence.weekdays] } },
    };

    const result = command.create(input);
    input.title = '변조됨';
    input.allowedStudentIds.push('S999');
    (input.schedule.recurrence.weekdays as number[]).push(3);
    release(databaseResult());

    await expect(result).resolves.toMatchObject({
      title: '읽기', allowedStudentIds: ['S001', 'S002'],
      schedule: { recurrence: { type: 'WEEKLY', weekdays: [1, 5], time: '09:00' } },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: '읽기', allowedStudentIds: ['S001', 'S002'],
    }));
  });

  it('canonicalizes optional instants before command execution and legacy projection', async () => {
    const create = vi.fn(async () => databaseResult());
    const creators = createTaskCreationRepositoryCreators({
      createDatabaseTaskAdminCommands: vi.fn(() => ({ create })),
      withTenantTransaction: vi.fn(), createConfiguredSheetsStore: vi.fn(), createTask: vi.fn(),
    });
    const command = await createConfiguredTaskCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => activeTenant(), creators,
    });

    const task = await command.create({
      ...INPUT,
      availableFrom: '2026-08-31T09:00:00+09:00',
      dueAt: '2026-09-02T00:00:00Z',
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      availableFrom: '2026-08-31T00:00:00.000Z',
      dueAt: '2026-09-02T00:00:00.000Z',
    }));
    expect(task).toMatchObject({
      availableFrom: '2026-08-31T00:00:00.000Z',
      dueAt: '2026-09-02T00:00:00.000Z',
    });
  });

  it.each([
    ['wrong action', { action: 'UPDATE' }],
    ['wrong operation', { operationId: '22222222-2222-4222-8222-222222222222' }],
    ['noncanonical completion', { completedAt: '2026-09-01T00:00:00Z' }],
    ['wrong task identity', { tasks: [{ ...databaseResult().tasks[0], taskId: 'OTHER' }] }],
    ['wrong physical identity', { tasks: [{ ...databaseResult().tasks[0], taskInstanceId: 'forged' }] }],
    ['wrong version', { tasks: [{ ...databaseResult().tasks[0], versionAfter: 2 }] }],
    ['wrong assignment evidence', { tasks: [{ ...databaseResult().tasks[0], assignmentEventIds: [] }] }],
  ])('rejects malformed PostgreSQL result evidence: %s', async (_label, patch) => {
    const raw = { ...databaseResult(), ...patch };
    const creators = createTaskCreationRepositoryCreators({
      createDatabaseTaskAdminCommands: vi.fn(() => ({ create: vi.fn(async () => raw) })) as never,
      withTenantTransaction: vi.fn(), createConfiguredSheetsStore: vi.fn(), createTask: vi.fn(),
    });
    const command = await createConfiguredTaskCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => activeTenant(), creators,
    });
    await expect(command.create(INPUT)).rejects.toThrow(/integrity/i);
  });

  it('keeps Sheets lazy, forwards the exact Request, strips operationId, and preserves omitted schedule compatibility', async () => {
    const request = new Request('http://localhost/api/tasks', { method: 'POST' });
    const store = { marker: 'sheets' };
    const legacy = { taskId: 'T001', title: '읽기', description: '', reward: 1, isActive: true, sortOrder: 1, allowedStudentIds: [] };
    const createSheetsStore = vi.fn(async () => store as never);
    const createLegacyTask = vi.fn(async () => legacy);
    const creators = createTaskCreationRepositoryCreators({
      createDatabaseTaskAdminCommands: vi.fn(), withTenantTransaction: vi.fn(),
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
