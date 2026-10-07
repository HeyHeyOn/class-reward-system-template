// @vitest-environment node
/**
 * Opt-in (RUN_REAL_POSTGRES=1 + CRS_OPERATING_REPLAY_GRID / _FINANCIAL_REVIEW / _SUBJECT, optional _REPORT):
 * the recorded operating class, migrated by the real frozen cutover into a disposable native PostgreSQL,
 * then moved onto the task stage ledger.
 *
 *  1. The carry-over must keep exactly what the teacher and every student saw just before it
 *     (the earlier per-cycle read model), for every task and every student.
 *  2. Every ledger command must work on every task of the real class, with the expected effect.
 *  3. Cancelling real rewards from before the ledger must still work (money back).
 * The report holds counts, IDs and stages only — never names.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it, vi, describe } from 'vitest';

vi.mock('server-only', () => ({}));
// Fail loudly if anything reaches the production pool, Sheets or Padlet.
vi.mock('@/server/db/transaction', async original => ({
  ...await original<typeof import('@/server/db/transaction')>(),
  withTenantTransaction: () => { throw Error('Production transaction runner is forbidden in the replay.'); },
  withTenantSnapshot: () => { throw Error('Production snapshot runner is forbidden in the replay.'); },
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsStore: () => { throw Error('Sheets forbidden in the replay.'); },
  createConfiguredSheetsReader: () => { throw Error('Sheets forbidden in the replay.'); },
}));

import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner, type TenantTransaction } from '@/server/db/transaction';
import type { TaskStage } from '@/domain/taskStage';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import { createDatabaseTaskCompletionCommand } from '@/server/repositories/database/taskCompletionCommands';
import { createDatabasePadletClaimRepository } from '@/server/repositories/database/padletClaims';
import { createDatabaseTransactionCommands } from '@/server/repositories/database/transactionCommands';
import { createTaskLedgerCommands } from '@/server/repositories/database/taskLedger/commands';
import { createTaskLedgerReader } from '@/server/repositories/database/taskLedger/compatReader';
import { readTaskLedgerHistory } from '@/server/repositories/database/taskLedger/history';
import { buildStudentTaskProjection } from '@/server/studentTaskProjection';
import { createTaskCompletionRepositoryCreators } from '@/server/repositories/configuredTaskCompletion';
import { createTenantBootstrapper } from '@/server/repositories/database/tenantBootstrap';
import { verifyOperatorObservedGoogleSheetControl } from './googleSourceControl';
import { createFrozenFullPreparation } from './prepareFrozenFullCutover';
import { createFrozenFullCutover, type FrozenCutoverDependencies, type VerifiedRedisNonUse } from './frozenFullCutover';
import type { LegacyFinancialReview } from './legacyFinancialHistory';
import { canonicalJson, sha256 } from './validators';

const GRID = process.env.CRS_OPERATING_REPLAY_GRID;
const suite = process.env.RUN_REAL_POSTGRES === '1' && GRID ? describe : describe.skip;
type Run = <T>(tenantId: string, callback: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
let db: DisposablePostgres;

suite('operating data on the task stage ledger', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres();
    await db.owner.query('GRANT SELECT,INSERT ON legacy_transaction_origins,legacy_task_origins,legacy_full_snapshot_archives,legacy_redis_snapshot_archives,legacy_claim_publications TO app_runtime');
  }, 120_000);
  afterAll(async () => { if (db) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true }); }, 60_000);

  it('carries the operating class over unchanged and runs every ledger command on every task', async () => {
    const gridJson = await readFile(GRID!, 'utf8');
    const spreadsheetId: string = JSON.parse(gridJson).spreadsheetId;
    const financialReview: LegacyFinancialReview | undefined = process.env.CRS_OPERATING_REPLAY_FINANCIAL_REVIEW
      ? JSON.parse(await readFile(process.env.CRS_OPERATING_REPLAY_FINANCIAL_REVIEW, 'utf8')) : undefined;
    const subject = process.env.CRS_OPERATING_REPLAY_SUBJECT ?? (financialReview ? undefined : `replay-owner-${randomUUID()}`);
    if (!subject) throw Error('CRS_OPERATING_REPLAY_SUBJECT is required with a financial review.');
    const email = 'replay-owner@example.invalid';
    const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), recordedGridDigest: sha256(gridJson) };
    const failures: unknown[] = [];
    const writeReport = async () => {
      report.failures = failures;
      if (process.env.CRS_OPERATING_REPLAY_REPORT) await writeFile(process.env.CRS_OPERATING_REPLAY_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    };

    // ---- activation: the same private bootstrap + reviewed frozen cutover as the production move ----
    const now = Date.now();
    const proof = await verifyOperatorObservedGoogleSheetControl({ fileId: spreadsheetId, session: { subject, email, issuedAt: now }, now: () => now,
      readObservation: async () => ({ method: 'OPERATOR_GOOGLE_SHARE_UI', observedAt: now, fileId: spreadsheetId, googleSubject: subject,
        ownerEmail: email, ownerIsSignedInUser: true, role: 'OWNER', generalAccess: 'RESTRICTED', listedPrincipals: 1,
        providerSpreadsheetReadSucceeded: true, evidenceDigest: sha256('synthetic replay operator observation') }) });
    const bootstrap = createTenantBootstrapper({ runTransaction: async callback => {
      const client = await db.owner.connect();
      try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } });
    const target = await bootstrap({ slug: `ledger-replay-${randomUUID()}`, displayName: 'Ledger replay',
      owner: { subject, email }, proof, sourceFingerprint: sha256(gridJson) });
    const getAuthenticatedSubject = async () => subject;
    const redis: VerifiedRedisNonUse = { kind: 'NEVER_USED', sourceIdentityDigest: sha256(spreadsheetId), evidenceDigest: sha256('replay: owner-verified Redis non-use') };
    const intent = await createFrozenFullPreparation({ tenantId: target.tenantId, getAuthenticatedSubject, runMigrationTransaction: db.runTenantTransaction })({
      migrationJobId: target.jobId, expectedStateVersion: '1', sheetsSourceId: target.sourceId, gridJson,
      capturedAt: new Date().toISOString(), redisSourceId: null, redis, ...(financialReview ? { financialReview } : {}) });
    const withFrozenSources: FrozenCutoverDependencies['withFrozenSources'] = async (binding, work) => {
      const startedAt = new Date().toISOString();
      return work({ bindingDigest: sha256(canonicalJson(binding)), fenceDigest: sha256('replay-fence'), writerInventoryDigest: sha256('replay-inventory'),
        startedAt, drainedAt: startedAt, assertHeld: async () => {}, captureFresh: async () => ({ gridJson, capturedAt: new Date().toISOString(), redis }) });
    };
    const receipt = await createFrozenFullCutover({ tenantId: target.tenantId, getAuthenticatedSubject, runMigrationTransaction: db.runTenantTransaction,
      withFrozenSources, ...(financialReview ? { financialReview } : {}) })(intent);
    expect(receipt.status).toBe('ACTIVE');
    const tenantId = target.tenantId;
    const commit: Run = (id, callback) => db.runTenantTransaction(id, callback);
    const snapshot: Run = createTenantTransactionRunner({ pool: db.runtime }, { isolationLevel: 'REPEATABLE READ' });
    const q = async (text: string, values: unknown[] = []) => (await db.owner.query(text, [tenantId, ...values])).rows as Record<string, unknown>[];
    const activeStudents = (await q(`SELECT student_id FROM students WHERE tenant_id=$1 AND status='ACTIVE' AND deleted_at IS NULL ORDER BY student_id`))
      .map((row) => String(row.student_id));

    // ---- 1. what the teacher and the students saw just before the carry-over ----
    const earlier = await createDatabaseTaskCycleQueries({ tenantId, runTenantSnapshot: snapshot })
      .listTaskCycleProjections({ includeInactive: true, adminMutation: true });
    const before = new Map(earlier.map((task) => [task.taskId, new Map(task.currentCycle.students.map((row) => [row.studentId, row.stage as TaskStage]))]));
    const earlierBank = new Map<string, string>();
    for (const studentId of activeStudents) {
      const own = await createDatabaseTaskCycleQueries({ tenantId, runTenantSnapshot: snapshot }).listTaskCycleProjections({ studentId });
      earlierBank.set(studentId, JSON.stringify(buildStudentTaskProjection(own, studentId, new Date().toISOString())
        .map((task) => [task.taskId, task.studentStatus.stage, task.prerequisiteStatus ?? null])));
    }

    const ledger = createTaskLedgerCommands({ tenantId, runTenantTransaction: commit, runTenantSnapshot: snapshot,
      resolveStudentQr: (value) => value });
    const reader = createTaskLedgerReader({ tenantId, runTenantTransaction: commit, runTenantSnapshot: snapshot });
    const board = await ledger.readTasks();
    const carry = { compared: 0, mismatches: [] as unknown[] };
    for (const task of board) {
      const was = before.get(task.taskId);
      for (const studentId of activeStudents) {
        const expected = was?.get(studentId) ?? 'UNASSIGNED';
        const actual = task.students.find((row) => row.studentId === studentId)?.stage ?? 'UNASSIGNED';
        carry.compared += 1;
        if (expected !== actual) carry.mismatches.push({ taskId: task.taskId, studentId, expected, actual });
      }
    }
    const bank = { compared: 0, mismatches: [] as unknown[] };
    for (const studentId of activeStudents) {
      const own = await reader.listTaskCycleProjections({ studentId });
      const now = JSON.stringify(buildStudentTaskProjection(own, studentId, new Date().toISOString())
        .map((task) => [task.taskId, task.studentStatus.stage, task.prerequisiteStatus ?? null]));
      bank.compared += 1;
      if (now !== earlierBank.get(studentId)) bank.mismatches.push({ studentId, before: earlierBank.get(studentId), after: now });
    }
    report.carryOver = { tasks: board.length, ...carry, carriedEvents: (await q(`SELECT result_snapshot->>'carriedEvents' AS n FROM operations
      WHERE tenant_id=$1 AND operation_id='task-ledger:v1'`))[0]?.n };
    report.bankViews = bank;
    report.stagesAfterCarry = Object.fromEntries(board.map((task) => [task.taskId, task.counts]));

    // ---- 4. students complete every task through the bank's own path, chained tasks in order ----
    // The same configured command the bank route runs, including its after-completion task list check.
    const studentBank = await createTaskCompletionRepositoryCreators({
      createDatabasePadletClaimRepository,
      createDatabaseTaskCompletionCommand: createDatabaseTaskCompletionCommand as never,
      createDatabaseTaskQueries: (() => ({})) as never,
      createDatabaseTaskCycleQueries: (() => reader) as never,
      createPadletCompletionEvidenceResolver: (() => async () => { throw Object.assign(new Error('Padlet unavailable in the replay.'), { code: 'PROVIDER_UNAVAILABLE' }); }) as never,
      fetchPadletBoardPosts: (async () => []) as never,
      withTenantTransaction: commit as never,
      withTenantSnapshot: snapshot as never,
      createConfiguredSheetsStore: (async () => { throw Error('Sheets forbidden in the replay.'); }) as never,
      completeTaskForStudent: (async () => { throw Error('Sheets forbidden in the replay.'); }) as never,
      sheetsListTaskCycleProjections: (async () => { throw Error('Sheets forbidden in the replay.'); }) as never,
      buildStudentTaskProjection,
    }).createPostgresql({ tenantId } as never);
    const chainLedger = createTaskLedgerCommands({ tenantId, runTenantTransaction: commit, runTenantSnapshot: snapshot, resolveStudentQr: (value) => value });
    const chainBoard = await chainLedger.readTasks();
    const ordered: typeof chainBoard = [];
    const visit = (task: (typeof chainBoard)[number]) => {
      if (ordered.includes(task)) return;
      const prerequisite = chainBoard.find((other) => other.taskId === task.prerequisiteTaskId);
      if (prerequisite) visit(prerequisite);
      ordered.push(task);
    };
    chainBoard.forEach(visit);
    const boards = new Map((await q('SELECT task_id, padlet_board_id FROM tasks WHERE tenant_id=$1 AND deleted_at IS NULL')).map((row) => [String(row.task_id), row.padlet_board_id]));
    const completable = ordered.filter((task) => task.isActive && !boards.get(task.taskId)
      && (!task.availableFrom || task.availableFrom <= new Date().toISOString()) && (!task.dueAt || task.dueAt > new Date().toISOString()));
    const chain = { completions: 0, failures: [] as unknown[] };
    const studentComplete = async (taskId: string, studentId: string, label: string) => {
      const balance = Number((await q('SELECT balance::text AS b FROM accounts WHERE tenant_id=$1 AND student_id=$2', [studentId]))[0].b);
      const reward = chainBoard.find((task) => task.taskId === taskId)!.reward;
      try {
        const result = await studentBank.execute({ requestId: randomUUID(), operationId: randomUUID(), taskId, studentId });
        const after = Number((await q('SELECT balance::text AS b FROM accounts WHERE tenant_id=$1 AND student_id=$2', [studentId]))[0].b);
        chain.completions += 1;
        if (result.tasks.find((task) => task.taskId === taskId)?.studentStatus.stage !== 'COMPLETED' || after !== balance + reward) {
          chain.failures.push({ taskId, studentId, label, error: 'unexpected effect' });
        }
      } catch (error) {
        const stored = (await q(`SELECT count(*)::text AS n FROM task_completions WHERE tenant_id=$1 AND task_id_snapshot=$2 AND student_id=$3 AND source='BANK'`, [taskId, studentId]))[0].n;
        chain.failures.push({ taskId, studentId, label, error: String(error), code: (error as { code?: unknown }).code, bankRows: stored });
      }
    };
    for (const studentId of activeStudents) {
      for (const task of completable) {
        await chainLedger.setStages({ operationId: randomUUID(), changes: [{ taskId: task.taskId, studentId, stage: 'READY' }] });
        await studentComplete(task.taskId, studentId, 'first');
      }
      // The teacher moves 완료 back to 완료 가능 and the student completes again, chain heads first.
      for (const task of completable) {
        await chainLedger.setStages({ operationId: randomUUID(), changes: [{ taskId: task.taskId, studentId, stage: 'READY' }] });
        await studentComplete(task.taskId, studentId, 'again');
      }
    }
    report.studentBankChain = { tasks: completable.map((task) => task.taskId), ...chain };
    for (const failure of chain.failures) failures.push({ step: 'student-bank-chain', ...(failure as object) });

    // ---- 3. a real reward from before the ledger can still be cancelled ----
    const legacyRewards = await q(`SELECT t.transaction_id, t.student_id FROM transactions t
      WHERE t.tenant_id=$1 AND t.kind IN ('TASK_REWARD','LEGACY') AND t.balance_delta > 0
        AND EXISTS (SELECT 1 FROM task_completions c WHERE c.tenant_id=t.tenant_id AND c.transaction_id=t.transaction_id)
        AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.tenant_id=t.tenant_id AND r.reverses_transaction_id=t.transaction_id)
      ORDER BY t.event_sequence DESC LIMIT 3`);
    const transactions = createDatabaseTransactionCommands({ tenantId, runTenantTransaction: commit });
    const cancellations: unknown[] = [];
    for (const reward of legacyRewards) {
      try {
        const result = await transactions.cancel({ operationId: randomUUID(), transactionId: String(reward.transaction_id) });
        cancellations.push({ transactionId: reward.transaction_id, ok: true, reversal: result.reversalAmount });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        // A malformed legacy row is refused for manual reconciliation, as before; anything else is a failure.
        cancellations.push({ transactionId: reward.transaction_id, ok: false, code: code ?? (error as Error).message });
        if (code !== 'MANUAL_RECONCILIATION_REQUIRED') failures.push({ step: 'legacy-reward-cancel', transactionId: reward.transaction_id, error: String(error) });
      }
    }
    report.legacyRewardCancellations = cancellations;

    // ---- 2. every ledger command on every task of the real class ----
    const stageOf = async (taskId: string, studentId: string) =>
      (await ledger.readTasks([taskId]))[0]?.students.find((row) => row.studentId === studentId)?.stage ?? 'UNASSIGNED';
    const balanceOf = async (studentId: string) => Number((await q('SELECT balance::text AS b FROM accounts WHERE tenant_id=$1 AND student_id=$2', [studentId]))[0].b);
    const bankCommand = createDatabaseTaskCompletionCommand({ tenantId, runTenantTransaction: commit, padletClaims: createDatabasePadletClaimRepository(),
      resolvePadletEvidence: async () => { throw Object.assign(new Error('Padlet unavailable in the replay.'), { code: 'PROVIDER_UNAVAILABLE' }); } });
    const outcomes: Array<Record<string, unknown>> = [];
    const step = async (taskId: string, name: string, run: () => Promise<unknown>, check?: () => Promise<boolean>) => {
      try {
        await run();
        const ok = check ? await check() : true;
        outcomes.push({ taskId, step: name, ok });
        if (!ok) failures.push({ taskId, step: name, error: 'unexpected effect' });
      } catch (error) {
        outcomes.push({ taskId, step: name, ok: false, error: String(error) });
        failures.push({ taskId, step: name, error: String(error) });
      }
    };
    const pick = activeStudents[0];
    for (const task of board) {
      const taskId = task.taskId;
      const studentId = task.students.find((row) => row.stage !== 'UNASSIGNED' && activeStudents.includes(row.studentId))?.studentId ?? pick;
      for (const stage of ['PENDING', 'READY', 'COMPLETED', 'READY', 'UNASSIGNED', 'COMPLETED', 'PENDING'] as const) {
        await step(taskId, `stage→${stage}`, () => ledger.setStages({ operationId: randomUUID(), changes: [{ taskId, studentId, stage }] }),
          async () => await stageOf(taskId, studentId) === stage);
      }
      await step(taskId, 'stage→READY', () => ledger.setStages({ operationId: randomUUID(), changes: [{ taskId, studentId, stage: 'READY' }] }),
        async () => await stageOf(taskId, studentId) === 'READY');
      const bankable = task.isActive && !task.availableFrom && !task.dueAt && task.reward > 0 && !task.prerequisiteTaskId;
      if (bankable && !(await q('SELECT padlet_board_id FROM tasks WHERE tenant_id=$1 AND task_id=$2 AND deleted_at IS NULL', [taskId]))[0]?.padlet_board_id) {
        const balance = await balanceOf(studentId);
        await step(taskId, 'bank-complete', () => bankCommand.execute({ operationId: randomUUID(), taskId, studentId }),
          async () => await stageOf(taskId, studentId) === 'COMPLETED' && await balanceOf(studentId) === balance + task.reward);
        await step(taskId, 'stage→READY again', () => ledger.setStages({ operationId: randomUUID(), changes: [{ taskId, studentId, stage: 'READY' }] }));
        const paidBefore = await balanceOf(studentId);
        await step(taskId, 'teacher-paid-complete', () => ledger.setStages({ operationId: randomUUID(), changes: [{ taskId, studentId, stage: 'COMPLETED', withReward: true }] }),
          async () => await balanceOf(studentId) === paidBefore + task.reward);
        const paid = (await q(`SELECT transaction_id FROM task_completions WHERE tenant_id=$1 AND task_id_snapshot=$2 AND student_id=$3
          AND note='teacher-completion-reward' ORDER BY event_sequence DESC LIMIT 1`, [taskId, studentId]))[0]?.transaction_id;
        if (paid) {
          await step(taskId, 'cancel-teacher-reward', () => transactions.cancel({ operationId: randomUUID(), transactionId: String(paid) }),
            async () => await balanceOf(studentId) === paidBefore && await stageOf(taskId, studentId) === 'READY');
        }
      }
      await step(taskId, 'reset→READY', () => ledger.resetTasks({ operationId: randomUUID(), taskIds: [taskId], stage: 'READY' }),
        async () => (await ledger.readTasks([taskId]))[0].students.every((row) => row.stage === 'UNASSIGNED' || row.stage === 'READY'));
      await step(taskId, 'repeat DAILY→PENDING', () => ledger.setRepeat({ operationId: randomUUID(), taskIds: [taskId],
        repeat: { recurrence: { type: 'DAILY', time: '09:00' }, resetStage: 'PENDING' } }),
      async () => (await ledger.readTasks([taskId]))[0].repeat.resetStage === 'PENDING');
      await step(taskId, 'repeat NONE', () => ledger.setRepeat({ operationId: randomUUID(), taskIds: [taskId], repeat: { recurrence: { type: 'NONE' }, resetStage: null } }));
      await step(taskId, 'qr→PENDING', () => ledger.qrStage({ operationId: randomUUID(), taskId, studentQr: pick, stage: 'PENDING' }),
        async () => await stageOf(taskId, pick) === 'PENDING');
      await step(taskId, 'rename', () => ledger.updateTask(taskId, { operationId: randomUUID(), task: { title: `${task.title} (replay)`, description: task.description,
        reward: task.reward, isActive: task.isActive, sortOrder: task.sortOrder, availableFrom: task.availableFrom, dueAt: task.dueAt,
        prerequisiteTaskId: task.prerequisiteTaskId } }));
      await step(taskId, 'history', () => commit(tenantId, (tx) => readTaskLedgerHistory(tx, tenantId, taskId)));
    }
    const deletable = board.find((task) => !board.some((other) => other.prerequisiteTaskId === task.taskId)) ?? board[0];
    if (deletable) {
      await step(deletable.taskId, 'delete', () => ledger.deleteTasks({ operationId: randomUUID(), taskIds: [deletable.taskId] }),
        async () => !(await ledger.readTasks()).some((task) => task.taskId === deletable.taskId));
    }
    report.outcomes = { total: outcomes.length, ok: outcomes.filter((outcome) => outcome.ok).length, steps: outcomes };
    await writeReport();
    expect(carry.mismatches).toEqual([]);
    expect(bank.mismatches).toEqual([]);
    expect(failures).toEqual([]);
  }, 1_800_000);
});
