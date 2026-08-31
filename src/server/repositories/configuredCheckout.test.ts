import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  createCheckoutCommandRepositoryCreators,
  createConfiguredCheckoutCommand,
} from '@/server/repositories/configuredCheckout';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  payloadHash: 'a'.repeat(64),
  studentId: 'S001',
  items: [{ productId: 'P001', quantity: 1 }],
  expectedPricing: { ok: true as const, totalAmount: 100, items: [] },
  operator: 'kiosk',
};

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

describe('configured checkout mutation composition root', () => {
  it('keeps explicit Sheets lazy and forwards the exact Request to request-scoped OAuth', async () => {
    const request = new Request('http://localhost/api/checkout', { method: 'POST' });
    const store = { marker: 'sheets' };
    const result = { ok: false as const, code: 'STUDENT_NOT_FOUND' as const, message: 'missing' };
    const execute = vi.fn(async () => result);
    const createConfiguredSheetsStore = vi.fn(async () => store as never);
    const createSheetsCheckoutCommand = vi.fn(() => ({ execute }));
    const creators = createCheckoutCommandRepositoryCreators({
      createDatabaseCheckoutCommand: vi.fn(),
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore,
      createSheetsCheckoutCommand,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const command = await createConfiguredCheckoutCommand({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });

    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    await expect(command.execute(INPUT)).resolves.toBe(result);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(createSheetsCheckoutCommand).toHaveBeenCalledWith(store);
    expect(execute).toHaveBeenCalledWith(INPUT);
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('selects the tenant PostgreSQL command without inspecting or invoking Sheets', async () => {
    const dbError = new Error('database unavailable');
    const execute = vi.fn(async () => { throw dbError; });
    const createDatabaseCheckoutCommand = vi.fn(() => ({ execute }));
    const createConfiguredSheetsStore = vi.fn();
    const creators = createCheckoutCommandRepositoryCreators({
      createDatabaseCheckoutCommand,
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore,
      createSheetsCheckoutCommand: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredCheckoutCommand({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(), creators,
    });

    expect(createDatabaseCheckoutCommand).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: expect.any(Function),
    });
    await expect(command.execute(INPUT)).rejects.toBe(dbError);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });
});
