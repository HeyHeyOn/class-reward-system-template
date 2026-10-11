import { parsePadletKeyRequest } from '@/lib/padletLinkApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredPadlet } from '@/server/repositories/configuredPadlet';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Saves (sealed) or removes the class's Padlet API key. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parsePadletKeyRequest(body.value);
    const padlet = await createConfiguredPadlet(request);
    return taskLedgerJson(await padlet.setKey(input.apiKey));
  } catch (error) {
    return taskLedgerFailure(error, 'padlet-key');
  }
}
