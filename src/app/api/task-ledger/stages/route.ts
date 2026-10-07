import { parseSetStagesRequest } from '@/lib/taskLedgerApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Puts students at the given stages; students already there are left as they are. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseSetStagesRequest(body.value);
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson(await ledger.setStages(input));
  } catch (error) {
    return taskLedgerFailure(error, 'stages');
  }
}
