import 'server-only';
import type { TransactionPool } from '@/server/db/transaction';
import type { BridgeReservation, BridgeReservations } from './registeredBridgeProducer';
import { canonicalJson } from './validators';

const columns = 'nonce_digest, challenge_id, ceremony_id, deployment_id, registration_digest, request_digest, issued_at_ms, expires_at_ms';
function refused(): never { throw Error('Bridge reservation refused.'); }

/** One independent, deployment-role-bound READ COMMITTED transaction. No retry,
 * no conflict-as-success, no archival recovery promotion, no tenant GUC authority.
 * COMMIT transport uncertainty ALWAYS discards the physical pool connection. */
export function createBridgeProducerReservations(pool: TransactionPool, deploymentId: string): BridgeReservations {
  return Object.freeze({ async reserveAndCommit(input: BridgeReservation): Promise<BridgeReservation> {
    const row = Object.freeze({ ...input });
    if (row.deploymentId !== deploymentId || !deploymentId || Buffer.byteLength(deploymentId) > 63
      || !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.expiresAt)) refused();
    const connection = await pool.connect();
    let began = false; let commitAttempted = false; let discard = false;
    try {
      await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED'); began = true;
      await connection.query("SET LOCAL statement_timeout = '4000ms'");
      await connection.query("SET LOCAL lock_timeout = '4000ms'");
      const isolation = await connection.query('SHOW transaction_isolation');
      if (isolation.rows[0]?.transaction_isolation !== 'read committed') refused();
      const role = await connection.query(`SELECT current_user::text AS principal, r.rolsuper, r.rolbypassrls,
        c.relowner = r.oid AS owns_table, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_catalog.pg_roles r, pg_catalog.pg_class c
        WHERE r.rolname = current_user AND c.oid = 'public.migration_bridge_producer_reservations'::regclass`);
      const authority = role.rows[0];
      if (role.rows.length !== 1 || authority.principal !== deploymentId || authority.rolsuper !== false
        || authority.rolbypassrls !== false || authority.owns_table !== false
        || authority.relrowsecurity !== true || authority.relforcerowsecurity !== true) refused();
      await connection.query(`INSERT INTO public.migration_bridge_producer_reservations (${columns})
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [row.nonceDigest, row.challengeId, row.ceremonyId,
        row.deploymentId, row.registrationDigest, row.requestDigest, row.issuedAt, row.expiresAt]);
      const result = await connection.query(`SELECT ${columns} FROM public.migration_bridge_producer_reservations
        WHERE nonce_digest=$1 AND deployment_id=$2`, [row.nonceDigest, deploymentId]);
      if (result.rows.length !== 1) refused();
      const stored = result.rows[0];
      const actual = { nonceDigest: stored.nonce_digest, challengeId: stored.challenge_id,
        ceremonyId: stored.ceremony_id, deploymentId: stored.deployment_id,
        registrationDigest: stored.registration_digest, requestDigest: stored.request_digest,
        issuedAt: Number(stored.issued_at_ms), expiresAt: Number(stored.expires_at_ms) };
      if (canonicalJson(actual) !== canonicalJson(row)) refused();
      const clock = await connection.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms');
      if (clock.rows.length !== 1 || !/^[0-9]+$/.test(clock.rows[0].now_ms)) refused();
      const now = BigInt(clock.rows[0].now_ms);
      if (now < BigInt(row.issuedAt) || now >= BigInt(row.expiresAt)) refused();
      commitAttempted = true;
      await connection.query('COMMIT'); began = false;
      return row;
    } catch {
      discard = commitAttempted || !began;
      if (began) { try { await connection.query('ROLLBACK'); } catch { discard = true; } }
      return refused();
    } finally {
      try { connection.release(discard ? true : undefined); } catch { /* Never convert uncertainty into success. */ }
    }
  } });
}
