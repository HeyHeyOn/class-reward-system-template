// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { QueryConfig } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ database: vi.fn(), dependencies: vi.fn() }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: mocks.database }));
vi.mock('@/server/tenantAccess', async importOriginal => ({
  ...await importOriginal<typeof import('@/server/tenantAccess')>(),
  getProductionTenantAccessDependencies: mocks.dependencies,
}));
import { createTenantAccessDependencies } from '@/server/tenantAccess';
import { GET } from './[slug]/route';

// In-memory WASM PostgreSQL only: no socket, DATABASE_URL, env file or source.
const database = new PGlite({ extensions: { pgcrypto } });
const tenantId = '20000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const userId = '40000000-0000-4000-8000-000000000001';
const memberId = '30000000-0000-4000-8000-000000000001';
const session = { subject: 'synthetic-subject', email: 'synthetic@example.test', issuedAt: 1 };
const configs: QueryConfig[] = [];
let revokeOnAcquisition = false;
let probeReadOnly = false;
const release = vi.fn();
const query = async (config: QueryConfig) => {
  configs.push(config);
  if (config.text.includes('public.migration_jobs')) {
    if (probeReadOnly) {
      expect((await database.query<{ read_only: string }>("SELECT current_setting('transaction_read_only') AS read_only")).rows[0].read_only).toBe('on');
      expect((await database.query<{ tenant: string }>("SELECT current_setting('app.tenant_id') AS tenant")).rows[0].tenant).toBe(tenantId);
    }

  }
  return database.query(config.text, config.values);
};
const getSession = vi.fn((): typeof session | null => session);
const get = (jobId?: string, slug = 'alpha') => GET(
  new Request(`https://example.test/api/migrations/status/${slug}${jobId === undefined ? '' : `?jobId=${encodeURIComponent(jobId)}`}`),
  { params: Promise.resolve({ slug }) },
);
const asOwner = async <T>(callback: () => Promise<T>) => {
  await database.exec('RESET ROLE');
  try { return await callback(); }
  finally { await database.exec('SET ROLE status_reader'); }
};

beforeAll(async () => {
  for (const name of ['0001_identity_tenants.sql', '0002_operational.sql', '0003_operations_migrations.sql', '0012_platform_tenant_discovery.sql']) {
    await database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
  }
  await database.query(`INSERT INTO tenants (id, slug, display_name, lifecycle) VALUES
    ($1, 'alpha', 'Synthetic alpha', 'ACTIVE'), ($2, 'beta', 'Synthetic beta', 'ACTIVE')`, [tenantId, otherTenantId]);
  await database.query('INSERT INTO users (id, google_subject, canonical_email) VALUES ($1, $2, $3)', [userId, session.subject, session.email]);
  await database.query("INSERT INTO tenant_memberships (tenant_id, id, user_id, role) VALUES ($1, $2, $3, 'OWNER')", [tenantId, memberId, userId]);
  await database.query(`INSERT INTO migration_jobs
    (tenant_id, job_id, status, final_fingerprint, freeze_started_at, freeze_verified_at, completed_at)
    VALUES ($1, 'job-active', 'ACTIVE', $3, now(), now(), now()),
           ($2, 'job-active', 'FAILED', NULL, NULL, NULL, now()),
           ($2, 'only-beta', 'FAILED', NULL, NULL, NULL, now())`, [tenantId, otherTenantId, 'a'.repeat(64)]);
  await database.exec(`CREATE ROLE status_reader NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO status_reader;
    GRANT SELECT ON migration_jobs TO status_reader;
    GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO status_reader;
    GRANT EXECUTE ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid, text) TO status_reader;
    SET ROLE status_reader`);
  mocks.dependencies.mockImplementation(() => createTenantAccessDependencies({ query: (text, values) => database.query(text, values) }, getSession));
  mocks.database.mockReturnValue({ pool: { connect: async () => {
    // Test-owner interleaving: revoke AFTER the HTTP membership gate, BEFORE
    // the reader's transaction. Production receives no mutation capability.
    if (revokeOnAcquisition) {
      await asOwner(() => database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1 AND id=$2', [tenantId, memberId]));
    }
    return { query, release };
  } } });
}, 30_000);
afterAll(async () => { await database.close(); }, 30_000);

it('isolates exact jobs, current membership and persisted ACTIVE with a SELECT-only role; GET changes no rows', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  try {
    const before = await asOwner(async () => ({
      jobs: (await database.query('SELECT * FROM migration_jobs ORDER BY tenant_id, job_id')).rows,
      audits: (await database.query('SELECT * FROM audit_events')).rows,
      members: (await database.query('SELECT * FROM tenant_memberships')).rows,
    }));
    const role = (await database.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    expect((await database.query('SELECT status FROM migration_jobs')).rows).toEqual([]);
    expect((await get()).status).toBe(503);
    expect(configs).toHaveLength(0);
    probeReadOnly = true;
    const active = await get('job-active');
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ migrationStatus: 'ACTIVE', authority: 'UNKNOWN', readOnly: true });
    const noJob = await get('missing');
    const crossTenant = await get('only-beta');
    expect(noJob.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual(await noJob.json());
    expect((await get('job-active', 'beta')).status).toBe(403);

    expect((await database.query('SELECT status FROM migration_jobs')).rows).toEqual([]);
    expect(release.mock.calls.every(call => call.length === 0)).toBe(true);
    const after = await asOwner(async () => ({
      jobs: (await database.query('SELECT * FROM migration_jobs ORDER BY tenant_id, job_id')).rows,
      audits: (await database.query('SELECT * FROM audit_events')).rows,
      members: (await database.query('SELECT * FROM tenant_memberships')).rows,
    }));
    expect(after).toEqual(before);
    expect(configs.every(config => /^(BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/.test(config.text.trimStart()))).toBe(true);

    // Actual synthetic membership removal between the access gate and SELECT.
    revokeOnAcquisition = true;
    expect((await get('job-active')).status).toBe(403);
    revokeOnAcquisition = false;
    const countBefore = configs.length;
    expect((await get('job-active')).status).toBe(403);
    expect(configs).toHaveLength(countBefore);
    getSession.mockReturnValue(null);
    expect((await get('job-active')).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
}, 30_000);
