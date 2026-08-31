import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTaskCycle } from '@/domain/taskRecurrence';
import { prepareTaskScheduleEdit, resolveTaskSchedule, validateTaskSchedule } from '@/domain/taskSchedule';
import type { DayOfMonth, IsoWeekday, TaskRecurrence, TaskSchedule } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit, operationAuditEventId } from './operationAudit';
import { materializeTaskConfigurationBoundaryCyclesInternal,
  taskNaturalAssignmentMaterializationId, taskNaturalCompletionMaterializationId } from './taskCycleMaterialization';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const UPDATE_KEYS = ['operationId', 'taskId', 'expectedTaskVersion', 'recurrence', 'timeZone',
  'resetCompletionOnCycle', 'resetAssignmentOnCycle'] as const;
const BATCH_KEYS = ['operationId', 'tasks'] as const;
const TASK_INPUT_KEYS = ['taskId', 'expectedTaskVersion', 'recurrence', 'timeZone',
  'resetCompletionOnCycle', 'resetAssignmentOnCycle'] as const;
const OPERATION_KEYS = ['operation_id', 'operation_kind', 'payload_hash', 'status', 'result_snapshot',
  'finished_at', 'failure_code', 'attempt_count', 'started_at', 'created_at', 'updated_at'] as const;
const MIRROR_KEYS = ['tenant_id', 'task_instance_id', 'student_id', 'created_at'] as const;
const ASSIGNMENT_KEYS = ['tenant_id', 'assignment_id', 'event_sequence', 'task_id_snapshot',
  'task_instance_id', 'cycle_id', 'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone',
  'student_id', 'event_type', 'source', 'previous_assignment_id', 'admin_operation_id',
  'admin_operation_hash', 'created_at', 'schema_version', 'note'] as const;
const COMPLETION_KEYS = ['tenant_id', 'completion_id', 'event_sequence', 'completed_at',
  'task_instance_id', 'task_id_snapshot', 'task_name_snapshot', 'student_id',
  'student_name_snapshot', 'reward_snapshot', 'balance_before', 'balance_after', 'status', 'note',
  'cycle_id', 'cycle_start_at', 'cycle_end_at', 'rule_version', 'timezone', 'source', 'assignment_id',
  'transaction_id', 'operation_id', 'operation_hash', 'admin_operation_id', 'admin_operation_hash',
  'schema_version', 'evidence_provider', 'evidence_board_id', 'evidence_post_id',
  'evidence_created_at', 'evidence_author_full_name', 'created_at'] as const;
const ACCOUNT_KEYS = ['tenant_id', 'student_id', 'balance', 'version', 'updated_at'] as const;
const TRANSACTION_KEYS = ['tenant_id', 'transaction_id', 'event_sequence', 'occurred_at',
  'student_id', 'student_name_snapshot', 'kind', 'legacy_total_amount', 'balance_delta',
  'balance_before', 'balance_after', 'operator_snapshot', 'legacy_status_snapshot',
  'reverses_transaction_id', 'operation_id', 'operation_hash', 'schema_version', 'created_at'] as const;

type RunTenantTransaction = <T>(tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<T>) => Promise<T>;

export type DatabaseTaskScheduleTaskInput = Readonly<{
  taskId: string;
  expectedTaskVersion: number;
  recurrence: TaskRecurrence;
  timeZone: 'Asia/Seoul';
  resetCompletionOnCycle: boolean;
  resetAssignmentOnCycle: boolean;
}>;
export type DatabaseTaskScheduleUpdateInput = Readonly<{
  operationId: string;
}> & DatabaseTaskScheduleTaskInput;
export type DatabaseTaskScheduleBatchUpdateInput = Readonly<{
  operationId: string;
  tasks: readonly DatabaseTaskScheduleTaskInput[];
}>;
export type DatabaseTaskScheduleTaskResult = Readonly<{
  taskId: string;
  taskInstanceId: string;
  changed: boolean;
  versionBefore: number;
  versionAfter: number;
  schedule: TaskSchedule;
  assignmentEventIds: readonly string[];
  completionEventIds: readonly string[];
}>;
export type DatabaseTaskScheduleBatchUpdateSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'SCHEDULE_UPDATE';
  completedAt: string;
  tasks: readonly DatabaseTaskScheduleTaskResult[];
}>;
export type DatabaseTaskScheduleUpdateSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: 'SCHEDULE_UPDATE';
  completedAt: string;
} & DatabaseTaskScheduleTaskResult>;
export type DatabaseTaskScheduleCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

type CanonicalTaskInput = DatabaseTaskScheduleTaskInput;
type CanonicalInput = Readonly<{ operationId: string; tasks: readonly CanonicalTaskInput[] }>;
type Operation = Readonly<{ operation_id: string; operation_kind: string; payload_hash: string;
  status: string; result_snapshot: unknown; finished_at: Date | null; failure_code: string | null;
  attempt_count: string; started_at: Date; created_at: Date; updated_at: Date }>;
type Task = Readonly<{ taskInstanceId: string; taskId: string; currentSchedule: TaskSchedule;
  pendingSchedule: TaskSchedule | null; scheduleSchemaVersion: number; version: number;
  title: string; description: string; reward: number; sortOrder: number;
  prerequisiteTaskInstanceId: string | null; padletBoardId: string | null;
  isActive: boolean; availableFrom: string | null; availableUntil: string | null;
  dueAt: string | null; createdAt: string; updatedAt: string; deletedAt: string | null }>;
type CanonicalEvidenceRow = Readonly<Record<string, string | number | boolean | null>>;
type ConnectedStateSnapshot = Readonly<{ mirrors: readonly CanonicalEvidenceRow[];
  assignments: readonly CanonicalEvidenceRow[]; completions: readonly CanonicalEvidenceRow[];
  accounts: readonly CanonicalEvidenceRow[]; transactions: readonly CanonicalEvidenceRow[] }>;

export function createTaskScheduleUpdatePayloadHash(
  raw: DatabaseTaskScheduleUpdateInput | DatabaseTaskScheduleBatchUpdateInput,
): string {
  const input = 'tasks' in raw ? canonicalBatchInput(raw) : canonicalUpdateInput(raw);
  return payloadHash(input);
}

