import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseTaskAdminCommands } from './taskAdminCommands';
import { createDatabaseTaskAssignmentCommand } from './taskAssignmentCommands';
import {
  createDatabaseTaskAssignmentBatchCommand,
  createTaskAssignmentBatchPayloadHash,
  groupTaskAssignmentBatchEvidence,
} from './taskAssignmentBatchCommands';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-31T01:00:00.000Z');
const OPERATION_ID = 'abcdef00-0000-4000-8000-000000000101';
let harness: PgliteDatabaseHarness;

const input = () => ({
  operationId: OPERATION_ID,
  targets: [{
    taskId: 'TASK-002',
    operations: [{ studentId: 'S002', assigned: false, source: 'ADMIN' as const }],
  }, {
    taskId: 'TASK-001',
    operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' as const }],
  }],
});

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await harness.database.exec(await readFile(resolve(process.cwd(),
    'src/server/db/migrations/0010_task_admin_invariants.sql'), 'utf8'));
  for (const tenantId of [harness.tenantOneId, harness.tenantTwoId]) {
    await harness.database.query(`INSERT INTO students
      (tenant_id, student_id, name, status, created_at, updated_at)
      VALUES ($1, 'S001', '하나', 'ACTIVE', $2, $2),
             ($1, 'S002', '둘', 'ACTIVE', $2, $2),
             ($1, 'S003', '셋', 'INACTIVE', $2, $2)`, [tenantId, NOW.toISOString()]);
  }
  const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => new Date('2026-08-30T01:00:00.000Z') });
  for (const [taskId, sortOrder] of [['TASK-001', 1], ['TASK-002', 2]] as const) {
    await admin.create({ operationId: `seed-${taskId}`, taskId, title: taskId, description: '',
      reward: 100, isActive: true, sortOrder, allowedStudentIds: [],
      schedule: { recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: true, resetAssignmentOnCycle: false } });
  }
});
afterEach(async () => harness.close());

const command = (tenantId = harness.tenantOneId) => createDatabaseTaskAssignmentBatchCommand({
  tenantId, runTenantTransaction: harness.runTenantTransaction, now: () => NOW,
});

const singleton = (now: Date) => createDatabaseTaskAssignmentCommand({
  tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction, now: () => now,
});

function observingRunner(
  observe: (query: { sql: string; params: unknown[] }, rows: unknown[]) => unknown[] = (_query, rows) => rows,
) {
  const dialect = new PgDialect();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const run = async <T>(tenantId: string, callback: (transaction: TenantTransaction) => Promise<T>) =>
    harness.runTenantTransaction(tenantId, async (transaction) => {
      const execute = async (wrapper: SQLWrapper) => {
        const compiled = dialect.sqlToQuery(wrapper.getSQL());
        const query = { ...compiled, sql: compiled.sql.toLowerCase() };
        queries.push(query);
        const result = await transaction.execute(wrapper);
        return { ...result, rows: observe(query, [...result.rows]) };
      };
      return callback({ ...transaction, execute } as unknown as TenantTransaction);
    });
  return { queries, run };
}

async function assignments() {
  return (await harness.database.query(`SELECT assignment_id, event_sequence::text, task_id_snapshot,
    task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
    event_type, source, previous_assignment_id, admin_operation_id, admin_operation_hash,
    created_at, schema_version, note FROM task_assignments WHERE tenant_id=$1
    ORDER BY event_sequence`, [harness.tenantOneId])).rows as Record<string, unknown>[];
}

async function batchState(operationId: string) {
  const [operation, mirrors, history, audit, completions] = await Promise.all([
    harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, operationId]),
    harness.database.query(`SELECT * FROM task_allowed_students WHERE tenant_id=$1 ORDER BY task_instance_id, student_id`,
      [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM task_assignments WHERE tenant_id=$1 ORDER BY event_sequence`,
      [harness.tenantOneId]),
    harness.database.query(`SELECT * FROM audit_events WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, operationId]),
    harness.database.query(`SELECT * FROM task_completions WHERE tenant_id=$1 ORDER BY event_sequence`,
      [harness.tenantOneId]),
  ]);
  return { operation: operation.rows, mirrors: mirrors.rows, history: history.rows,
    audit: audit.rows, completions: completions.rows };
}

async function seedLegacyMirror(studentId = 'S001') {
  const task = await harness.database.query<{ task_instance_id: string }>(
    `SELECT task_instance_id FROM tasks WHERE tenant_id=$1 AND task_id='TASK-001'`,
    [harness.tenantOneId]);
  await harness.database.query(`INSERT INTO task_allowed_students
    (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, $3, $4)`,
  [harness.tenantOneId, task.rows[0].task_instance_id, studentId, '2026-08-30T01:00:00.000Z']);
}

async function insertCompletionFixture(assignment: Record<string, unknown>) {
  await harness.database.query(`INSERT INTO task_completions
    (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
     task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
     balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
     rule_version, timezone, source, assignment_id, operation_id, operation_hash,
     admin_operation_id, admin_operation_hash, schema_version, created_at)
    VALUES ($1, 'fixture:completion', $2, $3, $4, $4, $5, $5, 100, 0, 100, 'COMPLETED', NULL,
      $6, $7, $8, $9, 'Asia/Seoul', 'BANK', $10, 'completion-operation', $11,
      NULL, NULL, 1, $2)`, [harness.tenantOneId, '2026-08-31T02:30:00.000Z',
    assignment.task_instance_id, assignment.task_id_snapshot, assignment.student_id,
    assignment.cycle_id, assignment.cycle_start_at, assignment.cycle_end_at,
    assignment.rule_version, assignment.assignment_id, 'c'.repeat(64)]);
}

function resultHash(result: unknown) {
  return createHash('sha256').update(JSON.stringify(result), 'utf8').digest('hex');
}

