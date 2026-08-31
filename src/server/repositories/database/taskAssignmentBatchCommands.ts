import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isTaskAvailable } from '@/domain/taskAvailability';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { resolveTaskSchedule, validateTaskSchedule } from '@/domain/taskSchedule';
import type { DayOfMonth, IsoWeekday, TaskSchedule } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit, operationAuditEventId } from './operationAudit';
import { createTaskAdminAssignmentEventId } from './taskAdminCommands';
import { taskNaturalCompletionMaterializationId } from './taskCycleMaterialization';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATION_KEYS = ['operation_id', 'operation_kind', 'payload_hash', 'status', 'result_snapshot',
  'finished_at', 'failure_code', 'attempt_count', 'started_at', 'created_at', 'updated_at'] as const;
const ASSIGNMENT_KEYS = ['assignment_id', 'event_sequence', 'task_id_snapshot', 'task_instance_id',
  'cycle_id', 'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'student_id',
  'event_type', 'source', 'previous_assignment_id', 'admin_operation_id', 'admin_operation_hash',
  'created_at', 'schema_version', 'note'] as const;

type RunTenantTransaction = <T>(tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<T>) => Promise<T>;

export type DatabaseTaskAssignmentBatchCommandInput = Readonly<{
  operationId: string;
  targets: readonly Readonly<{
    taskId: string;
    operations: readonly Readonly<{
      studentId: string;
      assigned: boolean;
      source: 'ADMIN';
    }>[];
  }>[];
}>;

export type TaskAssignmentBatchEntry = Readonly<{
  taskId: string;
  taskInstanceId: string;
  studentId: string;
  assigned: boolean;
  changed: boolean;
  cycleId: string;
  transitionEventId: string | null;
  materializationEventIds: readonly string[];
}>;

export type TaskAssignmentBatchSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'ASSIGNMENT_BATCH';
  completedAt: string;
  entries: readonly TaskAssignmentBatchEntry[];
}>;

export type DatabaseTaskAssignmentBatchCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

type Pair = Readonly<{ taskId: string; studentId: string; assigned: boolean; source: 'ADMIN' }>;
type Canonical = Readonly<{ operationId: string; pairs: readonly Pair[] }>;
type Task = Readonly<{ task_instance_id: string; task_id: string; current_schedule: TaskSchedule;
  pending_schedule: TaskSchedule | null; created_at: Date; is_active: boolean;
  available_from: Date | null; due_at: Date | null }>;
type Mirror = Readonly<{ task_instance_id: string; student_id: string; created_at: Date }>;
type Assignment = ReturnType<typeof parseAssignment>;
type Completion = ReturnType<typeof parseCompletion>;
type Operation = Readonly<{ operation_id: string; operation_kind: string; payload_hash: string;
  status: string; result_snapshot: unknown; finished_at: Date | null; failure_code: string | null;
  attempt_count: string; started_at: Date; created_at: Date; updated_at: Date }>;

type SubjectEvidence<T> = Readonly<{ subjectKey: string; events: readonly T[] }>;

export function groupTaskAssignmentBatchEvidence<T extends Readonly<{
  task_instance_id: string;
  student_id: string;
}>>(events: readonly T[]): readonly SubjectEvidence<T>[] {
  const mutable = new Map<string, T[]>();
  for (const event of events) {
    const subjectKey = key(event.task_instance_id, event.student_id);
    const bucket = mutable.get(subjectKey);
    if (bucket) bucket.push(event);
    else mutable.set(subjectKey, [event]);
  }
  return Object.freeze([...mutable].map(([subjectKey, bucket]) => Object.freeze({
    subjectKey, events: Object.freeze(bucket),
  })));
}

export function createTaskAssignmentBatchPayloadHash(raw: DatabaseTaskAssignmentBatchCommandInput): string {
  const input = canonicalInput(raw);
  return sha256({ kind: 'TASK_ADMIN', action: 'ASSIGNMENT_BATCH', assignments: input.pairs,
    schemaVersion: 1 });
}

