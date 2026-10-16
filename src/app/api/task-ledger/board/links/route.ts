import { parseBoardLinkRequest } from '@/lib/boardLinkApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { boardLinkError } from '@/server/ddanssaem/boardClient';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { requestBoardLinks } from '@/server/repositories/configuredBoardLinks';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Links the tasks to a 딴쌤 board (optionally one group); a roster linked nowhere is linked to this class first. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseBoardLinkRequest(body.value);
    const links = requestBoardLinks();
    if (!links || !links.sub) throw boardLinkError('NOT_CONFIGURED');
    return taskLedgerJson(await links.service.link(links.sub, input));
  } catch (error) {
    return taskLedgerFailure(error, 'board-links');
  }
}
