import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { readClassTreeJson } from '@/server/classTreeHttp';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentBag } from '@/server/repositories/configuredStudentBag';
import { studentBagAdminRequired, studentBagFailure, studentBagJson } from '@/server/studentBagHttp';

export const dynamic = 'force-dynamic';

/** The teacher marks a bag item used, or takes the mark back. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return studentBagAdminRequired();
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  const { itemId, used } = body.value;
  if (typeof itemId !== 'string' || typeof used !== 'boolean') {
    return studentBagJson({ error: '아이템을 다시 골라 주세요.', code: 'INVALID_INPUT' }, 400);
  }
  try {
    const bag = await createConfiguredStudentBag(request);
    return studentBagJson({ item: await bag.setItemUsed({ itemId, used }) });
  } catch (error) {
    return studentBagFailure(error, 'item-use');
  }
}
