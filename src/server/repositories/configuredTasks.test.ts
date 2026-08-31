import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  createConfiguredTaskReader,
  createTaskRepositoryCreators,
  type TaskReader,
} from '@/server/repositories/configuredTasks';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const taskReader = (): TaskReader => ({
  listTaskCycleProjections: vi.fn(async () => []),
  getTaskCycleProjection: vi.fn(async () => null),
  getTaskAssignmentStatus: vi.fn(async () => ({ taskId: 'T1', students: [] })),
  getTaskHistoryDetail: vi.fn(async () => ({
    taskId: 'T1', requestedTaskInstanceId: null,
    currentLifecycle: { taskDefinitionExists: false, taskInstanceId: null, currentCycleStatus: null },
    cumulativeHistory: { eventCount: 0, lifecycles: [] },
  })),
  getBankTasks: vi.fn(async () => []),
});

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' };
}

describe('configured task read composition root', () => {
  it('selects PostgreSQL and composes task and cycle queries with one tenant snapshot runner', async () => {
    const withTenantSnapshot = vi.fn();
    const taskQueries = { getTasks: vi.fn(), getActiveTasks: vi.fn(), getTaskById: vi.fn() };
    const taskCycleQueries = taskReader();
    const createDatabaseTaskQueries = vi.fn(() => taskQueries);
    const createDatabaseTaskCycleQueries = vi.fn(() => taskCycleQueries);
    const createConfiguredSheetsReader = vi.fn();
    const creators = createTaskRepositoryCreators({
      createDatabaseTaskQueries,
      createDatabaseTaskCycleQueries,
      withTenantSnapshot,
      createConfiguredSheetsReader,
      sheets: {
        listTaskCycleProjections: vi.fn(), getTaskById: vi.fn(), getTaskCycleProjection: vi.fn(),
        getTaskAssignmentStatus: vi.fn(), getTaskHistoryDetail: vi.fn(), getTasks: vi.fn(),
      },
    });
    const sheetsGetter = vi.fn(() => { throw new Error('unselected Sheets creator accessed'); });
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const tasks = await createConfiguredTaskReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: activeTenant,
      creators,
    });

    expect(tasks).toBe(taskCycleQueries);
    expect(createDatabaseTaskQueries).toHaveBeenCalledWith({
      tenantId: TENANT_ID, runTenantTransaction: withTenantSnapshot,
    });
    expect(createDatabaseTaskCycleQueries).toHaveBeenCalledWith({
      tenantId: TENANT_ID, runTenantSnapshot: withTenantSnapshot, taskQueries,
    });
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
  });

  it('selects explicit Sheets lazily, reuses one reader, and offers all five route use cases', async () => {
    const request = new Request('http://localhost/api/tasks');
    const reader = { getRows: vi.fn() };
    const createConfiguredSheetsReader = vi.fn(async () => reader);
    const projected = { taskId: 'T1', isActive: true };
    const sheets = {
      listTaskCycleProjections: vi.fn(async () => [projected]),
      getTaskById: vi.fn(async () => projected),
      getTaskCycleProjection: vi.fn(async () => projected),
      getTaskAssignmentStatus: vi.fn(async () => ({ taskId: 'T1', students: [] })),
      getTaskHistoryDetail: vi.fn(async () => ({ taskId: 'T1' })),
      getTasks: vi.fn(async () => []),
    };
    const creators = createTaskRepositoryCreators({
      createDatabaseTaskQueries: vi.fn(), createDatabaseTaskCycleQueries: vi.fn(),
      withTenantSnapshot: vi.fn(), createConfiguredSheetsReader: createConfiguredSheetsReader as never,
      sheets: sheets as never,
    }, request);
    const postgresGetter = vi.fn(() => { throw new Error('unselected PostgreSQL creator accessed'); });
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(activeTenant);

    const tasks = await createConfiguredTaskReader({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await tasks.listTaskCycleProjections({ includeInactive: true });
    await tasks.getTaskCycleProjection('T1', { studentId: 'S1' });
    await tasks.getTaskAssignmentStatus('T1');
    await tasks.getTaskHistoryDetail({ taskId: 'T1' });
    await tasks.getBankTasks('2026-08-27T00:00:00.000Z');
    expect(createConfiguredSheetsReader).toHaveBeenCalledWith(request);
    expect(sheets.listTaskCycleProjections).toHaveBeenCalledWith(reader, { includeInactive: true });
    expect(sheets.getTaskById).toHaveBeenCalledWith(reader, 'T1');
    expect(sheets.getTaskCycleProjection).toHaveBeenCalledWith(reader, projected, { studentId: 'S1' });
    expect(sheets.getTaskAssignmentStatus).toHaveBeenCalledWith(reader, 'T1');
    expect(sheets.getTaskHistoryDetail).toHaveBeenCalledWith(reader, { taskId: 'T1' });
    expect(sheets.getTasks).toHaveBeenCalledWith(reader, { includeInactive: true });
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tenant context', undefined],
    ['invalid tenant UUID', { tenantId: 'bad', tenantStatus: 'ACTIVE' }],
    ['inactive tenant', { tenantId: TENANT_ID, tenantStatus: 'SUSPENDED' }],
  ])('fails closed for PostgreSQL with %s before accessing either creator', async (_label, authority) => {
    const creators = {} as Parameters<typeof createConfiguredTaskReader>[0]['creators'];
    const postgresGetter = vi.fn();
    const sheetsGetter = vi.fn();
    Object.defineProperties(creators, {
      createPostgresql: { get: postgresGetter }, createSheets: { get: sheetsGetter },
    });
    await expect(createConfiguredTaskReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => authority,
      creators,
    })).rejects.toThrow(/tenant|ACTIVE/i);
    expect(postgresGetter).not.toHaveBeenCalled();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('propagates a database read error without accessing Sheets', async () => {
    const error = new Error('database unavailable');
    const adapter = taskReader();
    vi.mocked(adapter.getBankTasks).mockRejectedValue(error);
    const createPostgresql = vi.fn(() => adapter);
    const sheetsGetter = vi.fn();
    const creators = { createPostgresql } as unknown as Parameters<typeof createConfiguredTaskReader>[0]['creators'];
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });
    const tasks = await createConfiguredTaskReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: activeTenant, creators,
    });
    await expect(tasks.getBankTasks()).rejects.toBe(error);
    expect(sheetsGetter).not.toHaveBeenCalled();
  });
});
