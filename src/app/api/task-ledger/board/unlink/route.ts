import { parseBoardUnlinkRequest } from '@/lib/boardLinkApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { boardLinkError } from '@/server/ddanssaem/boardClient';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { requestBoardLinks } from '@/server/repositories/configuredBoardLinks';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** The tasks stop counting the board's posts; what already counted stays. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseBoardUnlinkRequest(body.value);
    const links = requestBoardLinks();
    if (!links) throw boardLinkError('NOT_CONFIGURED');
    return taskLedgerJson(await links.service.unlink(input.taskIds));
  } catch (error) {
    return taskLedgerFailure(error, 'board-unlink');
  }
}
