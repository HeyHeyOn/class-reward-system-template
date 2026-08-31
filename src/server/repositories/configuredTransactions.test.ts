import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  createConfiguredTransactionReader,
  createTransactionRepositoryCreators,
} from '@/server/repositories/configuredTransactions';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const TRANSACTIONS = [{ transactionId: 'T1' }] as never;
const activeTenant = () => ({ tenantId: TENANT_ID, tenantStatus: 'ACTIVE' });

describe('configured transaction read composition root', () => {
  it('builds PostgreSQL transaction queries with the tenant snapshot runner only', async () => {
    const withTenantSnapshot = vi.fn();
    const databaseAdapter = { getTransactions: vi.fn(async () => TRANSACTIONS) };
    const createDatabaseTransactionQueries = vi.fn(() => databaseAdapter);
    const creators = createTransactionRepositoryCreators({
      createDatabaseTransactionQueries,
      withTenantSnapshot,
      createConfiguredSheetsReader: vi.fn(),
      getTransactions: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const transactions = await createConfiguredTransactionReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: activeTenant, creators,
    });
    expect(transactions).toBe(databaseAdapter);
    expect(createDatabaseTransactionQueries).toHaveBeenCalledWith({
      tenantId: TENANT_ID, runTenantTransaction: withTenantSnapshot,
    });
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('lazily delegates explicit Sheets reads to the existing transaction function', async () => {
    const reader = { getRows: vi.fn() };
    const createConfiguredSheetsReader = vi.fn(async () => reader);
    const getTransactions = vi.fn(async () => TRANSACTIONS);
    const creators = createTransactionRepositoryCreators({
      createDatabaseTransactionQueries: vi.fn(), withTenantSnapshot: vi.fn(),
      createConfiguredSheetsReader, getTransactions,
    });
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const transactions = await createConfiguredTransactionReader({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(() => activeTenant()), creators,
    });
    expect(createConfiguredSheetsReader).not.toHaveBeenCalled();
    await expect(transactions.getTransactions()).resolves.toBe(TRANSACTIONS);
    expect(createConfiguredSheetsReader).toHaveBeenCalledOnce();
    expect(getTransactions).toHaveBeenCalledWith(reader);
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['invalid', { tenantId: 'bad', tenantStatus: 'ACTIVE' }],
    ['inactive', { tenantId: TENANT_ID, tenantStatus: 'SUSPENDED' }],
  ])('fails closed for %s PostgreSQL tenant authority before creator access', async (_label, tenant) => {
    const creators = {} as Parameters<typeof createConfiguredTransactionReader>[0]['creators'];
    const postgresGetter = vi.fn();
    const sheetsGetter = vi.fn();
    Object.defineProperties(creators, {
      createPostgresql: { get: postgresGetter }, createSheets: { get: sheetsGetter },
    });
    await expect(createConfiguredTransactionReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => tenant, creators,
    })).rejects.toThrow(/tenant|ACTIVE/i);
    expect(postgresGetter).not.toHaveBeenCalled();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('never accesses Sheets after a PostgreSQL read failure', async () => {
    const dbError = new Error('database unavailable');
    const creators = { createPostgresql: vi.fn(() => ({
      getTransactions: vi.fn(async () => { throw dbError; }),
    })) } as unknown as Parameters<typeof createConfiguredTransactionReader>[0]['creators'];
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });
    const transactions = await createConfiguredTransactionReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: activeTenant, creators,
    });
    await expect(transactions.getTransactions()).rejects.toBe(dbError);
    expect(sheetsGetter).not.toHaveBeenCalled();
  });
});