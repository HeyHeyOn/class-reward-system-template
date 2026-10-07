import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { migrationSources } from './migrations';

export const legacyFullSnapshotArchives = pgTable('legacy_full_snapshot_archives', {
  tenantId: uuid('tenant_id').notNull(), jobId: text('job_id').notNull(), sourceId: text('source_id').notNull(),
  sourceDigest: text('source_digest').notNull(), projectionDigest: text('projection_digest').notNull(),
  gridJson: text('grid_json').notNull(), physicalRows: integer('physical_rows').notNull(), businessRows: integer('business_rows').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(), importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  primaryKey({ columns: [table.tenantId, table.jobId, table.sourceId] }),
  foreignKey({ columns: [table.tenantId, table.jobId, table.sourceId], foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }),
  check('legacy_full_snapshot_archives_source_digest_check', sql`${table.sourceDigest} ~ '^[a-f0-9]{64}$'`),
  check('legacy_full_snapshot_archives_projection_digest_check', sql`${table.projectionDigest} ~ '^[a-f0-9]{64}$'`),
  check('legacy_full_snapshot_archives_grid_json_check', sql`octet_length(${table.gridJson})<=32000000`),
  check('legacy_full_snapshot_archives_physical_rows_check', sql`${table.physicalRows}>=0`),
  check('legacy_full_snapshot_archives_check', sql`${table.businessRows}>=0 AND ${table.businessRows}<=${table.physicalRows}`),
]);
