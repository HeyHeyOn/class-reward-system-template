import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { resolveTaskSchedule, validateTaskSchedule } from '@/domain/taskSchedule';
import type { DayOfMonth, IsoWeekday, TaskSchedule } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit, operationAuditEventId } from './operationAudit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPERATION_KEYS = ['operation_id', 'operation_kind', 'payload_hash', 'status', 'result_snapshot',
  'finished_at', 'failure_code', 'attempt_count', 'started_at', 'created_at', 'updated_at'] as const;
const COMPLETION_KEYS = ['completion_id', 'event_sequence', 'completed_at', 'task_instance_id',
  'task_id_snapshot', 'task_name_snapshot', 'student_id', 'student_name_snapshot',
  'reward_snapshot', 'balance_before', 'balance_after', 'status', 'note', 'cycle_id',
  'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'source', 'assignment_id',
  'transaction_id', 'operation_id', 'operation_hash', 'admin_operation_id',
  'admin_operation_hash', 'schema_version', 'evidence_provider', 'evidence_board_id',
  'evidence_post_id', 'evidence_created_at', 'evidence_author_full_name', 'created_at'] as const;
const TASK_KEYS = ['task_instance_id', 'task_id', 'current_schedule', 'pending_schedule',
  'schedule_schema_version', 'version', 'created_at', 'updated_at', 'is_active', 'deleted_at'] as const;
const ASSIGNMENT_KEYS = ['assignment_id', 'event_sequence', 'task_id_snapshot',
  'task_instance_id', 'cycle_id', 'cycle_start_at', 'cycle_end_at', 'rule_version',
  'timezone', 'student_id', 'event_type', 'source', 'previous_assignment_id',
  'admin_operation_id', 'admin_operation_hash', 'created_at', 'schema_version', 'note'] as const;
const ACCOUNT_KEYS = ['student_id', 'balance', 'version', 'updated_at'] as const;
const TRANSACTION_KEYS = ['tenant_id', 'transaction_id', 'event_sequence', 'occurred_at',
  'student_id', 'student_name_snapshot', 'kind', 'legacy_total_amount', 'balance_delta',
  'balance_before', 'balance_after', 'operator_snapshot', 'legacy_status_snapshot',
  'reverses_transaction_id', 'operation_id', 'operation_hash', 'schema_version',
  'created_at'] as const;
const TRANSACTION_ITEM_KEYS = ['tenant_id', 'item_id', 'transaction_id', 'line_number',
  'product_id_snapshot', 'current_product_id', 'product_name_snapshot', 'quantity',
  'unit_price_snapshot', 'subtotal_snapshot', 'regular_unit_price', 'regular_total',
  'total_quantity', 'paid_quantity', 'free_quantity', 'final_total', 'total_discount',
  'adjustments_snapshot', 'applied_promotions_snapshot', 'created_at'] as const;
const ADJUSTMENT_KEYS = ['tenant_id', 'adjustment_id', 'transaction_id', 'mode',
  'requested_amount', 'operator_snapshot', 'legacy_adjustment_id', 'created_at'] as const;
const INVENTORY_KEYS = ['tenant_id', 'inventory_event_id', 'event_sequence', 'product_id',
  'transaction_id', 'quantity_delta', 'stock_before', 'stock_after', 'reason', 'operation_id',
  'operation_hash', 'occurred_at', 'created_at'] as const;

type RunTenantTransaction = <T>(tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<T>) => Promise<T>;

export type DatabaseTaskResetCommandInput = Readonly<{
  operationId: string;
  taskIds: readonly string[];
}>;

export type DatabaseTaskResetResult = Readonly<{
  taskIds: readonly string[];
  resetEventsAppended: number;
  deletedCount: number;
}>;

export type DatabaseTaskResetCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

type CanonicalInput = Readonly<{ operationId: string; taskIds: readonly string[] }>;
type Task = Readonly<{ task_instance_id: string; task_id: string; current_schedule: TaskSchedule;
  pending_schedule: TaskSchedule | null; schedule_schema_version: number; version: number;
  created_at: Date; updated_at: Date; is_active: boolean; deleted_at: Date | null }>;
type Operation = Readonly<{ operation_id: string; operation_kind: string; payload_hash: string;
  status: string; result_snapshot: unknown; finished_at: Date | null; failure_code: string | null;
  attempt_count: string; started_at: Date; created_at: Date; updated_at: Date }>;
type Completion = ReturnType<typeof parseCompletion>;
type Assignment = ReturnType<typeof parseAssignment>;
type Account = ReturnType<typeof parseAccount>;
type TransactionGraph = Awaited<ReturnType<typeof readTransactionGraph>>;
type TaskIdentity = Readonly<{ taskId: string; taskInstanceId: string }>;

export function createTaskResetPayloadHash(raw: DatabaseTaskResetCommandInput): string {
  const input = canonicalInput(raw);
  return sha256({ kind: 'TASK_ADMIN', action: 'COMPLETION_RESET_BATCH',
    taskIds: input.taskIds, schemaVersion: 1 });
}

export function createDatabaseTaskResetCommands(dependencies: DatabaseTaskResetCommandDependencies) {
  return {
    async resetBatch(raw: DatabaseTaskResetCommandInput): Promise<DatabaseTaskResetResult> {
      const input = canonicalInput(raw);
      const now = dependencies.now?.() ?? new Date();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('Task reset current timestamp is invalid.');
      }
      const payloadHash = createTaskResetPayloadHash(raw);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) return replay(tx, dependencies.tenantId, existing, input, payloadHash);

        const claim = await tx.execute(sql`INSERT INTO operations
          (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
           started_at, created_at, updated_at)
          VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${payloadHash},
            'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id`);
        const claimRows = adapterRows(claim, 'operation claim rowset');
        if (claimRows.length === 0) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Task reset operation claim integrity check failed.');
          return replay(tx, dependencies.tenantId, winner, input, payloadHash);
        }
        assertReturning(claimRows, ['operation_id'], { operation_id: input.operationId },
          'operation claim');

        const taskRows = await tx.execute(sql`SELECT ${taskColumns()} FROM tasks
          WHERE tenant_id=${dependencies.tenantId}
          AND deleted_at IS NULL
          AND task_id IN (${sql.join(input.taskIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY task_instance_id FOR UPDATE`);
        const lockedTaskRows = adapterRows(taskRows, 'task rowset');
        if (lockedTaskRows.length < input.taskIds.length) throw new Error('Task reset target not found.');
        if (lockedTaskRows.length > input.taskIds.length) {
          throw new Error('Task reset target task integrity check failed.');
        }
        const tasks = new Map<string, Task>();
        const taskInstances = new Set<string>();
        for (const rawTask of lockedTaskRows) {
          const task = parseTask(rawTask);
          if (task.deleted_at !== null || !input.taskIds.includes(task.task_id)
            || tasks.has(task.task_id) || taskInstances.has(task.task_instance_id)) {
            throw new Error('Task reset target task integrity check failed.');
          }
          tasks.set(task.task_id, task);
          taskInstances.add(task.task_instance_id);
        }
        if (input.taskIds.some((id) => !tasks.has(id))) throw new Error('Task reset target not found.');
        const instances = [...tasks.values()].map((task) => task.task_instance_id)
          .sort(compareCanonical);
        const initial = await readCompletions(tx, dependencies.tenantId, instances, true);
        validateCompletionSet(initial, tasks);
        const initialAssignments = await readAssignments(tx, dependencies.tenantId, instances, true);
        validateAssignmentSet(initialAssignments, tasks);
        validateCompletionAssignments(initial, initialAssignments);
        const initialTransactionGraph = await validateCompletionReferences(tx,
          dependencies.tenantId, initial, initialAssignments);
        const completionStudentIds = [...new Set(initial.map((event) => event.student_id))]
          .sort(compareCanonical);
        const initialAccounts = await readAccounts(tx, dependencies.tenantId, completionStudentIds, true);
        validateAccountSet(initialAccounts, completionStudentIds);
        const expected = [...initial];
        const latest = latestCurrentCompletions(initial, tasks, now);

        for (const predecessor of latest) {
          const completionId = resetEventId(input.operationId, predecessor.task_instance_id!,
            predecessor.student_id, predecessor.cycle_id!);
          const inserted = await tx.execute(sql`INSERT INTO task_completions
            (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
             task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
             balance_before, balance_after, status, note, cycle_id, cycle_start_at,
             cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
             operation_id, operation_hash, admin_operation_id, admin_operation_hash,
             schema_version, evidence_provider, evidence_board_id, evidence_post_id,
             evidence_created_at, evidence_author_full_name, created_at)
            VALUES (${dependencies.tenantId}, ${completionId}, ${now},
              ${predecessor.task_instance_id}, ${predecessor.task_id_snapshot},
              ${predecessor.task_name_snapshot}, ${predecessor.student_id},
              ${predecessor.student_name_snapshot}, 0, ${predecessor.balance_after},
              ${predecessor.balance_after}, 'CANCELLED', 'admin-completion-reset',
              ${predecessor.cycle_id}, ${predecessor.cycle_start_at},
              ${predecessor.cycle_end_at}, ${predecessor.rule_version},
              ${predecessor.timezone}, 'ADMIN_RESET', ${predecessor.assignment_id}, NULL,
              NULL, NULL, ${input.operationId}, ${payloadHash}, 1, NULL, NULL, NULL, NULL,
              NULL, ${now}) RETURNING ${completionColumns()}`);
          const insertedRows = adapterRows(inserted, 'reset event rowset');
          if (insertedRows.length !== 1) {
            throw new Error('Task reset reset event integrity check failed.');
          }
          const event = parseCompletion(insertedRows[0]);
          validateResetEvent(event, predecessor, input.operationId, payloadHash, now, completionId);
          expected.push(event);
        }

        const identities = [...tasks.values()].map((task) => Object.freeze({
          taskId: task.task_id, taskInstanceId: task.task_instance_id,
        })).sort((left, right) => compareCanonical(left.taskId, right.taskId));
        const result = freezeResult({ taskIds: [...input.taskIds],
          resetEventsAppended: latest.length, deletedCount: latest.length });
        await verifyComplete(tx, dependencies.tenantId, tasks, expected, initialAssignments, result,
          input.operationId, payloadHash, now, initialTransactionGraph, 'pre-audit');
        await assertTaskSnapshots(tx, dependencies.tenantId, tasks, 'pre-audit');
        await assertAccountSnapshots(tx, dependencies.tenantId, completionStudentIds,
          initialAccounts, 'pre-audit');
        const audit = auditInput(input.operationId, result, identities, now);
        await appendOperationAudit(tx, dependencies.tenantId, audit);
        await assertOperationAudit(tx, dependencies.tenantId, audit);
        await assertAuditIdentities(tx, dependencies.tenantId, input.operationId, result,
          identities, now);
        const terminal = await tx.execute(sql`UPDATE operations SET status='SUCCEEDED',
          result_snapshot=${JSON.stringify(result)}::jsonb, finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id`);
        assertReturning(adapterRows(terminal, 'terminal operation rowset'), ['operation_id'],
          { operation_id: input.operationId }, 'terminal operation');
        await assertTaskSnapshots(tx, dependencies.tenantId, tasks, 'post-terminal');
        await assertAccountSnapshots(tx, dependencies.tenantId, completionStudentIds,
          initialAccounts, 'post-terminal');
        await verifyComplete(tx, dependencies.tenantId, tasks, expected, initialAssignments, result,
          input.operationId, payloadHash, now, initialTransactionGraph, 'post-terminal');
        await assertOperationAudit(tx, dependencies.tenantId, audit);
        await assertAuditIdentities(tx, dependencies.tenantId, input.operationId, result,
          identities, now);
        const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!stored) throw new Error('Task reset terminal operation integrity check failed.');
        return replay(tx, dependencies.tenantId, stored, input, payloadHash, true);
      });
    },
  };
}

