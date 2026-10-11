import { parsePadletUnlinkRequest } from '@/lib/padletLinkApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredPadlet } from '@/server/repositories/configuredPadlet';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Unlinks the tasks; what posts already did stays. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parsePadletUnlinkRequest(body.value);
    const padlet = await createConfiguredPadlet(request);
    return taskLedgerJson(await padlet.unlink(input.taskIds));
  } catch (error) {
    return taskLedgerFailure(error, 'padlet-unlink');
  }
}
