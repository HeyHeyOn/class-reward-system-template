import 'server-only';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { canonicalJson } from '@/server/migration/validators';
import { coldWorkerBlocker } from './coldProcessWitness';
import { coldInventoryMatches, withColdRecovery, type ColdAnchor, type ColdRecoveryResult } from './coldRestoreStore';
import { ColdOwnedBlocker, coldOrphanEmpty, disposeEmptyColdOrphan, disposeUnstartedColdAllocation, readColdOrphan } from './ownedPgArchive';

// An incomplete persisted object is an unproved claim, not a reason to skip
// the durable blocker by throwing out of the coordinator's admission path.
function sameEvidence(left:unknown,right:unknown):boolean {
  try { return canonicalJson(left)===canonicalJson(right); } catch { return false; }
}

/** Restarted, nonproduction coordinator. No endpoint/DB handle/PID/expiry claim
 * is accepted as authority; all target and death evidence comes from the pinned
 * trusted launcher store. Never resumes or adopts an old database. */
export async function recoverColdDatabase(anchor:ColdAnchor,binding:LocalCandidateBinding):Promise<ColdRecoveryResult> {
  return withColdRecovery(anchor,binding,async context => {
    const {attempt,leaseSha256,inventory,exit,state,previous}=context;
    if (!attempt || !leaseSha256) return context.block('LEGACY_OR_DAMAGED_LEASE');
    const processBlocker=await coldWorkerBlocker(attempt.worker);
    if (processBlocker) return context.block(processBlocker);
    if (!exit || exit.version!==1 || exit.attemptId!==attempt.attemptId || exit.leaseSha256!==leaseSha256 || exit.signal!=='SIGKILL' || exit.code!==null
      || !sameEvidence(exit.worker,attempt.worker) || !sameEvidence(exit.anchor,context.anchor)) return context.block('EXIT_UNPROVEN');
    if (previous) {
      if (sameEvidence(state.lastAttempt?.recovery,previous)
        && ((previous.status==='DISPOSED_EMPTY' && state.status==='READY') || (previous.status==='QUARANTINED' && state.status==='QUARANTINED'))) return previous;
      return context.block('RECOVERY_PUBLICATION_INCOMPLETE');
    }
    if (state.status!=='IN_FLIGHT') return context.block('NOT_IN_FLIGHT');
    if (!await context.leaseIntact()) return context.block('LEASE_LOCK_UNPROVEN');
    const quarantine=(blocker:string,readback?:unknown) => context.finish({status:'QUARANTINED',blocker,...(readback ? {readback} : {})});
    if (!inventory || !coldInventoryMatches(inventory,attempt,leaseSha256)) return quarantine('INVENTORY_MISMATCH');
    try {
      // Names/labels can locate a candidate but cannot fill a missing exact pin.
      // STARTING includes the external command-in-flight window; never rewind it
      // to CREATED based on a currently stopped/empty-looking container.
      if (inventory.phase==='PLANNED') return quarantine('ALLOCATION_ID_UNPROVEN');
      if (inventory.phase==='STARTING') return quarantine('CONTROL_PIN_INCOMPLETE');
      if (inventory.phase==='CREATED') {
        const blocker=await coldWorkerBlocker(attempt.worker);
        if (blocker) return context.block(blocker);
        if (!await context.leaseIntact()) return context.block('LEASE_LOCK_UNPROVEN');
        const {readback,cleanup}=await disposeUnstartedColdAllocation(inventory);
        return context.finish({status:'DISPOSED_EMPTY',readback,cleanup});
      }
      const readback=await readColdOrphan(inventory);
      const control=[{singleton:true,database_id:inventory.runId,owner_id:attempt.ownerId,tenant_id:binding.tenantId,job_id:binding.migrationJobId,
        system_identifier:inventory.systemIdentifier,state:'EMPTY_LEASE'}];
      if (!sameEvidence(readback.control,control) || !sameEvidence(readback.control,inventory.control)
        || !sameEvidence(readback.controlGuards,inventory.controlGuards)) return quarantine('CONTROL_MISMATCH',readback);
      if (readback.sessions.length) return quarantine('SQL_STILL_ACTIVE',readback);
      if (inventory.phase==='DISPATCHED') return quarantine('SQL_OUTCOME_UNCERTAIN',readback);
      if (!coldOrphanEmpty(inventory,readback)) return quarantine('EMPTY_TARGET_UNPROVEN',readback);
      // Recheck process absence under the recovery gate immediately before
      // disposal; the lower layer independently repeats identity and empty SQL.
      const blocker=await coldWorkerBlocker(attempt.worker);
      if (blocker) return context.block(blocker);
      if (!await context.leaseIntact()) return context.block('LEASE_LOCK_UNPROVEN');
      const cleanup=await disposeEmptyColdOrphan(inventory);
      return context.finish({status:'DISPOSED_EMPTY',readback,cleanup});
    } catch (error) {
      return quarantine(error instanceof ColdOwnedBlocker ? error.blocker : 'DESTINATION_UNREADABLE');
    }
  });
}
