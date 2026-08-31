import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDatabaseTaskAdminCommands } from './taskAdminCommands';
import {
  createDatabaseTaskAssignmentCommand,
  createTaskAssignmentPayloadHash,
} from './taskAssignmentCommands';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-31T01:00:00.000Z');
const OP_ASSIGN = 'abcdef00-0000-4000-8000-000000000001';
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await harness.database.exec(await readFile(resolve(
    process.cwd(), 'src/server/db/migrations/0010_task_admin_invariants.sql',
  ), 'utf8'));
  for (const tenantId of [harness.tenantOneId, harness.tenantTwoId]) {
    await harness.database.query(
      `INSERT INTO students (tenant_id, student_id, name, status, created_at, updated_at)
       VALUES ($1, 'S001', '하나', 'ACTIVE', $2, $2),
              ($1, 'S002', '둘', 'ACTIVE', $2, $2),
              ($1, 'S003', '셋', 'INACTIVE', $2, $2)`,
      [tenantId, NOW.toISOString()],
    );
  }
  await createDatabaseTaskAdminCommands({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => new Date('2026-08-30T01:00:00.000Z'),
  }).create({
    operationId: 'seed-task-operation', taskId: 'TASK-001', title: '과제', description: '',
    reward: 100, isActive: true, sortOrder: 1, allowedStudentIds: [],
    schedule: { recurrence: { type: 'DAILY', time: '09:00' }, timeZone: 'Asia/Seoul',
      resetCompletionOnCycle: true, resetAssignmentOnCycle: false },
  });
});

afterEach(async () => harness.close());

const input = (overrides: Record<string, unknown> = {}) => ({
  operationId: OP_ASSIGN, taskId: 'TASK-001', studentId: 'S001', assigned: true,
  source: 'ADMIN' as const, ...overrides,
});

const command = (tenantId = harness.tenantOneId, now = NOW) =>
  createDatabaseTaskAssignmentCommand({
    tenantId, runTenantTransaction: harness.runTenantTransaction, now: () => now,
  });

async function state(tenantId = harness.tenantOneId) {
  const [tasks, mirrors, assignments, operations, audits, completions] = await Promise.all([
    harness.database.query(`SELECT task_instance_id, task_id FROM tasks WHERE tenant_id=$1`, [tenantId]),
    harness.database.query(`SELECT task_instance_id, student_id, created_at FROM task_allowed_students
      WHERE tenant_id=$1 ORDER BY student_id`, [tenantId]),
    harness.database.query(`SELECT assignment_id, event_sequence::text, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
      event_type, source, previous_assignment_id, admin_operation_id, admin_operation_hash,
      created_at, schema_version, note FROM task_assignments WHERE tenant_id=$1
      ORDER BY student_id, event_sequence`, [tenantId]),
    harness.database.query(`SELECT operation_id, operation_kind, payload_hash, status, attempt_count::text,
      result_snapshot, started_at, finished_at, created_at, updated_at, failure_code
      FROM operations WHERE tenant_id=$1 AND operation_id=$2`, [tenantId, OP_ASSIGN]),
    harness.database.query(`SELECT operation_id, event_type, entity_type, entity_id, redacted_details,
      occurred_at FROM audit_events WHERE tenant_id=$1 AND operation_id=$2`, [tenantId, OP_ASSIGN]),
    harness.database.query(`SELECT to_jsonb(c)::text snapshot FROM task_completions c
      WHERE tenant_id=$1 ORDER BY event_sequence`, [tenantId]),
  ]);
  return { tasks: tasks.rows, mirrors: mirrors.rows, assignments: assignments.rows,
    operations: operations.rows, audits: audits.rows, completions: completions.rows };
}

function coercionTrap(counter: { calls: number }) {
  return {
    toString() { counter.calls += 1; throw new Error('toString coercion trap'); },
    valueOf() { counter.calls += 1; throw new Error('valueOf coercion trap'); },
  };
}

async function insertCompletionFixture(assignment: Record<string, unknown>) {
  await harness.database.query(`INSERT INTO task_completions
    (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
     task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
     balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
     rule_version, timezone, source, assignment_id, schema_version, created_at)
    VALUES ($1, 'fixture:completion', $2, $3, 'TASK-001', '과제', 'S001', '하나', 100,
      0, 100, 'COMPLETED', NULL, $4, $5, $6, $7, 'Asia/Seoul', 'BANK', $8, 1, $2)`, [
    harness.tenantOneId, '2026-08-31T01:30:00.000Z', assignment.task_instance_id,
    assignment.cycle_id, assignment.cycle_start_at, assignment.cycle_end_at,
    assignment.rule_version, assignment.assignment_id,
  ]);
}