export function createDatabaseTaskAssignmentBatchCommand(
  dependencies: DatabaseTaskAssignmentBatchCommandDependencies,
) {
  return {
    async execute(raw: DatabaseTaskAssignmentBatchCommandInput): Promise<TaskAssignmentBatchSuccess> {
      const input = canonicalInput(raw);
      const now = dependencies.now?.() ?? new Date();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Task assignment batch current timestamp is invalid.');
      }
      const payloadHash = createTaskAssignmentBatchPayloadHash(raw);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) return replay(tx, dependencies.tenantId, existing, input, payloadHash);
        const claim = await tx.execute(sql`INSERT INTO operations
          (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
           started_at, created_at, updated_at)
          VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${payloadHash},
            'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id`);
        if (claim.rows.length === 0) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Task assignment batch operation claim integrity check failed.');
          return replay(tx, dependencies.tenantId, winner, input, payloadHash);
        }
        assertReturning(claim.rows, ['operation_id'], { operation_id: input.operationId }, 'operation claim');

        const requestedTaskIds = uniqueCanonical(input.pairs.map((pair) => pair.taskId));
        const taskRows = await tx.execute(sql`SELECT task_instance_id, task_id, current_schedule,
          pending_schedule, created_at, is_active, available_from, due_at
          FROM tasks WHERE tenant_id=${dependencies.tenantId}
          AND deleted_at IS NULL AND task_id IN (${sql.join(requestedTaskIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY task_instance_id FOR UPDATE`);
        if (taskRows.rows.length !== requestedTaskIds.length) {
          throw new Error('Task assignment batch target task integrity check failed.');
        }
        const tasks = new Map<string, Task>();
        for (const rawTask of taskRows.rows) {
          const task = parseTask(rawTask);
          if (!requestedTaskIds.includes(task.task_id) || tasks.has(task.task_id)) {
            throw new Error('Task assignment batch target task integrity check failed.');
          }
          tasks.set(task.task_id, task);
        }
        if (requestedTaskIds.some((taskId) => !tasks.has(taskId))) {
          throw new Error('Task assignment batch target not found.');
        }
        const requestedStudentIds = uniqueCanonical(input.pairs.map((pair) => pair.studentId));
        const studentRows = await tx.execute(sql`SELECT student_id, status FROM students
          WHERE tenant_id=${dependencies.tenantId}
          AND student_id IN (${sql.join(requestedStudentIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY student_id FOR UPDATE`);
        if (studentRows.rows.length !== requestedStudentIds.length) {
          throw new Error(studentRows.rows.length > requestedStudentIds.length
            ? 'Task assignment batch student evidence integrity check failed.'
            : 'Task assignment batch active student not found.');
        }
        const students = new Map<string, string>();
        for (const rawStudent of studentRows.rows) {
          const student = exactRow(rawStudent, ['student_id', 'status'], 'student evidence');
          const studentId = requiredId(student.student_id, 'student ID');
          if (!requestedStudentIds.includes(studentId) || students.has(studentId)) {
            throw new Error('Task assignment batch student evidence integrity check failed.');
          }
          students.set(studentId, requiredId(student.status, 'student status'));
        }
        for (const pair of input.pairs) if (students.get(pair.studentId) !== 'ACTIVE') {
          throw new Error('Task assignment batch active student not found.');
        }
        const targetInstances = uniqueCanonical([...tasks.values()].map((task) => task.task_instance_id));
        const mirrorRows = await tx.execute(sql`SELECT task_instance_id, student_id, created_at
          FROM task_allowed_students WHERE tenant_id=${dependencies.tenantId}
          AND task_instance_id IN (${sql.join(targetInstances.map((id) => sql`${id}`), sql`, `)})
          ORDER BY task_instance_id, student_id FOR UPDATE`);
        const allMirrors = mirrorRows.rows.map(parseMirror);
        validateMirrorMembership(allMirrors, new Set(targetInstances));
        const assignmentRows = await tx.execute(sql`SELECT assignment_id,
          event_sequence::text AS event_sequence, task_id_snapshot, task_instance_id, cycle_id,
          cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
          previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
          schema_version, note FROM task_assignments WHERE tenant_id=${dependencies.tenantId}
          AND task_instance_id IN (${sql.join(targetInstances.map((id) => sql`${id}`), sql`, `)})
          ORDER BY task_instance_id, student_id, event_sequence FOR UPDATE`);
        const allHistory = assignmentRows.rows.map(parseAssignment);
        validateHistory(allHistory, tasks);
        const completionRows = await readCompletions(tx, dependencies.tenantId, targetInstances, true);
        validateCompletionIdentities(completionRows, tasks);
        const initialMirrors = snapshot(allMirrors);
        const initialHistory = snapshot(allHistory);
        const expectedMirrors = new Map(allMirrors.map((row) => [key(row.task_instance_id, row.student_id), row]));
        const expectedHistory = [...allHistory];
        const expectedCompletions = [...completionRows];
        const latestCompletionByAssignment = new Map<string, Completion>();
        const completionCycleSubjects = new Set<string>();
        for (const completion of completionRows) {
          if (completion.assignment_id !== null) {
            latestCompletionByAssignment.set(completion.assignment_id, completion);
          }
          if (completion.task_instance_id !== null && completion.cycle_id !== null) {
            completionCycleSubjects.add(key(completion.task_instance_id, completion.student_id,
              completion.cycle_id));
          }
        }
        const completionCarryPlans: Array<Readonly<{ completionId: string; task: Task;
          studentId: string; cycleId: string; cycleStartsAt: Date; cycleEndsAt: Date | null;
          ruleVersion: number; timezone: string; assignmentId: string;
          priorCompletion: Completion }>> = [];
        const expectedHistoryBySubject = new Map(groupTaskAssignmentBatchEvidence(allHistory)
          .map((group) => [group.subjectKey, [...group.events]]));
        const entries: TaskAssignmentBatchEntry[] = [];

        for (const pair of input.pairs) {
          const task = tasks.get(pair.taskId)!;
          const schedule = resolveTaskSchedule({ currentSchedule: task.current_schedule,
            pendingSchedule: task.pending_schedule, now: now.toISOString() });
          if (schedule.timeZone !== 'Asia/Seoul') throw new Error('Task assignment batch timezone is invalid.');
          const cycle = getTaskCycle({ taskInstanceId: task.task_instance_id, schedule,
            taskCreatedAt: task.created_at.toISOString(), now: now.toISOString() });
          const mirrorKey = key(task.task_instance_id, pair.studentId);
          const subjectHistory = expectedHistoryBySubject.get(mirrorKey) ?? [];
          if (!expectedHistoryBySubject.has(mirrorKey)) expectedHistoryBySubject.set(mirrorKey, subjectHistory);
          let sameCycle = subjectHistory.filter((event) => event.cycle_id === cycle.cycleId
            && event.rule_version === schedule.ruleVersion && event.timezone === schedule.timeZone
            && event.cycle_start_at.getTime() === new Date(cycle.startsAt).getTime()
            && nullableTime(event.cycle_end_at) === nullableTime(cycle.endsAt ? new Date(cycle.endsAt) : null));
          let predecessor = sameCycle.at(-1) ?? null;
          let mirror = expectedMirrors.get(mirrorKey) ?? null;
          const materializationEventIds: string[] = [];
          let effectiveAssigned: boolean;
          if (predecessor) effectiveAssigned = predecessor.event_type === 'ASSIGNED';
          else {
            const transitionCarry = schedule.ruleVersion > 1
              && new Date(cycle.startsAt).getTime() === new Date(schedule.effectiveFrom).getTime();
            const canCarry = mirror !== null && task.is_active && isTaskAvailable({
              ...(task.available_from ? { availableFrom: task.available_from.toISOString() } : {}),
              ...(task.due_at ? { dueAt: task.due_at.toISOString() } : {}),
            }, now.toISOString());
            const prior = subjectHistory.filter((event) => event.cycle_start_at.getTime()
              < new Date(cycle.startsAt).getTime() || (transitionCarry
                && event.cycle_start_at.getTime() === new Date(cycle.startsAt).getTime()
                && event.rule_version < schedule.ruleVersion)).at(-1);
            const source = subjectHistory.length === 0 && canCarry ? 'LEGACY_SEED' as const
              : canCarry && prior?.event_type === 'ASSIGNED'
                && ((!schedule.resetAssignmentOnCycle
                  && prior.rule_version === schedule.ruleVersion && prior.cycle_end_at?.getTime()
                  === new Date(cycle.startsAt).getTime()) || (transitionCarry
                  && prior.cycle_start_at.getTime() <= new Date(cycle.startsAt).getTime()
                  && (prior.cycle_end_at === null || prior.cycle_end_at.getTime()
                    > new Date(cycle.startsAt).getTime())
                  && prior.rule_version < schedule.ruleVersion)) ? 'CARRY_FORWARD' as const : null;
            if (source) {
              const id = materializationId(source, task.task_instance_id, cycle.cycleId, pair.studentId);
              const inserted = await tx.execute(sql`INSERT INTO task_assignments
                (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
                 cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
                 source, previous_assignment_id, admin_operation_id, admin_operation_hash,
                 created_at, schema_version, note)
                VALUES (${dependencies.tenantId}, ${id}, ${pair.taskId}, ${task.task_instance_id},
                  ${cycle.cycleId}, ${new Date(cycle.startsAt)},
                  ${cycle.endsAt ? new Date(cycle.endsAt) : null}, ${schedule.ruleVersion},
                  ${schedule.timeZone}, ${pair.studentId}, 'ASSIGNED', ${source},
                  ${source === 'CARRY_FORWARD' ? prior?.assignment_id ?? null : null}, NULL, NULL,
                  ${now}, 1, NULL) RETURNING assignment_id`);
              assertReturning(inserted.rows, ['assignment_id'], { assignment_id: id }, 'materialization event');
              const event = await readAssignment(tx, dependencies.tenantId, id);
              expectedHistory.push(event); subjectHistory.push(event); predecessor = event; sameCycle = [event];
              materializationEventIds.push(id); effectiveAssigned = true;
              if (source === 'CARRY_FORWARD' && !schedule.resetCompletionOnCycle && prior) {
                const priorCompletion = latestCompletionByAssignment.get(prior.assignment_id);
                const cycleSubject = key(task.task_instance_id, pair.studentId, cycle.cycleId);
                if (!completionCycleSubjects.has(cycleSubject)
                  && priorCompletion?.status === 'COMPLETED'
                  && priorCompletion.student_id === pair.studentId
                  && priorCompletion.cycle_id === prior.cycle_id) {
                  completionCarryPlans.push(Object.freeze({
                    completionId: taskNaturalCompletionMaterializationId(task.task_instance_id,
                      cycle.cycleId, pair.studentId),
                    task, studentId: pair.studentId, cycleId: cycle.cycleId,
                    cycleStartsAt: new Date(cycle.startsAt),
                    cycleEndsAt: cycle.endsAt ? new Date(cycle.endsAt) : null,
                    ruleVersion: schedule.ruleVersion, timezone: schedule.timeZone,
                    assignmentId: id, priorCompletion,
                  }));
                  completionCycleSubjects.add(cycleSubject);
                }
              }
            } else effectiveAssigned = false;
          }
          if ((mirror !== null) !== effectiveAssigned) {
            if (effectiveAssigned) {
              const repaired = await insertMirror(tx, dependencies.tenantId, task.task_instance_id,
                pair.studentId, now, 'mirror repair');
              expectedMirrors.set(mirrorKey, repaired); mirror = repaired;
            } else {
              await deleteMirror(tx, dependencies.tenantId, task.task_instance_id, pair.studentId,
                mirror?.created_at, 'mirror reset');
              expectedMirrors.delete(mirrorKey); mirror = null;
            }
          }
          const changed = effectiveAssigned !== pair.assigned;
          const transitionEventId = changed ? createTaskAdminAssignmentEventId(input.operationId,
            pair.taskId, pair.studentId, pair.assigned ? 'ASSIGNED' : 'UNASSIGNED') : null;
          if (changed && pair.assigned) {
            mirror = await insertMirror(tx, dependencies.tenantId, task.task_instance_id,
              pair.studentId, now, 'mirror insert'); expectedMirrors.set(mirrorKey, mirror);
          } else if (changed) {
            await deleteMirror(tx, dependencies.tenantId, task.task_instance_id, pair.studentId,
              mirror?.created_at, 'mirror delete'); expectedMirrors.delete(mirrorKey); mirror = null;
          }
          if (transitionEventId) {
            const inserted = await tx.execute(sql`INSERT INTO task_assignments
              (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
               cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
               source, previous_assignment_id, admin_operation_id, admin_operation_hash,
               created_at, schema_version, note)
              VALUES (${dependencies.tenantId}, ${transitionEventId}, ${pair.taskId},
                ${task.task_instance_id}, ${cycle.cycleId}, ${new Date(cycle.startsAt)},
                ${cycle.endsAt ? new Date(cycle.endsAt) : null}, ${schedule.ruleVersion},
                ${schedule.timeZone}, ${pair.studentId}, ${pair.assigned ? 'ASSIGNED' : 'UNASSIGNED'},
                'ADMIN', ${predecessor?.assignment_id ?? null}, ${input.operationId}, ${payloadHash},
                ${now}, 1, NULL) RETURNING assignment_id`);
            assertReturning(inserted.rows, ['assignment_id'], { assignment_id: transitionEventId },
              'transition event');
            const event = await readAssignment(tx, dependencies.tenantId, transitionEventId);
            expectedHistory.push(event); subjectHistory.push(event);
          }
          entries.push(Object.freeze({ taskId: pair.taskId, taskInstanceId: task.task_instance_id,
            studentId: pair.studentId, assigned: pair.assigned, changed, cycleId: cycle.cycleId,
            transitionEventId, materializationEventIds: Object.freeze(materializationEventIds) }));
        }
        if (completionCarryPlans.length > 0) {
          const inserted = await tx.execute(sql`INSERT INTO task_completions
            (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
             task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
             balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
             rule_version, timezone, source, assignment_id, transaction_id, operation_id,
             operation_hash, admin_operation_id, admin_operation_hash, schema_version,
             evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
             evidence_author_full_name, created_at)
            VALUES ${sql.join(completionCarryPlans.map((plan) => sql`(
              ${dependencies.tenantId}, ${plan.completionId}, ${now}, ${plan.task.task_instance_id},
              ${plan.task.task_id}, ${plan.priorCompletion.task_name_snapshot}, ${plan.studentId},
              ${plan.priorCompletion.student_name_snapshot}, 0, ${plan.priorCompletion.balance_after},
              ${plan.priorCompletion.balance_after}, 'COMPLETED', NULL, ${plan.cycleId},
              ${plan.cycleStartsAt}, ${plan.cycleEndsAt}, ${plan.ruleVersion}, ${plan.timezone},
              'CARRY_FORWARD', ${plan.assignmentId}, NULL, NULL, NULL, NULL, NULL, 1,
              NULL, NULL, NULL, NULL, NULL, ${now})`), sql`, `)}
            RETURNING completion_id, event_sequence::text AS event_sequence, completed_at,
              task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
              student_name_snapshot, reward_snapshot, balance_before, balance_after, status, note,
              cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id,
              transaction_id, operation_id, operation_hash, admin_operation_id,
              admin_operation_hash, schema_version, evidence_provider, evidence_board_id,
              evidence_post_id, evidence_created_at, evidence_author_full_name, created_at`);
          if (inserted.rows.length !== completionCarryPlans.length) {
            throw new Error('Task assignment batch completion materialization integrity check failed.');
          }
          const returned = inserted.rows.map(parseCompletion);
          const returnedById = new Map(returned.map((completion) =>
            [completion.completion_id, completion]));
          if (returnedById.size !== completionCarryPlans.length) {
            throw new Error('Task assignment batch completion materialization integrity check failed.');
          }
          for (const plan of completionCarryPlans) {
            const completion = returnedById.get(plan.completionId);
            if (!completion || completion.completed_at.getTime() !== now.getTime()
              || completion.task_instance_id !== plan.task.task_instance_id
              || completion.task_id_snapshot !== plan.task.task_id
              || completion.task_name_snapshot !== plan.priorCompletion.task_name_snapshot
              || completion.student_id !== plan.studentId
              || completion.student_name_snapshot !== plan.priorCompletion.student_name_snapshot
              || completion.reward_snapshot !== 0
              || completion.balance_before !== plan.priorCompletion.balance_after
              || completion.balance_after !== plan.priorCompletion.balance_after
              || completion.status !== 'COMPLETED' || completion.note !== null
              || completion.cycle_id !== plan.cycleId
              || completion.cycle_start_at?.getTime() !== plan.cycleStartsAt.getTime()
              || nullableTime(completion.cycle_end_at) !== nullableTime(plan.cycleEndsAt)
              || completion.rule_version !== plan.ruleVersion || completion.timezone !== plan.timezone
              || completion.source !== 'CARRY_FORWARD'
              || completion.assignment_id !== plan.assignmentId
              || completion.transaction_id !== null || completion.operation_id !== null
              || completion.operation_hash !== null || completion.admin_operation_id !== null
              || completion.admin_operation_hash !== null || completion.schema_version !== 1
              || completion.evidence_provider !== null || completion.evidence_board_id !== null
              || completion.evidence_post_id !== null || completion.evidence_created_at !== null
              || completion.evidence_author_full_name !== null
              || completion.created_at.getTime() !== now.getTime()) {
              throw new Error('Task assignment batch completion materialization integrity check failed.');
            }
            expectedCompletions.push(completion);
          }
        }
        const result = freezeResult({ ok: true, operationId: input.operationId,
          action: 'ASSIGNMENT_BATCH', completedAt: now.toISOString(), entries });
        await verifyComplete(tx, dependencies.tenantId, tasks, result, payloadHash,
          initialMirrors, initialHistory, expectedMirrors, expectedHistory, expectedCompletions);
        const audit = auditInput(result, now);
        await appendOperationAudit(tx, dependencies.tenantId, audit);
        await assertOperationAudit(tx, dependencies.tenantId, audit);
        await assertOneAudit(tx, dependencies.tenantId, input.operationId);
        const terminal = await tx.execute(sql`UPDATE operations SET status='SUCCEEDED',
          result_snapshot=${JSON.stringify(result)}::jsonb, finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id`);
        assertReturning(terminal.rows, ['operation_id'], { operation_id: input.operationId },
          'terminal operation');
        await verifyComplete(tx, dependencies.tenantId, tasks, result, payloadHash,
          initialMirrors, initialHistory, expectedMirrors, expectedHistory, expectedCompletions);
        await assertOperationAudit(tx, dependencies.tenantId, audit);
        await assertOneAudit(tx, dependencies.tenantId, input.operationId);
        const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!stored) throw new Error('Task assignment batch terminal operation integrity check failed.');
        return replay(tx, dependencies.tenantId, stored, input, payloadHash);
      });
    },
  };
}

