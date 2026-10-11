import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { syncPadletBoardsIfStale } from '@/server/repositories/configuredPadlet';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Every live task with each student's current stage (미부여 / 미완료 / 완료 가능 / 완료). */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  try {
    // Posts written on linked Padlet boards since the last look count before the board is read.
    if (legacyWriteFreezeResponse() === null) await syncPadletBoardsIfStale(request);
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson(await ledger.board());
  } catch (error) {
    return taskLedgerFailure(error, 'board');
  }
}
