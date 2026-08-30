import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseTaskAdminCommands,
  createTaskAdminAssignmentEventId,
  createTaskAdminPayloadHash,
  createTaskAdminResultHash,
  createTaskAdminTaskInstanceId,
  type CreateTaskAdminInput,
  type DeleteTaskAdminInput,
  type TaskAdminUpdateSuccess,
  type UpdateTasksAdminBatchInput,
  type UpdateTaskAdminInput,
} from './taskAdminCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-30T01:00:00.000Z');
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
});

afterEach(async () => harness.close());

const createInput = (overrides: Partial<CreateTaskAdminInput> = {}): CreateTaskAdminInput => ({
  operationId: ' task-admin-create-op ',
  taskId: ' TASK-001 ',
  title: ' 첫 과제 ',
  description: ' 설명 ',
  reward: 100,
  isActive: true,
  sortOrder: 2,
  allowedStudentIds: [' S002 ', 'S001'],
  availableFrom: '2026-08-30T00:00:00.000Z',
  dueAt: '2026-09-01T00:00:00.000Z',
  prerequisiteTaskId: null,
  padletBoardId: 'AbCdEfGhIjKlMnOp',
  schedule: {
    recurrence: { type: 'WEEKLY' as const, time: '09:00', weekdays: [5, 1] as const },
    timeZone: 'Asia/Seoul' as const,
    resetCompletionOnCycle: true,
    resetAssignmentOnCycle: false,
  },
  ...overrides,
});

const commands = (tenantId = harness.tenantOneId) => createDatabaseTaskAdminCommands({
  tenantId,
  runTenantTransaction: harness.runTenantTransaction,
  now: () => NOW,
});

const updateInput = (overrides: Partial<UpdateTaskAdminInput> = {}): UpdateTaskAdminInput => ({
  operationId: 'task-admin-update-op', taskId: 'TASK-001', expectedTaskVersion: 1,
  title: '수정 과제', description: '수정 설명', reward: 250, isActive: false,
  sortOrder: 9, allowedStudentIds: ['S002'], availableFrom: null, dueAt: null,
  prerequisiteTaskId: null, padletBoardId: null, ...overrides,
});

const updateBatchEntry = (overrides: Partial<UpdateTaskAdminInput> = {}):
UpdateTasksAdminBatchInput['tasks'][number] => {
  const entry = { ...updateInput(overrides) } as Record<string, unknown>;
  delete entry.operationId;
  return entry as UpdateTasksAdminBatchInput['tasks'][number];
};

const deleteInput = (overrides: Partial<DeleteTaskAdminInput> = {}): DeleteTaskAdminInput => ({
  operationId: 'task-admin-delete-op', taskId: 'TASK-001', expectedTaskVersion: 1,
  ...overrides,
});

async function appendLaterSameCycleAssignment(
  taskInstanceId: string,
  studentId: string,
  assignmentId: string,
  createdAt = NOW.toISOString(),
  eventType: 'ASSIGNED' | 'UNASSIGNED' = 'ASSIGNED',
  source: 'ADMIN' | 'QR' = 'ADMIN',
) {
  const task = await harness.database.query(
    `SELECT task_id, current_schedule, created_at FROM tasks
     WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, taskInstanceId],
  );
  const row = task.rows[0] as {
    task_id: string;
    current_schedule: Parameters<typeof getTaskCycle>[0]['schedule'];
    created_at: Date;
  };
  const cycle = getTaskCycle({ taskInstanceId, schedule: row.current_schedule,
    taskCreatedAt: row.created_at.toISOString(), now: NOW.toISOString() });
  const operationId = `${assignmentId}-operation`;
  const operationHash = 'a'.repeat(64);
  const previous = await harness.database.query(`SELECT assignment_id FROM task_assignments
    WHERE tenant_id=$1 AND task_instance_id=$2 AND student_id=$3
    ORDER BY event_sequence DESC LIMIT 1`, [harness.tenantOneId, taskInstanceId, studentId]);
  const previousAssignmentId = (previous.rows[0] as { assignment_id?: string } | undefined)
    ?.assignment_id ?? null;
  await harness.database.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
     started_at, created_at, updated_at)
    VALUES ($1, $2, 'TASK_ADMIN', $3, 'PENDING', 1, $4, $4, $4)`,
  [harness.tenantOneId, operationId, operationHash, createdAt]);
  await harness.database.query(`INSERT INTO task_assignments
    (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
     cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
     source, previous_assignment_id, admin_operation_id, admin_operation_hash,
     created_at, schema_version, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'Asia/Seoul', $8, $9,
            $10, $11, $12, $13, $14, 1, NULL)`,
  [harness.tenantOneId, assignmentId, row.task_id, taskInstanceId, cycle.cycleId,
    cycle.startsAt, cycle.endsAt, studentId, eventType, source, previousAssignmentId, operationId,
    operationHash, createdAt]);
}

async function seedCarryForwardCompletion(taskInstanceId: string, completionId = 'existing-completion') {
  await harness.database.query(`INSERT INTO task_completions
    (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
     task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
     balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
     rule_version, timezone, source, assignment_id, schema_version, created_at)
    SELECT tenant_id, $3, $4, task_instance_id, task_id_snapshot,
     'immutable task name', student_id, '하나', 0, 0, 0, 'COMPLETED', 'immutable note',
     cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, 'CARRY_FORWARD',
     assignment_id, 1, $4
    FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2
    ORDER BY event_sequence LIMIT 1`,
  [harness.tenantOneId, taskInstanceId, completionId, NOW.toISOString()]);
}

async function snapshot(tenantId = harness.tenantOneId) {
  const [tasks, mirrors, assignments, operations, audits] = await Promise.all([
    harness.database.query(`SELECT task_instance_id, task_id, title, description, reward::text,
      is_active, sort_order, available_from, available_until, due_at,
      prerequisite_task_instance_id, padlet_board_id, current_schedule, pending_schedule,
      schedule_schema_version, version::text, created_at, updated_at, deleted_at
      FROM tasks WHERE tenant_id=$1 ORDER BY task_id`, [tenantId]),
    harness.database.query(`SELECT task_instance_id, student_id, created_at
      FROM task_allowed_students WHERE tenant_id=$1 ORDER BY student_id`, [tenantId]),
    harness.database.query(`SELECT assignment_id, task_id_snapshot, task_instance_id, cycle_id,
      cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
      previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
      schema_version, note FROM task_assignments WHERE tenant_id=$1 ORDER BY student_id`, [tenantId]),
    harness.database.query(`SELECT operation_id, operation_kind, payload_hash, status,
      result_snapshot, started_at, finished_at FROM operations WHERE tenant_id=$1`, [tenantId]),
    harness.database.query(`SELECT operation_id, event_type, entity_type, entity_id,
      redacted_details, occurred_at FROM audit_events WHERE tenant_id=$1`, [tenantId]),
  ]);
  return { tasks: tasks.rows, mirrors: mirrors.rows, assignments: assignments.rows,
    operations: operations.rows, audits: audits.rows };
}

async function completeSnapshot(tenantId = harness.tenantOneId) {
  const state = await snapshot(tenantId);
  const completions = await harness.database.query(`SELECT to_jsonb(c)::text AS snapshot
    FROM task_completions c WHERE tenant_id=$1 ORDER BY event_sequence`, [tenantId]);
  return { ...state, completions: completions.rows };
}

