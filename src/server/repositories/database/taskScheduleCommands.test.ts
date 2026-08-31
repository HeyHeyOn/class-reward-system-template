import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantTransaction } from '@/server/db/transaction';
import type { TaskCycle } from '@/domain/taskRecurrence';
import { createDatabaseTaskAdminCommands } from './taskAdminCommands';
import { createDatabaseTaskScheduleCommands } from './taskScheduleCommands';
import { materializeTaskConfigurationBoundaryCycleInternal } from './taskCycleMaterialization';
import { createTaskRewardPayloadHash } from './taskCompletionCommands';
import { createCancellationPayloadHash } from './transactionCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-31T01:00:00.000Z');
let harness: PgliteDatabaseHarness;

const HASH = 'a'.repeat(64);
const INSTANCE = 'assignment-chain-instance';
type ClosedTaskCycle = TaskCycle & { endsAt: string; nextResetAt: string };
const cycle = (ruleVersion: number, startsAt: string, endsAt: string): ClosedTaskCycle => ({
  cycleId: `v1|${INSTANCE}|r${ruleVersion}|${startsAt.replace('.000Z', 'Z')}`,
  startsAt, endsAt, nextResetAt: endsAt,
});
const CHAIN_CYCLE_ONE = cycle(1, '2026-08-30T00:00:00Z', '2026-08-31T00:00:00Z');
const CHAIN_CYCLE_TWO = cycle(2, '2026-08-31T00:00:00Z', '2026-09-01T00:00:00Z');
const CHAIN_NEW_CYCLE = cycle(3, '2026-08-31T01:00:00Z', '2026-09-01T01:00:00Z');
const CHAIN_NOW = new Date(CHAIN_NEW_CYCLE.startsAt);
const REWARD_OPERATION = '10000000-0000-4000-8000-000000000001';
const ADMIN_OPERATION = '20000000-0000-4000-8000-000000000001';
const RESET_OPERATION = '30000000-0000-4000-8000-000000000001';

function assignmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sequence = String(overrides.event_sequence ?? '1');
  return { assignment_id: `assignment-${sequence}`, event_sequence: sequence,
    task_id_snapshot: 'TASK-CHAIN', task_instance_id: INSTANCE,
    cycle_id: CHAIN_CYCLE_ONE.cycleId, cycle_start_at: new Date(CHAIN_CYCLE_ONE.startsAt),
    cycle_end_at: new Date(CHAIN_CYCLE_ONE.endsAt), rule_version: 1,
    timezone: 'Asia/Seoul', student_id: 'S001', event_type: 'ASSIGNED',
    source: 'LEGACY_SEED', previous_assignment_id: null, admin_operation_id: null,
    admin_operation_hash: null, created_at: new Date('2026-08-30T00:00:00.000Z'),
    schema_version: 1, note: null, ...overrides };
}

function validMixedAssignmentChain() {
  return [
    assignmentRow(),
    assignmentRow({ assignment_id: 'assignment-2', event_sequence: '2', source: 'ADMIN',
      previous_assignment_id: 'assignment-1', admin_operation_id: 'admin-operation',
      admin_operation_hash: HASH, created_at: new Date('2026-08-30T01:00:00.000Z') }),
    assignmentRow({ assignment_id: 'assignment-3', event_sequence: '3', source: 'QR',
      previous_assignment_id: 'assignment-2', admin_operation_id: 'qr-operation',
      admin_operation_hash: HASH, created_at: new Date('2026-08-30T02:00:00.000Z') }),
    assignmentRow({ assignment_id: 'assignment-4', event_sequence: '4', source: 'CARRY_FORWARD',
      previous_assignment_id: 'assignment-3', cycle_id: CHAIN_CYCLE_TWO.cycleId,
      cycle_start_at: new Date(CHAIN_CYCLE_TWO.startsAt),
      cycle_end_at: new Date(CHAIN_CYCLE_TWO.endsAt), rule_version: 2,
      created_at: new Date(CHAIN_CYCLE_TWO.startsAt) }),
  ];
}

function completionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sequence = String(overrides.event_sequence ?? '1');
  return { completion_id: `completion-${sequence}`, event_sequence: sequence,
    completed_at: new Date('2026-08-30T03:00:00.000Z'), task_instance_id: INSTANCE,
    task_id_snapshot: 'TASK-CHAIN', task_name_snapshot: 'Chain task', student_id: 'S001',
    student_name_snapshot: 'Student one', reward_snapshot: '0', balance_before: '10',
    balance_after: '10', status: 'COMPLETED', note: null, cycle_id: CHAIN_CYCLE_ONE.cycleId,
    cycle_start_at: new Date(CHAIN_CYCLE_ONE.startsAt), cycle_end_at: new Date(CHAIN_CYCLE_ONE.endsAt),
    rule_version: 1, timezone: 'Asia/Seoul', source: 'ADMIN', assignment_id: 'assignment-3',
    transaction_id: null, operation_id: null, operation_hash: null,
    admin_operation_id: ADMIN_OPERATION, admin_operation_hash: HASH, schema_version: 1,
    evidence_provider: null, evidence_board_id: null, evidence_post_id: null,
    evidence_created_at: null, evidence_author_full_name: null,
    created_at: new Date('2026-08-30T03:00:00.000Z'), ...overrides };
}

function rewardHash() {
  return createTaskRewardPayloadHash({ taskId: 'TASK-CHAIN', taskInstanceId: INSTANCE,
    taskTitle: 'Chain task', studentId: 'S001', studentName: 'Student one',
    assignmentId: 'assignment-3', cycleId: CHAIN_CYCLE_ONE.cycleId,
    cycleStartsAt: new Date(CHAIN_CYCLE_ONE.startsAt).toISOString(),
    cycleEndsAt: new Date(CHAIN_CYCLE_ONE.endsAt).toISOString(), reward: 10 });
}

function adminResetCompletionId(operationId: string, taskInstanceId = INSTANCE,
  studentId = 'S001', cycleId = CHAIN_CYCLE_TWO.cycleId) {
  const digest = createHash('sha256').update(JSON.stringify({
    domain: 'task-completion-admin-reset-v1', operationId, taskInstanceId, studentId, cycleId,
  }), 'utf8').digest('hex');
  return `task-completion-admin-reset:${digest}`;
}

function validMixedCompletionChain() {
  const bankHash = rewardHash();
  return [
    completionRow({ completion_id: `task-completion:${REWARD_OPERATION}`, event_sequence: '1',
      completed_at: new Date('2026-08-30T02:00:00.000Z'), created_at: new Date('2026-08-30T02:00:00.000Z'),
      source: 'BANK', reward_snapshot: '10', balance_before: '0', balance_after: '10',
      note: 'bank-self-completion', transaction_id: `task-reward:${REWARD_OPERATION}`,
      operation_id: REWARD_OPERATION, operation_hash: bankHash,
      admin_operation_id: null, admin_operation_hash: null }),
    completionRow({ completion_id: 'completion-2', event_sequence: '2' }),
    completionRow({ completion_id: 'carry-completion', event_sequence: '3',
      completed_at: new Date(CHAIN_CYCLE_TWO.startsAt), created_at: new Date(CHAIN_CYCLE_TWO.startsAt),
      source: 'CARRY_FORWARD', assignment_id: 'assignment-4',
      cycle_id: CHAIN_CYCLE_TWO.cycleId, cycle_start_at: new Date(CHAIN_CYCLE_TWO.startsAt),
      cycle_end_at: new Date(CHAIN_CYCLE_TWO.endsAt), rule_version: 2,
      admin_operation_id: null, admin_operation_hash: null }),
    completionRow({ completion_id: adminResetCompletionId(RESET_OPERATION), event_sequence: '4',
      completed_at: new Date('2026-08-31T00:30:00.000Z'),
      created_at: new Date('2026-08-31T00:30:00.000Z'), status: 'CANCELLED',
      source: 'ADMIN_RESET', note: 'admin-completion-reset', assignment_id: 'assignment-4',
      cycle_id: CHAIN_CYCLE_TWO.cycleId, cycle_start_at: new Date(CHAIN_CYCLE_TWO.startsAt),
      cycle_end_at: new Date(CHAIN_CYCLE_TWO.endsAt), rule_version: 2,
      admin_operation_id: RESET_OPERATION }),
  ];
}

function completionReferences() {
  const bankHash = rewardHash();
  return {
    operations: [
      { operation_id: REWARD_OPERATION, operation_kind: 'TASK_REWARD', payload_hash: bankHash },
      { operation_id: ADMIN_OPERATION, operation_kind: 'TASK_ADMIN', payload_hash: HASH },
      { operation_id: RESET_OPERATION, operation_kind: 'TASK_ADMIN', payload_hash: HASH },
    ],
    transactions: [{ transaction_id: `task-reward:${REWARD_OPERATION}`, event_sequence: '1',
      occurred_at: new Date('2026-08-30T02:00:00.000Z'), student_id: 'S001',
      student_name_snapshot: 'Student one', kind: 'TASK_REWARD', legacy_total_amount: '10',
      balance_delta: '10', balance_before: '0', balance_after: '10',
      operator_snapshot: 'bank-task-completion', legacy_status_snapshot: 'COMPLETED',
      reverses_transaction_id: null, operation_id: REWARD_OPERATION,
      operation_hash: bankHash, schema_version: 1, created_at: new Date('2026-08-30T02:00:00.000Z') }],
  };
}

