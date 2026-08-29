import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTaskRewardPayloadHash,
} from './taskCompletionCommands';
import {
  createCancellationPayloadHash,
  createDatabaseTransactionCommands,
  TransactionCancellationError,
  type DatabaseTransactionCommandDependencies,
} from './transactionCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-28T06:00:00.000Z');
const STUDENT_ID = 'S001';
const ORIGINAL_ID = 'checkout:original-1';
const OPERATION_ID = '30000000-0000-4000-8000-000000000001';
const REWARD_OPERATION_ID = '20000000-0000-4000-8000-000000000009';
const REWARD_ORIGINAL_ID = `task-reward:${REWARD_OPERATION_ID}`;
const REWARD_COMPLETION_ID = `task-completion:${REWARD_OPERATION_ID}`;
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedBase();
});

afterEach(async () => {
  await harness?.close();
});

function commands(overrides: Partial<DatabaseTransactionCommandDependencies> = {}) {
  return createDatabaseTransactionCommands({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => NOW,
    ...overrides,
  });
}

async function seedBase() {
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, $2, '김민준', 'ACTIVE')`,
    [harness.tenantOneId, STUDENT_ID],
  );
  await harness.database.query(
    `INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1, $2, 2900)`,
    [harness.tenantOneId, STUDENT_ID],
  );
  await harness.database.query(
    `INSERT INTO products (tenant_id, product_id, name, price, stock, is_active, sort_order)
     VALUES ($1, 'P002', '지우개', 500, 14, true, 2), ($1, 'P001', '연필', 300, 18, true, 1)`,
    [harness.tenantOneId],
  );
  await harness.database.query(
    `INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
       legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
       legacy_status_snapshot, operation_id, operation_hash, schema_version)
     VALUES ($1, $2, '2026-08-28T05:00:00Z', $3, '김민준', 'CHECKOUT',
             600, -600, 3500, 2900, 'kiosk', 'COMPLETED',
             '20000000-0000-4000-8000-000000000001', $4, 1)`,
    [harness.tenantOneId, ORIGINAL_ID, STUDENT_ID, 'a'.repeat(64)],
  );
  await harness.database.query(
    `INSERT INTO transaction_items
      (tenant_id, transaction_id, line_number, product_id_snapshot, current_product_id,
       product_name_snapshot, quantity, unit_price_snapshot, subtotal_snapshot,
       regular_unit_price, regular_total, total_quantity, paid_quantity, free_quantity,
       final_total, total_discount, adjustments_snapshot, applied_promotions_snapshot)
     VALUES
      ($1, $2, 2, 'P002', 'P002', '지우개', 1, 500, 500, 500, 500, 1, 1, 0, 500, 0, '[]', '[]'),
      ($1, $2, 1, 'P001', 'P001', '연필', 2, 50, 100, 50, 100, 2, 2, 0, 100, 0, '[]', '[]')`,
    [harness.tenantOneId, ORIGINAL_ID],
  );
}

async function snapshot() {
  const [accounts, products, transactions, ledger, operations, items, completions, audits] = await Promise.all([
    harness.database.query(`SELECT balance::text, version::text FROM accounts WHERE tenant_id=$1`, [harness.tenantOneId]),
    harness.database.query(`SELECT product_id, stock::text, version::text
      FROM products WHERE tenant_id=$1 ORDER BY product_id`, [harness.tenantOneId]),
    harness.database.query(`SELECT transaction_id, kind, reverses_transaction_id,
      legacy_total_amount::text, balance_delta::text, balance_before::text, balance_after::text,
      student_id, student_name_snapshot, operator_snapshot, legacy_status_snapshot,
      operation_id, operation_hash FROM transactions WHERE tenant_id=$1 ORDER BY transaction_id`, [harness.tenantOneId]),
    harness.database.query(`SELECT product_id, transaction_id, quantity_delta::text,
      stock_before::text, stock_after::text, reason, operation_id, operation_hash
      FROM inventory_ledger WHERE tenant_id=$1 ORDER BY product_id`, [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1`, [harness.tenantOneId]),
    harness.database.query(`SELECT transaction_id, line_number, product_id_snapshot FROM transaction_items WHERE tenant_id=$1 ORDER BY transaction_id, line_number`, [harness.tenantOneId]),
    harness.database.query(`SELECT completion_id, completed_at, task_instance_id, task_id_snapshot,
      task_name_snapshot, student_id, student_name_snapshot, reward_snapshot::text,
      balance_before::text, balance_after::text, status, note, cycle_id, cycle_start_at,
      cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
      operation_id, operation_hash, schema_version, evidence_provider, evidence_board_id,
      evidence_post_id, evidence_created_at, evidence_author_full_name
      FROM task_completions WHERE tenant_id=$1 ORDER BY completion_id`, [harness.tenantOneId]),
    harness.database.query(`SELECT operation_id, event_type, entity_type, entity_id,
      redacted_details, occurred_at
      FROM audit_events WHERE tenant_id=$1 ORDER BY event_id`, [harness.tenantOneId]),
  ]);
  return {
    accounts: accounts.rows,
    products: products.rows,
    transactions: transactions.rows,
    ledger: ledger.rows,
    operations: operations.rows,
    items: items.rows,
    completions: completions.rows,
    audits: audits.rows,
  };
}

