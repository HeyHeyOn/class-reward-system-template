import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminAdjustmentLedgerOperationId,
  createAdminAdjustmentPayloadHash,
  createAdminAdjustmentResultHash,
  createDatabaseAdminCommands,
  type DatabaseAdminCommandDependencies,
} from './adminCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-28T06:00:00.000Z');
const OPERATION_ID = '40000000-0000-4000-8000-000000000001';
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedStudent(harness.tenantOneId, 'S002', '이서준', 500);
  await seedStudent(harness.tenantOneId, 'S001', '김민준', 1000);
  await seedStudent(harness.tenantTwoId, 'S001', '다른반', 9000);
});

afterEach(async () => harness?.close());

function commands(overrides: Partial<DatabaseAdminCommandDependencies> = {}) {
  return createDatabaseAdminCommands({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => NOW,
    ...overrides,
  });
}

async function seedStudent(tenantId: string, studentId: string, name: string, balance: number) {
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenantId, studentId, name],
  );
  await harness.database.query(
    `INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1, $2, $3)`,
    [tenantId, studentId, balance],
  );
}

async function snapshot(tenantId = harness.tenantOneId) {
  const [accounts, transactions, operations, items, inventory, completions, adjustments, audits] = await Promise.all([
    harness.database.query(`SELECT student_id, balance::text, version FROM accounts WHERE tenant_id=$1 ORDER BY student_id`, [tenantId]),
    harness.database.query(`SELECT transaction_id, occurred_at, student_id, student_name_snapshot, kind,
      legacy_total_amount::text, balance_delta::text, balance_before::text, balance_after::text,
      operator_snapshot, legacy_status_snapshot, operation_id, operation_hash, schema_version
      FROM transactions WHERE tenant_id=$1 ORDER BY transaction_id`, [tenantId]),
    harness.database.query(`SELECT operation_id, operation_kind, payload_hash, status, result_snapshot FROM operations WHERE tenant_id=$1 ORDER BY operation_id`, [tenantId]),
    harness.database.query(`SELECT transaction_id FROM transaction_items WHERE tenant_id=$1`, [tenantId]),
    harness.database.query(`SELECT transaction_id FROM inventory_ledger WHERE tenant_id=$1`, [tenantId]),
    harness.database.query(`SELECT transaction_id FROM task_completions WHERE tenant_id=$1`, [tenantId]),
    harness.database.query(`SELECT adjustment_id, transaction_id, mode, requested_amount::text,
      operator_snapshot, legacy_adjustment_id FROM adjustments WHERE tenant_id=$1 ORDER BY adjustment_id`, [tenantId]),
    harness.database.query(`SELECT operation_id, event_type, entity_type, entity_id,
      redacted_details, occurred_at FROM audit_events WHERE tenant_id=$1 ORDER BY event_id`, [tenantId]),
  ]);
  return { accounts: accounts.rows, transactions: transactions.rows, operations: operations.rows, items: items.rows, inventory: inventory.rows, completions: completions.rows, adjustments: adjustments.rows, audits: audits.rows };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION_ID,
  studentIds: ['S001'],
  mode: 'add' as const,
  amount: 250,
  ...overrides,
});

