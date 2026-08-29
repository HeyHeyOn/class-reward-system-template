import { sql } from 'drizzle-orm';
import {
  bigint, check, foreignKey, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const operationKinds = [
  'CHECKOUT', 'CANCELLATION', 'ADMIN_ADJUSTMENT', 'TASK_REWARD',
  'STUDENT_ADMIN', 'PRODUCT_ADMIN', 'PROMOTION_ADMIN', 'TASK_ADMIN', 'SETTINGS_ADMIN',
  'MIGRATION_IMPORT', 'CUTOVER', 'EXPORT',
] as const;
export const operationStatuses = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;

export const operations = pgTable('operations', {
  tenantId: uuid('tenant_id').notNull(),
  operationId: text('operation_id').notNull(),
  operationKind: text('operation_kind').$type<(typeof operationKinds)[number]>().notNull(),
  payloadHash: text('payload_hash').notNull(),
  status: text('status').$type<(typeof operationStatuses)[number]>().default('PENDING').notNull(),
  resultSnapshot: jsonb('result_snapshot').$type<Record<string, unknown>>(),
  failureCode: text('failure_code'),
  attemptCount: bigint('attempt_count', { mode: 'bigint' }).default(BigInt(1)).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'operations_pkey', columns: [table.tenantId, table.operationId] }),
  foreignKey({ name: 'operations_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  check('operations_id_check', sql`${table.operationId} = btrim(${table.operationId}) AND length(${table.operationId}) > 0`),
  check('operations_kind_check', sql`${table.operationKind} IN ('CHECKOUT','CANCELLATION','ADMIN_ADJUSTMENT','TASK_REWARD','STUDENT_ADMIN','PRODUCT_ADMIN','PROMOTION_ADMIN','TASK_ADMIN','SETTINGS_ADMIN','MIGRATION_IMPORT','CUTOVER','EXPORT')`),
  check('operations_payload_hash_check', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
  check('operations_status_check', sql`${table.status} IN ('PENDING','SUCCEEDED','FAILED')`),
  check('operations_failure_code_check', sql`${table.failureCode} IS NULL OR length(btrim(${table.failureCode})) > 0`),
  check('operations_attempt_count_check', sql`${table.attemptCount} BETWEEN 1 AND 9007199254740991`),
  check('operations_result_shape_check', sql`${table.resultSnapshot} IS NULL OR jsonb_typeof(${table.resultSnapshot}) = 'object'`),
  check('operations_terminal_shape_check', sql`(${table.status}='PENDING' AND ${table.resultSnapshot} IS NULL AND ${table.failureCode} IS NULL AND ${table.finishedAt} IS NULL) OR (${table.status}='SUCCEEDED' AND ${table.resultSnapshot} IS NOT NULL AND ${table.failureCode} IS NULL AND ${table.finishedAt} IS NOT NULL) OR (${table.status}='FAILED' AND ${table.resultSnapshot} IS NULL AND ${table.failureCode} IS NOT NULL AND ${table.finishedAt} IS NOT NULL)`),
  check('operations_chronology_check', sql`${table.updatedAt} >= COALESCE(${table.finishedAt}, ${table.startedAt}, ${table.createdAt}) AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt}) AND (${table.finishedAt} IS NULL OR ${table.finishedAt} >= COALESCE(${table.startedAt}, ${table.createdAt}))`),
]);

const padletClaimDigestRegistry = pgTable('padlet_claim_digest_registry', {
  tupleDigest: text('tuple_digest').primaryKey(),
  claimKind: text('claim_kind').notNull(),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('padlet_claim_digest_registry_digest_check', sql`${table.tupleDigest} ~ '^[0-9a-f]{64}$'`),
  check('padlet_claim_digest_registry_kind_check', sql`${table.claimKind} IN ('CLAIM','TOMBSTONE')`),
]);

export const padletEvidenceClaims = pgTable('padlet_evidence_claims', {
  provider: text('provider').$type<'PADLET'>().notNull(),
  boardId: text('board_id').notNull(),
  postId: text('post_id').notNull(),
  tupleDigest: text('tuple_digest').notNull(),
  claimedByTenantId: uuid('claimed_by_tenant_id').notNull(),
  claimedByOperationId: text('claimed_by_operation_id').notNull(),
  evidenceCreatedAt: timestamp('evidence_created_at', { withTimezone: true }).notNull(),
  evidenceAuthorFullName: text('evidence_author_full_name').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'padlet_evidence_claims_pkey', columns: [table.provider, table.boardId, table.postId] }),
  unique('padlet_evidence_claims_digest_unique').on(table.tupleDigest),
  foreignKey({ name: 'padlet_evidence_claims_registry_fk', columns: [table.tupleDigest], foreignColumns: [padletClaimDigestRegistry.tupleDigest] }),
  foreignKey({ name: 'padlet_evidence_claims_operation_fk', columns: [table.claimedByTenantId, table.claimedByOperationId], foreignColumns: [operations.tenantId, operations.operationId] }),
  check('padlet_evidence_claims_provider_check', sql`${table.provider} = 'PADLET'`),
  check('padlet_evidence_claims_board_check', sql`${table.boardId}=btrim(${table.boardId}) AND length(${table.boardId})>0`),
  check('padlet_evidence_claims_post_check', sql`${table.postId}=btrim(${table.postId}) AND length(${table.postId})>0`),
  check('padlet_evidence_claims_digest_check', sql`${table.tupleDigest} ~ '^[0-9a-f]{64}$'`),
  check('padlet_evidence_claims_author_check', sql`${table.evidenceAuthorFullName}=btrim(${table.evidenceAuthorFullName}) AND length(${table.evidenceAuthorFullName})>0`),
  check('padlet_evidence_claims_chronology_check', sql`${table.claimedAt} >= ${table.evidenceCreatedAt}`),
]);

export const padletClaimDigestTombstones = pgTable('padlet_claim_digest_tombstones', {
  tupleDigest: text('tuple_digest').primaryKey(),
  ownerDigest: text('owner_digest'),
  sourceProvenance: text('source_provenance').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({ name: 'padlet_claim_digest_tombstones_registry_fk', columns: [table.tupleDigest], foreignColumns: [padletClaimDigestRegistry.tupleDigest] }),
  check('padlet_claim_digest_tombstones_digest_check', sql`${table.tupleDigest} ~ '^[0-9a-f]{64}$'`),
  check('padlet_claim_digest_tombstones_owner_check', sql`${table.ownerDigest} IS NULL OR ${table.ownerDigest} ~ '^[0-9a-f]{64}$'`),
  check('padlet_claim_digest_tombstones_source_check', sql`length(btrim(${table.sourceProvenance})) > 0`),
]);
