import { parseQrStageRequest } from '@/lib/taskLedgerApi';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredTaskLedger } from '@/server/repositories/configuredTaskLedger';
import { readTaskLedgerJson, taskLedgerAdminRequired, taskLedgerFailure, taskLedgerJson } from '@/server/taskLedgerHttp';

export const dynamic = 'force-dynamic';

/** Puts the scanned student at the chosen stage of one task. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return taskLedgerAdminRequired();
  const body = await readTaskLedgerJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseQrStageRequest(body.value);
    const ledger = await createConfiguredTaskLedger(request);
    return taskLedgerJson(await ledger.qrStage(input));
  } catch (error) {
    return taskLedgerFailure(error, 'qr');
  }
}
