import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { getTableColumns } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accounts,
  adjustments,
  inventoryLedger,
  products,
  promotionProducts,
  promotions,
  students,
  taskAllowedStudents,
  taskAssignments,
  taskCompletions,
  tasks,
  transactionItems,
  transactions,
} from '@/server/db/schema';

const TENANT_ONE = '20000000-0000-4000-8000-000000000001';
const TENANT_TWO = '20000000-0000-4000-8000-000000000002';
const TASK_INSTANCE = 'legacy-task-instance/clean-board';
const ASSIGNMENT = 'assignment:2026:student-1';
const COMPLETION = 'completion#legacy-current';
const TRANSACTION = 'ADMIN-transaction-001';
const ITEM = 'a0000000-0000-4000-8000-000000000001';
const INVENTORY_EVENT = 'b0000000-0000-4000-8000-000000000001';
const PROMOTION = 'promotion:buy-one-get-one';
const PROMOTION_PRODUCT = 'promotion-product:legacy-link-1';
const ADJUSTMENT = 'adjustment/admin/001';
const operationalTables = [
  'students',
  'accounts',
  'products',
  'promotions',
  'promotion_products',
  'tasks',
  'task_allowed_students',
  'task_assignments',
  'task_completions',
  'transactions',
  'transaction_items',
  'adjustments',
  'inventory_ledger',
] as const;
const rlsDeleteOrder = [
  'inventory_ledger', 'adjustments', 'transaction_items', 'task_completions',
  'transactions', 'task_assignments', 'task_allowed_students', 'promotion_products',
  'tasks', 'promotions', 'products', 'accounts', 'students',
] as const;

let database: PGlite;
let operationalSql: string;

async function seedTenants() {
  await database.query(
    `INSERT INTO tenants (id, slug, display_name)
     VALUES ($1, 'first-class', 'First Class'), ($2, 'second-class', 'Second Class')`,
    [TENANT_ONE, TENANT_TWO],
  );
}

async function seedDefinitions(tenantId: string) {
  await database.query(
    `INSERT INTO students (tenant_id, student_id, name, status)
     VALUES ($1, 'student-1', 'Student One', 'ACTIVE')`,
    [tenantId],
  );
  await database.query(
    `INSERT INTO accounts (tenant_id, student_id, balance, version)
     VALUES ($1, 'student-1', -50, 1)`,
    [tenantId],
  );
  await database.query(
    `INSERT INTO products
       (tenant_id, product_id, name, price, stock, is_active, sort_order)
     VALUES ($1, 'product-1', 'Pencil', 100, 5, true, 1)`,
    [tenantId],
  );
  await database.query(
    `INSERT INTO promotions
       (tenant_id, promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, starts_at, ends_at, is_active, sort_order)
     VALUES ($1, $2, 'Buy one get one', '', 'N_PLUS_ONE', 1, 1,
       '2026-01-01T00:00:00+09:00', '2027-01-01T00:00:00+09:00', true, 1)`,
    [tenantId, PROMOTION],
  );
  await database.query(
    `INSERT INTO promotion_products
       (tenant_id, promotion_product_id, promotion_id, product_id, schema_version)
     VALUES ($1, $2, $3, 'product-1', 3)`,
    [tenantId, PROMOTION_PRODUCT, PROMOTION],
  );
  await database.query(
    `INSERT INTO tasks
       (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
        current_schedule, schedule_schema_version)
     VALUES ($1, $2, 'task-1', 'Clean board', '', 10, true, 1,
       '{"ruleVersion":1,"effectiveFrom":"2026-01-01T00:00:00+09:00","timeZone":"Asia/Seoul","recurrence":{"type":"DAILY"},"resetCompletionOnCycle":true,"resetAssignmentOnCycle":false}'::jsonb, 1)`,
    [tenantId, TASK_INSTANCE],
  );
  await database.query(
    `INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id)
     VALUES ($1, $2, 'student-1')`,
    [tenantId, TASK_INSTANCE],
  );
}