describe('database task administrator CREATE command', () => {
  it('atomically creates canonical task, mirror, initial assignment events, operation and audit', async () => {
    const input = createInput();
    const result = await commands().create(input);
    const taskInstanceId = createTaskAdminTaskInstanceId('task-admin-create-op', 'TASK-001');
    const assignmentEventIds = ['S001', 'S002'].map((studentId) =>
      createTaskAdminAssignmentEventId('task-admin-create-op', 'TASK-001', studentId));
    expect(result).toEqual({
      ok: true, operationId: 'task-admin-create-op', action: 'CREATE',
      completedAt: NOW.toISOString(), tasks: [{ taskId: 'TASK-001', taskInstanceId,
        versionBefore: null, versionAfter: 1, assignmentEventIds }],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tasks)).toBe(true);
    expect(Object.isFrozen(result.tasks[0].assignmentEventIds)).toBe(true);

    const state = await snapshot();
    expect(state.tasks).toEqual([expect.objectContaining({
      task_instance_id: taskInstanceId, task_id: 'TASK-001', title: '첫 과제',
      description: '설명', reward: '100', schedule_schema_version: 1, version: '1',
      current_schedule: expect.objectContaining({
        ruleVersion: 1, effectiveFrom: NOW.toISOString(), timeZone: 'Asia/Seoul',
        recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1, 5] },
      }),
    })]);
    expect(state.mirrors.map((row) => (row as { student_id: string }).student_id)).toEqual(['S001', 'S002']);
    expect(state.assignments).toHaveLength(2);
    expect(state.assignments).toEqual(expect.arrayContaining(assignmentEventIds.map((assignmentId) =>
      expect.objectContaining({ assignment_id: assignmentId, event_type: 'ASSIGNED', source: 'ADMIN',
        admin_operation_id: 'task-admin-create-op', schema_version: 1 }))));
    const payloadHash = createTaskAdminPayloadHash(input);
    expect(state.operations).toEqual([expect.objectContaining({
      operation_kind: 'TASK_ADMIN', payload_hash: payloadHash, status: 'SUCCEEDED', result_snapshot: result,
    })]);
    expect(state.audits).toEqual([expect.objectContaining({
      event_type: 'TASK_ADMIN_COMPLETED', entity_type: 'OPERATION', entity_id: 'task-admin-create-op',
      redacted_details: { action: 'CREATE', taskCount: 1, assignmentEventCount: 2,
        resultHash: createTaskAdminResultHash(result) },
    })]);
  });

  it('supports a NONE schedule, empty allowed students, and a live prerequisite', async () => {
    const prerequisite = await commands().create({
      ...createInput(), operationId: 'prerequisite-op', taskId: 'BASE', allowedStudentIds: [],
      availableFrom: undefined, dueAt: undefined, prerequisiteTaskId: undefined, padletBoardId: undefined,
      schedule: { recurrence: { type: 'NONE' }, timeZone: 'Asia/Seoul',
        resetCompletionOnCycle: false, resetAssignmentOnCycle: false },
    });
    const result = await commands().create({
      ...createInput(), operationId: 'dependent-op', taskId: 'DEPENDENT', allowedStudentIds: [],
      prerequisiteTaskId: ' BASE ', padletBoardId: null,
    });
    expect(result.tasks[0].assignmentEventIds).toEqual([]);
    const state = await snapshot();
    expect(state.tasks).toEqual(expect.arrayContaining([expect.objectContaining({
      task_id: 'DEPENDENT', prerequisite_task_instance_id: prerequisite.tasks[0].taskInstanceId,
    })]));
    expect(state.assignments).toEqual([]);
  });

  it('rejects an inactive prerequisite and rolls back CREATE before domain writes', async () => {
    await commands().create({
      ...createInput(), operationId: 'inactive-prerequisite-op', taskId: 'INACTIVE-BASE',
      isActive: false, allowedStudentIds: [],
    });
    const before = await completeSnapshot();

    await expect(commands().create({
      ...createInput(), operationId: 'inactive-dependent-op', taskId: 'DEPENDENT',
      prerequisiteTaskId: 'INACTIVE-BASE', allowedStudentIds: [],
    })).rejects.toThrow(/prerequisite.*active|active.*prerequisite/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('rejects malformed values and unsafe shapes before transaction entry', async () => {
    let calls = 0;
    const preflight = createDatabaseTaskAdminCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); },
      now: () => NOW,
    });
    const getter = { ...createInput() } as Record<string, unknown>;
    Object.defineProperty(getter, 'title', { enumerable: true, get: () => 'unsafe' });
    const symbol = { ...createInput(), [Symbol('extra')]: true };
    const invalid = [
      { ...createInput(), extra: true }, getter, symbol,
      { ...createInput(), reward: -1 }, { ...createInput(), reward: Number.MAX_SAFE_INTEGER + 1 },
      { ...createInput(), sortOrder: 2147483648 },
      { ...createInput(), allowedStudentIds: [' S001 ', 'S001'] },
      { ...createInput(), dueAt: '2020-01-01T00:00:00.000Z' },
      { ...createInput(), padletBoardId: 'bad' },
      { ...createInput(), schedule: { ...createInput().schedule, extra: true } },
      { ...createInput(), schedule: { ...createInput().schedule,
        recurrence: { type: 'WEEKLY', time: '25:00', weekdays: [1] } } },
      { ...createInput(), schedule: { ...createInput().schedule,
        recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1, 1] } } },
    ];
    for (const value of invalid) await expect(preflight.create(value as never)).rejects.toThrow();
    const badClock = createDatabaseTaskAdminCommands({
      tenantId: harness.tenantOneId, runTenantTransaction: preflight.create as never,
      now: () => new Date(Number.NaN),
    });
    await expect(badClock.create(createInput())).rejects.toThrow(/timestamp.*invalid/i);
    expect(calls).toBe(0);
  });

  it('rolls back duplicate, missing prerequisite, and invalid student targets', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const before = await snapshot();
    await expect(commands().create({ ...createInput(), operationId: 'duplicate-op' }))
      .rejects.toThrow(/duplicate/i);
    await expect(commands().create({ ...createInput(), operationId: 'missing-prereq-op', taskId: 'T2',
      prerequisiteTaskId: 'MISSING' })).rejects.toThrow(/prerequisite.*not found/i);
    await expect(commands().create({ ...createInput(), operationId: 'inactive-student-op', taskId: 'T3',
      allowedStudentIds: ['S003'] })).rejects.toThrow(/active/i);
    await expect(commands().create({ ...createInput(), operationId: 'missing-student-op', taskId: 'T4',
      allowedStudentIds: ['S404'] })).rejects.toThrow(/not found|invalid/i);
    await expect(commands().create({ ...createInput(), operationId: 'self-op', taskId: 'T5',
      prerequisiteTaskId: 'T5', allowedStudentIds: [] })).rejects.toThrow(/cycle/i);
    expect(await snapshot()).toEqual(before);
  });

  it('replays canonical reordered input, conflicts on changes, and handles a race loser', async () => {
    const input = createInput();
    const recurrence = input.schedule.recurrence;
    if (recurrence.type !== 'WEEKLY') throw new Error('weekly fixture required');
    const first = await commands().create(input);
    await expect(commands().create({ ...input,
      allowedStudentIds: [...input.allowedStudentIds].reverse(),
      schedule: { ...input.schedule, recurrence: { ...recurrence,
        weekdays: [...recurrence.weekdays].reverse() } },
    })).resolves.toEqual(first);
    await expect(commands().create({ ...input, reward: 101 })).rejects.toThrow(/conflict/i);

    const race = createDatabaseTaskAdminCommands({
      tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let firstRead = true;
        return callback({ execute: async (query) => {
          if (firstRead) { firstRead = false; return { rows: [] } as never; }
          return tx.execute(query);
        } } as typeof tx);
      }),
    });
    await expect(race.create(input)).resolves.toEqual(first);
    expect((await snapshot()).operations).toHaveLength(1);
  });

  it('replays after legitimate edits and tombstone, but rejects missing physical identity', async () => {
    const input = createInput();
    const first = await commands().create(input);
    const id = first.tasks[0].taskInstanceId;
    await harness.database.query(`UPDATE tasks SET title='later', is_active=false, version=2,
      updated_at=$3, deleted_at=$3 WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, id, '2026-08-30T02:00:00.000Z']);
    await expect(commands().create(input)).resolves.toEqual(first);
    await harness.database.exec('ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only');
    await harness.database.query('DELETE FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2',
      [harness.tenantOneId, id]);
    await harness.database.query('DELETE FROM task_allowed_students WHERE tenant_id=$1 AND task_instance_id=$2',
      [harness.tenantOneId, id]);
    await harness.database.query('DELETE FROM tasks WHERE tenant_id=$1 AND task_instance_id=$2',
      [harness.tenantOneId, id]);
    await expect(commands().create(input)).rejects.toThrow(/physical identity/i);
  });

  it('replays the frozen CREATE result after a legitimate later same-cycle assignment', async () => {
    const input = { ...createInput(), allowedStudentIds: ['S001'] };
    const first = await commands().create(input);
    await appendLaterSameCycleAssignment(first.tasks[0].taskInstanceId, 'S002', 'later-assignment');

    await expect(commands().create(input)).resolves.toEqual(first);
  });

  it('replays an initially empty CREATE after a legitimate later same-cycle assignment', async () => {
    const input = { ...createInput(), allowedStudentIds: [] };
    const first = await commands().create(input);
    await appendLaterSameCycleAssignment(first.tasks[0].taskInstanceId, 'S001', 'later-empty-assignment');

    await expect(commands().create(input)).resolves.toEqual(first);
  });

  it('rejects duplicate raw original-ID assignment evidence during replay', async () => {
    const input = { ...createInput(), allowedStudentIds: ['S001'] };
    await commands().create(input);
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          return call === 3 ? { ...result, rows: [...result.rows, ...result.rows] } : result;
        } } as typeof tx)),
    });

    await expect(adapter.create(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it.each([
    ['task', 'tasks', "NEW.task_id='TASK-001'"],
    ['mirror', 'task_allowed_students', "NEW.student_id='S002'"],
    ['assignment', 'task_assignments', "NEW.student_id='S002'"],
    ['audit', 'audit_events', "NEW.operation_id='task-admin-create-op'"],
  ] as const)('rolls back when the required %s insert is suppressed', async (_label, table, condition) => {
    await harness.database.exec(`
      CREATE FUNCTION suppress_task_admin_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_task_admin_insert BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_task_admin_insert();
    `);
    await expect(commands().create(createInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it('rolls back when an audit trigger mutates already verified task state', async () => {
    await harness.database.exec(`
      CREATE FUNCTION mutate_task_after_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE tasks SET title='tampered' WHERE tenant_id=NEW.tenant_id;
        RETURN NEW; END $$;
      CREATE TRIGGER mutate_task_after_audit AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION mutate_task_after_audit();
    `);
    await expect(commands().create(createInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it('rolls back when the terminal operation update mutates the created task', async () => {
    await harness.database.exec(`
      CREATE FUNCTION mutate_task_after_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='SUCCEEDED' THEN
          UPDATE tasks SET title='terminal-tampered', version=version + 1
          WHERE tenant_id=NEW.tenant_id;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER mutate_task_after_terminal AFTER UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION mutate_task_after_terminal();
    `);
    await expect(commands().create(createInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it.each([
    ['audit', `CREATE TRIGGER inject_extra_assignment AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION inject_extra_assignment()`],
    ['terminal', `CREATE TRIGGER inject_extra_assignment AFTER UPDATE ON operations
      FOR EACH ROW WHEN (NEW.status='SUCCEEDED') EXECUTE FUNCTION inject_extra_assignment()`],
  ])('rolls back an extra current-cycle assignment injected by the %s trigger', async (_label, trigger) => {
    await harness.database.exec(`
      CREATE FUNCTION inject_extra_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO task_assignments
          (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
           cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
           source, previous_assignment_id, admin_operation_id, admin_operation_hash,
           created_at, schema_version, note)
        SELECT tenant_id, assignment_id || ':legacy-extra', task_id_snapshot, task_instance_id,
          cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
          'ASSIGNED', 'LEGACY_SEED', NULL, NULL, NULL, created_at, schema_version, NULL
        FROM task_assignments WHERE tenant_id=NEW.tenant_id ORDER BY event_sequence LIMIT 1;
        RETURN NEW;
      END $$;
      ${trigger}
    `);
    await expect(commands().create(createInput())).rejects.toThrow(/assignment event integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it.each([
    ['audit', 'future-cycle assignment', `CREATE TRIGGER inject_other_ledger_event AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION inject_other_ledger_event()`, 'assignment'],
    ['terminal', 'future-cycle assignment', `CREATE TRIGGER inject_other_ledger_event AFTER UPDATE ON operations
      FOR EACH ROW WHEN (NEW.status='SUCCEEDED') EXECUTE FUNCTION inject_other_ledger_event()`, 'assignment'],
    ['audit', 'completion', `CREATE TRIGGER inject_other_ledger_event AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION inject_other_ledger_event()`, 'completion'],
    ['terminal', 'completion', `CREATE TRIGGER inject_other_ledger_event AFTER UPDATE ON operations
      FOR EACH ROW WHEN (NEW.status='SUCCEEDED') EXECUTE FUNCTION inject_other_ledger_event()`, 'completion'],
  ] as const)('rolls back a %s-triggered injected %s for the new task',
  async (_stage, _event, trigger, kind) => {
    const body = kind === 'assignment' ? `
      INSERT INTO task_assignments
        (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
         cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
         source, previous_assignment_id, admin_operation_id, admin_operation_hash,
         created_at, schema_version, note)
      SELECT tenant_id, 'injected-future:' || task_instance_id, task_id, task_instance_id,
        'future-cycle', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 1,
        'Asia/Seoul', 'S001', 'ASSIGNED', 'LEGACY_SEED', NULL, NULL, NULL,
        '2026-08-30T01:00:00Z', 1, NULL
      FROM tasks WHERE tenant_id=NEW.tenant_id ORDER BY created_at DESC LIMIT 1;`
      : `
      INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
         task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
         balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
         rule_version, timezone, source, schema_version, created_at)
      SELECT tenant_id, 'injected-completion:' || task_instance_id, '2026-08-30T01:00:00Z',
        task_instance_id, task_id, title, 'S001', '하나', reward, 0, reward,
        'COMPLETED', 'injected-cycle', '2026-08-30T00:00:00Z',
        '2026-08-31T00:00:00Z', 1, 'Asia/Seoul', 'BANK', 1,
        '2026-08-30T01:00:00Z'
      FROM tasks WHERE tenant_id=NEW.tenant_id ORDER BY created_at DESC LIMIT 1;`;
    await harness.database.exec(`
      CREATE FUNCTION inject_other_ledger_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${body} RETURN NEW; END $$;
      ${trigger}
    `);

    await expect(commands().create(createInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
    const completions = await harness.database.query('SELECT completion_id FROM task_completions');
    expect(completions.rows).toEqual([]);
  });

  it('replays after a legitimate completion is appended later', async () => {
    const input = createInput();
    const result = await commands().create(input);
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, schema_version, created_at)
      VALUES ($1, 'later-completion', $3, $2, 'TASK-001', '과제', 'S001', '하나',
        0, 0, 0, 'COMPLETED', 'later-cycle', $3, NULL, 1, 'Asia/Seoul',
        'CARRY_FORWARD', 1, $3)`,
    [harness.tenantOneId, result.tasks[0].taskInstanceId, '2026-08-30T02:00:00.000Z']);

    await expect(commands().create(input)).resolves.toEqual(result);
  });

  it('rolls back when the terminal operation update is suppressed', async () => {
    await harness.database.exec(`
      CREATE FUNCTION suppress_terminal_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='SUCCEEDED' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_terminal_update BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION suppress_terminal_update();
    `);
    await expect(commands().create(createInput())).rejects.toThrow(/terminal operation integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it.each([
    ['operationId padding', "jsonb_set(result_snapshot, '{operationId}', to_jsonb(' task-admin-create-op '::text))"],
    ['taskId padding', "jsonb_set(result_snapshot, '{tasks,0,taskId}', to_jsonb(' TASK-001 '::text))"],
    ['taskInstanceId padding', "jsonb_set(result_snapshot, '{tasks,0,taskInstanceId}', to_jsonb(' '::text || (result_snapshot#>>'{tasks,0,taskInstanceId}') || ' '::text))"],
    ['assignmentEventId padding', "jsonb_set(result_snapshot, '{tasks,0,assignmentEventIds,0}', to_jsonb(' '::text || (result_snapshot#>>'{tasks,0,assignmentEventIds,0}') || ' '::text))"],
    ['alternate completedAt spelling', "jsonb_set(result_snapshot, '{completedAt}', to_jsonb('2026-08-30T01:00:00Z'::text))"],
    ['extra result key', "result_snapshot || '{\"extra\":true}'::jsonb"],
    ['reordered assignment IDs', "jsonb_set(result_snapshot, '{tasks,0,assignmentEventIds}', jsonb_build_array(result_snapshot#>'{tasks,0,assignmentEventIds,1}', result_snapshot#>'{tasks,0,assignmentEventIds,0}'))"],
  ])('rejects raw stored result tampering: %s', async (_label, expression) => {
    const input = createInput();
    await commands().create(input);
    await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET result_snapshot=${expression} WHERE operation_id='task-admin-create-op';
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;`);
    await expect(commands().create(input)).rejects.toThrow(/stored/i);
  });

  it.each([
    ['padded live task identity', [{ task_instance_id: ' instance ', task_id: 'OTHER', prerequisite_task_instance_id: null,
      created_at: NOW, updated_at: NOW, deleted_at: null }]],
    ['duplicate live task identity', [
      { task_instance_id: 'instance', task_id: 'OTHER', prerequisite_task_instance_id: null,
        created_at: NOW, updated_at: NOW, deleted_at: null },
      { task_instance_id: 'instance', task_id: 'OTHER-2', prerequisite_task_instance_id: null,
        created_at: NOW, updated_at: NOW, deleted_at: null },
    ]],
    ['padded prerequisite identity', [{ task_instance_id: 'instance', task_id: 'OTHER',
      prerequisite_task_instance_id: ' missing ', created_at: NOW, updated_at: NOW, deleted_at: null }]],
  ])('rejects adapter %s without committing the operation claim', async (_label, rows) => {
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          if (call === 3) return { rows } as never;
          return tx.execute(query);
        } } as typeof tx)),
    });
    await expect(adapter.create({ ...createInput(), allowedStudentIds: [] })).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it.each([
    ['padded', [{ student_id: ' S001 ', status: 'ACTIVE' }]],
    ['duplicate', [{ student_id: 'S001', status: 'ACTIVE' }, { student_id: 'S001', status: 'ACTIVE' }]],
  ])('rejects adapter %s student lock evidence', async (_label, rows) => {
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          if (call === 4) return { rows } as never;
          return tx.execute(query);
        } } as typeof tx)),
    });
    await expect(adapter.create({ ...createInput(), allowedStudentIds: ['S001'] })).rejects.toThrow(/invalid|integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it('allows tombstoned business-ID reuse but rejects a tombstoned prerequisite', async () => {
    const old = await commands().create({ ...createInput(), allowedStudentIds: [] });
    await harness.database.query(`UPDATE tasks SET is_active=false, deleted_at=$3, updated_at=$3
      WHERE tenant_id=$1 AND task_instance_id=$2`, [harness.tenantOneId, old.tasks[0].taskInstanceId,
      '2026-08-30T02:00:00.000Z']);
    await expect(commands().create({ ...createInput(), operationId: 'dependent-on-old-op', taskId: 'DEPENDENT',
      prerequisiteTaskId: 'TASK-001', allowedStudentIds: [] })).rejects.toThrow(/prerequisite/i);
    const replacement = await commands().create({ ...createInput(), operationId: 'replacement-op', allowedStudentIds: [] });
    expect(replacement.tasks[0].taskInstanceId).not.toBe(old.tasks[0].taskInstanceId);
  });

  it('accepts DB collation order independently and keeps canonical JS replay ordering', async () => {
    const privateUse = '\uE000';
    const astral = '😀';
    await harness.database.query(`INSERT INTO students
      (tenant_id, student_id, name, status, created_at, updated_at)
      VALUES ($1, $2, 'private', 'ACTIVE', $4, $4), ($1, $3, 'astral', 'ACTIVE', $4, $4)`,
    [harness.tenantOneId, privateUse, astral, NOW.toISOString()]);
    const sqlOrder = await harness.database.query(`SELECT student_id FROM students
      WHERE tenant_id=$1 AND student_id IN ($2, $3) ORDER BY student_id`,
    [harness.tenantOneId, privateUse, astral]);
    expect(sqlOrder.rows.map((row) => (row as { student_id: string }).student_id)).toEqual([privateUse, astral]);
    const input = { ...createInput(), allowedStudentIds: [privateUse, astral] };
    const result = await commands().create(input);
    expect(result.tasks[0].assignmentEventIds).toEqual([astral, privateUse].map((studentId) =>
      createTaskAdminAssignmentEventId('task-admin-create-op', 'TASK-001', studentId)));
    await expect(commands().create({ ...input, allowedStudentIds: [astral, privateUse] })).resolves.toEqual(result);
  });

  it('locks live tasks by physical instance ID when business IDs have the opposite order', async () => {
    const schedule = JSON.stringify({ ruleVersion: 1, effectiveFrom: NOW.toISOString(), timeZone: 'Asia/Seoul',
      recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false });
    await harness.database.query(`INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
       current_schedule, schedule_schema_version, version, created_at, updated_at)
      VALUES ($1, 'instance-z', 'BUSINESS-A', 'A', '', 0, true, 0, $2::jsonb, 1, 1, $3, $3),
             ($1, 'instance-a', 'BUSINESS-Z', 'Z', '', 0, true, 0, $2::jsonb, 1, 1, $3, $3)`,
    [harness.tenantOneId, schedule, NOW.toISOString()]);
    let call = 0;
    const lockedInstanceIds: string[] = [];
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          if (call === 3) lockedInstanceIds.push(...result.rows.map((row) =>
            (row as { task_instance_id: string }).task_instance_id));
          return result;
        } } as typeof tx)),
    });
    await adapter.create({ ...createInput(), operationId: 'physical-lock-order-op', taskId: 'BUSINESS-M',
      prerequisiteTaskId: 'BUSINESS-A', allowedStudentIds: [] });
    expect(lockedInstanceIds).toEqual(['instance-a', 'instance-z']);
  });

  it('rejects a corrupt repeated physical identity in the full prerequisite chain before writes', async () => {
    await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_prerequisite_fk');
    const schedule = JSON.stringify({ ruleVersion: 1, effectiveFrom: NOW.toISOString(), timeZone: 'Asia/Seoul',
      recurrence: { type: 'NONE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false });
    await harness.database.query(`INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active, sort_order,
       prerequisite_task_instance_id, current_schedule, schedule_schema_version, version,
       created_at, updated_at)
      VALUES ($1, 'instance-a', 'A', 'A', '', 0, true, 0, 'instance-b', $2::jsonb, 1, 1, $3, $3),
             ($1, 'instance-b', 'B', 'B', '', 0, true, 0, 'instance-a', $2::jsonb, 1, 1, $3, $3)`,
    [harness.tenantOneId, schedule, NOW.toISOString()]);
    const before = await snapshot();
    await expect(commands().create({ ...createInput(), operationId: 'cycle-op', taskId: 'C',
      prerequisiteTaskId: 'A', allowedStudentIds: [] })).rejects.toThrow(/cycle/i);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['task', 5], ['mirror', 6], ['assignment', 7],
  ])('rejects duplicate raw %s INSERT RETURNING evidence and rolls back', async (_label, targetCall) => {
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          return call === targetCall ? { ...result, rows: [...result.rows, ...result.rows] } : result;
        } } as typeof tx)),
    });
    await expect(adapter.create(createInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it.each([
    ['boxed mirror ID', 6, (row: Record<string, unknown>) => ({ ...row,
      student_id: new String(row.student_id as string) })],
    ['alternate mirror timestamp spelling', 6, (row: Record<string, unknown>) => ({ ...row,
      created_at: '2026-08-30T01:00:00Z' })],
    ['wrong mirror Date instant', 6, (row: Record<string, unknown>) => ({ ...row,
      created_at: new Date('2026-08-30T01:00:00.001Z') })],
    ['extra mirror key', 6, (row: Record<string, unknown>) => ({ ...row, extra: true })],
    ['missing mirror key', 6, (row: Record<string, unknown>) => {
      const rest = { ...row };
      delete rest.created_at;
      return rest;
    }],
    ['boxed assignment number', 7, (row: Record<string, unknown>) => ({ ...row,
      rule_version: new Number(row.rule_version as number) })],
    ['boxed assignment boolean', 7, (row: Record<string, unknown>) => ({ ...row,
      source: new Boolean(true) })],
    ['boxed assignment ID', 7, (row: Record<string, unknown>) => ({ ...row,
      assignment_id: new String(row.assignment_id as string) })],
    ['alternate assignment timestamp spelling', 7, (row: Record<string, unknown>) => ({ ...row,
      created_at: '2026-08-30T01:00:00Z' })],
    ['wrong assignment Date instant', 7, (row: Record<string, unknown>) => ({ ...row,
      created_at: new Date('2026-08-30T01:00:00.001Z') })],
    ['extra assignment key', 7, (row: Record<string, unknown>) => ({ ...row, extra: true })],
    ['missing assignment key', 7, (row: Record<string, unknown>) => {
      const rest = { ...row };
      delete rest.note;
      return rest;
    }],
  ] as const)('rejects raw adapter evidence with a %s', async (_label, targetCall, mutate) => {
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          return call === targetCall
            ? { ...result, rows: result.rows.map((row) => mutate(row as Record<string, unknown>)) }
            : result;
        } } as typeof tx)),
    });
    await expect(adapter.create(createInput())).rejects.toThrow(/integrity/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it('rejects reordered raw stored-result object keys from an adapter', async () => {
    const input = createInput();
    await commands().create(input);
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          const result = await tx.execute(query);
          if (result.rows.length === 1 && (result.rows[0] as { result_snapshot?: unknown }).result_snapshot) {
            const row = result.rows[0] as { result_snapshot: Record<string, unknown> };
            const value = row.result_snapshot;
            return { ...result, rows: [{ ...row, result_snapshot: { operationId: value.operationId,
              ok: value.ok, tasks: value.tasks, action: value.action, completedAt: value.completedAt } }] };
          }
          return result;
        } } as typeof tx)),
    });
    await expect(adapter.create(input)).rejects.toThrow(/stored/i);
  });

  it.each([
    ['RETURN OLD', 'RETURN OLD'], ['RETURN NULL', 'RETURN NULL'],
  ])('rejects terminal operation trigger %s and rolls back', async (_label, returnClause) => {
    await harness.database.exec(`CREATE FUNCTION alter_terminal_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='SUCCEEDED' THEN ${returnClause}; END IF; RETURN NEW; END $$;
      CREATE TRIGGER alter_terminal_update BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION alter_terminal_update();`);
    await expect(commands().create(createInput())).rejects.toThrow(/terminal|replayable/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it('rejects a tampered audit row and rolls back', async () => {
    await harness.database.exec(`CREATE FUNCTION tamper_task_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.entity_id='tampered'; RETURN NEW; END $$;
      CREATE TRIGGER tamper_task_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION tamper_task_audit();`);
    await expect(commands().create(createInput())).rejects.toThrow(/audit/i);
    expect(await snapshot()).toEqual({ tasks: [], mirrors: [], assignments: [], operations: [], audits: [] });
  });

  it('rejects replay with a hard-missing assignment while the physical task remains', async () => {
    const input = createInput();
    await commands().create(input);
    await harness.database.exec('ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only');
    await harness.database.query(`DELETE FROM task_assignments WHERE tenant_id=$1 AND student_id='S001'`,
      [harness.tenantOneId]);
    await expect(commands().create(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it('fails closed on malformed stored result and immutable assignment evidence', async () => {
    const input = createInput();
    await commands().create(input);
    await harness.database.exec(`
      ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{tasks,0,versionAfter}', '2')
      WHERE operation_id='task-admin-create-op';
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;
    `);
    await expect(commands().create(input)).rejects.toThrow(/stored result integrity/i);

    await harness.database.exec(`
      ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET result_snapshot=jsonb_set(result_snapshot, '{tasks,0,versionAfter}', '1')
      WHERE operation_id='task-admin-create-op';
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;
      ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only;
      UPDATE task_assignments SET cycle_id='tampered' WHERE student_id='S001';
      ALTER TABLE task_assignments ENABLE TRIGGER task_assignments_append_only;
    `);
    await expect(commands().create(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it('isolates task business IDs and operations by tenant', async () => {
    const one = await commands(harness.tenantOneId).create(createInput());
    const two = await commands(harness.tenantTwoId).create(createInput());
    expect(two).toEqual(one);
    expect((await snapshot(harness.tenantOneId)).tasks).toHaveLength(1);
    expect((await snapshot(harness.tenantTwoId)).tasks).toHaveLength(1);
  });
});

describe('database task administrator UPDATE command', () => {
  it('selects the maximum same-cycle predecessor regardless of adapter row order', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const latestId = 'assignment-latest-before-update';
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001', latestId);
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          return call === 5 ? { ...result, rows: [...result.rows].reverse() } as never : result;
        } } as typeof tx)),
    });
    const result = await adapter.update(updateInput({ allowedStudentIds: [] }));
    const state = await snapshot();
    expect(state.assignments).toContainEqual(expect.objectContaining({
      assignment_id: result.tasks[0].assignmentEventIds[0], previous_assignment_id: latestId,
    }));
  });

  it('rejects a predecessor chain whose later sequence has an earlier timestamp', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001',
      'assignment-inverted-time', '2026-08-30T00:59:59.000Z');
    const before = await snapshot();
    await expect(commands().update(updateInput({ allowedStudentIds: [] })))
      .rejects.toThrow(/assignment event integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it('requires every same-cycle event to reference its immediate predecessor', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const first = createTaskAdminAssignmentEventId('task-admin-create-op', 'TASK-001', 'S001');
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001', 'chain-second');
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001', 'chain-third');
    await harness.database.exec(`ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only;
      UPDATE task_assignments SET previous_assignment_id='${first}' WHERE assignment_id='chain-third';
      ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only;`);
    const before = await snapshot();
    await expect(commands().update(updateInput({ allowedStudentIds: [] })))
      .rejects.toThrow(/assignment event integrity/i);
    expect(await snapshot()).toEqual(before);
  });

  it('accepts a valid prior-cycle CARRY_FORWARD predecessor during UPDATE', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const initial = await harness.database.query(`SELECT assignment_id, cycle_id, cycle_start_at,
      cycle_end_at, rule_version, timezone FROM task_assignments
      WHERE tenant_id=$1 AND task_instance_id=$2 ORDER BY event_sequence LIMIT 1`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId]);
    const row = initial.rows[0] as {
      assignment_id: string; cycle_id: string; cycle_start_at: Date; cycle_end_at: Date | null;
      rule_version: number; timezone: string;
    };
    const priorStart = new Date(row.cycle_start_at.getTime() - 86_400_000);
    const priorCycleId = `v1|${created.tasks[0].taskInstanceId}|r${row.rule_version}|${priorStart.toISOString().replace('.000Z', 'Z')}`;
    await harness.database.exec(`ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only`);
    await harness.database.query(`UPDATE task_assignments SET source='LEGACY_SEED',
      cycle_id=$1, cycle_start_at=$2, cycle_end_at=$3, previous_assignment_id=NULL,
      admin_operation_id=NULL, admin_operation_hash=NULL WHERE tenant_id=$4 AND assignment_id=$5`,
    [priorCycleId, priorStart.toISOString(), row.cycle_start_at.toISOString(),
      harness.tenantOneId, row.assignment_id]);
    await harness.database.exec(`ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only`);
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note)
      VALUES ($1, 'valid-carry', 'TASK-001', $2, $3, $4, $5, $6, $7, 'S001',
        'ASSIGNED', 'CARRY_FORWARD', $8, NULL, NULL, $9, 1, NULL)`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId, row.cycle_id,
      row.cycle_start_at.toISOString(), row.cycle_end_at?.toISOString() ?? null,
      row.rule_version, row.timezone, row.assignment_id, NOW.toISOString()]);

    const result = await commands().update(updateInput({ allowedStudentIds: [] }));
    const expectedId = createTaskAdminAssignmentEventId(
      'task-admin-update-op', 'TASK-001', 'S001', 'UNASSIGNED');
    expect(result.tasks[0].assignmentEventIds).toEqual([expectedId]);
    expect((await snapshot()).assignments).toContainEqual(expect.objectContaining({
      assignment_id: expectedId,
      previous_assignment_id: 'valid-carry',
    }));
  });

  it('accepts retained same-cycle LEGACY_SEED rows with null predecessors', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001', 'legacy-one');
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001', 'legacy-two');
    await harness.database.exec(`ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only;
      UPDATE task_assignments SET source='LEGACY_SEED', previous_assignment_id=NULL,
        admin_operation_id=NULL, admin_operation_hash=NULL
      WHERE assignment_id IN ('legacy-one', 'legacy-two');
      ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only;`);

    const result = await commands().update(updateInput({ allowedStudentIds: [] }));
    const expectedId = createTaskAdminAssignmentEventId(
      'task-admin-update-op', 'TASK-001', 'S001', 'UNASSIGNED');
    expect(result.tasks[0].assignmentEventIds).toEqual([expectedId]);
    expect((await snapshot()).assignments).toContainEqual(expect.objectContaining({
      assignment_id: expectedId,
      previous_assignment_id: 'legacy-two',
    }));
  });

  it('appends an authoritative UNASSIGNED event for every mirror removal', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001',
      'already-unassigned', NOW.toISOString(), 'UNASSIGNED');
    const result = await commands().update(updateInput({ allowedStudentIds: [] }));
    const expectedId = createTaskAdminAssignmentEventId(
      'task-admin-update-op', 'TASK-001', 'S001', 'UNASSIGNED');
    expect(result.tasks[0].assignmentEventIds).toEqual([expectedId]);
    const state = await snapshot();
    expect(state.mirrors).toEqual([]);
    expect(state.assignments).toContainEqual(expect.objectContaining({
      assignment_id: expectedId,
      event_type: 'UNASSIGNED',
      source: 'ADMIN',
      previous_assignment_id: 'already-unassigned',
    }));
    expect(state.audits.filter((row) =>
      (row as { operation_id: string }).operation_id === 'task-admin-update-op')).toHaveLength(1);
  });

  it('appends an authoritative ASSIGNED event when a QR-assigned student is added to the mirror', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: [] });
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S001',
      'qr-already-assigned', NOW.toISOString(), 'ASSIGNED', 'QR');
    const result = await commands().update(updateInput({ allowedStudentIds: ['S001'] }));
    const expectedId = createTaskAdminAssignmentEventId(
      'task-admin-update-op', 'TASK-001', 'S001', 'ASSIGNED');
    expect(result.tasks[0].assignmentEventIds).toEqual([expectedId]);
    const state = await snapshot();
    expect(state.mirrors).toHaveLength(1);
    expect(state.assignments).toContainEqual(expect.objectContaining({
      assignment_id: expectedId,
      event_type: 'ASSIGNED',
      source: 'ADMIN',
      previous_assignment_id: 'qr-already-assigned',
    }));
  });

  it.each([
    ['null pair', null, null],
    ['half pair', 'qr-operation', null],
    ['bad hash', 'qr-operation', 'A'.repeat(64)],
  ])('rejects a QR assignment with an invalid admin operation %s at the database boundary',
  async (_label, operationId, operationHash) => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    if (operationId !== null) {
      await harness.database.query(`INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
        VALUES ($1, $2, 'TASK_ADMIN', $3, 'PENDING', 1, $4, $4, $4)`,
      [harness.tenantOneId, operationId, 'a'.repeat(64), NOW.toISOString()]);
    }
    await expect(harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note)
      SELECT $1, 'invalid-qr', 'TASK-001', $2, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, 'S001', 'ASSIGNED', 'QR', NULL, $3, $4, $5, 1, NULL
      FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2
      ORDER BY event_sequence LIMIT 1`, [harness.tenantOneId, created.tasks[0].taskInstanceId,
      operationId, operationHash, NOW.toISOString()])).rejects.toThrow();
  });

  it.each([
    ['null pair', null, null],
    ['half pair', 'qr-operation', null],
    ['bad hash', 'qr-operation', 'A'.repeat(64)],
  ])('rejects malformed QR admin operation %s returned by an adapter',
  async (_label, operationId, operationHash) => {
    await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          if (call !== 5) return result;
          return { ...result, rows: result.rows.map((raw) => ({ ...(raw as Record<string, unknown>),
            source: 'QR', admin_operation_id: operationId,
            admin_operation_hash: operationHash })) } as never;
        } } as typeof tx)),
    });
    await expect(adapter.update(updateInput({ allowedStudentIds: [] })))
      .rejects.toThrow(/assignment event integrity/i);
  });

  it('preserves every field of a valid existing completion during UPDATE', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, schema_version, created_at)
      SELECT tenant_id, 'existing-completion', $3, task_instance_id, task_id_snapshot,
       'immutable task name', student_id, '하나', 0, -4, -4, 'COMPLETED', 'immutable note',
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, 'CARRY_FORWARD', assignment_id, 1, $3
      FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2 LIMIT 1`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId, NOW.toISOString()]);
    const before = await completeSnapshot();
    await commands().update(updateInput({ allowedStudentIds: ['S001'] }));
    expect((await completeSnapshot()).completions).toEqual(before.completions);
  });

  it('rejects malformed padded completion evidence before mutating UPDATE state', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    await harness.database.query(`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, schema_version, created_at)
      SELECT tenant_id, 'completion-before-padding', $3, task_instance_id, task_id_snapshot,
       'task', student_id, '하나', 0, 0, 0, 'COMPLETED', cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, 'CARRY_FORWARD', 1, $3
      FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2 LIMIT 1`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId, NOW.toISOString()]);
    await harness.database.exec(`ALTER TABLE task_completions DISABLE TRIGGER task_completions_append_only;
      ALTER TABLE task_completions DROP CONSTRAINT task_completions_id_check;
      UPDATE task_completions SET completion_id=' padded-completion ';
      ALTER TABLE task_completions ENABLE ALWAYS TRIGGER task_completions_append_only;`);
    const before = await completeSnapshot();
    await expect(commands().update(updateInput({ allowedStudentIds: ['S001'] })))
      .rejects.toThrow(/completion event integrity/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each([
    ['task CAS RETURN NULL', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.version=2 THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_update_write BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
    ['task CAS RETURN OLD', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.version=2 THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_update_write BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
    ['mirror DELETE', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_update_write BEFORE DELETE ON task_allowed_students
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
    ['mirror INSERT', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_update_write BEFORE INSERT ON task_allowed_students
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
    ['assignment INSERT', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.admin_operation_id='task-admin-update-op' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_update_write BEFORE INSERT ON task_assignments
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
    ['audit INSERT', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id='task-admin-update-op' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_update_write BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
    ['terminal RETURN NULL', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='SUCCEEDED' AND NEW.operation_id='task-admin-update-op' THEN RETURN NULL; END IF;
      RETURN NEW; END $$; CREATE TRIGGER suppress_update_write BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
    ['terminal RETURN OLD', `CREATE FUNCTION suppress_update_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='SUCCEEDED' AND NEW.operation_id='task-admin-update-op' THEN RETURN OLD; END IF;
      RETURN NEW; END $$; CREATE TRIGGER suppress_update_write BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION suppress_update_write()`],
  ])('rolls back the complete snapshot when required UPDATE %s is suppressed', async (_label, ddl) => {
    await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const before = await completeSnapshot();
    await harness.database.exec(ddl);
    await expect(commands().update(updateInput())).rejects.toThrow(/integrity|replayable/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each([
    ['audit', 'task', false, `UPDATE tasks SET title='audit-tampered', version=version+1
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['terminal', 'task', false, `UPDATE tasks SET title='terminal-tampered', version=version+1
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['audit', 'mirror add', false, `INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at)
      SELECT tenant_id, task_instance_id, 'S001', NEW.occurred_at FROM tasks
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['terminal', 'mirror delete', false, `DELETE FROM task_allowed_students WHERE tenant_id=NEW.tenant_id
      AND student_id='S002'`],
    ['audit', 'assignment', false, `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      SELECT tenant_id, assignment_id || ':audit-extra', task_id_snapshot, task_instance_id,
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
       event_type, 'LEGACY_SEED', NULL, NULL, NULL, created_at, schema_version, NULL
      FROM task_assignments WHERE tenant_id=NEW.tenant_id ORDER BY event_sequence LIMIT 1`],
    ['terminal', 'assignment', false, `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      SELECT tenant_id, assignment_id || ':terminal-extra', task_id_snapshot, task_instance_id,
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
       event_type, 'LEGACY_SEED', NULL, NULL, NULL, created_at, schema_version, NULL
      FROM task_assignments WHERE tenant_id=NEW.tenant_id ORDER BY event_sequence LIMIT 1`],
    ['audit', 'completion insert', false, `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, schema_version, created_at)
      SELECT tenant_id, 'audit-injected-completion', NEW.occurred_at, task_instance_id, task_id,
       title, 'S001', '하나', reward, 0, reward, 'COMPLETED', 'audit-cycle',
       NEW.occurred_at, NULL, 1, 'Asia/Seoul', 'BANK', 1, NEW.occurred_at
      FROM tasks WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['terminal', 'completion insert', false, `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, schema_version, created_at)
      SELECT tenant_id, 'terminal-injected-completion', NEW.updated_at, task_instance_id, task_id,
       title, 'S001', '하나', reward, 0, reward, 'COMPLETED', 'terminal-cycle',
       NEW.updated_at, NULL, 1, 'Asia/Seoul', 'BANK', 1, NEW.updated_at
      FROM tasks WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
  ] as const)('rolls back %s-stage post-write %s mutation',
  async (stage, _stateClass, needsCompletion, body) => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    if (needsCompletion) {
      await harness.database.query(`INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
         task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
         balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
         rule_version, timezone, source, schema_version, created_at)
        VALUES ($1, 'update-baseline-completion', $3, $2, 'TASK-001', '과제', 'S001', '하나',
          0, 0, 0, 'COMPLETED', 'baseline-cycle', $3, NULL, 1, 'Asia/Seoul', 'BANK', 1, $3)`,
      [harness.tenantOneId, created.tasks[0].taskInstanceId, NOW.toISOString()]);
    }
    const before = await completeSnapshot();
    const trigger = stage === 'audit'
      ? `AFTER INSERT ON audit_events FOR EACH ROW WHEN (NEW.operation_id='task-admin-update-op')`
      : `AFTER UPDATE ON operations FOR EACH ROW WHEN
        (NEW.operation_id='task-admin-update-op' AND NEW.status='SUCCEEDED')`;
    await harness.database.exec(`CREATE FUNCTION mutate_update_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${body}; RETURN NEW; END $$;
      CREATE TRIGGER mutate_update_state ${trigger} EXECUTE FUNCTION mutate_update_state()`);
    await expect(commands().update(updateInput())).rejects.toThrow(/integrity/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('atomically updates metadata, preserves schedule/creation, and emits only allowed-student diffs', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const before = (await snapshot()).tasks[0] as Record<string, unknown>;
    const result = await commands().update(updateInput({ allowedStudentIds: ['S002'] }));
    const expectedEvents = [
      createTaskAdminAssignmentEventId('task-admin-update-op', 'TASK-001', 'S001', 'UNASSIGNED'),
      createTaskAdminAssignmentEventId('task-admin-update-op', 'TASK-001', 'S002', 'ASSIGNED'),
    ];
    expect(result).toEqual({ ok: true, operationId: 'task-admin-update-op', action: 'UPDATE',
      completedAt: NOW.toISOString(), tasks: [{ taskId: 'TASK-001',
        taskInstanceId: created.tasks[0].taskInstanceId, versionBefore: 1, versionAfter: 2,
        assignmentEventIds: expectedEvents }] });
    expect(Object.isFrozen(result)).toBe(true);
    const state = await snapshot();
    expect(state.tasks[0]).toEqual(expect.objectContaining({ title: '수정 과제', description: '수정 설명',
      reward: '250', is_active: false, sort_order: 9, version: '2',
      created_at: before.created_at, current_schedule: before.current_schedule,
      pending_schedule: before.pending_schedule }));
    expect(state.mirrors).toEqual([expect.objectContaining({ student_id: 'S002', created_at: NOW })]);
    expect(state.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ assignment_id: expectedEvents[0], student_id: 'S001',
        event_type: 'UNASSIGNED', previous_assignment_id:
          createTaskAdminAssignmentEventId('task-admin-create-op', 'TASK-001', 'S001') }),
      expect.objectContaining({ assignment_id: expectedEvents[1], student_id: 'S002',
        event_type: 'ASSIGNED', previous_assignment_id: null }),
    ]));
  });

  it('rejects an inactive prerequisite and rolls back UPDATE before domain writes', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    await commands().create({
      ...createInput(), operationId: 'inactive-prerequisite-op', taskId: 'INACTIVE-BASE',
      isActive: false, allowedStudentIds: [],
    });
    const before = await completeSnapshot();

    await expect(commands().update(updateInput({
      prerequisiteTaskId: 'INACTIVE-BASE', allowedStudentIds: [],
    }))).rejects.toThrow(/prerequisite.*active|active.*prerequisite/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('updates a task to reference an active prerequisite', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const prerequisite = await commands().create({
      ...createInput(), operationId: 'active-prerequisite-op', taskId: 'ACTIVE-BASE',
      allowedStudentIds: [],
    });

    await commands().update(updateInput({ prerequisiteTaskId: 'ACTIVE-BASE', allowedStudentIds: [] }));

    expect((await snapshot()).tasks).toContainEqual(expect.objectContaining({
      task_id: 'TASK-001',
      prerequisite_task_instance_id: prerequisite.tasks[0].taskInstanceId,
    }));
  });

  it.each([
    ['clear', null],
    ['replace', 'REPLACEMENT'],
  ] as const)('can %s an existing prerequisite after it becomes inactive', async (_label, requested) => {
    const prerequisite = await commands().create({
      ...createInput(), operationId: 'active-prerequisite-op', taskId: 'ACTIVE-BASE',
      allowedStudentIds: [],
    });
    const replacement = await commands().create({
      ...createInput(), operationId: 'replacement-prerequisite-op', taskId: 'REPLACEMENT',
      allowedStudentIds: [],
    });
    await commands().create({
      ...createInput(), taskId: 'TASK-001', prerequisiteTaskId: 'ACTIVE-BASE', allowedStudentIds: [],
    });
    await harness.database.query(`UPDATE tasks SET is_active=false
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, prerequisite.tasks[0].taskInstanceId]);

    await commands().update(updateInput({ prerequisiteTaskId: requested, allowedStudentIds: [] }));

    expect((await snapshot()).tasks).toContainEqual(expect.objectContaining({
      task_id: 'TASK-001', prerequisite_task_instance_id:
        requested === null ? null : replacement.tasks[0].taskInstanceId,
    }));
  });

  it('canonicalizes reversed allowed IDs and emits no events for an unchanged set', async () => {
    await commands().create(createInput());
    const first = await commands().update(updateInput({ allowedStudentIds: ['S002', 'S001'] }));
    expect(first.tasks[0].assignmentEventIds).toEqual([]);
    await expect(commands().update(updateInput({ allowedStudentIds: [' S001 ', 'S002'] })))
      .resolves.toEqual(first);
  });

  it('rejects equal canonical availability instants for CREATE before entering a transaction', async () => {
    let calls = 0;
    const preflight = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); }, now: () => NOW });
    await expect(preflight.create(createInput({
      availableFrom: '2026-08-30T01:00:00.000Z',
      dueAt: '2026-08-30T10:00:00+09:00',
    }))).rejects.toThrow(/dueAt.*after availableFrom/i);
    expect(calls).toBe(0);
  });

  it('rejects equal canonical availability instants for UPDATE before entering a transaction', async () => {
    let calls = 0;
    const preflight = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); }, now: () => NOW });
    await expect(preflight.update(updateInput({
      availableFrom: '2026-08-30T01:00:00.000Z',
      dueAt: '2026-08-30T10:00:00+09:00',
    }))).rejects.toThrow(/dueAt.*after availableFrom/i);
    expect(calls).toBe(0);
  });

  it('rejects malformed update input before entering a transaction', async () => {
    let calls = 0;
    const preflight = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); }, now: () => NOW });
    for (const input of [
      { ...updateInput(), schedule: {} }, { ...updateInput(), expectedTaskVersion: 0 },
      { ...updateInput(), expectedTaskVersion: Number.MAX_SAFE_INTEGER },
      { ...updateInput(), allowedStudentIds: ['S001', ' S001 '] },
    ]) await expect(preflight.update(input as never)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('rolls back stale versions, invalid new students, and prerequisite cycles', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'other-create', taskId: 'OTHER',
      prerequisiteTaskId: 'TASK-001', allowedStudentIds: [] });
    const before = await snapshot();
    await expect(commands().update(updateInput({ expectedTaskVersion: 2 }))).rejects.toThrow(/stale|version/i);
    await expect(commands().update(updateInput({ operationId: 'bad-student', allowedStudentIds: ['S003'] })))
      .rejects.toThrow(/active/i);
    await expect(commands().update(updateInput({ operationId: 'cycle-update', prerequisiteTaskId: 'OTHER',
      allowedStudentIds: [] }))).rejects.toThrow(/cycle/i);
    expect(await snapshot()).toEqual(before);
  });

  it('operation claim race loser returns the exact winner and conflicts on a changed hash', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const input = updateInput({ allowedStudentIds: [] });
    const winner = await commands().update(input);
    const racing = () => createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let firstRead = true;
        return callback({ execute: async (query) => {
          if (firstRead) { firstRead = false; return { rows: [] } as never; }
          return tx.execute(query);
        } } as typeof tx);
      }),
    });
    const replay = await racing().update(input);
    expect(replay).toEqual(winner);
    expect(Object.isFrozen(replay)).toBe(true);
    await expect(racing().update({ ...input, reward: input.reward + 1 })).rejects.toThrow(/conflict/i);
  });

  it.each([
    ['missing', `DELETE FROM audit_events WHERE operation_id='task-admin-update-op'`],
    ['extra', `INSERT INTO audit_events
      (tenant_id, event_id, operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at)
      SELECT tenant_id, event_id || ':extra', operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at FROM audit_events WHERE operation_id='task-admin-update-op'`],
    ['field', `UPDATE audit_events SET entity_id='tampered'
      WHERE operation_id='task-admin-update-op'`],
    ['timestamp', `UPDATE audit_events SET occurred_at=occurred_at + interval '1 second'
      WHERE operation_id='task-admin-update-op'`],
  ])('rejects replay with %s audit tamper/cardinality evidence', async (_label, tamper) => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const input = updateInput({ allowedStudentIds: [] });
    await commands().update(input);
    await harness.database.exec(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
      ${tamper};
      ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable`);
    await expect(commands().update(input)).rejects.toThrow(/audit/i);
  });

  it('replays after later mutable changes but rejects missing immutable update events', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const input = updateInput({ allowedStudentIds: ['S002'] });
    const first = await commands().update(input);
    await harness.database.query(`UPDATE tasks SET title='later', version=3, updated_at=$3
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, first.tasks[0].taskInstanceId, '2026-08-30T02:00:00.000Z']);
    await expect(commands().update(input)).resolves.toEqual(first);
    await harness.database.exec('ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only');
    await harness.database.query('DELETE FROM task_assignments WHERE tenant_id=$1 AND assignment_id=$2',
      [harness.tenantOneId, first.tasks[0].assignmentEventIds[0]]);
    await expect(commands().update(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it('rejects a singleton replay whose otherwise authentic stored result contains a second task', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const input = updateInput({ allowedStudentIds: [] });
    const first = await commands().update(input);
    const forged: TaskAdminUpdateSuccess = { ...first, tasks: [...first.tasks, {
      taskId: 'ZZZ-FORGED', taskInstanceId: 'forged-task-instance',
      versionBefore: 1, versionAfter: 2, assignmentEventIds: [],
    }] };
    await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable`);
    await harness.database.query(`UPDATE operations SET result_snapshot=$1::jsonb
      WHERE tenant_id=$2 AND operation_id=$3`,
    [JSON.stringify(forged), harness.tenantOneId, input.operationId]);
    await harness.database.query(`UPDATE audit_events SET redacted_details=$1::jsonb
      WHERE tenant_id=$2 AND operation_id=$3`, [{ action: 'UPDATE', taskCount: 2,
      assignmentEventCount: first.tasks[0].assignmentEventIds.length,
      resultHash: createTaskAdminResultHash(forged),
    }, harness.tenantOneId, input.operationId]);
    await harness.database.exec(`ALTER TABLE operations ENABLE ALWAYS TRIGGER operations_update_guard;
      ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable`);

    await expect(commands().update(input)).rejects.toThrow(/stored result integrity/i);
  });

  it.each([
    ['event type', (row: Record<string, unknown>) => ({ ...row, event_type: 'BROKEN' })],
    ['source', (row: Record<string, unknown>) => ({ ...row, source: 'BROKEN' })],
    ['timezone', (row: Record<string, unknown>) => ({ ...row, timezone: 'UTC' })],
    ['rule version', (row: Record<string, unknown>) => ({ ...row, rule_version: 0 })],
    ['schema version', (row: Record<string, unknown>) => ({ ...row, schema_version: 0 })],
    ['cycle start', (row: Record<string, unknown>) => ({ ...row,
      cycle_start_at: new Date((row.cycle_start_at as Date).getTime() + 1000) })],
    ['cycle end', (row: Record<string, unknown>) => ({ ...row,
      cycle_end_at: new Date((row.cycle_start_at as Date).getTime() - 1000) })],
    ['admin pair', (row: Record<string, unknown>) => ({ ...row, admin_operation_hash: null })],
  ] as const)('rejects malformed predecessor %s adapter evidence before use', async (_label, mutate) => {
    await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          return call === 5 ? { ...result, rows: result.rows.map((row) =>
            mutate(row as Record<string, unknown>)) } as never : result;
        } } as typeof tx)),
    });
    await expect(adapter.update(updateInput({ allowedStudentIds: [] })))
      .rejects.toThrow(/assignment event integrity/i);
    expect(call).toBe(5);
  });

  it('rejects an extra immutable event carrying the original update operation ID', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const input = updateInput({ allowedStudentIds: ['S002'] });
    const first = await commands().update(input);
    await harness.database.exec('ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only');
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      SELECT tenant_id, assignment_id || ':extra', task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note FROM task_assignments
      WHERE tenant_id=$1 AND assignment_id=$2`,
    [harness.tenantOneId, first.tasks[0].assignmentEventIds[0]]);
    await expect(commands().update(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it('rejects raw replay operation evidence and a physical business-ID mismatch', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const input = updateInput({ allowedStudentIds: [] });
    await commands().update(input);
    for (const targetCall of [1, 2]) {
      let call = 0;
      const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
        runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
          callback({ execute: async (query) => {
            call += 1;
            const result = await tx.execute(query);
            if (call !== targetCall) return result;
            const rows = result.rows.map((raw) => targetCall === 1
              ? { ...(raw as Record<string, unknown>), attempt_count: new String('1'), extra: true }
              : { ...(raw as Record<string, unknown>), task_id: 'OTHER' });
            return { ...result, rows } as never;
          } } as typeof tx)),
      });
      await expect(adapter.update(input)).rejects.toThrow(/operation|physical identity/i);
    }
  });

  it('rejects non-exact operation chronology during replay', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const input = updateInput({ allowedStudentIds: [] });
    await commands().update(input);
    await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET started_at=started_at - interval '1 second',
        created_at=created_at - interval '1 second'
      WHERE operation_id='task-admin-update-op';
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;`);
    await expect(commands().update(input)).rejects.toThrow(/timestamp integrity/i);
  });

  it.each([
    ['reordered', "jsonb_build_array(result_snapshot#>'{tasks,0,assignmentEventIds,1}', result_snapshot#>'{tasks,0,assignmentEventIds,0}')"],
    ['omitted', "jsonb_build_array(result_snapshot#>'{tasks,0,assignmentEventIds,0}')"],
    ['duplicate', "jsonb_build_array(result_snapshot#>'{tasks,0,assignmentEventIds,0}', result_snapshot#>'{tasks,0,assignmentEventIds,0}')"],
  ])('rejects %s frozen update event IDs', async (_label, ids) => {
    await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const input = updateInput({ allowedStudentIds: ['S002'] });
    await commands().update(input);
    await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET result_snapshot=jsonb_set(result_snapshot,
        '{tasks,0,assignmentEventIds}', ${ids}) WHERE operation_id='task-admin-update-op';
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;`);
    await expect(commands().update(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it('isolates update operations and targets by tenant', async () => {
    await commands(harness.tenantOneId).create(createInput());
    await commands(harness.tenantTwoId).create(createInput());
    const one = await commands(harness.tenantOneId).update(updateInput({ allowedStudentIds: [] }));
    const two = await commands(harness.tenantTwoId).update(updateInput({ allowedStudentIds: [] }));
    expect(two).toEqual(one);
  });
});

