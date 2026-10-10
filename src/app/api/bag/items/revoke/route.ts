import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { readClassTreeJson } from '@/server/classTreeHttp';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentBag } from '@/server/repositories/configuredStudentBag';
import { studentBagAdminRequired, studentBagFailure, studentBagJson } from '@/server/studentBagHttp';

export const dynamic = 'force-dynamic';

/** The teacher takes an unused item back out of a student's 보관함. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return studentBagAdminRequired();
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  try {
    const bag = await createConfiguredStudentBag(request);
    await bag.revokeItem({ itemId: body.value.itemId });
    return studentBagJson({ ok: true });
  } catch (error) {
    return studentBagFailure(error, 'item-revoke');
  }
}
