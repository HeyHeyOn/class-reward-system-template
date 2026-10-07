import { parseId } from '@/lib/taskLedgerApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Every stage change of one task, newest first, with student names. */
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  try {
    const taskId = parseId((await context.params).taskId, '과제 번호');
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson(await ledger.history(taskId));
  } catch (error) {
    return taskLedgerFailure(error, 'history');
  }
}