export function createDatabaseTaskScheduleCommands(dependencies: DatabaseTaskScheduleCommandDependencies) {
  const run = async (input: CanonicalInput): Promise<DatabaseTaskScheduleBatchUpdateSuccess> => {
    const now = dependencies.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Task schedule current timestamp is invalid.');
    }
    const hash = payloadHash(input);
    return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
      const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (existing) return replay(tx, dependencies.tenantId, existing, input, hash);
      const claim = await tx.execute(sql`INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
         started_at, created_at, updated_at)
        VALUES (${dependencies.tenantId}, ${input.operationId}, 'TASK_ADMIN', ${hash},
          'PENDING', 1, ${now}, ${now}, ${now})
        ON CONFLICT (tenant_id, operation_id) DO NOTHING RETURNING operation_id`);
      const claimEvidence = exactArray(claim.rows, 'operation claim rowset');
      if (claimEvidence.length === 0) {
        const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!winner) throw new Error('Task schedule operation claim integrity check failed.');
        return replay(tx, dependencies.tenantId, winner, input, hash);
      }
      assertReturning(claimEvidence, ['operation_id'], { operation_id: input.operationId }, 'operation claim');

      const ids = input.tasks.map((task) => task.taskId);
      const taskRows = await tx.execute(sql`SELECT task_instance_id, task_id, current_schedule,
        pending_schedule, schedule_schema_version, version::text AS version, is_active,
        title, description, reward::text AS reward, sort_order, prerequisite_task_instance_id,
        padlet_board_id, available_from, available_until, due_at, created_at, updated_at, deleted_at FROM tasks
        WHERE tenant_id=${dependencies.tenantId} AND deleted_at IS NULL
          AND task_id IN (${sql.join(ids.map((value) => sql`${value}`), sql`, `)})
        ORDER BY task_instance_id FOR UPDATE`);
      const taskEvidence = exactArray(taskRows.rows, 'task rowset');
      if (taskEvidence.length !== input.tasks.length) throw new Error('Task schedule target not found.');
      const byId = new Map<string, Task>();
      for (const rawTask of taskEvidence) {
        const task = parseTask(rawTask);
        if (!ids.includes(task.taskId) || byId.has(task.taskId)) {
          throw new Error('Task schedule target task integrity check failed.');
        }
        byId.set(task.taskId, task);
      }
      if (input.tasks.some((task) => !byId.has(task.taskId))) throw new Error('Task schedule target not found.');
      for (const requested of input.tasks) {
        if (byId.get(requested.taskId)!.version !== requested.expectedTaskVersion) {
          throw new Error('Task schedule stale task version.');
        }
      }
      const connectedBefore = await captureConnectedState(tx, dependencies.tenantId,
        [...byId.values()].map((task) => task.taskInstanceId), true);

      const expectedTasks = new Map(byId);
      const prepared = input.tasks.map((requested) => {
        const task = byId.get(requested.taskId)!;
        const current = resolveTaskSchedule({ currentSchedule: task.currentSchedule,
          pendingSchedule: task.pendingSchedule, now: now.toISOString() });
        if (current.timeZone !== 'Asia/Seoul') throw new Error('Task schedule timezone integrity check failed.');
        const changed = !sameConfiguration(current, requested);
        let schedule = current;
        if (changed) {
          schedule = prepareTaskScheduleEdit({ currentSchedule: current, recurrence: requested.recurrence,
            timeZone: requested.timeZone, resetCompletionOnCycle: requested.resetCompletionOnCycle,
            resetAssignmentOnCycle: requested.resetAssignmentOnCycle, editedAt: now.toISOString() });
          if (schedule.ruleVersion === current.ruleVersion) schedule = validateTaskSchedule({ ...schedule,
            ruleVersion: current.ruleVersion + 1, effectiveFrom: now.toISOString() });
        }
        return { requested, task, current, schedule, changed,
          oldCycle: getTaskCycle({ taskInstanceId: task.taskInstanceId, schedule: current,
            taskCreatedAt: task.createdAt, now: now.toISOString() }),
          newCycle: getTaskCycle({ taskInstanceId: task.taskInstanceId, schedule,
            taskCreatedAt: task.createdAt, now: now.toISOString() }) };
      });
      const changed = prepared.filter((item) => item.changed);
      if (changed.length > 0) {
        const updated = await tx.execute(sql`UPDATE tasks AS target SET
          current_schedule=requested.schedule, pending_schedule=NULL, schedule_schema_version=1,
          version=target.version+1, updated_at=${now}
          FROM (VALUES ${sql.join(changed.map((item) => sql`(${item.task.taskInstanceId},
            ${JSON.stringify(item.schedule)}::jsonb, ${item.requested.expectedTaskVersion}::bigint)`), sql`, `)})
            AS requested(task_instance_id, schedule, expected_version)
          WHERE target.tenant_id=${dependencies.tenantId}
            AND target.task_instance_id=requested.task_instance_id
            AND target.deleted_at IS NULL AND target.version=requested.expected_version
          RETURNING target.task_instance_id, target.task_id, target.current_schedule,
            target.pending_schedule, target.schedule_schema_version, target.version::text AS version,
            target.is_active, target.title, target.description, target.reward::text AS reward,
            target.sort_order, target.prerequisite_task_instance_id, target.padlet_board_id,
            target.available_from, target.available_until, target.due_at, target.created_at,
            target.updated_at, target.deleted_at`);
        const evidence = exactArray(updated.rows, 'updated task set rowset');
        if (evidence.length !== changed.length) throw new Error('Task schedule optimistic update integrity check failed.');
        const expectedByInstance = new Map(changed.map((item) => {
          const expected = { ...item.task, currentSchedule: item.schedule, pendingSchedule: null,
            scheduleSchemaVersion: 1, version: item.task.version + 1, updatedAt: now.toISOString() };
          expectedTasks.set(item.task.taskId, expected);
          return [item.task.taskInstanceId, expected] as const;
        }));
        for (const raw of evidence) {
          const actual = parseTask(raw); const expected = expectedByInstance.get(actual.taskInstanceId);
          if (!expected || sha256(actual) !== sha256(expected)) {
            throw new Error('Task schedule optimistic update integrity check failed.');
          }
          expectedByInstance.delete(actual.taskInstanceId);
        }
        if (expectedByInstance.size) throw new Error('Task schedule optimistic update integrity check failed.');
      }
      const materialized = changed.length === 0 ? []
        : await materializeTaskConfigurationBoundaryCyclesInternal({ tx, tenantId: dependencies.tenantId,
          targets: changed.map((item) => ({ taskId: item.task.taskId,
            taskInstanceId: item.task.taskInstanceId, oldCycle: item.oldCycle,
            oldRuleVersion: item.current.ruleVersion, newCycle: item.newCycle,
            newRuleVersion: item.schedule.ruleVersion, timeZone: 'Asia/Seoul', now })) });
      const materializedByInstance = new Map(materialized.map((item) => [item.taskInstanceId, item]));
      const results: DatabaseTaskScheduleTaskResult[] = prepared.map((item) => {
        const events = materializedByInstance.get(item.task.taskInstanceId);
        if (item.changed !== Boolean(events)) throw new Error('Task schedule materialization target integrity check failed.');
        return freezeTaskResult({ taskId: item.task.taskId, taskInstanceId: item.task.taskInstanceId,
          changed: item.changed, versionBefore: item.task.version,
          versionAfter: item.task.version + (item.changed ? 1 : 0), schedule: item.schedule,
          assignmentEventIds: Object.freeze([...(events?.assignmentEventIds ?? [])].sort(compareText)),
          completionEventIds: Object.freeze([...(events?.completionEventIds ?? [])].sort(compareText)) });
      });
      const result = freezeBatchResult({ ok: true, operationId: input.operationId,
        action: 'SCHEDULE_UPDATE', completedAt: now.toISOString(), tasks: results });
      await verifyTaskSnapshots(tx, dependencies.tenantId, expectedTasks);
      const connectedAfterMaterialization = await verifyConnectedDelta(tx, dependencies.tenantId,
        connectedBefore, result);
      const audit = auditInput(result, now);
      await appendOperationAudit(tx, dependencies.tenantId, audit);
      await assertOperationAudit(tx, dependencies.tenantId, audit);
      await assertOneAudit(tx, dependencies.tenantId, input.operationId);
      const terminal = await tx.execute(sql`UPDATE operations SET status='SUCCEEDED',
        result_snapshot=${JSON.stringify(result)}::jsonb, finished_at=${now}, updated_at=${now}
        WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
        RETURNING operation_id`);
      assertReturning(terminal.rows, ['operation_id'], { operation_id: input.operationId }, 'terminal operation');
      const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
      if (!stored) throw new Error('Task schedule terminal operation integrity check failed.');
      await verifyTaskSnapshots(tx, dependencies.tenantId, expectedTasks);
      await verifyConnectedSnapshot(tx, dependencies.tenantId, connectedAfterMaterialization,
        result.tasks.map((task) => task.taskInstanceId));
      return replay(tx, dependencies.tenantId, stored, input, hash);
    });
  };
  return {
    async updateBatch(raw: DatabaseTaskScheduleBatchUpdateInput) {
      return run(canonicalBatchInput(raw));
    },
    async update(raw: DatabaseTaskScheduleUpdateInput): Promise<DatabaseTaskScheduleUpdateSuccess> {
      const batch = await run(canonicalUpdateInput(raw));
      return freezeSingleResult(batch);
    },
  };
}

