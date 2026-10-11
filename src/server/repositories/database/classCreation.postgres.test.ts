// @vitest-environment node
// Real PostgreSQL, current migrations and production handlers. The DB connection
// is redirected to the owned test cluster; SQL, auth and repositories are real.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { POST } from '@/app/api/classes/route';
import { GET as tenantGet } from '@/app/api/c/[slug]/[...path]/route';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest, setGoogleSessionCookie } from '@/server/googleOAuth';
import { loadClassMembershipPage } from '@/server/classMembershipPageAccess';
import { createClassMembershipRepository } from './classMemberships';
import { issueTeacherTestSession } from '@/server/db/testing/teacherIdentity';
import { createClassCreationCommand } from './classCreation';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined, sheets: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('Owned test database required.');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsStore: destination.sheets,
  createConfiguredSheetsReader: destination.sheets,
}));

const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const origin = 'https://classes.example.invalid';
let db: DisposablePostgres;
let cookie: string;
let tableNames: string[];
let subject: string;
let email: string;

async function sessionCookie(identity = { subject, email }) {
  const response = new NextResponse();
  setGoogleSessionCookie(response, await issueTeacherTestSession(db.owner,identity));
  return `${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
}

function request(operationId = randomUUID(), displayName = '새 학급', headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/classes`, {
    method: 'POST', headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ operationId, displayName }),
  });
}