function classifyBatchEvidenceQueries(queries: readonly { sql: string }[]) {
  const normalized = queries.map((query) => query.sql.replace(/\s+/g, ' ').trim());
  const table = (statement: string) => ['task_allowed_students', 'task_assignments', 'task_completions']
    .find((name) => statement.includes(`from ${name}`));
  const tableStatements = normalized.map((statement, index) => ({ statement, index, table: table(statement) }))
    .filter((query): query is { statement: string; index: number; table: string } => query.table !== undefined);
  const mutations = tableStatements.filter((query) => !query.statement.startsWith('select '));
  const evidence = tableStatements.filter((query) => query.statement.startsWith('select ')
    && (query.table === 'task_allowed_students' || query.statement.includes('task_instance_id in (')));
  const planning = evidence.filter((query) => query.statement.includes('for update'));
  const completeStarts = evidence.filter((query) => query.table === 'task_allowed_students'
    && !query.statement.includes('for update'));
  const complete = completeStarts.flatMap((start) => evidence.filter((query) =>
    query.index >= start.index && query.index <= start.index + 2));
  const completeIndexes = new Set(complete.map((query) => query.index));
  const replay = evidence.filter((query) => !query.statement.includes('for update')
    && !completeIndexes.has(query.index));
  return { planning, complete, replay, mutations };
}

