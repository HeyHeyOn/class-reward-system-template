import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { migrationSources } from './migrations';

// Forced RLS and append-only/retention guards: 0018_freezing_consent.sql.
export const migrationConsentChallenges = pgTable('migration_consent_challenges', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  binding: jsonb('binding').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
}, t => [
  primaryKey({name:'migration_consent_challenges_pkey',columns:[t.tenantId,t.challengeId]}),
  unique('migration_consent_challenges_global_unique').on(t.challengeId),
  foreignKey({name:'migration_consent_challenges_source_fk',columns:[t.tenantId,t.jobId,t.sourceId],foreignColumns:[migrationSources.tenantId,migrationSources.jobId,migrationSources.sourceId]}),
  foreignKey({name:'migration_consent_challenges_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
  check('migration_consent_challenges_binding_check',sql`(
  jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=8192
  AND ${t.binding}->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1'
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
  AND ${t.binding}->>'migrationJobId'=${t.jobId} AND ${t.binding}->>'sourceId'=${t.sourceId} AND ${t.binding}->>'actorUserId'=${t.actorUserId}::text
  AND ${t.binding}->>'sessionBinding' ~ '^[0-9a-f]{64}$' AND ${t.binding}->>'csrfDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'externalSourceId' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'jobSemanticFingerprint' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'sourceAcquisitionDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'preflightDigest' ~ '^[0-9a-f]{64}$'
 ) IS TRUE`),
]);
export const migrationConsentConfirmations = pgTable('migration_consent_confirmations', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  binding: jsonb('binding').notNull(),
}, t => [
  primaryKey({name:'migration_consent_confirmations_pkey',columns:[t.tenantId,t.challengeId]}),
  unique('migration_consent_confirmations_global_unique').on(t.challengeId),
  foreignKey({name:'migration_consent_confirmations_parent_fk',columns:[t.tenantId,t.challengeId],foreignColumns:[migrationConsentChallenges.tenantId,migrationConsentChallenges.challengeId]}),
  check('migration_consent_confirmations_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
  AND ${t.binding}->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1') IS TRUE`),
]);
export const migrationConsentAttempts = pgTable('migration_consent_attempts', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  binding: jsonb('binding').notNull(),
}, t => [
  primaryKey({name:'migration_consent_attempts_pkey',columns:[t.tenantId,t.challengeId]}),
  unique('migration_consent_attempts_global_unique').on(t.challengeId),
  foreignKey({name:'migration_consent_attempts_parent_fk',columns:[t.tenantId,t.challengeId],foreignColumns:[migrationConsentConfirmations.tenantId,migrationConsentConfirmations.challengeId]}),
  check('migration_consent_attempts_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
  AND ${t.binding}->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1') IS TRUE`),
]);
export const migrationConsentCaptures = pgTable('migration_consent_captures', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  binding: jsonb('binding').notNull(),
  capture: jsonb('capture').notNull(),
}, t => [
  primaryKey({name:'migration_consent_captures_pkey',columns:[t.tenantId,t.challengeId]}),
  unique('migration_consent_captures_global_unique').on(t.challengeId),
  foreignKey({name:'migration_consent_captures_parent_fk',columns:[t.tenantId,t.challengeId],foreignColumns:[migrationConsentAttempts.tenantId,migrationConsentAttempts.challengeId]}),
  check('migration_consent_captures_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
  AND ${t.binding}->>'purpose'='CLASS_STORE_FREEZING_CONSENT_V1') IS TRUE`),
  check('migration_consent_captures_capture_check',sql`(jsonb_typeof(${t.capture})='object' AND octet_length(${t.capture}::text)<=9000000
  AND ${t.binding}->>'captureDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'scope'='CONSENT_AND_SHEET_CAPTURE_ONLY') IS TRUE`),
]);
