import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { migrationSources } from './migrations';

// NON-AUTHORITY storage. Forced RLS and immutable triggers live in migration 0013.
export const migrationAuthorityReceipts = pgTable('migration_authority_receipts', {
  tenantId: uuid('tenant_id').notNull(),
  receiptId: uuid('receipt_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  provider: text('provider').notNull(),
  externalSourceId: text('external_source_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  actorSubject: text('actor_subject').notNull(),
  action: text('action').notNull(),
  expectedStatus: text('expected_status').notNull(),
  expectedStateVersion: bigint('expected_state_version', { mode: 'bigint' }).notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  issuedAtMs: bigint('issued_at_ms', { mode: 'bigint' }).notNull(),
  expiresAtMs: bigint('expires_at_ms', { mode: 'bigint' }).notNull(),
  issuerDigest: text('issuer_digest').notNull(),
  contentDigest: text('content_digest').notNull(),
  finalSheetDigest: text('final_sheet_digest'),
  finalRedisDigest: text('final_redis_digest'),
  finalReportDigest: text('final_report_digest'),
}, (table) => [
  primaryKey({ name: 'migration_authority_receipts_pkey', columns: [table.tenantId, table.receiptId] }),
  foreignKey({ name: 'migration_authority_receipts_source_fk', columns: [table.tenantId, table.jobId, table.sourceId], foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }),
  foreignKey({ name: 'migration_authority_receipts_actor_fk', columns: [table.actorUserId], foreignColumns: [users.id] }),
  check('migration_authority_receipts_ids_check', sql`
    length(${table.jobId}) BETWEEN 1 AND 1024 AND ${table.jobId}=btrim(${table.jobId})
    AND length(${table.sourceId}) BETWEEN 1 AND 1024 AND ${table.sourceId}=btrim(${table.sourceId})
    AND length(${table.externalSourceId}) BETWEEN 1 AND 1024 AND ${table.externalSourceId}=btrim(${table.externalSourceId})
    AND length(${table.actorSubject}) BETWEEN 1 AND 255 AND ${table.actorSubject}=btrim(${table.actorSubject})
    AND ${table.provider}='GOOGLE_SHEETS'`),
  check('migration_authority_receipts_version_check', sql`${table.expectedStateVersion} BETWEEN 1 AND 9007199254740991`),
  check('migration_authority_receipts_time_check', sql`
    ${table.issuedAtMs} BETWEEN 0 AND 9007199254140991
    AND ${table.expiresAtMs}>${table.issuedAtMs} AND ${table.expiresAtMs}<=${table.issuedAtMs}+600000`),
  check('migration_authority_receipts_digest_check', sql`
    ${table.sourceFingerprint} ~ '^[0-9a-f]{64}$' AND ${table.issuerDigest} ~ '^[0-9a-f]{64}$' AND ${table.contentDigest} ~ '^[0-9a-f]{64}$'`),
  check('migration_authority_receipts_action_check', sql`
    (${table.action} IN ('START_FREEZING_APPROVAL','FREEZING_CONSENT') AND ${table.expectedStatus}='READY'
      AND ${table.finalSheetDigest} IS NULL AND ${table.finalRedisDigest} IS NULL AND ${table.finalReportDigest} IS NULL)
    OR (${table.action}='ACTIVATE_APPROVAL' AND ${table.expectedStatus}='FINAL_IMPORT'
      AND ${table.finalSheetDigest} IS NOT NULL AND ${table.finalSheetDigest} ~ '^[0-9a-f]{64}$'
      AND ${table.finalRedisDigest} IS NOT NULL AND ${table.finalRedisDigest} ~ '^[0-9a-f]{64}$'
      AND ${table.finalReportDigest} IS NOT NULL AND ${table.finalReportDigest} ~ '^[0-9a-f]{64}$')`),
]);

export const migrationAuthorityReplays = pgTable('migration_authority_replays', {
  replayDigest: text('replay_digest').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  receiptId: uuid('receipt_id').notNull(),
}, (table) => [
  primaryKey({ name: 'migration_authority_replays_pkey', columns: [table.replayDigest] }),
  unique('migration_authority_replays_receipt_unique').on(table.tenantId, table.receiptId),
  foreignKey({ name: 'migration_authority_replays_receipt_fk', columns: [table.tenantId, table.receiptId], foreignColumns: [migrationAuthorityReceipts.tenantId, migrationAuthorityReceipts.receiptId] }),
  check('migration_authority_replays_digest_check', sql`${table.replayDigest} ~ '^[0-9a-f]{64}$'`),
]);
