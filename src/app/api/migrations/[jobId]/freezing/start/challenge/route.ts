import { getProductionStartFreezingHandlers } from '@/server/migration/startFreezingProduction';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<Record<string, string>> }) {
  try { return await getProductionStartFreezingHandlers().challenge(request, context); }
  catch { return Response.json({ error: 'Freezing consent refused.' }, { status: 403,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } }); }
}