describe('PostgreSQL transactional admin balance adjustments', () => {
  it('adds balance and writes the exact immutable ledger and success snapshot', async () => {
    const result = await commands().adjust(input());
    const hash = createAdminAdjustmentPayloadHash({ studentIds: ['S001'], mode: 'add', amount: 250 });
    expect(result).toEqual({
      ok: true, operationId: OPERATION_ID, mode: 'add', amount: 250,
      adjustedAt: NOW.toISOString(),
      students: [{ studentId: 'S001', studentName: '김민준', balanceBefore: 1000, balanceAfter: 1250, delta: 250, transactionId: `admin-adjustment:${OPERATION_ID}:S001` }],
    });
    const state = await snapshot();
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '1250', version: 2 }, { student_id: 'S002', balance: '500', version: 1 }]);
    expect(state.transactions).toEqual([expect.objectContaining({
      transaction_id: `admin-adjustment:${OPERATION_ID}:S001`, occurred_at: NOW,
      student_id: 'S001', student_name_snapshot: '김민준', kind: 'ADMIN_ADJUSTMENT',
      legacy_total_amount: '-250', balance_delta: '250', balance_before: '1000', balance_after: '1250',
      operator_snapshot: 'admin', legacy_status_snapshot: 'ADMIN_ADJUSTMENT',
      operation_id: createAdminAdjustmentLedgerOperationId(OPERATION_ID, 'S001'),
      operation_hash: hash, schema_version: 1,
    })]);
    expect(state.operations).toEqual([expect.objectContaining({ operation_kind: 'ADMIN_ADJUSTMENT', payload_hash: hash, status: 'SUCCEEDED', result_snapshot: result })]);
    expect(state.items).toEqual([]);
    expect(state.inventory).toEqual([]);
    expect(state.completions).toEqual([]);
    expect(state.adjustments).toEqual([{
      adjustment_id: `adjustment:${OPERATION_ID}:S001`,
      transaction_id: `admin-adjustment:${OPERATION_ID}:S001`,
      mode: 'add', requested_amount: '250', operator_snapshot: 'admin', legacy_adjustment_id: null,
    }]);
    expect(state.audits).toEqual([{
      operation_id: OPERATION_ID,
      event_type: 'ADMIN_ADJUSTMENT_COMPLETED',
      entity_type: 'OPERATION',
      entity_id: OPERATION_ID,
      redacted_details: {
        amount: 250,
        changedStudentCount: 1,
        mode: 'add',
        resultHash: createAdminAdjustmentResultHash(result),
        studentCount: 1,
      },
      occurred_at: NOW,
    }]);
  });

  it.each([
    ['set', 400, 1000, 400, -600],
    ['subtract', 400, 1000, 600, -400],
  ] as const)('%s computes from one locked balance snapshot', async (mode, amount, before, after, delta) => {
    const result = await commands().adjust(input({ mode, amount }));
    expect(result.students[0]).toMatchObject({ balanceBefore: before, balanceAfter: after, delta });
    expect((await snapshot()).transactions[0]).toMatchObject({ legacy_total_amount: String(-delta), balance_delta: String(delta) });
  });

  it('trims then sorts canonical student IDs and returns stable student_id order', async () => {
    const result = await commands().adjust(input({ studentIds: [' S002 ', 'S001'] }));
    expect(result.students.map((student) => student.studentId)).toEqual(['S001', 'S002']);
    expect(result.students.map((student) => student.balanceAfter)).toEqual([1250, 750]);
    const ledgers = (await snapshot()).transactions;
    expect(ledgers.map((row) => (row as { operation_id: string }).operation_id)).toEqual([
      createAdminAdjustmentLedgerOperationId(OPERATION_ID, 'S001'),
      createAdminAdjustmentLedgerOperationId(OPERATION_ID, 'S002'),
    ]);
    expect(new Set(ledgers.map((row) => (row as { operation_id: string }).operation_id)).size).toBe(2);
    expect(createAdminAdjustmentPayloadHash({ studentIds: ['S002', 'S001'], mode: 'add', amount: 250 }))
      .toBe(createAdminAdjustmentPayloadHash({ studentIds: ['S001', 'S002'], mode: 'add', amount: 250 }));
  });

  it('replays the exact prior result without double mutation', async () => {
    const first = await commands().adjust(input());
    const second = await commands({ now: () => new Date('2026-08-29T00:00:00Z') }).adjust(input());
    expect(second).toEqual(first);
    expect((await snapshot()).transactions).toHaveLength(1);
    expect((await snapshot()).audits).toHaveLength(1);
    expect((await snapshot()).accounts[0]).toMatchObject({ balance: '1250', version: 2 });
  });

  it('replays the exact historical result after a later valid adjustment changed mutable state', async () => {
    const first = await commands().adjust(input());
    await commands().adjust(input({
      operationId: '40000000-0000-4000-8000-000000000002',
      amount: 100,
    }));

    const replayed = await commands({ now: () => new Date('2026-08-29T00:00:00Z') }).adjust(input());

    expect(replayed).toEqual(first);
    const state = await snapshot();
    expect(state.accounts[0]).toMatchObject({ balance: '1350', version: 3 });
    expect(state.transactions).toHaveLength(2);
    expect(state.audits).toHaveLength(2);
  });

  it('replays a valid persisted student name with surrounding whitespace exactly', async () => {
    await harness.database.query(
      `UPDATE students SET name=' Alice ' WHERE tenant_id=$1 AND student_id='S001'`,
      [harness.tenantOneId],
    );
    const first = await commands().adjust(input());

    const replayed = await commands().adjust(input());

    expect(first.students[0].studentName).toBe(' Alice ');
    expect(replayed).toEqual(first);
  });

  it('rejects a zero-ledger replay whose stored student arithmetic was corrupted', async () => {
    await commands().adjust(input({ amount: 0 }));
    await harness.database.exec('ALTER TABLE operations DISABLE TRIGGER operations_update_guard');
    await harness.database.query(
      `UPDATE operations
       SET result_snapshot=jsonb_set(result_snapshot, '{students,0,balanceAfter}', '999'::jsonb)
       WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, OPERATION_ID],
    );
    await harness.database.exec('ALTER TABLE operations ENABLE TRIGGER operations_update_guard');

    await expect(commands().adjust(input({ amount: 0 }))).rejects.toThrow(/integrity|stored/i);
  });

  it('rejects a zero-ledger replay whose stored balances were consistently corrupted', async () => {
    await commands().adjust(input({ amount: 0 }));
    await harness.database.exec('ALTER TABLE operations DISABLE TRIGGER operations_update_guard');
    await harness.database.query(
      `UPDATE operations
       SET result_snapshot=jsonb_set(
         jsonb_set(result_snapshot, '{students,0,balanceBefore}', '999'::jsonb),
         '{students,0,balanceAfter}', '999'::jsonb
       )
       WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, OPERATION_ID],
    );
    await harness.database.exec('ALTER TABLE operations ENABLE TRIGGER operations_update_guard');

    await expect(commands().adjust(input({ amount: 0 }))).rejects.toThrow(/integrity|stored/i);
  });

  it('fails closed when an initially-existing successful replay is missing its immutable audit', async () => {
    await commands().adjust(input());
    await harness.database.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    await harness.database.query(
      'DELETE FROM audit_events WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, OPERATION_ID],
    );
    await harness.database.exec('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');

    await expect(commands().adjust(input())).rejects.toThrow(/audit integrity/i);
  });

  it('fails closed when a successful replay has a corrupt immutable audit', async () => {
    await commands().adjust(input());
    await harness.database.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    await harness.database.query(
      `UPDATE audit_events SET redacted_details=jsonb_set(redacted_details, '{amount}', '999')
       WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, OPERATION_ID],
    );
    await harness.database.exec('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');

    await expect(commands().adjust(input())).rejects.toThrow(/audit integrity/i);
  });

  it('fails closed when an insert-race successful replay is missing its immutable audit', async () => {
    await commands().adjust(input());
    await harness.database.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    await harness.database.query(
      'DELETE FROM audit_events WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, OPERATION_ID],
    );
    await harness.database.exec('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');
    const raceRunner: DatabaseAdminCommandDependencies['runTenantTransaction'] = (tenantId, callback) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        let executeCount = 0;
        const racedTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== 'execute') return Reflect.get(target, property, receiver);
            return async (...args: Parameters<typeof tx.execute>) => {
              executeCount += 1;
              if (executeCount === 1) return { rows: [] };
              return tx.execute(...args);
            };
          },
        });
        return callback(racedTx);
      });

    await expect(commands({ runTenantTransaction: raceRunner }).adjust(input()))
      .rejects.toThrow(/audit integrity/i);
  });

  it.each([
    ['other kind', 'TASK_REWARD', 'a'.repeat(64), 'PENDING', 'OPERATION_CONFLICT'],
    ['other hash', 'ADMIN_ADJUSTMENT', 'a'.repeat(64), 'PENDING', 'OPERATION_CONFLICT'],
    ['pending', 'ADMIN_ADJUSTMENT', null, 'PENDING', 'OPERATION_PENDING'],
    ['failed', 'ADMIN_ADJUSTMENT', null, 'FAILED', 'OPERATION_FAILED'],
  ] as const)('fails closed for an existing %s operation', async (_label, kind, storedHash, status, code) => {
    const hash = storedHash ?? createAdminAdjustmentPayloadHash({ studentIds: ['S001'], mode: 'add', amount: 250 });
    await harness.database.query(`INSERT INTO operations
      (tenant_id, operation_id, operation_kind, payload_hash, status, failure_code,
       started_at, finished_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='FAILED' THEN 'TEST_FAILURE' END,
       $6::timestamptz,CASE WHEN $5='FAILED' THEN $6::timestamptz END,
       $6::timestamptz,$6::timestamptz)`,
    [harness.tenantOneId, OPERATION_ID, kind, hash, status, NOW]);
    await expect(commands().adjust(input())).rejects.toMatchObject({ code });
    expect((await snapshot()).transactions).toEqual([]);
    expect((await snapshot()).audits).toEqual([]);
  });

  it.each([
    ['empty selection', { studentIds: [] }],
    ['blank ID', { studentIds: ['S001', ' '] }],
    ['duplicate after trim', { studentIds: ['S001', ' S001 '] }],
    ['bad mode', { mode: 'multiply' }],
    ['negative amount', { amount: -1 }],
    ['unsafe amount', { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional amount', { amount: 1.5 }],
    ['uppercase operation', { operationId: '40000000-0000-4000-8000-00000000000A' }],
    ['bad hash', { payloadHash: 'A'.repeat(64) }],
  ])('rejects %s before tenant authority', async (_label, overrides) => {
    const spy = vi.fn();
    const runner: DatabaseAdminCommandDependencies['runTenantTransaction'] = async (tenantId, callback) => {
      spy();
      return harness.runTenantTransaction(tenantId, callback);
    };
    await expect(createDatabaseAdminCommands({ tenantId: harness.tenantOneId, runTenantTransaction: runner, now: () => NOW }).adjust(input(overrides)))
      .rejects.toBeInstanceOf(Error);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing student', { studentIds: ['MISSING'] }, 'STUDENT_INVALID'],
    ['overflow result', { mode: 'add', amount: 1 }, 'UNSAFE_BALANCE'],
  ] as const)('rejects %s with no mutation', async (label, overrides, code) => {
    if (label === 'overflow result') await harness.database.query(`UPDATE accounts SET balance=$2 WHERE tenant_id=$1 AND student_id='S001'`, [harness.tenantOneId, Number.MAX_SAFE_INTEGER]);
    const before = await snapshot();
    await expect(commands().adjust(input(overrides))).rejects.toMatchObject({ code });
    expect(await snapshot()).toEqual(before);
  });

  it('allows an explicit administrator adjustment for an inactive student', async () => {
    await harness.database.query(
      `UPDATE students SET status='INACTIVE' WHERE tenant_id=$1 AND student_id='S001'`,
      [harness.tenantOneId],
    );

    const result = await commands().adjust(input());

    expect(result.students[0]).toMatchObject({ studentId: 'S001', balanceAfter: 1250 });
    const state = await snapshot();
    expect(state.accounts[0]).toMatchObject({ balance: '1250', version: 2 });
    expect(state.audits).toHaveLength(1);
  });

  it('rejects an adjustment for a tombstoned student while still allowing inactive students', async () => {
    await harness.database.query(
      `UPDATE students
       SET status='INACTIVE', deleted_at=now(), version=version+1
       WHERE tenant_id=$1 AND student_id='S001'`,
      [harness.tenantOneId],
    );
    const before = await snapshot();

    await expect(commands().adjust(input())).rejects.toMatchObject({ code: 'STUDENT_INVALID' });
    expect(await snapshot()).toEqual(before);
  });

  it('allows an explicit administrator subtraction to produce a negative balance with an audit ledger', async () => {
    const result = await commands().adjust(input({ mode: 'subtract', amount: 1001 }));

    expect(result.students[0]).toMatchObject({ balanceBefore: 1000, balanceAfter: -1, delta: -1001 });
    const state = await snapshot();
    expect(state.accounts[0]).toMatchObject({ student_id: 'S001', balance: '-1' });
    expect(state.transactions[0]).toMatchObject({ balance_delta: '-1001', balance_after: '-1' });
    expect(state.adjustments[0]).toMatchObject({ mode: 'subtract', requested_amount: '1001' });
  });

  it('rolls back the whole bulk operation at the post-account fault seam', async () => {
    const before = await snapshot();
    await expect(commands({ afterAccountUpdates: vi.fn().mockRejectedValue(new Error('injected')) })
      .adjust(input({ studentIds: ['S002', 'S001'] }))).rejects.toThrow('injected');
    expect(await snapshot()).toEqual(before);
  });

  it('audits set no-op but omits add/subtract zero ledgers while representing every student', async () => {
    const setResult = await commands().adjust(input({ mode: 'set', amount: 1000 }));
    expect(setResult.students[0]).toMatchObject({ delta: 0, transactionId: `admin-adjustment:${OPERATION_ID}:S001` });
    const setState = await snapshot();
    expect(setState.transactions).toHaveLength(1);
    expect(setState.audits[0]).toMatchObject({
      redacted_details: expect.objectContaining({ changedStudentCount: 0 }),
    });

    const addResult = await commands().adjust(input({ operationId: '40000000-0000-4000-8000-000000000002', amount: 0 }));
    expect(addResult.students[0]).toMatchObject({ delta: 0, transactionId: null });
    const state = await snapshot();
    expect(state.transactions).toHaveLength(1);
    expect(state.audits).toHaveLength(2);
    expect(state.audits[1]).toMatchObject({
      operation_id: '40000000-0000-4000-8000-000000000002',
      redacted_details: {
        amount: 0,
        changedStudentCount: 0,
        mode: 'add',
        resultHash: createAdminAdjustmentResultHash(addResult),
        studentCount: 1,
      },
    });
  });

  it.each([
    ['stored result', `UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{amount}', '999') WHERE tenant_id=$1 AND operation_id=$2`],
    ['transaction', `UPDATE transactions SET student_name_snapshot='변조' WHERE tenant_id=$1 AND transaction_id='admin-adjustment:40000000-0000-4000-8000-000000000001:S001' AND $2::text IS NOT NULL`],
    ['missing transaction', `WITH deleted_adjustment AS (
      DELETE FROM adjustments WHERE tenant_id=$1 AND transaction_id='admin-adjustment:40000000-0000-4000-8000-000000000001:S001' RETURNING 1)
      DELETE FROM transactions WHERE tenant_id=$1 AND transaction_id='admin-adjustment:40000000-0000-4000-8000-000000000001:S001'
        AND EXISTS (SELECT 1 FROM deleted_adjustment) AND $2::text IS NOT NULL`],
    ['extra transaction', `INSERT INTO transactions (tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,legacy_status_snapshot,schema_version)
      SELECT tenant_id,'admin-adjustment:40000000-0000-4000-8000-000000000001:EXTRA',occurred_at,student_id,student_name_snapshot,kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,legacy_status_snapshot,schema_version FROM transactions WHERE tenant_id=$1 AND transaction_id='admin-adjustment:40000000-0000-4000-8000-000000000001:S001' AND $2::text IS NOT NULL`],
    ['unexpected item', `INSERT INTO transaction_items (tenant_id,transaction_id,line_number,product_id_snapshot,product_name_snapshot,quantity,unit_price_snapshot,subtotal_snapshot)
      VALUES ($1,'admin-adjustment:40000000-0000-4000-8000-000000000001:S001',1,'X','X',1,0,0) RETURNING $2::text`],
    ['unexpected inventory ledger', `WITH inserted_product AS (
      INSERT INTO products (tenant_id,product_id,name,price,stock,is_active,sort_order)
      VALUES ($1,'P-DRIFT','drift',0,1,true,99) RETURNING tenant_id,product_id)
      INSERT INTO inventory_ledger (tenant_id,product_id,transaction_id,quantity_delta,stock_before,stock_after,reason,occurred_at)
      SELECT tenant_id,product_id,'admin-adjustment:40000000-0000-4000-8000-000000000001:S001',1,0,1,'CANCELLATION','2026-08-28T06:00:00Z' FROM inserted_product WHERE $2::text IS NOT NULL`],
    ['unexpected task completion', `INSERT INTO task_completions
      (tenant_id,completion_id,completed_at,task_id_snapshot,task_name_snapshot,student_id,
       student_name_snapshot,reward_snapshot,balance_before,balance_after,status,transaction_id,schema_version)
      VALUES ($1,'completion-drift','2026-08-28T06:00:00Z','TASK-X','drift','S001','김민준',0,1250,1250,
       'CANCELLED','admin-adjustment:40000000-0000-4000-8000-000000000001:S001',1) RETURNING $2::text`],
    ['missing adjustment audit', `DELETE FROM adjustments WHERE tenant_id=$1 AND transaction_id='admin-adjustment:40000000-0000-4000-8000-000000000001:S001' AND $2::text IS NOT NULL`],
    ['adjustment audit', `UPDATE adjustments SET requested_amount=999 WHERE tenant_id=$1 AND transaction_id='admin-adjustment:40000000-0000-4000-8000-000000000001:S001' AND $2::text IS NOT NULL`],
    ['extra parent adjustment audit', `WITH inserted_transaction AS (
      INSERT INTO transactions
        (tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,kind,
         legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,
         legacy_status_snapshot,schema_version)
      SELECT $1,'unrelated-admin-transaction','2026-08-28T06:00:00Z','S001','김민준',
        'ADMIN_ADJUSTMENT',0,0,1250,1250,'admin','ADMIN_ADJUSTMENT',1
      WHERE $2::text IS NOT NULL RETURNING transaction_id)
      INSERT INTO adjustments
        (tenant_id,adjustment_id,transaction_id,mode,requested_amount,operator_snapshot)
      SELECT $1,'adjustment:40000000-0000-4000-8000-000000000001:EXTRA',transaction_id,
        'add',250,'admin' FROM inserted_transaction`],
  ])('rejects replay after %s drift', async (_label, mutation) => {
    await commands().adjust(input());
    if (_label === 'stored result') await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard`);
    await harness.withImmutableLedgerTampering(() =>
      harness.database.query(mutation, [harness.tenantOneId, OPERATION_ID]));
    if (_label === 'stored result') await harness.database.exec(`ALTER TABLE operations ENABLE TRIGGER operations_update_guard`);
    await expect(commands().adjust(input())).rejects.toThrow(/integrity|stored/i);
  });

  it('isolates the trusted tenant and never mutates the same student ID in another tenant', async () => {
    await commands().adjust(input());
    expect((await snapshot(harness.tenantTwoId)).accounts).toEqual([{ student_id: 'S001', balance: '9000', version: 1 }]);
    expect((await snapshot(harness.tenantTwoId)).transactions).toEqual([]);
  });

  it('documents PostgreSQL lock order and the honest serialized PGlite limitation', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/server/repositories/database/adminCommands.ts'), 'utf8');
    expect(source).toMatch(/LOCK ORDER:[\s\S]*existing operation[\s\S]*student\/account[\s\S]*student_id[\s\S]*FOR UPDATE/i);
    expect(source).toMatch(/PGlite[\s\S]*serial/i);
    expect(source).not.toMatch(/retry[\s\S]*40001/i);
  });
});
