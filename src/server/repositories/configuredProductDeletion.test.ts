import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/sheetsRepository')>(),
  deleteProduct: vi.fn(),
}));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  createConfiguredProductDeletion,
  createProductDeletionRepositoryCreators,
} from '@/server/repositories/configuredProductDeletion';
import { deleteProduct } from '@/server/sheetsRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  productId: 'P-001',
  expectedProductVersion: 4,
};
const COMPLETED_AT = '2026-09-01T01:02:03.000Z';

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    productId: INPUT.productId,
    name: '  역사적 상품명  ',
    price: 1200,
    stock: 7,
    isActive: false,
    imageUrl: null,
    category: '간식',
    sortOrder: -3,
    productVersionBefore: INPUT.expectedProductVersion,
    productVersionAfter: INPUT.expectedProductVersion + 1,
    stockBefore: 7,
    stockAfter: 7,
    inventoryEventId: null,
    deletedAt: COMPLETED_AT,
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    operationId: INPUT.operationId,
    action: 'DEACTIVATE' as const,
    completedAt: COMPLETED_AT,
    products: [row()],
    ...overrides,
  };
}

function dependencies(rawResult: unknown = result()) {
  const deactivate = vi.fn(async () => rawResult);
  const createDatabaseCatalogCommands = vi.fn(() => ({ deactivate }));
  const runTenantTransaction = vi.fn();
  const createSheetsStore = vi.fn();
  const removeFromSheets = vi.fn();
  return {
    deactivate,
    createDatabaseCatalogCommands,
    runTenantTransaction,
    createSheetsStore,
    removeFromSheets,
    value: {
      createDatabaseCatalogCommands,
      withTenantTransaction: runTenantTransaction,
      createConfiguredSheetsStore: createSheetsStore,
      deleteProduct: removeFromSheets,
    },
  };
}

