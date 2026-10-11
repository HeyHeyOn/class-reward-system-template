import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { hasExactKeys, petAdminRequired, petFailure, petJson, readPetJson } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';

export const dynamic = 'force-dynamic';

/** The teacher adds growth to a student's pet or takes some away (`amount` below 0). */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return petAdminRequired();
  const body = await readPetJson(request);
  if (body instanceof Response) return body;
  if (!hasExactKeys(body.value, ['operationId', 'petId', 'amount'])) return petJson({ error: '요청 형식이 올바르지 않아요.', code: 'INVALID_REQUEST' }, 400);
  try {
    const pets = await createConfiguredPets(request);
    return petJson(await pets.adjustGrowth({ operationId: body.value.operationId, petId: body.value.petId, amount: body.value.amount }));
  } catch (error) {
    return petFailure(error, 'adjust-growth');
  }
}
