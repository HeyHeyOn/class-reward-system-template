import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseTaskAdminCommands } from './taskAdminCommands';
import { createDatabaseTaskScheduleCommands } from './taskScheduleCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-31T01:00:00.000Z');
let harness: PgliteDatabaseHarness;

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

    const commands = createDatabaseTaskScheduleCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => NOW,
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
