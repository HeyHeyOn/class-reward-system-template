import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { readClassTreeJson } from '@/server/classTreeHttp';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentBag } from '@/server/repositories/configuredStudentBag';
import { studentBagAdminRequired, studentBagFailure, studentBagJson } from '@/server/studentBagHttp';

export const dynamic = 'force-dynamic';

/**
 * The teacher puts a store product into the 보관함 of one or more students (a physical product as its
 * 교환권; retry-safe by operation ID). For one student the refreshed storage comes back with it.
 */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return studentBagAdminRequired();
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  const { studentIds, productId, count, operationId } = body.value;
  try {
    const bag = await createConfiguredStudentBag(request);
    const given = await bag.giveItems({ studentIds, productId, count, operationId });
    const only = Array.isArray(studentIds) && new Set(studentIds).size === 1 ? studentIds[0] as string : null;
    return studentBagJson({ given, ...(only ? { bag: await bag.studentBag(only, { includeUsed: true }) } : {}) });
  } catch (error) {
    return studentBagFailure(error, 'item-give');
  }
}
