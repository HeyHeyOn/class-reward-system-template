import 'server-only';
import { types } from 'node:util';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { readLocalFullCandidate } from './localFullGenerationStage';
import type { LegacyNormalizationManifest } from './manifest';
import type { OwnedSyntheticDatabaseLease } from './localMaterializationRunner';
import { canonicalJson, isHexDigest, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalCandidateBinding = Readonly<{
  tenantId: string; migrationJobId: string; generationId: string;
  expectedStateVersion: string; sourceFingerprint: string; manifestDigest: string;
}>;
/** Trusted internal runner: leases two separately created synthetic databases,
 * checks their actual ownership/isolation and global destination vacancy, then
 * holds the source snapshot while atomically committing/rolling back destination.
 * No production connection, URL, manifest or caller MATCH is accepted. */
export type OwnedLocalMaterializationRunner = <T>(tenantId: string,
  callback: (pair: Readonly<{ source: TenantTransaction; destination: TenantTransaction;
    ownerId: string; sourceDatabaseId: string; destinationDatabaseId: string }>) => Promise<T>) => Promise<T>;

type Readback = Record<string, { count: number; digest: string }>;

/** Internal NONAUTHORITY synthetic service. The injected runner is mandatory and
 * is the capability boundary, not a caller-provided success receipt. No default
 * production connection and no in-place UPDATE/DELETE path exists here. */
export async function materializeLocalCandidate(raw: LocalCandidateBinding,
  runOwnedPair: OwnedLocalMaterializationRunner) {
  try {
    const binding = admit(raw);
    if (typeof runOwnedPair !== 'function' || types.isProxy(runOwnedPair)) refused();
    let completed: ReturnType<typeof result> | undefined;
    let called = false;
    const returned = await runOwnedPair(binding.tenantId, async pair => {
      if (called) refused();
      called = true;
      const { source, destination, sourceDatabaseId, destinationDatabaseId, ownerId } = pair;
      if (source === destination || sourceDatabaseId === destinationDatabaseId
        || ![sourceDatabaseId,destinationDatabaseId,ownerId].every(id => typeof id === 'string' && UUID_PATTERN.test(id))) refused();
      for (const [tx,id,role] of [[source,sourceDatabaseId,'SOURCE'],[destination,destinationDatabaseId,'DESTINATION']] as const) {
        const { rows } = await tx.execute(sql`SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database`);
        if (rows.length !== 1 || canonicalJson(rows[0]) !== canonicalJson({ database_id:id,owner_id:ownerId,role,
          tenant_id:binding.tenantId,job_id:binding.migrationJobId })) refused();
      }
      // Recompute the actual captures, importer graph, delta/recapture and every
      // immutable source entry before creating any destination materialization.
      const sourceTenant = await source.execute(sql`SELECT lifecycle FROM tenants WHERE id=${binding.tenantId} FOR UPDATE`);
      if (sourceTenant.rows.length !== 1 || sourceTenant.rows[0].lifecycle !== 'IMPORTING') refused();
      const manifest = await readLocalFullCandidate(binding, source);
      const { rows: jobs } = await destination.execute(sql`SELECT job_id,status,state_version::text AS version,source_fingerprint,
        final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs
        WHERE tenant_id=${binding.tenantId} FOR UPDATE`);
      const { rows: tenants } = await destination.execute(sql`SELECT lifecycle FROM tenants WHERE id=${binding.tenantId} FOR UPDATE`);
      const { rows: receipts } = await destination.execute(sql`SELECT * FROM migration_local_materializations`);
      if (jobs.length !== 1 || tenants.length !== 1 || receipts.length > 1) refused();
      const retry = receipts.length === 1;
      const job = jobs[0];
      if (job.job_id !== binding.migrationJobId || job.status !== (retry ? 'IMPORTING' : 'VALIDATED') || job.version !== (retry ? '2' : '1')
        || job.source_fingerprint !== (retry ? binding.sourceFingerprint : null)
        || job.final_fingerprint !== null || job.freeze_started_at !== null || job.freeze_verified_at !== null || job.completed_at !== null
        || tenants[0].lifecycle !== (retry ? 'IMPORTING' : 'DRAFT')) refused();
      const receiptBinding = { tenant_id:binding.tenantId,job_id:binding.migrationJobId,generation_id:binding.generationId,
        source_database_id:sourceDatabaseId,destination_database_id:destinationDatabaseId,owner_id:ownerId,
        expected_state_version:binding.expectedStateVersion,source_fingerprint:binding.sourceFingerprint,manifest_digest:binding.manifestDigest,
        scope:'LOCAL_DISPOSABLE_DOMAIN',authority:'NONAUTHORITY',activation_allowed:false };
      if (retry) {
        const { domain_readback, ...stored } = receipts[0];
        stored.expected_state_version = String(stored.expected_state_version);
        if (canonicalJson(stored) !== canonicalJson(receiptBinding)) refused();
        await verifyDomain(destination, binding, manifest);
        const observed = await readback(destination);
        if (canonicalJson(domain_readback) !== canonicalJson(observed)) refused();
        completed = result(binding, observed);
        return completed;
      }
      for (const table of await destinationTables(destination)) {
        if (table === 'tenants' || table === 'migration_jobs') continue;
        const { rows } = await destination.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`);
        if (rows.length) refused();
      }
      await importLegacyNormalizationManifest({tenantId:binding.tenantId,migrationJobId:binding.migrationJobId,manifest,
        runTransaction: async (tenant, callback) => {
          if (tenant !== binding.tenantId) refused();
          return callback(destination);
        } });
      // Operations are inert PENDING imported binding reservations, never a
      // successful reward/result. Authentic BANK/union inputs remain rejected by
      // the unchanged importer before this path; no authority is synthesized.
      for (const op of manifest.records.legacy_operation_bindings ?? []) {
        await destination.execute(sql`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,
          result_snapshot,failure_code,attempt_count,started_at,finished_at)
          VALUES(${binding.tenantId},${op.operationId},'TASK_REWARD',${String(op.payloadHash).slice(7)},'PENDING',NULL,NULL,1,NULL,NULL)`);
      }
      for (const claim of manifest.records.padlet_evidence_claims ?? []) {
        await destination.execute(sql`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,
          claimed_by_tenant_id,claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
          VALUES('PADLET',${claim.boardId},${claim.postId},${claim.tupleDigest},${binding.tenantId},${claim.operationId},
          ${claim.evidenceCreatedAt},${claim.evidenceAuthorFullName})`);
      }
      for (const tombstone of manifest.records.padlet_claim_digest_tombstones ?? []) {
        await destination.execute(sql`INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance)
          VALUES(${tombstone.tupleDigest},${tombstone.ownerDigest ?? null},${tombstone.provenance})`);
      }
      await verifyDomain(destination, binding, manifest);
      const observed = await readback(destination);
      await destination.execute(sql`INSERT INTO migration_local_materializations(tenant_id,job_id,generation_id,source_database_id,
        destination_database_id,owner_id,expected_state_version,source_fingerprint,manifest_digest,domain_readback,scope,authority,activation_allowed)
        VALUES(${binding.tenantId},${binding.migrationJobId},${binding.generationId},${sourceDatabaseId},${destinationDatabaseId},${ownerId},
        ${binding.expectedStateVersion},${binding.sourceFingerprint},${binding.manifestDigest},${JSON.stringify(observed)}::jsonb,
        'LOCAL_DISPOSABLE_DOMAIN','NONAUTHORITY',false)`);
      // The source stage uses a different transaction. Drain this destination's
      // deferred triggers after its final write, before checking receipt/domain
      // bytes; otherwise COMMIT can publish rows our readback never observed.
      await destination.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const { rows: written } = await destination.execute(sql`SELECT * FROM migration_local_materializations`);
      if (written.length !== 1) refused();
      const { domain_readback, ...stored } = written[0];
      stored.expected_state_version = String(stored.expected_state_version);
      if (canonicalJson(stored) !== canonicalJson(receiptBinding) || canonicalJson(domain_readback) !== canonicalJson(observed)) refused();
      // Receipt INSERT is the final write; its drained triggers can change
      // domain/job/source rows after the verified observation above. Re-read the
      // full inventory inside this transaction so late divergence rolls back
      // publication instead of sealing stale bytes as a successful candidate.
      if (canonicalJson(await readback(destination)) !== canonicalJson(observed)) refused();
      completed = result(binding, observed);
      return completed;
    });
    if (!completed || returned !== completed) refused();
    return completed;
  } catch { refused(); }
}

export type LocalPreparedTransitionIntent = Readonly<{
  binding: LocalCandidateBinding;
  ownerId: string; sourceDatabaseId: string; destinationDatabaseId: string;
  expectedDestinationStateVersion: string;
  expectedReportDigest: string; expectedMaterializationDigest: string;
}>;

/** One-shot, exclusively leased SYNTHETIC intermediate step, NOT cutover.
 * Revalidate an EXISTING materialization, then atomically append its bound STOP
 * receipt and move IMPORTING -> RECONCILING. No READY/FREEZING/FINAL_IMPORT/ACTIVE,
 * tenant lifecycle, writer fence, pointer, grants or source mutations. The
 * unchanged materializer refuses the new state; stale/lost-response retries are
 * STOP, not an implicit replay/rollback/authority claim. No public/default runner.
 */
export async function prepareLocalCandidateTransition(raw: LocalPreparedTransitionIntent,
  runOwnedPair: OwnedLocalMaterializationRunner) {
  try {
    const intent = admitPrepared(raw), {binding} = intent;
    if (typeof runOwnedPair !== 'function' || types.isProxy(runOwnedPair)) refused();
    let called = false;
    let completed: ReturnType<typeof preparedResult> | undefined;
    const returned = await runOwnedPair(binding.tenantId,async pair => {
      if (called) refused();
      called = true;
      if (pair.ownerId!==intent.ownerId || pair.sourceDatabaseId!==intent.sourceDatabaseId
        || pair.destinationDatabaseId!==intent.destinationDatabaseId) refused();
      const {source,destination} = pair;
      // Source tenant/job -> destination tenant/job. Hold all locks through the
      // destination commit; the trusted allocator keeps both leases exclusive.
      await source.execute(sql`SELECT id FROM tenants WHERE id=${binding.tenantId} FOR UPDATE`);
      const {rows: sourceJobs} = await source.execute(sql`SELECT job_id,status,state_version::text AS version,source_fingerprint
        FROM migration_jobs WHERE tenant_id=${binding.tenantId} FOR UPDATE`);
      if (sourceJobs.length!==1 || sourceJobs[0].job_id!==binding.migrationJobId
        || sourceJobs[0].status!=='READY' || sourceJobs[0].version!==binding.expectedStateVersion) refused();
      await destination.execute(sql`SELECT id FROM tenants WHERE id=${binding.tenantId} FOR UPDATE`);
      const {rows: jobs} = await destination.execute(sql`SELECT to_jsonb(j)-'updated_at' AS value,state_version::text AS version
        FROM migration_jobs j WHERE tenant_id=${binding.tenantId} FOR UPDATE`);
      if (jobs.length!==1 || jobs[0].version!==intent.expectedDestinationStateVersion) refused();
      const reports = await source.execute(sql`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
        FROM migration_full_reconciliation WHERE tenant_id=${binding.tenantId} AND migration_job_id=${binding.migrationJobId}
          AND generation_id=${binding.generationId} ORDER BY category`);
      if (!reports.rows.length || sha256(canonicalJson(reports.rows))!==intent.expectedReportDigest) refused();
      const {rows: receipts} = await destination.execute(sql`SELECT to_jsonb(t) AS value FROM migration_local_materializations t`);
      if (receipts.length!==1 || sha256(canonicalJson(receipts[0].value))!==intent.expectedMaterializationDigest) refused();
      // An exact receipt alone is insufficient: this existing read-only retry
      // recomputes all captures/deltas/reports and compares the actual SQL domain.
      const validated = await materializeLocalCandidate(binding,async (tenant,callback) => {
        if (tenant!==binding.tenantId) refused();
        return callback(pair);
      });
      const receipt = deepFreeze({scope:'LOCAL_PREPARED_STOP' as const,preparation:'PREPARED_STOP_REQUIRED' as const,
        authority:'NONAUTHORITY' as const,activationAllowed:false as const,complete:false as const,exclusion:'NOT_PROVEN' as const,
        intent,sourceJob:sourceJobs[0],previousStatus:'IMPORTING' as const,status:'RECONCILING' as const,stateVersion:'3' as const,
        validatedReadbackDigest:sha256(canonicalJson(validated.readback))});
      const auditEventId = `local-prepared-stop:${sha256(canonicalJson(receipt))}`;
      await destination.execute(sql`INSERT INTO audit_events
        (tenant_id,event_id,job_id,actor_user_id,event_type,operation_id,entity_type,entity_id,redacted_details)
        VALUES(${binding.tenantId},${auditEventId},${binding.migrationJobId},NULL,'MIGRATION_LOCAL_PREPARED_STOP',NULL,NULL,NULL,
          ${JSON.stringify(receipt)}::jsonb)`);
      const {rows: updated} = await destination.execute(sql`UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now()
        WHERE tenant_id=${binding.tenantId} AND job_id=${binding.migrationJobId} AND status='IMPORTING'
          AND state_version=${intent.expectedDestinationStateVersion}::bigint AND source_fingerprint=${binding.sourceFingerprint}
          AND final_fingerprint IS NULL AND freeze_started_at IS NULL AND freeze_verified_at IS NULL AND completed_at IS NULL
        RETURNING state_version::text AS version`);
      if (updated.length!==1 || updated[0].version!=='3') refused();
      // Preparation writes its own audit/UPDATE after materialization validation.
      // Drain their deferred effects before the final job, audit, domain and
      // receipt readbacks; otherwise COMMIT can change already-validated rows.
      await destination.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const {rows: verified} = await destination.execute(sql`SELECT to_jsonb(j)-'updated_at' AS value,updated_at=now() AS touched
        FROM migration_jobs j WHERE tenant_id=${binding.tenantId}`);
      const expectedJob = {...jobs[0].value as Record<string,unknown>,status:'RECONCILING',state_version:3};
      if (verified.length!==1 || verified[0].touched!==true || canonicalJson(verified[0].value)!==canonicalJson(expectedJob)) refused();
      const {rows: audits} = await destination.execute(sql`SELECT tenant_id,event_id,job_id,actor_user_id,event_type,
        operation_id,entity_type,entity_id,redacted_details FROM audit_events`);
      same(audits,[{tenant_id:binding.tenantId,event_id:auditEventId,job_id:binding.migrationJobId,actor_user_id:null,
        event_type:'MIGRATION_LOCAL_PREPARED_STOP',operation_id:null,entity_type:null,entity_id:null,redacted_details:receipt}]);
      const after = await readback(destination);
      const stable = (view:Readback) => Object.fromEntries(Object.entries(view).filter(([key]) => !['migration_jobs','audit_events'].includes(key)));
      if (canonicalJson(stable(after))!==canonicalJson(stable(validated.readback))) refused();
      const {rows: retained} = await destination.execute(sql`SELECT to_jsonb(t) AS value FROM migration_local_materializations t`);
      if (canonicalJson(retained)!==canonicalJson(receipts)) refused();
      completed = preparedResult(binding,receipt,auditEventId);
      return completed;
    });
    if (!completed || returned!==completed) refused();
    return completed;
  } catch { throw new Error('Local prepared transition refused.'); }
}

/** Cold, read-only NONAUTHORITY determination, never a retry of preparation.
 * The allocator supplies two STILL exclusively owned synthetic leases, not URLs
 * or request DTOs. The ordinary materializer runner deliberately rejects the
 * prepared audit, so it is not weakened/reused here. Source READY evidence must
 * still exist exactly; failed source finalization is not repaired across DBs.
 * SELECT row locks order the snapshots; there is no INSERT/UPDATE/DELETE/DDL,
 * grant, external writer exclusion, or assertion of distributed atomic commit.
 */
export async function reconcileLocalPreparedTransition(raw:LocalPreparedTransitionIntent,
  sourceLease:OwnedSyntheticDatabaseLease,destinationLease:OwnedSyntheticDatabaseLease) {
  try {
    const intent = admitPrepared(raw),{binding} = intent;
    if (sourceLease===destinationLease) refused();
    for (const [lease,id,role] of [[sourceLease,intent.sourceDatabaseId,'SOURCE'],
      [destinationLease,intent.destinationDatabaseId,'DESTINATION']] as const) {
      if (!lease || types.isProxy(lease) || lease.kind!=='SYNTHETIC_DISPOSABLE'
        || lease.databaseId!==id || lease.ownerId!==intent.ownerId
        || typeof lease.queryOwner!=='function' || types.isProxy(lease.queryOwner)
        || typeof lease.runTransaction!=='function' || types.isProxy(lease.runTransaction)) refused();
      same((await lease.queryOwner('SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database')).rows,
        [{database_id:id,owner_id:intent.ownerId,role,tenant_id:binding.tenantId,job_id:binding.migrationJobId}]);
      // Owner readback, not RLS-visible rows, excludes conflicting/foreign jobs.
      same((await lease.queryOwner('SELECT tenant_id,job_id FROM migration_jobs')).rows,
        [{tenant_id:binding.tenantId,job_id:binding.migrationJobId}]);
    }
    let sourceCalled = false,destinationCalled = false;
    let completed:ReturnType<typeof recoveredPreparedResult> | undefined;
    const returned = await sourceLease.runTransaction(binding.tenantId,async source => {
      if (sourceCalled) refused();
      sourceCalled = true;
      const {rows: tenants} = await source.execute(sql`SELECT lifecycle FROM tenants WHERE id=${binding.tenantId} FOR UPDATE`);
      same(tenants,[{lifecycle:'IMPORTING'}]);
      const {rows: sourceJobs} = await source.execute(sql`SELECT job_id,status,state_version::text AS version,source_fingerprint
        FROM migration_jobs WHERE tenant_id=${binding.tenantId} FOR UPDATE`);
      if (sourceJobs.length!==1 || sourceJobs[0].job_id!==binding.migrationJobId || sourceJobs[0].status!=='READY'
        || sourceJobs[0].version!==binding.expectedStateVersion) refused();
      const manifest = await readLocalFullCandidate(binding,source);
      const reports = await source.execute(sql`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
        FROM migration_full_reconciliation WHERE tenant_id=${binding.tenantId} AND migration_job_id=${binding.migrationJobId}
          AND generation_id=${binding.generationId} ORDER BY category`);
      if (!reports.rows.length || sha256(canonicalJson(reports.rows))!==intent.expectedReportDigest) refused();
      // The tenant pipeline validated exact ORIGINAL import/acquisition and
      // selected candidate evidence, not all owner-visible source rows.
      await verifyPreparedSourceInventory(source,sourceLease,binding);
      return destinationLease.runTransaction(binding.tenantId,async destination => {
        if (destinationCalled || source===destination) refused();
        destinationCalled = true;
        for (const [tx,id,role] of [[source,intent.sourceDatabaseId,'SOURCE'],[destination,intent.destinationDatabaseId,'DESTINATION']] as const) {
          same((await tx.execute(sql`SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database`)).rows,
            [{database_id:id,owner_id:intent.ownerId,role,tenant_id:binding.tenantId,job_id:binding.migrationJobId}]);
        }
        same((await destination.execute(sql`SELECT lifecycle FROM tenants WHERE id=${binding.tenantId} FOR UPDATE`)).rows,[{lifecycle:'IMPORTING'}]);
        const {rows: jobs} = await destination.execute(sql`SELECT job_id,status,state_version::text AS version,source_fingerprint,
          final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs
          WHERE tenant_id=${binding.tenantId} FOR UPDATE`);
        same(jobs,[{job_id:binding.migrationJobId,status:'RECONCILING',version:'3',source_fingerprint:binding.sourceFingerprint,
          final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
        const {rows: materializations} = await destination.execute(sql`SELECT to_jsonb(t) AS value FROM migration_local_materializations t`);
        if (materializations.length!==1 || sha256(canonicalJson(materializations[0].value))!==intent.expectedMaterializationDigest) refused();
        const {domain_readback: retained,...stored} = materializations[0].value as Record<string,unknown>;
        stored.expected_state_version = String(stored.expected_state_version);
        same([stored],[{tenant_id:binding.tenantId,job_id:binding.migrationJobId,generation_id:binding.generationId,
          source_database_id:intent.sourceDatabaseId,destination_database_id:intent.destinationDatabaseId,owner_id:intent.ownerId,
          expected_state_version:binding.expectedStateVersion,source_fingerprint:binding.sourceFingerprint,manifest_digest:binding.manifestDigest,
          scope:'LOCAL_DISPOSABLE_DOMAIN',authority:'NONAUTHORITY',activation_allowed:false}]);
        if (!retained || typeof retained!=='object' || Array.isArray(retained)) refused();
        const receipt = deepFreeze({scope:'LOCAL_PREPARED_STOP' as const,preparation:'PREPARED_STOP_REQUIRED' as const,
          authority:'NONAUTHORITY' as const,activationAllowed:false as const,complete:false as const,exclusion:'NOT_PROVEN' as const,
          intent,sourceJob:sourceJobs[0],previousStatus:'IMPORTING' as const,status:'RECONCILING' as const,stateVersion:'3' as const,
          validatedReadbackDigest:sha256(canonicalJson(retained))});
        const auditEventId = `local-prepared-stop:${sha256(canonicalJson(receipt))}`;
        same((await destination.execute(sql`SELECT tenant_id,event_id,job_id,actor_user_id,event_type,
          operation_id,entity_type,entity_id,redacted_details FROM audit_events`)).rows,
          [{tenant_id:binding.tenantId,event_id:auditEventId,job_id:binding.migrationJobId,actor_user_id:null,
            event_type:'MIGRATION_LOCAL_PREPARED_STOP',operation_id:null,entity_type:null,entity_id:null,redacted_details:receipt}]);
        // The two effects were written in one transaction (now() is stable).
        // This checks present chronology, not an unavailable historical xmin.
        same((await destination.execute(sql`SELECT a.occurred_at=j.updated_at AS same_transaction_time FROM audit_events a
          JOIN migration_jobs j ON j.tenant_id=a.tenant_id AND j.job_id=a.job_id`)).rows,[{same_transaction_time:true}]);
        await verifyDomain(destination,binding,manifest);
        const observed = await readback(destination);
        const stable = (view:Readback) => Object.fromEntries(Object.entries(view).filter(([key]) => !['migration_jobs','audit_events'].includes(key)));
        if (canonicalJson(stable(observed))!==canonicalJson(stable(retained as Readback))) refused();
        // Cover every public table, including private tables/foreign-tenant rows
        // hidden from app_runtime. No privilege changes or private field reads.
        const tables = await destinationLease.queryOwner("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename");
        // Counts prove absence only for a complete inventory. Cross-check the
        // catalog through the transaction as on SOURCE: RLS hides rows, not
        // table names. A truncated/duplicated owner result must not prove STOP.
        same(tables.rows,(await destination.execute(sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows);
        for (const {tablename} of tables.rows) {
          if (typeof tablename!=='string') refused();
          // The reviewed allocator includes inert DRAFT tenant shells for RLS
          // sentinels. Permit only those metadata rows; every foreign domain,
          // private row and job is still excluded by the owner counts below.
          if (tablename==='tenants') {
            same((await destinationLease.queryOwner("SELECT count(*)::text AS count FROM tenants WHERE id<>$1 AND lifecycle<>'DRAFT'",
              [binding.tenantId])).rows,[{count:'0'}]);
            same((await destinationLease.queryOwner('SELECT count(*)::text AS count FROM tenants WHERE id=$1',
              [binding.tenantId])).rows,[{count:'1'}]);
            continue;
          }
          const identifier = '"'+tablename.replaceAll('"','""')+'"';
          const expected = ['migration_local_disposable_database','migration_local_materializations'].includes(tablename) ? 1
            : observed[tablename]?.count ?? 0;
          same((await destinationLease.queryOwner(`SELECT count(*)::text AS count FROM ${identifier}`)).rows,[{count:String(expected)}]);
        }
        completed = recoveredPreparedResult(intent,receipt,auditEventId,observed);
        return completed;
      });
    });
    // Callback success alone is insufficient: both read transactions must finish
    // and return the exact result, with no skipped/repeated callback or uncertainty.
    if (!completed || returned!==completed) refused();
    return completed;
  } catch { throw new Error('Local prepared reconciliation refused.'); }
}

/** Only call after readLocalFullCandidate has semantically revalidated ORIGINAL
 * domain/checkpoints/acquisitions and every selected graph/report. Compare the
 * owner inventory against those exact scopes, NOT all runtime-visible rows: a
 * same-tenant unrelated snapshot/audit/generation is contamination too. Deferred
 * claims/operations, private and unknown tables must remain empty on SOURCE.
 * Counts never expose private fields. The allocator's two exclusive leases are
 * still required; these SELECTs are not an external writer fence. */
async function verifyPreparedSourceInventory(tx:TenantTransaction,lease:OwnedSyntheticDatabaseLease,binding:LocalCandidateBinding) {
  const expected = new Map<string,string>([
    ['migration_local_disposable_database','1'],['migration_jobs','1'],
    ['migration_snapshots','1'],['audit_events','3'],['migration_full_generations','1'],
  ]);
  const scopedCount = async (table:string,condition:ReturnType<typeof sql>) => {
    const {rows} = await tx.execute(sql`SELECT count(*)::text AS count FROM ${sql.identifier(table)} WHERE ${condition}`);
    if (rows.length!==1 || typeof rows[0].count!=='string' || !/^(0|[1-9][0-9]*)$/.test(rows[0].count)) refused();
    expected.set(table,rows[0].count);
  };
  // Exactly the non-deferred tables inspected against the ORIGINAL manifest by
  // inspectLegacyImport (settings project into one tenant_settings row).
  for (const table of ['tenant_settings','students','accounts','products','promotions','promotion_products','tasks',
    'task_allowed_students','task_assignments','transactions','transaction_items','adjustments','task_completions']) {
    await scopedCount(table,sql`tenant_id=${binding.tenantId}`);
  }
  for (const table of ['migration_sources','migration_source_records']) {
    await scopedCount(table,sql`tenant_id=${binding.tenantId} AND job_id=${binding.migrationJobId}`);
  }
  for (const table of ['migration_full_sources','migration_full_targets','migration_full_mappings','migration_full_contributors',
    'migration_full_delta_entries','migration_full_claim_recaptures','migration_full_reconciliation']) {
    await scopedCount(table,sql`tenant_id=${binding.tenantId} AND migration_job_id=${binding.migrationJobId} AND generation_id=${binding.generationId}`);
  }
  same((await tx.execute(sql`SELECT final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs
    WHERE tenant_id=${binding.tenantId} AND job_id=${binding.migrationJobId}`)).rows,
    [{final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
  const {rows: tables} = await lease.queryOwner("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename");
  // Catalog metadata remains visible even for owner-only tables. An incomplete
  // owner inventory must not silently hide a private table from the count pass.
  same(tables,(await tx.execute(sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows);
  const names = tables.map(row => {
    if (typeof row.tablename!=='string' || !row.tablename) refused();
    return row.tablename;
  });
  if (new Set(names).size!==names.length || !names.includes('tenants')
    || [...expected.keys()].some(table => !names.includes(table))) refused();
  for (const table of names) {
    if (table==='tenants') {
      // An inert DRAFT RLS sentinel shell is metadata only. Its foreign jobs,
      // domain/private rows and evidence are still rejected by global counts.
      same((await lease.queryOwner("SELECT count(*)::text AS count FROM tenants WHERE id<>$1 AND lifecycle<>'DRAFT'",
        [binding.tenantId])).rows,[{count:'0'}]);
      same((await lease.queryOwner('SELECT count(*)::text AS count FROM tenants WHERE id=$1',
        [binding.tenantId])).rows,[{count:'1'}]);
      continue;
    }
    const identifier = '"'+table.replaceAll('"','""')+'"';
    same((await lease.queryOwner(`SELECT count(*)::text AS count FROM ${identifier}`)).rows,[{count:expected.get(table) ?? '0'}]);
  }
}

function recoveredPreparedResult(intent:LocalPreparedTransitionIntent,receipt:Readonly<Record<string,unknown>>,
  auditEventId:string,observed:Readback) {
  return deepFreeze({scope:'LOCAL_PREPARED_RECONCILIATION' as const,disposition:'DURABLE_PREPARED_STOP' as const,
    preparation:'PREPARED_STOP_REQUIRED' as const,status:'RECONCILING' as const,stateVersion:'3' as const,
    authority:'NONAUTHORITY' as const,activationAllowed:false as const,complete:false as const,exclusion:'NOT_PROVEN' as const,
    repeatMutationAllowed:false as const,rollbackAllowed:false as const,intent,receipt,auditEventId,
    observedReadbackDigest:sha256(canonicalJson(observed))});
}

function preparedResult(binding:LocalCandidateBinding,receipt:Readonly<Record<string,unknown>>,auditEventId:string) {
  return deepFreeze({scope:'LOCAL_PREPARED_STOP' as const,preparation:'PREPARED_STOP_REQUIRED' as const,
    status:'RECONCILING' as const,stateVersion:'3' as const,authority:'NONAUTHORITY' as const,
    activationAllowed:false as const,complete:false as const,exclusion:'NOT_PROVEN' as const,binding,receipt,auditEventId});
}

function admitPrepared(raw:LocalPreparedTransitionIntent):LocalPreparedTransitionIntent {
  if (!raw || typeof raw!=='object' || types.isProxy(raw) || Object.getPrototypeOf(raw)!==Object.prototype) refused();
  const keys = ['binding','ownerId','sourceDatabaseId','destinationDatabaseId','expectedDestinationStateVersion',
    'expectedReportDigest','expectedMaterializationDigest'];
  if (Reflect.ownKeys(raw).length!==keys.length) refused();
  const copy:Record<string,unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw,key);
    if (!d || !d.enumerable || !('value' in d)) refused();
    copy[key] = d.value;
  }
  const binding = admit(copy.binding as LocalCandidateBinding);
  if (![copy.ownerId,copy.sourceDatabaseId,copy.destinationDatabaseId].every(id => typeof id==='string' && UUID_PATTERN.test(id))
    || copy.sourceDatabaseId===copy.destinationDatabaseId || copy.expectedDestinationStateVersion!=='2'
    || !isHexDigest(copy.expectedReportDigest) || !isHexDigest(copy.expectedMaterializationDigest)) refused();
  return deepFreeze({...copy,binding}) as LocalPreparedTransitionIntent;
}

function result(binding: LocalCandidateBinding, readback: Readback) {
  return deepFreeze({ scope:'LOCAL_DISPOSABLE_DOMAIN' as const,authority:'NONAUTHORITY' as const,
    activationAllowed:false as const,complete:false as const,exclusion:'NOT_PROVEN' as const,binding,readback });
}

async function verifyDomain(tx: TenantTransaction, binding: LocalCandidateBinding, manifest: LegacyNormalizationManifest) {
  if ((await inspectLegacyImport(tx,{tenantId:binding.tenantId,migrationJobId:binding.migrationJobId,manifest},manifest)).length) refused();
  const { rows: operations } = await tx.execute(sql`SELECT operation_id,payload_hash,operation_kind,status,result_snapshot,
    failure_code,attempt_count::text,started_at,finished_at FROM operations WHERE tenant_id=${binding.tenantId}`);
  same(operations, (manifest.records.legacy_operation_bindings ?? []).map(op => ({operation_id:op.operationId,
    payload_hash:String(op.payloadHash).slice(7),operation_kind:'TASK_REWARD',status:'PENDING',result_snapshot:null,
    failure_code:null,attempt_count:'1',started_at:null,finished_at:null})));
  const { rows: claims } = await tx.execute(sql`SELECT provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,
    claimed_by_operation_id,to_char(evidence_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS evidence_created_at,
    date_trunc('milliseconds',evidence_created_at)=evidence_created_at AS exact_milliseconds,
    evidence_author_full_name FROM padlet_evidence_claims`);
  same(claims, (manifest.records.padlet_evidence_claims ?? []).map(c => ({provider:'PADLET',board_id:c.boardId,post_id:c.postId,
    tuple_digest:c.tupleDigest,claimed_by_tenant_id:binding.tenantId,claimed_by_operation_id:c.operationId,
    evidence_created_at:c.evidenceCreatedAt,exact_milliseconds:true,evidence_author_full_name:c.evidenceAuthorFullName})));
  const { rows: tombstones } = await tx.execute(sql`SELECT tuple_digest,owner_digest,source_provenance FROM padlet_claim_digest_tombstones`);
  same(tombstones, (manifest.records.padlet_claim_digest_tombstones ?? []).map(t => ({tuple_digest:t.tupleDigest,
    owner_digest:t.ownerDigest ?? null,source_provenance:t.provenance})));
  const { rows: registry } = await tx.execute(sql`SELECT tuple_digest,claim_kind FROM padlet_claim_digest_registry`);
  same(registry, [...claims.map(c => ({tuple_digest:c.tuple_digest,claim_kind:'CLAIM'})),
    ...tombstones.map(t => ({tuple_digest:t.tuple_digest,claim_kind:'TOMBSTONE'}))]);
  if ((await tx.execute(sql`SELECT 1 FROM inventory_ledger LIMIT 1`)).rows.length) refused();
}

async function readback(tx: TenantTransaction): Promise<Readback> {
  const report: Readback = {};
  for (const table of await destinationTables(tx)) {
    const { rows } = await tx.execute(sql`SELECT to_jsonb(t) AS value FROM ${sql.identifier(table)} t`);
    report[table] = {count:rows.length,digest:sha256(canonicalJson(rows.map(row => canonicalJson(row.value)).sort()))};
  }
  return report;
}
// Scan the actual DDL rather than an importer allowlist: unrelated domain/auth/
// staging tables must be empty too. The trusted owner runner separately checks
// foreign-tenant rows hidden by runtime RLS before entering this transaction.
async function destinationTables(tx: TenantTransaction): Promise<string[]> {
  const { rows } = await tx.execute(sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public'
    AND has_table_privilege(current_user, quote_ident(schemaname)||'.'||quote_ident(tablename), 'SELECT') ORDER BY tablename`);
  return rows.map(row => {
    if (typeof row.tablename !== 'string') refused();
    return row.tablename;
  }).filter(table => !['migration_local_disposable_database','migration_local_materializations'].includes(table));
}
function same(actual: unknown[], expected: unknown[]) {
  const sorted = (rows: unknown[]) => canonicalJson(rows.map(row => canonicalJson(row)).sort());
  if (sorted(actual) !== sorted(expected)) refused();
}
function admit(raw: LocalCandidateBinding): LocalCandidateBinding {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) refused();
  const keys = ['tenantId','migrationJobId','generationId','expectedStateVersion','sourceFingerprint','manifestDigest'];
  if (Reflect.ownKeys(raw).length !== keys.length) refused();
  const copy: Record<string,string> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw,key);
    if (!d || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 256) refused();
    copy[key] = d.value;
  }
  if (!UUID_PATTERN.test(copy.tenantId) || copy.migrationJobId.trim() !== copy.migrationJobId
    || !/^[1-9][0-9]{0,15}$/.test(copy.expectedStateVersion) || !Number.isSafeInteger(Number(copy.expectedStateVersion))
    || !isHexDigest(copy.sourceFingerprint) || !isHexDigest(copy.manifestDigest)) refused();
  return Object.freeze(copy) as LocalCandidateBinding;
}
function refused(): never { throw new Error('Local candidate domain materialization refused.'); }
