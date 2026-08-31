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

async function materializeWithAssignmentRows(rows: unknown) {
  const dialect = new PgDialect();
  let assignmentRead = 0;
  let insertedAssignment: Record<string, unknown> | undefined;
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
    if (statement.includes('from task_completions')) return { rows: [] };
    if (statement.startsWith('insert into task_assignments')) {
      const assignmentId = query.params[1] as string;
      insertedAssignment = assignmentRow({ assignment_id: assignmentId, event_sequence: '5',
        source: 'CARRY_FORWARD', previous_assignment_id: 'assignment-4',
        cycle_id: CHAIN_NEW_CYCLE.cycleId, cycle_start_at: new Date(CHAIN_NEW_CYCLE.startsAt),
        cycle_end_at: new Date(CHAIN_NEW_CYCLE.endsAt), rule_version: 3,
        created_at: CHAIN_NOW });
      return { rows: [{ assignment_id: assignmentId }] };
    }
    throw new Error(`unexpected statement: ${statement}`);
  } } as unknown as TenantTransaction;
  return materializeTaskConfigurationBoundaryCycleInternal({ tx, tenantId: 'tenant',
    taskId: 'TASK-CHAIN', taskInstanceId: INSTANCE, oldCycle: CHAIN_CYCLE_TWO,
    oldRuleVersion: 2, newCycle: CHAIN_NEW_CYCLE, newRuleVersion: 3,
    timeZone: 'Asia/Seoul', now: CHAIN_NOW });
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
    await harness.database.query(
      `INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
         task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
         balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
         rule_version, timezone, source, assignment_id, schema_version, created_at)
       SELECT tenant_id, 'schedule-red-completion', $3, task_instance_id, task_id_snapshot,
         '과제', student_id, '하나', 0, 0, 0, 'COMPLETED', NULL, cycle_id,
         cycle_start_at, cycle_end_at, rule_version, timezone, 'CARRY_FORWARD',
         assignment_id, 1, $3
       FROM task_assignments
       WHERE tenant_id=$1 AND task_instance_id=$2
       ORDER BY event_sequence DESC LIMIT 1`,
      [harness.tenantOneId, taskInstanceId, '2026-08-30T01:00:00.000Z'],
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
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, schema_version, created_at)
      VALUES ($1, 'historical-s2-completion', '2026-08-30T01:10:00.000Z', $2, 'TASK-SKIP',
       'skip', 'S002', '둘', 0, 5, 5, 'COMPLETED', NULL, $3, $4, $5, 1,
       'Asia/Seoul', 'CARRY_FORWARD', $6, 1, '2026-08-30T01:10:00.000Z')`,
    [harness.tenantOneId, instance, s2.cycle_id, s2.cycle_start_at, s2.cycle_end_at,
      s2.assignment_id]);
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
});
