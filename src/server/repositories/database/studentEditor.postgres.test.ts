// @vitest-environment node
// D05: owned native PG, actual scoped auth/GET/PATCH and real cancellation connection.
import { issueTeacherTestSession, grantProductionTestRuntime } from '@/server/db/testing/teacherIdentity';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { setGoogleSessionCookie, GOOGLE_AUTH_COOKIE } from '@/server/googleOAuth';
import { GET, PATCH } from '@/app/api/c/[slug]/[...path]/route';
import { GET as unscopedGet } from '@/app/api/students/route';
import { PATCH as unscopedPatch } from '@/app/api/students/batch/route';
import { createDatabaseStudentCommands } from './studentCommands';
import { createDatabaseTransactionCommands } from './transactionCommands';
import { createTenantBootstrapper } from './tenantBootstrap';
import { verifyGoogleSheetSourceControl } from '@/server/migration/googleSourceControl';
import type { VersionedAdminStudent } from '@/lib/studentAdminSnapshot';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined, google: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('D05_OWNED_DATABASE_REQUIRED');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsStore: destination.google,
  createConfiguredSheetsReader: destination.google,
}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const A = 'd0500000-0000-4000-8000-000000000001';
const B = 'd0500000-0000-4000-8000-000000000002';
const DRAFT = 'd0500000-0000-4000-8000-000000000003';
let db: DisposablePostgres;
let cookie: string;
const evidence = (kind: string, value: unknown) => console.info('D05_PG', JSON.stringify({ kind, value }));
const command = () => createDatabaseStudentCommands({ tenantId: A, runTenantTransaction: db.runTenantTransaction });
function input(row: VersionedAdminStudent, changes: Partial<VersionedAdminStudent> = {}) {
  return { studentId: row.studentId, name: row.name, balance: row.balance, status: row.status,
    expectedStudentVersion: row.studentVersion, expectedAccountVersion: row.accountVersion, ...changes };
}
async function get(slug = 'd05-a', admin = true, snapshot = true) {
  const request = new Request(`http://localhost/api/c/${slug}/students${snapshot ? '?includeInactive=1' : ''}`, {
    headers: admin ? { cookie } : {},
  });
  return GET(request, { params: Promise.resolve({ slug, path: ['students'] }) });
}
async function patch(body: unknown, slug = 'd05-a', admin = true) {
  return PATCH(new Request(`http://localhost/api/c/${slug}/students/batch`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(admin ? { cookie } : {}) }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ slug, path: ['students', 'batch'] }) });
}
async function row(id: string): Promise<VersionedAdminStudent> {
  const response = await get(); expect(response.status).toBe(200);
  const snapshot = await response.json(); expect(snapshot.storage).toBe('postgresql');
  const result = snapshot.students.find((s: VersionedAdminStudent) => s.studentId === id);
  expect(result).toBeTruthy(); return result;
}
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ['students', 'accounts', 'transactions', 'adjustments', 'operations', 'audit_events']) {
    result[table] = (await db.owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [A])).rows;
  }
  return result;
}

