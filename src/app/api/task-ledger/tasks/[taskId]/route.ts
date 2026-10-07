import { parseId, parseUpdateTaskRequest } from '@/lib/taskLedgerApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Saves a task's name, reward, visibility, period and prerequisite (the last save wins). */
export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const taskId = parseId((await context.params).taskId, '과제 번호');
    const input = parseUpdateTaskRequest(body.value);
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson({ task: await ledger.updateTask(taskId, input) });
  } catch (error) {
    return taskLedgerFailure(error, 'update');
  }
}