async function replay(tx: TenantTransaction, tenantId: string, operation: Operation,
  input: CanonicalInput, payloadHash: string, referencesAlreadyValidated = false)
  : Promise<DatabaseTaskResetResult> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Task reset operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== '1' || operation.finished_at === null
    || operation.started_at.getTime() !== operation.created_at.getTime()
    || operation.finished_at.getTime() !== operation.updated_at.getTime()
    || operation.started_at.getTime() > operation.finished_at.getTime()) {
    throw new Error('Task reset operation is not replayable.');
  }
  const result = parseResult(operation.result_snapshot);
  if (snapshot(result.taskIds) !== snapshot(input.taskIds)
    || result.resetEventsAppended !== result.deletedCount) {
    throw new Error('Task reset stored result integrity check failed.');
  }
  const identitiesEvidence = await readAuditIdentities(tx, tenantId, input.operationId, result,
    operation.finished_at);
  const instanceIds = identitiesEvidence.map((identity) => identity.taskInstanceId);
  const taskRows = await tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(instanceIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id`);
  const identities = new Map<string, string>();
  for (const raw of adapterRows(taskRows, 'replay task rowset')) {
    const row = exactRow(raw, ['task_instance_id', 'task_id'], 'replay task evidence');
    const instance = requiredId(row.task_instance_id, 'replay task instance ID');
    const taskId = requiredId(row.task_id, 'replay task ID');
    const expectedIdentity = identitiesEvidence.find((identity) => identity.taskInstanceId === instance);
    if (!expectedIdentity || expectedIdentity.taskId !== taskId || identities.has(instance)) {
      throw new Error('Task reset physical identity integrity check failed.');
    }
    identities.set(instance, taskId);
  }
  if (identities.size !== identitiesEvidence.length) {
    throw new Error('Task reset physical identity integrity check failed.');
  }
  const instances = [...identities.keys()].sort(compareCanonical);
  const histories = await readCompletions(tx, tenantId, instances, false);
  validateCompletionIdentities(histories, identities);
  if (!referencesAlreadyValidated) {
    const assignments = await readAssignments(tx, tenantId, instances);
    validateAssignmentIdentities(assignments, identities);
    validateCompletionAssignments(histories, assignments);
    await validateCompletionReferences(tx, tenantId, histories, assignments);
  }
  const bound = histories.filter((event) => event.admin_operation_id === input.operationId);
  if (bound.length !== result.resetEventsAppended) {
    throw new Error('Task reset operation-bound event integrity check failed.');
  }
  for (const event of bound) {
    if (event.source !== 'ADMIN_RESET' || event.status !== 'CANCELLED'
      || event.reward_snapshot !== 0 || event.balance_before !== event.balance_after
      || event.admin_operation_hash !== payloadHash || event.completed_at.getTime()
        !== operation.finished_at.getTime() || event.transaction_id !== null
      || event.operation_id !== null || event.operation_hash !== null
      || event.completion_id !== resetEventId(input.operationId, event.task_instance_id!,
        event.student_id, event.cycle_id!)) {
      throw new Error('Task reset operation-bound event integrity check failed.');
    }
  }
  await assertOperationAudit(tx, tenantId, auditInput(input.operationId, result,
    identitiesEvidence, operation.finished_at));
  return result;
}

function latestCurrentCompletions(history: readonly Completion[], tasks: ReadonlyMap<string, Task>,
  now: Date): Completion[] {
  const cycles = new Map<string, ReturnType<typeof getTaskCycle>>();
  const scheduleVersions = new Map<string, number>();
  for (const task of tasks.values()) {
    const schedule = resolveTaskSchedule({ currentSchedule: task.current_schedule,
      pendingSchedule: task.pending_schedule, now: now.toISOString() });
    if (schedule.timeZone !== 'Asia/Seoul') throw new Error('Task reset timezone is invalid.');
    cycles.set(task.task_instance_id, getTaskCycle({ taskInstanceId: task.task_instance_id,
      schedule, taskCreatedAt: task.created_at.toISOString(), now: now.toISOString() }));
    scheduleVersions.set(task.task_instance_id, schedule.ruleVersion);
  }
  const latest = new Map<string, Completion>();
  for (const event of history) {
    const cycle = cycles.get(event.task_instance_id!);
    if (!cycle || event.cycle_id !== cycle.cycleId
      || event.cycle_start_at?.getTime() !== new Date(cycle.startsAt).getTime()
      || nullableTime(event.cycle_end_at) !== nullableTime(cycle.endsAt ? new Date(cycle.endsAt) : null)
      || event.rule_version !== scheduleVersions.get(event.task_instance_id!)
      || event.timezone !== 'Asia/Seoul') continue;
    const subject = key(event.task_instance_id!, event.student_id);
    const prior = latest.get(subject);
    if (!prior || prior.event_sequence < event.event_sequence) latest.set(subject, event);
  }
  return [...latest.values()].filter((event) => event.status === 'COMPLETED')
    .sort((left, right) => compareCanonical(left.task_id_snapshot, right.task_id_snapshot)
      || compareCanonical(left.student_id, right.student_id));
}

async function verifyComplete(tx: TenantTransaction, tenantId: string,
  tasks: ReadonlyMap<string, Task>, expected: readonly Completion[],
  expectedAssignments: readonly Assignment[], result: DatabaseTaskResetResult,
  operationId: string, payloadHash: string, now: Date, expectedGraph: TransactionGraph,
  phase: string) {
  const instances = [...tasks.values()].map((task) => task.task_instance_id).sort(compareCanonical);
  const actual = await readCompletions(tx, tenantId, instances, false);
  validateCompletionSet(actual, tasks);
  const assignments = await readAssignments(tx, tenantId, instances);
  validateAssignmentSet(assignments, tasks);
  if (snapshot(canonicalAssignments(assignments)) !== snapshot(canonicalAssignments(expectedAssignments))) {
    throw new Error(`Task reset ${phase} assignment snapshot integrity check failed.`);
  }
  validateCompletionAssignments(actual, assignments);
  await validateCompletionReferences(tx, tenantId, actual, assignments, expectedGraph, phase);
  if (snapshot(canonicalCompletions(actual)) !== snapshot(canonicalCompletions(expected))) {
    throw new Error('Task reset complete-state completion history integrity check failed.');
  }
  const bound = actual.filter((event) => event.admin_operation_id === operationId);
  if (bound.length !== result.resetEventsAppended) {
    throw new Error('Task reset operation-bound event integrity check failed.');
  }
  for (const event of bound) {
    if (event.admin_operation_hash !== payloadHash || event.completed_at.getTime() !== now.getTime()) {
      throw new Error('Task reset operation-bound event integrity check failed.');
    }
  }
}

async function readCompletions(tx: TenantTransaction, tenantId: string,
  instances: readonly string[], lock: boolean): Promise<Completion[]> {
  const rows = await tx.execute(lock ? sql`SELECT ${completionColumns()} FROM task_completions
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(instances.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id, event_sequence FOR UPDATE`
    : sql`SELECT ${completionColumns()} FROM task_completions WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((id) => sql`${id}`), sql`, `)})
      ORDER BY task_instance_id, event_sequence`);
  return adapterRows(rows, 'completion rowset').map(parseCompletion);
}

function assignmentColumns() {
  return sql`assignment_id, event_sequence::text AS event_sequence, task_id_snapshot,
    task_instance_id, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
    student_id, event_type, source, previous_assignment_id, admin_operation_id,
    admin_operation_hash, created_at, schema_version, note`;
}

async function readAssignments(tx: TenantTransaction, tenantId: string,
  instances: readonly string[], lock = false): Promise<Assignment[]> {
  const result = await tx.execute(lock ? sql`SELECT ${assignmentColumns()} FROM task_assignments
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(instances.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id, event_sequence FOR UPDATE`
    : sql`SELECT ${assignmentColumns()} FROM task_assignments WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((id) => sql`${id}`), sql`, `)})
      ORDER BY task_instance_id, event_sequence`);
  return adapterRows(result, 'assignment snapshot rowset').map(parseAssignment);
}

function parseAssignment(raw: unknown) {
  const row = exactRow(raw, ASSIGNMENT_KEYS, 'assignment snapshot evidence');
  if (!['ASSIGNED', 'UNASSIGNED'].includes(row.event_type as string)
    || !['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(row.source as string)
    || row.schema_version !== 1 || (row.note !== null && typeof row.note !== 'string')) {
    throw new Error('Task reset assignment snapshot integrity check failed.');
  }
  const source = row.source as 'ADMIN' | 'QR' | 'LEGACY_SEED' | 'CARRY_FORWARD';
  const operationBound = source === 'ADMIN' || source === 'QR';
  const adminOperationId = row.admin_operation_id === null ? null
    : requiredId(row.admin_operation_id, 'assignment administrator operation ID');
  const adminOperationHash = nullableHash(row.admin_operation_hash,
    'assignment administrator operation hash');
  if (operationBound !== (adminOperationId !== null && adminOperationHash !== null)) {
    throw new Error('Task reset assignment snapshot integrity check failed.');
  }
  const cycleStartAt = requiredDate(row.cycle_start_at, 'assignment cycle start');
  const cycleEndAt = row.cycle_end_at === null ? null
    : requiredDate(row.cycle_end_at, 'assignment cycle end');
  const createdAt = requiredDate(row.created_at, 'assignment created timestamp');
  const ruleVersion = requiredSafeInteger(row.rule_version, 'assignment rule version');
  const taskInstanceId = requiredId(row.task_instance_id, 'assignment task instance ID');
  if (ruleVersion < 1 || row.timezone !== 'Asia/Seoul' || cycleStartAt.getTime() > createdAt.getTime()
    || (cycleEndAt !== null && (cycleEndAt.getTime() <= cycleStartAt.getTime()
      || createdAt.getTime() >= cycleEndAt.getTime()))) {
    throw new Error('Task reset assignment snapshot integrity check failed.');
  }
  const cycleIdValue = requiredId(row.cycle_id, 'assignment cycle ID');
  if (cycleIdValue !== `v1|${taskInstanceId}|r${ruleVersion}|${cycleStartAt.toISOString()
    .replace(/\.000Z$/, 'Z')}`) {
    throw new Error('Task reset assignment snapshot integrity check failed.');
  }
  return { assignment_id: requiredId(row.assignment_id, 'assignment ID'),
    event_sequence: requiredPositiveIntegerText(row.event_sequence, 'assignment event sequence'),
    task_id_snapshot: requiredId(row.task_id_snapshot, 'assignment task ID'),
    task_instance_id: taskInstanceId, cycle_id: cycleIdValue, cycle_start_at: cycleStartAt,
    cycle_end_at: cycleEndAt, rule_version: ruleVersion, timezone: 'Asia/Seoul' as const,
    student_id: requiredId(row.student_id, 'assignment student ID'),
    event_type: row.event_type as 'ASSIGNED' | 'UNASSIGNED', source,
    previous_assignment_id: row.previous_assignment_id === null ? null
      : requiredId(row.previous_assignment_id, 'assignment predecessor ID'),
    admin_operation_id: adminOperationId, admin_operation_hash: adminOperationHash,
    created_at: createdAt, schema_version: 1,
    note: row.note as string | null };
}

function validateAssignmentSet(rows: readonly Assignment[], tasks: ReadonlyMap<string, Task>) {
  const identities = new Map([...tasks.values()].map((task) =>
    [task.task_instance_id, task.task_id] as const));
  const assignmentIds = new Set<string>(); const sequences = new Set<number>();
  for (const assignment of rows) {
    if (identities.get(assignment.task_instance_id) !== assignment.task_id_snapshot
      || assignmentIds.has(assignment.assignment_id) || sequences.has(assignment.event_sequence)) {
      throw new Error('Task reset assignment snapshot identity integrity check failed.');
    }
    assignmentIds.add(assignment.assignment_id); sequences.add(assignment.event_sequence);
  }
  validateAssignmentChains(rows);
}

function validateAssignmentIdentities(rows: readonly Assignment[],
  identities: ReadonlyMap<string, string>) {
  const assignmentIds = new Set<string>(); const sequences = new Set<number>();
  for (const assignment of rows) {
    if (identities.get(assignment.task_instance_id) !== assignment.task_id_snapshot
      || assignmentIds.has(assignment.assignment_id) || sequences.has(assignment.event_sequence)) {
      throw new Error('Task reset assignment snapshot identity integrity check failed.');
    }
    assignmentIds.add(assignment.assignment_id); sequences.add(assignment.event_sequence);
  }
  validateAssignmentChains(rows);
}

function validateAssignmentChains(rows: readonly Assignment[]) {
  const failure = 'Task reset assignment source chain integrity check failed.';
  const ordered = [...rows].sort((left, right) => left.event_sequence - right.event_sequence);
  const byId = new Map(ordered.map((event) => [event.assignment_id, event]));
  const local = new Map<string, Assignment[]>();
  const subjects = new Map<string, Assignment[]>();
  for (const event of ordered) {
    const localKey = key(event.task_instance_id, event.task_id_snapshot, event.student_id,
      event.cycle_id, String(event.cycle_start_at.getTime()), String(nullableTime(event.cycle_end_at)),
      String(event.rule_version), event.timezone);
    const subjectKey = key(event.task_instance_id, event.task_id_snapshot, event.student_id);
    local.set(localKey, [...(local.get(localKey) ?? []), event]);
    subjects.set(subjectKey, [...(subjects.get(subjectKey) ?? []), event]);
  }
  const immediateSubjectPrior = new Map<string, Assignment>();
  for (const chain of subjects.values()) chain.forEach((event, index) => {
    if (index > 0) immediateSubjectPrior.set(event.assignment_id, chain[index - 1]);
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
        || (priorLocal !== undefined && priorLocal.created_at.getTime() > event.created_at.getTime())) {
        throw new Error(failure);
      }
      return;
    }
    const predecessor = event.previous_assignment_id === null
      ? undefined : byId.get(event.previous_assignment_id);
    const immediate = immediateSubjectPrior.get(event.assignment_id);
    const commonLink = predecessor !== undefined && predecessor === immediate
      && predecessor.event_type === 'ASSIGNED'
      && predecessor.task_instance_id === event.task_instance_id
      && predecessor.task_id_snapshot === event.task_id_snapshot
      && predecessor.student_id === event.student_id
      && predecessor.created_at.getTime() <= event.created_at.getTime()
      && predecessor.cycle_end_at !== null;
    const naturalCarry = commonLink
      && predecessor!.cycle_end_at!.getTime() <= event.cycle_start_at.getTime()
      && predecessor!.cycle_start_at.getTime() < event.cycle_start_at.getTime()
      && predecessor!.rule_version === event.rule_version;
    const configurationCarry = commonLink
      && predecessor!.cycle_end_at!.getTime() > event.cycle_start_at.getTime()
      && predecessor!.cycle_start_at.getTime() <= event.cycle_start_at.getTime()
      && predecessor!.rule_version < event.rule_version
      && event.created_at.getTime() === event.cycle_start_at.getTime();
    if (event.event_type !== 'ASSIGNED' || (!naturalCarry && !configurationCarry)) {
      throw new Error(failure);
    }
  });
}

function validateCompletionAssignments(completions: readonly Completion[],
  assignments: readonly Assignment[]) {
  const byId = new Map<string, Assignment>();
  for (const assignment of assignments) {
    if (byId.has(assignment.assignment_id)) {
      throw new Error('Task reset completion assignment integrity check failed.');
    }
    byId.set(assignment.assignment_id, assignment);
  }
  for (const completion of completions) {
    const assignment = completion.assignment_id === null
      ? undefined : byId.get(completion.assignment_id);
    if (assignment === undefined || assignment.event_type !== 'ASSIGNED'
      || assignment.task_instance_id !== completion.task_instance_id
      || assignment.task_id_snapshot !== completion.task_id_snapshot
      || assignment.student_id !== completion.student_id
      || assignment.cycle_id !== completion.cycle_id
      || assignment.cycle_start_at.getTime() !== completion.cycle_start_at?.getTime()
      || nullableTime(assignment.cycle_end_at) !== nullableTime(completion.cycle_end_at)
      || assignment.rule_version !== completion.rule_version
      || assignment.timezone !== completion.timezone) {
      throw new Error('Task reset completion assignment integrity check failed.');
    }
  }
}

async function readAccounts(tx: TenantTransaction, tenantId: string,
  studentIds: readonly string[], lock = false): Promise<Account[]> {
  const predicate = studentIds.length === 0 ? sql`FALSE`
    : sql`student_id IN (${sql.join(studentIds.map((id) => sql`${id}`), sql`, `)})`;
  const result = await tx.execute(lock ? sql`SELECT student_id, balance::text AS balance,
    version::text AS version, updated_at FROM accounts WHERE tenant_id=${tenantId}
    AND ${predicate} ORDER BY student_id FOR UPDATE`
    : sql`SELECT student_id, balance::text AS balance, version::text AS version, updated_at
      FROM accounts WHERE tenant_id=${tenantId} AND ${predicate} ORDER BY student_id`);
  return adapterRows(result, 'account snapshot rowset').map(parseAccount);
}

function parseAccount(raw: unknown) {
  const row = exactRow(raw, ACCOUNT_KEYS, 'account snapshot evidence');
  return { student_id: requiredId(row.student_id, 'account student ID'),
    balance: requiredSafeIntegerText(row.balance, 'account balance'),
    version: requiredPositiveIntegerText(row.version, 'account version'),
    updated_at: requiredDate(row.updated_at, 'account updated timestamp') };
}

function validateAccountSet(rows: readonly Account[], expectedStudentIds: readonly string[]) {
  const expected = new Set(expectedStudentIds); const seen = new Set<string>();
  for (const account of rows) {
    if (!expected.has(account.student_id) || seen.has(account.student_id)) {
      throw new Error('Task reset account snapshot identity integrity check failed.');
    }
    seen.add(account.student_id);
  }
  if (seen.size !== expected.size) throw new Error('Task reset account snapshot integrity check failed.');
}

async function assertAccountSnapshots(tx: TenantTransaction, tenantId: string,
  studentIds: readonly string[], expected: readonly Account[], phase: string) {
  const actual = await readAccounts(tx, tenantId, studentIds);
  validateAccountSet(actual, studentIds);
  if (snapshot(canonicalAccounts(actual)) !== snapshot(canonicalAccounts(expected))) {
    throw new Error(`Task reset ${phase} account snapshot integrity check failed.`);
  }
}

function completionColumns() {
  return sql`completion_id, event_sequence::text AS event_sequence, completed_at,
    task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
    student_name_snapshot, reward_snapshot::text AS reward_snapshot,
    balance_before::text AS balance_before, balance_after::text AS balance_after,
    status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source,
    assignment_id, transaction_id, operation_id, operation_hash, admin_operation_id,
    admin_operation_hash, schema_version, evidence_provider, evidence_board_id,
    evidence_post_id, evidence_created_at, evidence_author_full_name, created_at`;
}

function parseCompletion(raw: unknown) {
  const row = exactRow(raw, COMPLETION_KEYS, 'completion evidence');
  if (row.schema_version !== 1 || typeof row.task_name_snapshot !== 'string'
    || typeof row.student_name_snapshot !== 'string' || typeof row.status !== 'string'
    || row.status.trim().length === 0 || (row.source !== null
      && !['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'].includes(row.source as string))) {
    throw new Error('Task reset completion history integrity check failed.');
  }
  const nullableId = (value: unknown, label: string) => value === null ? null : requiredId(value, label);
  const nullableDate = (value: unknown, label: string) => value === null ? null : requiredDate(value, label);
  const taskInstanceId = nullableId(row.task_instance_id, 'completion task instance ID');
  const cycleId = nullableId(row.cycle_id, 'completion cycle ID');
  const cycleStartAt = nullableDate(row.cycle_start_at, 'completion cycle start');
  const cycleEndAt = nullableDate(row.cycle_end_at, 'completion cycle end');
  const ruleVersion = row.rule_version === null ? null : requiredSafeInteger(row.rule_version,
    'completion rule version');
  const timezone = nullableId(row.timezone, 'completion timezone');
  const source = nullableId(row.source, 'completion source');
  const operationId = nullableId(row.operation_id, 'completion operation ID');
  const operationHash = nullableHash(row.operation_hash, 'completion operation hash');
  const adminOperationId = nullableId(row.admin_operation_id, 'completion admin operation ID');
  const adminOperationHash = nullableHash(row.admin_operation_hash, 'completion admin operation hash');
  const hasCycle = taskInstanceId !== null;
  if (hasCycle !== (cycleId !== null) || hasCycle !== (cycleStartAt !== null)
    || hasCycle !== (ruleVersion !== null) || hasCycle !== (timezone !== null)
    || hasCycle !== (source !== null) || (cycleEndAt !== null && cycleStartAt === null)
    || (operationId === null) !== (operationHash === null)
    || (adminOperationId === null) !== (adminOperationHash === null)) {
    throw new Error('Task reset completion history integrity check failed.');
  }
  const evidence = [row.evidence_provider, row.evidence_board_id, row.evidence_post_id,
    row.evidence_created_at, row.evidence_author_full_name];
  if (evidence.some((value) => value !== null) && evidence.some((value) => value === null)) {
    throw new Error('Task reset completion history integrity check failed.');
  }
  return { completion_id: requiredId(row.completion_id, 'completion ID'),
    event_sequence: requiredPositiveIntegerText(row.event_sequence, 'completion event sequence'),
    completed_at: requiredDate(row.completed_at, 'completion timestamp'),
    task_instance_id: taskInstanceId,
    task_id_snapshot: requiredId(row.task_id_snapshot, 'completion task ID'),
    task_name_snapshot: row.task_name_snapshot, student_id: requiredId(row.student_id, 'student ID'),
    student_name_snapshot: row.student_name_snapshot,
    reward_snapshot: requiredSafeIntegerText(row.reward_snapshot, 'completion reward'),
    balance_before: requiredSafeIntegerText(row.balance_before, 'completion balance before'),
    balance_after: requiredSafeIntegerText(row.balance_after, 'completion balance after'),
    status: row.status, note: nullableId(row.note, 'completion note'), cycle_id: cycleId,
    cycle_start_at: cycleStartAt, cycle_end_at: cycleEndAt, rule_version: ruleVersion,
    timezone, source, assignment_id: nullableId(row.assignment_id, 'completion assignment ID'),
    transaction_id: nullableId(row.transaction_id, 'completion transaction ID'),
    operation_id: operationId, operation_hash: operationHash,
    admin_operation_id: adminOperationId, admin_operation_hash: adminOperationHash,
    schema_version: 1, evidence_provider: nullableId(row.evidence_provider, 'evidence provider'),
    evidence_board_id: nullableId(row.evidence_board_id, 'evidence board ID'),
    evidence_post_id: nullableId(row.evidence_post_id, 'evidence post ID'),
    evidence_created_at: nullableDate(row.evidence_created_at, 'evidence timestamp'),
    evidence_author_full_name: nullableId(row.evidence_author_full_name, 'evidence author'),
    created_at: requiredDate(row.created_at, 'completion created timestamp') };
}

function validateCompletionSet(rows: readonly Completion[], tasks: ReadonlyMap<string, Task>) {
  validateCompletionIdentities(rows,
    new Map([...tasks.values()].map((task) => [task.task_instance_id, task.task_id])));
}

function validateCompletionIdentities(rows: readonly Completion[], identities: ReadonlyMap<string, string>) {
  const completionIds = new Set<string>(); const sequences = new Set<number>();
  const priorBySubject = new Map<string, Completion>();
  for (const event of [...rows].sort((left, right) => left.event_sequence - right.event_sequence)) {
    const ordinaryPair = event.operation_id !== null && event.operation_hash !== null;
    const adminPair = event.admin_operation_id !== null && event.admin_operation_hash !== null;
    const evidence = [event.evidence_provider, event.evidence_board_id, event.evidence_post_id,
      event.evidence_created_at, event.evidence_author_full_name];
    const evidenceCount = evidence.filter((value) => value !== null).length;
    const completed = event.completed_at.getTime();
    const created = event.created_at.getTime();
    const cycleStart = event.cycle_start_at?.getTime() ?? Number.NaN;
    const cycleEnd = event.cycle_end_at?.getTime() ?? null;
    if (event.task_instance_id === null || !identities.has(event.task_instance_id)
      || identities.get(event.task_instance_id) !== event.task_id_snapshot
      || completionIds.has(event.completion_id) || sequences.has(event.event_sequence)
      || event.timezone !== 'Asia/Seoul' || event.cycle_start_at === null
      || event.rule_version === null || event.rule_version < 1 || event.cycle_id !== cycleId(event)
      || completed < cycleStart || completed > created
      || (cycleEnd !== null && (cycleEnd <= cycleStart || completed >= cycleEnd))
      || (event.operation_id !== null && !UUID.test(event.operation_id))
      || (event.admin_operation_id !== null && !UUID.test(event.admin_operation_id))) {
      throw new Error('Task reset completion history integrity check failed.');
    }
    if (event.source === 'BANK' && (event.status !== 'COMPLETED'
      || event.reward_snapshot <= 0 || !Number.isSafeInteger(event.balance_before + event.reward_snapshot)
      || event.balance_after !== event.balance_before + event.reward_snapshot
      || event.assignment_id === null || event.transaction_id === null || !ordinaryPair || adminPair)) {
      throw new Error('Task reset completion history integrity check failed.');
    }
    if (event.source === 'ADMIN' && (event.status !== 'COMPLETED'
      || event.reward_snapshot !== 0 || event.balance_before !== event.balance_after
      || ordinaryPair || !adminPair || event.transaction_id !== null)) {
      throw new Error('Task reset completion history integrity check failed.');
    }
    if (event.source === 'CARRY_FORWARD' && (event.status !== 'COMPLETED'
      || event.reward_snapshot !== 0 || event.balance_before !== event.balance_after
      || ordinaryPair || adminPair || event.transaction_id !== null)) {
      throw new Error('Task reset completion history integrity check failed.');
    }
    if (event.source === 'ADMIN_RESET') {
      const cancellation = ordinaryPair && !adminPair && event.transaction_id !== null
        && event.reward_snapshot > 0
        && Number.isSafeInteger(event.balance_before - event.reward_snapshot)
        && event.balance_after === event.balance_before - event.reward_snapshot;
      const administrator = !ordinaryPair && adminPair && event.transaction_id === null
        && event.reward_snapshot === 0 && event.balance_before === event.balance_after;
      if (event.status !== 'CANCELLED' || cancellation === administrator) {
        throw new Error('Task reset completion history integrity check failed.');
      }
    }
    if (evidenceCount !== 0 && (evidenceCount !== evidence.length || event.source !== 'BANK'
      || event.evidence_provider !== 'PADLET' || event.evidence_created_at === null
      || event.evidence_board_id === null
      || !/^[A-Za-z0-9]{16,22}$/.test(event.evidence_board_id)
      || event.evidence_post_id === null
      || !/^[A-Za-z0-9_-]{3,128}$/.test(event.evidence_post_id)
      || event.evidence_author_full_name === null
      || event.evidence_author_full_name.length > 200
      || event.evidence_author_full_name !== event.student_name_snapshot
      || event.evidence_created_at.getTime() < cycleStart
      || (cycleEnd !== null && event.evidence_created_at.getTime() >= cycleEnd)
      || event.evidence_created_at.getTime() > completed)) {
      throw new Error('Task reset completion history integrity check failed.');
    }
    const subject = key(event.task_instance_id, event.student_id);
    const prior = priorBySubject.get(subject);
    if (prior && (prior.event_sequence >= event.event_sequence
      || prior.completed_at.getTime() > event.completed_at.getTime()
      || prior.created_at.getTime() > event.created_at.getTime())) {
      throw new Error('Task reset completion history integrity check failed.');
    }
    priorBySubject.set(subject, event);
    completionIds.add(event.completion_id); sequences.add(event.event_sequence);
  }
}

async function validateCompletionReferences(tx: TenantTransaction, tenantId: string,
  rows: readonly Completion[], assignments: readonly Assignment[],
  expectedGraph?: TransactionGraph, phase = 'initial') {
  const expectedOperations = new Map<string, { hash: string; kind: 'TASK_REWARD' | 'TASK_ADMIN' | 'CANCELLATION' }>();
  const expectedTransactions = new Map<string, { operationId: string; hash: string; kind: 'TASK_REWARD' | 'CANCELLATION' }>();
  for (const event of rows) {
    if (event.operation_id !== null && event.operation_hash !== null) {
      const kind = event.source === 'BANK' ? 'TASK_REWARD' : 'CANCELLATION';
      addReference(expectedOperations, event.operation_id, { hash: event.operation_hash, kind });
      if (event.transaction_id === null) throw new Error('Task reset completion history integrity check failed.');
      addReference(expectedTransactions, event.transaction_id,
        { operationId: event.operation_id, hash: event.operation_hash, kind });
    }
    if (event.admin_operation_id !== null && event.admin_operation_hash !== null) {
      addReference(expectedOperations, event.admin_operation_id,
        { hash: event.admin_operation_hash, kind: 'TASK_ADMIN' });
    }
  }
  for (const assignment of assignments) {
    if (assignment.admin_operation_id !== null && assignment.admin_operation_hash !== null) {
      addReference(expectedOperations, assignment.admin_operation_id,
        { hash: assignment.admin_operation_hash, kind: 'TASK_ADMIN' });
    }
  }
  if (expectedOperations.size > 0) {
    const ids = [...expectedOperations.keys()].sort(compareCanonical);
    const result = await tx.execute(sql`SELECT operation_id, operation_kind, payload_hash
      FROM operations WHERE tenant_id=${tenantId}
      AND operation_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      ORDER BY operation_id`);
    const referenceRows = adapterRows(result, 'referenced operation rowset');
    if (referenceRows.length !== ids.length) throw new Error('Task reset referenced operation integrity check failed.');
    const seen = new Set<string>();
    for (const raw of referenceRows) {
      const row = exactRow(raw, ['operation_id', 'operation_kind', 'payload_hash'],
        'referenced operation evidence');
      const operationId = requiredId(row.operation_id, 'referenced operation ID');
      const expected = expectedOperations.get(operationId);
      if (!expected || seen.has(operationId) || row.operation_kind !== expected.kind
        || row.payload_hash !== expected.hash) {
        throw new Error('Task reset referenced operation integrity check failed.');
      }
      seen.add(operationId);
    }
  }
  const graph = await readTransactionGraph(tx, tenantId,
    [...expectedTransactions.keys()].sort(compareCanonical));
  const transactions = new Map(graph.transactions.map((row) => [row.transaction_id, row]));
  if (expectedGraph !== undefined && snapshot(graph) !== snapshot(expectedGraph)) {
    throw new Error(`Task reset transaction graph ${phase} snapshot integrity check failed.`);
  }
  validateBankTransactionProvenance(rows, transactions);
  if (graph.transactions.some((row) => row.kind === 'CANCELLATION'
    && (row.reverses_transaction_id === null || !transactions.has(row.reverses_transaction_id)))) {
    throw new Error('Task reset transaction graph transaction identity integrity check failed.');
  }
  for (const [transactionId, expected] of expectedTransactions) {
    const row = transactions.get(transactionId);
    if (!row || row.kind !== expected.kind || row.operation_id !== expected.operationId
      || row.operation_hash !== expected.hash) {
      throw new Error(expected.kind === 'TASK_REWARD'
        ? 'Task reset BANK completion transaction provenance integrity check failed.'
        : 'Task reset transaction graph reference integrity check failed.');
    }
  }
  return graph;
}

function validateBankTransactionProvenance(rows: readonly Completion[],
  transactions: ReadonlyMap<string, TransactionGraph['transactions'][number]>) {
  const failure = 'Task reset BANK completion transaction provenance integrity check failed.';
  for (const completion of rows) {
    if (completion.source !== 'BANK') continue;
    const transaction = completion.transaction_id === null
      ? undefined : transactions.get(completion.transaction_id);
    const operationId = completion.operation_id;
    if (transaction === undefined || operationId === null
      || completion.operation_hash === null
      || completion.completion_id !== `task-completion:${operationId}`
      || completion.transaction_id !== `task-reward:${operationId}`
      || transaction.transaction_id !== completion.transaction_id
      || transaction.kind !== 'TASK_REWARD'
      || transaction.student_id !== completion.student_id
      || transaction.student_name_snapshot !== completion.student_name_snapshot
      || transaction.legacy_total_amount !== completion.reward_snapshot
      || transaction.balance_delta !== completion.reward_snapshot
      || transaction.balance_before !== completion.balance_before
      || transaction.balance_after !== completion.balance_after
      || transaction.occurred_at !== completion.completed_at.getTime()
      || transaction.operator_snapshot !== 'bank-task-completion'
      || transaction.legacy_status_snapshot !== 'COMPLETED'
      || transaction.reverses_transaction_id !== null
      || transaction.operation_id !== operationId
      || transaction.operation_hash !== completion.operation_hash
      || transaction.schema_version !== 1) throw new Error(failure);
  }
}

async function readTransactionGraph(tx: TenantTransaction, tenantId: string,
  referencedIds: readonly string[]) {
  const directPredicate = referencedIds.length === 0 ? sql`FALSE`
    : sql`transaction_id IN (
      WITH RECURSIVE captured(transaction_id) AS (
        VALUES ${sql.join(referencedIds.map((id) => sql`(${id})`), sql`, `)}
        UNION
        SELECT candidate.transaction_id FROM captured
        JOIN transactions source ON source.tenant_id=${tenantId}
          AND source.transaction_id=captured.transaction_id
        JOIN transactions candidate ON candidate.tenant_id=${tenantId}
          AND (candidate.transaction_id=source.reverses_transaction_id
            OR candidate.reverses_transaction_id=source.transaction_id)
      ) SELECT transaction_id FROM captured)`;
  const transactionResult = await tx.execute(sql`SELECT tenant_id, transaction_id,
    event_sequence::text AS event_sequence, occurred_at, student_id, student_name_snapshot,
    kind, legacy_total_amount::text AS legacy_total_amount, balance_delta::text AS balance_delta,
    balance_before::text AS balance_before, balance_after::text AS balance_after,
    operator_snapshot, legacy_status_snapshot, reverses_transaction_id, operation_id,
    operation_hash, schema_version, created_at FROM transactions WHERE tenant_id=${tenantId}
    AND (${directPredicate}) ORDER BY transaction_id`);
  const transactions = parseGraphRows(transactionResult, 'transactions',
    (raw) => parseGraphTransaction(raw, tenantId));
  const transactionIds = transactions.map((row) => row.transaction_id);
  const transactionSequences = transactions.map((row) => row.event_sequence);
  const parents = new Set(transactionIds);
  if (parents.size !== transactionIds.length
    || new Set(transactionSequences).size !== transactionSequences.length) {
    throw new Error('Task reset transaction graph transaction identity integrity check failed.');
  }
  const dependentPredicate = transactionIds.length === 0 ? sql`FALSE`
    : sql`transaction_id IN (${sql.join(transactionIds.map((id) => sql`${id}`), sql`, `)})`;
  const itemResult = await tx.execute(sql`SELECT tenant_id, item_id, transaction_id, line_number,
    product_id_snapshot, current_product_id, product_name_snapshot,
    quantity::text AS quantity, unit_price_snapshot::text AS unit_price_snapshot,
    subtotal_snapshot::text AS subtotal_snapshot, regular_unit_price::text AS regular_unit_price,
    regular_total::text AS regular_total, total_quantity::text AS total_quantity,
    paid_quantity::text AS paid_quantity, free_quantity::text AS free_quantity,
    final_total::text AS final_total, total_discount::text AS total_discount,
    adjustments_snapshot, applied_promotions_snapshot, created_at FROM transaction_items
    WHERE tenant_id=${tenantId} AND (${dependentPredicate}) ORDER BY transaction_id, line_number`);
  const adjustmentResult = await tx.execute(sql`SELECT tenant_id, adjustment_id, transaction_id,
    mode, requested_amount::text AS requested_amount, operator_snapshot, legacy_adjustment_id,
    created_at FROM adjustments WHERE tenant_id=${tenantId} AND (${dependentPredicate})
    ORDER BY transaction_id, adjustment_id`);
  const inventoryResult = await tx.execute(sql`SELECT tenant_id, inventory_event_id,
    event_sequence::text AS event_sequence, product_id, transaction_id,
    quantity_delta::text AS quantity_delta, stock_before::text AS stock_before,
    stock_after::text AS stock_after, reason, operation_id, operation_hash, occurred_at, created_at
    FROM inventory_ledger WHERE tenant_id=${tenantId} AND (${dependentPredicate})
    ORDER BY transaction_id, event_sequence`);
  const items = parseGraphRows(itemResult, 'transaction items',
    (raw) => parseGraphItem(raw, tenantId));
  const adjustments = parseGraphRows(adjustmentResult, 'adjustments',
    (raw) => parseGraphAdjustment(raw, tenantId));
  const inventory = parseGraphRows(inventoryResult, 'inventory ledger',
    (raw) => parseGraphInventory(raw, tenantId));
  assertGraphChildren(items, parents, (row) => row.item_id, 'transaction item');
  assertGraphChildren(adjustments, parents, (row) => row.adjustment_id, 'adjustment');
  assertGraphChildren(inventory, parents, (row) => row.inventory_event_id, 'inventory');
  assertLogicalKeys(items, (row) => key(row.transaction_id, String(row.line_number)),
    'transaction item');
  assertLogicalKeys(adjustments, (row) => row.transaction_id, 'adjustment');
  assertLogicalKeys(inventory, (row) => String(row.event_sequence), 'inventory');
  return Object.freeze({
    transactions: Object.freeze([...transactions].sort((a, b) => compareCanonical(a.transaction_id,
      b.transaction_id))),
    items: Object.freeze([...items].sort((a, b) => compareCanonical(a.item_id, b.item_id))),
    adjustments: Object.freeze([...adjustments].sort((a, b) => compareCanonical(a.adjustment_id,
      b.adjustment_id))),
    inventory: Object.freeze([...inventory].sort((a, b) => compareCanonical(a.inventory_event_id,
      b.inventory_event_id))),
  });
}

function parseGraphRows<T>(result: unknown, label: string, parser: (raw: unknown) => T): T[] {
  const rows = adapterRows(result, `transaction graph ${label} rowset`);
  try { return rows.map(parser); } catch (error) {
    if (error instanceof Error && /transaction graph/.test(error.message)) throw error;
    throw new Error(`Task reset transaction graph ${label} integrity check failed.`);
  }
}

function assertGraphChildren<T extends { transaction_id: string }>(rows: readonly T[],
  parents: ReadonlySet<string>, identity: (row: T) => string, label: string) {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = identity(row);
    if (!parents.has(row.transaction_id) || seen.has(id)) {
      throw new Error(`Task reset transaction graph ${label} link integrity check failed.`);
    }
    seen.add(id);
  }
}

function assertLogicalKeys<T>(rows: readonly T[], logicalKey: (row: T) => string, label: string) {
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = logicalKey(row);
    if (seen.has(identity)) {
      throw new Error(`Task reset transaction graph ${label} identity integrity check failed.`);
    }
    seen.add(identity);
  }
}

function parseGraphTransaction(raw: unknown, tenantId: string) {
  const row = exactRow(raw, TRANSACTION_KEYS, 'transaction graph transaction evidence');
  try {
    const occurredAt = requiredDate(row.occurred_at, 'transaction graph occurred timestamp');
    const createdAt = requiredDate(row.created_at, 'transaction graph created timestamp');
    const kind = requiredEnum(row.kind, ['CHECKOUT', 'CANCELLATION', 'ADMIN_ADJUSTMENT',
      'TASK_REWARD', 'LEGACY'] as const, 'transaction kind');
    const legacyTotal = requiredSafeIntegerText(row.legacy_total_amount,
      'transaction graph legacy total');
    const delta = requiredSafeIntegerText(row.balance_delta, 'transaction graph balance delta');
    const before = requiredSafeIntegerText(row.balance_before, 'transaction graph balance before');
    const after = requiredSafeIntegerText(row.balance_after, 'transaction graph balance after');
    const reverses = nullableId(row.reverses_transaction_id, 'transaction graph reversal ID');
    const operationId = nullableId(row.operation_id, 'transaction graph operation ID');
    const operationHash = nullableHash(row.operation_hash, 'transaction graph operation hash');
    if (row.tenant_id !== tenantId || after - before !== delta
      || (kind === 'CANCELLATION') !== (reverses !== null)
      || (operationId === null) !== (operationHash === null)
      || occurredAt.getTime() > createdAt.getTime()) throw new Error('shape');
    return Object.freeze({ tenant_id: tenantId,
      transaction_id: requiredId(row.transaction_id, 'transaction graph transaction ID'),
      event_sequence: requiredPositiveIntegerText(row.event_sequence,
        'transaction graph event sequence'), occurred_at: occurredAt.getTime(),
      student_id: requiredId(row.student_id, 'transaction graph student ID'),
      student_name_snapshot: requiredString(row.student_name_snapshot,
        'transaction graph student name'), kind, legacy_total_amount: legacyTotal,
      balance_delta: delta, balance_before: before, balance_after: after,
      operator_snapshot: requiredString(row.operator_snapshot, 'transaction graph operator'),
      legacy_status_snapshot: nullableString(row.legacy_status_snapshot,
        'transaction graph legacy status'), reverses_transaction_id: reverses,
      operation_id: operationId, operation_hash: operationHash,
      schema_version: requiredPositiveInteger(row.schema_version,
        'transaction graph schema version'), created_at: createdAt.getTime() });
  } catch { throw new Error('Task reset transaction graph transaction integrity check failed.'); }
}

function parseGraphItem(raw: unknown, tenantId: string) {
  const row = exactRow(raw, TRANSACTION_ITEM_KEYS, 'transaction graph item evidence');
  try {
    const quantity = requiredSafeIntegerText(row.quantity, 'transaction graph item quantity');
    const extended = [row.regular_unit_price, row.regular_total, row.total_quantity,
      row.paid_quantity, row.free_quantity, row.final_total, row.total_discount,
      row.adjustments_snapshot, row.applied_promotions_snapshot];
    const count = extended.filter((value) => value !== null).length;
    if (row.tenant_id !== tenantId || quantity < 1 || (count !== 0 && count !== extended.length)) {
      throw new Error('shape');
    }
    const regularUnitPrice = nullableIntegerText(row.regular_unit_price,
      'transaction graph regular price');
    const regularTotal = nullableIntegerText(row.regular_total, 'transaction graph regular total');
    const totalQuantity = nullableIntegerText(row.total_quantity, 'transaction graph total quantity');
    const paidQuantity = nullableIntegerText(row.paid_quantity, 'transaction graph paid quantity');
    const freeQuantity = nullableIntegerText(row.free_quantity, 'transaction graph free quantity');
    const finalTotal = nullableIntegerText(row.final_total, 'transaction graph final total');
    const totalDiscount = nullableIntegerText(row.total_discount, 'transaction graph total discount');
    if (count !== 0 && (regularUnitPrice! < 0 || regularTotal! < 0 || totalQuantity! < 1
      || paidQuantity! < 0 || freeQuantity! < 0 || finalTotal! < 0 || totalDiscount! < 0
      || paidQuantity! + freeQuantity! !== totalQuantity!
      || !Array.isArray(row.adjustments_snapshot) || !Array.isArray(row.applied_promotions_snapshot))) {
      throw new Error('shape');
    }
    return Object.freeze({ tenant_id: tenantId,
      item_id: requiredId(row.item_id, 'transaction graph item ID'),
      transaction_id: requiredId(row.transaction_id, 'transaction graph item transaction ID'),
      line_number: requiredPositiveInteger(row.line_number, 'transaction graph line number'),
      product_id_snapshot: requiredId(row.product_id_snapshot, 'transaction graph product snapshot'),
      current_product_id: nullableId(row.current_product_id, 'transaction graph current product'),
      product_name_snapshot: requiredString(row.product_name_snapshot, 'transaction graph product name'),
      quantity, unit_price_snapshot: requiredSafeIntegerText(row.unit_price_snapshot,
        'transaction graph unit price'), subtotal_snapshot: requiredSafeIntegerText(
        row.subtotal_snapshot, 'transaction graph subtotal'),
      regular_unit_price: regularUnitPrice, regular_total: regularTotal,
      total_quantity: totalQuantity, paid_quantity: paidQuantity, free_quantity: freeQuantity,
      final_total: finalTotal, total_discount: totalDiscount,
      adjustments_snapshot: row.adjustments_snapshot === null ? null
        : canonicalJson(row.adjustments_snapshot, 'transaction graph adjustments snapshot'),
      applied_promotions_snapshot: row.applied_promotions_snapshot === null ? null
        : canonicalJson(row.applied_promotions_snapshot, 'transaction graph promotions snapshot'),
      created_at: requiredDate(row.created_at, 'transaction graph item created timestamp').getTime() });
  } catch { throw new Error('Task reset transaction graph transaction item integrity check failed.'); }
}

function parseGraphAdjustment(raw: unknown, tenantId: string) {
  const row = exactRow(raw, ADJUSTMENT_KEYS, 'transaction graph adjustment evidence');
  try {
    if (row.tenant_id !== tenantId) throw new Error('tenant');
    return Object.freeze({ tenant_id: tenantId,
      adjustment_id: requiredId(row.adjustment_id, 'transaction graph adjustment ID'),
      transaction_id: requiredId(row.transaction_id, 'transaction graph adjustment transaction ID'),
      mode: requiredEnum(row.mode, ['add', 'subtract', 'set'] as const, 'adjustment mode'),
      requested_amount: requiredSafeIntegerText(row.requested_amount,
        'transaction graph requested amount'), operator_snapshot: requiredString(
        row.operator_snapshot, 'transaction graph adjustment operator'),
      legacy_adjustment_id: nullableId(row.legacy_adjustment_id,
        'transaction graph legacy adjustment ID'),
      created_at: requiredDate(row.created_at, 'transaction graph adjustment timestamp').getTime() });
  } catch { throw new Error('Task reset transaction graph adjustment integrity check failed.'); }
}

function parseGraphInventory(raw: unknown, tenantId: string) {
  const row = exactRow(raw, INVENTORY_KEYS, 'transaction graph inventory evidence');
  try {
    const delta = requiredSafeIntegerText(row.quantity_delta, 'transaction graph inventory delta');
    const before = requiredSafeIntegerText(row.stock_before, 'transaction graph stock before');
    const after = requiredSafeIntegerText(row.stock_after, 'transaction graph stock after');
    const operationId = nullableId(row.operation_id, 'transaction graph inventory operation ID');
    const operationHash = nullableHash(row.operation_hash, 'transaction graph inventory operation hash');
    const occurredAt = requiredDate(row.occurred_at, 'transaction graph inventory occurred timestamp');
    const createdAt = requiredDate(row.created_at, 'transaction graph inventory created timestamp');
    if (row.tenant_id !== tenantId || after - before !== delta || before < 0 || after < 0
      || (operationId === null) !== (operationHash === null)
      || occurredAt.getTime() > createdAt.getTime()) throw new Error('shape');
    return Object.freeze({ tenant_id: tenantId,
      inventory_event_id: requiredId(row.inventory_event_id, 'transaction graph inventory ID'),
      event_sequence: requiredPositiveIntegerText(row.event_sequence,
        'transaction graph inventory sequence'),
      product_id: requiredId(row.product_id, 'transaction graph inventory product ID'),
      transaction_id: requiredId(row.transaction_id, 'transaction graph inventory transaction ID'),
      quantity_delta: delta, stock_before: before, stock_after: after,
      reason: requiredEnum(row.reason, ['CHECKOUT', 'CANCELLATION', 'ADMIN_ADJUSTMENT',
        'LEGACY_IMPORT'] as const, 'inventory reason'), operation_id: operationId,
      operation_hash: operationHash, occurred_at: occurredAt.getTime(),
      created_at: createdAt.getTime() });
  } catch { throw new Error('Task reset transaction graph inventory integrity check failed.'); }
}

function addReference<T>(references: Map<string, T>, id: string, value: T) {
  const prior = references.get(id);
  if (prior !== undefined && snapshot(prior) !== snapshot(value)) {
    throw new Error('Task reset referenced operation integrity check failed.');
  }
  references.set(id, value);
}

function validateResetEvent(event: Completion, predecessor: Completion, operationId: string,
  payloadHash: string, now: Date, completionId: string) {
  if (event.completion_id !== completionId || event.completed_at.getTime() !== now.getTime()
    || event.created_at.getTime() !== now.getTime() || event.task_instance_id !== predecessor.task_instance_id
    || event.task_id_snapshot !== predecessor.task_id_snapshot
    || event.task_name_snapshot !== predecessor.task_name_snapshot
    || event.student_id !== predecessor.student_id
    || event.student_name_snapshot !== predecessor.student_name_snapshot
    || event.reward_snapshot !== 0 || event.balance_before !== predecessor.balance_after
    || event.balance_after !== predecessor.balance_after || event.status !== 'CANCELLED'
    || event.note !== 'admin-completion-reset' || event.cycle_id !== predecessor.cycle_id
    || nullableTime(event.cycle_start_at) !== nullableTime(predecessor.cycle_start_at)
    || nullableTime(event.cycle_end_at) !== nullableTime(predecessor.cycle_end_at)
    || event.rule_version !== predecessor.rule_version || event.timezone !== predecessor.timezone
    || event.source !== 'ADMIN_RESET' || event.assignment_id !== predecessor.assignment_id
    || event.transaction_id !== null || event.operation_id !== null || event.operation_hash !== null
    || event.admin_operation_id !== operationId || event.admin_operation_hash !== payloadHash
    || event.evidence_provider !== null || event.evidence_board_id !== null
    || event.evidence_post_id !== null || event.evidence_created_at !== null
    || event.evidence_author_full_name !== null) {
    throw new Error('Task reset reset event integrity check failed.');
  }
}

function taskColumns() {
  return sql`task_instance_id, task_id, current_schedule, pending_schedule,
    schedule_schema_version, version::text AS version, created_at, updated_at, is_active, deleted_at`;
}

async function assertTaskSnapshots(tx: TenantTransaction, tenantId: string,
  expectedByTaskId: ReadonlyMap<string, Task>, phase: string) {
  const expected = [...expectedByTaskId.values()]
    .sort((left, right) => compareCanonical(left.task_instance_id, right.task_instance_id));
  const instanceIds = expected.map((task) => task.task_instance_id);
  const result = await tx.execute(sql`SELECT ${taskColumns()} FROM tasks
    WHERE tenant_id=${tenantId}
    AND task_instance_id IN (${sql.join(instanceIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id`);
  const rows = adapterRows(result, `${phase} task snapshot rowset`);
  if (rows.length !== expected.length) {
    throw new Error(`Task reset ${phase} task snapshot integrity check failed.`);
  }
  const actual = rows.map(parseTask);
  const taskIds = new Set<string>();
  const instanceIdsSeen = new Set<string>();
  for (const task of actual) {
    const bound = expectedByTaskId.get(task.task_id);
    if (!bound || bound.task_instance_id !== task.task_instance_id
      || taskIds.has(task.task_id) || instanceIdsSeen.has(task.task_instance_id)) {
      throw new Error(`Task reset ${phase} task snapshot identity integrity check failed.`);
    }
    taskIds.add(task.task_id);
    instanceIdsSeen.add(task.task_instance_id);
  }
  if (snapshot(actual) !== snapshot(expected)) {
    throw new Error(`Task reset ${phase} task snapshot integrity check failed.`);
  }
}

function parseTask(raw: unknown): Task {
  const row = exactRow(raw, TASK_KEYS, 'task evidence');
  const createdAt = requiredDate(row.created_at, 'task created timestamp');
  const updatedAt = requiredDate(row.updated_at, 'task updated timestamp');
  const deletedAt = row.deleted_at === null ? null : requiredDate(row.deleted_at,
    'task deleted timestamp');
  if (typeof row.is_active !== 'boolean' || updatedAt.getTime() < createdAt.getTime()
    || (deletedAt !== null && (deletedAt.getTime() < updatedAt.getTime() || row.is_active))) {
    throw new Error('Task reset task snapshot integrity check failed.');
  }
  const scheduleSchemaVersion = requiredSafeInteger(row.schedule_schema_version,
    'task schedule schema version');
  if (scheduleSchemaVersion < 1) throw new Error('Task reset task snapshot integrity check failed.');
  return { task_instance_id: requiredId(row.task_instance_id, 'task instance ID'),
    task_id: requiredId(row.task_id, 'task ID'), current_schedule: parseSchedule(row.current_schedule),
    pending_schedule: row.pending_schedule === null ? null : parseSchedule(row.pending_schedule),
    schedule_schema_version: scheduleSchemaVersion,
    version: requiredPositiveIntegerText(row.version, 'task version'), created_at: createdAt,
    updated_at: updatedAt, is_active: row.is_active, deleted_at: deletedAt };
}

function parseSchedule(raw: unknown): TaskSchedule {
  const row = exactRow(raw, ['ruleVersion', 'effectiveFrom', 'timeZone', 'recurrence',
    'resetCompletionOnCycle', 'resetAssignmentOnCycle'], 'schedule evidence');
  if (typeof row.resetCompletionOnCycle !== 'boolean'
    || typeof row.resetAssignmentOnCycle !== 'boolean') {
    throw new Error('Task reset schedule evidence is malformed.');
  }
  const schedule = { ruleVersion: requiredSafeInteger(row.ruleVersion, 'schedule rule version'),
    effectiveFrom: requiredId(row.effectiveFrom, 'schedule effective timestamp'),
    timeZone: requiredId(row.timeZone, 'schedule timezone'), recurrence: parseRecurrence(row.recurrence),
    resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle };
  try { return validateTaskSchedule(schedule); } catch {
    throw new Error('Task reset schedule evidence is malformed.');
  }
}

function parseRecurrence(raw: unknown): TaskSchedule['recurrence'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error('Task reset schedule evidence is malformed.');
  }
  const type = Object.getOwnPropertyDescriptor(raw, 'type');
  if (!type?.enumerable || !Object.hasOwn(type, 'value')) {
    throw new Error('Task reset schedule evidence is malformed.');
  }
  if (type.value === 'NONE') { exactRow(raw, ['type'], 'schedule evidence'); return { type: 'NONE' }; }
  if (type.value === 'DAILY') {
    const row = exactRow(raw, ['type', 'time'], 'schedule evidence');
    return { type: 'DAILY', time: requiredId(row.time, 'schedule recurrence time') };
  }
  if (type.value === 'WEEKLY') {
    const row = exactRow(raw, ['type', 'weekdays', 'time'], 'schedule evidence');
    return { type: 'WEEKLY', weekdays: exactArray(row.weekdays, 1, 7, 'schedule weekdays')
      .map((value) => requiredSafeInteger(value, 'schedule weekday')) as IsoWeekday[],
    time: requiredId(row.time, 'schedule recurrence time') };
  }
  if (type.value === 'MONTHLY') {
    const row = exactRow(raw, ['type', 'dayOfMonth', 'time'], 'schedule evidence');
    return { type: 'MONTHLY', dayOfMonth: requiredSafeInteger(row.dayOfMonth,
      'schedule day of month') as DayOfMonth, time: requiredId(row.time, 'schedule recurrence time') };
  }
  throw new Error('Task reset schedule evidence is malformed.');
}

async function readOperation(tx: TenantTransaction, tenantId: string, operationId: string) {
  const result = await tx.execute(sql`SELECT operation_id, operation_kind, payload_hash, status,
    result_snapshot, finished_at, failure_code, attempt_count::text AS attempt_count,
    started_at, created_at, updated_at FROM operations WHERE tenant_id=${tenantId}
    AND operation_id=${operationId} FOR UPDATE`);
  const rows = adapterRows(result, 'operation rowset');
  if (rows.length > 1) throw new Error('Task reset operation integrity check failed.');
  if (rows.length === 0) return null;
  const row = exactRow(rows[0], OPERATION_KEYS, 'operation evidence');
  if (row.operation_id !== operationId || row.operation_kind !== 'TASK_ADMIN'
    || typeof row.payload_hash !== 'string' || !HASH.test(row.payload_hash)
    || typeof row.status !== 'string' || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(row.status)
    || typeof row.attempt_count !== 'string' || !/^[1-9][0-9]*$/.test(row.attempt_count)) {
    throw new Error('Task reset operation integrity check failed.');
  }
  return { ...row, started_at: requiredDate(row.started_at, 'operation start'),
    created_at: requiredDate(row.created_at, 'operation create'),
    updated_at: requiredDate(row.updated_at, 'operation update'),
    finished_at: row.finished_at === null ? null : requiredDate(row.finished_at, 'operation finish')
  } as Operation;
}

function canonicalInput(raw: DatabaseTaskResetCommandInput): CanonicalInput {
  const row = exactRow(raw, ['operationId', 'taskIds'], 'input');
  if (typeof row.operationId !== 'string' || !UUID.test(row.operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  const values = exactArray(row.taskIds, 1, 100, 'task IDs');
  const ids = values.map((value) => requiredId(value, 'task ID'));
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate task reset task ID.');
  ids.sort(compareCanonical);
  return Object.freeze({ operationId: row.operationId, taskIds: Object.freeze(ids) });
}

function parseResult(raw: unknown): DatabaseTaskResetResult {
  const row = exactRow(raw, ['taskIds', 'resetEventsAppended', 'deletedCount'], 'stored result');
  const taskIds = exactArray(row.taskIds, 1, 100, 'stored task IDs')
    .map((value) => requiredId(value, 'stored task ID'));
  if (new Set(taskIds).size !== taskIds.length
    || taskIds.some((id, index) => index > 0 && compareCanonical(taskIds[index - 1], id) >= 0)
    || !Number.isSafeInteger(row.resetEventsAppended) || !Number.isSafeInteger(row.deletedCount)
    || (row.resetEventsAppended as number) < 0 || row.resetEventsAppended !== row.deletedCount) {
    throw new Error('Task reset stored result integrity check failed.');
  }
  return freezeResult({ taskIds, resetEventsAppended: row.resetEventsAppended as number,
    deletedCount: row.deletedCount as number });
}

function freezeResult(result: DatabaseTaskResetResult): DatabaseTaskResetResult {
  Object.freeze(result.taskIds); return Object.freeze(result);
}

function auditInput(operationId: string, result: DatabaseTaskResetResult,
  identities: readonly TaskIdentity[], occurredAt: Date) {
  return { operationId, eventType: 'TASK_ADMIN_COMPLETED', entityType: 'OPERATION',
    entityId: operationId, redactedDetails: { action: 'COMPLETION_RESET_BATCH',
      taskCount: result.taskIds.length, resetEventCount: result.resetEventsAppended,
      resultHash: sha256(result), taskIdentities: identities }, occurredAt } as const;
}

async function readAuditIdentities(tx: TenantTransaction, tenantId: string, operationId: string,
  result: DatabaseTaskResetResult, occurredAt: Date): Promise<TaskIdentity[]> {
  const query = await tx.execute(sql`SELECT event_id, operation_id, event_type, entity_type,
    entity_id, redacted_details, occurred_at FROM audit_events WHERE tenant_id=${tenantId}
    AND operation_id=${operationId} ORDER BY event_id`);
  const rows = adapterRows(query, 'audit rowset');
  if (rows.length !== 1) throw new Error('Task reset operation audit set integrity check failed.');
  const row = exactRow(rows[0], ['event_id', 'operation_id', 'event_type', 'entity_type',
    'entity_id', 'redacted_details', 'occurred_at'], 'audit evidence');
  if (row.event_id !== operationAuditEventId(operationId, 'TASK_ADMIN_COMPLETED')
    || row.operation_id !== operationId || row.event_type !== 'TASK_ADMIN_COMPLETED'
    || row.entity_type !== 'OPERATION' || row.entity_id !== operationId
    || requiredDate(row.occurred_at, 'audit timestamp').getTime() !== occurredAt.getTime()) {
    throw new Error('Task reset operation audit set integrity check failed.');
  }
  const details = exactRow(row.redacted_details,
    ['action', 'taskCount', 'resetEventCount', 'resultHash', 'taskIdentities'], 'audit details');
  if (details.action !== 'COMPLETION_RESET_BATCH' || details.taskCount !== result.taskIds.length
    || details.resetEventCount !== result.resetEventsAppended || details.resultHash !== sha256(result)) {
    throw new Error('Task reset operation audit integrity check failed.');
  }
  const identities = exactArray(details.taskIdentities, 1, 100, 'audit task identities')
    .map((raw) => {
      const identity = exactRow(raw, ['taskId', 'taskInstanceId'], 'audit task identity');
      return Object.freeze({ taskId: requiredId(identity.taskId, 'audit task ID'),
        taskInstanceId: requiredId(identity.taskInstanceId, 'audit task instance ID') });
    });
  if (identities.length !== result.taskIds.length
    || identities.some((identity, index) => identity.taskId !== result.taskIds[index])
    || new Set(identities.map((identity) => identity.taskInstanceId)).size !== identities.length) {
    throw new Error('Task reset physical identity audit integrity check failed.');
  }
  return identities;
}

async function assertAuditIdentities(tx: TenantTransaction, tenantId: string, operationId: string,
  result: DatabaseTaskResetResult, expected: readonly TaskIdentity[], occurredAt: Date) {
  const actual = await readAuditIdentities(tx, tenantId, operationId, result, occurredAt);
  if (snapshot(actual) !== snapshot(expected)) {
    throw new Error('Task reset physical identity audit integrity check failed.');
  }
}

function adapterRows(rawResult: unknown, label: string): unknown[] {
  if (typeof rawResult !== 'object' || rawResult === null) {
    throw new Error(`Task reset ${label} is malformed.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(rawResult, 'rows');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`Task reset ${label} is malformed.`);
  }
  return exactArray(descriptor.value, 0, 10000, label);
}