async function seedValidTaskReward() {
  const rewardHash = createTaskRewardPayloadHash({
    taskId: 'TASK-1',
    taskInstanceId: 'INSTANCE-1',
    taskTitle: '과제',
    studentId: STUDENT_ID,
    studentName: '김민준',
    assignmentId: 'ASSIGNMENT-1',
    cycleId: 'cycle-1',
    cycleStartsAt: '2026-08-28T00:00:00.000Z',
    cycleEndsAt: '2026-08-29T00:00:00.000Z',
    reward: 500,
  });
  await harness.withImmutableLedgerTampering(async () => {
    await harness.database.query(`DELETE FROM transaction_items WHERE tenant_id=$1`, [harness.tenantOneId]);
    await harness.database.query(`DELETE FROM transactions WHERE tenant_id=$1`, [harness.tenantOneId]);
  });
  await harness.database.query(`UPDATE accounts SET balance=1000 WHERE tenant_id=$1 AND student_id=$2`, [harness.tenantOneId, STUDENT_ID]);
  await harness.database.query(
    `INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active,
       sort_order, current_schedule, schedule_schema_version, created_at, updated_at)
     VALUES ($1, 'INSTANCE-1', 'TASK-1', '과제', '설명', 500, true, 1,
       '{"ruleVersion":1,"effectiveFrom":"2026-08-28T00:00:00.000Z","timeZone":"Asia/Seoul","recurrence":{"type":"DAILY","time":"09:00"},"resetCompletionOnCycle":true,"resetAssignmentOnCycle":true}'::jsonb,
       1, '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`,
    [harness.tenantOneId],
  );
  await harness.database.query(
    `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, created_at, schema_version)
     VALUES ($1, 'ASSIGNMENT-1', 'TASK-1', 'INSTANCE-1', 'cycle-1',
       '2026-08-28T00:00:00Z', '2026-08-29T00:00:00Z', 1, 'Asia/Seoul', $2,
       'ASSIGNED', 'ADMIN', '2026-08-28T00:00:00Z', 1)`,
    [harness.tenantOneId, STUDENT_ID],
  );
  await harness.database.query(
    `INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
       legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
       legacy_status_snapshot, operation_id, operation_hash, schema_version)
     VALUES ($1, $2, '2026-08-28T05:00:00Z', $3, '김민준', 'TASK_REWARD',
       500, 500, 500, 1000, 'bank-task-completion', 'COMPLETED', $4, $5, 1)`,
    [harness.tenantOneId, REWARD_ORIGINAL_ID, STUDENT_ID, REWARD_OPERATION_ID, rewardHash],
  );
  await harness.database.query(
    `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
       operation_id, operation_hash, schema_version)
     VALUES ($1, $2, '2026-08-28T05:00:00Z', 'INSTANCE-1',
       'TASK-1', '과제', $3, '김민준', 500, 500, 1000, 'COMPLETED',
       'bank-self-completion', 'cycle-1', '2026-08-28T00:00:00Z',
       '2026-08-29T00:00:00Z', 1, 'Asia/Seoul', 'BANK', 'ASSIGNMENT-1', $4,
       $5, $6, 1)`,
    [harness.tenantOneId, REWARD_COMPLETION_ID, STUDENT_ID, REWARD_ORIGINAL_ID, REWARD_OPERATION_ID, rewardHash],
  );
}

