import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';
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
  const bankHash = taskId === 'TASK-001' ? 'd'.repeat(64) : 'e'.repeat(64);
  const bankTransactionId = `task-reward:${bankOperationId}`;
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
    harness.tenantOneId, `completion:${taskId}:${studentId}`, '2026-08-31T00:30:00.000Z',
    taskInstanceId, taskId, title, studentId, studentName, cycleId, CURRENT_START,
    CURRENT_END, assignmentId, bankTransactionId, bankOperationId, bankHash,
  ]);
}

async function state(operationId = OPERATION_ID) {
  const [accounts, transactions, completions, operations, audits] = await Promise.all([
    harness.database.query(`SELECT student_id, balance::text, version::text FROM accounts
      WHERE tenant_id=$1 ORDER BY student_id`, [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM transactions WHERE tenant_id=$1 ORDER BY transaction_id`,
      [harness.tenantOneId]),
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
  return { accounts: accounts.rows, transactions: transactions.rows,
    completions: completions.rows, operations: operations.rows, audits: audits.rows };
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
      FROM task_completions WHERE tenant_id=$1 AND completion_id='completion:TASK-001:S001'`,
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
      { student_id: 'S001', balance: '700', version: '1' },
      { student_id: 'S002', balance: '700', version: '1' },
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
      VALUES ($1, 'completion:cancellation:S001', $2, 'INSTANCE-001', 'TASK-001',
        '첫째 과제', 'S001', '첫째 학생', 50, 700, 650, 'CANCELLED',
        'cancels-completion:completion:TASK-001:S001', $3, $4, $5, 1, 'Asia/Seoul',
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

  it('is tenant isolated', async () => {
    await expect(createDatabaseTaskResetCommands({ tenantId: harness.tenantTwoId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW })
      .resetBatch({ operationId: OPERATION_ID, taskIds: ['TASK-001'] }))
      .rejects.toThrow(/target.*not found/i);
    expect((await state()).completions).toHaveLength(2);
  });
});
