import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import { createLegacyFullSnapshotImporter } from './importLegacyFullSnapshot';
import { createLegacyRedisSnapshotStager, publishLegacyClaimsInternal } from './legacyClaimPublication';
import { parseLegacyFullSnapshot } from './legacyFullSnapshot';
import { assertRedisSnapshot, canonicalJson, sha256 } from './validators';
import type { LegacyFinancialReview } from './legacyFinancialHistory';

export type FrozenCutoverIntent = Readonly<{
  migrationJobId: string;
  expectedStateVersion: string;
  expectedJobFingerprint: string | null;
  sheetsSourceId: string;
  expectedSheetsFingerprint: string;
  redisSourceId: string | null;
  expectedRedisFingerprint: string | null;
  redisNonUseEvidenceDigest: string | null;
}>;
export type FrozenSourceBinding = Readonly<{
  tenantId: string; migrationJobId: string; intentDigest: string; actorSubjectDigest: string;
  sheetsSourceId: string; spreadsheetId: string; redisSourceId: string | null; redisExternalId: string | null;
  redisNonUseEvidenceDigest: string | null;
  financialReviewDigest?: string;
}>;
/** Only an inventoried source owner's verified historical non-use can select
 * this branch. Missing credentials, a failed connection or an empty SCAN cannot.
 * Keep the underlying operator evidence outside public manifests and bind its digest.
 */
export type VerifiedRedisNonUse = Readonly<{
  kind: 'NEVER_USED'; sourceIdentityDigest: string; evidenceDigest: string;
}>;
export type FrozenLegacySources = Readonly<{
  bindingDigest: string; fenceDigest: string; writerInventoryDigest: string;
  startedAt: string; drainedAt: string;
  assertHeld: () => Promise<void>;
  captureFresh: () => Promise<Readonly<{ gridJson: string; capturedAt: string; redis: RedisClaimSnapshot | VerifiedRedisNonUse }>>;
}>;
export type FrozenCutoverReceipt = Readonly<{
  status: 'ACTIVE'; tenantId: string; migrationJobId: string; stateVersion: string;
  sheetsDigest: string; redisDigest: string | null; redisCoverage: 'SNAPSHOT' | 'NEVER_USED'; projectionDigest: string; finalFingerprint: string;
  physicalRows: number; businessRows: number; tombstones: number; auditEventId: string;
}>;
export type FrozenCutoverDependencies = Readonly<{
  tenantId: string;
  getAuthenticatedSubject: () => Promise<string | null>;
  // A separately provisioned migration executor, never the web application's pool.
  runMigrationTransaction: TenantImportTransactionRunner;
  financialReview?: LegacyFinancialReview;
  /** Trusted server composition only, not request-supplied callbacks or booleans.
   * Verify current source control, block EVERY inventoried writer (including old
   * deployments, editors and automation), drain in-flight work, then call work.
   * The exclusion must remain durable through COMMIT, connection loss and process
   * death. A TTL lease or two equal reads alone does not meet this contract.
   * Do not automatically resume legacy writers on either success or failure.
   * An unavailable/incomplete inventory or Redis history must fail closed.
   */
  withFrozenSources: <T>(binding: FrozenSourceBinding, work: (source: FrozenLegacySources) => Promise<T>) => Promise<T>;
}>;
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INTENT_KEYS = ['expectedJobFingerprint', 'expectedRedisFingerprint', 'expectedSheetsFingerprint',
  'expectedStateVersion', 'migrationJobId', 'redisNonUseEvidenceDigest', 'redisSourceId', 'sheetsSourceId'];
