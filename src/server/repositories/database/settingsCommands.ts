import 'server-only';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { FONT_FAMILY_OPTIONS, type FontFamily } from '@/lib/fontSettings';
import type { TenantTransaction } from '@/server/db/transaction';
import { safeInteger } from './queryProjection';
import { appendOperationAudit } from './operationAudit';
import { storedQrManualInputEnabled } from './settingsBoolean';

// One theme now; the earlier names are still accepted (an open admin page, migrated classes) and read as it.
const themes = ['white'] as const;
const retiredThemes = ['blue', 'pink', 'yellow', 'green', 'purple', 'black', 'navy'];
const editKeys = ['currencyUnit', 'appTitle', 'bankTitle', 'themeColor', 'fontFamily', 'qrManualInputEnabled'] as const;
type Editable = { currencyUnit: string; appTitle: string; bankTitle: string; themeColor: typeof themes[number]; fontFamily: FontFamily; qrManualInputEnabled: boolean };
export type PublicDatabaseSettings = Editable & { source: 'database'; className: string; classTimeZone: 'Asia/Seoul'; settingsVersion: number };
type SaveInput = Editable & { operationId: string; expectedSettingsVersion: number };
type Dependencies = { tenantId: string; runTenantTransaction: <T>(tenantId: string, callback: (tx: TenantTransaction) => Promise<T>) => Promise<T> };
const defaults: Editable = { currencyUnit: '원', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false };

export class SettingsInputError extends Error {}
export class SettingsConflictError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function edits(value: unknown): Editable {
  if (!record(value)) throw new SettingsInputError('설정 값을 확인해 주세요.');
  for (const key of ['currencyUnit', 'appTitle', 'bankTitle'] as const) {
    const text = value[key];
    if (typeof text !== 'string' || !text || text !== text.trim() || text.length > (key === 'currencyUnit' ? 20 : 80)
      || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)) throw new SettingsInputError('화폐 단위와 제목의 길이, 공백을 확인해 주세요.');
  }
  if (!themes.includes(value.themeColor as Editable['themeColor']) && !retiredThemes.includes(value.themeColor as string)
    || !FONT_FAMILY_OPTIONS.some(option => option.value === value.fontFamily)
    || typeof value.qrManualInputEnabled !== 'boolean') throw new SettingsInputError('테마, 글꼴, QR 설정을 확인해 주세요.');
  return { ...Object.fromEntries(editKeys.map(key => [key, value[key]])), themeColor: 'white' } as Editable;
}
function parseInput(value: unknown): SaveInput {
  if (!record(value) || Object.keys(value).length !== editKeys.length + 2
    || Object.keys(value).some(key => ![...editKeys, 'operationId', 'expectedSettingsVersion'].includes(key))
    || typeof value.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.operationId)
    || !Number.isSafeInteger(value.expectedSettingsVersion) || Number(value.expectedSettingsVersion) < 0
    || Number(value.expectedSettingsVersion) >= Number.MAX_SAFE_INTEGER) throw new SettingsInputError('올바른 설정 저장 요청이 아니에요. 다시 불러와 주세요.');
  return { operationId: value.operationId, expectedSettingsVersion: Number(value.expectedSettingsVersion), ...edits(value) };
}
function project(settings: unknown, version: unknown, schemaVersion: unknown): PublicDatabaseSettings {
  // The importer retains the source Sheets schema (1–4) on this row. The
  // editable PostgreSQL JSON contract is shared by all four admitted versions.
  if (!record(settings) || ![1, 2, 3, 4].includes(safeInteger(schemaVersion, 'Settings schema'))) throw new Error('Invalid settings schema.');
  const settingsVersion = safeInteger(version, 'Settings version');
  if (settingsVersion < 0) throw new Error('Invalid settings version.');
  // This is the browser contract. Migration source IDs and Padlet/API secrets
  // stay in storage and must never be serialized by a public settings endpoint.
  const selected = Object.fromEntries(editKeys.map(key => [key, settings[key] ?? defaults[key]]));
  selected.qrManualInputEnabled = storedQrManualInputEnabled(selected.qrManualInputEnabled);
  if (settings.className !== undefined && typeof settings.className !== 'string') throw new Error('Invalid class name.');
  return { ...edits(selected), className: typeof settings.className === 'string' ? settings.className : '',
    classTimeZone: 'Asia/Seoul', source: 'database', settingsVersion };
}

