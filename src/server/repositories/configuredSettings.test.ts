import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  createConfiguredSettingsReader,
  createSettingsRepositoryCreators,
} from '@/server/repositories/configuredSettings';
import type { AppSettings } from '@/server/settings';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const SETTINGS = { currencyUnit: '별', className: '교실', googleSheetsUrl: '', googleSheetsId: '',
  googleSheetsModifiedTime: '', padletApiKey: '', source: 'database', path: '' } as AppSettings;
const activeTenant = () => ({ tenantId: TENANT_ID, tenantStatus: 'ACTIVE' });

describe('configured settings read composition root', () => {
  it('builds PostgreSQL settings queries with the tenant snapshot runner only', async () => {
    const withTenantSnapshot = vi.fn();
    const databaseAdapter = { getAppSettings: vi.fn(async () => SETTINGS) };
    const createDatabaseSettingsQueries = vi.fn(() => databaseAdapter);
    const creators = createSettingsRepositoryCreators({
      createDatabaseSettingsQueries,
      withTenantSnapshot,
      createConfiguredSheetsStore: vi.fn(),
      getAppSettings: vi.fn(),
    });
    const sheetsGetter = vi.fn(() => { throw new Error('unselected Sheets creator accessed'); });
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    const settings = await createConfiguredSettingsReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: activeTenant,
      creators,
    });

    expect(settings).toBe(databaseAdapter);
    expect(createDatabaseSettingsQueries).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runTenantTransaction: withTenantSnapshot,
    });
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('lazily delegates explicit Sheets reads to the existing settings function', async () => {
    const request = new Request('http://localhost/api/settings');
    const store = { getRows: vi.fn() };
    const createConfiguredSheetsStore = vi.fn(async () => store as never);
    const sheetSettings = { spreadsheetId: 'sheet-id', currencyUnit: '원', appTitle: '매점',
      bankTitle: '은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false,
      classTimeZone: 'Asia/Seoul', schemaVersion: 1, systemVersion: '1', systemName: 'CRS',
      source: 'sheet' } as AppSettings;
    const getAppSettings = vi.fn(async () => sheetSettings);
    const creators = createSettingsRepositoryCreators({
      createDatabaseSettingsQueries: vi.fn(),
      withTenantSnapshot: vi.fn(),
      createConfiguredSheetsStore,
      getAppSettings,
    }, request);
    const postgresGetter = vi.fn(() => { throw new Error('unselected PostgreSQL creator accessed'); });
    Object.defineProperty(creators, 'createPostgresql', { get: postgresGetter });

    const settings = await createConfiguredSettingsReader({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(() => activeTenant()),
      creators,
    });

    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    await expect(settings.getAppSettings()).resolves.toEqual(sheetSettings);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(getAppSettings).toHaveBeenCalledWith({ settingsReader: store });
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['invalid', { tenantId: 'bad', tenantStatus: 'ACTIVE' }],
    ['inactive', { tenantId: TENANT_ID, tenantStatus: 'SUSPENDED' }],
  ])('fails closed for %s PostgreSQL tenant authority before creator access', async (_label, tenant) => {
    const creators = {} as Parameters<typeof createConfiguredSettingsReader>[0]['creators'];
    const postgresGetter = vi.fn();
    const sheetsGetter = vi.fn();
    Object.defineProperties(creators, {
      createPostgresql: { get: postgresGetter },
      createSheets: { get: sheetsGetter },
    });
    await expect(createConfiguredSettingsReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => tenant,
      creators,
    })).rejects.toThrow(/tenant|ACTIVE/i);
    expect(postgresGetter).not.toHaveBeenCalled();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('never accesses Sheets after a PostgreSQL read failure', async () => {
    const dbError = new Error('database unavailable');
    const creators = { createPostgresql: vi.fn(() => ({
      getAppSettings: vi.fn(async () => { throw dbError; }),
    })) } as unknown as Parameters<typeof createConfiguredSettingsReader>[0]['creators'];
    const sheetsGetter = vi.fn();
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });
    const settings = await createConfiguredSettingsReader({
      env: { CLASS_STORE_STORAGE: 'postgresql' }, getCentralTenantContext: activeTenant, creators,
    });
    await expect(settings.getAppSettings()).rejects.toBe(dbError);
    expect(sheetsGetter).not.toHaveBeenCalled();
  });
});