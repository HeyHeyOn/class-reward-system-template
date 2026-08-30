import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { TaskSchedule } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit, operationAuditEventId } from './operationAudit';
import { createTaskAdminAssignmentEventId } from './taskAdminCommands';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const INPUT_KEYS = ['operationId', 'taskId', 'studentId', 'assigned', 'source'] as const;
const OPERATION_KEYS = ['operation_id', 'operation_kind', 'payload_hash', 'status', 'result_snapshot',
  'finished_at', 'failure_code', 'attempt_count', 'started_at', 'created_at', 'updated_at'] as const;

type RunTenantTransaction = <T>(tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<T>) => Promise<T>;

export type DatabaseTaskAssignmentCommandInput = Readonly<{
  operationId: string;
  taskId: string;
  studentId: string;
  assigned: boolean;
  source: 'ADMIN' | 'QR';
}>;

export type TaskAssignmentCommandSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'ASSIGNMENT';
  completedAt: string;
  taskId: string;
  taskInstanceId: string;
  studentId: string;
  assigned: boolean;
  changed: boolean;
  cycleId: string;
  transitionEventId: string | null;
  materializationEventIds: readonly string[];
}>;

export type DatabaseTaskAssignmentCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

type CanonicalInput = DatabaseTaskAssignmentCommandInput;
type TaskRow = Readonly<{
  task_instance_id: string;
  task_id: string;
  current_schedule: TaskSchedule;
  pending_schedule: TaskSchedule | null;
  created_at: Date;
}>;
type Operation = Readonly<{
  operation_id: string;
  operation_kind: string;
  payload_hash: string;
  status: string;
  result_snapshot: unknown;
  finished_at: Date | null;
  failure_code: string | null;
  attempt_count: string;
  started_at: Date;
  created_at: Date;
  updated_at: Date;
}>;

export function createTaskAssignmentPayloadHash(raw: DatabaseTaskAssignmentCommandInput): string {
  const input = canonicalInput(raw);
  return sha256({ kind: 'TASK_ADMIN', action: 'ASSIGNMENT', taskId: input.taskId,
    studentId: input.studentId, assigned: input.assigned, source: input.source, schemaVersion: 1 });
}