function validCancellationCompletionChain() {
  const bank = validMixedCompletionChain()[0];
  const references = completionReferences();
  const cancellationHash = createCancellationPayloadHash(references.transactions[0] as never, [], bank as never);
  return [bank, completionRow({ completion_id: `task-completion-cancellation:${RESET_OPERATION}`,
    event_sequence: '2', completed_at: new Date('2026-08-30T05:00:00.000Z'),
    created_at: new Date('2026-08-30T05:00:00.000Z'), source: 'ADMIN_RESET',
    status: 'CANCELLED', reward_snapshot: '10', balance_before: '10', balance_after: '0',
    note: `cancels-completion:task-completion:${REWARD_OPERATION}`,
    transaction_id: `cancellation:${RESET_OPERATION}`, operation_id: RESET_OPERATION,
    operation_hash: cancellationHash, admin_operation_id: null, admin_operation_hash: null })];
}

function cancellationReferences() {
  const references = completionReferences();
  const bank = validMixedCompletionChain()[0];
  const cancellationHash = createCancellationPayloadHash(references.transactions[0] as never, [], bank as never);
  return { operations: [...references.operations.filter((row) => row.operation_id === REWARD_OPERATION),
    { operation_id: RESET_OPERATION, operation_kind: 'CANCELLATION', payload_hash: cancellationHash }],
  transactions: [...references.transactions, { transaction_id: `cancellation:${RESET_OPERATION}`,
    event_sequence: '2', occurred_at: new Date('2026-08-30T05:00:00.000Z'), student_id: 'S001',
    student_name_snapshot: 'Student one', kind: 'CANCELLATION', legacy_total_amount: '10',
    balance_delta: '-10', balance_before: '10', balance_after: '0',
    operator_snapshot: 'admin-cancellation', legacy_status_snapshot: 'CANCEL_REVERSAL',
    reverses_transaction_id: `task-reward:${REWARD_OPERATION}`, operation_id: RESET_OPERATION,
    operation_hash: cancellationHash, schema_version: 1,
    created_at: new Date('2026-08-30T05:00:00.000Z') }] };
}

async function materializeWithAssignmentRows(rows: unknown, completionRows: unknown = [],
  references: { operations: Record<string, unknown>[]; transactions: Record<string, unknown>[] }
    = completionReferences()) {
  const dialect = new PgDialect();
  let assignmentRead = 0;
  let completionRead = 0;
  let insertedAssignment: Record<string, unknown> | undefined;
  let insertedCompletion: Record<string, unknown> | undefined;
  const tx = { execute: async (wrapper: SQLWrapper) => {
    const query = dialect.sqlToQuery(wrapper.getSQL());
    const statement = query.sql.toLowerCase().replace(/\s+/g, ' ');
    if (statement.includes('from task_allowed_students')) return { rows: [{
      task_instance_id: INSTANCE, student_id: 'S001', created_at: new Date('2026-08-30T00:00:00.000Z'),
    }] };
    if (statement.includes('from task_assignments')) {
      if (assignmentRead++ === 0) return { rows };
      return { rows: insertedAssignment ? [insertedAssignment] : [] };
    }
    if (statement.includes('from task_completions')) {
      if (completionRead++ === 0) return { rows: completionRows };
      return { rows: insertedCompletion ? [insertedCompletion] : [] };
    }
    if (statement.includes('from operations')) return { rows: references.operations };
    if (statement.includes('from transactions')) return { rows: references.transactions };
    if (statement.startsWith('insert into task_assignments')) {
      const assignmentId = query.params[1] as string;
      const predecessorId = Array.isArray(rows) ? [...rows]
        .filter((raw): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null
          && (raw as Record<string, unknown>).cycle_id === CHAIN_CYCLE_TWO.cycleId)
        .sort((left, right) => Number(left.event_sequence) - Number(right.event_sequence))
        .at(-1)?.assignment_id as string | undefined : undefined;
      insertedAssignment = assignmentRow({ assignment_id: assignmentId, event_sequence: '6',
        source: 'CARRY_FORWARD', previous_assignment_id: predecessorId ?? 'assignment-4',
        cycle_id: CHAIN_NEW_CYCLE.cycleId, cycle_start_at: new Date(CHAIN_NEW_CYCLE.startsAt),
        cycle_end_at: new Date(CHAIN_NEW_CYCLE.endsAt), rule_version: 3,
        created_at: CHAIN_NOW });
      return { rows: [{ assignment_id: assignmentId }] };
    }
    if (statement.startsWith('insert into task_completions')) {
      const completionId = query.params[1] as string;
      insertedCompletion = completionRow({ completion_id: completionId, event_sequence: '5',
        completed_at: CHAIN_NOW, created_at: CHAIN_NOW, source: 'CARRY_FORWARD',
        assignment_id: insertedAssignment?.assignment_id, cycle_id: CHAIN_NEW_CYCLE.cycleId,
        cycle_start_at: new Date(CHAIN_NEW_CYCLE.startsAt),
        cycle_end_at: new Date(CHAIN_NEW_CYCLE.endsAt), rule_version: 3,
        admin_operation_id: null, admin_operation_hash: null });
      return { rows: [{ completion_id: completionId }] };
    }
    throw new Error(`unexpected statement: ${statement}`);
  } } as unknown as TenantTransaction;
  return materializeTaskConfigurationBoundaryCycleInternal({ tx, tenantId: 'tenant',
    taskId: 'TASK-CHAIN', taskInstanceId: INSTANCE, oldCycle: CHAIN_CYCLE_TWO,
    oldRuleVersion: 2, newCycle: CHAIN_NEW_CYCLE, newRuleVersion: 3,
    timeZone: 'Asia/Seoul', now: CHAIN_NOW });
}

async function seedAssignmentOperation(operationId: string, payloadHash: string) {
  await harness.database.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
     attempt_count, started_at, finished_at, created_at, updated_at)
    VALUES ($1, $2, 'TASK_ADMIN', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
  [harness.tenantOneId, operationId, payloadHash, '2026-08-30T01:00:00.000Z']);
}

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await harness.database.exec(await readFile(resolve(
    process.cwd(), 'src/server/db/migrations/0010_task_admin_invariants.sql',
  ), 'utf8'));
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status, created_at, updated_at)
     VALUES ($1, 'S001', '하나', 'ACTIVE', $2, $2)`,
    [harness.tenantOneId, NOW.toISOString()],
  );
});

afterEach(async () => harness.close());

async function createScheduleFixture(taskId: string, createdAt = '2026-08-30T01:00:00.000Z') {
  return createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction, now: () => new Date(createdAt) }).create({
    operationId: `create-${taskId}`, taskId, title: taskId, description: '', reward: 1,
    isActive: true, sortOrder: 0, allowedStudentIds: ['S001'], schedule: {
      recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
    },
  });
}

function changedScheduleInput(operationId: string, taskId: string) {
  return { operationId, taskId, expectedTaskVersion: 1,
    recurrence: { type: 'WEEKLY' as const, time: '09:00', weekdays: [1] as const },
    timeZone: 'Asia/Seoul' as const, resetCompletionOnCycle: true,
    resetAssignmentOnCycle: true };
}

async function readFullTaskState(taskId: string) {
  return (await harness.database.query(`SELECT task_instance_id, task_id, title, description,
    reward::text AS reward, sort_order, prerequisite_task_instance_id, padlet_board_id,
    current_schedule, pending_schedule, schedule_schema_version, version::text AS version,
    is_active, available_from, available_until, due_at, created_at, updated_at, deleted_at
    FROM tasks WHERE tenant_id=$1 AND task_id=$2 ORDER BY task_instance_id`,
  [harness.tenantOneId, taskId])).rows;
}

function malformedDenseRows(rows: readonly unknown[], mode: 'sparse' | 'getter', onGetter: () => void) {
  if (mode === 'sparse') return new Array(Math.max(rows.length, 1));
  const malformed: unknown[] = [];
  Object.defineProperty(malformed, '0', { enumerable: true, configurable: true,
    get() { onGetter(); return rows[0]; } });
  Object.defineProperty(malformed, 'length', { value: 1, writable: true });
  return malformed;
}

async function createConnectedScheduleFixture(taskId: string) {
  const createdAt = new Date('2026-08-30T01:00:00.000Z');
  const created = await createScheduleFixture(taskId, createdAt.toISOString());
  const taskInstanceId = created.tasks[0].taskInstanceId;
  const assignmentRows = await harness.database.query(`SELECT assignment_id, cycle_id,
    cycle_start_at, cycle_end_at FROM task_assignments WHERE tenant_id=$1
    AND task_instance_id=$2 ORDER BY event_sequence`, [harness.tenantOneId, taskInstanceId]);
  const assignment = assignmentRows.rows[0] as { assignment_id: string; cycle_id: string;
    cycle_start_at: Date; cycle_end_at: Date | null };
  const operationId = '40000000-0000-4000-8000-000000000001';
  const completedAt = new Date('2026-08-30T01:10:00.000Z');
  const operationHash = createTaskRewardPayloadHash({ taskId, taskInstanceId, taskTitle: taskId,
    studentId: 'S001', studentName: '하나', assignmentId: assignment.assignment_id,
    cycleId: assignment.cycle_id, cycleStartsAt: assignment.cycle_start_at.toISOString(),
    cycleEndsAt: assignment.cycle_end_at?.toISOString() ?? null, reward: 1 });
  await harness.database.query(`INSERT INTO accounts
    (tenant_id, student_id, balance, version, updated_at) VALUES ($1, 'S001', 1, 2, $2)`,
  [harness.tenantOneId, completedAt]);
  await harness.database.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
     attempt_count, started_at, finished_at, created_at, updated_at)
    VALUES ($1, $2, 'TASK_REWARD', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
  [harness.tenantOneId, operationId, operationHash, completedAt]);
  const transactionId = `task-reward:${operationId}`;
  await harness.database.query(`INSERT INTO transactions
    (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
     legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
     legacy_status_snapshot, operation_id, operation_hash, schema_version, created_at)
    VALUES ($1, $2, $3, 'S001', '하나', 'TASK_REWARD', 1, 1, 0, 1,
      'bank-task-completion', 'COMPLETED', $4, $5, 1, $3)`,
  [harness.tenantOneId, transactionId, completedAt, operationId, operationHash]);
  await harness.database.query(`INSERT INTO task_completions
    (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
     task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
     balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
     rule_version, timezone, source, assignment_id, transaction_id, operation_id,
     operation_hash, schema_version, created_at)
    VALUES ($1, $2, $3, $4, $5, $5, 'S001', '하나', 1, 0, 1, 'COMPLETED',
      'bank-self-completion', $6, $7, $8, 1, 'Asia/Seoul', 'BANK', $9, $10, $11, $12, 1, $3)`,
  [harness.tenantOneId, `task-completion:${operationId}`, completedAt, taskInstanceId, taskId,
    assignment.cycle_id, assignment.cycle_start_at, assignment.cycle_end_at,
    assignment.assignment_id, transactionId, operationId, operationHash]);
  return taskInstanceId;
}

async function readConnectedScheduleState(taskId: string, operationId: string) {
  const taskRows = await readFullTaskState(taskId);
  const taskInstanceId = (taskRows[0] as { task_instance_id: string }).task_instance_id;
  const query = async (statement: string) => (await harness.database.query(statement,
    [harness.tenantOneId, taskInstanceId])).rows;
  return {
    tasks: taskRows,
    mirrors: await query(`SELECT * FROM task_allowed_students WHERE tenant_id=$1
      AND task_instance_id=$2 ORDER BY student_id`),
    assignments: await query(`SELECT * FROM task_assignments WHERE tenant_id=$1
      AND task_instance_id=$2 ORDER BY event_sequence`),
    completions: await query(`SELECT * FROM task_completions WHERE tenant_id=$1
      AND task_instance_id=$2 ORDER BY event_sequence`),
    accounts: (await harness.database.query(`SELECT * FROM accounts WHERE tenant_id=$1
      AND student_id='S001' ORDER BY student_id`, [harness.tenantOneId])).rows,
    transactions: (await harness.database.query(`SELECT * FROM transactions WHERE tenant_id=$1
      AND student_id='S001' ORDER BY event_sequence`, [harness.tenantOneId])).rows,
    operation: (await harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1
      AND operation_id=$2`, [harness.tenantOneId, operationId])).rows,
    audit: (await harness.database.query(`SELECT * FROM audit_events WHERE tenant_id=$1
      AND operation_id=$2`, [harness.tenantOneId, operationId])).rows,
  };
}