async function seedHistory(tenantId: string) {
  await seedDefinitions(tenantId);
  await database.query(
    `INSERT INTO task_assignments
       (tenant_id, assignment_id, event_sequence, task_id_snapshot, task_instance_id,
        cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
        event_type, source, created_at, schema_version)
     VALUES ($1, $2, 10, 'task-1', $3, 'cycle-1', '2026-01-01T00:00:00Z',
       NULL, 1, 'Asia/Seoul', 'student-1', 'ASSIGNED',
       'ADMIN', '2026-01-01T00:00:00Z', 1)`,
    [tenantId, ASSIGNMENT, TASK_INSTANCE],
  );
  await database.query(
    `INSERT INTO transactions
       (tenant_id, transaction_id, event_sequence, occurred_at, student_id,
        student_name_snapshot, kind, legacy_total_amount, balance_delta,
        balance_before, balance_after, operator_snapshot, operation_id, operation_hash,
        schema_version)
     VALUES ($1, $2, 20, '2026-01-01T01:00:00Z', 'student-1', 'Student One',
       'ADMIN_ADJUSTMENT', -25, 25, -50, -25, 'Teacher', 'operation/admin/txn',
       'txn-hash', 1)`,
    [tenantId, TRANSACTION],
  );
  await database.query(
    `INSERT INTO adjustments
       (tenant_id, adjustment_id, transaction_id, mode, requested_amount, operator_snapshot)
     VALUES ($1, $2, $3, 'add', 25, 'Teacher')`,
    [tenantId, ADJUSTMENT, TRANSACTION],
  );
  await database.query(
    `INSERT INTO transaction_items
       (tenant_id, item_id, transaction_id, product_id_snapshot, current_product_id,
        product_name_snapshot, quantity, unit_price_snapshot, subtotal_snapshot,
        regular_unit_price, regular_total, total_quantity, paid_quantity, free_quantity,
        final_total, total_discount, adjustments_snapshot, applied_promotions_snapshot)
     VALUES ($1, $2, $3, 'product-1', 'product-1', 'Pencil', 1, 100, 100,
       100, 200, 2, 1, 1, 100, 100,
       '[]'::jsonb, '[]'::jsonb)`,
    [tenantId, ITEM, TRANSACTION],
  );
  await database.query(
    `INSERT INTO inventory_ledger
       (tenant_id, inventory_event_id, event_sequence, product_id, transaction_id,
        quantity_delta, stock_before, stock_after, reason, operation_id, operation_hash,
        occurred_at)
     VALUES ($1, $2, 30, 'product-1', $3, -1, 5, 4, 'CHECKOUT',
       'operation/inventory/1', 'inventory-hash',
       '2026-01-01T01:00:00Z')`,
    [tenantId, INVENTORY_EVENT, TRANSACTION],
  );
  await database.query(
    `INSERT INTO task_completions
       (tenant_id, completion_id, event_sequence, completed_at, task_instance_id,
        task_id_snapshot, task_name_snapshot, student_id, student_name_snapshot,
        reward_snapshot, balance_before, balance_after, status, cycle_id, cycle_start_at,
        cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
        evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
        evidence_author_full_name, operation_id, operation_hash, schema_version)
     VALUES ($1, $2, 40, '2026-01-01T02:00:00Z', $3, 'task-1', 'Clean board',
       'student-1', 'Student One', 10, -25, -15, 'COMPLETED', 'cycle-1',
       '2026-01-01T00:00:00Z', NULL, 1, 'Asia/Seoul', 'ADMIN', $4, $5,
       'PADLET', 'board-1', 'post-1', '2026-01-01T01:30:00Z', 'Student One',
       'operation/completion/1', 'completion-hash', 1)`,
    [tenantId, COMPLETION, TASK_INSTANCE, ASSIGNMENT, TRANSACTION],
  );
}

