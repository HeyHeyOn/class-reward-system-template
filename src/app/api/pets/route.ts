import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { petAdminRequired, petFailure, petJson } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';

export const dynamic = 'force-dynamic';

/** The teacher's 펫 키우기 screen: settings and every student's pet. */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return petAdminRequired();
  try {
    const pets = await createConfiguredPets(request);
    return petJson(await pets.adminBoard());
  } catch (error) {
    return petFailure(error, 'board');
  }
}
