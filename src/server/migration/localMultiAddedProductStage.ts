import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import type { LegacyNormalizationManifest } from './manifest';
import { stageLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';
import { buildLocalMultiAddedProductPayload } from './localMultiAddedProductPlan';
import { canonicalJson, isPlainRecord, sha256 } from './validators';

/** Multiple ADDED Products in immutable local staging only. The preparation's
 * job lock, audit envelopes and every staged row share one transaction. Neither
 * the acquisitions nor the exclusion label confer operational authority. */
export async function stageLocalMultiAddedProducts(input: FinalGenerationPreparationInput,
  options: { runTransaction?: TenantImportTransactionRunner } = {}): Promise<{
    authority: 'NONAUTHORITY'; phase: 'LOCAL_CANDIDATE'; exclusion: 'NOT_PROVEN';
    activationAllowed: false; complete: false; scope: 'MULTI_ADDED_PRODUCTS'; targetTable: 'products';
    generationId: string; products: { productId: string; recordId: string }[];
  }> {
  try {
    const run = options.runTransaction ?? withTenantTransaction;
    const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
    let staged: { generationId: string; products: { productId: string; recordId: string }[] } | undefined;
    const preparation = await stageLegacyFinalGeneration(input, { runTransaction: (tenantId, callback) => {
      // Preparation has validated input synchronously. Capture its primitive
      // binding before awaiting the transaction; do not reread caller input later.
      const { migrationJobId, originalSourceId, originalSnapshotId, expectedStateVersion, exclusionGenerationReference } = input;
      return run(tenantId, async (tx) => {
        const result = await callback(tx);
        const prepared = result as Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
        if (prepared.plan.status !== 'DIFF_VALIDATED' || prepared.plan.blockers.length) throw new Error('plan');
        // The callback has locked READY + version and checked the original import
        // and exact persisted envelopes. Select payloads from those stored bytes.
        const { rows: envelopes } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,
          operation_id,actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId}
            AND event_id IN (${prepared.originalGenerationId},${prepared.candidateGenerationId},${prepared.planId})`);
        if (envelopes.length !== 3) throw new Error('envelopes');
        const envelope = (id: string, kind: string) => {
          const row = envelopes.find((item) => item.event_id === id);
          if (!row || row.tenant_id !== tenantId || row.job_id !== migrationJobId
            || row.event_type !== `MIGRATION_PREPARATION_${kind}` || row.operation_id !== null
            || row.actor_user_id !== null || row.entity_type !== null || row.entity_id !== null
            || !isPlainRecord(row.redacted_details)) throw new Error('envelope');
          const details = row.redacted_details;
          if (details.storage !== 'UNTRUSTED_PREPARATION'
            || id !== `preparation:${kind.toLowerCase()}:${sha256(canonicalJson(details))}`) throw new Error('envelope digest');
          return details;
        };
        const original = envelope(prepared.originalGenerationId, 'ORIGINAL');
        const candidate = envelope(prepared.candidateGenerationId, 'CANDIDATE');
        const plan = envelope(prepared.planId, 'PLAN');
        const originalManifest = original.manifest as LegacyNormalizationManifest;
        const manifest = candidate.manifest as LegacyNormalizationManifest;
        if (!originalManifest || !manifest || originalManifest.tenantId !== tenantId || manifest.tenantId !== tenantId
          || originalManifest.migrationJobId !== migrationJobId || manifest.migrationJobId !== migrationJobId) throw new Error('manifest');
        const binding = { tenantId, migrationJobId, expectedStatus: 'READY', expectedStateVersion,
          originalSnapshotId, originalSourceId, originalManifestDigest: originalManifest.manifestDigest,
          originalSourceFingerprint: originalManifest.sourceFingerprint };
        if (original.phase !== 'ORIGINAL_PREFLIGHT' || original.tenantId !== tenantId || original.migrationJobId !== migrationJobId
          || original.originalSourceId !== originalSourceId || original.originalSnapshotId !== originalSnapshotId
          || originalSourceId !== `sheet:${originalManifest.sourceArtifacts.sheets.digest}`
          || originalSnapshotId !== `import:${originalManifest.manifestDigest}`
          || candidate.phase !== 'FINAL_CANDIDATE' || plan.phase !== 'DELTA_PLAN'
          || !same(candidate.binding, binding) || !same(plan.binding, binding)
          || candidate.originalGenerationId !== prepared.originalGenerationId || plan.originalGenerationId !== prepared.originalGenerationId
          || plan.candidateGenerationId !== prepared.candidateGenerationId
          || plan.originalManifestDigest !== originalManifest.manifestDigest || plan.candidateManifestDigest !== manifest.manifestDigest
          || candidate.exclusionGenerationReference !== exclusionGenerationReference || plan.exclusionGenerationReference !== exclusionGenerationReference
          || !same({ status: plan.status, blockers: plan.blockers, changes: plan.changes }, prepared.plan)) throw new Error('binding');
        const payload = buildLocalMultiAddedProductPayload(originalManifest, manifest, prepared.plan.changes);
        const generationId = prepared.candidateGenerationId;
        const generation = { tenant_id: tenantId, job_id: migrationJobId, generation_id: generationId,
          original_source_id: originalSourceId, original_snapshot_id: originalSnapshotId, original_snapshot_phase: 'PREFLIGHT',
          candidate_event_id: generationId, plan_event_id: prepared.planId, candidate_manifest_digest: manifest.manifestDigest,
          candidate_sheet_digest: manifest.sourceArtifacts.sheets.digest, expected_state_version: expectedStateVersion,
          phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN' };
        const products = payload.products.map((product) => {
          const recordId = `local-final-record:${sha256(canonicalJson([tenantId, migrationJobId, generationId, product.sourceRowHash, product.productId]))}`;
          const identity = { tenant_id: tenantId, job_id: migrationJobId, generation_id: generationId, record_id: recordId };
          return { productId: product.productId, recordId,
            source: { ...identity, source_row_number: String(product.sourceRowNumber), source_row_hash: product.sourceRowHash,
              source_collection: 'Products', source_record_id: product.productId,
              redacted_record: product.source.redactedSourceRecord, canonical_record: product.source.canonicalRecord },
            target: { ...identity, target_table: 'products', target_id: product.productId, canonical_target: product.target } };
        });
        const readGeneration = () => tx.execute(sql`SELECT tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,
          original_snapshot_phase,candidate_event_id,plan_event_id,candidate_manifest_digest,candidate_sheet_digest,
          expected_state_version::text AS expected_state_version,phase,exclusion FROM migration_final_generations
          WHERE tenant_id=${tenantId} AND generation_id=${generationId} FOR UPDATE`);
        const { rows: existing } = await readGeneration();
        // An existing generation is read-only exact retry, never permission to
        // fill partial children or overwrite corrupted data with an upsert.
        if (!existing.length) {
          await tx.execute(sql`INSERT INTO migration_final_generations
            (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,original_snapshot_phase,
              candidate_event_id,plan_event_id,candidate_manifest_digest,candidate_sheet_digest,expected_state_version,phase,exclusion)
            VALUES (${tenantId},${migrationJobId},${generationId},${originalSourceId},${originalSnapshotId},'PREFLIGHT',
              ${generation.candidate_event_id},${generation.plan_event_id},${generation.candidate_manifest_digest},
              ${generation.candidate_sheet_digest},${expectedStateVersion}::bigint,'LOCAL_CANDIDATE','NOT_PROVEN')`);
          for (const { source, target } of products) {
            await tx.execute(sql`INSERT INTO migration_final_source_records
              (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
              VALUES (${tenantId},${migrationJobId},${generationId},${source.record_id},${source.source_row_number}::bigint,
                ${source.source_row_hash},'Products',${source.source_record_id},${JSON.stringify(source.redacted_record)}::jsonb,
                ${JSON.stringify(source.canonical_record)}::jsonb)`);
            await tx.execute(sql`INSERT INTO migration_final_targets
              (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
              VALUES (${tenantId},${migrationJobId},${generationId},${target.record_id},'products',${target.target_id},
                ${JSON.stringify(target.canonical_target)}::jsonb)`);
          }
        }
        // Verify every column of the stored payload, on new writes AND retries.
        // Read each entire generation independently: joins or expected-ID filters
        // would hide extra sources, missing targets, or same-count substitutions.
        const { rows: persistedGeneration } = await readGeneration();
        if (persistedGeneration.length !== 1 || !same(persistedGeneration[0], generation)) throw new Error('generation conflict');
        const { rows: sources } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,
          source_row_number::text AS source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record
          FROM migration_final_source_records WHERE tenant_id=${tenantId} AND generation_id=${generationId}`);
        const { rows: targets } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target
          FROM migration_final_targets WHERE tenant_id=${tenantId} AND generation_id=${generationId}`);
        const exactRows = (actual: readonly unknown[], expected: readonly unknown[]) => actual.length === expected.length
          && same(actual.map((row) => canonicalJson(row)).sort(), expected.map((row) => canonicalJson(row)).sort());
        if (!exactRows(sources, products.map((product) => product.source))
          || !exactRows(targets, products.map((product) => product.target))) throw new Error('stored products conflict');
        staged = { generationId, products: products.map(({ productId, recordId }) => ({ productId, recordId })) };
        return result;
      });
    } });
    if (!staged || staged.generationId !== preparation.candidateGenerationId) throw new Error('no stage');
    return { authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
      activationAllowed: false, complete: false, scope: 'MULTI_ADDED_PRODUCTS', targetTable: 'products', ...staged };
  } catch { throw new Error('Local multi-added-product stage refused.'); }
}
