import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenantTransaction, type TenantTransaction } from '@/server/db/transaction';
import { inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { canonicalJson, isHexDigest, isPlainRecord, sha256 } from './validators';

export type LocalUpdatedProductBinding = Pick<FinalGenerationPreparationInput,
  'tenantId' | 'migrationJobId' | 'expectedStateVersion' | 'originalSourceId' | 'originalSnapshotId'>;
export type LocalUpdatedProductReconciliationInput = LocalUpdatedProductBinding & {
  generationId: string; candidateManifestDigest: string;
};
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** Internal lock order matches the importer: tenant, job, then local generation.
 * The locks do not exclude any external Sheet/Redis writer or grant authority. */
export async function lockLocalUpdatedProductJob(tx: TenantTransaction, input: LocalUpdatedProductBinding) {
  if (!/^[1-9][0-9]{0,15}$/.test(input.expectedStateVersion)
    || BigInt(input.expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('version');
  for (const id of [input.migrationJobId, input.originalSourceId, input.originalSnapshotId]) {
    if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 512) throw new Error('identity');
  }
  const { rows: tenants } = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${input.tenantId} FOR UPDATE`);
  const { rows: jobs } = await tx.execute(sql`SELECT status,state_version::text AS version FROM migration_jobs
    WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} FOR UPDATE`);
  if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING'
    || jobs.length !== 1 || jobs[0].status !== 'READY' || jobs[0].version !== input.expectedStateVersion) throw new Error('phase');
}

/** Read and independently re-normalize persisted acquisitions. Caller-provided
 * counts, MATCH rows and the archived exclusion reference are never proof.
 * This intentionally supports exactly one MUTATED product, NOT deletions. */
export async function loadLocalUpdatedProductPlan(tx: TenantTransaction, input: LocalUpdatedProductBinding,
  generationId: string, planId: string) {
  const { tenantId, migrationJobId, originalSourceId, originalSnapshotId, expectedStateVersion } = input;
  const readEnvelope = async (id: string, kind: string) => {
    const { rows } = await tx.execute(sql`SELECT job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details
      FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${id}`);
    const row = rows[0];
    if (rows.length !== 1 || row.job_id !== migrationJobId || row.event_type !== `MIGRATION_PREPARATION_${kind}`
      || row.operation_id !== null || row.actor_user_id !== null || row.entity_type !== null || row.entity_id !== null
      || !isPlainRecord(row.redacted_details)) throw new Error('envelope');
    const details = row.redacted_details;
    if (id !== `preparation:${kind.toLowerCase()}:${sha256(canonicalJson(details))}`
      || details.storage !== 'UNTRUSTED_PREPARATION') throw new Error('envelope digest');
    return details;
  };
  const candidate = await readEnvelope(generationId, 'CANDIDATE');
  if (typeof candidate.originalGenerationId !== 'string') throw new Error('original identity');
  const original = await readEnvelope(candidate.originalGenerationId, 'ORIGINAL');
  const plan = await readEnvelope(planId, 'PLAN');
  const reconstitute = (details: Record<string, unknown>) => {
    if (!isPlainRecord(details.acquisition)) throw new Error('acquisition');
    const acquired = details.acquisition as FinalGenerationPreparationInput['candidate'];
    const manifest = createLegacyNormalizationManifest({ tenantId, migrationJobId, sheets: acquired.sheets, redis: acquired.redis });
    if (!equal(manifest, details.manifest) || manifest.status !== 'READY_FOR_IMPORT'
      || manifest.blockingConflicts.length || manifest.quarantines.length) throw new Error('manifest');
    return { manifest, acquired };
  };
  const before = reconstitute(original);
  const after = reconstitute(candidate);
  const binding = { tenantId, migrationJobId, expectedStatus: 'READY', expectedStateVersion, originalSourceId, originalSnapshotId,
    originalManifestDigest: before.manifest.manifestDigest, originalSourceFingerprint: before.manifest.sourceFingerprint };
  if (original.phase !== 'ORIGINAL_PREFLIGHT' || original.tenantId !== tenantId || original.migrationJobId !== migrationJobId
    || original.originalSourceId !== originalSourceId || original.originalSnapshotId !== originalSnapshotId
    || originalSourceId !== `sheet:${before.manifest.sourceArtifacts.sheets.digest}`
    || originalSnapshotId !== `import:${before.manifest.manifestDigest}`
    || candidate.phase !== 'FINAL_CANDIDATE' || plan.phase !== 'DELTA_PLAN'
    || !equal(candidate.binding, binding) || !equal(plan.binding, binding)
    || plan.originalGenerationId !== candidate.originalGenerationId || plan.candidateGenerationId !== generationId
    || plan.originalManifestDigest !== before.manifest.manifestDigest || plan.candidateManifestDigest !== after.manifest.manifestDigest
    || !isHexDigest(candidate.exclusionGenerationReference) || plan.exclusionGenerationReference !== candidate.exclusionGenerationReference
    || before.acquired.sheets.spreadsheetId !== after.acquired.sheets.spreadsheetId
    || !equal(before.manifest.sourceArtifacts.sheets.credentialHashes, after.manifest.sourceArtifacts.sheets.credentialHashes)
    || plan.status !== 'DIFF_VALIDATED' || !equal(plan.blockers, []) || !Array.isArray(plan.changes) || plan.changes.length !== 1) {
    throw new Error('plan binding');
  }
  const change = plan.changes[0];
  if (!isPlainRecord(change) || change.table !== 'products' || change.kind !== 'MUTATED'
    || !isHexDigest(change.beforeDigest) || !isHexDigest(change.afterDigest) || change.beforeDigest === change.afterDigest
    || typeof change.identity !== 'string') throw new Error('updated scope');
  const identity: unknown = JSON.parse(change.identity);
  if (!Array.isArray(identity) || identity.length !== 1 || typeof identity[0] !== 'string' || !identity[0]) throw new Error('product identity');
  const productId = identity[0];
  const selectProduct = (manifest: LegacyNormalizationManifest, digest: string) => {
    const targets = (manifest.records.products ?? []).filter((row) => row.productId === productId);
    const sources = manifest.sourceRecords.filter((record) => record.source.kind === 'SHEET' && record.source.tab === 'Products'
      && record.mappingStatus === 'STAGED' && record.targetTable === 'products' && record.targetId === productId
      && record.canonicalRecord !== null && record.errorCodes.length === 0);
    if (targets.length !== 1 || sources.length !== 1 || sha256(canonicalJson(targets[0])) !== digest) throw new Error('product digest');
    const source = sources[0];
    const pointer = source.source;
    if (pointer.kind !== 'SHEET' || pointer.artifactDigest !== manifest.sourceArtifacts.sheets.digest
      || !equal(targets[0], { tenantId, ...source.canonicalRecord })
      || manifest.mappings.filter((mapping) => mapping.targetTable === 'products' && mapping.targetId === productId
        && mapping.sourceDigest === pointer.rowHash).length !== 1) throw new Error('source projection');
    return { target: targets[0], source, pointer };
  };
  const prior = selectProduct(before.manifest, change.beforeDigest);
  const next = selectProduct(after.manifest, change.afterDigest);
  if (prior.pointer.rowNumber !== next.pointer.rowNumber || prior.pointer.rowHash === next.pointer.rowHash) throw new Error('updated provenance');
  const retainedSources = (manifest: LegacyNormalizationManifest, changed: typeof prior.source) => manifest.sourceRecords
    .filter((record) => record !== changed).map((record) => ({ ...record,
      source: Object.fromEntries(Object.entries(record.source).filter(([key]) => key !== 'artifactDigest')),
    })).map((record) => canonicalJson(record)).sort();
  const retainedTargets = (manifest: LegacyNormalizationManifest) => Object.fromEntries(Object.entries(manifest.records)
    .map(([table, rows]) => [table, rows.filter((row) => table !== 'products' || row.productId !== productId)
      .map((row) => canonicalJson(row)).sort()]));
  if (!equal(retainedSources(before.manifest, prior.source), retainedSources(after.manifest, next.source))
    || !equal(retainedTargets(before.manifest), retainedTargets(after.manifest))) throw new Error('retained data');
  if ((await inspectLegacyImport(tx, { tenantId, migrationJobId, manifest: before.manifest }, before.manifest)).length) throw new Error('original changed');
  const recordId = `local-final-record:${sha256(canonicalJson([tenantId, migrationJobId, generationId, next.pointer.rowHash, productId]))}`;
  return {
    generation: { tenant_id: tenantId, job_id: migrationJobId, generation_id: generationId,
      original_source_id: originalSourceId, original_snapshot_id: originalSnapshotId, original_snapshot_phase: 'PREFLIGHT',
      candidate_event_id: generationId, plan_event_id: planId, candidate_manifest_digest: after.manifest.manifestDigest,
      candidate_sheet_digest: after.manifest.sourceArtifacts.sheets.digest, expected_state_version: expectedStateVersion,
      phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN' },
    record: { tenant_id: tenantId, job_id: migrationJobId, generation_id: generationId, record_id: recordId,
      source_row_number: String(next.pointer.rowNumber), source_row_hash: next.pointer.rowHash, source_collection: 'Products',
      source_record_id: productId, redacted_record: next.source.redactedSourceRecord, canonical_record: next.source.canonicalRecord },
    target: { tenant_id: tenantId, job_id: migrationJobId, generation_id: generationId, record_id: recordId,
      target_table: 'products', target_id: productId, canonical_target: next.target },
    beforeDigest: change.beforeDigest, afterDigest: change.afterDigest,
    beforeSourceRowHash: prior.pointer.rowHash, afterSourceRowHash: next.pointer.rowHash,
  };
}

/** Recompute this ONE staged product from persisted generation/source/target bytes.
 * Never reads reconciliation_results or stored MATCH evidence. This is not a full
 * PRODUCTS report, final import, backup, fresh-capture proof or activation gate.
 * The generation lock prevents concurrent FK child inserts while comparing counts;
 * immutable child rows and the tenant/job locks protect the other local reads. */
export async function inspectLocalUpdatedProduct(tx: TenantTransaction, input: LocalUpdatedProductReconciliationInput) {
  await lockLocalUpdatedProductJob(tx, input);
  if (typeof input.generationId !== 'string' || !input.generationId || !isHexDigest(input.candidateManifestDigest)) throw new Error('generation identity');
  const { rows: generations } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,
    original_snapshot_phase,candidate_event_id,plan_event_id,candidate_manifest_digest,candidate_sheet_digest,
    expected_state_version::text AS expected_state_version,phase,exclusion FROM migration_final_generations
    WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND generation_id=${input.generationId} FOR UPDATE`);
  if (generations.length !== 1 || typeof generations[0].plan_event_id !== 'string'
    || generations[0].candidate_manifest_digest !== input.candidateManifestDigest) throw new Error('generation missing or changed');
  const expected = await loadLocalUpdatedProductPlan(tx, input, input.generationId, generations[0].plan_event_id);
  if (!equal(generations[0], expected.generation)) throw new Error('generation binding');
  // Count independently: a join would hide a missing target or an orphan source.
  const { rows: sources } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,source_row_number::text AS source_row_number,
    source_row_hash,source_collection,source_record_id,redacted_record,canonical_record FROM migration_final_source_records
    WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND generation_id=${input.generationId} LIMIT 2`);
  const { rows: targets } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target
    FROM migration_final_targets WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND generation_id=${input.generationId} LIMIT 2`);
  if (sources.length !== 1 || targets.length !== 1 || !equal(sources[0], expected.record) || !equal(targets[0], expected.target)
    || sha256(canonicalJson(targets[0].canonical_target)) !== expected.afterDigest) throw new Error('stored product mismatch');
  return {
    authority: 'NONAUTHORITY' as const, phase: 'LOCAL_CANDIDATE' as const, exclusion: 'NOT_PROVEN' as const,
    activationAllowed: false as const, complete: false as const, scope: 'SINGLE_UPDATED_PRODUCT' as const,
    tenantId: input.tenantId, migrationJobId: input.migrationJobId, generationId: input.generationId,
    originalSourceId: input.originalSourceId, originalSnapshotId: input.originalSnapshotId,
    candidateManifestDigest: input.candidateManifestDigest, productId: expected.target.target_id, recordId: expected.record.record_id,
    beforeDigest: expected.beforeDigest, afterDigest: expected.afterDigest,
    beforeSourceRowHash: expected.beforeSourceRowHash, afterSourceRowHash: expected.afterSourceRowHash,
    expectedCount: 1, actualCount: targets.length, delta: targets.length - 1, status: 'MATCH' as const,
  };
}

/** Separate read-only inspector entrypoint; no staging, healing or evidence INSERT. */
export async function reconcileLocalUpdatedProduct(input: LocalUpdatedProductReconciliationInput,
  options: { runTransaction?: TenantImportTransactionRunner } = {}) {
  try {
    const binding = { ...input };
    return await (options.runTransaction ?? withTenantTransaction)(binding.tenantId, (tx) => inspectLocalUpdatedProduct(tx, binding));
  } catch { throw new Error('Local updated-product reconciliation refused.'); }
}
