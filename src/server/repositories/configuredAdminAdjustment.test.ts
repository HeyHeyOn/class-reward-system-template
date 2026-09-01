import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ bulkAdjustStudentBalances: vi.fn() }));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  createAdminAdjustmentCommandRepositoryCreators,
  createConfiguredAdminAdjustmentCommand,
} from '@/server/repositories/configuredAdminAdjustment';
import { bulkAdjustStudentBalances } from '@/server/sheetsRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  studentIds: [' S001 ', 'S002'],
  mode: 'add' as const,
  amount: 10,
};

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('configured administrator balance adjustment composition root', () => {
  it('keeps explicit Sheets lazy, forwards the exact Request and input, and normalizes balances', async () => {
    const request = new Request('http://localhost/api/students/bulk', { method: 'PATCH' });
    const store = { marker: 'sheets' };
    const sheetsResult = [
      { studentId: 'S001', balance: 20 },
      { studentId: 'S002', balance: 30 },
    ];
    const adjustSheets = vi.fn(async () => sheetsResult);
    const createSheetsStore = vi.fn(async () => store as never);
    const creators = createAdminAdjustmentCommandRepositoryCreators({
      createDatabaseAdminCommands: vi.fn(),
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore: createSheetsStore,
      bulkAdjustStudentBalances: adjustSheets,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const command = await createConfiguredAdminAdjustmentCommand({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createSheetsStore).not.toHaveBeenCalled();
    await expect(command.adjust(INPUT)).resolves.toEqual({
      students: [
        { studentId: 'S001', balanceAfter: 20 },
        { studentId: 'S002', balanceAfter: 30 },
      ],
    });
    expect(createSheetsStore).toHaveBeenCalledWith(request);
    expect(adjustSheets).toHaveBeenCalledWith(store, INPUT);
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('selects the active tenant PostgreSQL command without inspecting Sheets or falling back', async () => {
    const dbError = new Error('database unavailable');
    const adjust = vi.fn(async () => { throw dbError; });
    const createDatabaseAdminCommands = vi.fn(() => ({ adjust }));
    const createSheetsStore = vi.fn();
    const runTenantTransaction = vi.fn();
    const creators = createAdminAdjustmentCommandRepositoryCreators({
      createDatabaseAdminCommands,
      withTenantTransaction: runTenantTransaction,
      createConfiguredSheetsStore: createSheetsStore,
      bulkAdjustStudentBalances: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredAdminAdjustmentCommand({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });

    expect(createDatabaseAdminCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction,
    });
    await expect(command.adjust(INPUT)).rejects.toBe(dbError);
    expect(adjust).toHaveBeenCalledWith(INPUT);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createSheetsStore).not.toHaveBeenCalled();
  });

  it('recognizes a decorated Request before considering the options shape', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/students/bulk', { method: 'PATCH' });
    Object.defineProperties(request, {
      creators: { value: { createSheets: vi.fn(() => { throw new Error('wrong options'); }) } },
      env: { value: { CLASS_STORE_STORAGE: 'postgresql' } },
      getCentralTenantContext: { value: vi.fn(() => activeTenant()) },
    });
    const store = { marker: 'decorated-request-store' };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(bulkAdjustStudentBalances).mockResolvedValue([{ studentId: 'S001', balance: 9 }]);

    const command = await createConfiguredAdminAdjustmentCommand(request);
    await expect(command.adjust({ ...INPUT, studentIds: ['S001'] })).resolves.toEqual({
      students: [{ studentId: 'S001', balanceAfter: 9 }],
    });

    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
  });
});
