// @vitest-environment node
/**
 * Local end-to-end check of the self-service .xlsx import against a RECORDED operating grid.
 * Opt-in: RUN_REAL_POSTGRES=1, CRS_XLSX_REAL_GRID=<recorded includeGridData JSON>,
 * CRS_XLSX_SCRATCH_DIR=<directory outside the repository for the generated .xlsx>,
 * optional CRS_XLSX_REPORT=<report path>. The report holds counts and IDs only — never names.
 *
 * grid → .xlsx (as Google's Excel export types cells) → preview + commit through the real tenant
 * route into a disposable PostgreSQL → compare students, balances, products, stock, promotions,
 * settings, task definitions and current-cycle stages with values derived independently from the
 * grid (the Sheets app's own row parsers and cycle projection).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { TaskCompletion } from '@/domain/types';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { GOOGLE_AUTH_COOKIE, setGoogleSessionCookie } from '@/server/googleOAuth';
import { createClassCreationCommand } from '@/server/repositories/database/classCreation';
import { createTaskLedgerReader } from '@/server/repositories/database/taskLedger/compatReader';
import { storedResetStage, type StoredTaskSchedule } from '@/domain/taskRepeat';
import { createHeaderIndex, parseTaskAssignmentRows, parseTaskCompletionRow, parseTaskRow } from '@/server/sheetsRows';
import { readOfflineGoogleGrid } from '../offlineGoogleGrid';
import { readXlsxWorkbookGrid } from './xlsxWorkbook';
import { googleGridToXlsx } from './testing/googleGridToXlsx';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('Owned test database required.');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsStore: () => { throw Error('Sheets forbidden.'); },
  createConfiguredSheetsReader: () => { throw Error('Sheets forbidden.'); },
}));
import { POST as tenantPost } from '@/app/api/c/[slug]/[...path]/route';

const GRID = process.env.CRS_XLSX_REAL_GRID;
const SCRATCH = process.env.CRS_XLSX_SCRATCH_DIR;
const suite = process.env.RUN_REAL_POSTGRES === '1' && GRID && SCRATCH ? describe : describe.skip;
const origin = 'https://classes.example.invalid';
let db: DisposablePostgres;

const rowsOf = (table: string[][] | undefined) => {
  const [headers = [], ...data] = table ?? [];
  const index = new Map(headers.map((header, i) => [header.trim(), i]));
  return data.filter(row => row.some(cell => cell.trim())).map(row => (name: string) => row[index.get(name) ?? -1] ?? '');
};

suite('xlsx import of the recorded operating grid (local end-to-end check)', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    const scratch = resolve(SCRATCH!);
    if (!relative(process.cwd(), scratch).startsWith('..')) throw Error('CRS_XLSX_SCRATCH_DIR must be outside the repository.');
    db = await createDisposablePostgres(); destination.pool = db.runtime;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    await db.owner.query(`GRANT EXECUTE ON FUNCTION public.platform_create_draft_class(uuid,text,text,text),
      public.platform_find_tenant_by_slug(text), public.platform_find_membership_by_tenant_and_google_subject(uuid,text),
      public.platform_get_new_class_setup(text,text), public.platform_start_new_class(uuid,text,text) TO app_runtime`);
  }, 120_000);
  afterAll(async () => {
    destination.pool = undefined; vi.unstubAllEnvs();
    if (db) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
  }, 60_000);

  it('imports the recorded class and matches its current state', async () => {
    const gridJson = await readFile(GRID!, 'utf8');
    const sheets = readOfflineGoogleGrid(gridJson).tabs;
    const bytes = await googleGridToXlsx(gridJson);
    await mkdir(resolve(SCRATCH!), { recursive: true, mode: 0o700 });
    const xlsxPath = join(resolve(SCRATCH!), `recorded-${randomUUID()}.xlsx`);
    await writeFile(xlsxPath, bytes, { mode: 0o600 });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), xlsxBytes: bytes.length, mismatches: {} };
    const mismatches = report.mismatches as Record<string, unknown[]>;
    const note = (kind: string, value: unknown) => { (mismatches[kind] ??= []).push(value); };

    // 1. The .xlsx reads back as the Sheets formatted grid.
    const grid = await readXlsxWorkbookGrid(await readFile(xlsxPath));
    let gridCells = 0, gridDiffs = 0;
    for (const [tab, rows] of Object.entries(sheets)) {
      rows.forEach((row, r) => row.forEach((cell, c) => { if (cell) gridCells += 1; if ((grid.tabs[tab]?.[r]?.[c] ?? '') !== cell) gridDiffs += 1; }));
    }
    report.grid = { tabs: Object.keys(sheets).length, nonEmptyCells: gridCells, cellDifferences: gridDiffs };

    // 2. Through the real tenant route: create a new class, preview, commit.
    const subject = `real-grid-${randomUUID()}`;
    const session = new NextResponse();
    setGoogleSessionCookie(session, { subject, email: `${subject}@example.invalid`, issuedAt: Date.now() });
    const cookie = `${GOOGLE_AUTH_COOKIE}=${session.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
    const { slug } = await createClassCreationCommand(db.runtime).create({ operationId: randomUUID(), subject,
      email: `${subject}@example.invalid`, displayName: '기록 검증 학급' });
    const tenantId: string = (await db.owner.query('SELECT id FROM tenants WHERE slug=$1', [slug])).rows[0].id;
    const call = async (action: 'preview' | 'commit', fields: Record<string, string> = {}) => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(bytes)], 'crs.xlsx'));
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      const started = performance.now();
      const response = await tenantPost(new Request(`${origin}/api/c/${slug}/migrations/xlsx/${action}`, { method: 'POST', body: form,
        headers: { cookie, origin, 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ slug, path: ['migrations', 'xlsx', action] }) });
      return { status: response.status, body: await response.json() as Record<string, unknown>, ms: Math.round(performance.now() - started) };
    };
    const preview = await call('preview');
    const issues = (preview.body.issues ?? []) as { level: string; sheet: string | null; row: number | null }[];
    report.preview = { status: preview.status, ms: preview.ms, canImport: preview.body.canImport, summary: preview.body.summary,
      issues: issues.map(issue => ({ level: issue.level, sheet: issue.sheet, row: issue.row })) };
    const operationId = randomUUID();
    const commit = await call('commit', { operationId, fileDigest: digest });
    report.commit = { status: commit.status, ms: commit.ms, replayed: commit.body.replayed, error: commit.body.error ?? null };
    const writeReport = () => process.env.CRS_XLSX_REPORT
      ? writeFile(process.env.CRS_XLSX_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) : Promise.resolve();
    if (commit.status !== 200) { await writeReport(); }
    expect(preview.status).toBe(200);
    expect(commit.status, String(commit.body.error)).toBe(200);
    const now = new Date().toISOString();

    // 3. Students and balances.
    const q = async (text: string) => (await db.owner.query(text, [tenantId])).rows as Record<string, unknown>[];
    const dbStudents = new Map((await q(`SELECT s.student_id, s.name, s.status, a.balance::text AS balance FROM students s
      JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id WHERE s.tenant_id=$1`)).map(row => [String(row.student_id), row]));
    const sheetStudents = rowsOf(sheets.Students);
    let balanceTotal = 0;
    for (const cell of sheetStudents) {
      const id = cell('studentId'), row = dbStudents.get(id);
      balanceTotal += Number(cell('balance'));
      if (!row) { note('studentMissing', id); continue; }
      if (row.name !== cell('name').trim()) note('studentName', id);
      if (Number(row.balance) !== Number(cell('balance'))) note('studentBalance', id);
      if (row.status !== cell('status')) note('studentStatus', id);
    }
    const dbBalance = [...dbStudents.values()].reduce((sum, row) => sum + Number(row.balance), 0);
    const transactions = await q(`SELECT kind, count(*)::int AS n FROM transactions WHERE tenant_id=$1 GROUP BY kind`);
    report.students = { sheet: sheetStudents.length, imported: dbStudents.size, sheetBalanceTotal: balanceTotal, importedBalanceTotal: dbBalance,
      openingAdjustments: transactions, nonZeroBalances: sheetStudents.filter(cell => Number(cell('balance')) !== 0).length };

    // 4. Products, stock, promotions.
    const dbProducts = new Map((await q(`SELECT product_id, name, price::text AS price, stock::text AS stock, is_active, image_url, category, sort_order
      FROM products WHERE tenant_id=$1`)).map(row => [String(row.product_id), row]));
    const sheetProducts = rowsOf(sheets.Products);
    for (const cell of sheetProducts) {
      const id = cell('productId'), row = dbProducts.get(id);
      if (!row) { note('productMissing', id); continue; }
      if (row.name !== cell('name').trim() || Number(row.price) !== Number(cell('price')) || Number(row.stock) !== Number(cell('stock'))
        || row.is_active !== (cell('isActive') === 'TRUE') || (row.image_url ?? '') !== cell('imageUrl').trim()
        || (row.category ?? '') !== cell('category').trim() || Number(row.sort_order) !== Number(cell('sortOrder'))) note('product', id);
    }
    const promotionLinks = await q(`SELECT promotion_id, count(*)::int AS n FROM promotion_products WHERE tenant_id=$1 GROUP BY 1`);
    const linkRows = rowsOf(sheets.PromotionProducts);
    report.products = { sheet: sheetProducts.length, imported: dbProducts.size,
      sheetStock: sheetProducts.reduce((sum, cell) => sum + Number(cell('stock')), 0),
      importedStock: [...dbProducts.values()].reduce((sum, row) => sum + Number(row.stock), 0) };
    report.promotions = { sheet: rowsOf(sheets.Promotions).length, imported: (await q('SELECT 1 FROM promotions WHERE tenant_id=$1')).length,
      sheetLinks: linkRows.length, sheetLinksToExistingProducts: linkRows.filter(cell => dbProducts.has(cell('productId'))).length,
      importedLinks: promotionLinks.reduce((sum, row) => sum + Number(row.n), 0) };

    // 5. Settings.
    const settings = (await q('SELECT settings FROM tenant_settings WHERE tenant_id=$1'))[0].settings as Record<string, unknown>;
    const sheetSettings = Object.fromEntries(rowsOf(sheets.Settings).map(cell => [cell('key'), cell('value')]));
    for (const key of ['appTitle', 'bankTitle', 'currencyUnit', 'themeColor', 'fontFamily']) {
      if (sheetSettings[key] !== undefined && settings[key] !== sheetSettings[key]) note('setting', key);
    }
    if (settings.qrManualInputEnabled !== (sheetSettings.qrManualInputEnabled === 'TRUE')) note('setting', 'qrManualInputEnabled');

    // 6. Task definitions and current-cycle stages, from the grid with the Sheets app's own parsers.
    const taskTable = sheets.Tasks, taskIndex = createHeaderIndex(taskTable[0].map(header => header.trim()));
    const sheetTasks = taskTable.slice(1).filter(row => row.some(Boolean)).map(row => parseTaskRow(row, taskIndex)!);
    const assignmentTable = sheets.TaskAssignments, completionTable = sheets.TaskCompletions;
    const assignments = parseTaskAssignmentRows(assignmentTable.slice(1).filter(row => row.some(Boolean)), createHeaderIndex(assignmentTable[0]));
    const completionIndex = createHeaderIndex(completionTable[0]);
    const completions = completionTable.slice(1).filter(row => row.some(Boolean)).map(row => parseTaskCompletionRow(row, completionIndex))
      .filter((event): event is TaskCompletion => event !== null);
    const activeStudents = new Set(sheetStudents.filter(cell => cell('status') === 'ACTIVE').map(cell => cell('studentId')));
    const dbTasks = new Map((await q(`SELECT task_id, title, description, reward::text AS reward, is_active, sort_order, available_from, due_at,
      current_schedule, (SELECT task_id FROM tasks p WHERE p.tenant_id=t.tenant_id AND p.task_instance_id=t.prerequisite_task_instance_id) AS prerequisite
      FROM tasks t WHERE tenant_id=$1 AND deleted_at IS NULL`)).map(row => [String(row.task_id), row]));
    const reader = createTaskLedgerReader({ tenantId, runTenantTransaction: createTenantTransactionRunner({ pool: db.runtime }),
      runTenantSnapshot: createTenantTransactionRunner({ pool: db.runtime }, { isolationLevel: 'REPEATABLE READ' }) });
    const readModel = new Map((await reader.listTaskCycleProjections({ includeInactive: true })).map(task => [task.taskId, task]));
    const stageCounts: Record<string, Record<string, { expected: number; imported: number }>> = {};
    let compared = 0;
    for (const task of sheetTasks) {
      const row = dbTasks.get(task.taskId), read = readModel.get(task.taskId);
      if (!row || !read) { note('taskMissing', task.taskId); continue; }
      const effective = resolveTaskSchedule({ currentSchedule: task.schedule!, pendingSchedule: task.pendingSchedule ?? null, now });
      const stored = row.current_schedule as Record<string, unknown>;
      const iso = (value: unknown) => value ? new Date(value as string).toISOString() : null;
      const canonical = (value?: string) => value ? new Date(value).toISOString() : null;
      const sorted = (value: unknown) => JSON.stringify(value, (_key, inner) => inner && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);
      const fields = { title: row.title === task.title.trim(), description: row.description === task.description.trim(),
        reward: Number(row.reward) === task.reward, isActive: row.is_active === task.isActive, sortOrder: Number(row.sort_order) === task.sortOrder,
        availableFrom: iso(row.available_from) === canonical(task.availableFrom), dueAt: iso(row.due_at) === canonical(task.dueAt),
        recurrence: sorted(stored.recurrence) === sorted(effective.recurrence),
        // The sheet's two reset flags become one "reset to" stage.
        resets: storedResetStage(stored as unknown as StoredTaskSchedule) === storedResetStage(effective) };
      const wrong = Object.entries(fields).filter(([, ok]) => !ok).map(([field]) => field);
      if (wrong.length) note('taskDefinition', { taskId: task.taskId, fields: wrong });
      if ((row.prerequisite ?? null) !== (task.prerequisiteTaskId ?? null)) note('taskPrerequisite', task.taskId);
      const state = projectTaskCycleState({ task, now, assignments, completions });
      const counts: Record<string, { expected: number; imported: number }> = {};
      const bump = (stage: string, key: 'expected' | 'imported') => { (counts[stage] ??= { expected: 0, imported: 0 })[key] += 1; };
      const importedById = new Map(read.currentCycle.students.map(student => [student.studentId, student]));
      for (const studentId of activeStudents) {
        const sheet = state.students[studentId];
        // The old app had no 미완료: every assigned, not completed student is 완료 가능.
        const expected = !sheet ? 'UNASSIGNED' : sheet.completed ? 'COMPLETED' : sheet.assigned ? 'READY' : 'UNASSIGNED';
        const imported = importedById.get(studentId);
        const actual = imported?.stage ?? 'UNASSIGNED';
        bump(expected, 'expected'); bump(actual, 'imported'); compared += 1;
        if (actual !== expected) {
          note('taskStage', { taskId: task.taskId, expected, actual });
        }
      }
      stageCounts[task.taskId] = counts;
    }
    report.tasks = { sheet: sheetTasks.length, imported: dbTasks.size, comparedStudentStages: compared, stages: stageCounts,
      importedCompletions: (await q(`SELECT source, count(*)::int AS n, sum(reward_snapshot)::int AS reward FROM task_completions WHERE tenant_id=$1 GROUP BY source`)) };
    report.history = { sheetTransactions: rowsOf(sheets.Transactions).length, sheetTaskAssignments: assignments.length,
      sheetTaskCompletions: completions.length, recreated: false };
    report.mismatchCount = Object.values(mismatches).reduce((sum, list) => sum + list.length, 0);

    // 7. Idempotent replay of the same upload writes nothing.
    const operations = (await q('SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1'))[0].n;
    const replay = await call('commit', { operationId, fileDigest: digest });
    const operationsAfterReplay = (await q('SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1'))[0].n;
    report.replay = { status: replay.status, replayed: replay.body.replayed, operationsBefore: operations, operationsAfter: operationsAfterReplay };
    await writeReport();
    expect(replay.body.replayed).toBe(true);
    expect(operationsAfterReplay).toBe(operations);
    expect(gridDiffs).toBe(0);
    expect(report.mismatchCount).toBe(0);
    expect(dbBalance).toBe(balanceTotal);
  }, 600_000);
});
