import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { classTreeAdminRequired, classTreeFailure, classTreeJson, readClassTreeJson } from '@/server/classTreeHttp';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredClassTree } from '@/server/repositories/configuredClassTree';

export const dynamic = 'force-dynamic';

/** Harvests the full tree: the reward goes to every active student and the next tree is planted. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return classTreeAdminRequired();
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  const { operationId, treeNo } = body.value;
  try {
    const tree = await createConfiguredClassTree(request);
    const result = await tree.harvest({ operationId: String(operationId ?? ''), treeNo: Number(treeNo) });
    return classTreeJson({ result, board: await tree.adminBoard() });
  } catch (error) {
    return classTreeFailure(error, 'harvest');
  }
}
