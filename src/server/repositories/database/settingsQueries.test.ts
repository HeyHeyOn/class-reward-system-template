import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseSettingsQueries,
  type DatabaseSettingsQueryDependencies,
} from '@/server/repositories/database/settingsQueries';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
});

afterEach(async () => {
  await harness?.close();
});

function queries(overrides: Partial<DatabaseSettingsQueryDependencies> = {}) {
  return createDatabaseSettingsQueries({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    ...overrides,
  });
}

async function seedSettings(
  tenantId: string,
  settings: Record<string, unknown>,
  schemaVersion = 1,
) {
  await harness.database.query(
    `INSERT INTO tenant_settings (tenant_id, schema_version, settings)
     VALUES ($1, $2, $3::jsonb)`,
    [tenantId, schemaVersion, JSON.stringify(settings)],
  );
}

const DEFAULT_DATABASE_SETTINGS = {
  currencyUnit: '달란트',
  className: '',
  googleSheetsUrl: '',
  googleSheetsId: '',
  googleSheetsModifiedTime: '',
  padletApiKey: '',
  source: 'database',
  path: '',
} as const;

describe('database settings queries', () => {
  it('returns exact database defaults inside the tenant transaction when settings are absent', async () => {
    const transactionTenantIds: string[] = [];
    const runTenantTransaction: DatabaseSettingsQueryDependencies['runTenantTransaction'] =
      async (tenantId, callback) => {
        transactionTenantIds.push(tenantId);
        return harness.runTenantTransaction(tenantId, callback);
      };

    await expect(queries({ runTenantTransaction }).getAppSettings())
      .resolves.toEqual(DEFAULT_DATABASE_SETTINGS);
    expect(transactionTenantIds).toEqual([harness.tenantOneId]);
  });

  it('projects only supported JSON string values without trimming or normalizing them', async () => {
    await seedSettings(harness.tenantOneId, {
      currencyUnit: '',
      className: '  햇살반  ',
      googleSheetsUrl: ' https://docs.google.com/spreadsheets/d/source-id ',
      googleSheetsId: ' source-id ',
      googleSheetsModifiedTime: ' 2026-08-29T01:02:03.000Z ',
      padletApiKey: '  secret value  ',
      ignoredFutureSetting: { unsafe: true },
    });

    await expect(queries().getAppSettings()).resolves.toEqual({
      currencyUnit: '',
      className: '  햇살반  ',
      googleSheetsUrl: ' https://docs.google.com/spreadsheets/d/source-id ',
      googleSheetsId: ' source-id ',
      googleSheetsModifiedTime: ' 2026-08-29T01:02:03.000Z ',
      padletApiKey: '  secret value  ',
      source: 'database',
      path: '',
    });
  });

  it('isolates the same supported setting key across two tenants', async () => {
    await seedSettings(harness.tenantOneId, { currencyUnit: '첫 반 화폐' });
    await seedSettings(harness.tenantTwoId, { currencyUnit: '둘째 반 화폐' });

    await expect(queries().getAppSettings()).resolves.toEqual({
      ...DEFAULT_DATABASE_SETTINGS,
      currencyUnit: '첫 반 화폐',
    });
    await expect(createDatabaseSettingsQueries({
      tenantId: harness.tenantTwoId,
      runTenantTransaction: harness.runTenantTransaction,
    }).getAppSettings()).resolves.toEqual({
      ...DEFAULT_DATABASE_SETTINGS,
      currencyUnit: '둘째 반 화폐',
    });
  });

  it('keeps the explicit tenant predicate behind a mismatched RLS context with a decoy row', async () => {
    await seedSettings(harness.tenantOneId, { currencyUnit: '첫 반 화폐' });
    await seedSettings(harness.tenantTwoId, { currencyUnit: '둘째 반 미끼' });
    const runWithTenantTwoContext: DatabaseSettingsQueryDependencies['runTenantTransaction'] =
      (_tenantId, callback) => harness.runTenantTransaction(harness.tenantTwoId, callback);

    await expect(queries({ runTenantTransaction: runWithTenantTwoContext }).getAppSettings())
      .resolves.toEqual(DEFAULT_DATABASE_SETTINGS);
  });

  it('rejects an unsupported tenant settings schema version even with no supported keys', async () => {
    await seedSettings(harness.tenantOneId, { ignoredFutureSetting: 'value' }, 2);

    await expect(queries().getAppSettings()).rejects.toThrow(/schema version/i);
  });

  it.each([
    ['number', 7],
    ['boolean', true],
    ['null', null],
    ['array', ['secret']],
    ['object', { secret: 'value' }],
  ])('rejects a supported %s value_json instead of coercing it', async (_label, value) => {
    await seedSettings(harness.tenantOneId, { padletApiKey: value });

    await expect(queries().getAppSettings()).rejects.toThrow(/JSON string/i);
  });

  it('fails closed on duplicate supported keys if database constraints are bypassed', async () => {
    const runTenantTransaction: DatabaseSettingsQueryDependencies['runTenantTransaction'] =
      async (_tenantId, callback) => callback({
        execute: async () => ({ rows: [
          {
            source_tenant_id: harness.tenantOneId,
            schema_version: 1,
            setting_key: 'currencyUnit',
            value_json: '별',
          },
          {
            source_tenant_id: harness.tenantOneId,
            schema_version: 1,
            setting_key: 'currencyUnit',
            value_json: '달란트',
          },
        ] }),
      } as unknown as TenantTransaction);

    await expect(queries({ runTenantTransaction }).getAppSettings())
      .rejects.toThrow(/duplicate/i);
  });

  it.each([
    ['wrong source tenant', {
      source_tenant_id: '20000000-0000-4000-8000-000000000099',
      schema_version: 1,
      setting_key: 'currencyUnit',
      value_json: '별',
    }, /source tenant/i],
    ['unsafe setting key', {
      source_tenant_id: '20000000-0000-4000-8000-000000000001',
      schema_version: 1,
      setting_key: 17,
      value_json: '별',
    }, /setting key/i],
  ])('validates %s row data at the projection boundary', async (_label, row, expectedError) => {
    const runTenantTransaction: DatabaseSettingsQueryDependencies['runTenantTransaction'] =
      async (_tenantId, callback) => callback({
        execute: async () => ({ rows: [row] }),
      } as unknown as TenantTransaction);

    await expect(queries({ runTenantTransaction }).getAppSettings())
      .rejects.toThrow(expectedError);
  });
});
