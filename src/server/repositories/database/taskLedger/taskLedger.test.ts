// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { createDatabasePadletClaimRepository } from '../padletClaims';
import { createDatabaseTaskCompletionCommand, TaskRewardCommandError } from '../taskCompletionCommands';
import { createDatabaseTransactionCommands } from '../transactionCommands';
import { createTaskLedgerCommands } from './commands';
import { createTaskLedgerReader } from './compatReader';
import { readTaskLedgerHistory } from './history';
import { TaskLedgerError } from './store';
import { createTaskCompletionRepositoryCreators, parseConfiguredTaskCompletionResult } from '@/server/repositories/configuredTaskCompletion';
import { buildStudentTaskProjection } from '@/server/studentTaskProjection';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;
let tenantId: string;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  for (const name of (await readdir(resolve(process.cwd(), 'src/server/db/migrations'))).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', name), 'utf8'));
  }
  await harness.database.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;`);
  tenantId = harness.tenantOneId;
  await harness.database.query(`INSERT INTO students (tenant_id, student_id, name, status) VALUES
    ($1,'S1','김민준','ACTIVE'),($1,'S2','이서연','ACTIVE'),($1,'S3','박지후','ACTIVE')`, [tenantId]);
  await harness.database.query(`INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1,'S1',100),($1,'S2',100),($1,'S3',100)`, [tenantId]);
}, 120_000);
afterEach(async () => { await harness?.close(); });

const commands = () => createTaskLedgerCommands({
  tenantId, runTenantTransaction: harness.runTenantTransaction, resolveStudentQr: (value) => value.replace(/^qr:/, ''),
});
const op = () => randomUUID();
const stageMap = (task: AdminTaskDto) => Object.fromEntries(task.students.map((row) => [row.studentId, row.stage]));
const board = async () => (await commands().readTasks());
const definition = (title: string, extra: Partial<AdminTaskDto> = {}) => ({ title, description: '', reward: 30, isActive: true, sortOrder: 0,
  availableFrom: null, dueAt: null, prerequisiteTaskId: null, ...extra });
const balance = async (studentId: string) => Number((await harness.database.query<{ balance: string }>(
  'SELECT balance::text AS balance FROM accounts WHERE tenant_id=$1 AND student_id=$2', [tenantId, studentId])).rows[0].balance);

async function createTask(students: Array<{ studentId: string; stage: 'UNASSIGNED' | 'PENDING' | 'READY' | 'COMPLETED' }>, title = '책 읽기') {
  return commands().createTask({ operationId: op(), task: definition(title), repeat: { recurrence: { type: 'NONE' }, resetStage: null }, students });
}

describe('task ledger: carry-over of earlier progress', () => {
  it('starts every class from exactly the stages the earlier model showed, once', async () => {
    await harness.database.query(`INSERT INTO tasks (tenant_id, task_instance_id, task_id, title, description, reward, current_schedule, created_at, updated_at)
      VALUES ($1,'legacy-t1','T001','예전 과제','',10,$2::jsonb,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`, [tenantId,
      JSON.stringify({ ruleVersion: 1, effectiveFrom: '2026-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' },
        resetCompletionOnCycle: false, resetAssignmentOnCycle: false })]);
    await harness.database.query(`INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id) VALUES ($1,'legacy-t1','S1'),($1,'legacy-t1','S2')`, [tenantId]);

    const first = await board();
    expect(stageMap(first[0])).toEqual({ S1: 'READY', S2: 'READY', S3: 'UNASSIGNED' });
    const marker = await harness.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM operations WHERE operation_id='task-ledger:v1'`);
    expect(marker.rows[0].count).toBe('1');
    const carried = await harness.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM task_assignments WHERE source='CARRY_FORWARD'`);
    expect(carried.rows[0].count).toBe('2');
    await board();
    expect((await harness.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM task_assignments`)).rows[0].count).toBe('2');
  }, 120_000);
});

