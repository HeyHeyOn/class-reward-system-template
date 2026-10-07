// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { POST } from '@/app/api/classes/[slug]/start/route';
import { GET as tenantGet } from '@/app/api/c/[slug]/[...path]/route';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest, setGoogleSessionCookie } from '@/server/googleOAuth';
import { loadClassMembershipPage } from '@/server/classMembershipPageAccess';
import { createClassMembershipRepository } from './classMemberships';
import { createClassCreationCommand } from './classCreation';
import { createClassStartRepository } from './classStart';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined, sheets: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('Owned test database required.');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: destination.sheets, createConfiguredSheetsReader: destination.sheets }));

const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const origin = 'https://classes.example.invalid';
let db: DisposablePostgres;
let subject: string;
let cookie: string;
let slug: string;
let tenantId: string;

function sessionCookie(subjectValue = subject) {
  const response = new NextResponse();
  setGoogleSessionCookie(response, { subject: subjectValue, email: `${subjectValue}@example.invalid`, issuedAt: Date.now() });
  return `${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
}
function startRequest(operationId = randomUUID(), headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return new Request(`${origin}/api/classes/${slug}/start`, { method: 'POST',
    headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ operationId, ...body }) });
}
function start(operationId = randomUUID(), headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return POST(startRequest(operationId, headers, body), { params: Promise.resolve({ slug }) });
}
async function state() {
  return (await db.owner.query(`SELECT
    (SELECT to_jsonb(t) FROM tenants t WHERE id=$1) AS tenant,
    (SELECT jsonb_agg(to_jsonb(s)) FROM tenant_settings s WHERE tenant_id=$1) AS settings,
    (SELECT jsonb_agg(to_jsonb(s)) FROM new_class_start_operations s WHERE tenant_id=$1) AS receipts`, [tenantId])).rows[0];
}

suite('new empty class start on native PostgreSQL', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres(); destination.pool = db.runtime;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    destination.sheets.mockImplementation(() => { throw new Error('Sheets fallback forbidden.'); });
    await db.owner.query(`GRANT EXECUTE ON FUNCTION public.platform_create_draft_class(uuid,text,text,text),
      public.platform_list_memberships_by_google_subject(text), public.platform_find_tenant_by_slug(text),
      public.platform_find_membership_by_tenant_and_google_subject(uuid,text),
      public.platform_get_new_class_setup(text,text), public.platform_start_new_class(uuid,text,text) TO app_runtime`);
  }, 60_000);
  beforeEach(async () => {
    subject = `class-start-${randomUUID()}`; cookie = sessionCookie();
    const created = await createClassCreationCommand(db.runtime).create({ operationId: randomUUID(), subject,
      email: `${subject}@example.invalid`, displayName: '새 학급' });
    slug = created.slug;
    tenantId = (await db.owner.query('SELECT id FROM tenants WHERE slug=$1', [slug])).rows[0].id;
    destination.sheets.mockClear();
  });
  afterAll(async () => {
    destination.pool = undefined; vi.unstubAllEnvs();
    if (db) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
  }, 60_000);

  it('atomically initializes settings and starts the class; exact replay preserves every row', async () => {
    const operationId = randomUUID();
    expect(await createClassStartRepository(db.runtime).getSetup(slug, subject)).toEqual({ slug, displayName: '새 학급', lifecycle: 'DRAFT' });
    const first = await start(operationId);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual({ slug, displayName: '새 학급', lifecycle: 'ACTIVE', replayed: false });
    const started = await state();
    expect(started.settings).toHaveLength(1);
    expect(started.receipts).toHaveLength(1);
    expect(started.settings[0].settings).toMatchObject({ className: '새 학급', currencyUnit: '원', qrManualInputEnabled: false });
    const replay = await start(operationId);
    expect(await replay.json()).toMatchObject({ lifecycle: 'ACTIVE', replayed: true });
    expect(await state()).toEqual(started);
    const model = await loadClassMembershipPage(startRequest(), { getSession: getGoogleSessionFromRequest,
      listByGoogleSubject: createClassMembershipRepository(db.runtime).listByGoogleSubject });
    expect(model).toMatchObject({ memberships: [{ slug, selectable: true, href: `/c/${slug}` }] });
    const settings = await tenantGet(new Request(`${origin}/api/c/${slug}/settings`, { headers: { cookie } }),
      { params: Promise.resolve({ slug, path: ['settings'] }) });
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ source: 'database', currencyUnit: '원', className: '새 학급' });
    expect(destination.sheets).not.toHaveBeenCalled();
  });

  it('refuses missing/foreign identity, cross-origin and forged authority without writes', async () => {
    const before = await state();
    expect((await start(randomUUID(), { cookie: '' })).status).toBe(401);
    expect((await start(randomUUID(), { cookie: sessionCookie('other-subject') })).status).toBe(403);
    expect((await start(randomUUID(), { origin: 'https://foreign.example.invalid' })).status).toBe(403);
    expect((await start(randomUUID(), {}, { lifecycle: 'ACTIVE' })).status).toBe(400);
    expect(await createClassStartRepository(db.runtime).getSetup(slug, 'other-subject')).toBeNull();
    expect(await state()).toEqual(before);
  });

  it('serializes a duplicate start on distinct DB connections', async () => {
    const connections = await Promise.all([db.runtime.connect(), db.runtime.connect()]);
    try {
      const pids = await Promise.all(connections.map(c => c.query('SELECT pg_backend_pid() AS pid')));
      expect(pids[0].rows[0].pid).not.toBe(pids[1].rows[0].pid);
      const input = { operationId: randomUUID(), slug, subject };
      const results = await Promise.all(connections.map(c => createClassStartRepository(c).start(input)));
      expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
      expect((await state()).receipts).toHaveLength(1);
    } finally { connections.forEach(c => c.release()); }
  });

  it('rejects a second operation and reusing an operation for another class', async () => {
    const operationId = randomUUID();
    expect((await start(operationId)).status).toBe(200);
    const before = await state();
    expect((await start()).status).toBe(409);
    expect(await state()).toEqual(before);
    const other = await createClassCreationCommand(db.runtime).create({ operationId: randomUUID(), subject,
      email: `${subject}@example.invalid`, displayName: '다른 학급' });
    await expect(createClassStartRepository(db.runtime).start({ operationId, slug: other.slug, subject }))
      .rejects.toMatchObject({ code: '23505' });
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE slug=$1', [other.slug])).rows[0].lifecycle).toBe('DRAFT');
  });

  it('does not activate a legacy tenant or a new draft with any migration job', async () => {
    await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'DISCOVERED')", [tenantId, randomUUID()]);
    const before = await state();
    expect((await start()).status).toBe(409);
    expect(await createClassStartRepository(db.runtime).getSetup(slug, subject)).toBeNull();
    expect(await state()).toEqual(before);
    const legacyId = randomUUID();
    await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'legacy-start-test','이전 학급')", [legacyId]);
    await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) SELECT $1,id,'OWNER' FROM users WHERE google_subject=$2", [legacyId, subject]);
    await expect(createClassStartRepository(db.runtime).start({ operationId: randomUUID(), slug: 'legacy-start-test', subject }))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('refuses drafts containing settings/data and refuses revoked ownership', async () => {
    await db.owner.query("INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,'{\"currencyUnit\":\"보존\"}')", [tenantId]);
    const before = await state();
    expect((await start()).status).toBe(409);
    expect(await state()).toEqual(before);
    await db.owner.query("UPDATE tenant_memberships SET role='ADMIN' WHERE tenant_id=$1", [tenantId]);
    expect((await start()).status).toBe(403);
    expect(await createClassStartRepository(db.runtime).getSetup(slug, subject)).toBeNull();
    expect(await state()).toEqual(before);
  });

  it('does not reopen suspended classrooms even with the exact original request', async () => {
    const operationId = randomUUID(); await start(operationId);
    await db.owner.query("UPDATE tenants SET lifecycle='SUSPENDED' WHERE id=$1", [tenantId]);
    const before = await state();
    expect((await start(operationId)).status).toBe(409);
    expect(await state()).toEqual(before);
  });

  it('rolls settings and receipt back on a late activation failure, then safely retries', async () => {
    await db.owner.query(`CREATE FUNCTION fail_class_start_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.lifecycle='ACTIVE' THEN RAISE EXCEPTION 'synthetic late failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_class_start_test BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION fail_class_start_test()`);
    const before = await state(); const operationId = randomUUID();
    try {
      const response = await start(operationId);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('synthetic');
      expect(await state()).toEqual(before);
    } finally { await db.owner.query('DROP TRIGGER fail_class_start_test ON tenants; DROP FUNCTION fail_class_start_test()'); }
    expect((await start(operationId)).status).toBe(200);
  });

  it('keeps the receipt private and immutable and retains exact privileged-function boundaries', async () => {
    await start();
    await expect(db.runtime.query('SELECT * FROM new_class_start_operations')).rejects.toMatchObject({ code: '42501' });
    await expect(db.owner.query('DELETE FROM new_class_start_operations WHERE tenant_id=$1', [tenantId])).rejects.toThrow();
    const functions = await db.owner.query(`SELECT p.prosecdef, p.proconfig, r.rolsuper OR r.rolbypassrls AS privileged_owner,
      NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS no_public
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('platform_start_new_class','platform_get_new_class_setup')`);
    expect(functions.rows).toHaveLength(2);
    for (const row of functions.rows) expect(row).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog'], privileged_owner: true, no_public: true });
  });
});
