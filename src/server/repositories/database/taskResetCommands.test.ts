import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';
import { createTaskRewardPayloadHash } from './taskCompletionCommands';
import {
  createDatabaseTaskResetCommands,
  createTaskResetPayloadHash,
  type DatabaseTaskResetCommandDependencies,
} from './taskResetCommands';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-31T01:00:00.000Z');
const OPERATION_ID = 'abcdef00-0000-4000-8000-000000000301';
const CURRENT_START = '2026-08-31T00:00:00.000Z';
const CURRENT_END = '2026-09-01T00:00:00.000Z';
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await harness.database.exec(await readFile(resolve(process.cwd(),
    'src/server/db/migrations/0010_task_admin_invariants.sql'), 'utf8'));
  await seedTask('TASK-002', 'INSTANCE-002', '둘째 과제', 'S002', '둘째 학생');
  await seedTask('TASK-001', 'INSTANCE-001', '첫째 과제', 'S001', '첫째 학생');
});

afterEach(async () => harness.close());

function command(overrides: Partial<DatabaseTaskResetCommandDependencies> = {}) {
  return createDatabaseTaskResetCommands({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => NOW,
    ...overrides,
  });
}

async function seedTask(taskId: string, taskInstanceId: string, title: string,
  studentId: string, studentName: string) {
  await harness.database.query(`INSERT INTO students
    (tenant_id, student_id, name, status, created_at, updated_at)
    VALUES ($1, $2, $3, 'ACTIVE', $4, $4)`,
  [harness.tenantOneId, studentId, studentName, '2026-08-30T00:00:00.000Z']);
  await harness.database.query(`INSERT INTO accounts (tenant_id, student_id, balance)
    VALUES ($1, $2, 700)`, [harness.tenantOneId, studentId]);
  await harness.database.query(`INSERT INTO tasks
    (tenant_id, task_instance_id, task_id, title, description, reward, is_active,
     sort_order, current_schedule, schedule_schema_version, created_at, updated_at)
    VALUES ($1, $2, $3, $4, '', 50, true, 1, $5::jsonb, 1, $6, $6)`, [
    harness.tenantOneId, taskInstanceId, taskId, title,
    JSON.stringify({ ruleVersion: 1, effectiveFrom: '2026-08-30T00:00:00.000Z',
      timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' },
      resetCompletionOnCycle: true, resetAssignmentOnCycle: false }),
    '2026-08-30T00:00:00.000Z',
  ]);
  const assignmentId = `assignment:${taskId}:${studentId}`;
  const cycleId = `v1|${taskInstanceId}|r1|2026-08-31T00:00:00Z`;
  await harness.database.query(`INSERT INTO task_assignments
    (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
     cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
     source, previous_assignment_id, created_at, schema_version, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'Asia/Seoul', $8, 'ASSIGNED',
      'LEGACY_SEED', NULL, $6, 1, NULL)`, [harness.tenantOneId, assignmentId, taskId,
    taskInstanceId, cycleId, CURRENT_START, CURRENT_END, studentId]);
  const bankOperationId = taskId === 'TASK-001'
    ? 'abcdef00-0000-4000-8000-000000000401'
    : 'abcdef00-0000-4000-8000-000000000402';
  const bankHash = createTaskRewardPayloadHash({ taskId, taskInstanceId, taskTitle: title,
    studentId, studentName, assignmentId, cycleId, cycleStartsAt: CURRENT_START,
    cycleEndsAt: CURRENT_END, reward: 50 });
  const bankTransactionId = `task-reward:${bankOperationId}`;
  const bankCompletionId = `task-completion:${bankOperationId}`;
  await harness.database.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
     attempt_count, started_at, finished_at, created_at, updated_at)
    VALUES ($1, $2, 'TASK_REWARD', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
  [harness.tenantOneId, bankOperationId, bankHash, '2026-08-31T00:30:00.000Z']);
  await harness.database.query(`INSERT INTO transactions
    (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
     legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
     legacy_status_snapshot, operation_id, operation_hash, schema_version)
    VALUES ($1, $2, $3, $4, $5, 'TASK_REWARD', 50, 50, 650, 700,
      'bank-task-completion', 'COMPLETED', $6, $7, 1)`, [harness.tenantOneId,
    bankTransactionId, '2026-08-31T00:30:00.000Z', studentId, studentName,
    bankOperationId, bankHash]);
  await harness.database.query(`INSERT INTO task_completions
    (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
     task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
     balance_before, balance_after, status, note, cycle_id, cycle_start_at,
     cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
     operation_id, operation_hash, schema_version, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 50, 650, 700, 'COMPLETED',
      'original completion', $9, $10, $11, 1, 'Asia/Seoul', 'BANK', $12, $13,
      $14, $15, 1, $3)`, [
    harness.tenantOneId, bankCompletionId, '2026-08-31T00:30:00.000Z',
    taskInstanceId, taskId, title, studentId, studentName, cycleId, CURRENT_START,
    CURRENT_END, assignmentId, bankTransactionId, bankOperationId, bankHash,
  ]);
}

