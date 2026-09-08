import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { migrationSources } from './migrations';

// Acquisition-only storage. Forced RLS and immutable triggers live in 0014.
export const migrationBridgeChallenges = pgTable('migration_bridge_challenges', {
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  jobId: text('job_id').notNull(),
  sourceId: text('source_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  binding: jsonb('binding').notNull(),
}, (t) => [
  primaryKey({ name: 'migration_bridge_challenges_pkey', columns: [t.tenantId, t.challengeId] }),
  unique('migration_bridge_challenges_global_unique').on(t.challengeId),
  foreignKey({ name: 'migration_bridge_challenges_source_fk', columns: [t.tenantId, t.jobId, t.sourceId],
    foreignColumns: [migrationSources.tenantId, migrationSources.jobId, migrationSources.sourceId] }),
  foreignKey({ name: 'migration_bridge_challenges_actor_fk', columns: [t.actorUserId], foreignColumns: [users.id] }),
  check('migration_bridge_challenges_binding_check', sql`(
    jsonb_typeof(${t.binding})='object' AND octet_length(${t.binding}::text)<=8192
    AND ${t.binding} ?& ARRAY['tenantId','challengeId','migrationJobId','sourceId','actorUserId','purpose']
    AND ${t.binding}->>'tenantId'=${t.tenantId}::text AND ${t.binding}->>'challengeId'=${t.challengeId}::text
    AND ${t.binding}->>'migrationJobId'=${t.jobId} AND ${t.binding}->>'sourceId'=${t.sourceId}
    AND ${t.binding}->>'actorUserId'=${t.actorUserId}::text AND ${t.binding}->>'purpose'='CLASS_STORE_FINAL_BRIDGE_INTAKE') IS TRUE`),
]);
export const migrationBridgeConsumptions = pgTable('migration_bridge_consumptions', {
  nonceDigest: text('nonce_digest').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  challengeId: uuid('challenge_id').notNull(),
}, (t) => [
  primaryKey({ name: 'migration_bridge_consumptions_pkey', columns: [t.nonceDigest] }),
  unique('migration_bridge_consumptions_challenge_unique').on(t.tenantId, t.challengeId),
  foreignKey({ name: 'migration_bridge_consumptions_challenge_fk', columns: [t.tenantId, t.challengeId],
    foreignColumns: [migrationBridgeChallenges.tenantId, migrationBridgeChallenges.challengeId] }),
  check('migration_bridge_consumptions_digest_check', sql`${t.nonceDigest} ~ '^[0-9a-f]{64}$'`),
]);
