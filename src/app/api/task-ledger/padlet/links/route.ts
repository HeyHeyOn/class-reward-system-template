import { parsePadletLinkRequest } from '@/lib/padletLinkApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredPadlet } from '@/server/repositories/configuredPadlet';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Links the tasks to a board (optionally one section); posts already there count at once. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parsePadletLinkRequest(body.value);
    const padlet = await createConfiguredPadlet(request);
    return taskLedgerJson(await padlet.link(input));
  } catch (error) {
    return taskLedgerFailure(error, 'padlet-links');
  }
}
