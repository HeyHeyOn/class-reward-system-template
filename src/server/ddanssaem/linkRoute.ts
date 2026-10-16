import 'server-only';

import { readBoundedRequestText, RequestBodyError } from '@/server/boundedRequestBody';
import { getDatabaseClient } from '@/server/db/client';
import { withTenantSnapshot } from '@/server/db/transaction';
import { getProductionClassDashboardRepository } from '@/server/repositories/database/classDashboard';
import { databaseStudentQrLookup, resolveStudentQr } from '@/server/studentQr';
import { teacherAccountsEnabled } from '@/server/teacherAccounts';
import { createLinkStore, LINK_SIGNATURE_HEADER, linksEnabled, parseLinkRequest, verifyLinkSignature, type LinkCall, type LinkRequest, type LinkStore } from './links';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export function getProductionLinkStore(): LinkStore {
  return createLinkStore({
    listMemberships: (sub) => getProductionClassDashboardRepository().listByGoogleSubject(sub),
    findTenantId: async (slug) => {
      const { rows } = await getDatabaseClient().pool.query('SELECT id FROM public.platform_find_tenant_by_slug($1)', [slug]);
      const id = (rows[0] as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' ? id : null;
    },
    runTenantSnapshot: withTenantSnapshot,
  });
}

/** The class's own card rule (the store and bank): a short code, a signed card it still accepts, or a student id. */
export async function resolveLinkCard(card: string, classId: string): Promise<string> {
  return (await resolveStudentQr(card, classId, databaseStudentQrLookup(classId))).studentId;
}

/** A signed app-links call from the 딴쌤 board: 401 for a bad signature or an old iat, 404 for another teacher's class. */
export async function answerLinkCall(request: Request, call: LinkCall,
  answer: (asked: LinkRequest) => Promise<unknown | null>): Promise<Response> {
  if (!linksEnabled() || !teacherAccountsEnabled()) return json({ error: 'Not found' }, 404);
  let body: string;
  try {
    body = await readBoundedRequestText(request, 4_096);
  } catch (error) {
    return json({ error: 'invalid_request' }, error instanceof RequestBodyError ? error.status : 400);
  }
  if (!verifyLinkSignature(body, request.headers.get(LINK_SIGNATURE_HEADER))) return json({ error: 'invalid_signature' }, 401);
  const asked = parseLinkRequest(body, call);
  if (asked === 'STALE') return json({ error: 'stale_request' }, 401);
  if (asked === 'INVALID') return json({ error: 'invalid_request' }, 400);
  try {
    const result = await answer(asked);
    return result === null ? json({ error: 'not_found' }, 404) : json(result);
  } catch (error) {
    console.error(`[ddanssaem] link ${call} failed`, error instanceof Error ? error.message : 'unknown');
    return json({ error: 'unavailable' }, 503);
  }
}
