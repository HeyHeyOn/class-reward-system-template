import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/repositories/sheets/promotionCommands', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/repositories/sheets/promotionCommands')>(),
  deletePromotion: vi.fn(),
}));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  createConfiguredPromotionDeletion,
  createPromotionDeletionRepositoryCreators,
} from '@/server/repositories/configuredPromotionDeletion';
import {
  deletePromotion,
  PromotionDeletePartialFailure,
} from '@/server/repositories/sheets/promotionCommands';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  promotionId: 'PROMO-001',
  expectedPromotionVersion: 4,
};
const COMPLETED_AT = '2026-09-01T01:02:03.000Z';

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    promotionId: INPUT.promotionId,
    name: '하나 더',
    description: '설명',
    type: 'N_PLUS_ONE' as const,
    buyQuantity: 2,
    freeQuantity: 1,
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-10-01T00:00:00.000Z',
    isActive: false,
    sortOrder: 3,
    schemaVersion: 3 as const,
    productIds: ['P001', 'P002'],
    promotionVersionBefore: INPUT.expectedPromotionVersion,
    promotionVersionAfter: INPUT.expectedPromotionVersion + 1,
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    operationId: INPUT.operationId,
    action: 'DELETE' as const,
    completedAt: COMPLETED_AT,
    promotions: [row()],
    ...overrides,
  };
}

function dependencies(rawResult: unknown = result()) {
  const remove = vi.fn(async () => rawResult);
  const createDatabasePromotionCommands = vi.fn(() => ({ delete: remove }));
  const runTenantTransaction = vi.fn();
  const createSheetsStore = vi.fn();
  const removeFromSheets = vi.fn();
  return {
    remove,
    createDatabasePromotionCommands,
    runTenantTransaction,
    createSheetsStore,
    removeFromSheets,
    value: {
      createDatabasePromotionCommands,
      withTenantTransaction: runTenantTransaction,
      createConfiguredSheetsStore: createSheetsStore,
      deletePromotion: removeFromSheets,
    },
  };
}

