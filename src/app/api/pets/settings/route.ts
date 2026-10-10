import { parsePetSettings } from '@/domain/pet';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { petAdminRequired, petFailure, petJson, readPetJson } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';

export const dynamic = 'force-dynamic';

/** Saves the pet settings. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return petAdminRequired();
  const body = await readPetJson(request);
  if (body instanceof Response) return body;
  const parsed = parsePetSettings(body.value.settings);
  if (!parsed.ok) return petJson({ error: parsed.error, code: 'INVALID_INPUT' }, 400);
  try {
    const pets = await createConfiguredPets(request);
    return petJson(await pets.saveSettings(parsed.settings));
  } catch (error) {
    return petFailure(error, 'settings');
  }
}
