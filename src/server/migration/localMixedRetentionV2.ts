import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { deltaEntries, readLocalFullCandidate } from './localFullGenerationStage';
import { inspectLocalPointerPreparationEnvelopes } from './localPointerCheckedPreparation';
import { LOCAL_DELTA_COVERAGE_CATALOG } from './localFullCategoryDeltaCoverage';
import { verifyLocalCaptureBoundDeltaCoverage } from './localClaimRecapture';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { projectLegacyStagingGraph } from './importer';
import type { LegacyNormalizationManifest } from './manifest';
import { canonicalJson, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

export type MixedRetentionBinding = Parameters<typeof readLocalFullCandidate>[0];
type Row = Record<string, unknown>;
type Generation = { manifest: LegacyNormalizationManifest; acquisition: FinalGenerationPreparationInput['original'] };
type Prepared = Parameters<typeof inspectLocalPointerPreparationEnvelopes>[1];
export type MixedRetentionEvidence = Readonly<{
  format: 'TASK19_MIXED_RETENTION_V2'; authority: 'NONAUTHORITY'; activationAllowed: false;
  complete: false; exclusion: 'NOT_PROVEN'; binding: MixedRetentionBinding;
  header: Row; envelopes: Row[]; sources: Row[]; targets: Row[]; mappings: Row[];
  contributors: Row[]; deltas: Row[]; recaptures: Row[]; reconciliation: Row[];
  coverage: Readonly<{ categories: readonly string[]; capture: ReturnType<typeof verifyLocalCaptureBoundDeltaCoverage> }>;
}>;
const LIMIT = 16_000_000;
function refused(): never { throw new Error('Local mixed V2 retention evidence refused.'); }
function equal(actual: unknown, expected: unknown) {
  if (canonicalJson(actual) !== canonicalJson(expected)) refused();
}
function report(category: string, rows: readonly unknown[]) {
  const digest = sha256(canonicalJson(rows.map(row => canonicalJson(row)).sort()));
  return { category, expected_count: rows.length, observed_count: rows.length,
    expected_digest: digest, observed_digest: digest, status: 'MATCH' };
}
function rowsEqual(actual: unknown, expected: readonly unknown[]) {
  if (!Array.isArray(actual)) refused();
  equal(actual.map(row => canonicalJson(row)).sort(), expected.map(row => canonicalJson(row)).sort());
}

/** Cold pure verification uses ONLY retained acquisitions and rows. It does not
 * query/rebuild missing rows from a source, install data, or issue authority.
 * The file layer must first verify its separately pinned whole-artifact digest.
 * Separate V2 admission, never an upgrade/fallback from Products-only V1.
 * Admits Products MUTATED/REMOVED and Settings MUTATED plus nonempty bounded
 * Redis-only claim recapture. Unsupported category/kind combinations fail closed.
 * Every catalog category/report, including empty tombstones, remains mandatory. */
export function verifyLocalMixedRetentionV2(bytes: string, expected: MixedRetentionBinding): MixedRetentionEvidence {
  try {
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > LIMIT) refused();
    const evidence = JSON.parse(bytes) as MixedRetentionEvidence;
    equal(Object.keys(evidence).sort(), ['format','authority','activationAllowed','complete','exclusion','binding',
      'header','envelopes','sources','targets','mappings','contributors','deltas','recaptures','reconciliation','coverage'].sort());
    if (evidence.format !== 'TASK19_MIXED_RETENTION_V2' || evidence.authority !== 'NONAUTHORITY'
      || evidence.activationAllowed !== false || evidence.complete !== false || evidence.exclusion !== 'NOT_PROVEN') refused();
    equal(Object.keys(evidence.binding).sort(), ['tenantId','migrationJobId','generationId','expectedStateVersion','sourceFingerprint','manifestDigest'].sort());
    equal(evidence.binding, expected);
    const { header, envelopes, binding } = evidence;
    const envelope = (id: unknown) => {
      const rows = envelopes.filter(row => row.event_id === id);
      if (rows.length !== 1) refused();
      return rows[0].redacted_details as Record<string, unknown>;
    };
    const original = envelope(header.original_generation_id), candidate = envelope(header.candidate_generation_id);
    const planEnvelope = envelope(header.plan_id);
    const plan = { status: planEnvelope.status, changes: planEnvelope.changes, blockers: planEnvelope.blockers } as Prepared['plan'];
    const prepared = { storage: 'UNTRUSTED_PREPARATION' as const, originalGenerationId: header.original_generation_id as string,
      candidateGenerationId: header.candidate_generation_id as string, planId: header.plan_id as string, plan };
    const context = { tenantId: binding.tenantId, migrationJobId: binding.migrationJobId,
      expectedStateVersion: binding.expectedStateVersion, originalSourceId: original.originalSourceId,
      originalSnapshotId: original.originalSnapshotId, exclusionGenerationReference: candidate.exclusionGenerationReference };
    // Re-normalize the retained captures and authenticate all three envelope IDs,
    // tenant/job/version/manifest bindings, source pointers and the exact plan.
    inspectLocalPointerPreparationEnvelopes(context, prepared, envelopes);
    const before = original.manifest as LegacyNormalizationManifest, after = candidate.manifest as LegacyNormalizationManifest;
    const kinds = [...new Set(plan.changes.map(change => `${change.table}:${change.kind}`))].sort();
    equal(kinds, ['products:MUTATED','products:REMOVED','settings:MUTATED']);
    const capture = verifyLocalCaptureBoundDeltaCoverage(
      { manifest: before, acquisition: original.acquisition as Generation['acquisition'] },
      { manifest: after, acquisition: candidate.acquisition as Generation['acquisition'] }, plan);
    if (!capture.recaptures.length) refused();
    const coverage = { categories: LOCAL_DELTA_COVERAGE_CATALOG.map(({ table }) => table), capture };
    equal(evidence.coverage, coverage);
    equal(header, { original_generation_id: prepared.originalGenerationId,
      candidate_generation_id: prepared.candidateGenerationId, plan_id: prepared.planId,
      expected_state_version: binding.expectedStateVersion, source_fingerprint: binding.sourceFingerprint,
      manifest_digest: binding.manifestDigest, scope: 'LOCAL_CANDIDATE', writer_exclusion_status: 'NOT_PROVEN' });
    if (after.sourceFingerprint !== binding.sourceFingerprint || after.manifestDigest !== binding.manifestDigest
      || binding.generationId !== `full-recapture-stage:${sha256(canonicalJson([
        context, prepared.originalGenerationId, prepared.candidateGenerationId, prepared.planId]))}`) refused();
    const graph = projectLegacyStagingGraph(after);
    const sources = after.sourceRecords.map((source_value, source_ordinal) => ({ source_value, source_ordinal }));
    const mappings = after.mappings.map((mapping_value, mapping_ordinal) => ({ mapping_value, mapping_ordinal,
      target_table: mapping_value.targetTable, target_id: mapping_value.targetId }));
    const targets = graph.targets.map(row => ({ target_table: row.table, target_id: row.id, canonical_value: row.value }));
    const contributors = graph.contributors.map(row => ({ mapping_ordinal: row.mappingOrdinal, source_ordinal: row.sourceOrdinal }));
    const deltas = deltaEntries(before, after, plan.changes, graph);
    rowsEqual(evidence.sources, sources); rowsEqual(evidence.targets, targets);
    rowsEqual(evidence.mappings, mappings); rowsEqual(evidence.contributors, contributors);
    const recaptures = deltaEntries(before, after, capture.recaptures, graph)
      .map(({ target_table, target_id, entry_value }) => ({ target_table, target_id, entry_value }));
    rowsEqual(evidence.deltas, deltas); rowsEqual(evidence.recaptures, recaptures);
    const reports = [report('SOURCE_RECORDS', sources), report('MAPPINGS', mappings), report('CONTRIBUTORS', contributors),
      report('DELTA_ENTRIES', deltas), report('CLAIM_RECAPTURES', recaptures), ...LOCAL_DELTA_COVERAGE_CATALOG.map(({ table }) =>
        report(table, targets.filter(row => row.target_table === table)))];
    rowsEqual(evidence.reconciliation, reports);
    return deepFreeze(evidence);
  } catch { refused(); }
}

