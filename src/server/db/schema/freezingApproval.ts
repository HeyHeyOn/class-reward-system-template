import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { migrationSources } from './migrations';

// Acquisition-only storage. Forced RLS and immutable triggers live in 0015.
export const migrationFreezingChallenges = pgTable('migration_freezing_challenges', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  binding: jsonb('binding').notNull(),
}, (t) => [
  primaryKey({ name: 'migration_freezing_challenges_pkey', columns: [t.tenantId, t.challengeId] }),
  unique('migration_freezing_challenges_global_unique').on(t.challengeId),
  foreignKey({ name: 'migration_freezing_challenges_source_fk', columns: [t.tenantId, t.jobId, t.sourceId],
    foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }),
  foreignKey({ name: 'migration_freezing_challenges_actor_fk', columns: [t.actorUserId], foreignColumns: [users.id] }),
  check('migration_freezing_challenges_binding_check', sql`(
    jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=8192
    AND ${t.binding} ?& ARRAY['tenantId','challengeId','migrationJobId','sourceId','actorUserId','purpose','action']
    AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
    AND ${t.binding}->>'migrationJobId'=${t.jobId} AND ${t.binding}->>'sourceId'=${t.sourceId}
    AND ${t.binding}->>'actorUserId'=${t.actorUserId}::text AND ${t.binding}->>'purpose'='CLASS_STORE_START_FREEZING_APPROVAL_V1' AND ${t.binding}->>'action'='START_FREEZING_APPROVAL') IS TRUE`),
]);
export const migrationFreezingConsumptions = pgTable('migration_freezing_consumptions', {
  replayDigest: text('replay_digest').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
}, (t) => [
  primaryKey({ name: 'migration_freezing_consumptions_pkey', columns: [t.replayDigest] }),
  unique('migration_freezing_consumptions_challenge_unique').on(t.tenantId, t.challengeId),
  foreignKey({ name: 'migration_freezing_consumptions_challenge_fk', columns: [t.tenantId, t.challengeId],
    foreignColumns: [migrationFreezingChallenges.tenantId, migrationFreezingChallenges.challengeId] }),
  check('migration_freezing_consumptions_digest_check', sql`${t.replayDigest} ~ '^[0-9a-f]{64}$'`),
]);
