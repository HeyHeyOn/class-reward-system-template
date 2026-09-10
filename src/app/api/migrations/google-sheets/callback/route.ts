import { getProductionFreezingConsentHandlers } from '@/server/migration/freezingConsentProduction';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const consent = getProductionFreezingConsentHandlers();
    let ordinary = false;
    try { consent.readRoutingHint(request); ordinary = true; } catch { /* Try only the separately authenticated start purpose. */ }
    if (ordinary) return await consent.callback(request);
    const { getProductionStartFreezingCallbackHandlers } = await import('@/server/migration/startFreezingProduction');
    return await getProductionStartFreezingCallbackHandlers(request).callback(request);
  }
  catch { return Response.json({ error: 'Freezing consent refused.' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
