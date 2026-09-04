import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const generatorGrantClaims = pgTable('generator_grant_claims', {
  grantIdHash: text('grant_id_hash').primaryKey(),
  subjectHash: text('subject_hash').notNull(),
  emailHash: text('email_hash').notNull(),
  clientFingerprint: text('client_fingerprint').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('generator_grant_claims_grant_hash_check', sql`${table.grantIdHash} ~ '^[0-9a-f]{64}$'`),
  check('generator_grant_claims_subject_hash_check', sql`${table.subjectHash} ~ '^[0-9a-f]{64}$'`),
  check('generator_grant_claims_email_hash_check', sql`${table.emailHash} ~ '^[0-9a-f]{64}$'`),
  check('generator_grant_claims_client_fingerprint_check', sql`${table.clientFingerprint} ~ '^[0-9a-f]{64}$'`),
  check('generator_grant_claims_chronology_check', sql`${table.expiresAt} > ${table.consumedAt}`),
]);