function postgresqlCommand(rawResult: unknown = result()) {
  const deps = dependencies(rawResult);
  const creators = createProductDeletionRepositoryCreators(deps.value as never);
  return {
    deps,
    command: createConfiguredProductDeletion({
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

describe('configured product deletion composition root', () => {
  it('binds the active tenant transaction, forwards the exact input, and returns a fresh ID projection', async () => {
    const { deps, command } = postgresqlCommand();
    const configured = await command;

    const first = await configured.delete(INPUT);
    const second = await configured.delete(INPUT);
    expect(first).toEqual({ productId: INPUT.productId });
    expect(second).toEqual({ productId: INPUT.productId });
    expect(first).not.toBe(second);
    expect(deps.createDatabaseCatalogCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: deps.runTenantTransaction,
    });
    expect(deps.deactivate).toHaveBeenNthCalledWith(1, INPUT);
    expect(deps.deactivate).toHaveBeenNthCalledWith(2, INPUT);
    expect(deps.createSheetsStore).not.toHaveBeenCalled();
    expect(deps.removeFromSheets).not.toHaveBeenCalled();
  });

  it.each([
    ['top-level extra key', result({ extra: true })],
    ['wrong ok', result({ ok: false })],
    ['wrong operation ID', result({ operationId: '22222222-2222-4222-8222-222222222222' })],
    ['wrong action', result({ action: 'DELETE' })],
    ['noncanonical completedAt', result({ completedAt: '2026-09-01T01:02:03Z' })],
    ['zero rows', result({ products: [] })],
    ['two rows', result({ products: [row(), row()] })],
    ['row extra key', result({ products: [row({ extra: true })] })],
    ['wrong product ID', result({ products: [row({ productId: 'OTHER' })] })],
    ['blank name', result({ products: [row({ name: '   ' })] })],
    ['boxed name', result({ products: [row({ name: new String('name') })] })],
    ['negative price', result({ products: [row({ price: -1 })] })],
    ['unsafe price', result({ products: [row({ price: Number.MAX_SAFE_INTEGER + 1 })] })],
    ['negative stock', result({ products: [row({ stock: -1, stockBefore: -1, stockAfter: -1 })] })],
    ['active product', result({ products: [row({ isActive: true })] })],
    ['invalid image URL', result({ products: [row({ imageUrl: 1 })] })],
    ['invalid category', result({ products: [row({ category: undefined })] })],
    ['sort below int32', result({ products: [row({ sortOrder: -2147483649 })] })],
    ['sort above int32', result({ products: [row({ sortOrder: 2147483648 })] })],
    ['wrong version before', result({ products: [row({ productVersionBefore: 3 })] })],
    ['wrong version after', result({ products: [row({ productVersionAfter: 6 })] })],
    ['wrong stock before', result({ products: [row({ stockBefore: 6 })] })],
    ['wrong stock after', result({ products: [row({ stockAfter: 6 })] })],
    ['inventory event present', result({ products: [row({ inventoryEventId: INPUT.operationId })] })],
    ['noncanonical deletedAt', result({ products: [row({ deletedAt: '2026-09-01T01:02:03Z' })] })],
    ['deletedAt differs from completedAt', result({ products: [row({ deletedAt: '2026-09-01T01:02:04.000Z' })] })],
  ])('rejects malformed PostgreSQL success evidence: %s', async (_label, rawResult) => {
    const { command } = postgresqlCommand(rawResult);
    await expect((await command).delete(INPUT)).rejects.toThrow(/integrity/i);
  });

  it.each([0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])(
    'rejects malformed expected version %s before calling deactivate', async (expectedProductVersion) => {
      const { deps, command } = postgresqlCommand();
      await expect((await command).delete({ ...INPUT, expectedProductVersion } as never))
        .rejects.toThrow(/integrity/i);
      expect(deps.deactivate).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed or hostile command inputs before either backend is touched', async () => {
    const hook = vi.fn(() => { throw new Error('input hook invoked'); });
    const getter = { ...INPUT };
    Object.defineProperty(getter, 'productId', { enumerable: true, get: hook });
    const symbol = { ...INPUT, [Symbol('extra')]: true };
    const custom = Object.assign(Object.create({}), INPUT);
    const malformed = [
      getter, symbol, custom, { ...INPUT, extra: true },
      { ...INPUT, operationId: 'NOT-A-UUID' },
      { ...INPUT, operationId: 'aaaaaaaa-1111-4111-8111-111111111111'.toUpperCase() },
      { ...INPUT, productId: '' }, { ...INPUT, productId: ' P-001' },
    ];

    for (const candidate of malformed) {
      const postgres = postgresqlCommand();
      await expect((await postgres.command).delete(candidate as never)).rejects.toThrow(/integrity/i);
      expect(postgres.deps.deactivate).not.toHaveBeenCalled();

      const sheetsDeps = dependencies();
      sheetsDeps.createSheetsStore.mockResolvedValue({});
      const sheets = await createConfiguredProductDeletion({
        env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(),
        creators: createProductDeletionRepositoryCreators(sheetsDeps.value as never),
      });
      await expect(sheets.delete(candidate as never)).rejects.toThrow(/integrity/i);
      expect(sheetsDeps.createSheetsStore).not.toHaveBeenCalled();
      expect(sheetsDeps.removeFromSheets).not.toHaveBeenCalled();
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects symbols, accessors, custom prototypes, descriptor changes, sparse/exotic arrays, and coercion hooks without invocation', async () => {
    const hook = vi.fn(() => { throw new Error('hook invoked'); });
    const getterResult = result();
    Object.defineProperty(getterResult, 'ok', { enumerable: true, get: hook });
    const readonlyResult = result();
    Object.defineProperty(readonlyResult, 'ok', { value: true, enumerable: true, writable: false, configurable: true });
    const getterRow = row();
    Object.defineProperty(getterRow, 'name', { enumerable: true, get: hook });
    const sealedRow = row();
    Object.defineProperty(sealedRow, 'name', { value: sealedRow.name, enumerable: true, writable: true, configurable: false });
    const getterArray = [row()];
    Object.defineProperty(getterArray, '0', { enumerable: true, get: hook });
    const sparse: unknown[] = [];
    sparse.length = 1;
    const exotic = Object.assign(Object.create(Array.prototype), { 0: row(), length: 1 });
    const symbolResult = result() as Record<PropertyKey, unknown>;
    symbolResult[Symbol('extra')] = true;
    const custom = Object.assign(Object.create({}), result());
    const coercion = { toString: hook, valueOf: hook };
    const malformed = [
      getterResult, readonlyResult, result({ products: [getterRow] }), result({ products: [sealedRow] }),
      result({ products: getterArray }), result({ products: sparse }), result({ products: exotic }),
      symbolResult, custom, result({ products: [row({ price: coercion })] }),
    ];
    for (const rawResult of malformed) {
      const { command } = postgresqlCommand(rawResult);
      await expect((await command).delete(INPUT)).rejects.toThrow(/integrity/i);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('keeps Sheets lazy and memoized, forwards the exact Request, strips command-only fields, and validates exact identity', async () => {
    const request = new Request('http://localhost/api/products/P-001', { method: 'DELETE' });
    const store = { marker: 'sheets' };
    const deps = dependencies();
    deps.createSheetsStore.mockResolvedValue(store);
    deps.removeFromSheets.mockResolvedValue({ productId: INPUT.productId });
    const command = await createConfiguredProductDeletion({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(),
      creators: createProductDeletionRepositoryCreators(deps.value as never, request),
    });
    expect(deps.createSheetsStore).not.toHaveBeenCalled();

    await expect(command.delete(INPUT)).resolves.toEqual({ productId: INPUT.productId });
    await expect(command.delete(INPUT)).resolves.toEqual({ productId: INPUT.productId });
    expect(deps.createSheetsStore).toHaveBeenCalledOnce();
    expect(deps.createSheetsStore).toHaveBeenCalledWith(request);
    expect(deps.removeFromSheets).toHaveBeenNthCalledWith(1, store, INPUT.productId);
    expect(deps.removeFromSheets).toHaveBeenNthCalledWith(2, store, INPUT.productId);
    expect(deps.createDatabaseCatalogCommands).not.toHaveBeenCalled();

    deps.removeFromSheets.mockResolvedValueOnce({ productId: 'OTHER' });
    await expect(command.delete(INPUT)).rejects.toThrow(/integrity/i);
    deps.removeFromSheets.mockResolvedValueOnce({ productId: INPUT.productId, extra: true });
    await expect(command.delete(INPUT)).rejects.toThrow(/integrity/i);
  });

  it('preserves selected backend errors and never falls back in either direction', async () => {
    const sheetsFailure = new Error('sheets unavailable');
    const sheetsDeps = dependencies();
    sheetsDeps.createSheetsStore.mockResolvedValue({});
    sheetsDeps.removeFromSheets.mockRejectedValue(sheetsFailure);
    const sheets = await createConfiguredProductDeletion({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext: vi.fn(),
      creators: createProductDeletionRepositoryCreators(sheetsDeps.value as never),
    });
    await expect(sheets.delete(INPUT)).rejects.toBe(sheetsFailure);
    expect(sheetsDeps.createDatabaseCatalogCommands).not.toHaveBeenCalled();

    const databaseFailure = new Error('database unavailable');
    const dbDeps = dependencies();
    dbDeps.deactivate.mockRejectedValue(databaseFailure);
    const postgres = await createConfiguredProductDeletion({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: () => activeTenant(),
      creators: createProductDeletionRepositoryCreators(dbDeps.value as never),
    });
    await expect(postgres.delete(INPUT)).rejects.toBe(databaseFailure);
    expect(dbDeps.createSheetsStore).not.toHaveBeenCalled();
    expect(dbDeps.removeFromSheets).not.toHaveBeenCalled();
  });

  it('recognizes Request first and rejects malformed supplied options before getters or dependencies', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/products/P-001', { method: 'DELETE' });
    const hostile = vi.fn(() => { throw new Error('hostile getter'); });
    Object.defineProperties(request, {
      env: { enumerable: true, get: hostile },
      getCentralTenantContext: { enumerable: true, get: hostile },
      creators: { enumerable: true, get: hostile },
    });
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(deleteProduct).mockResolvedValue({ productId: INPUT.productId });
    const fromRequest = await createConfiguredProductDeletion(request);
    await expect(fromRequest.delete(INPUT)).resolves.toEqual({ productId: INPUT.productId });
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
      { ...valid(), getCentralTenantContext: 'bad' }, { ...valid(), creators: null },
    ];
    for (const value of malformed) {
      await expect(createConfiguredProductDeletion(value as never))
        .rejects.toThrow(/invalid configured product deletion options/i);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  });
});
