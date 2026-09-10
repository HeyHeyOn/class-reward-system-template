import 'server-only';
import { getDatabaseClient } from '@/server/db/client';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { getProductionTenantAccessDependencies } from '@/server/tenantAccess';
import { createFreezingConsentHandlers } from './freezingConsentHandlers';

/** Explicit server configuration only. No deployment-global Sheet, token or
 * request-selected origin fallback. Configuration is detached per request. */
export function getProductionFreezingConsentHandlers() {
  return createFreezingConsentHandlers(getProductionFreezingConsentDependencies());
}

export function getProductionFreezingConsentDependencies() {
  try {
    const env = Object.freeze({ ...process.env });
    const origin = env.MIGRATION_GOOGLE_OAUTH_ORIGIN;
    const raw = env.MIGRATION_GOOGLE_SHEET_REGISTRATIONS;
    if (env.CLASS_STORE_STORAGE !== 'postgresql' || !origin || !origin.startsWith('https://')
      || new URL(origin).origin !== origin || !raw || Buffer.byteLength(raw) > 128_000) throw Error();
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || !rows.length || rows.length > 256) throw Error();
    const seen = new Set<string>();
    const registeredSheets = rows.map(row => {
      if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'sourceId,spreadsheetId,tenantId'
        || typeof row.tenantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.tenantId)) throw Error();
      for (const field of ['sourceId','spreadsheetId']) if (typeof row[field] !== 'string' || !row[field]
        || row[field].trim() !== row[field] || row[field].length > (field === 'sourceId' ? 1024 : 512)) throw Error();
      const identity = JSON.stringify([row.tenantId, row.sourceId]);
      if (seen.has(identity)) throw Error();
      seen.add(identity);
      return Object.freeze({ tenantId: row.tenantId as string, sourceId: row.sourceId as string, spreadsheetId: row.spreadsheetId as string });
    });
    const runTransaction = createTenantTransactionRunner({
      get pool() { return getDatabaseClient().pool; },
    }, { maxAttempts: 1, isolationLevel: 'READ COMMITTED' });
    return { origin, env, registeredSheets, runTransaction,
      directory: getProductionTenantAccessDependencies() };
  } catch { throw Error('Freezing consent configuration refused.'); }
}