async function snapshot() {
  const state: Record<string, unknown[]> = {};
  for (const table of tableNames) {
    const identifier = '"' + table.replaceAll('"', '""') + '"';
    state[table] = (await db.owner.query(`SELECT to_jsonb(t) AS row FROM public.${identifier} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return state;
}

function expectOnlyCreation(before: Record<string, unknown[]>, after: Record<string, unknown[]>, newUser: boolean) {
  for (const name of tableNames) {
    const delta = ['tenants', 'tenant_memberships', 'class_creation_operations'].includes(name)
      || (name === 'users' && newUser) ? 1 : 0;
    expect(after[name].length - before[name].length, `${name} row delta`).toBe(delta);
    if (delta === 0) expect(after[name], `${name} unchanged`).toEqual(before[name]);
    else expect(after[name], `${name} existing rows preserved`).toEqual(expect.arrayContaining(before[name]));
  }
}

suite('new class creation on native PostgreSQL (no activation or external OAuth)', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres();
    destination.pool = db.runtime;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    destination.sheets.mockImplementation(() => { throw new Error('Sheets fallback forbidden.'); });
    await db.owner.query(`GRANT EXECUTE ON FUNCTION public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text),
      public.platform_validate_teacher_session(text,uuid,uuid,boolean,text),
      public.platform_list_memberships_by_google_subject(text), public.platform_find_tenant_by_slug(text),
      public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO app_runtime`);
    tableNames = (await db.owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )).rows.map(row => row.tablename);
  }, 60_000);

  beforeEach(async () => {
    // Unique identities keep each scenario independent without truncating the
    // immutable migration/evidence tables in the production schema.
    subject = `class-creation-${randomUUID()}`;
    email = `${subject}@example.invalid`;
    cookie = await sessionCookie();
    destination.sheets.mockClear();
  });

  afterAll(async () => {
    destination.pool = undefined;
    vi.unstubAllEnvs();
    if (db) {
      const cleanup = await db.close();
      expect(cleanup.containerRemoved).toBe(true);
      expect(cleanup.scratchRemoved).toBe(true);
    }
  }, 60_000);

  it('refuses unauthenticated and cross-origin requests without changing any table', async () => {
    const before = await snapshot();
    expect((await POST(request(randomUUID(), '거부', { cookie: '' }))).status).toBe(401);
    expect((await POST(request(randomUUID(), '거부', { origin: 'https://foreign.example.invalid' }))).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('creates only identity, DRAFT, OWNER membership and operation; exact replay writes nothing', async () => {
    const before = await snapshot();
    const operationId = randomUUID();
    const first = await POST(request(operationId));
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const result = await first.json();
    expect(result).toEqual({ slug: expect.stringMatching(/^class-[0-9a-f-]{36}$/),
      displayName: '새 학급', lifecycle: 'DRAFT', role: 'OWNER', replayed: false });
    const created = await snapshot();
    expectOnlyCreation(before, created, true);
    const replay = await POST(request(operationId));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...result, replayed: true });
    expect(await snapshot()).toEqual(created);
  });

  it('serializes the same operation on two real connections without duplicate classes', async () => {
    const before = await snapshot();
    const clients = await Promise.all([db.runtime.connect(), db.runtime.connect()]);
    try {
      const pids = await Promise.all(clients.map(client => client.query('SELECT pg_backend_pid() AS pid')));
      expect(new Set(pids.map(result => result.rows[0].pid)).size).toBe(2);
      const identity = getGoogleSessionFromRequest(new Request(origin,{headers:{cookie}}))!;
      const input = { operationId: randomUUID(), displayName: '동시 생성', subject, email, accountGeneration:identity.accountGeneration!,sessionId:identity.sessionId! };
      const results = await Promise.all(clients.map(client => createClassCreationCommand(client).create(input)));
      expect(new Set(results.map(result => result.slug)).size).toBe(1);
      expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
      expectOnlyCreation(before, await snapshot(), true);
    } finally { clients.forEach(client => client.release()); }
  });

  it('rejects a concurrent changed payload for the same operation without overwriting the winner', async () => {
    const before = await snapshot();
    const operationId = randomUUID();
    const responses = await Promise.all([POST(request(operationId, '첫 이름')), POST(request(operationId, '다른 이름'))]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const created = await snapshot();
    expectOnlyCreation(before, created, true);
    const winner = await responses.find(response => response.status === 201)!.json();
    const replay = await POST(request(operationId, winner.displayName));
    expect(replay.status).toBe(200);
    expect(await snapshot()).toEqual(created);
  });

  it('shows only the authenticated account’s DRAFT classes and refuses their business API', async () => {
    expect((await POST(request(randomUUID(), '내 첫 학급'))).status).toBe(201);
    expect((await POST(request(randomUUID(), '내 두 번째 학급'))).status).toBe(201);
    expect((await POST(request(randomUUID(), '다른 계정 학급', {
      cookie: await sessionCookie({ subject: 'foreign-account', email: 'foreign@example.invalid' }),
    }))).status).toBe(201);
    const before = await snapshot();
    const repository = createClassMembershipRepository(db.runtime);
    const model = await loadClassMembershipPage(new Request(`${origin}/classes`, { headers: { cookie } }), {
      ...repository, getSession: getGoogleSessionFromRequest,
    });
    expect(model.kind).toBe('MEMBERSHIPS');
    if (model.kind !== 'MEMBERSHIPS') throw new Error('Expected authenticated membership page.');
    expect(model.memberships.map(item => item.displayName).sort()).toEqual(['내 두 번째 학급', '내 첫 학급']);
    expect(model.memberships.every(item => !item.selectable && item.href === null && item.lifecycleLabel === '준비 중')).toBe(true);
    expect((await repository.listByGoogleSubject('foreign-account')).map(item => item.displayName)).toEqual(['다른 계정 학급']);
    expect(await repository.listByGoogleSubject('account-with-no-classes')).toEqual([]);
    const slug = model.memberships[0].slug;
    const response = await tenantGet(new Request(`${origin}/api/c/${slug}/settings`, { headers: { cookie } }), {
      params: Promise.resolve({ slug, path: ['settings'] }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'SETTINGS_UNAVAILABLE' });
    expect(destination.sheets).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('rejects another Google subject with the same email without merging identities', async () => {
    expect((await POST(request())).status).toBe(201);
    const foreignCookie = await sessionCookie({ subject: 'foreign-account', email });
    const before = await snapshot();
    const response = await POST(request(randomUUID(), '다른 계정', { cookie:foreignCookie }));
    expect(response.status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back all creation rows on a failure after user, tenant and membership inserts', async () => {
    const rollbackCookie = await sessionCookie({ subject: 'rollback-owner', email: 'rollback@example.invalid' });
    const before = await snapshot();
    await db.owner.query(`CREATE FUNCTION public.reject_creation_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic late failure'; END; $$;
      CREATE TRIGGER reject_creation_test BEFORE INSERT ON public.class_creation_operations
      FOR EACH ROW EXECUTE FUNCTION public.reject_creation_test()`);
    try {
      const response = await POST(request(randomUUID(), '롤백', {
        cookie: rollbackCookie,
      }));
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain('synthetic');
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.owner.query('DROP TRIGGER reject_creation_test ON public.class_creation_operations; DROP FUNCTION public.reject_creation_test()');
    }
  });

  it('keeps the runtime unprivileged and denies direct access to creation operations', async () => {
    expect((await db.runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await expect(db.runtime.query('SELECT * FROM public.class_creation_operations')).rejects.toMatchObject({ code: '42501' });
    expect(destination.sheets).not.toHaveBeenCalled();
  });
});
