import { sql } from 'drizzle-orm';
import {
  bigint, check, foreignKey, index, integer, jsonb, pgTable, primaryKey,
  text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';
import { operations } from './operations';
import { tenants } from './tenants';

export const migrationJobStatuses = [
  'DISCOVERED', 'VALIDATED', 'IMPORTING', 'RECONCILING', 'READY', 'FREEZING',
  'FINAL_IMPORT', 'ACTIVE', 'FAILED', 'ABORTED',
] as const;

export const migrationJobs = pgTable('migration_jobs', {
  tenantId: uuid('tenant_id').notNull(),
  jobId: text('job_id').notNull(),
  status: text('status').$type<(typeof migrationJobStatuses)[number]>().default('DISCOVERED').notNull(),
  stateVersion: bigint('state_version', { mode: 'bigint' }).default(BigInt(1)).notNull(),
  sourceFingerprint: text('source_fingerprint'),
  finalFingerprint: text('final_fingerprint'),
  freezeStartedAt: timestamp('freeze_started_at', { withTimezone: true }),
  freezeVerifiedAt: timestamp('freeze_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ name: 'migration_jobs_pkey', columns: [table.tenantId, table.jobId] }),
  foreignKey({ name: 'migration_jobs_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  check('migration_jobs_id_check', sql`${table.jobId}=btrim(${table.jobId}) AND length(${table.jobId})>0`),
  check('migration_jobs_status_check', sql`${table.status} IN ('DISCOVERED','VALIDATED','IMPORTING','RECONCILING','READY','FREEZING','FINAL_IMPORT','ACTIVE','FAILED','ABORTED')`),
  check('migration_jobs_state_version_check', sql`${table.stateVersion} BETWEEN 1 AND 9007199254740991`),
  check('migration_jobs_hashes_check', sql`(${table.sourceFingerprint} IS NULL OR ${table.sourceFingerprint} ~ '^[0-9a-f]{64}$') AND (${table.finalFingerprint} IS NULL OR ${table.finalFingerprint} ~ '^[0-9a-f]{64}$')`),
  check('migration_jobs_freeze_shape_check', sql`${table.freezeVerifiedAt} IS NULL OR (${table.freezeStartedAt} IS NOT NULL AND ${table.freezeVerifiedAt} >= ${table.freezeStartedAt})`),
  check('migration_jobs_terminal_shape_check', sql`(${table.status}='ACTIVE' AND ${table.finalFingerprint} IS NOT NULL AND ${table.freezeStartedAt} IS NOT NULL AND ${table.freezeVerifiedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL) OR (${table.status} IN ('FAILED','ABORTED') AND ${table.completedAt} IS NOT NULL) OR (${table.status} NOT IN ('ACTIVE','FAILED','ABORTED') AND ${table.completedAt} IS NULL)`),
  check('migration_jobs_chronology_check', sql`${table.updatedAt} >= COALESCE(${table.completedAt}, ${table.freezeVerifiedAt}, ${table.freezeStartedAt}, ${table.createdAt}) AND (${table.freezeStartedAt} IS NULL OR ${table.freezeStartedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= COALESCE(${table.freezeVerifiedAt}, ${table.freezeStartedAt}, ${table.createdAt}))`),
]);

export const migrationSources = pgTable('migration_sources', {
  tenantId: uuid('tenant_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  provider: text('provider').$type<'GOOGLE_SHEETS' | 'LEGACY_REDIS_BRIDGE'>().notNull(),
  externalSourceId: text('external_source_id').notNull(),
  ownershipSubjectHash: text('ownership_subject_hash'),
  schemaVersion: integer('schema_version'),
  sourceFingerprint: text('source_fingerprint').notNull(),
  grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }),
  grantDeletedAt: timestamp('grant_deleted_at', { withTimezone: true }),
  boundAt: timestamp('bound_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'migration_sources_pkey', columns: [table.tenantId, table.sourceId] }),
  unique('migration_sources_job_binding_unique').on(table.tenantId, table.jobId, table.sourceId),
  unique('migration_sources_global_owner_unique').on(table.provider, table.externalSourceId),
  foreignKey({ name: 'migration_sources_job_fk', columns: [table.tenantId, table.jobId], foreignColumns: [migrationJobs.tenantId, migrationJobs.jobId] }).onDelete('cascade'),
  check('migration_sources_ids_check', sql`${table.sourceId}=btrim(${table.sourceId}) AND length(${table.sourceId})>0 AND ${table.externalSourceId}=btrim(${table.externalSourceId}) AND length(${table.externalSourceId})>0`),
  check('migration_sources_provider_check', sql`${table.provider} IN ('GOOGLE_SHEETS','LEGACY_REDIS_BRIDGE')`),
  check('migration_sources_hashes_check', sql`${table.sourceFingerprint} ~ '^[0-9a-f]{64}$' AND (${table.ownershipSubjectHash} IS NULL OR ${table.ownershipSubjectHash} ~ '^[0-9a-f]{64}$')`),
  check('migration_sources_schema_version_check', sql`${table.schemaVersion} IS NULL OR ${table.schemaVersion} >= 1`),
  check('migration_sources_chronology_check', sql`(${table.grantExpiresAt} IS NULL OR ${table.grantExpiresAt} >= ${table.boundAt}) AND (${table.grantDeletedAt} IS NULL OR ${table.grantDeletedAt} >= ${table.boundAt})`),
]);

export const migrationSourceRecords = pgTable('migration_source_records', {
  tenantId: uuid('tenant_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  recordId: text('record_id').notNull(),
  sourceCollection: text('source_collection').notNull(),
  sourceRecordId: text('source_record_id').notNull(),
  sourceRowNumber: bigint('source_row_number', { mode: 'bigint' }),
  sourceRowHash: text('source_row_hash').notNull(),
  redactedRecord: jsonb('redacted_record').$type<Record<string, unknown>>().notNull(),
  canonicalRecord: jsonb('canonical_record').$type<Record<string, unknown>>(),
  mappingStatus: text('mapping_status').$type<'STAGED' | 'IMPORTED' | 'QUARANTINED' | 'SKIPPED'>().default('STAGED').notNull(),
  targetTable: text('target_table'),
  targetId: text('target_id'),
  warningDetails: jsonb('warning_details').$type<unknown[]>().default([]).notNull(),
  errorDetails: jsonb('error_details').$type<unknown[]>().default([]).notNull(),
  stagedAt: timestamp('staged_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'migration_source_records_pkey', columns: [table.tenantId, table.recordId] }),
  unique('migration_source_records_source_record_unique').on(table.tenantId, table.sourceId, table.sourceCollection, table.sourceRecordId),

  foreignKey({ name: 'migration_source_records_source_fk', columns: [table.tenantId, table.jobId, table.sourceId], foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }).onDelete('cascade'),
  check('migration_source_records_ids_check', sql`${table.recordId}=btrim(${table.recordId}) AND length(${table.recordId})>0 AND ${table.sourceCollection}=btrim(${table.sourceCollection}) AND length(${table.sourceCollection})>0 AND ${table.sourceRecordId}=btrim(${table.sourceRecordId}) AND length(${table.sourceRecordId})>0`),
  check('migration_source_records_row_number_check', sql`${table.sourceRowNumber} IS NULL OR ${table.sourceRowNumber} BETWEEN 1 AND 9007199254740991`),
  check('migration_source_records_hash_check', sql`${table.sourceRowHash} ~ '^[0-9a-f]{64}$'`),
  check('migration_source_records_json_check', sql`jsonb_typeof(${table.redactedRecord})='object' AND (${table.canonicalRecord} IS NULL OR jsonb_typeof(${table.canonicalRecord})='object') AND jsonb_typeof(${table.warningDetails})='array' AND jsonb_typeof(${table.errorDetails})='array'`),
  check('migration_source_records_sensitive_keys_check', sql`NOT jsonb_has_sensitive_top_level_key(${table.redactedRecord})`),
  check('migration_source_records_status_check', sql`${table.mappingStatus} IN ('STAGED','IMPORTED','QUARANTINED','SKIPPED')`),
  check('migration_source_records_target_check', sql`(${table.mappingStatus}='IMPORTED' AND ${table.targetTable} IS NOT NULL AND length(btrim(${table.targetTable}))>0 AND ${table.targetId} IS NOT NULL AND length(btrim(${table.targetId}))>0) OR (${table.mappingStatus}<>'IMPORTED' AND ${table.targetTable} IS NULL AND ${table.targetId} IS NULL)`),
]);

export const migrationSnapshots = pgTable('migration_snapshots', {
  tenantId: uuid('tenant_id').notNull(), jobId: text('job_id').notNull(), sourceId: text('source_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  phase: text('phase').$type<'PREFLIGHT' | 'FINAL_FROZEN' | 'ROLLBACK_EXPORT'>().notNull(),
  artifactDigest: text('artifact_digest').notNull(),
  redactedManifest: jsonb('redacted_manifest').$type<Record<string, unknown>>().notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
  sourceMaxModifiedAt: timestamp('source_max_modified_at', { withTimezone: true }),
  rowCount: bigint('row_count', { mode: 'bigint' }).notNull(),
}, (table) => [
  primaryKey({ name: 'migration_snapshots_pkey', columns: [table.tenantId, table.snapshotId] }),
  unique('migration_snapshots_idempotency_unique').on(table.tenantId, table.sourceId, table.phase, table.artifactDigest),
  foreignKey({ name: 'migration_snapshots_source_fk', columns: [table.tenantId, table.jobId, table.sourceId], foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }).onDelete('cascade'),
  check('migration_snapshots_id_check', sql`${table.snapshotId}=btrim(${table.snapshotId}) AND length(${table.snapshotId})>0`),
  check('migration_snapshots_phase_check', sql`${table.phase} IN ('PREFLIGHT','FINAL_FROZEN','ROLLBACK_EXPORT')`),
  check('migration_snapshots_digest_check', sql`${table.artifactDigest} ~ '^[0-9a-f]{64}$'`),
  check('migration_snapshots_manifest_check', sql`jsonb_typeof(${table.redactedManifest})='object' AND NOT jsonb_has_sensitive_top_level_key(${table.redactedManifest})`),
  check('migration_snapshots_count_check', sql`${table.rowCount} BETWEEN 0 AND 9007199254740991`),
]);

export const reconciliationResults = pgTable('reconciliation_results', {
  tenantId: uuid('tenant_id').notNull(), jobId: text('job_id').notNull(), resultId: text('result_id').notNull(),
  category: text('category').notNull(), expectedCount: bigint('expected_count', { mode: 'bigint' }).notNull(),
  actualCount: bigint('actual_count', { mode: 'bigint' }).notNull(), delta: bigint('delta', { mode: 'bigint' }).notNull(),
  status: text('status').$type<'MATCH' | 'MISMATCH' | 'BLOCKED'>().notNull(),
  diagnostics: jsonb('diagnostics').$type<unknown[]>().default([]).notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'reconciliation_results_pkey', columns: [table.tenantId, table.resultId] }),
  unique('reconciliation_results_job_category_unique').on(table.tenantId, table.jobId, table.category),
  foreignKey({ name: 'reconciliation_results_job_fk', columns: [table.tenantId, table.jobId], foreignColumns: [migrationJobs.tenantId, migrationJobs.jobId] }).onDelete('cascade'),
  check('reconciliation_results_category_check', sql`${table.category} IN ('STUDENTS','BALANCES','PRODUCTS','STOCK','TRANSACTIONS','CANCELLATIONS','TASKS','ASSIGNMENTS','COMPLETIONS','PROMOTIONS','RECURRENCE','PADLET_CLAIMS','OPERATION_BINDINGS')`),
  check('reconciliation_results_id_check', sql`${table.resultId}=btrim(${table.resultId}) AND length(${table.resultId})>0`),
  check('reconciliation_results_safe_check', sql`${table.expectedCount} BETWEEN 0 AND 9007199254740991 AND ${table.actualCount} BETWEEN 0 AND 9007199254740991 AND ${table.delta} BETWEEN -9007199254740991 AND 9007199254740991`),
  check('reconciliation_results_status_check', sql`${table.status} IN ('MATCH','MISMATCH','BLOCKED')`),
  check('reconciliation_results_arithmetic_check', sql`${table.delta}=${table.actualCount}-${table.expectedCount} AND (${table.status}<>'MATCH' OR (${table.delta}=0 AND ${table.expectedCount}=${table.actualCount}))`),
  check('reconciliation_results_diagnostics_check', sql`jsonb_typeof(${table.diagnostics})='array'`),
]);

export const auditEvents = pgTable('audit_events', {
  tenantId: uuid('tenant_id').notNull(), eventId: text('event_id').notNull(), operationId: text('operation_id'),
  jobId: text('job_id'), actorUserId: uuid('actor_user_id'), eventType: text('event_type').notNull(),
  entityType: text('entity_type'), entityId: text('entity_id'),
  redactedDetails: jsonb('redacted_details').$type<Record<string, unknown>>().default({}).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'audit_events_pkey', columns: [table.tenantId, table.eventId] }),
  foreignKey({ name: 'audit_events_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  foreignKey({ name: 'audit_events_operation_fk', columns: [table.tenantId, table.operationId], foreignColumns: [operations.tenantId, operations.operationId] }),
  foreignKey({ name: 'audit_events_job_fk', columns: [table.tenantId, table.jobId], foreignColumns: [migrationJobs.tenantId, migrationJobs.jobId] }),
  foreignKey({ name: 'audit_events_actor_fk', columns: [table.actorUserId], foreignColumns: [users.id] }),
  index('audit_events_tenant_chronology_idx').on(table.tenantId, table.occurredAt.desc(), table.eventId),
  check('audit_events_id_type_check', sql`${table.eventId}=btrim(${table.eventId}) AND length(${table.eventId})>0 AND length(btrim(${table.eventType}))>0`),
  check('audit_events_entity_check', sql`(${table.entityType} IS NULL)=(${table.entityId} IS NULL) AND (${table.entityType} IS NULL OR (length(btrim(${table.entityType}))>0 AND length(btrim(${table.entityId}))>0))`),
  check('audit_events_details_check', sql`jsonb_typeof(${table.redactedDetails})='object' AND NOT jsonb_has_sensitive_top_level_key(${table.redactedDetails})`),
]);

export const exports = pgTable('exports', {
  tenantId: uuid('tenant_id').notNull(), exportId: text('export_id').notNull(), jobId: text('job_id'),
  kind: text('kind').$type<'MIGRATION_REPORT' | 'ROLLBACK_DELTA' | 'CSV' | 'XLSX' | 'SHEETS_COMPATIBLE'>().notNull(),
  status: text('status').$type<'PENDING' | 'READY' | 'FAILED' | 'EXPIRED'>().default('PENDING').notNull(),
  artifactDigest: text('artifact_digest'), artifactPath: text('artifact_path'),
  redactedMetadata: jsonb('redacted_metadata').$type<Record<string, unknown>>().default({}).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ name: 'exports_pkey', columns: [table.tenantId, table.exportId] }),
  foreignKey({ name: 'exports_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  foreignKey({ name: 'exports_job_fk', columns: [table.tenantId, table.jobId], foreignColumns: [migrationJobs.tenantId, migrationJobs.jobId] }),
  check('exports_id_check', sql`${table.exportId}=btrim(${table.exportId}) AND length(${table.exportId})>0`),
  check('exports_kind_check', sql`${table.kind} IN ('MIGRATION_REPORT','ROLLBACK_DELTA','CSV','XLSX','SHEETS_COMPATIBLE')`),
  check('exports_status_check', sql`${table.status} IN ('PENDING','READY','FAILED','EXPIRED')`),
  check('exports_artifact_check', sql`(${table.artifactDigest} IS NULL)=(${table.artifactPath} IS NULL) AND ((${table.status}='READY' AND ${table.artifactDigest} ~ '^[0-9a-f]{64}$' AND length(btrim(${table.artifactPath}))>0) OR (${table.status}<>'READY' AND ${table.artifactDigest} IS NULL))`),
  check('exports_terminal_shape_check', sql`(${table.status}='PENDING' AND ${table.completedAt} IS NULL) OR (${table.status} IN ('READY','FAILED') AND ${table.completedAt} IS NOT NULL) OR (${table.status}='EXPIRED' AND ${table.completedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.completedAt}>=${table.expiresAt})`),
  check('exports_metadata_check', sql`jsonb_typeof(${table.redactedMetadata})='object' AND NOT jsonb_has_sensitive_top_level_key(${table.redactedMetadata})`),
  check('exports_chronology_check', sql`(${table.completedAt} IS NULL OR ${table.completedAt}>=${table.createdAt}) AND (${table.expiresAt} IS NULL OR ${table.expiresAt}>=${table.createdAt})`),
]);
