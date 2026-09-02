import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/repositories/sheets/promotionCommands', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/repositories/sheets/promotionCommands')>(),
  updatePromotion: vi.fn(),
  replacePromotionProducts: vi.fn(),
  setPromotionActive: vi.fn(),
}));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  replacePromotionProducts as updateProductionTargets,
  updatePromotion as updateProductionPromotion,
} from '@/server/repositories/sheets/promotionCommands';

import {
  createConfiguredPromotionMutation,
  createPromotionMutationRepositoryCreators,
  PromotionMutationTargetPartialFailure,
} from './configuredPromotionMutation';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const definition = {
  name: '행사', description: '설명', startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: '2026-10-01T00:00:00.000Z', isActive: true, sortOrder: 3,
  type: 'FIXED_DISCOUNT' as const, discountAmount: 100,
};
const definitionInput = {
  kind: 'definition' as const, operationId: OPERATION_ID, promotionId: 'PROMO-1',
  expectedPromotionVersion: 4, definition, productIds: ['P1', 'P2'],
};
const activationInput = {
  kind: 'activation' as const, operationId: OPERATION_ID, promotionId: 'PROMO-1',
  expectedPromotionVersion: 4, isActive: false,
};

function result(action: 'UPDATE' | 'ACTIVATE' | 'DEACTIVATE', overrides: Record<string, unknown> = {}) {
  return {
    ok: true, operationId: OPERATION_ID, action, completedAt: '2026-09-02T00:00:00.000Z',
    promotions: [{
      promotionId: 'PROMO-1', ...definition, isActive: action === 'DEACTIVATE' ? false : true,
      schemaVersion: 3, productIds: ['P1', 'P2'], promotionVersionBefore: 4,
      promotionVersionAfter: 5,
    }],
    ...overrides,
  };
}

function dependencies(raw: unknown = result('UPDATE')) {
  const update = vi.fn(async () => raw);
  const activate = vi.fn(async () => raw);
  const deactivate = vi.fn(async () => raw);
  const createDatabasePromotionCommands = vi.fn(() => ({ update, activate, deactivate }));
  const createConfiguredSheetsStore = vi.fn();
  const updatePromotion = vi.fn();
  const replacePromotionProducts = vi.fn();
  const setPromotionActive = vi.fn();
  const withTenantTransaction = vi.fn();
  return { update, activate, deactivate, createDatabasePromotionCommands, createConfiguredSheetsStore,
    updatePromotion, replacePromotionProducts, setPromotionActive, withTenantTransaction,
    value: { createDatabasePromotionCommands, createConfiguredSheetsStore, updatePromotion,
      replacePromotionProducts, setPromotionActive, withTenantTransaction } };
}

