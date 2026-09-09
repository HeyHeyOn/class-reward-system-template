import { getProductionFreezingConsentHandlers } from '@/server/migration/freezingConsentProduction';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try { return await getProductionFreezingConsentHandlers().callback(request); }
  catch { return Response.json({ error: 'Freezing consent refused.' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
