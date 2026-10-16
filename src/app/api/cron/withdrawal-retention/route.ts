import { teacherAccountsEnabled } from '@/server/teacherAccounts';
import { cronSecretConfigured, expireWithdrawalRecords, isCronRequest } from '@/server/withdrawalRetention';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Once a day (vercel.json crons): withdrawal records are kept for one year, then erased (0059). */
export async function GET(request: Request) {
  if (!teacherAccountsEnabled()) return json({ error: 'Not found' }, 404);
  if (!cronSecretConfigured()) return json({ error: 'not_configured' }, 503);
  if (!isCronRequest(request)) return json({ error: 'unauthorized' }, 401);
  try {
    const result = await expireWithdrawalRecords();
    console.info('[retention] withdrawal records erased', JSON.stringify(result));
    return json({ ok: true, ...result });
  } catch (error) {
    console.error('[retention] withdrawal records could not be erased', error instanceof Error ? error.message : 'unknown');
    return json({ error: 'unavailable' }, 503);
  }
}
