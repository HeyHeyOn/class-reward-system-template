import { readBoundedRequestText, RequestBodyError } from '@/server/boundedRequestBody';
import { HUB_SIGNATURE_HEADER, hubConnected, parseSummaryRequest, verifyHubSignature } from '@/server/ddanssaem/hub';
import { hubSummary } from '@/server/ddanssaem/hubAccounts';
import { getProductionClassDashboardRepository } from '@/server/repositories/database/classDashboard';
import { teacherAccountsEnabled } from '@/server/teacherAccounts';
import { logFailure } from '@/server/log';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** 4: the teacher's classes for the hub's '내 학급' and its withdrawal screen (signed by the hub). */
export async function POST(request: Request) {
  if (!hubConnected() || !teacherAccountsEnabled()) return json({ error: 'Not found' }, 404);
  let body: string;
  try {
    body = await readBoundedRequestText(request, 4_096);
  } catch (error) {
    return json({ error: 'invalid_request' }, error instanceof RequestBodyError ? error.status : 400);
  }
  if (!verifyHubSignature(body, request.headers.get(HUB_SIGNATURE_HEADER))) return json({ error: 'invalid_signature' }, 401);
  const asked = parseSummaryRequest(body);
  if (!asked) return json({ error: 'invalid_request' }, 400);
  try {
    const memberships = await getProductionClassDashboardRepository().listByGoogleSubject(asked.sub);
    return json(hubSummary(memberships, new URL(request.url).origin));
  } catch (error) {
    logFailure('[ddanssaem] summary failed', error);
    return json({ error: 'unavailable' }, 503);
  }
}
