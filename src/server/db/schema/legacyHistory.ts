import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { transactions } from './ledger';
import { migrationSources } from './migrations';

export const legacyTransactionOrigins = pgTable('legacy_transaction_origins', {
  tenantId: uuid('tenant_id').notNull(),
  transactionId: text('transaction_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  sourceDigest: text('source_digest').notNull(),
  sourceRowNumber: integer('source_row_number').notNull(),
  sourceRowDigest: text('source_row_digest').notNull(),
  originalCells: jsonb('original_cells').$type<string[]>().notNull(),
  reversesTransactionId: text('reverses_transaction_id'),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  primaryKey({ columns: [table.tenantId, table.transactionId] }),
  unique().on(table.tenantId, table.jobId, table.sourceId, table.sourceRowNumber),
  foreignKey({ columns: [table.tenantId, table.transactionId], foreignColumns: [transactions.tenantId, transactions.transactionId] }),
  foreignKey({ columns: [table.tenantId, table.jobId, table.sourceId], foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }),
  foreignKey({ columns: [table.tenantId, table.reversesTransactionId], foreignColumns: [transactions.tenantId, transactions.transactionId] }),
  uniqueIndex('legacy_transaction_one_reversal').on(table.tenantId, table.reversesTransactionId).where(sql`${table.reversesTransactionId} IS NOT NULL`),
  check('legacy_transaction_origins_source_digest_check', sql`${table.sourceDigest} ~ '^[a-f0-9]{64}$'`),
  check('legacy_transaction_origins_source_row_number_check', sql`${table.sourceRowNumber} > 1`),
  check('legacy_transaction_origins_source_row_digest_check', sql`${table.sourceRowDigest} ~ '^[a-f0-9]{64}$'`),
  check('legacy_transaction_origins_original_cells_check', sql`jsonb_typeof(${table.originalCells})='array'`),
  check('legacy_transaction_origins_check', sql`${table.reversesTransactionId} IS NULL OR ${table.reversesTransactionId} <> ${table.transactionId}`),
]);
