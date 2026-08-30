import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseTaskAdminCommands,
  createTaskAdminAssignmentEventId,
  createTaskAdminPayloadHash,
  createTaskAdminResultHash,
  createTaskAdminTaskInstanceId,
} from './taskAdminCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import { getTaskCycle } from '@/domain/taskRecurrence';

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

const createInput = () => ({
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
});

const commands = (tenantId = harness.tenantOneId) => createDatabaseTaskAdminCommands({
  tenantId,
  runTenantTransaction: harness.runTenantTransaction,
  now: () => NOW,
});

async function appendLaterSameCycleAssignment(
  taskInstanceId: string,
  studentId: string,
  assignmentId: string,
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
  const later = '2026-08-30T02:00:00.000Z';
  await harness.database.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
     started_at, created_at, updated_at)
    VALUES ($1, $2, 'TASK_ADMIN', $3, 'PENDING', 1, $4, $4, $4)`,
  [harness.tenantOneId, operationId, operationHash, later]);
  await harness.database.query(`INSERT INTO task_assignments
    (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
     cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
     source, previous_assignment_id, admin_operation_id, admin_operation_hash,
     created_at, schema_version, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'Asia/Seoul', $8, 'ASSIGNED',
            'ADMIN', NULL, $9, $10, $11, 1, NULL)`,
  [harness.tenantOneId, assignmentId, row.task_id, taskInstanceId, cycle.cycleId,
    cycle.startsAt, cycle.endsAt, studentId, operationId, operationHash, later]);
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
    const first = await commands().create(input);
    await expect(commands().create({ ...input,
      allowedStudentIds: [...input.allowedStudentIds].reverse(),
      schedule: { ...input.schedule, recurrence: { ...input.schedule.recurrence,
        weekdays: [...input.schedule.recurrence.weekdays].reverse() } },
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
