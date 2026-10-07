import { parseDeleteTasksRequest } from '@/lib/taskLedgerApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Deletes tasks; already-deleted ones are simply skipped. Paid rewards stay. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseDeleteTasksRequest(body.value);
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson(await ledger.deleteTasks(input));
  } catch (error) {
    return taskLedgerFailure(error, 'delete');
  }
}