/** Call ONLY inside an owned synthetic source's locked repeatable-read lease.
 * Unlike export of the materialized domain, this preserves the exact persisted
 * source-only before/after images and reports, not just reconstructed targets. */
export async function captureLocalMixedRetentionV2(binding: MixedRetentionBinding,
  tx: TenantTransaction): Promise<MixedRetentionEvidence> {
  try {
    await readLocalFullCandidate(binding, tx);
    const scope = sql`tenant_id=${binding.tenantId} AND migration_job_id=${binding.migrationJobId} AND generation_id=${binding.generationId}`;
    const header = (await tx.execute(sql`SELECT candidate_generation_id,original_generation_id,plan_id,
      expected_state_version::text AS expected_state_version,source_fingerprint,manifest_digest,scope,writer_exclusion_status
      FROM migration_full_generations WHERE ${scope}`)).rows[0];
    const envelopes = (await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,
      entity_type,entity_id,redacted_details FROM audit_events WHERE tenant_id=${binding.tenantId}
      AND job_id=${binding.migrationJobId} AND event_id IN (${header.original_generation_id},${header.candidate_generation_id},${header.plan_id})`)).rows;
    const original = envelopes.find(row => row.event_id === header.original_generation_id)!.redacted_details as Generation;
    const candidate = envelopes.find(row => row.event_id === header.candidate_generation_id)!.redacted_details as Generation;
    const plan = envelopes.find(row => row.event_id === header.plan_id)!.redacted_details as Prepared['plan'];
    const evidence: MixedRetentionEvidence = {
      format: 'TASK19_MIXED_RETENTION_V2', authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN',
      binding, header, envelopes,
      sources: (await tx.execute(sql`SELECT source_ordinal,source_value FROM migration_full_sources WHERE ${scope}`)).rows,
      targets: (await tx.execute(sql`SELECT target_table,target_id,canonical_value FROM migration_full_targets WHERE ${scope}`)).rows,
      mappings: (await tx.execute(sql`SELECT mapping_ordinal,target_table,target_id,mapping_value FROM migration_full_mappings WHERE ${scope}`)).rows,
      contributors: (await tx.execute(sql`SELECT mapping_ordinal,source_ordinal FROM migration_full_contributors WHERE ${scope}`)).rows,
      deltas: (await tx.execute(sql`SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries WHERE ${scope}`)).rows,
      recaptures: (await tx.execute(sql`SELECT target_table,target_id,entry_value FROM migration_full_claim_recaptures WHERE ${scope}`)).rows,
      reconciliation: (await tx.execute(sql`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
        FROM migration_full_reconciliation WHERE ${scope}`)).rows,
      coverage: { categories: LOCAL_DELTA_COVERAGE_CATALOG.map(({ table }) => table),
        capture: verifyLocalCaptureBoundDeltaCoverage(
          { manifest: original.manifest, acquisition: original.acquisition },
          { manifest: candidate.manifest, acquisition: candidate.acquisition },
          { status: plan.status, changes: plan.changes, blockers: plan.blockers }) },
    };
    return verifyLocalMixedRetentionV2(canonicalJson(evidence), binding);
  } catch { refused(); }
}