async function replay(tx: TenantTransaction, tenantId: string, operation: Operation,
  input: Canonical, payloadHash: string): Promise<TaskAssignmentBatchSuccess> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Task assignment batch operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== '1' || operation.finished_at === null
    || operation.started_at.getTime() !== operation.created_at.getTime()
    || operation.finished_at.getTime() !== operation.updated_at.getTime()
    || operation.started_at > operation.finished_at) {
    throw new Error('Task assignment batch operation is not replayable.');
  }
  const result = parseResult(operation.result_snapshot);
  if (result.operationId !== input.operationId || result.completedAt !== operation.finished_at.toISOString()
    || result.entries.length !== input.pairs.length || result.entries.some((entry, index) =>
      entry.taskId !== input.pairs[index].taskId || entry.studentId !== input.pairs[index].studentId
      || entry.assigned !== input.pairs[index].assigned)) {
    throw new Error('Task assignment batch stored result integrity check failed.');
  }
  const frozenInstances = uniqueCanonical(result.entries.map((entry) => entry.taskInstanceId));
  const identities = await tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(frozenInstances.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id`);
  if (identities.rows.length !== frozenInstances.length) {
    throw new Error('Task assignment batch physical identity integrity check failed.');
  }
  const identityMap = new Map<string, string>();
  for (const raw of identities.rows) {
    const row = exactRow(raw, ['task_instance_id', 'task_id'], 'replay task evidence');
    const taskInstanceId = requiredId(row.task_instance_id, 'task instance ID');
    if (!frozenInstances.includes(taskInstanceId) || identityMap.has(taskInstanceId)) {
      throw new Error('Task assignment batch physical identity integrity check failed.');
    }
    identityMap.set(taskInstanceId, requiredId(row.task_id, 'task ID'));
  }
  if (result.entries.some((entry) => identityMap.get(entry.taskInstanceId) !== entry.taskId)) {
    throw new Error('Task assignment batch physical identity integrity check failed.');
  }
  const histories = await tx.execute(sql`SELECT assignment_id, event_sequence::text AS event_sequence,
    task_id_snapshot, task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version,
    timezone, student_id, event_type, source, previous_assignment_id, admin_operation_id,
    admin_operation_hash, created_at, schema_version, note FROM task_assignments
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(frozenInstances.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id, student_id, event_sequence`);
  const history = histories.rows.map(parseAssignment);
  const byId = uniqueAssignments(history);
  validateHistoryWithIdentities(history, identityMap);
  const historyBySubject = new Map(groupTaskAssignmentBatchEvidence(history)
    .map((group) => [group.subjectKey, group.events]));
  const historyByOperation = new Map<string, Assignment[]>();
  for (const event of history) if (event.admin_operation_id !== null) {
    const bound = historyByOperation.get(event.admin_operation_id);
    if (bound) bound.push(event);
    else historyByOperation.set(event.admin_operation_id, [event]);
  }
  const expectedBound = result.entries.flatMap((entry) => entry.transitionEventId ? [entry.transitionEventId] : []);
  const actualBound = (historyByOperation.get(result.operationId) ?? [])
    .map((event) => event.assignment_id).sort(compareCanonical);
  if (snapshot(actualBound) !== snapshot([...expectedBound].sort(compareCanonical))) {
    throw new Error('Task assignment batch operation-bound event integrity check failed.');
  }
  validateResultEvents(byId, historyBySubject, result, payloadHash);
  const completions = await readCompletions(tx, tenantId, frozenInstances, false);
  validateCompletionIdentitiesWithMap(completions, identityMap);
  await assertOperationAudit(tx, tenantId, auditInput(result, operation.finished_at));
  await assertOneAudit(tx, tenantId, result.operationId);
  return result;
}

async function verifyComplete(tx: TenantTransaction, tenantId: string, tasks: ReadonlyMap<string, Task>,
  result: TaskAssignmentBatchSuccess, payloadHash: string, _initialMirrors: string,
  initialHistory: string, expectedMirrors: ReadonlyMap<string, Mirror>,
  expectedHistory: readonly Assignment[], expectedCompletions: readonly Completion[]) {
  const targetInstances = uniqueCanonical([...tasks.values()].map((task) => task.task_instance_id));
  const mirrors = (await tx.execute(sql`SELECT task_instance_id, student_id, created_at
    FROM task_allowed_students WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(targetInstances.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id, student_id`)).rows.map(parseMirror);
  validateMirrorMembership(mirrors, new Set(targetInstances));
  if (snapshot(mirrors) !== snapshot([...expectedMirrors.values()].sort((a, b) =>
    compareCanonical(a.task_instance_id, b.task_instance_id) || compareCanonical(a.student_id, b.student_id)))) {
    throw new Error('Task assignment batch complete-state mirror integrity check failed.');
  }
  const history = (await tx.execute(sql`SELECT assignment_id, event_sequence::text AS event_sequence,
    task_id_snapshot, task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version,
    timezone, student_id, event_type, source, previous_assignment_id, admin_operation_id,
    admin_operation_hash, created_at, schema_version, note FROM task_assignments
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(targetInstances.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id, student_id, event_sequence`)).rows.map(parseAssignment);
  validateHistory(history, tasks);
  if (snapshot(canonicalEvidence(history)) !== snapshot(canonicalEvidence(expectedHistory))) {
    throw new Error('Task assignment batch complete-state assignment set integrity check failed.');
  }
  const initialIds = new Set((JSON.parse(initialHistory) as Array<{ assignment_id: string }>)
    .map((event) => event.assignment_id));
  for (const event of history) if (!initialIds.has(event.assignment_id) && event.admin_operation_id !== null
    && event.admin_operation_hash !== payloadHash) {
    throw new Error('Task assignment batch assignment integrity check failed.');
  }
  const completions = await readCompletions(tx, tenantId, targetInstances, false);
  validateCompletionIdentities(completions, tasks);
  if (snapshot(canonicalCompletions(completions))
    !== snapshot(canonicalCompletions(expectedCompletions))) {
    throw new Error('Task assignment batch completion history integrity check failed.');
  }
  const expectedBound = result.entries.filter((entry) => entry.transitionEventId !== null).length;
  if (history.filter((event) => event.admin_operation_id === result.operationId).length !== expectedBound) {
    throw new Error('Task assignment batch operation-bound event integrity check failed.');
  }
}

function canonicalInput(raw: DatabaseTaskAssignmentBatchCommandInput): Canonical {
  const root = exactRow(raw, ['operationId', 'targets'], 'input');
  if (typeof root.operationId !== 'string' || !UUID.test(root.operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  const targets = exactArray(root.targets, 1, 20, 'targets');
  const taskIds = new Set<string>(); const pairs: Pair[] = []; let total = 0;
  for (const rawTarget of targets) {
    const target = exactRow(rawTarget, ['taskId', 'operations'], 'target');
    const taskId = requiredId(target.taskId, 'task ID');
    if (taskIds.has(taskId)) throw new Error('Duplicate task assignment batch task ID.');
    taskIds.add(taskId);
    const operations = exactArray(target.operations, 1, 40, 'operations');
    const studentIds = new Set<string>();
    for (const rawOperation of operations) {
      const operation = exactRow(rawOperation, ['studentId', 'assigned', 'source'], 'operation');
      const studentId = requiredId(operation.studentId, 'student ID');
      if (studentIds.has(studentId)) throw new Error('Duplicate task assignment batch student ID.');
      studentIds.add(studentId);
      if (typeof operation.assigned !== 'boolean' || operation.source !== 'ADMIN') {
        throw new Error('Task assignment batch operation is invalid.');
      }
      pairs.push({ taskId, studentId, assigned: operation.assigned, source: 'ADMIN' }); total += 1;
    }
  }
  if (total > 100) throw new Error('Task assignment batch total limit exceeded.');
  pairs.sort((a, b) => compareCanonical(a.taskId, b.taskId)
    || compareCanonical(a.studentId, b.studentId));
  return { operationId: root.operationId, pairs };
}

function exactArray(raw: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length !== 0) throw new Error(`Task assignment batch ${label} is malformed.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw) as Record<string, PropertyDescriptor>;
  const length = descriptors.length;
  if (!length || length.enumerable || !Object.hasOwn(length, 'value')
    || !Number.isSafeInteger(length.value) || length.value < min || length.value > max) {
    throw new Error(`Task assignment batch ${label} is malformed.`);
  }
  const values: unknown[] = [];
  for (let i = 0; i < length.value; i += 1) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`Task assignment batch ${label} is malformed.`);
    }
    values.push(descriptor.value);
  }
  if (Object.keys(descriptors).filter((key) => key !== 'length').length !== length.value) {
    throw new Error(`Task assignment batch ${label} is malformed.`);
  }
  return values;
}

