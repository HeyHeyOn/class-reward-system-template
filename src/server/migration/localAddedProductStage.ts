import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import type { LegacyNormalizationManifest } from './manifest';
import { stageLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';
import { canonicalJson, sha256 } from './validators';

/** Local diagnostic staging only: no operational product, freeze or authority write.
 * The caller's exclusionGenerationReference is an untrusted archive label. */
export async function stageLocalAddedProduct(input: FinalGenerationPreparationInput,
  options: { runTransaction?: TenantImportTransactionRunner } = {}) {
  try {
    const run = options.runTransaction ?? withTenantTransaction;
    const binding = { jobId: input.migrationJobId, originalSourceId: input.originalSourceId,
      originalSnapshotId: input.originalSnapshotId, expectedStateVersion: input.expectedStateVersion };
    let staged: { generationId: string; targetId: string; recordId: string } | undefined;
    const preparation = await stageLegacyFinalGeneration(input, { runTransaction: (tenantId, callback) =>
      run(tenantId, async (tx) => {
        // This callback has already inspected the original and locked READY + version.
        const result = await callback(tx);
        const prepared = result as Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
        if (prepared.plan.status !== 'DIFF_VALIDATED' || prepared.plan.blockers.length
          || prepared.plan.changes.length !== 1) throw new Error('plan');
        const [change] = prepared.plan.changes;
        if (change.table !== 'products' || change.kind !== 'ADDED' || change.beforeDigest !== null
          || typeof change.afterDigest !== 'string') throw new Error('scope');
        const { rows: envelopes } = await tx.execute(sql`SELECT event_id,event_type,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId} AND job_id=${binding.jobId}
            AND event_id IN (${prepared.originalGenerationId},${prepared.candidateGenerationId},${prepared.planId})`);
        if (envelopes.length !== 3) throw new Error('envelopes');
        const envelope = (id: string, type: string) => {
          const item = envelopes.find((row) => row.event_id === id && row.event_type === type);
          if (!item || !item.redacted_details || typeof item.redacted_details !== 'object') throw new Error('envelope');
          return item.redacted_details as Record<string, unknown>;
        };
        const original = envelope(prepared.originalGenerationId, 'MIGRATION_PREPARATION_ORIGINAL');
        const candidate = envelope(prepared.candidateGenerationId, 'MIGRATION_PREPARATION_CANDIDATE');
        const plan = envelope(prepared.planId, 'MIGRATION_PREPARATION_PLAN');
        if (original.storage !== 'UNTRUSTED_PREPARATION' || candidate.storage !== 'UNTRUSTED_PREPARATION'
          || plan.storage !== 'UNTRUSTED_PREPARATION' || candidate.originalGenerationId !== prepared.originalGenerationId
          || plan.originalGenerationId !== prepared.originalGenerationId || plan.candidateGenerationId !== prepared.candidateGenerationId
          || canonicalJson({ status: plan.status, blockers: plan.blockers, changes: plan.changes }) !== canonicalJson(prepared.plan)) throw new Error('binding');
        const manifest = candidate.manifest as LegacyNormalizationManifest;
        const originalManifest = original.manifest as LegacyNormalizationManifest;
        if (!manifest || !originalManifest || manifest.status !== 'READY_FOR_IMPORT'
          || typeof manifest.manifestDigest !== 'string' || !manifest.sourceArtifacts?.sheets?.digest
          || manifest.tenantId !== tenantId || manifest.migrationJobId !== binding.jobId
          || originalManifest.manifestDigest !== (candidate.binding as Record<string, unknown>)?.originalManifestDigest
          || (candidate.binding as Record<string, unknown>)?.originalSnapshotId !== binding.originalSnapshotId
          || (candidate.binding as Record<string, unknown>)?.originalSourceId !== binding.originalSourceId
          || (candidate.binding as Record<string, unknown>)?.expectedStateVersion !== binding.expectedStateVersion
          || plan.candidateManifestDigest !== manifest.manifestDigest) throw new Error('manifest');
        const targetId = JSON.parse(change.identity);
        if (!Array.isArray(targetId) || targetId.length !== 1 || typeof targetId[0] !== 'string') throw new Error('identity');
        const rows = manifest.records.products?.filter((row) => row.productId === targetId[0]) ?? [];
        if (rows.length !== 1 || sha256(canonicalJson(rows[0])) !== change.afterDigest
          || (originalManifest.records.products ?? []).some((row) => row.productId === targetId[0])) throw new Error('target');
        const sources = manifest.sourceRecords.filter((record) => record.source.kind === 'SHEET'
          && record.source.tab === 'Products' && record.mappingStatus === 'STAGED'
          && record.targetTable === 'products' && record.targetId === targetId[0]
          && record.canonicalRecord !== null && record.errorCodes.length === 0);
        if (sources.length !== 1) throw new Error('provenance');
        const source = sources[0];
        // Products normalize from the source canonical fields plus tenantId.
        // A mapping/digest alone does not prove that the staged target belongs
        // to this source row; source and target shapes are intentionally distinct.
        if (canonicalJson(rows[0]) !== canonicalJson({ tenantId, ...source.canonicalRecord })) throw new Error('source target projection');
        const pointer = source.source;
        if (pointer.kind !== 'SHEET' || pointer.artifactDigest !== manifest.sourceArtifacts.sheets.digest
          || manifest.mappings.filter((mapping) => mapping.targetTable === 'products'
            && mapping.targetId === targetId[0] && mapping.sourceDigest === pointer.rowHash).length !== 1
          || originalManifest.sourceRecords.some((record) => record.source.kind === 'SHEET'
            && record.source.tab === 'Products' && record.source.rowHash === pointer.rowHash)) throw new Error('provenance');
        // Only one source record may have been added. A normalized target delta
        // alone cannot detect edits to the source spelling or other retained rows.
        const retained = (records: LegacyNormalizationManifest['sourceRecords']) => records
          .map((record) => ({ ...record, source: Object.fromEntries(
            Object.entries(record.source).filter(([key]) => key !== 'artifactDigest'),
          ) })).map((record) => canonicalJson(record)).sort();
        const remaining = manifest.sourceRecords.filter((record) => record !== source);
        if (manifest.sourceRecords.length !== originalManifest.sourceRecords.length + 1
          || canonicalJson(retained(remaining)) !== canonicalJson(retained(originalManifest.sourceRecords))) throw new Error('retained provenance');
        const generationId = prepared.candidateGenerationId;
        const recordId = `local-final-record:${sha256(canonicalJson([tenantId, binding.jobId, generationId, pointer.rowHash, targetId[0]]))}`;
        const generation = { job_id: binding.jobId, original_source_id: binding.originalSourceId,
          original_snapshot_id: binding.originalSnapshotId, candidate_event_id: generationId,
          plan_event_id: prepared.planId, candidate_manifest_digest: manifest.manifestDigest,
          candidate_sheet_digest: manifest.sourceArtifacts.sheets.digest,
          expected_state_version: binding.expectedStateVersion, phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN' };
        await tx.execute(sql`INSERT INTO migration_final_generations
          (tenant_id,generation_id,job_id,original_source_id,original_snapshot_id,candidate_event_id,plan_event_id,
            candidate_manifest_digest,candidate_sheet_digest,expected_state_version,phase,exclusion)
          VALUES (${tenantId},${generationId},${generation.job_id},${generation.original_source_id},${generation.original_snapshot_id},
            ${generation.candidate_event_id},${generation.plan_event_id},${generation.candidate_manifest_digest},
            ${generation.candidate_sheet_digest},${generation.expected_state_version}::bigint,'LOCAL_CANDIDATE','NOT_PROVEN')
          ON CONFLICT (tenant_id,generation_id) DO NOTHING`);
        const { rows: persistedGeneration } = await tx.execute(sql`SELECT job_id,original_source_id,original_snapshot_id,candidate_event_id,
          plan_event_id,candidate_manifest_digest,candidate_sheet_digest,expected_state_version::text AS expected_state_version,phase,exclusion
          FROM migration_final_generations WHERE tenant_id=${tenantId} AND generation_id=${generationId}`);
        if (persistedGeneration.length !== 1 || canonicalJson(persistedGeneration[0]) !== canonicalJson(generation)) throw new Error('generation conflict');
        const record = { tenant_id: tenantId, job_id: binding.jobId, generation_id: generationId, record_id: recordId,
          source_row_number: pointer.rowNumber, source_row_hash: pointer.rowHash,
          source_collection: 'Products', source_record_id: targetId[0],
          redacted_record: source.redactedSourceRecord, canonical_record: source.canonicalRecord };
        await tx.execute(sql`INSERT INTO migration_final_source_records
          (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
          VALUES (${tenantId},${record.job_id},${generationId},${recordId},${record.source_row_number},${record.source_row_hash},
            'Products',${record.source_record_id},${JSON.stringify(record.redacted_record)}::jsonb,${JSON.stringify(record.canonical_record)}::jsonb)
          ON CONFLICT (tenant_id,record_id) DO NOTHING`);
        // Inspect the complete source set independently: an INNER JOIN would
        // hide an extra source with no target, even when stored counts say MATCH.
        const { rows: persistedRecord } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,source_row_number::int AS source_row_number,
          source_row_hash,source_collection,source_record_id,redacted_record,canonical_record FROM migration_final_source_records
          WHERE tenant_id=${tenantId} AND generation_id=${generationId}`);
        if (persistedRecord.length !== 1 || canonicalJson(persistedRecord[0]) !== canonicalJson(record)) throw new Error('record conflict');
        const target = { tenant_id: tenantId, job_id: binding.jobId, generation_id: generationId, record_id: recordId,
          target_table: 'products', target_id: targetId[0], canonical_target: rows[0] };
        await tx.execute(sql`INSERT INTO migration_final_targets
          (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
          VALUES (${tenantId},${target.job_id},${generationId},${recordId},'products',${target.target_id},${JSON.stringify(target.canonical_target)}::jsonb)
          ON CONFLICT (tenant_id,record_id) DO NOTHING`);
        const { rows: persistedTarget } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target
          FROM migration_final_targets WHERE tenant_id=${tenantId} AND generation_id=${generationId}`);
        if (persistedTarget.length !== 1 || canonicalJson(persistedTarget[0]) !== canonicalJson(target)) throw new Error('target conflict');
        // Both complete sets must contain exactly the expected row and payload.
        // This is only the one ADDED local candidate, not full-products
        // reconciliation or an activation predicate.
        await tx.execute(sql`INSERT INTO migration_local_generation_reconciliation
          (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,
            category,expected_count,actual_count,delta,status)
          VALUES (${tenantId},${binding.jobId},${generationId},${binding.originalSourceId},${binding.originalSnapshotId},
            ${manifest.manifestDigest},'PRODUCTS',1,${persistedTarget.length},0,'MATCH')
          ON CONFLICT (tenant_id,job_id,generation_id,category) DO NOTHING`);
        const { rows: persistedEvidence } = await tx.execute(sql`SELECT original_source_id,original_snapshot_id,
          candidate_manifest_digest,expected_count::int AS expected_count,actual_count::int AS actual_count,
          delta::int AS delta,status FROM migration_local_generation_reconciliation
          WHERE tenant_id=${tenantId} AND job_id=${binding.jobId}
            AND generation_id=${generationId} AND category='PRODUCTS'`);
        if (persistedEvidence.length !== 1 || canonicalJson(persistedEvidence[0]) !== canonicalJson({
          original_source_id: binding.originalSourceId, original_snapshot_id: binding.originalSnapshotId,
          candidate_manifest_digest: manifest.manifestDigest, expected_count: 1,
          actual_count: 1, delta: 0, status: 'MATCH',
        })) throw new Error('local evidence conflict');
        staged = { generationId, targetId: targetId[0], recordId };
        return result;
      }),
    });
    if (!staged || staged.generationId !== preparation.candidateGenerationId) throw new Error('no stage');
    return { authority: 'NONAUTHORITY' as const, phase: 'LOCAL_CANDIDATE' as const,
      targetTable: 'products' as const, targetId: staged.targetId,
      generationId: staged.generationId, recordId: staged.recordId };
  } catch {
    throw new Error('Local added-product stage refused.');
  }
}
