import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import type { FrozenCutoverIntent, VerifiedRedisNonUse } from './frozenFullCutover';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import { parseLegacyFullSnapshot } from './legacyFullSnapshot';
import { assertRedisSnapshot, canonicalJson, sha256 } from './validators';
import type { LegacyFinancialReview } from './legacyFinancialHistory';

/** Read-only-source preflight for the finite full-snapshot path. The Google
 * source must already be bound by verified bootstrap; this never grants ownership.
 * Stores the reviewed manifest, not partial business imports or modern operations.
 */
export function createFrozenFullPreparation(deps: Readonly<{
  tenantId: string; getAuthenticatedSubject: () => Promise<string | null>; runMigrationTransaction: TenantImportTransactionRunner;
}>) {
  return async (input: Readonly<{
    migrationJobId: string; expectedStateVersion: string; sheetsSourceId: string; gridJson: string; capturedAt: string;
    redisSourceId: string | null; redis: RedisClaimSnapshot | VerifiedRedisNonUse;
    financialReview?: LegacyFinancialReview;
  }>): Promise<FrozenCutoverIntent> => {
    const copied = JSON.parse(JSON.stringify(input)) as typeof input;
    const { tenantId, getAuthenticatedSubject, runMigrationTransaction } = deps;
    if (!/^[1-9][0-9]{0,15}$/.test(copied.expectedStateVersion)
      || BigInt(copied.expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER) - BigInt(7)) throw new Error('Invalid preflight version.');
    const subject = await getAuthenticatedSubject();
    if (typeof subject !== 'string' || !subject || subject !== subject.trim() || subject.length > 255) throw new Error('Preflight authentication required.');
    if (copied.financialReview && copied.financialReview.approvedBySubjectDigest !== sha256(subject)) throw new Error('Financial review owner mismatch.');
    const plan = await parseLegacyFullSnapshot({ ...copied, tenantId });
    const redisSnapshot = 'snapshotVersion' in copied.redis ? copied.redis as RedisClaimSnapshot : null;
    const nonUse = redisSnapshot ? null : copied.redis as VerifiedRedisNonUse;
    if (redisSnapshot) {
      assertRedisSnapshot(redisSnapshot);
      if (!copied.redisSourceId || redisSnapshot.orphanedClaimDigests.length) throw new Error('Unresolved preflight Redis source.');
    } else if (copied.redisSourceId !== null || nonUse?.kind !== 'NEVER_USED'
      || Object.keys(nonUse).sort().join('|') !== 'evidenceDigest|kind|sourceIdentityDigest'
      || !/^[a-f0-9]{64}$/.test(nonUse.evidenceDigest) || nonUse.sourceIdentityDigest !== plan.sourceIdentityDigest) throw new Error('Preflight non-use evidence mismatch.');
    const manifest = { protocolVersion: 1, scope: 'FULL_SNAPSHOT_PREFLIGHT', projectionDigest: plan.digest,
      sourceIdentityDigest: plan.sourceIdentityDigest, physicalRows: plan.physicalRows, businessRows: plan.businessRows,
      redisDigest: redisSnapshot?.digest ?? null, redisNonUse: nonUse,
      ...(copied.financialReview ? { financialReviewDigest: sha256(canonicalJson(copied.financialReview)) } : {}) };
    const eventId = `frozen-preflight:${sha256(canonicalJson([tenantId, copied.migrationJobId]))}`;
    const requestDigest = sha256(canonicalJson({ ...copied, gridJson: plan.sourceDigest, redis: redisSnapshot?.digest ?? nonUse }));
    return runMigrationTransaction(tenantId, async tx => {
      const tenants = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
      const jobs = await tx.execute(sql`SELECT status,state_version::text AS state_version,source_fingerprint FROM migration_jobs
        WHERE tenant_id=${tenantId} AND job_id=${copied.migrationJobId} FOR UPDATE`);
      if (await getAuthenticatedSubject() !== subject) throw new Error('Preflight identity changed.');
      const actors = await tx.execute(sql`SELECT u.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=${tenantId} AND u.google_subject=${subject} AND m.role='OWNER' FOR SHARE OF m,u`);
      if (tenants.rows.length !== 1 || !['DRAFT', 'IMPORTING'].includes(String(tenants.rows[0].lifecycle))
        || jobs.rows.length !== 1 || actors.rows.length !== 1) throw new Error('Private preflight owner required.');
      const sources = await tx.execute(sql`SELECT source_id,provider,source_fingerprint,external_source_id,ownership_subject_hash
        FROM migration_sources WHERE tenant_id=${tenantId} AND job_id=${copied.migrationJobId}
          AND grant_deleted_at IS NULL AND (grant_expires_at IS NULL OR grant_expires_at>clock_timestamp()) ORDER BY source_id FOR SHARE`);
      const sheets = sources.rows.find(s => s.source_id === copied.sheetsSourceId && s.provider === 'GOOGLE_SHEETS');
      const redis = sources.rows.find(s => s.source_id === copied.redisSourceId && s.provider === 'LEGACY_REDIS_BRIDGE');
      if (sources.rows.length !== (redisSnapshot ? 2 : 1) || !sheets || sheets.source_fingerprint !== plan.sourceDigest
        || sha256(String(sheets.external_source_id)) !== plan.sourceIdentityDigest
        || (redisSnapshot && (!redis || redis.source_fingerprint !== redisSnapshot.digest))
        || sources.rows.some(s => s.ownership_subject_hash !== sha256(subject))) throw new Error('Preflight source binding mismatch.');
      const intent: FrozenCutoverIntent = { migrationJobId: copied.migrationJobId, expectedStateVersion: String(BigInt(copied.expectedStateVersion) + BigInt(1)),
        expectedJobFingerprint: plan.sourceDigest, sheetsSourceId: copied.sheetsSourceId, expectedSheetsFingerprint: plan.sourceDigest,
        redisSourceId: copied.redisSourceId, expectedRedisFingerprint: redisSnapshot?.digest ?? null, redisNonUseEvidenceDigest: nonUse?.evidenceDigest ?? null };
      const details = { requestDigest, manifest, intent };
      const audit = await tx.execute(sql`SELECT redacted_details FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${eventId}
        AND job_id=${copied.migrationJobId} AND event_type='MIGRATION_FROZEN_PREFLIGHT_VALIDATED'`);
      const job = jobs.rows[0];
      if (job.status === 'VALIDATED' && job.state_version === intent.expectedStateVersion && job.source_fingerprint === plan.sourceDigest) {
        if (audit.rows.length !== 1 || canonicalJson(audit.rows[0].redacted_details) !== canonicalJson(details)) throw new Error('Preflight retry differs.');
        return intent;
      }
      if (job.status !== 'DISCOVERED' || job.state_version !== copied.expectedStateVersion || job.source_fingerprint !== null || audit.rows.length) throw new Error('Stale preflight job.');
      await tx.execute(sql`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,captured_at,row_count)
        VALUES (${tenantId},${copied.migrationJobId},${copied.sheetsSourceId},${eventId},'PREFLIGHT',${plan.sourceDigest},
          ${JSON.stringify(manifest)}::jsonb,${copied.capturedAt}::timestamptz,${plan.physicalRows})`);
      await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,actor_user_id,event_type,redacted_details)
        VALUES (${tenantId},${eventId},${copied.migrationJobId},${String(actors.rows[0].id)},'MIGRATION_FROZEN_PREFLIGHT_VALIDATED',${JSON.stringify(details)}::jsonb)`);
      await tx.execute(sql`UPDATE migration_jobs SET status='VALIDATED',state_version=state_version+1,source_fingerprint=${plan.sourceDigest},updated_at=clock_timestamp()
        WHERE tenant_id=${tenantId} AND job_id=${copied.migrationJobId}`);
      return intent;
    });
  };
}
