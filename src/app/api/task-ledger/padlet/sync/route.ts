import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredPadlet } from '@/server/repositories/configuredPadlet';
import { taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Reads every linked board now (지금 확인). */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  try {
    const padlet = await createConfiguredPadlet(request);
    return taskLedgerJson(await padlet.syncNow());
  } catch (error) {
    return taskLedgerFailure(error, 'padlet-sync');
  }
}
