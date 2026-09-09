import { getProductionBridgeProducer } from '@/server/migration/bridgeProducerProduction';

export const runtime = 'nodejs';

// Dedicated signed companion ingress, not tenant routing or ordinary login authority.
// Preserve the stream: authentication and byte/deadline limits run in the producer.
export async function POST(request: Request): Promise<Response> {
  try { return await getProductionBridgeProducer()(request); }
  catch { return Response.json({ outcome: 'REFUSED' }, { status: 403, headers: { 'cache-control': 'no-store' } }); }
}
