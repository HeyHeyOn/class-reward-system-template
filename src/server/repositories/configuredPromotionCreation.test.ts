import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/repositories/sheets/promotionCommands', () => ({
  createPromotion: vi.fn(),
  replacePromotionProducts: vi.fn(),
}));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  PromotionCreationTargetPartialFailure,
  createConfiguredPromotionCreation,
  createPromotionCreationRepositoryCreators,
} from '@/server/repositories/configuredPromotionCreation';
import {
  createPromotion,
  replacePromotionProducts,
} from '@/server/repositories/sheets/promotionCommands';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const INPUT = {
  operationId: '11111111-1111-4111-8111-111111111111',
  promotionId: 'PROMO-001',
  definition: {
    name: ' 하나 더 ',
    description: ' 설명 ',
    type: 'N_PLUS_ONE' as const,
    buyQuantity: 2,
    freeQuantity: 1,
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-10-01T00:00:00.000Z',
    isActive: true,
    sortOrder: 3,
  },
  productIds: [' P002 ', 'P001'],
};
const COMPLETED_AT = '2026-09-01T01:02:03.000Z';

function activeTenant() {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE' } as const;
}

function databaseResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    operationId: INPUT.operationId,
    action: 'CREATE' as const,
    completedAt: COMPLETED_AT,
    promotions: [{
      promotionId: INPUT.promotionId,
      name: '하나 더',
      description: '설명',
      type: 'N_PLUS_ONE' as const,
      buyQuantity: 2,
      freeQuantity: 1,
      startsAt: INPUT.definition.startsAt,
      endsAt: INPUT.definition.endsAt,
      isActive: true,
      sortOrder: 3,
      schemaVersion: 3 as const,
      productIds: ['P001', 'P002'],
      promotionVersionBefore: null,
      promotionVersionAfter: 1,
    }],
    ...overrides,
  };
}

