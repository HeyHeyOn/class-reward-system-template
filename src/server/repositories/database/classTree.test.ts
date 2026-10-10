import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLASS_TREE_SETTINGS, classTreeGoal, type ClassTreeSettings } from '@/domain/classTree';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { ClassTreeError, addTaskTreeDrops, createClassTreeCommands, revokeTreeDropsForTransaction } from './classTree';
import { createStudentBagCommands } from './studentBag';
import { createDatabaseTransactionCommands } from './transactionCommands';
import { createDatabaseTransactionQueries } from './transactionQueries';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;
let sequence = 0;
const op = () => `50000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const ON: ClassTreeSettings = { ...DEFAULT_CLASS_TREE_SETTINGS, enabled: true };

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const file of ['0044_class_tree.sql', '0045_student_bag.sql', '0046_vouchers.sql', '0047_tree_name.sql']) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', file), 'utf8'));
  }
  await harness.database.exec('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime');
  await harness.database.exec('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime');
  await seedStudent(harness.tenantOneId, 'S001', '김민준', 100);
  await seedStudent(harness.tenantOneId, 'S002', '이서준', 5);
  await seedStudent(harness.tenantOneId, 'S003', '박하은', 0);
  await seedStudent(harness.tenantTwoId, 'S001', '다른반', 900);
  await harness.database.query(`INSERT INTO products (tenant_id, product_id, name, price, stock, is_active, sort_order) VALUES ($1, 'P010', '초코 과자', 500, 3, false, 1)`, [harness.tenantOneId]);
});

afterEach(async () => harness?.close());

async function seedStudent(tenantId: string, studentId: string, name: string, balance: number) {
  await harness.database.query(`INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, $2, $3, 'ACTIVE')`, [tenantId, studentId, name]);
  await harness.database.query(`INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1, $2, $3)`, [tenantId, studentId, balance]);
}

const tree = (tenantId = harness.tenantOneId) => createClassTreeCommands({ tenantId, runTenantTransaction: harness.runTenantTransaction });

async function balance(studentId: string): Promise<number> {
  const result = await harness.database.query<{ balance: string }>(`SELECT balance::text AS balance FROM accounts WHERE tenant_id=$1 AND student_id=$2`, [harness.tenantOneId, studentId]);
  return Number(result.rows[0].balance);
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClassTreeError) return error.code;
    throw error;
  }
  throw new Error('expected a class tree refusal');
}

describe('class tree settings', () => {
  it('stays off until the teacher turns it on, then plants tree No. 1 for the class size', async () => {
    expect((await tree().adminBoard()).tree).toBeNull();
    expect(await failure(tree().water({ studentId: 'S001', operationId: op() }))).toBe('TREE_OFF');

    const board = await tree().saveSettings(ON);
    expect(board.settings.enabled).toBe(true);
    expect(board.activeStudents).toBe(3);
    // 3 students × (2 waterings + 1 task) a day × 5 days × 4 weeks
    expect(board.tree).toMatchObject({ treeNo: 1, drops: 0, goal: 180 });
    expect(classTreeGoal(ON, 3)).toBe(180);
  });

  it('keeps the name the class gives its tree', async () => {
    expect((await tree().adminBoard()).settings.treeName).toBe('사과나무');
    await tree().saveSettings({ ...ON, treeName: '햇살 나무' });
    expect((await tree().adminBoard()).settings.treeName).toBe('햇살 나무');
    expect((await tree().studentView('S001')).treeName).toBe('햇살 나무');
  });

  it('moves the growing goal only when what the goal depends on changes', async () => {
    await tree().saveSettings(ON);
    expect((await tree().saveSettings({ ...ON, rewardAmount: 5 })).tree?.goal).toBe(180);
    expect((await tree().saveSettings({ ...ON, rewardAmount: 5, goalOverride: 7 })).tree?.goal).toBe(7);
  });
});

describe('watering', () => {
  it('charges the price once, adds one drop, and repeats the stored result for the same operation', async () => {
    await tree().saveSettings(ON);
    const operationId = op();
    const first = await tree().water({ studentId: 'S001', operationId });
    expect(first).toMatchObject({ ok: true, treeNo: 1, drops: 1, price: 10, balanceAfter: 90, myWaterToday: 1, ready: false });
    expect(await tree().water({ studentId: 'S001', operationId })).toEqual(first);
    expect(await balance('S001')).toBe(90);
    expect(await failure(tree().water({ studentId: 'S002', operationId }))).toBe('OPERATION_CONFLICT');

    const history = await createDatabaseTransactionQueries({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction }).getTransactions();
    expect(history).toEqual([expect.objectContaining({ studentId: 'S001', totalAmount: 10, balanceBefore: 100, balanceAfter: 90, status: 'TREE_WATER', items: [] })]);
  });

  it('keeps to the daily limit and the balance', async () => {
    await tree().saveSettings(ON);
    await tree().water({ studentId: 'S001', operationId: op() });
    await tree().water({ studentId: 'S001', operationId: op() });
    expect(await failure(tree().water({ studentId: 'S001', operationId: op() }))).toBe('DAILY_LIMIT');
    expect(await failure(tree().water({ studentId: 'S002', operationId: op() }))).toBe('NOT_ENOUGH_MONEY');
    expect(await balance('S002')).toBe(5);

    const view = await tree().studentView('S001');
    expect(view).toMatchObject({ enabled: true, apples: 3, myWaterToday: 2, waterDailyLimit: 2, waterersToday: 1, tree: { drops: 2 } });
    expect((await tree().studentView('S003')).myWaterToday).toBe(0);
  });

  it('is free when the price is 0 and writes no money record', async () => {
    await tree().saveSettings({ ...ON, waterPrice: 0 });
    expect(await tree().water({ studentId: 'S003', operationId: op() })).toMatchObject({ drops: 1, price: 0, balanceAfter: 0 });
    const transactions = await harness.database.query(`SELECT 1 FROM transactions WHERE tenant_id=$1`, [harness.tenantOneId]);
    expect(transactions.rows).toHaveLength(0);
  });

  it('gives the money and the drop back when the teacher cancels a watering', async () => {
    await tree().saveSettings(ON);
    await tree().water({ studentId: 'S001', operationId: op() });
    const cancellation = await createDatabaseTransactionCommands({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction })
      .cancel({ operationId: op(), transactionId: `tree-water:50000000-0000-4000-8000-${String(sequence - 1).padStart(12, '0')}` });
    expect(cancellation).toMatchObject({ originalKind: 'GROWTH_SPEND', reversalAmount: 10, balanceAfter: 100 });
    expect(await balance('S001')).toBe(100);
    expect((await tree().adminBoard()).tree?.drops).toBe(0);
    const history = await createDatabaseTransactionQueries({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction }).getTransactions();
    expect(history.map((transaction) => transaction.status).sort()).toEqual(['CANCELLED', 'CANCEL_REVERSAL']);
  });
});

describe('classFeed and harvest', () => {
  it('fills the tree, stops watering when full, and pays every active student at the harvest', async () => {
    // An inactive physical product still works as a reward: it lands as its 교환권.
    await tree().saveSettings({ ...ON, goalOverride: 20, rewardAmount: 50, rewardProductId: 'P010' });
    await tree().water({ studentId: 'S001', operationId: op() });
    expect(await failure(tree().harvest({ operationId: op(), treeNo: 1 }))).toBe('TREE_NOT_READY');
    const fed = await tree().classFeed({ operationId: op(), amount: 19, note: '모둠 활동 칭찬' });
    expect(fed).toMatchObject({ treeNo: 1, amount: 19, drops: 20, goal: 20, ready: true });
    expect(await failure(tree().water({ studentId: 'S001', operationId: op() }))).toBe('TREE_READY');

    const operationId = op();
    const harvest = await tree().harvest({ operationId, treeNo: 1 });
    expect(harvest).toMatchObject({ treeNo: 1, recipients: 3, rewardAmount: 50, rewardItem: '초코 과자 교환권', nextTreeNo: 2, nextGoal: 20 });
    expect(await tree().harvest({ operationId, treeNo: 1 })).toEqual(harvest);
    expect(await failure(tree().harvest({ operationId: op(), treeNo: 1 }))).toBe('TREE_NOT_READY');
    expect(await failure(tree().saveSettings({ ...ON, rewardProductId: 'NOPE' }))).toBe('INVALID_INPUT');
    expect([await balance('S001'), await balance('S002'), await balance('S003')]).toEqual([140, 55, 50]);

    const board = await tree().adminBoard();
    expect(board.tree).toMatchObject({ treeNo: 2, drops: 0, goal: 20 });
    expect(board.harvests).toEqual([expect.objectContaining({ treeNo: 1, recipients: 3, rewardAmount: 50, rewardItem: '초코 과자 교환권' })]);
    expect(board.rewardProducts).toEqual([expect.objectContaining({ productId: 'P010', isActive: false, digitalKind: null })]);
    expect((await tree().studentView('S002')).harvestedTrees).toBe(1);
    const bag = createStudentBagCommands({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction });
    const items = (await bag.studentBag('S002', { includeUsed: false })).items;
    expect(items).toEqual([expect.objectContaining({
      title: '초코 과자 교환권', kind: 'CONSUMABLE', source: 'TREE_HARVEST', sourceRef: '1', productId: 'P010',
      voucherProductId: 'P010', voucherProductName: '초코 과자', usedAt: null,
    })]);

    const history = await createDatabaseTransactionQueries({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction }).getTransactions();
    expect(history.filter((transaction) => transaction.status === 'TREE_HARVEST')).toHaveLength(3);
  });

  it('keeps each class to its own tree', async () => {
    await tree().saveSettings(ON);
    await tree().water({ studentId: 'S001', operationId: op() });
    expect((await tree(harness.tenantTwoId).adminBoard()).tree).toBeNull();
    expect(await failure(tree(harness.tenantTwoId).water({ studentId: 'S001', operationId: op() }))).toBe('TREE_OFF');
  });
});

describe('task completions', () => {
  async function rewardTransaction(transactionId: string, kind: 'TASK_REWARD' | 'CANCELLATION', reverses: string | null = null) {
    await harness.database.query(`INSERT INTO transactions (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
      legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot, reverses_transaction_id)
      VALUES ($1, $2, now(), 'S001', '김민준', $3, $4::bigint, $4::bigint, 100, 100 + $4::bigint, 'bank-task-completion', 'COMPLETED', $5)`,
    [harness.tenantOneId, transactionId, kind, kind === 'TASK_REWARD' ? 30 : -30, reverses]);
  }

  it('adds the task drops while the tree grows and takes them back when the reward is cancelled', async () => {
    await tree().saveSettings({ ...ON, taskDrops: 3 });
    await rewardTransaction('task-reward:a', 'TASK_REWARD');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskTreeDrops(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:a', operationId: op() }));
    expect((await tree().adminBoard()).contributions.find((row) => row.studentId === 'S001')).toMatchObject({ task: 3, total: 3 });

    await rewardTransaction('cancel:a', 'CANCELLATION', 'task-reward:a');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => revokeTreeDropsForTransaction(tx, harness.tenantOneId, {
      originalTransactionId: 'task-reward:a', reversalTransactionId: 'cancel:a', operationId: op() }));
    const board = await tree().adminBoard();
    expect(board.tree?.drops).toBe(0);
    expect(board.contributions.find((row) => row.studentId === 'S001')).toMatchObject({ task: 0, total: 0 });
  });

  it('adds nothing while the tree is off or task drops are 0', async () => {
    await tree().saveSettings({ ...ON, taskDrops: 0 });
    await rewardTransaction('task-reward:b', 'TASK_REWARD');
    await harness.runTenantTransaction(harness.tenantOneId, (tx) => addTaskTreeDrops(tx, harness.tenantOneId, { studentId: 'S001', transactionId: 'task-reward:b', operationId: op() }));
    expect((await tree().adminBoard()).tree?.drops).toBe(0);
  });
});
