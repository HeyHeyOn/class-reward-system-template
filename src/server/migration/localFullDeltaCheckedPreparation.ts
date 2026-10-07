import 'server-only';
import { types } from 'node:util';
import { sql } from 'drizzle-orm';
import type { FinalGenerationPreparationInput, stageLegacyFinalGeneration } from './finalGeneration';
import type { TenantImportTransactionRunner } from './importer';
import type { LegacyNormalizationManifest } from './manifest';
import { inspectLocalPointerPreparationEnvelopes, stageLocalPointerCheckedPreparation } from './localPointerCheckedPreparation';
import { verifyLocalFullCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';
import { canonicalJson } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Stage = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
type Inspection = ReturnType<typeof inspectLocalFullDeltaPreparationEnvelopes>;

/** Opt-in local ADDED-only gate, NEVER an authority/cutover capability.
 * Composes the unchanged pointer wrapper (hence real stage, original inspector,
 * READY/version lock, three content-addressed appends and pointer accounting).
 * The extra read and checks run in THAT callback/transaction, before commit.
 * Neither manifests, reports nor checker/inspector replacements are accepted.
 *
 * A caller-supplied runner is mandatory; there is no default DB connection. As
 * with the pointer wrapper, the runner/driver must await and faithfully return
 * the callback and roll back on rejection. A function cannot certify this trust
 * contract. Response loss after a successful commit is NOT rollback evidence.
 * Retries clear attempt-local evidence. Existing direct stage/pointer callers
 * are unchanged and do not automatically acquire this stricter gate.
 *
 * Bounds remain the existing pointer boundary's and delta helper's local bounds,
 * applied AFTER stage SQL/normalization. This is not a bounded ingress decoder.
 * The full helper requires exact retained normalized bytes: even a legitimate
 * claim recapture provenance change exempted by the stage can be refused here.
 * No digest rewriting, date coercion, provenance exemption or guard weakening.
 */
export async function stageLocalFullDeltaCheckedPreparation(input: FinalGenerationPreparationInput,
  runTransaction: TenantImportTransactionRunner) {
  try {
    if (typeof runTransaction !== 'function' || types.isProxy(runTransaction)) refused();
    let checked: { prepared: Stage; inspection: Inspection } | undefined;
    const result = await stageLocalPointerCheckedPreparation(input, (tenantId, callback) => {
      // Called synchronously by the real stage AFTER it admits/snapshots input;
      // freeze the same primitive context BEFORE any caller runner/await.
      const { migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference } = input;
      const binding = { tenantId, migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference };
      return runTransaction(tenantId, async (tx) => {
        checked = undefined;
        const raw = await callback(tx);
        // This private callback is the actual pointer wrapper's callback, not a
        // caller-supplied preparation. Its successful return already validated
        // the Stage shell, IDs, archived bindings and both pointer reports.
        const prepared = raw as unknown as Stage;
        const { rows } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,
          operation_id,actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId} AND job_id=${migrationJobId}
          AND event_id IN (${prepared.originalGenerationId},${prepared.candidateGenerationId},${prepared.planId})`);
        const inspection = inspectLocalFullDeltaPreparationEnvelopes(binding, prepared, rows);
        checked = { prepared, inspection };
        return raw;
      });
    });
    // The pointer wrapper already refuses a skipped callback/substituted result.
    // Its published preparation is a clone, so compare bounded canonical bytes.
    if (!checked || canonicalJson(result.preparation) !== canonicalJson(checked.prepared)
      || canonicalJson(result.reports) !== canonicalJson(checked.inspection.reports)) refused();
    return deepFreeze({ ...result, scope: 'LOCAL_FULL_DELTA_CHECKED_PREPARATION_ONLY' as const,
      deltaCoverage: checked.inspection.deltaCoverage });
  } catch { refused(); }
}

/** Pure readback boundary for copies/testing, NOT proof of storage or commit.
 * Admit EXACTLY three envelopes and all descriptor/shape/digest/binding/plan
 * equality checks through the unchanged pointer boundary BEFORE extracting
 * any records. Rechecking this second read is intentional, not trusting the
 * earlier read or caller-supplied Stage.plan as the full-check operand.
 * The wrapper above is the transactional entry point; this function alone must
 * never be used as an authority receipt. No asynchronous gap after admission.
 */
export function inspectLocalFullDeltaPreparationEnvelopes(binding: unknown, prepared: Stage, rawRows: unknown) {
  try {
    const reports = inspectLocalPointerPreparationEnvelopes(binding, prepared, rawRows);
    // Safe only after the real boundary has rejected proxies/accessors, checked
    // all three content addresses and admitted both manifest graphs and plan.
    const rows = rawRows as Array<{ event_id: string; redacted_details: Record<string, unknown> }>;
    const details = (id: string) => rows.find((row) => row.event_id === id)!.redacted_details;
    const original = details(prepared.originalGenerationId).manifest as LegacyNormalizationManifest;
    const candidate = details(prepared.candidateGenerationId).manifest as LegacyNormalizationManifest;
    const plan = details(prepared.planId);
    const archivedPlan = { status: plan.status, changes: plan.changes, blockers: plan.blockers } as Stage['plan'];
    const deltaCoverage = verifyLocalFullCategoryDeltaCoverage(original.records, candidate.records, archivedPlan);
    return deepFreeze({ reports, deltaCoverage });
  } catch { refused(); }
}

function refused(): never { throw new Error('Local full-delta-checked preparation refused.'); }