function exactArray(raw: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length !== 0) throw new Error(`Task reset ${label} is malformed.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw) as Record<string, PropertyDescriptor>;
  const length = descriptors.length;
  if (!length || length.enumerable || !Object.hasOwn(length, 'value')
    || !Number.isSafeInteger(length.value) || length.value < min || length.value > max) {
    throw new Error(`Task reset ${label} is malformed.`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`Task reset ${label} is malformed.`);
    }
    values.push(descriptor.value);
  }
  if (Object.keys(descriptors).filter((keyName) => keyName !== 'length').length !== length.value) {
    throw new Error(`Task reset ${label} is malformed.`);
  }
  return values;
}

function exactRow<const K extends readonly string[]>(raw: unknown, keys: K, label: string) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error(`Task reset ${label} is malformed.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw); const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((keyName) => !keys.includes(keyName))) {
    throw new Error(`Task reset ${label} is malformed.`);
  }
  for (const keyName of actual) {
    const descriptor = descriptors[keyName];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`Task reset ${label} is malformed.`);
    }
  }
  return raw as { [P in K[number]]: unknown };
}

function assertReturning<const K extends readonly string[]>(rows: readonly unknown[], keys: K,
  expected: { [P in K[number]]: unknown }, label: string) {
  if (rows.length !== 1) throw new Error(`Task reset ${label} integrity check failed.`);
  const row = exactRow(rows[0], keys, `${label} RETURNING evidence`);
  for (const keyName of keys as readonly K[number][]) if (row[keyName] !== expected[keyName]) {
    throw new Error(`Task reset ${label} integrity check failed.`);
  }
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`Task reset ${label} is invalid.`);
  }
  return value;
}
function requiredDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Task reset ${label} is invalid.`);
  }
  return value;
}
function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Task reset ${label} is invalid.`);
  return value as number;
}
function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = requiredSafeInteger(value, label);
  if (parsed < 1) throw new Error(`Task reset ${label} is invalid.`);
  return parsed;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Task reset ${label} is invalid.`);
  return value;
}
function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}
function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : requiredId(value, label);
}
function requiredEnum<const T extends readonly string[]>(value: unknown, values: T,
  label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Task reset ${label} is invalid.`);
  }
  return value as T[number];
}
function requiredSafeIntegerText(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Task reset ${label} is invalid.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Task reset ${label} is invalid.`);
  return number;
}
function requiredPositiveIntegerText(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)
    || !Number.isSafeInteger(Number(value))) throw new Error(`Task reset ${label} is invalid.`);
  return Number(value);
}
function nullableIntegerText(value: unknown, label: string): number | null {
  return value === null ? null : requiredSafeIntegerText(value, label);
}
function nullableHash(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`Task reset ${label} is invalid.`);
  return value;
}
function canonicalJson(value: unknown, label: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Task reset ${label} is malformed.`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(exactArray(value, 0, 10000, label)
      .map((entry) => canonicalJson(entry, label)));
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error(`Task reset ${label} is malformed.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const keyName of Object.keys(descriptors).sort(compareCanonical)) {
    const descriptor = descriptors[keyName];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`Task reset ${label} is malformed.`);
    }
    Object.defineProperty(result, keyName, { enumerable: true, configurable: false,
      writable: false, value: canonicalJson(descriptor.value, label) });
  }
  return Object.freeze(result);
}
function resetEventId(operationId: string, taskInstanceId: string, studentId: string, cycle: string) {
  return `task-completion-admin-reset:${sha256({ domain: 'task-completion-admin-reset-v1',
    operationId, taskInstanceId, studentId, cycleId: cycle })}`;
}
function cycleId(event: Completion) {
  return `v1|${event.task_instance_id}|r${event.rule_version}|${event.cycle_start_at!
    .toISOString().replace(/\.000Z$/, 'Z')}`;
}
function canonicalCompletions(rows: readonly Completion[]) {
  return [...rows].sort((left, right) => left.event_sequence - right.event_sequence);
}
function canonicalAssignments(rows: readonly Assignment[]) {
  return [...rows].sort((left, right) => compareCanonical(left.assignment_id, right.assignment_id));
}
function canonicalAccounts(rows: readonly Account[]) {
  return [...rows].sort((left, right) => compareCanonical(left.student_id, right.student_id));
}
function compareCanonical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function nullableTime(value: Date | null): number | null { return value?.getTime() ?? null; }
function key(...parts: string[]): string { return JSON.stringify(parts); }
function snapshot(value: unknown): string { return JSON.stringify(value); }
function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