describe('database task administrator batch UPDATE command', () => {
  it('updates a reversed batch against the simultaneous final graph and replays canonically', async () => {
    const first = await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A',
      allowedStudentIds: ['S001'], prerequisiteTaskId: null });
    const second = await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B',
      allowedStudentIds: ['S002'], prerequisiteTaskId: null });
    const aEntry = updateBatchEntry({ taskId: 'A', title: 'A2', isActive: true,
      allowedStudentIds: ['S002'], prerequisiteTaskId: null });
    const bEntry = updateBatchEntry({ taskId: 'B', title: 'B2', isActive: true,
      allowedStudentIds: ['S001', 'S002'], prerequisiteTaskId: 'A' });
    const input: UpdateTasksAdminBatchInput = {
      operationId: 'batch-update', tasks: [bEntry, aEntry],
    };

    const result = await commands().updateBatch(input);
    expect(result).toEqual({ ok: true, operationId: 'batch-update', action: 'UPDATE',
      completedAt: NOW.toISOString(), tasks: [
        { taskId: 'A', taskInstanceId: first.tasks[0].taskInstanceId, versionBefore: 1,
          versionAfter: 2, assignmentEventIds: [
            createTaskAdminAssignmentEventId('batch-update', 'A', 'S001', 'UNASSIGNED'),
            createTaskAdminAssignmentEventId('batch-update', 'A', 'S002', 'ASSIGNED'),
          ] },
        { taskId: 'B', taskInstanceId: second.tasks[0].taskInstanceId, versionBefore: 1,
          versionAfter: 2, assignmentEventIds: [
            createTaskAdminAssignmentEventId('batch-update', 'B', 'S001', 'ASSIGNED'),
          ] },
      ] });
    await expect(commands().updateBatch({ ...input, tasks: [aEntry, bEntry] })).resolves.toEqual(result);
    const state = await snapshot();
    expect(state.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: 'A', title: 'A2', version: '2' }),
      expect.objectContaining({ task_id: 'B', title: 'B2', version: '2',
        prerequisite_task_instance_id: first.tasks[0].taskInstanceId }),
    ]));
  });

  it('verifies one and two target batches with six set-wise queries per verification phase', async () => {
    for (const taskId of ['A', 'B', 'C']) await commands().create({
      ...createInput(), operationId: `query-count-create-${taskId}`, taskId, allowedStudentIds: [],
    });
    const dialect = new PgDialect();
    const run = async (operationId: string, taskIds: readonly string[]) => {
      const statements: string[] = [];
      const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
        runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
          callback({ execute: async (query) => {
            const statement = typeof query === 'string' ? query : dialect.sqlToQuery(query as never).sql;
            statements.push(statement.replace(/\s+/g, ' ').trim());
            return tx.execute(query);
          } } as typeof tx)),
      });
      await adapter.updateBatch({ operationId, tasks: taskIds.map((taskId) =>
        updateBatchEntry({ taskId, isActive: true, allowedStudentIds: [] })) });
      const classify = (statement: string) => statement.includes('FROM tasks ')
        ? 'tasks' : statement.includes('FROM task_allowed_students') ? 'mirrors'
          : statement.includes('FROM task_completions') ? 'completions'
            : statement.includes('admin_operation_id=') ? 'operation-events'
              : statement.includes('FROM task_assignments') ? 'assignments' : 'unknown';
      const signature = ['tasks', 'mirrors', 'assignments', 'completions', 'tasks',
        'operation-events'];
      const starts = statements.flatMap((_statement, index) =>
        JSON.stringify(statements.slice(index, index + 6).map(classify)) === JSON.stringify(signature)
          ? [index] : []);
      expect(starts, `${taskIds.length}-target verifier starts`).toHaveLength(2);
      const phases = starts.map((start) => statements.slice(start, start + 6));
      for (const phase of phases) {
        expect(phase).toHaveLength(6);
        expect(phase.map(classify)).toEqual(signature);
        expect(phase.slice(0, 4).every((statement) => statement.includes(' IN ('))).toBe(true);
        expect(phase.slice(0, 4).some((statement) =>
          /task_instance_id=\$\d+/.test(statement))).toBe(false);
      }
      return phases;
    };
    const singletonPhases = await run('query-count-single', ['A']);
    const twoTargetPhases = await run('query-count-pair', ['B', 'C']);
    expect(singletonPhases.map((phase) => phase.length)).toEqual([6, 6]);
    expect(twoTargetPhases.map((phase) => phase.length)).toEqual([6, 6]);
  });

  it('rejects every unsafe batch shape before opening a transaction', async () => {
    let calls = 0;
    const transaction = async () => { calls += 1; throw new Error('entered transaction'); };
    const preflight = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: transaction, now: () => NOW });
    const entry = updateBatchEntry();
    const rootGetter = { operationId: 'batch', tasks: [entry] } as Record<string, unknown>;
    Object.defineProperty(rootGetter, 'tasks', { enumerable: true, get: () => [entry] });
    const itemGetter = { ...entry } as Record<string, unknown>;
    Object.defineProperty(itemGetter, 'title', { enumerable: true, get: () => 'unsafe' });
    const sparse = Array(2) as unknown[];
    sparse[0] = entry;
    const invalid: unknown[] = [
      { operationId: 'batch', tasks: [], extra: true },
      { operationId: 'batch', tasks: [entry], [Symbol('extra')]: true },
      rootGetter,
      { operationId: 'batch', tasks: 'not-an-array' },
      { operationId: 'batch', tasks: sparse },
      { operationId: 'batch', tasks: [{ ...entry, extra: true }] },
      { operationId: 'batch', tasks: [{ ...entry, [Symbol('extra')]: true }] },
      { operationId: 'batch', tasks: [itemGetter] },
      { operationId: 'batch', tasks: [] },
      { operationId: 'batch', tasks: Array.from({ length: 101 },
        (_, index) => ({ ...entry, taskId: `T${index}` })) },
      { operationId: 'batch', tasks: [entry, { ...entry, taskId: ' TASK-001 ' }] },
      { operationId: 'batch', tasks: [{ ...entry, allowedStudentIds: [' S001 ', 'S001'] }] },
      { operationId: 'batch', tasks: [entry, { ...entry, taskId: 'T2', reward: -1 }] },
      { operationId: 'batch', tasks: [{ ...entry,
        allowedStudentIds: Array.from({ length: 1001 }, (_, index) => `S${index}`) }] },
    ];
    for (const value of invalid) {
      await expect(preflight.updateBatch(value as UpdateTasksAdminBatchInput)).rejects.toThrow();
    }
    const invalidClock = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: transaction, now: () => new Date(Number.NaN) });
    await expect(invalidClock.updateBatch({ operationId: 'batch', tasks: [entry] }))
      .rejects.toThrow(/timestamp.*invalid/i);
    expect(calls).toBe(0);
  });

  it('accepts exactly 100 tasks and 1000 allowed-student references at preflight', async () => {
    let calls = 0;
    const preflight = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('entered transaction'); }, now: () => NOW });
    const entry = updateBatchEntry();
    const tasks = Array.from({ length: 100 }, (_, taskIndex) => ({ ...entry,
      taskId: `T${String(taskIndex).padStart(3, '0')}`,
      allowedStudentIds: Array.from({ length: 10 }, (_unused, studentIndex) =>
        `S${taskIndex}-${studentIndex}`),
    }));
    await expect(preflight.updateBatch({ operationId: 'batch-boundary', tasks }))
      .rejects.toThrow('entered transaction');
    expect(calls).toBe(1);
  });

  it('conflicts canonical replay when any task definition, version, or student changes', async () => {
    await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A', allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B', allowedStudentIds: [] });
    const base = updateBatchEntry({ isActive: true, allowedStudentIds: [] });
    const input = { operationId: 'batch-conflict', tasks: [
      { ...base, taskId: 'B' }, { ...base, taskId: 'A' },
    ] };
    const first = await commands().updateBatch(input);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tasks)).toBe(true);
    expect(first.tasks.map((task) => task.taskId)).toEqual(['A', 'B']);
    const stored = (await snapshot()).operations.find((row) =>
      (row as { operation_id: string }).operation_id === 'batch-conflict') as { result_snapshot: typeof first };
    expect(stored.result_snapshot.tasks.map((task) => task.taskId)).toEqual(['A', 'B']);
    await expect(commands().updateBatch({ ...input, tasks: input.tasks.map((task, index) =>
      index === 0 ? { ...task, title: 'changed' } : task) })).rejects.toThrow(/conflict/i);
    await expect(commands().updateBatch({ ...input, tasks: input.tasks.map((task, index) =>
      index === 0 ? { ...task, expectedTaskVersion: 2 } : task) })).rejects.toThrow(/conflict/i);
    await expect(commands().updateBatch({ ...input, tasks: input.tasks.map((task, index) =>
      index === 0 ? { ...task, allowedStudentIds: ['S001'] } : task) })).rejects.toThrow(/conflict/i);
  });

  it.each(['stale', 'missing', 'tombstoned', 'unsafe-version', 'future-chronology'] as const)(
    'rolls back every write when the second target is %s', async (failure) => {
      await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A', allowedStudentIds: [] });
      await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B', allowedStudentIds: [] });
      const base = updateBatchEntry({ isActive: true, allowedStudentIds: [] });
      let second = { ...base, taskId: 'B' };
      if (failure === 'stale') second = { ...second, expectedTaskVersion: 2 };
      if (failure === 'missing') second = { ...second, taskId: 'MISSING' };
      if (failure === 'tombstoned') await harness.database.query(
        `UPDATE tasks SET is_active=false, deleted_at=$2, updated_at=$2 WHERE tenant_id=$1 AND task_id='B'`,
        [harness.tenantOneId, NOW.toISOString()]);
      if (failure === 'unsafe-version') await harness.database.query(
        `UPDATE tasks SET version=$2 WHERE tenant_id=$1 AND task_id='B'`,
        [harness.tenantOneId, Number.MAX_SAFE_INTEGER]);
      if (failure === 'future-chronology') await harness.database.query(
        `UPDATE tasks SET updated_at=$2 WHERE tenant_id=$1 AND task_id='B'`,
        [harness.tenantOneId, '2026-08-30T01:00:00.001Z']);
      if (failure === 'unsafe-version') second = { ...second, expectedTaskVersion: Number.MAX_SAFE_INTEGER - 1 };
      const before = await completeSnapshot();
      await expect(commands().updateBatch({ operationId: `batch-${failure}`, tasks: [
        { ...base, taskId: 'A', title: 'A changed' }, second,
      ] })).rejects.toThrow();
      expect(await completeSnapshot()).toEqual(before);
    },
  );

  it('allows a target to reference another target that stays active regardless of caller order', async () => {
    await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A', allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B', allowedStudentIds: [] });
    const base = updateBatchEntry({ isActive: true, allowedStudentIds: [] });
    const a = { ...base, taskId: 'A', prerequisiteTaskId: 'B' };
    const b = { ...base, taskId: 'B', prerequisiteTaskId: null };
    await expect(commands().updateBatch({ operationId: 'batch-live-reference', tasks: [b, a] }))
      .resolves.toMatchObject({ tasks: [{ taskId: 'A' }, { taskId: 'B' }] });
  });

  it('rejects deactivating a simultaneous prerequisite and rolls back all state', async () => {
    await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B', allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A',
      prerequisiteTaskId: 'B', allowedStudentIds: [] });
    const base = updateBatchEntry({ isActive: true, allowedStudentIds: [] });
    const before = await completeSnapshot();
    await expect(commands().updateBatch({ operationId: 'batch-deactivate-reference', tasks: [
      { ...base, taskId: 'A', prerequisiteTaskId: 'B' },
      { ...base, taskId: 'B', isActive: false },
    ] })).rejects.toThrow(/prerequisite.*active|active.*prerequisite/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each([
    ['two-entry cycle', 'A', 'B', 'B', 'A'],
    ['self prerequisite', 'A', 'A', 'B', null],
    ['missing prerequisite', 'A', 'MISSING', 'B', null],
    ['inactive non-target prerequisite', 'A', 'INACTIVE', 'B', null],
  ] as const)('rejects %s against the final graph and rolls back', async (
    _label, firstId, firstPrerequisite, secondId, secondPrerequisite,
  ) => {
    await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A', allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B', allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'create-inactive', taskId: 'INACTIVE',
      allowedStudentIds: [], isActive: false });
    const base = updateBatchEntry({ isActive: true, allowedStudentIds: [] });
    const before = await completeSnapshot();
    await expect(commands().updateBatch({ operationId: `batch-invalid-${_label}`, tasks: [
      { ...base, taskId: firstId, prerequisiteTaskId: firstPrerequisite },
      { ...base, taskId: secondId, prerequisiteTaskId: secondPrerequisite },
    ] })).rejects.toThrow(/cycle|prerequisite/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('can atomically remove an old cycle and validates only the simultaneous final graph', async () => {
    const a = await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A', allowedStudentIds: [] });
    const b = await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B', allowedStudentIds: [] });
    await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_prerequisite_fk');
    await harness.database.query(`UPDATE tasks SET prerequisite_task_instance_id=CASE task_id
      WHEN 'A' THEN $2 ELSE $3 END WHERE tenant_id=$1 AND task_id IN ('A','B')`,
    [harness.tenantOneId, b.tasks[0].taskInstanceId, a.tasks[0].taskInstanceId]);
    const base = updateBatchEntry({ isActive: true, allowedStudentIds: [] });
    await expect(commands().updateBatch({ operationId: 'batch-break-cycle', tasks: [
      { ...base, taskId: 'B', prerequisiteTaskId: null },
      { ...base, taskId: 'A', prerequisiteTaskId: null },
    ] })).resolves.toMatchObject({ tasks: [{ taskId: 'A' }, { taskId: 'B' }] });
  });

  it('repairs a dangling physical prerequisite when the simultaneous final graph clears it', async () => {
    await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A',
      allowedStudentIds: [] });
    await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_prerequisite_fk');
    await harness.database.query(`UPDATE tasks SET prerequisite_task_instance_id=$2
      WHERE tenant_id=$1 AND task_id='A'`,
    [harness.tenantOneId, createTaskAdminTaskInstanceId('missing-operation', 'missing-physical-task')]);
    const base = updateBatchEntry({ taskId: 'A', isActive: true, allowedStudentIds: [],
      prerequisiteTaskId: null });

    await expect(commands().updateBatch({ operationId: 'batch-repair-dangling', tasks: [base] }))
      .resolves.toMatchObject({ tasks: [{ taskId: 'A' }] });
    await expect(harness.database.query(`SELECT prerequisite_task_instance_id FROM tasks
      WHERE tenant_id=$1 AND task_id='A'`, [harness.tenantOneId])).resolves.toMatchObject({
      rows: [{ prerequisite_task_instance_id: null }],
    });
  });

  it('rejects a final graph with a dangling prerequisite on a non-target row', async () => {
    await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A',
      allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'create-B', taskId: 'B',
      allowedStudentIds: [] });
    await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_prerequisite_fk');
    await harness.database.query(`UPDATE tasks SET prerequisite_task_instance_id=$2
      WHERE tenant_id=$1 AND task_id='B'`,
    [harness.tenantOneId, createTaskAdminTaskInstanceId('missing-operation', 'missing-physical-task')]);
    const before = await completeSnapshot();

    await expect(commands().updateBatch({ operationId: 'batch-retain-dangling', tasks: [
      updateBatchEntry({ taskId: 'A', isActive: true, allowedStudentIds: [], prerequisiteTaskId: null }),
    ] })).rejects.toThrow(/prerequisite/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('rejects a target whose requested final prerequisite is missing', async () => {
    await commands().create({ ...createInput(), operationId: 'create-A', taskId: 'A',
      allowedStudentIds: [] });
    const before = await completeSnapshot();
    await expect(commands().updateBatch({ operationId: 'batch-target-dangling', tasks: [
      updateBatchEntry({ taskId: 'A', isActive: true, allowedStudentIds: [],
        prerequisiteTaskId: 'MISSING' }),
    ] })).rejects.toThrow(/prerequisite/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('deduplicates the desired-student union across opposite JS and database orderings', async () => {
    const privateUse = '\uE000';
    const astral = '😀';
    await harness.database.query(`INSERT INTO students
      (tenant_id, student_id, name, status, created_at, updated_at)
      VALUES ($1, $2, 'private', 'ACTIVE', $4, $4), ($1, $3, 'astral', 'ACTIVE', $4, $4)`,
    [harness.tenantOneId, privateUse, astral, NOW.toISOString()]);
    await commands().create({ ...createInput(), operationId: 'create-private', taskId: privateUse,
      allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'create-astral', taskId: astral,
      allowedStudentIds: [] });
    const base = updateBatchEntry({ isActive: true });
    const result = await commands().updateBatch({ operationId: 'batch-opposite-order', tasks: [
      { ...base, taskId: privateUse, allowedStudentIds: [privateUse, astral] },
      { ...base, taskId: astral, allowedStudentIds: [astral] },
    ] });
    expect(result.tasks.map((task) => task.taskId)).toEqual([astral, privateUse]);
  });

  it('preserves complete existing completion evidence for every target and emits only canonical diffs', async () => {
    const a = await commands().create({ ...createInput(), operationId: 'batch-history-create-A',
      taskId: 'A', allowedStudentIds: ['S001'] });
    const b = await commands().create({ ...createInput(), operationId: 'batch-history-create-B',
      taskId: 'B', allowedStudentIds: ['S002'] });
    await seedCarryForwardCompletion(a.tasks[0].taskInstanceId, 'completion-A');
    await seedCarryForwardCompletion(b.tasks[0].taskInstanceId, 'completion-B');
    const before = await completeSnapshot();
    const base = updateBatchEntry({ isActive: true });
    const result = await commands().updateBatch({ operationId: 'batch-history-update', tasks: [
      { ...base, taskId: 'B', allowedStudentIds: ['S002'] },
      { ...base, taskId: 'A', allowedStudentIds: ['S002'] },
    ] });
    expect(result.tasks).toEqual([
      expect.objectContaining({ taskId: 'A', assignmentEventIds: [
        createTaskAdminAssignmentEventId('batch-history-update', 'A', 'S001', 'UNASSIGNED'),
        createTaskAdminAssignmentEventId('batch-history-update', 'A', 'S002', 'ASSIGNED'),
      ] }),
      expect.objectContaining({ taskId: 'B', assignmentEventIds: [] }),
    ]);
    expect((await completeSnapshot()).completions).toEqual(before.completions);
    expect((await snapshot()).audits.filter((row) =>
      (row as { operation_id: string }).operation_id === 'batch-history-update')).toHaveLength(1);
  });

  it.each([
    ['task RETURN NULL', `CREATE FUNCTION suppress_batch_later() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.task_id='B' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_batch_later BEFORE UPDATE ON tasks FOR EACH ROW
      EXECUTE FUNCTION suppress_batch_later()`],
    ['task RETURN OLD', `CREATE FUNCTION suppress_batch_later() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.task_id='B' THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_batch_later BEFORE UPDATE ON tasks FOR EACH ROW
      EXECUTE FUNCTION suppress_batch_later()`],
    ['task mutated RETURNING', `CREATE FUNCTION suppress_batch_later() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.task_id='B' THEN NEW.title='mutated-returning'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_batch_later BEFORE UPDATE ON tasks FOR EACH ROW
      EXECUTE FUNCTION suppress_batch_later()`],
    ['mirror DELETE', `CREATE FUNCTION suppress_batch_later() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.student_id='S001' THEN RETURN NULL; END IF; RETURN OLD; END $$;
      CREATE TRIGGER suppress_batch_later BEFORE DELETE ON task_allowed_students FOR EACH ROW
      EXECUTE FUNCTION suppress_batch_later()`],
    ['mirror INSERT', `CREATE FUNCTION suppress_batch_later() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.student_id='S002' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_batch_later BEFORE INSERT ON task_allowed_students FOR EACH ROW
      EXECUTE FUNCTION suppress_batch_later()`],
    ['assignment INSERT', `CREATE FUNCTION suppress_batch_later() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.admin_operation_id='batch-later-fault' AND NEW.task_id_snapshot='B'
        THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_batch_later BEFORE INSERT ON task_assignments FOR EACH ROW
      EXECUTE FUNCTION suppress_batch_later()`],
  ] as const)('reaches the later target and rolls back the complete snapshot on suppressed %s',
  async (_label, ddl) => {
    await commands().create({ ...createInput(), operationId: 'batch-fault-create-A',
      taskId: 'A', allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'batch-fault-create-B',
      taskId: 'B', allowedStudentIds: ['S001'] });
    const before = await completeSnapshot();
    await harness.database.exec(ddl);
    const base = updateBatchEntry({ isActive: true });
    await expect(commands().updateBatch({ operationId: 'batch-later-fault', tasks: [
      { ...base, taskId: 'A', title: 'A reached', allowedStudentIds: [] },
      { ...base, taskId: 'B', title: 'B reached', allowedStudentIds: ['S002'] },
    ] })).rejects.toThrow(/integrity/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('replays frozen batch success after legitimate later state changes and rejects a hard-deleted target', async () => {
    const a = await commands().create({ ...createInput(), operationId: 'batch-replay-create-A',
      taskId: 'A', allowedStudentIds: ['S001'] });
    const b = await commands().create({ ...createInput(), operationId: 'batch-replay-create-B',
      taskId: 'B', allowedStudentIds: [] });
    const base = updateBatchEntry({ isActive: true });
    const input = { operationId: 'batch-frozen-replay', tasks: [
      { ...base, taskId: 'A', allowedStudentIds: ['S002'] },
      { ...base, taskId: 'B', allowedStudentIds: [] },
    ] };
    const first = await commands().updateBatch(input);
    await harness.database.query(`UPDATE tasks SET title='later title', version=3, updated_at=$3
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, a.tasks[0].taskInstanceId, '2026-08-30T02:00:00.000Z']);
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1,$2,'S001',$3)`,
    [harness.tenantOneId, b.tasks[0].taskInstanceId, '2026-08-30T02:00:00.000Z']);
    await appendLaterSameCycleAssignment(a.tasks[0].taskInstanceId, 'S002',
      'later-legitimate-assignment', '2026-08-30T02:00:00.000Z', 'UNASSIGNED');
    await harness.database.exec(`ALTER TABLE task_assignments
      DISABLE TRIGGER task_assignments_append_only;
      UPDATE task_assignments SET previous_assignment_id=NULL
      WHERE tenant_id='${harness.tenantOneId}' AND assignment_id='later-legitimate-assignment';
      ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only;`);
    await seedCarryForwardCompletion(a.tasks[0].taskInstanceId, 'later-completion');
    await expect(commands().updateBatch(input)).resolves.toEqual(first);
    await harness.database.query(`DELETE FROM task_allowed_students
      WHERE tenant_id=$1 AND task_instance_id=$2`, [harness.tenantOneId, b.tasks[0].taskInstanceId]);
    await harness.database.query('DELETE FROM tasks WHERE tenant_id=$1 AND task_instance_id=$2',
      [harness.tenantOneId, b.tasks[0].taskInstanceId]);
    await expect(commands().updateBatch(input)).rejects.toThrow(/physical identity/i);
  });

  it.each([
    ['task', 3], ['mirror', 5], ['assignment', 6], ['completion', 7],
  ] as const)('rejects duplicate %s evidence before batch writes', async (_label, targetCall) => {
    const a = await commands().create({ ...createInput(), operationId: 'batch-raw-create-A',
      taskId: 'A', allowedStudentIds: ['S001'] });
    const b = await commands().create({ ...createInput(), operationId: 'batch-raw-create-B',
      taskId: 'B', allowedStudentIds: ['S001'] });
    await seedCarryForwardCompletion(a.tasks[0].taskInstanceId, 'batch-raw-completion-A');
    await seedCarryForwardCompletion(b.tasks[0].taskInstanceId, 'batch-raw-completion-B');
    const before = await completeSnapshot();
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          if (call !== targetCall || result.rows.length === 0) return result;
          return { ...result, rows: [...result.rows,
            { ...(result.rows[0] as Record<string, unknown>) }] } as never;
        } } as typeof tx)),
    });
    const base = updateBatchEntry({ isActive: true, allowedStudentIds: ['S001'] });
    await expect(adapter.updateBatch({ operationId: `batch-raw-${_label}`, tasks: [
      { ...base, taskId: 'A' }, { ...base, taskId: 'B' },
    ] })).rejects.toThrow(/integrity/i);
    expect(call).toBe(targetCall);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('rejects every non-raw active-student row before task writes without invoking getters', async () => {
    await commands().create({ ...createInput(), operationId: 'batch-student-create-A',
      taskId: 'A', allowedStudentIds: [] });
    const before = await completeSnapshot();
    const probes = [
      { label: 'extra key', mutate: (row: Record<string, unknown>) => ({ ...row, extra: true }) },
      { label: 'padded ID', mutate: (row: Record<string, unknown>) => ({ ...row, student_id: ' S001 ' }) },
      { label: 'boxed ID', mutate: (row: Record<string, unknown>) =>
        ({ ...row, student_id: new String('S001') }) },
      { label: 'boxed status', mutate: (row: Record<string, unknown>) =>
        ({ ...row, status: new String('ACTIVE') }) },
      { label: 'wrong prototype', mutate: (row: Record<string, unknown>) =>
        Object.assign(Object.create({ inherited: true }), row) as Record<string, unknown> },
      { label: 'symbol key', mutate: (row: Record<string, unknown>) =>
        ({ ...row, [Symbol('extra')]: true }) },
      { label: 'nonenumerable key', mutate: (row: Record<string, unknown>) => {
        const result = { ...row };
        Object.defineProperty(result, 'hidden', { value: true });
        return result;
      } },
    ];
    for (const [index, probe] of probes.entries()) {
      let call = 0;
      const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
        runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
          callback({ execute: async (query) => {
            call += 1;
            const result = await tx.execute(query);
            if (call !== 4 || result.rows.length === 0) return result;
            return { ...result, rows: [probe.mutate(
              result.rows[0] as Record<string, unknown>)] } as never;
          } } as typeof tx)),
      });
      await expect(adapter.updateBatch({ operationId: `batch-student-raw-${index}`, tasks: [
        updateBatchEntry({ taskId: 'A', isActive: true, allowedStudentIds: ['S001'] }),
      ] }), probe.label).rejects.toThrow(/student|integrity|invalid/i);
      expect(call, probe.label).toBe(4);
      expect(await completeSnapshot(), probe.label).toEqual(before);
    }

    let getterCalls = 0;
    let call = 0;
    const getterAdapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          if (call !== 4 || result.rows.length === 0) return result;
          const row = { ...(result.rows[0] as Record<string, unknown>) };
          Object.defineProperty(row, 'student_id', { enumerable: true, get: () => {
            getterCalls += 1;
            return 'S001';
          } });
          return { ...result, rows: [row] } as never;
        } } as typeof tx)),
    });
    await expect(getterAdapter.updateBatch({ operationId: 'batch-student-getter', tasks: [
      updateBatchEntry({ taskId: 'A', isActive: true, allowedStudentIds: ['S001'] }),
    ] })).rejects.toThrow(/student|integrity|invalid/i);
    expect(call).toBe(4);
    expect(getterCalls).toBe(0);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('rejects a getter-backed mirror row without invoking task_instance_id', async () => {
    await commands().create({ ...createInput(), operationId: 'batch-mirror-getter-create-A',
      taskId: 'A', allowedStudentIds: ['S001'] });
    const before = await completeSnapshot();
    let call = 0;
    let getterCalls = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          if (call !== 5 || result.rows.length === 0) return result;
          const original = result.rows[0] as Record<string, unknown>;
          const row = { ...original };
          Object.defineProperty(row, 'task_instance_id', { enumerable: true, get: () => {
            getterCalls += 1;
            return original.task_instance_id;
          } });
          return { ...result, rows: [row] } as never;
        } } as typeof tx)),
    });
    await expect(adapter.updateBatch({ operationId: 'batch-mirror-getter', tasks: [
      updateBatchEntry({ taskId: 'A', isActive: true, allowedStudentIds: ['S001'] }),
    ] })).rejects.toThrow(/mirror.*integrity/i);
    expect(call).toBe(5);
    expect(getterCalls).toBe(0);
    expect(await completeSnapshot()).toEqual(before);
  });

  const seedReplayBatch = async (operationId = 'batch-adversarial') => {
    const a = await commands().create({ ...createInput(), operationId: `${operationId}-create-A`,
      taskId: 'A', allowedStudentIds: ['S001'] });
    const b = await commands().create({ ...createInput(), operationId: `${operationId}-create-B`,
      taskId: 'B', allowedStudentIds: ['S002'] });
    const base = updateBatchEntry({ isActive: true });
    const input: UpdateTasksAdminBatchInput = { operationId, tasks: [
      { ...base, taskId: 'B', title: 'B final', allowedStudentIds: ['S002'], prerequisiteTaskId: 'A' },
      { ...base, taskId: 'A', title: 'A final', allowedStudentIds: ['S002'], prerequisiteTaskId: null },
    ] };
    return { a, b, input, result: await commands().updateBatch(input) };
  };

  it('fully validates and freezes the deterministic batch operation-claim race winner', async () => {
    const { input, result: winner } = await seedReplayBatch('batch-race-winner');
    const racing = () => createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let firstRead = true;
        return callback({ execute: async (query) => {
          if (firstRead) { firstRead = false; return { rows: [] } as never; }
          return tx.execute(query);
        } } as typeof tx);
      }),
    });
    const replay = await racing().updateBatch(input);
    expect(replay).toEqual(winner);
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay.tasks)).toBe(true);
    expect(Object.isFrozen(replay.tasks[0].assignmentEventIds)).toBe(true);
    await expect(racing().updateBatch({ ...input, tasks: input.tasks.map((task) =>
      task.taskId === 'A' ? { ...task, reward: task.reward + 1 } : task) }))
      .rejects.toThrow(/conflict/i);
  });

  it.each([
    ['audit RETURN NULL', `CREATE FUNCTION alter_batch_late_stage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id='batch-late-stage' AND NEW.event_type='TASK_ADMIN_COMPLETED'
        THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER alter_batch_late_stage BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION alter_batch_late_stage()`],
    ['terminal RETURN NULL', `CREATE FUNCTION alter_batch_late_stage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status='PENDING' AND NEW.status='SUCCEEDED'
        AND NEW.operation_id='batch-late-stage' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER alter_batch_late_stage BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION alter_batch_late_stage()`],
    ['terminal RETURN OLD', `CREATE FUNCTION alter_batch_late_stage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status='PENDING' AND NEW.status='SUCCEEDED'
        AND NEW.operation_id='batch-late-stage' THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER alter_batch_late_stage BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION alter_batch_late_stage()`],
    ['terminal mutated evidence', `CREATE FUNCTION alter_batch_late_stage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status='PENDING' AND NEW.status='SUCCEEDED'
        AND NEW.operation_id='batch-late-stage' THEN NEW.result_snapshot=jsonb_set(
          NEW.result_snapshot, '{tasks,0,versionAfter}', '999'); END IF; RETURN NEW; END $$;
      CREATE TRIGGER alter_batch_late_stage BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION alter_batch_late_stage()`],
  ] as const)('reaches and rejects batch %s with exact snapshot rollback', async (_label, ddl) => {
    await commands().create({ ...createInput(), operationId: 'batch-late-create-A',
      taskId: 'A', allowedStudentIds: ['S001'] });
    await commands().create({ ...createInput(), operationId: 'batch-late-create-B',
      taskId: 'B', allowedStudentIds: ['S002'] });
    const before = await completeSnapshot();
    await harness.database.exec(ddl);
    const base = updateBatchEntry({ isActive: true });
    await expect(commands().updateBatch({ operationId: 'batch-late-stage', tasks: [
      { ...base, taskId: 'A', title: 'A reached', allowedStudentIds: ['S002'] },
      { ...base, taskId: 'B', title: 'B reached', allowedStudentIds: ['S002'] },
    ] })).rejects.toThrow(/integrity|replayable|stored/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('rejects duplicate audit cardinality evidence after the batch audit stage and rolls back', async () => {
    await commands().create({ ...createInput(), operationId: 'batch-audit-cardinality-create-A',
      taskId: 'A', allowedStudentIds: ['S001'] });
    const before = await completeSnapshot();
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          const result = await tx.execute(query);
          if (result.rows.length === 1
            && Object.hasOwn(result.rows[0] as object, 'event_id')) {
            return { ...result, rows: [...result.rows, ...result.rows] } as never;
          }
          return result;
        } } as typeof tx)),
    });
    await expect(adapter.updateBatch({ operationId: 'batch-audit-cardinality', tasks: [
      updateBatchEntry({ taskId: 'A', isActive: true, allowedStudentIds: ['S002'] }),
    ] })).rejects.toThrow(/audit.*integrity/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each([
    ['audit', 'task metadata/version', '', `UPDATE tasks SET title='post-audit-task', version=version+1
      WHERE tenant_id=NEW.tenant_id AND task_id='A'`],
    ['terminal', 'task metadata/version', '', `UPDATE tasks SET title='post-terminal-task', version=version+1
      WHERE tenant_id=NEW.tenant_id AND task_id='A'`],
    ['audit', 'mirror recreation', '', `INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at)
      SELECT tenant_id, task_instance_id, 'S001', NEW.occurred_at FROM tasks
      WHERE tenant_id=NEW.tenant_id AND task_id='A'`],
    ['terminal', 'mirror deletion', '', `DELETE FROM task_allowed_students
      WHERE tenant_id=NEW.tenant_id AND student_id='S002'`],
    ['audit', 'assignment injection', '', `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      SELECT tenant_id, assignment_id || ':post-audit', task_id_snapshot, task_instance_id,
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
       event_type, 'LEGACY_SEED', NULL, NULL, NULL, created_at, schema_version, NULL
      FROM task_assignments WHERE tenant_id=NEW.tenant_id
       AND admin_operation_id='batch-post-write' ORDER BY event_sequence LIMIT 1`],
    ['terminal', 'assignment tamper', 'assignment', `UPDATE task_assignments SET note='post-terminal-tamper'
      WHERE tenant_id=NEW.tenant_id AND admin_operation_id='batch-post-write'`],
    ['audit', 'completion injection', '', `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, schema_version, created_at)
      SELECT tenant_id, completion_id || ':post-audit', completed_at, task_instance_id,
       task_id_snapshot, task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, schema_version, created_at
      FROM task_completions WHERE tenant_id=NEW.tenant_id ORDER BY event_sequence LIMIT 1`],
    ['terminal', 'preexisting completion deletion', 'completion', `DELETE FROM task_completions
      WHERE tenant_id=NEW.tenant_id`],
    ['audit', 'final prerequisite graph corruption', 'graph', `UPDATE tasks
      SET prerequisite_task_instance_id='missing-post-audit-instance'
      WHERE tenant_id=NEW.tenant_id AND task_id='B'`],
    ['terminal', 'final prerequisite graph corruption', 'graph', `UPDATE tasks
      SET prerequisite_task_instance_id='missing-post-terminal-instance'
      WHERE tenant_id=NEW.tenant_id AND task_id='B'`],
  ] as const)('rolls back %s-stage batch %s fault after that stage is reached',
  async (stage, _stateClass, guard, body) => {
    const a = await commands().create({ ...createInput(), operationId: `batch-post-${stage}-create-A`,
      taskId: 'A', allowedStudentIds: ['S001'] });
    await commands().create({ ...createInput(), operationId: `batch-post-${stage}-create-B`,
      taskId: 'B', allowedStudentIds: ['S002'] });
    await seedCarryForwardCompletion(a.tasks[0].taskInstanceId, `batch-post-${stage}-completion`);
    if (guard === 'assignment') await harness.database.exec(
      'ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only');
    if (guard === 'completion') await harness.database.exec(
      'ALTER TABLE task_completions DISABLE TRIGGER task_completions_append_only');
    if (guard === 'graph') await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_prerequisite_fk');
    const before = await completeSnapshot();
    const trigger = stage === 'audit'
      ? `AFTER INSERT ON audit_events FOR EACH ROW WHEN (NEW.operation_id='batch-post-write')`
      : `AFTER UPDATE ON operations FOR EACH ROW WHEN
        (OLD.status='PENDING' AND NEW.status='SUCCEEDED' AND NEW.operation_id='batch-post-write')`;
    await harness.database.exec(`CREATE FUNCTION mutate_batch_post_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${body}; RETURN NEW; END $$;
      CREATE TRIGGER mutate_batch_post_write ${trigger} EXECUTE FUNCTION mutate_batch_post_write()`);
    const base = updateBatchEntry({ isActive: true });
    await expect(commands().updateBatch({ operationId: 'batch-post-write', tasks: [
      { ...base, taskId: 'A', title: 'A verified', allowedStudentIds: ['S002'] },
      { ...base, taskId: 'B', title: 'B verified', allowedStudentIds: ['S002'], prerequisiteTaskId: 'A' },
    ] })).rejects.toThrow(/integrity|cycle|prerequisite/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each([
    ['missing', `DELETE FROM task_assignments WHERE admin_operation_id='batch-replay-events'`],
    ['tampered', `UPDATE task_assignments SET note='tampered'
      WHERE admin_operation_id='batch-replay-events'`],
    ['extra', `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      SELECT tenant_id, assignment_id || ':extra', task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note FROM task_assignments
      WHERE admin_operation_id='batch-replay-events' ORDER BY event_sequence LIMIT 1`],
  ] as const)('rejects batch replay with %s original operation-bound event evidence',
  async (_label, mutation) => {
    const { input } = await seedReplayBatch('batch-replay-events');
    await harness.database.exec(`ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only;
      ${mutation}; ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only`);
    await expect(commands().updateBatch(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it('rejects an extra same-operation event for the batch target that originally emitted zero events', async () => {
    const { b, input } = await seedReplayBatch('batch-zero-target-event');
    const operation = await harness.database.query(`SELECT payload_hash FROM operations
      WHERE tenant_id=$1 AND operation_id=$2`, [harness.tenantOneId, input.operationId]);
    const task = await harness.database.query(`SELECT current_schedule, created_at FROM tasks
      WHERE tenant_id=$1 AND task_instance_id=$2`, [harness.tenantOneId, b.tasks[0].taskInstanceId]);
    const row = task.rows[0] as { current_schedule: Parameters<typeof getTaskCycle>[0]['schedule']; created_at: Date };
    const cycle = getTaskCycle({ taskInstanceId: b.tasks[0].taskInstanceId,
      schedule: row.current_schedule, taskCreatedAt: row.created_at.toISOString(), now: NOW.toISOString() });
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      VALUES ($1, 'batch-zero-target-extra', 'B', $2, $3, $4, $5, 1, 'Asia/Seoul',
       'S001', 'ASSIGNED', 'ADMIN', NULL, $6, $7, $8, 1, NULL)`,
    [harness.tenantOneId, b.tasks[0].taskInstanceId, cycle.cycleId, cycle.startsAt, cycle.endsAt,
      input.operationId, (operation.rows[0] as { payload_hash: string }).payload_hash, NOW.toISOString()]);
    await expect(commands().updateBatch(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it.each([
    ['task omission', `result_snapshot #- '{tasks,1}'`],
    ['task reordering', `jsonb_set(result_snapshot, '{tasks}',
      jsonb_build_array(result_snapshot#>'{tasks,1}', result_snapshot#>'{tasks,0}'))`],
    ['wrong version', `jsonb_set(result_snapshot, '{tasks,0,versionAfter}', '9')`],
    ['padded event ID', `jsonb_set(result_snapshot, '{tasks,0,assignmentEventIds,0}',
      to_jsonb(' ' || (result_snapshot#>>'{tasks,0,assignmentEventIds,0}') || ' '))`],
  ] as const)('rejects batch replay stored-result %s', async (_label, expression) => {
    const { input } = await seedReplayBatch('batch-result-tamper');
    await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET result_snapshot=${expression} WHERE operation_id='batch-result-tamper';
      ALTER TABLE operations ENABLE ALWAYS TRIGGER operations_update_guard`);
    await expect(commands().updateBatch(input)).rejects.toThrow(/stored|assignment event integrity/i);
  });

  it('rejects boxed raw frozen event IDs returned by the replay adapter', async () => {
    const { input } = await seedReplayBatch('batch-boxed-result');
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          const result = await tx.execute(query);
          if (result.rows.length !== 1 || !(result.rows[0] as { result_snapshot?: unknown }).result_snapshot) {
            return result;
          }
          const row = result.rows[0] as { result_snapshot: TaskAdminUpdateSuccess };
          return { ...result, rows: [{ ...row, result_snapshot: { ...row.result_snapshot,
            tasks: row.result_snapshot.tasks.map((task, index) => index === 0 ? { ...task,
              assignmentEventIds: task.assignmentEventIds.map((id) => new String(id)) } : task),
          } }] } as never;
        } } as typeof tx)),
    });
    await expect(adapter.updateBatch(input)).rejects.toThrow(/stored|invalid/i);
  });

  it.each([
    ['missing', `DELETE FROM audit_events WHERE operation_id='batch-audit-replay'`],
    ['extra', `INSERT INTO audit_events
      (tenant_id, event_id, operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at)
      SELECT tenant_id, event_id || ':extra', operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at FROM audit_events WHERE operation_id='batch-audit-replay'`],
    ['action', `UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,
      '{action}', '"CREATE"') WHERE operation_id='batch-audit-replay'`],
    ['taskCount', `UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,
      '{taskCount}', '1') WHERE operation_id='batch-audit-replay'`],
    ['assignmentEventCount', `UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,
      '{assignmentEventCount}', '99') WHERE operation_id='batch-audit-replay'`],
    ['hash', `UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,
      '{resultHash}', to_jsonb(repeat('a',64))) WHERE operation_id='batch-audit-replay'`],
    ['timestamp', `UPDATE audit_events SET occurred_at=occurred_at + interval '1 second'
      WHERE operation_id='batch-audit-replay'`],
  ] as const)('rejects batch replay audit %s tampering', async (_label, mutation) => {
    const { input } = await seedReplayBatch('batch-audit-replay');
    await harness.database.exec(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
      ${mutation}; ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable`);
    await expect(commands().updateBatch(input)).rejects.toThrow(/audit/i);
  });

  it.each([
    ['kind', 'ALTER TABLE operations DROP CONSTRAINT operations_kind_check', `operation_kind='OTHER'`],
    ['hash', '', `payload_hash=repeat('a',64)`],
    ['status', 'ALTER TABLE operations DROP CONSTRAINT operations_terminal_shape_check', `status='PENDING'`],
    ['attempt', '', `attempt_count=2`],
    ['timestamp', 'ALTER TABLE operations DROP CONSTRAINT operations_chronology_check',
      `started_at=started_at - interval '1 second'`],
  ] as const)('rejects batch replay operation %s tampering', async (_label, prepare, mutation) => {
    const { input } = await seedReplayBatch('batch-operation-replay');
    if (prepare) await harness.database.exec(prepare);
    await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET ${mutation} WHERE operation_id='batch-operation-replay';
      ALTER TABLE operations ENABLE ALWAYS TRIGGER operations_update_guard`);
    await expect(commands().updateBatch(input)).rejects.toThrow(/conflict|replayable|timestamp|operation/i);
  });

  it('updates and replays identical batch task and operation IDs independently in two tenants', async () => {
    for (const tenantId of [harness.tenantOneId, harness.tenantTwoId]) {
      await commands(tenantId).create({ ...createInput(), operationId: 'tenant-batch-create-A',
        taskId: 'A', allowedStudentIds: ['S001'] });
      await commands(tenantId).create({ ...createInput(), operationId: 'tenant-batch-create-B',
        taskId: 'B', allowedStudentIds: ['S002'] });
    }
    const base = updateBatchEntry({ isActive: true });
    const input: UpdateTasksAdminBatchInput = { operationId: 'same-tenant-batch-operation', tasks: [
      { ...base, taskId: 'A', title: 'tenant A', allowedStudentIds: ['S002'] },
      { ...base, taskId: 'B', title: 'tenant B', allowedStudentIds: ['S002'], prerequisiteTaskId: 'A' },
    ] };
    const one = await commands(harness.tenantOneId).updateBatch(input);
    const two = await commands(harness.tenantTwoId).updateBatch(input);
    expect(two).toEqual(one);
    await expect(commands(harness.tenantOneId).updateBatch(input)).resolves.toEqual(one);
    await expect(commands(harness.tenantTwoId).updateBatch(input)).resolves.toEqual(two);
    expect((await snapshot(harness.tenantOneId)).tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: 'A', title: 'tenant A', version: '2' }),
      expect.objectContaining({ task_id: 'B', title: 'tenant B', version: '2' }),
    ]));
    expect((await snapshot(harness.tenantTwoId)).tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: 'A', title: 'tenant A', version: '2' }),
      expect.objectContaining({ task_id: 'B', title: 'tenant B', version: '2' }),
    ]));
  });
});

describe('database task administrator DELETE command', () => {
  it('atomically tombstones one task, removes mirrors, and appends ordered unassignments', async () => {
    const created = await commands().create(createInput());
    await seedCarryForwardCompletion(created.tasks[0].taskInstanceId);
    const before = await completeSnapshot();
    const result = await commands().delete(deleteInput());
    const expectedIds = ['S001', 'S002'].map((studentId) => createTaskAdminAssignmentEventId(
      'task-admin-delete-op', 'TASK-001', studentId, 'UNASSIGNED'));
    expect(result).toEqual({ ok: true, operationId: 'task-admin-delete-op', action: 'DELETE',
      completedAt: NOW.toISOString(), tasks: [{ taskId: 'TASK-001',
        taskInstanceId: created.tasks[0].taskInstanceId, versionBefore: 1, versionAfter: 2,
        assignmentEventIds: expectedIds }] });
    expect(Object.isFrozen(result)).toBe(true);
    const after = await completeSnapshot();
    expect(after.tasks).toEqual([expect.objectContaining({
      task_instance_id: created.tasks[0].taskInstanceId, is_active: false, version: '2',
      deleted_at: NOW, updated_at: NOW,
      current_schedule: (before.tasks[0] as Record<string, unknown>).current_schedule,
      pending_schedule: (before.tasks[0] as Record<string, unknown>).pending_schedule,
      prerequisite_task_instance_id:
        (before.tasks[0] as Record<string, unknown>).prerequisite_task_instance_id,
    })]);
    expect(after.mirrors).toEqual([]);
    expect(after.assignments).toHaveLength(4);
    for (const [index, assignmentId] of expectedIds.entries()) {
      expect(after.assignments).toContainEqual(expect.objectContaining({ assignment_id: assignmentId,
        student_id: `S00${index + 1}`, event_type: 'UNASSIGNED', source: 'ADMIN',
        previous_assignment_id: (before.assignments[index] as { assignment_id: string }).assignment_id }));
    }
    expect(after.completions).toEqual(before.completions);
  });

  it('supports zero mirrors and replays exact frozen zero-event evidence', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    const first = await commands().delete(deleteInput());
    expect(first.tasks[0].assignmentEventIds).toEqual([]);
    await expect(commands().delete(deleteInput())).resolves.toEqual(first);
    const state = await completeSnapshot();
    expect(state.mirrors).toEqual([]);
    expect(state.assignments).toEqual([]);
  });

  it('rejects malformed input before transaction entry', async () => {
    let calls = 0;
    const preflight = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); }, now: () => NOW });
    const getter = { ...deleteInput() } as Record<string, unknown>;
    Object.defineProperty(getter, 'taskId', { enumerable: true, get: () => 'TASK-001' });
    for (const input of [
      { ...deleteInput(), extra: true }, getter,
      { ...deleteInput(), expectedTaskVersion: 0 },
      { ...deleteInput(), expectedTaskVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) await expect(preflight.delete(input as never)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('rolls back stale, missing, tombstoned, and active or inactive dependent targets', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: [] });
    await commands().create({ ...createInput(), operationId: 'dependent-create', taskId: 'DEPENDENT',
      prerequisiteTaskId: 'TASK-001', allowedStudentIds: [] });
    const before = await completeSnapshot();
    await expect(commands().delete(deleteInput({ operationId: 'stale-delete', expectedTaskVersion: 2 })))
      .rejects.toThrow(/stale|version/i);
    await expect(commands().delete(deleteInput({ operationId: 'active-dependent-delete' })))
      .rejects.toThrow(/dependent/i);
    await harness.database.query(`UPDATE tasks SET is_active=false WHERE tenant_id=$1 AND task_id='DEPENDENT'`,
      [harness.tenantOneId]);
    const inactiveBefore = await completeSnapshot();
    await expect(commands().delete(deleteInput({ operationId: 'inactive-dependent-delete' })))
      .rejects.toThrow(/dependent/i);
    expect(await completeSnapshot()).toEqual(inactiveBefore);
    await harness.database.query(`UPDATE tasks SET is_active=true WHERE tenant_id=$1 AND task_id='DEPENDENT'`,
      [harness.tenantOneId]);
    expect(await completeSnapshot()).toEqual(before);
    await harness.database.query(`UPDATE tasks SET prerequisite_task_instance_id=NULL
      WHERE tenant_id=$1 AND task_id='DEPENDENT'`, [harness.tenantOneId]);
    await commands().delete(deleteInput({ operationId: 'valid-delete' }));
    await expect(commands().delete(deleteInput({ operationId: 'already-deleted' })))
      .rejects.toThrow(/not found/i);
    await expect(commands().delete(deleteInput({ operationId: 'missing-delete', taskId: 'MISSING' })))
      .rejects.toThrow(/not found/i);
    expect(created.tasks[0].taskInstanceId).toBeTruthy();
  });

  it('accepts retained LEGACY and QR histories and links DELETE to the latest current-cycle event', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const taskInstanceId = created.tasks[0].taskInstanceId;
    await harness.database.exec(`ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only;
      UPDATE task_assignments SET source='LEGACY_SEED', previous_assignment_id=NULL,
        admin_operation_id=NULL, admin_operation_hash=NULL WHERE tenant_id='${harness.tenantOneId}';
      ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only;`);
    await appendLaterSameCycleAssignment(taskInstanceId, 'S001', 'qr-before-delete',
      NOW.toISOString(), 'ASSIGNED', 'QR');
    const result = await commands().delete(deleteInput());
    expect((await snapshot()).assignments).toContainEqual(expect.objectContaining({
      assignment_id: result.tasks[0].assignmentEventIds[0],
      previous_assignment_id: 'qr-before-delete', event_type: 'UNASSIGNED',
    }));
  });

  it('accepts a valid prior-cycle CARRY_FORWARD history before DELETE', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const initial = await harness.database.query(`SELECT assignment_id, cycle_id, cycle_start_at,
      cycle_end_at, rule_version, timezone FROM task_assignments
      WHERE tenant_id=$1 AND task_instance_id=$2 ORDER BY event_sequence LIMIT 1`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId]);
    const row = initial.rows[0] as { assignment_id: string; cycle_id: string;
      cycle_start_at: Date; cycle_end_at: Date | null; rule_version: number; timezone: string };
    const priorStart = new Date(row.cycle_start_at.getTime() - 86_400_000);
    const priorCycleId = `v1|${created.tasks[0].taskInstanceId}|r${row.rule_version}|${priorStart.toISOString().replace('.000Z', 'Z')}`;
    await harness.database.exec('ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only');
    await harness.database.query(`UPDATE task_assignments SET source='LEGACY_SEED', cycle_id=$1,
      cycle_start_at=$2, cycle_end_at=$3, previous_assignment_id=NULL, admin_operation_id=NULL,
      admin_operation_hash=NULL WHERE tenant_id=$4 AND assignment_id=$5`,
    [priorCycleId, priorStart.toISOString(), row.cycle_start_at.toISOString(),
      harness.tenantOneId, row.assignment_id]);
    await harness.database.exec('ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only');
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, created_at, schema_version, note)
      VALUES ($1, 'carry-before-delete', 'TASK-001', $2, $3, $4, $5, $6, $7, 'S001',
       'ASSIGNED', 'CARRY_FORWARD', $8, $9, 1, NULL)`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId, row.cycle_id,
      row.cycle_start_at.toISOString(), row.cycle_end_at?.toISOString() ?? null,
      row.rule_version, row.timezone, row.assignment_id, NOW.toISOString()]);
    const result = await commands().delete(deleteInput());
    expect((await snapshot()).assignments).toContainEqual(expect.objectContaining({
      assignment_id: result.tasks[0].assignmentEventIds[0], previous_assignment_id: 'carry-before-delete',
    }));
  });

  it('rejects an invalid clock before transaction entry', async () => {
    let calls = 0;
    const invalidClock = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: async () => { calls += 1; throw new Error('sentinel'); },
      now: () => new Date(Number.NaN) });
    await expect(invalidClock.delete(deleteInput())).rejects.toThrow(/timestamp.*invalid/i);
    expect(calls).toBe(0);
  });

  it.each([
    ['created after updated', "created_at='2026-08-30T01:00:01Z'"],
    ['updated after now', "updated_at='2026-08-30T01:00:01Z'"],
  ])('rejects corrupt target chronology (%s) and rolls back', async (_label, mutation) => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    await harness.database.exec(`ALTER TABLE tasks DROP CONSTRAINT tasks_updated_chronology_check;
      UPDATE tasks SET ${mutation} WHERE tenant_id='${harness.tenantOneId}' AND task_id='TASK-001'`);
    const before = await completeSnapshot();
    await expect(commands().delete(deleteInput())).rejects.toThrow(/chronology.*integrity|task row integrity/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it('rejects an unsafe stored successor before mutation', async () => {
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    await harness.database.query(`UPDATE tasks SET version=$3 WHERE tenant_id=$1 AND task_id=$2`,
      [harness.tenantOneId, 'TASK-001', Number.MAX_SAFE_INTEGER.toString()]);
    const before = await completeSnapshot();
    let calls = 0;
    const counted = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
      runTenantTransaction: (tenantId, callback) => { calls += 1;
        return harness.runTenantTransaction(tenantId, callback); }, now: () => NOW });
    await expect(counted.delete(deleteInput({ expectedTaskVersion: Number.MAX_SAFE_INTEGER })))
      .rejects.toThrow(/successor|version|safe/i);
    expect(calls).toBe(1);
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each([
    ['audit', 'task metadata', false, `UPDATE tasks SET title='audit-tampered', version=version+1
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['terminal', 'task metadata', false, `UPDATE tasks SET title='terminal-tampered', version=version+1
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['audit', 'task lifecycle', false, `UPDATE tasks SET deleted_at=NULL, updated_at=NEW.occurred_at
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['terminal', 'task lifecycle', false, `UPDATE tasks SET deleted_at=NULL, updated_at=NEW.updated_at
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['audit', 'mirror recreation', false, `INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at)
      SELECT tenant_id, task_instance_id, 'S001', NEW.occurred_at FROM tasks
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['terminal', 'mirror recreation', false, `INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at)
      SELECT tenant_id, task_instance_id, 'S001', NEW.updated_at FROM tasks
      WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['audit', 'extra assignment', false, `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, created_at, schema_version, note)
      SELECT tenant_id, assignment_id || ':audit-extra', task_id_snapshot, task_instance_id,
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
       'ASSIGNED', 'LEGACY_SEED', NULL, created_at, schema_version, NULL
      FROM task_assignments WHERE tenant_id=NEW.tenant_id ORDER BY event_sequence LIMIT 1`],
    ['terminal', 'extra assignment', false, `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, created_at, schema_version, note)
      SELECT tenant_id, assignment_id || ':terminal-extra', task_id_snapshot, task_instance_id,
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
       'ASSIGNED', 'LEGACY_SEED', NULL, created_at, schema_version, NULL
      FROM task_assignments WHERE tenant_id=NEW.tenant_id ORDER BY event_sequence LIMIT 1`],
    ['audit', 'completion insert', false, `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, schema_version, created_at)
      SELECT tenant_id, 'audit-delete-completion', NEW.occurred_at, task_instance_id, task_id,
       title, 'S001', '하나', 0, 0, 0, 'COMPLETED', 'audit-delete-cycle',
       NEW.occurred_at, NULL, 1, 'Asia/Seoul', 'CARRY_FORWARD', 1, NEW.occurred_at
      FROM tasks WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['terminal', 'completion insert', false, `INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, schema_version, created_at)
      SELECT tenant_id, 'terminal-delete-completion', NEW.updated_at, task_instance_id, task_id,
       title, 'S001', '하나', 0, 0, 0, 'COMPLETED', 'terminal-delete-cycle',
       NEW.updated_at, NULL, 1, 'Asia/Seoul', 'CARRY_FORWARD', 1, NEW.updated_at
      FROM tasks WHERE tenant_id=NEW.tenant_id AND task_id='TASK-001'`],
    ['audit', 'completion delete', true, `ALTER TABLE task_completions DISABLE TRIGGER task_completions_append_only;
      DELETE FROM task_completions WHERE tenant_id=NEW.tenant_id;
      ALTER TABLE task_completions ENABLE ALWAYS TRIGGER task_completions_append_only`],
    ['terminal', 'completion delete', true, `ALTER TABLE task_completions DISABLE TRIGGER task_completions_append_only;
      DELETE FROM task_completions WHERE tenant_id=NEW.tenant_id;
      ALTER TABLE task_completions ENABLE ALWAYS TRIGGER task_completions_append_only`],
  ] as const)('rolls back %s-stage DELETE %s fault with the complete snapshot',
  async (stage, _stateClass, needsCompletion, body) => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    if (needsCompletion) await seedCarryForwardCompletion(created.tasks[0].taskInstanceId);
    const before = await completeSnapshot();
    const trigger = stage === 'audit'
      ? `AFTER INSERT ON audit_events FOR EACH ROW WHEN (NEW.operation_id='task-admin-delete-op')`
      : `AFTER UPDATE ON operations FOR EACH ROW WHEN
        (NEW.operation_id='task-admin-delete-op' AND NEW.status='SUCCEEDED')`;
    await harness.database.exec(`CREATE FUNCTION mutate_delete_state() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${body}; RETURN NEW; END $$;
      CREATE TRIGGER mutate_delete_state ${trigger} EXECUTE FUNCTION mutate_delete_state()`);
    await expect(commands().delete(deleteInput())).rejects.toThrow();
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each([
    ['duplicate task', 3, 'task_id', 'duplicate'],
    ['padded task', 3, 'task_id', 'padded'],
    ['boxed task', 3, 'task_id', 'boxed'],
    ['duplicate mirror', 4, 'student_id', 'duplicate'],
    ['padded mirror', 4, 'student_id', 'padded'],
    ['boxed mirror', 4, 'student_id', 'boxed'],
    ['duplicate assignment', 5, 'assignment_id', 'duplicate'],
    ['padded assignment', 5, 'assignment_id', 'padded'],
    ['boxed assignment', 5, 'assignment_id', 'boxed'],
    ['duplicate completion', 6, 'completion_id', 'duplicate'],
    ['padded completion', 6, 'completion_id', 'padded'],
    ['boxed completion', 6, 'completion_id', 'boxed'],
  ] as const)('rejects raw DELETE-path %s evidence before mutation',
  async (_label, targetCall, key, mode) => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    await seedCarryForwardCompletion(created.tasks[0].taskInstanceId);
    const before = await completeSnapshot();
    let call = 0;
    const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
        callback({ execute: async (query) => {
          call += 1;
          const result = await tx.execute(query);
          if (call !== targetCall) return result;
          if (mode === 'duplicate') return { ...result, rows: [...result.rows, ...result.rows] } as never;
          return { ...result, rows: result.rows.map((raw) => {
            const row = raw as Record<string, unknown>;
            const value = row[key];
            return { ...row, [key]: mode === 'padded' ? ` ${String(value)} ` : new String(String(value)) };
          }) } as never;
        } } as typeof tx)),
    });
    await expect(adapter.delete(deleteInput())).rejects.toThrow(/integrity|invalid/i);
    expect(await completeSnapshot()).toEqual(before);
  });

  it.each(['duplicate', 'padded', 'boxed'] as const)(
    'rejects raw replay operation evidence that is %s', async (mode) => {
      const input = deleteInput();
      await commands().create({ ...createInput(), allowedStudentIds: [] });
      await commands().delete(input);
      const before = await completeSnapshot();
      const adapter = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
        runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) =>
          callback({ execute: async (query) => {
            const result = await tx.execute(query);
            if (!result.rows.some((row) => (row as { operation_id?: unknown }).operation_id === input.operationId)) {
              return result;
            }
            if (mode === 'duplicate') return { ...result, rows: [...result.rows, ...result.rows] } as never;
            return { ...result, rows: result.rows.map((raw) => ({ ...(raw as Record<string, unknown>),
              operation_id: mode === 'padded' ? ` ${input.operationId} ` : new String(input.operationId) })) } as never;
          } } as typeof tx)),
      });
      await expect(adapter.delete(input)).rejects.toThrow(/operation.*integrity|database identity/i);
      expect(await completeSnapshot()).toEqual(before);
    },
  );

  it('replays the exact frozen result, conflicts on changed input, and handles the claim race loser', async () => {
    await commands().create(createInput());
    const input = deleteInput();
    const first = await commands().delete(input);
    const replay = await commands().delete(input);
    expect(replay).toEqual(first);
    expect(Object.isFrozen(replay)).toBe(true);
    await expect(commands().delete({ ...input, expectedTaskVersion: 2 })).rejects.toThrow(/conflict/i);
    const racing = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId, now: () => NOW,
      runTenantTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (tx) => {
        let firstRead = true;
        return callback({ execute: async (query) => {
          if (firstRead) { firstRead = false; return { rows: [] } as never; }
          return tx.execute(query);
        } } as typeof tx);
      }),
    });
    await expect(racing.delete(input)).resolves.toEqual(first);
  });

  it('replays after legitimate later task, mirror, assignment, and completion state', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    const input = deleteInput();
    const first = await commands().delete(input);
    await harness.database.query(`UPDATE tasks SET title='later', version=3, updated_at=$3, deleted_at=$3
      WHERE tenant_id=$1 AND task_instance_id=$2`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId, '2026-08-30T02:00:00.000Z']);
    await harness.database.query(`INSERT INTO task_allowed_students
      (tenant_id, task_instance_id, student_id, created_at) VALUES ($1, $2, 'S002', $3)`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId, '2026-08-30T02:00:00.000Z']);
    await appendLaterSameCycleAssignment(created.tasks[0].taskInstanceId, 'S002',
      'later-delete-assignment', '2026-08-30T02:00:00.000Z');
    await seedCarryForwardCompletion(created.tasks[0].taskInstanceId, 'later-delete-completion');
    await expect(commands().delete(input)).resolves.toEqual(first);
  });

  it('rejects replay after the physical task identity is hard-deleted', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: [] });
    const input = deleteInput();
    await commands().delete(input);
    await harness.database.exec('ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only');
    await harness.database.query('DELETE FROM task_assignments WHERE tenant_id=$1 AND task_instance_id=$2',
      [harness.tenantOneId, created.tasks[0].taskInstanceId]);
    await harness.database.query('DELETE FROM tasks WHERE tenant_id=$1 AND task_instance_id=$2',
      [harness.tenantOneId, created.tasks[0].taskInstanceId]);
    await expect(commands().delete(input)).rejects.toThrow(/physical identity/i);
  });

  it.each([
    ['missing', `DELETE FROM task_assignments WHERE admin_operation_id='task-admin-delete-op'`],
    ['tampered', `UPDATE task_assignments SET event_type='ASSIGNED'
      WHERE admin_operation_id='task-admin-delete-op'`],
    ['extra', `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note)
      SELECT tenant_id, assignment_id || ':extra', task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
       previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
       schema_version, note FROM task_assignments
      WHERE admin_operation_id='task-admin-delete-op'`],
  ])('rejects replay with %s original DELETE assignment evidence', async (_label, tamper) => {
    const input = deleteInput();
    await commands().create({ ...createInput(), allowedStudentIds: ['S001'] });
    await commands().delete(input);
    await harness.database.exec(`ALTER TABLE task_assignments DISABLE TRIGGER task_assignments_append_only;
      ${tamper}; ALTER TABLE task_assignments ENABLE ALWAYS TRIGGER task_assignments_append_only`);
    await expect(commands().delete(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it('rejects an extra operation-bound event for an originally zero-event DELETE', async () => {
    const created = await commands().create({ ...createInput(), allowedStudentIds: [] });
    const input = deleteInput();
    await commands().delete(input);
    const task = await harness.database.query('SELECT current_schedule, created_at FROM tasks WHERE task_instance_id=$1',
      [created.tasks[0].taskInstanceId]);
    const row = task.rows[0] as { current_schedule: Parameters<typeof getTaskCycle>[0]['schedule']; created_at: Date };
    const cycle = getTaskCycle({ taskInstanceId: created.tasks[0].taskInstanceId,
      schedule: row.current_schedule, taskCreatedAt: row.created_at.toISOString(), now: NOW.toISOString() });
    const operation = await harness.database.query(`SELECT payload_hash FROM operations
      WHERE tenant_id=$1 AND operation_id='task-admin-delete-op'`, [harness.tenantOneId]);
    await harness.database.query(`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, student_id, event_type, source,
       admin_operation_id, admin_operation_hash, created_at, schema_version, note)
      VALUES ($1, 'zero-delete-extra', 'TASK-001', $2, $3, $4, $5, 1, 'Asia/Seoul',
       'S001', 'UNASSIGNED', 'ADMIN', 'task-admin-delete-op', $6, $7, 1, NULL)`,
    [harness.tenantOneId, created.tasks[0].taskInstanceId, cycle.cycleId, cycle.startsAt,
      cycle.endsAt, (operation.rows[0] as { payload_hash: string }).payload_hash, NOW.toISOString()]);
    await expect(commands().delete(input)).rejects.toThrow(/assignment event integrity/i);
  });

  it.each([
    ['missing', `DELETE FROM audit_events WHERE operation_id='task-admin-delete-op'`],
    ['extra', `INSERT INTO audit_events
      (tenant_id, event_id, operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at)
      SELECT tenant_id, event_id || ':extra', operation_id, event_type, entity_type, entity_id,
       redacted_details, occurred_at FROM audit_events WHERE operation_id='task-admin-delete-op'`],
    ['field', `UPDATE audit_events SET entity_id='tampered' WHERE operation_id='task-admin-delete-op'`],
    ['time', `UPDATE audit_events SET occurred_at=occurred_at + interval '1 second'
      WHERE operation_id='task-admin-delete-op'`],
  ])('rejects DELETE replay with %s audit evidence', async (_label, tamper) => {
    const input = deleteInput();
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    await commands().delete(input);
    await harness.database.exec(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
      ${tamper}; ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_immutable`);
    await expect(commands().delete(input)).rejects.toThrow(/audit/i);
  });

  it.each([
    ['raw result', `result_snapshot=jsonb_set(result_snapshot, '{tasks,0,taskId}', '"OTHER"')`],
    ['operation chronology', `started_at=started_at - interval '1 second',
      created_at=created_at - interval '1 second'`],
  ])('rejects DELETE replay with tampered %s', async (_label, mutation) => {
    const input = deleteInput();
    await commands().create({ ...createInput(), allowedStudentIds: [] });
    await commands().delete(input);
    await harness.database.exec(`ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
      UPDATE operations SET ${mutation} WHERE operation_id='task-admin-delete-op';
      ALTER TABLE operations ENABLE ALWAYS TRIGGER operations_update_guard`);
    await expect(commands().delete(input)).rejects.toThrow(/stored result|timestamp integrity/i);
  });

  it('isolates identical DELETE business and operation IDs by tenant', async () => {
    await commands(harness.tenantOneId).create(createInput());
    await commands(harness.tenantTwoId).create(createInput());
    const one = await commands(harness.tenantOneId).delete(deleteInput());
    const two = await commands(harness.tenantTwoId).delete(deleteInput());
    expect(two).toEqual(one);
    expect((await snapshot(harness.tenantOneId)).tasks).toHaveLength(1);
    expect((await snapshot(harness.tenantTwoId)).tasks).toHaveLength(1);
  });

  it.each([
    ['task CAS RETURN NULL', `CREATE FUNCTION suppress_delete_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_delete_write BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION suppress_delete_write()`],
    ['task CAS RETURN OLD', `CREATE FUNCTION suppress_delete_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.deleted_at IS NOT NULL THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_delete_write BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION suppress_delete_write()`],
    ['mirror DELETE', `CREATE FUNCTION suppress_delete_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_delete_write BEFORE DELETE ON task_allowed_students
      FOR EACH ROW EXECUTE FUNCTION suppress_delete_write()`],
    ['assignment INSERT', `CREATE FUNCTION suppress_delete_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.admin_operation_id='task-admin-delete-op' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_delete_write BEFORE INSERT ON task_assignments
      FOR EACH ROW EXECUTE FUNCTION suppress_delete_write()`],
    ['audit INSERT', `CREATE FUNCTION suppress_delete_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id='task-admin-delete-op' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_delete_write BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION suppress_delete_write()`],
    ['terminal UPDATE', `CREATE FUNCTION suppress_delete_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id='task-admin-delete-op' AND NEW.status='SUCCEEDED' THEN RETURN NULL; END IF;
      RETURN NEW; END $$; CREATE TRIGGER suppress_delete_write BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION suppress_delete_write()`],
  ])('rolls back all state when required DELETE %s is suppressed', async (_label, ddl) => {
    await commands().create(createInput());
    const before = await completeSnapshot();
    await harness.database.exec(ddl);
    await expect(commands().delete(deleteInput())).rejects.toThrow(/integrity|replayable/i);
    expect(await completeSnapshot()).toEqual(before);
  });
});