function exactRow<const K extends readonly string[]>(raw: unknown, keys: K, label: string) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error(`Task assignment batch ${label} is malformed.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw); const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`Task assignment batch ${label} is malformed.`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`Task assignment batch ${label} is malformed.`);
    }
  }
  return raw as { [P in K[number]]: unknown };
}

function parseTask(raw: unknown): Task {
  const row = exactRow(raw, ['task_instance_id', 'task_id', 'current_schedule', 'pending_schedule',
    'created_at', 'is_active', 'available_from', 'due_at'], 'task evidence');
  if (typeof row.is_active !== 'boolean') {
    throw new Error('Task assignment batch task evidence is malformed.');
  }
  return { task_instance_id: requiredId(row.task_instance_id, 'task instance ID'),
    task_id: requiredId(row.task_id, 'task ID'), current_schedule: parseSchedule(row.current_schedule),
    pending_schedule: row.pending_schedule === null ? null : parseSchedule(row.pending_schedule),
    created_at: requiredDate(row.created_at, 'task created timestamp'), is_active: row.is_active,
    available_from: row.available_from === null ? null
      : requiredDate(row.available_from, 'task available timestamp'),
    due_at: row.due_at === null ? null : requiredDate(row.due_at, 'task due timestamp') };
}

function parseSchedule(raw: unknown): TaskSchedule {
  const row = exactRow(raw, ['ruleVersion', 'effectiveFrom', 'timeZone', 'recurrence',
    'resetCompletionOnCycle', 'resetAssignmentOnCycle'], 'schedule evidence');
  if (typeof row.resetCompletionOnCycle !== 'boolean'
    || typeof row.resetAssignmentOnCycle !== 'boolean') {
    throw new Error('Task assignment batch schedule evidence is malformed.');
  }
  const schedule = {
    ruleVersion: requiredSafeInteger(row.ruleVersion, 'schedule rule version'),
    effectiveFrom: requiredId(row.effectiveFrom, 'schedule effective timestamp'),
    timeZone: requiredId(row.timeZone, 'schedule timezone'),
    recurrence: parseRecurrence(row.recurrence),
    resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle,
  };
  try {
    return validateTaskSchedule(schedule);
  } catch {
    throw new Error('Task assignment batch schedule evidence is malformed.');
  }
}

function parseRecurrence(raw: unknown): TaskSchedule['recurrence'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error('Task assignment batch schedule evidence is malformed.');
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(raw, 'type');
  if (!typeDescriptor?.enumerable || !Object.hasOwn(typeDescriptor, 'value')) {
    throw new Error('Task assignment batch schedule evidence is malformed.');
  }
  if (typeDescriptor.value === 'NONE') {
    exactRow(raw, ['type'], 'schedule evidence');
    return { type: 'NONE' };
  }
  if (typeDescriptor.value === 'DAILY') {
    const row = exactRow(raw, ['type', 'time'], 'schedule evidence');
    return { type: 'DAILY', time: requiredId(row.time, 'schedule recurrence time') };
  }
  if (typeDescriptor.value === 'WEEKLY') {
    const row = exactRow(raw, ['type', 'weekdays', 'time'], 'schedule evidence');
    const weekdays = exactArray(row.weekdays, 1, 7, 'schedule weekdays')
      .map((value) => requiredSafeInteger(value, 'schedule weekday'));
    return { type: 'WEEKLY', weekdays: weekdays as IsoWeekday[],
      time: requiredId(row.time, 'schedule recurrence time') };
  }
  if (typeDescriptor.value === 'MONTHLY') {
    const row = exactRow(raw, ['type', 'dayOfMonth', 'time'], 'schedule evidence');
    return { type: 'MONTHLY', dayOfMonth: requiredSafeInteger(row.dayOfMonth,
      'schedule day of month') as DayOfMonth, time: requiredId(row.time, 'schedule recurrence time') };
  }
  throw new Error('Task assignment batch schedule evidence is malformed.');
}
function parseMirror(raw: unknown): Mirror {
  const row = exactRow(raw, ['task_instance_id', 'student_id', 'created_at'], 'mirror evidence');
  return { task_instance_id: requiredId(row.task_instance_id, 'mirror task instance ID'),
    student_id: requiredId(row.student_id, 'mirror student ID'),
    created_at: requiredDate(row.created_at, 'mirror created timestamp') };
}
function validateMirrorMembership(rows: readonly Mirror[], targetInstances: ReadonlySet<string>) {
  const identities = new Set<string>();
  for (const row of rows) {
    const identity = key(row.task_instance_id, row.student_id);
    if (!targetInstances.has(row.task_instance_id) || identities.has(identity)) {
      throw new Error('Task assignment batch mirror evidence integrity check failed.');
    }
    identities.add(identity);
  }
}
function parseAssignment(raw: unknown) {
  const row = exactRow(raw, ASSIGNMENT_KEYS, 'assignment evidence');
  if (typeof row.event_sequence !== 'string' || !/^[1-9][0-9]*$/.test(row.event_sequence)
    || !Number.isSafeInteger(Number(row.event_sequence)) || (row.event_type !== 'ASSIGNED'
      && row.event_type !== 'UNASSIGNED') || !['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(row.source as string)
    || row.schema_version !== 1 || row.note !== null) throw new Error('Task assignment batch history integrity check failed.');
  const source = row.source as 'ADMIN' | 'QR' | 'LEGACY_SEED' | 'CARRY_FORWARD';
  const bound = source === 'ADMIN' || source === 'QR';
  if (bound ? (typeof row.admin_operation_id !== 'string' || typeof row.admin_operation_hash !== 'string'
    || !HASH.test(row.admin_operation_hash)) : (row.admin_operation_id !== null || row.admin_operation_hash !== null)) {
    throw new Error('Task assignment batch history integrity check failed.');
  }
  return { assignment_id: requiredId(row.assignment_id, 'assignment ID'),
    event_sequence: Number(row.event_sequence), task_id_snapshot: requiredId(row.task_id_snapshot, 'assignment task ID'),
    task_instance_id: requiredId(row.task_instance_id, 'assignment task instance ID'),
    cycle_id: requiredId(row.cycle_id, 'cycle ID'), cycle_start_at: requiredDate(row.cycle_start_at, 'cycle start'),
    cycle_end_at: row.cycle_end_at === null ? null : requiredDate(row.cycle_end_at, 'cycle end'),
    rule_version: requiredSafeInteger(row.rule_version, 'rule version'), timezone: requiredId(row.timezone, 'timezone'),
    student_id: requiredId(row.student_id, 'student ID'), event_type: row.event_type as 'ASSIGNED' | 'UNASSIGNED',
    source, previous_assignment_id: row.previous_assignment_id === null ? null : requiredId(row.previous_assignment_id, 'predecessor ID'),
    admin_operation_id: row.admin_operation_id as string | null,
    admin_operation_hash: row.admin_operation_hash as string | null,
    created_at: requiredDate(row.created_at, 'assignment timestamp'), schema_version: 1, note: null };
}

function validateHistory(history: readonly Assignment[], tasks: ReadonlyMap<string, Task>) {
  validateHistoryWithIdentities(history,
    new Map([...tasks.values()].map((task) => [task.task_instance_id, task.task_id])));
}

function validateHistoryWithIdentities(history: readonly Assignment[],
  taskByPhysical: ReadonlyMap<string, string>) {
  const ordered = [...history].sort((left, right) => left.event_sequence - right.event_sequence);
  const byId = uniqueAssignments(ordered);
  const priorByCycle = new Map<string, Assignment>();
  const latestBySubject = new Map<string, Assignment>();
  const cycleKey = (event: Assignment) => key(event.task_instance_id, event.student_id,
    event.cycle_id, event.cycle_start_at.toISOString(), event.cycle_end_at?.toISOString() ?? 'null',
    String(event.rule_version), event.timezone);
  const subjectKey = (event: Assignment) => key(event.task_instance_id, event.student_id);
  for (const event of ordered) {
    if (!taskByPhysical.has(event.task_instance_id)
      || taskByPhysical.get(event.task_instance_id) !== event.task_id_snapshot
      || event.timezone !== 'Asia/Seoul' || assignmentCycleId(event) !== event.cycle_id
      || (event.cycle_end_at !== null
        && event.cycle_end_at.getTime() <= event.cycle_start_at.getTime())
      || event.rule_version <= 0) {
      throw new Error('Task assignment batch history integrity check failed.');
    }
    const latest = latestBySubject.get(subjectKey(event));
    if (event.source === 'LEGACY_SEED') {
      if (event.event_type !== 'ASSIGNED' || event.previous_assignment_id !== null
        || latest !== undefined) {
        throw new Error('Task assignment batch history predecessor integrity check failed.');
      }
    } else if (event.source === 'CARRY_FORWARD') {
      const previous = event.previous_assignment_id === null
        ? undefined : byId.get(event.previous_assignment_id);
      const previousCycleClosed = previous !== undefined && previous.cycle_end_at !== null
        && previous.cycle_end_at.getTime() <= event.cycle_start_at.getTime();
      const immediateRuleTransition = previous !== undefined
        && previous.rule_version < event.rule_version
        && previous.cycle_start_at.getTime() <= event.cycle_start_at.getTime();
      if (event.event_type !== 'ASSIGNED' || !previous || previous !== latest
        || previous.event_type !== 'ASSIGNED' || previous.student_id !== event.student_id
        || previous.task_instance_id !== event.task_instance_id
        || previous.task_id_snapshot !== event.task_id_snapshot
        || cycleKey(previous) === cycleKey(event)
        || (!previousCycleClosed && !immediateRuleTransition)
        || previous.event_sequence >= event.event_sequence
        || previous.created_at.getTime() > event.created_at.getTime()) {
        throw new Error('Task assignment batch carry-forward integrity check failed.');
      }
    } else {
      const prior = priorByCycle.get(cycleKey(event)) ?? null;
      if ((event.previous_assignment_id ?? null) !== (prior?.assignment_id ?? null)
        || (prior !== null && prior.created_at.getTime() > event.created_at.getTime())) {
        throw new Error('Task assignment batch history predecessor integrity check failed.');
      }
    }
    priorByCycle.set(cycleKey(event), event);
    latestBySubject.set(subjectKey(event), event);
  }
}

function uniqueAssignments(events: readonly Assignment[]) {
  const byId = new Map<string, Assignment>();
  for (const event of events) {
    if (byId.has(event.assignment_id)) {
      throw new Error('Task assignment batch history integrity check failed.');
    }
    byId.set(event.assignment_id, event);
  }
  return byId;
}

function assignmentCycleId(event: Assignment) {
  const start = event.cycle_start_at.toISOString().replace(/\.000Z$/, 'Z');
  return `v1|${event.task_instance_id}|r${event.rule_version}|${start}`;
}

function validateResultEvents(byId: ReadonlyMap<string, Assignment>,
  historyBySubject: ReadonlyMap<string, readonly Assignment[]>,
  result: TaskAssignmentBatchSuccess, payloadHash: string) {
  for (const entry of result.entries) {
    const subjectHistory = historyBySubject.get(key(entry.taskInstanceId, entry.studentId)) ?? [];
    let frozenCycleTuple: string | null = null;
    const validateFrozenCycle = (event: Assignment) => {
      const tuple = snapshot([event.cycle_id, event.cycle_start_at.toISOString(),
        event.cycle_end_at?.toISOString() ?? null, event.rule_version, event.timezone]);
      if (event.cycle_id !== entry.cycleId || assignmentCycleId(event) !== event.cycle_id
        || event.timezone !== 'Asia/Seoul' || (event.cycle_end_at !== null
          && event.cycle_end_at.getTime() <= event.cycle_start_at.getTime())
        || (frozenCycleTuple !== null && frozenCycleTuple !== tuple)) return false;
      frozenCycleTuple = tuple;
      return true;
    };
    const actualMaterializationEventIds = subjectHistory.filter((event) =>
      (event.source === 'LEGACY_SEED' || event.source === 'CARRY_FORWARD')
      && event.task_id_snapshot === entry.taskId
      && event.task_instance_id === entry.taskInstanceId
      && event.student_id === entry.studentId
      && event.created_at.toISOString() === result.completedAt
      && event.assignment_id === materializationId(event.source, entry.taskInstanceId,
        event.cycle_id, entry.studentId))
      .map((event) => event.assignment_id).sort(compareCanonical);
    const frozenMaterializationEventIds = [...entry.materializationEventIds]
      .sort(compareCanonical);
    if (snapshot(actualMaterializationEventIds) !== snapshot(frozenMaterializationEventIds)) {
      throw new Error('Task assignment batch materialization event integrity check failed.');
    }
    for (const id of entry.materializationEventIds) {
      const event = byId.get(id);
      if (!event || (event.source !== 'LEGACY_SEED' && event.source !== 'CARRY_FORWARD')
        || event.assignment_id !== materializationId(event.source, entry.taskInstanceId,
          entry.cycleId, entry.studentId)
        || event.task_id_snapshot !== entry.taskId || event.task_instance_id !== entry.taskInstanceId
        || event.student_id !== entry.studentId || !validateFrozenCycle(event)
        || event.event_type !== 'ASSIGNED' || event.admin_operation_id !== null
        || event.admin_operation_hash !== null || event.created_at.toISOString() !== result.completedAt
        || (event.source === 'LEGACY_SEED' && event.previous_assignment_id !== null)
        || (event.source === 'CARRY_FORWARD' && event.previous_assignment_id === null)) {
        throw new Error('Task assignment batch materialization event integrity check failed.');
      }
    }
    if (entry.transitionEventId) {
      const event = byId.get(entry.transitionEventId);
      const expectedId = createTaskAdminAssignmentEventId(result.operationId, entry.taskId,
        entry.studentId, entry.assigned ? 'ASSIGNED' : 'UNASSIGNED');
      if (!event || event.assignment_id !== expectedId || event.task_id_snapshot !== entry.taskId
        || event.task_instance_id !== entry.taskInstanceId || event.student_id !== entry.studentId
        || !validateFrozenCycle(event)
        || event.event_type !== (entry.assigned ? 'ASSIGNED' : 'UNASSIGNED')
        || event.source !== 'ADMIN' || event.admin_operation_id !== result.operationId
        || event.admin_operation_hash !== payloadHash
        || event.created_at.toISOString() !== result.completedAt) {
        throw new Error('Task assignment batch transition event integrity check failed.');
      }
      const priorInCycle = subjectHistory.filter((candidate) => candidate.event_sequence < event.event_sequence
        && candidate.cycle_id === event.cycle_id
        && candidate.cycle_start_at.getTime() === event.cycle_start_at.getTime()
        && nullableTime(candidate.cycle_end_at) === nullableTime(event.cycle_end_at)
        && candidate.rule_version === event.rule_version && candidate.timezone === event.timezone)
        .sort((left, right) => left.event_sequence - right.event_sequence).at(-1) ?? null;
      if ((event.previous_assignment_id ?? null) !== (priorInCycle?.assignment_id ?? null)) {
        throw new Error('Task assignment batch transition event integrity check failed.');
      }
    }
  }
}

async function readAssignment(tx: TenantTransaction, tenantId: string, id: string) {
  const rows = await tx.execute(sql`SELECT assignment_id, event_sequence::text AS event_sequence,
    task_id_snapshot, task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version,
    timezone, student_id, event_type, source, previous_assignment_id, admin_operation_id,
    admin_operation_hash, created_at, schema_version, note FROM task_assignments
    WHERE tenant_id=${tenantId} AND assignment_id=${id}`);
  if (rows.rows.length !== 1) throw new Error('Task assignment batch event read integrity check failed.');
  const event = parseAssignment(rows.rows[0]);
  if (event.assignment_id !== id) {
    throw new Error('Task assignment batch event read integrity check failed.');
  }
  return event;
}
async function insertMirror(tx: TenantTransaction, tenantId: string, taskInstanceId: string,
  studentId: string, now: Date, label: string) {
  const result = await tx.execute(sql`INSERT INTO task_allowed_students
    (tenant_id, task_instance_id, student_id, created_at)
    VALUES (${tenantId}, ${taskInstanceId}, ${studentId}, ${now})
    RETURNING task_instance_id, student_id, created_at`);
  assertReturning(result.rows, ['task_instance_id', 'student_id', 'created_at'], {
    task_instance_id: taskInstanceId, student_id: studentId, created_at: now }, label);
  return parseMirror(result.rows[0]);
}
async function deleteMirror(tx: TenantTransaction, tenantId: string, taskInstanceId: string,
  studentId: string, createdAt: Date | undefined, label: string) {
  const result = await tx.execute(sql`DELETE FROM task_allowed_students WHERE tenant_id=${tenantId}
    AND task_instance_id=${taskInstanceId} AND student_id=${studentId}
    RETURNING task_instance_id, student_id, created_at`);
  assertReturning(result.rows, ['task_instance_id', 'student_id', 'created_at'], {
    task_instance_id: taskInstanceId, student_id: studentId, created_at: createdAt }, label);
}
async function readCompletions(tx: TenantTransaction, tenantId: string,
  taskInstanceIds: readonly string[], lock: boolean) {
  const columns = sql`completion_id, event_sequence::text AS event_sequence, completed_at,
    task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
    student_name_snapshot, reward_snapshot, balance_before, balance_after, status, note,
    cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id,
    transaction_id, operation_id, operation_hash, admin_operation_id, admin_operation_hash,
    schema_version, evidence_provider, evidence_board_id, evidence_post_id,
    evidence_created_at, evidence_author_full_name, created_at`;
  const result = await tx.execute(lock ? sql`SELECT ${columns} FROM task_completions
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(taskInstanceIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id, event_sequence FOR UPDATE`
    : sql`SELECT ${columns} FROM task_completions WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(taskInstanceIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY task_instance_id, event_sequence`);
  return result.rows.map(parseCompletion);
}

function parseCompletion(raw: unknown) {
  const keys = ['completion_id', 'event_sequence', 'completed_at', 'task_instance_id',
    'task_id_snapshot', 'task_name_snapshot', 'student_id', 'student_name_snapshot',
    'reward_snapshot', 'balance_before', 'balance_after', 'status', 'note', 'cycle_id',
    'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'source', 'assignment_id',
    'transaction_id', 'operation_id', 'operation_hash', 'admin_operation_id',
    'admin_operation_hash', 'schema_version', 'evidence_provider', 'evidence_board_id',
    'evidence_post_id', 'evidence_created_at', 'evidence_author_full_name', 'created_at'] as const;
  const row = exactRow(raw, keys, 'completion evidence');
  if (row.schema_version !== 1 || typeof row.task_name_snapshot !== 'string'
    || typeof row.student_name_snapshot !== 'string' || typeof row.status !== 'string'
    || row.status.trim().length === 0 || (row.source !== null
      && (typeof row.source !== 'string'
        || !['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'].includes(row.source)))) {
    throw new Error('Task assignment batch completion history integrity check failed.');
  }
  const nullableId = (value: unknown, label: string) => value === null ? null : requiredId(value, label);
  const nullableDate = (value: unknown, label: string) => value === null ? null : requiredDate(value, label);
  const nullableInteger = (value: unknown, label: string) => value === null
    ? null : requiredSafeInteger(value, label);
  const operationHash = row.operation_hash === null ? null : requiredHash(row.operation_hash,
    'completion operation hash');
  const adminOperationHash = row.admin_operation_hash === null ? null
    : requiredHash(row.admin_operation_hash, 'completion admin operation hash');
  if ((row.operation_id === null) !== (operationHash === null)
    || (row.admin_operation_id === null) !== (adminOperationHash === null)) {
    throw new Error('Task assignment batch completion history integrity check failed.');
  }
  const taskInstanceId = nullableId(row.task_instance_id, 'completion task instance ID');
  const cycleId = nullableId(row.cycle_id, 'completion cycle ID');
  const cycleStartAt = nullableDate(row.cycle_start_at, 'completion cycle start');
  const cycleEndAt = nullableDate(row.cycle_end_at, 'completion cycle end');
  const ruleVersion = nullableInteger(row.rule_version, 'completion rule version');
  const timezone = nullableId(row.timezone, 'completion timezone');
  const hasCycleMetadata = taskInstanceId !== null;
  if (hasCycleMetadata !== (cycleId !== null)
    || hasCycleMetadata !== (cycleStartAt !== null)
    || hasCycleMetadata !== (ruleVersion !== null)
    || hasCycleMetadata !== (timezone !== null)
    || hasCycleMetadata !== (row.source !== null)
    || (cycleEndAt !== null && cycleStartAt === null)) {
    throw new Error('Task assignment batch completion history integrity check failed.');
  }
  return { completion_id: requiredId(row.completion_id, 'completion ID'),
    event_sequence: requiredPositiveIntegerText(row.event_sequence, 'completion event sequence'),
    completed_at: requiredDate(row.completed_at, 'completion timestamp'),
    task_instance_id: taskInstanceId,
    task_id_snapshot: requiredId(row.task_id_snapshot, 'completion task ID'),
    task_name_snapshot: row.task_name_snapshot, student_id: requiredId(row.student_id, 'completion student ID'),
    student_name_snapshot: row.student_name_snapshot,
    reward_snapshot: requiredSafeInteger(row.reward_snapshot, 'completion reward'),
    balance_before: requiredSafeInteger(row.balance_before, 'completion balance before'),
    balance_after: requiredSafeInteger(row.balance_after, 'completion balance after'), status: row.status,
    note: nullableId(row.note, 'completion note'), cycle_id: cycleId,
    cycle_start_at: cycleStartAt, cycle_end_at: cycleEndAt, rule_version: ruleVersion,
    timezone, source: row.source,
    assignment_id: nullableId(row.assignment_id, 'completion assignment ID'),
    transaction_id: nullableId(row.transaction_id, 'completion transaction ID'),
    operation_id: nullableId(row.operation_id, 'completion operation ID'), operation_hash: operationHash,
    admin_operation_id: nullableId(row.admin_operation_id, 'completion admin operation ID'),
    admin_operation_hash: adminOperationHash,
    schema_version: 1, evidence_provider: nullableId(row.evidence_provider, 'completion evidence provider'),
    evidence_board_id: nullableId(row.evidence_board_id, 'completion evidence board ID'),
    evidence_post_id: nullableId(row.evidence_post_id, 'completion evidence post ID'),
    evidence_created_at: nullableDate(row.evidence_created_at, 'completion evidence timestamp'),
    evidence_author_full_name: nullableId(row.evidence_author_full_name, 'completion evidence author'),
    created_at: requiredDate(row.created_at, 'completion created timestamp') };
}

function validateCompletionIdentities(rows: readonly ReturnType<typeof parseCompletion>[],
  tasks: ReadonlyMap<string, Task>) {
  validateCompletionIdentitiesWithMap(rows,
    new Map([...tasks.values()].map((task) => [task.task_instance_id, task.task_id])));
}
function validateCompletionIdentitiesWithMap(rows: readonly ReturnType<typeof parseCompletion>[],
  physical: ReadonlyMap<string, string>) {
  const completionIds = new Set<string>();
  const eventSequences = new Set<number>();
  for (const row of rows) {
    if (row.task_instance_id === null || !physical.has(row.task_instance_id)
      || physical.get(row.task_instance_id) !== row.task_id_snapshot
      || completionIds.has(row.completion_id) || eventSequences.has(row.event_sequence)) {
      throw new Error('Task assignment batch completion history integrity check failed.');
    }
    completionIds.add(row.completion_id);
    eventSequences.add(row.event_sequence);
  }
}

async function readOperation(tx: TenantTransaction, tenantId: string, operationId: string) {
  const result = await tx.execute(sql`SELECT operation_id, operation_kind, payload_hash, status,
    result_snapshot, finished_at, failure_code, attempt_count::text AS attempt_count,
    started_at, created_at, updated_at FROM operations WHERE tenant_id=${tenantId}
    AND operation_id=${operationId} FOR UPDATE`);
  if (result.rows.length > 1) throw new Error('Task assignment batch operation integrity check failed.');
  if (!result.rows.length) return null;
  const row = exactRow(result.rows[0], OPERATION_KEYS, 'operation evidence');
  if (row.operation_id !== operationId || row.operation_kind !== 'TASK_ADMIN'
    || typeof row.payload_hash !== 'string' || !HASH.test(row.payload_hash)
    || typeof row.status !== 'string' || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(row.status)
    || typeof row.attempt_count !== 'string' || !/^[1-9][0-9]*$/.test(row.attempt_count)) {
    throw new Error('Task assignment batch operation integrity check failed.');
  }
  return { ...row, started_at: requiredDate(row.started_at, 'operation start'),
    created_at: requiredDate(row.created_at, 'operation create'), updated_at: requiredDate(row.updated_at, 'operation update'),
    finished_at: row.finished_at === null ? null : requiredDate(row.finished_at, 'operation finish') } as Operation;
}

function parseResult(raw: unknown): TaskAssignmentBatchSuccess {
  const row = exactRow(raw, ['ok', 'operationId', 'action', 'completedAt', 'entries'], 'stored result');
  if (row.ok !== true || row.action !== 'ASSIGNMENT_BATCH') throw new Error('Task assignment batch stored result integrity check failed.');
  const entries = exactArray(row.entries, 1, 100, 'stored result entries').map((rawEntry) => {
    const entry = exactRow(rawEntry, ['taskId', 'taskInstanceId', 'studentId', 'assigned', 'changed',
      'cycleId', 'transitionEventId', 'materializationEventIds'], 'stored result entry');
    if (typeof entry.assigned !== 'boolean' || typeof entry.changed !== 'boolean'
      || (entry.transitionEventId !== null && typeof entry.transitionEventId !== 'string')) {
      throw new Error('Task assignment batch stored result integrity check failed.');
    }
    const materializationEventIds = exactArray(entry.materializationEventIds, 0, 1,
      'stored materialization events').map((id) => requiredId(id, 'materialization event ID'));
    if (entry.changed !== (entry.transitionEventId !== null)
      || (materializationEventIds.length === 1 && entry.changed !== !entry.assigned)) {
      throw new Error('Task assignment batch stored result integrity check failed.');
    }
    return Object.freeze({ taskId: requiredId(entry.taskId, 'result task ID'),
      taskInstanceId: requiredId(entry.taskInstanceId, 'result task instance ID'),
      studentId: requiredId(entry.studentId, 'result student ID'), assigned: entry.assigned,
      changed: entry.changed, cycleId: requiredId(entry.cycleId, 'result cycle ID'),
      transitionEventId: entry.transitionEventId as string | null,
      materializationEventIds: Object.freeze(materializationEventIds) });
  });
  if (entries.some((entry, index) => index > 0 && (compareCanonical(entries[index - 1].taskId, entry.taskId)
    || compareCanonical(entries[index - 1].studentId, entry.studentId)) > 0)) {
    throw new Error('Task assignment batch stored result ordering integrity check failed.');
  }
  const completedAt = requiredCanonicalInstant(row.completedAt);
  return freezeResult({ ok: true, operationId: requiredId(row.operationId, 'result operation ID'),
    action: 'ASSIGNMENT_BATCH', completedAt, entries });
}
function freezeResult(result: TaskAssignmentBatchSuccess): TaskAssignmentBatchSuccess {
  Object.freeze(result.entries); return Object.freeze(result);
}
function auditInput(result: TaskAssignmentBatchSuccess, occurredAt: Date) {
  return { operationId: result.operationId, eventType: 'TASK_ADMIN_COMPLETED', entityType: 'OPERATION',
    entityId: result.operationId, redactedDetails: { action: 'ASSIGNMENT_BATCH',
      taskCount: new Set(result.entries.map((entry) => entry.taskId)).size,
      entryCount: result.entries.length,
      materializationEventCount: result.entries.reduce((sum, entry) => sum + entry.materializationEventIds.length, 0),
      transitionEventCount: result.entries.filter((entry) => entry.transitionEventId !== null).length,
      resultHash: sha256(result) }, occurredAt } as const;
}
async function assertOneAudit(tx: TenantTransaction, tenantId: string, operationId: string) {
  const result = await tx.execute(sql`SELECT event_id FROM audit_events WHERE tenant_id=${tenantId}
    AND operation_id=${operationId} ORDER BY event_id`);
  if (result.rows.length !== 1) throw new Error('Task assignment batch operation audit set integrity check failed.');
  const row = exactRow(result.rows[0], ['event_id'], 'audit evidence');
  if (row.event_id !== operationAuditEventId(operationId, 'TASK_ADMIN_COMPLETED')) {
    throw new Error('Task assignment batch operation audit set integrity check failed.');
  }
}
function assertReturning<const K extends readonly string[]>(rows: readonly unknown[], keys: K,
  expected: { [P in K[number]]: unknown }, label: string) {
  if (rows.length !== 1) throw new Error(`Task assignment batch ${label} integrity check failed.`);
  const row = exactRow(rows[0], keys, `${label} RETURNING evidence`);
  for (const key of keys as readonly K[number][]) {
    const actual = row[key]; const wanted = expected[key];
    if (actual instanceof Date && wanted instanceof Date ? actual.getTime() !== wanted.getTime() : actual !== wanted) {
      throw new Error(`Task assignment batch ${label} integrity check failed.`);
    }
  }
}
function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) throw new Error(`Task assignment batch ${label} is invalid.`);
  return value;
}
function requiredDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`Task assignment batch ${label} is invalid.`);
  return value;
}
function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Task assignment batch ${label} is invalid.`);
  return value as number;
}
function requiredHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new Error(`Task assignment batch ${label} is invalid.`);
  }
  return value;
}
function requiredPositiveIntegerText(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)
    || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Task assignment batch ${label} is invalid.`);
  }
  return Number(value);
}
function requiredCanonicalInstant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Task assignment batch timestamp is invalid.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('Task assignment batch timestamp is invalid.');
  return value;
}
function materializationId(source: 'LEGACY_SEED' | 'CARRY_FORWARD', taskInstanceId: string,
  cycleId: string, studentId: string) {
  return `task-assignment-materialization:${sha256({ domain: 'task-assignment-materialization-v1',
    source, taskInstanceId, cycleId, studentId })}`;
}
function uniqueCanonical(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonical);
}
function canonicalEvidence(history: readonly Assignment[]): Assignment[] {
  return [...history].sort((left, right) => compareCanonical(left.task_instance_id, right.task_instance_id)
    || compareCanonical(left.student_id, right.student_id)
    || left.event_sequence - right.event_sequence
    || compareCanonical(left.assignment_id, right.assignment_id));
}
function canonicalCompletions(completions: readonly Completion[]): Completion[] {
  return [...completions].sort((left, right) =>
    compareCanonical(left.task_instance_id ?? '', right.task_instance_id ?? '')
    || left.event_sequence - right.event_sequence
    || compareCanonical(left.completion_id, right.completion_id));
}
function compareCanonical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function key(...parts: string[]): string { return JSON.stringify(parts); }
function nullableTime(value: Date | null): number | null { return value?.getTime() ?? null; }
function snapshot(value: unknown): string { return JSON.stringify(value); }
function sha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
