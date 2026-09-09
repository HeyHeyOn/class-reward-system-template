import { getProductionFreezingConsentHandlers } from '@/server/migration/freezingConsentProduction';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  try { return await getProductionFreezingConsentHandlers().challenge(request, context); }
  catch { return Response.json({ error: 'Freezing consent refused.' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
