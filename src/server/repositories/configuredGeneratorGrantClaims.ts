import 'server-only';

import { getDatabaseClient } from '@/server/db/client';
import { createGeneratorGrantClaimer, type GeneratorGrantClaim } from './database/generatorGrantClaims';

export async function claimGeneratorGrant(grant: GeneratorGrantClaim): Promise<boolean> {
  return createGeneratorGrantClaimer(getDatabaseClient().pool)(grant);
}