async function state(operationId = OPERATION_ID) {
  const [accounts, assignments, transactions, transactionItems, adjustments, inventoryLedger,
    completions, operations, audits] = await Promise.all([
    harness.database.query(`SELECT student_id, balance::text, version::text, updated_at FROM accounts
      WHERE tenant_id=$1 ORDER BY student_id`, [harness.tenantOneId]),
    harness.database.query(`SELECT assignment_id, event_sequence::text, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note FROM task_assignments
      WHERE tenant_id=$1 ORDER BY event_sequence`, [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM transactions WHERE tenant_id=$1 ORDER BY transaction_id`,
      [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM transaction_items WHERE tenant_id=$1 ORDER BY item_id`,
      [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM adjustments WHERE tenant_id=$1 ORDER BY adjustment_id`,
      [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM inventory_ledger WHERE tenant_id=$1
      ORDER BY inventory_event_id`, [harness.tenantOneId]),
    harness.database.query(`SELECT completion_id, event_sequence::text, completed_at,
      task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
      student_name_snapshot, reward_snapshot::text, balance_before::text,
      balance_after::text, status, note, cycle_id, cycle_start_at, cycle_end_at,
      rule_version, timezone, source, assignment_id, transaction_id, operation_id,
      operation_hash, admin_operation_id, admin_operation_hash, schema_version,
      evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
      evidence_author_full_name, created_at FROM task_completions WHERE tenant_id=$1
      ORDER BY event_sequence`, [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, operationId]),
    harness.database.query(`SELECT * FROM audit_events WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, operationId]),
  ]);
  return { accounts: accounts.rows, assignments: assignments.rows, transactions: transactions.rows,
    transactionItems: transactionItems.rows, adjustments: adjustments.rows,
    inventoryLedger: inventoryLedger.rows, completions: completions.rows,
    operations: operations.rows, audits: audits.rows };
}

function observingRunner(observe: (sql: string, rows: unknown[]) => unknown[]) {
  const dialect = new PgDialect();
  const run: DatabaseTaskResetCommandDependencies['runTenantTransaction'] = async <T>(
    tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>,
  ) => harness.runTenantTransaction(tenantId, async (transaction) => callback({
    ...transaction,
    execute: async (wrapper: SQLWrapper) => {
      const query = dialect.sqlToQuery(wrapper.getSQL());
      const result = await transaction.execute(wrapper);
      return { ...result, rows: observe(query.sql.toLowerCase(), [...result.rows]) };
    },
  } as unknown as TenantTransaction));
  return run;
}

async function seedReferencedTransactionDependents() {
  const transactionId = 'task-reward:abcdef00-0000-4000-8000-000000000401';
  await harness.database.query(`INSERT INTO products
    (tenant_id, product_id, name, price, stock, created_at, updated_at)
    VALUES ($1, 'GRAPH-PRODUCT', '그래프 상품', 50, 10, $2, $2)`,
  [harness.tenantOneId, '2026-08-30T00:00:00.000Z']);
  await harness.database.query(`INSERT INTO transaction_items
    (tenant_id, item_id, transaction_id, line_number, product_id_snapshot,
     current_product_id, product_name_snapshot, quantity, unit_price_snapshot,
     subtotal_snapshot, created_at)
    VALUES ($1, 'abcdef00-0000-4000-8000-000000000701', $2, 1, 'GRAPH-PRODUCT',
      'GRAPH-PRODUCT', '그래프 상품', 1, 50, 50, $3)`,
  [harness.tenantOneId, transactionId, '2026-08-31T00:30:00.000Z']);
  await harness.database.query(`INSERT INTO adjustments
    (tenant_id, adjustment_id, transaction_id, mode, requested_amount,
     operator_snapshot, legacy_adjustment_id, created_at)
    VALUES ($1, 'graph-adjustment', $2, 'add', 50, 'graph-fixture', NULL, $3)`,
  [harness.tenantOneId, transactionId, '2026-08-31T00:30:00.000Z']);
  await harness.database.query(`INSERT INTO inventory_ledger
    (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
     stock_before, stock_after, reason, operation_id, operation_hash, occurred_at, created_at)
    VALUES ($1, 'abcdef00-0000-4000-8000-000000000702', 'GRAPH-PRODUCT', $2,
      -1, 11, 10, 'CHECKOUT', NULL, NULL, $3, $3)`,
  [harness.tenantOneId, transactionId, '2026-08-31T00:30:00.000Z']);
}

async function seedCancellationOnlyCompletionWithOriginalDependent() {
  await seedReferencedTransactionDependents();
  const cancellationOperationId = 'abcdef00-0000-4000-8000-000000000711';
  const cancellationHash = '7'.repeat(64);
  const originalTransactionId = 'task-reward:abcdef00-0000-4000-8000-000000000401';
  const reversalTransactionId = `cancellation:${cancellationOperationId}`;
  await harness.database.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
     attempt_count, started_at, finished_at, created_at, updated_at)
    VALUES ($1, $2, 'CANCELLATION', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
  [harness.tenantOneId, cancellationOperationId, cancellationHash,
    '2026-08-31T00:45:00.000Z']);
  await harness.database.query(`INSERT INTO transactions
    (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
     legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
     legacy_status_snapshot, reverses_transaction_id, operation_id, operation_hash, schema_version)
    VALUES ($1, $2, $3, 'S001', '첫째 학생', 'CANCELLATION', 50, -50, 700, 650,
      'admin-cancellation', 'CANCEL_REVERSAL', $4, $5, $6, 1)`, [harness.tenantOneId,
    reversalTransactionId, '2026-08-31T00:45:00.000Z', originalTransactionId,
    cancellationOperationId, cancellationHash]);
  await harness.database.query(`ALTER TABLE task_completions
    DISABLE TRIGGER task_completions_append_only`);
  await harness.database.query(`DELETE FROM task_completions WHERE tenant_id=$1
    AND completion_id='task-completion:abcdef00-0000-4000-8000-000000000401'`, [harness.tenantOneId]);
  await harness.database.query(`INSERT INTO task_completions
    (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
     task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
     balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
     rule_version, timezone, source, assignment_id, transaction_id, operation_id,
     operation_hash, schema_version, created_at)
    VALUES ($1, 'task-completion-cancellation:abcdef00-0000-4000-8000-000000000711', $2,
      'INSTANCE-001', 'TASK-001',
      '첫째 과제', 'S001', '첫째 학생', 50, 700, 650, 'CANCELLED',
      'cancels-completion:task-completion:abcdef00-0000-4000-8000-000000000401', $3, $4, $5, 1, 'Asia/Seoul',
      'ADMIN_RESET', 'assignment:TASK-001:S001', $6, $7, $8, 1, $2)`, [
    harness.tenantOneId, '2026-08-31T00:45:00.000Z',
    'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
    reversalTransactionId, cancellationOperationId, cancellationHash,
  ]);
}

async function seedAssignmentOperation(operationId: string, hash: string,
  kind = 'TASK_ADMIN') {
  await harness.database.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
     attempt_count, started_at, finished_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'SUCCEEDED', '{}'::jsonb, 1, $5, $5, $5, $5)`,
  [harness.tenantOneId, operationId, kind, hash, '2026-08-31T00:05:00.000Z']);
}

describe('migration 0010 task completion reset provenance', () => {
  it.each([
    ['no binding', null, null, null, null],
    ['mixed binding', 'abcdef00-0000-4000-8000-000000000311', 'a'.repeat(64),
      'abcdef00-0000-4000-8000-000000000310', 'b'.repeat(64)],
    ['wrong administrator kind', null, null,
      'abcdef00-0000-4000-8000-000000000311', 'a'.repeat(64)],
    ['wrong administrator hash', null, null,
      'abcdef00-0000-4000-8000-000000000310', 'c'.repeat(64)],
  ])('rejects an ADMIN_RESET row with %s', async (_label, operationId, operationHash,
    adminOperationId, adminOperationHash) => {
    await harness.database.query(`INSERT INTO operations
      (tenant_id, operation_id, operation_kind, payload_hash, status, started_at, created_at, updated_at)
      VALUES ($1, 'abcdef00-0000-4000-8000-000000000310', 'TASK_ADMIN', $2,
        'PENDING', $3, $3, $3),
      ($1, 'abcdef00-0000-4000-8000-000000000311', 'CANCELLATION', $4,
        'PENDING', $3, $3, $3)`, [harness.tenantOneId, 'b'.repeat(64), NOW, 'a'.repeat(64)]);

    await expect(harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
       operation_id, operation_hash, admin_operation_id, admin_operation_hash,
       schema_version, created_at)
      SELECT tenant_id, $2, $3, task_instance_id, task_id_snapshot, task_name_snapshot,
       student_id, student_name_snapshot, 0, balance_after, balance_after, 'CANCELLED',
       'malformed reset', cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
       'ADMIN_RESET', assignment_id, NULL, $4, $5, $6, $7, 1, $3
      FROM task_completions WHERE tenant_id=$1 AND completion_id='task-completion:abcdef00-0000-4000-8000-000000000401'`,
    [harness.tenantOneId, `malformed:${_label}`, NOW, operationId, operationHash,
      adminOperationId, adminOperationHash])).rejects.toThrow(/binding|provenance|operation/i);
  });
});

describe('database batch task completion reset command', () => {
  it('appends one deterministic zero-delta reset per effective current-cycle completion atomically', async () => {
    const result = await command().resetBatch({
      operationId: OPERATION_ID,
      taskIds: ['TASK-002', 'TASK-001'],
    });

    expect(result).toEqual({ taskIds: ['TASK-001', 'TASK-002'],
      resetEventsAppended: 2, deletedCount: 2 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.taskIds)).toBe(true);

    const saved = await state();
    expect(saved.accounts).toEqual([
      expect.objectContaining({ student_id: 'S001', balance: '700', version: '1' }),
      expect.objectContaining({ student_id: 'S002', balance: '700', version: '1' }),
    ]);
    expect(saved.transactions).toHaveLength(2);
    expect(saved.completions).toHaveLength(4);
    const completionRows = saved.completions as Array<Record<string, unknown>>;
    const resets = completionRows.filter((row) => row.source === 'ADMIN_RESET');
    expect(resets).toHaveLength(2);
    expect(resets.map((row) => row.task_id_snapshot)).toEqual(['TASK-001', 'TASK-002']);
    expect(resets).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_instance_id: 'INSTANCE-001', task_id_snapshot: 'TASK-001',
        task_name_snapshot: '첫째 과제', student_id: 'S001', student_name_snapshot: '첫째 학생',
        reward_snapshot: '0', balance_before: '700', balance_after: '700',
        status: 'CANCELLED', cycle_id: 'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z',
        assignment_id: 'assignment:TASK-001:S001', transaction_id: null,
        operation_id: null, operation_hash: null, admin_operation_id: OPERATION_ID }),
    ]));
    expect(new Set(resets.map((row) => row.admin_operation_hash)))
      .toEqual(new Set([createTaskResetPayloadHash({ operationId: OPERATION_ID,
        taskIds: ['TASK-001', 'TASK-002'] })]));
    expect(saved.operations).toEqual([expect.objectContaining({ operation_kind: 'TASK_ADMIN',
      status: 'SUCCEEDED', result_snapshot: result })]);
    expect(saved.audits).toHaveLength(1);
    expect(saved.audits[0]).toMatchObject({ event_type: 'TASK_ADMIN_COMPLETED',
      entity_type: 'OPERATION', entity_id: OPERATION_ID,
      redacted_details: expect.objectContaining({ action: 'COMPLETION_RESET_BATCH',
        taskCount: 2, resetEventCount: 2 }) });
  });

  it('uses latest current-cycle state so replayed reset targets become no-ops for a new operation', async () => {
    await command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] });
    const second = await command().resetBatch({
      operationId: 'abcdef00-0000-4000-8000-000000000302', taskIds: ['TASK-001'],
    });
    expect(second).toEqual({ taskIds: ['TASK-001'], resetEventsAppended: 0, deletedCount: 0 });
    expect((await state('abcdef00-0000-4000-8000-000000000302')).completions)
      .toHaveLength(3);
  });

  it('returns the exact frozen stored result for reordered retry and conflicts on changed targets', async () => {
    const first = await command().resetBatch({ operationId: OPERATION_ID,
      taskIds: ['TASK-002', 'TASK-001'] });
    const replay = await command().resetBatch({ operationId: OPERATION_ID,
      taskIds: ['TASK-001', 'TASK-002'] });
    expect(replay).toEqual(first);
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay.taskIds)).toBe(true);
    expect((await state()).completions).toHaveLength(4);
    await expect(command().resetBatch({ operationId: OPERATION_ID,
      taskIds: ['TASK-001'] })).rejects.toThrow(/conflict/i);
  });

  it('rejects zero-event replay when the bound physical task was hard-deleted and recreated', async () => {
    const zeroOperation = 'abcdef00-0000-4000-8000-000000000302';
    await command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] });
    await command().resetBatch({ operationId: zeroOperation, taskIds: ['TASK-001'] });
    await harness.database.query(`ALTER TABLE task_completions DISABLE TRIGGER task_completions_append_only`);
    await harness.database.query(`ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only`);
    await harness.database.query(`DELETE FROM task_completions WHERE tenant_id=$1
      AND task_instance_id='INSTANCE-001'`, [harness.tenantOneId]);
    await harness.database.query(`DELETE FROM task_assignments WHERE tenant_id=$1
      AND task_instance_id='INSTANCE-001'`, [harness.tenantOneId]);
    await harness.database.query(`DELETE FROM tasks WHERE tenant_id=$1
      AND task_instance_id='INSTANCE-001'`, [harness.tenantOneId]);
    await harness.database.query(`INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active,
       sort_order, current_schedule, schedule_schema_version, created_at, updated_at)
      SELECT tenant_id, 'INSTANCE-RECREATED', 'TASK-001', 'recreated', description, reward,
        is_active, sort_order, current_schedule, schedule_schema_version, created_at, updated_at
      FROM tasks WHERE tenant_id=$1 AND task_instance_id='INSTANCE-002'`, [harness.tenantOneId]);

    await expect(command().resetBatch({ operationId: zeroOperation, taskIds: ['TASK-001'] }))
      .rejects.toThrow(/physical identity|audit.*integrity/i);
  });

  it('replays against the original tombstoned physical task despite a valid recreated lifecycle', async () => {
    const zeroOperation = 'abcdef00-0000-4000-8000-000000000302';
    await command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] });
    await command().resetBatch({ operationId: zeroOperation, taskIds: ['TASK-001'] });
    await harness.database.query(`UPDATE tasks SET is_active=false, deleted_at=$2, updated_at=$2
      WHERE tenant_id=$1 AND task_instance_id='INSTANCE-001'`,
    [harness.tenantOneId, '2026-08-31T01:01:00.000Z']);
    await harness.database.query(`INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active,
       sort_order, current_schedule, schedule_schema_version, created_at, updated_at)
      SELECT tenant_id, 'INSTANCE-RECREATED', 'TASK-001', 'recreated', description, reward,
        true, sort_order, current_schedule, schedule_schema_version, $2, $2
      FROM tasks WHERE tenant_id=$1 AND task_instance_id='INSTANCE-001'`,
    [harness.tenantOneId, '2026-08-31T01:02:00.000Z']);

    await expect(command().resetBatch({ operationId: zeroOperation, taskIds: ['TASK-001'] }))
      .resolves.toEqual({ taskIds: ['TASK-001'], resetEventsAppended: 0, deletedCount: 0 });
  });

  it('fails a missing target atomically without operation, audit, or earlier reset residue', async () => {
    const before = await state();
    await expect(command().resetBatch({ operationId: OPERATION_ID,
      taskIds: ['TASK-001', 'TASK-MISSING'] })).rejects.toThrow(/target.*not found/i);
    expect(await state()).toEqual(before);
  });

  it('rejects malformed exact input, duplicate canonical IDs, invalid clock, and UUID before transaction entry', async () => {
    const calls = vi.fn();
    const runTenantTransaction: DatabaseTaskResetCommandDependencies['runTenantTransaction'] =
      async (tenantId, callback) => { calls(); return harness.runTenantTransaction(tenantId, callback); };
    const subject = command({ runTenantTransaction });
    await expect(subject.resetBatch({ operationId: 'NOT-A-UUID', taskIds: ['TASK-001'] }))
      .rejects.toThrow(/uuid|operation/i);
    await expect(subject.resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001', 'TASK-001'] }))
      .rejects.toThrow(/duplicate/i);
    await expect(subject.resetBatch({ operationId: OPERATION_ID, taskIds: [] }))
      .rejects.toThrow(/task ids|malformed/i);
    await expect(subject.resetBatch({ operationId: OPERATION_ID, taskIds: [' TASK-001'] }))
      .rejects.toThrow(/task id/i);
    const expanded = { operationId: OPERATION_ID, taskIds: ['TASK-001'], extra: true };
    await expect(subject.resetBatch(expanded as never)).rejects.toThrow(/malformed/i);
    await expect(command({ runTenantTransaction, now: () => new Date(Number.NaN) })
      .resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
      .rejects.toThrow(/timestamp|clock/i);
    expect(calls).not.toHaveBeenCalled();
  });

  it.each([
    ['BANK status', (row: Record<string, unknown>) => ({ ...row, status: 'CANCELLED' })],
    ['BANK balance arithmetic', (row: Record<string, unknown>) => ({ ...row, balance_after: '701' })],
    ['BANK operation ID spelling', (row: Record<string, unknown>) => ({
      ...row, operation_id: String(row.operation_id).toUpperCase(),
    })],
    ['completion chronology', (row: Record<string, unknown>) => ({
      ...row, completed_at: new Date('2026-08-30T23:59:59.999Z'),
    })],
    ['BANK evidence board ID', (row: Record<string, unknown>) => ({
      ...row, evidence_provider: 'PADLET', evidence_board_id: 'x',
      evidence_post_id: 'post-001', evidence_created_at: row.completed_at,
      evidence_author_full_name: row.student_name_snapshot,
    })],
    ['BANK evidence post ID', (row: Record<string, unknown>) => ({
      ...row, evidence_provider: 'PADLET', evidence_board_id: 'AbCdEfGhIjKlMnOp',
      evidence_post_id: 'x', evidence_created_at: row.completed_at,
      evidence_author_full_name: row.student_name_snapshot,
    })],
    ['BANK evidence author length', (row: Record<string, unknown>) => {
      const author = '가'.repeat(201);
      return { ...row, student_name_snapshot: author, evidence_provider: 'PADLET',
        evidence_board_id: 'AbCdEfGhIjKlMnOp', evidence_post_id: 'post-001',
        evidence_created_at: row.completed_at, evidence_author_full_name: author };
    }],
  ])('rejects malformed immutable completion history: %s', async (_label, corrupt) => {
    const before = await state();
    let corrupted = 0;
    const run = observingRunner((sql, rows) => {
      if (sql.startsWith('select ') && sql.includes('from task_completions')) {
        return rows.map((raw) => {
          const row = raw as Record<string, unknown>;
          if (row.source !== 'BANK') return row;
          corrupted += 1;
          return corrupt(row);
        });
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/completion.*(history|integrity)|operation id/i);
    expect(corrupted).toBeGreaterThan(0);
    expect(await state()).toEqual(before);
  });

  it('accepts cancellation-provenance ADMIN_RESET history without appending an administrator reset', async () => {
    const cancellationOperationId = 'abcdef00-0000-4000-8000-000000000501';
    const cancellationHash = 'f'.repeat(64);
    const originalOperationId = 'abcdef00-0000-4000-8000-000000000401';
    const originalTransactionId = `task-reward:${originalOperationId}`;
    const reversalTransactionId = `cancellation:${cancellationOperationId}`;
    await harness.database.query(`INSERT INTO operations
      (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
       attempt_count, started_at, finished_at, created_at, updated_at)
      VALUES ($1, $2, 'CANCELLATION', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
    [harness.tenantOneId, cancellationOperationId, cancellationHash, '2026-08-31T00:45:00.000Z']);
    await harness.database.query(`INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
       legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
       legacy_status_snapshot, reverses_transaction_id, operation_id, operation_hash, schema_version)
      VALUES ($1, $2, $3, 'S001', '첫째 학생', 'CANCELLATION', 50, -50, 700, 650,
        'admin-cancellation', 'CANCEL_REVERSAL', $4, $5, $6, 1)`, [harness.tenantOneId,
      reversalTransactionId, '2026-08-31T00:45:00.000Z', originalTransactionId,
      cancellationOperationId, cancellationHash]);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, transaction_id, operation_id,
       operation_hash, schema_version, created_at)
      VALUES ($1, 'task-completion-cancellation:abcdef00-0000-4000-8000-000000000501', $2,
        'INSTANCE-001', 'TASK-001',
        '첫째 과제', 'S001', '첫째 학생', 50, 700, 650, 'CANCELLED',
        'cancels-completion:task-completion:abcdef00-0000-4000-8000-000000000401', $3, $4, $5, 1, 'Asia/Seoul',
        'ADMIN_RESET', 'assignment:TASK-001:S001', $6, $7, $8, 1, $2)`, [
      harness.tenantOneId, '2026-08-31T00:45:00.000Z',
      'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
      reversalTransactionId, cancellationOperationId, cancellationHash,
    ]);

    await expect(command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
      .resolves.toEqual({ taskIds: ['TASK-001'], resetEventsAppended: 0, deletedCount: 0 });
  });

  it('accepts valid ADMIN and CARRY_FORWARD source contracts together', async () => {
    const adminOperationId = 'abcdef00-0000-4000-8000-000000000601';
    const adminHash = '1'.repeat(64);
    await harness.database.query(`INSERT INTO operations
      (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
       attempt_count, started_at, finished_at, created_at, updated_at)
      VALUES ($1, $2, 'TASK_ADMIN', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
    [harness.tenantOneId, adminOperationId, adminHash, '2026-08-31T00:35:00.000Z']);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, admin_operation_id,
       admin_operation_hash, schema_version, created_at)
      VALUES ($1, 'completion:admin:S001', $2, 'INSTANCE-001', 'TASK-001', '첫째 과제',
        'S001', '첫째 학생', 0, 700, 700, 'COMPLETED', 'admin completion', $3, $4,
        $5, 1, 'Asia/Seoul', 'ADMIN', 'assignment:TASK-001:S001', $6, $7, 1, $2)`, [
      harness.tenantOneId, '2026-08-31T00:35:00.000Z',
      'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
      adminOperationId, adminHash,
    ]);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, schema_version, created_at)
      VALUES ($1, 'completion:carry:S002', $2, 'INSTANCE-002', 'TASK-002', '둘째 과제',
        'S002', '둘째 학생', 0, 700, 700, 'COMPLETED', 'carry completion', $3, $4,
        $5, 1, 'Asia/Seoul', 'CARRY_FORWARD', 'assignment:TASK-002:S002', 1, $2)`, [
      harness.tenantOneId, '2026-08-31T00:40:00.000Z',
      'v1|INSTANCE-002|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
    ]);

    await expect(command().resetBatch({ operationId: OPERATION_ID,
      taskIds: ['TASK-001', 'TASK-002'] })).resolves.toMatchObject({ resetEventsAppended: 2 });
  });

  it('rejects a BANK completion repointed to a DB-valid assignment for another student atomically',
    async () => {
      await harness.database.query(`INSERT INTO students
        (tenant_id, student_id, name, status, created_at, updated_at)
        VALUES ($1, 'S003', '셋째 학생', 'ACTIVE', $2, $2)`,
      [harness.tenantOneId, '2026-08-30T00:00:00.000Z']);
      await harness.database.query(`INSERT INTO task_assignments
        (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
         cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
         source, previous_assignment_id, created_at, schema_version, note)
        VALUES ($1, 'assignment:TASK-001:S003', 'TASK-001', 'INSTANCE-001', $2,
          $3, $4, 1, 'Asia/Seoul', 'S003', 'ASSIGNED', 'LEGACY_SEED', NULL, $3, 1, NULL)`,
      [harness.tenantOneId, 'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z',
        CURRENT_START, CURRENT_END]);
      await harness.database.query(`ALTER TABLE task_completions
        DISABLE TRIGGER task_completions_append_only`);
      await harness.database.query(`UPDATE task_completions
        SET assignment_id='assignment:TASK-001:S003'
        WHERE tenant_id=$1 AND completion_id='task-completion:abcdef00-0000-4000-8000-000000000401'`,
      [harness.tenantOneId]);
      const corrupted = await state();

      await expect(command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
        .rejects.toThrow(/completion.*assignment.*integrity/i);
      expect(await state()).toEqual(corrupted);
      expect((await state()).operations).toEqual([]);
    });

  it('rejects a CARRY_FORWARD assignment linked to an assignment of another task atomically',
    async () => {
      await harness.database.query(`INSERT INTO task_assignments
        (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
         cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
         source, previous_assignment_id, created_at, schema_version, note)
        VALUES ($1, 'assignment:TASK-001:S001:bad-carry', 'TASK-001', 'INSTANCE-001', $2,
          $3, $4, 2, 'Asia/Seoul', 'S001', 'ASSIGNED', 'CARRY_FORWARD',
          'assignment:TASK-002:S002', $3, 1, 'cross-task carry')`,
      [harness.tenantOneId, 'v1|INSTANCE-001|r2|2026-09-01T00:00:00Z',
        '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);
      const before = await state();

      await expect(command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
        .rejects.toThrow(/assignment.*(chain|integrity)/i);
      expect(await state()).toEqual(before);
      expect((await state()).operations).toEqual([]);
    });

  it('rejects malformed ADMIN/QR assignment operation binding and immediate predecessor chain',
    async () => {
      const operationId = 'abcdef00-0000-4000-8000-000000000681';
      const operationHash = '8'.repeat(64);
      await seedAssignmentOperation(operationId, operationHash);
      await harness.database.query(`INSERT INTO task_assignments
        (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
         cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
         source, previous_assignment_id, admin_operation_id, admin_operation_hash,
         created_at, schema_version, note) VALUES
        ($1, 'assignment:TASK-001:S001:admin', 'TASK-001', 'INSTANCE-001', $2, $3, $4,
          1, 'Asia/Seoul', 'S001', 'UNASSIGNED', 'ADMIN', 'assignment:TASK-001:S001',
          $5, $6, $7, 1, 'admin'),
        ($1, 'assignment:TASK-001:S001:qr', 'TASK-001', 'INSTANCE-001', $2, $3, $4,
          1, 'Asia/Seoul', 'S001', 'ASSIGNED', 'QR', 'assignment:TASK-001:S001',
          $5, $6, $8, 1, 'qr skip')`, [harness.tenantOneId,
        'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
        operationId, operationHash, '2026-08-31T00:10:00.000Z',
        '2026-08-31T00:20:00.000Z']);
      const before = await state();

      await expect(command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
        .rejects.toThrow(/assignment.*(chain|integrity)/i);
      expect(await state()).toEqual(before);
    });

  it('rejects a referenced ADMIN assignment operation whose kind is malformed set-wise', async () => {
    const operationId = 'abcdef00-0000-4000-8000-000000000683';
    const operationHash = 'b'.repeat(64);
    await seedAssignmentOperation(operationId, operationHash);
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note)
      VALUES ($1, 'assignment:TASK-001:S001:admin-kind', 'TASK-001', 'INSTANCE-001', $2,
        $3, $4, 1, 'Asia/Seoul', 'S001', 'ASSIGNED', 'ADMIN',
        'assignment:TASK-001:S001', $5, $6, $7, 1, 'admin kind')`, [harness.tenantOneId,
      'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
      operationId, operationHash, '2026-08-31T00:10:00.000Z']);
    const before = await state();
    const run = observingRunner((sql, rows) => {
      if (sql.startsWith('select operation_id, operation_kind, payload_hash')
        && sql.includes('operation_id in (')) return rows.map((raw) =>
        (raw as Record<string, unknown>).operation_id === operationId
          ? { ...(raw as Record<string, unknown>), operation_kind: 'CANCELLATION' } : raw);
      return rows;
    });

    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/referenced operation.*integrity/i);
    expect(await state()).toEqual(before);
  });

  it('accepts a mixed LEGACY_SEED, ADMIN/QR, ordinary carry, and boundary carry chain', async () => {
    const operationId = 'abcdef00-0000-4000-8000-000000000682';
    const operationHash = 'a'.repeat(64);
    await seedAssignmentOperation(operationId, operationHash);
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note) VALUES
      ($1, 'assignment:TASK-001:S001:admin', 'TASK-001', 'INSTANCE-001', $2, $3, $4,
        1, 'Asia/Seoul', 'S001', 'UNASSIGNED', 'ADMIN', 'assignment:TASK-001:S001',
        $5, $6, $7, 1, 'admin'),
      ($1, 'assignment:TASK-001:S001:qr', 'TASK-001', 'INSTANCE-001', $2, $3, $4,
        1, 'Asia/Seoul', 'S001', 'ASSIGNED', 'QR', 'assignment:TASK-001:S001:admin',
        $5, $6, $8, 1, 'qr'),
      ($1, 'assignment:TASK-001:S001:natural', 'TASK-001', 'INSTANCE-001', $9, $10, $11,
        1, 'Asia/Seoul', 'S001', 'ASSIGNED', 'CARRY_FORWARD',
        'assignment:TASK-001:S001:qr', NULL, NULL, $10, 1, 'natural carry'),
      ($1, 'assignment:TASK-001:S001:boundary', 'TASK-001', 'INSTANCE-001', $12, $13, $14,
        2, 'Asia/Seoul', 'S001', 'ASSIGNED', 'CARRY_FORWARD',
        'assignment:TASK-001:S001:natural', NULL, NULL, $13, 1, 'boundary carry')`, [
      harness.tenantOneId, 'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START,
      CURRENT_END, operationId, operationHash, '2026-08-31T00:10:00.000Z',
      '2026-08-31T00:20:00.000Z', 'v1|INSTANCE-001|r1|2026-09-01T00:00:00Z',
      '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z',
      'v1|INSTANCE-001|r2|2026-09-01T00:00:00Z', '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z']);

    await expect(command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
      .resolves.toMatchObject({ resetEventsAppended: 1 });
  });

  it('validates assignment source chains independently of adapter row order', async () => {
    const operationId = 'abcdef00-0000-4000-8000-000000000684';
    const operationHash = 'c'.repeat(64);
    await seedAssignmentOperation(operationId, operationHash);
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note) VALUES
      ($1, 'assignment:TASK-001:S001:order-admin', 'TASK-001', 'INSTANCE-001', $2, $3, $4,
        1, 'Asia/Seoul', 'S001', 'UNASSIGNED', 'ADMIN', 'assignment:TASK-001:S001',
        $5, $6, $7, 1, 'order admin'),
      ($1, 'assignment:TASK-001:S001:order-qr', 'TASK-001', 'INSTANCE-001', $2, $3, $4,
        1, 'Asia/Seoul', 'S001', 'ASSIGNED', 'QR', 'assignment:TASK-001:S001:order-admin',
        $5, $6, $8, 1, 'order qr')`, [harness.tenantOneId,
      'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
      operationId, operationHash, '2026-08-31T00:10:00.000Z',
      '2026-08-31T00:20:00.000Z']);
    const run = observingRunner((statement, rows) => statement.startsWith('select ')
      && statement.includes('from task_assignments') ? [...rows].reverse() : rows);
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).resolves.toMatchObject({ resetEventsAppended: 1 });
  });

  it('rejects a referenced operation whose set-wise evidence has the wrong kind', async () => {
    const before = await state();
    let referenceReads = 0;
    const run = observingRunner((sql, rows) => {
      if (sql.startsWith('select operation_id, operation_kind, payload_hash')
        && sql.includes('operation_id in (')) {
        referenceReads += 1;
        return rows.map((raw, index) => index === 0
          ? { ...(raw as Record<string, unknown>), operation_kind: 'CANCELLATION' }
          : raw);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/referenced operation.*integrity/i);
    expect(referenceReads).toBe(1);
    expect(await state()).toEqual(before);
  });

  it('locks physical tasks in stable order and performs completion reads set-wise', async () => {
    const statements: string[] = [];
    const run = observingRunner((sql, rows) => { statements.push(sql.replace(/\s+/g, ' ')); return rows; });
    await command({ runTenantTransaction: run }).resetBatch({ operationId: OPERATION_ID,
      taskIds: ['TASK-002', 'TASK-001'] });
    const taskLock = statements.find((sql) => sql.includes('from tasks') && sql.includes('for update'));
    expect(taskLock).toContain('order by task_instance_id for update');
    const completionReads = statements.filter((sql) => sql.startsWith('select ')
      && sql.includes('from task_completions'));
    expect(completionReads.every((sql) => sql.includes('task_instance_id in ('))).toBe(true);
    expect(completionReads.length).toBeLessThanOrEqual(4);
  });

  it.each([
    { taskIds: ['TASK-001'] as const, expectedWidth: 1, label: 'one-target' },
    { taskIds: ['TASK-002', 'TASK-001'] as const, expectedWidth: 2, label: 'many-target' },
  ])('uses exactly three set-wise task snapshot reads for a $label reset',
  async ({ taskIds, expectedWidth }) => {
    const widths: number[] = [];
    const run = observingRunner((sql, rows) => {
      if (sql.startsWith('select task_instance_id, task_id, current_schedule')
        && sql.includes('from tasks')) widths.push(rows.length);
      return rows;
    });

    await command({ runTenantTransaction: run }).resetBatch({ operationId: OPERATION_ID, taskIds });

    expect(widths).toEqual([expectedWidth, expectedWidth, expectedWidth]);
  });

  it('rejects valid-looking adapter task identity and nested schedule mutations at every snapshot phase',
    async () => {
      const pending = { ruleVersion: 2, effectiveFrom: '2026-09-01T00:00:00.000Z',
        timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' },
        resetCompletionOnCycle: true, resetAssignmentOnCycle: false };
      await harness.database.query(`UPDATE tasks SET pending_schedule=$2::jsonb
        WHERE tenant_id=$1 AND task_instance_id='INSTANCE-001'`,
      [harness.tenantOneId, JSON.stringify(pending)]);
      const before = await state();
      const mutations = [
        ['task ID', (row: Record<string, unknown>) => ({ ...row, task_id: 'TASK-CORRUPTED' })],
        ['current schedule', (row: Record<string, unknown>) => ({ ...row,
          current_schedule: { ...(row.current_schedule as Record<string, unknown>),
            resetAssignmentOnCycle: true } })],
        ['pending schedule', (row: Record<string, unknown>) => ({ ...row,
          pending_schedule: { ...(row.pending_schedule as Record<string, unknown>),
            resetAssignmentOnCycle: true } })],
      ] as const;

      for (const phase of [1, 2, 3]) {
        for (const [label, mutate] of mutations) {
          let snapshotRead = 0;
          let terminalReached = false;
          let auditReached = false;
          const run = observingRunner((sql, rows) => {
            if (sql.startsWith("update operations set status='succeeded'")) terminalReached = true;
            if (sql.includes('from audit_events')) auditReached = true;
            if (sql.startsWith('select task_instance_id, task_id, current_schedule')
              && sql.includes('from tasks')) {
              snapshotRead += 1;
              if (snapshotRead === phase) return rows.map((raw, index) => index === 0
                ? mutate(raw as Record<string, unknown>) : raw);
            }
            return rows;
          });

          await expect(command({ runTenantTransaction: run }).resetBatch({
            operationId: OPERATION_ID, taskIds: ['TASK-001'],
          }), `${label} mutation at task snapshot read ${phase}`)
            .rejects.toThrow(/task.*(snapshot|identity|integrity)/i);
          expect(snapshotRead).toBeGreaterThanOrEqual(phase);
          if (phase === 2) expect(auditReached).toBe(false);
          if (phase === 3) expect(terminalReached).toBe(true);
          expect(await state()).toEqual(before);
        }
      }
    });

  it('fails closed when any exact task snapshot scalar changes before audit', async () => {
    const before = await state();
    const mutations = [
      (row: Record<string, unknown>) => ({ ...row, schedule_schema_version: 2 }),
      (row: Record<string, unknown>) => ({ ...row, version: '2' }),
      (row: Record<string, unknown>) => ({ ...row,
        created_at: new Date('2026-08-29T23:59:59.000Z') }),
      (row: Record<string, unknown>) => ({ ...row,
        updated_at: new Date('2026-08-30T00:00:01.000Z') }),
      (row: Record<string, unknown>) => ({ ...row, is_active: false }),
      (row: Record<string, unknown>) => ({ ...row, deleted_at: NOW }),
    ];
    for (const mutate of mutations) {
      let snapshotRead = 0;
      const run = observingRunner((sql, rows) => {
        if (sql.startsWith('select task_instance_id, task_id, current_schedule')
          && sql.includes('from tasks') && ++snapshotRead === 2) {
          return rows.map((raw, index) => index === 0
            ? mutate(raw as Record<string, unknown>) : raw);
        }
        return rows;
      });
      await expect(command({ runTenantTransaction: run }).resetBatch({
        operationId: OPERATION_ID, taskIds: ['TASK-001'],
      })).rejects.toThrow(/task.*(snapshot|integrity)/i);
      expect(await state()).toEqual(before);
    }
  });

  it('fails closed on suppressed later reset insertion and rolls back every write', async () => {
    const before = await state();
    let insertions = 0;
    const run = observingRunner((sql, rows) => {
      if (sql.startsWith('insert into task_completions')) {
        insertions += 1;
        if (insertions === 2) return [];
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({ operationId: OPERATION_ID,
      taskIds: ['TASK-001', 'TASK-002'] })).rejects.toThrow(/reset event.*integrity/i);
    expect(insertions).toBe(2);
    expect(await state()).toEqual(before);
  });

  it.each([
    { phase: 'pre-audit', occurrence: 2, auditReached: false, terminalReached: false },
    { phase: 'post-terminal', occurrence: 3, auditReached: true, terminalReached: true },
  ])('rejects the explicit assignment unchanged-state fault matrix at $phase and rolls back',
  async ({ phase, occurrence, auditReached: expectedAudit, terminalReached: expectedTerminal }) => {
    const faults = [
      ['added row', (rows: unknown[]) => [...rows, { ...(rows[0] as Record<string, unknown>) }]],
      ['removed row', (rows: unknown[]) => rows.slice(1)],
      ['changed row', (rows: unknown[]) => rows.map((row, index) => index === 0
        ? { ...(row as Record<string, unknown>), note: 'adapter mutation' } : row)],
      ['unknown ID', (rows: unknown[]) => rows.map((row, index) => index === 0
        ? { ...(row as Record<string, unknown>), assignment_id: 'assignment:UNKNOWN' } : row)],
    ] as const;
    for (const [label, mutate] of faults) {
      const before = await state();
      let reads = 0; let auditReached = false; let terminalReached = false;
      const run = observingRunner((sql, rows) => {
        if (sql.includes('from audit_events')) auditReached = true;
        if (sql.startsWith("update operations set status='succeeded'")) terminalReached = true;
        if (sql.startsWith('select assignment_id, event_sequence::text')
          && sql.includes('from task_assignments') && ++reads === occurrence) return mutate(rows);
        return rows;
      });
      await expect(command({ runTenantTransaction: run }).resetBatch({
        operationId: OPERATION_ID, taskIds: ['TASK-001'],
      }), `${label} at ${phase}`).rejects.toThrow(/assignment.*(snapshot|identity|integrity)/i);
      expect(reads).toBeGreaterThanOrEqual(occurrence);
      expect(auditReached).toBe(expectedAudit);
      expect(terminalReached).toBe(expectedTerminal);
      expect(await state()).toEqual(before);
    }
  });

  it.each([
    { phase: 'pre-audit', occurrence: 2, auditReached: false, terminalReached: false },
    { phase: 'post-terminal', occurrence: 3, auditReached: true, terminalReached: true },
  ])('rejects the explicit account unchanged-state fault matrix at $phase and rolls back',
  async ({ phase, occurrence, auditReached: expectedAudit, terminalReached: expectedTerminal }) => {
    const faults = [
      ['added row', (rows: unknown[]) => [...rows, { ...(rows[0] as Record<string, unknown>) }]],
      ['removed row', (rows: unknown[]) => rows.slice(1)],
      ['changed row', (rows: unknown[]) => rows.map((row, index) => index === 0
        ? { ...(row as Record<string, unknown>), balance: '701' } : row)],
      ['unknown ID', (rows: unknown[]) => rows.map((row, index) => index === 0
        ? { ...(row as Record<string, unknown>), student_id: 'S-UNKNOWN' } : row)],
    ] as const;
    for (const [label, mutate] of faults) {
      const before = await state();
      let reads = 0; let auditReached = false; let terminalReached = false;
      const run = observingRunner((sql, rows) => {
        if (sql.includes('from audit_events')) auditReached = true;
        if (sql.startsWith("update operations set status='succeeded'")) terminalReached = true;
        if (sql.startsWith('select student_id, balance::text') && sql.includes('from accounts')
          && ++reads === occurrence) return mutate(rows);
        return rows;
      });
      await expect(command({ runTenantTransaction: run }).resetBatch({
        operationId: OPERATION_ID, taskIds: ['TASK-001'],
      }), `${label} at ${phase}`).rejects.toThrow(/account.*(snapshot|identity|integrity)/i);
      expect(reads).toBeGreaterThanOrEqual(occurrence);
      expect(auditReached).toBe(expectedAudit);
      expect(terminalReached).toBe(expectedTerminal);
      expect(await state()).toEqual(before);
    }
  });

  it.each([
    ['assignment', 'select assignment_id, event_sequence::text', 'from task_assignments'],
    ['account', 'select student_id, balance::text', 'from accounts'],
  ] as const)('rejects sparse and index-getter %s rowsets without invoking hooks',
  async (label, prefix, table) => {
    for (const shape of ['sparse', 'getter'] as const) {
      const before = await state();
      let hooks = 0; let injected = false;
      const run = observingRunner((sql, rows) => {
        if (!injected && sql.startsWith(prefix) && sql.includes(table)) {
          injected = true;
          if (shape === 'sparse') return new Array(rows.length) as unknown[];
          const malformed: unknown[] = [];
          Object.defineProperty(malformed, '0', { enumerable: true, configurable: true,
            get: () => { hooks += 1; throw new Error('row hook executed'); } });
          return malformed;
        }
        return rows;
      });
      await expect(command({ runTenantTransaction: run }).resetBatch({
        operationId: OPERATION_ID, taskIds: ['TASK-001'],
      })).rejects.toThrow(new RegExp(`${label}.*rowset.*malformed`, 'i'));
      expect(injected).toBe(true);
      expect(hooks).toBe(0);
      expect(await state()).toEqual(before);
    }
  });

  it.each([
    { taskIds: ['TASK-001'] as const, width: 1, label: 'one-target' },
    { taskIds: ['TASK-002', 'TASK-001'] as const, width: 2, label: 'multi-target' },
  ])('uses constant verb-classified assignment/account SELECT counts for $label',
  async ({ taskIds, width }) => {
    const statements: Array<{ verb: string; sql: string; width: number }> = [];
    const run = observingRunner((sql, rows) => {
      statements.push({ verb: sql.trimStart().split(/\s+/, 1)[0], sql, width: rows.length });
      return rows;
    });
    await command({ runTenantTransaction: run }).resetBatch({ operationId: OPERATION_ID, taskIds });
    const selects = (table: string) => statements.filter((statement) => statement.verb === 'select'
      && statement.sql.includes(`from ${table}`));
    expect(selects('task_assignments').map((statement) => statement.width))
      .toEqual([width, width, width]);
    expect(selects('accounts').map((statement) => statement.width)).toEqual([width, width, width]);
    expect(statements.filter((statement) => statement.verb !== 'select'
      && /\b(task_assignments|accounts)\b/.test(statement.sql))).toEqual([]);
  });

  it.each([
    ['student identity', (row: Record<string, unknown>) => ({ ...row,
      student_id: 'S999', student_name_snapshot: '다른 학생' })],
    ['completion-relative balance arithmetic', (row: Record<string, unknown>) => ({ ...row,
      balance_before: '600', balance_after: '650' })],
    ['completion-relative chronology', (row: Record<string, unknown>) => ({ ...row,
      occurred_at: new Date('2026-08-31T00:29:00.000Z'),
      created_at: new Date('2026-08-31T00:29:00.000Z') })],
    ['operator', (row: Record<string, unknown>) => ({ ...row,
      operator_snapshot: 'other-valid-operator' })],
    ['status', (row: Record<string, unknown>) => ({ ...row,
      legacy_status_snapshot: 'SUCCESS' })],
    ['schema', (row: Record<string, unknown>) => ({ ...row, schema_version: 2 })],
  ] as const)('rejects consistently observed BANK transaction semantic fault: %s',
  async (_label, mutate) => {
    const before = await state();
    let transactionReads = 0; let auditReached = false; let terminalReached = false;
    const run = observingRunner((statement, rows) => {
      if (statement.includes('from audit_events')) auditReached = true;
      if (statement.startsWith("update operations set status='succeeded'")) terminalReached = true;
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        transactionReads += 1;
        return rows.map((raw) => (raw as Record<string, unknown>).kind === 'TASK_REWARD'
          ? mutate(raw as Record<string, unknown>) : raw);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/bank completion transaction provenance.*integrity/i);
    expect(transactionReads).toBe(1);
    expect(auditReached).toBe(false);
    expect(terminalReached).toBe(false);
    expect(await state()).toEqual(before);
  });

  it('rejects a consistently observed non-deterministic BANK transaction ID before audit', async () => {
    const before = await state();
    const replacement = 'task-reward:abcdef00-0000-4000-8000-000000000499';
    let transactionReads = 0; let auditReached = false;
    const run = observingRunner((statement, rows) => {
      if (statement.includes('from audit_events')) auditReached = true;
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        transactionReads += 1;
        return rows.map((raw) => (raw as Record<string, unknown>).kind === 'TASK_REWARD'
          ? { ...(raw as Record<string, unknown>), transaction_id: replacement } : raw);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/bank completion transaction provenance.*integrity/i);
    expect(transactionReads).toBe(1);
    expect(auditReached).toBe(false);
    expect(await state()).toEqual(before);
  });

  it('cross-validates multiple BANK completions set-wise on the positive CREATE path', async () => {
    let transactionReads = 0;
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        transactionReads += 1;
        expect(rows.filter((raw) => (raw as Record<string, unknown>).kind === 'TASK_REWARD'))
          .toHaveLength(2);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-002', 'TASK-001'],
    })).resolves.toEqual({ taskIds: ['TASK-001', 'TASK-002'],
      resetEventsAppended: 2, deletedCount: 2 });
    expect(transactionReads).toBe(3);
  });

  it('captures a referenced cancellation predecessor and its dependents before audit', async () => {
    await seedCancellationOnlyCompletionWithOriginalDependent();
    const before = await state();
    let itemReads = 0; let auditReached = false;
    const run = observingRunner((statement, rows) => {
      if (statement.includes('from audit_events')) auditReached = true;
      if (statement.startsWith('select ') && statement.includes('from transaction_items')
        && ++itemReads === 2) {
        return rows.map((raw) => ({ ...(raw as Record<string, unknown>),
          product_name_snapshot: 'mutated predecessor dependent' }));
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/transaction graph.*snapshot.*integrity/i);
    expect(itemReads).toBe(2);
    expect(auditReached).toBe(false);
    expect(await state()).toEqual(before);
  });

  it.each([
    ['cancellation student/name', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, student_id: 'S999', student_name_snapshot: '다른 학생' } : row],
    ['original student/name', (row: Record<string, unknown>) => row.kind === 'TASK_REWARD'
      ? { ...row, student_id: 'S999', student_name_snapshot: '다른 학생' } : row],
    ['reversal reward/delta/balance relation', (row: Record<string, unknown>) =>
      row.kind === 'CANCELLATION' ? { ...row, legacy_total_amount: '40', balance_delta: '-40',
        balance_before: '700', balance_after: '660' } : row],
    ['original reward/delta relation', (row: Record<string, unknown>) => row.kind === 'TASK_REWARD'
      ? { ...row, legacy_total_amount: '40', balance_delta: '40', balance_before: '650',
        balance_after: '690' } : row],
    ['reversal chronology', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, occurred_at: new Date('2026-08-31T00:20:00.000Z'),
        created_at: new Date('2026-08-31T00:20:00.000Z') } : row],
    ['deterministic cancellation transaction ID', (row: Record<string, unknown>) =>
      row.kind === 'CANCELLATION' ? { ...row,
        transaction_id: 'cancellation:abcdef00-0000-4000-8000-000000000712' } : row],
    ['cancellation operator', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, operator_snapshot: 'other-valid-operator' } : row],
    ['cancellation status', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, legacy_status_snapshot: 'SUCCESS' } : row],
    ['cancellation schema', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, schema_version: 2 } : row],
    ['cancellation operation ID', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, operation_id: 'abcdef00-0000-4000-8000-000000000712' } : row],
    ['cancellation operation hash', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, operation_hash: '8'.repeat(64) } : row],
    ['reversed transaction ID', (row: Record<string, unknown>) => row.kind === 'CANCELLATION'
      ? { ...row, reverses_transaction_id: row.transaction_id } : row],
    ['missing original operation binding', (row: Record<string, unknown>) => row.kind === 'TASK_REWARD'
      ? { ...row, operation_id: null, operation_hash: null } : row],
    ['non-cancellable original semantic kind', (row: Record<string, unknown>) =>
      row.kind === 'TASK_REWARD' ? { ...row, kind: 'LEGACY' } : row],
  ] as const)('rejects consistently observed cancellation semantic fault: %s',
  async (_label, mutate) => {
    await seedCancellationOnlyCompletionWithOriginalDependent();
    const before = await state();
    let transactionReads = 0; let auditReached = false;
    const run = observingRunner((statement, rows) => {
      if (statement.includes('from audit_events')) auditReached = true;
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        transactionReads += 1;
        return rows.map((raw) => mutate(raw as Record<string, unknown>));
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/cancellation completion transaction provenance.*integrity/i);
    expect(transactionReads).toBe(1);
    expect(auditReached).toBe(false);
    expect(await state()).toEqual(before);
  });

  it.each([
    ['completion ID', (row: Record<string, unknown>) => ({ ...row,
      completion_id: 'task-completion-cancellation:abcdef00-0000-4000-8000-000000000712' })],
    ['completion note', (row: Record<string, unknown>) => ({ ...row,
      note: 'cancels-completion:task-completion:wrong' })],
  ] as const)('rejects cancellation completion deterministic contract fault: %s',
  async (_label, mutate) => {
    await seedCancellationOnlyCompletionWithOriginalDependent();
    const before = await state();
    let completionReads = 0;
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && statement.includes('from task_completions')) {
        completionReads += 1;
        return rows.map((raw) => (raw as Record<string, unknown>).operation_id !== null
          ? mutate(raw as Record<string, unknown>) : raw);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/cancellation completion transaction provenance.*integrity/i);
    expect(completionReads).toBe(1);
    expect(await state()).toEqual(before);
  });

  it('rejects cancellation chronology when completion and reversal consistently predate the original',
  async () => {
    await seedCancellationOnlyCompletionWithOriginalDependent();
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && statement.includes('from task_completions')) {
        return rows.map((raw) => (raw as Record<string, unknown>).operation_id
          === 'abcdef00-0000-4000-8000-000000000711'
          ? { ...(raw as Record<string, unknown>),
            completed_at: new Date('2026-08-31T00:20:00.000Z') } : raw);
      }
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        return rows.map((raw) => (raw as Record<string, unknown>).kind === 'CANCELLATION'
          ? { ...(raw as Record<string, unknown>),
            occurred_at: new Date('2026-08-31T00:20:00.000Z') } : raw);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/cancellation completion transaction provenance.*integrity/i);
  });

  it('reads cancellation and captured original operations together once per CREATE phase', async () => {
    await seedCancellationOnlyCompletionWithOriginalDependent();
    const operationReads: string[][] = [];
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select operation_id, operation_kind, payload_hash')
        && statement.includes('from operations')) {
        const ids = rows.map((raw) => String((raw as Record<string, unknown>).operation_id)).sort();
        if (ids.includes('abcdef00-0000-4000-8000-000000000401')
          || ids.includes('abcdef00-0000-4000-8000-000000000711')) operationReads.push(ids);
      }
      return rows;
    });
    await command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    });
    expect(operationReads).toEqual(Array.from({ length: 3 }, () => [
      'abcdef00-0000-4000-8000-000000000401',
      'abcdef00-0000-4000-8000-000000000711',
    ]));
  });

  it('uses FALSE graph predicates in all three CREATE phases when there are no references', async () => {
    await harness.database.query('ALTER TABLE task_completions DISABLE TRIGGER task_completions_append_only');
    await harness.database.query('DELETE FROM task_completions WHERE tenant_id=$1',
      [harness.tenantOneId]);
    const graphReads: string[] = [];
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && [
        'from transactions', 'from transaction_items', 'from adjustments', 'from inventory_ledger',
      ].some((fragment) => statement.includes(fragment))) graphReads.push(statement);
      return rows;
    });
    await command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    });
    for (const table of ['transactions', 'transaction_items', 'adjustments', 'inventory_ledger']) {
      const reads = graphReads.filter((statement) => statement.includes(`from ${table}`));
      expect(reads, table).toHaveLength(3);
      expect(reads.every((statement) => /\bfalse\b/.test(statement)), table).toBe(true);
    }
  });

  it('rejects a fresh physical item ID duplicating a logical transaction line in every phase',
  async () => {
    await seedReferencedTransactionDependents();
    const before = await state();
    let reads = 0;
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && statement.includes('from transaction_items')) {
        reads += 1;
        return [...rows, { ...(rows[0] as Record<string, unknown>),
          item_id: 'abcdef00-0000-4000-8000-000000000799' }];
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/transaction graph.*(item|identity|schema|duplicate).*integrity/i);
    expect(reads).toBe(1);
    expect(await state()).toEqual(before);
  });

  it.each([
    ['extended arithmetic mismatch', {
      regular_unit_price: '50', regular_total: '50', total_quantity: '2', paid_quantity: '1',
      free_quantity: '0', final_total: '50', total_discount: '0', adjustments_snapshot: [],
      applied_promotions_snapshot: [],
    }],
    ['object JSON snapshot', {
      regular_unit_price: '50', regular_total: '50', total_quantity: '1', paid_quantity: '1',
      free_quantity: '0', final_total: '50', total_discount: '0', adjustments_snapshot: {},
      applied_promotions_snapshot: [],
    }],
  ] as const)('rejects transaction item extended contract fault: %s', async (_label, fault) => {
    await seedReferencedTransactionDependents();
    const before = await state();
    let reads = 0;
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && statement.includes('from transaction_items')) {
        reads += 1;
        return rows.map((raw) => ({ ...(raw as Record<string, unknown>), ...fault }));
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/transaction graph.*transaction item.*integrity/i);
    expect(reads).toBe(1);
    expect(await state()).toEqual(before);
  });

  it('preserves nested __proto__ JSON evidence so a later phase mutation is detected', async () => {
    await seedReferencedTransactionDependents();
    let reads = 0; let auditReached = false;
    const extended = {
      regular_unit_price: '50', regular_total: '50', total_quantity: '1', paid_quantity: '1',
      free_quantity: '0', final_total: '50', total_discount: '0', applied_promotions_snapshot: [],
    };
    const run = observingRunner((statement, rows) => {
      if (statement.includes('from audit_events')) auditReached = true;
      if (statement.startsWith('select ') && statement.includes('from transaction_items')) {
        reads += 1;
        const phase = reads === 1 ? 'initial' : 'changed';
        return rows.map((raw) => ({ ...(raw as Record<string, unknown>), ...extended,
          adjustments_snapshot: JSON.parse(`[{"nested":{"__proto__":{"phase":"${phase}"}}}]`),
        }));
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/transaction graph.*snapshot.*integrity/i);
    expect(reads).toBe(2);
    expect(auditReached).toBe(false);
  });

  it('does not let retained Date aliases rewrite the initial graph snapshot', async () => {
    let retainedOccurred: Date | undefined; let retainedCreated: Date | undefined;
    let reads = 0; let auditReached = false;
    const run = observingRunner((statement, rows) => {
      if (statement.includes('from audit_events')) auditReached = true;
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        reads += 1;
        const transaction = rows[0] as Record<string, unknown>;
        if (reads === 1) {
          retainedOccurred = transaction.occurred_at as Date;
          retainedCreated = transaction.created_at as Date;
        } else {
          retainedOccurred!.setTime(retainedOccurred!.getTime() + 1);
          retainedCreated!.setTime(retainedCreated!.getTime() + 1);
          return rows.map((raw, index) => index === 0 ? { ...(raw as Record<string, unknown>),
            occurred_at: retainedOccurred, created_at: retainedCreated } : raw);
        }
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/transaction graph.*snapshot.*integrity/i);
    expect(reads).toBe(2);
    expect(auditReached).toBe(false);
  });

  it.each([
    { phase: 'pre-audit', occurrence: 2, auditReached: false, terminalReached: false },
    { phase: 'post-terminal', occurrence: 3, auditReached: true, terminalReached: true },
  ])('rejects added, removed, changed, and hidden-link transaction graph faults at $phase',
  async ({ phase, occurrence, auditReached: expectedAudit, terminalReached: expectedTerminal }) => {
    await seedReferencedTransactionDependents();
    const tables = [
      ['transactions', 'from transactions', 'student_name_snapshot'],
      ['transaction items', 'from transaction_items', 'product_name_snapshot'],
      ['adjustments', 'from adjustments', 'operator_snapshot'],
      ['inventory ledger', 'from inventory_ledger', 'reason'],
    ] as const;
    const faults = [
      ['added row', (rows: unknown[]) => [...rows, { ...(rows[0] as Record<string, unknown>) }]],
      ['removed row', (rows: unknown[]) => rows.slice(1)],
      ['changed row', (rows: unknown[], field: string) => rows.map((raw, index) => index === 0
        ? { ...(raw as Record<string, unknown>), [field]: 'adapter-mutation' } : raw)],
      ['unknown parent', (rows: unknown[]) => rows.map((raw, index) => index === 0
        ? { ...(raw as Record<string, unknown>), transaction_id: 'transaction:unknown' } : raw)],
    ] as const;
    for (const [label, tableFragment, changedField] of tables) {
      for (const [faultLabel, mutate] of faults) {
        if (label === 'transactions' && faultLabel === 'unknown parent') continue;
        const before = await state();
        let reads = 0; let auditReached = false; let terminalReached = false;
        const run = observingRunner((statement, rows) => {
          if (statement.includes('from audit_events')) auditReached = true;
          if (statement.startsWith("update operations set status='succeeded'")) terminalReached = true;
          if (statement.startsWith('select ') && statement.includes(tableFragment)
            && ++reads === occurrence) return mutate(rows, changedField);
          return rows;
        });
        await expect(command({ runTenantTransaction: run }).resetBatch({
          operationId: OPERATION_ID, taskIds: ['TASK-001'],
        }), `${label} ${faultLabel} at ${phase}`)
          .rejects.toThrow(/transaction graph.*(snapshot|identity|link|integrity)/i);
        expect(reads).toBeGreaterThanOrEqual(occurrence);
        expect(auditReached).toBe(expectedAudit);
        expect(terminalReached).toBe(expectedTerminal);
        expect(await state()).toEqual(before);
      }
    }
  });

  it.each([
    ['transactions', 'from transactions'],
    ['transaction items', 'from transaction_items'],
    ['adjustments', 'from adjustments'],
    ['inventory ledger', 'from inventory_ledger'],
  ] as const)('rejects sparse and index-getter %s graph rowsets with zero hooks',
  async (_label, tableFragment) => {
    await seedReferencedTransactionDependents();
    for (const shape of ['sparse', 'getter'] as const) {
      const before = await state();
      let hooks = 0; let injected = false;
      const run = observingRunner((statement, rows) => {
        if (!injected && statement.startsWith('select ') && statement.includes(tableFragment)) {
          injected = true;
          if (shape === 'sparse') return new Array(rows.length) as unknown[];
          const malformed: unknown[] = [];
          Object.defineProperty(malformed, '0', { enumerable: true, configurable: true,
            get: () => { hooks += 1; throw new Error('graph row hook executed'); } });
          return malformed;
        }
        return rows;
      });
      await expect(command({ runTenantTransaction: run }).resetBatch({
        operationId: OPERATION_ID, taskIds: ['TASK-001'],
      })).rejects.toThrow(/transaction graph.*rowset.*malformed/i);
      expect(injected).toBe(true);
      expect(hooks).toBe(0);
      expect(await state()).toEqual(before);
    }
  });

  it.each([
    { taskIds: ['TASK-001'] as const, label: 'one-target' },
    { taskIds: ['TASK-002', 'TASK-001'] as const, label: 'many-target' },
  ])('uses constant verb-classified graph SELECT counts and emits no financial writes for $label',
  async ({ taskIds }) => {
    await seedReferencedTransactionDependents();
    const statements: Array<{ verb: string; sql: string }> = [];
    const run = observingRunner((statement, rows) => {
      statements.push({ verb: statement.trimStart().split(/\s+/, 1)[0], sql: statement });
      return rows;
    });
    await command({ runTenantTransaction: run }).resetBatch({ operationId: OPERATION_ID, taskIds });
    for (const table of ['transactions', 'transaction_items', 'adjustments', 'inventory_ledger']) {
      expect(statements.filter(({ verb, sql }) => verb === 'select'
        && sql.includes(`from ${table}`)), table).toHaveLength(3);
    }
    expect(statements.filter(({ verb, sql }) => verb !== 'select'
      && (/\b(transactions|transaction_items|adjustments|inventory_ledger|accounts|products)\b/
        .test(sql)))).toEqual([]);
  });

  it('replay validates provenance while tolerating a legitimate later cancellation graph', async () => {
    const first = await command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] });
    const cancellationOperationId = 'abcdef00-0000-4000-8000-000000000711';
    const cancellationHash = '7'.repeat(64);
    const originalTransactionId = 'task-reward:abcdef00-0000-4000-8000-000000000401';
    const reversalTransactionId = `cancellation:${cancellationOperationId}`;
    await harness.database.query(`INSERT INTO operations
      (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
       attempt_count, started_at, finished_at, created_at, updated_at)
      VALUES ($1, $2, 'CANCELLATION', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
    [harness.tenantOneId, cancellationOperationId, cancellationHash,
      '2026-08-31T02:00:00.000Z']);
    await harness.database.query(`INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
       legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
       legacy_status_snapshot, reverses_transaction_id, operation_id, operation_hash,
       schema_version, created_at)
      VALUES ($1, $2, $3, 'S001', '첫째 학생', 'CANCELLATION', 50, -50, 700, 650,
        'admin-cancellation', 'CANCEL_REVERSAL', $4, $5, $6, 1, $3)`,
    [harness.tenantOneId, reversalTransactionId, '2026-08-31T02:00:00.000Z',
      originalTransactionId, cancellationOperationId, cancellationHash]);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, transaction_id, operation_id,
       operation_hash, schema_version, created_at)
      VALUES ($1, 'task-completion-cancellation:abcdef00-0000-4000-8000-000000000711', $2,
        'INSTANCE-001', 'TASK-001',
        '첫째 과제', 'S001', '첫째 학생', 50, 700, 650, 'CANCELLED',
        'cancels-completion:task-completion:abcdef00-0000-4000-8000-000000000401', $3, $4, $5, 1, 'Asia/Seoul',
        'ADMIN_RESET', 'assignment:TASK-001:S001', $6, $7, $8, 1, $2)`, [
      harness.tenantOneId, '2026-08-31T02:00:00.000Z',
      'v1|INSTANCE-001|r1|2026-08-31T00:00:00Z', CURRENT_START, CURRENT_END,
      reversalTransactionId, cancellationOperationId, cancellationHash,
    ]);
    await expect(command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
      .resolves.toEqual(first);
    const missingBank = observingRunner((statement, rows) => statement.startsWith('select ')
      && statement.includes('from transactions')
      ? rows.filter((raw) => (raw as Record<string, unknown>).kind !== 'TASK_REWARD') : rows);
    await expect(command({ runTenantTransaction: missingBank }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/bank completion transaction provenance.*integrity/i);
    const drifted = observingRunner((statement, rows) => statement.startsWith('select ')
      && statement.includes('from task_completions') ? rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return row.source === 'ADMIN_RESET' && row.operation_id === cancellationOperationId
          ? { ...row, task_name_snapshot: 'wrong copied task name' } : raw;
      }) : rows);
    await expect(command({ runTenantTransaction: drifted }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/cancellation completion transaction provenance.*integrity/i);
  });

  it('historical replay rejects corrupted BANK transaction semantic provenance', async () => {
    await command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] });
    let graphReached = false;
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        graphReached = true;
        return rows.map((raw) => (raw as Record<string, unknown>).kind === 'TASK_REWARD'
          ? { ...(raw as Record<string, unknown>), student_name_snapshot: '다른 학생' } : raw);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/bank completion transaction provenance.*integrity/i);
    expect(graphReached).toBe(true);
  });

  it('historical replay rejects corrupted cancellation semantic provenance', async () => {
    await seedCancellationOnlyCompletionWithOriginalDependent();
    await command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] });
    let graphReached = false;
    const run = observingRunner((statement, rows) => {
      if (statement.startsWith('select ') && statement.includes('from transactions')) {
        graphReached = true;
        return rows.map((raw) => (raw as Record<string, unknown>).kind === 'CANCELLATION'
          ? { ...(raw as Record<string, unknown>), operator_snapshot: 'other-valid-operator' }
          : raw);
      }
      return rows;
    });
    await expect(command({ runTenantTransaction: run }).resetBatch({
      operationId: OPERATION_ID, taskIds: ['TASK-001'],
    })).rejects.toThrow(/cancellation completion transaction provenance.*integrity/i);
    expect(graphReached).toBe(true);
  });

  it('replay tolerates legitimate later assignment history and account lifecycle changes', async () => {
    const first = await command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] });
    await harness.database.query(`UPDATE accounts SET balance=725, version=version+1, updated_at=$3
      WHERE tenant_id=$1 AND student_id=$2`,
    [harness.tenantOneId, 'S001', '2026-09-01T00:05:00.000Z']);
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, created_at, schema_version, note)
      VALUES ($1, 'assignment:TASK-001:S001:later', 'TASK-001', 'INSTANCE-001',
        'v1|INSTANCE-001|r1|2026-09-01T00:00:00Z', $2, $3, 1, 'Asia/Seoul', 'S001',
        'ASSIGNED', 'LEGACY_SEED', NULL, $2, 1, 'later cycle')`,
    [harness.tenantOneId, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);

    await expect(command().resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
      .resolves.toEqual(first);
    const after = await state();
    expect(after.accounts).toEqual(expect.arrayContaining([expect.objectContaining({
      student_id: 'S001', balance: '725', version: '2',
    })]));
    expect(after.assignments).toEqual(expect.arrayContaining([expect.objectContaining({
      assignment_id: 'assignment:TASK-001:S001:later', note: 'later cycle',
    })]));
  });

  it('is tenant isolated', async () => {
    await expect(createDatabaseTaskResetCommands({ tenantId: harness.tenantTwoId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW })
      .resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
      .rejects.toThrow(/target.*not found/i);
    expect((await state()).completions).toHaveLength(2);
  });
});