function postgresqlCommand(rawResult: unknown = result()) {
  const deps = dependencies(rawResult);
  const creators = createPromotionDeletionRepositoryCreators(deps.value as never);
  return {
    deps,
    command: createConfiguredPromotionDeletion({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('configured promotion deletion composition root', () => {
  it('uses active PostgreSQL authority and projects exactly one deleted promotion ID', async () => {
    const { deps, command } = postgresqlCommand();
    const configured = await command;

    await expect(configured.delete(INPUT)).resolves.toEqual({ promotionId: INPUT.promotionId });
    expect(deps.createDatabasePromotionCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: deps.runTenantTransaction,
    });
    expect(deps.remove).toHaveBeenCalledOnce();
    expect(deps.remove).toHaveBeenCalledWith(INPUT);
    expect(deps.createSheetsStore).not.toHaveBeenCalled();
    expect(deps.removeFromSheets).not.toHaveBeenCalled();
  });

  it.each([
    ['top-level extra key', result({ extra: true })],
    ['wrong ok', result({ ok: false })],
    ['wrong operation ID', result({ operationId: '22222222-2222-4222-8222-222222222222' })],
    ['wrong action', result({ action: 'UPDATE' })],
    ['noncanonical completedAt', result({ completedAt: '2026-09-01T01:02:03Z' })],
    ['zero rows', result({ promotions: [] })],
    ['two rows', result({ promotions: [row(), row()] })],
    ['row extra key', result({ promotions: [row({ extra: true })] })],
    ['wrong promotion ID', result({ promotions: [row({ promotionId: 'OTHER' })] })],
    ['blank name', result({ promotions: [row({ name: ' ' })] })],
    ['non-string description', result({ promotions: [row({ description: 1 })] })],
    ['unknown type', result({ promotions: [{ ...row(), type: 'UNKNOWN' }] })],
    ['noncanonical startsAt', result({ promotions: [row({ startsAt: '2026-09-01T00:00:00Z' })] })],
    ['invalid range', result({ promotions: [row({ endsAt: '2026-08-01T00:00:00.000Z' })] })],
    ['non-boolean active', result({ promotions: [row({ isActive: 0 })] })],
    ['sort below int32', result({ promotions: [row({ sortOrder: -2147483649 })] })],
    ['sort above int32', result({ promotions: [row({ sortOrder: 2147483648 })] })],
    ['wrong schema version', result({ promotions: [row({ schemaVersion: 2 })] })],
    ['wrong version before', result({ promotions: [row({ promotionVersionBefore: 3 })] })],
    ['wrong version after', result({ promotions: [row({ promotionVersionAfter: 6 })] })],
    ['padded product ID', result({ promotions: [row({ productIds: [' P001'] })] })],
    ['duplicate product ID', result({ promotions: [row({ productIds: ['P001', 'P001'] })] })],
    ['unsorted product IDs', result({ promotions: [row({ productIds: ['P002', 'P001'] })] })],
    ['invalid N_PLUS_ONE quantity', result({ promotions: [row({ freeQuantity: 0 })] })],
    ['PROMOTIONAL_PRICE wrong keys', result({ promotions: [row({ type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 3 })] })],
    ['PERCENT_DISCOUNT wrong keys', result({ promotions: [row({ type: 'PERCENT_DISCOUNT', percent: 5 })] })],
    ['FIXED_DISCOUNT wrong keys', result({ promotions: [row({ type: 'FIXED_DISCOUNT', discountAmount: 5 })] })],
  ])('rejects malformed PostgreSQL success evidence: %s', async (_label, rawResult) => {
    const { command } = postgresqlCommand(rawResult);
    await expect((await command).delete(INPUT)).rejects.toThrow(/integrity/i);
  });

  it('rejects a noncanonical expected version before accepting matching forged evidence', async () => {
    const malformedInput = { ...INPUT, expectedPromotionVersion: Number.POSITIVE_INFINITY };
    const forged = result({
      promotions: [row({
        promotionVersionBefore: Number.POSITIVE_INFINITY,
        promotionVersionAfter: Number.POSITIVE_INFINITY,
      })],
    });
    const { deps, command } = postgresqlCommand(forged);

    await expect((await command).delete(malformedInput)).rejects.toThrow(/integrity/i);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['PROMOTIONAL_PRICE', { promotionalUnitPrice: 0 }],
    ['PERCENT_DISCOUNT', { percent: 100 }],
    ['FIXED_DISCOUNT', { discountAmount: 1 }],
  ] as const)('accepts the exact %s result variant', async (type, rule) => {
    const common = row();
    const variant = Object.fromEntries(Object.entries({ ...common, type, ...rule })
      .filter(([key]) => !['buyQuantity', 'freeQuantity'].includes(key)));
    const { command } = postgresqlCommand(result({ promotions: [variant] }));
    await expect((await command).delete(INPUT)).resolves.toEqual({ promotionId: INPUT.promotionId });
  });

  it('rejects getter, nonordinary descriptors, custom prototypes, symbols, sparse arrays, and coercion-bearing evidence without hooks', async () => {
    const hook = vi.fn(() => { throw new Error('hook invoked'); });
    const getterResult = result();
    Object.defineProperty(getterResult, 'ok', { enumerable: true, get: hook });
    const readonlyResult = result();
    Object.defineProperty(readonlyResult, 'ok', {
      value: true, enumerable: true, writable: false, configurable: true,
    });
    const getterRow = row();
    Object.defineProperty(getterRow, 'name', { enumerable: true, get: hook });
    const sealedRow = row();
    Object.defineProperty(sealedRow, 'name', {
      value: sealedRow.name, enumerable: true, writable: true, configurable: false,
    });
    const getterArray = [row()];
    Object.defineProperty(getterArray, '0', { enumerable: true, get: hook });
    const sparse: unknown[] = [];
    sparse.length = 1;
    const symbolResult = result() as Record<PropertyKey, unknown>;
    symbolResult[Symbol('extra')] = true;
    const custom = Object.assign(Object.create({}), result());
    const coercion = { toString: hook, valueOf: hook };
    const malformed = [
      getterResult,
      readonlyResult,
      result({ promotions: [getterRow] }),
      result({ promotions: [sealedRow] }),
      result({ promotions: getterArray }),
      result({ promotions: sparse }),
      symbolResult,
      custom,
      result({ promotions: [row({ sortOrder: coercion })] }),
      result({ promotions: [row({ productIds: [coercion] })] }),
    ];
    for (const rawResult of malformed) {
      const { command } = postgresqlCommand(rawResult);
      await expect((await command).delete(INPUT)).rejects.toThrow(/integrity/i);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('keeps Sheets lazy and memoized, forwards the exact Request, strips operation/version, and validates identity', async () => {
    const request = new Request('http://localhost/api/promotions/PROMO-001', { method: 'DELETE' });
    const store = { marker: 'sheets' };
    const deps = dependencies();
    deps.createSheetsStore.mockResolvedValue(store);
    deps.removeFromSheets.mockResolvedValue({ promotionId: INPUT.promotionId });
    const creators = createPromotionDeletionRepositoryCreators(deps.value as never, request);
    const command = await createConfiguredPromotionDeletion({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(), creators,
    });
    expect(deps.createSheetsStore).not.toHaveBeenCalled();

    await expect(command.delete(INPUT)).resolves.toEqual({ promotionId: INPUT.promotionId });
    await expect(command.delete(INPUT)).resolves.toEqual({ promotionId: INPUT.promotionId });
    expect(deps.createSheetsStore).toHaveBeenCalledOnce();
    expect(deps.createSheetsStore).toHaveBeenCalledWith(request);
    expect(deps.removeFromSheets).toHaveBeenNthCalledWith(1, store, INPUT.promotionId);
    expect(deps.removeFromSheets).toHaveBeenNthCalledWith(2, store, INPUT.promotionId);
    expect(deps.createDatabasePromotionCommands).not.toHaveBeenCalled();

    deps.removeFromSheets.mockResolvedValueOnce({ promotionId: 'OTHER' });
    await expect(command.delete(INPUT)).rejects.toThrow(/integrity/i);
  });

  it('preserves the typed Sheets partial failure and never falls back from PostgreSQL', async () => {
    const partial = new PromotionDeletePartialFailure();
    const sheetsDeps = dependencies();
    sheetsDeps.createSheetsStore.mockResolvedValue({});
    sheetsDeps.removeFromSheets.mockRejectedValue(partial);
    const sheets = await createConfiguredPromotionDeletion({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(),
      creators: createPromotionDeletionRepositoryCreators(sheetsDeps.value as never),
    });
    await expect(sheets.delete(INPUT)).rejects.toBe(partial);

    const databaseFailure = new Error('database unavailable');
    const dbDeps = dependencies();
    dbDeps.remove.mockRejectedValue(databaseFailure);
    const postgres = await createConfiguredPromotionDeletion({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => activeTenant(),
      creators: createPromotionDeletionRepositoryCreators(dbDeps.value as never),
    });
    await expect(postgres.delete(INPUT)).rejects.toBe(databaseFailure);
    expect(dbDeps.createSheetsStore).not.toHaveBeenCalled();
    expect(dbDeps.removeFromSheets).not.toHaveBeenCalled();
  });

  it('recognizes Request first and rejects malformed supplied options before any getter or dependency', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/promotions/PROMO-001', { method: 'DELETE' });
    const hostile = vi.fn(() => { throw new Error('hostile getter'); });
    Object.defineProperties(request, {
      env: { enumerable: true, get: hostile },
      getCentralTenantContext: { enumerable: true, get: hostile },
      creators: { enumerable: true, get: hostile },
    });
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(deletePromotion).mockResolvedValue({ promotionId: INPUT.promotionId });
    const fromRequest = await createConfiguredPromotionDeletion(request);
    await expect(fromRequest.delete(INPUT)).resolves.toEqual({ promotionId: INPUT.promotionId });
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(hostile).not.toHaveBeenCalled();

    const invoked = vi.fn();
    const valid = () => ({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(),
      creators: { createPostgresql: vi.fn(invoked), createSheets: vi.fn(invoked) },
    });
    const getter = vi.fn(() => { throw new Error('option getter invoked'); });
    const getterOptions = valid();
    Object.defineProperty(getterOptions, 'env', { enumerable: true, get: getter });
    const creatorGetter = valid();
    Object.defineProperty(creatorGetter.creators, 'createSheets', { enumerable: true, get: getter });
    const envGetter = valid();
    Object.defineProperty(envGetter.env, 'CLASS_STORE_STORAGE', { enumerable: true, get: getter });
    const symbolOptions = valid() as Record<PropertyKey, unknown>;
    symbolOptions[Symbol('extra')] = true;
    const malformed: unknown[] = [
      null, {}, getterOptions, creatorGetter, envGetter, symbolOptions,
      { ...valid(), extra: true }, Object.assign(Object.create({}), valid()),
      { ...valid(), env: Object.assign(Object.create({}), valid().env) },
      { ...valid(), creators: Object.assign(Object.create({}), valid().creators) },
      { ...valid(), getCentralTenantContext: 'bad' },
      { ...valid(), creators: null },
    ];
    for (const value of malformed) {
      await expect(createConfiguredPromotionDeletion(value as never))
        .rejects.toThrow(/invalid configured promotion deletion options/i);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  });
});
