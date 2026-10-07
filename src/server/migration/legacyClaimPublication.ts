import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import { assertRedisSnapshot, canonicalJson } from './validators';

type Binding = Readonly<{tenantId:string;migrationJobId:string;sourceId:string}>;
export function createLegacyRedisSnapshotStager(runTransaction:TenantImportTransactionRunner) {
  return async(input:Binding & {snapshot:RedisClaimSnapshot})=>{
    assertRedisSnapshot(input.snapshot);
    // Detach the caller's mutable graph before the first await.
    const snapshot=JSON.parse(JSON.stringify(input.snapshot)) as RedisClaimSnapshot;
    return runTransaction(input.tenantId,async tx=>{
      await requirePrivateJob(tx,input,['VALIDATED','IMPORTING','FINAL_IMPORT']);
      const source=await tx.execute(sql`SELECT source_fingerprint FROM migration_sources
        WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND source_id=${input.sourceId}
          AND provider='LEGACY_REDIS_BRIDGE' FOR SHARE`);
      if(source.rows.length!==1||source.rows[0].source_fingerprint!==snapshot.digest)throw new Error('Redis snapshot source binding mismatch.');
      await tx.execute(sql`INSERT INTO legacy_redis_snapshot_archives(tenant_id,job_id,source_id,source_digest,snapshot)
        VALUES (${input.tenantId},${input.migrationJobId},${input.sourceId},${snapshot.digest},${JSON.stringify(snapshot)}::jsonb)
        ON CONFLICT (tenant_id,job_id,source_id) DO NOTHING`);
      const stored=await readSnapshot(tx,input);
      if(canonicalJson(stored)!==canonicalJson(snapshot))throw new Error('Redis source archive differs from input.');
      return{sourceDigest:snapshot.digest,v2Claims:snapshot.v2Claims.length,v1Tombstones:snapshot.v1Tombstones.length,
        orphanedClaims:snapshot.orphanedClaimDigests.length,claimsPublished:false as const};
    });
  };
}

/** Internal same-transaction step. The caller must first recheck authenticated
 * actor/source/freeze evidence and the full Sheets reconciliation, then commit
 * this publication together with activation. Never expose as an HTTP command.
 * V2 details stay in the immutable source archive; the global one-use registry
 * receives tombstones without inventing modern operation receipts.
 */
export async function publishLegacyClaimsInternal(tx:TenantTransaction,input:Binding & {
  expectedStateVersion:string;expectedSourceDigest:string;
}) {
  const job=await requirePrivateJob(tx,input,['FINAL_IMPORT']);
  if(job.state_version!==input.expectedStateVersion||job.freeze_verified_at===null)throw new Error('Claim publication job version/freeze mismatch.');
  const snapshot=await readSnapshot(tx,input);
  if(snapshot.digest!==input.expectedSourceDigest)throw new Error('Claim publication source mismatch.');
  if(snapshot.orphanedClaimDigests.length)throw new Error('Orphaned Redis claims require resolution before activation.');
  const claims=[...snapshot.v2Claims,...snapshot.v1Tombstones].map(row=>({tuple_digest:row.tupleDigest,owner_digest:row.ownerDigest,source_provenance:row.sourceProvenance}));
  for(const claim of [...claims].sort((a,b)=>a.tuple_digest.localeCompare(b.tuple_digest))) {
    // The shared registry's unique key serializes conflicts across classrooms.
    // An existing tombstone is reusable only when its historical owner matches.
    const found=await tx.execute(sql`SELECT tuple_digest,owner_digest,source_provenance FROM padlet_claim_digest_tombstones WHERE tuple_digest=${claim.tuple_digest}`);
    if(!found.rows.length) await tx.execute(sql`INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance)
      VALUES (${claim.tuple_digest},${claim.owner_digest},${claim.source_provenance})`);
    else if(canonicalJson(found.rows)!==canonicalJson([claim]))throw new Error('Historical claim ownership conflict.');
    const verified=await tx.execute(sql`SELECT t.tuple_digest,t.owner_digest,t.source_provenance FROM padlet_claim_digest_tombstones t
      JOIN padlet_claim_digest_registry r ON r.tuple_digest=t.tuple_digest AND r.claim_kind='TOMBSTONE'
      WHERE t.tuple_digest=${claim.tuple_digest}`);
    if(canonicalJson(verified.rows)!==canonicalJson([claim]))throw new Error('Historical claim registry readback mismatch.');
  }
  await tx.execute(sql`INSERT INTO legacy_claim_publications(tenant_id,job_id,source_id,source_digest,tombstone_count)
    VALUES (${input.tenantId},${input.migrationJobId},${input.sourceId},${snapshot.digest},${claims.length})
    ON CONFLICT (tenant_id,job_id,source_id) DO NOTHING`);
  const receipt=await tx.execute(sql`SELECT source_digest,tombstone_count FROM legacy_claim_publications
    WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND source_id=${input.sourceId}`);
  if(canonicalJson(receipt.rows)!==canonicalJson([{source_digest:snapshot.digest,tombstone_count:claims.length}]))throw new Error('Claim publication receipt mismatch.');
  return{sourceDigest:snapshot.digest,tombstones:claims.length,modernOperationsCreated:0 as const};
}

async function requirePrivateJob(tx:TenantTransaction,input:Binding,statuses:readonly string[]) {
  const tenant=await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${input.tenantId} FOR UPDATE`);
  if(tenant.rows.length!==1||!['DRAFT','IMPORTING'].includes(String(tenant.rows[0].lifecycle)))throw new Error('Historical claims require a private tenant.');
  const result=await tx.execute(sql`SELECT status,state_version::text AS state_version,freeze_verified_at FROM migration_jobs
    WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} FOR UPDATE`);
  if(result.rows.length!==1||!statuses.includes(String(result.rows[0].status)))throw new Error('Historical claim job is not ready.');
  return result.rows[0];
}
async function readSnapshot(tx:TenantTransaction,input:Binding):Promise<RedisClaimSnapshot> {
  const result=await tx.execute(sql`SELECT a.source_digest,a.snapshot FROM legacy_redis_snapshot_archives a
    JOIN migration_sources s ON s.tenant_id=a.tenant_id AND s.job_id=a.job_id AND s.source_id=a.source_id
    WHERE a.tenant_id=${input.tenantId} AND a.job_id=${input.migrationJobId} AND a.source_id=${input.sourceId}
      AND s.provider='LEGACY_REDIS_BRIDGE' AND s.source_fingerprint=a.source_digest FOR SHARE OF s`);
  if(result.rows.length!==1)throw new Error('Redis source archive is missing.');
  const snapshot=result.rows[0].snapshot;assertRedisSnapshot(snapshot);
  if(result.rows[0].source_digest!==(snapshot as RedisClaimSnapshot).digest)throw new Error('Redis source archive digest mismatch.');
  return snapshot as RedisClaimSnapshot;
}
