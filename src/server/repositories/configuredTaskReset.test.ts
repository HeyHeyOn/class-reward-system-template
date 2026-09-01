import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  createConfiguredTaskResetCommand,
  createTaskResetCommandRepositoryCreators,
} from '@/server/repositories/configuredTaskReset';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  taskIds: ['T001', 'T002'],
} as const;
const RESULT = { taskIds: ['T001', 'T002'], resetEventsAppended: 2, deletedCount: 2 };

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

describe('configured task reset mutation composition root', () => {
  it('keeps explicit Sheets lazy and forwards the exact trimmed operationId', async () => {
    const request = new Request('http://localhost/api/tasks/completions/reset', { method: 'POST' });
    const store = { marker: 'sheets' };
    const resetTaskCompletionsBatch = vi.fn(async () => RESULT);
    const createConfiguredSheetsStore = vi.fn(async () => store as never);
    const creators = createTaskResetCommandRepositoryCreators({
      createDatabaseTaskResetCommands: vi.fn(),
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore,
      resetTaskCompletionsBatch,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const command = await createConfiguredTaskResetCommand({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    await expect(command.resetBatch({ ...INPUT, operationId: `  ${INPUT.operationId}  ` })).resolves.toBe(RESULT);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(resetTaskCompletionsBatch).toHaveBeenCalledWith(store, INPUT.taskIds, {
      operationId: INPUT.operationId,
    });
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('selects the tenant PostgreSQL command without inspecting Sheets or falling back after failure', async () => {
    const dbError = new Error('database unavailable');
    const resetBatch = vi.fn(async () => { throw dbError; });
    const createDatabaseTaskResetCommands = vi.fn(() => ({ resetBatch }));
    const createConfiguredSheetsStore = vi.fn();
    const creators = createTaskResetCommandRepositoryCreators({
      createDatabaseTaskResetCommands,
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore,
      resetTaskCompletionsBatch: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredTaskResetCommand({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });

    expect(createDatabaseTaskResetCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: expect.any(Function),
    });
    await expect(command.resetBatch(INPUT)).rejects.toBe(dbError);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });
});
