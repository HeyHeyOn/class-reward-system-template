import 'server-only';
import { types } from 'node:util';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { projectLegacyStagingGraph, type TenantImportTransactionRunner } from './importer';
import { inspectLocalPointerPreparationEnvelopes, stageLocalPointerCheckedPreparation, inspectLocalPointerCheckedPreparation } from './localPointerCheckedPreparation';
import { LOCAL_DELTA_COVERAGE_CATALOG, verifyLocalFullCategoryDeltaCoverage,
  verifyLocalMutableCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';
import type { LegacyNormalizationManifest } from './manifest';
import { verifyLocalCaptureBoundDeltaCoverage } from './localClaimRecapture';
import { canonicalJson, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Preparation = Awaited<ReturnType<typeof stageLocalPointerCheckedPreparation>>;
type Result = Readonly<{
  generationId: string; scope: 'LOCAL_FULL_ADDED_SNAPSHOT' | 'LOCAL_FULL_MUTABLE_SNAPSHOT' | 'LOCAL_FULL_RECAPTURE_SNAPSHOT';
  exclusion: 'NOT_PROVEN'; authority: 'NONAUTHORITY'; phase: 'LOCAL_CANDIDATE';
  activationAllowed: false; complete: false; persistedReadback: 'MATCH';
  targetCounts: Readonly<Record<string, number>>;
}>;

/** Opt-in full normalized snapshot and mutable delta, not operational publication.
 * Captures are admitted/re-normalized by the existing final/pointer
 * pipeline. All audit appends, graph inserts and exact readbacks share its locked
 * READY transaction. No default connection, capture adapter, HTTP endpoint,
 * writer fence, claim publication, lifecycle or state-version update is added.
 *
 * Mutable edits/removals retain before/after graphs and explicit staged tombstones.
 * Retained ledger/tombstone bytes stay exact. A separate capture-bound contract
 * permits single-Redis-contributor claim recapture, with explicit immutable images.
 * Original ADDED/recapture-only accounting is unchanged. Mutable generations,
 * including those with claim recaptures, require every catalog report, including
 * empty categories; incomplete old evidence is
 * refused on retry, never healed or upgraded in place.
 * This is NOT the final cutover importer. The mandatory
 * internal runner must faithfully await the callback and commit/rollback it;
 * this function cannot certify a caller-provided driver or an external fence.
 */
export async function stageLocalFullGeneration(input: FinalGenerationPreparationInput,
  runTransaction: TenantImportTransactionRunner): Promise<Result> {
  return fullGeneration(input, runTransaction, false);
}

/** Read the persisted acquisitions, never accept caller-created manifests/MATCH.
 * The shared pipeline rebuilds both captures, locks READY/original import, then
 * reads ALL immutable evidence without inserting even on a missing-row retry. */
export async function readLocalFullCandidate(binding: Readonly<{ tenantId: string; migrationJobId: string;
  generationId: string; expectedStateVersion: string; sourceFingerprint: string; manifestDigest: string }>, tx: TenantTransaction) {
  const { tenantId, migrationJobId, generationId } = binding;
  const { rows } = await tx.execute(sql`SELECT * FROM migration_full_generations
    WHERE tenant_id=${tenantId} AND migration_job_id=${migrationJobId} AND generation_id=${generationId}`);
  if (rows.length !== 1) refused();
  const header = rows[0];
  const { rows: envelopes } = await tx.execute(sql`SELECT event_id,redacted_details FROM audit_events
    WHERE tenant_id=${tenantId} AND job_id=${migrationJobId}
    AND event_id IN (${header.original_generation_id},${header.candidate_generation_id})`);
  type Archive = { acquisition: FinalGenerationPreparationInput['original']; manifest: LegacyNormalizationManifest;
    originalSnapshotId: string; originalSourceId: string; exclusionGenerationReference: string };
  const original = envelopes.find(row => row.event_id === header.original_generation_id)?.redacted_details as Archive;
  const candidate = envelopes.find(row => row.event_id === header.candidate_generation_id)?.redacted_details as Archive;
  if (!original || !candidate) refused();
  const input: FinalGenerationPreparationInput = { tenantId, migrationJobId, expectedStateVersion: binding.expectedStateVersion,
    originalSnapshotId: original.originalSnapshotId, originalSourceId: original.originalSourceId,
    exclusionGenerationReference: candidate.exclusionGenerationReference, original: original.acquisition, candidate: candidate.acquisition };
  const result = await fullGeneration(input, async (tenant, callback) => {
    if (tenant !== tenantId) refused();
    return callback(tx);
  }, true);
  if (result.generationId !== generationId || candidate.manifest.sourceFingerprint !== binding.sourceFingerprint
    || candidate.manifest.manifestDigest !== binding.manifestDigest) refused();
  return deepFreeze(candidate.manifest);
}

async function fullGeneration(input: FinalGenerationPreparationInput,
  runTransaction: TenantImportTransactionRunner, readOnly: boolean): Promise<Result> {
  try {
    if (typeof runTransaction !== 'function' || types.isProxy(runTransaction)) refused();
    let staged: Result | undefined;
    let checkedPreparation: Preparation['preparation'] | undefined;
    const outer = await (readOnly ? inspectLocalPointerCheckedPreparation : stageLocalPointerCheckedPreparation)(input, (tenantId, callback) => {
      // The real stage admitted and detached the capture graph before this call.
      const { migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference } = input;
      const binding = { tenantId, migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference };
      return runTransaction(tenantId, async tx => {
        staged = undefined;
        checkedPreparation = undefined;
        const raw = await callback(tx);
        const prepared = raw as unknown as Preparation['preparation'];
        const { rows: archived } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,
          operation_id,actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId} AND job_id=${migrationJobId}
          AND event_id IN (${prepared.originalGenerationId},${prepared.candidateGenerationId},${prepared.planId})`);
        // Validate the second, persisted read too; never trust a caller manifest.
        inspectLocalPointerPreparationEnvelopes(binding, prepared, archived);
        type ArchivedGeneration = { manifest: LegacyNormalizationManifest; acquisition: FinalGenerationPreparationInput['original'] };
        const candidateArchive = archived.find(row => row.event_id === prepared.candidateGenerationId)!.redacted_details as ArchivedGeneration;
        const originalArchive = archived.find(row => row.event_id === prepared.originalGenerationId)!.redacted_details as ArchivedGeneration;
        const manifest = candidateArchive.manifest, original = originalArchive.manifest;
        const mutable = prepared.plan.changes.some(change => change.kind !== 'ADDED');
        const priorClaims = new Map((original.records.padlet_evidence_claims ?? []).map(row => [row.tupleDigest, canonicalJson(row)]));
        const hasRecapture = (manifest.records.padlet_evidence_claims ?? []).some(row =>
          priorClaims.has(row.tupleDigest) && priorClaims.get(row.tupleDigest) !== canonicalJson(row));
        // Exact multiset/digest accounting, including changes omitted from a plan.
        // The old ADDED helper and its callers retain their stricter contract.
        const recaptures = hasRecapture ? verifyLocalCaptureBoundDeltaCoverage(
          { manifest: original, acquisition: originalArchive.acquisition },
          { manifest, acquisition: candidateArchive.acquisition }, prepared.plan).recaptures : [];
        if (hasRecapture && !recaptures.length) refused();
        if (!hasRecapture) (mutable ? verifyLocalMutableCategoryDeltaCoverage : verifyLocalFullCategoryDeltaCoverage)(
          original.records, manifest.records, prepared.plan);
        const graph = projectLegacyStagingGraph(manifest);
        const hasDelta = mutable || hasRecapture;
        const delta = hasDelta ? deltaEntries(original, manifest, prepared.plan.changes, graph) : [];
        const recaptureEntries = hasRecapture ? deltaEntries(original, manifest, recaptures, graph)
          .map(({ target_table, target_id, entry_value }) => ({ target_table, target_id, entry_value })) : [];
        const generationId = `${hasRecapture ? 'full-recapture-stage' : mutable ? 'full-mutable-stage' : 'full-stage'}:${sha256(canonicalJson([
          binding, prepared.originalGenerationId, prepared.candidateGenerationId, prepared.planId,
        ]))}`;
        const header = { candidate_generation_id: prepared.candidateGenerationId,
          original_generation_id: prepared.originalGenerationId, plan_id: prepared.planId,
          expected_state_version: String(expectedStateVersion), source_fingerprint: manifest.sourceFingerprint,
          manifest_digest: manifest.manifestDigest, scope: 'LOCAL_CANDIDATE', writer_exclusion_status: 'NOT_PROVEN' };
        const scope = sql`tenant_id=${tenantId} AND migration_job_id=${migrationJobId} AND generation_id=${generationId}`;
        const readHeader = async () => (await tx.execute(sql`SELECT candidate_generation_id,original_generation_id,plan_id,
          expected_state_version::text AS expected_state_version,source_fingerprint,manifest_digest,scope,writer_exclusion_status
          FROM migration_full_generations WHERE ${scope}`)).rows;
        const previous = await readHeader();
        if (previous.length > 1 || (previous.length && canonicalJson(previous[0]) !== canonicalJson(header))) refused();
        const retry = previous.length === 1;
        if (readOnly && !retry) refused();
        if (!retry) {
          await tx.execute(sql`INSERT INTO migration_full_generations
            (tenant_id,migration_job_id,generation_id,candidate_generation_id,original_generation_id,plan_id,
             expected_state_version,source_fingerprint,manifest_digest,scope,writer_exclusion_status)
            VALUES (${tenantId},${migrationJobId},${generationId},${prepared.candidateGenerationId},${prepared.originalGenerationId},
             ${prepared.planId},${expectedStateVersion}::bigint,${manifest.sourceFingerprint},${manifest.manifestDigest},'LOCAL_CANDIDATE','NOT_PROVEN')`);
          await tx.execute(sql`INSERT INTO migration_full_sources
            (tenant_id,migration_job_id,generation_id,source_ordinal,source_value)
            SELECT ${tenantId},${migrationJobId},${generationId},(ordinality-1)::integer,value
            FROM jsonb_array_elements(${JSON.stringify(manifest.sourceRecords)}::jsonb) WITH ORDINALITY`);
          await tx.execute(sql`INSERT INTO migration_full_targets
            (tenant_id,migration_job_id,generation_id,target_table,target_id,canonical_value)
            SELECT ${tenantId},${migrationJobId},${generationId},value->>'table',value->>'id',value->'value'
            FROM jsonb_array_elements(${JSON.stringify(graph.targets)}::jsonb)`);
          await tx.execute(sql`INSERT INTO migration_full_mappings
            (tenant_id,migration_job_id,generation_id,mapping_ordinal,target_table,target_id,mapping_value)
            SELECT ${tenantId},${migrationJobId},${generationId},(ordinality-1)::integer,value->>'targetTable',value->>'targetId',value
            FROM jsonb_array_elements(${JSON.stringify(manifest.mappings)}::jsonb) WITH ORDINALITY`);
          await tx.execute(sql`INSERT INTO migration_full_contributors
            (tenant_id,migration_job_id,generation_id,mapping_ordinal,source_ordinal)
            SELECT ${tenantId},${migrationJobId},${generationId},(value->>'mappingOrdinal')::integer,(value->>'sourceOrdinal')::integer
            FROM jsonb_array_elements(${JSON.stringify(graph.contributors)}::jsonb)`);
          if (hasDelta) await tx.execute(sql`INSERT INTO migration_full_delta_entries
            (tenant_id,migration_job_id,generation_id,target_table,target_id,change_kind,entry_value)
            SELECT ${tenantId},${migrationJobId},${generationId},value->>'target_table',value->>'target_id',
              value->>'change_kind',value->'entry_value'
            FROM jsonb_array_elements(${JSON.stringify(delta)}::jsonb)`);
          if (hasRecapture) await tx.execute(sql`INSERT INTO migration_full_claim_recaptures
            (tenant_id,migration_job_id,generation_id,target_table,target_id,entry_value)
            SELECT ${tenantId},${migrationJobId},${generationId},value->>'target_table',value->>'target_id',value->'entry_value'
            FROM jsonb_array_elements(${JSON.stringify(recaptureEntries)}::jsonb)`);
        }
        const headerRows = await readHeader();
        if (headerRows.length !== 1 || canonicalJson(headerRows[0]) !== canonicalJson(header)) refused();
        const { rows: sources } = await tx.execute(sql`SELECT source_ordinal,source_value FROM migration_full_sources WHERE ${scope}`);
        const { rows: targets } = await tx.execute(sql`SELECT target_table,target_id,canonical_value FROM migration_full_targets WHERE ${scope}`);
        const { rows: mappings } = await tx.execute(sql`SELECT mapping_ordinal,target_table,target_id,mapping_value FROM migration_full_mappings WHERE ${scope}`);
        const { rows: contributors } = await tx.execute(sql`SELECT mapping_ordinal,source_ordinal FROM migration_full_contributors WHERE ${scope}`);
        // Compare complete keyed rows, not counts, caller hashes or one sample.
        const reports = [
          match('SOURCE_RECORDS', manifest.sourceRecords.map((value, ordinal) => ({ source_ordinal: ordinal, source_value: value })), sources),
          match('MAPPINGS', manifest.mappings.map((value, ordinal) => ({ mapping_ordinal: ordinal,
            target_table: value.targetTable, target_id: value.targetId, mapping_value: value })), mappings),
          match('CONTRIBUTORS', graph.contributors.map(row => ({ mapping_ordinal: row.mappingOrdinal, source_ordinal: row.sourceOrdinal })), contributors),
        ];
        const targetCounts: Record<string, number> = {};
        const { rows: storedDelta } = await tx.execute(sql`SELECT target_table,target_id,change_kind,entry_value
          FROM migration_full_delta_entries WHERE ${scope}`);
        const deltaReport = match('DELTA_ENTRIES', delta, storedDelta);
        if (hasDelta) reports.push(deltaReport);
        const { rows: storedRecaptures } = await tx.execute(sql`SELECT target_table,target_id,entry_value
          FROM migration_full_claim_recaptures WHERE ${scope}`);
        const recaptureReport = match('CLAIM_RECAPTURES', recaptureEntries, storedRecaptures);
        if (hasRecapture) reports.push(recaptureReport);
        if (targets.length !== graph.targets.length || targets.some(row => !(String(row.target_table) in manifest.records))) refused();
        // Optional empty record arrays can be absent from normalization. Mutable
        // final-delta evidence must still persist and re-read their zero reports.
        // Keep the unrelated ADDED/recapture-only contracts unchanged.
        const reportTables = mutable
          ? LOCAL_DELTA_COVERAGE_CATALOG.map(entry => entry.table) : Object.keys(manifest.records);
        for (const table of reportTables) {
          const expected = graph.targets.filter(row => row.table === table).map(row => ({
            target_table: table, target_id: row.id, canonical_value: row.value,
          }));
          reports.push(match(table, expected, targets.filter(row => row.target_table === table)));
          targetCounts[table] = expected.length;
        }
        if (!retry) await tx.execute(sql`INSERT INTO migration_full_reconciliation
          (tenant_id,migration_job_id,generation_id,category,expected_count,observed_count,expected_digest,observed_digest,status)
          SELECT ${tenantId},${migrationJobId},${generationId},value->>'category',(value->>'expected_count')::integer,
            (value->>'observed_count')::integer,value->>'expected_digest',value->>'observed_digest','MATCH'
          FROM jsonb_array_elements(${JSON.stringify(reports)}::jsonb)`);
        const { rows: persisted } = await tx.execute(sql`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
          FROM migration_full_reconciliation WHERE ${scope}`);
        match('REPORTS', reports, persisted);
        if (!readOnly) {
          // Graph/report INSERT triggers run after preparation's last check;
          // deferred constraint triggers can otherwise wait until COMMIT. Drain
          // them before a write-free replay of job, original, envelopes, graph
          // and reports in this same transaction. No publication writes follow.
          await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          await readLocalFullCandidate({ tenantId, migrationJobId, generationId, expectedStateVersion,
            sourceFingerprint: manifest.sourceFingerprint, manifestDigest: manifest.manifestDigest }, tx);
        }
        staged = deepFreeze({ generationId, scope: hasRecapture ? 'LOCAL_FULL_RECAPTURE_SNAPSHOT' as const
          : mutable ? 'LOCAL_FULL_MUTABLE_SNAPSHOT' as const : 'LOCAL_FULL_ADDED_SNAPSHOT' as const,
          exclusion: 'NOT_PROVEN' as const, authority: 'NONAUTHORITY' as const, phase: 'LOCAL_CANDIDATE' as const,
          activationAllowed: false as const, complete: false as const, persistedReadback: 'MATCH' as const, targetCounts });
        checkedPreparation = prepared;
        return raw;
      });
    });
    if (!staged || !checkedPreparation || canonicalJson(outer.preparation) !== canonicalJson(checkedPreparation)) refused();
    return staged;
  } catch { refused(); }
}

/** Pure image projection shared with Task19's source-independent verifier. */
export function deltaEntries(original: LegacyNormalizationManifest, candidate: LegacyNormalizationManifest,
  changes: readonly (Omit<Preparation['preparation']['plan']['changes'][number], 'kind'> &
    { kind: 'ADDED' | 'MUTATED' | 'REMOVED' | 'RECAPTURED' })[], candidateGraph: ReturnType<typeof projectLegacyStagingGraph>) {
  type Graph = ReturnType<typeof projectLegacyStagingGraph>;
  const originalGraph = projectLegacyStagingGraph(original);
  const index = (graph: Graph) => {
    const result = new Map<string, Graph['targets'][number]>();
    for (const target of graph.targets) {
      const keys = LOCAL_DELTA_COVERAGE_CATALOG.find(entry => entry.table === target.table)!.identityKeys;
      const key = canonicalJson([target.table, canonicalJson(keys.map(key => target.value[key]))]);
      if (result.has(key)) refused();
      result.set(key, target);
    }
    return result;
  };
  const before = index(originalGraph), after = index(candidateGraph);
  const image = (manifest: LegacyNormalizationManifest, graph: Graph, target: Graph['targets'][number] | undefined) => {
    if (!target) return null;
    const mappings = manifest.mappings.flatMap((value, ordinal) => value.targetTable === target.table && value.targetId === target.id
      ? [{ mappingOrdinal: ordinal, mappingValue: value }] : []);
    const ordinals = new Set(mappings.map(row => row.mappingOrdinal));
    const contributors = graph.contributors.filter(row => ordinals.has(row.mappingOrdinal));
    const sources = new Set(contributors.map(row => row.sourceOrdinal));
    if (!mappings.length || !contributors.length) refused();
    return { target: target.value, mappings, contributors,
      sources: manifest.sourceRecords.flatMap((value, ordinal) => sources.has(ordinal)
        ? [{ sourceOrdinal: ordinal, sourceValue: value }] : []) };
  };
  return changes.map(change => {
    const key = canonicalJson([change.table, change.identity]);
    const prior = before.get(key), next = after.get(key);
    if ((!prior && !next) || (prior && next && prior.id !== next.id)) refused();
    return { target_table: change.table, target_id: (next ?? prior)!.id, change_kind: change.kind,
      entry_value: { ...change, before: image(original, originalGraph, prior), after: image(candidate, candidateGraph, next) } };
  });
}

function match(category: string, expected: readonly unknown[], observed: readonly unknown[]) {
  const ordered = (rows: readonly unknown[]) => canonicalJson(rows.map(row => canonicalJson(row)).sort());
  const expectedBytes = ordered(expected);
  if (expectedBytes !== ordered(observed)) refused();
  const digest = sha256(expectedBytes);
  return { category, expected_count: expected.length, observed_count: observed.length,
    expected_digest: digest, observed_digest: digest, status: 'MATCH' };
}
function refused(): never { throw new Error('Local full-generation stage refused.'); }
