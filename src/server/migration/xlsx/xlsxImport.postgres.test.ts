// @vitest-environment node
/**
 * Opt-in (RUN_REAL_POSTGRES=1): the self-service .xlsx import on a disposable native PostgreSQL,
 * through the real tenant route, auth, regular commands and read models. Synthetic data only.
 */
import { issueTeacherTestSession, grantProductionTestRuntime } from '@/server/db/testing/teacherIdentity';
import type { TeacherSessionBinding } from '@/server/teacherSession';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest, setGoogleSessionCookie } from '@/server/googleOAuth';
import { createClassCreationCommand } from '@/server/repositories/database/classCreation';
import { createClassStartRepository } from '@/server/repositories/database/classStart';
import { createTaskLedgerReader } from '@/server/repositories/database/taskLedger/compatReader';
import { buildStudentTaskProjection } from '@/server/studentTaskProjection';
import { executeXlsxImportPlan } from './xlsxImportExecutor';
import { buildXlsxImportPlan } from './xlsxImportPlan';
import { readXlsxWorkbookGrid } from './xlsxWorkbook';
import { buildSyntheticCrsWorkbook, writeSyntheticXlsx } from './testing/syntheticCrsWorkbook';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined, sheets: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('Owned test database required.');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: destination.sheets, createConfiguredSheetsReader: destination.sheets }));

import { POST as tenantPost } from '@/app/api/c/[slug]/[...path]/route';

const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const origin = 'https://classes.example.invalid';
let db: DisposablePostgres;
let subject: string;
let cookie: string;
let slug: string;
let tenantId: string;
let xlsx: Buffer;
let digest: string;
const binding = () => { const s=getGoogleSessionFromRequest(new Request(origin,{headers:{cookie}}))!; return {accountGeneration:s.accountGeneration!,sessionId:s.sessionId!} as TeacherSessionBinding; };