async function postgres(raw: unknown = result('UPDATE')) {
  const deps = dependencies(raw);
  const command = await createConfiguredPromotionMutation({
    env: { CLASS_STORE_STORAGE: 'postgresql' },
    getCentralTenantContext: () => ({ tenantId: TENANT_ID, tenantStatus: 'ACTIVE' }),
    creators: createPromotionMutationRepositoryCreators(deps.value as never),
  });
  return { deps, command };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('configured promotion mutation', () => {
  it('adapts the production Sheets update call without leaking promotionId into the definition', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/promotions/PROMO-1', { method: 'PATCH' });
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateProductionPromotion).mockResolvedValue({
      promotionId: 'PROMO-1',
      productIds: ['P1', 'P2'],
    } as never);
    const command = await createConfiguredPromotionMutation(request);

    await expect(command.patch(definitionInput)).resolves.toEqual({
      promotionId: 'PROMO-1',
      mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 1 },
    });
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(updateProductionPromotion).toHaveBeenCalledWith(store, 'PROMO-1', definition);
    expect(updateProductionTargets).not.toHaveBeenCalled();
  });

  it('maps definition updates exactly through active tenant PostgreSQL and returns a fresh acknowledgement', async () => {
    const { deps, command } = await postgres();
    await expect(command.patch(definitionInput)).resolves.toEqual({ promotionId: 'PROMO-1', mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 } });
    expect(deps.createDatabasePromotionCommands).toHaveBeenCalledWith({ tenantId: TENANT_ID, runTenantTransaction: deps.withTenantTransaction });
    expect(deps.update).toHaveBeenCalledWith({ operationId: OPERATION_ID, promotionId: 'PROMO-1', expectedPromotionVersion: 4, definition, productIds: ['P1', 'P2'] });
    expect(deps.createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it.each([[true, 'ACTIVATE', 'activate'], [false, 'DEACTIVATE', 'deactivate']] as const)(
    'maps activation %s to the exact PostgreSQL command', async (isActive, action, method) => {
      const { deps, command } = await postgres(result(action));
      await expect(command.patch({ ...activationInput, isActive })).resolves.toEqual({ promotionId: 'PROMO-1', mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 5 } });
      expect(deps[method]).toHaveBeenCalledWith({ operationId: OPERATION_ID, promotionId: 'PROMO-1', expectedPromotionVersion: 4 });
    },
  );

  it.each([
    ['unsafe input', result('UPDATE'), { ...definitionInput, expectedPromotionVersion: Number.MAX_SAFE_INTEGER }],
    ['wrong action', result('ACTIVATE'), definitionInput],
    ['extra result key', result('UPDATE', { extra: true }), definitionInput],
    ['wrong operation', result('UPDATE', { operationId: '22222222-2222-4222-8222-222222222222' }), definitionInput],
    ['noncanonical time', result('UPDATE', { completedAt: '2026-09-02T00:00:00Z' }), definitionInput],
    ['wrong definition', result('UPDATE', { promotions: [{ ...result('UPDATE').promotions[0], name: '다름' }] }), definitionInput],
    ['unsorted products', result('UPDATE', { promotions: [{ ...result('UPDATE').promotions[0], productIds: ['P2', 'P1'] }] }), definitionInput],
    ['non-int32 retained sort order', result('DEACTIVATE', { promotions: [{ ...result('DEACTIVATE').promotions[0], sortOrder: 2 ** 31 }] }), activationInput],
  ])('fails closed for %s', async (_label, raw, input) => {
    const { deps, command } = await postgres(raw);
    await expect(command.patch(input as never)).rejects.toThrow(/integrity/i);
    if (_label === 'unsafe input') expect(deps.update).not.toHaveBeenCalled();
  });

  it('rejects getter/custom/symbol evidence without invoking hooks', async () => {
    const hook = vi.fn(() => { throw new Error('hook'); });
    const getter = result('UPDATE');
    Object.defineProperty(getter, 'ok', { enumerable: true, get: hook });
    const custom = Object.assign(Object.create({}), result('UPDATE'));
    const symbol = result('UPDATE') as Record<PropertyKey, unknown>;
    symbol[Symbol('x')] = true;
    for (const raw of [getter, custom, symbol]) {
      const { command } = await postgres(raw);
      await expect(command.patch(definitionInput)).rejects.toThrow(/integrity/i);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('keeps Sheets lazy/memoized, forwards Request, strips operation/version, and wraps target partial failure', async () => {
    const request = new Request('http://localhost/api/promotions/PROMO-1', { method: 'PATCH' });
    const deps = dependencies();
    const store = {};
    deps.createConfiguredSheetsStore.mockResolvedValue(store);
    deps.updatePromotion.mockResolvedValue({ promotionId: 'PROMO-1', productIds: [] });
    deps.replacePromotionProducts.mockResolvedValue({ promotionId: 'PROMO-1' });
    const command = await createConfiguredPromotionMutation({ env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(), creators: createPromotionMutationRepositoryCreators(deps.value as never, request) });
 expect(deps.createConfiguredSheetsStore).not.toHaveBeenCalled();
 await expect(command.patch(definitionInput)).resolves.toEqual({ promotionId: 'PROMO-1', mutationPrecondition: { promotionId: 'PROMO-1', expectedVersion: 1 } });
    expect(deps.createConfiguredSheetsStore).toHaveBeenCalledOnce();
    expect(deps.createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(deps.updatePromotion).toHaveBeenCalledWith(store, { promotionId: 'PROMO-1', ...definition });
    expect(deps.replacePromotionProducts).toHaveBeenCalledWith(store, 'PROMO-1', ['P1', 'P2']);
    deps.replacePromotionProducts.mockRejectedValueOnce(new Error('secret'));
    await expect(command.patch(definitionInput)).rejects.toBeInstanceOf(PromotionMutationTargetPartialFailure);
    expect(deps.createDatabasePromotionCommands).not.toHaveBeenCalled();
  });

  it('rejects malformed Sheets target evidence without invoking coercion hooks', async () => {
    const hook = vi.fn(() => { throw new Error('hook invoked'); });
    const hostileId = {};
    Object.defineProperty(hostileId, 'trim', { enumerable: true, get: hook });
    const deps = dependencies();
    deps.createConfiguredSheetsStore.mockResolvedValue({});
    deps.updatePromotion.mockResolvedValue({ promotionId: 'PROMO-1', productIds: [hostileId] });
    const command = await createConfiguredPromotionMutation({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(),
      creators: createPromotionMutationRepositoryCreators(deps.value as never),
    });

    await expect(command.patch(definitionInput)).rejects.toThrow(/integrity/i);
    expect(hook).not.toHaveBeenCalled();
    expect(deps.replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('rejects symbol-decorated Sheets results', async () => {
    const deps = dependencies();
    deps.createConfiguredSheetsStore.mockResolvedValue({});
    deps.updatePromotion.mockResolvedValue({
      promotionId: 'PROMO-1',
      productIds: ['P1', 'P2'],
      [Symbol('extra')]: true,
    });
    const command = await createConfiguredPromotionMutation({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(),
      creators: createPromotionMutationRepositoryCreators(deps.value as never),
    });

    await expect(command.patch(definitionInput)).rejects.toThrow(/integrity/i);
    expect(deps.replacePromotionProducts).not.toHaveBeenCalled();
  });

  it('uses setPromotionActive for Sheets and validates returned identity', async () => {
    const deps = dependencies(); deps.createConfiguredSheetsStore.mockResolvedValue({});
    deps.setPromotionActive.mockResolvedValue({ promotionId: 'OTHER' });
    const command = await createConfiguredPromotionMutation({ env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(), creators: createPromotionMutationRepositoryCreators(deps.value as never) });
    await expect(command.patch(activationInput)).rejects.toThrow(/integrity/i);
    expect(deps.setPromotionActive).toHaveBeenCalledWith({}, 'PROMO-1', false);
  });

  it('never falls back from PostgreSQL and rejects malformed supplied options before hostile getters', async () => {
    const failure = new Error('db down'); const { deps, command } = await postgres(); deps.update.mockRejectedValue(failure);
    await expect(command.patch(definitionInput)).rejects.toBe(failure);
    expect(deps.createConfiguredSheetsStore).not.toHaveBeenCalled();
    const getter = vi.fn(() => { throw new Error('getter'); });
    const malformed = {}; Object.defineProperty(malformed, 'env', { enumerable: true, get: getter });
    await expect(createConfiguredPromotionMutation(malformed as never)).rejects.toThrow(/invalid configured promotion mutation options/i);
    expect(getter).not.toHaveBeenCalled();
  });
});