function intentCopy(raw: FrozenCutoverIntent): FrozenCutoverIntent {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).some(key => typeof key !== 'string')
    || Object.keys(raw).sort().join('|') !== INTENT_KEYS.join('|')
    || Object.values(Object.getOwnPropertyDescriptors(raw)).some(d => !d.enumerable || !('value' in d))) throw new Error('Invalid cutover intent.');
  const intent = { ...raw };
  for (const value of [intent.migrationJobId, intent.sheetsSourceId, ...(intent.redisSourceId === null ? [] : [intent.redisSourceId])]) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 1024) throw new Error('Invalid cutover binding.');
  }
  if (intent.sheetsSourceId === intent.redisSourceId || typeof intent.expectedStateVersion !== 'string' || !/^[1-9][0-9]{0,15}$/.test(intent.expectedStateVersion)
    || BigInt(intent.expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER) - BigInt(7)
    || typeof intent.expectedSheetsFingerprint !== 'string' || !HEX.test(intent.expectedSheetsFingerprint)
    || (intent.redisSourceId === null
      ? intent.expectedRedisFingerprint !== null || typeof intent.redisNonUseEvidenceDigest !== 'string' || !HEX.test(intent.redisNonUseEvidenceDigest)
      : typeof intent.expectedRedisFingerprint !== 'string' || !HEX.test(intent.expectedRedisFingerprint) || intent.redisNonUseEvidenceDigest !== null)
    || (intent.expectedJobFingerprint !== null && (typeof intent.expectedJobFingerprint !== 'string' || !HEX.test(intent.expectedJobFingerprint)))) throw new Error('Invalid cutover version or fingerprint.');
  return Object.freeze(intent);
}
function instant(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw new Error('Invalid frozen capture time.');
  return millis;
}

/** A finite A–F coordinator: one fresh full import, exact reconciliation and
 * historical claim publication commit with activation and an immutable receipt.
 * There is deliberately no public route/default freeze adapter. Installing this
 * module alone is not evidence that real external writers have been stopped.
 */