async function withRuntimeRole<T>(tenantId: string | undefined, operation: () => Promise<T>) {
  await database.exec('BEGIN');
  try {
    await database.exec('SET ROLE app_runtime');
    if (tenantId !== undefined) {
      await database.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    }
    return await operation();
  } finally {
    try {
      await database.exec('ROLLBACK');
    } finally {
      await database.exec('RESET ROLE');
    }
  }
}

beforeEach(async () => {
  const identitySql = await readFile(resolve(
    process.cwd(),
    'src/server/db/migrations/0001_identity_tenants.sql',
  ), 'utf8');
  operationalSql = await readFile(resolve(
    process.cwd(),
    'src/server/db/migrations/0002_operational.sql',
  ), 'utf8');
  database = new PGlite();
  await database.exec(identitySql);
  await database.exec(operationalSql);
});

afterEach(async () => {
  await database?.close();
});

describe('normalized operational schema', () => {
  it('exports typed Drizzle tables for every operational relation', () => {
    const tables = [
      students, accounts, products, promotions, promotionProducts, tasks,
      taskAllowedStudents, taskAssignments, taskCompletions, transactions,
      transactionItems, adjustments, inventoryLedger,
    ];
    expect(tables).toHaveLength(operationalTables.length);
    expect(Object.keys(getTableColumns(accounts))).toEqual(expect.arrayContaining([
      'tenantId', 'studentId', 'balance', 'version',
    ]));
    expect(Object.keys(getTableColumns(taskAssignments))).toContain('eventSequence');
    expect(Object.keys(getTableColumns(taskCompletions))).toEqual(expect.arrayContaining([
      'cycleStartAt', 'cycleEndAt', 'evidenceProvider', 'evidenceBoardId',
      'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName',
    ]));
    expect(Object.keys(getTableColumns(transactionItems))).toEqual(expect.arrayContaining([
      'productIdSnapshot', 'currentProductId', 'unitPriceSnapshot', 'subtotalSnapshot',
      'totalQuantity',
    ]));
    expect(Object.keys(getTableColumns(transactions))).toEqual(expect.arrayContaining([
      'legacyTotalAmount', 'balanceDelta', 'operationId', 'operationHash',
    ]));
  });

  it('round-trips arbitrary source IDs and exact promotion and schedule snapshots', async () => {
    await seedTenants();
    await seedDefinitions(TENANT_ONE);

    const promotion = await database.query<{ promotion_id: string; description: string }>(
      `SELECT promotion_id, description FROM promotions WHERE tenant_id = $1`, [TENANT_ONE],
    );
    expect(promotion.rows).toEqual([{ promotion_id: PROMOTION, description: '' }]);
    const link = await database.query<{ promotion_product_id: string; schema_version: number }>(
      `SELECT promotion_product_id, schema_version FROM promotion_products WHERE tenant_id = $1`,
      [TENANT_ONE],
    );
    expect(link.rows).toEqual([{ promotion_product_id: PROMOTION_PRODUCT, schema_version: 3 }]);
    const task = await database.query<{
      task_instance_id: string; description: string; current_schedule: unknown;
    }>(`SELECT task_instance_id, description, current_schedule FROM tasks WHERE tenant_id = $1`, [TENANT_ONE]);
    expect(task.rows).toEqual([{
      task_instance_id: TASK_INSTANCE,
      description: '',
      current_schedule: {
        ruleVersion: 1,
        effectiveFrom: '2026-01-01T00:00:00+09:00',
        timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY' },
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: false,
      },
    }]);
  });

  it('imports open-ended assignments and legacy completions without fabricated v2 metadata', async () => {
    await seedTenants();
    await seedDefinitions(TENANT_ONE);
    await database.query(
      `INSERT INTO task_assignments
        (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
         cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source)
       VALUES ($1, 'assignment/NONE/open', 'task-1', $2, 'NONE',
         '2026-01-01T00:00:00Z', NULL, 1, 'Asia/Seoul', 'student-1', 'ASSIGNED', 'LEGACY_SEED')`,
      [TENANT_ONE, TASK_INSTANCE],
    );
    await database.query(
      `INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_id_snapshot, task_name_snapshot,
         student_id, student_name_snapshot, reward_snapshot, balance_before, balance_after,
         status, note)
       VALUES ($1, 'legacy completion / 001', '2025-12-31T00:00:00Z', 'legacy-task',
         'Legacy task', 'student-1', 'Student One', 7, -10, -3,
         'IMPORTED_LEGACY_STATUS', 'unaltered legacy row')`,
      [TENANT_ONE],
    );

    const assignment = await database.query<{ assignment_id: string; cycle_end_at: Date | null }>(
      `SELECT assignment_id, cycle_end_at FROM task_assignments WHERE tenant_id = $1`, [TENANT_ONE],
    );
    expect(assignment.rows).toEqual([{ assignment_id: 'assignment/NONE/open', cycle_end_at: null }]);
    const completion = await database.query<{
      completion_id: string; task_instance_id: string | null; cycle_id: string | null;
      rule_version: number | null; timezone: string | null; source: string | null;
      assignment_id: string | null; status: string;
    }>(`SELECT completion_id, task_instance_id, cycle_id, rule_version, timezone, source,
          assignment_id, status FROM task_completions WHERE tenant_id = $1`, [TENANT_ONE]);
    expect(completion.rows).toEqual([{
      completion_id: 'legacy completion / 001', task_instance_id: null, cycle_id: null,
      rule_version: null, timezone: null, source: null, assignment_id: null,
      status: 'IMPORTED_LEGACY_STATUS',
    }]);
  });

  it('preserves base-only pseudo-items and independent extended checkout quantities', async () => {
    await seedTenants();
    await seedHistory(TENANT_ONE);
    await database.query(
      `INSERT INTO transaction_items
        (tenant_id, item_id, transaction_id, line_number, product_id_snapshot,
         product_name_snapshot, quantity, unit_price_snapshot, subtotal_snapshot)
       VALUES ($1, 'a0000000-0000-4000-8000-000000000002', $2, 2,
         'ADMIN-BALANCE-ADJUSTMENT', '관리자 조정', 1, -25, -25)`,
      [TENANT_ONE, TRANSACTION],
    );

    const items = await database.query<{
      product_id_snapshot: string; current_product_id: string | null; quantity: string;
      unit_price_snapshot: string; subtotal_snapshot: string; total_quantity: string | null;
    }>(`SELECT product_id_snapshot, current_product_id, quantity::text,
          unit_price_snapshot::text, subtotal_snapshot::text, total_quantity::text
        FROM transaction_items WHERE tenant_id = $1 ORDER BY line_number`, [TENANT_ONE]);
    expect(items.rows).toEqual([
      {
        product_id_snapshot: 'product-1', current_product_id: 'product-1', quantity: '1',
        unit_price_snapshot: '100', subtotal_snapshot: '100', total_quantity: '2',
      },
      {
        product_id_snapshot: 'ADMIN-BALANCE-ADJUSTMENT', current_product_id: null, quantity: '1',
        unit_price_snapshot: '-25', subtotal_snapshot: '-25', total_quantity: null,
      },
    ]);
  });

  it('scopes stable business IDs to a tenant and rejects cross-tenant relationships', async () => {
    await seedTenants();
    await seedDefinitions(TENANT_ONE);
    await seedDefinitions(TENANT_TWO);
    await database.query(
      `INSERT INTO promotions
       (tenant_id, promotion_id, name, description, type, promotional_price,
        starts_at, ends_at, is_active, sort_order)
       VALUES ($1, 'tenant-two-only-promotion', 'Tenant two only', '',
        'PROMOTIONAL_PRICE', 50, '2026-01-01T00:00:00Z',
        '2026-02-01T00:00:00Z', true, 2)`,
      [TENANT_TWO],
    );

    await expect(database.query(
      `INSERT INTO students (tenant_id, student_id, name, status)
       VALUES ($1, 'student-1', 'Duplicate', 'ACTIVE')`,
      [TENANT_ONE],
    )).rejects.toThrow();

    await expect(database.query(
      `INSERT INTO promotion_products
         (tenant_id, promotion_product_id, promotion_id, product_id, schema_version)
       VALUES ($1, 'cross-tenant-link', 'tenant-two-only-promotion', 'product-1', 3)`,
      [TENANT_ONE],
    )).rejects.toThrow();

    await database.query(
      `INSERT INTO tasks
       (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
        current_schedule, schedule_schema_version)
       VALUES ($1, '60000000-0000-4000-8000-000000000002', 'task-2', 'Second', '', 0,
         true, 2, '{"ruleVersion":1,"effectiveFrom":"2026-01-01","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}', 1)`,
      [TENANT_TWO],
    );
    await expect(database.query(
      `INSERT INTO tasks
       (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
        prerequisite_task_instance_id, current_schedule, schedule_schema_version)
       VALUES ($1, '60000000-0000-4000-8000-000000000003', 'task-2', 'Invalid', '', 0,
         true, 2, '60000000-0000-4000-8000-000000000002',
         '{"ruleVersion":1,"effectiveFrom":"2026-01-01","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}', 1)`,
      [TENANT_ONE],
    )).rejects.toThrow();
  });

  it('accepts signed safe balances but rejects unsafe money, negative stock, and invalid promotion variants', async () => {
    await seedTenants();
    await seedDefinitions(TENANT_ONE);
    const account = await database.query<{ balance: string }>(
      `SELECT balance::text AS balance FROM accounts WHERE tenant_id = $1`,
      [TENANT_ONE],
    );
    expect(account.rows).toEqual([{ balance: '-50' }]);

    await expect(database.query(
      `UPDATE products SET stock = -1 WHERE tenant_id = $1 AND product_id = 'product-1'`,
      [TENANT_ONE],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE accounts SET balance = 9007199254740992 WHERE tenant_id = $1`,
      [TENANT_ONE],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO promotions
       (tenant_id, promotion_id, name, description, type, percent_discount, fixed_discount,
        starts_at, ends_at, is_active, sort_order)
       VALUES ($1, 'c0000000-0000-4000-8000-000000000002', 'Invalid', '',
         'PERCENT_DISCOUNT', 20, 10, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', true, 2)`,
      [TENANT_ONE],
    )).rejects.toThrow();

    const missingVariantValues = [
      ['missing-n-plus-one', 'N_PLUS_ONE', null, 1, null, null, null],
      ['missing-promotional-price', 'PROMOTIONAL_PRICE', null, null, null, null, null],
      ['missing-percent-discount', 'PERCENT_DISCOUNT', null, null, null, null, null],
      ['missing-fixed-discount', 'FIXED_DISCOUNT', null, null, null, null, null],
    ] as const;
    for (const [promotionId, type, buy, free, promotionalPrice, percent, fixed] of missingVariantValues) {
      await expect(database.query(
        `INSERT INTO promotions
         (tenant_id, promotion_id, name, description, type,
          n_plus_one_buy_quantity, n_plus_one_free_quantity, promotional_price,
          percent_discount, fixed_discount, starts_at, ends_at, is_active, sort_order)
         VALUES ($1, $2, 'Missing required value', '', $3, $4, $5, $6, $7, $8,
          '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', true, 3)`,
        [TENANT_ONE, promotionId, type, buy, free, promotionalPrice, percent, fixed],
      ), `${type} must reject a missing required value`).rejects.toThrow();
    }
  });

  it('validates immutable JSON and typed snapshot invariants', async () => {
    await seedTenants();
    await seedDefinitions(TENANT_ONE);
    await expect(database.query(
      `UPDATE tasks SET current_schedule = '[]'::jsonb
       WHERE tenant_id = $1 AND task_instance_id = $2`,
      [TENANT_ONE, TASK_INSTANCE],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE tasks SET current_schedule = '{"ruleVersion":1}'::jsonb
       WHERE tenant_id = $1 AND task_instance_id = $2`,
      [TENANT_ONE, TASK_INSTANCE],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE tasks SET current_schedule =
       '{"ruleVersion":9007199254740992,"effectiveFrom":"2026-01-01","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}'::jsonb
       WHERE tenant_id = $1 AND task_instance_id = $2`,
      [TENANT_ONE, TASK_INSTANCE],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE tasks SET pending_schedule =
       '{"ruleVersion":9007199254740992,"effectiveFrom":"2026-02-01","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}'::jsonb
       WHERE tenant_id = $1 AND task_instance_id = $2`,
      [TENANT_ONE, TASK_INSTANCE],
    )).rejects.toThrow();

    await seedHistory(TENANT_TWO);
    await expect(database.query(
      `UPDATE task_assignments SET previous_assignment_id = assignment_id
       WHERE tenant_id = $1 AND assignment_id = $2`,
      [TENANT_TWO, ASSIGNMENT],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE transactions
       SET kind = 'CANCELLATION', reverses_transaction_id = transaction_id
       WHERE tenant_id = $1 AND transaction_id = $2`,
      [TENANT_TWO, TRANSACTION],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE task_assignments SET task_id_snapshot = '   '
       WHERE tenant_id = $1 AND assignment_id = $2`,
      [TENANT_TWO, ASSIGNMENT],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE task_completions SET task_id_snapshot = '   '
       WHERE tenant_id = $1 AND completion_id = $2`,
      [TENANT_TWO, COMPLETION],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE transactions SET balance_after = balance_before
       WHERE tenant_id = $1 AND transaction_id = $2`,
      [TENANT_TWO, TRANSACTION],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE transaction_items SET adjustments_snapshot = '{}'::jsonb
       WHERE tenant_id = $1 AND item_id = $2`,
      [TENANT_TWO, ITEM],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE inventory_ledger SET stock_after = 6
       WHERE tenant_id = $1 AND inventory_event_id = $2`,
      [TENANT_TWO, INVENTORY_EVENT],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE task_completions SET evidence_provider = NULL
       WHERE tenant_id = $1 AND completion_id = $2`,
      [TENANT_TWO, COMPLETION],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE task_completions SET evidence_board_id = '   '
       WHERE tenant_id = $1 AND completion_id = $2`,
      [TENANT_TWO, COMPLETION],
    )).rejects.toThrow();
  });

  it('keeps history after referenced definitions are inactive or soft-deleted and permits task ID reuse', async () => {
    await seedTenants();
    await seedHistory(TENANT_ONE);
    await database.query(
      `UPDATE students SET status = 'INACTIVE' WHERE tenant_id = $1`,
      [TENANT_ONE],
    );
    await database.query(
      `UPDATE products SET is_active = false, deleted_at = now() WHERE tenant_id = $1`,
      [TENANT_ONE],
    );
    await database.query(
      `UPDATE promotions SET deleted_at = now() WHERE tenant_id = $1`,
      [TENANT_ONE],
    );
    await database.query(
      `UPDATE tasks SET deleted_at = now() WHERE tenant_id = $1`,
      [TENANT_ONE],
    );
    await database.query(
      `INSERT INTO tasks
       (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
        current_schedule, schedule_schema_version)
       VALUES ($1, '60000000-0000-4000-8000-000000000004', 'task-1', 'Replacement', '', 5,
         true, 1, '{"ruleVersion":2,"effectiveFrom":"2026-02-01","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}', 1)`,
      [TENANT_ONE],
    );
    const history = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_assignments a
       JOIN task_completions c USING (tenant_id, task_instance_id)
       JOIN transactions t USING (tenant_id, transaction_id)
       JOIN transaction_items i USING (tenant_id, transaction_id)
       WHERE a.tenant_id = $1`,
      [TENANT_ONE],
    );
    expect(history.rows).toEqual([{ count: '1' }]);
  });

  it('enforces runtime RLS for every operational table under a non-bypass role', async () => {
    await seedTenants();
    await seedHistory(TENANT_ONE);
    await seedHistory(TENANT_TWO);
    await database.exec('CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS');
    await database.exec('GRANT USAGE ON SCHEMA public TO app_runtime');
    await database.exec(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${operationalTables.join(', ')} TO app_runtime`,
    );

    await withRuntimeRole(undefined, async () => {
      for (const table of operationalTables) {
        const rows = await database.query(`SELECT * FROM ${table}`);
        expect(rows.rows, `${table} must fail closed without tenant context`).toEqual([]);
        const updated = await database.query(`UPDATE ${table} SET tenant_id = tenant_id`);
        expect(updated.affectedRows, `${table} update must affect no rows without context`).toBe(0);
        const deleted = await database.query(`DELETE FROM ${table}`);
        expect(deleted.affectedRows, `${table} delete must affect no rows without context`).toBe(0);
      }
      await expect(database.query(
        `INSERT INTO students (tenant_id, student_id, name, status)
         VALUES ($1, 'missing-context-insert', 'Hidden', 'ACTIVE')`,
        [TENANT_ONE],
      )).rejects.toThrow(/row-level security policy/i);
    });

    await withRuntimeRole(TENANT_ONE, async () => {
      for (const table of operationalTables) {
        const own = await database.query(`SELECT tenant_id::text AS tenant_id FROM ${table}`);
        expect(own.rows, `${table} must expose only the selected tenant`).toEqual([
          { tenant_id: TENANT_ONE },
        ]);
        const other = await database.query(
          `SELECT * FROM ${table} WHERE tenant_id = $1`,
          [TENANT_TWO],
        );
        expect(other.rows, `${table} must hide cross-tenant rows`).toEqual([]);
        const ownUpdate = await database.query(
          `UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [TENANT_ONE],
        );
        expect(ownUpdate.affectedRows, `${table} must permit same-tenant updates`).toBe(1);
        const otherUpdate = await database.query(
          `UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`, [TENANT_TWO],
        );
        expect(otherUpdate.affectedRows, `${table} must block cross-tenant updates`).toBe(0);
        const otherDelete = await database.query(
          `DELETE FROM ${table} WHERE tenant_id = $1`, [TENANT_TWO],
        );
        expect(otherDelete.affectedRows, `${table} must block cross-tenant deletes`).toBe(0);
      }

      const inserted = await database.query(
        `INSERT INTO students (tenant_id, student_id, name, status)
         VALUES ($1, 'same-tenant-insert', 'Visible', 'ACTIVE')`,
        [TENANT_ONE],
      );
      expect(inserted.affectedRows).toBe(1);
      const deletedInsert = await database.query(
        `DELETE FROM students WHERE tenant_id = $1 AND student_id = 'same-tenant-insert'`,
        [TENANT_ONE],
      );
      expect(deletedInsert.affectedRows).toBe(1);

      await expect(database.query(
        `INSERT INTO students (tenant_id, student_id, name, status)
         VALUES ($1, 'cross-tenant-insert', 'Hidden', 'ACTIVE')`,
        [TENANT_TWO],
      )).rejects.toThrow(/row-level security policy/i);
    });

    await withRuntimeRole(TENANT_ONE, async () => {
      for (const table of rlsDeleteOrder) {
        const deleted = await database.query(
          `DELETE FROM ${table} WHERE tenant_id = $1`, [TENANT_ONE],
        );
        expect(deleted.affectedRows, `${table} must permit same-tenant deletes`).toBe(1);
      }
    });

    for (const table of operationalTables) {
      await expect(withRuntimeRole(TENANT_ONE, () => database.query(
        `UPDATE ${table} SET tenant_id = $1 WHERE tenant_id = $2`,
        [TENANT_TWO, TENANT_ONE],
      )), `${table} must reject moving an own row into another tenant`)
        .rejects.toThrow(/row-level security policy/i);
    }
  });
});