describe('database transaction cancellation commands', () => {
  it('atomically negates the original balance delta, restores checkout stock, and links one immutable reversal', async () => {
    const result = await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });

    expect(result).toEqual({
      ok: true,
      operationId: OPERATION_ID,
      originalTransactionId: ORIGINAL_ID,
      reversalTransactionId: `cancellation:${OPERATION_ID}`,
      studentId: STUDENT_ID,
      studentName: '김민준',
      originalKind: 'CHECKOUT',
      reversalAmount: 600,
      balanceBefore: 2900,
      balanceAfter: 3500,
      restoredItems: [
        { productId: 'P001', productName: '연필', quantity: 2 },
        { productId: 'P002', productName: '지우개', quantity: 1 },
      ],
      originalCompletionId: null,
      cancellationCompletionId: null,
      cancelledAt: NOW.toISOString(),
    });
    const state = await snapshot();
    expect(state.accounts).toEqual([{ balance: '3500', version: '2' }]);
    expect(state.products).toEqual([
      { product_id: 'P001', stock: '20', version: '2' },
      { product_id: 'P002', stock: '15', version: '2' },
    ]);
    expect(state.transactions).toHaveLength(2);
    expect(state.transactions.find((row) => (row as { kind?: string }).kind === 'CANCELLATION')).toMatchObject({
      transaction_id: `cancellation:${OPERATION_ID}`,
      kind: 'CANCELLATION', reverses_transaction_id: ORIGINAL_ID,
      legacy_total_amount: '-600', balance_delta: '600', balance_before: '2900', balance_after: '3500',
      student_id: STUDENT_ID, student_name_snapshot: '김민준',
      operator_snapshot: 'admin-cancellation', legacy_status_snapshot: 'CANCEL_REVERSAL',
      operation_id: OPERATION_ID,
    });
    expect(state.ledger).toEqual([
      { product_id: 'P001', transaction_id: `cancellation:${OPERATION_ID}`, quantity_delta: '2', stock_before: '18', stock_after: '20', reason: 'CANCELLATION', operation_id: null, operation_hash: null },
      { product_id: 'P002', transaction_id: `cancellation:${OPERATION_ID}`, quantity_delta: '1', stock_before: '14', stock_after: '15', reason: 'CANCELLATION', operation_id: null, operation_hash: null },
    ]);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]).toMatchObject({ operation_kind: 'CANCELLATION', status: 'SUCCEEDED', result_snapshot: result });
    expect(state.audits).toEqual([{
      operation_id: OPERATION_ID,
      event_type: 'CANCELLATION_COMPLETED',
      entity_type: 'TRANSACTION',
      entity_id: result.reversalTransactionId,
      redacted_details: {
        originalTransactionId: ORIGINAL_ID,
        cancellationTransactionId: result.reversalTransactionId,
        studentId: STUDENT_ID,
        reversalAmount: 600,
      },
      occurred_at: NOW,
    }]);
    expect(state.items).toHaveLength(2);
  });

  it('returns the exact stored result on retry without another mutation', async () => {
    const first = await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });
    const second = await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });
    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.accounts).toEqual([{ balance: '3500', version: '2' }]);
    expect(state.products).toEqual([
      { product_id: 'P001', stock: '20', version: '2' },
      { product_id: 'P002', stock: '15', version: '2' },
    ]);
    expect(state.transactions).toHaveLength(2);
    expect(state.ledger).toHaveLength(2);
    expect(state.audits).toHaveLength(1);
  });

  it('fails closed when a successful cancellation replay is missing its immutable audit', async () => {
    await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });
    await harness.database.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    await harness.database.query(
      'DELETE FROM audit_events WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, OPERATION_ID],
    );
    await harness.database.exec('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');

    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID }))
      .rejects.toThrow(/audit integrity/i);
  });

  it('fails closed when an operation is pending or bound to another kind/payload', async () => {
    const hash = await authoritativeHash();
    await harness.database.query(
      `INSERT INTO operations (tenant_id, operation_id, operation_kind, payload_hash, status, started_at, created_at, updated_at)
       VALUES ($1, $2, 'CANCELLATION', $3, 'PENDING', $4, $4, $4)`,
      [harness.tenantOneId, OPERATION_ID, hash, NOW],
    );
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'OPERATION_PENDING' });

    await harness.database.query(`DELETE FROM operations WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, OPERATION_ID]);
    await harness.database.query(
      `INSERT INTO operations (tenant_id, operation_id, operation_kind, payload_hash, status, started_at, created_at, updated_at)
       VALUES ($1, $2, 'TASK_REWARD', $3, 'PENDING', $4, $4, $4)`,
      [harness.tenantOneId, OPERATION_ID, hash, NOW],
    );
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const state = await snapshot();
    expect(state.transactions).toHaveLength(1);
    expect(state.audits).toHaveLength(0);
  });

  it('validates canonical UUID and an optional lowercase SHA-256 before tenant authority', async () => {
    const calls = vi.fn();
    const runTenantTransaction: DatabaseTransactionCommandDependencies['runTenantTransaction'] = async (tenantId, callback) => {
      calls();
      return harness.runTenantTransaction(tenantId, callback);
    };
    await expect(commands({ runTenantTransaction }).cancel({ operationId: 'NOT-A-UUID', transactionId: ORIGINAL_ID }))
      .rejects.toThrow(/operation/i);
    await expect(commands({ runTenantTransaction }).cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID, payloadHash: 'A'.repeat(64) }))
      .rejects.toThrow(/hash/i);
    expect(calls).not.toHaveBeenCalled();
  });

  it('rejects a caller hash that differs from authoritative immutable reversal semantics', async () => {
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID, payloadHash: 'b'.repeat(64) }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect((await snapshot()).operations).toHaveLength(0);
  });

  it.each([
    ['missing extended checkout snapshot', `UPDATE transaction_items SET total_quantity=NULL, regular_unit_price=NULL, regular_total=NULL, paid_quantity=NULL, free_quantity=NULL, final_total=NULL, total_discount=NULL, adjustments_snapshot=NULL, applied_promotions_snapshot=NULL WHERE tenant_id=$1 AND transaction_id=$2`],
    ['duplicate product snapshot', `UPDATE transaction_items SET product_id_snapshot='P001', current_product_id='P001' WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=2`],
    ['inconsistent checkout total', `UPDATE transaction_items SET final_total=499 WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=2`],
    ['quantity alias drift', `UPDATE transaction_items SET quantity=1 WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=1`],
    ['unit-price alias drift', `UPDATE transaction_items SET unit_price_snapshot=51 WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=1`],
    ['subtotal alias drift', `UPDATE transaction_items SET subtotal_snapshot=99 WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=1`],
    ['regular multiplication drift', `UPDATE transaction_items SET regular_total=101, total_discount=1 WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=1`],
    ['promotion-chain drift', `UPDATE transaction_items SET adjustments_snapshot='[{"promotionId":"PROMO-1","type":"FIXED_DISCOUNT","beforeAmount":100,"afterAmount":100,"discountAmount":0}]'::jsonb WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=1`],
  ])('requires manual reconciliation for a malformed legacy transaction: %s', async (_label, mutation) => {
    await harness.database.query(mutation, [harness.tenantOneId, ORIGINAL_ID]);
    const before = await snapshot();
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'MANUAL_RECONCILIATION_REQUIRED' });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects cancellation-of-cancellation and an original already linked by any reversal', async () => {
    await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });
    await expect(commands().cancel({ operationId: '30000000-0000-4000-8000-000000000002', transactionId: ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    await expect(commands().cancel({ operationId: '30000000-0000-4000-8000-000000000003', transactionId: `cancellation:${OPERATION_ID}` }))
      .rejects.toMatchObject({ code: 'NOT_REVERSIBLE' });
  });

  it.each([
    ['ADMIN_ADJUSTMENT', -200, 1200, 1000],
  ] as const)('reverses valid %s balance semantics without inventory mutation', async (kind, delta, before, after) => {
    await harness.withImmutableLedgerTampering(async () => {
      await harness.database.query(`DELETE FROM transaction_items WHERE tenant_id=$1`, [harness.tenantOneId]);
      await harness.database.query(`DELETE FROM transactions WHERE tenant_id=$1`, [harness.tenantOneId]);
    });
    await harness.database.query(`UPDATE accounts SET balance=$2 WHERE tenant_id=$1 AND student_id=$3`, [harness.tenantOneId, after, STUDENT_ID]);
    await harness.database.query(
      `INSERT INTO transactions
        (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
         legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot)
       VALUES ($1, $2, $3, $4, '김민준', $5, $6, $7, $8, $9, 'admin', 'COMPLETED')`,
      [harness.tenantOneId, ORIGINAL_ID, NOW, STUDENT_ID, kind, delta, delta, before, after],
    );
    const result = await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });
    expect(result).toMatchObject({ originalKind: kind, balanceBefore: after, balanceAfter: before, restoredItems: [] });
    expect((await snapshot()).ledger).toHaveLength(0);
  });

  it('appends an auditable CANCELLED completion linked to the task reward reversal', async () => {
    await seedValidTaskReward();

    const result = await commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID });

    expect(result).toMatchObject({
      originalKind: 'TASK_REWARD', balanceBefore: 1000, balanceAfter: 500,
      originalCompletionId: REWARD_COMPLETION_ID,
      cancellationCompletionId: `task-completion-cancellation:${OPERATION_ID}`,
    });
    const state = await snapshot();
    expect(state.completions).toHaveLength(2);
    expect(state.completions[0]).toMatchObject({
      completion_id: `task-completion-cancellation:${OPERATION_ID}`,
      task_instance_id: 'INSTANCE-1', task_id_snapshot: 'TASK-1', task_name_snapshot: '과제',
      student_id: STUDENT_ID, student_name_snapshot: '김민준', reward_snapshot: '500',
      balance_before: '1000', balance_after: '500', status: 'CANCELLED',
      note: `cancels-completion:${REWARD_COMPLETION_ID}`, cycle_id: 'cycle-1',
      rule_version: 1, timezone: 'Asia/Seoul', source: 'ADMIN_RESET',
      assignment_id: 'ASSIGNMENT-1', transaction_id: `cancellation:${OPERATION_ID}`,
      operation_id: OPERATION_ID, schema_version: 1,
      evidence_provider: null, evidence_board_id: null, evidence_post_id: null,
      evidence_created_at: null, evidence_author_full_name: null,
    });
    expect(state.completions[1]).toMatchObject({
      completion_id: REWARD_COMPLETION_ID, status: 'COMPLETED',
      transaction_id: REWARD_ORIGINAL_ID,
    });
  });

  it('accepts a complete Padlet evidence snapshot whose provider author differs from the student name', async () => {
    await seedValidTaskReward();
    const evidenceHash = createTaskRewardPayloadHash({
      taskId: 'TASK-1', taskInstanceId: 'INSTANCE-1', taskTitle: '과제',
      studentId: STUDENT_ID, studentName: '김민준', assignmentId: 'ASSIGNMENT-1',
      cycleId: 'cycle-1', cycleStartsAt: '2026-08-28T00:00:00.000Z',
      cycleEndsAt: '2026-08-29T00:00:00.000Z', reward: 500,
      evidence: {
        evidenceProvider: 'PADLET', evidenceBoardId: 'AbCdEfGhIjKlMnOp', evidencePostId: 'post-001',
        evidenceCreatedAt: '2026-08-28T04:00:00.000Z', evidenceAuthorFullName: '보호자 작성자',
      },
    });
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      `UPDATE transactions SET operation_hash=$3 WHERE tenant_id=$1 AND transaction_id=$2`,
      [harness.tenantOneId, REWARD_ORIGINAL_ID, evidenceHash],
    ));
    await harness.database.query(
      `UPDATE task_completions
       SET evidence_provider='PADLET', evidence_board_id='AbCdEfGhIjKlMnOp', evidence_post_id='post-001',
           evidence_created_at='2026-08-28T04:00:00Z', evidence_author_full_name='보호자 작성자',
           operation_hash=$3
       WHERE tenant_id=$1 AND transaction_id=$2`,
      [harness.tenantOneId, REWARD_ORIGINAL_ID, evidenceHash],
    );

    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID }))
      .resolves.toMatchObject({ originalKind: 'TASK_REWARD' });
  });

  it('rolls back the reversal transaction and cancellation completion on injected ledger failure', async () => {
    await seedValidTaskReward();
    const before = await snapshot();
    await expect(commands({ afterReversalTransaction: vi.fn().mockRejectedValue(new Error('injected reversal')) })
      .cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID })).rejects.toThrow('injected reversal');
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['missing original completion', `DELETE FROM task_completions WHERE tenant_id=$1 AND transaction_id=$2`, () => [harness.tenantOneId, REWARD_ORIGINAL_ID]],
    ['duplicate original completion', `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_id_snapshot, task_name_snapshot,
       student_id, student_name_snapshot, reward_snapshot, balance_before, balance_after,
       status, transaction_id, schema_version)
      VALUES ($1, 'duplicate-completion', '2026-08-28T05:00:00Z', 'TASK-1', '과제',
       $3, '김민준', 500, 500, 1000, 'COMPLETED', $2, 1)`, () => [harness.tenantOneId, REWARD_ORIGINAL_ID, STUDENT_ID]],
    ['drifted original completion', `UPDATE task_completions SET reward_snapshot=499 WHERE tenant_id=$1 AND transaction_id=$2`, () => [harness.tenantOneId, REWARD_ORIGINAL_ID]],
  ])('rejects a %s before mutation', async (_label, mutation, parameters) => {
    await seedValidTaskReward();
    await harness.database.query(mutation, parameters());
    const before = await snapshot();
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'MANUAL_RECONCILIATION_REQUIRED' });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['task reward payload hash drift', `UPDATE task_completions SET task_name_snapshot='변조된 과제' WHERE tenant_id=$1 AND transaction_id=$2`, () => [harness.tenantOneId, REWARD_ORIGINAL_ID]],
    ['linked assignment drift', `UPDATE task_assignments SET task_id_snapshot='OTHER-TASK' WHERE tenant_id=$1 AND assignment_id='ASSIGNMENT-1'`, () => [harness.tenantOneId]],
  ])('rejects %s before cancellation mutation', async (_label, mutation, parameters) => {
    await seedValidTaskReward();
    await harness.database.query(mutation, parameters());
    const before = await snapshot();

    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'MANUAL_RECONCILIATION_REQUIRED' });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects an unexpected task completion linked to a non-task transaction', async () => {
    await harness.database.query(
      `INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_id_snapshot, task_name_snapshot,
         student_id, student_name_snapshot, reward_snapshot, balance_before, balance_after,
         status, transaction_id, schema_version)
       VALUES ($1, 'unexpected-completion', $2, 'TASK-X', 'unexpected', $3, '김민준',
         0, 2900, 2900, 'COMPLETED', $4, 1)`,
      [harness.tenantOneId, NOW, STUDENT_ID, ORIGINAL_ID],
    );
    const before = await snapshot();
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'MANUAL_RECONCILIATION_REQUIRED' });
    expect(await snapshot()).toEqual(before);
  });

  it('returns the exact task completion linkage on retry without another event', async () => {
    await seedValidTaskReward();
    const first = await commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID });
    const second = await commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID });
    expect(second).toEqual(first);
    expect((await snapshot()).completions).toHaveLength(2);
  });

  it.each([
    ['missing', `DELETE FROM task_completions WHERE tenant_id=$1 AND completion_id=$2`, () => [harness.tenantOneId, `task-completion-cancellation:${OPERATION_ID}`]],
    ['extra', `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_id_snapshot, task_name_snapshot,
       student_id, student_name_snapshot, reward_snapshot, balance_before, balance_after,
       status, transaction_id, schema_version)
      VALUES ($1, 'extra-cancellation', $2, 'TASK-1', '과제', $3, '김민준', 500,
       1000, 500, 'CANCELLED', $4, 1)`, () => [harness.tenantOneId, NOW, STUDENT_ID, `cancellation:${OPERATION_ID}`]],
    ['drifted', `UPDATE task_completions SET note='drifted' WHERE tenant_id=$1 AND completion_id=$2`, () => [harness.tenantOneId, `task-completion-cancellation:${OPERATION_ID}`]],
  ])('rejects retry when the cancellation completion is %s', async (_label, mutation, parameters) => {
    await seedValidTaskReward();
    await commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID });
    await harness.database.query(mutation, parameters());
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID }))
      .rejects.toThrow(/stored|completion|integrity/i);
  });

  it('rejects a reversal that would produce a negative balance', async () => {
    await seedValidTaskReward();
    const largeRewardHash = createTaskRewardPayloadHash({
      taskId: 'TASK-1', taskInstanceId: 'INSTANCE-1', taskTitle: '과제',
      studentId: STUDENT_ID, studentName: '김민준', assignmentId: 'ASSIGNMENT-1',
      cycleId: 'cycle-1', cycleStartsAt: '2026-08-28T00:00:00.000Z',
      cycleEndsAt: '2026-08-29T00:00:00.000Z', reward: 5000,
    });
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      `UPDATE transactions SET legacy_total_amount=5000, balance_delta=5000,
         balance_before=-4000, balance_after=1000, operation_hash=$3
       WHERE tenant_id=$1 AND transaction_id=$2`,
      [harness.tenantOneId, REWARD_ORIGINAL_ID, largeRewardHash],
    ));
    await harness.database.query(
      `UPDATE task_completions SET reward_snapshot=5000, balance_before=-4000,
         balance_after=1000, operation_hash=$3 WHERE tenant_id=$1 AND transaction_id=$2`,
      [harness.tenantOneId, REWARD_ORIGINAL_ID, largeRewardHash],
    );
    const before = await snapshot();
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: REWARD_ORIGINAL_ID }))
      .rejects.toMatchObject({ code: 'NEGATIVE_BALANCE' });
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back account, stock, operation, reversal, and inventory ledger on injected failure', async () => {
    const before = await snapshot();
    await expect(commands({ afterResourceUpdates: vi.fn().mockRejectedValue(new Error('injected')) })
      .cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID })).rejects.toThrow('injected');
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['reversal timestamp', `UPDATE transactions SET occurred_at='2026-08-28T07:00:00Z' WHERE tenant_id=$1 AND transaction_id=$2`],
    ['reversal schema version', `UPDATE transactions SET schema_version=2 WHERE tenant_id=$1 AND transaction_id=$2`],
    ['inventory timestamp', `UPDATE inventory_ledger SET occurred_at='2026-08-28T07:00:00Z' WHERE tenant_id=$1 AND transaction_id=$2`],
    ['unexpected reversal item', `INSERT INTO transaction_items
      (tenant_id, transaction_id, line_number, product_id_snapshot, product_name_snapshot,
       quantity, unit_price_snapshot, subtotal_snapshot)
      VALUES ($1, $2, 1, 'REVERSAL', 'unexpected', 1, 0, 0)`],
  ])('rejects replay after immutable %s drift', async (_label, mutation) => {
    await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      mutation,
      [harness.tenantOneId, `cancellation:${OPERATION_ID}`],
    ));
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID }))
      .rejects.toThrow(/stored|ledger|snapshot|integrity/i);
  });

  it('rejects stored-success or immutable-ledger drift instead of trusting the operation snapshot', async () => {
    await commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID });
    await harness.database.query(
      `UPDATE inventory_ledger SET stock_after=stock_after+1, quantity_delta=quantity_delta+1
       WHERE tenant_id=$1 AND product_id='P001'`,
      [harness.tenantOneId],
    );
    await expect(commands().cancel({ operationId: OPERATION_ID, transactionId: ORIGINAL_ID }))
      .rejects.toThrow(/stored|ledger|snapshot|integrity/i);
  });

  it('contains deterministic PostgreSQL lock order for operation, original, account, and sorted products', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/server/repositories/database/transactionCommands.ts'), 'utf8');
    expect(source).toMatch(/LOCK ORDER/);
    expect(source).toMatch(/FROM operations[\s\S]*FOR UPDATE/);
    expect(source).toMatch(/FROM transactions[\s\S]*transaction_id=[\s\S]*FOR UPDATE/);
    expect(source).toMatch(/FOR UPDATE OF s, a/);
    expect(source).toMatch(/ORDER BY product_id[\s\S]*FOR UPDATE/);
  });
});

async function authoritativeHash() {
  const row = await harness.database.query(`SELECT * FROM transactions WHERE tenant_id=$1 AND transaction_id=$2`, [harness.tenantOneId, ORIGINAL_ID]);
  const items = await harness.database.query(`SELECT * FROM transaction_items WHERE tenant_id=$1 AND transaction_id=$2 ORDER BY line_number`, [harness.tenantOneId, ORIGINAL_ID]);
  return createCancellationPayloadHash(row.rows[0] as never, items.rows as never);
}

void TransactionCancellationError;
