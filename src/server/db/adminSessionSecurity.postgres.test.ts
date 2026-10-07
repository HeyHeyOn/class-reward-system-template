// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createDisposablePostgres } from './testing/disposablePostgres';

const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
suite('administrator rate limit concurrent PostgreSQL admission', () => {
  it('admits exactly ten committed attempts across competing runtime connections', async () => {
    const db = await createDisposablePostgres();
    try {
      const tenantId = '10000000-0000-4000-8000-000000000040';
      await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'synthetic-auth-limit','Synthetic')", [tenantId]);
      await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_consume_tenant_login_attempt(uuid) TO app_runtime');
      const attempt = async () => {
        const client = await db.runtime.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
          const result = await client.query<{ retry: number }>('SELECT platform_consume_tenant_login_attempt($1) AS retry', [tenantId]);
          await client.query('COMMIT'); return result.rows[0].retry;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      };
      const admitted = await Promise.all(Array.from({ length: 16 }, attempt));
      expect(admitted.filter(value => value === 0)).toHaveLength(10);
      expect(admitted.filter(value => value > 0 && value <= 300)).toHaveLength(6);
      expect((await db.owner.query('SELECT short_attempts,hour_attempts FROM tenant_admin_login_limits WHERE tenant_id=$1', [tenantId])).rows)
        .toEqual([{ short_attempts: 10, hour_attempts: 10 }]);
    } finally { await db.close(); }
  }, 120000);
});
