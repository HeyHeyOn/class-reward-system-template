import 'server-only';

import { createDisposablePostgres, type DisposablePostgres } from './disposablePostgres';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { acquireColdArchive, bindColdTarget, coldAllocationRegistration, coldRefused, readColdLease, settleColdArchive, type ColdAnchor, type ColdPolicy } from './coldRestoreStore';
import { allocateRestoreTarget, allocateOriginalRestoreTarget, backupMaterializedDatabase, readRestoredMaterializedDatabase,
  restoreRetainedMaterializedDatabase, retainMaterializedBackup, verifyRestoreRollback } from './materializedRestore';
export { disposeColdArchive } from './coldRestoreStore';
export { recoverColdDatabase } from './coldOrphanRecovery';
export type { ColdAnchor, ColdPolicy } from './coldRestoreStore';

export async function retainColdDatabase(source: DisposablePostgres, owner: string, binding: LocalCandidateBinding, policy: ColdPolicy): Promise<ColdAnchor> {
  return retainMaterializedBackup(await backupMaterializedDatabase(source,owner,binding),policy);
}

/** Restarted coordinator: accepts no connection URL or caller target. */
export async function restoreColdDatabase(anchor: ColdAnchor, binding: LocalCandidateBinding) {
  const lease=await acquireColdArchive(anchor,binding);
  let db: DisposablePostgres | undefined, target: Awaited<ReturnType<typeof allocateRestoreTarget>> | undefined;
  try {
    const {ownerId,registration}=coldAllocationRegistration(lease);
    db=await createDisposablePostgres(registration);
    const seal=readColdLease(lease).seal;
    target=await (seal.original ? allocateOriginalRestoreTarget : allocateRestoreTarget)(db,ownerId,seal.binding);
    await bindColdTarget(lease,db);
    const result=await restoreRetainedMaterializedDatabase(lease,target);
    const readback={...await readRestoredMaterializedDatabase(db),...(seal.original ? {originalRestorations:
      (await db.owner.query('SELECT receipt FROM local_restore_control.original_restorations')).rows.map(r => r.receipt)} : {})};
    await settleColdArchive(lease,'SUCCEEDED',{pid:process.pid,targetId:db.runId,containerId:db.evidence.containerId,rollbackVerified:false});
    const cleanup=await db.close();
    return {result,readback,ownerId,databaseId:db.runId,containerId:db.evidence.containerId,pid:process.pid,cleanup};
  } catch (error) {
    const rollbackConfirmed=target ? await verifyRestoreRollback(target) : false;
    const attempt={pid:process.pid,targetId:db?.runId,containerId:db?.evidence.containerId,rollbackVerified:rollbackConfirmed,
      error:error instanceof Error ? error.message : String(error)};
    await settleColdArchive(lease,rollbackConfirmed ? 'READY' : 'QUARANTINED',attempt);
    console.info('COLD_RESTORE_ATTEMPT',JSON.stringify(attempt));
    coldRefused();
  } finally {
    if (db) console.info('COLD_CLEANUP',JSON.stringify(await db.close()));
  }
}