async function sessionCookie(value = subject) {
  const response = new NextResponse();
  setGoogleSessionCookie(response, await issueTeacherTestSession(db.owner,{ subject:value,email:`${value}@example.invalid` }));
  return `${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
}

async function call(action: 'preview' | 'commit', bytes: Buffer, fields: Record<string, string> = {}, headers: Record<string, string> = {}, name = 'crs.xlsx') {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await tenantPost(new Request(`${origin}/api/c/${slug}/migrations/xlsx/${action}`, { method: 'POST', body: form,
    headers: { cookie, origin, 'sec-fetch-site': 'same-origin', ...headers } }), { params: Promise.resolve({ slug, path: ['migrations', 'xlsx', action] }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function snapshot() {
  const one = async (text: string) => (await db.owner.query(text, [tenantId])).rows;
  return {
    tenant: (await one('SELECT lifecycle FROM tenants WHERE id=$1'))[0],
    students: await one(`SELECT s.student_id, s.name, s.status, a.balance::int AS balance FROM students s
      JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id WHERE s.tenant_id=$1 ORDER BY s.student_id`),
    products: await one(`SELECT product_id, name, price::int AS price, stock::int AS stock, is_active, image_url, category, sort_order
      FROM products WHERE tenant_id=$1 ORDER BY product_id`),
    promotions: await one(`SELECT p.promotion_id, p.name, p.is_active, array_agg(l.product_id ORDER BY l.product_id) AS products
      FROM promotions p LEFT JOIN promotion_products l ON l.tenant_id=p.tenant_id AND l.promotion_id=p.promotion_id
      WHERE p.tenant_id=$1 GROUP BY 1,2,3 ORDER BY 1`),
    tasks: await one(`SELECT task_id, title, reward::int AS reward, is_active, available_from, due_at, current_schedule->'recurrence' AS recurrence,
      (SELECT task_id FROM tasks p WHERE p.tenant_id=t.tenant_id AND p.task_instance_id=t.prerequisite_task_instance_id) AS prerequisite
      FROM tasks t WHERE tenant_id=$1 ORDER BY task_id`),
    settings: (await one('SELECT settings FROM tenant_settings WHERE tenant_id=$1'))[0]?.settings,
    transactions: await one(`SELECT student_id, kind, balance_delta::int AS delta FROM transactions WHERE tenant_id=$1 ORDER BY student_id`),
    completions: await one(`SELECT task_id_snapshot, student_id, source, reward_snapshot::int AS reward FROM task_completions WHERE tenant_id=$1 ORDER BY 1,2`),
    operations: Number((await one('SELECT count(*) AS n FROM operations WHERE tenant_id=$1'))[0].n),
  };
}

function ledgerReader() {
  const run = createTenantTransactionRunner({ pool: db.runtime }, { isolationLevel: 'REPEATABLE READ' });
  return createTaskLedgerReader({ tenantId, runTenantTransaction: createTenantTransactionRunner({ pool: db.runtime }), runTenantSnapshot: run });
}

/** Each task's students by stage, read from the class's task ledger (no cycles). */
async function stages() {
  const tasks = await ledgerReader().listTaskCycleProjections({ includeInactive: true });
  return Object.fromEntries(tasks.map(task => [task.taskId, Object.fromEntries(task.currentCycle.students
    .filter(student => student.stage !== 'UNASSIGNED')
    .map(student => [student.studentId, student.stage]))]));
}

async function newClass() {
  subject = `xlsx-import-${randomUUID()}`; cookie = await sessionCookie();
  const created = await createClassCreationCommand(db.runtime).create({ ...binding(),operationId: randomUUID(), subject,
    email: `${subject}@example.invalid`, displayName: '가져오기 학급' });
  slug = created.slug;
  tenantId = (await db.owner.query('SELECT id FROM tenants WHERE slug=$1', [slug])).rows[0].id;
}

suite('self-service CRS workbook import on native PostgreSQL', () => {
  let expected: ReturnType<typeof buildSyntheticCrsWorkbook>['expected'];
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres(); await grantProductionTestRuntime(db.owner); destination.pool = db.runtime;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    destination.sheets.mockImplementation(() => { throw new Error('Sheets fallback forbidden.'); });
    await db.owner.query(`GRANT EXECUTE ON FUNCTION public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text),
      public.platform_validate_teacher_session(text,uuid,uuid,boolean,text),
      public.platform_list_memberships_by_google_subject(text), public.platform_find_tenant_by_slug(text),
      public.platform_find_membership_by_tenant_and_google_subject(uuid,text),
      public.platform_get_new_class_setup(text,text), public.platform_start_new_class_authenticated(uuid,text,text,uuid,uuid,text) TO app_runtime`);
    const fixture = buildSyntheticCrsWorkbook(new Date());
    expected = fixture.expected;
    xlsx = await writeSyntheticXlsx(fixture.workbook);
    digest = createHash('sha256').update(xlsx).digest('hex');
  }, 120_000);
  beforeEach(async () => { await newClass(); });
  afterAll(async () => {
    destination.pool = undefined; vi.unstubAllEnvs();
    if (db) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
  }, 60_000);

  it('previews, starts a new class and imports its current state in one transaction; a replay writes nothing', async () => {
    const preview = await call('preview', xlsx);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ mode: 'start', canImport: true, blocked: null, fileDigest: digest,
      summary: { students: 6, totalBalance: 28, products: 2, tasks: 4 } });
    expect((await snapshot()).tenant.lifecycle).toBe('DRAFT');

    const operationId = randomUUID();
    const committed = await call('commit', xlsx, { operationId, fileDigest: digest });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body).toMatchObject({ ok: true, replayed: false, adminHref: `/c/${slug}/admin` });
    const state = await snapshot();
    expect(state.tenant.lifecycle).toBe('ACTIVE');
    expect(state.students).toEqual([
      { student_id: '0101', name: '바다', status: 'ACTIVE', balance: 1 },
      { student_id: 'S01', name: '가람', status: 'ACTIVE', balance: 12 },
      { student_id: 'S02', name: '나래', status: 'ACTIVE', balance: 0 },
      { student_id: 'S03', name: '다솜', status: 'ACTIVE', balance: 5 },
      { student_id: 'S04', name: '라온', status: 'ACTIVE', balance: 7 },
      { student_id: 'S05', name: '마루', status: 'INACTIVE', balance: 3 },
    ]);
    // Opening balances use the app's own administrator "set" adjustment; no history is recreated.
    expect(state.transactions).toEqual(['0101', 'S01', 'S03', 'S04', 'S05'].map(id => ({ student_id: id, kind: 'ADMIN_ADJUSTMENT',
      delta: state.students.find(row => row.student_id === id)!.balance })));
    expect(state.products).toEqual([
      { product_id: 'P1', name: '연필', price: 2, stock: 10, is_active: true, image_url: null, category: '문구', sort_order: 1 },
      { product_id: 'P2', name: '지우개', price: 1, stock: 0, is_active: false, image_url: 'https://example.invalid/eraser.png', category: null, sort_order: 2 },
    ]);
    expect(state.promotions).toEqual([{ promotion_id: 'PR1', name: '연필 할인', is_active: true, products: ['P1'] }]);
    expect(state.tasks.map(task => [task.task_id, task.is_active, task.prerequisite, task.recurrence.type])).toEqual([
      ['TA', true, null, 'NONE'], ['TB', true, null, 'WEEKLY'], ['TC', false, 'TA', 'NONE'], ['TD', true, null, 'NONE']]);
    expect(new Date(state.tasks[3].available_from).toISOString()).toBe('2030-03-02T00:00:00.000Z');
    expect(state.settings).toMatchObject({ className: '가져오기 학급', appTitle: '시험 매점', bankTitle: '시험 은행', currencyUnit: '점',
      themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: true });
    expect(JSON.stringify(state.settings)).not.toContain('a'.repeat(64));
    // Completed students are marked by the administrator command: no reward, no ledger row.
    expect(state.completions.every(row => row.source === 'ADMIN' && row.reward === 0)).toBe(true);
    const read = await stages();
    for (const [taskId, task] of Object.entries(expected.tasks)) {
      const want = Object.fromEntries([
        ...task.ready.map(id => [id, 'READY']),
        ...task.completed.map(id => [id, 'COMPLETED']),
      ]);
      expect(read[taskId], taskId).toEqual(want);
    }
    // The bank sees the same stages.
    const bank = buildStudentTaskProjection(await ledgerReader().listTaskCycleProjections({ includeInactive: true, studentId: 'S02' }), 'S02', new Date().toISOString());
    expect(JSON.stringify(bank)).toContain('TA');

    const replay = await call('commit', xlsx, { operationId, fileDigest: digest });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, replayed: true });
    expect(await snapshot()).toEqual(state);
    const again = await call('commit', xlsx, { operationId: randomUUID(), fileDigest: digest });
    expect(again).toMatchObject({ status: 409, body: { code: 'NOT_EMPTY' } });
    expect(await snapshot()).toEqual(state);
    const blocked = await call('preview', xlsx);
    expect(blocked.body).toMatchObject({ mode: 'import', canImport: false, blocked: 'NOT_EMPTY' });
    expect(destination.sheets).not.toHaveBeenCalled();
  }, 180_000);

  it('imports into an already started, still empty class (admin path)', async () => {
    await createClassStartRepository(db.runtime).start({ ...binding(),operationId: randomUUID(), slug, subject });
    const preview = await call('preview', xlsx);
    expect(preview.body).toMatchObject({ mode: 'import', canImport: true, blocked: null });
    const committed = await call('commit', xlsx, { operationId: randomUUID(), fileDigest: digest });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect((await snapshot()).students).toHaveLength(6);
  }, 180_000);

  it('rolls back every step, including the class start, when a later step fails', async () => {
    const plan = await buildXlsxImportPlan(await readXlsxWorkbookGrid(xlsx), { now: new Date().toISOString(), fileDigest: digest });
    const before = await snapshot();
    await expect(db.runTenantTransaction(tenantId, async tx => {
      await executeXlsxImportPlan(tx, { tenantId, plan, operationId: randomUUID(), start: { slug, subject,...binding() } });
      throw new Error('injected failure after the last step');
    })).rejects.toThrow('injected failure');
    expect(await snapshot()).toEqual(before);
    expect(before.tenant.lifecycle).toBe('DRAFT');
  }, 180_000);

  it('refuses unauthenticated, foreign, cross-site, mismatched and invalid uploads without writes', async () => {
    const before = await snapshot();
    expect((await call('preview', xlsx, {}, { cookie: '' })).status).toBe(401);
    expect((await call('commit', xlsx, { operationId: randomUUID(), fileDigest: digest }, { cookie: await sessionCookie('someone-else') })).status).toBe(403);
    expect((await call('commit', xlsx, { operationId: randomUUID(), fileDigest: digest }, { origin: 'https://foreign.example.invalid' })).status).toBe(403);
    expect(await call('commit', xlsx, { operationId: randomUUID(), fileDigest: 'e'.repeat(64) })).toMatchObject({ status: 409 });
    expect(await call('preview', Buffer.from('studentId,name\n'), {}, {}, 'students.csv')).toMatchObject({ status: 415 });
    expect(await call('preview', Buffer.from('not a zip'), {}, {}, 'fake.xlsx')).toMatchObject({ status: 415, body: { code: 'NOT_XLSX' } });
    const broken = buildSyntheticCrsWorkbook(new Date());
    broken.workbook.Students[1] = ['S01', '가람', 'lots', 'ACTIVE'];
    const bad = await writeSyntheticXlsx(broken.workbook);
    const badPreview = await call('preview', bad);
    expect(badPreview.body).toMatchObject({ canImport: false });
    expect(badPreview.body.issues).toContainEqual({ level: 'error', sheet: 'Students', row: 2, message: '잔액(balance)은 정수여야 해요.' });
    const badCommit = await call('commit', bad, { operationId: randomUUID(), fileDigest: createHash('sha256').update(bad).digest('hex') });
    expect(badCommit.status).toBe(422);
    expect(await snapshot()).toEqual(before);
  }, 180_000);
});