suite('D05 student editor vertical slice (native isolated fixture, not migration/deployment acceptance)', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres(); await grantProductionTestRuntime(db.owner); destination.pool = db.runtime;
    evidence('owned', db.evidence);
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    destination.google.mockImplementation(() => { throw new Error('D05_GOOGLE_FORBIDDEN'); });
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_validate_teacher_session(text,uuid,uuid,boolean,text) TO app_runtime');
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO app_runtime');
    // Pre-existing ACTIVE business fixtures, NOT a DRAFT promotion or migration proof.
    // The separately bootstrapped DRAFT stays DRAFT and fails normal admission.
    for (const [id, slug, lifecycle] of [[A, 'd05-a', 'ACTIVE'], [B, 'd05-b', 'ACTIVE']]) {
      await db.owner.query('INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$2,$3)', [id, slug, lifecycle]);
    }
    const user = (await db.owner.query("INSERT INTO users(google_subject,canonical_email) VALUES('d05-owner','d05@example.test') RETURNING id")).rows[0].id;
    await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [A, user]);
    // Exercise the existing initializer, using explicitly synthetic source-control
    // metadata (not a real Google binding). It may create only DRAFT/DISCOVERED.
    const now = Date.now();
    const proof = await verifyGoogleSheetSourceControl({
      fileId: 'd05-disposable-source', session: { subject: 'd05-owner', email: 'd05@example.test', issuedAt: now }, now: () => now,
      reader: { readMetadataAndPermissions: async () => ({ observedAt: now, file: {
        id: 'd05-disposable-source', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false,
        owners: [{ emailAddress: 'd05@example.test' }],
      }, permissions: [{ type: 'user', role: 'owner', emailAddress: 'd05@example.test', deleted: false }] }) },
    });
    let firstId = true;
    const initialized = await createTenantBootstrapper({
      createId: () => { if (firstId) { firstId = false; return DRAFT; } return randomUUID(); },
      async runTransaction(callback) {
        const client = await db.owner.connect();
        try {
          await client.query('BEGIN'); const result = await callback(client);
          await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
    })({ slug: 'd05-draft', displayName: 'D05 disposable draft', owner: { subject: 'd05-owner', email: 'd05@example.test' }, proof, sourceFingerprint: 'd'.repeat(64) });
    expect(initialized.tenantId).toBe(DRAFT);
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [DRAFT])).rows).toEqual([{ lifecycle: 'DRAFT' }]);
    expect((await db.owner.query('SELECT status FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [DRAFT, initialized.jobId])).rows).toEqual([{ status: 'DISCOVERED' }]);
    evidence('existing_initializer', { tenantId: DRAFT, lifecycle: 'DRAFT', jobStatus: 'DISCOVERED', sourceControlMetadata: 'explicit synthetic fixture, no real Google binding' });
    const reply = NextResponse.json({});
    setGoogleSessionCookie(reply, await issueTeacherTestSession(db.owner,{ subject:'d05-owner',email:'d05@example.test' }));
    cookie = `${GOOGLE_AUTH_COOKIE}=${reply.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
    for (const [id, status] of [['READ', 'ACTIVE'], ['INACTIVE', 'INACTIVE'], ['DELETED', 'INACTIVE'], ['EDIT', 'ACTIVE'], ['RACE1', 'ACTIVE'], ['RACE2', 'ACTIVE'], ['ROLLBACK', 'ACTIVE']] as const) {
      await command().create({ operationId: randomUUID(), studentId: id, name: id, balance: 100, status });
    }
    await db.owner.query("UPDATE students SET deleted_at=now() WHERE tenant_id=$1 AND student_id='DELETED'", [A]);
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'FOREIGN','FOREIGN','ACTIVE')", [B]);
    await db.owner.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'FOREIGN',777)", [B]);
    const identity = (await db.runtime.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows;
    expect(identity).toEqual([{ current_user: 'app_runtime', rolsuper: false, rolbypassrls: false }]);
    evidence('admission_fixture', { identity, activeTenants: [A, B], draftTenant: DRAFT,
      limitation: 'Business-active fixture initialization only. No DRAFT activation, migration import, or real tenant binding claimed.' });
  }, 60_000);
  afterAll(async () => {
    destination.pool = undefined; vi.unstubAllEnvs();
    if (db) evidence('cleanup', await db.close());
  }, 60_000);

  it('authenticates and binds admin reads; includes inactive nondeleted rows with same-snapshot versions; ordinary GET unchanged', async () => {
    expect((await get('d05-a', false)).status).toBe(401);
    expect((await get('d05-b')).status).toBe(403);
    const snapshot = await (await get()).json();
    expect(snapshot.students.some((s: VersionedAdminStudent) => s.studentId === 'INACTIVE')).toBe(true);
    expect(snapshot.students.some((s: VersionedAdminStudent) => ['DELETED', 'FOREIGN'].includes(s.studentId))).toBe(false);
    for (const s of snapshot.students) expect(s).toMatchObject({ studentVersion: 1, accountVersion: 1, balance: 100 });
    const normal = await (await get('d05-a', true, false)).json();
    expect(Array.isArray(normal)).toBe(true);
    expect(normal.every((s: VersionedAdminStudent) => s.status === 'ACTIVE' && !('studentVersion' in s) && !('accountVersion' in s))).toBe(true);
    evidence('admin_read', { snapshot, normal, unauthenticated: 401, foreign: 403 });
    expect(destination.google).not.toHaveBeenCalled();
  });

  it('commits scoped PATCH row, ledger and operation together; exact lost-response replay has no extra ledger; changed same ID conflicts', async () => {
    const body = { operationId: randomUUID(), students: [input(await row('EDIT'), { name: 'Edited', balance: 125, status: 'INACTIVE' })] };
    const first = await patch(body); expect(first.status).toBe(200); const saved = await first.json();
    expect(saved).toEqual([{ studentId: 'EDIT', name: 'Edited', balance: 125, status: 'INACTIVE', studentVersion: 2, accountVersion: 2 }]);
    const committed = await state();
    const replay = await patch(body); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(saved);
    expect(await state()).toEqual(committed);
    const changed = await patch({ ...body, students: [{ ...body.students[0], balance: 126 }] });
    expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await state()).toEqual(committed);
    const op = (await db.owner.query('SELECT xmin::text AS xid,status,result_snapshot FROM operations WHERE tenant_id=$1 AND operation_id=$2', [A, body.operationId])).rows[0];
    const transactionId = op.result_snapshot.students[0].transactionId;
    const xids = [];
    for (const table of ['students', 'accounts']) xids.push((await db.owner.query(`SELECT xmin::text AS xid FROM ${table} WHERE tenant_id=$1 AND student_id='EDIT'`, [A])).rows[0].xid);
    for (const table of ['transactions', 'adjustments']) xids.push((await db.owner.query(`SELECT xmin::text AS xid FROM ${table} WHERE tenant_id=$1 AND transaction_id=$2`, [A, transactionId])).rows[0].xid);
    expect(new Set([...xids, op.xid]).size).toBe(1); expect(op.status).toBe('SUCCEEDED');
    evidence('committed_replay', { saved, operationId: body.operationId, transactionId, xids, operationXid: op.xid, exactReplayUnchanged: true, changedPayloadStatus: 409 });
    expect(destination.google).not.toHaveBeenCalled();
  });

  it('another real connection cancels, bumps account version; stale multirow PATCH rolls back ALL rows/ledgers/PENDING; explicit fresh edit succeeds', async () => {
    const initial = await row('RACE2');
    const adjustment = await command().updateBatch({ operationId: randomUUID(), students: [input(initial, { balance: 90 })] });
    const stale = [await row('RACE1'), await row('RACE2')];
    const other = await db.runtime.connect();
    try {
      const otherPid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const routePoolPid = (await db.runtime.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      expect(otherPid).not.toBe(routePoolPid);
      const cancellation = createDatabaseTransactionCommands({ tenantId: A,
        runTenantTransaction: createTenantTransactionRunner({ pool: { connect: async () => ({
          query: other.query.bind(other), release: () => undefined,
        }) } }),
      });
      const cancelled = await cancellation.cancel({ operationId: randomUUID(), transactionId: adjustment.students[0].transactionId! });
      expect(cancelled.balanceAfter).toBe(100);
      const current = await row('RACE2'); expect(current.accountVersion).toBe(stale[1].accountVersion + 1);
      const before = await state();
      const staleResponse = await patch({ operationId: randomUUID(), students: stale.map((s) => input(s, { name: `stale-${s.name}`, status: 'INACTIVE', balance: 95 })) });
      expect(staleResponse.status).toBe(409); expect(await staleResponse.json()).toMatchObject({ code: 'STALE_VERSION' });
      expect(await state()).toEqual(before);
      expect((await db.owner.query("SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1 AND status='PENDING'", [A])).rows).toEqual([{ n: 0 }]);
      const fresh = await patch({ operationId: randomUUID(), students: [input(current, { name: 'Fresh explicit edit', balance: 110 })] });
      expect(fresh.status).toBe(200);
      expect(await row('RACE2')).toMatchObject({ name: 'Fresh explicit edit', balance: 110, accountVersion: current.accountVersion + 1 });
      evidence('cancellation_stale_fresh', { otherPid, routePoolPid, beforeAccountVersion: stale[1].accountVersion, afterCancelAccountVersion: current.accountVersion,
        staleStatus: 409, exactStateUnchanged: true, pending: 0, freshStatus: 200, cancelled });
    } finally { other.release(); }
    expect(destination.google).not.toHaveBeenCalled();
  });

  it('denies foreign mutation, injected tenant, malformed PG contracts and DRAFT admission without Google fallback', async () => {
    const body = { operationId: randomUUID(), students: [input(await row('READ'), { balance: 105 })] };
    const before = await state();
    expect((await patch(body, 'd05-a', false)).status).toBe(401);
    expect((await patch(body, 'd05-b')).status).toBe(403);
    expect((await patch({ ...body, tenantId: B })).status).toBe(400);
    expect((await patch({ ...body, students: [{ ...body.students[0], studentId: 'FOREIGN' }] })).status).toBe(400);
    for (const bad of [undefined, 0, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect((await patch({ ...body, students: [{ ...body.students[0], expectedAccountVersion: bad }] })).status).toBe(400);
    }
    expect((await patch({ ...body, operationId: body.operationId.toUpperCase() })).status).toBe(400);
    expect((await get('d05-draft')).status).toBe(500);
    expect((await patch(body, 'd05-draft')).status).toBe(400);
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [DRAFT])).rows).toEqual([{ lifecycle: 'DRAFT' }]);
    expect((await unscopedGet(new Request('http://localhost/api/students?includeInactive=1', { headers: { cookie } }))).status).toBe(401);
    expect((await unscopedPatch(new Request('http://localhost/api/students/batch', { method: 'PATCH', headers: { cookie }, body: JSON.stringify(body) }))).status).toBe(401);
    expect(await state()).toEqual(before);
    expect((await db.owner.query('SELECT balance::text FROM accounts WHERE tenant_id=$1', [B])).rows).toEqual([{ balance: '777' }]);
    expect(destination.google).not.toHaveBeenCalled();
    evidence('tenant_contract_admission', { foreignRead: 403, foreignPatch: 403, draft: 'DRAFT', noResidualState: true, googleCalls: destination.google.mock.calls.length });
  });

  it('a native ledger failure rolls back row changes and operation claim, and never invokes Google', async () => {
    const before = await state();
    await db.owner.query(`CREATE FUNCTION d05_fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.student_id='ROLLBACK' THEN RAISE EXCEPTION 'D05_LEDGER_FAILURE'; END IF; RETURN NEW; END $$`);
    await db.owner.query('CREATE TRIGGER d05_fail_ledger BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION d05_fail_ledger()');
    try {
      const result = await patch({ operationId: randomUUID(), students: [input(await row('ROLLBACK'), { name: 'Must rollback', balance: 150, status: 'INACTIVE' })] });
      expect(result.status).toBe(400);
      expect(await state()).toEqual(before);
      expect(destination.google).not.toHaveBeenCalled();
      evidence('ledger_failure_rollback', { status: result.status, exactStateUnchanged: true, googleCalls: destination.google.mock.calls.length });
    } finally { await db.owner.query('DROP TRIGGER d05_fail_ledger ON transactions; DROP FUNCTION d05_fail_ledger()'); }
  });
});
