import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { syncPadletBoardsIfStale } from '@/server/repositories/configuredPadlet';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Every live task with each student's current stage (미부여 / 미완료 / 완료 가능 / 완료). */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  try {
    // Return stored stages promptly; a later screen refresh observes the background Padlet read.
    if (legacyWriteFreezeResponse() === null) await syncPadletBoardsIfStale(request);
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson(await ledger.board());
  } catch (error) {
    return taskLedgerFailure(error, 'board');
  }
}
