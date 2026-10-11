import { parsePadletPreviewRequest } from '@/lib/padletLinkApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredPadlet } from '@/server/repositories/configuredPadlet';
import { taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Reads a board by its address (title and sections) so the teacher can check it before linking. */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  try {
    const input = parsePadletPreviewRequest({ address: new URL(request.url).searchParams.get('address') ?? '' });
    const padlet = await createConfiguredPadlet(request);
    return taskLedgerJson(await padlet.previewBoard(input.address));
  } catch (error) {
    return taskLedgerFailure(error, 'padlet-preview');
  }
}
