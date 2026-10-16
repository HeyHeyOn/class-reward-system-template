import 'server-only';

import { currentLegalRevision } from '@/lib/legalDocuments';
import { HUB_AGREEMENT, hubLoginEnabled } from '@/server/ddanssaem/hub';

/** The agreement a teacher session must carry: the class's terms in force, or, when teachers sign in
 *  through the 딴쌤 hub (DDANSSAEM_LOGIN=1), a hub agreement (the hub asked for its terms in force). */
export function requiredAgreementVersion(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return hubLoginEnabled(env) ? HUB_AGREEMENT : currentLegalRevision().version;
}