export function createDatabaseTaskAssignmentCommand(
  dependencies: DatabaseTaskAssignmentCommandDependencies,
) {
  return {
    async execute(raw: DatabaseTaskAssignmentCommandInput): Promise<TaskAssignmentCommandSuccess> {
      const input = canonicalInput(raw);
      const now = dependencies.now?.() ?? new Date();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Task assignment current timestamp is invalid.');
      }
      const payloadHash = createTaskAssignmentPayloadHash(input);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) return resolveReplay(tx, dependencies.tenantId, existing, input, payloadHash);

        const claim = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
             started_at, created_at, updated_at)
          VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${payloadHash},
                  'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        if (claim.rows.length === 0) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Task assignment operation claim integrity check failed.');
          return resolveReplay(tx, dependencies.tenantId, winner, input, payloadHash);
        }
        assertExactReturning(claim.rows, ['operation_id'], { operation_id: input.operationId },
          'operation claim');

        const taskResult = await tx.execute(sql`
          SELECT task_instance_id, task_id, current_schedule, pending_schedule, created_at
          FROM tasks
          WHERE tenant_id=${dependencies.tenantId} AND deleted_at IS NULL
          ORDER BY task_instance_id
          FOR UPDATE
        `);
        const tasks = taskResult.rows.map(parseTaskRow);
        const matches = tasks.filter((task) => task.task_id === input.taskId);
        if (matches.length !== 1) throw new Error('Task assignment target not found.');
        const task = matches[0];

        const studentResult = await tx.execute(sql`
          SELECT student_id, status FROM students
          WHERE tenant_id=${dependencies.tenantId} AND student_id=${input.studentId}
          ORDER BY student_id FOR UPDATE
        `);
        if (studentResult.rows.length !== 1) throw new Error('Task assignment active student not found.');
        const student = exactRow(studentResult.rows[0], ['student_id', 'status'], 'student evidence');
        if (student.student_id !== input.studentId || student.status !== 'ACTIVE') {
          throw new Error('Task assignment active student not found.');
        }

        const mirrorResult = await tx.execute(sql`
          SELECT task_instance_id, student_id, created_at FROM task_allowed_students
          WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${task.task_instance_id}
          ORDER BY student_id FOR UPDATE
        `);
        const mirrors = mirrorResult.rows.map(parseMirror);

        const assignmentResult = await tx.execute(sql`
          SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
            task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
            student_id, event_type, source, previous_assignment_id, admin_operation_id,
            admin_operation_hash, created_at, schema_version, note
          FROM task_assignments
          WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${task.task_instance_id}
          ORDER BY student_id, event_sequence FOR UPDATE
        `);
        const history = assignmentResult.rows.map(parseAssignment);
        validateChains(history, task.task_id);

        const completionResult = await tx.execute(sql`
          SELECT completion_id, event_sequence::text AS event_sequence, completed_at,
            task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
            student_name_snapshot, reward_snapshot, balance_before, balance_after, status, note,
            cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id,
            transaction_id, operation_id, operation_hash, admin_operation_id,
            admin_operation_hash, schema_version, evidence_provider,
            evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name,
            created_at
          FROM task_completions
          WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${task.task_instance_id}
          ORDER BY event_sequence FOR UPDATE
        `);
        const completions = parseCompletionHistory(completionResult.rows,
          task.task_instance_id, task.task_id);

        const schedule = resolveTaskSchedule({ currentSchedule: task.current_schedule,
          pendingSchedule: task.pending_schedule, now: now.toISOString() });
        if (schedule.timeZone !== 'Asia/Seoul') {
          throw new Error('Task assignment schedule timezone must be exactly Asia/Seoul.');
        }
        const cycle = getTaskCycle({ taskInstanceId: task.task_instance_id, schedule,
          taskCreatedAt: task.created_at.toISOString(), now: now.toISOString() });
        let sameCycle = history.filter((event) => event.student_id === input.studentId
          && event.cycle_id === cycle.cycleId
          && event.cycle_start_at.getTime() === new Date(cycle.startsAt).getTime()
          && nullableTime(event.cycle_end_at) === nullableTime(cycle.endsAt ? new Date(cycle.endsAt) : null)
          && event.rule_version === schedule.ruleVersion && event.timezone === schedule.timeZone)
          .sort((left, right) => left.event_sequence - right.event_sequence);
        let predecessor = sameCycle.at(-1) ?? null;
        let currentMirror = mirrors.find((row) => row.student_id === input.studentId) ?? null;
        const mirrorAssigned = currentMirror !== null;
        const materializationEventIds: string[] = [];
        let effectiveAssigned: boolean;
        if (predecessor) {
          effectiveAssigned = predecessor.event_type === 'ASSIGNED';
        } else {
          const studentHistory = history.filter((event) => event.student_id === input.studentId);
          const transitionForcesCarry = schedule.ruleVersion > 1
            && new Date(cycle.startsAt).getTime() === new Date(schedule.effectiveFrom).getTime();
          const normalCarry = schedule.recurrence.type === 'NONE'
            || !schedule.resetAssignmentOnCycle;
          const prior = [...studentHistory].filter((event) => {
            const startsBefore = event.cycle_start_at.getTime() < new Date(cycle.startsAt).getTime();
            const sameStartOldRule = transitionForcesCarry
              && event.cycle_start_at.getTime() === new Date(cycle.startsAt).getTime()
              && event.rule_version < schedule.ruleVersion;
            return startsBefore || sameStartOldRule;
          }).sort((left, right) => left.cycle_start_at.getTime() - right.cycle_start_at.getTime()
            || left.event_sequence - right.event_sequence).at(-1);
          const source = studentHistory.length === 0 && mirrorAssigned
            ? 'LEGACY_SEED' as const
            : prior?.event_type === 'ASSIGNED'
              && (normalCarry || (transitionForcesCarry
                && prior.rule_version < schedule.ruleVersion))
              ? 'CARRY_FORWARD' as const : null;
          if (source) {
            const materializationId = createMaterializationEventId(source, task.task_instance_id,
              cycle.cycleId, input.studentId);
            const inserted = await tx.execute(sql`
              INSERT INTO task_assignments
                (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
                 cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
                 source, previous_assignment_id, admin_operation_id, admin_operation_hash,
                 created_at, schema_version, note)
              VALUES (${dependencies.tenantId}, ${materializationId}, ${input.taskId},
                ${task.task_instance_id}, ${cycle.cycleId}, ${new Date(cycle.startsAt)},
                ${cycle.endsAt ? new Date(cycle.endsAt) : null}, ${schedule.ruleVersion},
                ${schedule.timeZone}, ${input.studentId}, 'ASSIGNED', ${source},
                ${source === 'CARRY_FORWARD' ? prior?.assignment_id ?? null : null}, NULL, NULL,
                ${now}, 1, NULL)
              RETURNING assignment_id
            `);
            assertExactReturning(inserted.rows, ['assignment_id'], { assignment_id: materializationId },
              'materialization event');
            materializationEventIds.push(materializationId);
            effectiveAssigned = true;
            predecessor = parseAssignment((await tx.execute(sql`
              SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
                task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
                student_id, event_type, source, previous_assignment_id, admin_operation_id,
                admin_operation_hash, created_at, schema_version, note
              FROM task_assignments WHERE tenant_id=${dependencies.tenantId}
                AND assignment_id=${materializationId}
            `)).rows[0]);
            sameCycle = [predecessor];
          } else {
            effectiveAssigned = false;
          }
        }
        if (mirrorAssigned !== effectiveAssigned) {
          if (effectiveAssigned) {
            const repaired = await tx.execute(sql`INSERT INTO task_allowed_students
              (tenant_id, task_instance_id, student_id, created_at)
              VALUES (${dependencies.tenantId}, ${task.task_instance_id}, ${input.studentId}, ${now})
              RETURNING task_instance_id, student_id, created_at`);
            assertExactReturning(repaired.rows, ['task_instance_id', 'student_id', 'created_at'], {
              task_instance_id: task.task_instance_id, student_id: input.studentId, created_at: now,
            },
              'mirror repair');
            currentMirror = parseMirror(repaired.rows[0]);
          } else {
            const repaired = await tx.execute(sql`DELETE FROM task_allowed_students
              WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${task.task_instance_id}
                AND student_id=${input.studentId} RETURNING student_id`);
            assertExactReturning(repaired.rows, ['student_id'], { student_id: input.studentId },
              'mirror reset');
            currentMirror = null;
          }
        }
        const currentlyAssigned = effectiveAssigned;
        const changed = currentlyAssigned !== input.assigned;
        const transitionEventId = changed
          ? createTaskAdminAssignmentEventId(input.operationId, input.taskId, input.studentId,
            input.assigned ? 'ASSIGNED' : 'UNASSIGNED')
          : null;

        if (changed && input.assigned) {
          const inserted = await tx.execute(sql`
            INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id, created_at)
            VALUES (${dependencies.tenantId}, ${task.task_instance_id}, ${input.studentId}, ${now})
            RETURNING task_instance_id, student_id, created_at
          `);
          assertExactReturning(inserted.rows, ['task_instance_id', 'student_id', 'created_at'], {
            task_instance_id: task.task_instance_id, student_id: input.studentId, created_at: now,
          }, 'mirror insert');
          currentMirror = parseMirror(inserted.rows[0]);
        } else if (changed) {
          const deleted = await tx.execute(sql`
            DELETE FROM task_allowed_students
            WHERE tenant_id=${dependencies.tenantId} AND task_instance_id=${task.task_instance_id}
              AND student_id=${input.studentId}
            RETURNING task_instance_id, student_id, created_at
          `);
          assertExactReturning(deleted.rows, ['task_instance_id', 'student_id', 'created_at'], {
            task_instance_id: task.task_instance_id, student_id: input.studentId,
            created_at: currentMirror?.created_at,
          }, 'mirror delete');
          currentMirror = null;
        }

        if (transitionEventId) {
          const event = await tx.execute(sql`
            INSERT INTO task_assignments
              (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
               cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
               source, previous_assignment_id, admin_operation_id, admin_operation_hash,
               created_at, schema_version, note)
            VALUES (${dependencies.tenantId}, ${transitionEventId}, ${input.taskId},
              ${task.task_instance_id}, ${cycle.cycleId}, ${new Date(cycle.startsAt)},
              ${cycle.endsAt ? new Date(cycle.endsAt) : null}, ${schedule.ruleVersion},
              ${schedule.timeZone}, ${input.studentId}, ${input.assigned ? 'ASSIGNED' : 'UNASSIGNED'},
              ${input.source}, ${predecessor?.assignment_id ?? null}, ${input.operationId},
              ${payloadHash}, ${now}, 1, NULL)
            RETURNING assignment_id
          `);
          assertExactReturning(event.rows, ['assignment_id'], { assignment_id: transitionEventId },
            'transition event');
        }

        const result = freezeResult({ ok: true, operationId: input.operationId,
          action: 'ASSIGNMENT', completedAt: now.toISOString(), taskId: input.taskId,
          taskInstanceId: task.task_instance_id, studentId: input.studentId,
          assigned: input.assigned, changed, cycleId: cycle.cycleId, transitionEventId,
          materializationEventIds });
        await verifyCurrentState(tx, dependencies.tenantId, result, payloadHash, input.source,
          currentMirror, mirrors, history, completions);
        const audit = auditInput(result, now);
        await appendOperationAudit(tx, dependencies.tenantId, audit);
        await assertOperationAudit(tx, dependencies.tenantId, audit);
        await assertExactlyOneOperationAudit(tx, dependencies.tenantId, input.operationId);
        const terminal = await tx.execute(sql`
          UPDATE operations SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
            finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id
        `);
        assertExactReturning(terminal.rows, ['operation_id'], { operation_id: input.operationId },
          'terminal operation');
        await assertExactlyOneOperationAudit(tx, dependencies.tenantId, input.operationId);
        await verifyCurrentState(tx, dependencies.tenantId, result, payloadHash, input.source,
          currentMirror, mirrors, history, completions);
        const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!stored) throw new Error('Task assignment terminal operation integrity check failed.');
        return resolveReplay(tx, dependencies.tenantId, stored, input, payloadHash);
      });
    },
  };
}

