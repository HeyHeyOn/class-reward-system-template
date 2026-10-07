import { parseCreateTaskRequest } from '@/lib/taskLedgerApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Creates a task (the server picks its ID), optionally giving it to students right away. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseCreateTaskRequest(body.value);
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson({ task: await ledger.createTask(input) });
  } catch (error) {
    return taskLedgerFailure(error, 'create');
  }
}
