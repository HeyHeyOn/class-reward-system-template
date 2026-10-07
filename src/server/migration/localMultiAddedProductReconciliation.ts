import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { buildLocalMultiAddedProductPayload } from './localMultiAddedProductPlan';
import { assertNormalizationInput, canonicalJson, isHexDigest, isPlainRecord, sha256 } from './validators';

export type LocalMultiAddedProductReconciliationInput = Readonly<{
  tenantId: string;
  migrationJobId: string;
  expectedStateVersion: string;
  originalSourceId: string;
  originalSnapshotId: string;
  generationId: string;
  candidateManifestDigest: string;
}>;
const REFUSAL = 'Local multi-added-product reconciliation refused.';
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const INPUT_KEYS = ['tenantId', 'migrationJobId', 'expectedStateVersion', 'originalSourceId',
  'originalSnapshotId', 'generationId', 'candidateManifestDigest'] as const;

function bindingSnapshot(value: LocalMultiAddedProductReconciliationInput): LocalMultiAddedProductReconciliationInput {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== INPUT_KEYS.length) throw new Error('input');
  const copy = {} as Record<typeof INPUT_KEYS[number], string>;
  for (const key of INPUT_KEYS) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !('value' in field) || typeof field.value !== 'string' || !field.value
      || field.value !== field.value.trim() || field.value.length > 512) throw new Error('input');
    copy[key] = field.value;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(copy.tenantId)
    || !/^[1-9][0-9]{0,15}$/.test(copy.expectedStateVersion)
    || BigInt(copy.expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER)
    || !/^sheet:[0-9a-f]{64}$/.test(copy.originalSourceId)
    || !/^import:[0-9a-f]{64}$/.test(copy.originalSnapshotId)
    || !/^preparation:candidate:[0-9a-f]{64}$/.test(copy.generationId)
    || !isHexDigest(copy.candidateManifestDigest)) throw new Error('binding');
  return Object.freeze(copy);
}

/** Logical read-only inspection inside an injected tenant transaction.
 * SELECT locks protect the local persisted view, not any Sheet/Redis writer.
 * Persisted acquisition is UNTRUSTED_PREPARATION: re-normalization establishes
 * internal consistency, not acquisition authenticity, freshness or exclusion.
 * Only 2+ ADDED Products are supported. This never stages or repairs any row.
 * Requires READ COMMITTED and importer lock order, not an autocommit adapter. */
