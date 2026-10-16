import { readBoundedRequestText, RequestBodyError } from '@/server/boundedRequestBody';
import { HUB_SIGNATURE_HEADER, hubConnected, parseHubEvent, verifyHubSignature } from '@/server/ddanssaem/hub';
import { getProductionHubAccountStore } from '@/server/ddanssaem/hubAccounts';
import { teacherAccountsEnabled } from '@/server/teacherAccounts';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** 2-2, 3: the hub's signed events. logout ends the class sessions made from that hub session;
 *  account_deleted withdraws the teacher by the class's own rules. */
export async function POST(request: Request) {
  if (!hubConnected() || !teacherAccountsEnabled()) return json({ error: 'Not found' }, 404);
  let body: string;
  try {
    body = await readBoundedRequestText(request, 4_096);
  } catch (error) {
    return json({ error: 'invalid_request' }, error instanceof RequestBodyError ? error.status : 400);
  }
  if (!verifyHubSignature(body, request.headers.get(HUB_SIGNATURE_HEADER))) return json({ error: 'invalid_signature' }, 401);
  const event = parseHubEvent(body);
  if (!event) return json({ error: 'invalid_event' }, 400);
  try {
    const accounts = getProductionHubAccountStore();
    if (event.type === 'logout') return json({ ok: true, ended: await accounts.endSessions(event.sid) });
    return json({ ok: true, closedClasses: await accounts.accountDeleted(event.sub) });
  } catch (error) {
    console.error(`[ddanssaem] ${event.type} event failed`, error instanceof Error ? error.message : 'unknown');
    return json({ error: 'unavailable' }, 503);
  }
}