function promotionResult(overrides: Record<string, unknown> = {}, omitted: string[] = []) {
  const row = { ...databaseResult().promotions[0], ...overrides };
  return Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.includes(key)));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('configured promotion creation composition root', () => {
  it('uses active PostgreSQL authority, forwards exact input, and projects one versionless legacy promotion', async () => {
    const create = vi.fn(async () => databaseResult());
    const createDatabasePromotionCommands = vi.fn(() => ({ create }));
    const runTenantTransaction = vi.fn();
    const creators = createPromotionCreationRepositoryCreators({
      createDatabasePromotionCommands,
      withTenantTransaction: runTenantTransaction,
      createConfiguredSheetsStore: vi.fn(),
      createPromotion: vi.fn(),
      replacePromotionProducts: vi.fn(),
    });
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const command = await createConfiguredPromotionCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });
    const promotion = await command.create(INPUT);

    expect(createDatabasePromotionCommands).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction,
    });
    expect(create).toHaveBeenCalledWith(INPUT);
    expect(promotion).toEqual({
      promotionId: 'PROMO-001',
      name: '하나 더',
      description: '설명',
      type: 'N_PLUS_ONE',
      buyQuantity: 2,
      freeQuantity: 1,
      startsAt: INPUT.definition.startsAt,
      endsAt: INPUT.definition.endsAt,
      isActive: true,
      sortOrder: 3,
      schemaVersion: 3,
      productIds: ['P001', 'P002'],
      createdAt: COMPLETED_AT,
      updatedAt: COMPLETED_AT,
    });
    expect(Object.keys(promotion)).not.toContain('promotionVersionAfter');
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['zero rows', databaseResult({ promotions: [] })],
    ['two rows', databaseResult({ promotions: [databaseResult().promotions[0], databaseResult().promotions[0]] })],
    ['wrong operation identity', databaseResult({ operationId: '22222222-2222-4222-8222-222222222222' })],
    ['wrong action', databaseResult({ action: 'UPDATE' })],
    ['malformed completed timestamp', databaseResult({ completedAt: 'not-an-instant' })],
    ['wrong promotion identity', databaseResult({ promotions: [{ ...databaseResult().promotions[0], promotionId: 'OTHER' }] })],
    ['wrong schema version', databaseResult({ promotions: [promotionResult({ schemaVersion: 1 })] })],
    ['unknown promotion type', databaseResult({ promotions: [promotionResult({ type: 'UNKNOWN' }, ['buyQuantity', 'freeQuantity'])] })],
    ['N_PLUS_ONE missing free quantity', databaseResult({ promotions: [promotionResult({}, ['freeQuantity'])] })],
    ['PROMOTIONAL_PRICE missing price', databaseResult({ promotions: [promotionResult({ type: 'PROMOTIONAL_PRICE' }, ['buyQuantity', 'freeQuantity'])] })],
    ['PERCENT_DISCOUNT missing percent', databaseResult({ promotions: [promotionResult({ type: 'PERCENT_DISCOUNT' }, ['buyQuantity', 'freeQuantity'])] })],
    ['FIXED_DISCOUNT missing amount', databaseResult({ promotions: [promotionResult({ type: 'FIXED_DISCOUNT' }, ['buyQuantity', 'freeQuantity'])] })],
  ])('rejects PostgreSQL result integrity failure: %s', async (_label, result) => {
    const creators = createPromotionCreationRepositoryCreators({
      createDatabasePromotionCommands: vi.fn(() => ({ create: vi.fn(async () => result) })) as never,
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore: vi.fn(),
      createPromotion: vi.fn(),
      replacePromotionProducts: vi.fn(),
    });
    const command = await createConfiguredPromotionCreation({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => activeTenant(),
      creators,
    });

    await expect(command.create(INPUT)).rejects.toThrow(/integrity|exactly one/i);
  });

  it('keeps Sheets lazy and memoized, forwards the exact Request, strips operationId, and skips matching targets', async () => {
    const request = new Request('http://localhost/api/promotions', { method: 'POST' });
    const store = { marker: 'sheets' };
    const created = {
      promotionId: INPUT.promotionId,
      ...INPUT.definition,
      productIds: ['P001', 'P002'],
      createdAt: COMPLETED_AT,
      updatedAt: COMPLETED_AT,
      schemaVersion: 3,
    };
    const createSheetsStore = vi.fn(async () => store as never);
    const createLegacyPromotion = vi.fn(async () => created as never);
    const replaceLegacyTargets = vi.fn();
    const creators = createPromotionCreationRepositoryCreators({
      createDatabasePromotionCommands: vi.fn(),
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore: createSheetsStore,
      createPromotion: createLegacyPromotion,
      replacePromotionProducts: replaceLegacyTargets,
    }, request);
    const postgresGetter = vi.fn();
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });
    const getCentralTenantContext = vi.fn(() => activeTenant());

    const command = await createConfiguredPromotionCreation({
      env: { CLASS_STORE_STORAGE: 'sheets' }, getCentralTenantContext, creators,
    });
    expect(createSheetsStore).not.toHaveBeenCalled();
    await expect(command.create(INPUT)).resolves.toBe(created);

    expect(createSheetsStore).toHaveBeenCalledOnce();
    expect(createSheetsStore).toHaveBeenCalledWith(request);
    expect(createLegacyPromotion).toHaveBeenCalledWith(store, {
      promotionId: INPUT.promotionId,
      ...INPUT.definition,
    });
    expect(replaceLegacyTargets).not.toHaveBeenCalled();
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('replaces different Sheets targets and classifies only the post-create target failure', async () => {
    const store = { marker: 'sheets' };
    const created = { promotionId: INPUT.promotionId, productIds: [] };
    const cause = new Error('provider target secret');
    const creators = createPromotionCreationRepositoryCreators({
      createDatabasePromotionCommands: vi.fn(),
      withTenantTransaction: vi.fn(),
      createConfiguredSheetsStore: vi.fn(async () => store as never),
      createPromotion: vi.fn(async () => created as never),
      replacePromotionProducts: vi.fn(async () => { throw cause; }),
    });
    const command = await createConfiguredPromotionCreation({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(),
      creators,
    });

    const failure = await command.create(INPUT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PromotionCreationTargetPartialFailure);
    expect(failure).toHaveProperty('cause', cause);
  });

  it('recognizes a decorated Request before the full own-property options discriminator', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/promotions', { method: 'POST' });
    Object.defineProperties(request, {
      env: { value: { CLASS_STORE_STORAGE: 'postgresql' } },
      getCentralTenantContext: { value: vi.fn(() => activeTenant()) },
      creators: { value: { createSheets: vi.fn(() => { throw new Error('wrong options'); }) } },
    });
    const created = { promotionId: INPUT.promotionId, productIds: ['P001', 'P002'] };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(createPromotion).mockResolvedValue(created as never);

    const command = await createConfiguredPromotionCreation(request);
    await expect(command.create(INPUT)).resolves.toBe(created);

    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(replacePromotionProducts).not.toHaveBeenCalled();
  });
});
