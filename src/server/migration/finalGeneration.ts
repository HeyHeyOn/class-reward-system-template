import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenantTransaction, type TenantTransaction } from '@/server/db/transaction';
import { inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import type { SheetsSnapshot } from './sheetsSnapshot';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import { assertNormalizationInput, canonicalJson, clonePlainData, deterministicId, isHexDigest, isPlainRecord, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Acquisition = Readonly<{ sheets: SheetsSnapshot; redis: RedisClaimSnapshot }>;
export type FinalGenerationPreparationInput = Readonly<{
  tenantId: string; migrationJobId: string; expectedStateVersion: string;
  originalSnapshotId: string; originalSourceId: string; exclusionGenerationReference: string;
  original: Acquisition; candidate: Acquisition;
}>;
type Change = Readonly<{ table: string; identity: string; kind: 'ADDED' | 'REMOVED' | 'MUTATED'; beforeDigest: string | null; afterDigest: string | null }>;
type DeltaPlan = Readonly<{ status: 'DIFF_VALIDATED' | 'BLOCKED'; changes: readonly Change[]; blockers: readonly string[] }>;
const IDENTITIES: Readonly<Record<string, readonly string[]>> = {
  students: ['studentId'], accounts: ['studentId'], products: ['productId'], settings: ['key'],
  tasks: ['taskInstanceId'], task_allowed_students: ['taskInstanceId', 'studentId'],
  promotions: ['promotionId'], promotion_products: ['promotionProductId'], transactions: ['transactionId'],
  transaction_items: ['itemId'], adjustments: ['adjustmentId'], task_assignments: ['assignmentId'],
  task_completions: ['completionId'], legacy_operation_bindings: ['operationId'],
  padlet_evidence_claims: ['tupleDigest'], padlet_claim_digest_tombstones: ['tupleDigest'],
};
const MUTABLE = new Set(['students', 'accounts', 'products', 'settings', 'tasks', 'task_allowed_students', 'promotions', 'promotion_products']);
const KEYS = ['tenantId', 'migrationJobId', 'expectedStateVersion', 'originalSnapshotId', 'originalSourceId', 'exclusionGenerationReference', 'original', 'candidate'];

/** Internal local preparation ONLY. Acquired objects are untrusted consistency input.
 * No approval receipt, verifier, freeze phase or authority capability is accepted.
 * DIFF_VALIDATED describes canonical differences, NOT executable operational SQL.
 * The only writes are immutable audit envelopes; all forward actions are absent. */
export async function stageLegacyFinalGeneration(raw: FinalGenerationPreparationInput,
  options: { runTransaction?: TenantImportTransactionRunner } = {}) {
  try {
    // Validate descriptors before accessing input; snapshot bounds/shape/digests are
    // checked separately so identical original/candidate objects need no alias hack.
    if (!isPlainRecord(raw) || Reflect.ownKeys(raw).length !== KEYS.length || KEYS.some((key) => {
      const d = Object.getOwnPropertyDescriptor(raw, key);
      return !d || !d.enumerable || !('value' in d);
    })) refused();
    const { tenantId, migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference } = raw;
    if (typeof expectedStateVersion !== 'string' || !/^[1-9][0-9]{0,15}$/.test(expectedStateVersion)
      || BigInt(expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER)
      || !isHexDigest(exclusionGenerationReference)) refused();
    for (const id of [originalSnapshotId, originalSourceId]) {
      if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 512) refused();
    }
    const acquire = (value: Acquisition) => {
      assertNormalizationInput(value);
      if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== 'redis,sheets') refused();
      // The shared acquisition validator checks Settings only by its canonical
      // name. Full-envelope retention is narrower: refuse every noncanonical
      // alias recognized by redactWorkbook, before retaining either capture.
      if (Object.keys(value.sheets.tabs).some((name) => name !== 'Settings' && name.trim().toLowerCase() === 'settings')) refused();
      const manifest = createLegacyNormalizationManifest({ tenantId, migrationJobId, sheets: value.sheets, redis: value.redis });
      return { acquisition: clonePlainData(value), manifest };
    };
    const original = acquire(raw.original);
    const candidate = acquire(raw.candidate);
    if (original.acquisition.sheets.spreadsheetId !== candidate.acquisition.sheets.spreadsheetId
      || originalSnapshotId !== `import:${original.manifest.manifestDigest}`
      || originalSourceId !== `sheet:${original.manifest.sourceArtifacts.sheets.digest}`) refused();
    const binding = { tenantId, migrationJobId, expectedStatus: 'READY', expectedStateVersion,
      originalSnapshotId, originalSourceId, originalManifestDigest: original.manifest.manifestDigest,
      originalSourceFingerprint: original.manifest.sourceFingerprint };
    const originalDetails = { storage: 'UNTRUSTED_PREPARATION', phase: 'ORIGINAL_PREFLIGHT',
      tenantId, migrationJobId, originalSnapshotId, originalSourceId, ...original };
    const originalGenerationId = envelopeId('ORIGINAL', originalDetails);
    const candidateDetails = { storage: 'UNTRUSTED_PREPARATION', phase: 'FINAL_CANDIDATE',
      binding, originalGenerationId, exclusionGenerationReference, ...candidate };
    const candidateGenerationId = envelopeId('CANDIDATE', candidateDetails);
    const plan = delta(original.manifest, candidate.manifest);
    const planDetails = { storage: 'UNTRUSTED_PREPARATION', phase: 'DELTA_PLAN', binding,
      originalGenerationId, candidateGenerationId, exclusionGenerationReference,
      originalManifestDigest: original.manifest.manifestDigest, candidateManifestDigest: candidate.manifest.manifestDigest,
      ...plan };
    const planId = envelopeId('PLAN', planDetails);
    return await (options.runTransaction ?? withTenantTransaction)(tenantId, async (tx) => {
      // Reuse all existing original source/checkpoint/target readback guards. Do
      // not feed the candidate into identical-preflight inspection or ensureSources.
      const issues = await inspectLegacyImport(tx, { tenantId, migrationJobId, manifest: original.manifest }, original.manifest);
      if (issues.length) refused();
      const { rows } = await tx.execute(sql`SELECT status,state_version::text AS version FROM migration_jobs
        WHERE tenant_id=${tenantId} AND job_id=${migrationJobId} FOR UPDATE`);
      if (rows.length !== 1 || rows[0].status !== 'READY' || rows[0].version !== expectedStateVersion) refused();
      await append(tx, tenantId, migrationJobId, 'ORIGINAL', originalGenerationId, originalDetails);
      await append(tx, tenantId, migrationJobId, 'CANDIDATE', candidateGenerationId, candidateDetails);
      await append(tx, tenantId, migrationJobId, 'PLAN', planId, planDetails);
      return deepFreeze({ storage: 'UNTRUSTED_PREPARATION' as const, originalGenerationId, candidateGenerationId, planId, plan });
    });
  } catch { throw new Error('Final generation preparation refused.'); }
}

