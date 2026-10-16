// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const query = vi.hoisted(() => vi.fn());
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => ({ pool: { query } }) }));

import { GET } from './route';

const SECRET = 'cron-secret-0123456789abcdef';
const call = (authorization?: string) => GET(new Request('https://class.example/api/cron/withdrawal-retention',
  authorization ? { headers: { authorization } } : {}));

beforeEach(() => {
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  query.mockReset();
});

describe('GET /api/cron/withdrawal-retention', () => {
  it('erases the withdrawal records that are a year old when Vercel cron calls with the secret', async () => {
    query.mockResolvedValue({ rows: [{ result: { records: 2, classes: 3, accounts: 2, identities: 1 } }] });
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, records: 2, classes: 3, accounts: 2, identities: 1 });
    expect(query).toHaveBeenCalledWith('SELECT public.platform_expire_withdrawal_records() AS result');
  });

  it('refuses any other caller and does nothing until CRON_SECRET is set', async () => {
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${SECRET}x`)).status).toBe(401);
    expect((await call(SECRET)).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await call('Bearer ')).status).toBe(503);
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    expect((await call(`Bearer ${SECRET}`)).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers 503 when the database fails, so the next run tries again', async () => {
    query.mockRejectedValue(new Error('down'));
    expect((await call(`Bearer ${SECRET}`)).status).toBe(503);
  });
});