export function createDatabaseSettingsCommands(dependencies: Dependencies) {
  return {
    async get(): Promise<PublicDatabaseSettings> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async tx => {
        const result = await tx.execute(sql`SELECT settings, version, schema_version FROM tenant_settings WHERE tenant_id=${dependencies.tenantId}`);
        const row = result.rows[0] as Record<string, unknown> | undefined;
        return row ? project(row.settings, row.version, row.schema_version) : project({}, 0, 1);
      });
    },
    async save(raw: unknown): Promise<PublicDatabaseSettings> {
      const input = parseInput(raw);
      const update = edits(input);
      const payloadHash = createHash('sha256').update(JSON.stringify({ expectedSettingsVersion: input.expectedSettingsVersion, ...update })).digest('hex');
      return dependencies.runTenantTransaction(dependencies.tenantId, async tx => {
        const tenant = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${dependencies.tenantId} FOR SHARE`);
        if (tenant.rows.length !== 1 || tenant.rows[0].lifecycle !== 'ACTIVE') throw new SettingsConflictError('학급이 사용 중 상태가 아니에요.');
        const now = new Date();
        const inserted = await tx.execute(sql`INSERT INTO operations
          (tenant_id, operation_id, operation_kind, payload_hash, status, started_at, created_at, updated_at)
          VALUES (${dependencies.tenantId},${input.operationId},'SETTINGS_ADMIN',${payloadHash},'PENDING',${now},${now},${now})
          ON CONFLICT (tenant_id,operation_id) DO NOTHING RETURNING operation_id`);
        if (!inserted.rows.length) {
          const existing = await tx.execute(sql`SELECT operation_kind,payload_hash,status,result_snapshot FROM operations
            WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId} FOR UPDATE`);
          const row = existing.rows[0];
          if (!row || row.operation_kind !== 'SETTINGS_ADMIN' || row.payload_hash !== payloadHash || row.status !== 'SUCCEEDED'
            || !record(row.result_snapshot)) throw new SettingsConflictError('저장 요청이 충돌했어요.');
          const snapshot = row.result_snapshot;
          const result = project(snapshot, snapshot.settingsVersion, 1);
          if (result.settingsVersion !== input.expectedSettingsVersion + 1
            || editKeys.some(key => result[key] !== update[key])) throw new Error('Settings receipt integrity failed.');
          return result;
        }
        // Also serializes initialization when an older ACTIVE tenant has no
        // settings row yet. Other kinds of tenant operations are not serialized.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${dependencies.tenantId + ':settings'},0))`);
        const current = await tx.execute(sql`SELECT settings,version,schema_version FROM tenant_settings
          WHERE tenant_id=${dependencies.tenantId} FOR UPDATE`);
        const row = current.rows[0];
        const version = row ? safeInteger(row.version, 'Settings version') : 0;
        if (version !== input.expectedSettingsVersion) throw new SettingsConflictError('다른 화면에서 설정을 변경했어요. 다시 불러온 뒤 저장해 주세요.');
        if (row && (![1, 2, 3, 4].includes(safeInteger(row.schema_version, 'Settings schema')) || !record(row.settings))) throw new Error('Invalid settings schema.');
        const merged = { ...(row?.settings as Record<string, unknown> ?? {}), ...update };
        const result = project(merged, version + 1, 1);
        if (row) {
          await tx.execute(sql`UPDATE tenant_settings SET settings=${JSON.stringify(merged)}::jsonb,
            version=${version + 1},updated_at=${now} WHERE tenant_id=${dependencies.tenantId} AND version=${version}`);
        } else {
          await tx.execute(sql`INSERT INTO tenant_settings(tenant_id,settings) VALUES (${dependencies.tenantId},${JSON.stringify(merged)}::jsonb)`);
        }
        await appendOperationAudit(tx, dependencies.tenantId, { operationId: input.operationId,
          eventType: 'SETTINGS_UPDATED', entityType: 'TENANT_SETTINGS', entityId: dependencies.tenantId,
          redactedDetails: { versionBefore: version, versionAfter: version + 1, changedFields: editKeys }, occurredAt: now });
        await tx.execute(sql`UPDATE operations SET status='SUCCEEDED',result_snapshot=${JSON.stringify(result)}::jsonb,
          finished_at=${now},updated_at=${now} WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}`);
        return result;
      });
    },
  };
}