async function verifyCurrentState(tx: TenantTransaction, tenantId: string,
  result: TaskAssignmentCommandSuccess, payloadHash: string, source: 'ADMIN' | 'QR',
  expectedTargetMirror: MirrorEvidence | null, initialMirrors: readonly MirrorEvidence[],
  initialHistory: readonly AssignmentEvidence[], initialCompletions: readonly CompletionEvidence[]) {
  const mirrorResult = await tx.execute(sql`
    SELECT task_instance_id, student_id, created_at FROM task_allowed_students
    WHERE tenant_id=${tenantId} AND task_instance_id=${result.taskInstanceId}
    ORDER BY student_id`);
  const mirrors = mirrorResult.rows.map(parseMirror);
  const targetMirrors = mirrors.filter((row) => row.student_id === result.studentId);
  const canonicalMirror = (row: MirrorEvidence | null) => row === null ? null : ({
    task_instance_id: row.task_instance_id,
    student_id: row.student_id,
    created_at: row.created_at.toISOString(),
  });
  if (targetMirrors.length !== (result.assigned ? 1 : 0)
    || sha256(canonicalMirror(targetMirrors[0] ?? null))
      !== sha256(canonicalMirror(expectedTargetMirror))) {
    throw new Error('Task assignment complete-state mirror integrity check failed.');
  }
  const canonicalNonTargetMirrors = (rows: readonly MirrorEvidence[]) => rows
    .filter((row) => row.student_id !== result.studentId)
    .sort((left, right) => left.student_id.localeCompare(right.student_id)
      || left.task_instance_id.localeCompare(right.task_instance_id))
    .map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
  if (sha256(canonicalNonTargetMirrors(mirrors))
    !== sha256(canonicalNonTargetMirrors(initialMirrors))) {
    throw new Error('Task assignment complete-state mirror integrity check failed.');
  }

  const assignmentResult = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId} AND task_instance_id=${result.taskInstanceId}
    ORDER BY student_id, event_sequence`);
  const history = assignmentResult.rows.map(parseAssignment);
  validateChains(history, result.taskId);
  const byId = uniqueById(history);
  const expectedIds = new Set(initialHistory.map((event) => event.assignment_id));
  result.materializationEventIds.forEach((id) => expectedIds.add(id));
  if (result.transitionEventId) expectedIds.add(result.transitionEventId);
  if (byId.size !== expectedIds.size || [...byId.keys()].some((id) => !expectedIds.has(id))) {
    throw new Error('Task assignment complete-state assignment set integrity check failed.');
  }
  const initialById = uniqueById(initialHistory);
  if ([...initialById].some(([id, event]) => sha256(byId.get(id)) !== sha256(event))) {
    throw new Error('Task assignment complete-state assignment integrity check failed.');
  }
  validateResultEvents(byId, result, payloadHash, source);

  const completionResult = await tx.execute(sql`
    SELECT completion_id, event_sequence::text AS event_sequence, completed_at,
      task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
      student_name_snapshot, reward_snapshot, balance_before, balance_after, status, note,
      cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id,
      transaction_id, operation_id, operation_hash, admin_operation_id, admin_operation_hash,
      schema_version, evidence_provider,
      evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name,
      created_at
    FROM task_completions WHERE tenant_id=${tenantId} AND task_instance_id=${result.taskInstanceId}
    ORDER BY event_sequence`);
  const completions = parseCompletionHistory(completionResult.rows,
    result.taskInstanceId, result.taskId);
  if (sha256(completions) !== sha256(initialCompletions)) {
    throw new Error('Task assignment completion history integrity check failed.');
  }
}

function uniqueById(events: readonly AssignmentEvidence[]) {
  const byId = new Map<string, AssignmentEvidence>();
  for (const event of events) {
    if (byId.has(event.assignment_id)) {
      throw new Error('Task assignment history duplicate identity integrity check failed.');
    }
    byId.set(event.assignment_id, event);
  }
  return byId;
}

function validateResultEvents(byId: ReadonlyMap<string, AssignmentEvidence>,
  result: TaskAssignmentCommandSuccess, payloadHash: string, source: 'ADMIN' | 'QR') {
  let frozenCycleTuple: string | null = null;
  const validateFrozenCycle = (event: AssignmentEvidence) => {
    const start = event.cycle_start_at.toISOString().replace(/\.000Z$/, 'Z');
    const expectedCycleId = `v1|${event.task_instance_id}|r${event.rule_version}|${start}`;
    if (event.cycle_id !== result.cycleId || event.cycle_id !== expectedCycleId
      || event.timezone !== 'Asia/Seoul'
      || (event.cycle_end_at !== null
        && event.cycle_end_at.getTime() <= event.cycle_start_at.getTime())) return false;
    const tuple = JSON.stringify([event.cycle_id, event.cycle_start_at.toISOString(),
      event.cycle_end_at?.toISOString() ?? null, event.rule_version, event.timezone]);
    if (frozenCycleTuple !== null && frozenCycleTuple !== tuple) return false;
    frozenCycleTuple = tuple;
    return true;
  };
  for (const id of result.materializationEventIds) {
    const event = byId.get(id);
    if (!event || event.assignment_id !== createMaterializationEventId(event.source as never,
      result.taskInstanceId, result.cycleId, result.studentId)
      || (event.source !== 'LEGACY_SEED' && event.source !== 'CARRY_FORWARD')
      || event.task_id_snapshot !== result.taskId || event.task_instance_id !== result.taskInstanceId
      || event.student_id !== result.studentId || !validateFrozenCycle(event)
      || event.event_type !== 'ASSIGNED' || event.admin_operation_id !== null
      || event.admin_operation_hash !== null || event.schema_version !== 1 || event.note !== null
      || event.created_at.toISOString() !== result.completedAt
      || (event.source === 'LEGACY_SEED' && event.previous_assignment_id !== null)
      || (event.source === 'CARRY_FORWARD' && event.previous_assignment_id === null)) {
      throw new Error('Task assignment materialization event integrity check failed.');
    }
  }
  const bound = [...byId.values()].filter((event) => event.admin_operation_id === result.operationId);
  const expected = result.transitionEventId ? [result.transitionEventId] : [];
  if (bound.length !== expected.length || bound.some((event, index) => event.assignment_id !== expected[index])) {
    throw new Error('Task assignment operation-bound event integrity check failed.');
  }
  if (result.transitionEventId) {
    const event = byId.get(result.transitionEventId);
    const expectedId = createTaskAdminAssignmentEventId(result.operationId, result.taskId,
      result.studentId, result.assigned ? 'ASSIGNED' : 'UNASSIGNED');
    if (!event || event.assignment_id !== expectedId || event.task_id_snapshot !== result.taskId
      || event.task_instance_id !== result.taskInstanceId || event.student_id !== result.studentId
      || !validateFrozenCycle(event)
      || event.event_type !== (result.assigned ? 'ASSIGNED' : 'UNASSIGNED')
      || event.source !== source || event.admin_operation_id !== result.operationId
      || event.admin_operation_hash !== payloadHash || event.schema_version !== 1
      || event.note !== null || event.created_at.toISOString() !== result.completedAt) {
      throw new Error('Task assignment transition event integrity check failed.');
    }
  }
}

async function resolveReplay(tx: TenantTransaction, tenantId: string, operation: Operation,
  input: CanonicalInput, payloadHash: string): Promise<TaskAssignmentCommandSuccess> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Task assignment operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== '1' || operation.finished_at === null) {
    throw new Error('Task assignment operation is not replayable.');
  }
  if (operation.started_at.getTime() !== operation.created_at.getTime()
    || operation.finished_at.getTime() !== operation.updated_at.getTime()
    || operation.started_at > operation.finished_at) {
    throw new Error('Task assignment operation timestamp integrity check failed.');
  }
  const result = parseResult(operation.result_snapshot);
  if (result.operationId !== input.operationId || result.taskId !== input.taskId
    || result.studentId !== input.studentId || result.assigned !== input.assigned
    || result.completedAt !== operation.finished_at.toISOString()) {
    throw new Error('Task assignment stored result integrity check failed.');
  }
  const identity = await tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${tenantId} AND task_instance_id=${result.taskInstanceId}`);
  if (identity.rows.length !== 1) {
    throw new Error('Task assignment physical identity integrity check failed.');
  }
  const task = exactRow(identity.rows[0], ['task_instance_id', 'task_id'], 'replay task evidence');
  if (task.task_instance_id !== result.taskInstanceId || task.task_id !== result.taskId) {
    throw new Error('Task assignment physical identity integrity check failed.');
  }
  const assignmentResult = await tx.execute(sql`
    SELECT assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
      task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
      student_id, event_type, source, previous_assignment_id, admin_operation_id,
      admin_operation_hash, created_at, schema_version, note
    FROM task_assignments WHERE tenant_id=${tenantId} AND task_instance_id=${result.taskInstanceId}
    ORDER BY student_id, event_sequence`);
  const history = assignmentResult.rows.map(parseAssignment);
  validateChains(history, result.taskId);
  const byId = uniqueById(history);
  for (const id of result.materializationEventIds) {
    if (!byId.has(id)) throw new Error('Task assignment materialization event integrity check failed.');
  }
  validateResultEvents(byId, result, payloadHash, input.source);
  const completionResult = await tx.execute(sql`
    SELECT completion_id, event_sequence::text AS event_sequence, completed_at,
      task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
      student_name_snapshot, reward_snapshot, balance_before, balance_after, status, note,
      cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id,
      transaction_id, operation_id, operation_hash, admin_operation_id, admin_operation_hash,
      schema_version, evidence_provider,
      evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name,
      created_at
    FROM task_completions WHERE tenant_id=${tenantId} AND task_instance_id=${result.taskInstanceId}
    ORDER BY event_sequence`);
  parseCompletionHistory(completionResult.rows, result.taskInstanceId, result.taskId);
  await assertOperationAudit(tx, tenantId, auditInput(result, operation.finished_at));
  await assertExactlyOneOperationAudit(tx, tenantId, result.operationId);
  return result;
}

