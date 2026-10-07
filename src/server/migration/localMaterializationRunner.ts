import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import type { OwnedLocalMaterializationRunner } from './localCandidateMaterialization';
import { canonicalJson } from './validators';

/** Trusted, exclusively leased infrastructure handles, never request DTOs.
 * The allocator must prove ownership/isolation (e.g. the reviewed disposable PG
 * harness), install immutable markers, and close both DBs. No URL/default pool. */
export type OwnedSyntheticDatabaseLease = Readonly<{
  kind: 'SYNTHETIC_DISPOSABLE';
  databaseId: string;
  ownerId: string;
  runTransaction: TenantImportTransactionRunner;
  queryOwner: (statement: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}>;

const METADATA = new Set(['tenants','migration_jobs','migration_local_disposable_database']);
const IMPORTED = new Set(['tenant_settings','students','accounts','products','promotions','promotion_products','tasks',
  'task_allowed_students','task_assignments','transactions','transaction_items','adjustments','task_completions',
  'operations','padlet_evidence_claims','padlet_claim_digest_tombstones','padlet_claim_digest_registry',
  'migration_sources','migration_source_records','migration_snapshots','migration_local_materializations']);
const identifier = (value: string) => `"${value.replaceAll('"','""')}"`;
function refused(): never { throw new Error('Owned local database boundary refused.'); }

/** Owner readback is mandatory because tenant RLS and intentionally private
 * generator/authority tables cannot prove global vacancy through app_runtime.
 * Count only: never reads private field values and never grants new privileges.
 * The lease must remain exclusive through both transactions and their commits. */
export function createOwnedLocalMaterializationRunner(tenantId: string, migrationJobId: string,
  source: OwnedSyntheticDatabaseLease, destination: OwnedSyntheticDatabaseLease): OwnedLocalMaterializationRunner {
  let busy = false;
  return async (tenant, callback) => {
    if (busy || tenant !== tenantId || source === destination
      || source.kind !== 'SYNTHETIC_DISPOSABLE' || destination.kind !== 'SYNTHETIC_DISPOSABLE'
      || source.databaseId === destination.databaseId || source.ownerId !== destination.ownerId) refused();
    busy = true;
    try {
      const markers = await destination.queryOwner('SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database');
      const marker = markers.rows[0];
      if (markers.rows.length !== 1 || marker.database_id !== destination.databaseId || marker.owner_id !== destination.ownerId
        || marker.role !== 'DESTINATION' || marker.tenant_id !== tenantId || marker.job_id !== migrationJobId) refused();
      const jobs = await destination.queryOwner('SELECT tenant_id,job_id FROM migration_jobs');
      if (jobs.rows.length !== 1 || jobs.rows[0].tenant_id !== tenantId || jobs.rows[0].job_id !== migrationJobId) refused();
      const receipts = await destination.queryOwner('SELECT tenant_id,job_id FROM migration_local_materializations');
      if (receipts.rows.length > 1 || receipts.rows.some(row => row.tenant_id !== tenantId || row.job_id !== migrationJobId)) refused();
      const retry = receipts.rows.length === 1;
      const tables = await destination.queryOwner("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename");
      const columns = await destination.queryOwner("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('tenant_id','claimed_by_tenant_id')");
      for (const row of tables.rows) {
        if (typeof row.tablename !== 'string') refused();
        const table = row.tablename;
        const count = await destination.queryOwner(`SELECT count(*)::text AS count FROM ${identifier(table)}`);
        if (!METADATA.has(table) && (!retry || !IMPORTED.has(table)) && count.rows[0].count !== '0') refused();
        const tenantColumn = columns.rows.find(column => column.table_name === table)?.column_name;
        if (typeof tenantColumn === 'string') {
          const foreign = await destination.queryOwner(`SELECT count(*)::text AS count FROM ${identifier(table)} WHERE ${identifier(tenantColumn)} <> $1`, [tenantId]);
          if (foreign.rows[0].count !== '0') refused();
        }
      }
      return await source.runTransaction(tenant, sourceTx => destination.runTransaction(tenant, async destinationTx => {
        // An incomplete owner catalog can hide foreign/private rows from every
        // count above. Independently bind its exact inventory before any import,
        // retry or preparation callback; pg_tables names are not tenant-RLS data.
        const actual = await destinationTx.execute(sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename`);
        if (canonicalJson(tables.rows) !== canonicalJson(actual.rows)) refused();
        return callback({
          source: sourceTx, destination: destinationTx, ownerId: source.ownerId,
          sourceDatabaseId: source.databaseId, destinationDatabaseId: destination.databaseId,
        });
      }));
    } finally { busy = false; }
  };
}
