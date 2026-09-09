import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, unique, uuid } from 'drizzle-orm/pg-core';
import { migrationConsentChallenges, migrationConsentConfirmations, migrationConsentCaptures } from './freezingConsent';
import { migrationBridgeChallenges } from './bridgeReplay';

export const migrationStartIntents = pgTable('migration_start_intents', {
  tenantId: uuid('tenant_id').notNull(),
  ceremonyId: uuid('ceremony_id').notNull(),
  binding: jsonb('binding').notNull(),
}, t => [
  primaryKey({name:'migration_start_intents_pkey',columns:[t.tenantId,t.ceremonyId]}),
  unique('migration_start_intents_global_unique').on(t.ceremonyId),
  foreignKey({name:'migration_start_intents_parent_fk',columns:[t.tenantId,t.ceremonyId],foreignColumns:[migrationConsentChallenges.tenantId,migrationConsentChallenges.challengeId]}),
  check('migration_start_intents_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'purpose'='CLASS_STORE_START_FREEZING_V1'
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'ceremonyId'=${t.ceremonyId}::text
  AND ${t.binding}->>'consentChallengeDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'sessionBinding' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->'display'->>'action'='DISABLE_LOCAL_WRITER_AND_START_FREEZING'
  AND ${t.binding}->'display'->>'automaticEnable'='false'
  AND length(${t.binding}->'display'->>'deploymentId') BETWEEN 1 AND 128
  AND ${t.binding}->'display'->>'registrationVersion' ~ '^[1-9][0-9]{0,15}$'
  AND ${t.binding}->'display'->>'registrationDigest' ~ '^[0-9a-f]{64}$'
  AND (${t.binding}->>'expiresAt')::bigint-(${t.binding}->>'issuedAt')::bigint=300000) IS TRUE`)
]);

export const migrationStartConfirmations = pgTable('migration_start_confirmations', {
  tenantId: uuid('tenant_id').notNull(),
  ceremonyId: uuid('ceremony_id').notNull(),
  binding: jsonb('binding').notNull(),
}, t => [
  primaryKey({name:'migration_start_confirmations_pkey',columns:[t.tenantId,t.ceremonyId]}),
  unique('migration_start_confirmations_global_unique').on(t.ceremonyId),
  foreignKey({name:'migration_start_confirmations_parent_fk',columns:[t.tenantId,t.ceremonyId],foreignColumns:[migrationStartIntents.tenantId,migrationStartIntents.ceremonyId]}),
  foreignKey({name:'migration_start_confirmations_consent_fk',columns:[t.tenantId,t.ceremonyId],foreignColumns:[migrationConsentConfirmations.tenantId,migrationConsentConfirmations.challengeId]}),
  check('migration_start_confirmations_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'purpose'='CLASS_STORE_START_FREEZING_V1'
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'ceremonyId'=${t.ceremonyId}::text
  AND ${t.binding}->>'intentDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'stateDigest' ~ '^[0-9a-f]{64}$') IS TRUE`)
]);

export const migrationStartDispatches = pgTable('migration_start_dispatches', {
  tenantId: uuid('tenant_id').notNull(),
  ceremonyId: uuid('ceremony_id').notNull(),
  binding: jsonb('binding').notNull(),
  bridgeChallengeId: uuid('bridge_challenge_id').notNull(),
}, t => [
  primaryKey({name:'migration_start_dispatches_pkey',columns:[t.tenantId,t.ceremonyId]}),
  unique('migration_start_dispatches_global_unique').on(t.ceremonyId),
  foreignKey({name:'migration_start_dispatches_parent_fk',columns:[t.tenantId,t.ceremonyId],foreignColumns:[migrationStartConfirmations.tenantId,migrationStartConfirmations.ceremonyId]}),
  foreignKey({name:'migration_start_dispatches_capture_fk',columns:[t.tenantId,t.ceremonyId],foreignColumns:[migrationConsentCaptures.tenantId,migrationConsentCaptures.challengeId]}),
  unique('migration_start_dispatches_bridge_unique').on(t.bridgeChallengeId),
  foreignKey({name:'migration_start_dispatches_bridge_fk',columns:[t.tenantId,t.bridgeChallengeId],foreignColumns:[migrationBridgeChallenges.tenantId,migrationBridgeChallenges.challengeId]}),
  check('migration_start_dispatches_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'purpose'='CLASS_STORE_START_FREEZING_V1'
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'ceremonyId'=${t.ceremonyId}::text
  AND ${t.binding}->>'intentDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'bridgeChallengeId'=${t.bridgeChallengeId}::text
  AND ${t.binding}->>'registrationDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'requestDigest' ~ '^[0-9a-f]{64}$') IS TRUE`)
]);