async function assertExactlyOneOperationAudit(tx: TenantTransaction, tenantId: string,
  operationId: string): Promise<void> {
  const auditRows = await tx.execute(sql`SELECT event_id FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${operationId} ORDER BY event_id`);
  if (auditRows.rows.length !== 1) {
    throw new Error('Task assignment operation audit set integrity check failed.');
  }
  const row = exactRow(auditRows.rows[0], ['event_id'], 'operation audit evidence');
  if (row.event_id !== operationAuditEventId(operationId, 'TASK_ADMIN_COMPLETED')) {
    throw new Error('Task assignment operation audit set integrity check failed.');
  }
}

function auditInput(result: TaskAssignmentCommandSuccess, occurredAt: Date) {
  return { operationId: result.operationId, eventType: 'TASK_ADMIN_COMPLETED',
    entityType: 'OPERATION', entityId: result.operationId,
    redactedDetails: { action: 'ASSIGNMENT', taskCount: 1,
      materializationEventCount: result.materializationEventIds.length,
      transitionEventCount: result.transitionEventId === null ? 0 : 1,
      resultHash: sha256(result) }, occurredAt } as const;
}

async function readOperation(tx: TenantTransaction, tenantId: string, operationId: string) {
  const result = await tx.execute(sql`SELECT operation_id, operation_kind, payload_hash, status,
    result_snapshot, finished_at, failure_code, attempt_count::text AS attempt_count,
    started_at, created_at, updated_at FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId} FOR UPDATE`);
  if (result.rows.length > 1) throw new Error('Task assignment operation integrity check failed.');
  if (result.rows.length === 0) return null;
  const row = exactRow(result.rows[0], OPERATION_KEYS, 'operation evidence');
  if (row.operation_id !== operationId || row.operation_kind !== 'TASK_ADMIN'
    || typeof row.payload_hash !== 'string' || !HASH.test(row.payload_hash)
    || typeof row.status !== 'string' || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(row.status)
    || typeof row.attempt_count !== 'string' || !/^[1-9][0-9]*$/.test(row.attempt_count)) {
    throw new Error('Task assignment operation integrity check failed.');
  }
  return { ...row, started_at: requiredDate(row.started_at, 'operation started timestamp'),
    created_at: requiredDate(row.created_at, 'operation created timestamp'),
    updated_at: requiredDate(row.updated_at, 'operation updated timestamp'),
    finished_at: row.finished_at === null ? null : requiredDate(row.finished_at, 'operation finished timestamp'),
  } as Operation;
}

