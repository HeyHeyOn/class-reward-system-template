import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { requestBoardLinks } from '@/server/repositories/configuredBoardLinks';
import { taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** The teacher's 딴쌤 boards to link tasks to (empty and `enabled: false` when the class cannot). */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const links = requestBoardLinks();
  if (!links || !links.sub || !links.service.enabled()) return taskLedgerJson({ enabled: false, boards: [] });
  try {
    return taskLedgerJson(await links.service.status(links.sub));
  } catch (error) {
    return taskLedgerFailure(error, 'board-status');
  }
}
