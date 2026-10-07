// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { GET, POST } from '@/app/api/c/[slug]/[...path]/route';
import { GOOGLE_AUTH_COOKIE, setGoogleSessionCookie } from '@/server/googleOAuth';
import { createDatabaseSettingsCommands, SettingsConflictError } from './settingsCommands';
import { createDatabaseSettingsQueries } from './settingsQueries';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined, sheets: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('Owned test database required.');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: destination.sheets, createConfiguredSheetsReader: destination.sheets }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const origin = 'https://settings.example.invalid';
const values = { currencyUnit: '별', appTitle: '우리 반 매점', bankTitle: '우리 반 은행', themeColor: 'purple', fontFamily: 'default', qrManualInputEnabled: true };
let db: DisposablePostgres;
let tenantId: string;
let otherId: string;
let slug: string;
let cookie: string;
const commands = () => createDatabaseSettingsCommands({ tenantId, runTenantTransaction: db.runTenantTransaction });
const payload = (changes = {}) => ({ operationId: randomUUID(), expectedSettingsVersion: 1, ...values, ...changes });
const context = () => ({ params: Promise.resolve({ slug, path: ['settings'] }) });
function request(input: unknown, headers = {}) {
  return new Request(`${origin}/api/c/${slug}/settings`, { method: 'POST',
    headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
}
async function inspect() {
  return (await db.owner.query(`SELECT
    (SELECT to_jsonb(s) FROM tenant_settings s WHERE tenant_id=$1) settings,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_id) FROM operations o WHERE tenant_id=$1) operations,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY event_id) FROM audit_events a WHERE tenant_id=$1) audits`, [tenantId])).rows[0];
}

suite('central settings on native PostgreSQL', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres(); destination.pool = db.runtime;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql'); vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    destination.sheets.mockImplementation(() => { throw new Error('Sheets fallback forbidden.'); });
    await db.owner.query(`GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text),
      public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO app_runtime`);
  }, 60_000);
  beforeEach(async () => {
    tenantId = randomUUID(); otherId = randomUUID(); slug = 'settings-' + tenantId;
    const subject = 'settings-' + randomUUID();
    const userId = randomUUID();
    await db.owner.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,$2,$3)", [userId, subject, `${subject}@example.invalid`]);
    await db.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'설정 시험','ACTIVE'),($3,$4,'다른 학급','ACTIVE')", [tenantId, slug, otherId, 'settings-' + otherId]);
    await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
    await db.owner.query(`INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,$3::jsonb),($2,'{"currencyUnit":"다른 학급"}')`,
      [tenantId, otherId, JSON.stringify({ className: '설정 시험', padletApiKey: 'synthetic-private-key', googleSheetsId: 'synthetic-source', privateFutureKey: { keep: true } })]);
    const response = new NextResponse(); setGoogleSessionCookie(response, { subject, email: `${subject}@example.invalid`, issuedAt: Date.now() });
    cookie = `${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
    destination.sheets.mockClear();
  });
  afterAll(async () => {
    destination.pool = undefined; vi.unstubAllEnvs();
    if (db) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
  }, 60_000);

  it('public GET returns display settings and version without source IDs or secrets', async () => {
    const response = await GET(new Request(`${origin}/api/c/${slug}/settings`), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ source: 'database', settingsVersion: 1, className: '설정 시험', appTitle: '학급 매점' });
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private|synthetic-source|padletApiKey|googleSheetsId|privateFutureKey/);
    expect(destination.sheets).not.toHaveBeenCalled();
  });
  it('saves settings, immutable result and audit together; exact replay returns the original receipt', async () => {
    const input = payload();
    const response = await POST(request(input), context());
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved).toMatchObject({ ...values, settingsVersion: 2, source: 'database' });
    const state = await inspect();
    expect(state.operations).toHaveLength(1); expect(state.audits).toHaveLength(1);
    expect(state.settings.settings).toMatchObject({ ...values, padletApiKey: 'synthetic-private-key', privateFutureKey: { keep: true } });
    const again = await POST(request(input), context());
    expect(await again.json()).toEqual(saved); expect(await inspect()).toEqual(state);
    expect((await db.owner.query('SELECT settings FROM tenant_settings WHERE tenant_id=$1', [otherId])).rows[0].settings)
      .toEqual({ currencyUnit: '다른 학급' });
    expect(destination.sheets).not.toHaveBeenCalled();
  });
  it('rejects stale edits and changed requests without pending operations or lost updates', async () => {
    const first = payload(); await commands().save(first);
    const state = await inspect();
    for (const input of [payload({ appTitle: '오래된 화면' }), { ...first, bankTitle: '바뀐 요청' }]) {
      expect((await POST(request(input), context())).status).toBe(409);
      expect(await inspect()).toEqual(state);
    }
  });
  it('reads and edits an imported schema-4 row while retaining its historical schema and private settings', async () => {
    await db.owner.query('UPDATE tenant_settings SET schema_version=4 WHERE tenant_id=$1', [tenantId]);
    const reader = createDatabaseSettingsQueries({ tenantId, runTenantTransaction: db.runTenantTransaction });
    expect(await reader.getAppSettings()).toMatchObject({ source: 'database', padletApiKey: 'synthetic-private-key' });
    expect((await GET(new Request(`${origin}/api/c/${slug}/settings`), context())).status).toBe(200);
    const response = await POST(request(payload()), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ...values, settingsVersion: 2 });
    expect((await inspect()).settings).toMatchObject({ schema_version: 4, settings: { padletApiKey: 'synthetic-private-key' } });
  });
  it.each([['TRUE', true], ['FALSE', false]])('reads retained Sheets QR setting %s without rewriting it, then saves typed settings', async (text, expected) => {
    await db.owner.query(`UPDATE tenant_settings SET schema_version=4,
      settings=jsonb_set(settings,'{qrManualInputEnabled}',to_jsonb($2::text)) WHERE tenant_id=$1`, [tenantId, text]);
    const before = await inspect();
    expect(await commands().get()).toMatchObject({ qrManualInputEnabled: expected, settingsVersion: 1 });
    expect(await createDatabaseSettingsQueries({ tenantId, runTenantTransaction: db.runTenantTransaction }).getAppSettings())
      .toMatchObject({ qrManualInputEnabled: expected });
    expect(await inspect()).toEqual(before);
    expect((await POST(request(payload()), context())).status).toBe(200);
    expect((await inspect()).settings).toMatchObject({ schema_version: 4, settings: { qrManualInputEnabled: true } });
  });
  it('two simultaneous saves at the same version produce exactly one committed update', async () => {
    const results = await Promise.allSettled([commands().save(payload()), commands().save(payload({ currencyUnit: '달' }))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(SettingsConflictError);
    const state = await inspect(); expect(state.settings.version).toBe(2);
    expect(state.operations).toHaveLength(1); expect(state.audits).toHaveLength(1);
  });
  it('two concurrent copies of one request return one identical receipt', async () => {
    const input = payload();
    const results = await Promise.all([commands().save(input), commands().save(input)]);
    expect(results[0]).toEqual(results[1]); expect((await inspect()).operations).toHaveLength(1);
  });
  it('rejects anonymous/foreign/cross-site writes and extra authority or credential fields', async () => {
    const before = await inspect();
    expect((await POST(request(payload(), { cookie: '' }), context())).status).toBe(401);
    expect((await POST(request(payload(), { origin: 'https://foreign.example.invalid' }), context())).status).toBe(403);
    for (const changes of [{ tenantId: otherId }, { adminPassword: 'forbidden' }, { padletApiKey: 'forbidden' }, { themeColor: 'invalid' }]) {
      expect((await POST(request(payload(changes)), context())).status).toBe(400);
    }
    const otherSlug = 'settings-' + otherId;
    const foreign = new Request(`${origin}/api/c/${otherSlug}/settings`, { method: 'POST', headers: { cookie }, body: '{}' });
    expect((await POST(foreign, { params: Promise.resolve({ slug: otherSlug, path: ['settings'] }) })).status).toBe(403);
    expect(await inspect()).toEqual(before);
  });
  it('late audit failure rolls the settings update and operation back', async () => {
    await db.owner.query(`CREATE FUNCTION fail_settings_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic private audit failure'; END $$;
      CREATE TRIGGER fail_settings_audit_test BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_settings_audit_test()`);
    const before = await inspect();
    try {
      const response = await POST(request(payload()), context()); expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('synthetic private');
      expect(await inspect()).toEqual(before);
    } finally { await db.owner.query('DROP TRIGGER fail_settings_audit_test ON audit_events; DROP FUNCTION fail_settings_audit_test()'); }
  });
});
