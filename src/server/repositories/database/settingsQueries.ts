import 'server-only';

import { sql } from 'drizzle-orm';
import type { AppSettings, DatabaseAppSettings } from '@/server/settings';
import type { TenantTransaction } from '@/server/db/transaction';
import { safeInteger } from '@/server/repositories/database/queryProjection';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseSettingsQueryDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
}>;


type SupportedSettingKey =
  | 'currencyUnit'
  | 'className'
  | 'googleSheetsUrl'
  | 'googleSheetsId'
  | 'googleSheetsModifiedTime'
  | 'padletApiKey';

type SettingRow = {
  source_tenant_id: unknown;
  schema_version: unknown;
  setting_key: unknown;
  value_json: unknown;
};

const SUPPORTED_SETTING_KEYS = new Set<SupportedSettingKey>([
  'currencyUnit',
  'className',
  'googleSheetsUrl',
  'googleSheetsId',
  'googleSheetsModifiedTime',
  'padletApiKey',
]);

const DEFAULT_VALUES: Readonly<Record<SupportedSettingKey, string>> = {
  currencyUnit: '달란트',
  className: '',
  googleSheetsUrl: '',
  googleSheetsId: '',
  googleSheetsModifiedTime: '',
  padletApiKey: '',
};

export function createDatabaseSettingsQueries(
  dependencies: DatabaseSettingsQueryDependencies,
) {
  return {
    async getAppSettings(): Promise<AppSettings> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT ts.tenant_id AS source_tenant_id,
                 ts.schema_version,
                 entry.key AS setting_key,
                 entry.value AS value_json
          FROM tenant_settings ts
          LEFT JOIN LATERAL jsonb_each(ts.settings) AS entry(key, value)
            ON entry.key IN (
              'currencyUnit',
              'className',
              'googleSheetsUrl',
              'googleSheetsId',
              'googleSheetsModifiedTime',
              'padletApiKey'
            )
          WHERE ts.tenant_id = ${dependencies.tenantId}
        `);
        return projectSettings(result.rows as SettingRow[], dependencies.tenantId);
      });
    },
  };
}

function projectSettings(rows: SettingRow[], tenantId: string): DatabaseAppSettings {
  const values: Record<SupportedSettingKey, string> = { ...DEFAULT_VALUES };
  const seen = new Set<SupportedSettingKey>();

  for (const row of rows) {
    if (typeof row.source_tenant_id !== 'string' || row.source_tenant_id !== tenantId) {
      throw new Error('Tenant settings source tenant is invalid.');
    }
    if (safeInteger(row.schema_version, 'Tenant settings schema version') !== 1) {
      throw new Error('Tenant settings schema version is unsupported.');
    }
    if (row.setting_key === null) continue;
    if (typeof row.setting_key !== 'string') {
      throw new Error('Tenant setting key must be a string.');
    }
    if (!SUPPORTED_SETTING_KEYS.has(row.setting_key as SupportedSettingKey)) continue;

    const key = row.setting_key as SupportedSettingKey;
    if (seen.has(key)) throw new Error(`Tenant setting ${key} returned duplicate rows.`);
    if (typeof row.value_json !== 'string') {
      throw new Error(`Tenant setting ${key} value_json must be a JSON string.`);
    }
    seen.add(key);
    values[key] = row.value_json;
  }

  return {
    ...values,
    source: 'database',
    path: '',
  };
}