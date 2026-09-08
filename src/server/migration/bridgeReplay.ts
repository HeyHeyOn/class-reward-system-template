import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { parseFinalBridgeChallenge, type FinalBridgeChallenge } from '../legacyMigrationBridge';
import { canonicalJson } from './legacyBridgeManifest';

/** Internal storage primitive, not authenticated permission. Caller owns the transaction
 * and must recheck current membership, bindings and DB time before consuming. */
export async function appendBridgeChallenge(tx: TenantTransaction, raw: FinalBridgeChallenge): Promise<void> {
  const b = parseFinalBridgeChallenge(raw);
  await tx.execute(sql`INSERT INTO migration_bridge_challenges(tenant_id,challenge_id,job_id,source_id,actor_user_id,binding)
    VALUES(${b.tenantId},${b.challengeId},${b.migrationJobId},${b.sourceId},${b.actorUserId},${canonicalJson(b)}::jsonb)`);
  await exactChallenge(tx, b);
}
export async function consumeBridgeChallenge(tx: TenantTransaction, raw: FinalBridgeChallenge, nonceDigest: string): Promise<void> {
  const b = parseFinalBridgeChallenge(raw);
  if (typeof nonceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(nonceDigest)) throw new Error('Bridge replay storage refused.');
  await exactChallenge(tx, b);
  // Both constraints are unconditional and global across processes. No ON CONFLICT
  // success or archival-recovery path: a lost COMMIT response cannot renew intake.
  await tx.execute(sql`INSERT INTO migration_bridge_consumptions(nonce_digest,tenant_id,challenge_id)
    VALUES(${nonceDigest},${b.tenantId},${b.challengeId})`);
  const { rows } = await tx.execute(sql`SELECT nonce_digest,tenant_id,challenge_id FROM migration_bridge_consumptions
    WHERE tenant_id=${b.tenantId} AND challenge_id=${b.challengeId}`);
  if (rows.length !== 1 || canonicalJson(rows[0]) !== canonicalJson({ nonce_digest: nonceDigest,
    tenant_id: b.tenantId, challenge_id: b.challengeId })) throw new Error('Bridge replay storage refused.');
}
async function exactChallenge(tx: TenantTransaction, b: FinalBridgeChallenge) {
  const { rows } = await tx.execute(sql`SELECT binding FROM migration_bridge_challenges
    WHERE tenant_id=${b.tenantId} AND challenge_id=${b.challengeId}`);
  if (rows.length !== 1 || canonicalJson(rows[0].binding) !== canonicalJson(b)) throw new Error('Bridge challenge storage refused.');
}
