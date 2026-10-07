import 'server-only';
import { types } from 'node:util';
import { sql } from 'drizzle-orm';
import type { FinalGenerationPreparationInput, stageLegacyFinalGeneration } from './finalGeneration';
import type { TenantImportTransactionRunner } from './importer';
import type { LegacyNormalizationManifest } from './manifest';
import { stageLocalFullDeltaCheckedPreparation, inspectLocalFullDeltaPreparationEnvelopes } from './localFullDeltaCheckedPreparation';
import { verifyLocalCapturedStudentProjection } from './localCapturedStudentProjection';
import { canonicalJson } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Stage = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
type Projection = ReturnType<typeof verifyLocalCapturedStudentProjection>;
type Inspection = ReturnType<typeof inspectLocalFullDeltaPreparationEnvelopes> & {
  studentProjection: { original: Projection; candidate: Projection };
};
type Result = Omit<Awaited<ReturnType<typeof stageLocalFullDeltaCheckedPreparation>>, 'scope'> & {
  scope: 'LOCAL_STUDENT_CHECKED_PREPARATION_ONLY'; studentProjection: Inspection['studentProjection'];
};

/** Opt-in local preparation: actual full-delta stage, then actual ORIGINAL and
 * CANDIDATE student checks on an additional SAME-TRANSACTION envelope readback,
 * before the callback can return/commit. Only the existing three audit envelopes
 * are written by the underlying stage; no candidate target import or new schema.
 * Neither caller manifests/reports nor replacement inspectors are accepted.
 *
 * The explicit runner/driver is trusted to execute this callback on one real
 * connection, await it and roll back on rejection. A function cannot certify
 * that contract. Result substitution/response loss AFTER COMMIT cannot undo it.
 * No default production connection, authority transition or writer-freeze proof.
 * Retries clear attempt-local evidence; direct pre-existing callers are unchanged.
 *
 * Local bounds are inherited from the full/pointer/student checks AFTER stage
 * normalization/SQL, not a bounded ingress/DB-response allocation guarantee.
 * Raw here means retained SANITIZED capture cells, not pre-redaction originals.
 * The initial importer does not retain those cells. A missing original capture
 * is refused by the real stage, never reconstructed from candidate/checkpoints.
 */
export async function stageLocalStudentCheckedPreparation(input: FinalGenerationPreparationInput,
  runTransaction: TenantImportTransactionRunner): Promise<Result> {
  try {
    if (typeof runTransaction !== 'function' || types.isProxy(runTransaction)) refused();
    let checked: { prepared: Stage; inspection: Inspection } | undefined;
    const result = await stageLocalFullDeltaCheckedPreparation(input, (tenantId, callback) => {
      // The real stage has already synchronously admitted/snapshotted input.
      // Capture immutable primitives BEFORE any external runner/await can mutate it.
      const { migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference } = input;
      const binding = { tenantId, migrationJobId, expectedStateVersion, originalSnapshotId, originalSourceId, exclusionGenerationReference };
      return runTransaction(tenantId, async (tx) => {
        checked = undefined;
        const raw = await callback(tx); // Actual original inspector/READY, appends, pointer/full checks.
        const prepared = raw as unknown as Stage;
        const { rows } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,
          operation_id,actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId} AND job_id=${migrationJobId}
          AND event_id IN (${prepared.originalGenerationId},${prepared.candidateGenerationId},${prepared.planId})`);
        const inspection = inspectLocalStudentPreparationEnvelopes(binding, prepared, rows);
        checked = { prepared, inspection };
        return raw;
      });
    });
    // Existing wrappers enforce the actual callback-result identity. Retain
    // bounded equality with their published clones, never an unbound receipt.
    if (!checked || canonicalJson(result.preparation) !== canonicalJson(checked.prepared)
      || canonicalJson(result.reports) !== canonicalJson(checked.inspection.reports)
      || canonicalJson(result.deltaCoverage) !== canonicalJson(checked.inspection.deltaCoverage)) refused();
    return deepFreeze({ ...result, scope: 'LOCAL_STUDENT_CHECKED_PREPARATION_ONLY' as const,
      studentProjection: checked.inspection.studentProjection });
  } catch { refused(); }
}

/** Pure readback-copy boundary, NOT storage/commit/authenticated acquisition proof.
 * Re-admit exactly three rows and all content/binding/plan/pointer/full checks
 * BEFORE extracting either acquisition. Each student's denominator comes from
 * its OWN archived acquisition, never the other side or normalized records.
 * There is no await/caller callback between admission, extraction and checks.
 */
export function inspectLocalStudentPreparationEnvelopes(binding: unknown, prepared: Stage, rawRows: unknown): Inspection {
  try {
    const full = inspectLocalFullDeltaPreparationEnvelopes(binding, prepared, rawRows);
    // Safe only after the actual full boundary admits both graphs and context.
    const { tenantId, migrationJobId } = binding as Pick<FinalGenerationPreparationInput, 'tenantId' | 'migrationJobId'>;
    const rows = rawRows as Array<{ event_id: string; redacted_details: {
      acquisition: FinalGenerationPreparationInput['original']; manifest: LegacyNormalizationManifest;
    } }>;
    const check = (id: string) => {
      const { acquisition, manifest } = rows.find((row) => row.event_id === id)!.redacted_details;
      return verifyLocalCapturedStudentProjection({
        capture: { tenantId, migrationJobId, sheets: acquisition.sheets, redis: acquisition.redis }, manifest,
      });
    };
    const original = check(prepared.originalGenerationId);
    const candidate = check(prepared.candidateGenerationId);
    return deepFreeze({ ...full, studentProjection: { original, candidate } });
  } catch { refused(); }
}

function refused(): never { throw new Error('Local student-checked preparation refused.'); }
