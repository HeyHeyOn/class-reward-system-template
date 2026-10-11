import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { getTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { getProductionStartFreezingStatus } from '@/server/migration/startFreezingProduction';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<Record<string, string>> }) {
  try {
    getTrustedTenantRequestContext();
    if (!await getTeacherGoogleSessionFromRequest(request)) throw new Error('Authentication required');
    return await getProductionStartFreezingStatus()(request, context); }
  catch { return Response.json({ error: 'Freezing consent refused.' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
