import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { hasExactKeys, petAdminRequired, petFailure, petJson, readPetJson } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';

export const dynamic = 'force-dynamic';

/** The teacher corrects a student's pet name. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return petAdminRequired();
  const body = await readPetJson(request);
  if (body instanceof Response) return body;
  if (!hasExactKeys(body.value, ['petId', 'name'])) return petJson({ error: '요청 형식이 올바르지 않아요.', code: 'INVALID_REQUEST' }, 400);
  try {
    const pets = await createConfiguredPets(request);
    return petJson(await pets.renamePet({ petId: body.value.petId, name: body.value.name }));
  } catch (error) {
    return petFailure(error, 'rename');
  }
}
