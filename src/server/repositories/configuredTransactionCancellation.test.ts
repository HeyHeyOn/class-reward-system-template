import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ cancelTransaction: vi.fn() }));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  createConfiguredTransactionCancellation,
  createTransactionCancellationRepositoryCreators,
} from '@/server/repositories/configuredTransactionCancellation';
import { cancelTransaction } from '@/server/sheetsRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  transactionId: 'TR-1',
};
const PAIR = {
  cancelledTransaction: { transactionId: 'TR-1', status: 'CANCELLED' },
  reversalTransaction: { transactionId: 'CANCEL-TR-1', status: 'CANCEL_REVERSAL' },
} as never;
const activeTenant = () => ({ tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const);

describe('configured transaction cancellation composition root', () => {
  it('keeps Sheets lazy and forwards the exact Request and cancellation arguments', async () => {
    const request = new Request('http://localhost/api/transactions/TR-1/cancel', { method: 'POST' });
    const store = { marker: 'sheets' };
    const createStore = vi.fn(async () => store as never);
    const cancelSheets = vi.fn(async () => PAIR);
    const creators = createTransactionCancellationRepositoryCreators({
      createDatabaseTransactionCommands: vi.fn(),
      createDatabaseTransactionQueries: vi.fn(),
      withTenantTransaction: vi.fn(),
      withTenantSnapshot: vi.fn(),
      createConfiguredSheetsStore: createStore,
      cancelTransaction: cancelSheets,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const cancellation = await createConfiguredTransactionCancellation({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createStore).not.toHaveBeenCalled();
    await expect(cancellation.cancel(INPUT)).resolves.toBe(PAIR);
    expect(createStore).toHaveBeenCalledWith(request);
    expect(cancelSheets).toHaveBeenCalledWith(store, INPUT.transactionId, INPUT.operationId);
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('executes and projects the full pair from the same PostgreSQL authority without Sheets fallback', async () => {
    const commandResult = {
      originalTransactionId: 'TR-1',
      reversalTransactionId: 'CANCEL-TR-1',
    };
    const cancel = vi.fn(async () => commandResult);
    const getCancellationPair = vi.fn(async () => PAIR);
    const createDatabaseTransactionCommands = vi.fn(() => ({ cancel }));
    const createDatabaseTransactionQueries = vi.fn(() => ({ getCancellationPair }));
    const withTenantTransaction = vi.fn();
    const withTenantSnapshot = vi.fn();
    const creators = createTransactionCancellationRepositoryCreators({
      createDatabaseTransactionCommands,
      createDatabaseTransactionQueries,
      withTenantTransaction,
      withTenantSnapshot,
      createConfiguredSheetsStore: vi.fn(),
      cancelTransaction: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const cancellation = await createConfiguredTransactionCancellation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: activeTenant,
      creators,
    });

    await expect(cancellation.cancel(INPUT)).resolves.toBe(PAIR);
    expect(createDatabaseTransactionCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID, runTenantTransaction: withTenantTransaction,
    });
    expect(createDatabaseTransactionQueries).toHaveBeenCalledWith({
      tenantId: TENANT_ID, runTenantTransaction: withTenantSnapshot,
    });
    expect(cancel).toHaveBeenCalledWith(INPUT);
    expect(getCancellationPair).toHaveBeenCalledWith('TR-1', 'CANCEL-TR-1');
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('retries pair projection after a successful command replay without inspecting Sheets', async () => {
    const result = { originalTransactionId: 'TR-1', reversalTransactionId: 'CANCEL-TR-1' };
    const cancel = vi.fn(async () => result);
    const projectionError = new Error('snapshot unavailable');
    const getCancellationPair = vi.fn()
      .mockRejectedValueOnce(projectionError)
      .mockResolvedValueOnce(PAIR);
    const creators = createTransactionCancellationRepositoryCreators({
      createDatabaseTransactionCommands: vi.fn(() => ({ cancel })),
      createDatabaseTransactionQueries: vi.fn(() => ({ getCancellationPair })),
      withTenantTransaction: vi.fn(), withTenantSnapshot: vi.fn(),
      createConfiguredSheetsStore: vi.fn(), cancelTransaction: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });
    const cancellation = await createConfiguredTransactionCancellation({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: activeTenant, creators,
    });

    await expect(cancellation.cancel(INPUT)).rejects.toBe(projectionError);
    await expect(cancellation.cancel(INPUT)).resolves.toBe(PAIR);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(getCancellationPair).toHaveBeenCalledTimes(2);
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('recognizes a decorated Request before considering a full-own options shape', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/transactions/TR-1/cancel', { method: 'POST' });
    Object.defineProperties(request, {
      env: { value: { CLASS_STORE_STORAGE: 'postgresql' } },
      getCentralTenantContext: { value: activeTenant },
      creators: { value: { createSheets: vi.fn(() => { throw new Error('wrong options'); }) } },
    });
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({ marker: 'store' } as never);
    vi.mocked(cancelTransaction).mockResolvedValue(PAIR);

    const cancellation = await createConfiguredTransactionCancellation(request);
    await expect(cancellation.cancel(INPUT)).resolves.toBe(PAIR);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
  });
});
