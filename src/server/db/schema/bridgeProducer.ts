import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

// Companion-only authority. Deployment-role RLS, immutable and TRUNCATE triggers
// live in 0020; 0022 adds phase-correct variants in the SAME global replay domain.
// No tenant FK/cascade: these replay tombstones are permanent.
export const migrationBridgeProducerReservations = pgTable('migration_bridge_producer_reservations', {
  nonceDigest: text('nonce_digest').notNull(),
  challengeId: uuid('challenge_id').notNull(),
  ceremonyId: uuid('ceremony_id'),
  purpose: text('purpose').notNull().default(sql`'CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST'`),
  startCeremonyId: uuid('start_ceremony_id'),
  executionDigest: text('execution_digest'),
  deploymentId: text('deployment_id').notNull(),
  registrationDigest: text('registration_digest').notNull(),
  requestDigest: text('request_digest').notNull(),
  issuedAtMs: bigint('issued_at_ms', { mode: 'bigint' }).notNull(),
  expiresAtMs: bigint('expires_at_ms', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  primaryKey({ name: 'migration_bridge_producer_reservations_pkey', columns: [t.nonceDigest] }),
  unique('migration_bridge_producer_reservations_challenge_id_key').on(t.challengeId),
  check('bridge_producer_phase_check', sql`
    (${t.purpose} = 'CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST'
      AND ${t.ceremonyId} IS NOT NULL AND ${t.startCeremonyId} IS NULL AND ${t.executionDigest} IS NULL)
    OR (${t.purpose} = 'CLASS_STORE_REGISTERED_FREEZING_REACQUISITION_REQUEST'
      AND ${t.ceremonyId} IS NULL AND ${t.startCeremonyId} IS NOT NULL
      AND ${t.executionDigest} IS NOT NULL AND ${t.executionDigest} ~ '^[0-9a-f]{64}$')`),
  check('bridge_producer_nonce_check', sql`${t.nonceDigest} ~ '^[0-9a-f]{64}$'`),
  check('bridge_producer_registration_check', sql`${t.registrationDigest} ~ '^[0-9a-f]{64}$'`),
  check('bridge_producer_request_check', sql`${t.requestDigest} ~ '^[0-9a-f]{64}$'`),
  check('bridge_producer_deployment_check', sql`${t.deploymentId} = btrim(${t.deploymentId})
    AND octet_length(${t.deploymentId}) BETWEEN 1 AND 63 AND ${t.deploymentId} !~ '[[:cntrl:]]'`),
  check('bridge_producer_lifetime_check', sql`${t.issuedAtMs} >= 0
    AND ${t.expiresAtMs} > ${t.issuedAtMs} AND ${t.expiresAtMs} - ${t.issuedAtMs} <= 60000
    AND ${t.expiresAtMs} <= 9007199254740991`),
]);