describe('database desired task-assignment batch command', () => {
  it('fails the transition point-read on a different exact row and rolls back earlier pairs', async () => {
    const operationId = 'abcdef00-0000-4000-8000-000000000201';
    const before = await batchState(operationId);
    let transitionWrites = 0;
    let pointReads = 0;
    let firstTransitionRow: unknown;
    const observed = observingRunner((query, rows) => {
      if (query.sql.startsWith('insert into task_assignments')) {
        transitionWrites += 1;
      }
      if (query.sql.includes('from task_assignments') && query.sql.includes('assignment_id=')
        && rows.length === 1) {
        pointReads += 1;
        if (pointReads === 1) firstTransitionRow = rows[0];
        if (pointReads === 2) return [firstTransitionRow];
      }
      return rows;
    });
    const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: observed.run, now: () => NOW });

    await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
      { studentId: 'S001', assigned: true, source: 'ADMIN' },
      { studentId: 'S002', assigned: true, source: 'ADMIN' },
    ] }] })).rejects.toThrow(/event read.*integrity/i);
    expect(transitionWrites).toBe(2);
    expect(pointReads).toBe(2);
    expect(await batchState(operationId)).toEqual(before);
  });

  it('rereads the exact race winner before domain access and applies replay/conflict semantics', async () => {
    const desired = { operationId: 'abcdef00-0000-4000-8000-000000000202', targets: [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' as const }],
    }] };
    const winner = await command().execute(desired);
    let operationReads = 0;
    const raced = observingRunner((query, rows) => {
      if (query.sql.includes('from operations')) {
        operationReads += 1;
        if (operationReads === 1) return [];
      }
      return rows;
    });
    const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: raced.run, now: () => NOW });
    await expect(subject.execute(desired)).resolves.toEqual(winner);
    const claim = raced.queries.findIndex((query) => query.sql.startsWith('insert into operations'));
    const reread = raced.queries.findIndex((query, index) => index > claim && query.sql.includes('from operations'));
    const domain = raced.queries.findIndex((query) => query.sql.includes('from tasks')
      || query.sql.includes('from students') || query.sql.includes('from task_assignments'));
    expect(operationReads).toBe(2);
    expect(claim).toBeGreaterThan(0);
    expect(reread).toBeGreaterThan(claim);
    expect(domain).toBeGreaterThan(reread);
    await expect(subject.execute({ ...desired, targets: [{ ...desired.targets[0], operations: [
      { studentId: 'S001', assigned: false, source: 'ADMIN' as const },
    ] }] })).rejects.toThrow(/conflict/i);
  });

  it('fails a race whose exact winner disappears without any domain access or residue', async () => {
    const desired = { operationId: 'abcdef00-0000-4000-8000-000000000203', targets: [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' as const }],
    }] };
    const before = await batchState(desired.operationId);
    let operationReads = 0;
    const raced = observingRunner((query, rows) => {
      if (query.sql.includes('from operations')) { operationReads += 1; return []; }
      if (query.sql.startsWith('insert into operations')) return [];
      return rows;
    });
    const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: raced.run, now: () => NOW });
    await expect(subject.execute(desired)).rejects.toThrow(/claim integrity/i);
    expect(operationReads).toBe(2);
    expect(raced.queries.some((query) => query.sql.includes('from tasks')
      || query.sql.includes('from students') || query.sql.includes('from task_assignments'))).toBe(false);
    expect(await batchState(desired.operationId)).toEqual(before);
  });

  it.each([
    ['operation claim extra key', (sql: string) => sql.startsWith('insert into operations'),
      (rows: unknown[]) => [{ ...(rows[0] as object), extra: true }]],
    ['mirror insert wrong timestamp', (sql: string) => sql.startsWith('insert into task_allowed_students'),
      (rows: unknown[]) => [{ ...(rows[0] as object), created_at: new Date(0) }]],
    ['transition insert zero rows', (sql: string) => sql.startsWith('insert into task_assignments'),
      () => []],
    ['transition insert duplicate rows', (sql: string) => sql.startsWith('insert into task_assignments'),
      (rows: unknown[]) => [rows[0], rows[0]]],
    ['terminal update wrong operation', (sql: string) => sql.startsWith('update operations'),
      () => [{ operation_id: 'wrong-operation' }]],
    ['terminal update duplicate rows', (sql: string) => sql.startsWith('update operations'),
      (rows: unknown[]) => [rows[0], rows[0]]],
  ] as const)('fails closed at %s and rolls back every write', async (label, matches, corrupt) => {
    const operationId = `abcdef00-0000-4000-8000-${createHash('sha256').update(label)
      .digest('hex').slice(0, 12)}`;
    const before = await batchState(operationId);
    let reached = 0;
    const injected = observingRunner((query, rows) => {
      if (matches(query.sql)) { reached += 1; return corrupt(rows); }
      return rows;
    });
    const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: injected.run, now: () => NOW });
    await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
      { studentId: 'S001', assigned: true, source: 'ADMIN' },
    ] }] })).rejects.toThrow(/integrity|malformed/i);
    expect(reached).toBe(1);
    expect(await batchState(operationId)).toEqual(before);
  });

  it('rejects a getter-bearing RETURNING row without invoking the getter and rolls back', async () => {
    const operationId = 'abcdef00-0000-4000-8000-000000000210';
    const before = await batchState(operationId);
    let hooks = 0;
    const injected = observingRunner((query, rows) => {
      if (!query.sql.startsWith('insert into operations')) return rows;
      const row = {};
      Object.defineProperty(row, 'operation_id', { enumerable: true,
        get() { hooks += 1; return operationId; } });
      return [row];
    });
    const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: injected.run, now: () => NOW });
    await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
      { studentId: 'S001', assigned: true, source: 'ADMIN' },
    ] }] })).rejects.toThrow(/returning evidence.*malformed/i);
    expect(hooks).toBe(0);
    expect(await batchState(operationId)).toEqual(before);
  });

  it.each([
    ['materialization RETURNING wrong identity', (query: { sql: string }, rows: unknown[], write: number) =>
      query.sql.startsWith('insert into task_assignments') && write === 1
        ? [{ assignment_id: 'wrong-materialization' }] : rows],
    ['materialization point-read missing', (query: { sql: string }, rows: unknown[], write: number) =>
      query.sql.includes('from task_assignments') && query.sql.includes('assignment_id=') && write === 1
        ? [] : rows],
    ['mirror DELETE duplicate RETURNING', (query: { sql: string }, rows: unknown[]) =>
      query.sql.startsWith('delete from task_allowed_students') ? [rows[0], rows[0]] : rows],
  ] as const)('fails the reached %s boundary and restores legacy evidence', async (label, corrupt) => {
    await seedLegacyMirror();
    const operationId = `abcdef00-0000-4000-8000-${createHash('sha256').update(label)
      .digest('hex').slice(0, 12)}`;
    const before = await batchState(operationId);
    let assignmentWrites = 0;
    let changed = 0;
    const injected = observingRunner((query, rows) => {
      if (query.sql.startsWith('insert into task_assignments')) assignmentWrites += 1;
      const result = corrupt(query, rows, assignmentWrites);
      if (result !== rows) changed += 1;
      return result;
    });
    const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: injected.run, now: () => NOW });
    await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
      { studentId: 'S001', assigned: false, source: 'ADMIN' },
    ] }] })).rejects.toThrow(/integrity/i);
    expect(assignmentWrites).toBeGreaterThanOrEqual(1);
    expect(changed).toBe(1);
    expect(await batchState(operationId)).toEqual(before);
  });

  it.each([
    ['malformed result snapshot', (rows: unknown[]) => [{ ...(rows[0] as object),
      result_snapshot: { malformed: true } }]],
    ['wrong operation identity', (rows: unknown[]) => [{ ...(rows[0] as object),
      operation_id: 'wrong-operation' }]],
    ['duplicate operation rows', (rows: unknown[]) => [rows[0], rows[0]]],
  ] as const)('rejects final stored operation %s before commit and rolls everything back',
    async (label, corrupt) => {
      const operationId = `abcdef00-0000-4000-8000-${createHash('sha256').update(`stored-${label}`)
        .digest('hex').slice(0, 12)}`;
      const before = await batchState(operationId);
      let operationReads = 0;
      const injected = observingRunner((query, rows) => {
        if (!query.sql.includes('from operations')) return rows;
        operationReads += 1;
        return operationReads === 2 && rows.length === 1 ? corrupt(rows) : rows;
      });
      const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
        runTenantTransaction: injected.run, now: () => NOW });
      await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
      ] }] })).rejects.toThrow(/operation.*integrity|stored result.*(integrity|malformed)/i);
      expect(operationReads).toBe(2);
      expect(injected.queries.some((query) => query.sql.startsWith('update operations'))).toBe(true);
      expect(await batchState(operationId)).toEqual(before);
    });

  it.each([
    ['missing', () => []],
    ['duplicate', (rows: unknown[]) => [rows[0], rows[0]]],
    ['wrong identity', (rows: unknown[]) => [{ ...(rows[0] as object), assignment_id: 'wrong' }]],
  ] as const)('fails a %s transition readback and rolls back', async (label, corrupt) => {
    const operationId = `abcdef00-0000-4000-8000-${createHash('sha256').update(`read-${label}`)
      .digest('hex').slice(0, 12)}`;
    const before = await batchState(operationId);
    let reached = 0;
    const injected = observingRunner((query, rows) => {
      if (query.sql.includes('from task_assignments') && query.sql.includes('assignment_id=')) {
        reached += 1; return corrupt(rows);
      }
      return rows;
    });
    const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: injected.run, now: () => NOW });
    await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
      { studentId: 'S001', assigned: true, source: 'ADMIN' },
    ] }] })).rejects.toThrow(/event read.*integrity/i);
    expect(reached).toBe(1);
    expect(await batchState(operationId)).toEqual(before);
  });

  it.each(['task_allowed_students', 'task_assignments', 'task_completions'] as const)(
    'detects pre-audit and post-terminal %s evidence mutations with full rollback', async (table) => {
      for (const phase of [1, 2]) {
        const operationId = `abcdef00-0000-4000-8000-${String(400 + phase
          + ['task_allowed_students', 'task_assignments', 'task_completions'].indexOf(table) * 10).padStart(12, '0')}`;
        const before = await batchState(operationId);
        let completeReads = 0;
        let reached = 0;
        const injected = observingRunner((query, rows) => {
          if (query.sql.startsWith('select ') && query.sql.includes(`from ${table}`)
            && !query.sql.includes('for update') && !query.sql.includes('assignment_id=')) {
            completeReads += 1;
            if (completeReads === phase) {
              reached += 1;
              if (table === 'task_allowed_students') return [];
              if (table === 'task_assignments') return rows.length ? rows.slice(0, -1) : [{ forged: true }];
              return [{ forged: true }];
            }
          }
          return rows;
        });
        const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
          runTenantTransaction: injected.run, now: () => NOW });
        await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
          { studentId: 'S001', assigned: true, source: 'ADMIN' },
        ] }] })).rejects.toThrow(/integrity|malformed/i);
        expect(reached).toBe(1);
        expect(await batchState(operationId)).toEqual(before);
      }
    });

  it.each([
    ['missing audit readback', (sql: string) => sql.includes('from audit_events')
      && sql.includes('redacted_details='), () => [], 1],
    ['duplicate audit rows', (sql: string) => sql.includes('from audit_events')
      && sql.includes('redacted_details='), (rows: unknown[]) => [rows[0], rows[0]], 1],
    ['post-terminal audit set mutation', (sql: string) => sql.includes('select event_id from audit_events')
      && !sql.includes('redacted_details='), (rows: unknown[]) => [rows[0], rows[0]], 2],
  ] as const)('detects %s and rolls back domain, history, operation, and audit',
    async (label, matches, corrupt, targetRead) => {
      const operationId = `abcdef00-0000-4000-8000-${createHash('sha256').update(`audit-${label}`)
        .digest('hex').slice(0, 12)}`;
      const before = await batchState(operationId);
      let matchingReads = 0;
      const injected = observingRunner((query, rows) => {
        if (matches(query.sql)) {
          matchingReads += 1;
          if (matchingReads === targetRead) return corrupt(rows);
        }
        return rows;
      });
      const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
        runTenantTransaction: injected.run, now: () => NOW });
      await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
      ] }] })).rejects.toThrow(/audit.*integrity|operation audit integrity/i);
      expect(matchingReads).toBe(targetRead);
      expect(injected.queries.some((query) => query.sql.startsWith('update operations')))
        .toBe(targetRead === 2);
      expect(await batchState(operationId)).toEqual(before);
    });

  it('rejects unsafe nested schedule evidence without invoking getters and rolls back', async () => {
    for (const [index, shape] of ['getter', 'prototype'].entries()) {
      const operationId = `abcdef00-0000-4000-8000-${String(220 + index).padStart(12, '0')}`;
      const before = await batchState(operationId);
      let hooks = 0;
      let reached = 0;
      const injected = observingRunner((query, rows) => {
        if (!query.sql.includes('from tasks') || !query.sql.includes('for update') || rows.length === 0) return rows;
        reached += 1;
        const raw = rows[0] as Record<string, unknown>;
        const original = raw.current_schedule as Record<string, unknown>;
        const schedule = shape === 'getter'
          ? { ...original }
          : Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, original);
        if (shape === 'getter') Object.defineProperty(schedule, 'ruleVersion', { enumerable: true,
          get() { hooks += 1; return original.ruleVersion; } });
        return [{ ...raw, current_schedule: schedule }, ...rows.slice(1)];
      });
      const subject = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
        runTenantTransaction: injected.run, now: () => NOW });
      await expect(subject.execute({ operationId, targets: [{ taskId: 'TASK-001', operations: [
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
      ] }] })).rejects.toThrow(/schedule evidence.*malformed/i);
      expect(reached).toBe(1);
      expect(hooks).toBe(0);
      expect(await batchState(operationId)).toEqual(before);
    }
  });

  it('groups evidence once and resolves requested subject buckets without rescanning history', () => {
    let evidenceAccesses = 0;
    const evidence = Array.from({ length: 120 }, (_, index) => {
      const taskInstanceId = `instance-${index % 4}`;
      const studentId = `student-${index}`;
      return Object.freeze({
        get task_instance_id() { evidenceAccesses += 1; return taskInstanceId; },
        get student_id() { evidenceAccesses += 1; return studentId; },
        assignment_id: `assignment-${index}`,
      });
    });
    const grouped = groupTaskAssignmentBatchEvidence(evidence);
    const afterGrouping = evidenceAccesses;
    const requested = grouped.slice(0, 40).map((group) => group.events);

    expect(afterGrouping).toBe(evidence.length * 2);
    expect(evidenceAccesses).toBe(afterGrouping);
    expect(requested).toHaveLength(40);
    expect(grouped.every((group) => Object.isFrozen(group) && Object.isFrozen(group.events))).toBe(true);
    expect(Object.isFrozen(grouped)).toBe(true);
  });

  it('wires the linear grouping helper into both live planning and replay validation', async () => {
    const source = await readFile(resolve(process.cwd(),
      'src/server/repositories/database/taskAssignmentBatchCommands.ts'), 'utf8');
    expect([...source.matchAll(/groupTaskAssignmentBatchEvidence\(/g)]).toHaveLength(2);
    expect(source).toContain('expectedHistoryBySubject.get(mirrorKey)');
    expect(source).toContain('validateResultEvents(byId, historyBySubject');
    expect(source).not.toMatch(/(?:expectedHistory|allHistory)\.filter\(/);
    expect([...source.matchAll(/\bhistory\.filter\(/g)]).toHaveLength(1);
  });

  it('uses one complete-state SELECT per evidence table per phase independent of entry count', async () => {
    const executeAndClassify = async (operationId: string, targets: ReturnType<typeof input>['targets']) => {
      const observed = observingRunner();
      const instrumented = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
        runTenantTransaction: observed.run, now: () => NOW });
      await instrumented.execute({ operationId, targets });
      return classifyBatchEvidenceQueries(observed.queries);
    };
    await singleton(new Date('2026-08-31T00:30:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000137', taskId: 'TASK-001',
      studentId: 'S001', assigned: true, source: 'ADMIN',
    });
    const one = await executeAndClassify('abcdef00-0000-4000-8000-000000000134', [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: false, source: 'ADMIN' }],
    }]);
    const several = await executeAndClassify('abcdef00-0000-4000-8000-000000000135', input().targets);
    expect(one.mutations.some((query) => query.statement.startsWith('delete from task_allowed_students')))
      .toBe(true);
    for (const classified of [one, several]) {
      expect(classified.planning.map((query) => query.table)).toEqual([
        'task_allowed_students', 'task_assignments', 'task_completions',
      ]);
      expect(classified.complete.map((query) => query.table)).toEqual([
        'task_allowed_students', 'task_assignments', 'task_completions',
        'task_allowed_students', 'task_assignments', 'task_completions',
      ]);
      expect(classified.replay.map((query) => query.table)).toEqual([
        'task_assignments', 'task_completions',
      ]);
    }
    expect(several.complete.map((query) => query.table)).toEqual(one.complete.map((query) => query.table));
  });

  it('preserves canonical output with many irrelevant histories across every target task', async () => {
    const irrelevant = Array.from({ length: 12 }, (_, index) => `IRRELEVANT-${String(index).padStart(2, '0')}`);
    for (const studentId of irrelevant) {
      await harness.database.query(`INSERT INTO students
        (tenant_id, student_id, name, status, created_at, updated_at)
        VALUES ($1, $2, $2, 'ACTIVE', $3, $3)`,
      [harness.tenantOneId, studentId, NOW.toISOString()]);
    }
    for (let index = 0; index < irrelevant.length; index += 1) {
      await singleton(new Date(`2026-08-31T00:${String(index).padStart(2, '0')}:00.000Z`)).execute({
        operationId: `abcdef00-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
        taskId: index % 2 === 0 ? 'TASK-001' : 'TASK-002', studentId: irrelevant[index],
        assigned: true, source: 'ADMIN',
      });
    }
    const result = await command().execute({
      operationId: 'abcdef00-0000-4000-8000-000000000136',
      targets: [{ taskId: 'TASK-002', operations: [
        { studentId: 'S002', assigned: true, source: 'ADMIN' },
        { studentId: 'S001', assigned: false, source: 'ADMIN' },
      ] }, { taskId: 'TASK-001', operations: [
        { studentId: 'S002', assigned: false, source: 'ADMIN' },
        { studentId: 'S001', assigned: true, source: 'ADMIN' },
      ] }],
    });
    expect(result.entries.map(({ taskId, studentId, assigned, changed }) =>
      ({ taskId, studentId, assigned, changed }))).toEqual([
      { taskId: 'TASK-001', studentId: 'S001', assigned: true, changed: true },
      { taskId: 'TASK-001', studentId: 'S002', assigned: false, changed: false },
      { taskId: 'TASK-002', studentId: 'S001', assigned: false, changed: false },
      { taskId: 'TASK-002', studentId: 'S002', assigned: true, changed: true },
    ]);
  });

  it('exports a canonical order-insensitive payload hash', () => {
    const reordered = { operationId: OPERATION_ID, targets: [...input().targets].reverse().map((target) => ({
      ...target, operations: [...target.operations].reverse(),
    })) };
    expect(createTaskAssignmentBatchPayloadHash(reordered))
      .toBe(createTaskAssignmentBatchPayloadHash(input()));
  });

  it('rejects malformed and over-limit input before transaction entry', async () => {
    let transactions = 0;
    const preflight = createDatabaseTaskAssignmentBatchCommand({ tenantId: 'tenant-one',
      runTenantTransaction: async () => { transactions += 1; throw new Error('sentinel'); }, now: () => NOW });
    const invalid: unknown[] = [
      { ...input(), extra: true }, { operationId: OPERATION_ID, targets: [] },
      { operationId: OPERATION_ID, targets: Array.from({ length: 21 }, (_, i) => ({ taskId: `T${i}`,
        operations: [{ studentId: 'S', assigned: true, source: 'ADMIN' }] })) },
      { operationId: OPERATION_ID, targets: [{ taskId: 'T', operations: [] }] },
      { operationId: OPERATION_ID, targets: [{ taskId: 'T', operations: [
        { studentId: 'S', assigned: true, source: 'ADMIN' },
        { studentId: 'S', assigned: false, source: 'ADMIN' }] }] },
      { operationId: OPERATION_ID, targets: [
        { taskId: 'T', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN' }] },
        { taskId: 'T', operations: [{ studentId: 'S2', assigned: true, source: 'ADMIN' }] }] },
      { operationId: OPERATION_ID, targets: [{ taskId: 'T', operations: [
        { studentId: 'S', assigned: true, completed: false, source: 'ADMIN' }] }] },
    ];
    for (const value of invalid) await expect(preflight.execute(value as never)).rejects.toThrow();
    expect(transactions).toBe(0);
  });

  it('atomically applies canonical multi-task desired state and replays reordered input', async () => {
    const result = await command().execute(input());
    expect(result.entries.map(({ taskId, studentId, assigned, changed }) =>
      ({ taskId, studentId, assigned, changed }))).toEqual([
      { taskId: 'TASK-001', studentId: 'S001', assigned: true, changed: true },
      { taskId: 'TASK-002', studentId: 'S002', assigned: false, changed: false },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(result.entries.every((entry) => Object.isFrozen(entry)
      && Object.isFrozen(entry.materializationEventIds))).toBe(true);
    const reordered = { operationId: OPERATION_ID, targets: [...input().targets].reverse() };
    await expect(command().execute(reordered)).resolves.toEqual(result);
    const [operations, audits, mirrors] = await Promise.all([
      harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, OPERATION_ID]),
      harness.database.query(`SELECT * FROM audit_events WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, OPERATION_ID]),
      harness.database.query(`SELECT t.task_id, m.student_id FROM task_allowed_students m JOIN tasks t
        ON t.tenant_id=m.tenant_id AND t.task_instance_id=m.task_instance_id
        WHERE m.tenant_id=$1 ORDER BY t.task_id, m.student_id`, [harness.tenantOneId]),
    ]);
    expect(operations.rows).toHaveLength(1); expect(audits.rows).toHaveLength(1);
    expect(mirrors.rows).toEqual([{ task_id: 'TASK-001', student_id: 'S001' }]);
  });

  it('rolls back all earlier work for an invalid later student and isolates tenants', async () => {
    const invalid = input();
    invalid.targets[1].operations[0] = { studentId: 'S003', assigned: true, source: 'ADMIN' };
    await expect(command().execute(invalid)).rejects.toThrow(/active student/i);
    const [operations, mirrors, assignments, otherTenant] = await Promise.all([
      harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1 AND operation_id=$2`,
        [harness.tenantOneId, OPERATION_ID]),
      harness.database.query(`SELECT * FROM task_allowed_students WHERE tenant_id=$1`, [harness.tenantOneId]),
      harness.database.query(`SELECT * FROM task_assignments WHERE tenant_id=$1`, [harness.tenantOneId]),
      harness.database.query(`SELECT * FROM task_allowed_students WHERE tenant_id=$1`, [harness.tenantTwoId]),
    ]);
    expect(operations.rows).toEqual([]); expect(mirrors.rows).toEqual([]);
    expect(assignments.rows).toEqual([]); expect(otherTenant.rows).toEqual([]);
  });

  it('rejects replay when the stored result, event identity, and audit hash are jointly forged', async () => {
    const desired = input();
    const result = await command().execute(desired);
    const entry = result.entries.find((value) => value.transitionEventId !== null)!;
    const forgedId = `forged:${entry.transitionEventId}`;
    const forged = { ...result, entries: result.entries.map((value) => value === entry
      ? { ...value, transitionEventId: forgedId } : value) };
    await harness.database.query(`ALTER TABLE task_assignments DISABLE TRIGGER USER`);
    await harness.database.query(`ALTER TABLE audit_events DISABLE TRIGGER USER`);
    await harness.database.query(`ALTER TABLE operations DISABLE TRIGGER USER`);
    try {
      await harness.database.query(`UPDATE task_assignments SET assignment_id=$3
        WHERE tenant_id=$1 AND assignment_id=$2`,
      [harness.tenantOneId, entry.transitionEventId, forgedId]);
      await harness.database.query(`UPDATE audit_events
        SET redacted_details=jsonb_set(redacted_details, '{resultHash}', to_jsonb($3::text))
        WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, OPERATION_ID, resultHash(forged)]);
      await harness.database.query(`UPDATE operations SET result_snapshot=$3::jsonb
        WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, OPERATION_ID, JSON.stringify(forged)]);
    } finally {
      await harness.database.query(`ALTER TABLE operations ENABLE TRIGGER USER`);
      await harness.database.query(`ALTER TABLE audit_events ENABLE TRIGGER USER`);
      await harness.database.query(`ALTER TABLE task_assignments ENABLE TRIGGER USER`);
    }

    await expect(command().execute(desired)).rejects.toThrow(/transition|integrity/i);
  });

  it('replays through a valid later assignment chain', async () => {
    const desired = input();
    const result = await command().execute(desired);
    await singleton(new Date('2026-08-31T02:00:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000102', taskId: 'TASK-001',
      studentId: 'S001', assigned: false, source: 'ADMIN',
    });
    await expect(command().execute(desired)).resolves.toEqual(result);
  });

  it('ignores an unrelated malformed history row but blocks it when targeted', async () => {
    const first = await singleton(new Date('2026-08-31T00:30:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000103', taskId: 'TASK-001',
      studentId: 'S001', assigned: true, source: 'ADMIN',
    });
    await singleton(new Date('2026-08-31T00:40:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000104', taskId: 'TASK-001',
      studentId: 'S001', assigned: false, source: 'ADMIN',
    });
    const prior = (await assignments()).find((row) => row.assignment_id === first.transitionEventId)!;
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, 'malformed:carry', 'TASK-001', $2, $3, $4, $5, 1, 'Asia/Seoul', 'S001',
       'ASSIGNED', 'CARRY_FORWARD', $6, NULL, NULL, $7, 1, NULL)`, [
      harness.tenantOneId, prior.task_instance_id,
      `v1|${String(prior.task_instance_id)}|r1|2026-09-01T00:00:00Z`,
      '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', first.transitionEventId,
      '2026-09-01T00:00:00.000Z',
    ]);

    await expect(command().execute({ operationId: 'abcdef00-0000-4000-8000-000000000105',
      targets: [{ taskId: 'TASK-002', operations: [{ studentId: 'S002', assigned: false,
        source: 'ADMIN' }] }] })).resolves.toMatchObject({ ok: true });
    await expect(command().execute({ operationId: 'abcdef00-0000-4000-8000-000000000115',
      targets: [{ taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: false,
        source: 'ADMIN' }] }] })).rejects.toThrow(/carry|history/i);
  });

  it('ignores an unrelated malformed cycle identity but blocks it when targeted', async () => {
    const first = await singleton(new Date('2026-08-31T00:30:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000106', taskId: 'TASK-001',
      studentId: 'S001', assigned: true, source: 'ADMIN',
    });
    await harness.database.query(`ALTER TABLE task_assignments DISABLE TRIGGER USER`);
    try {
      await harness.database.query(`UPDATE task_assignments SET cycle_id='forged-cycle'
        WHERE tenant_id=$1 AND assignment_id=$2`, [harness.tenantOneId, first.transitionEventId]);
    } finally {
      await harness.database.query(`ALTER TABLE task_assignments ENABLE TRIGGER USER`);
    }

    await expect(command().execute({ operationId: 'abcdef00-0000-4000-8000-000000000107',
      targets: [{ taskId: 'TASK-002', operations: [{ studentId: 'S002', assigned: false,
        source: 'ADMIN' }] }] })).resolves.toMatchObject({ ok: true });
    await expect(command().execute({ operationId: 'abcdef00-0000-4000-8000-000000000117',
      targets: [{ taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: false,
        source: 'ADMIN' }] }] })).rejects.toThrow(/history|cycle/i);
  });

  it('rejects structurally invalid completion evidence on replay', async () => {
    const desired = input();
    const result = await command().execute(desired);
    const assignment = (await assignments()).find((row) => row.assignment_id
      === result.entries.find((entry) => entry.transitionEventId)?.transitionEventId)!;
    await insertCompletionFixture(assignment);
    await harness.database.query(`ALTER TABLE task_completions DISABLE TRIGGER USER`);
    try {
      await harness.database.query(`UPDATE task_completions SET operation_hash='bad'
        WHERE tenant_id=$1 AND completion_id='fixture:completion'`, [harness.tenantOneId]);
    } finally {
      await harness.database.query(`ALTER TABLE task_completions ENABLE TRIGGER USER`);
    }

    await expect(command().execute(desired)).rejects.toThrow(/completion.*(integrity|invalid)/i);
  });

  it('replays successfully with a valid later structured completion', async () => {
    const desired = input();
    const result = await command().execute(desired);
    const assignment = (await assignments()).find((row) => row.assignment_id
      === result.entries.find((entry) => entry.transitionEventId)?.transitionEventId)!;
    await insertCompletionFixture(assignment);

    await expect(command().execute(desired)).resolves.toEqual(result);
  });

  it('rejects replay when a frozen materialization event is omitted from result evidence', async () => {
    const task = await harness.database.query(`SELECT task_instance_id FROM tasks
      WHERE tenant_id=$1 AND task_id='TASK-001'`, [harness.tenantOneId]);
    const taskInstanceId = (task.rows[0] as { task_instance_id: string }).task_instance_id;
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
    [harness.tenantOneId, taskInstanceId, '2026-08-30T01:00:00.000Z']);
    const desired = { operationId: 'abcdef00-0000-4000-8000-000000000108', targets: [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' as const }],
    }] };
    const result = await command().execute(desired);
    expect(result.entries[0].materializationEventIds).toHaveLength(1);
    const forged = { ...result, entries: result.entries.map((entry) => ({
      ...entry, cycleId: 'forged-cycle', materializationEventIds: [],
    })) };
    await harness.database.query(`ALTER TABLE audit_events DISABLE TRIGGER USER`);
    await harness.database.query(`ALTER TABLE operations DISABLE TRIGGER USER`);
    try {
      await harness.database.query(`UPDATE audit_events
        SET redacted_details=jsonb_set(
          jsonb_set(redacted_details, '{resultHash}', to_jsonb($3::text)),
          '{materializationEventCount}', '0'::jsonb)
        WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, desired.operationId, resultHash(forged)]);
      await harness.database.query(`UPDATE operations SET result_snapshot=$3::jsonb
        WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, desired.operationId, JSON.stringify(forged)]);
    } finally {
      await harness.database.query(`ALTER TABLE operations ENABLE TRIGGER USER`);
      await harness.database.query(`ALTER TABLE audit_events ENABLE TRIGGER USER`);
    }

    await expect(command().execute(desired)).rejects.toThrow(/materialization.*integrity/i);
  });

  it('replays successfully with an unrelated schema-valid legacy completion', async () => {
    const desired = input();
    const result = await command().execute(desired);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, transaction_id, operation_id,
       operation_hash, admin_operation_id, admin_operation_hash, schema_version, created_at)
      VALUES ($1, 'legacy:completion', $2, NULL, 'LEGACY-TASK', '과거 과제', 'S002', '둘',
        0, 0, 0, 'COMPLETED', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, 1, $2)`,
    [harness.tenantOneId, '2026-08-31T02:30:00.000Z']);

    await expect(command().execute(desired)).resolves.toEqual(result);
  });

  it('scopes live and replay evidence SQL to the exact requested physical sets', async () => {
    const observed = observingRunner();
    const scoped = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: observed.run, now: () => NOW });
    const desired = { operationId: 'abcdef00-0000-4000-8000-000000000118', targets: [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' as const }],
    }] };
    const result = await scoped.execute(desired);
    await scoped.execute(desired);

    const normalized = observed.queries.map((query) => ({
      sql: query.sql.replace(/\s+/g, ' ').trim(), params: query.params,
    }));
    const taskLocks = normalized.filter((query) => query.sql.includes('from tasks')
      && query.sql.includes('for update'));
    expect(taskLocks).not.toHaveLength(0);
    expect(taskLocks.every((query) => query.sql.includes('task_id in (')
      && query.sql.includes('order by task_instance_id for update')
      && query.params.includes('TASK-001') && !query.params.includes('TASK-002'))).toBe(true);
    const studentLocks = normalized.filter((query) => query.sql.includes('from students'));
    expect(studentLocks.every((query) => query.sql.includes('student_id in (')
      && query.sql.includes('order by student_id for update')
      && query.params.includes('S001') && !query.params.includes('S002'))).toBe(true);
    for (const table of ['task_allowed_students', 'task_assignments', 'task_completions']) {
      const evidence = normalized.filter((query) => query.sql.includes(`from ${table}`)
        && query.sql.includes('order by task_instance_id'));
      expect(evidence).not.toHaveLength(0);
      expect(evidence.every((query) => query.sql.includes('task_instance_id in (')
        && query.params.includes(result.entries[0].taskInstanceId))).toBe(true);
    }
    const replayIdentity = normalized.find((query) => query.sql.includes('select task_instance_id, task_id from tasks')
      && !query.sql.includes('for update'));
    expect(replayIdentity?.sql).toContain('task_instance_id in (');
    expect(replayIdentity?.params).toContain(result.entries[0].taskInstanceId);
  });

  it('rejects duplicate target task evidence before applying writes', async () => {
    const observed = observingRunner((query, rows) => query.sql.includes('from tasks')
      && query.sql.includes('for update') && rows.length === 1 ? [...rows, rows[0]] : rows);
    const scoped = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: observed.run, now: () => NOW });
    await expect(scoped.execute({ operationId: 'abcdef00-0000-4000-8000-000000000119', targets: [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' }],
    }] })).rejects.toThrow(/target|task.*integrity/i);
    expect(await harness.database.query(`SELECT * FROM task_assignments WHERE tenant_id=$1`,
      [harness.tenantOneId])).toMatchObject({ rows: [] });
  });

  it('rejects duplicate target student evidence and duplicate frozen replay identities', async () => {
    const duplicateStudents = observingRunner((query, rows) => query.sql.includes('from students')
      && rows.length === 1 ? [...rows, rows[0]] : rows);
    const live = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: duplicateStudents.run, now: () => NOW });
    const desired = { operationId: 'abcdef00-0000-4000-8000-000000000121', targets: [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' as const }],
    }] };
    await expect(live.execute(desired)).rejects.toThrow(/student.*(evidence|integrity)/i);

    const result = await command().execute(desired);
    const duplicateIdentities = observingRunner((query, rows) => query.sql.includes(
      'select task_instance_id, task_id from tasks') && !query.sql.includes('for update')
      ? [...rows, rows[0]] : rows);
    const replay = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: duplicateIdentities.run, now: () => NOW });
    await expect(replay.execute(desired)).rejects.toThrow(/physical identity.*integrity/i);
    expect(result.entries).toHaveLength(1);
  });

  it('ignores malformed completion evidence outside the target physical set', async () => {
    const first = await singleton(new Date('2026-08-31T00:30:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000122', taskId: 'TASK-001',
      studentId: 'S001', assigned: true, source: 'ADMIN',
    });
    const assignment = (await assignments()).find((row) => row.assignment_id === first.transitionEventId)!;
    await insertCompletionFixture(assignment);
    await harness.database.query(`ALTER TABLE task_completions DISABLE TRIGGER USER`);
    try {
      await harness.database.query(`UPDATE task_completions SET operation_hash='bad'
        WHERE tenant_id=$1 AND completion_id='fixture:completion'`, [harness.tenantOneId]);
    } finally {
      await harness.database.query(`ALTER TABLE task_completions ENABLE TRIGGER USER`);
    }
    await expect(command().execute({ operationId: 'abcdef00-0000-4000-8000-000000000123',
      targets: [{ taskId: 'TASK-002', operations: [{ studentId: 'S002', assigned: false,
        source: 'ADMIN' }] }] })).resolves.toMatchObject({ ok: true });
    await expect(command().execute({ operationId: 'abcdef00-0000-4000-8000-000000000124',
      targets: [{ taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true,
        source: 'ADMIN' }] }] })).rejects.toThrow(/completion.*(integrity|invalid)/i);
  });

  it('rejects unknown physical mirror and assignment evidence injected by an adapter', async () => {
    const unknownMirror = observingRunner((query, rows) => query.sql.includes('from task_allowed_students')
      ? [...rows, { task_instance_id: 'unknown-instance', student_id: 'S001', created_at: NOW }] : rows);
    const mirrorCommand = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: unknownMirror.run, now: () => NOW });
    await expect(mirrorCommand.execute({ operationId: 'abcdef00-0000-4000-8000-000000000125',
      targets: [{ taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: false,
        source: 'ADMIN' }] }] })).rejects.toThrow(/mirror.*integrity/i);

    const desired = { operationId: 'abcdef00-0000-4000-8000-000000000126', targets: [{
      taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' as const }],
    }] };
    await command().execute(desired);
    const unknownHistory = observingRunner((query, rows) => query.sql.includes('from task_assignments')
      && rows.length > 0 ? [...rows, { ...(rows[0] as Record<string, unknown>),
        assignment_id: 'unknown:assignment',
        task_instance_id: 'unknown-instance', cycle_id: 'v1|unknown-instance|r1|2026-08-31T00:00:00Z',
        previous_assignment_id: null, admin_operation_id: null, admin_operation_hash: null,
        source: 'LEGACY_SEED' }] : rows);
    const replayCommand = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: unknownHistory.run, now: () => NOW });
    await expect(replayCommand.execute(desired)).rejects.toThrow(/history.*integrity/i);
  });

  it('rejects duplicate mirror identities injected by an adapter', async () => {
    const task = await harness.database.query<{ task_instance_id: string }>(
      `SELECT task_instance_id FROM tasks WHERE tenant_id=$1 AND task_id='TASK-001'`,
      [harness.tenantOneId]);
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
    [harness.tenantOneId, task.rows[0].task_instance_id, NOW.toISOString()]);
    const duplicateMirrors = observingRunner((query, rows) => query.sql.includes('from task_allowed_students')
      && rows.length === 1 ? [...rows, rows[0]] : rows);
    const duplicateCommand = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: duplicateMirrors.run, now: () => NOW });
    await expect(duplicateCommand.execute({ operationId: 'abcdef00-0000-4000-8000-000000000129',
      targets: [{ taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true,
        source: 'ADMIN' }] }] })).rejects.toThrow(/mirror.*integrity/i);
  });

  it('rejects duplicate completion identities injected by an adapter', async () => {
    const first = await singleton(new Date('2026-08-31T00:30:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000127', taskId: 'TASK-001',
      studentId: 'S001', assigned: true, source: 'ADMIN',
    });
    const assignment = (await assignments()).find((row) => row.assignment_id === first.transitionEventId)!;
    await insertCompletionFixture(assignment);
    const duplicateCompletions = observingRunner((query, rows) => query.sql.includes('from task_completions')
      && rows.length === 1 ? [...rows, rows[0]] : rows);
    const duplicateCommand = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: duplicateCompletions.run, now: () => NOW });
    await expect(duplicateCommand.execute({ operationId: 'abcdef00-0000-4000-8000-000000000128',
      targets: [{ taskId: 'TASK-001', operations: [{ studentId: 'S001', assigned: true,
        source: 'ADMIN' }] }] })).rejects.toThrow(/completion.*integrity/i);
  });

  it('rejects null, unknown, and business-mismatched completion identities from an adapter', async () => {
    const first = await singleton(new Date('2026-08-31T00:30:00.000Z')).execute({
      operationId: 'abcdef00-0000-4000-8000-000000000133', taskId: 'TASK-001',
      studentId: 'S001', assigned: true, source: 'ADMIN',
    });
    const assignment = (await assignments()).find((row) => row.assignment_id === first.transitionEventId)!;
    await insertCompletionFixture(assignment);
    const cases: Array<[string, (row: Record<string, unknown>) => Record<string, unknown>]> = [
      ['abcdef00-0000-4000-8000-000000000130', (row) => ({ ...row, task_instance_id: null,
        cycle_id: null, cycle_start_at: null, cycle_end_at: null, rule_version: null,
        timezone: null, source: null })],
      ['abcdef00-0000-4000-8000-000000000131', (row) => ({ ...row,
        task_instance_id: 'unknown-instance' })],
      ['abcdef00-0000-4000-8000-000000000132', (row) => ({ ...row,
        task_id_snapshot: 'OTHER-TASK' })],
    ];
    for (const [operationId, mutate] of cases) {
      const injected = observingRunner((query, rows) => query.sql.includes('from task_completions')
        && rows.length === 1 ? [mutate(rows[0] as Record<string, unknown>)] : rows);
      const injectedCommand = createDatabaseTaskAssignmentBatchCommand({ tenantId: harness.tenantOneId,
        runTenantTransaction: injected.run, now: () => NOW });
      await expect(injectedCommand.execute({ operationId, targets: [{ taskId: 'TASK-001',
        operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' }] }] }))
        .rejects.toThrow(/completion.*integrity/i);
    }
  });

  it('succeeds when canonical business order opposes physical lock order', async () => {
    const rows = await harness.database.query<{ task_instance_id: string; task_id: string }>(
      `SELECT task_instance_id, task_id FROM tasks WHERE tenant_id=$1 ORDER BY task_instance_id`,
      [harness.tenantOneId]);
    await harness.database.query(`UPDATE tasks SET task_id='ZZZ-TASK'
      WHERE tenant_id=$1 AND task_instance_id=$2`, [harness.tenantOneId, rows.rows[0].task_instance_id]);
    await harness.database.query(`UPDATE tasks SET task_id='AAA-TASK'
      WHERE tenant_id=$1 AND task_instance_id=$2`, [harness.tenantOneId, rows.rows[1].task_instance_id]);

    const result = await command().execute({
      operationId: 'abcdef00-0000-4000-8000-000000000120',
      targets: [{ taskId: 'ZZZ-TASK', operations: [{ studentId: 'S001', assigned: true, source: 'ADMIN' }] },
        { taskId: 'AAA-TASK', operations: [{ studentId: 'S002', assigned: true, source: 'ADMIN' }] }],
    });
    expect(result.entries.map((entry) => entry.taskId)).toEqual(['AAA-TASK', 'ZZZ-TASK']);
    expect(result.entries.every((entry) => entry.changed)).toBe(true);
    expect(await assignments()).toHaveLength(2);
  });
});
