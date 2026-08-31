import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TaskCycle } from '@/domain/taskRecurrence';
import type { TenantTransaction } from '@/server/db/transaction';
import { createTaskRewardPayloadHash } from './taskCompletionCommands';
import { createCancellationPayloadHash } from './transactionCommands';

const ASSIGNMENT_KEYS = ['assignment_id', 'event_sequence', 'task_id_snapshot',
  'task_instance_id', 'cycle_id', 'cycle_start_at', 'cycle_end_at', 'rule_version',
  'timezone', 'student_id', 'event_type', 'source', 'previous_assignment_id',
  'admin_operation_id', 'admin_operation_hash', 'created_at', 'schema_version', 'note'] as const;
const COMPLETION_KEYS = ['completion_id', 'event_sequence', 'completed_at', 'task_instance_id',
  'task_id_snapshot', 'task_name_snapshot', 'student_id', 'student_name_snapshot',
  'reward_snapshot', 'balance_before', 'balance_after', 'status', 'note', 'cycle_id',
  'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'source', 'assignment_id',
  'transaction_id', 'operation_id', 'operation_hash', 'admin_operation_id',
  'admin_operation_hash', 'schema_version', 'evidence_provider', 'evidence_board_id',
  'evidence_post_id', 'evidence_created_at', 'evidence_author_full_name', 'created_at'] as const;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_REFERENCE_KEYS = ['operation_id', 'operation_kind', 'payload_hash'] as const;
const TRANSACTION_REFERENCE_KEYS = ['transaction_id', 'event_sequence', 'occurred_at', 'student_id',
  'student_name_snapshot', 'kind', 'legacy_total_amount', 'balance_delta', 'balance_before',
  'balance_after', 'operator_snapshot', 'legacy_status_snapshot', 'reverses_transaction_id',
  'operation_id', 'operation_hash', 'schema_version', 'created_at'] as const;

type Assignment = ReturnType<typeof parseAssignment>;
type Completion = ReturnType<typeof parseCompletion>;
type Mirror = ReturnType<typeof parseMirror>;

export type TaskNaturalCycleMaterialization = Readonly<{
  assignmentEventIds: readonly string[];
  completionEventIds: readonly string[];
}>;

/**
 * Opens the current natural cycle inside an existing tenant transaction.
 * The task row is locked here so query and command entry points share the
 * same materialization seam without opening a nested transaction.
 */