export function createFrozenFullCutover(deps: FrozenCutoverDependencies) {
  const { tenantId, getAuthenticatedSubject, runMigrationTransaction, withFrozenSources } = deps;
  const financialReview: LegacyFinancialReview | undefined = deps.financialReview
    ? JSON.parse(JSON.stringify(deps.financialReview)) as LegacyFinancialReview : undefined;
  const financialReviewDigest = financialReview ? sha256(canonicalJson(financialReview)) : null;
  return async (rawIntent: FrozenCutoverIntent): Promise<FrozenCutoverReceipt> => {
    if (!UUID.test(tenantId)) throw new Error('Invalid cutover tenant.');
    const intent = intentCopy(rawIntent), intentDigest = sha256(canonicalJson(intent));
    const auditEventId = `frozen-cutover:${sha256(canonicalJson([tenantId, intent.migrationJobId]))}`;
    const subject = await getAuthenticatedSubject();
    if (typeof subject !== 'string' || !subject || subject !== subject.trim() || subject.length > 255) throw new Error('Cutover authentication required.');
    const subjectDigest = sha256(subject);
    if (financialReview && financialReview.approvedBySubjectDigest !== subjectDigest) throw new Error('Financial review owner mismatch.');

    async function authorizedState(tx: TenantTransaction) {
      const tenants = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
      const jobs = await tx.execute(sql`SELECT status,state_version::text AS state_version,source_fingerprint,final_fingerprint,created_at
        FROM migration_jobs WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId} FOR UPDATE`);
      if (tenants.rows.length !== 1 || jobs.rows.length !== 1) throw new Error('Cutover target missing.');
      // Read identity again after any lock wait; hold membership/source locks to commit.
      if (await getAuthenticatedSubject() !== subject) throw new Error('Cutover identity changed.');
      const actors = await tx.execute(sql`SELECT u.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=${tenantId} AND u.google_subject=${subject} AND m.role='OWNER' FOR SHARE OF m,u`);
      if (actors.rows.length !== 1) throw new Error('Cutover source owner required.');
      const sources = await tx.execute(sql`SELECT source_id,provider,external_source_id,source_fingerprint,ownership_subject_hash,
        grant_deleted_at,grant_expires_at FROM migration_sources WHERE tenant_id=${tenantId}
        AND job_id=${intent.migrationJobId} ORDER BY source_id FOR UPDATE`);
      const sheets = sources.rows.find(s => s.source_id === intent.sheetsSourceId && s.provider === 'GOOGLE_SHEETS');
      const redis = sources.rows.find(s => s.source_id === intent.redisSourceId && s.provider === 'LEGACY_REDIS_BRIDGE');
      if (sources.rows.length !== (intent.redisSourceId === null ? 1 : 2) || !sheets || (intent.redisSourceId !== null && !redis)
        || sources.rows.some(s => s.ownership_subject_hash !== subjectDigest)) throw new Error('Cutover source ownership mismatch.');
      const binding: FrozenSourceBinding = Object.freeze({ tenantId, migrationJobId: intent.migrationJobId, intentDigest,
        actorSubjectDigest: subjectDigest, sheetsSourceId: intent.sheetsSourceId, spreadsheetId: String(sheets.external_source_id),
        redisSourceId: intent.redisSourceId, redisExternalId: redis ? String(redis.external_source_id) : null,
        redisNonUseEvidenceDigest: intent.redisNonUseEvidenceDigest,
        ...(financialReviewDigest ? { financialReviewDigest } : {}) });
      const job = jobs.rows[0];
      if (job.status === 'ACTIVE') {
        const audit = await tx.execute(sql`SELECT event_type,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId} AND event_id=${auditEventId}`);
        const details = audit.rows[0]?.redacted_details as { intentDigest?: string; bindingDigest?: string; receipt?: FrozenCutoverReceipt } | undefined;
        const receipt = details?.receipt;
        if (tenants.rows[0].lifecycle !== 'ACTIVE' || audit.rows.length !== 1 || audit.rows[0].event_type !== 'MIGRATION_FROZEN_FULL_ACTIVATED'
          || details?.intentDigest !== intentDigest || details.bindingDigest !== sha256(canonicalJson(binding))
          || !receipt || receipt.status !== 'ACTIVE' || receipt.tenantId !== tenantId || receipt.migrationJobId !== intent.migrationJobId
          || receipt.auditEventId !== auditEventId || receipt.stateVersion !== job.state_version
          || receipt.finalFingerprint !== job.final_fingerprint || receipt.sheetsDigest !== sheets.source_fingerprint
          || receipt.redisDigest !== (redis?.source_fingerprint ?? null)
          || receipt.redisCoverage !== (redis ? 'SNAPSHOT' : 'NEVER_USED')) throw new Error('Cutover receipt or retry intent mismatch.');
        return { receipt, binding, actorUserId: String(actors.rows[0].id), createdAt: job.created_at };
      }
      if (sources.rows.some(s => s.grant_deleted_at !== null
        || (s.grant_expires_at !== null && new Date(String(s.grant_expires_at)).getTime() <= Date.now()))) throw new Error('Cutover source grant expired or revoked.');
      if (!['DRAFT', 'IMPORTING'].includes(String(tenants.rows[0].lifecycle)) || job.status !== 'VALIDATED'
        || job.state_version !== intent.expectedStateVersion || job.source_fingerprint !== intent.expectedJobFingerprint
        || sheets.source_fingerprint !== intent.expectedSheetsFingerprint || (redis?.source_fingerprint ?? null) !== intent.expectedRedisFingerprint) {
        throw new Error('Stale cutover state or source binding.');
      }
      const preflight = await tx.execute(sql`SELECT redacted_manifest FROM migration_snapshots WHERE tenant_id=${tenantId}
        AND job_id=${intent.migrationJobId} AND source_id=${intent.sheetsSourceId} AND phase='PREFLIGHT'
        AND artifact_digest=${intent.expectedSheetsFingerprint} FOR SHARE`);
      const manifest = preflight.rows[0]?.redacted_manifest as { scope?: string; sourceIdentityDigest?: string;
        redisDigest?: string | null; redisNonUse?: VerifiedRedisNonUse | null; financialReviewDigest?: string } | undefined;
      if (preflight.rows.length !== 1 || manifest?.scope !== 'FULL_SNAPSHOT_PREFLIGHT'
        || manifest.sourceIdentityDigest !== sha256(binding.spreadsheetId)
        || manifest.redisDigest !== intent.expectedRedisFingerprint
        || (manifest.financialReviewDigest ?? null) !== financialReviewDigest
        || (manifest.redisNonUse?.evidenceDigest ?? null) !== intent.redisNonUseEvidenceDigest) throw new Error('Reviewed full preflight is missing or differs.');
      return { receipt: null, binding, actorUserId: String(actors.rows[0].id), createdAt: job.created_at };
    }
    const initial = await runMigrationTransaction(tenantId, authorizedState);
    if (initial.receipt) return initial.receipt;
    return withFrozenSources(initial.binding, async frozen => {
      const bindingDigest = sha256(canonicalJson(initial.binding));
      const proof = { bindingDigest: frozen.bindingDigest, fenceDigest: frozen.fenceDigest,
        writerInventoryDigest: frozen.writerInventoryDigest, startedAt: frozen.startedAt, drainedAt: frozen.drainedAt };
      if (proof.bindingDigest !== bindingDigest || !HEX.test(proof.fenceDigest) || !HEX.test(proof.writerInventoryDigest)
        || instant(proof.startedAt) < new Date(String(initial.createdAt)).getTime()
        || instant(proof.drainedAt) < instant(proof.startedAt)) throw new Error('Frozen source proof mismatch.');
      await frozen.assertHeld();
      // Detach acquired data before subsequent asynchronous work.
      const capture = JSON.parse(JSON.stringify(await frozen.captureFresh())) as Awaited<ReturnType<FrozenLegacySources['captureFresh']>>;
      const redisSnapshot = 'snapshotVersion' in capture.redis ? capture.redis as RedisClaimSnapshot : null;
      const nonUse = redisSnapshot ? null : capture.redis as VerifiedRedisNonUse;
      if (redisSnapshot) {
        assertRedisSnapshot(redisSnapshot);
        if (intent.redisSourceId === null) throw new Error('Redis coverage differs from the reviewed intent.');
      } else if (intent.redisSourceId !== null || nonUse?.kind !== 'NEVER_USED'
        || Object.keys(nonUse).sort().join('|') !== 'evidenceDigest|kind|sourceIdentityDigest'
        || nonUse.evidenceDigest !== intent.redisNonUseEvidenceDigest
        || nonUse.sourceIdentityDigest !== sha256(initial.binding.spreadsheetId)) throw new Error('Redis non-use evidence mismatch.');
      if (instant(capture.capturedAt) < instant(proof.drainedAt)
        || (redisSnapshot && instant(redisSnapshot.capturedAt) < instant(proof.drainedAt))
        || Math.max(instant(capture.capturedAt), redisSnapshot ? instant(redisSnapshot.capturedAt) : 0) > Date.now()) throw new Error('Capture must follow writer drain.');
      await frozen.assertHeld();
      const input = { tenantId, migrationJobId: intent.migrationJobId, sourceId: intent.sheetsSourceId,
        gridJson: capture.gridJson, capturedAt: capture.capturedAt, ...(financialReview ? { financialReview } : {}) };
      const plan = await parseLegacyFullSnapshot(input);
      if (plan.sourceIdentityDigest !== sha256(initial.binding.spreadsheetId)) throw new Error('Captured spreadsheet identity mismatch.');
      if (redisSnapshot?.orphanedClaimDigests.length) throw new Error('Unresolved historical Redis claims.');
      return runMigrationTransaction(tenantId, async tx => {
        const current = await authorizedState(tx);
        if (current.receipt) return current.receipt;
        if (canonicalJson(current.binding) !== canonicalJson(initial.binding)) throw new Error('Source binding changed during freeze.');
        await frozen.assertHeld();
        const otherJobs = await tx.execute(sql`SELECT job_id FROM migration_jobs WHERE tenant_id=${tenantId} AND job_id<>${intent.migrationJobId}`);
        if (otherJobs.rows.length) throw new Error('Frozen cutover requires a single destination job.');
        // No old private partial import is silently replaced or reused for activation.
        for (const table of ['legacy_full_snapshot_archives', 'legacy_redis_snapshot_archives', 'reconciliation_results', 'migration_source_records']) {
          const found = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId}`);
          if (found.rows[0].n !== 0) throw new Error('Frozen cutover requires a fresh private destination.');
        }
        const inThisTransaction: TenantImportTransactionRunner = (_tenant, callback) => callback(tx);
        let status = 'VALIDATED', version = BigInt(intent.expectedStateVersion);
        async function advance(next: string) {
          const changed = await tx.execute(sql`UPDATE migration_jobs SET status=${next},state_version=state_version+1,updated_at=clock_timestamp()
            WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId} AND status=${status} AND state_version=${String(version)}::bigint
            RETURNING state_version::text AS state_version`);
          if (changed.rows.length !== 1 || changed.rows[0].state_version !== String(version + BigInt(1))) throw new Error('Cutover transition conflict.');
          status = next; version += BigInt(1);
        }
        await tx.execute(sql`UPDATE migration_sources SET source_fingerprint=CASE WHEN source_id=${intent.sheetsSourceId}
          THEN ${plan.sourceDigest} ELSE ${redisSnapshot?.digest ?? null} END WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId}`);
        await tx.execute(sql`UPDATE migration_jobs SET source_fingerprint=${plan.sourceDigest},freeze_started_at=${proof.startedAt}::timestamptz,
          freeze_verified_at=${proof.drainedAt}::timestamptz,updated_at=clock_timestamp() WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId}`);
        await advance('IMPORTING');
        const imported = await createLegacyFullSnapshotImporter(inThisTransaction)(input);
        if (redisSnapshot && intent.redisSourceId) await createLegacyRedisSnapshotStager(inThisTransaction)({ tenantId, migrationJobId: intent.migrationJobId,
          sourceId: intent.redisSourceId, snapshot: redisSnapshot });
        await advance('RECONCILING');
        // Importers already compare full values with EXCEPT ALL / reader readback.
        // Persist category counts as a navigable receipt, not as a replacement for those comparisons.
        const categories: Array<[string, string, number]> = [
          ['STUDENTS', 'students', imported.currentCounts.students], ['BALANCES', 'accounts', imported.currentCounts.accounts],
          ['PRODUCTS', 'products', imported.currentCounts.products], ['STOCK', 'products', imported.currentCounts.products],
          ['TRANSACTIONS', 'transactions', imported.financialRows], ['TASKS', 'tasks', imported.currentCounts.tasks],
          ['ASSIGNMENTS', 'task_assignments', imported.assignmentRows], ['COMPLETIONS', 'task_completions', imported.completionStateEvents],
          ['PROMOTIONS', 'promotions', imported.currentCounts.promotions], ['RECURRENCE', 'tasks', imported.currentCounts.tasks],
        ];
        async function recordMatch(category: string, expected: number, actual: number) {
          if (expected !== actual) throw new Error('Frozen cutover reconciliation mismatch.');
          await tx.execute(sql`INSERT INTO reconciliation_results(tenant_id,job_id,result_id,category,expected_count,actual_count,delta,status)
            VALUES (${tenantId},${intent.migrationJobId},${`frozen:${intent.migrationJobId}:${category}`},${category},${expected},${actual},0,'MATCH')`);
        }
        for (const [category, table, expected] of categories) {
          const actual = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId}`);
          await recordMatch(category, expected, Number(actual.rows[0].n));
        }
        const reversals = await tx.execute(sql`SELECT count(*)::int AS n FROM legacy_transaction_origins
          WHERE tenant_id=${tenantId} AND reverses_transaction_id IS NOT NULL`);
        await recordMatch('CANCELLATIONS', plan.financial.records.filter(r => r.reversesTransactionId !== null).length, Number(reversals.rows[0].n));
        if (redisSnapshot) {
          const archive = await tx.execute(sql`SELECT jsonb_array_length(snapshot->'operationBindings')::int AS n
            FROM legacy_redis_snapshot_archives WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId} AND source_id=${intent.redisSourceId}`);
          await recordMatch('OPERATION_BINDINGS', redisSnapshot.operationBindings.length, Number(archive.rows[0].n));
        } else await recordMatch('OPERATION_BINDINGS', 0, 0);
        await advance('READY');
        await advance('FREEZING');
        await advance('FINAL_IMPORT');
        const claims = redisSnapshot && intent.redisSourceId ? await publishLegacyClaimsInternal(tx, { tenantId, migrationJobId: intent.migrationJobId, sourceId: intent.redisSourceId,
          expectedStateVersion: String(version), expectedSourceDigest: redisSnapshot.digest }) : { tombstones: 0 };
        await recordMatch('PADLET_CLAIMS', redisSnapshot ? redisSnapshot.v2Claims.length + redisSnapshot.v1Tombstones.length : 0, claims.tombstones);
        const snapshots: Array<readonly [string, string, string, number]> = [
          [intent.sheetsSourceId, plan.sourceDigest, capture.capturedAt, imported.physicalRows],
        ];
        if (redisSnapshot && intent.redisSourceId) snapshots.push([intent.redisSourceId, redisSnapshot.digest, redisSnapshot.capturedAt,
          claims.tombstones + redisSnapshot.operationBindings.length]);
        for (const [sourceId, digest, capturedAt, rowCount] of snapshots) {
          await tx.execute(sql`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,captured_at,row_count)
            VALUES (${tenantId},${intent.migrationJobId},${sourceId},${`frozen:${sourceId}:${digest}`},'FINAL_FROZEN',${digest},
              ${JSON.stringify({ bindingDigest, fenceDigest: proof.fenceDigest, writerInventoryDigest: proof.writerInventoryDigest })}::jsonb,${capturedAt}::timestamptz,${rowCount})`);
        }
        const finalFingerprint = sha256(canonicalJson({ sheets: plan.sourceDigest, redis: redisSnapshot?.digest ?? null, nonUse, projection: plan.digest, proof }));
        const receipt: FrozenCutoverReceipt = { status: 'ACTIVE', tenantId, migrationJobId: intent.migrationJobId, stateVersion: String(version + BigInt(1)),
          sheetsDigest: plan.sourceDigest, redisDigest: redisSnapshot?.digest ?? null, redisCoverage: redisSnapshot ? 'SNAPSHOT' : 'NEVER_USED', projectionDigest: plan.digest, finalFingerprint,
          physicalRows: imported.physicalRows, businessRows: imported.businessRows, tombstones: claims.tombstones, auditEventId };
        const details = { protocolVersion: 1, intentDigest, bindingDigest, proof, receipt, redisNonUse: nonUse,
          preflightSheetsDigest: intent.expectedSheetsFingerprint, preflightRedisDigest: intent.expectedRedisFingerprint };
        await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,actor_user_id,event_type,redacted_details)
          VALUES (${tenantId},${auditEventId},${intent.migrationJobId},${current.actorUserId},'MIGRATION_FROZEN_FULL_ACTIVATED',${JSON.stringify(details)}::jsonb)`);
        const audit = await tx.execute(sql`SELECT redacted_details FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${auditEventId}`);
        if (canonicalJson(audit.rows[0]?.redacted_details) !== canonicalJson(details)) throw new Error('Cutover audit readback mismatch.');
        // Identity/fence are rechecked after all data writes and lock waits. The
        // provider's durable exclusion remains in force after this last check.
        if (await getAuthenticatedSubject() !== subject) throw new Error('Cutover identity changed.');
        await frozen.assertHeld();
        const expired = await tx.execute(sql`SELECT source_id FROM migration_sources WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId}
          AND (grant_deleted_at IS NOT NULL OR grant_expires_at<=clock_timestamp())`);
        if (expired.rows.length) throw new Error('Cutover source grant expired or revoked.');
        const activated = await tx.execute(sql`WITH completion AS MATERIALIZED (SELECT clock_timestamp() AS at)
          UPDATE migration_jobs SET status='ACTIVE',state_version=state_version+1,
          final_fingerprint=${finalFingerprint},completed_at=completion.at,updated_at=completion.at FROM completion
          WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId} AND status='FINAL_IMPORT' AND state_version=${String(version)}::bigint RETURNING job_id`);
        if (activated.rows.length !== 1) throw new Error('Cutover activation conflict.');
        await tx.execute(sql`UPDATE tenants SET lifecycle='ACTIVE',updated_at=clock_timestamp() WHERE id=${tenantId}`);
        return receipt;
      });
    });
  };
}