async function replay(tx: TenantTransaction, tenantId: string, operation: Operation,
  input: CanonicalInput, hash: string): Promise<DatabaseTaskScheduleBatchUpdateSuccess> {
  if (operation.operation_kind !== 'TASK_ADMIN' || operation.payload_hash !== hash) {
    throw new Error('Task schedule operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || operation.failure_code !== null
    || operation.attempt_count !== '1' || operation.finished_at === null
    || operation.started_at.getTime() !== operation.created_at.getTime()
    || operation.finished_at.getTime() !== operation.updated_at.getTime()
    || operation.started_at > operation.finished_at) {
    throw new Error('Task schedule operation is not replayable.');
  }
  const result = parseBatchResult(operation.result_snapshot);
  if (result.operationId !== input.operationId || result.completedAt !== operation.finished_at.toISOString()
    || result.tasks.length !== input.tasks.length) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  for (let index = 0; index < input.tasks.length; index += 1) {
    const requested = input.tasks[index]; const saved = result.tasks[index];
    if (saved.taskId !== requested.taskId || saved.versionBefore !== requested.expectedTaskVersion
      || saved.versionAfter !== saved.versionBefore + (saved.changed ? 1 : 0)
      || !sameConfiguration(saved.schedule, requested)) {
      throw new Error('Task schedule stored result integrity check failed.');
    }
  }
  await verifyPhysicalTaskBindings(tx, tenantId, result);
  await verifyMaterializationIds(tx, tenantId, result);
  await assertOperationAudit(tx, tenantId, auditInput(result, operation.finished_at));
  await assertOneAudit(tx, tenantId, input.operationId);
  return result;
}

async function verifyTaskSnapshots(tx: TenantTransaction, tenantId: string,
  expectedByBusinessId: ReadonlyMap<string, Task>) {
  const instances = [...expectedByBusinessId.values()].map((task) => task.taskInstanceId);
  const rows = await tx.execute(sql`SELECT task_instance_id, task_id, current_schedule,
    pending_schedule, schedule_schema_version, version::text AS version, is_active,
    title, description, reward::text AS reward, sort_order, prerequisite_task_instance_id,
    padlet_board_id, available_from, available_until, due_at, created_at, updated_at, deleted_at
    FROM tasks WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id`);
  const taskEvidence = exactArray(rows.rows, 'task snapshot rowset');
  if (taskEvidence.length !== expectedByBusinessId.size) {
    throw new Error('Task schedule task state integrity check failed.');
  }
  const expected = new Map([...expectedByBusinessId.values()]
    .map((task) => [task.taskInstanceId, task] as const));
  for (const raw of taskEvidence) {
    const actual = parseTask(raw);
    const task = expected.get(actual.taskInstanceId);
    if (!task || sha256(actual) !== sha256(task)) {
      throw new Error('Task schedule task state integrity check failed.');
    }
    expected.delete(actual.taskInstanceId);
  }
  if (expected.size) throw new Error('Task schedule task state integrity check failed.');
}

async function captureConnectedState(tx: TenantTransaction, tenantId: string,
  taskInstanceIds: readonly string[], lock: boolean): Promise<ConnectedStateSnapshot> {
  const instances = [...taskInstanceIds].sort(compareText);
  const lockRows = lock ? sql` FOR UPDATE` : sql``;
  const mirrorResult = await tx.execute(sql`SELECT tenant_id::text AS tenant_id,
    task_instance_id, student_id, created_at FROM task_allowed_students
    WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id, student_id${lockRows}`);
  const assignmentResult = await tx.execute(sql`SELECT tenant_id::text AS tenant_id, assignment_id,
    event_sequence::text AS event_sequence, task_id_snapshot, task_instance_id, cycle_id,
    cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
    previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
    schema_version, note FROM task_assignments WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id, event_sequence${lockRows}`);
  const completionResult = await tx.execute(sql`SELECT tenant_id::text AS tenant_id, completion_id,
    event_sequence::text AS event_sequence, completed_at, task_instance_id, task_id_snapshot,
    task_name_snapshot, student_id, student_name_snapshot, reward_snapshot::text AS reward_snapshot,
    balance_before::text AS balance_before, balance_after::text AS balance_after, status, note,
    cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id,
    transaction_id, operation_id, operation_hash, admin_operation_id, admin_operation_hash,
    schema_version, evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
    evidence_author_full_name, created_at FROM task_completions WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id, event_sequence${lockRows}`);
  const mirrors = canonicalEvidenceRows(mirrorResult.rows, MIRROR_KEYS, 'connected mirror rowset');
  const assignments = canonicalEvidenceRows(assignmentResult.rows, ASSIGNMENT_KEYS,
    'connected assignment rowset');
  const completions = canonicalEvidenceRows(completionResult.rows, COMPLETION_KEYS,
    'connected completion rowset');
  const instanceSet = new Set(instances); const students = new Set<string>();
  assertConnectedRelation(mirrors, tenantId, 'task_instance_id', instanceSet, 'student_id', students);
  assertConnectedRelation(assignments, tenantId, 'task_instance_id', instanceSet, 'student_id', students);
  assertConnectedRelation(completions, tenantId, 'task_instance_id', instanceSet, 'student_id', students);
  assertUniqueEvidence(mirrors, (row) => `${row.task_instance_id}\u0000${row.student_id}`);
  assertUniqueEvidence(assignments, (row) => row.assignment_id);
  assertUniqueEvidence(completions, (row) => row.completion_id);

  const studentIds = [...students].sort(compareText);
  const accountResult = studentIds.length === 0 ? { rows: [] } : await tx.execute(sql`
    SELECT tenant_id::text AS tenant_id, student_id, balance::text AS balance,
      version::text AS version, updated_at FROM accounts WHERE tenant_id=${tenantId}
      AND student_id IN (${sql.join(studentIds.map((value) => sql`${value}`), sql`, `)})
    ORDER BY student_id${lockRows}`);
  const accounts = canonicalEvidenceRows(accountResult.rows, ACCOUNT_KEYS, 'connected account rowset');
  for (const row of accounts) if (row.tenant_id !== tenantId || typeof row.student_id !== 'string'
    || !students.has(row.student_id)) throw connectedIntegrityError();
  assertUniqueEvidence(accounts, (row) => row.student_id);
  const accountStudents = new Set(accounts.map((row) => row.student_id));
  const requiredAccountStudents = new Set(completions.filter((row) => typeof row.transaction_id === 'string')
    .map((row) => row.student_id));
  if ([...requiredAccountStudents].some((studentId) => !accountStudents.has(studentId))) {
    throw connectedIntegrityError();
  }

  const directTransactionIds = [...new Set(completions.map((row) => row.transaction_id)
    .filter((value): value is string => typeof value === 'string'))].sort(compareText);
  const transactionResult = directTransactionIds.length === 0 ? { rows: [] } : await tx.execute(sql`
    SELECT tenant_id::text AS tenant_id, transaction_id,
      event_sequence::text AS event_sequence, occurred_at, student_id, student_name_snapshot,
      kind, legacy_total_amount::text AS legacy_total_amount, balance_delta::text AS balance_delta,
      balance_before::text AS balance_before, balance_after::text AS balance_after,
      operator_snapshot, legacy_status_snapshot, reverses_transaction_id, operation_id,
      operation_hash, schema_version, created_at FROM transactions WHERE tenant_id=${tenantId}
      AND transaction_id IN (WITH RECURSIVE captured(transaction_id) AS
        (VALUES ${sql.join(directTransactionIds.map((value) => sql`(${value})`), sql`, `)} UNION
         SELECT candidate.transaction_id FROM captured
         JOIN transactions source ON source.tenant_id=${tenantId}
           AND source.transaction_id=captured.transaction_id
         JOIN transactions candidate ON candidate.tenant_id=${tenantId}
           AND (candidate.transaction_id=source.reverses_transaction_id
             OR candidate.reverses_transaction_id=source.transaction_id))
        SELECT transaction_id FROM captured) ORDER BY transaction_id${lockRows}`);
  const transactions = canonicalEvidenceRows(transactionResult.rows, TRANSACTION_KEYS,
    'connected transaction rowset');
  assertReferencedTransactions(transactions, tenantId, directTransactionIds);
  return Object.freeze({ mirrors, assignments, completions, accounts, transactions });
}

async function verifyConnectedDelta(tx: TenantTransaction, tenantId: string,
  before: ConnectedStateSnapshot, result: DatabaseTaskScheduleBatchUpdateSuccess) {
  const instances = result.tasks.map((task) => task.taskInstanceId);
  const actual = await captureConnectedState(tx, tenantId, instances, false);
  if (sha256(actual.mirrors) !== sha256(before.mirrors)
    || sha256(actual.accounts) !== sha256(before.accounts)
    || sha256(actual.transactions) !== sha256(before.transactions)) throw connectedIntegrityError();
  assertEvidenceDelta(before.assignments, actual.assignments, 'assignment_id',
    result.tasks.flatMap((task) => [...task.assignmentEventIds]),
    (row) => assertMaterializedAssignment(row, before.assignments, result));
  assertEvidenceDelta(before.completions, actual.completions, 'completion_id',
    result.tasks.flatMap((task) => [...task.completionEventIds]),
    (row) => assertMaterializedCompletion(row, before, actual.assignments, result));
  return actual;
}

async function verifyConnectedSnapshot(tx: TenantTransaction, tenantId: string,
  expected: ConnectedStateSnapshot, taskInstanceIds: readonly string[]) {
  const actual = await captureConnectedState(tx, tenantId, taskInstanceIds, false);
  if (sha256(actual) !== sha256(expected)) throw connectedIntegrityError();
}

function assertEvidenceDelta(before: readonly CanonicalEvidenceRow[],
  actual: readonly CanonicalEvidenceRow[], identity: string, expectedAdditionIds: readonly string[],
  validateAddition: (row: CanonicalEvidenceRow) => void) {
  const old = new Map(before.map((row) => [row[identity], row] as const));
  const additions = new Set(expectedAdditionIds);
  if (old.size !== before.length || additions.size !== expectedAdditionIds.length
    || actual.length !== before.length + additions.size) throw connectedIntegrityError();
  for (const row of actual) {
    const key = row[identity];
    if (typeof key !== 'string') throw connectedIntegrityError();
    const prior = old.get(key);
    if (prior) {
      if (sha256(row) !== sha256(prior)) throw connectedIntegrityError();
      old.delete(key);
    } else if (!additions.delete(key)) throw connectedIntegrityError();
    else validateAddition(row);
  }
  if (old.size || additions.size) throw connectedIntegrityError();
}

function assertMaterializedAssignment(row: CanonicalEvidenceRow,
  before: readonly CanonicalEvidenceRow[], result: DatabaseTaskScheduleBatchUpdateSuccess) {
  const task = result.tasks.find((candidate) => candidate.taskInstanceId === row.task_instance_id);
  if (!task || typeof row.student_id !== 'string') throw connectedIntegrityError();
  const cycle = getTaskCycle({ taskInstanceId: task.taskInstanceId, schedule: task.schedule,
    taskCreatedAt: result.completedAt, now: result.completedAt });
  const cycleStart = new Date(cycle.startsAt).toISOString();
  const cycleEnd = cycle.endsAt === null ? null : new Date(cycle.endsAt).toISOString();
  const predecessor = before.find((candidate) => candidate.assignment_id === row.previous_assignment_id);
  if (!predecessor || predecessor.task_instance_id !== task.taskInstanceId
    || predecessor.task_id_snapshot !== task.taskId || predecessor.student_id !== row.student_id
    || predecessor.event_type !== 'ASSIGNED' || typeof predecessor.rule_version !== 'number'
    || predecessor.rule_version >= task.schedule.ruleVersion
    || typeof predecessor.cycle_start_at !== 'string'
    || new Date(predecessor.cycle_start_at).getTime() >= new Date(cycleStart).getTime()
    || (predecessor.cycle_end_at !== null && (typeof predecessor.cycle_end_at !== 'string'
      || new Date(predecessor.cycle_end_at).getTime() <= new Date(cycleStart).getTime()))) {
    throw connectedIntegrityError();
  }
  assertCanonicalFields(row, {
    assignment_id: taskNaturalAssignmentMaterializationId(task.taskInstanceId, cycle.cycleId, row.student_id),
    task_id_snapshot: task.taskId, task_instance_id: task.taskInstanceId, cycle_id: cycle.cycleId,
    cycle_start_at: cycleStart, cycle_end_at: cycleEnd, rule_version: task.schedule.ruleVersion,
    timezone: 'Asia/Seoul', event_type: 'ASSIGNED', source: 'CARRY_FORWARD',
    previous_assignment_id: predecessor.assignment_id, admin_operation_id: null,
    admin_operation_hash: null, created_at: result.completedAt, schema_version: 1, note: null,
  });
  if (typeof row.event_sequence !== 'string' || !/^[1-9][0-9]*$/.test(row.event_sequence)) {
    throw connectedIntegrityError();
  }
}

function assertMaterializedCompletion(row: CanonicalEvidenceRow, before: ConnectedStateSnapshot,
  assignments: readonly CanonicalEvidenceRow[], result: DatabaseTaskScheduleBatchUpdateSuccess) {
  const task = result.tasks.find((candidate) => candidate.taskInstanceId === row.task_instance_id);
  if (!task || typeof row.student_id !== 'string') throw connectedIntegrityError();
  const assignment = assignments.find((candidate) => candidate.assignment_id === row.assignment_id);
  const assignmentPredecessor = before.assignments.find((candidate) =>
    candidate.assignment_id === assignment?.previous_assignment_id);
  const candidates = before.completions.filter((candidate) =>
    candidate.task_instance_id === task.taskInstanceId && candidate.student_id === row.student_id
    && candidate.assignment_id === assignmentPredecessor?.assignment_id
    && candidate.cycle_id === assignmentPredecessor?.cycle_id && candidate.status === 'COMPLETED')
    .sort((left, right) => Number(left.event_sequence) - Number(right.event_sequence));
  const predecessor = candidates.at(-1);
  const cycle = getTaskCycle({ taskInstanceId: task.taskInstanceId, schedule: task.schedule,
    taskCreatedAt: result.completedAt, now: result.completedAt });
  const cycleStart = new Date(cycle.startsAt).toISOString();
  const cycleEnd = cycle.endsAt === null ? null : new Date(cycle.endsAt).toISOString();
  if (!assignment || !assignmentPredecessor || !predecessor) throw connectedIntegrityError();
  assertCanonicalFields(row, {
    completion_id: taskNaturalCompletionMaterializationId(task.taskInstanceId, cycle.cycleId, row.student_id),
    completed_at: result.completedAt, task_instance_id: task.taskInstanceId,
    task_id_snapshot: task.taskId, task_name_snapshot: predecessor.task_name_snapshot,
    student_name_snapshot: predecessor.student_name_snapshot, reward_snapshot: '0',
    balance_before: predecessor.balance_after, balance_after: predecessor.balance_after,
    status: 'COMPLETED', note: null, cycle_id: cycle.cycleId, cycle_start_at: cycleStart,
    cycle_end_at: cycleEnd, rule_version: task.schedule.ruleVersion, timezone: 'Asia/Seoul',
    source: 'CARRY_FORWARD', assignment_id: assignment.assignment_id, transaction_id: null,
    operation_id: null, operation_hash: null, admin_operation_id: null, admin_operation_hash: null,
    schema_version: 1, evidence_provider: null, evidence_board_id: null, evidence_post_id: null,
    evidence_created_at: null, evidence_author_full_name: null, created_at: result.completedAt,
  });
  if (typeof row.event_sequence !== 'string' || !/^[1-9][0-9]*$/.test(row.event_sequence)) {
    throw connectedIntegrityError();
  }
}

function assertCanonicalFields(row: CanonicalEvidenceRow,
  expected: Readonly<Record<string, string | number | boolean | null>>) {
  for (const [key, value] of Object.entries(expected)) if (row[key] !== value) {
    throw new Error(`Task schedule connected state integrity check failed (${key}).`);
  }
}

function canonicalEvidenceRows<const K extends readonly string[]>(raw: unknown, keys: K,
  label: string): readonly CanonicalEvidenceRow[] {
  const rows = exactArray(raw, label).map((value) => {
    const row = exactRow(value, keys, label) as Readonly<Record<string, unknown>>;
    const canonical: Record<string, string | number | boolean | null> = {};
    for (const key of keys) canonical[key] = canonicalEvidenceValue(row[key]);
    return Object.freeze(canonical);
  });
  return Object.freeze(rows);
}
function canonicalEvidenceValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isSafeInteger(value))) return value;
  if (value instanceof Date && Object.getPrototypeOf(value) === Date.prototype
    && Reflect.ownKeys(value).length === 0) {
    const time = Date.prototype.getTime.call(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  throw connectedIntegrityError();
}
function assertConnectedRelation(rows: readonly CanonicalEvidenceRow[], tenantId: string,
  instanceKey: string, instances: ReadonlySet<string>, studentKey: string, students: Set<string>) {
  for (const row of rows) {
    const instance = row[instanceKey]; const student = row[studentKey];
    if (row.tenant_id !== tenantId || typeof instance !== 'string' || !instances.has(instance)
      || typeof student !== 'string') throw connectedIntegrityError();
    students.add(student);
  }
}
function assertUniqueEvidence(rows: readonly CanonicalEvidenceRow[],
  identity: (row: CanonicalEvidenceRow) => unknown) {
  const seen = new Set<unknown>();
  for (const row of rows) { const value = identity(row); if (seen.has(value)) throw connectedIntegrityError(); seen.add(value); }
}
function assertReferencedTransactions(rows: readonly CanonicalEvidenceRow[], tenantId: string,
  directIds: readonly string[]) {
  const byId = new Map<string, CanonicalEvidenceRow>();
  for (const row of rows) {
    if (row.tenant_id !== tenantId || typeof row.transaction_id !== 'string'
      || byId.has(row.transaction_id)) throw connectedIntegrityError();
    byId.set(row.transaction_id, row);
  }
  const reachable = new Set<string>(); const pending = [...directIds];
  while (pending.length) {
    const idValue = pending.pop()!; if (reachable.has(idValue)) continue;
    const row = byId.get(idValue); if (!row) throw connectedIntegrityError();
    reachable.add(idValue);
    if (typeof row.reverses_transaction_id === 'string') pending.push(row.reverses_transaction_id);
    for (const candidate of rows) if (candidate.reverses_transaction_id === idValue
      && typeof candidate.transaction_id === 'string') pending.push(candidate.transaction_id);
  }
  if (reachable.size !== rows.length) throw connectedIntegrityError();
}
function connectedIntegrityError() { return new Error('Task schedule connected state integrity check failed.'); }

async function verifyPhysicalTaskBindings(tx: TenantTransaction, tenantId: string,
  result: DatabaseTaskScheduleBatchUpdateSuccess) {
  const instances = result.tasks.map((task) => task.taskInstanceId);
  const rows = await tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
    ORDER BY task_instance_id`);
  const physicalEvidence = exactArray(rows.rows, 'physical task rowset');
  if (physicalEvidence.length !== result.tasks.length) {
    throw new Error('Task schedule physical identity integrity check failed.');
  }
  const expected = new Map(result.tasks.map((task) => [task.taskInstanceId, task.taskId]));
  for (const raw of physicalEvidence) {
    const row = exactRow(raw, ['task_instance_id', 'task_id'], 'physical task evidence');
    const instance = id(row.task_instance_id);
    if (expected.get(instance) !== id(row.task_id)) {
      throw new Error('Task schedule physical identity integrity check failed.');
    }
    expected.delete(instance);
  }
  if (expected.size) throw new Error('Task schedule physical identity integrity check failed.');
}

async function verifyMaterializationIds(tx: TenantTransaction, tenantId: string,
  result: DatabaseTaskScheduleBatchUpdateSuccess) {
  const instances = result.tasks.map((task) => task.taskInstanceId);
  const assignmentRows = await tx.execute(sql`SELECT assignment_id, task_instance_id, cycle_id
    FROM task_assignments WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
      AND source='CARRY_FORWARD' ORDER BY task_instance_id, assignment_id`);
  const completionRows = await tx.execute(sql`SELECT completion_id, task_instance_id, cycle_id
    FROM task_completions WHERE tenant_id=${tenantId}
      AND task_instance_id IN (${sql.join(instances.map((value) => sql`${value}`), sql`, `)})
      AND source='CARRY_FORWARD' ORDER BY task_instance_id, completion_id`);
  const assignments = exactArray(assignmentRows.rows, 'replay assignment rowset').map((raw) => exactRow(raw,
    ['assignment_id', 'task_instance_id', 'cycle_id'], 'replay assignment identity'));
  const completions = exactArray(completionRows.rows, 'replay completion rowset').map((raw) => exactRow(raw,
    ['completion_id', 'task_instance_id', 'cycle_id'], 'replay completion identity'));
  for (const task of result.tasks) {
    if (!task.changed && (task.assignmentEventIds.length || task.completionEventIds.length)) {
      throw new Error('Task schedule no-op materialization integrity check failed.');
    }
    const expectedCycle = cycleId(task.taskInstanceId, task.schedule.ruleVersion, task.schedule.effectiveFrom);
    const assignmentIds = assignments.filter((row) => row.task_instance_id === task.taskInstanceId
      && row.cycle_id === expectedCycle).map((row) => id(row.assignment_id));
    const completionIds = completions.filter((row) => row.task_instance_id === task.taskInstanceId
      && row.cycle_id === expectedCycle).map((row) => id(row.completion_id));
    if (JSON.stringify(assignmentIds) !== JSON.stringify(task.assignmentEventIds)
      || JSON.stringify(completionIds) !== JSON.stringify(task.completionEventIds)) {
      throw new Error('Task schedule materialization set integrity check failed.');
    }
  }
}

function canonicalUpdateInput(raw: DatabaseTaskScheduleUpdateInput): CanonicalInput {
  const row = exactRow(raw, UPDATE_KEYS, 'input');
  return canonicalBatchParts(row.operationId, [{ taskId: row.taskId,
    expectedTaskVersion: row.expectedTaskVersion, recurrence: row.recurrence, timeZone: row.timeZone,
    resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle }]);
}
function canonicalBatchInput(raw: DatabaseTaskScheduleBatchUpdateInput): CanonicalInput {
  const row = exactRow(raw, BATCH_KEYS, 'batch input');
  return canonicalBatchParts(row.operationId, exactArray(row.tasks, 'tasks'));
}
function canonicalBatchParts(operationValue: unknown, rawTasks: readonly unknown[]): CanonicalInput {
  if (typeof operationValue !== 'string' || !UUID.test(operationValue)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  if (rawTasks.length < 1 || rawTasks.length > 20) throw new Error('Task schedule batch requires 1-20 tasks.');
  const tasks = rawTasks.map((raw) => canonicalTask(raw)).sort((a, b) => compareText(a.taskId, b.taskId));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) {
    throw new Error('Task schedule batch contains a duplicate task ID.');
  }
  return Object.freeze({ operationId: operationValue, tasks: Object.freeze(tasks) });
}
function canonicalTask(raw: unknown): CanonicalTaskInput {
  const row = exactRow(raw, TASK_INPUT_KEYS, 'task input');
  const taskId = id(row.taskId); const expectedTaskVersion = integer(row.expectedTaskVersion);
  if (expectedTaskVersion < 1 || expectedTaskVersion >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Task schedule expected version is invalid.');
  }
  if (row.timeZone !== 'Asia/Seoul' || typeof row.resetCompletionOnCycle !== 'boolean'
    || typeof row.resetAssignmentOnCycle !== 'boolean') throw new Error('Task schedule input is invalid.');
  const recurrence = parseRecurrence(row.recurrence);
  const normalized = validateTaskSchedule({ ruleVersion: 1,
    effectiveFrom: '1970-01-01T00:00:00.000Z',
    timeZone: row.timeZone, recurrence, resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle });
  return Object.freeze({ taskId, expectedTaskVersion,
    recurrence: freezeRecurrence(normalized.recurrence),
    timeZone: 'Asia/Seoul', resetCompletionOnCycle: row.resetCompletionOnCycle,
    resetAssignmentOnCycle: row.resetAssignmentOnCycle });
}
function payloadHash(input: CanonicalInput) {
  return sha256({ kind: 'TASK_ADMIN', action: 'SCHEDULE_UPDATE', tasks: input.tasks,
    schemaVersion: 1 });
}
function sameConfiguration(schedule: TaskSchedule, input: CanonicalTaskInput) {
  return sha256({ recurrence: schedule.recurrence, timeZone: schedule.timeZone,
    resetCompletionOnCycle: schedule.resetCompletionOnCycle,
    resetAssignmentOnCycle: schedule.resetAssignmentOnCycle })
    === sha256({ recurrence: input.recurrence, timeZone: input.timeZone,
      resetCompletionOnCycle: input.resetCompletionOnCycle,
      resetAssignmentOnCycle: input.resetAssignmentOnCycle });
}

function parseTask(raw: unknown): Task {
  const row = exactRow(raw, ['task_instance_id', 'task_id', 'current_schedule', 'pending_schedule',
    'schedule_schema_version', 'version', 'is_active', 'title', 'description', 'reward',
    'sort_order', 'prerequisite_task_instance_id', 'padlet_board_id', 'available_from',
    'available_until', 'due_at', 'created_at', 'updated_at', 'deleted_at'], 'task evidence');
  if (row.schedule_schema_version !== 1 || typeof row.is_active !== 'boolean'
    || typeof row.description !== 'string') {
    throw new Error('Task schedule task evidence integrity check failed.');
  }
  const task = { taskInstanceId: id(row.task_instance_id), taskId: id(row.task_id),
    currentSchedule: parseSchedule(row.current_schedule),
    pendingSchedule: row.pending_schedule === null ? null : parseSchedule(row.pending_schedule),
    scheduleSchemaVersion: 1, version: positiveText(row.version), isActive: row.is_active,
    title: id(row.title), description: row.description, reward: safeIntegerText(row.reward),
    sortOrder: integer(row.sort_order), prerequisiteTaskInstanceId: row.prerequisite_task_instance_id
      === null ? null : id(row.prerequisite_task_instance_id),
    padletBoardId: row.padlet_board_id === null ? null : id(row.padlet_board_id),
    availableFrom: nullableDate(row.available_from), availableUntil: nullableDate(row.available_until),
    dueAt: nullableDate(row.due_at), createdAt: date(row.created_at).toISOString(),
    updatedAt: date(row.updated_at).toISOString(), deletedAt: nullableDate(row.deleted_at) };
  if (task.deletedAt !== null || task.createdAt > task.updatedAt) {
    throw new Error('Task schedule task evidence integrity check failed.');
  }
  return task;
}
function parseSchedule(raw: unknown): TaskSchedule {
  const row = exactRow(raw, ['ruleVersion', 'effectiveFrom', 'timeZone', 'recurrence',
    'resetCompletionOnCycle', 'resetAssignmentOnCycle'], 'schedule evidence');
  if (typeof row.resetCompletionOnCycle !== 'boolean' || typeof row.resetAssignmentOnCycle !== 'boolean') {
    throw new Error('Task schedule evidence is malformed.');
  }
  try {
    return validateTaskSchedule({ ruleVersion: integer(row.ruleVersion), effectiveFrom: id(row.effectiveFrom),
      timeZone: id(row.timeZone), recurrence: parseRecurrence(row.recurrence),
      resetCompletionOnCycle: row.resetCompletionOnCycle,
      resetAssignmentOnCycle: row.resetAssignmentOnCycle });
  } catch { throw new Error('Task schedule evidence is malformed.'); }
}
function parseRecurrence(raw: unknown): TaskRecurrence {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error('Task schedule recurrence is malformed.');
  }
  const type = Object.getOwnPropertyDescriptor(raw, 'type');
  if (!type?.enumerable || !Object.hasOwn(type, 'value')) throw new Error('Task schedule recurrence is malformed.');
  if (type.value === 'NONE') { exactRow(raw, ['type'], 'recurrence'); return { type: 'NONE' }; }
  if (type.value === 'DAILY') {
    const row = exactRow(raw, ['type', 'time'], 'recurrence'); return { type: 'DAILY', time: id(row.time) };
  }
  if (type.value === 'WEEKLY') {
    const row = exactRow(raw, ['type', 'time', 'weekdays'], 'recurrence');
    return { type: 'WEEKLY', time: id(row.time),
      weekdays: exactArray(row.weekdays, 'weekdays').map(integer) as IsoWeekday[] };
  }
  if (type.value === 'MONTHLY') {
    const row = exactRow(raw, ['type', 'time', 'dayOfMonth'], 'recurrence');
    return { type: 'MONTHLY', time: id(row.time), dayOfMonth: integer(row.dayOfMonth) as DayOfMonth };
  }
  throw new Error('Task schedule recurrence is malformed.');
}
function parseBatchResult(raw: unknown): DatabaseTaskScheduleBatchUpdateSuccess {
  const row = exactRow(raw, ['ok', 'operationId', 'action', 'completedAt', 'tasks'], 'stored result');
  if (row.ok !== true || row.action !== 'SCHEDULE_UPDATE') throw new Error('Task schedule stored result integrity check failed.');
  const tasks = exactArray(row.tasks, 'stored tasks').map(parseTaskResult);
  if (tasks.length < 1 || tasks.length > 20 || new Set(tasks.map((task) => task.taskId)).size !== tasks.length
    || tasks.some((task, index) => index > 0 && compareText(tasks[index - 1].taskId, task.taskId) >= 0)) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  return freezeBatchResult({ ok: true, operationId: id(row.operationId), action: 'SCHEDULE_UPDATE',
    completedAt: canonicalInstant(row.completedAt), tasks });
}
function parseTaskResult(raw: unknown): DatabaseTaskScheduleTaskResult {
  const row = exactRow(raw, ['taskId', 'taskInstanceId', 'changed', 'versionBefore', 'versionAfter',
    'schedule', 'assignmentEventIds', 'completionEventIds'], 'stored task result');
  if (typeof row.changed !== 'boolean') throw new Error('Task schedule stored result integrity check failed.');
  const result = { taskId: id(row.taskId), taskInstanceId: id(row.taskInstanceId), changed: row.changed,
    versionBefore: integer(row.versionBefore), versionAfter: integer(row.versionAfter),
    schedule: parseSchedule(row.schedule), assignmentEventIds: parseIdArray(row.assignmentEventIds),
    completionEventIds: parseIdArray(row.completionEventIds) };
  if (result.versionAfter !== result.versionBefore + (result.changed ? 1 : 0)
    || (!result.changed && (result.assignmentEventIds.length || result.completionEventIds.length))) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  return freezeTaskResult(result);
}
function parseIdArray(raw: unknown): string[] {
  const values = exactArray(raw, 'stored identities').map(id);
  if (new Set(values).size !== values.length
    || values.some((value, index) => index > 0 && compareText(values[index - 1], value) >= 0)) {
    throw new Error('Task schedule stored result integrity check failed.');
  }
  return values;
}
function freezeRecurrence(recurrence: TaskRecurrence): TaskRecurrence {
  if (recurrence.type === 'WEEKLY') Object.freeze(recurrence.weekdays);
  return Object.freeze(recurrence);
}
function freezeSchedule(schedule: TaskSchedule): TaskSchedule {
  freezeRecurrence(schedule.recurrence); return Object.freeze(schedule);
}
function freezeTaskResult(result: DatabaseTaskScheduleTaskResult): DatabaseTaskScheduleTaskResult {
  freezeSchedule(result.schedule); Object.freeze(result.assignmentEventIds); Object.freeze(result.completionEventIds);
  return Object.freeze(result);
}
function freezeBatchResult(result: DatabaseTaskScheduleBatchUpdateSuccess): DatabaseTaskScheduleBatchUpdateSuccess {
  result.tasks.forEach(freezeTaskResult); Object.freeze(result.tasks); return Object.freeze(result);
}
function freezeSingleResult(batch: DatabaseTaskScheduleBatchUpdateSuccess): DatabaseTaskScheduleUpdateSuccess {
  const task = batch.tasks[0];
  return Object.freeze({ ok: true, operationId: batch.operationId, action: batch.action,
    completedAt: batch.completedAt, ...task });
}

async function readOperation(tx: TenantTransaction, tenantId: string, operationId: string) {
  const rows = await tx.execute(sql`SELECT operation_id, operation_kind, payload_hash, status,
    result_snapshot, finished_at, failure_code, attempt_count::text AS attempt_count,
    started_at, created_at, updated_at FROM operations WHERE tenant_id=${tenantId}
      AND operation_id=${operationId} FOR UPDATE`);
  const operationEvidence = exactArray(rows.rows, 'operation rowset');
  if (operationEvidence.length > 1) throw new Error('Task schedule operation integrity check failed.');
  if (!operationEvidence.length) return null;
  const row = exactRow(operationEvidence[0], OPERATION_KEYS, 'operation evidence');
  if (row.operation_id !== operationId || typeof row.operation_kind !== 'string'
    || typeof row.payload_hash !== 'string' || !HASH.test(row.payload_hash)
    || typeof row.status !== 'string' || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(row.status)
    || typeof row.attempt_count !== 'string' || !/^[1-9][0-9]*$/.test(row.attempt_count)) {
    throw new Error('Task schedule operation integrity check failed.');
  }
  return { ...row, started_at: date(row.started_at), created_at: date(row.created_at),
    updated_at: date(row.updated_at), finished_at: row.finished_at === null ? null : date(row.finished_at) } as Operation;
}
function auditInput(result: DatabaseTaskScheduleBatchUpdateSuccess, occurredAt: Date) {
  return { operationId: result.operationId, eventType: 'TASK_ADMIN_COMPLETED', entityType: 'OPERATION',
    entityId: result.operationId, redactedDetails: { action: 'SCHEDULE_UPDATE',
      taskCount: result.tasks.length, changedTaskCount: result.tasks.filter((task) => task.changed).length,
      assignmentMaterializationCount: result.tasks.reduce((sum, task) => sum + task.assignmentEventIds.length, 0),
      completionMaterializationCount: result.tasks.reduce((sum, task) => sum + task.completionEventIds.length, 0),
      targetBindings: result.tasks.map((task) => ({ taskId: task.taskId,
        taskInstanceId: task.taskInstanceId })), resultHash: sha256(result) }, occurredAt } as const;
}
async function assertOneAudit(tx: TenantTransaction, tenantId: string, operationId: string) {
  const rows = await tx.execute(sql`SELECT event_id FROM audit_events WHERE tenant_id=${tenantId}
    AND operation_id=${operationId} ORDER BY event_id`);
  const auditEvidence = exactArray(rows.rows, 'audit rowset');
  if (auditEvidence.length !== 1) throw new Error('Task schedule audit set integrity check failed.');
  const row = exactRow(auditEvidence[0], ['event_id'], 'audit evidence');
  if (row.event_id !== operationAuditEventId(operationId, 'TASK_ADMIN_COMPLETED')) {
    throw new Error('Task schedule audit set integrity check failed.');
  }
}
function exactRow<const K extends readonly string[]>(raw: unknown, keys: K, label: string) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw); const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  for (const key of actual) if (!descriptors[key].enumerable
    || !Object.hasOwn(descriptors[key], 'value')) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  return raw as { [P in K[number]]: unknown };
}
function exactArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length) throw new Error(`Task schedule ${label} is malformed.`);
  const descriptors = Object.getOwnPropertyDescriptors(raw) as Record<string, PropertyDescriptor>;
  const length = descriptors.length;
  if (!length || length.enumerable
    || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value')) throw new Error(`Task schedule ${label} is malformed.`);
    values.push(descriptor.value);
  }
  if (Object.keys(descriptors).filter((key) => key !== 'length').length !== length.value) {
    throw new Error(`Task schedule ${label} is malformed.`);
  }
  return values;
}
function assertReturning<const K extends readonly string[]>(rows: readonly unknown[], keys: K,
  expected: { [P in K[number]]: unknown }, label: string) {
  const evidence = exactArray(rows, `${label} rowset`);
  if (evidence.length !== 1) throw new Error(`Task schedule ${label} integrity check failed.`);
  const row = exactRow(evidence[0], keys, label);
  for (const key of keys as readonly K[number][]) if (row[key] !== expected[key]) {
    throw new Error(`Task schedule ${label} integrity check failed.`);
  }
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) throw new Error('Task schedule identity is invalid.');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('Task schedule integer is invalid.'); return value as number;
}
function positiveText(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Task schedule version is invalid.');
  }
  return Number(value);
}
function safeIntegerText(value: unknown): number {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)
    || !Number.isSafeInteger(Number(value))) throw new Error('Task schedule integer is invalid.');
  return Number(value);
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Task schedule timestamp is invalid.');
  return value;
}
function nullableDate(value: unknown): string | null {
  return value === null ? null : date(value).toISOString();
}
function canonicalInstant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Task schedule timestamp is invalid.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error('Task schedule timestamp is invalid.');
  return value;
}
function cycleId(taskInstanceId: string, ruleVersion: number, effectiveFrom: string) {
  return `v1|${taskInstanceId}|r${ruleVersion}|${new Date(effectiveFrom).toISOString().replace('.000Z', 'Z')}`;
}
function compareText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