export async function materializeTaskNaturalCycleInternal(input: Readonly<{
  tx: TenantTransaction;
  tenantId: string;
  taskId: string;
  taskInstanceId: string;
  taskTitle: string;
  schedule: Readonly<{ ruleVersion: number; effectiveFrom: string;
    recurrence: { type: string }; resetAssignmentOnCycle: boolean;
    resetCompletionOnCycle: boolean }>;
  cycle: TaskCycle;
  isAvailable: boolean;
  now: Date;
}>): Promise<TaskNaturalCycleMaterialization> {
  if (input.schedule.recurrence.type === 'NONE'
    || new Date(input.cycle.startsAt).getTime() === new Date(input.schedule.effectiveFrom).getTime()) {
    return Object.freeze({ assignmentEventIds: Object.freeze([]), completionEventIds: Object.freeze([]) });
  }
  const locked = await input.tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${input.tenantId} AND task_instance_id=${input.taskInstanceId} FOR UPDATE`);
  if (locked.rows.length !== 1 || (locked.rows[0] as Record<string, unknown>).task_instance_id !== input.taskInstanceId
    || (locked.rows[0] as Record<string, unknown>).task_id !== input.taskId) {
    throw new Error('Task natural cycle physical identity integrity check failed.');
  }
  const mirrors = (await input.tx.execute(sql`SELECT student_id FROM task_allowed_students
    WHERE tenant_id=${input.tenantId} AND task_instance_id=${input.taskInstanceId}
    ORDER BY student_id FOR UPDATE`)).rows.map((raw) => id((raw as Record<string, unknown>).student_id));
  const assignmentRows = (await input.tx.execute(sql`SELECT assignment_id,
    event_sequence::text AS event_sequence, cycle_id, cycle_start_at, cycle_end_at,
    rule_version, timezone, student_id, event_type, source
    FROM task_assignments WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId}
    ORDER BY student_id, event_sequence FOR UPDATE`)).rows as Record<string, unknown>[];
  const completionRows = (await input.tx.execute(sql`SELECT completion_id,
    event_sequence::text AS event_sequence, cycle_id, cycle_start_at, cycle_end_at,
    rule_version, timezone, student_id, student_name_snapshot, task_name_snapshot,
    status, source, reward_snapshot::text AS reward_snapshot,
    balance_after::text AS balance_after, assignment_id
    FROM task_completions WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId}
    ORDER BY student_id, event_sequence FOR UPDATE`)).rows as Record<string, unknown>[];
  const start = new Date(input.cycle.startsAt);
  const assignmentEventIds: string[] = [];
  const currentAssignments = new Map<string, Record<string, unknown>>();
  const priorAssignments = new Map<string, Record<string, unknown>>();
  for (const row of assignmentRows) {
    const student = id(row.student_id); const rowStart = date(row.cycle_start_at);
    if (row.cycle_id === input.cycle.cycleId) currentAssignments.set(student, row);
    else if (rowStart < start && date(row.cycle_end_at).getTime() === start.getTime()
      && row.rule_version === input.schedule.ruleVersion) {
      const prior = priorAssignments.get(student);
      if (!prior || date(prior.cycle_start_at) < rowStart
        || (date(prior.cycle_start_at).getTime() === rowStart.getTime()
          && positive(prior.event_sequence) < positive(row.event_sequence))) priorAssignments.set(student, row);
    }
  }
  const carried = new Map<string, { assignmentId: string; predecessor: Record<string, unknown> }>();
  for (const studentId of [...mirrors].sort(compareText)) {
    const current = currentAssignments.get(studentId);
    if (current) {
      if (current.event_type === 'ASSIGNED') carried.set(studentId,
        { assignmentId: id(current.assignment_id), predecessor: current });
      continue;
    }
    const predecessor = priorAssignments.get(studentId);
    if (!input.isAvailable || input.schedule.resetAssignmentOnCycle
      || predecessor?.event_type !== 'ASSIGNED') {
      if (!input.isAvailable || input.schedule.resetAssignmentOnCycle) {
        await input.tx.execute(sql`DELETE FROM task_allowed_students
          WHERE tenant_id=${input.tenantId} AND task_instance_id=${input.taskInstanceId}
            AND student_id=${studentId}`);
      }
      continue;
    }
    const assignmentId = assignmentMaterializationId(input.taskInstanceId, input.cycle.cycleId, studentId);
    const inserted = await input.tx.execute(sql`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note)
      VALUES (${input.tenantId}, ${assignmentId}, ${input.taskId}, ${input.taskInstanceId},
       ${input.cycle.cycleId}, ${start},
       ${input.cycle.endsAt ? new Date(input.cycle.endsAt) : null}, ${input.schedule.ruleVersion},
       'Asia/Seoul', ${studentId}, 'ASSIGNED', 'CARRY_FORWARD',
       ${id(predecessor.assignment_id)}, NULL, NULL, ${input.now}, 1, NULL)
      RETURNING assignment_id`);
    assertOne(inserted.rows, 'assignment_id', assignmentId, 'natural assignment insert');
    assignmentEventIds.push(assignmentId); carried.set(studentId, { assignmentId, predecessor });
  }
  const completionEventIds: string[] = [];
  if (!input.schedule.resetCompletionOnCycle && input.isAvailable) {
    for (const [studentId, assignment] of [...carried].sort(([a], [b]) => compareText(a, b))) {
      if (completionRows.some((row) => row.student_id === studentId
        && row.cycle_id === input.cycle.cycleId)) continue;
      const predecessorCycleId = assignment.predecessor.cycle_id;
      const candidates = completionRows.filter((row) => row.student_id === studentId
        && row.cycle_id === predecessorCycleId
        && row.assignment_id === assignment.predecessor.assignment_id)
        .sort((a, b) => positive(a.event_sequence) - positive(b.event_sequence));
      const predecessor = candidates.at(-1);
      if (!predecessor || predecessor.status !== 'COMPLETED') continue;
      const completionId = completionMaterializationId(input.taskInstanceId,
        input.cycle.cycleId, studentId);
      const balance = integerText(predecessor.balance_after);
      const inserted = await input.tx.execute(sql`INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
         task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
         balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
         rule_version, timezone, source, assignment_id, transaction_id, operation_id,
         operation_hash, admin_operation_id, admin_operation_hash, schema_version,
         evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
         evidence_author_full_name, created_at)
        VALUES (${input.tenantId}, ${completionId}, ${input.now}, ${input.taskInstanceId},
         ${input.taskId}, ${String(predecessor.task_name_snapshot)}, ${studentId},
         ${String(predecessor.student_name_snapshot)}, 0, ${balance}, ${balance}, 'COMPLETED',
         NULL, ${input.cycle.cycleId}, ${start},
         ${input.cycle.endsAt ? new Date(input.cycle.endsAt) : null}, ${input.schedule.ruleVersion},
         'Asia/Seoul', 'CARRY_FORWARD', ${assignment.assignmentId}, NULL, NULL, NULL,
         NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL, ${input.now})
        RETURNING completion_id`);
      assertOne(inserted.rows, 'completion_id', completionId, 'natural completion insert');
      completionEventIds.push(completionId);
    }
  }
  return Object.freeze({ assignmentEventIds: Object.freeze(assignmentEventIds),
    completionEventIds: Object.freeze(completionEventIds) });
}

export type TaskConfigurationBoundaryMaterialization = Readonly<{
  assignmentEventIds: readonly string[];
  completionEventIds: readonly string[];
}>;

export type TaskConfigurationBoundaryMaterializationTarget = Readonly<{
  taskId: string;
  taskInstanceId: string;
  oldCycle: TaskCycle;
  oldRuleVersion: number;
  newCycle: TaskCycle;
  newRuleVersion: number;
  timeZone: 'Asia/Seoul';
  now: Date;
}>;

export type TaskConfigurationBoundaryBatchMaterialization = Readonly<{
  taskId: string;
  taskInstanceId: string;
  assignmentEventIds: readonly string[];
  completionEventIds: readonly string[];
}>;

type PlannedAssignment = Readonly<{ target: TaskConfigurationBoundaryMaterializationTarget;
  studentId: string; assignmentId: string; predecessor: Assignment }>;
type PlannedCompletion = Readonly<{ target: TaskConfigurationBoundaryMaterializationTarget;
  studentId: string; completionId: string; assignmentId: string; predecessor: Completion }>;

/**
 * Set-wise configuration-boundary primitive. The caller owns the transaction and
 * must already hold every target task lock in physical identity order.
 */
export async function materializeTaskConfigurationBoundaryCyclesInternal(input: Readonly<{
  tx: TenantTransaction;
  tenantId: string;
  targets: readonly TaskConfigurationBoundaryMaterializationTarget[];
}>): Promise<readonly TaskConfigurationBoundaryBatchMaterialization[]> {
  const targets = exactArray(input.targets, 'batch target list') as
    TaskConfigurationBoundaryMaterializationTarget[];
  if (targets.length < 1 || targets.length > 20) {
    throw new Error('Task cycle materialization batch target count must be 1-20.');
  }
  const byInstance = new Map<string, TaskConfigurationBoundaryMaterializationTarget>();
  const taskIds = new Set<string>();
  for (const target of targets) {
    if (typeof target !== 'object' || target === null || Object.getPrototypeOf(target) !== Object.prototype
      || id(target.taskId) !== target.taskId || id(target.taskInstanceId) !== target.taskInstanceId
      || byInstance.has(target.taskInstanceId) || taskIds.has(target.taskId)) {
      throw new Error('Task cycle materialization batch target integrity check failed.');
    }
    byInstance.set(target.taskInstanceId, target); taskIds.add(target.taskId);
  }
  const instances = [...byInstance.keys()].sort(compareText);
  const mirrorResult = await input.tx.execute(sql`SELECT task_instance_id, student_id, created_at
    FROM task_allowed_students WHERE tenant_id=${input.tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id, student_id FOR UPDATE`);
  const assignmentResult = await input.tx.execute(sql`SELECT assignment_id,
    event_sequence::text AS event_sequence, task_id_snapshot, task_instance_id, cycle_id,
    cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
    previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
    schema_version, note FROM task_assignments WHERE tenant_id=${input.tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id, student_id, event_sequence FOR UPDATE`);
  const completionResult = await input.tx.execute(sql`SELECT completion_id,
    event_sequence::text AS event_sequence, completed_at, task_instance_id, task_id_snapshot,
    task_name_snapshot, student_id, student_name_snapshot,
    reward_snapshot::text AS reward_snapshot, balance_before::text AS balance_before,
    balance_after::text AS balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
    rule_version, timezone, source, assignment_id, transaction_id, operation_id, operation_hash,
    admin_operation_id, admin_operation_hash, schema_version, evidence_provider,
    evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
    FROM task_completions WHERE tenant_id=${input.tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id, event_sequence FOR UPDATE`);
  const mirrors = exactArray(mirrorResult.rows, 'batch mirror result').map(parseMirror);
  const assignments = exactArray(assignmentResult.rows, 'batch assignment result').map(parseAssignment);
  const completions = exactArray(completionResult.rows, 'batch completion result').map(parseCompletion);
  const mirrorBuckets = bucketByTarget(mirrors, byInstance, 'mirror');
  const assignmentBuckets = bucketByTarget(assignments, byInstance, 'assignment');
  const completionBuckets = bucketByTarget(completions, byInstance, 'completion');

  const transactionRoots = [...new Set(completions.map((event) => event.transaction_id)
    .filter((value): value is string => value !== null))].sort(compareText);
  let transactionReferences: unknown[] = [];
  if (transactionRoots.length > 0) {
    const result = await input.tx.execute(sql`SELECT transaction_id,
      event_sequence::text AS event_sequence, occurred_at, student_id, student_name_snapshot,
      kind, legacy_total_amount::text AS legacy_total_amount, balance_delta::text AS balance_delta,
      balance_before::text AS balance_before, balance_after::text AS balance_after,
      operator_snapshot, legacy_status_snapshot, reverses_transaction_id, operation_id,
      operation_hash, schema_version, created_at FROM transactions WHERE tenant_id=${input.tenantId}
      AND transaction_id IN (WITH RECURSIVE captured(transaction_id) AS
        (VALUES ${sql.join(transactionRoots.map((value) => sql`(${value})`), sql`, `)} UNION
         SELECT candidate.transaction_id FROM captured
         JOIN transactions source ON source.tenant_id=${input.tenantId}
           AND source.transaction_id=captured.transaction_id
         JOIN transactions candidate ON candidate.tenant_id=${input.tenantId}
           AND (candidate.transaction_id=source.reverses_transaction_id
             OR candidate.reverses_transaction_id=source.transaction_id))
        SELECT transaction_id FROM captured) ORDER BY transaction_id`);
    transactionReferences = exactArray(result.rows, 'batch transaction reference result');
  }
  const operationIds = [...new Set(completions.flatMap((event) =>
    [event.operation_id, event.admin_operation_id].filter((value): value is string => value !== null)))]
    .sort(compareText);
  let operationReferences: unknown[] = [];
  if (operationIds.length > 0) {
    const result = await input.tx.execute(sql`SELECT operation_id, operation_kind, payload_hash
      FROM operations WHERE tenant_id=${input.tenantId}
      AND operation_id IN (${sql.join(operationIds.map((value) => sql`${value}`), sql`, `)})
      ORDER BY operation_id`);
    operationReferences = exactArray(result.rows, 'batch operation reference result');
  }

  const assignmentPlans: PlannedAssignment[] = [];
  const completionPlans: PlannedCompletion[] = [];
  const state = new Map<string, { oldAssignments: Map<string, Assignment>;
    oldCompletions: Map<string, Completion>; carried: Map<string, string> }>();
  for (const target of targets) {
    const targetAssignments = assignmentBuckets.get(target.taskInstanceId) ?? [];
    const targetCompletions = completionBuckets.get(target.taskInstanceId) ?? [];
    const referenceTx = cachedReferenceTransaction(input.tx, targetCompletions,
      transactionReferences, operationReferences);
    await validateEvidence({ ...target, tx: referenceTx, tenantId: input.tenantId },
      mirrorBuckets.get(target.taskInstanceId) ?? [], targetAssignments, targetCompletions);
    const oldAssignments = latestBySubject(targetAssignments.filter((event) =>
      inOldCycle({ ...target, tx: referenceTx, tenantId: input.tenantId }, event)));
    const oldCompletions = latestBySubject(targetCompletions.filter((event) =>
      inOldCycle({ ...target, tx: referenceTx, tenantId: input.tenantId }, event)));
    const carried = new Map<string, string>();
    const students = new Set((mirrorBuckets.get(target.taskInstanceId) ?? [])
      .map((mirror) => mirror.student_id));
    for (const studentId of [...students].sort(compareText)) {
      const predecessor = oldAssignments.get(studentId);
      if (!predecessor || predecessor.event_type !== 'ASSIGNED') continue;
      const assignmentId = assignmentMaterializationId(target.taskInstanceId,
        target.newCycle.cycleId, studentId);
      assignmentPlans.push({ target, studentId, assignmentId, predecessor });
      carried.set(studentId, assignmentId);
      const completion = oldCompletions.get(studentId);
      if (completion?.status === 'COMPLETED'
        && completion.assignment_id === predecessor.assignment_id) {
        completionPlans.push({ target, studentId, assignmentId, predecessor: completion,
          completionId: completionMaterializationId(target.taskInstanceId,
            target.newCycle.cycleId, studentId) });
      }
    }
    state.set(target.taskInstanceId, { oldAssignments, oldCompletions, carried });
  }

  const assignmentReturning = assignmentPlans.length === 0
    ? await input.tx.execute(sql`SELECT NULL::text AS assignment_id,
        NULL::text AS task_instance_id WHERE FALSE`)
    : await input.tx.execute(sql`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note)
      VALUES ${sql.join(assignmentPlans.map((plan) => sql`(${input.tenantId},
       ${plan.assignmentId}, ${plan.target.taskId}, ${plan.target.taskInstanceId},
       ${plan.target.newCycle.cycleId}, ${new Date(plan.target.newCycle.startsAt)},
       ${plan.target.newCycle.endsAt ? new Date(plan.target.newCycle.endsAt) : null},
       ${plan.target.newRuleVersion}, ${plan.target.timeZone}, ${plan.studentId},
       'ASSIGNED', 'CARRY_FORWARD', ${plan.predecessor.assignment_id}, NULL, NULL,
       ${plan.target.now}, 1, NULL)`), sql`, `)}
      ON CONFLICT (tenant_id, assignment_id) DO NOTHING
      RETURNING assignment_id, task_instance_id`);
  assertReturningSet(assignmentReturning.rows, 'assignment_id', assignmentPlans.map((plan) =>
    ({ id: plan.assignmentId, taskInstanceId: plan.target.taskInstanceId })), 'assignment insert');

  const completionReturning = completionPlans.length === 0
    ? await input.tx.execute(sql`SELECT NULL::text AS completion_id,
        NULL::text AS task_instance_id WHERE FALSE`)
    : await input.tx.execute(sql`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, transaction_id, operation_id,
       operation_hash, admin_operation_id, admin_operation_hash, schema_version,
       evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
       evidence_author_full_name, created_at)
      VALUES ${sql.join(completionPlans.map((plan) => sql`(${input.tenantId},
       ${plan.completionId}, ${plan.target.now}, ${plan.target.taskInstanceId},
       ${plan.target.taskId}, ${plan.predecessor.task_name_snapshot}, ${plan.studentId},
       ${plan.predecessor.student_name_snapshot}, 0, ${plan.predecessor.balance_after},
       ${plan.predecessor.balance_after}, 'COMPLETED', NULL, ${plan.target.newCycle.cycleId},
       ${new Date(plan.target.newCycle.startsAt)},
       ${plan.target.newCycle.endsAt ? new Date(plan.target.newCycle.endsAt) : null},
       ${plan.target.newRuleVersion}, ${plan.target.timeZone}, 'CARRY_FORWARD',
       ${plan.assignmentId}, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL,
       NULL, NULL, ${plan.target.now})`), sql`, `)}
      ON CONFLICT (tenant_id, completion_id) DO NOTHING
      RETURNING completion_id, task_instance_id`);
  assertReturningSet(completionReturning.rows, 'completion_id', completionPlans.map((plan) =>
    ({ id: plan.completionId, taskInstanceId: plan.target.taskInstanceId })), 'completion insert');

  await verifyBatchMaterialized(input.tx, input.tenantId, targets, assignmentPlans, completionPlans,
    state);
  const assignmentByTarget = bucketPlans(assignmentPlans, (plan) => plan.assignmentId);
  const completionByTarget = bucketPlans(completionPlans, (plan) => plan.completionId);
  return Object.freeze(targets.map((target) => Object.freeze({ taskId: target.taskId,
    taskInstanceId: target.taskInstanceId,
    assignmentEventIds: Object.freeze(assignmentByTarget.get(target.taskInstanceId) ?? []),
    completionEventIds: Object.freeze(completionByTarget.get(target.taskInstanceId) ?? []) })));
}

/** Internal command primitive. The caller must hold the task row lock first. */
export async function materializeTaskConfigurationBoundaryCycleInternal(input: Readonly<{
  tx: TenantTransaction;
  tenantId: string;
  taskId: string;
  taskInstanceId: string;
  oldCycle: TaskCycle;
  oldRuleVersion: number;
  newCycle: TaskCycle;
  newRuleVersion: number;
  timeZone: 'Asia/Seoul';
  now: Date;
}>): Promise<TaskConfigurationBoundaryMaterialization> {
  const mirrors = (await input.tx.execute(sql`SELECT task_instance_id, student_id, created_at
    FROM task_allowed_students WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId}
    ORDER BY student_id FOR UPDATE`)).rows.map(parseMirror);
  const assignmentResult = await input.tx.execute(sql`SELECT assignment_id,
    event_sequence::text AS event_sequence, task_id_snapshot, task_instance_id, cycle_id,
    cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
    previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
    schema_version, note FROM task_assignments WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId}
    ORDER BY student_id, event_sequence FOR UPDATE`);
  const assignments = exactArray(assignmentResult.rows, 'assignment result').map(parseAssignment);
  const completionResult = await input.tx.execute(sql`SELECT completion_id,
    event_sequence::text AS event_sequence, completed_at, task_instance_id, task_id_snapshot,
    task_name_snapshot, student_id, student_name_snapshot,
    reward_snapshot::text AS reward_snapshot, balance_before::text AS balance_before,
    balance_after::text AS balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
    rule_version, timezone, source, assignment_id, transaction_id, operation_id, operation_hash,
    admin_operation_id, admin_operation_hash, schema_version, evidence_provider,
    evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
    FROM task_completions WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId}
    ORDER BY event_sequence FOR UPDATE`);
  const completions = exactArray(completionResult.rows, 'completion result').map(parseCompletion);

  await validateEvidence(input, mirrors, assignments, completions);
  const oldAssignments = latestBySubject(assignments.filter((event) => inOldCycle(input, event)));
  const oldCompletions = latestBySubject(completions.filter((event) => inOldCycle(input, event)));
  const mirrorIds = new Set(mirrors.map((mirror) => mirror.student_id));
  const assignmentEventIds: string[] = [];
  const carriedAssignmentByStudent = new Map<string, string>();

  for (const studentId of [...mirrorIds].sort(compareText)) {
    const predecessor = oldAssignments.get(studentId);
    if (!predecessor || predecessor.event_type !== 'ASSIGNED') {
      continue;
    }
    const assignmentId = assignmentMaterializationId(input.taskInstanceId,
      input.newCycle.cycleId, studentId);
    const inserted = await input.tx.execute(sql`INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type,
       source, previous_assignment_id, admin_operation_id, admin_operation_hash,
       created_at, schema_version, note)
      VALUES (${input.tenantId}, ${assignmentId}, ${input.taskId}, ${input.taskInstanceId},
       ${input.newCycle.cycleId}, ${new Date(input.newCycle.startsAt)},
       ${input.newCycle.endsAt ? new Date(input.newCycle.endsAt) : null}, ${input.newRuleVersion},
       ${input.timeZone}, ${studentId}, 'ASSIGNED', 'CARRY_FORWARD',
       ${predecessor.assignment_id}, NULL, NULL, ${input.now}, 1, NULL)
      ON CONFLICT (tenant_id, assignment_id) DO NOTHING RETURNING assignment_id`);
    assertOne(inserted.rows, 'assignment_id', assignmentId, 'assignment insert');
    assignmentEventIds.push(assignmentId);
    carriedAssignmentByStudent.set(studentId, assignmentId);
  }

  const completionEventIds: string[] = [];
  for (const [studentId, predecessor] of [...oldCompletions].sort(([left], [right]) =>
    compareText(left, right))) {
    if (predecessor.status !== 'COMPLETED') continue;
    const assignmentId = carriedAssignmentByStudent.get(studentId);
    if (!assignmentId) continue;
    const completionId = completionMaterializationId(input.taskInstanceId,
      input.newCycle.cycleId, studentId);
    const inserted = await input.tx.execute(sql`INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
       task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
       balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, source, assignment_id, transaction_id, operation_id,
       operation_hash, admin_operation_id, admin_operation_hash, schema_version,
       evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
       evidence_author_full_name, created_at)
      VALUES (${input.tenantId}, ${completionId}, ${input.now}, ${input.taskInstanceId},
       ${input.taskId}, ${predecessor.task_name_snapshot}, ${studentId},
       ${predecessor.student_name_snapshot}, 0, ${predecessor.balance_after},
       ${predecessor.balance_after}, 'COMPLETED', NULL, ${input.newCycle.cycleId},
       ${new Date(input.newCycle.startsAt)},
       ${input.newCycle.endsAt ? new Date(input.newCycle.endsAt) : null},
       ${input.newRuleVersion}, ${input.timeZone}, 'CARRY_FORWARD', ${assignmentId},
       NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL, ${input.now})
      ON CONFLICT (tenant_id, completion_id) DO NOTHING RETURNING completion_id`);
    assertOne(inserted.rows, 'completion_id', completionId, 'completion insert');
    completionEventIds.push(completionId);
  }

  await verifyMaterialized(input, assignmentEventIds, completionEventIds,
    carriedAssignmentByStudent, oldAssignments, oldCompletions);
  return Object.freeze({ assignmentEventIds: Object.freeze(assignmentEventIds),
    completionEventIds: Object.freeze(completionEventIds) });
}

function bucketByTarget<T extends { task_instance_id: string }>(rows: readonly T[],
  targets: ReadonlyMap<string, TaskConfigurationBoundaryMaterializationTarget>, label: string) {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    if (!targets.has(row.task_instance_id)) {
      throw new Error(`Task cycle materialization batch ${label} membership integrity check failed.`);
    }
    const bucket = buckets.get(row.task_instance_id) ?? [];
    bucket.push(row); buckets.set(row.task_instance_id, bucket);
  }
  return buckets;
}

function cachedReferenceTransaction(base: TenantTransaction, completions: readonly Completion[],
  transactionRows: readonly unknown[], operationRows: readonly unknown[]): TenantTransaction {
  const roots = new Set(completions.map((event) => event.transaction_id)
    .filter((value): value is string => value !== null));
  const parsedTransactions = transactionRows.map((raw) => ({ raw, row: parseTransactionReference(raw) }));
  const byTransactionId = new Map(parsedTransactions.map((item) => [item.row.transaction_id, item]));
  const reachable = new Set<string>(); const pending = [...roots];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    const item = byTransactionId.get(current);
    if (!item) continue;
    reachable.add(current);
    if (item.row.reverses_transaction_id !== null) pending.push(item.row.reverses_transaction_id);
    for (const candidate of parsedTransactions) {
      if (candidate.row.reverses_transaction_id === current) pending.push(candidate.row.transaction_id);
    }
  }
  const targetTransactions = parsedTransactions.filter((item) => reachable.has(item.row.transaction_id));
  const operationIds = new Set(completions.flatMap((event) =>
    [event.operation_id, event.admin_operation_id].filter((value): value is string => value !== null)));
  for (const item of targetTransactions) if (item.row.operation_id !== null) {
    operationIds.add(item.row.operation_id);
  }
  const targetOperations = operationRows.filter((raw) => {
    const row = exactRow(raw, OPERATION_REFERENCE_KEYS, 'operation reference evidence');
    return operationIds.has(id(row.operation_id));
  });
  let call = 0;
  return { ...base, execute: async () => {
    if (roots.size > 0 && call++ === 0) return { rows: targetTransactions.map((item) => item.raw) } as never;
    if (operationIds.size > 0) return { rows: targetOperations } as never;
    throw new Error('Task cycle materialization unexpected cached reference query.');
  } } as unknown as TenantTransaction;
}

function assertReturningSet(rows: unknown, identityKey: 'assignment_id' | 'completion_id',
  expected: readonly Readonly<{ id: string; taskInstanceId: string }>[], label: string) {
  const parsed = exactArray(rows, `${label} result`).map((raw) => {
    const row = exactRow(raw, [identityKey, 'task_instance_id'], label);
    return { id: id(row[identityKey]), taskInstanceId: id(row.task_instance_id) };
  });
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  if (expectedById.size !== expected.length || parsed.length !== expected.length) {
    throw new Error(`Task cycle materialization ${label} integrity check failed.`);
  }
  for (const item of parsed) {
    if (expectedById.get(item.id)?.taskInstanceId !== item.taskInstanceId) {
      throw new Error(`Task cycle materialization ${label} integrity check failed.`);
    }
    expectedById.delete(item.id);
  }
  if (expectedById.size) throw new Error(`Task cycle materialization ${label} integrity check failed.`);
}

function bucketPlans<T extends { target: TaskConfigurationBoundaryMaterializationTarget }>(
  plans: readonly T[], identity: (plan: T) => string) {
  const buckets = new Map<string, string[]>();
  for (const plan of plans) {
    const bucket = buckets.get(plan.target.taskInstanceId) ?? [];
    bucket.push(identity(plan)); buckets.set(plan.target.taskInstanceId, bucket);
  }
  for (const bucket of buckets.values()) bucket.sort(compareText);
  return buckets;
}

async function verifyBatchMaterialized(tx: TenantTransaction, tenantId: string,
  targets: readonly TaskConfigurationBoundaryMaterializationTarget[],
  assignmentPlans: readonly PlannedAssignment[], completionPlans: readonly PlannedCompletion[],
  state: ReadonlyMap<string, { oldAssignments: Map<string, Assignment>;
    oldCompletions: Map<string, Completion>; carried: Map<string, string> }>) {
  const pairs = targets.map((target) => sql`(${target.taskInstanceId}, ${target.newCycle.cycleId})`);
  const assignmentResult = await tx.execute(sql`SELECT assignment_id,
    event_sequence::text AS event_sequence, task_id_snapshot, task_instance_id, cycle_id,
    cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
    previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
    schema_version, note FROM task_assignments WHERE tenant_id=${tenantId}
      AND (task_instance_id, cycle_id) IN (${sql.join(pairs, sql`, `)})
      ORDER BY task_instance_id, student_id, event_sequence`);
  const assignments = exactArray(assignmentResult.rows, 'batch assignment verification result')
    .map(parseAssignment);
  const assignmentById = new Map(assignmentPlans.map((plan) => [plan.assignmentId, plan]));
  if (assignmentById.size !== assignmentPlans.length || assignments.length !== assignmentPlans.length) {
    throw new Error('Task cycle materialization assignment set integrity check failed.');
  }
  for (const event of assignments) {
    const plan = assignmentById.get(event.assignment_id);
    const targetState = state.get(event.task_instance_id);
    if (!plan || !targetState || event.task_instance_id !== plan.target.taskInstanceId
      || event.task_id_snapshot !== plan.target.taskId || event.cycle_id !== plan.target.newCycle.cycleId
      || event.source !== 'CARRY_FORWARD' || event.event_type !== 'ASSIGNED'
      || event.previous_assignment_id !== plan.predecessor.assignment_id
      || targetState.oldAssignments.get(event.student_id) !== plan.predecessor
      || event.rule_version !== plan.target.newRuleVersion
      || event.created_at.getTime() !== plan.target.now.getTime()) {
      throw new Error('Task cycle materialization assignment set integrity check failed.');
    }
    assignmentById.delete(event.assignment_id);
  }
  if (assignmentById.size) throw new Error('Task cycle materialization assignment set integrity check failed.');

  const completionResult = await tx.execute(sql`SELECT completion_id,
    event_sequence::text AS event_sequence, completed_at, task_instance_id, task_id_snapshot,
    task_name_snapshot, student_id, student_name_snapshot,
    reward_snapshot::text AS reward_snapshot, balance_before::text AS balance_before,
    balance_after::text AS balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
    rule_version, timezone, source, assignment_id, transaction_id, operation_id, operation_hash,
    admin_operation_id, admin_operation_hash, schema_version, evidence_provider,
    evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
    FROM task_completions WHERE tenant_id=${tenantId}
      AND (task_instance_id, cycle_id) IN (${sql.join(pairs, sql`, `)})
      ORDER BY task_instance_id, event_sequence`);
  const completions = exactArray(completionResult.rows, 'batch completion verification result')
    .map(parseCompletion);
  const completionById = new Map(completionPlans.map((plan) => [plan.completionId, plan]));
  if (completionById.size !== completionPlans.length || completions.length !== completionPlans.length) {
    throw new Error('Task cycle materialization completion set integrity check failed.');
  }
  for (const event of completions) {
    const plan = completionById.get(event.completion_id);
    const targetState = state.get(event.task_instance_id);
    if (!plan || !targetState || event.task_instance_id !== plan.target.taskInstanceId
      || event.task_id_snapshot !== plan.target.taskId || event.cycle_id !== plan.target.newCycle.cycleId
      || event.source !== 'CARRY_FORWARD' || event.status !== 'COMPLETED'
      || event.reward_snapshot !== 0 || event.balance_before !== plan.predecessor.balance_after
      || event.balance_after !== plan.predecessor.balance_after
      || event.assignment_id !== plan.assignmentId
      || targetState.oldCompletions.get(event.student_id) !== plan.predecessor
      || targetState.carried.get(event.student_id) !== plan.assignmentId
      || event.transaction_id !== null || event.operation_id !== null
      || event.admin_operation_id !== null || event.rule_version !== plan.target.newRuleVersion
      || event.completed_at.getTime() !== plan.target.now.getTime()) {
      throw new Error('Task cycle materialization completion set integrity check failed.');
    }
    completionById.delete(event.completion_id);
  }
  if (completionById.size) throw new Error('Task cycle materialization completion set integrity check failed.');
}

async function validateEvidence(input: Parameters<typeof materializeTaskConfigurationBoundaryCycleInternal>[0],
  mirrors: readonly Mirror[], assignments: readonly Assignment[], completions: readonly Completion[]) {
  if (input.newRuleVersion !== input.oldRuleVersion + 1
    || input.newCycle.cycleId === input.oldCycle.cycleId
    || input.newCycle.startsAt !== input.now.toISOString().replace('.000Z', 'Z')) {
    throw new Error('Task cycle materialization configuration boundary integrity check failed.');
  }
  const mirrorIds = new Set<string>();
  for (const mirror of mirrors) {
    if (mirror.task_instance_id !== input.taskInstanceId || mirrorIds.has(mirror.student_id)) {
      throw new Error('Task cycle materialization mirror evidence integrity check failed.');
    }
    mirrorIds.add(mirror.student_id);
  }
  const assignmentIds = new Set<string>(); const assignmentSequences = new Set<number>();
  for (const event of assignments) {
    if (event.task_instance_id !== input.taskInstanceId || event.task_id_snapshot !== input.taskId
      || event.timezone !== input.timeZone || event.cycle_id !== cycleId(event)
      || event.rule_version < 1 || event.created_at.getTime() > input.now.getTime()
      || event.cycle_start_at.getTime() > event.created_at.getTime()
      || (event.cycle_end_at !== null && (event.cycle_end_at <= event.cycle_start_at
        || event.created_at >= event.cycle_end_at))
      || assignmentIds.has(event.assignment_id) || assignmentSequences.has(event.event_sequence)) {
      throw new Error('Task cycle materialization assignment evidence integrity check failed.');
    }
    assignmentIds.add(event.assignment_id); assignmentSequences.add(event.event_sequence);
  }
  validateAssignmentChains(assignments, input.now);
  await validateCompletionHistory(input, completions, assignments);
}

function validateAssignmentChains(assignments: readonly Assignment[], now: Date) {
  const failure = 'Task cycle materialization assignment evidence integrity check failed.';
  const ordered = [...assignments].sort((left, right) => left.event_sequence - right.event_sequence);
  const byId = new Map(ordered.map((event) => [event.assignment_id, event]));
  const local = new Map<string, Assignment[]>();
  const bySubject = new Map<string, Assignment[]>();
  for (const event of ordered) {
    const localKey = JSON.stringify([event.task_instance_id, event.task_id_snapshot,
      event.student_id, event.cycle_id, event.cycle_start_at.getTime(),
      nullableTime(event.cycle_end_at), event.rule_version, event.timezone]);
    const subjectKey = JSON.stringify([event.task_instance_id, event.task_id_snapshot, event.student_id]);
    local.set(localKey, [...(local.get(localKey) ?? []), event]);
    bySubject.set(subjectKey, [...(bySubject.get(subjectKey) ?? []), event]);
  }
  const immediatePrior = new Map<string, Assignment>();
  for (const chain of bySubject.values()) chain.forEach((event, index) => {
    if (index > 0) immediatePrior.set(event.assignment_id, chain[index - 1]);
  });
  for (const chain of local.values()) chain.forEach((event, index) => {
    const priorLocal = index > 0 ? chain[index - 1] : undefined;
    if (event.source === 'LEGACY_SEED') {
      if (event.event_type !== 'ASSIGNED' || event.previous_assignment_id !== null) {
        throw new Error(failure);
      }
      return;
    }
    if (event.source === 'ADMIN' || event.source === 'QR') {
      if (event.previous_assignment_id !== (priorLocal?.assignment_id ?? null)
        || (!priorLocal && event.event_type !== 'ASSIGNED')
        || (priorLocal && priorLocal.created_at > event.created_at)) throw new Error(failure);
      return;
    }
    const predecessor = event.previous_assignment_id === null
      ? undefined : byId.get(event.previous_assignment_id);
    const immediate = immediatePrior.get(event.assignment_id);
    const overlapIsConfigurationBoundary = predecessor !== undefined
      && predecessor.cycle_end_at !== null && predecessor.cycle_end_at > event.cycle_start_at
      && event.created_at.getTime() === event.cycle_start_at.getTime()
      && event.created_at.getTime() <= now.getTime();
    if (event.event_type !== 'ASSIGNED' || !predecessor || predecessor !== immediate
      || predecessor.event_type !== 'ASSIGNED'
      || predecessor.task_instance_id !== event.task_instance_id
      || predecessor.task_id_snapshot !== event.task_id_snapshot
      || predecessor.student_id !== event.student_id
      || predecessor.rule_version >= event.rule_version
      || predecessor.cycle_start_at >= event.cycle_start_at
      || predecessor.created_at > event.created_at
      || predecessor.cycle_end_at === null
      || (predecessor.cycle_end_at > event.cycle_start_at && !overlapIsConfigurationBoundary)) {
      throw new Error(failure);
    }
  });
}

async function validateCompletionHistory(
  input: Parameters<typeof materializeTaskConfigurationBoundaryCycleInternal>[0],
  completions: readonly Completion[], assignments: readonly Assignment[],
) {
  const failure = 'Task cycle materialization completion evidence integrity check failed.';
  const ordered = [...completions].sort((left, right) => left.event_sequence - right.event_sequence);
  const assignmentById = new Map(assignments.map((event) => [event.assignment_id, event]));
  const completionIds = new Set<string>(); const sequences = new Set<number>();
  const operations = new Map<string, { kind: 'TASK_REWARD' | 'TASK_ADMIN' | 'CANCELLATION'; hash: string }>();
  const transactionIds = new Set<string>();
  const priorBySubject = new Map<string, Completion>();
  for (const event of ordered) {
    const assignment = event.assignment_id === null ? undefined : assignmentById.get(event.assignment_id);
    const prior = priorBySubject.get(event.student_id);
    const operationPair = event.operation_id !== null && event.operation_hash !== null;
    const adminPair = event.admin_operation_id !== null && event.admin_operation_hash !== null;
    const evidence = [event.evidence_provider, event.evidence_board_id, event.evidence_post_id,
      event.evidence_created_at, event.evidence_author_full_name];
    const evidenceCount = evidence.filter((value) => value !== null).length;
    if (event.task_instance_id !== input.taskInstanceId || event.task_id_snapshot !== input.taskId
      || event.timezone !== input.timeZone || event.cycle_id !== cycleId(event)
      || event.rule_version < 1 || event.completed_at > event.created_at
      || event.completed_at < event.cycle_start_at || event.created_at > input.now
      || (event.cycle_end_at !== null && (event.cycle_end_at <= event.cycle_start_at
        || event.completed_at >= event.cycle_end_at))
      || completionIds.has(event.completion_id) || sequences.has(event.event_sequence)
      || assignment === undefined || assignment.event_type !== 'ASSIGNED'
      || assignment.task_instance_id !== event.task_instance_id
      || assignment.task_id_snapshot !== event.task_id_snapshot
      || assignment.student_id !== event.student_id || assignment.cycle_id !== event.cycle_id
      || assignment.cycle_start_at.getTime() !== event.cycle_start_at.getTime()
      || nullableTime(assignment.cycle_end_at) !== nullableTime(event.cycle_end_at)
      || assignment.rule_version !== event.rule_version || assignment.timezone !== event.timezone
      || (prior !== undefined && (prior.completed_at > event.completed_at
        || prior.created_at > event.created_at))
      || (evidenceCount !== 0 && (evidenceCount !== evidence.length || event.source !== 'BANK'
        || event.evidence_provider !== 'PADLET' || event.evidence_board_id === null
        || !/^[A-Za-z0-9]{16,22}$/.test(event.evidence_board_id)
        || event.evidence_post_id === null || !/^[A-Za-z0-9_-]{3,128}$/.test(event.evidence_post_id)
        || event.evidence_author_full_name === null
        || event.evidence_author_full_name !== event.evidence_author_full_name.trim()
        || event.evidence_author_full_name.length < 1 || event.evidence_author_full_name.length > 200
        || event.evidence_author_full_name !== event.student_name_snapshot
        || event.evidence_created_at === null || event.evidence_created_at < event.cycle_start_at
        || (event.cycle_end_at !== null && event.evidence_created_at >= event.cycle_end_at)
        || event.evidence_created_at > event.completed_at))) {
      throw new Error(failure);
    }
    if (event.source === 'BANK') {
      let semanticHash: string;
      try {
        semanticHash = createTaskRewardPayloadHash({ taskId: event.task_id_snapshot,
          taskInstanceId: event.task_instance_id, taskTitle: event.task_name_snapshot,
          studentId: event.student_id, studentName: event.student_name_snapshot,
          assignmentId: event.assignment_id!, cycleId: event.cycle_id,
          cycleStartsAt: event.cycle_start_at.toISOString(),
          cycleEndsAt: event.cycle_end_at?.toISOString() ?? null, reward: event.reward_snapshot,
          ...(evidenceCount === evidence.length && evidenceCount > 0 ? { evidence: {
            evidenceProvider: event.evidence_provider as 'PADLET',
            evidenceBoardId: event.evidence_board_id!, evidencePostId: event.evidence_post_id!,
            evidenceCreatedAt: event.evidence_created_at!.toISOString(),
            evidenceAuthorFullName: event.evidence_author_full_name!,
          } } : {}) });
      } catch { throw new Error(failure); }
      if (event.status !== 'COMPLETED' || event.reward_snapshot <= 0
        || event.balance_after !== event.balance_before + event.reward_snapshot
        || !operationPair || adminPair || event.transaction_id === null
        || event.note !== 'bank-self-completion'
        || event.operation_hash !== semanticHash
        || event.completion_id !== `task-completion:${event.operation_id}`
        || event.transaction_id !== `task-reward:${event.operation_id}`) throw new Error(failure);
      addExpectedOperation(operations, event.operation_id!, 'TASK_REWARD', event.operation_hash!, failure);
      transactionIds.add(event.transaction_id);
    } else if (event.source === 'ADMIN') {
      if (event.status !== 'COMPLETED' || event.reward_snapshot !== 0
        || event.balance_before !== event.balance_after || operationPair || !adminPair
        || event.transaction_id !== null) throw new Error(failure);
      addExpectedOperation(operations, event.admin_operation_id!, 'TASK_ADMIN',
        event.admin_operation_hash!, failure);
    } else if (event.source === 'CARRY_FORWARD') {
      const assignmentPredecessor = assignment.previous_assignment_id === null
        ? undefined : assignmentById.get(assignment.previous_assignment_id);
      const retainedFirst = prior === undefined && assignment.source === 'CARRY_FORWARD'
        && assignmentPredecessor !== undefined && assignmentPredecessor.event_type === 'ASSIGNED'
        && assignmentPredecessor.task_instance_id === event.task_instance_id
        && assignmentPredecessor.task_id_snapshot === event.task_id_snapshot
        && assignmentPredecessor.student_id === event.student_id
        && assignmentPredecessor.cycle_start_at < event.cycle_start_at;
      if (event.status !== 'COMPLETED' || event.reward_snapshot !== 0
        || event.balance_before !== event.balance_after || operationPair || adminPair
        || event.transaction_id !== null
        || (!retainedFirst && (prior === undefined || prior.status !== 'COMPLETED'
          || assignment.previous_assignment_id !== prior.assignment_id
          || prior.balance_after !== event.balance_before
          || prior.cycle_start_at >= event.cycle_start_at))) throw new Error(failure);
    } else {
      const cancellation = operationPair && !adminPair && event.transaction_id !== null
        && event.reward_snapshot > 0 && event.balance_after === event.balance_before - event.reward_snapshot;
      const administrator = !operationPair && adminPair && event.transaction_id === null
        && event.reward_snapshot === 0 && event.balance_before === event.balance_after;
      if (event.status !== 'CANCELLED' || cancellation === administrator) throw new Error(failure);
      if (cancellation) {
        if (event.completion_id !== `task-completion-cancellation:${event.operation_id}`
          || event.transaction_id !== `cancellation:${event.operation_id}`) throw new Error(failure);
        addExpectedOperation(operations, event.operation_id!, 'CANCELLATION', event.operation_hash!, failure);
        transactionIds.add(event.transaction_id!);
      } else {
        if (event.note !== 'admin-completion-reset'
          || event.completion_id !== adminResetCompletionId(event.admin_operation_id!,
            event.task_instance_id, event.student_id, event.cycle_id)) throw new Error(failure);
        addExpectedOperation(operations, event.admin_operation_id!, 'TASK_ADMIN',
          event.admin_operation_hash!, failure);
      }
    }
    priorBySubject.set(event.student_id, event);
    completionIds.add(event.completion_id); sequences.add(event.event_sequence);
  }
  if (transactionIds.size > 0) {
    const ids = [...transactionIds].sort(compareText);
    const result = await input.tx.execute(sql`SELECT transaction_id,
      event_sequence::text AS event_sequence, occurred_at, student_id, student_name_snapshot,
      kind, legacy_total_amount::text AS legacy_total_amount, balance_delta::text AS balance_delta,
      balance_before::text AS balance_before, balance_after::text AS balance_after,
      operator_snapshot, legacy_status_snapshot, reverses_transaction_id, operation_id,
      operation_hash, schema_version, created_at FROM transactions WHERE tenant_id=${input.tenantId}
      AND transaction_id IN (WITH RECURSIVE captured(transaction_id) AS
        (VALUES ${sql.join(ids.map((value) => sql`(${value})`), sql`, `)} UNION
         SELECT candidate.transaction_id FROM captured
         JOIN transactions source ON source.tenant_id=${input.tenantId}
           AND source.transaction_id=captured.transaction_id
         JOIN transactions candidate ON candidate.tenant_id=${input.tenantId}
           AND (candidate.transaction_id=source.reverses_transaction_id
             OR candidate.reverses_transaction_id=source.transaction_id))
        SELECT transaction_id FROM captured) ORDER BY transaction_id`);
    const transactions = exactArray(result.rows, 'transaction reference result')
      .map(parseTransactionReference);
    const transactionFailure = 'Task cycle materialization transaction reference integrity check failed.';
    const byId = new Map(transactions.map((row) => [row.transaction_id, row]));
    const transactionSequences = new Set(transactions.map((row) => row.event_sequence));
    const reachable = new Set<string>(); const pending = [...ids];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (reachable.has(current)) continue;
      if (!byId.has(current)) throw new Error(transactionFailure);
      reachable.add(current);
      for (const row of transactions) {
        if (row.transaction_id === current && row.reverses_transaction_id !== null) {
          pending.push(row.reverses_transaction_id);
        }
        if (row.reverses_transaction_id === current) pending.push(row.transaction_id);
      }
    }
    const cancellationCompletionTransactions = new Set(ordered.filter((event) =>
      event.source === 'ADMIN_RESET' && event.operation_id !== null)
      .map((event) => event.transaction_id));
    if (byId.size !== transactions.length || transactionSequences.size !== transactions.length
      || reachable.size !== transactions.length
      || transactions.some((row) => row.kind === 'CANCELLATION'
        && !cancellationCompletionTransactions.has(row.transaction_id))) {
      throw new Error(transactionFailure);
    }
    for (const event of ordered) {
      if (event.source === 'BANK') {
        const row = byId.get(event.transaction_id!);
        if (!row || row.kind !== 'TASK_REWARD' || row.student_id !== event.student_id
          || row.student_name_snapshot !== event.student_name_snapshot
          || row.legacy_total_amount !== event.reward_snapshot || row.balance_delta !== event.reward_snapshot
          || row.balance_before !== event.balance_before || row.balance_after !== event.balance_after
          || row.occurred_at.getTime() !== event.completed_at.getTime()
          || row.operator_snapshot !== 'bank-task-completion' || row.legacy_status_snapshot !== 'COMPLETED'
          || row.reverses_transaction_id !== null || row.operation_id !== event.operation_id
          || row.operation_hash !== event.operation_hash || row.schema_version !== 1) throw new Error(failure);
      } else if (event.source === 'ADMIN_RESET' && event.operation_id !== null) {
        const reversal = byId.get(event.transaction_id!);
        const original = reversal?.reverses_transaction_id
          ? byId.get(reversal.reverses_transaction_id) : undefined;
        const retainedOriginal = original === undefined ? undefined : ordered.find((candidate) =>
          candidate.source === 'BANK' && candidate.transaction_id === original.transaction_id);
        if (!reversal || !original || !retainedOriginal || reversal.kind !== 'CANCELLATION'
          || reversal.student_id !== event.student_id || reversal.student_name_snapshot !== event.student_name_snapshot
          || reversal.legacy_total_amount !== event.reward_snapshot
          || reversal.balance_delta !== -event.reward_snapshot
          || reversal.balance_before !== event.balance_before || reversal.balance_after !== event.balance_after
          || reversal.occurred_at.getTime() !== event.completed_at.getTime()
          || reversal.operator_snapshot !== 'admin-cancellation'
          || reversal.legacy_status_snapshot !== 'CANCEL_REVERSAL'
          || reversal.operation_id !== event.operation_id || reversal.operation_hash !== event.operation_hash
          || original.kind !== 'TASK_REWARD' || original.student_id !== event.student_id
          || original.student_name_snapshot !== event.student_name_snapshot
          || original.legacy_total_amount !== event.reward_snapshot
          || original.balance_delta !== event.reward_snapshot || original.occurred_at > reversal.occurred_at
          || event.note !== `cancels-completion:task-completion:${original.operation_id}`
          || original.transaction_id !== `task-reward:${original.operation_id}`
          || original.operation_id === null || original.operation_hash === null
          || retainedOriginal.task_instance_id !== event.task_instance_id
          || retainedOriginal.task_id_snapshot !== event.task_id_snapshot
          || retainedOriginal.task_name_snapshot !== event.task_name_snapshot
          || retainedOriginal.student_id !== event.student_id
          || retainedOriginal.student_name_snapshot !== event.student_name_snapshot
          || retainedOriginal.reward_snapshot !== event.reward_snapshot
          || retainedOriginal.cycle_id !== event.cycle_id
          || retainedOriginal.cycle_start_at.getTime() !== event.cycle_start_at.getTime()
          || nullableTime(retainedOriginal.cycle_end_at) !== nullableTime(event.cycle_end_at)
          || retainedOriginal.rule_version !== event.rule_version
          || retainedOriginal.timezone !== event.timezone
          || retainedOriginal.assignment_id !== event.assignment_id) throw new Error(failure);
        let cancellationHash: string;
        try {
          cancellationHash = createCancellationPayloadHash(original as never, [], retainedOriginal as never);
        } catch { throw new Error(failure); }
        if (event.operation_hash !== cancellationHash) throw new Error(failure);
        addExpectedOperation(operations, original.operation_id, 'TASK_REWARD', original.operation_hash, failure);
      }
    }
  }
  if (operations.size > 0) {
    const ids = [...operations.keys()].sort(compareText);
    const result = await input.tx.execute(sql`SELECT operation_id, operation_kind, payload_hash
      FROM operations WHERE tenant_id=${input.tenantId}
      AND operation_id IN (${sql.join(ids.map((value) => sql`${value}`), sql`, `)})
      ORDER BY operation_id`);
    const rows = exactArray(result.rows, 'operation reference result');
    if (rows.length !== ids.length) throw new Error(failure);
    const seen = new Set<string>();
    for (const raw of rows) {
      const row = exactRow(raw, OPERATION_REFERENCE_KEYS, 'operation reference evidence');
      const operationId = id(row.operation_id); const expected = operations.get(operationId);
      if (!expected || seen.has(operationId) || row.operation_kind !== expected.kind
        || row.payload_hash !== expected.hash) throw new Error(failure);
      seen.add(operationId);
    }
  }
}

function addExpectedOperation(map: Map<string, { kind: 'TASK_REWARD' | 'TASK_ADMIN' | 'CANCELLATION'; hash: string }>,
  operationId: string, kind: 'TASK_REWARD' | 'TASK_ADMIN' | 'CANCELLATION', operationHash: string,
  failure: string) {
  if (!UUID.test(operationId) || !HASH.test(operationHash)) throw new Error(failure);
  const prior = map.get(operationId);
  if (prior && (prior.kind !== kind || prior.hash !== operationHash)) throw new Error(failure);
  map.set(operationId, { kind, hash: operationHash });
}

function parseTransactionReference(raw: unknown) {
  const row = exactRow(raw, TRANSACTION_REFERENCE_KEYS, 'transaction reference evidence');
  const occurredAt = date(row.occurred_at); const createdAt = date(row.created_at);
  const before = integerText(row.balance_before); const after = integerText(row.balance_after);
  const delta = integerText(row.balance_delta);
  if (!['TASK_REWARD', 'CANCELLATION'].includes(row.kind as string) || after - before !== delta
    || occurredAt > createdAt || (row.operation_id === null) !== (row.operation_hash === null)) {
    throw new Error('Task cycle materialization transaction reference integrity check failed.');
  }
  return { transaction_id: id(row.transaction_id), event_sequence: positive(row.event_sequence),
    occurred_at: occurredAt, student_id: id(row.student_id),
    student_name_snapshot: id(row.student_name_snapshot), kind: row.kind as 'TASK_REWARD' | 'CANCELLATION',
    legacy_total_amount: integerText(row.legacy_total_amount), balance_delta: delta,
    balance_before: before, balance_after: after, operator_snapshot: id(row.operator_snapshot),
    legacy_status_snapshot: row.legacy_status_snapshot === null ? null : id(row.legacy_status_snapshot),
    reverses_transaction_id: row.reverses_transaction_id === null ? null : id(row.reverses_transaction_id),
    operation_id: row.operation_id === null ? null : id(row.operation_id),
    operation_hash: row.operation_hash === null ? null : hash(row.operation_hash),
    schema_version: integer(row.schema_version), created_at: createdAt };
}

async function verifyMaterialized(
  input: Parameters<typeof materializeTaskConfigurationBoundaryCycleInternal>[0],
  assignmentIds: readonly string[], completionIds: readonly string[],
  carried: ReadonlyMap<string, string>, oldAssignments: ReadonlyMap<string, Assignment>,
  oldCompletions: ReadonlyMap<string, Completion>,
) {
  const assignments = (await input.tx.execute(sql`SELECT assignment_id,
    event_sequence::text AS event_sequence, task_id_snapshot, task_instance_id, cycle_id,
    cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
    previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
    schema_version, note FROM task_assignments WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId} AND cycle_id=${input.newCycle.cycleId}
    ORDER BY student_id, event_sequence`)).rows.map(parseAssignment);
  if (assignments.length !== assignmentIds.length) {
    throw new Error('Task cycle materialization assignment set integrity check failed.');
  }
  for (const event of assignments) {
    const predecessor = oldAssignments.get(event.student_id);
    if (!assignmentIds.includes(event.assignment_id) || event.source !== 'CARRY_FORWARD'
      || event.event_type !== 'ASSIGNED' || event.previous_assignment_id !== predecessor?.assignment_id
      || event.rule_version !== input.newRuleVersion || event.created_at.getTime() !== input.now.getTime()) {
      throw new Error('Task cycle materialization assignment set integrity check failed.');
    }
  }
  const completions = (await input.tx.execute(sql`SELECT completion_id,
    event_sequence::text AS event_sequence, completed_at, task_instance_id, task_id_snapshot,
    task_name_snapshot, student_id, student_name_snapshot,
    reward_snapshot::text AS reward_snapshot, balance_before::text AS balance_before,
    balance_after::text AS balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
    rule_version, timezone, source, assignment_id, transaction_id, operation_id, operation_hash,
    admin_operation_id, admin_operation_hash, schema_version, evidence_provider,
    evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
    FROM task_completions WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId} AND cycle_id=${input.newCycle.cycleId}
    ORDER BY event_sequence`)).rows.map(parseCompletion);
  if (completions.length !== completionIds.length) {
    throw new Error('Task cycle materialization completion set integrity check failed.');
  }
  for (const event of completions) {
    const predecessor = oldCompletions.get(event.student_id);
    if (!completionIds.includes(event.completion_id) || event.source !== 'CARRY_FORWARD'
      || event.status !== 'COMPLETED' || event.reward_snapshot !== 0
      || event.balance_before !== predecessor?.balance_after
      || event.balance_after !== predecessor?.balance_after
      || event.assignment_id !== carried.get(event.student_id)
      || event.transaction_id !== null || event.operation_id !== null
      || event.admin_operation_id !== null || event.rule_version !== input.newRuleVersion
      || event.completed_at.getTime() !== input.now.getTime()) {
      throw new Error('Task cycle materialization completion set integrity check failed.');
    }
  }
}

function latestBySubject<T extends { student_id: string; event_sequence: number }>(
  events: readonly T[],
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const event of events) {
    const prior = latest.get(event.student_id);
    if (!prior || prior.event_sequence < event.event_sequence) latest.set(event.student_id, event);
  }
  return latest;
}

function inOldCycle(
  input: Parameters<typeof materializeTaskConfigurationBoundaryCycleInternal>[0],
  event: { cycle_id: string; cycle_start_at: Date; cycle_end_at: Date | null;
    rule_version: number; timezone: string },
) {
  return event.cycle_id === input.oldCycle.cycleId
    && event.cycle_start_at.getTime() === new Date(input.oldCycle.startsAt).getTime()
    && nullableTime(event.cycle_end_at)
      === nullableTime(input.oldCycle.endsAt ? new Date(input.oldCycle.endsAt) : null)
    && event.rule_version === input.oldRuleVersion && event.timezone === input.timeZone;
}

function parseMirror(raw: unknown) {
  const row = exactRow(raw, ['task_instance_id', 'student_id', 'created_at'], 'mirror evidence');
  return { task_instance_id: id(row.task_instance_id), student_id: id(row.student_id),
    created_at: date(row.created_at) };
}
function parseAssignment(raw: unknown) {
  const row = exactRow(raw, ASSIGNMENT_KEYS, 'assignment evidence');
  if (!['ASSIGNED', 'UNASSIGNED'].includes(row.event_type as string)
    || !['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(row.source as string)
    || row.schema_version !== 1 || row.note !== null) {
    throw new Error('Task cycle materialization assignment evidence integrity check failed.');
  }
  const source = row.source as 'ADMIN' | 'QR' | 'LEGACY_SEED' | 'CARRY_FORWARD';
  const bound = source === 'ADMIN' || source === 'QR';
  if (bound !== (row.admin_operation_id !== null && row.admin_operation_hash !== null)) {
    throw new Error('Task cycle materialization assignment evidence integrity check failed.');
  }
  const adminOperationId = bound ? id(row.admin_operation_id) : null;
  const adminOperationHash = bound ? hash(row.admin_operation_hash) : null;
  return { assignment_id: id(row.assignment_id), event_sequence: positive(row.event_sequence),
    task_id_snapshot: id(row.task_id_snapshot), task_instance_id: id(row.task_instance_id),
    cycle_id: id(row.cycle_id), cycle_start_at: date(row.cycle_start_at),
    cycle_end_at: row.cycle_end_at === null ? null : date(row.cycle_end_at),
    rule_version: integer(row.rule_version), timezone: id(row.timezone), student_id: id(row.student_id),
    event_type: row.event_type as 'ASSIGNED' | 'UNASSIGNED', source,
    previous_assignment_id: row.previous_assignment_id === null ? null : id(row.previous_assignment_id),
    admin_operation_id: adminOperationId, admin_operation_hash: adminOperationHash,
    created_at: date(row.created_at), schema_version: 1, note: null };
}
function parseCompletion(raw: unknown) {
  const row = exactRow(raw, COMPLETION_KEYS, 'completion evidence');
  if (row.schema_version !== 1 || typeof row.task_name_snapshot !== 'string'
    || typeof row.student_name_snapshot !== 'string' || typeof row.status !== 'string'
    || !['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'].includes(row.source as string)) {
    throw new Error('Task cycle materialization completion evidence integrity check failed.');
  }
  const nullableId = (value: unknown) => value === null ? null : id(value);
  const nullableDate = (value: unknown) => value === null ? null : date(value);
  const operationHash = row.operation_hash === null ? null : hash(row.operation_hash);
  const adminHash = row.admin_operation_hash === null ? null : hash(row.admin_operation_hash);
  if ((row.operation_id === null) !== (operationHash === null)
    || (row.admin_operation_id === null) !== (adminHash === null)) {
    throw new Error('Task cycle materialization completion evidence integrity check failed.');
  }
  return { completion_id: id(row.completion_id), event_sequence: positive(row.event_sequence),
    completed_at: date(row.completed_at), task_instance_id: id(row.task_instance_id),
    task_id_snapshot: id(row.task_id_snapshot), task_name_snapshot: row.task_name_snapshot,
    student_id: id(row.student_id), student_name_snapshot: row.student_name_snapshot,
    reward_snapshot: integerText(row.reward_snapshot), balance_before: integerText(row.balance_before),
    balance_after: integerText(row.balance_after), status: row.status, note: nullableId(row.note),
    cycle_id: id(row.cycle_id), cycle_start_at: date(row.cycle_start_at),
    cycle_end_at: nullableDate(row.cycle_end_at), rule_version: integer(row.rule_version),
    timezone: id(row.timezone), source: row.source, assignment_id: nullableId(row.assignment_id),
    transaction_id: nullableId(row.transaction_id), operation_id: nullableId(row.operation_id),
    operation_hash: operationHash, admin_operation_id: nullableId(row.admin_operation_id),
    admin_operation_hash: adminHash, schema_version: 1,
    evidence_provider: nullableId(row.evidence_provider),
    evidence_board_id: nullableId(row.evidence_board_id),
    evidence_post_id: nullableId(row.evidence_post_id),
    evidence_created_at: nullableDate(row.evidence_created_at),
    evidence_author_full_name: nullableId(row.evidence_author_full_name),
    created_at: date(row.created_at) };
}

function exactRow<const K extends readonly string[]>(raw: unknown, keys: K, label: string) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error(`Task cycle materialization ${label} is malformed.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw); const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`Task cycle materialization ${label} is malformed.`);
  }
  for (const key of actual) if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) {
    throw new Error(`Task cycle materialization ${label} is malformed.`);
  }
  return raw as { [P in K[number]]: unknown };
}
function exactArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length) {
    throw new Error(`Task cycle materialization ${label} is malformed.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw) as Record<string, PropertyDescriptor>;
  const length = descriptors.length;
  if (!length || length.enumerable || !Object.hasOwn(length, 'value')
    || !Number.isSafeInteger(length.value) || length.value < 0) {
    throw new Error(`Task cycle materialization ${label} is malformed.`);
  }
  const expected = Array.from({ length: length.value as number }, (_, index) => String(index));
  const actual = Object.keys(descriptors).filter((key) => key !== 'length');
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Task cycle materialization ${label} is malformed.`);
  }
  const values: unknown[] = [];
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`Task cycle materialization ${label} is malformed.`);
    }
    values.push(descriptor.value);
  }
  return values;
}
function assertOne(rows: readonly unknown[], key: string, value: string, label: string) {
  if (rows.length !== 1) throw new Error(`Task cycle materialization ${label} integrity check failed.`);
  const row = exactRow(rows[0], [key] as const, label);
  if (row[key] !== value) throw new Error(`Task cycle materialization ${label} integrity check failed.`);
}
export function taskNaturalAssignmentMaterializationId(taskInstanceId: string,
  cycleIdValue: string, studentId: string) {
  return `task-assignment-materialization:${sha256({ domain: 'task-assignment-materialization-v1',
    source: 'CARRY_FORWARD', taskInstanceId, cycleId: cycleIdValue, studentId })}`;
}
const assignmentMaterializationId = taskNaturalAssignmentMaterializationId;
export function taskNaturalCompletionMaterializationId(taskInstanceId: string,
  cycleIdValue: string, studentId: string) {
  return `task-completion-materialization:${sha256({ domain: 'task-completion-materialization-v1',
    source: 'CARRY_FORWARD', taskInstanceId, cycleId: cycleIdValue, studentId })}`;
}
const completionMaterializationId = taskNaturalCompletionMaterializationId;
function adminResetCompletionId(operationId: string, taskInstanceId: string,
  studentId: string, cycleIdValue: string) {
  return `task-completion-admin-reset:${sha256({ domain: 'task-completion-admin-reset-v1',
    operationId, taskInstanceId, studentId, cycleId: cycleIdValue })}`;
}
function cycleId(event: { task_instance_id: string; rule_version: number; cycle_start_at: Date }) {
  return `v1|${event.task_instance_id}|r${event.rule_version}|${event.cycle_start_at.toISOString().replace('.000Z', 'Z')}`;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) throw new Error('Invalid identity evidence.');
  return value;
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype
    || Reflect.ownKeys(value).length || !Number.isFinite(Date.prototype.getTime.call(value))) {
    throw new Error('Invalid timestamp evidence.');
  }
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid integer evidence.'); return value as number;
}
function positive(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Invalid sequence evidence.');
  }
  return Number(value);
}
function integerText(value: unknown): number {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)
    || !Number.isSafeInteger(Number(value))) throw new Error('Invalid numeric evidence.');
  return Number(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Invalid hash evidence.'); return value;
}
function compareText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function nullableTime(value: Date | null) { return value?.getTime() ?? null; }
function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
