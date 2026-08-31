import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { Student, Transaction } from '@/domain/types';
import {
  createBankRepositoryCreators,
  createConfiguredBankReader,
} from '@/server/repositories/configuredBank';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const STUDENT: Student = { studentId: 'S1', name: '학생', balance: 100, status: 'ACTIVE' };
const TRANSACTION: Transaction = {
  transactionId: 'T1', timestamp: '2026-09-01T00:00:00.000Z', studentId: 'S1',
  studentName: '학생', items: [], totalAmount: 10, balanceBefore: 90, balanceAfter: 100,
  status: 'TASK_REWARD', operator: 'task',
};

function activeTenant(overrides: Record<string, unknown> = {}) {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE', ...overrides };
}

describe('configured bank read composition root', () => {
  it('reads balance student and transactions in one PostgreSQL tenant snapshot', async () => {
    const transaction = { marker: 'snapshot' };
    const withTenantSnapshot = vi.fn(async (_tenantId, callback) => callback(transaction as never));
    const getStudentById = vi.fn(async () => STUDENT);
    const getTransactions = vi.fn(async () => [TRANSACTION]);
    const createDatabaseStudentQueries = vi.fn(({ runTenantTransaction }) => ({
      getStudents: vi.fn(),
      getStudentById: () => runTenantTransaction(TENANT_ID, async (received: unknown) => {
        expect(received).toBe(transaction);
        return getStudentById();
      }),
    }));
    const createDatabaseTransactionQueries = vi.fn(({ runTenantTransaction }) => ({
      getTransactionById: vi.fn(),
      getTransactions: () => runTenantTransaction(TENANT_ID, async (received: unknown) => {
        expect(received).toBe(transaction);
        return getTransactions();
      }),
    }));
    const createConfiguredSheetsReader = vi.fn();
    const creators = createBankRepositoryCreators({
      createDatabaseStudentQueries,
      createDatabaseTransactionQueries,
      withTenantSnapshot,
      createConfiguredSheetsReader,
      getStudentById: vi.fn(),
      getTransactions: vi.fn(),
      confirmStudentLookup: vi.fn(),
    });
    const sheetsGetter = vi.fn(() => { throw new Error('unselected Sheets accessed'); });
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const bank = await createConfiguredBankReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    await expect(bank.getBalance('S1')).resolves.toEqual({ student: STUDENT, transactions: [TRANSACTION] });
    await expect(bank.confirmStudent('S1')).resolves.toEqual({ status: 'FOUND', student: STUDENT });
    expect(withTenantSnapshot).toHaveBeenCalledTimes(2);
    expect(withTenantSnapshot).toHaveBeenNthCalledWith(1, TENANT_ID, expect.any(Function));
    expect(createDatabaseStudentQueries).toHaveBeenCalledTimes(2);
    expect(createDatabaseTransactionQueries).toHaveBeenCalledOnce();
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
  });

  it('preserves explicit legacy Sheets behavior through one lazy reader', async () => {
    const reader = { getRows: vi.fn() };
    const createConfiguredSheetsReader = vi.fn(async () => reader);
    const getStudentById = vi.fn(async () => STUDENT);
    const getTransactions = vi.fn(async () => [TRANSACTION]);
    const confirmStudentLookup = vi.fn(async () => ({ status: 'FOUND' as const, student: STUDENT }));
    const creators = createBankRepositoryCreators({
      createDatabaseStudentQueries: vi.fn(),
      createDatabaseTransactionQueries: vi.fn(),
      withTenantSnapshot: vi.fn(),
      createConfiguredSheetsReader,
      getStudentById,
      getTransactions,
      confirmStudentLookup,
    });
    const postgresGetter = vi.fn(() => { throw new Error('unselected PostgreSQL accessed'); });
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const bank = await createConfiguredBankReader({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await expect(bank.getBalance('S1')).resolves.toEqual({ student: STUDENT, transactions: [TRANSACTION] });
    await expect(bank.confirmStudent('S1')).resolves.toEqual({ status: 'FOUND', student: STUDENT });
    expect(createConfiguredSheetsReader).toHaveBeenCalledOnce();
    expect(getStudentById).toHaveBeenCalledWith(reader, 'S1');
    expect(getTransactions).toHaveBeenCalledWith(reader);
    expect(confirmStudentLookup).toHaveBeenCalledWith(reader, 'S1');
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tenant', undefined],
    ['invalid tenant', activeTenant({ tenantId: 'bad' })],
    ['inactive tenant', activeTenant({ tenantStatus: 'SUSPENDED' })],
  ])('fails closed for PostgreSQL with %s before accessing a backend', async (_label, context) => {
    const creators = {} as Parameters<typeof createConfiguredBankReader>[0]['creators'];
    const postgresGetter = vi.fn();
    const sheetsGetter = vi.fn();
    Object.defineProperties(creators, {
      createPostgresql: { get: postgresGetter }, createSheets: { get: sheetsGetter },
    });
    await expect(createConfiguredBankReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => context,
      creators,
    })).rejects.toThrow(/tenant|ACTIVE/i);
    expect(postgresGetter).not.toHaveBeenCalled();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('propagates a PostgreSQL read error without touching Sheets', async () => {
    const dbError = new Error('database unavailable');
    const sheetsGetter = vi.fn();
    const creators = {
      createPostgresql: vi.fn(() => ({
        getBalance: vi.fn(async () => { throw dbError; }), confirmStudent: vi.fn(),
      })),
    } as unknown as Parameters<typeof createConfiguredBankReader>[0]['creators'];
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });
    const bank = await createConfiguredBankReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });
    await expect(bank.getBalance('S1')).rejects.toBe(dbError);
    expect(sheetsGetter).not.toHaveBeenCalled();
  });
});
