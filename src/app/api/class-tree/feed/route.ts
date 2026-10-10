import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { classTreeAdminRequired, classTreeFailure, classTreeJson, readClassTreeJson } from '@/server/classTreeHttp';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredClassTree } from '@/server/repositories/configuredClassTree';

export const dynamic = 'force-dynamic';

/** The teacher's classFeed: drops for the whole class. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return classTreeAdminRequired();
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  const { operationId, amount, note } = body.value;
  try {
    const tree = await createConfiguredClassTree(request);
    const result = await tree.classFeed({ operationId: String(operationId ?? ''), amount: Number(amount), note: typeof note === 'string' ? note : '' });
    return classTreeJson({ result, board: await tree.adminBoard() });
  } catch (error) {
    return classTreeFailure(error, 'classFeed');
  }
}
