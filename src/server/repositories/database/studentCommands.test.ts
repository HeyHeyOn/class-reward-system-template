import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertStudentAdminDeactivateStateRows,
  createDatabaseStudentCommands,
  createStudentAdminAdjustmentId,
  createStudentAdminLedgerOperationId,
  createStudentAdminPayloadHash,
  createStudentAdminResultHash,
  createStudentAdminTransactionId,
  type DatabaseStudentCommandDependencies,
} from './studentCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit } from './operationAudit';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-29T10:15:00.000Z');
const OPERATION_ID = 'student-create-op-001';
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
});

afterEach(async () => harness?.close());

function commands(overrides: Partial<DatabaseStudentCommandDependencies> = {}) {
  return createDatabaseStudentCommands({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => new Date(NOW),
    ...overrides,
  });
}

async function seedStudent(input: {
  studentId: string;
  name: string;
  balance: number;
  status?: 'ACTIVE' | 'INACTIVE';
}) {
  await harness.database.query(
    `INSERT INTO students
      (tenant_id, student_id, name, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)`,
    [harness.tenantOneId, input.studentId, input.name, input.status ?? 'ACTIVE', NOW],
  );
  await harness.database.query(
    `INSERT INTO accounts (tenant_id, student_id, balance, version, updated_at)
     VALUES ($1, $2, $3, 1, $4)`,
    [harness.tenantOneId, input.studentId, input.balance, NOW],
  );
}

async function withOperationAuditTampering<TResult>(callback: () => Promise<TResult>): Promise<TResult> {
  await harness.database.exec(`
    ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
    ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
  `);
  try {
    return await callback();
  } finally {
    await harness.database.exec(`
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;
      ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable;
    `);
  }
}

async function snapshot(tenantId = harness.tenantOneId) {
  const [students, accounts, transactions, adjustments, operations, audits] = await Promise.all([
    harness.database.query(
      `SELECT student_id, name, status, version::text, deleted_at
       FROM students WHERE tenant_id=$1 ORDER BY student_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT student_id, balance::text, version::text
       FROM accounts WHERE tenant_id=$1 ORDER BY student_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT transaction_id, occurred_at, student_id, student_name_snapshot, kind,
              legacy_total_amount::text, balance_delta::text, balance_before::text,
              balance_after::text, operator_snapshot, legacy_status_snapshot,
              operation_id, operation_hash, schema_version
       FROM transactions WHERE tenant_id=$1 ORDER BY transaction_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT adjustment_id, transaction_id, mode, requested_amount::text,
              operator_snapshot, legacy_adjustment_id
       FROM adjustments WHERE tenant_id=$1 ORDER BY adjustment_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT operation_id, operation_kind, payload_hash, status, result_snapshot
       FROM operations WHERE tenant_id=$1 ORDER BY operation_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT operation_id, event_type, entity_type, entity_id,
              redacted_details, occurred_at
       FROM audit_events WHERE tenant_id=$1 ORDER BY event_id`,
      [tenantId],
    ),
  ]);
  return {
    students: students.rows,
    accounts: accounts.rows,
    transactions: transactions.rows,
    adjustments: adjustments.rows,
    operations: operations.rows,
    audits: audits.rows,
  };
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION_ID,
  studentId: 'S001',
  name: ' 김민준 ',
  balance: 1200,
  status: 'ACTIVE' as const,
  ...overrides,
});

