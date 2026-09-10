import { getProductionFreezingReacquisitionHandlers } from '@/server/migration/freezingReacquisitionCentralProduction';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<Record<string, string>> }) {
  try {
    const { jobId } = await context.params;
    return await getProductionFreezingReacquisitionHandlers(jobId).challenge(request);
  } catch { return Response.json({ status: 'REFUSED' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