describe('database task schedule command configuration boundary', () => {
  it('accepts a mixed legacy, administrative, QR, and carry-forward chain in adapter-independent order', async () => {
    const result = await materializeWithAssignmentRows(validMixedAssignmentChain().reverse());
    expect(result.assignmentEventIds).toHaveLength(1);
    expect(result.completionEventIds).toEqual([]);
  });

  it('accepts multiple retained same-cycle legacy seed roots with null predecessors', async () => {
    const result = await materializeWithAssignmentRows([
      assignmentRow(),
      assignmentRow({ assignment_id: 'legacy-root-2', event_sequence: '2',
        previous_assignment_id: null, created_at: new Date('2026-08-30T00:10:00.000Z') }),
    ].reverse());
    expect(result.assignmentEventIds).toEqual([]);
    expect(result.completionEventIds).toEqual([]);
  });

  it.each([
    ['legacy unassignment', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[0].event_type = 'UNASSIGNED';
    }],
    ['legacy predecessor', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[0].previous_assignment_id = 'foreign-assignment';
    }],
    ['incomplete administrative binding', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[1].admin_operation_hash = null;
    }],
    ['non-immediate administrative predecessor', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[2].previous_assignment_id = 'assignment-1';
    }],
    ['carry-forward unassignment', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[3].event_type = 'UNASSIGNED';
    }],
    ['carry-forward missing predecessor', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[3].previous_assignment_id = null;
    }],
    ['carry-forward without a higher rule version', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[3].rule_version = 1;
      rows[3].cycle_id = cycle(1, CHAIN_CYCLE_TWO.startsAt, CHAIN_CYCLE_TWO.endsAt).cycleId;
    }],
    ['duplicate assignment identity', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[3].assignment_id = 'assignment-3';
    }],
    ['duplicate event sequence', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[3].event_sequence = '3';
    }],
    ['future-created evidence', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[3].created_at = new Date(CHAIN_NOW.getTime() + 1);
    }],
    ['evidence created at its exclusive cycle end', (rows: ReturnType<typeof validMixedAssignmentChain>) => {
      rows[3].created_at = new Date(CHAIN_CYCLE_TWO.endsAt);
    }],
  ])('rejects malformed assignment evidence: %s', async (_label, mutate) => {
    const rows = validMixedAssignmentChain();
    mutate(rows);
    await expect(materializeWithAssignmentRows(rows)).rejects.toThrow(/assignment evidence integrity/i);
  });

  it('rejects a sparse assignment result before iteration', async () => {
    const sparse = new Array(1);
    await expect(materializeWithAssignmentRows(sparse)).rejects.toThrow(/assignment.*malformed/i);
  });

  it('rejects an assignment result index getter without invoking it', async () => {
    let getterCalls = 0;
    const rows: unknown[] = [];
    Object.defineProperty(rows, '0', { enumerable: true, configurable: true,
      get() { getterCalls += 1; return validMixedAssignmentChain()[0]; } });
    Object.defineProperty(rows, 'length', { value: 1, writable: true });
    await expect(materializeWithAssignmentRows(rows)).rejects.toThrow(/assignment.*malformed/i);
    expect(getterCalls).toBe(0);
  });

  it('accepts a mixed BANK, ADMIN, carry-forward, and canonical administrator reset chain independent of adapter order', async () => {
    const result = await materializeWithAssignmentRows(validMixedAssignmentChain().reverse(),
      validMixedCompletionChain().reverse());
    expect(result.assignmentEventIds).toHaveLength(1);
    expect(result.completionEventIds).toHaveLength(0);
  });

  it('accepts the transaction-cancellation ADMIN_RESET provenance variant', async () => {
    const result = await materializeWithAssignmentRows(validMixedAssignmentChain().reverse(),
      validCancellationCompletionChain().reverse(), cancellationReferences());
    expect(result.assignmentEventIds).toHaveLength(1);
    expect(result.completionEventIds).toHaveLength(0);
  });

  it.each([
    ['BANK operation hash mismatch', (rows: Record<string, unknown>[], references: ReturnType<typeof completionReferences>) => {
      references.operations[0].payload_hash = 'b'.repeat(64);
    }],
    ['BANK transaction semantic mismatch', (_rows: Record<string, unknown>[], references: ReturnType<typeof completionReferences>) => {
      references.transactions[0].balance_after = '11';
    }],
    ['ADMIN wrong operation kind', (_rows: Record<string, unknown>[], references: ReturnType<typeof completionReferences>) => {
      references.operations[1].operation_kind = 'TASK_REWARD';
    }],
    ['carry-forward wrong local assignment', (rows: Record<string, unknown>[]) => {
      rows[2].assignment_id = 'assignment-3';
    }],
    ['carry-forward wrong predecessor balance', (rows: Record<string, unknown>[]) => {
      rows[2].balance_before = '9'; rows[2].balance_after = '9';
    }],
    ['cross-subject completion', (rows: Record<string, unknown>[]) => {
      rows[1].student_id = 'S002';
    }],
    ['duplicate completion ID', (rows: Record<string, unknown>[]) => {
      rows[3].completion_id = rows[2].completion_id;
    }],
    ['duplicate completion sequence', (rows: Record<string, unknown>[]) => {
      rows[3].event_sequence = rows[2].event_sequence;
    }],
  ])('rejects malformed completion history: %s', async (_label, mutate) => {
    const rows = validMixedCompletionChain(); const references = completionReferences();
    mutate(rows, references);
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(), rows, references))
      .rejects.toThrow(/completion|operation|transaction/i);
  });

  it('rejects a cancellation reset with a non-deterministic original completion link', async () => {
    const rows = validCancellationCompletionChain();
    rows[1].note = 'cancels-completion:other';
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(), rows,
      cancellationReferences())).rejects.toThrow(/completion|transaction/i);
  });

  it('rejects a cancellation completion when the append-only original BANK completion is missing', async () => {
    const rows = validCancellationCompletionChain().slice(1);
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(), rows,
      cancellationReferences())).rejects.toThrow(/completion|transaction/i);
  });

  it('rejects a captured BANK transaction whose direct reversal has no cancellation completion', async () => {
    const references = cancellationReferences();
    references.operations = references.operations.filter((row) => row.operation_id === REWARD_OPERATION);
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(),
      [validCancellationCompletionChain()[0]], references)).rejects.toThrow(/completion|transaction/i);
  });

  it('rejects an unrelated transaction row injected by the adapter', async () => {
    const references = completionReferences();
    references.operations = references.operations.filter((row) => row.operation_id === REWARD_OPERATION);
    references.transactions.push({ ...references.transactions[0], transaction_id: 'external-transaction',
      event_sequence: '99', operation_id: '40000000-0000-4000-8000-000000000001' });
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(),
      [validMixedCompletionChain()[0]], references)).rejects.toThrow(/transaction/i);
  });

  it('rejects duplicate transaction event_sequence evidence', async () => {
    const references = cancellationReferences();
    references.transactions[1].event_sequence = references.transactions[0].event_sequence;
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(),
      validCancellationCompletionChain(), references)).rejects.toThrow(/transaction/i);
  });

  it('rejects per-subject completion timestamps that move backwards with event_sequence', async () => {
    const rows = validMixedCompletionChain();
    rows[1].completed_at = new Date('2026-08-30T01:00:00.000Z');
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(), rows,
      completionReferences())).rejects.toThrow(/completion/i);
  });

  it('rejects carry-forward after an immediate administrator reset instead of stale completed state', async () => {
    const rows = validMixedCompletionChain();
    const carry = rows[2]; const reset = rows[3];
    reset.event_sequence = '3'; reset.completed_at = new Date('2026-08-30T04:00:00.000Z');
    reset.created_at = new Date('2026-08-30T04:00:00.000Z'); reset.assignment_id = 'assignment-3';
    reset.cycle_id = CHAIN_CYCLE_ONE.cycleId; reset.cycle_start_at = new Date(CHAIN_CYCLE_ONE.startsAt);
    reset.cycle_end_at = new Date(CHAIN_CYCLE_ONE.endsAt); reset.rule_version = 1;
    reset.completion_id = adminResetCompletionId(RESET_OPERATION, INSTANCE, 'S001', CHAIN_CYCLE_ONE.cycleId);
    carry.event_sequence = '4';
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(), rows,
      completionReferences())).rejects.toThrow(/completion/i);
  });

  it('rejects carry-forward across an intervening assignment without a completion', async () => {
    const assignments = [...validMixedAssignmentChain(), assignmentRow({
      assignment_id: 'assignment-5', event_sequence: '5', source: 'ADMIN',
      previous_assignment_id: 'assignment-4', cycle_id: CHAIN_CYCLE_TWO.cycleId,
      cycle_start_at: new Date(CHAIN_CYCLE_TWO.startsAt),
      cycle_end_at: new Date(CHAIN_CYCLE_TWO.endsAt), rule_version: 2,
      admin_operation_id: ADMIN_OPERATION, admin_operation_hash: HASH,
      created_at: new Date('2026-08-31T00:10:00.000Z'),
    })];
    const completions = [completionRow({ completion_id: 'prior-completion', event_sequence: '1' }),
      completionRow({ completion_id: 'stale-carry', event_sequence: '2', source: 'CARRY_FORWARD',
        completed_at: new Date(CHAIN_CYCLE_TWO.startsAt),
        created_at: new Date(CHAIN_CYCLE_TWO.startsAt), assignment_id: 'assignment-5',
        cycle_id: CHAIN_CYCLE_TWO.cycleId, cycle_start_at: new Date(CHAIN_CYCLE_TWO.startsAt),
        cycle_end_at: new Date(CHAIN_CYCLE_TWO.endsAt), rule_version: 2,
        admin_operation_id: null, admin_operation_hash: null })];
    await expect(materializeWithAssignmentRows(assignments, completions, {
      operations: [{ operation_id: ADMIN_OPERATION, operation_kind: 'TASK_ADMIN',
        payload_hash: HASH }], transactions: [],
    })).rejects.toThrow(/completion/i);
  });

  it.each([
    ['ID', (row: Record<string, unknown>) => { row.completion_id = 'admin-reset-arbitrary'; }],
    ['note', (row: Record<string, unknown>) => { row.note = 'arbitrary reset'; }],
  ])('rejects an administrator ADMIN_RESET with a non-canonical %s', async (_label, mutate) => {
    const rows = validMixedCompletionChain(); mutate(rows[3]);
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(), rows,
      completionReferences())).rejects.toThrow(/completion/i);
  });

  it('rejects Padlet evidence created before the exact cycle start', async () => {
    const rows = validMixedCompletionChain(); const references = completionReferences();
    const bank = rows[0];
    Object.assign(bank, { evidence_provider: 'PADLET', evidence_board_id: 'AbCdEfGhIjKlMnOp',
      evidence_post_id: 'post-001', evidence_created_at: new Date('2026-08-29T23:59:59.999Z'),
      evidence_author_full_name: 'Student one' });
    const hash = createTaskRewardPayloadHash({ taskId: 'TASK-CHAIN', taskInstanceId: INSTANCE,
      taskTitle: 'Chain task', studentId: 'S001', studentName: 'Student one',
      assignmentId: 'assignment-3', cycleId: CHAIN_CYCLE_ONE.cycleId,
      cycleStartsAt: new Date(CHAIN_CYCLE_ONE.startsAt).toISOString(),
      cycleEndsAt: new Date(CHAIN_CYCLE_ONE.endsAt).toISOString(), reward: 10,
      evidence: { evidenceProvider: 'PADLET', evidenceBoardId: 'AbCdEfGhIjKlMnOp',
        evidencePostId: 'post-001', evidenceCreatedAt: '2026-08-29T23:59:59.999Z',
        evidenceAuthorFullName: 'Student one' } });
    bank.operation_hash = hash; references.operations[0].payload_hash = hash;
    references.transactions[0].operation_hash = hash;
    await expect(materializeWithAssignmentRows(validMixedAssignmentChain(), rows, references))
      .rejects.toThrow(/completion/i);
  });

  it('updates two tasks through one canonical batch command', async () => {
    const admin = createDatabaseTaskAdminCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z'),
    });
    for (const taskId of ['TASK-002', 'TASK-001']) {
      await admin.create({ operationId: `schedule-create-${taskId}`, taskId, title: taskId,
        description: '', reward: 100, isActive: true, sortOrder: 0,
        allowedStudentIds: ['S001'], schedule: {
          recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
          resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
        } });
    }
    const commands = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW });
    const result = await commands.updateBatch({
      operationId: '00000000-0000-4000-8000-000000000011',
      tasks: ['TASK-002', 'TASK-001'].map((taskId) => ({ taskId, expectedTaskVersion: 1,
        recurrence: { type: 'WEEKLY' as const, time: '09:00', weekdays: [1] as const },
        timeZone: 'Asia/Seoul' as const, resetCompletionOnCycle: true,
        resetAssignmentOnCycle: true })),
    });
    expect(result.tasks.map((task) => task.taskId)).toEqual(['TASK-001', 'TASK-002']);
  });

  it('carries assignment and completion exactly once with zero reward', async () => {
    const admin = createDatabaseTaskAdminCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z'),
    });
    const created = await admin.create({
      operationId: 'schedule-red-create',
      taskId: 'TASK-001',
      title: '과제',
      description: '',
      reward: 100,
      isActive: true,
      sortOrder: 0,
      allowedStudentIds: ['S001'],
      schedule: {
        recurrence: { type: 'DAILY', time: '09:00' },
        timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: true,
      },
    });
    const taskInstanceId = created.tasks[0].taskInstanceId;
    await seedAssignmentOperation('00000000-0000-4000-8000-000000000101', HASH);
    await harness.database.query(
      `INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
         task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
         balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
         rule_version, timezone, source, assignment_id, admin_operation_id,
         admin_operation_hash, schema_version, created_at)
       SELECT tenant_id, 'schedule-red-completion', $3, task_instance_id, task_id_snapshot,
         '과제', student_id, '하나', 0, 0, 0, 'COMPLETED', NULL, cycle_id,
         cycle_start_at, cycle_end_at, rule_version, timezone, 'ADMIN',
         assignment_id, '00000000-0000-4000-8000-000000000101', $4, 1, $3
       FROM task_assignments
       WHERE tenant_id=$1 AND task_instance_id=$2
       ORDER BY event_sequence DESC LIMIT 1`,
      [harness.tenantOneId, taskInstanceId, '2026-08-30T01:00:00.000Z', HASH],
    );

    const editNow = new Date('2026-08-30T02:00:00.000Z');
    const commands = createDatabaseTaskScheduleCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => editNow,
    });
    await commands.update({
      operationId: '00000000-0000-4000-8000-000000000010',
      taskId: 'TASK-001',
      expectedTaskVersion: 1,
      recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1] },
      timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: true,
    });

    const assignments = await harness.database.query(
      `SELECT source, event_type, rule_version, previous_assignment_id
       FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2
       ORDER BY event_sequence`,
      [harness.tenantOneId, taskInstanceId],
    );
    const completions = await harness.database.query(
      `SELECT source, status, reward_snapshot::text AS reward_snapshot,
              balance_before::text AS balance_before, balance_after::text AS balance_after,
              rule_version
       FROM task_completions WHERE tenant_id=$1 AND task_instance_id=$2
       ORDER BY event_sequence`,
      [harness.tenantOneId, taskInstanceId],
    );
    expect(assignments.rows).toHaveLength(2);
    expect(assignments.rows[1]).toEqual(expect.objectContaining({
      source: 'CARRY_FORWARD', event_type: 'ASSIGNED', rule_version: 2,
      previous_assignment_id: created.tasks[0].assignmentEventIds[0],
    }));
    expect(completions.rows).toHaveLength(2);
    expect(completions.rows[1]).toEqual(expect.objectContaining({
      source: 'CARRY_FORWARD', status: 'COMPLETED', reward_snapshot: '0',
      balance_before: '0', balance_after: '0', rule_version: 2,
    }));

    await commands.update({
      operationId: '00000000-0000-4000-8000-000000000010',
      taskId: 'TASK-001',
      expectedTaskVersion: 1,
      recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1] },
      timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: true,
    });
    expect((await harness.database.query(
      `SELECT assignment_id FROM task_assignments
       WHERE tenant_id=$1 AND task_instance_id=$2 AND source='CARRY_FORWARD'`,
      [harness.tenantOneId, taskInstanceId],
    )).rows).toHaveLength(1);
    expect((await harness.database.query(
      `SELECT completion_id FROM task_completions
       WHERE tenant_id=$1 AND task_instance_id=$2 AND source='CARRY_FORWARD'
         AND completion_id <> 'schedule-red-completion'`,
      [harness.tenantOneId, taskInstanceId],
    )).rows).toHaveLength(1);
  });

  it('derives carry state only from the exact old cycle instead of a later global event', async () => {
    const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z') });
    const created = await admin.create({ operationId: 'create-exact-old-cycle', taskId: 'TASK-EXACT',
      title: 'exact', description: '', reward: 1, isActive: true, sortOrder: 0,
      allowedStudentIds: ['S001'], schedule: { recurrence: { type: 'DAILY', time: '09:00' },
        timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const instance = created.tasks[0].taskInstanceId;
    const oldAssignment = created.tasks[0].assignmentEventIds[0];
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, 'future-stale-unassignment', 'TASK-EXACT', $2,
       $3, '2026-08-30T01:30:00.000Z', '2026-09-01T00:00:00.000Z', 2,
       'Asia/Seoul', 'S001', 'ASSIGNED', 'CARRY_FORWARD', $4, NULL, NULL,
       '2026-08-30T01:30:00.000Z', 1, NULL)`, [harness.tenantOneId, instance,
      `v1|${instance}|r2|2026-08-30T01:30:00Z`, oldAssignment]);
    const result = await createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T02:00:00.000Z') }).update({
      operationId: '00000000-0000-4000-8000-000000000012', taskId: 'TASK-EXACT',
      expectedTaskVersion: 1,
      recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1] }, timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: true });
    const carried = await harness.database.query(`SELECT previous_assignment_id
      FROM task_assignments WHERE tenant_id=$1 AND assignment_id=$2`,
    [harness.tenantOneId, result.assignmentEventIds[0]]);
    expect(carried.rows).toEqual([{ previous_assignment_id: oldAssignment }]);
  });

  it('skips a historical completer who was later unassigned and is absent from the mirror', async () => {
    await harness.database.query(`INSERT INTO students
      (tenant_id, student_id, name, status, created_at, updated_at)
      VALUES ($1, 'S002', '둘', 'ACTIVE', $2, $2)`,
    [harness.tenantOneId, NOW.toISOString()]);
    const created = await createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z') }).create({
      operationId: 'create-skipped-completer', taskId: 'TASK-SKIP', title: 'skip',
      description: '', reward: 1, isActive: true, sortOrder: 0,
      allowedStudentIds: ['S001', 'S002'], schedule: { recurrence: { type: 'DAILY', time: '09:00' },
        timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const instance = created.tasks[0].taskInstanceId;
    const assignments = await harness.database.query(`SELECT assignment_id, student_id, cycle_id,
      cycle_start_at, cycle_end_at FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2
      ORDER BY student_id`, [harness.tenantOneId, instance]);
    const createOperation = await harness.database.query(`SELECT payload_hash FROM operations
      WHERE tenant_id=$1 AND operation_id='create-skipped-completer'`, [harness.tenantOneId]);
    const createOperationHash = (createOperation.rows[0] as { payload_hash: string }).payload_hash;
    const s2 = assignments.rows[1] as Record<string, unknown>;
    await seedAssignmentOperation('00000000-0000-4000-8000-000000000102', HASH);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, admin_operation_id,
       admin_operation_hash, schema_version, created_at)
      VALUES ($1, 'historical-s2-completion', '2026-08-30T01:10:00.000Z', $2, 'TASK-SKIP',
       'skip', 'S002', '둘', 0, 5, 5, 'COMPLETED', NULL, $3, $4, $5, 1,
       'Asia/Seoul', 'ADMIN', $6, '00000000-0000-4000-8000-000000000102', $7,
       1, '2026-08-30T01:10:00.000Z')`,
    [harness.tenantOneId, instance, s2.cycle_id, s2.cycle_start_at, s2.cycle_end_at,
      s2.assignment_id, HASH]);
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, 's2-unassigned', 'TASK-SKIP', $2, $3, $4, $5, 1, 'Asia/Seoul',
       'S002', 'UNASSIGNED', 'ADMIN', $6, 'create-skipped-completer', $7,
       '2026-08-30T01:20:00.000Z', 1, NULL)`,
    [harness.tenantOneId, instance, s2.cycle_id, s2.cycle_start_at, s2.cycle_end_at,
      s2.assignment_id, createOperationHash]);
    await harness.database.query(`DELETE FROM task_allowed_students
      WHERE tenant_id=$1 AND task_instance_id=$2 AND student_id='S002'`,
    [harness.tenantOneId, instance]);
    const result = await createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T02:00:00.000Z') }).update({
      operationId: '00000000-0000-4000-8000-000000000013', taskId: 'TASK-SKIP',
      expectedTaskVersion: 1,
      recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1] }, timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: true });
    expect(result.assignmentEventIds).toHaveLength(1);
    expect(result.completionEventIds).toHaveLength(0);
  });

  it('preflights cardinality, duplicates, exact nested data, and UUID before transaction entry', async () => {
    const entered = vi.fn();
    const runTenantTransaction = vi.fn(async () => { entered(); throw new Error('entered'); });
    const subject = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: runTenantTransaction as never, now: () => NOW });
    const task = (taskId: string) => ({ taskId, expectedTaskVersion: 1,
      recurrence: { type: 'DAILY' as const, time: '09:00' }, timeZone: 'Asia/Seoul' as const,
      resetCompletionOnCycle: true, resetAssignmentOnCycle: true });
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000020',
      tasks: [task('TASK-001')] })).rejects.toThrow('entered');
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000021',
      tasks: Array.from({ length: 20 }, (_, index) => task(`TASK-${index}`)) }))
      .rejects.toThrow('entered');
    expect(entered).toHaveBeenCalledTimes(2);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000022',
      tasks: Array.from({ length: 21 }, (_, index) => task(`TASK-${index}`)) }))
      .rejects.toThrow(/1-20/);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000023',
      tasks: [task('TASK-001'), task('TASK-001')] })).rejects.toThrow(/duplicate/i);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000026',
      tasks: [] })).rejects.toThrow(/1-20/i);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000027',
      tasks: [{ ...task('TASK-001'), expectedTaskVersion: 0 }] })).rejects.toThrow(/version/i);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000028',
      tasks: [{ ...task('TASK-001'), expectedTaskVersion: Number.MAX_SAFE_INTEGER }] }))
      .rejects.toThrow(/version/i);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000029',
      tasks: [{ ...task('TASK-001'), extra: true } as never] })).rejects.toThrow(/task input.*malformed/i);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000024',
      tasks: [task(' TASK-001')] })).rejects.toThrow(/identity/i);
    let getterCalls = 0;
    const recurrence = { get type() { getterCalls += 1; return 'DAILY'; }, time: '09:00' };
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-000000000025',
      tasks: [{ ...task('TASK-001'), recurrence } as never] })).rejects.toThrow(/recurrence.*malformed/i);
    expect(getterCalls).toBe(0);
    await expect(subject.updateBatch({ operationId: '00000000-0000-4000-8000-00000000002A',
      tasks: [task('TASK-001')] })).rejects.toThrow(/uuid/i);
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it('commits a mixed no-op and changed batch with exact versions and one operation and audit', async () => {
    const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z') });
    for (const taskId of ['TASK-NOOP', 'TASK-CHANGE']) await admin.create({
      operationId: `create-${taskId}`, taskId, title: taskId, description: '', reward: 1,
      isActive: true, sortOrder: 0, allowedStudentIds: ['S001'], schedule: {
        recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const command = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW });
    const result = await command.updateBatch({
      operationId: '00000000-0000-4000-8000-000000000030', tasks: [{
        taskId: 'TASK-NOOP', expectedTaskVersion: 1,
        recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
      }, { taskId: 'TASK-CHANGE', expectedTaskVersion: 1,
        recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1, 3] }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: true }] });
    expect(result.tasks.map(({ taskId, changed, versionBefore, versionAfter }) =>
      ({ taskId, changed, versionBefore, versionAfter }))).toEqual([
      { taskId: 'TASK-CHANGE', changed: true, versionBefore: 1, versionAfter: 2 },
      { taskId: 'TASK-NOOP', changed: false, versionBefore: 1, versionAfter: 1 },
    ]);
    const tasks = await harness.database.query(`SELECT task_id, version::text, updated_at
      FROM tasks WHERE tenant_id=$1 AND task_id IN ('TASK-NOOP','TASK-CHANGE') ORDER BY task_id`,
    [harness.tenantOneId]);
    expect(tasks.rows).toEqual([
      { task_id: 'TASK-CHANGE', version: '2', updated_at: NOW },
      { task_id: 'TASK-NOOP', version: '1', updated_at: new Date('2026-08-30T01:00:00.000Z') },
    ]);
    expect((await harness.database.query(`SELECT operation_id FROM operations WHERE tenant_id=$1
      AND operation_id=$2`, [harness.tenantOneId, result.operationId])).rows).toHaveLength(1);
    expect((await harness.database.query(`SELECT event_id FROM audit_events WHERE tenant_id=$1
      AND operation_id=$2`, [harness.tenantOneId, result.operationId])).rows).toHaveLength(1);
  });

  it('canonicalizes weekly weekday order for no-op hashing and replay', async () => {
    const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z') });
    await admin.create({ operationId: 'create-weekday-order', taskId: 'TASK-WEEKDAYS',
      title: 'weekdays', description: '', reward: 1, isActive: true, sortOrder: 0,
      allowedStudentIds: ['S001'], schedule: {
        recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1, 3] },
        timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const command = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW });
    const operationId = '00000000-0000-4000-8000-000000000031';
    const first = await command.update({ operationId, taskId: 'TASK-WEEKDAYS',
      expectedTaskVersion: 1,
      recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [3, 1] },
      timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true });
    expect(first.changed).toBe(false);
    expect((first.schedule.recurrence as { weekdays: readonly number[] }).weekdays).toEqual([1, 3]);
    await expect(command.update({ operationId, taskId: 'TASK-WEEKDAYS', expectedTaskVersion: 1,
      recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1, 3] },
      timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true }))
      .resolves.toEqual(first);
  });

  it('treats each reset-flag-only edit as a versioned configuration boundary', async () => {
    const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z') });
    for (const taskId of ['TASK-RESET-COMPLETION', 'TASK-RESET-ASSIGNMENT']) {
      await admin.create({ operationId: `create-${taskId}`, taskId, title: taskId,
        description: '', reward: 1, isActive: true, sortOrder: 0,
        allowedStudentIds: ['S001'], schedule: {
          recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
          resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    }
    const command = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW });
    const result = await command.updateBatch({
      operationId: '00000000-0000-4000-8000-000000000032', tasks: [{
        taskId: 'TASK-RESET-COMPLETION', expectedTaskVersion: 1,
        recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: false, resetAssignmentOnCycle: true,
      }, { taskId: 'TASK-RESET-ASSIGNMENT', expectedTaskVersion: 1,
        recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: false }] });
    expect(result.tasks.map((task) => ({ taskId: task.taskId, changed: task.changed,
      versionAfter: task.versionAfter, ruleVersion: task.schedule.ruleVersion,
      completion: task.schedule.resetCompletionOnCycle,
      assignment: task.schedule.resetAssignmentOnCycle }))).toEqual([
      { taskId: 'TASK-RESET-ASSIGNMENT', changed: true, versionAfter: 2,
        ruleVersion: 2, completion: true, assignment: false },
      { taskId: 'TASK-RESET-COMPLETION', changed: true, versionAfter: 2,
        ruleVersion: 2, completion: false, assignment: true },
    ]);
  });

  it('rolls back every task, operation, and audit when one target is stale or missing', async () => {
    const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => new Date('2026-08-30T01:00:00.000Z') });
    await admin.create({ operationId: 'create-atomic', taskId: 'TASK-ATOMIC', title: 'atomic',
      description: '', reward: 1, isActive: true, sortOrder: 0, allowedStudentIds: ['S001'],
      schedule: { recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const command = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW });
    const input = (operationId: string, second: string, version = 1) => ({ operationId, tasks: [{
      taskId: 'TASK-ATOMIC', expectedTaskVersion: version,
      recurrence: { type: 'WEEKLY' as const, time: '09:00', weekdays: [1] as const },
      timeZone: 'Asia/Seoul' as const, resetCompletionOnCycle: true, resetAssignmentOnCycle: true,
    }, { taskId: second, expectedTaskVersion: 1,
      recurrence: { type: 'DAILY' as const, time: '09:00' }, timeZone: 'Asia/Seoul' as const,
      resetCompletionOnCycle: true, resetAssignmentOnCycle: true }] });
    await expect(command.updateBatch(input('00000000-0000-4000-8000-000000000040',
      'TASK-MISSING'))).rejects.toThrow(/not found/i);
    await expect(command.updateBatch({ ...input('00000000-0000-4000-8000-000000000041',
      'TASK-ATOMIC-OTHER'), tasks: [input('x', 'x', 2).tasks[0]] })).rejects.toThrow(/stale/i);
    const state = await harness.database.query(`SELECT version::text FROM tasks WHERE tenant_id=$1
      AND task_id='TASK-ATOMIC'`, [harness.tenantOneId]);
    expect(state.rows).toEqual([{ version: '1' }]);
    expect((await harness.database.query(`SELECT operation_id FROM operations WHERE tenant_id=$1
      AND operation_id IN ('00000000-0000-4000-8000-000000000040',
      '00000000-0000-4000-8000-000000000041')`, [harness.tenantOneId])).rows).toHaveLength(0);
  });

  it('canonicalizes reordered replay, locks physical identities, and deeply freezes the result', async () => {
    const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => new Date('2026-08-30T01:00:00.000Z') });
    for (const taskId of ['TASK-B', 'TASK-A']) await admin.create({ operationId: `create-${taskId}`,
      taskId, title: taskId, description: '', reward: 1, isActive: true, sortOrder: 0,
      allowedStudentIds: ['S001'], schedule: { recurrence: { type: 'DAILY', time: '09:00' },
        timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const statements: string[] = []; const dialect = new PgDialect();
    const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
        execute: async (wrapper: SQLWrapper) => { const query = dialect.sqlToQuery(wrapper.getSQL());
          statements.push(query.sql.toLowerCase().replace(/\s+/g, ' ')); return transaction.execute(wrapper); },
      } as unknown as TenantTransaction));
    const command = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => NOW });
    const task = (taskId: string) => ({ taskId, expectedTaskVersion: 1,
      recurrence: { type: 'WEEKLY' as const, time: '09:00', weekdays: [1, 3] as const },
      timeZone: 'Asia/Seoul' as const, resetCompletionOnCycle: true, resetAssignmentOnCycle: true });
    const first = await command.updateBatch({ operationId: '00000000-0000-4000-8000-000000000050',
      tasks: [task('TASK-B'), task('TASK-A')] });
    const replay = await command.updateBatch({ operationId: first.operationId,
      tasks: [task('TASK-A'), task('TASK-B')] });
    expect(replay).toEqual(first);
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay.tasks)).toBe(true);
    expect(Object.isFrozen(replay.tasks[0])).toBe(true);
    expect(Object.isFrozen(replay.tasks[0].schedule)).toBe(true);
    expect(Object.isFrozen(replay.tasks[0].schedule.recurrence)).toBe(true);
    expect(Object.isFrozen((replay.tasks[0].schedule.recurrence as { weekdays: readonly number[] }).weekdays)).toBe(true);
    expect(statements.find((statement) => statement.includes('from tasks')
      && statement.includes('for update'))).toContain('order by task_instance_id for update');
    await expect(command.updateBatch({ operationId: first.operationId,
      tasks: [task('TASK-A')] })).rejects.toThrow(/conflict/i);
  });

  it('rereads a zero-row claim winner before any task lock and fails closed on conflict', async () => {
    const statements: string[] = [];
    const winner = { operation_id: '00000000-0000-4000-8000-000000000060',
      operation_kind: 'TASK_ADMIN', payload_hash: 'f'.repeat(64), status: 'SUCCEEDED',
      result_snapshot: {}, finished_at: NOW, failure_code: null, attempt_count: '1',
      started_at: NOW, created_at: NOW, updated_at: NOW };
    let reads = 0;
    const run = async <T>(_tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      callback({ execute: async (wrapper: SQLWrapper) => {
        const query = new PgDialect().sqlToQuery(wrapper.getSQL()).sql.toLowerCase(); statements.push(query);
        if (query.includes('from operations')) return { rows: reads++ === 0 ? [] : [winner] };
        if (query.startsWith('insert into operations')) return { rows: [] };
        throw new Error('mutable domain access occurred');
      } } as unknown as TenantTransaction);
    const command = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => NOW });
    await expect(command.update({ operationId: winner.operation_id, taskId: 'TASK-001',
      expectedTaskVersion: 1, recurrence: { type: 'DAILY', time: '09:00' },
      timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true }))
      .rejects.toThrow(/conflict/i);
    expect(statements.filter((statement) => statement.includes('from operations'))).toHaveLength(2);
    expect(statements.some((statement) => statement.includes('from tasks'))).toBe(false);
  });

  it('replays a same-payload zero-row claim winner before task verification', async () => {
    const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-08-30T01:00:00.000Z') });
    await admin.create({ operationId: 'create-race-replay', taskId: 'TASK-RACE-REPLAY',
      title: 'race', description: '', reward: 1, isActive: true, sortOrder: 0,
      allowedStudentIds: ['S001'], schedule: {
        recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const input = { operationId: '00000000-0000-4000-8000-000000000061',
      taskId: 'TASK-RACE-REPLAY', expectedTaskVersion: 1,
      recurrence: { type: 'DAILY' as const, time: '09:00' },
      timeZone: 'Asia/Seoul' as const, resetCompletionOnCycle: true,
      resetAssignmentOnCycle: true };
    const first = await createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW }).update(input);
    const statements: string[] = []; let operationReads = 0;
    const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
        execute: async (wrapper: SQLWrapper) => {
          const query = new PgDialect().sqlToQuery(wrapper.getSQL()).sql.toLowerCase()
            .replace(/\s+/g, ' ');
          statements.push(query);
          if (query.includes('from operations') && operationReads++ === 0) return { rows: [] };
          if (query.startsWith('insert into operations')) return { rows: [] };
          return transaction.execute(wrapper);
        },
      } as unknown as TenantTransaction));
    const replay = await createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => NOW }).update(input);
    expect(replay).toEqual(first);
    const winnerRead = statements.findIndex((statement, index) => index > 0
      && statement.includes('from operations'));
    const taskRead = statements.findIndex((statement) => statement.includes('from tasks'));
    expect(winnerRead).toBeGreaterThan(0);
    expect(taskRead).toBeGreaterThan(winnerRead);
  });

  it.each([
    ['update RETURNING', 'title', false],
    ['pre-audit verification', 'description', false],
    ['post-terminal verification', 'reward', true],
  ])('rejects omitted task metadata corruption at %s and exactly rolls back full state',
  async (_label, stage, expectsTerminal) => {
    await createScheduleFixture('TASK-SNAPSHOT');
    await harness.database.query(`UPDATE tasks SET description='preserve me', reward=77,
      sort_order=9, padlet_board_id='AbCdEfGhIjKlMnOp' WHERE tenant_id=$1 AND task_id='TASK-SNAPSHOT'`,
    [harness.tenantOneId]);
    const before = await readFullTaskState('TASK-SNAPSHOT');
    const dialect = new PgDialect(); let snapshotRead = 0; let terminalReached = false;
    const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
        execute: async (wrapper: SQLWrapper) => {
          const query = dialect.sqlToQuery(wrapper.getSQL());
          const statement = query.sql.toLowerCase().replace(/\s+/g, ' ');
          if (statement.startsWith('update operations set status=')) terminalReached = true;
          const result = await transaction.execute(wrapper);
          const isUpdateReturning = statement.startsWith('update tasks')
            && statement.includes('set current_schedule=');
          const isSnapshot = statement.startsWith('select') && statement.includes(' from tasks ')
            && !statement.includes('for update') && statement.includes('current_schedule');
          if ((stage === 'title' && isUpdateReturning && statement.includes('title'))
            || (stage === 'description' && isSnapshot && ++snapshotRead === 1
              && statement.includes('description'))
            || (stage === 'reward' && isSnapshot && ++snapshotRead === 2
              && statement.includes('reward'))) {
            const rows = [...result.rows] as Record<string, unknown>[];
            rows[0] = { ...rows[0], [stage]: stage === 'reward' ? '78' : 'corrupted' };
            return { ...result, rows };
          }
          return result;
        },
      } as unknown as TenantTransaction));
    const operationId = `00000000-0000-4000-8000-00000000007${
      stage === 'title' ? 1 : stage === 'description' ? 2 : 3}`;
    await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => NOW }).update(
      changedScheduleInput(operationId, 'TASK-SNAPSHOT'))).rejects.toThrow(/task.*integrity/i);
    expect(terminalReached).toBe(expectsTerminal);
    expect(await readFullTaskState('TASK-SNAPSHOT')).toEqual(before);
    expect((await harness.database.query(`SELECT operation_id FROM operations
      WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, operationId])).rows)
      .toHaveLength(0);
    expect((await harness.database.query(`SELECT event_id FROM audit_events
      WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, operationId])).rows)
      .toHaveLength(0);
  });

  it('binds replay to immutable audit physical identities while tolerating later schedule state', async () => {
    const created = await createScheduleFixture('TASK-PHYSICAL');
    const operationId = '00000000-0000-4000-8000-000000000080';
    const first = await createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW }).update(
      changedScheduleInput(operationId, 'TASK-PHYSICAL'));
    const audit = await harness.database.query(`SELECT redacted_details FROM audit_events
      WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, operationId]);
    expect(audit.rows).toEqual([{ redacted_details: expect.objectContaining({ targetBindings: [{
      taskId: 'TASK-PHYSICAL', taskInstanceId: created.tasks[0].taskInstanceId,
    }] }) }]);
    await harness.database.query(`UPDATE tasks SET current_schedule=jsonb_set(current_schedule,
      '{effectiveFrom}', '"2026-09-01T00:00:00.000Z"'::jsonb), version=version+1,
      updated_at='2026-09-01T00:00:00.000Z' WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId]);
    await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date('2026-09-01T00:00:00.000Z') }).update(
      changedScheduleInput(operationId, 'TASK-PHYSICAL'))).resolves.toEqual(first);
  });

  it('tolerates a later tombstone but rejects hard-delete and recreate under the original business ID', async () => {
    const originalPhysicalId = 'physical-original';
    const initialSchedule = { ruleVersion: 1, effectiveFrom: '2026-08-30T01:00:00.000Z',
      timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' },
      resetCompletionOnCycle: true, resetAssignmentOnCycle: true };
    await harness.database.query(`INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
       current_schedule, schedule_schema_version, created_at, updated_at)
      VALUES ($1, $2, 'TASK-RECREATE', 'original', '', 1, true, 0, $3::jsonb, 1, $4, $4)`,
    [harness.tenantOneId, originalPhysicalId, JSON.stringify(initialSchedule),
      '2026-08-30T01:00:00.000Z']);
    const operationId = '00000000-0000-4000-8000-000000000081';
    const input = changedScheduleInput(operationId, 'TASK-RECREATE');
    const commands = createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, now: () => NOW });
    const first = await commands.update(input);
    await harness.database.query(`UPDATE tasks SET is_active=false, deleted_at=$3, updated_at=$3
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, originalPhysicalId, '2026-09-01T00:00:00.000Z']);
    await expect(commands.update(input)).resolves.toEqual(first);
    await harness.database.query(`DELETE FROM tasks WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, originalPhysicalId]);
    const replacementPhysicalId = 'physical-replacement';
    await harness.database.query(`INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
       current_schedule, schedule_schema_version, created_at, updated_at)
      VALUES ($1, $2, 'TASK-RECREATE', 'replacement', '', 1, true, 0, $3::jsonb, 1, $4, $4)`,
    [harness.tenantOneId, replacementPhysicalId, JSON.stringify(initialSchedule),
      '2026-09-01T00:00:00.000Z']);
    expect(replacementPhysicalId).not.toBe(originalPhysicalId);
    await expect(commands.update(input)).rejects.toThrow(/physical identity.*integrity/i);
  });

  it.each(['wrong', 'extra', 'boxed', 'getter'] as const)(
    'rejects %s raw audit verification evidence without invoking accessors', async (variant) => {
      await createScheduleFixture(`TASK-AUDIT-${variant}`);
      const operationId = `00000000-0000-4000-8000-00000000008${
        variant === 'wrong' ? 2 : variant === 'extra' ? 3 : variant === 'boxed' ? 4 : 5}`;
      let getterCalls = 0; const dialect = new PgDialect();
      const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
        harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
          execute: async (wrapper: SQLWrapper) => {
            const query = dialect.sqlToQuery(wrapper.getSQL());
            const statement = query.sql.toLowerCase().replace(/\s+/g, ' ');
            const result = await transaction.execute(wrapper);
            if (!statement.startsWith('select') || !statement.includes(' from audit_events ')) return result;
            const base = { ...(result.rows[0] as Record<string, unknown>) };
            if (variant === 'wrong') base.event_id = 'wrong-audit-id';
            if (variant === 'extra') base.extra = true;
            if (variant === 'boxed') return { ...result, rows: [Object.assign(Object.create(null), base)] };
            if (variant === 'getter') Object.defineProperty(base, 'event_id', { enumerable: true,
              get() { getterCalls += 1; return 'wrong-audit-id'; } });
            return { ...result, rows: [base] };
          },
        } as unknown as TenantTransaction));
      await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
        runTenantTransaction: run, now: () => NOW }).update(
        changedScheduleInput(operationId, `TASK-AUDIT-${variant}`))).rejects.toThrow(/audit.*integrity|audit.*malformed/i);
      expect(getterCalls).toBe(0);
    });

  it.each(['sparse', 'getter'] as const)(
    'rejects %s initial task rowsets without invoking accessors', async (mode) => {
      const taskId = `TASK-ROWSET-${mode}`;
      await createScheduleFixture(taskId);
      let getterCalls = 0; const dialect = new PgDialect(); let injected = false;
      const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
        harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
          execute: async (wrapper: SQLWrapper) => {
            const query = dialect.sqlToQuery(wrapper.getSQL());
            const statement = query.sql.toLowerCase().replace(/\s+/g, ' ');
            const result = await transaction.execute(wrapper);
            if (injected || !statement.startsWith('select') || !statement.includes(' from tasks ')
              || !statement.includes(' for update')) return result;
            injected = true;
            return { ...result, rows: malformedDenseRows(result.rows, mode, () => { getterCalls += 1; }) };
          },
        } as unknown as TenantTransaction));
      const operationId = mode === 'sparse' ? '00000000-0000-4000-8000-000000000086'
        : '00000000-0000-4000-8000-000000000087';
      await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
        runTenantTransaction: run, now: () => NOW }).update(
        changedScheduleInput(operationId, taskId))).rejects.toThrow(/rowset.*malformed|target.*not found/i);
      expect(injected).toBe(true);
      expect(getterCalls).toBe(0);
    });

  it.each([
    ['pre-audit', 'mirror', 'created_at', false],
    ['pre-audit', 'assignment', 'task_id_snapshot', false],
    ['pre-audit', 'completion', 'task_name_snapshot', false],
    ['pre-audit', 'account', 'balance', false],
    ['pre-audit', 'transaction', 'operator_snapshot', false],
    ['pre-audit', 'new-assignment', 'task_id_snapshot', false],
    ['pre-audit', 'new-completion', 'balance_after', false],
    ['post-terminal', 'mirror', 'created_at', true],
    ['post-terminal', 'assignment', 'task_id_snapshot', true],
    ['post-terminal', 'completion', 'task_name_snapshot', true],
    ['post-terminal', 'account', 'balance', true],
    ['post-terminal', 'transaction', 'operator_snapshot', true],
    ['post-terminal', 'new-assignment', 'task_id_snapshot', true],
    ['post-terminal', 'new-completion', 'balance_after', true],
  ] as const)('rejects %s connected-state %s faults and exactly rolls back',
  async (stage, relation, field, expectsTerminal) => {
    const taskId = `TASK-CONNECTED-${stage}-${relation}`;
    await createConnectedScheduleFixture(taskId);
    const suffix = `${stage}-${relation}`.split('').reduce((sum, value) => sum + value.charCodeAt(0), 0);
    const operationId = `00000000-0000-4000-8000-${String(900000000000 + suffix).padStart(12, '0')}`;
    const before = await readConnectedScheduleState(taskId, operationId);
    const dialect = new PgDialect(); let connectedRead = 0; let injected = false;
    let terminalReached = false;
    const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
        execute: async (wrapper: SQLWrapper) => {
          const query = dialect.sqlToQuery(wrapper.getSQL());
          const statement = query.sql.toLowerCase().replace(/\s+/g, ' ');
          if (statement.startsWith('update operations set status=')) terminalReached = true;
          const result = await transaction.execute(wrapper);
          const connected = relation === 'mirror'
            ? statement.includes(' from task_allowed_students ') && statement.includes('task_instance_id in')
              && statement.includes('tenant_id::text as tenant_id')
            : relation === 'assignment' || relation === 'new-assignment'
              ? statement.includes(' from task_assignments ') && statement.includes('task_instance_id in')
                && statement.includes('tenant_id::text as tenant_id')
              : relation === 'completion' || relation === 'new-completion'
                ? statement.includes(' from task_completions ') && statement.includes('task_instance_id in')
                  && statement.includes('tenant_id::text as tenant_id')
                : relation === 'account'
                  ? statement.includes(' from accounts ') && statement.includes('student_id in')
                  : statement.includes(' from transactions ') && statement.includes('with recursive')
                    && statement.includes('tenant_id::text as tenant_id');
          if (connected && ++connectedRead === (stage === 'pre-audit' ? 2 : 3)) {
            const rows = [...result.rows] as Record<string, unknown>[];
            const rowIndex = relation.startsWith('new-')
              ? rows.findIndex((row) => row.source === 'CARRY_FORWARD') : 0;
            if (rowIndex < 0) throw new Error('Expected carried row was not reached.');
            rows[rowIndex] = { ...rows[rowIndex], [field]: field === 'created_at'
              ? new Date('2026-08-30T01:00:00.001Z') : field === 'balance' ? '2' : 'corrupted' };
            injected = true;
            return { ...result, rows };
          }
          return result;
        },
      } as unknown as TenantTransaction));
    await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => new Date('2026-08-30T02:00:00.000Z') }).update(
      changedScheduleInput(operationId, taskId))).rejects.toThrow(/connected.*integrity/i);
    expect(injected).toBe(true);
    expect(terminalReached).toBe(expectsTerminal);
    expect(await readConnectedScheduleState(taskId, operationId)).toEqual(before);
  });

  it('rejects a missing transaction-backed account from connected closure', async () => {
    const taskId = 'TASK-CONNECTED-MISSING-ACCOUNT';
    await createConnectedScheduleFixture(taskId);
    const operationId = '00000000-0000-4000-8000-000000000089';
    const before = await readConnectedScheduleState(taskId, operationId);
    const dialect = new PgDialect(); let injected = 0;
    const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
        execute: async (wrapper: SQLWrapper) => {
          const query = dialect.sqlToQuery(wrapper.getSQL());
          const statement = query.sql.toLowerCase().replace(/\s+/g, ' ');
          const result = await transaction.execute(wrapper);
          if (statement.includes(' from accounts ')
            && statement.includes('student_id in')) { injected += 1; return { ...result, rows: [] }; }
          return result;
        },
      } as unknown as TenantTransaction));
    await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => new Date('2026-08-30T02:00:00.000Z') }).update(
      changedScheduleInput(operationId, taskId))).rejects.toThrow(/connected.*integrity/i);
    expect(injected).toBe(1);
    expect(await readConnectedScheduleState(taskId, operationId)).toEqual(before);
  });

  it('rejects a claim RETURNING index getter without invoking it', async () => {
    const taskId = 'TASK-CLAIM-GETTER'; await createScheduleFixture(taskId);
    const operationId = '00000000-0000-4000-8000-000000000088';
    const dialect = new PgDialect(); let getterCalls = 0; let injected = false;
    const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
        execute: async (wrapper: SQLWrapper) => {
          const query = dialect.sqlToQuery(wrapper.getSQL());
          const statement = query.sql.toLowerCase().replace(/\s+/g, ' ');
          const result = await transaction.execute(wrapper);
          if (!injected && statement.startsWith('insert into operations')) {
            injected = true;
            return { ...result, rows: malformedDenseRows(result.rows, 'getter', () => { getterCalls += 1; }) };
          }
          return result;
        },
      } as unknown as TenantTransaction));
    await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => NOW }).update(changedScheduleInput(operationId, taskId)))
      .rejects.toThrow(/claim rowset.*malformed/i);
    expect(injected).toBe(true); expect(getterCalls).toBe(0);
    expect((await harness.database.query(`SELECT operation_id FROM operations
      WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, operationId])).rows).toEqual([]);
  });

  it('uses the same set-wise SQL categories for one and twenty changed schedule targets', async () => {
    const oneId = 'TASK-COUNT-ONE'; await createScheduleFixture(oneId);
    const twentyIds = Array.from({ length: 20 }, (_, index) => `TASK-COUNT-${String(index).padStart(2, '0')}`);
    for (const taskId of twentyIds) await createScheduleFixture(taskId);
    const dialect = new PgDialect();
    const execute = async (operationId: string, taskIds: readonly string[]) => {
      const statements: string[] = [];
      const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
        harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
          execute: async (wrapper: SQLWrapper) => {
            const query = dialect.sqlToQuery(wrapper.getSQL());
            statements.push(query.sql.toLowerCase().replace(/\s+/g, ' ').trim());
            return transaction.execute(wrapper);
          },
        } as unknown as TenantTransaction));
      await createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
        runTenantTransaction: run, now: () => NOW }).updateBatch({ operationId,
        tasks: taskIds.map((taskId) => { const single = changedScheduleInput(operationId, taskId);
          return { taskId: single.taskId, expectedTaskVersion: single.expectedTaskVersion,
            recurrence: single.recurrence, timeZone: single.timeZone,
            resetCompletionOnCycle: single.resetCompletionOnCycle,
            resetAssignmentOnCycle: single.resetAssignmentOnCycle }; }) });
      return statements;
    };
    const classify = (statement: string) => {
      const relation = ['operations', 'tasks', 'task_allowed_students', 'task_assignments',
        'task_completions', 'accounts', 'transactions', 'audit_events']
        .find((table) => statement.includes(` ${table} `) || statement.includes(` ${table}\n`)) ?? 'other';
      return `${statement.split(' ')[0]}:${relation}`;
    };
    const one = await execute('00000000-0000-4000-8000-000000000091', [oneId]);
    const twenty = await execute('00000000-0000-4000-8000-000000000092', twentyIds);
    expect(twenty.map(classify)).toEqual(one.map(classify));
    expect(twenty.some((statement) => /from task_(assignments|completions)[^;]*task_instance_id\s*=\s*\$/i
      .test(statement))).toBe(false);
  });

  it('rolls back both targets when later set-wise assignment RETURNING evidence is corrupted', async () => {
    const taskIds = ['TASK-LATER-A', 'TASK-LATER-B'] as const;
    for (const taskId of taskIds) await createScheduleFixture(taskId, '2026-08-30T01:00:00.000Z');
    const before = await Promise.all(taskIds.map(readFullTaskState));
    const operationId = '00000000-0000-4000-8000-000000000093';
    const dialect = new PgDialect(); let injected = false;
    const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (transaction) => callback({ ...transaction,
        execute: async (wrapper: SQLWrapper) => {
          const query = dialect.sqlToQuery(wrapper.getSQL());
          const statement = query.sql.toLowerCase().replace(/\s+/g, ' ').trim();
          const result = await transaction.execute(wrapper);
          if (!injected && statement.startsWith('insert into task_assignments')) {
            injected = true; const rows = result.rows.map((row) => ({ ...(row as Record<string, unknown>) }));
            (rows.at(-1) as Record<string, unknown>).assignment_id = 'wrong-later-assignment';
            return { ...result, rows };
          }
          return result;
        },
      } as unknown as TenantTransaction));
    const taskInput = (taskId: string) => { const single = changedScheduleInput(operationId, taskId);
      return { taskId: single.taskId, expectedTaskVersion: single.expectedTaskVersion,
        recurrence: single.recurrence, timeZone: single.timeZone,
        resetCompletionOnCycle: single.resetCompletionOnCycle,
        resetAssignmentOnCycle: single.resetAssignmentOnCycle }; };
    await expect(createDatabaseTaskScheduleCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: run, now: () => new Date('2026-08-30T02:00:00.000Z') }).updateBatch({ operationId,
      tasks: taskIds.map(taskInput) })).rejects.toThrow(/assignment insert.*integrity/i);
    expect(injected).toBe(true);
    expect(await Promise.all(taskIds.map(readFullTaskState))).toEqual(before);
    expect((await harness.database.query(`SELECT operation_id FROM operations
      WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, operationId])).rows).toEqual([]);
  });
});
