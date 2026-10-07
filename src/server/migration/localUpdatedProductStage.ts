import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import { stageLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';
import { canonicalJson } from './validators';
import { inspectLocalUpdatedProduct, loadLocalUpdatedProductPlan, lockLocalUpdatedProductJob } from './localProductReconciliation';

/** Exactly one UPDATED Products row in an isolated immutable LOCAL_CANDIDATE.
 * No original source/PREFLIGHT/checkpoint/operational target UPDATE is performed.
 * Before provenance remains in the original immutable envelope and inspector;
 * after provenance has a distinct generation/record identity. Caller-supplied
 * acquisition/exclusion labels are consistency input, never operating authority.
 * ADDED/REMOVED, final-import activation, and delete/tombstone policy are absent. */
export async function stageLocalUpdatedProduct(input: FinalGenerationPreparationInput,
  options: { runTransaction?: TenantImportTransactionRunner } = {}) {
  try {
    const binding = { tenantId: input.tenantId, migrationJobId: input.migrationJobId,
      expectedStateVersion: input.expectedStateVersion, originalSourceId: input.originalSourceId, originalSnapshotId: input.originalSnapshotId };
    const run = options.runTransaction ?? withTenantTransaction;
    let staged: Awaited<ReturnType<typeof inspectLocalUpdatedProduct>> | undefined;
    const preparation = await stageLegacyFinalGeneration(input, {
      runTransaction: (tenantId, callback) => run(tenantId, async (tx) => {
        const result = await callback(tx);
        const prepared = result as Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
        if (prepared.plan.status !== 'DIFF_VALIDATED' || prepared.plan.blockers.length || prepared.plan.changes.length !== 1
          || prepared.plan.changes[0].table !== 'products' || prepared.plan.changes[0].kind !== 'MUTATED') throw new Error('updated scope');
        await lockLocalUpdatedProductJob(tx, binding);
        const expected = await loadLocalUpdatedProductPlan(tx, binding, prepared.candidateGenerationId, prepared.planId);
        const generation = expected.generation;
        const record = expected.record;
        const target = expected.target;
        const { rows: existing } = await tx.execute(sql`SELECT generation_id FROM migration_final_generations
          WHERE tenant_id=${tenantId} AND generation_id=${generation.generation_id} FOR UPDATE`);
        const readBinding = { ...binding, generationId: generation.generation_id, candidateManifestDigest: generation.candidate_manifest_digest };
        if (!existing.length) {
          await tx.execute(sql`INSERT INTO migration_final_generations
            (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,original_snapshot_phase,
              candidate_event_id,plan_event_id,candidate_manifest_digest,candidate_sheet_digest,expected_state_version,phase,exclusion)
            VALUES (${tenantId},${binding.migrationJobId},${generation.generation_id},${generation.original_source_id},
              ${generation.original_snapshot_id},'PREFLIGHT',${generation.candidate_event_id},${generation.plan_event_id},
              ${generation.candidate_manifest_digest},${generation.candidate_sheet_digest},${generation.expected_state_version}::bigint,
              'LOCAL_CANDIDATE','NOT_PROVEN')`);
          await tx.execute(sql`INSERT INTO migration_final_source_records
            (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
            VALUES (${tenantId},${record.job_id},${record.generation_id},${record.record_id},${record.source_row_number}::bigint,
              ${record.source_row_hash},'Products',${record.source_record_id},${JSON.stringify(record.redacted_record)}::jsonb,
              ${JSON.stringify(record.canonical_record)}::jsonb)`);
          await tx.execute(sql`INSERT INTO migration_final_targets
            (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
            VALUES (${tenantId},${target.job_id},${target.generation_id},${target.record_id},'products',${target.target_id},
              ${JSON.stringify(target.canonical_target)}::jsonb)`);
          // Compute from stored bytes before emitting an immutable aggregate.
          // The independent reader does not trust this MATCH row on later runs.
          const computed = await inspectLocalUpdatedProduct(tx, readBinding);
          await tx.execute(sql`INSERT INTO migration_local_generation_reconciliation
            (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,
              phase,exclusion,category,expected_count,actual_count,delta,status)
            VALUES (${tenantId},${binding.migrationJobId},${generation.generation_id},${binding.originalSourceId},${binding.originalSnapshotId},
              ${generation.candidate_manifest_digest},'LOCAL_CANDIDATE','NOT_PROVEN','PRODUCTS',${computed.expectedCount},
              ${computed.actualCount},${computed.delta},${computed.status})`);
        }
        // Existing generation means exact retry, never fill missing children or
        // overwrite a conflicting target. Every corruption fails the transaction.
        staged = await inspectLocalUpdatedProduct(tx, readBinding);
        const { rows: evidence } = await tx.execute(sql`SELECT original_source_id,original_snapshot_id,candidate_manifest_digest,
          phase,exclusion,expected_count::text AS expected_count,actual_count::text AS actual_count,delta::text AS delta,status
          FROM migration_local_generation_reconciliation WHERE tenant_id=${tenantId} AND job_id=${binding.migrationJobId}
          AND generation_id=${generation.generation_id} AND category='PRODUCTS'`);
        const wanted = { original_source_id: binding.originalSourceId, original_snapshot_id: binding.originalSnapshotId,
          candidate_manifest_digest: generation.candidate_manifest_digest, phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
          expected_count: String(staged.expectedCount), actual_count: String(staged.actualCount), delta: String(staged.delta), status: staged.status };
        if (evidence.length !== 1 || canonicalJson(evidence[0]) !== canonicalJson(wanted)) throw new Error('evidence mismatch');
        return result;
      }),
    });
    if (!staged || staged.generationId !== preparation.candidateGenerationId) throw new Error('no stage');
    return staged;
  } catch { throw new Error('Local updated-product stage refused.'); }
}