function delta(original: LegacyNormalizationManifest, candidate: LegacyNormalizationManifest): DeltaPlan {
  const blockers = new Set<string>();
  if ([original, candidate].some((m) => m.status !== 'READY_FOR_IMPORT' || m.blockingConflicts.length
    || m.quarantines.length || m.sourceRecords.some((r) => r.mappingStatus === 'QUARANTINED' || r.errorCodes.length))) {
    blockers.add('NORMALIZATION_BLOCKED');
  }
  if (canonicalJson(original.sourceArtifacts.sheets.credentialHashes) !== canonicalJson(candidate.sourceArtifacts.sheets.credentialHashes)) {
    blockers.add('CREDENTIAL_HASH_CHANGE_UNSUPPORTED');
  }
  const changes: Change[] = [];
  for (const table of [...new Set([...Object.keys(original.records), ...Object.keys(candidate.records)])].sort()) {
    const keys = Object.hasOwn(IDENTITIES, table) ? IDENTITIES[table] : undefined;
    if (!keys) refused();
    const index = (manifest: LegacyNormalizationManifest) => {
      const result = new Map<string, { digest: string; contributors: string }>();
      for (const row of manifest.records[table] ?? []) {
        if (keys.some((key) => typeof row[key] !== 'string' || !row[key])) refused();
        const identity = canonicalJson(keys.map((key) => row[key]));
        if (result.has(identity)) refused();
        result.set(identity, { digest: sha256(canonicalJson(row)),
          contributors: MUTABLE.has(table) ? '' : retainedContributors(manifest, table, row, keys) });
      }
      return result;
    };
    const before = index(original); const after = index(candidate);
    for (const identity of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const prior = before.get(identity); const next = after.get(identity);
      if (prior && next && prior.contributors !== next.contributors) blockers.add('APPEND_ONLY_HISTORY_PROVENANCE_CHANGED');
      const beforeDigest = prior?.digest ?? null; const afterDigest = next?.digest ?? null;
      if (beforeDigest === afterDigest) continue;
      const kind = beforeDigest === null ? 'ADDED' : afterDigest === null ? 'REMOVED' : 'MUTATED';
      changes.push({ table, identity, kind, beforeDigest, afterDigest });
      if (!MUTABLE.has(table) && kind !== 'ADDED') blockers.add('APPEND_ONLY_HISTORY_CHANGED');
    }
  }
  return { status: blockers.size ? 'BLOCKED' : 'DIFF_VALIDATED', changes, blockers: [...blockers].sort() };
}
// Mapping IDs differ from delta business identities for derived Redis targets.
// Match every mapping to its own contributor family, not the first member of a
// claim union or a Set of hashes. Items inherit their transaction's source row.
function retainedContributors(manifest: LegacyNormalizationManifest, table: string,
  row: Readonly<Record<string, unknown>>, keys: readonly string[]): string {
  let targetId = String(row[keys[0]]);
  if (table === 'legacy_operation_bindings' || table === 'padlet_evidence_claims') {
    targetId = deterministicId(manifest.tenantId, manifest.migrationJobId, table, targetId);
  } else if (table === 'padlet_claim_digest_tombstones') {
    targetId = deterministicId('global', table, targetId);
  }
  const sourceTable = table === 'transaction_items' ? 'transactions' : table;
  const mappings = manifest.mappings.filter((m) => m.targetTable === table && m.targetId === targetId);
  if (!mappings.length) refused();
  const contributors = mappings.flatMap((mapping) => {
    const sources = manifest.sourceRecords.filter((record) => record.mappingStatus === 'STAGED'
      && record.targetTable === sourceTable
      && (record.source.kind === 'SHEET' ? record.source.rowHash : record.source.sourceDigest) === mapping.sourceDigest);
    if (!sources.length) refused();
    return sources.map(({ source }) => source.kind === 'SHEET'
      ? { kind: source.kind, tab: source.tab, rowNumber: source.rowNumber, rowHash: source.rowHash }
      : { kind: source.kind, provenance: source.provenance, sourceDigest: source.sourceDigest });
  });
  // Whole-acquisition digests change on unrelated appends/revisions; they remain
  // in immutable envelopes, but are not retained-contributor identity. Compare
  // exact sorted multisets (including multiplicity), never deduplicated sets.
  return canonicalJson(contributors.map(canonicalJson).sort());
}
function envelopeId(kind: string, details: unknown) {
  return `preparation:${kind.toLowerCase()}:${sha256(canonicalJson(details))}`;
}
async function append(tx: TenantTransaction, tenantId: string, jobId: string, kind: string,
  id: string, details: Record<string, unknown>) {
  const expected = { job_id: jobId, event_type: `MIGRATION_PREPARATION_${kind}`, operation_id: null,
    actor_user_id: null, entity_type: null, entity_id: null, redacted_details: details };
  await tx.execute(sql`INSERT INTO audit_events
    (tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details)
    VALUES (${tenantId},${id},${jobId},${expected.event_type},NULL,NULL,NULL,NULL,${JSON.stringify(details)}::jsonb)
    ON CONFLICT (tenant_id,event_id) DO NOTHING`);
  const { rows } = await tx.execute(sql`SELECT job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details
    FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${id}`);
  if (rows.length !== 1 || canonicalJson(rows[0]) !== canonicalJson(expected)) refused();
}
function refused(): never { throw new Error('Final generation preparation refused.'); }