describe('task ledger: stages', () => {
  it('moves students freely between all four stages, including back from 완료', async () => {
    const task = await createTask([{ studentId: 'S1', stage: 'READY' }, { studentId: 'S2', stage: 'PENDING' }]);
    expect(task.taskId).toBe('T001');
    expect(stageMap(task)).toEqual({ S1: 'READY', S2: 'PENDING', S3: 'UNASSIGNED' });
    expect(task.counts).toEqual({ UNASSIGNED: 1, PENDING: 1, READY: 1, COMPLETED: 0 });

    let [saved] = (await commands().setStages({ operationId: op(), changes: [
      { taskId: 'T001', studentId: 'S1', stage: 'COMPLETED' }, { taskId: 'T001', studentId: 'S2', stage: 'READY' },
      { taskId: 'T001', studentId: 'S3', stage: 'UNASSIGNED' }] })).tasks;
    expect(stageMap(saved)).toEqual({ S1: 'COMPLETED', S2: 'READY', S3: 'UNASSIGNED' });
    expect(await balance('S1')).toBe(100);

    [saved] = (await commands().setStages({ operationId: op(), changes: [{ taskId: 'T001', studentId: 'S1', stage: 'PENDING' }] })).tasks;
    expect(stageMap(saved).S1).toBe('PENDING');
    [saved] = (await commands().setStages({ operationId: op(), changes: [{ taskId: 'T001', studentId: 'S1', stage: 'UNASSIGNED' }] })).tasks;
    expect(stageMap(saved).S1).toBe('UNASSIGNED');
    // Saving the same stages again writes nothing.
    const before = (await harness.database.query<{ count: string }>('SELECT count(*)::text AS count FROM task_assignments')).rows[0].count;
    await commands().setStages({ operationId: op(), changes: [{ taskId: 'T001', studentId: 'S1', stage: 'UNASSIGNED' }] });
    expect((await harness.database.query<{ count: string }>('SELECT count(*)::text AS count FROM task_assignments')).rows[0].count).toBe(before);
  }, 120_000);

  it('replays the same request without writing twice and refuses a different body with the same ID', async () => {
    await createTask([{ studentId: 'S1', stage: 'READY' }]);
    const request = { operationId: op(), changes: [{ taskId: 'T001', studentId: 'S2', stage: 'PENDING' as const }] };
    await commands().setStages(request);
    await commands().setStages(request);
    expect((await harness.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM task_assignments WHERE student_id='S2'`)).rows[0].count).toBe('1');
    await expect(commands().setStages({ ...request, changes: [{ taskId: 'T001', studentId: 'S2', stage: 'READY' }] }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  }, 120_000);

  it('pays the reward only when asked, and the paid reward cancels from 거래 내역 like a bank one', async () => {
    await createTask([{ studentId: 'S1', stage: 'READY' }]);
    const [task] = (await commands().setStages({ operationId: op(), changes: [{ taskId: 'T001', studentId: 'S1', stage: 'COMPLETED', withReward: true }] })).tasks;
    expect(stageMap(task).S1).toBe('COMPLETED');
    expect(await balance('S1')).toBe(130);
    const reward = await harness.database.query<{ transaction_id: string }>(`SELECT transaction_id FROM transactions WHERE kind='TASK_REWARD'`);
    expect(reward.rows).toHaveLength(1);

    await createDatabaseTransactionCommands({ tenantId, runTenantTransaction: harness.runTenantTransaction })
      .cancel({ operationId: op(), transactionId: reward.rows[0].transaction_id });
    expect(await balance('S1')).toBe(100);
    expect(stageMap((await board())[0]).S1).toBe('READY');
  }, 120_000);

  it('refuses unknown tasks and students as a plain failure', async () => {
    await createTask([]);
    await expect(commands().setStages({ operationId: op(), changes: [{ taskId: 'NOPE', studentId: 'S1', stage: 'READY' }] }))
      .rejects.toBeInstanceOf(TaskLedgerError);
    await expect(commands().setStages({ operationId: op(), changes: [{ taskId: 'T001', studentId: 'NOPE', stage: 'READY' }] }))
      .rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
  }, 120_000);
});

describe('task ledger: bank completion', () => {
  const bank = () => createDatabaseTaskCompletionCommand({ tenantId, runTenantTransaction: harness.runTenantTransaction,
    padletClaims: createDatabasePadletClaimRepository() });

  it('lets only 완료 가능 students complete, pays once, and the reward cancels back to 완료 가능', async () => {
    await createTask([{ studentId: 'S1', stage: 'READY' }, { studentId: 'S2', stage: 'PENDING' }]);
    await expect(bank().execute({ operationId: op(), taskId: 'T001', studentId: 'S2' })).rejects.toMatchObject({ code: 'NOT_READY' });
    await expect(bank().execute({ operationId: op(), taskId: 'T001', studentId: 'S3' })).rejects.toBeInstanceOf(TaskRewardCommandError);

    const operationId = op();
    const result = await bank().execute({ operationId, taskId: 'T001', studentId: 'S1' });
    expect(result).toMatchObject({ reward: 30, balanceBefore: 100, balanceAfter: 130 });
    expect(await bank().execute({ operationId, taskId: 'T001', studentId: 'S1' })).toEqual(result);
    expect(await balance('S1')).toBe(130);
    expect(stageMap((await board())[0]).S1).toBe('COMPLETED');
    await expect(bank().execute({ operationId: op(), taskId: 'T001', studentId: 'S1' })).rejects.toMatchObject({ code: 'POLICY' });

    // A teacher can make it completable again; the student completes and is paid again.
    await commands().setStages({ operationId: op(), changes: [{ taskId: 'T001', studentId: 'S1', stage: 'READY' }] });
    await bank().execute({ operationId: op(), taskId: 'T001', studentId: 'S1' });
    expect(await balance('S1')).toBe(160);

    await createDatabaseTransactionCommands({ tenantId, runTenantTransaction: harness.runTenantTransaction })
      .cancel({ operationId: op(), transactionId: result.transactionId });
    // The first reward is no longer what the stage stands on: money back, stage stays 완료.
    expect(await balance('S1')).toBe(130);
    expect(stageMap((await board())[0]).S1).toBe('COMPLETED');
  }, 120_000);

  it('feeds the student bank projection with the same stages', async () => {
    await createTask([{ studentId: 'S1', stage: 'READY' }, { studentId: 'S2', stage: 'PENDING' }]);
    const reader = createTaskLedgerReader({ tenantId, runTenantTransaction: harness.runTenantTransaction, runTenantSnapshot: harness.runTenantTransaction });
    const [own] = await reader.listTaskCycleProjections({ studentId: 'S2' });
    expect(own.studentStatus).toMatchObject({ studentId: 'S2', assigned: true, ready: false, completed: false, stage: 'PENDING' });
    // A student's projection carries only that student.
    expect(own.currentCycle.students.map((row) => row.studentId)).toEqual(['S2']);
    const [all] = await reader.listTaskCycleProjections({ includeInactive: true });
    expect(all.currentCycle.readyStudentIds).toEqual(['S1']);
  }, 120_000);
  // The bank route runs this configured command; it checks the task list it returns after paying.
  const studentBank = (build = buildStudentTaskProjection) => createTaskCompletionRepositoryCreators({
    createDatabasePadletClaimRepository,
    createDatabaseTaskCompletionCommand: createDatabaseTaskCompletionCommand as never,
    createDatabaseTaskQueries: (() => ({})) as never,
    createDatabaseTaskCycleQueries: (() => createTaskLedgerReader({ tenantId, runTenantTransaction: harness.runTenantTransaction,
      runTenantSnapshot: harness.runTenantTransaction })) as never,
    createPadletCompletionEvidenceResolver: (() => async () => { throw new Error('no Padlet here'); }) as never,
    fetchPadletBoardPosts: (async () => []) as never,
    withTenantTransaction: harness.runTenantTransaction as never,
    withTenantSnapshot: harness.runTenantTransaction as never,
    createConfiguredSheetsStore: (async () => { throw new Error('no Sheets here'); }) as never,
    completeTaskForStudent: (async () => { throw new Error('no Sheets here'); }) as never,
    sheetsListTaskCycleProjections: (async () => { throw new Error('no Sheets here'); }) as never,
    buildStudentTaskProjection: build,
  }).createPostgresql({ tenantId } as never);
  const studentComplete = async (taskId: string, build?: typeof buildStudentTaskProjection) => (await studentBank(build))
    .execute({ requestId: op(), operationId: op(), taskId, studentId: 'S1' });

  it('completes chained tasks with start times through the student bank, again after 완료 → 완료 가능', async () => {
    const commandsWithDates = commands();
    await commandsWithDates.createTask({ operationId: op(), task: definition('지정 번호', { availableFrom: '2026-01-01T00:00:00.123Z' }),
      repeat: { recurrence: { type: 'WEEKLY', weekdays: [1], time: '00:00' }, resetStage: 'READY' }, students: [{ studentId: 'S1', stage: 'READY' }] });
    await commandsWithDates.createTask({ operationId: op(), task: definition('자유 1', { availableFrom: '2026-01-01T00:00:00Z', prerequisiteTaskId: 'T001' }),
      repeat: { recurrence: { type: 'WEEKLY', weekdays: [1], time: '00:00' }, resetStage: 'READY' }, students: [{ studentId: 'S1', stage: 'READY' }] });

    const first = await studentComplete('T001');
    expect(first.tasks.map((task) => [task.taskId, task.studentStatus.stage, task.availableFrom])).toEqual([
      ['T001', 'COMPLETED', '2026-01-01T00:00:00.123Z'], ['T002', 'READY', '2026-01-01T00:00:00.000Z']]);
    // The teacher puts 지정 번호 back to 완료 가능; the student completes it again, then the next task.
    await commandsWithDates.setStages({ operationId: op(), changes: [{ taskId: 'T001', studentId: 'S1', stage: 'READY' }] });
    expect((await studentComplete('T001')).tasks.find((task) => task.taskId === 'T001')?.studentStatus.stage).toBe('COMPLETED');
    expect((await studentComplete('T002')).tasks.find((task) => task.taskId === 'T002')?.studentStatus.stage).toBe('COMPLETED');
    expect(await balance('S1')).toBe(190);
    // Times leave the server in the standard form.
    const [saved] = await board();
    expect(saved).toMatchObject({ availableFrom: '2026-01-01T00:00:00.123Z' });
    expect(saved.createdAt).toBe(new Date(saved.createdAt).toISOString());
    expect(saved.students.every((row) => row.since === null || row.since === new Date(row.since).toISOString())).toBe(true);
  }, 120_000);

  it('reports a paid completion as done even when the task list after it cannot be built', async () => {
    await createTask([{ studentId: 'S1', stage: 'READY' }]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await studentComplete('T001', () => { throw new Error('list unavailable'); });
    expect(result).toMatchObject({ task: { taskId: 'T001', reward: 30 }, tasks: [], operation: { state: 'SUCCESS' } });
    expect(parseConfiguredTaskCompletionResult(result, { taskId: 'T001', studentId: 'S1', operationId: result.operation.operationId }).tasks).toEqual([]);
    expect(errors).toHaveBeenCalledWith('[task-completion] task list after a committed completion could not be built', 'T001', 'list unavailable');
    errors.mockRestore();
    expect(await balance('S1')).toBe(130);
  }, 120_000);
});

describe('task ledger: reset, repeat, QR, delete, history', () => {
  it('resets everyone who has the task to the chosen stage now, leaving 미부여 alone', async () => {
    await createTask([{ studentId: 'S1', stage: 'COMPLETED' }, { studentId: 'S2', stage: 'PENDING' }]);
    const [task] = (await commands().resetTasks({ operationId: op(), taskIds: ['T001'], stage: 'READY' })).tasks;
    expect(stageMap(task)).toEqual({ S1: 'READY', S2: 'READY', S3: 'UNASSIGNED' });
  }, 120_000);

  it('applies automatic resets of a schedule and keeps them when the schedule changes', async () => {
    const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();
    // A class whose ledger started five days ago, with a daily 09:00 reset to 완료 가능.
    await harness.database.query(`INSERT INTO operations (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
      started_at, finished_at, created_at, updated_at) VALUES ($1,'task-ledger:v1','TASK_ADMIN',$2,'SUCCEEDED',$3::jsonb,$4,$4,$4,$4)`,
    [tenantId, 'a'.repeat(64), JSON.stringify({ ledgerFrom: ago(5) }), ago(5)]);
    await harness.database.query(`INSERT INTO tasks (tenant_id, task_instance_id, task_id, title, description, reward, current_schedule, created_at, updated_at)
      VALUES ($1,'daily','T001','일기','',10,$2::jsonb,$3,$3)`, [tenantId, JSON.stringify({ ruleVersion: 1, effectiveFrom: ago(5),
      timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: true, resetAssignmentOnCycle: false,
      resetStage: 'READY' }), ago(5)]);
    const row = (id: string, student: string, type: string, note: string | null, at: string) => harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at, rule_version, timezone, student_id, event_type, source, created_at, note)
      VALUES ($1,$2,'T001','daily','ledger','1970-01-01T00:00:00Z',1,'Asia/Seoul',$3,$4,'CARRY_FORWARD',$5,$6)`, [tenantId, id, student, type, at, note]);
    await row('a1', 'S1', 'ASSIGNED', null, ago(4));
    await row('a2', 'S2', 'ASSIGNED', 'stage:pending', ago(4));
    await row('a3', 'S3', 'UNASSIGNED', null, ago(4));

    let [task] = await board();
    expect(stageMap(task)).toEqual({ S1: 'READY', S2: 'READY', S3: 'UNASSIGNED' });
    expect(task.students.find((entry) => entry.studentId === 'S2')).toMatchObject({ byReset: true });
    expect(task.repeat.lastResetAt).not.toBeNull();

    // Turning the repeat off keeps what the resets did, as events at the reset's own time.
    [task] = (await commands().setRepeat({ operationId: op(), taskIds: ['T001'], repeat: { recurrence: { type: 'NONE' }, resetStage: null } })).tasks;
    expect(stageMap(task)).toEqual({ S1: 'READY', S2: 'READY', S3: 'UNASSIGNED' });
    expect(task.students.find((entry) => entry.studentId === 'S2')).toMatchObject({ byReset: false });
    const history = await harness.runTenantTransaction(tenantId, (tx) => readTaskLedgerHistory(tx, tenantId, 'T001'));
    expect(history.entries.filter((entry) => entry.cause === 'AUTO_RESET').map((entry) => [entry.studentName, entry.previousStage, entry.stage]))
      .toEqual([['이서연', 'PENDING', 'READY']]);
  }, 120_000);

  it('sets the repeat setting with the stage to reset to and shows the next reset', async () => {
    await createTask([{ studentId: 'S1', stage: 'READY' }]);
    const [task] = (await commands().setRepeat({ operationId: op(), taskIds: ['T001'],
      repeat: { recurrence: { type: 'WEEKLY', weekdays: [1, 3], time: '08:30' }, resetStage: 'PENDING' } })).tasks;
    expect(task.repeat).toMatchObject({ recurrence: { type: 'WEEKLY', weekdays: [1, 3], time: '08:30' }, resetStage: 'PENDING' });
    expect(task.repeat.nextResetAt).not.toBeNull();
    const [none] = (await commands().setRepeat({ operationId: op(), taskIds: ['T001'], repeat: { recurrence: { type: 'NONE' }, resetStage: null } })).tasks;
    expect(none.repeat).toMatchObject({ recurrence: { type: 'NONE' }, resetStage: null, nextResetAt: null });
  }, 120_000);

  it('puts a scanned student at the chosen stage and says when nothing changed', async () => {
    await createTask([]);
    const first = await commands().qrStage({ operationId: op(), taskId: 'T001', studentQr: 'qr:S2', stage: 'PENDING' });
    expect(first).toMatchObject({ student: { studentId: 'S2', name: '이서연' }, previousStage: 'UNASSIGNED', stage: 'PENDING', changed: true });
    const again = await commands().qrStage({ operationId: op(), taskId: 'T001', studentQr: 'qr:S2', stage: 'PENDING' });
    expect(again).toMatchObject({ previousStage: 'PENDING', stage: 'PENDING', changed: false });
    await expect(commands().qrStage({ operationId: op(), taskId: 'T001', studentQr: 'qr:NOPE', stage: 'PENDING' }))
      .rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
  }, 120_000);

  it('deletes tasks and drops them as a prerequisite of others', async () => {
    await createTask([], '먼저');
    await commands().createTask({ operationId: op(), task: definition('나중', { prerequisiteTaskId: 'T001' }), repeat: { recurrence: { type: 'NONE' }, resetStage: null } });
    expect((await board()).find((task) => task.taskId === 'T002')?.prerequisiteTaskId).toBe('T001');
    expect(await commands().deleteTasks({ operationId: op(), taskIds: ['T001'] })).toEqual({ deletedTaskIds: ['T001'] });
    const tasks = await board();
    expect(tasks.map((task) => task.taskId)).toEqual(['T002']);
    expect(tasks[0].prerequisiteTaskId).toBeNull();
    await expect(commands().updateTask('T002', { operationId: op(), task: definition('나중', { prerequisiteTaskId: 'T002' }) }))
      .rejects.toMatchObject({ code: 'PREREQUISITE_SELF' });
  }, 120_000);

  it('tells the history in names and causes, newest first', async () => {
    await createTask([{ studentId: 'S1', stage: 'PENDING' }]);
    await commands().qrStage({ operationId: op(), taskId: 'T001', studentQr: 'qr:S1', stage: 'READY' });
    await createDatabaseTaskCompletionCommand({ tenantId, runTenantTransaction: harness.runTenantTransaction,
      padletClaims: createDatabasePadletClaimRepository() }).execute({ operationId: op(), taskId: 'T001', studentId: 'S1' });
    const history = await harness.runTenantTransaction(tenantId, (tx) => readTaskLedgerHistory(tx, tenantId, 'T001'));
    expect(history.entries.map((entry) => [entry.studentName, entry.previousStage, entry.stage, entry.cause, entry.reward])).toEqual([
      ['김민준', 'READY', 'COMPLETED', 'BANK', 30],
      ['김민준', 'PENDING', 'READY', 'QR', null],
      ['김민준', 'UNASSIGNED', 'PENDING', 'TEACHER', null],
    ]);
  }, 120_000);
});