describe('database desired task-assignment command', () => {
  it('rejects non-exact inputs and invalid clocks before transaction entry', async () => {
    let calls = 0;
    const preflight = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('transaction sentinel'); },
      now: () => NOW,
    });
    const getter = input() as Record<string, unknown>;
    Object.defineProperty(getter, 'studentId', { enumerable: true, get: () => 'S001' });
    const symbol = { ...input(), [Symbol('extra')]: true };
    const invalid = [
      { ...input(), extra: true }, getter, symbol,
      input({ operationId: 'not-a-uuid' }), input({ operationId: OP_ASSIGN.toUpperCase() }),
      input({ taskId: ' TASK-001' }), input({ studentId: 'S001 ' }), input({ assigned: 1 }),
      input({ source: 'admin' }), input({ source: 'LEGACY_SEED' }), null, [],
    ];
    for (const value of invalid) await expect(preflight.execute(value as never)).rejects.toThrow();
    const badClock = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction: preflight.execute as never,
      now: () => new Date(Number.NaN),
    });
    await expect(badClock.execute(input())).rejects.toThrow(/timestamp|date/i);
    expect(calls).toBe(0);
  });

  it('resolves a lost operation-claim race before reading mutable domain evidence', async () => {
    const desired = input({ assigned: false });
    const winner = await command().execute(desired);

    const racingCommand = () => {
      const calls: string[] = [];
      let executeCount = 0;
      const runTenantTransaction = async <T,>(tenantId: string,
        callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
        harness.runTenantTransaction(tenantId, async (tx) => {
          const adapter = Object.create(tx) as typeof tx;
          adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
            executeCount += 1;
            if (executeCount === 1) {
              calls.push('operation-read-hidden');
              return { rows: [] } as unknown as Awaited<ReturnType<typeof tx.execute>>;
            }
            const result = await tx.execute(statement);
            if (executeCount === 2) calls.push(`claim:${result.rows.length}`);
            else if (executeCount === 3) calls.push('winner-reread');
            else calls.push('domain-read');
            return result;
          }) as typeof tx.execute;
          return callback(adapter);
        });
      return { command: createDatabaseTaskAssignmentCommand({
        tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
      }), calls };
    };

    const same = racingCommand();
    await expect(same.command.execute(desired)).resolves.toEqual(winner);
    expect(same.calls).toEqual(['operation-read-hidden', 'claim:0', 'winner-reread',
      'domain-read', 'domain-read', 'domain-read', 'domain-read', 'domain-read']);

    const changed = racingCommand();
    await expect(changed.command.execute(input({ assigned: true }))).rejects.toThrow(/conflict/i);
    expect(changed.calls).toEqual(['operation-read-hidden', 'claim:0', 'winner-reread']);
  });

  it('locks evidence in operation, task, student, mirror, assignment, completion order', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          statements.push(dialect.sqlToQuery(statement as SQL).sql.replace(/\s+/g, ' ').trim());
          return tx.execute(statement);
        }) as typeof tx.execute;
        return callback(adapter);
      });
    await createDatabaseTaskAssignmentCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction, now: () => NOW }).execute(input({ assigned: false,
      operationId: 'abcdef00-0000-4000-8000-000000000010' }));
    const first = (needle: string) => statements.findIndex((statement) => statement.includes(needle));
    const order = [first('FROM operations'), first('INSERT INTO operations'),
      first('FROM tasks'), first('FROM students'), first('FROM task_allowed_students'),
      first('FROM task_assignments'), first('FROM task_completions')];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(statements[order[2]]).toContain('ORDER BY task_instance_id');
    expect(statements[order[3]]).toContain('ORDER BY student_id');
  });

  it('rejects non-raw-exact RETURNING evidence without invoking getters and rolls back', async () => {
    const cases = [
      { label: 'claim', keys: ['operation_id'], occurrence: 1, operationId: 'abcdef00-0000-4000-8000-000000000011' },
      { label: 'mirror', keys: ['created_at', 'student_id', 'task_instance_id'], occurrence: 1,
        operationId: 'abcdef00-0000-4000-8000-000000000012' },
      { label: 'transition', keys: ['assignment_id'], occurrence: 1,
        operationId: 'abcdef00-0000-4000-8000-000000000013' },
      { label: 'terminal', keys: ['operation_id'], occurrence: 2,
        operationId: 'abcdef00-0000-4000-8000-000000000014' },
    ] as const;
    for (const testCase of cases) {
      const before = await state();
      let matches = 0;
      let getterCalls = 0;
      const runTenantTransaction = async <T,>(tenantId: string,
        callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
        harness.runTenantTransaction(tenantId, async (tx) => {
          const adapter = Object.create(tx) as typeof tx;
          adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
            const result = await tx.execute(statement);
            const row = result.rows[0];
            if (row && Object.keys(row).sort().join(',') === [...testCase.keys].sort().join(',')) {
              matches += 1;
              if (matches === testCase.occurrence) {
                const corrupted = { ...row } as Record<string, unknown>;
                if (testCase.label === 'claim') {
                  Object.defineProperty(corrupted, 'operation_id', { enumerable: true,
                    get: () => { getterCalls += 1; return testCase.operationId; } });
                } else {
                  corrupted.extra = true;
                }
                return { ...result, rows: [corrupted] };
              }
            }
            return result;
          }) as typeof tx.execute;
          return callback(adapter);
        });
      const corrupted = createDatabaseTaskAssignmentCommand({
        tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
      });
      await expect(corrupted.execute(input({ operationId: testCase.operationId })))
        .rejects.toThrow(/malformed|integrity/i);
      expect(getterCalls).toBe(0);
      expect(await state()).toEqual(before);
    }
  });

  it('rolls back when audit and terminal triggers corrupt complete assignment or completion sets', async () => {
    const beforeAuditFault = await state();
    await harness.database.exec(`
      CREATE FUNCTION assignment_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id = 'abcdef00-0000-4000-8000-000000000021' THEN
          INSERT INTO task_assignments
            (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
             cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
             previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
             schema_version, note)
          SELECT NEW.tenant_id, 'fault:assignment', task_id_snapshot, task_instance_id, cycle_id,
             cycle_start_at, cycle_end_at, rule_version, timezone, student_id, 'ASSIGNED',
             'LEGACY_SEED', NULL, NULL, NULL, NEW.occurred_at, 1, NULL
          FROM task_assignments WHERE tenant_id=NEW.tenant_id
            AND admin_operation_id=NEW.operation_id LIMIT 1;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER assignment_audit_fault_trigger AFTER INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION assignment_audit_fault();
    `);
    await expect(command().execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000021',
    }))).rejects.toThrow(/assignment set integrity/i);
    expect(await state()).toEqual(beforeAuditFault);

    await harness.database.exec(`
      CREATE FUNCTION completion_terminal_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id = 'abcdef00-0000-4000-8000-000000000022' AND NEW.status='SUCCEEDED' THEN
          INSERT INTO task_completions
            (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
             task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
             balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
             rule_version, timezone, source, assignment_id, schema_version, created_at)
          SELECT NEW.tenant_id, 'fault:completion', NEW.finished_at, a.task_instance_id,
             a.task_id_snapshot, t.title, 'S001', '하나', t.reward, 0, t.reward, 'COMPLETED',
             a.cycle_id, a.cycle_start_at, a.cycle_end_at, a.rule_version, a.timezone, 'BANK',
             a.assignment_id, 1, NEW.finished_at
          FROM task_assignments a JOIN tasks t ON t.tenant_id=a.tenant_id
            AND t.task_instance_id=a.task_instance_id
          WHERE a.tenant_id=NEW.tenant_id AND a.admin_operation_id=NEW.operation_id LIMIT 1;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER completion_terminal_fault_trigger AFTER UPDATE ON operations
        FOR EACH ROW EXECUTE FUNCTION completion_terminal_fault();
    `);
    const beforeTerminalFault = await state();
    await expect(command().execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000022',
    }))).rejects.toThrow(/completion history integrity/i);
    expect(await state()).toEqual(beforeTerminalFault);
  });

  it.each([
    ['mutates', `UPDATE task_allowed_students SET created_at=created_at + interval '1 second'
      WHERE tenant_id=NEW.tenant_id AND student_id='S002'`],
    ['adds', `INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id, created_at)
      SELECT NEW.tenant_id, task_instance_id, 'S003', NEW.occurred_at FROM tasks
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['deletes', `DELETE FROM task_allowed_students
      WHERE tenant_id=NEW.tenant_id AND student_id='S002'`],
  ] as const)('rejects when an audit trigger %s another student mirror and rolls back', async (_label, faultSql) => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S002', $3)`,
    [harness.tenantOneId, task.task_instance_id, '2026-08-30T01:30:00.000Z']);
    const before = await state();
    await harness.database.exec(`
      CREATE SEQUENCE mirror_fault_reached;
      GRANT USAGE, SELECT, UPDATE ON SEQUENCE mirror_fault_reached TO PUBLIC;
      CREATE FUNCTION other_mirror_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id = 'abcdef00-0000-4000-8000-000000000051' THEN
          PERFORM nextval('mirror_fault_reached');
          ${faultSql};
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER other_mirror_fault_trigger AFTER INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION other_mirror_fault();
    `);

    await expect(command().execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000051',
    }))).rejects.toThrow(/mirror integrity/i);
    expect((await harness.database.query(`SELECT last_value FROM mirror_fault_reached`)).rows)
      .toEqual([{ last_value: 1 }]);
    expect(await state()).toEqual(before);
  });

  it('rejects when an audit trigger mutates the target mirror timestamp and rolls back', async () => {
    const before = await state();
    await harness.database.exec(`
      CREATE SEQUENCE target_mirror_fault_reached;
      GRANT USAGE, SELECT, UPDATE ON SEQUENCE target_mirror_fault_reached TO PUBLIC;
      CREATE FUNCTION target_mirror_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id = 'abcdef00-0000-4000-8000-000000000060' THEN
          PERFORM nextval('target_mirror_fault_reached');
          UPDATE task_allowed_students SET created_at=created_at + interval '1 second'
          WHERE tenant_id=NEW.tenant_id AND student_id='S001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER target_mirror_fault_trigger AFTER INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION target_mirror_fault();
    `);

    await expect(command().execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000060',
    }))).rejects.toThrow(/mirror integrity/i);
    expect((await harness.database.query(`SELECT last_value FROM target_mirror_fault_reached`)).rows)
      .toEqual([{ last_value: 1 }]);
    expect(await state()).toEqual(before);
  });

  it('rejects a still-chain-valid adapter mutation of an initial assignment and rolls back', async () => {
    await command(harness.tenantOneId, new Date('2026-08-31T00:30:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000052', studentId: 'S002',
    }));
    const before = await state();
    let assignmentReads = 0;
    let faultReached = false;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.length > 0 && result.rows.every((row) =>
            Object.hasOwn(row, 'assignment_id') && Object.hasOwn(row, 'event_sequence'))) {
            assignmentReads += 1;
            if (assignmentReads === 2) {
              faultReached = true;
              return { ...result, rows: result.rows.map((value) => {
                const row = { ...value } as Record<string, unknown>;
                if (row.student_id === 'S002') {
                  row.created_at = new Date(new Date(String(row.created_at)).getTime() + 1_000);
                }
                return row;
              }) } as typeof result;
            }
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const corrupted = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });

    await expect(corrupted.execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000053',
    }))).rejects.toThrow(/assignment.*integrity/i);
    expect(faultReached).toBe(true);
    expect(await state()).toEqual(before);
  });

  it('accepts a normal same-cycle ADMIN to QR assignment chain bound to the locked task snapshot', async () => {
    const assigned = await command().execute(input());
    const result = await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000066', assigned: false, source: 'QR',
    }));

    expect(result).toEqual(expect.objectContaining({ assigned: false, changed: true }));
    expect((await state()).assignments).toEqual([
      expect.objectContaining({ assignment_id: assigned.transitionEventId,
        task_id_snapshot: 'TASK-001', source: 'ADMIN' }),
      expect.objectContaining({ assignment_id: result.transitionEventId,
        task_id_snapshot: 'TASK-001', source: 'QR',
        previous_assignment_id: assigned.transitionEventId }),
    ]);
  });

  it.each(['execution', 'replay'] as const)(
    'rejects %s when an otherwise canonical predecessor has the wrong locked task snapshot',
    async (mode) => {
      const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000067' });
      const first = await command().execute(input({
        operationId: 'abcdef00-0000-4000-8000-000000000068', source: 'QR',
      }));
      if (mode === 'replay') await command().execute(desired);
      const before = await state();
      let faultReached = false;
      let callsAfterFault = 0;
      const runTenantTransaction = async <T,>(tenantId: string,
        callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
        harness.runTenantTransaction(tenantId, async (tx) => {
          const adapter = Object.create(tx) as typeof tx;
          adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
            if (faultReached) callsAfterFault += 1;
            const queryResult = await tx.execute(statement);
            if (!faultReached && queryResult.rows.some((row) =>
              Object.hasOwn(row, 'assignment_id'))) {
              faultReached = true;
              return { ...queryResult, rows: queryResult.rows.map((value) => {
                const row = { ...value } as Record<string, unknown>;
                if (row.assignment_id === first.transitionEventId) row.task_id_snapshot = 'TASK-OTHER';
                return row;
              }) } as typeof queryResult;
            }
            return queryResult;
          }) as typeof tx.execute;
          return callback(adapter);
        });
      const corrupted = createDatabaseTaskAssignmentCommand({
        tenantId: harness.tenantOneId, runTenantTransaction, now: () => new Date('2026-08-31T02:00:00.000Z'),
      });

      await expect(corrupted.execute(desired)).rejects
        .toThrow('Task assignment history integrity check failed.');
      expect(faultReached).toBe(true);
      expect(callsAfterFault).toBe(0);
      expect(await state()).toEqual(before);
    },
  );

  it('rejects an object-valued operation status without invoking coercion hooks or domain reads', async () => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000069', assigned: false });
    await command().execute(desired);
    const counter = { calls: 0 };
    let faultReached = false;
    let callsAfterFault = 0;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          if (faultReached) callsAfterFault += 1;
          const queryResult = await tx.execute(statement);
          if (!faultReached && queryResult.rows.length === 1
            && Object.hasOwn(queryResult.rows[0], 'result_snapshot')) {
            faultReached = true;
            return ({ ...queryResult,
              rows: [{ ...queryResult.rows[0], status: coercionTrap(counter) }],
            }) as typeof queryResult;
          }
          return queryResult;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const replay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });

    await expect(replay.execute(desired)).rejects
      .toThrow('Task assignment operation integrity check failed.');
    expect(faultReached).toBe(true);
    expect(callsAfterFault).toBe(0);
    expect(counter.calls).toBe(0);
  });

  it.each([
    ['execution', 'event_type'], ['execution', 'source'], ['execution', 'previous_assignment_id'],
    ['replay', 'event_type'], ['replay', 'source'], ['replay', 'previous_assignment_id'],
  ] as const)('rejects during %s with object-valued assignment %s without coercion',
  async (mode, field) => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000070', assigned: false });
    await command().execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000071' }));
    if (mode === 'replay') await command().execute(desired);
    const before = await state();
    const counter = { calls: 0 };
    let faultReached = false;
    let callsAfterFault = 0;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          if (faultReached) callsAfterFault += 1;
          const queryResult = await tx.execute(statement);
          if (!faultReached && queryResult.rows.some((row) => Object.hasOwn(row, 'assignment_id'))) {
            faultReached = true;
            const rows = queryResult.rows.map((value) => ({ ...value })) as Record<string, unknown>[];
            rows[0][field] = coercionTrap(counter);
            return { ...queryResult, rows } as typeof queryResult;
          }
          return queryResult;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const corrupted = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => new Date('2026-08-31T02:00:00.000Z'),
    });

    await expect(corrupted.execute(desired)).rejects
      .toThrow('Task assignment history integrity check failed.');
    expect(faultReached).toBe(true);
    expect(callsAfterFault).toBe(0);
    expect(counter.calls).toBe(0);
    expect(await state()).toEqual(before);
  });

  it.each([
    ['initial lock', 1, 'task_id_snapshot', 'TASK-OTHER'],
    ['first complete-state read', 2, 'task_id_snapshot', 'TASK-OTHER'],
    ['second complete-state read', 3, 'task_id_snapshot', 'TASK-OTHER'],
    ['initial lock', 1, 'task_instance_id', 'task-instance-other'],
    ['first complete-state read', 2, 'task_instance_id', 'task-instance-other'],
    ['second complete-state read', 3, 'task_instance_id', 'task-instance-other'],
  ] as const)(
    'binds completion history at the %s against primitive-corrupt %s adapter evidence',
    async (_stage, corruptRead, field, corruptValue) => {
      await command().execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000074' }));
      const assignment = (await state()).assignments[0] as Record<string, unknown>;
      await insertCompletionFixture(assignment);
      const before = await state();
      let completionReads = 0;
      let faultReached = false;
      let callsAfterFault = 0;
      const runTenantTransaction = async <T,>(tenantId: string,
        callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
        harness.runTenantTransaction(tenantId, async (tx) => {
          const adapter = Object.create(tx) as typeof tx;
          adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
            if (faultReached) callsAfterFault += 1;
            const queryResult = await tx.execute(statement);
            if (queryResult.rows.some((row) => Object.hasOwn(row, 'completion_id'))) {
              completionReads += 1;
              if (completionReads === corruptRead) {
                faultReached = true;
                const rows = queryResult.rows.map((value) => ({ ...value })) as Record<string, unknown>[];
                rows[0][field] = corruptValue;
                return { ...queryResult, rows } as typeof queryResult;
              }
            }
            return queryResult;
          }) as typeof tx.execute;
          return callback(adapter);
        });
      const corrupted = createDatabaseTaskAssignmentCommand({
        tenantId: harness.tenantOneId, runTenantTransaction, now: () => new Date('2026-08-31T02:00:00.000Z'),
      });

      await expect(corrupted.execute(input({
        operationId: 'abcdef00-0000-4000-8000-000000000075', assigned: false,
      }))).rejects.toThrow('Task assignment completion history integrity check failed.');
      expect(completionReads).toBe(corruptRead);
      expect(faultReached).toBe(true);
      expect(callsAfterFault).toBe(0);
      expect(await state()).toEqual(before);
    },
  );

  it('rejects replay when current completion history has the wrong task snapshot', async () => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000076' });
    const result = await command().execute(desired);
    const assignment = (await state()).assignments[0] as Record<string, unknown>;
    await insertCompletionFixture(assignment);
    const before = await state();
    let completionQueryReached = false;
    let callsAfterFault = 0;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          if (completionQueryReached) callsAfterFault += 1;
          const queryResult = await tx.execute(statement);
          if (!completionQueryReached && queryResult.rows.some((row) => Object.hasOwn(row, 'completion_id'))) {
            completionQueryReached = true;
            return { ...queryResult, rows: queryResult.rows.map((row) => ({
              ...row, task_id_snapshot: 'TASK-OTHER',
            })) } as typeof queryResult;
          }
          return queryResult;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const replay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });

    await expect(replay.execute(desired)).rejects
      .toThrow('Task assignment completion history integrity check failed.');
    expect(result.taskId).toBe('TASK-001');
    expect(completionQueryReached).toBe(true);
    expect(callsAfterFault).toBe(0);
    expect(await state()).toEqual(before);
  });

  it('replays successfully with a valid later BANK completion in current history', async () => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000077' });
    const result = await command().execute(desired);
    const assignment = (await state()).assignments[0] as Record<string, unknown>;
    await insertCompletionFixture(assignment);

    await expect(command(harness.tenantOneId, new Date('2026-08-31T03:00:00.000Z')).execute(desired))
      .resolves.toEqual(result);
    expect((await state()).completions).toHaveLength(1);
  });

  it('rejects object-valued completion source during execution without coercion', async () => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000072', assigned: false });
    await command().execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000073' }));
    const assignment = (await state()).assignments[0] as Record<string, unknown>;
    await insertCompletionFixture(assignment);
    const before = await state();
    const counter = { calls: 0 };
    let faultReached = false;
    let callsAfterFault = 0;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          if (faultReached) callsAfterFault += 1;
          const queryResult = await tx.execute(statement);
          if (!faultReached && queryResult.rows.some((row) => Object.hasOwn(row, 'completion_id'))) {
            faultReached = true;
            return { ...queryResult, rows: queryResult.rows.map((row) => ({
              ...row, source: coercionTrap(counter),
            })) } as typeof queryResult;
          }
          return queryResult;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const corrupted = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => new Date('2026-08-31T02:00:00.000Z'),
    });

    await expect(corrupted.execute(desired)).rejects
      .toThrow('Task assignment completion history integrity check failed.');
    expect(faultReached).toBe(true);
    expect(callsAfterFault).toBe(0);
    expect(counter.calls).toBe(0);
    expect(await state()).toEqual(before);
  });

  it('preserves another student mirror exactly during a normal target assignment', async () => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    const createdAt = '2026-08-30T01:30:00.000Z';
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S002', $3)`,
    [harness.tenantOneId, task.task_instance_id, createdAt]);

    await command().execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000054' }));

    expect((await state()).mirrors).toEqual([
      expect.objectContaining({ student_id: 'S001' }),
      { task_instance_id: task.task_instance_id, student_id: 'S002', created_at: new Date(createdAt) },
    ]);
  });

  it('rejects and rolls back when a terminal trigger inserts a second operation audit', async () => {
    const before = await state();
    await harness.database.exec(`
      CREATE SEQUENCE extra_audit_fault_reached;
      GRANT USAGE, SELECT, UPDATE ON SEQUENCE extra_audit_fault_reached TO PUBLIC;
      CREATE FUNCTION extra_terminal_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id = 'abcdef00-0000-4000-8000-000000000056'
          AND NEW.status = 'SUCCEEDED' THEN
          PERFORM nextval('extra_audit_fault_reached');
          INSERT INTO audit_events
            (tenant_id, event_id, operation_id, event_type, entity_type, entity_id,
             redacted_details, occurred_at)
          SELECT tenant_id, 'fault:extra-audit', operation_id, event_type, entity_type, entity_id,
             redacted_details, occurred_at
          FROM audit_events WHERE tenant_id=NEW.tenant_id AND operation_id=NEW.operation_id;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER extra_terminal_audit_fault_trigger AFTER UPDATE ON operations
        FOR EACH ROW EXECUTE FUNCTION extra_terminal_audit_fault();
    `);

    await expect(command().execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000056',
    }))).rejects.toThrow(/audit.*integrity/i);
    expect((await harness.database.query(`SELECT last_value FROM extra_audit_fault_reached`)).rows)
      .toEqual([{ last_value: 1 }]);
    expect(await state()).toEqual(before);
  });

  it('rejects historical replay with an extra valid audit for the operation', async () => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000057' });
    await command().execute(desired);
    await harness.database.query(`INSERT INTO audit_events
      (tenant_id, event_id, operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at)
      SELECT tenant_id, 'tamper:extra-audit', operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at FROM audit_events
      WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, desired.operationId]);

    await expect(command().execute(desired)).rejects.toThrow(/audit.*integrity/i);
  });

  it.each([
    ['missing task', () => command(), () => input({ taskId: 'TASK-MISSING' })],
    ['missing student', () => command(), () => input({ studentId: 'S999' })],
    ['inactive student', () => command(), () => input({ studentId: 'S003' })],
    ['wrong tenant', () => command(harness.tenantTwoId), () => input()],
  ] as const)('rejects %s and leaves every tenant snapshot unchanged', async (_label, makeCommand, makeInput) => {
    const beforeOne = await state(harness.tenantOneId);
    const beforeTwo = await state(harness.tenantTwoId);
    await expect(makeCommand().execute(makeInput())).rejects.toThrow(/not found/i);
    expect(await state(harness.tenantOneId)).toEqual(beforeOne);
    expect(await state(harness.tenantTwoId)).toEqual(beforeTwo);
  });

  it('rejects a persisted non-Seoul schedule after claim and rolls the transaction back', async () => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    const schedule = {
      ruleVersion: 1,
      effectiveFrom: '2026-08-30T01:00:00.000Z',
      timeZone: 'America/New_York',
      recurrence: { type: 'DAILY', time: '09:00' },
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: false,
    };
    await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_current_schedule_check');
    await harness.database.query(`UPDATE tasks SET current_schedule=$3::jsonb, pending_schedule=NULL
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, task.task_instance_id, JSON.stringify(schedule)]);
    const before = await state();

    await expect(command().execute(input())).rejects.toThrow(/Asia\/Seoul|timezone/i);
    expect(await state()).toEqual(before);
  });

  it('assigns false to true with an exact mirror, bound event, operation, audit, and frozen result', async () => {
    const before = await state();
    const result = await command().execute(input());
    expect(result).toEqual({
      ok: true, operationId: OP_ASSIGN, action: 'ASSIGNMENT', completedAt: NOW.toISOString(),
      taskId: 'TASK-001', taskInstanceId: (before.tasks[0] as { task_instance_id: string }).task_instance_id,
      studentId: 'S001', assigned: true, changed: true,
      cycleId: expect.any(String), transitionEventId: expect.any(String), materializationEventIds: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.materializationEventIds)).toBe(true);

    const after = await state();
    expect(after.mirrors).toEqual([expect.objectContaining({ student_id: 'S001' })]);
    expect(after.assignments).toEqual([expect.objectContaining({
      assignment_id: result.transitionEventId, student_id: 'S001', event_type: 'ASSIGNED',
      source: 'ADMIN', previous_assignment_id: null, admin_operation_id: OP_ASSIGN,
      admin_operation_hash: createTaskAssignmentPayloadHash(input()), schema_version: 1, note: null,
    })]);
    expect(after.operations).toEqual([expect.objectContaining({
      operation_kind: 'TASK_ADMIN', payload_hash: createTaskAssignmentPayloadHash(input()),
      status: 'SUCCEEDED', attempt_count: '1', result_snapshot: result,
    })]);
    expect(after.audits).toEqual([expect.objectContaining({
      event_type: 'TASK_ADMIN_COMPLETED', entity_type: 'OPERATION', entity_id: OP_ASSIGN,
      redacted_details: expect.objectContaining({ action: 'ASSIGNMENT', taskCount: 1,
        materializationEventCount: 0, transitionEventCount: 1 }),
    })]);
    expect(after.completions).toEqual(before.completions);
  });

  it('unassigns true to false with exact mirror deletion and immediate predecessor', async () => {
    const first = await command().execute(input());
    const secondOperation = 'abcdef00-0000-4000-8000-000000000002';
    const later = new Date('2026-08-31T02:00:00.000Z');
    const result = await command(harness.tenantOneId, later).execute(input({
      operationId: secondOperation, assigned: false,
    }));
    expect(result).toEqual(expect.objectContaining({
      assigned: false, changed: true, transitionEventId: expect.any(String),
      materializationEventIds: [],
    }));
    const after = await state();
    expect(after.mirrors).toEqual([]);
    expect(after.assignments).toHaveLength(2);
    expect(after.assignments[1]).toEqual(expect.objectContaining({
      assignment_id: result.transitionEventId, event_type: 'UNASSIGNED', source: 'ADMIN',
      previous_assignment_id: first.transitionEventId, admin_operation_id: secondOperation,
    }));
  });

  it('repairs a missing assigned mirror before atomically unassigning it', async () => {
    const assigned = await command().execute(input());
    const taskInstanceId = assigned.taskInstanceId;
    await harness.database.query(`DELETE FROM task_allowed_students
      WHERE tenant_id=$1 AND task_instance_id=$2 AND student_id='S001'`,
    [harness.tenantOneId, taskInstanceId]);

    const operationId = 'abcdef00-0000-4000-8000-000000000045';
    const result = await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId, assigned: false,
    }));

    expect(result).toEqual(expect.objectContaining({ assigned: false, changed: true }));
    const after = await state();
    expect(after.mirrors).toEqual([]);
    expect(after.assignments).toHaveLength(2);
    expect(after.assignments[0]).toEqual(expect.objectContaining({
      assignment_id: assigned.transitionEventId, event_type: 'ASSIGNED',
    }));
    expect(after.assignments.filter((row) =>
      (row as { admin_operation_id: string | null }).admin_operation_id === operationId))
      .toEqual([expect.objectContaining({ event_type: 'UNASSIGNED' })]);
  });

  it.each(['ADMIN', 'QR'] as const)('supports %s no-op with zero bound events and strict replay', async (source) => {
    const operationId = source === 'ADMIN'
      ? 'abcdef00-0000-4000-8000-000000000003'
      : 'abcdef00-0000-4000-8000-000000000004';
    const desired = input({ operationId, assigned: false, source });
    const result = await command().execute(desired);
    expect(result).toEqual(expect.objectContaining({
      assigned: false, changed: false, transitionEventId: null, materializationEventIds: [],
    }));
    expect(Object.isFrozen(result)).toBe(true);
    await expect(command().execute(desired)).resolves.toEqual(result);
    await expect(command().execute({ ...desired, assigned: true })).rejects.toThrow(/conflict/i);

    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, $2, 'TASK-001', $3, $4, $5, $6, 1, 'Asia/Seoul', 'S001',
       'ASSIGNED', $7, NULL, $8, $9, $10, 1, NULL)`, [
      harness.tenantOneId, `injected:${source}`, result.taskInstanceId, result.cycleId,
      '2026-08-30T00:00:00.000Z', '2026-09-01T00:00:00.000Z', source, operationId,
      createTaskAssignmentPayloadHash(desired), NOW.toISOString(),
    ]);
    await expect(command().execute(desired)).rejects.toThrow(/operation-bound event integrity/i);
  });

  it('materializes implicit legacy and carry-forward assignments deterministically without duplicates', async () => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
    [harness.tenantOneId, task.task_instance_id, '2026-08-30T01:30:00.000Z']);
    const legacyInput = input({ operationId: 'abcdef00-0000-4000-8000-000000000006' });
    const legacy = await command().execute(legacyInput);
    expect(legacy).toEqual(expect.objectContaining({
      assigned: true, changed: false, transitionEventId: null,
      materializationEventIds: [expect.stringMatching(/^task-assignment-materialization:/)],
    }));
    let after = await state();
    expect(after.assignments).toEqual([expect.objectContaining({
      assignment_id: legacy.materializationEventIds[0], event_type: 'ASSIGNED', source: 'LEGACY_SEED',
      previous_assignment_id: null, admin_operation_id: null, admin_operation_hash: null,
    })]);

    const missingMaterializationRunner = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.some((row) => Object.hasOwn(row, 'assignment_id')
            && Object.hasOwn(row, 'event_sequence'))) return { ...result, rows: [] };
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const missingMaterializationReplay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction: missingMaterializationRunner, now: () => NOW,
    });
    await expect(missingMaterializationReplay.execute(legacyInput))
      .rejects.toThrow(/materialization event integrity/i);

    const noDuplicate = await command().execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000007',
    }));
    expect(noDuplicate.materializationEventIds).toEqual([]);
    expect((await state()).assignments).toHaveLength(1);

    await command(harness.tenantOneId, new Date('2026-09-01T01:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000008', assigned: true,
    }));
    after = await state();
    const carries = after.assignments.filter((row) =>
      (row as { source: string }).source === 'CARRY_FORWARD');
    expect(carries).toHaveLength(1);
    expect(carries[0]).toEqual(expect.objectContaining({
      event_type: 'ASSIGNED', previous_assignment_id: legacy.materializationEventIds[0],
      admin_operation_id: null, admin_operation_hash: null,
    }));
  });

  it.each([
    ['UNASSIGNED carry', (prior: Record<string, unknown>, carry: Record<string, unknown>) => {
      carry.event_type = 'UNASSIGNED';
    }],
    ['same-cycle predecessor', (prior: Record<string, unknown>, carry: Record<string, unknown>) => {
      carry.cycle_id = prior.cycle_id;
    }],
    ['non-assigned predecessor', (prior: Record<string, unknown>) => {
      prior.event_type = 'UNASSIGNED';
    }],
    ['wrong-task predecessor', (prior: Record<string, unknown>) => {
      prior.task_instance_id = 'wrong-task-instance';
    }],
    ['wrong-student predecessor', (prior: Record<string, unknown>) => {
      prior.student_id = 'S002';
    }],
    ['open predecessor cycle', (prior: Record<string, unknown>) => {
      prior.cycle_end_at = null;
    }],
    ['predecessor cycle ending after carry starts', (prior: Record<string, unknown>, carry: Record<string, unknown>) => {
      prior.cycle_end_at = new Date(new Date(String(carry.cycle_start_at)).getTime() + 1);
    }],
    ['predecessor created after carry', (prior: Record<string, unknown>, carry: Record<string, unknown>) => {
      prior.created_at = new Date(new Date(String(carry.created_at)).getTime() + 1);
    }],
  ] as const)('rejects a CARRY_FORWARD event with %s evidence', async (_label, corrupt) => {
    await command().execute(input());
    const carry = await command(harness.tenantOneId, new Date('2026-09-01T01:00:00.000Z'))
      .execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000040' }));
    expect(carry.materializationEventIds).toHaveLength(1);
    const before = await state();
    const corruptingRunner = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        let corrupted = false;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (!corrupted && result.rows.length === 2 && result.rows.every((row) =>
            Object.hasOwn(row, 'assignment_id') && Object.hasOwn(row, 'event_sequence'))) {
            corrupted = true;
            const rows = result.rows.map((row) => ({ ...row })) as Record<string, unknown>[];
            corrupt(rows[0], rows[1]);
            return { ...result, rows } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const corruptedCommand = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction: corruptingRunner,
      now: () => new Date('2026-09-01T02:00:00.000Z'),
    });

    await expect(corruptedCommand.execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000041',
    }))).rejects.toThrow(/carry-forward integrity/i);
    expect(await state()).toEqual(before);
  });

  it.each([
    ['ADMIN', 'cycle ID'], ['ADMIN', 'timezone'],
    ['QR', 'cycle ID'], ['QR', 'timezone'],
    ['LEGACY_SEED', 'cycle ID'], ['LEGACY_SEED', 'timezone'],
  ] as const)('rejects noncanonical %s history with a corrupt %s before writes', async (source, field) => {
    if (source === 'LEGACY_SEED') {
      const task = (await state()).tasks[0] as { task_instance_id: string };
      await harness.database.query(`INSERT INTO task_allowed_students
        (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
      [harness.tenantOneId, task.task_instance_id, '2026-08-30T01:30:00.000Z']);
      await command().execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000061' }));
    } else {
      await command().execute(input({
        operationId: 'abcdef00-0000-4000-8000-000000000061', source,
      }));
    }
    const before = await state();
    let faultReached = false;
    let callsAfterFault = 0;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          if (faultReached) callsAfterFault += 1;
          const result = await tx.execute(statement);
          if (!faultReached && result.rows.length > 0 && result.rows.every((row) =>
            Object.hasOwn(row, 'assignment_id') && Object.hasOwn(row, 'event_sequence'))) {
            faultReached = true;
            const rows = result.rows.map((value) => ({ ...value })) as Record<string, unknown>[];
            if (field === 'cycle ID') rows[0].cycle_id = 'noncanonical-cycle';
            else rows[0].timezone = 'Etc/UTC';
            return { ...result, rows } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const corrupted = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction,
      now: () => new Date('2026-08-31T02:00:00.000Z'),
    });

    await expect(corrupted.execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000062',
    }))).rejects.toThrow(/history.*integrity/i);
    expect(faultReached).toBe(true);
    expect(callsAfterFault).toBe(0);
    expect(await state()).toEqual(before);
  });

  it('rejects a later LEGACY_SEED after a prior physical assignment event', async () => {
    const first = await command().execute(input());
    const firstRow = (await state()).assignments[0] as Record<string, unknown>;
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, 'fixture:late-legacy', 'TASK-001', $2, $3, $4, $5, $6, 'Asia/Seoul',
       'S001', 'ASSIGNED', 'LEGACY_SEED', NULL, NULL, NULL, $7, 1, NULL)`, [
      harness.tenantOneId, first.taskInstanceId, firstRow.cycle_id, firstRow.cycle_start_at,
      firstRow.cycle_end_at, firstRow.rule_version, '2026-08-31T01:30:00.000Z',
    ]);
    const before = await state();

    await expect(command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000063',
    }))).rejects.toThrow(/history|predecessor.*integrity/i);
    expect(await state()).toEqual(before);
  });

  it('validates numeric assignment chains independently of adapter row order', async () => {
    await command().execute(input());
    await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000042', assigned: false,
    }));
    await command(harness.tenantOneId, new Date('2026-08-31T03:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000043', assigned: true,
    }));
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.length >= 3 && result.rows.every((row) =>
            Object.hasOwn(row, 'assignment_id') && Object.hasOwn(row, 'event_sequence'))) {
            return { ...result, rows: [...result.rows].reverse() } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const permuted = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction,
      now: () => new Date('2026-08-31T04:00:00.000Z'),
    });
    await expect(permuted.execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000044',
    }))).resolves.toEqual(expect.objectContaining({ assigned: true, changed: false }));
  });

  it('plans from the largest numeric same-cycle sequence independently of adapter row order', async () => {
    await command().execute(input());
    const latest = await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000058', assigned: false,
    }));
    const before = await state();
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.length === 2 && result.rows.every((row) =>
            Object.hasOwn(row, 'assignment_id') && Object.hasOwn(row, 'event_sequence'))) {
            return { ...result, rows: [...result.rows].reverse() } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const permuted = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction,
      now: () => new Date('2026-08-31T03:00:00.000Z'),
    });

    await expect(permuted.execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000059', assigned: false,
    }))).resolves.toEqual(expect.objectContaining({
      assigned: false, changed: false, transitionEventId: null,
    }));
    const after = await state();
    expect(after.assignments).toEqual(before.assignments);
    expect(after.assignments.at(-1)).toEqual(expect.objectContaining({
      assignment_id: latest.transitionEventId, event_type: 'UNASSIGNED',
    }));
  });

  it('rejects a carry that skips the latest effective predecessor while accepting the latest assigned', async () => {
    const first = await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000036',
    }));
    const unassigned = await command(harness.tenantOneId, new Date('2026-08-31T03:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000037', assigned: false,
    }));
    const secondStudent = await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000038', studentId: 'S002',
    }));
    const validCarry = await command(harness.tenantOneId, new Date('2026-09-01T01:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000039', studentId: 'S002',
    }));
    const afterValidCarry = await state();
    expect(afterValidCarry.assignments.find((row) =>
      (row as { assignment_id: string }).assignment_id === validCarry.materializationEventIds[0]))
      .toEqual(expect.objectContaining({
        source: 'CARRY_FORWARD', previous_assignment_id: secondStudent.transitionEventId,
      }));

    const validCarryRow = afterValidCarry.assignments.find((row) =>
      (row as { assignment_id: string }).assignment_id === validCarry.materializationEventIds[0]) as
      Record<string, unknown>;
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, 'fixture:skipped-effective-predecessor', 'TASK-001', $2, $3, $4, $5, $6,
       'Asia/Seoul', 'S001', 'ASSIGNED', 'CARRY_FORWARD', $7, NULL, NULL, $8, 1, NULL)`, [
      harness.tenantOneId, first.taskInstanceId, validCarryRow.cycle_id,
      validCarryRow.cycle_start_at, validCarryRow.cycle_end_at, validCarryRow.rule_version,
      first.transitionEventId, '2026-09-01T01:30:00.000Z',
    ]);
    const before = await state();
    expect(before.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ assignment_id: first.transitionEventId, event_type: 'ASSIGNED' }),
      expect.objectContaining({ assignment_id: unassigned.transitionEventId, event_type: 'UNASSIGNED',
        previous_assignment_id: first.transitionEventId }),
      expect.objectContaining({ assignment_id: 'fixture:skipped-effective-predecessor',
        source: 'CARRY_FORWARD', previous_assignment_id: first.transitionEventId }),
    ]));

    await expect(command(harness.tenantOneId, new Date('2026-09-01T02:00:00.000Z')).execute(input({
      assigned: false,
    }))).rejects.toThrow(/carry-forward integrity/i);
    expect(await state()).toEqual(before);
  });

  it.each([
    [false, 'abcdef00-0000-4000-8000-000000000064'],
    [true, 'abcdef00-0000-4000-8000-000000000065'],
  ] as const)('does not transition-carry a same-rule closed-cycle assignment for desired %s',
  async (assigned, operationId) => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    const transitionStart = '2026-08-31T03:30:00.000Z';
    const changedSchedule = {
      ruleVersion: 2,
      effectiveFrom: transitionStart,
      timeZone: 'Asia/Seoul',
      recurrence: { type: 'DAILY', time: '12:30' },
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: true,
    };
    await harness.database.query(`UPDATE tasks SET pending_schedule=$3::jsonb
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, task.task_instance_id, JSON.stringify(changedSchedule)]);
    const priorStart = '2026-08-30T03:30:00.000Z';
    const priorCycleId = `v1|${task.task_instance_id}|r2|2026-08-30T03:30:00Z`;
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, 'fixture:same-rule-prior', 'TASK-001', $2, $3, $4, $5, 2,
       'Asia/Seoul', 'S001', 'ASSIGNED', 'LEGACY_SEED', NULL, NULL, NULL, $6, 1, NULL)`, [
      harness.tenantOneId, task.task_instance_id, priorCycleId, priorStart, transitionStart,
      '2026-08-30T04:00:00.000Z',
    ]);
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
    [harness.tenantOneId, task.task_instance_id, '2026-08-30T04:00:00.000Z']);

    const result = await command(harness.tenantOneId, new Date(transitionStart)).execute(input({
      operationId, assigned,
    }));

    expect(result.materializationEventIds).toEqual([]);
    expect(result).toEqual(expect.objectContaining({
      assigned, changed: assigned, transitionEventId: assigned ? expect.any(String) : null,
    }));
    const after = await state();
    expect(after.assignments.filter((row) =>
      (row as { source: string }).source === 'CARRY_FORWARD')).toEqual([]);
    if (assigned) {
      expect(after.assignments.at(-1)).toEqual(expect.objectContaining({
        assignment_id: result.transitionEventId, source: 'ADMIN', event_type: 'ASSIGNED',
        previous_assignment_id: null,
      }));
    } else {
      expect(after.assignments).toHaveLength(1);
      expect(after.mirrors).toEqual([]);
    }
  });

  it('carries an old-rule assignment into the immediate changed-rule cycle despite reset', async () => {
    const old = await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z'))
      .execute(input());
    const task = (await state()).tasks[0] as { task_instance_id: string };
    const changedSchedule = {
      ruleVersion: 2,
      effectiveFrom: '2026-08-31T03:30:00.000Z',
      timeZone: 'Asia/Seoul',
      recurrence: { type: 'DAILY', time: '10:00' },
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: true,
    };
    await harness.database.query(`UPDATE tasks SET pending_schedule=$3::jsonb
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, task.task_instance_id, JSON.stringify(changedSchedule)]);

    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000030' });
    const result = await command(harness.tenantOneId, new Date('2026-08-31T03:30:00.000Z'))
      .execute(desired);

    expect(result).toEqual(expect.objectContaining({
      assigned: true, changed: false, transitionEventId: null,
      cycleId: expect.stringContaining('|r2|2026-08-31T03:30:00Z'),
      materializationEventIds: [expect.stringMatching(/^task-assignment-materialization:/)],
    }));
    const after = await state();
    expect(after.mirrors).toEqual([expect.objectContaining({ student_id: 'S001' })]);
    expect(after.assignments).toHaveLength(2);
    expect(after.assignments[1]).toEqual(expect.objectContaining({
      assignment_id: result.materializationEventIds[0], cycle_id: result.cycleId,
      cycle_start_at: new Date(changedSchedule.effectiveFrom), rule_version: 2,
      event_type: 'ASSIGNED', source: 'CARRY_FORWARD',
      previous_assignment_id: old.transitionEventId, admin_operation_id: null,
    }));

    await expect(command(harness.tenantOneId, new Date('2026-08-31T04:30:00.000Z'))
      .execute(desired)).resolves.toEqual(result);
    const later = await command(harness.tenantOneId, new Date('2026-08-31T05:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000031',
    }));
    expect(later.materializationEventIds).toEqual([]);
    expect((await state()).assignments).toHaveLength(2);
  });

  it('carries an assignment across a same-start immediate rule transition despite reset', async () => {
    const transitionStart = new Date('2026-08-31T00:00:00.000Z');
    const old = await command(harness.tenantOneId, new Date('2026-08-31T00:30:00.000Z'))
      .execute(input());
    const beforeScheduleChange = await state();
    expect(beforeScheduleChange.assignments[0]).toEqual(expect.objectContaining({
      assignment_id: old.transitionEventId, cycle_start_at: transitionStart,
      cycle_end_at: new Date('2026-09-01T00:00:00.000Z'), rule_version: 1,
    }));
    const task = beforeScheduleChange.tasks[0] as { task_instance_id: string };
    const changedSchedule = {
      ruleVersion: 2,
      effectiveFrom: transitionStart.toISOString(),
      timeZone: 'Asia/Seoul',
      recurrence: { type: 'DAILY', time: '09:00' },
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: true,
    };
    await harness.database.query(`UPDATE tasks SET pending_schedule=$3::jsonb
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, task.task_instance_id, JSON.stringify(changedSchedule)]);

    const result = await command(harness.tenantOneId, new Date('2026-08-31T01:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000035',
    }));

    expect(result).toEqual(expect.objectContaining({
      assigned: true, changed: false, transitionEventId: null,
      cycleId: expect.stringContaining('|r2|2026-08-31T00:00:00Z'),
      materializationEventIds: [expect.stringMatching(/^task-assignment-materialization:/)],
    }));
    const after = await state();
    expect(after.assignments).toHaveLength(2);
    expect(after.assignments[1]).toEqual(expect.objectContaining({
      assignment_id: result.materializationEventIds[0], cycle_start_at: transitionStart,
      rule_version: 2, event_type: 'ASSIGNED', source: 'CARRY_FORWARD',
      previous_assignment_id: old.transitionEventId, admin_operation_id: null,
    }));
  });

  it('resets the mirror at the next natural cycle and binds a fresh assignment without carry', async () => {
    const old = await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z'))
      .execute(input());
    const task = (await state()).tasks[0] as { task_instance_id: string };
    const changedSchedule = {
      ruleVersion: 2,
      effectiveFrom: '2026-08-31T03:30:00.000Z',
      timeZone: 'Asia/Seoul',
      recurrence: { type: 'DAILY', time: '10:00' },
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: true,
    };
    await harness.database.query(`UPDATE tasks SET pending_schedule=$3::jsonb
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, task.task_instance_id, JSON.stringify(changedSchedule)]);
    const changedCycle = await command(harness.tenantOneId, new Date('2026-08-31T03:30:00.000Z'))
      .execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000032' }));
    expect(changedCycle.materializationEventIds).toHaveLength(1);

    const reset = await command(harness.tenantOneId, new Date('2026-09-01T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000033', assigned: false,
    }));
    expect(reset).toEqual(expect.objectContaining({
      assigned: false, changed: false, transitionEventId: null,
      cycleId: expect.stringContaining('|r2|2026-09-01T01:00:00Z'),
      materializationEventIds: [],
    }));
    let after = await state();
    expect(after.mirrors).toEqual([]);
    expect(after.assignments.map((row) => (row as { assignment_id: string }).assignment_id))
      .toEqual([old.transitionEventId, changedCycle.materializationEventIds[0]]);

    const reassigned = await command(harness.tenantOneId, new Date('2026-09-01T03:00:00.000Z'))
      .execute(input({ operationId: 'abcdef00-0000-4000-8000-000000000034' }));
    expect(reassigned).toEqual(expect.objectContaining({
      assigned: true, changed: true, cycleId: reset.cycleId,
      transitionEventId: expect.any(String), materializationEventIds: [],
    }));
    after = await state();
    expect(after.mirrors).toEqual([expect.objectContaining({ student_id: 'S001' })]);
    expect(after.assignments).toHaveLength(3);
    expect(after.assignments[2]).toEqual(expect.objectContaining({
      assignment_id: reassigned.transitionEventId, cycle_id: reset.cycleId,
      cycle_start_at: new Date('2026-09-01T01:00:00.000Z'), rule_version: 2,
      event_type: 'ASSIGNED', source: 'ADMIN', previous_assignment_id: null,
      admin_operation_id: 'abcdef00-0000-4000-8000-000000000034',
    }));
  });

  it('rejects a getter-backed materialization ID index without invoking it', async () => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000048', assigned: false });
    await command().execute(desired);
    let getterCalls = 0;
    const ids: string[] = [];
    Object.defineProperty(ids, '0', { enumerable: true, configurable: true,
      get: () => { getterCalls += 1; return 'event'; } });
    Object.defineProperty(ids, 'length', { value: 1, writable: true, configurable: false });
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.length === 1 && Object.hasOwn(result.rows[0], 'result_snapshot')) {
            const operation = { ...result.rows[0] } as Record<string, unknown>;
            operation.result_snapshot = {
              ...(operation.result_snapshot as Record<string, unknown>), materializationEventIds: ids,
            };
            return { ...result, rows: [operation] } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const replay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });
    await expect(replay.execute(desired)).rejects.toThrow(/stored result/i);
    expect(getterCalls).toBe(0);
  });

  it.each([
    ['sparse', () => new Array(1) as string[]],
    ['extra enumerable key', () => Object.assign([] as string[], { extra: true })],
    ['symbol key', () => Object.assign([] as string[], { [Symbol('extra')]: true })],
    ['duplicate IDs', () => ['event', 'event']],
    ['noncanonical order', () => ['event:b', 'event:a']],
  ] as const)('rejects a %s materialization ID array before domain reads', async (_label, makeIds) => {
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000049', assigned: false });
    await command().execute(desired);
    let assignmentReads = 0;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.some((row) => Object.hasOwn(row, 'assignment_id'))) assignmentReads += 1;
          if (result.rows.length === 1 && Object.hasOwn(result.rows[0], 'result_snapshot')) {
            const operation = { ...result.rows[0] } as Record<string, unknown>;
            operation.result_snapshot = {
              ...(operation.result_snapshot as Record<string, unknown>), materializationEventIds: makeIds(),
            };
            return { ...result, rows: [operation] } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const replay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });
    await expect(replay.execute(desired)).rejects.toThrow(/stored result/i);
    expect(assignmentReads).toBe(0);
  });

  it.each([
    ['multiple materializations', (snapshot: Record<string, unknown>, materializationId: string) => {
      snapshot.materializationEventIds = [materializationId, 'zz-extra-materialization'];
    }],
    ['materialized assigned-false no-op', (snapshot: Record<string, unknown>) => {
      snapshot.changed = false;
      snapshot.transitionEventId = null;
    }],
  ] as const)('rejects frozen result with %s before assignment history access', async (_label, tamper) => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
    [harness.tenantOneId, task.task_instance_id, '2026-08-30T01:30:00.000Z']);
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000055', assigned: false });
    const frozen = await command().execute(desired);
    expect(frozen.materializationEventIds).toHaveLength(1);
    let assignmentReads = 0;
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.some((row) => Object.hasOwn(row, 'assignment_id'))) assignmentReads += 1;
          if (result.rows.length === 1 && Object.hasOwn(result.rows[0], 'result_snapshot')) {
            const operation = { ...result.rows[0] } as Record<string, unknown>;
            const snapshot = { ...(operation.result_snapshot as Record<string, unknown>) };
            tamper(snapshot, frozen.materializationEventIds[0]);
            operation.result_snapshot = snapshot;
            return { ...result, rows: [operation] } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const replay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });

    await expect(replay.execute(desired)).rejects.toThrow(/stored result/i);
    expect(assignmentReads).toBe(0);
  });

  it.each([
    ['cycle_start_at', (row: Record<string, unknown>) => {
      row.cycle_start_at = new Date(new Date(String(row.cycle_start_at)).getTime() + 1);
    }],
    ['cycle_end_at', (row: Record<string, unknown>) => {
      row.cycle_end_at = new Date(new Date(String(row.cycle_end_at)).getTime() + 1);
    }],
    ['rule_version', (row: Record<string, unknown>) => { row.rule_version = 2; }],
    ['timezone', (row: Record<string, unknown>) => { row.timezone = 'Etc/UTC'; }],
    ['created_at', (row: Record<string, unknown>) => {
      row.created_at = new Date(new Date(String(row.created_at)).getTime() + 1);
    }],
  ] as const)('rejects replay with tampered materialization %s', async (_field, tamper) => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
    [harness.tenantOneId, task.task_instance_id, '2026-08-30T01:30:00.000Z']);
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000046', assigned: false });
    const frozen = await command().execute(desired);
    expect(frozen.materializationEventIds).toHaveLength(1);
    expect(frozen.transitionEventId).not.toBeNull();
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.length >= 1 && result.rows.every((row) =>
            Object.hasOwn(row, 'assignment_id') && Object.hasOwn(row, 'event_sequence'))) {
            const rows = result.rows.map((value) => {
              const row = { ...value } as Record<string, unknown>;
              if (row.assignment_id === frozen.materializationEventIds[0]) tamper(row);
              return row;
            });
            return { ...result, rows } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const replay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });
    await expect(replay.execute(desired)).rejects.toThrow(/integrity/i);
  });

  it.each([
    ['cycle_start_at', (row: Record<string, unknown>) => {
      row.cycle_start_at = new Date(new Date(String(row.cycle_start_at)).getTime() + 1);
    }],
    ['cycle_end_at', (row: Record<string, unknown>) => {
      row.cycle_end_at = new Date(new Date(String(row.cycle_end_at)).getTime() + 1);
    }],
    ['rule_version', (row: Record<string, unknown>) => { row.rule_version = 2; }],
    ['timezone', (row: Record<string, unknown>) => { row.timezone = 'Etc/UTC'; }],
    ['created_at', (row: Record<string, unknown>) => {
      row.created_at = new Date(new Date(String(row.created_at)).getTime() + 1);
    }],
  ] as const)('rejects replay with tampered transition %s', async (_field, tamper) => {
    const task = (await state()).tasks[0] as { task_instance_id: string };
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S001', $3)`,
    [harness.tenantOneId, task.task_instance_id, '2026-08-30T01:30:00.000Z']);
    const desired = input({ operationId: 'abcdef00-0000-4000-8000-000000000047', assigned: false });
    const frozen = await command().execute(desired);
    expect(frozen.materializationEventIds).toHaveLength(1);
    expect(frozen.transitionEventId).not.toBeNull();
    const runTenantTransaction = async <T,>(tenantId: string,
      callback: (transaction: Parameters<Parameters<typeof harness.runTenantTransaction>[1]>[0]) => Promise<T>) =>
      harness.runTenantTransaction(tenantId, async (tx) => {
        const adapter = Object.create(tx) as typeof tx;
        adapter.execute = (async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          if (result.rows.length >= 1 && result.rows.every((row) =>
            Object.hasOwn(row, 'assignment_id') && Object.hasOwn(row, 'event_sequence'))) {
            const rows = result.rows.map((value) => {
              const row = { ...value } as Record<string, unknown>;
              if (row.assignment_id === frozen.transitionEventId) tamper(row);
              return row;
            });
            return { ...result, rows } as typeof result;
          }
          return result;
        }) as typeof tx.execute;
        return callback(adapter);
      });
    const replay = createDatabaseTaskAssignmentCommand({
      tenantId: harness.tenantOneId, runTenantTransaction, now: () => NOW,
    });
    await expect(replay.execute(desired)).rejects.toThrow(/integrity/i);
  });

  it('persists natural assignment and completion carry before applying the desired assignment', async () => {
    const seedNow = new Date('2026-08-30T01:00:00.000Z');
    await command(harness.tenantOneId, seedNow).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000050',
    }));
    const seeded = (await state()).assignments[0] as Record<string, unknown>;
    await harness.database.query(`UPDATE tasks
      SET current_schedule=current_schedule || '{"resetCompletionOnCycle":false}'::jsonb
      WHERE tenant_id=$1 AND task_id='TASK-001'`, [harness.tenantOneId]);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, schema_version, created_at)
      VALUES ($1, 'natural-prior-success', '2026-08-30T02:00:00.000Z', $2, 'TASK-001',
       '과제', 'S001', '하나', 0, 40, 40, 'COMPLETED', NULL, $3, $4, $5, 1,
       'Asia/Seoul', 'CARRY_FORWARD', $6, 1, '2026-08-30T02:00:00.000Z')`, [
      harness.tenantOneId, seeded.task_instance_id, seeded.cycle_id,
      seeded.cycle_start_at, seeded.cycle_end_at, seeded.assignment_id,
    ]);

    const result = await command().execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000051',
    }));
    const snapshot = await state();
    expect(result.changed).toBe(false);
    expect(snapshot.assignments.filter((row) =>
      (row as Record<string, unknown>).cycle_id === result.cycleId)).toHaveLength(1);
    const carried = await harness.database.query(`SELECT source, status,
      reward_snapshot::text AS reward_snapshot, balance_before::text AS balance_before,
      balance_after::text AS balance_after FROM task_completions
      WHERE tenant_id=$1 AND cycle_id=$2`, [harness.tenantOneId, result.cycleId]);
    expect(carried.rows).toEqual([{ source: 'CARRY_FORWARD', status: 'COMPLETED',
      reward_snapshot: '0', balance_before: '40', balance_after: '40' }]);
  });

  it.each([
    { label: 'removed mirror', now: new Date('2026-08-31T02:00:00.000Z'),
      prepare: async () => harness.database.query(
        `DELETE FROM task_allowed_students WHERE tenant_id=$1`, [harness.tenantOneId]) },
    { label: 'unavailable task', now: new Date('2026-08-31T02:00:00.000Z'),
      prepare: async () => harness.database.query(
        `UPDATE tasks SET due_at='2026-08-30T23:00:00.000Z'
         WHERE tenant_id=$1 AND task_id='TASK-001'`, [harness.tenantOneId]) },
    { label: 'skipped natural cycle', now: new Date('2026-09-01T02:00:00.000Z'),
      prepare: async () => undefined },
    { label: 'exact-end lower-rule configuration boundary',
      now: new Date('2026-08-31T00:00:00.000Z'),
      prepare: async () => harness.database.query(`UPDATE tasks SET pending_schedule=$2::jsonb
        WHERE tenant_id=$1 AND task_id='TASK-001'`, [harness.tenantOneId, JSON.stringify({
        ruleVersion: 2, effectiveFrom: '2026-08-31T00:00:00.000Z', timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: false,
        resetAssignmentOnCycle: false,
      })]) },
    { label: 'stale configuration boundary', now: new Date('2026-09-01T00:00:00.000Z'),
      prepare: async () => harness.database.query(`UPDATE tasks SET pending_schedule=$2::jsonb
        WHERE tenant_id=$1 AND task_id='TASK-001'`, [harness.tenantOneId, JSON.stringify({
        ruleVersion: 2, effectiveFrom: '2026-09-01T00:00:00.000Z', timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY', time: '09:00' }, resetCompletionOnCycle: false,
        resetAssignmentOnCycle: false,
      })]) },
  ])('does not resurrect $label assignment state', async ({ now, prepare }) => {
    await command(harness.tenantOneId, new Date('2026-08-30T01:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000052',
    }));
    await prepare();
    const result = await command(harness.tenantOneId, now).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000152', assigned: false,
    }));
    expect(result.changed).toBe(false);
    expect(result.materializationEventIds).toEqual([]);
    const snapshot = await state();
    expect(snapshot.assignments.some((row) =>
      (row as Record<string, unknown>).source === 'CARRY_FORWARD')).toBe(false);
    expect(snapshot.mirrors).toEqual([]);
  });

  it('replays a frozen assignment after a later valid change', async () => {
    const first = await command().execute(input());
    await command(harness.tenantOneId, new Date('2026-08-31T02:00:00.000Z')).execute(input({
      operationId: 'abcdef00-0000-4000-8000-000000000005', assigned: false, source: 'QR',
    }));
    const replay = await command(harness.tenantOneId, new Date('2026-08-31T03:00:00.000Z'))
      .execute(input());
    expect(replay).toEqual(first);
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay.materializationEventIds)).toBe(true);
  });
});
