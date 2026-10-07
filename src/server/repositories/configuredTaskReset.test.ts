import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { LegacyTaskWriterUnsupportedError } from '@/server/legacyTaskWriters';
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

  it('answers PostgreSQL authority as unsupported without inspecting Sheets', async () => {
    const createConfiguredSheetsStore = vi.fn();
    const resetTaskCompletionsBatch = vi.fn();
    const creators = createTaskResetCommandRepositoryCreators({ createConfiguredSheetsStore, resetTaskCompletionsBatch });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredTaskResetCommand({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });

    await expect(command.resetBatch(INPUT)).rejects.toBeInstanceOf(LegacyTaskWriterUnsupportedError);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(resetTaskCompletionsBatch).not.toHaveBeenCalled();
  });
});
