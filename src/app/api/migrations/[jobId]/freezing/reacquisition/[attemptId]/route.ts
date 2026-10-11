import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { getTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { getProductionFreezingReacquisitionStatus } from '@/server/migration/freezingReacquisitionCentralProduction';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<Record<string, string>> }) {
  try {
    getTrustedTenantRequestContext();
    if (!await getTeacherGoogleSessionFromRequest(request)) throw new Error('Authentication required');
    const { jobId } = await context.params;
    return await getProductionFreezingReacquisitionStatus(jobId)(request);
  } catch { return Response.json({ status: 'REFUSED' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
