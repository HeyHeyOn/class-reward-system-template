import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { getTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { getProductionFreezingConsentHandlers } from '@/server/migration/freezingConsentProduction';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  try {
    getTrustedTenantRequestContext();
    if (!await getTeacherGoogleSessionFromRequest(request)) throw new Error('Authentication required');
    return await getProductionFreezingConsentHandlers().begin(request, context); }
  catch { return Response.json({ error: 'Freezing consent refused.' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
