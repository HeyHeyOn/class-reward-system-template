import 'server-only';
import type { MaterializedArchiveExpectation } from './materializedRestore';
import { canonicalJson } from '@/server/migration/validators';
import { coldWorkerBlocker } from './coldProcessWitness';
import { coldInventoryMatches, coldRefused, withColdRecovery, type ColdAnchor } from './coldRestoreStore';
function same(left:unknown,right:unknown) {
  try {return canonicalJson(left)===canonicalJson(right);} catch {return false;}
}
/** Disposition ONLY: never recreates the in-process lease, inspects/adopts a SQL
 * target, deletes an allocation, publishes READY, or accepts a replay receipt.
 * A SQL prefix, even an exact one, cannot reconstruct lost execution authority.
 * The original launcher store + certified death are required even to quarantine.
 * An unproved death/inventory or interrupted disposition stays locked/blocked.
 */
export async function quarantineDispatchedColdExport(rawAnchor:ColdAnchor,rawBase:MaterializedArchiveExpectation,exportSha256:string) {
  const anchor=structuredClone(rawAnchor),base=structuredClone(rawBase);
  if (typeof exportSha256!=='string' || !/^[a-f0-9]{64}$/.test(exportSha256)) coldRefused();
  return withColdRecovery(anchor,base.binding,async context => {
    if (!same(context.seal,base)) coldRefused();
    const {attempt,leaseSha256,exit,state,inventory,previous}=context;
    if (!attempt || !leaseSha256) return context.block('LEGACY_OR_DAMAGED_LEASE');
    const processBlocker=await coldWorkerBlocker(attempt.worker);
    if (processBlocker) return context.block(processBlocker);
    if (!exit || exit.version!==1 || exit.attemptId!==attempt.attemptId || exit.leaseSha256!==leaseSha256
      || exit.signal!=='SIGKILL' || exit.code!==null || !same(exit.worker,attempt.worker) || !same(exit.anchor,context.anchor)) return context.block('EXIT_UNPROVEN');
    // Export provenance is diagnostic context, NOT proof that all segments ran.
    const readback={scope:'SEALED_EXPORT_CRASH_DISPOSITION_ONLY',exportSha256,accepted:false,sqlOutcome:'NOT_ADOPTED',rollbackVerified:false};
    const expected={status:'QUARANTINED' as const,blocker:'SEALED_REPLAY_RESTART_UNSUPPORTED',readback};
    if (previous) {
      if (state.status==='QUARANTINED' && same(state.lastAttempt?.recovery,previous)
        && same(previous,{...expected,attemptId:attempt.attemptId})) return previous;
      return context.block('RECOVERY_PUBLICATION_INCOMPLETE');
    }
    if (state.status!=='IN_FLIGHT') return context.block('NOT_IN_FLIGHT');
    if (!await context.leaseIntact()) return context.block('LEASE_LOCK_UNPROVEN');
    if (!inventory || !coldInventoryMatches(inventory,attempt,leaseSha256)) return context.block('INVENTORY_MISMATCH');
    if (inventory.phase!=='DISPATCHED') return context.block('SEALED_DISPATCH_UNPROVEN');
    // No target mutation or disposal and no lost-response rollback inference.
    // finish durably publishes quarantine before journal; keeps original lock.
    return context.finish(expected);
  });
}
