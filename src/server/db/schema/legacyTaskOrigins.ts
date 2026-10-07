import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { migrationSources } from './migrations';

export const legacyTaskOrigins = pgTable('legacy_task_origins', {
  tenantId: uuid('tenant_id').notNull(),
  originId: text('origin_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  sourceDigest: text('source_digest').notNull(),
  targetTable: text('target_table').$type<'task_assignments' | 'task_completions'>().notNull(),
  targetId: text('target_id').notNull(),
  historicalOperationId: text('historical_operation_id'),
  historicalOperationHash: text('historical_operation_hash'),
  sourceRows: jsonb('source_rows').$type<{ rowNumber: number; cells: string[]; digest: string }[]>().notNull(),
  projection: jsonb('projection').$type<Record<string, unknown>>().notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  primaryKey({ columns: [table.tenantId, table.originId] }),
  unique().on(table.tenantId, table.targetTable, table.targetId),
  unique().on(table.tenantId, table.historicalOperationId),
  foreignKey({ columns: [table.tenantId, table.jobId, table.sourceId], foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }),
  check('legacy_task_origins_origin_id_check', sql`${table.originId} ~ '^[a-f0-9]{64}$'`),
  check('legacy_task_origins_source_digest_check', sql`${table.sourceDigest} ~ '^[a-f0-9]{64}$'`),
  check('legacy_task_origins_target_table_check', sql`${table.targetTable} IN ('task_assignments','task_completions')`),
  check('legacy_task_origins_source_rows_check', sql`jsonb_typeof(${table.sourceRows})='array' AND jsonb_array_length(${table.sourceRows})>0`),
  check('legacy_task_origins_projection_check', sql`jsonb_typeof(${table.projection})='object'`),
  check('legacy_task_origins_check', sql`(${table.historicalOperationId} IS NULL)=(${table.historicalOperationHash} IS NULL)`),
  check('legacy_task_origins_check1', sql`${table.historicalOperationId} IS NULL OR (${table.targetTable}='task_completions'
    AND length(btrim(${table.historicalOperationId}))>0 AND ${table.historicalOperationHash} ~ '^(sha256:)?[a-f0-9]{64}$')`),
]);
