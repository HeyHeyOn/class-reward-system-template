// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTeacherSessionStore } from '@/server/teacherSession';
import { currentLegalRevision } from '@/lib/legalDocuments';
import { createClassCreationCommand } from './classCreation';

let db: PGlite;
const input = { operationId: '50000000-0000-4000-8000-000000000001', subject: 'subject-a', email: 'a@example.invalid', displayName: '새 학급', accountGeneration:'', sessionId:'' };
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  for (const name of (await readdir('src/server/db/migrations')).filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort()) {
    await db.exec(await readFile(`src/server/db/migrations/${name}`, 'utf8'));
  }
  await db.exec(`CREATE ROLE creation_runtime NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO creation_runtime;
    GRANT EXECUTE ON FUNCTION public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text) TO creation_runtime`);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('RESET ROLE; BEGIN');
  const sessions = createTeacherSessionStore({ query:(text,values)=>db.query(text,values) });
  Object.assign(input,await sessions.begin(input.subject,currentLegalRevision().version));
  await sessions.mutate(input,'AGREE',{ version:currentLegalRevision().version });
});
afterEach(async () => { await db.exec('ROLLBACK; RESET ROLE'); });
async function guardedQuery(text:string, values?:unknown[]) {
  await db.exec('SAVEPOINT statement');
  try { const result=await db.query(text,values); await db.exec('RELEASE SAVEPOINT statement'); return result; }
  catch(error) { await db.exec('ROLLBACK TO SAVEPOINT statement; RELEASE SAVEPOINT statement'); throw error; }
}
const command = () => createClassCreationCommand({ query: guardedQuery });
const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM users)::int AS users,
 (SELECT count(*) FROM tenants)::int AS tenants, (SELECT count(*) FROM tenant_memberships)::int AS memberships,
 (SELECT count(*) FROM class_creation_operations)::int AS operations`)).rows;
describe('atomic DRAFT creation command', () => {
  it('creates DRAFT + OWNER with server IDs using only exact function EXECUTE', async () => {
    await db.exec('SET ROLE creation_runtime');
    const result = await command().create(input);
    expect(result).toMatchObject({ displayName: input.displayName, lifecycle: 'DRAFT', role: 'OWNER', replayed: false });
    expect(result.slug).toMatch(/^class-[0-9a-f-]{36}$/);
    await db.exec('RESET ROLE');
    expect(await counts()).toEqual([{ users: 1, tenants: 1, memberships: 1, operations: 1 }]);
    const binding = await db.query(`SELECT u.google_subject, tm.role, t.lifecycle FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id JOIN tenants t ON t.id=tm.tenant_id`);
    expect(binding.rows).toEqual([{ google_subject: input.subject, role: 'OWNER', lifecycle: 'DRAFT' }]);
  });
  it('replays an exact operation without writing and rejects changed/foreign payload', async () => {
    const first = await command().create(input);
    expect(await command().create(input)).toEqual({ ...first, replayed: true });
    for (const mutation of [{ displayName: '다른 학급' }, { subject: 'foreign' }, { email: 'other@example.invalid' }]) {
      await expect(command().create({ ...input, ...mutation })).rejects.toThrow();
    }
    expect(await counts()).toEqual([{ users: 1, tenants: 1, memberships: 1, operations: 1 }]);
  });
  it('does not merge another subject by canonical email or update an existing user', async () => {
    await db.query(`INSERT INTO users(google_subject,canonical_email) VALUES ('foreign',$1)`, [input.email]);
    const before = await db.query('SELECT * FROM users');
    await expect(command().create(input)).rejects.toThrow();
    expect((await db.query('SELECT * FROM users')).rows).toEqual(before.rows);
    expect(await counts()).toEqual([{ users: 1, tenants: 0, memberships: 0, operations: 0 }]);
  });
  it('reuses the exact subject/email user without mutation', async () => {
    await db.query('INSERT INTO users(google_subject,canonical_email) VALUES ($1,$2)', [input.subject, input.email]);
    const before = await db.query('SELECT * FROM users');
    await command().create(input);
    expect((await db.query('SELECT * FROM users')).rows).toEqual(before.rows);
  });
  it('rolls back user/tenant/membership on a late metadata failure', async () => {
    await db.exec(`CREATE FUNCTION fail_creation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic late failure'; END $$;
      CREATE TRIGGER fail_creation_test BEFORE INSERT ON class_creation_operations FOR EACH ROW EXECUTE FUNCTION fail_creation_test()`);
    try {
      await expect(command().create(input)).rejects.toThrow();
      expect(await counts()).toEqual([{ users: 0, tenants: 0, memberships: 0, operations: 0 }]);
    } finally { await db.exec('DROP TRIGGER fail_creation_test ON class_creation_operations; DROP FUNCTION fail_creation_test()'); }
  });
  it('keeps FORCE RLS, migration ownership, exact search_path, and PUBLIC revoked', async () => {
    const guards = await db.query(`SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c WHERE c.oid='public.class_creation_operations'::regclass`);
    expect(guards.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const f = await db.query(`SELECT p.prosecdef,p.proconfig, r.rolsuper OR r.rolbypassrls AS privileged_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text)'::regprocedure`);
    expect(f.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog'], privileged_owner: true }]);
    await db.exec('SET ROLE creation_runtime');
    await expect(guardedQuery('SELECT * FROM class_creation_operations')).rejects.toThrow();
    await expect(guardedQuery(`INSERT INTO tenants(slug,display_name) VALUES ('bypass','bypass')`)).rejects.toThrow();
    await db.exec('RESET ROLE');
    const grants = await db.query(`SELECT count(*)::int n FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.oid='public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text)'::regprocedure AND a.grantee=0`);
    expect(grants.rows).toEqual([{ n: 0 }]);
  });
});