export async function inspectLocalMultiAddedProductGeneration(tx: TenantTransaction,
  raw: LocalMultiAddedProductReconciliationInput) {
  try {
    const input = bindingSnapshot(raw);
    const { tenantId, migrationJobId, expectedStateVersion, originalSourceId, originalSnapshotId,
      generationId, candidateManifestDigest } = input;
    const { rows: context } = await tx.execute(sql`SELECT current_setting('app.tenant_id',true) AS tenant_id,
      current_setting('transaction_isolation') AS isolation`);
    if (context.length !== 1 || context[0].tenant_id !== tenantId || context[0].isolation !== 'read committed') throw new Error('context');
    const { rows: tenants } = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
    const { rows: jobs } = await tx.execute(sql`SELECT status,state_version::text AS version FROM migration_jobs
      WHERE tenant_id=${tenantId} AND job_id=${migrationJobId} FOR UPDATE`);
    if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING' || jobs.length !== 1
      || jobs[0].status !== 'READY' || jobs[0].version !== expectedStateVersion) throw new Error('phase');
    // The generation lock also conflicts with FK inserts of new source rows.
    // Existing children are immutable; each source admits at most one target.
    const { rows: generations } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,original_source_id,
      original_snapshot_id,original_snapshot_phase,candidate_event_id,plan_event_id,candidate_manifest_digest,
      candidate_sheet_digest,expected_state_version::text AS expected_state_version,phase,exclusion
      FROM migration_final_generations WHERE tenant_id=${tenantId} AND generation_id=${generationId} FOR UPDATE`);
    if (generations.length !== 1) throw new Error('generation');
    const generation = generations[0];
    if (typeof generation.plan_event_id !== 'string' || !/^preparation:plan:[0-9a-f]{64}$/.test(generation.plan_event_id)) throw new Error('plan');

    const envelope = async (id: string, kind: 'ORIGINAL' | 'CANDIDATE' | 'PLAN') => {
      const { rows } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,
        entity_type,entity_id,redacted_details FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${id}`);
      if (rows.length !== 1 || rows[0].tenant_id !== tenantId || rows[0].event_id !== id || rows[0].job_id !== migrationJobId
        || rows[0].event_type !== `MIGRATION_PREPARATION_${kind}` || rows[0].operation_id !== null
        || rows[0].actor_user_id !== null || rows[0].entity_type !== null || rows[0].entity_id !== null
        || !isPlainRecord(rows[0].redacted_details)) throw new Error('envelope');
      const details = rows[0].redacted_details;
      assertNormalizationInput(details);
      if (id !== `preparation:${kind.toLowerCase()}:${sha256(canonicalJson(details))}`
        || details.storage !== 'UNTRUSTED_PREPARATION') throw new Error('envelope digest');
      return details;
    };
    const candidate = await envelope(generationId, 'CANDIDATE');
    if (typeof candidate.originalGenerationId !== 'string'
      || !/^preparation:original:[0-9a-f]{64}$/.test(candidate.originalGenerationId)) throw new Error('original');
    const original = await envelope(candidate.originalGenerationId, 'ORIGINAL');
    const plan = await envelope(generation.plan_event_id, 'PLAN');
    const reconstitute = (details: Record<string, unknown>) => {
      if (!isPlainRecord(details.acquisition)) throw new Error('acquisition');
      const acquired = details.acquisition as FinalGenerationPreparationInput['candidate'];
      const manifest = createLegacyNormalizationManifest({ tenantId, migrationJobId, sheets: acquired.sheets, redis: acquired.redis });
      if (manifest.status !== 'READY_FOR_IMPORT' || manifest.blockingConflicts.length || manifest.quarantines.length
        || !equal(manifest, details.manifest)
        || !equal(details.acquisition, { sheets: acquired.sheets, ...(acquired.redis ? { redis: acquired.redis } : {}) })) throw new Error('manifest');
      // Current stage rejects legacy aliases even if they normalize identically.
      if (Object.hasOwn(acquired.sheets.tabs, 'TaskChecks') || Object.hasOwn(acquired.sheets.tabs, 'RewardChecks')) throw new Error('alias');
      return { acquired, manifest };
    };
    const before = reconstitute(original);
    const after = reconstitute(candidate);
    const binding = { tenantId, migrationJobId, expectedStatus: 'READY', expectedStateVersion, originalSourceId, originalSnapshotId,
      originalManifestDigest: before.manifest.manifestDigest, originalSourceFingerprint: before.manifest.sourceFingerprint };
    if (originalSourceId !== `sheet:${before.manifest.sourceArtifacts.sheets.digest}`
      || originalSnapshotId !== `import:${before.manifest.manifestDigest}`
      || after.manifest.manifestDigest !== candidateManifestDigest
      || before.acquired.sheets.spreadsheetId !== after.acquired.sheets.spreadsheetId
      || !equal(before.manifest.sourceArtifacts.sheets.credentialHashes, after.manifest.sourceArtifacts.sheets.credentialHashes)
      || !isHexDigest(candidate.exclusionGenerationReference)
      || !equal(original, { storage: 'UNTRUSTED_PREPARATION', phase: 'ORIGINAL_PREFLIGHT', tenantId, migrationJobId,
        originalSourceId, originalSnapshotId, acquisition: before.acquired, manifest: before.manifest })
      || !equal(candidate, { storage: 'UNTRUSTED_PREPARATION', phase: 'FINAL_CANDIDATE', binding,
        originalGenerationId: candidate.originalGenerationId, exclusionGenerationReference: candidate.exclusionGenerationReference,
        acquisition: after.acquired, manifest: after.manifest })) throw new Error('binding');

    // Build the entire product delta from re-normalized acquisitions, not plan
    // changes or an aggregate. Pure guard additionally compares ALL retained
    // tables, mappings and source rows; unsupported side changes are refused.
    const index = (manifest: LegacyNormalizationManifest) => {
      const result = new Map<string, string>();
      for (const row of manifest.records.products ?? []) {
        if (typeof row.productId !== 'string' || !row.productId || result.has(row.productId)) throw new Error('duplicate');
        result.set(row.productId, sha256(canonicalJson(row)));
      }
      return result;
    };
    const oldProducts = index(before.manifest); const newProducts = index(after.manifest);
    const changes: Array<{ table: string; identity: string; kind: 'ADDED'; beforeDigest: null; afterDigest: string }> = [];
    for (const id of [...new Set([...oldProducts.keys(), ...newProducts.keys()])].sort()) {
      const oldDigest = oldProducts.get(id); const newDigest = newProducts.get(id);
      if (oldDigest === newDigest) continue;
      if (oldDigest !== undefined || newDigest === undefined) throw new Error('unsupported delta');
      changes.push({ table: 'products', identity: canonicalJson([id]), kind: 'ADDED', beforeDigest: null, afterDigest: newDigest });
    }
    changes.sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
    const payload = buildLocalMultiAddedProductPayload(before.manifest, after.manifest, changes);
    if (!equal(plan, { storage: 'UNTRUSTED_PREPARATION', phase: 'DELTA_PLAN', binding,
      originalGenerationId: candidate.originalGenerationId, candidateGenerationId: generationId,
      exclusionGenerationReference: candidate.exclusionGenerationReference,
      originalManifestDigest: before.manifest.manifestDigest, candidateManifestDigest,
      status: 'DIFF_VALIDATED', blockers: [], changes })) throw new Error('plan');
    if (!equal(generation, { tenant_id: tenantId, job_id: migrationJobId, generation_id: generationId,
      original_source_id: originalSourceId, original_snapshot_id: originalSnapshotId, original_snapshot_phase: 'PREFLIGHT',
      candidate_event_id: generationId, plan_event_id: generation.plan_event_id, candidate_manifest_digest: candidateManifestDigest,
      candidate_sheet_digest: after.manifest.sourceArtifacts.sheets.digest, expected_state_version: expectedStateVersion,
      phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN' })) throw new Error('generation binding');
    if ((await inspectLegacyImport(tx, { tenantId, migrationJobId, manifest: before.manifest }, before.manifest)).length) throw new Error('original drift');

    const expected = payload.products.map((product) => {
      const recordId = `local-final-record:${sha256(canonicalJson([tenantId, migrationJobId, generationId, product.sourceRowHash, product.productId]))}`;
      const identity = { tenant_id: tenantId, job_id: migrationJobId, generation_id: generationId, record_id: recordId };
      return { source: { ...identity, source_row_number: String(product.sourceRowNumber), source_row_hash: product.sourceRowHash,
        source_collection: 'Products', source_record_id: product.productId,
        redacted_record: product.source.redactedSourceRecord, canonical_record: product.source.canonicalRecord },
      target: { ...identity, target_table: 'products', target_id: product.productId, canonical_target: product.target } };
    });
    // Never join or restrict to expected record IDs: either would hide extras.
    const { rows: sources } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,
      source_row_number::text AS source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record
      FROM migration_final_source_records WHERE tenant_id=${tenantId} AND generation_id=${generationId}`);
    const { rows: targets } = await tx.execute(sql`SELECT tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target
      FROM migration_final_targets WHERE tenant_id=${tenantId} AND generation_id=${generationId}`);
    const exactSet = (actual: readonly Record<string, unknown>[], wanted: readonly Record<string, unknown>[]) =>
      actual.length === wanted.length && new Set(actual.map((row) => row.record_id)).size === actual.length
      && equal(actual.map((row) => canonicalJson(row)).sort(), wanted.map((row) => canonicalJson(row)).sort());
    if (!exactSet(sources, expected.map((row) => row.source)) || !exactSet(targets, expected.map((row) => row.target))) throw new Error('row set');
    // No reconciliation/aggregate table is consulted or written. No sensitive
    // payload or archived exclusion reference leaves this boundary.
    return Object.freeze({ ...input, authority: 'NONAUTHORITY' as const, phase: 'LOCAL_CANDIDATE' as const,
      exclusion: 'NOT_PROVEN' as const, activationAllowed: false as const, complete: false as const,
      scope: 'MULTI_ADDED_PRODUCTS' as const, expectedCount: expected.length,
      sourceCount: sources.length, targetCount: targets.length, delta: 0 as const, status: 'MATCH' as const });
  } catch { throw new Error(REFUSAL); }
}

/** No default DB connection. Caller must inject a genuine tenant transaction;
 * unknown/caller-supplied evidence fields are refused before invoking it. */
export async function reconcileLocalMultiAddedProducts(input: LocalMultiAddedProductReconciliationInput,
  options: Readonly<{ runTransaction: TenantImportTransactionRunner }>) {
  try {
    const binding = bindingSnapshot(input);
    return await options.runTransaction(binding.tenantId, (tx) => inspectLocalMultiAddedProductGeneration(tx, binding));
  } catch { throw new Error(REFUSAL); }
}
