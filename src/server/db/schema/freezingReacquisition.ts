import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, text, unique, uuid, type PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { migrationSources, migrationSnapshots, auditEvents } from './migrations';
import { migrationStartExecutions } from './startFreezing';
import { migrationBridgeConsumptions } from './bridgeReplay';

export const migrationReacquisitionChallenges = pgTable('migration_reacquisition_challenges', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  startCeremonyId: uuid('start_ceremony_id').notNull(),
  preflightSnapshotId: text('preflight_snapshot_id').notNull(),
  binding: jsonb('binding').notNull(),
}, (t): PgTableExtraConfigValue[] => [
  primaryKey({name:'migration_reacquisition_challenges_pkey',columns:[t.tenantId,t.challengeId]}),
  unique('migration_reacquisition_challenges_global_unique').on(t.challengeId),
  foreignKey({name:'migration_reacquisition_challenges_source_fk',columns:[t.tenantId,t.jobId,t.sourceId],foreignColumns:[migrationSources.tenantId,migrationSources.jobId,migrationSources.sourceId]}),
  foreignKey({name:'migration_reacquisition_challenges_actor_fk',columns:[t.actorUserId],foreignColumns:[users.id]}),
  foreignKey({name:'migration_reacquisition_challenges_start_fk',columns:[t.tenantId,t.startCeremonyId],foreignColumns:[migrationStartExecutions.tenantId,migrationStartExecutions.ceremonyId]}),
  foreignKey({name:'migration_reacquisition_challenges_snapshot_fk',columns:[t.tenantId,t.preflightSnapshotId],foreignColumns:[migrationSnapshots.tenantId,migrationSnapshots.snapshotId]}),
  check('migration_reacquisition_challenges_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->'challenge'->>'purpose'='CLASS_STORE_FREEZING_REACQUISITION'
  AND ${t.binding}->'challenge'->>'bindingVersion'='1' AND ${t.binding}->'challenge'->>'expectedStatus'='FREEZING'
  AND ${t.binding}->'challenge'->>'tenantId'=${t.tenantId}::text AND ${t.binding}->'challenge'->>'challengeId'=${t.challengeId}::text
  AND ${t.binding}->'challenge'->>'migrationJobId'=${t.jobId} AND ${t.binding}->'challenge'->>'sourceId'=${t.sourceId}
  AND ${t.binding}->'challenge'->>'actorUserId'=${t.actorUserId}::text AND ${t.binding}->'challenge'->>'startCeremonyId'=${t.startCeremonyId}::text
  AND ${t.binding}->'challenge'->>'preflightSnapshotId'=${t.preflightSnapshotId}
  AND (${t.binding}->'challenge'->>'expiresAt')::bigint-(${t.binding}->'challenge'->>'issuedAt')::bigint=60000
  AND ${t.binding}->>'csrfDigest' ~ '^[0-9a-f]{64}$' AND ${t.binding}->>'intentDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->'display'->>'action'='READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE'
  AND ${t.binding}->'display'->>'exclusion'='NOT_PROVEN'
  AND ${t.binding}->'display'->>'automaticRetry'='false' AND ${t.binding}->'display'->>'automaticEnable'='false') IS TRUE`),
]);

export const migrationReacquisitionDispatches = pgTable('migration_reacquisition_dispatches', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  binding: jsonb('binding').notNull(),
}, (t): PgTableExtraConfigValue[] => [
  primaryKey({name:'migration_reacquisition_dispatches_pkey',columns:[t.tenantId,t.challengeId]}),
  unique('migration_reacquisition_dispatches_global_unique').on(t.challengeId),
  foreignKey({name:'migration_reacquisition_dispatches_challenge_fk',columns:[t.tenantId,t.challengeId],foreignColumns:[migrationReacquisitionChallenges.tenantId,migrationReacquisitionChallenges.challengeId]}),
  check('migration_reacquisition_dispatches_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'purpose'='CLASS_STORE_FREEZING_REACQUISITION'
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
  AND ${t.binding}->>'intentDigest' ~ '^[0-9a-f]{64}$' AND ${t.binding}->>'requestDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'registrationDigest' ~ '^[0-9a-f]{64}$') IS TRUE`),
]);

export const migrationReacquisitionCandidates = pgTable('migration_reacquisition_candidates', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  nonceDigest: text('nonce_digest').notNull(),
  auditEventId: text('audit_event_id').notNull(),
  binding: jsonb('binding').notNull(),
}, (t): PgTableExtraConfigValue[] => [
  primaryKey({name:'migration_reacquisition_candidates_pkey',columns:[t.tenantId,t.challengeId]}),
  unique('migration_reacquisition_candidates_global_unique').on(t.challengeId),
  unique('migration_reacquisition_candidates_nonce_unique').on(t.nonceDigest),
  foreignKey({name:'migration_reacquisition_candidates_dispatch_fk',columns:[t.tenantId,t.challengeId],foreignColumns:[migrationReacquisitionDispatches.tenantId,migrationReacquisitionDispatches.challengeId]}),
  foreignKey({name:'migration_reacquisition_candidates_nonce_fk',columns:[t.nonceDigest,t.tenantId,t.challengeId],foreignColumns:[migrationBridgeConsumptions.nonceDigest,migrationBridgeConsumptions.tenantId,migrationBridgeConsumptions.freezingChallengeId]}),
  foreignKey({name:'migration_reacquisition_candidates_audit_fk',columns:[t.tenantId,t.auditEventId],foreignColumns:[auditEvents.tenantId,auditEvents.eventId]}),
  check('migration_reacquisition_candidates_binding_check',sql`(jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=16384
  AND ${t.binding}->>'purpose'='CLASS_STORE_FREEZING_REACQUISITION'
  AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
  AND ${t.binding}->>'nonceDigest'=${t.nonceDigest} AND ${t.binding}->>'auditEventId'=${t.auditEventId}
  AND ${t.binding}->>'candidateDigest' ~ '^[0-9a-f]{64}$'
  AND ${t.binding}->>'authority'='NONAUTHORITY' AND ${t.binding}->>'exclusion'='NOT_PROVEN'
  AND ${t.binding}->>'finalImportEligible'='false') IS TRUE`),
]);
