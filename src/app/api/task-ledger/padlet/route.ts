import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredPadlet } from '@/server/repositories/configuredPadlet';
import { taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** The class's Padlet key (only its last four characters), linked boards and what their recent posts did. */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  try {
    const padlet = await createConfiguredPadlet(request);
    return taskLedgerJson(await padlet.status());
  } catch (error) {
    return taskLedgerFailure(error, 'padlet-status');
  }
}
