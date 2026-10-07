// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const alpha = '10000000-0000-4000-8000-000000000001';
const beta = '10000000-0000-4000-8000-000000000002';
let db: PGlite;

describe('durable administrator session controls', () => {
  beforeAll(async () => {
    db = new PGlite();
    for (const name of ['0001_identity_tenants.sql', '0040_admin_session_security.sql']) {
      await db.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', name), 'utf8'));
    }
    await db.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'alpha','Alpha'),($2,'beta','Beta')", [alpha, beta]);
    await db.exec(`CREATE ROLE auth_runtime NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE auth_outsider NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO auth_runtime,auth_outsider;
      GRANT EXECUTE ON FUNCTION public.platform_consume_tenant_login_attempt(uuid),public.platform_revoke_tenant_session(text,integer) TO auth_runtime;`);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  async function runtime<T>(callback: () => Promise<T>, context = alpha): Promise<T> {
    await db.exec('BEGIN; SET LOCAL ROLE auth_runtime;');
    try {
      await db.query("SELECT set_config('app.tenant_id',$1,true)", [context]);
      const result = await callback(); await db.exec('COMMIT'); return result;
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
  }
  const attempt = (tenantId = alpha) => runtime(async () =>
    (await db.query<{ retry: number }>('SELECT platform_consume_tenant_login_attempt($1) AS retry', [tenantId])).rows[0].retry, tenantId);

  it('serially admits ten attempts and refuses further calls without extending or growing the window', async () => {
    for (let index = 0; index < 10; index++) expect(await attempt()).toBe(0);
    const before = (await db.query('SELECT * FROM tenant_admin_login_limits WHERE tenant_id=$1', [alpha])).rows[0];
    for (let index = 0; index < 3; index++) expect(await attempt()).toBeGreaterThan(0);
    const after = (await db.query('SELECT * FROM tenant_admin_login_limits WHERE tenant_id=$1', [alpha])).rows[0];
    expect(after).toEqual(before);
    expect(await attempt(beta)).toBe(0);
  });

  it('recovers after five minutes, enforces the hourly budget, then recovers after an hour', async () => {
    for (let round = 0; round < 2; round++) {
      await db.query("UPDATE tenant_admin_login_limits SET short_started_at=clock_timestamp()-interval '6 minutes' WHERE tenant_id=$1", [alpha]);
      for (let index = 0; index < 10; index++) expect(await attempt()).toBe(0);
    }
    await db.query("UPDATE tenant_admin_login_limits SET short_started_at=clock_timestamp()-interval '6 minutes' WHERE tenant_id=$1", [alpha]);
    expect(await attempt()).toBeGreaterThan(300);
    expect((await db.query<{ hour_attempts: number }>('SELECT hour_attempts FROM tenant_admin_login_limits WHERE tenant_id=$1', [alpha])).rows[0].hour_attempts).toBe(30);
    await db.query("UPDATE tenant_admin_login_limits SET hour_started_at=clock_timestamp()-interval '61 minutes' WHERE tenant_id=$1", [alpha]);
    expect(await attempt()).toBe(0);
  });

  it('rejects mismatched tenant context and grants no direct counter table access or PUBLIC function execution', async () => {
    await expect(runtime(() => db.query('SELECT platform_consume_tenant_login_attempt($1)', [beta]))).rejects.toMatchObject({ code: '42501' });
    await expect(runtime(() => db.query('SELECT * FROM tenant_admin_login_limits'))).rejects.toMatchObject({ code: '42501' });
    await db.exec('BEGIN; SET LOCAL ROLE auth_outsider;');
    try { await expect(db.query('SELECT platform_revoke_tenant_session($1,1)', ['a'.repeat(64)])).rejects.toMatchObject({ code: '42501' }); }
    finally { await db.exec('ROLLBACK'); }
  });

  it('revokes only the exact bearer hash/version, including global logout without tenant context', async () => {
    await db.exec(`INSERT INTO users(id,google_subject,canonical_email) VALUES('20000000-0000-4000-8000-000000000001','synthetic-subject','synthetic@example.invalid');`);
    for (const [tenantId, hash] of [[alpha, 'a'.repeat(64)], [beta, 'b'.repeat(64)]]) {
      const membership = (await db.query<{ id: string }>("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,'20000000-0000-4000-8000-000000000001','OWNER') RETURNING id", [tenantId])).rows[0].id;
      await db.query("INSERT INTO tenant_sessions(tenant_id,membership_id,user_id,token_hash,credential_version,expires_at) VALUES($1,$2,'20000000-0000-4000-8000-000000000001',$3,1,clock_timestamp()+interval '12 hours')", [tenantId, membership, hash]);
    }
    await runtime(() => db.query('SELECT platform_revoke_tenant_session($1,2)', ['a'.repeat(64)]), '');
    expect((await db.query('SELECT * FROM tenant_sessions WHERE revoked_at IS NOT NULL')).rows).toHaveLength(0);
    await runtime(() => db.query('SELECT platform_revoke_tenant_session($1,1)', ['a'.repeat(64)]), '');
    const rows = (await db.query<{ token_hash: string; revoked_at: unknown }>('SELECT token_hash,revoked_at FROM tenant_sessions ORDER BY token_hash')).rows;
    expect(rows[0].revoked_at).not.toBeNull(); expect(rows[1].revoked_at).toBeNull();
    await runtime(() => db.query('SELECT platform_revoke_tenant_session($1,1)', ['a'.repeat(64)]), '');
    expect((await db.query('SELECT * FROM tenant_sessions WHERE revoked_at IS NOT NULL')).rows).toHaveLength(1);
  });
});
