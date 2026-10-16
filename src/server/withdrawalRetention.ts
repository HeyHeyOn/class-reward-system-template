import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { getDatabaseClient } from '@/server/db/client';

type Env = Readonly<Record<string, string | undefined>>;
type Queryable = Readonly<{ query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }>;

export type RetentionResult = Readonly<{ records: number; classes: number; accounts: number; identities: number }>;

/** Vercel cron calls carry `Authorization: Bearer <CRON_SECRET>`. Off until CRON_SECRET is set. */
export function cronSecretConfigured(env: Env = process.env): boolean {
  return (env.CRON_SECRET?.trim().length ?? 0) >= 16;
}

export function isCronRequest(request: Request, env: Env = process.env): boolean {
  const secret = env.CRON_SECRET?.trim();
  const header = request.headers.get('authorization');
  if (!secret || secret.length < 16 || !header?.startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret));
}

/** 0059: erase withdrawal records a year old, with the shells and identifier hashes they left. */
export async function expireWithdrawalRecords(db: Queryable = getDatabaseClient().pool): Promise<RetentionResult> {
  const { rows } = await db.query('SELECT public.platform_expire_withdrawal_records() AS result');
  const result = (rows[0] as { result?: Partial<Record<keyof RetentionResult, unknown>> } | undefined)?.result;
  const number = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
  return { records: number(result?.records), classes: number(result?.classes), accounts: number(result?.accounts), identities: number(result?.identities) };
}