describe('PostgreSQL student administration commands', () => {
  it('creates a student and account with an immutable initial-balance ledger in one operation', async () => {
    const result = await commands().create(createInput());
    const payloadHash = createStudentAdminPayloadHash({
      action: 'CREATE',
      students: [{ studentId: 'S001', name: '김민준', balance: 1200, status: 'ACTIVE' }],
    });

    expect(result).toEqual({
      ok: true,
      operationId: OPERATION_ID,
      action: 'CREATE',
      completedAt: NOW.toISOString(),
      students: [{
        studentId: 'S001',
        name: '김민준',
        balance: 1200,
        status: 'ACTIVE',
        studentVersionBefore: null,
        studentVersionAfter: 1,
        accountVersionBefore: null,
        accountVersionAfter: 1,
        balanceBefore: null,
        balanceAfter: 1200,
        transactionId: createStudentAdminTransactionId(OPERATION_ID, 'S001'),
      }],
    });

    const state = await snapshot();
    expect(state.students).toEqual([{
      student_id: 'S001', name: '김민준', status: 'ACTIVE', version: '1', deleted_at: null,
    }]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '1200', version: '1' }]);
    expect(state.transactions).toEqual([expect.objectContaining({
      transaction_id: createStudentAdminTransactionId(OPERATION_ID, 'S001'),
      occurred_at: NOW,
      student_id: 'S001',
      student_name_snapshot: '김민준',
      kind: 'ADMIN_ADJUSTMENT',
      legacy_total_amount: '-1200',
      balance_delta: '1200',
      balance_before: '0',
      balance_after: '1200',
      operator_snapshot: 'admin',
      legacy_status_snapshot: 'ADMIN_ADJUSTMENT',
      operation_id: createStudentAdminLedgerOperationId(OPERATION_ID, 'S001'),
      operation_hash: payloadHash,
      schema_version: 1,
    })]);
    expect(state.adjustments).toEqual([{
      adjustment_id: createStudentAdminAdjustmentId(OPERATION_ID, 'S001'),
      transaction_id: createStudentAdminTransactionId(OPERATION_ID, 'S001'),
      mode: 'set',
      requested_amount: '1200',
      operator_snapshot: 'admin',
      legacy_adjustment_id: null,
    }]);
    expect(state.operations).toEqual([expect.objectContaining({
      operation_id: OPERATION_ID,
      operation_kind: 'STUDENT_ADMIN',
      payload_hash: payloadHash,
      status: 'SUCCEEDED',
      result_snapshot: result,
    })]);
    expect(state.audits).toEqual([{
      operation_id: OPERATION_ID,
      event_type: 'STUDENT_ADMIN_COMPLETED',
      entity_type: 'OPERATION',
      entity_id: OPERATION_ID,
      redacted_details: {
        action: 'CREATE',
        changedStudentCount: 1,
        ledgerCount: 1,
        resultHash: createStudentAdminResultHash(result),
        studentCount: 1,
      },
      occurred_at: NOW,
    }]);
  });

  it('returns the exact stored create result on retry without duplicating rows or ledgers', async () => {
    const first = await commands().create(createInput());
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') })
      .create(createInput());

    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.students).toHaveLength(1);
    expect(state.accounts).toHaveLength(1);
    expect(state.transactions).toHaveLength(1);
    expect(state.adjustments).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('re-reads and exactly replays a concurrent identical operation that wins the insert race', async () => {
    const input = createInput({
      operationId: 'student-create-race-op',
      studentId: 'S010',
      balance: 0,
    });
    const payloadHash = createStudentAdminPayloadHash({
      action: 'CREATE',
      students: [{ studentId: 'S010', name: '김민준', balance: 0, status: 'ACTIVE' }],
    });
    const winner = {
      ok: true,
      operationId: input.operationId,
      action: 'CREATE',
      completedAt: NOW.toISOString(),
      students: [{
        studentId: input.studentId,
        name: '김민준',
        balance: 0,
        status: 'ACTIVE',
        studentVersionBefore: null,
        studentVersionAfter: 1,
        accountVersionBefore: null,
        accountVersionAfter: 1,
        balanceBefore: null,
        balanceAfter: 0,
        transactionId: null,
      }],
    } as const;
    let executeCount = 0;
    const racingRunTenantTransaction: DatabaseStudentCommandDependencies['runTenantTransaction'] =
      (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        const wrapped = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== 'execute') return Reflect.get(target, property, receiver);
            return async (query: Parameters<TenantTransaction['execute']>[0]) => {
              executeCount += 1;
              if (executeCount === 2) {
                await tx.execute(sql`
                  INSERT INTO operations
                    (tenant_id, operation_id, operation_kind, payload_hash, status,
                     result_snapshot, attempt_count, started_at, finished_at, created_at, updated_at)
                  VALUES (${tenantId}, ${input.operationId}, 'STUDENT_ADMIN', ${payloadHash}, 'SUCCEEDED',
                          ${JSON.stringify(winner)}::jsonb, 1, ${NOW}, ${NOW}, ${NOW}, ${NOW})
                `);
                await tx.execute(sql`
                  INSERT INTO students
                    (tenant_id, student_id, name, status, version, created_at, updated_at)
                  VALUES (${tenantId}, ${input.studentId}, '김민준', 'ACTIVE', 1, ${NOW}, ${NOW})
                `);
                await tx.execute(sql`
                  INSERT INTO accounts (tenant_id, student_id, balance, version, updated_at)
                  VALUES (${tenantId}, ${input.studentId}, 0, 1, ${NOW})
                `);
                await appendOperationAudit(tx, tenantId, {
                  operationId: input.operationId,
                  eventType: 'STUDENT_ADMIN_COMPLETED',
                  entityType: 'OPERATION',
                  entityId: input.operationId,
                  redactedDetails: {
                    action: 'CREATE',
                    changedStudentCount: 1,
                    ledgerCount: 0,
                    resultHash: createStudentAdminResultHash(winner),
                    studentCount: 1,
                  },
                  occurredAt: NOW,
                });
              }
              return tx.execute(query);
            };
          },
        });
        return callback(wrapped);
      });

    const result = await commands({ runTenantTransaction: racingRunTenantTransaction }).create(input);

    expect(result).toEqual(winner);
    expect(executeCount).toBeGreaterThan(2);
  });

  it('database-rejects updates to an initial-balance transaction', async () => {
    await commands().create(createInput());

    await expect(harness.database.query(
      `UPDATE transactions SET operator_snapshot='changed'
       WHERE tenant_id=$1 AND transaction_id=$2`,
      [harness.tenantOneId, createStudentAdminTransactionId(OPERATION_ID, 'S001')],
    )).rejects.toThrow(/immutable/i);
  });

  it('database-rejects deletion of an initial-balance adjustment', async () => {
    await commands().create(createInput());

    await expect(harness.database.query(
      `DELETE FROM adjustments
       WHERE tenant_id=$1 AND transaction_id=$2`,
      [harness.tenantOneId, createStudentAdminTransactionId(OPERATION_ID, 'S001')],
    )).rejects.toThrow(/immutable/i);
  });

  it('fails closed when a successful create replay is missing its immutable audit', async () => {
    await commands().create(createInput());
    await withOperationAuditTampering(() => harness.database.query(
      'DELETE FROM audit_events WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, OPERATION_ID],
    ));

    await expect(commands().create(createInput())).rejects.toThrow(/audit integrity/i);
  });

  it('fails closed when successful operation lifecycle evidence is corrupted', async () => {
    await commands().create(createInput());
    await harness.database.query(
      `UPDATE operations SET attempt_count=2
       WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, OPERATION_ID],
    );

    await expect(commands().create(createInput())).rejects.toThrow(/operation integrity/i);
  });

  it('fails closed when a successful create replay is missing its adjustment ledger', async () => {
    await commands().create(createInput());
    await harness.withImmutableLedgerTampering(async () => {
      await harness.database.query(
        'DELETE FROM adjustments WHERE tenant_id=$1 AND transaction_id=$2',
        [harness.tenantOneId, createStudentAdminTransactionId(OPERATION_ID, 'S001')],
      );
      await harness.database.query(
        'DELETE FROM transactions WHERE tenant_id=$1 AND transaction_id=$2',
        [harness.tenantOneId, createStudentAdminTransactionId(OPERATION_ID, 'S001')],
      );
    });

    await expect(commands().create(createInput())).rejects.toThrow(/ledger integrity/i);
  });

  it('fails closed when create replay finds an extra transaction attributed to the same operation hash', async () => {
    await commands().create(createInput());
    await seedStudent({ studentId: 'extra', name: '추가 학생', balance: 0 });
    const payloadHash = createStudentAdminPayloadHash({
      action: 'CREATE',
      students: [{ studentId: 'S001', name: '김민준', balance: 1200, status: 'ACTIVE' }],
    });
    await harness.database.query(
      `INSERT INTO transactions
        (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot,
         kind, legacy_total_amount, balance_delta, balance_before, balance_after,
         operator_snapshot, legacy_status_snapshot, operation_id, operation_hash, schema_version)
       VALUES ($1, 'student-admin-extra', $2, 'extra', '추가 학생',
               'ADMIN_ADJUSTMENT', 0, 0, 0, 0, 'admin', 'ADMIN_ADJUSTMENT', $3, $4, 1)`,
      [harness.tenantOneId, NOW, createStudentAdminLedgerOperationId(OPERATION_ID, 'extra'), payloadHash],
    );

    await expect(commands().create(createInput())).rejects.toThrow(/ledger integrity/i);
  });

  it('creates a zero-balance account without fabricating an adjustment ledger', async () => {
    const result = await commands().create(createInput({
      operationId: 'student-create-zero-op',
      studentId: 'S000',
      balance: 0,
    }));

    expect(result.students[0]).toMatchObject({ balance: 0, transactionId: null });
    const state = await snapshot();
    expect(state.students).toHaveLength(1);
    expect(state.accounts).toEqual([{ student_id: 'S000', balance: '0', version: '1' }]);
    expect(state.transactions).toEqual([]);
    expect(state.adjustments).toEqual([]);
    expect(state.audits[0]).toMatchObject({
      redacted_details: expect.objectContaining({ ledgerCount: 0 }),
    });
  });

  it('rejects a zero-ledger replay when its deterministic transaction ID exists with a corrupted hash', async () => {
    const input = createInput({
      operationId: 'student-create-zero-hash-op',
      studentId: 'S000',
      balance: 0,
    });
    await commands().create(input);
    await harness.database.query(
      `INSERT INTO transactions
        (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot,
         kind, legacy_total_amount, balance_delta, balance_before, balance_after,
         operator_snapshot, legacy_status_snapshot, operation_id, operation_hash, schema_version)
       VALUES ($1, $2, $3, 'S000', '김민준', 'ADMIN_ADJUSTMENT', 0, 0, 0, 0,
               'admin', 'ADMIN_ADJUSTMENT', $4, $5, 1)`,
      [harness.tenantOneId, createStudentAdminTransactionId(input.operationId, 'S000'), NOW,
        createStudentAdminLedgerOperationId(input.operationId, 'S000'), 'f'.repeat(64)],
    );

    await expect(commands().create(input)).rejects.toThrow(/ledger integrity/i);
  });

  it('rejects a zero-ledger replay whose stored result and audit digest were consistently corrupted', async () => {
    const input = createInput({
      operationId: 'student-create-zero-corrupt-op',
      studentId: 'S000',
      balance: 0,
    });
    const result = await commands().create(input);
    const corrupted = structuredClone(result) as unknown as {
      students: Array<{ name: string }>;
    };
    corrupted.students[0].name = '변조된 이름';

    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET result_snapshot=$3::jsonb
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId, JSON.stringify(corrupted)],
      );
      await harness.database.query(
        `UPDATE audit_events
         SET redacted_details=jsonb_set(redacted_details, '{resultHash}', to_jsonb($3::text))
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, input.operationId,
          createStudentAdminResultHash(corrupted as unknown as typeof result)],
      );
    });

    await expect(commands().create(input)).rejects.toThrow(/stored result integrity/i);
  });

  it('rejects reuse of an operation ID for a different canonical create payload', async () => {
    const first = await commands().create(createInput());

    await expect(commands().create(createInput({ name: '다른 이름' })))
      .rejects.toThrow(/conflict/i);

    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({ name: '김민준' })]);
    expect(state.operations[0]).toMatchObject({ result_snapshot: first });
    expect(state.transactions).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('atomically updates student fields and balance with optimistic versions and an adjustment ledger', async () => {
    await seedStudent({ studentId: 'S001', name: '기존 학생', balance: 100 });

    const result = await commands().update({
      operationId: 'student-update-op-001',
      studentId: 'S001',
      expectedStudentVersion: 1,
      expectedAccountVersion: 1,
      name: '수정 학생',
      balance: 150,
      status: 'INACTIVE',
    });

    expect(result).toMatchObject({
      ok: true,
      operationId: 'student-update-op-001',
      action: 'UPDATE',
      students: [{
        studentId: 'S001', name: '수정 학생', balance: 150, status: 'INACTIVE',
        studentVersionBefore: 1, studentVersionAfter: 2,
        accountVersionBefore: 1, accountVersionAfter: 2,
        balanceBefore: 100, balanceAfter: 150,
        transactionId: createStudentAdminTransactionId('student-update-op-001', 'S001'),
      }],
    });
    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({
      student_id: 'S001', name: '수정 학생', status: 'INACTIVE', version: '2', deleted_at: null,
    })]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '150', version: '2' }]);
    expect(state.transactions).toEqual([expect.objectContaining({
      transaction_id: createStudentAdminTransactionId('student-update-op-001', 'S001'),
      balance_delta: '50', balance_before: '100', balance_after: '150',
    })]);
    expect(state.adjustments).toEqual([expect.objectContaining({
      adjustment_id: createStudentAdminAdjustmentId('student-update-op-001', 'S001'),
      mode: 'set', requested_amount: '150',
    })]);
    expect(state.operations).toEqual([expect.objectContaining({
      operation_id: 'student-update-op-001', operation_kind: 'STUDENT_ADMIN', status: 'SUCCEEDED',
    })]);
    expect(state.audits).toEqual([expect.objectContaining({
      operation_id: 'student-update-op-001',
      redacted_details: expect.objectContaining({ action: 'UPDATE', ledgerCount: 1 }),
    })]);
  });

  it('does not fabricate a balance ledger when an update keeps the same balance', async () => {
    await seedStudent({ studentId: 'S001', name: '기존 학생', balance: 100 });

    const result = await commands().update({
      operationId: 'student-update-no-balance-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
      expectedAccountVersion: 1,
      name: '이름만 수정',
      balance: 100,
      status: 'ACTIVE',
    });

    expect(result.students[0]).toMatchObject({
      transactionId: null,
      balanceBefore: 100,
      balanceAfter: 100,
      studentVersionAfter: 2,
      accountVersionAfter: 2,
    });
    const state = await snapshot();
    expect(state.transactions).toHaveLength(0);
    expect(state.adjustments).toHaveLength(0);
    expect(state.audits).toEqual([expect.objectContaining({
      redacted_details: expect.objectContaining({ ledgerCount: 0 }),
    })]);
  });

  it('exactly replays a completed student update without applying it twice', async () => {
    await seedStudent({ studentId: 'S001', name: '기존 학생', balance: 100 });
    const input = {
      operationId: 'student-update-replay-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
      expectedAccountVersion: 1,
      name: '수정 학생',
      balance: 150,
      status: 'INACTIVE' as const,
    };

    const first = await commands().update(input);
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') }).update(input);

    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({ version: '2' })]);
    expect(state.accounts).toEqual([expect.objectContaining({ version: '2', balance: '150' })]);
    expect(state.transactions).toHaveLength(1);
    expect(state.adjustments).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('rejects an update replay whose stored version successor exceeds the safe integer range', async () => {
    await seedStudent({ studentId: 'S001', name: '기존 학생', balance: 100 });
    const originalInput = {
      operationId: 'student-update-version-overflow-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
      expectedAccountVersion: 1,
      name: '수정 학생',
      balance: 100,
      status: 'ACTIVE' as const,
    };
    const result = await commands().update(originalInput);
    const corrupted = structuredClone(result) as unknown as {
      students: Array<{
        studentVersionBefore: number;
        studentVersionAfter: number;
        accountVersionBefore: number;
        accountVersionAfter: number;
      }>;
    };
    corrupted.students[0].studentVersionBefore = Number.MAX_SAFE_INTEGER;
    corrupted.students[0].studentVersionAfter = Number.MAX_SAFE_INTEGER + 1;
    corrupted.students[0].accountVersionBefore = Number.MAX_SAFE_INTEGER;
    corrupted.students[0].accountVersionAfter = Number.MAX_SAFE_INTEGER + 1;
    const replayInput = {
      ...originalInput,
      expectedStudentVersion: Number.MAX_SAFE_INTEGER,
      expectedAccountVersion: Number.MAX_SAFE_INTEGER,
    };
    const payloadHash = createStudentAdminPayloadHash({ action: 'UPDATE', students: [replayInput] });

    await withOperationAuditTampering(async () => {
      await harness.database.query(
        `UPDATE operations SET payload_hash=$3, result_snapshot=$4::jsonb
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, originalInput.operationId, payloadHash, JSON.stringify(corrupted)],
      );
      await harness.database.query(
        `UPDATE audit_events
         SET redacted_details=jsonb_set(redacted_details, '{resultHash}', to_jsonb($3::text))
         WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, originalInput.operationId,
          createStudentAdminResultHash(corrupted as unknown as typeof result)],
      );
    });

    await expect(commands().update(replayInput)).rejects.toThrow(/stored result integrity/i);
  });

  it('rejects a stale student version and rolls back the attempted operation', async () => {
    await seedStudent({ studentId: 'S001', name: '기존 학생', balance: 100 });
    await harness.database.query(
      `UPDATE students SET version=2 WHERE tenant_id=$1 AND student_id='S001'`,
      [harness.tenantOneId],
    );

    await expect(commands().update({
      operationId: 'student-update-stale-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
      expectedAccountVersion: 1,
      name: '덮어쓸 이름',
      balance: 150,
      status: 'INACTIVE',
    })).rejects.toThrow(/stale version/i);

    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({ name: '기존 학생', version: '2' })]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '100', version: '1' }]);
    expect(state.operations).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('rejects a stale account version and preserves the concurrent balance', async () => {
    await seedStudent({ studentId: 'S001', name: '기존 학생', balance: 100 });
    await harness.database.query(
      `UPDATE accounts SET balance=175, version=2 WHERE tenant_id=$1 AND student_id='S001'`,
      [harness.tenantOneId],
    );

    await expect(commands().update({
      operationId: 'student-update-stale-account-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
      expectedAccountVersion: 1,
      name: '덮어쓸 이름',
      balance: 150,
      status: 'INACTIVE',
    })).rejects.toThrow(/stale version/i);

    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({ name: '기존 학생', version: '1' })]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '175', version: '2' }]);
    expect(state.operations).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
  });

  it('rejects updates to a tombstoned student while preserving the row and account', async () => {
    await seedStudent({ studentId: 'S001', name: '삭제 학생', balance: 100, status: 'INACTIVE' });
    await harness.database.query(
      `UPDATE students SET deleted_at=$3 WHERE tenant_id=$1 AND student_id=$2`,
      [harness.tenantOneId, 'S001', NOW],
    );

    await expect(commands().update({
      operationId: 'student-update-tombstone-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
      expectedAccountVersion: 1,
      name: '변조 이름',
      balance: 200,
      status: 'INACTIVE',
    })).rejects.toThrow(/student integrity/i);

    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({
      name: '삭제 학생', status: 'INACTIVE', version: '1', deleted_at: NOW,
    })]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '100', version: '1' }]);
    expect(state.operations).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
  });

  it('soft-deactivates a student while preserving the account and appending no balance ledger', async () => {
    await seedStudent({ studentId: 'S001', name: '삭제 대상', balance: 100 });

    const result = await commands().deactivate({
      operationId: 'student-deactivate-op-001',
      studentId: 'S001',
      expectedStudentVersion: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      action: 'DEACTIVATE',
      operationId: 'student-deactivate-op-001',
      students: [{
        studentId: 'S001', name: '삭제 대상', balance: 100, status: 'INACTIVE',
        studentVersionBefore: 1, studentVersionAfter: 2,
        accountVersionBefore: 1, accountVersionAfter: 1,
        balanceBefore: 100, balanceAfter: 100, transactionId: null,
      }],
    });
    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({
      name: '삭제 대상', status: 'INACTIVE', version: '2', deleted_at: NOW,
    })]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '100', version: '1' }]);
    expect(state.transactions).toHaveLength(0);
    expect(state.adjustments).toHaveLength(0);
    expect(state.operations).toEqual([expect.objectContaining({
      operation_id: 'student-deactivate-op-001', operation_kind: 'STUDENT_ADMIN', status: 'SUCCEEDED',
    })]);
    expect(state.audits).toEqual([expect.objectContaining({
      operation_id: 'student-deactivate-op-001',
      redacted_details: expect.objectContaining({ action: 'DEACTIVATE', ledgerCount: 0 }),
    })]);
  });

  it('exactly replays a completed student deactivation without changing the tombstone twice', async () => {
    await seedStudent({ studentId: 'S001', name: '삭제 대상', balance: 100 });
    const input = {
      operationId: 'student-deactivate-replay-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
    };

    const first = await commands().deactivate(input);
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') }).deactivate(input);

    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({ version: '2', deleted_at: NOW })]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '100', version: '1' }]);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(state.transactions).toHaveLength(0);
  });

  it('replays a deactivation for a valid legacy student name with surrounding spaces', async () => {
    await seedStudent({ studentId: 'S001', name: ' 삭제 대상 ', balance: 100 });
    const input = {
      operationId: 'student-deactivate-legacy-name-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
    };

    const first = await commands().deactivate(input);
    await expect(commands().deactivate(input)).resolves.toEqual(first);
    expect(first.students[0].name).toBe(' 삭제 대상 ');
  });

  it('rejects a second deactivation under a different operation ID', async () => {
    await seedStudent({ studentId: 'S001', name: '삭제 대상', balance: 100 });
    await commands().deactivate({
      operationId: 'student-deactivate-first-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
    });

    await expect(commands().deactivate({
      operationId: 'student-deactivate-second-op',
      studentId: 'S001',
      expectedStudentVersion: 2,
    })).rejects.toThrow(/student integrity/i);

    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({ version: '2', deleted_at: NOW })]);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('rejects a stale deactivation version without creating a tombstone or operation', async () => {
    await seedStudent({ studentId: 'S001', name: '삭제 대상', balance: 100 });
    await harness.database.query(
      `UPDATE students SET version=2 WHERE tenant_id=$1 AND student_id='S001'`,
      [harness.tenantOneId],
    );

    await expect(commands().deactivate({
      operationId: 'student-deactivate-stale-op',
      studentId: 'S001',
      expectedStudentVersion: 1,
    })).rejects.toThrow(/stale version/i);

    const state = await snapshot();
    expect(state.students).toEqual([expect.objectContaining({
      status: 'ACTIVE', version: '2', deleted_at: null,
    })]);
    expect(state.accounts).toEqual([{ student_id: 'S001', balance: '100', version: '1' }]);
    expect(state.operations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('atomically batch-updates students in stable ID order and emits only nonzero balance ledgers', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    await seedStudent({ studentId: 'S002', name: '둘째', balance: 200 });

    const result = await commands().updateBatch({
      operationId: 'student-update-batch-op-001',
      students: [
        {
          studentId: 'S002', expectedStudentVersion: 1, expectedAccountVersion: 1,
          name: '둘째 수정', balance: 200, status: 'INACTIVE',
        },
        {
          studentId: 'S001', expectedStudentVersion: 1, expectedAccountVersion: 1,
          name: '첫째 수정', balance: 150, status: 'ACTIVE',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      operationId: 'student-update-batch-op-001',
      action: 'UPDATE',
      students: [
        expect.objectContaining({
          studentId: 'S001', balanceBefore: 100, balanceAfter: 150,
          studentVersionAfter: 2, accountVersionAfter: 2,
          transactionId: createStudentAdminTransactionId('student-update-batch-op-001', 'S001'),
        }),
        expect.objectContaining({
          studentId: 'S002', balanceBefore: 200, balanceAfter: 200,
          studentVersionAfter: 2, accountVersionAfter: 2, transactionId: null,
        }),
      ],
    });
    const state = await snapshot();
    expect(state.students).toEqual([
      expect.objectContaining({ student_id: 'S001', name: '첫째 수정', status: 'ACTIVE', version: '2' }),
      expect.objectContaining({ student_id: 'S002', name: '둘째 수정', status: 'INACTIVE', version: '2' }),
    ]);
    expect(state.accounts).toEqual([
      { student_id: 'S001', balance: '150', version: '2' },
      { student_id: 'S002', balance: '200', version: '2' },
    ]);
    expect(state.transactions).toHaveLength(1);
    expect(state.adjustments).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toEqual([expect.objectContaining({
      redacted_details: expect.objectContaining({ action: 'UPDATE', changedStudentCount: 2, ledgerCount: 1 }),
    })]);
  });

  it('exactly replays a canonicalized student update batch without duplicate mutations', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    await seedStudent({ studentId: 'S002', name: '둘째', balance: 200 });
    const input = {
      operationId: 'student-update-batch-replay-op',
      students: [
        {
          studentId: 'S002', expectedStudentVersion: 1, expectedAccountVersion: 1,
          name: '둘째 수정', balance: 200, status: 'INACTIVE' as const,
        },
        {
          studentId: 'S001', expectedStudentVersion: 1, expectedAccountVersion: 1,
          name: '첫째 수정', balance: 150, status: 'ACTIVE' as const,
        },
      ],
    };

    const first = await commands().updateBatch(input);
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') }).updateBatch(input);

    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.students).toEqual([
      expect.objectContaining({ student_id: 'S001', version: '2' }),
      expect.objectContaining({ student_id: 'S002', version: '2' }),
    ]);
    expect(state.accounts).toEqual([
      expect.objectContaining({ student_id: 'S001', version: '2' }),
      expect.objectContaining({ student_id: 'S002', version: '2' }),
    ]);
    expect(state.transactions).toHaveLength(1);
    expect(state.adjustments).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('ignores an unexpected entry-level operation ID in favor of the update batch operation ID', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    const student = {
      operationId: 'malicious-entry-operation',
      studentId: 'S001', expectedStudentVersion: 1, expectedAccountVersion: 1,
      name: '첫째 수정', balance: 150, status: 'ACTIVE' as const,
    };
    const input = {
      operationId: 'student-update-batch-outer-op',
      students: [student],
    };

    const first = await commands().updateBatch(input);
    await expect(commands().updateBatch(input)).resolves.toEqual(first);
    expect(first.students[0].transactionId)
      .toBe(createStudentAdminTransactionId(input.operationId, student.studentId));
  });

  it('rejects update batches above the shared maximum before opening a transaction', async () => {
    const student = {
      studentId: 'S001', expectedStudentVersion: 1, expectedAccountVersion: 1,
      name: '수정', balance: 100, status: 'ACTIVE' as const,
    };
    await expect(commands().updateBatch({
      operationId: 'student-update-batch-at-limit-op',
      students: Array.from({ length: 100 }, () => student),
    })).rejects.toThrow(/duplicate student IDs/i);
    await expect(commands().updateBatch({
      operationId: 'student-update-batch-over-limit-op',
      students: Array.from({ length: 101 }, () => student),
    })).rejects.toThrow(/at most 100 students/i);
    expect((await snapshot()).operations).toHaveLength(0);
  });

  it('rejects duplicate student IDs before starting an update batch operation', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    const student = {
      studentId: 'S001', expectedStudentVersion: 1, expectedAccountVersion: 1,
      name: '수정', balance: 100, status: 'ACTIVE' as const,
    };

    await expect(commands().updateBatch({
      operationId: 'student-update-batch-duplicate-op',
      students: [student, student],
    })).rejects.toThrow(/duplicate student IDs/i);

    const state = await snapshot();
    expect(state.operations).toHaveLength(0);
    expect(state.students).toEqual([expect.objectContaining({ name: '첫째', version: '1' })]);
  });

  it('rolls back an entire update batch when a later account version is stale', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    await seedStudent({ studentId: 'S002', name: '둘째', balance: 200 });
    await harness.database.query(
      `UPDATE accounts SET balance=250, version=2 WHERE tenant_id=$1 AND student_id='S002'`,
      [harness.tenantOneId],
    );

    await expect(commands().updateBatch({
      operationId: 'student-update-batch-stale-op',
      students: [
        {
          studentId: 'S001', expectedStudentVersion: 1, expectedAccountVersion: 1,
          name: '첫째 수정', balance: 150, status: 'ACTIVE',
        },
        {
          studentId: 'S002', expectedStudentVersion: 1, expectedAccountVersion: 1,
          name: '둘째 수정', balance: 300, status: 'ACTIVE',
        },
      ],
    })).rejects.toThrow(/stale version/i);

    const state = await snapshot();
    expect(state.students).toEqual([
      expect.objectContaining({ student_id: 'S001', name: '첫째', version: '1' }),
      expect.objectContaining({ student_id: 'S002', name: '둘째', version: '1' }),
    ]);
    expect(state.accounts).toEqual([
      { student_id: 'S001', balance: '100', version: '1' },
      { student_id: 'S002', balance: '250', version: '2' },
    ]);
    expect(state.operations).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('atomically batch-deactivates students in stable ID order without balance ledgers', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    await seedStudent({ studentId: 'S002', name: '둘째', balance: 200 });

    const result = await commands().deactivateBatch({
      operationId: 'student-deactivate-batch-op-001',
      students: [
        { studentId: 'S002', expectedStudentVersion: 1 },
        { studentId: 'S001', expectedStudentVersion: 1 },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      operationId: 'student-deactivate-batch-op-001',
      action: 'DEACTIVATE',
      students: [
        expect.objectContaining({
          studentId: 'S001', status: 'INACTIVE', studentVersionAfter: 2,
          accountVersionAfter: 1, balanceAfter: 100, transactionId: null,
        }),
        expect.objectContaining({
          studentId: 'S002', status: 'INACTIVE', studentVersionAfter: 2,
          accountVersionAfter: 1, balanceAfter: 200, transactionId: null,
        }),
      ],
    });
    const state = await snapshot();
    expect(state.students).toEqual([
      expect.objectContaining({ student_id: 'S001', status: 'INACTIVE', version: '2', deleted_at: NOW }),
      expect.objectContaining({ student_id: 'S002', status: 'INACTIVE', version: '2', deleted_at: NOW }),
    ]);
    expect(state.accounts).toEqual([
      { student_id: 'S001', balance: '100', version: '1' },
      { student_id: 'S002', balance: '200', version: '1' },
    ]);
    expect(state.transactions).toHaveLength(0);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toEqual([expect.objectContaining({
      redacted_details: expect.objectContaining({ action: 'DEACTIVATE', changedStudentCount: 2, ledgerCount: 0 }),
    })]);
  });

  it('exactly replays a canonicalized student deactivation batch', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    await seedStudent({ studentId: 'S002', name: '둘째', balance: 200 });
    const input = {
      operationId: 'student-deactivate-batch-replay-op',
      students: [
        { studentId: 'S002', expectedStudentVersion: 1 },
        { studentId: 'S001', expectedStudentVersion: 1 },
      ],
    };

    const first = await commands().deactivateBatch(input);
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') })
      .deactivateBatch(input);

    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.students).toEqual([
      expect.objectContaining({ student_id: 'S001', version: '2', deleted_at: NOW }),
      expect.objectContaining({ student_id: 'S002', version: '2', deleted_at: NOW }),
    ]);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(state.transactions).toHaveLength(0);
  });

  it('ignores an unexpected entry-level operation ID in favor of the deactivate batch operation ID', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    const student = {
      operationId: 'malicious-deactivate-entry-operation',
      studentId: 'S001',
      expectedStudentVersion: 1,
    };
    const input = {
      operationId: 'student-deactivate-batch-outer-op',
      students: [student],
    };

    const first = await commands().deactivateBatch(input);
    await expect(commands().deactivateBatch(input)).resolves.toEqual(first);
    expect(first.operationId).toBe(input.operationId);
  });

  it('matches deactivation replay rows by student ID instead of database row order', () => {
    const result = {
      ok: true as const,
      operationId: 'student-deactivate-collation-op',
      action: 'DEACTIVATE' as const,
      completedAt: NOW.toISOString(),
      students: [
        {
          studentId: 'Z', name: '첫째', balance: 100, status: 'INACTIVE' as const,
          studentVersionBefore: 1, studentVersionAfter: 2,
          accountVersionBefore: 1, accountVersionAfter: 1,
          balanceBefore: 100, balanceAfter: 100, transactionId: null,
        },
        {
          studentId: 'é', name: '둘째', balance: 200, status: 'INACTIVE' as const,
          studentVersionBefore: 1, studentVersionAfter: 2,
          accountVersionBefore: 1, accountVersionAfter: 1,
          balanceBefore: 200, balanceAfter: 200, transactionId: null,
        },
      ],
    };
    const databaseRows = [
      {
        student_id: 'é', name: '둘째', status: 'INACTIVE', student_version: '2',
        deleted_at: NOW, balance: '200', account_version: '1',
      },
      {
        student_id: 'Z', name: '첫째', status: 'INACTIVE', student_version: '2',
        deleted_at: NOW, balance: '100', account_version: '1',
      },
    ];

    expect(() => assertStudentAdminDeactivateStateRows(databaseRows, result)).not.toThrow();
  });

  it('rejects deactivate batches above the shared maximum before opening a transaction', async () => {
    const student = { studentId: 'S001', expectedStudentVersion: 1 };
    await expect(commands().deactivateBatch({
      operationId: 'student-deactivate-batch-at-limit-op',
      students: Array.from({ length: 100 }, () => student),
    })).rejects.toThrow(/duplicate student IDs/i);
    await expect(commands().deactivateBatch({
      operationId: 'student-deactivate-batch-over-limit-op',
      students: Array.from({ length: 101 }, () => student),
    })).rejects.toThrow(/at most 100 students/i);
    expect((await snapshot()).operations).toHaveLength(0);
  });

  it('rejects duplicate student IDs before starting a deactivate batch operation', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    const student = { studentId: 'S001', expectedStudentVersion: 1 };

    await expect(commands().deactivateBatch({
      operationId: 'student-deactivate-batch-duplicate-op',
      students: [student, student],
    })).rejects.toThrow(/duplicate student IDs/i);

    const state = await snapshot();
    expect(state.operations).toHaveLength(0);
    expect(state.students).toEqual([expect.objectContaining({ status: 'ACTIVE', version: '1' })]);
  });

  it('rolls back an entire deactivate batch when a later student version is stale', async () => {
    await seedStudent({ studentId: 'S001', name: '첫째', balance: 100 });
    await seedStudent({ studentId: 'S002', name: '둘째', balance: 200 });
    await harness.database.query(
      `UPDATE students SET version=2 WHERE tenant_id=$1 AND student_id='S002'`,
      [harness.tenantOneId],
    );

    await expect(commands().deactivateBatch({
      operationId: 'student-deactivate-batch-stale-op',
      students: [
        { studentId: 'S001', expectedStudentVersion: 1 },
        { studentId: 'S002', expectedStudentVersion: 1 },
      ],
    })).rejects.toThrow(/stale version/i);

    const state = await snapshot();
    expect(state.students).toEqual([
      expect.objectContaining({ student_id: 'S001', status: 'ACTIVE', version: '1', deleted_at: null }),
      expect.objectContaining({ student_id: 'S002', status: 'ACTIVE', version: '2', deleted_at: null }),
    ]);
    expect(state.operations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('does not reuse a tombstoned student ID', async () => {
    await seedStudent({ studentId: 'S001', name: '기존 학생', balance: 50, status: 'INACTIVE' });
    await harness.database.query(
      `UPDATE students SET deleted_at=$3, version=version+1
       WHERE tenant_id=$1 AND student_id=$2`,
      [harness.tenantOneId, 'S001', NOW],
    );

    await expect(commands().create(createInput())).rejects.toThrow();

    const operation = await harness.database.query(
      'SELECT operation_id FROM operations WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, OPERATION_ID],
    );
    expect(operation.rows).toEqual([]);
  });

  it('allows the same student and operation IDs in another tenant without cross-tenant reads', async () => {
    const tenantTwoCommands = createDatabaseStudentCommands({
      tenantId: harness.tenantTwoId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date(NOW),
    });

    await commands().create(createInput());
    await tenantTwoCommands.create(createInput({ name: '두 번째 반 학생' }));

    const rows = await harness.database.query<{ tenant_id: string; name: string }>(
      `SELECT tenant_id, name FROM students WHERE student_id=$1 ORDER BY tenant_id`,
      ['S001'],
    );
    expect(rows.rows).toEqual([
      { tenant_id: harness.tenantOneId, name: '김민준' },
      { tenant_id: harness.tenantTwoId, name: '두 번째 반 학생' },
    ]);
  });

  it('does not collide ledger identifiers for distinct canonical tuples containing delimiters', async () => {
    const first = await commands().create(createInput({
      operationId: 'a:b', studentId: 'c', name: '첫 학생', balance: 1,
    }));
    const second = await commands().create(createInput({
      operationId: 'a', studentId: 'b:c', name: '둘째 학생', balance: 1,
    }));

    expect(first.students[0].transactionId).not.toBe(second.students[0].transactionId);
    const ledgers = await harness.database.query<{ transaction_id: string; adjustment_id: string }>(
      `SELECT t.transaction_id, a.adjustment_id
       FROM transactions t JOIN adjustments a USING (tenant_id, transaction_id)
       WHERE t.tenant_id=$1 ORDER BY t.transaction_id`,
      [harness.tenantOneId],
    );
    expect(new Set(ledgers.rows.map((row) => row.transaction_id)).size).toBe(2);
    expect(new Set(ledgers.rows.map((row) => row.adjustment_id)).size).toBe(2);
  });

  it('rolls back operation, student, and account rows when the ledger insert conflicts', async () => {
    await seedStudent({ studentId: 'seed', name: '기존 학생', balance: 0 });
    await harness.database.query(
      `INSERT INTO transactions
        (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot,
         kind, legacy_total_amount, balance_delta, balance_before, balance_after,
         operator_snapshot, legacy_status_snapshot, operation_id, operation_hash, schema_version)
       VALUES ($1, $2, $3, 'seed', '기존 학생', 'ADMIN_ADJUSTMENT', 0, 0, 0, 0,
               'admin', 'ADMIN_ADJUSTMENT', $4, $5, 1)`,
      [harness.tenantOneId, createStudentAdminTransactionId(OPERATION_ID, 'S001'), NOW,
        createStudentAdminLedgerOperationId('seed-ledger-op', 'seed'), 'a'.repeat(64)],
    );

    await expect(commands().create(createInput())).rejects.toThrow();

    const rows = await harness.database.query(
      `SELECT student_id FROM students WHERE tenant_id=$1 AND student_id='S001'
       UNION ALL
       SELECT operation_id FROM operations WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, OPERATION_ID],
    );
    expect(rows.rows).toEqual([]);
  });
});
