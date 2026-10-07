// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from './contracts';
import { createTaskLedgerRepositoryCreators } from './configuredTaskLedger';

const mocks = vi.hoisted(() => ({
  readBoard: vi.fn(), readTasks: vi.fn(), ensureTaskLedger: vi.fn(),
  withTenantSnapshot: vi.fn(), withTenantTransaction: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/transaction', () => ({
  withTenantSnapshot: mocks.withTenantSnapshot,
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock('@/server/repositories/database/taskLedger/commands', () => ({
  createTaskLedgerCommands: () => ({ readBoard: mocks.readBoard, readTasks: mocks.readTasks }),
}));
vi.mock('@/server/repositories/database/taskLedger/migration', () => ({ ensureTaskLedger: mocks.ensureTaskLedger }));

beforeEach(() => { vi.clearAllMocks(); });

describe('configured task ledger board', () => {
  it('returns the command snapshot without another initialization check or clock transaction', async () => {
    const board = { now: '2030-01-01T00:00:00.000Z', tasks: [] };
    mocks.readBoard.mockResolvedValue(board);
    const repository = await createTaskLedgerRepositoryCreators().createPostgresql({
      storage: 'postgresql', tenantId: '20000000-0000-4000-8000-000000000001' as TenantId, tenantStatus: 'ACTIVE',
    });
    expect(await repository.board()).toBe(board);
    expect(mocks.readBoard).toHaveBeenCalledOnce();
    expect(mocks.readTasks).not.toHaveBeenCalled();
    expect(mocks.ensureTaskLedger).not.toHaveBeenCalled();
    expect(mocks.withTenantSnapshot).not.toHaveBeenCalled();
    expect(mocks.withTenantTransaction).not.toHaveBeenCalled();
  });
});
