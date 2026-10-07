import 'server-only';
import { types } from 'node:util';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import { stageLegacyFinalGeneration, inspectLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';
import { verifyLocalCapturedSourceCoverage } from './localCapturedSourceCoverage';
import { assertNormalizationInput, canonicalJson, clonePlainData, isHexDigest, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Stage = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
type Binding = Pick<FinalGenerationPreparationInput, 'tenantId' | 'migrationJobId' | 'expectedStateVersion'
  | 'originalSnapshotId' | 'originalSourceId' | 'exclusionGenerationReference'>;
type Reports = ReturnType<typeof inspectLocalPointerPreparationEnvelopes>;
const CONTEXT_KEYS = ['tenantId', 'migrationJobId', 'expectedStateVersion', 'originalSnapshotId', 'originalSourceId', 'exclusionGenerationReference'];
const BINDING_KEYS = ['tenantId', 'migrationJobId', 'expectedStatus', 'expectedStateVersion',
  'originalSnapshotId', 'originalSourceId', 'originalManifestDigest', 'originalSourceFingerprint'];
const ROW_KEYS = ['tenant_id', 'event_id', 'job_id', 'event_type', 'operation_id', 'actor_user_id', 'entity_type', 'entity_id', 'redacted_details'];
const ORIGINAL_KEYS = ['storage', 'phase', 'tenantId', 'migrationJobId', 'originalSnapshotId', 'originalSourceId', 'acquisition', 'manifest'];
const CANDIDATE_KEYS = ['storage', 'phase', 'binding', 'originalGenerationId', 'exclusionGenerationReference', 'acquisition', 'manifest'];
const PLAN_KEYS = ['storage', 'phase', 'binding', 'originalGenerationId', 'candidateGenerationId', 'exclusionGenerationReference',
  'originalManifestDigest', 'candidateManifestDigest', 'status', 'changes', 'blockers'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Opt-in LOCAL preparation, not an ingress, source-completeness or freeze gate.
 * The runner is mandatory: no default production connection. It is trusted to
 * await this callback and commit only after it returns. That contract cannot be
 * certified by accepting a function. No inspector/checker/report injection.
 * Only the existing stage's three audit envelopes are written. Rejection inside
 * the callback rolls back this attempt; an error AFTER COMMIT cannot undo it.
 * Existing direct stage callers remain unchanged and can omit this extra gate.
 */
export async function stageLocalPointerCheckedPreparation(input: FinalGenerationPreparationInput,
  runTransaction: TenantImportTransactionRunner) {
  return prepare(input, runTransaction, false);
}

export async function inspectLocalPointerCheckedPreparation(input: FinalGenerationPreparationInput,
  runTransaction: TenantImportTransactionRunner) {
  return prepare(input, runTransaction, true);
}

async function prepare(input: FinalGenerationPreparationInput,
  runTransaction: TenantImportTransactionRunner, readOnly: boolean) {
  try {
    if (typeof runTransaction !== 'function' || types.isProxy(runTransaction)) refused();
    let checked: { prepared: Stage; reports: Reports } | undefined;
    const run: TenantImportTransactionRunner = (tenantId, callback) => {
      // The real stage has validated/snapshotted both acquisitions synchronously.
      // Freeze primitives BEFORE invoking the supplied runner or its first await.
      const { migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference } = input;
      const binding: Binding = { tenantId, migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference };
      return runTransaction(tenantId, async (tx) => {
        checked = undefined; // A transaction retry must not inherit an earlier attempt's report.
        const result = await callback(tx); // real original inspector, lock, append and readback
        const prepared = parseStage(result);
        const { rows } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,
          operation_id,actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId} AND job_id=${migrationJobId}
          AND event_id IN (${prepared.originalGenerationId},${prepared.candidateGenerationId},${prepared.planId})`);
        const reports = inspectLocalPointerPreparationEnvelopes(binding, prepared, rows);
        checked = { prepared, reports };
        return result;
      });
    };
    const preparation = await (readOnly ? inspectLegacyFinalGeneration(input, run)
      : stageLegacyFinalGeneration(input, { runTransaction: run }));
    // Never publish if the runner skipped the callback or substituted its result.
    if (!checked || preparation !== checked.prepared) refused();
    return deepFreeze({ scope: 'LOCAL_POINTER_CHECKED_PREPARATION_ONLY' as const,
      authority: 'NONAUTHORITY' as const, complete: false as const, activationAllowed: false as const,
      exclusion: 'NOT_PROVEN' as const, fullSourceReconciliation: 'NOT_PERFORMED' as const,
      fullTargetReconciliation: 'NOT_PERFORMED' as const, preRedactionInventory: 'NOT_OBSERVED' as const,
      canonicalBusinessValidation: 'NOT_PERFORMED' as const, contributorMultiplicityValidation: 'NOT_PERFORMED' as const,
      preparation: clonePlainData(preparation), reports: checked.reports });
  } catch { refused(); }
}

/** Pure DB-readback boundary, separately exercisable with COPIES of real rows.
 * A successful direct call is NOT evidence that rows were ever stored/committed.
 * The wrapper above is the only transactional composition; it accepts neither
 * these rows nor caller-produced reports. Check each capture separately so
 * exact recapture digests may differ, without weakening their own bindings.
 *
 * Strict fixed shells precede encoding; each acquisition/manifest uses the
 * unchanged checker's narrower bounds. Plans additionally use shared 4MB/300k
 * normalization admission and local 4000 changes / 128 blockers caps. This may
 * reject otherwise valid stage output. Admission follows stage SQL/readback;
 * it does NOT bound the stage's earlier normalizer, SQL or DB ingress work.
 */
export function inspectLocalPointerPreparationEnvelopes(rawBinding: unknown, rawPrepared: Stage, rawRows: unknown) {
  try {
    const binding = parseBinding(rawBinding), prepared = parseStage(rawPrepared);
    const rows = sequence(rawRows, 3);
    if (rows.length !== 3) refused();
    const byId = new Map<string, Record<string, unknown>>();
    for (const value of rows) {
      const row = object(value, ROW_KEYS);
      if (!text(row.event_id) || byId.has(row.event_id) || row.tenant_id !== binding.tenantId
        || row.job_id !== binding.migrationJobId || row.operation_id !== null || row.actor_user_id !== null
        || row.entity_type !== null || row.entity_id !== null) refused();
      byId.set(row.event_id, row);
    }
    const envelope = (id: string, kind: string, phase: string, keys: readonly string[]) => {
      const row = byId.get(id);
      if (!row || row.event_type !== `MIGRATION_PREPARATION_${kind}`) refused();
      const details = object(row.redacted_details, keys);
      if (details.storage !== 'UNTRUSTED_PREPARATION' || details.phase !== phase) refused();
      return details;
    };
    const original = envelope(prepared.originalGenerationId, 'ORIGINAL', 'ORIGINAL_PREFLIGHT', ORIGINAL_KEYS);
    const candidate = envelope(prepared.candidateGenerationId, 'CANDIDATE', 'FINAL_CANDIDATE', CANDIDATE_KEYS);
    const plan = envelope(prepared.planId, 'PLAN', 'DELTA_PLAN', PLAN_KEYS);
    const originalAcquisition = object(original.acquisition, ['sheets', 'redis']);
    const candidateAcquisition = object(candidate.acquisition, ['sheets', 'redis']);
    // Do not canonicalize either full envelope before its real bounded checker.
    const check = (acquisition: Record<string, unknown>, manifest: unknown) => verifyLocalCapturedSourceCoverage({
      capture: { tenantId: binding.tenantId, migrationJobId: binding.migrationJobId,
        sheets: acquisition.sheets, redis: acquisition.redis }, manifest,
    });
    const originalReport = check(originalAcquisition, original.manifest);
    const candidateReport = check(candidateAcquisition, candidate.manifest);
    for (const report of [originalReport, candidateReport]) {
      if (report.status !== 'CAPTURE_POINTERS_ACCOUNTED' || report.pointerAccounting !== 'ACCOUNTED'
        || report.normalizationStatus !== 'READY_FOR_IMPORT') refused();
    }
    // Both manifest/acquisition graphs have now passed shape, digest and bounds.
    const originalManifest = original.manifest as Record<string, unknown>;
    const candidateManifest = candidate.manifest as Record<string, unknown>;
    const sheets = originalAcquisition.sheets as Record<string, unknown>;
    const candidateSheets = candidateAcquisition.sheets as Record<string, unknown>;
    const expectedBinding = { ...binding, expectedStatus: 'READY', originalManifestDigest: originalReport.manifestDigest,
      originalSourceFingerprint: originalManifest.sourceFingerprint };
    // The exclusion label is NOT a member of the stage's binding object.
    const { exclusionGenerationReference, ...expected } = expectedBinding;
    for (const value of [candidate.binding, plan.binding]) {
      const actual = object(value, BINDING_KEYS);
      if (!Object.entries(expected).every(([key, value]) => actual[key] === value)) refused();
    }
    if (original.tenantId !== binding.tenantId || original.migrationJobId !== binding.migrationJobId
      || original.originalSourceId !== binding.originalSourceId || original.originalSnapshotId !== binding.originalSnapshotId
      || binding.originalSourceId !== `sheet:${originalReport.sheetsDigest}`
      || binding.originalSnapshotId !== `import:${originalReport.manifestDigest}`
      || sheets.spreadsheetId !== candidateSheets.spreadsheetId
      || originalReport.manifestDigest !== originalManifest.manifestDigest || candidateReport.manifestDigest !== candidateManifest.manifestDigest
      || candidate.originalGenerationId !== prepared.originalGenerationId || plan.originalGenerationId !== prepared.originalGenerationId
      || plan.candidateGenerationId !== prepared.candidateGenerationId
      || plan.originalManifestDigest !== originalReport.manifestDigest || plan.candidateManifestDigest !== candidateReport.manifestDigest
      || candidate.exclusionGenerationReference !== exclusionGenerationReference || plan.exclusionGenerationReference !== exclusionGenerationReference) refused();
    const archivedPlan = parsePlan({ status: plan.status, changes: plan.changes, blockers: plan.blockers });
    if (archivedPlan.status !== 'DIFF_VALIDATED' || archivedPlan.blockers.length
      || canonicalJson(archivedPlan) !== canonicalJson(prepared.plan)) refused();
    // One opaque revision cannot describe two different captured workbooks.
    // Ignore only capture time/digest here, not raw rows, order or tab metadata:
    // different observations may normalize alike and still contradict source.
    // A revision is an equality token, NEVER a sortable commit sequence.
    const content = (capture: Record<string, unknown>) => canonicalJson([
      capture.schemaVersion, capture.missingOptionalTabs, capture.tabs,
    ]);
    if (sheets.sourceRevision === candidateSheets.sourceRevision
      && content(sheets) !== content(candidateSheets)) refused();
    // Neither a mutation nor a removal may predate its before-image.
    // Both canonical instants were validated with the acquisition digests above.
    // Shared by local staging, read-only retries and cold retained provenance;
    // do not repair old envelopes or treat caller timestamps as source authority.
    // Equal instants remain valid (capture precision is not a commit sequence).
    if (archivedPlan.changes.some(change => change.kind === 'REMOVED' || change.kind === 'MUTATED')
      && Date.parse(candidateSheets.capturedAt as string) < Date.parse(sheets.capturedAt as string)) refused();
    for (const [kind, id, details] of [['original', prepared.originalGenerationId, original],
      ['candidate', prepared.candidateGenerationId, candidate], ['plan', prepared.planId, plan]] as const) {
      if (id !== `preparation:${kind}:${sha256(canonicalJson(details))}`) refused();
    }
    return deepFreeze({ original: originalReport, candidate: candidateReport });
  } catch { refused(); }
}

function parseBinding(raw: unknown): Binding {
  const value = object(raw, CONTEXT_KEYS);
  if (!CONTEXT_KEYS.every((key) => text(value[key]))) refused();
  const binding = value as Binding;
  if (!UUID.test(binding.tenantId) || !UUID.test(binding.migrationJobId)
    || !/^[1-9][0-9]{0,15}$/.test(binding.expectedStateVersion)
    || BigInt(binding.expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER)
    || !isHexDigest(binding.exclusionGenerationReference)) refused();
  return binding;
}
function parseStage(raw: unknown): Stage {
  const value = object(raw, ['storage', 'originalGenerationId', 'candidateGenerationId', 'planId', 'plan']);
  if (value.storage !== 'UNTRUSTED_PREPARATION') refused();
  for (const [key, kind] of [['originalGenerationId', 'original'], ['candidateGenerationId', 'candidate'], ['planId', 'plan']]) {
    const id = value[key];
    if (!text(id) || !id.startsWith(`preparation:${kind}:`) || !isHexDigest(id.slice(`preparation:${kind}:`.length))) refused();
  }
  parsePlan(value.plan);
  return value as Stage;
}
function parsePlan(raw: unknown): Stage['plan'] {
  const value = object(raw, ['status', 'changes', 'blockers']);
  if (value.status !== 'DIFF_VALIDATED' && value.status !== 'BLOCKED') refused();
  for (const blocker of sequence(value.blockers, 128)) if (typeof blocker !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(blocker)) refused();
  for (const row of sequence(value.changes, 4_000)) {
    const change = object(row, ['table', 'identity', 'kind', 'beforeDigest', 'afterDigest']);
    if (!text(change.table, 64) || !/^[a-z_]+$/.test(change.table) || !text(change.identity, 8_192)
      || !['ADDED', 'REMOVED', 'MUTATED'].includes(change.kind as string)
      || (change.beforeDigest !== null && !isHexDigest(change.beforeDigest))
      || (change.afterDigest !== null && !isHexDigest(change.afterDigest))) refused();
  }
  assertNormalizationInput(value);
  return value as Stage['plan'];
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) refused();
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(value).length !== keys.length) refused();
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) refused();
  }
  return value as Record<string, unknown>;
}
function sequence(value: unknown, max: number): unknown[] {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) refused();
  if (Reflect.ownKeys(value).length !== value.length + 1) refused();
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !('value' in d)) refused();
  }
  return value;
}
function text(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
}
function refused(): never { throw new Error('Local pointer-checked preparation refused.'); }