function canonicalInput(raw: DatabaseTaskAssignmentCommandInput): CanonicalInput {
  const row = exactRow(raw, INPUT_KEYS, 'input');
  if (typeof row.operationId !== 'string' || !UUID.test(row.operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  const taskId = requiredId(row.taskId, 'task ID');
  const studentId = requiredId(row.studentId, 'student ID');
  if (typeof row.assigned !== 'boolean') throw new Error('Task assignment desired state is invalid.');
  if (row.source !== 'ADMIN' && row.source !== 'QR') throw new Error('Task assignment source is invalid.');
  return { operationId: row.operationId, taskId, studentId, assigned: row.assigned, source: row.source };
}

function parseMirror(raw: unknown) {
  const row = exactRow(raw, ['task_instance_id', 'student_id', 'created_at'], 'mirror evidence');
  return { task_instance_id: requiredId(row.task_instance_id, 'mirror task instance ID'),
    student_id: requiredId(row.student_id, 'mirror student ID'),
    created_at: requiredDate(row.created_at, 'mirror created timestamp') };
}

function parseTaskRow(raw: unknown): TaskRow {
  const row = exactRow(raw, ['task_instance_id', 'task_id', 'current_schedule',
    'pending_schedule', 'created_at'], 'task evidence');
  return { task_instance_id: requiredId(row.task_instance_id, 'task instance ID'),
    task_id: requiredId(row.task_id, 'task ID'), current_schedule: row.current_schedule as TaskSchedule,
    pending_schedule: row.pending_schedule as TaskSchedule | null,
    created_at: requiredDate(row.created_at, 'task created timestamp') };
}

type AssignmentEvidence = ReturnType<typeof parseAssignment>;
type CompletionEvidence = ReturnType<typeof parseCompletion>;
type MirrorEvidence = ReturnType<typeof parseMirror>;
function parseAssignment(raw: unknown) {
  const keys = ['assignment_id', 'event_sequence', 'task_id_snapshot', 'task_instance_id',
    'cycle_id', 'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'student_id',
    'event_type', 'source', 'previous_assignment_id', 'admin_operation_id', 'admin_operation_hash',
    'created_at', 'schema_version', 'note'] as const;
  const row = exactRow(raw, keys, 'assignment evidence');
  const sequence = requiredPositiveIntegerText(row.event_sequence, 'assignment event sequence');
  if (typeof row.event_type !== 'string' || !['ASSIGNED', 'UNASSIGNED'].includes(row.event_type)
    || typeof row.source !== 'string'
    || !['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(row.source)
    || (row.previous_assignment_id !== null
      && (typeof row.previous_assignment_id !== 'string'
        || row.previous_assignment_id.length === 0
        || row.previous_assignment_id.trim() !== row.previous_assignment_id))
    || row.schema_version !== 1 || row.note !== null) {
    throw new Error('Task assignment history integrity check failed.');
  }
  const operationBound = row.source === 'ADMIN' || row.source === 'QR';
  if (operationBound
    ? (typeof row.admin_operation_id !== 'string' || row.admin_operation_id.length === 0
      || row.admin_operation_id.trim() !== row.admin_operation_id
      || typeof row.admin_operation_hash !== 'string' || !HASH.test(row.admin_operation_hash))
    : (row.admin_operation_id !== null || row.admin_operation_hash !== null)) {
    throw new Error('Task assignment history integrity check failed.');
  }
  return { ...row, assignment_id: requiredId(row.assignment_id, 'assignment ID'),
    event_sequence: sequence, task_id_snapshot: requiredId(row.task_id_snapshot, 'assignment task ID'),
    task_instance_id: requiredId(row.task_instance_id, 'assignment task instance ID'),
    cycle_id: requiredId(row.cycle_id, 'assignment cycle ID'),
    cycle_start_at: requiredDate(row.cycle_start_at, 'assignment cycle start'),
    cycle_end_at: row.cycle_end_at === null ? null : requiredDate(row.cycle_end_at, 'assignment cycle end'),
    rule_version: requiredSafeInteger(row.rule_version, 'assignment rule version'),
    timezone: requiredId(row.timezone, 'assignment timezone'),
    student_id: requiredId(row.student_id, 'assignment student ID'),
    event_type: row.event_type as 'ASSIGNED' | 'UNASSIGNED',
    source: row.source as 'ADMIN' | 'QR' | 'LEGACY_SEED' | 'CARRY_FORWARD',
    previous_assignment_id: row.previous_assignment_id as string | null,
    admin_operation_id: row.admin_operation_id as string | null,
    admin_operation_hash: row.admin_operation_hash as string | null,
    created_at: requiredDate(row.created_at, 'assignment created timestamp') };
}

function validateChains(events: readonly AssignmentEvidence[], expectedTaskId: string) {
  const ordered = [...events].sort((left, right) => left.event_sequence - right.event_sequence);
  const byId = new Map(ordered.map((event) => [event.assignment_id, event]));
  const cycleKey = (event: AssignmentEvidence) => JSON.stringify([
    event.task_instance_id, event.student_id, event.cycle_id,
    event.cycle_start_at.toISOString(), event.cycle_end_at?.toISOString() ?? null,
    event.rule_version, event.timezone,
  ]);
  const priorByCycle = new Map<string, AssignmentEvidence>();
  const latestBySubject = new Map<string, AssignmentEvidence>();
  const subjectKey = (event: AssignmentEvidence) => JSON.stringify([
    event.task_instance_id, event.student_id,
  ]);
  for (const event of ordered) {
    if (event.task_id_snapshot !== expectedTaskId) {
      throw new Error('Task assignment history integrity check failed.');
    }
    const latest = latestBySubject.get(subjectKey(event));
    if (event.timezone !== 'Asia/Seoul' || assignmentCycleId(event) !== event.cycle_id
      || (event.cycle_end_at !== null
        && event.cycle_end_at.getTime() <= event.cycle_start_at.getTime())
      || event.rule_version <= 0) {
      const referencedByCarry = ordered.some((candidate) => candidate.source === 'CARRY_FORWARD'
        && candidate.previous_assignment_id === event.assignment_id);
      const label = event.source === 'CARRY_FORWARD' || referencedByCarry
        ? 'history carry-forward'
        : event.source === 'ADMIN' || event.source === 'QR'
          ? 'history operation-bound event' : 'history';
      throw new Error(`Task assignment ${label} integrity check failed.`);
    }
    if (event.source === 'LEGACY_SEED') {
      if (event.previous_assignment_id !== null || latest !== undefined) {
        throw new Error('Task assignment history predecessor integrity check failed (assignment set integrity).');
      }
      priorByCycle.set(cycleKey(event), event);
      latestBySubject.set(subjectKey(event), event);
      continue;
    }
    if (event.source === 'CARRY_FORWARD') {
      const previous = event.previous_assignment_id === null
        ? undefined : byId.get(event.previous_assignment_id);
      const previousCycleClosed = previous?.cycle_end_at !== null
        && previous !== undefined
        && previous.cycle_end_at.getTime() <= event.cycle_start_at.getTime();
      const immediateRuleTransition = previous !== undefined
        && previous.rule_version < event.rule_version
        && previous.cycle_start_at.getTime() <= event.cycle_start_at.getTime();
      if (event.event_type !== 'ASSIGNED' || !previous || previous !== latest
        || previous.event_type !== 'ASSIGNED'
        || previous.student_id !== event.student_id || previous.task_instance_id !== event.task_instance_id
        || previous.task_id_snapshot !== event.task_id_snapshot || cycleKey(previous) === cycleKey(event)
        || assignmentCycleId(previous) !== previous.cycle_id
        || assignmentCycleId(event) !== event.cycle_id
        || (!previousCycleClosed && !immediateRuleTransition)
        || previous.event_sequence >= event.event_sequence
        || previous.created_at.getTime() > event.created_at.getTime()) {
        throw new Error('Task assignment carry-forward integrity check failed.');
      }
      priorByCycle.set(cycleKey(event), event);
      latestBySubject.set(subjectKey(event), event);
      continue;
    }
    const key = cycleKey(event);
    const earlier = priorByCycle.get(key) ?? null;
    if ((event.previous_assignment_id ?? null) !== (earlier?.assignment_id ?? null)
      || (earlier && earlier.created_at.getTime() > event.created_at.getTime())) {
      throw new Error('Task assignment history predecessor integrity check failed.');
    }
    priorByCycle.set(key, event);
    latestBySubject.set(subjectKey(event), event);
  }
}

function parseCompletion(raw: unknown) {
  const keys = ['completion_id', 'event_sequence', 'completed_at', 'task_instance_id',
    'task_id_snapshot', 'task_name_snapshot', 'student_id', 'student_name_snapshot',
    'reward_snapshot', 'balance_before', 'balance_after', 'status', 'note', 'cycle_id',
    'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'source', 'assignment_id',
    'transaction_id', 'operation_id', 'operation_hash', 'admin_operation_id',
    'admin_operation_hash', 'schema_version', 'evidence_provider',
    'evidence_board_id', 'evidence_post_id', 'evidence_created_at',
    'evidence_author_full_name', 'created_at'] as const;
  const row = exactRow(raw, keys, 'completion evidence');
  if (row.schema_version !== 1 || typeof row.task_name_snapshot !== 'string'
    || typeof row.student_name_snapshot !== 'string' || typeof row.status !== 'string'
    || row.status.trim().length === 0
    || (row.source !== null && (typeof row.source !== 'string'
      || !['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'].includes(row.source)))) {
    throw new Error('Task assignment completion history integrity check failed.');
  }
  const nullableId = (value: unknown, label: string) => value === null ? null : requiredId(value, label);
  const nullableDate = (value: unknown, label: string) => value === null ? null : requiredDate(value, label);
  const nullableInteger = (value: unknown, label: string) => value === null ? null : requiredSafeInteger(value, label);
  const operationHash = row.operation_hash === null ? null : requiredHash(row.operation_hash,
    'completion operation hash');
  const adminOperationHash = row.admin_operation_hash === null ? null
    : requiredHash(row.admin_operation_hash, 'completion admin operation hash');
  if ((row.admin_operation_id === null) !== (adminOperationHash === null)) {
    throw new Error('Task assignment completion history integrity check failed.');
  }
  return { ...row, completion_id: requiredId(row.completion_id, 'completion ID'),
    event_sequence: requiredPositiveIntegerText(row.event_sequence, 'completion event sequence'),
    completed_at: requiredDate(row.completed_at, 'completion timestamp'),
    task_instance_id: requiredId(row.task_instance_id, 'completion task instance ID'),
    task_id_snapshot: requiredId(row.task_id_snapshot, 'completion task ID'),
    student_id: requiredId(row.student_id, 'completion student ID'),
    reward_snapshot: requiredSafeInteger(row.reward_snapshot, 'completion reward'),
    balance_before: requiredSafeInteger(row.balance_before, 'completion balance before'),
    balance_after: requiredSafeInteger(row.balance_after, 'completion balance after'),
    note: nullableId(row.note, 'completion note'), cycle_id: nullableId(row.cycle_id, 'completion cycle ID'),
    cycle_start_at: nullableDate(row.cycle_start_at, 'completion cycle start'),
    cycle_end_at: nullableDate(row.cycle_end_at, 'completion cycle end'),
    rule_version: nullableInteger(row.rule_version, 'completion rule version'),
    timezone: nullableId(row.timezone, 'completion timezone'),
    assignment_id: nullableId(row.assignment_id, 'completion assignment ID'),
    transaction_id: nullableId(row.transaction_id, 'completion transaction ID'),
    operation_id: nullableId(row.operation_id, 'completion operation ID'), operation_hash: operationHash,
    admin_operation_id: nullableId(row.admin_operation_id, 'completion admin operation ID'),
    admin_operation_hash: adminOperationHash,
    evidence_provider: nullableId(row.evidence_provider, 'completion evidence provider'),
    evidence_board_id: nullableId(row.evidence_board_id, 'completion evidence board ID'),
    evidence_post_id: nullableId(row.evidence_post_id, 'completion evidence post ID'),
    evidence_created_at: nullableDate(row.evidence_created_at, 'completion evidence timestamp'),
    evidence_author_full_name: nullableId(row.evidence_author_full_name, 'completion evidence author'),
    created_at: requiredDate(row.created_at, 'completion created timestamp') };
}

function parseCompletionHistory(rows: readonly unknown[], expectedTaskInstanceId: string,
  expectedTaskId: string): CompletionEvidence[] {
  const completions = rows.map(parseCompletion);
  if (completions.some((completion) => completion.task_instance_id !== expectedTaskInstanceId
    || completion.task_id_snapshot !== expectedTaskId)) {
    throw new Error('Task assignment completion history integrity check failed.');
  }
  return completions;
}

function parseResult(raw: unknown): TaskAssignmentCommandSuccess {
  const keys = ['ok', 'operationId', 'action', 'completedAt', 'taskId', 'taskInstanceId',
    'studentId', 'assigned', 'changed', 'cycleId', 'transitionEventId', 'materializationEventIds'] as const;
  const row = exactRow(raw, keys, 'stored result');
  if (row.ok !== true || row.action !== 'ASSIGNMENT' || typeof row.assigned !== 'boolean'
    || typeof row.changed !== 'boolean' || (row.transitionEventId !== null
      && typeof row.transitionEventId !== 'string') || !Array.isArray(row.materializationEventIds)) {
    throw new Error('Task assignment stored result integrity check failed.');
  }
  const materializationEventIds = parseStoredIdArray(row.materializationEventIds);
  const result = { ok: true as const, operationId: requiredId(row.operationId, 'result operation ID'),
    action: 'ASSIGNMENT' as const, completedAt: requiredCanonicalInstant(row.completedAt),
    taskId: requiredId(row.taskId, 'result task ID'),
    taskInstanceId: requiredId(row.taskInstanceId, 'result task instance ID'),
    studentId: requiredId(row.studentId, 'result student ID'), assigned: row.assigned,
    changed: row.changed, cycleId: requiredId(row.cycleId, 'result cycle ID'),
    transitionEventId: row.transitionEventId as string | null, materializationEventIds };
  if (result.changed !== (result.transitionEventId !== null)
    || result.materializationEventIds.length > 1
    || (result.materializationEventIds.length === 1 && result.changed !== !result.assigned)) {
    throw new Error('Task assignment stored result integrity check failed.');
  }
  return freezeResult(result);
}

function parseStoredIdArray(raw: unknown): string[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length !== 0) {
    throw new Error('Task assignment stored result integrity check failed.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || lengthDescriptor.enumerable || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new Error('Task assignment stored result integrity check failed.');
  }
  const length = lengthDescriptor.value as number;
  const keys = Object.keys(descriptors).filter((key) => key !== 'length');
  if (keys.length !== length) throw new Error('Task assignment stored result integrity check failed.');
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Task assignment stored result integrity check failed.');
    }
    values.push(requiredId(descriptor.value, 'materialization event ID'));
  }
  if (keys.some((key, index) => key !== String(index))
    || new Set(values).size !== values.length
    || values.some((value, index) => index > 0 && values[index - 1] > value)) {
    throw new Error('Task assignment stored result integrity check failed.');
  }
  return values;
}

function freezeResult(result: TaskAssignmentCommandSuccess): TaskAssignmentCommandSuccess {
  Object.freeze(result.materializationEventIds);
  return Object.freeze(result);
}

function exactRow<const K extends readonly string[]>(raw: unknown, keys: K, label: string,
  ordered = false): { [P in K[number]]: unknown } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getOwnPropertySymbols(raw).length !== 0) throw new Error(`Task assignment ${label} is malformed.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const actual = Object.keys(raw);
  if (actual.length !== keys.length || (ordered
    ? actual.some((key, i) => key !== keys[i])
    : actual.some((key) => !keys.includes(key)))) {
    throw new Error(`Task assignment ${label} is malformed.`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`Task assignment ${label} is malformed.`);
    }
  }
  return raw as { [P in K[number]]: unknown };
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`Task assignment ${label} is invalid.`);
  }
  return value;
}
function requiredDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Task assignment ${label} is invalid.`);
  }
  return value;
}
function requiredCanonicalInstant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Task assignment result timestamp is invalid.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error('Task assignment result timestamp is invalid.');
  }
  return value;
}
function requiredHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new Error(`Task assignment ${label} is invalid.`);
  }
  return value;
}
function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Task assignment ${label} is invalid.`);
  return value as number;
}
function requiredPositiveIntegerText(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)
    || !Number.isSafeInteger(Number(value))) throw new Error(`Task assignment ${label} is invalid.`);
  return Number(value);
}
function assertExactReturning<const K extends readonly string[]>(rows: readonly unknown[], keys: K,
  expected: { [P in K[number]]: unknown }, label: string) {
  if (rows.length !== 1) throw new Error(`Task assignment ${label} integrity check failed.`);
  const row = exactRow(rows[0], keys, `${label} RETURNING evidence`);
  for (const key of keys as readonly K[number][]) {
    const actual = row[key];
    const wanted = expected[key];
    if (actual instanceof Date && wanted instanceof Date
      ? actual.getTime() !== wanted.getTime() : actual !== wanted) {
      throw new Error(`Task assignment ${label} integrity check failed.`);
    }
  }
}
function nullableTime(value: Date | null): number | null { return value?.getTime() ?? null; }
function assignmentCycleId(event: AssignmentEvidence): string {
  const start = event.cycle_start_at.toISOString().replace(/\.000Z$/, 'Z');
  return `v1|${event.task_instance_id}|r${event.rule_version}|${start}`;
}
function createMaterializationEventId(source: 'LEGACY_SEED' | 'CARRY_FORWARD',
  taskInstanceId: string, cycleId: string, studentId: string): string {
  return `task-assignment-materialization:${sha256({
    domain: 'task-assignment-materialization-v1', source, taskInstanceId, cycleId, studentId,
  })}`;
}
function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
