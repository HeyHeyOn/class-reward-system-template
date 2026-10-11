import 'server-only';

import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';

// The transaction object is unique to an attempt. Nothing survives a commit,
// rollback or retry, and tenant keys prevent accidental cross-class reuse.
const values = new WeakMap<TenantTransaction, Map<string, Promise<unknown>>>();

export function readGrowthTransactionValue<T>(tx: TenantTransaction, tenantId: string, key: string, read: () => Promise<T>): Promise<T> {
  let state = values.get(tx);
  if (!state) { state = new Map(); values.set(tx, state); }
  const cacheKey = `${tenantId}:${key}`;
  let result = state.get(cacheKey);
  if (!result) { result = read(); state.set(cacheKey, result); }
  return result as Promise<T>;
}

export function readGrowthCapabilities(tx: TenantTransaction, tenantId: string): Promise<{ tree: boolean; pet: boolean }> {
  return readGrowthTransactionValue(tx, tenantId, 'capabilities', async () => {
    const result = await tx.execute(sql`
      SELECT to_regclass('public.growth_settings') IS NOT NULL AS tree,
             to_regclass('public.pet_growth') IS NOT NULL AS pet`);
    const row = result.rows[0] as { tree: boolean; pet: boolean };
    return { tree: row.tree === true, pet: row.pet === true };
  });
}
