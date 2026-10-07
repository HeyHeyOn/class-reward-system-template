import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import { stageLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';
import { canonicalJson, sha256 } from './validators';

/** Local-only exact-noop branch. The retained captures are untrusted: this neither
 * establishes source-writer exclusion nor advances FINAL_IMPORT/ACTIVE. No caller
 * may treat its report as an approval or proof of fresh external acquisition. */
export async function reconcileLocalNoopFinalDelta(input: FinalGenerationPreparationInput,
  options: { runTransaction?: TenantImportTransactionRunner } = {}) {
  try {
    // Never read the caller's potentially mutable job binding after an await.
    const jobId = input.migrationJobId;
    const run = options.runTransaction ?? withTenantTransaction;
    let reportEventId: string | undefined;
    const staged = await stageLegacyFinalGeneration(input, { runTransaction: (tenantId, callback) =>
      run(tenantId, async (tx) => {
        const prepared = await callback(tx);
        if (!prepared || typeof prepared !== 'object' || !('plan' in prepared)
          || !('originalGenerationId' in prepared) || !('candidateGenerationId' in prepared)
          || !('planId' in prepared)) throw new Error('preparation');
        const result = prepared as unknown as Awaited<ReturnType<typeof stageLegacyFinalGeneration>>;
        if (result.plan.status !== 'DIFF_VALIDATED' || result.plan.changes.length !== 0
          || result.plan.blockers.length !== 0) throw new Error('delta');
        // Query immutable envelopes in the SAME transaction that staged them. This
        // compares the complete retained acquisitions, not just mapped target rows.
        const { rows } = await tx.execute(sql`SELECT event_id,redacted_details FROM audit_events
          WHERE tenant_id=${tenantId} AND job_id=${jobId}
          AND event_id IN (${result.originalGenerationId},${result.candidateGenerationId})`);
        if (rows.length !== 2) throw new Error('envelopes');
        const original = rows.find((row) => row.event_id === result.originalGenerationId)?.redacted_details;
        const candidate = rows.find((row) => row.event_id === result.candidateGenerationId)?.redacted_details;
        if (!original || !candidate || typeof original !== 'object' || typeof candidate !== 'object'
          || !('acquisition' in original) || !('acquisition' in candidate)
          || canonicalJson(original.acquisition) !== canonicalJson(candidate.acquisition)) throw new Error('capture');
        const details = { storage: 'UNTRUSTED_PREPARATION', finding: 'IDENTICAL_CAPTURE',
          originalGenerationId: result.originalGenerationId, candidateGenerationId: result.candidateGenerationId,
          planId: result.planId, authority: 'NONAUTHORITY' };
        const eventId = `local-noop:${sha256(canonicalJson([tenantId, jobId, details]))}`;
        await tx.execute(sql`INSERT INTO audit_events
          (tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details)
          VALUES (${tenantId},${eventId},${jobId},'MIGRATION_LOCAL_NOOP_RECONCILED',NULL,NULL,NULL,NULL,${JSON.stringify(details)}::jsonb)
          ON CONFLICT (tenant_id,event_id) DO NOTHING`);
        const { rows: verified } = await tx.execute(sql`SELECT job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details
          FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${eventId}`);
        if (verified.length !== 1 || canonicalJson(verified[0]) !== canonicalJson({
          job_id: jobId, event_type: 'MIGRATION_LOCAL_NOOP_RECONCILED', operation_id: null,
          actor_user_id: null, entity_type: null, entity_id: null, redacted_details: details,
        })) throw new Error('report');
        reportEventId = eventId;
        return prepared;
      }),
    });
    if (!reportEventId) throw new Error('report missing');
    return { authority: 'NONAUTHORITY' as const, finding: 'IDENTICAL_CAPTURE' as const,
      reportEventId, originalGenerationId: staged.originalGenerationId,
      candidateGenerationId: staged.candidateGenerationId, planId: staged.planId };
  } catch {
    throw new Error('Local no-op reconciliation refused.');
  }
}
