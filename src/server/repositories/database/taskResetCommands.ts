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
  pending_schedule: TaskSchedule | null; created_at: Date }>;
type Operation = Readonly<{ operation_id: string; operation_kind: string; payload_hash: string;
  status: string; result_snapshot: unknown; finished_at: Date | null; failure_code: string | null;
  attempt_count: string; started_at: Date; created_at: Date; updated_at: Date }>;
type Completion = ReturnType<typeof parseCompletion>;

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
        if (claim.rows.length === 0) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Task reset operation claim integrity check failed.');
          return replay(tx, dependencies.tenantId, winner, input, payloadHash);
        }
        assertReturning(claim.rows, ['operation_id'], { operation_id: input.operationId },
          'operation claim');

        const taskRows = await tx.execute(sql`SELECT task_instance_id, task_id, current_schedule,
          pending_schedule, created_at FROM tasks WHERE tenant_id=${dependencies.tenantId}
          AND deleted_at IS NULL
          AND task_id IN (${sql.join(input.taskIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY task_instance_id FOR UPDATE`);
        if (taskRows.rows.length < input.taskIds.length) throw new Error('Task reset target not found.');
        if (taskRows.rows.length > input.taskIds.length) {
          throw new Error('Task reset target task integrity check failed.');
        }
        const tasks = new Map<string, Task>();
        for (const rawTask of taskRows.rows) {
          const task = parseTask(rawTask);
          if (!input.taskIds.includes(task.task_id) || tasks.has(task.task_id)) {
            throw new Error('Task reset target task integrity check failed.');
          }
          tasks.set(task.task_id, task);
        }
        if (input.taskIds.some((id) => !tasks.has(id))) throw new Error('Task reset target not found.');
        const instances = [...tasks.values()].map((task) => task.task_instance_id)
          .sort(compareCanonical);
        const initial = await readCompletions(tx, dependencies.tenantId, instances, true);
        validateCompletionSet(initial, tasks);
        await validateCompletionReferences(tx, dependencies.tenantId, initial);
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
          if (inserted.rows.length !== 1) {
            throw new Error('Task reset reset event integrity check failed.');
          }
          const event = parseCompletion(inserted.rows[0]);
          validateResetEvent(event, predecessor, input.operationId, payloadHash, now, completionId);
          expected.push(event);
        }

        const result = freezeResult({ taskIds: [...input.taskIds],
          resetEventsAppended: latest.length, deletedCount: latest.length });
        await verifyComplete(tx, dependencies.tenantId, tasks, expected, result,
          input.operationId, payloadHash, now);
        const audit = auditInput(input.operationId, result, now);
        await appendOperationAudit(tx, dependencies.tenantId, audit);
        await assertOperationAudit(tx, dependencies.tenantId, audit);
        await assertOneAudit(tx, dependencies.tenantId, input.operationId);
        const terminal = await tx.execute(sql`UPDATE operations SET status='SUCCEEDED',
          result_snapshot=${JSON.stringify(result)}::jsonb, finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id`);
        assertReturning(terminal.rows, ['operation_id'], { operation_id: input.operationId },
          'terminal operation');
        await verifyComplete(tx, dependencies.tenantId, tasks, expected, result,
          input.operationId, payloadHash, now);
        await assertOperationAudit(tx, dependencies.tenantId, audit);
        await assertOneAudit(tx, dependencies.tenantId, input.operationId);
        const stored = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (!stored) throw new Error('Task reset terminal operation integrity check failed.');
        return replay(tx, dependencies.tenantId, stored, input, payloadHash);
      });
    },
  };
}

async function replay(tx: TenantTransaction, tenantId: string, operation: Operation,
  input: CanonicalInput, payloadHash: string): Promise<DatabaseTaskResetResult> {
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
  const taskRows = await tx.execute(sql`SELECT task_instance_id, task_id FROM tasks
    WHERE tenant_id=${tenantId}
    AND task_id IN (${sql.join(input.taskIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY task_instance_id`);
  const identities = new Map<string, string>();
  for (const raw of taskRows.rows) {
    const row = exactRow(raw, ['task_instance_id', 'task_id'], 'replay task evidence');
    const instance = requiredId(row.task_instance_id, 'replay task instance ID');
    const taskId = requiredId(row.task_id, 'replay task ID');
    if (!input.taskIds.includes(taskId) || identities.has(instance)) {
      throw new Error('Task reset physical identity integrity check failed.');
    }
    identities.set(instance, taskId);
  }
  if (new Set(identities.values()).size !== input.taskIds.length) {
    throw new Error('Task reset physical identity integrity check failed.');
  }
  const instances = [...identities.keys()].sort(compareCanonical);
  const histories = await readCompletions(tx, tenantId, instances, false);
  validateCompletionIdentities(histories, identities);
  await validateCompletionReferences(tx, tenantId, histories);
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
    operation.finished_at));
  await assertOneAudit(tx, tenantId, input.operationId);
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
  tasks: ReadonlyMap<string, Task>, expected: readonly Completion[], result: DatabaseTaskResetResult,
  operationId: string, payloadHash: string, now: Date) {
  const instances = [...tasks.values()].map((task) => task.task_instance_id).sort(compareCanonical);
  const actual = await readCompletions(tx, tenantId, instances, false);
  validateCompletionSet(actual, tasks);
  await validateCompletionReferences(tx, tenantId, actual);
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
  return rows.rows.map(parseCompletion);
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
  rows: readonly Completion[]) {
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
  if (expectedOperations.size > 0) {
    const ids = [...expectedOperations.keys()].sort(compareCanonical);
    const result = await tx.execute(sql`SELECT operation_id, operation_kind, payload_hash
      FROM operations WHERE tenant_id=${tenantId}
      AND operation_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      ORDER BY operation_id`);
    if (result.rows.length !== ids.length) throw new Error('Task reset referenced operation integrity check failed.');
    const seen = new Set<string>();
    for (const raw of result.rows) {
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
  if (expectedTransactions.size > 0) {
    const ids = [...expectedTransactions.keys()].sort(compareCanonical);
    const result = await tx.execute(sql`SELECT transaction_id, kind, operation_id, operation_hash
      FROM transactions WHERE tenant_id=${tenantId}
      AND transaction_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      ORDER BY transaction_id`);
    if (result.rows.length !== ids.length) throw new Error('Task reset referenced transaction integrity check failed.');
    const seen = new Set<string>();
    for (const raw of result.rows) {
      const row = exactRow(raw, ['transaction_id', 'kind', 'operation_id', 'operation_hash'],
        'referenced transaction evidence');
      const transactionId = requiredId(row.transaction_id, 'referenced transaction ID');
      const expected = expectedTransactions.get(transactionId);
      if (!expected || seen.has(transactionId) || row.kind !== expected.kind
        || row.operation_id !== expected.operationId || row.operation_hash !== expected.hash) {
        throw new Error('Task reset referenced transaction integrity check failed.');
      }
      seen.add(transactionId);
    }
  }
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

function parseTask(raw: unknown): Task {
  const row = exactRow(raw, ['task_instance_id', 'task_id', 'current_schedule', 'pending_schedule',
    'created_at'], 'task evidence');
  return { task_instance_id: requiredId(row.task_instance_id, 'task instance ID'),
    task_id: requiredId(row.task_id, 'task ID'), current_schedule: parseSchedule(row.current_schedule),
    pending_schedule: row.pending_schedule === null ? null : parseSchedule(row.pending_schedule),
    created_at: requiredDate(row.created_at, 'task created timestamp') };
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
  if (result.rows.length > 1) throw new Error('Task reset operation integrity check failed.');
  if (result.rows.length === 0) return null;
  const row = exactRow(result.rows[0], OPERATION_KEYS, 'operation evidence');
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

function auditInput(operationId: string, result: DatabaseTaskResetResult, occurredAt: Date) {
  return { operationId, eventType: 'TASK_ADMIN_COMPLETED', entityType: 'OPERATION',
    entityId: operationId, redactedDetails: { action: 'COMPLETION_RESET_BATCH',
      taskCount: result.taskIds.length, resetEventCount: result.resetEventsAppended,
      resultHash: sha256(result) }, occurredAt } as const;
}

async function assertOneAudit(tx: TenantTransaction, tenantId: string, operationId: string) {
  const result = await tx.execute(sql`SELECT event_id FROM audit_events WHERE tenant_id=${tenantId}
    AND operation_id=${operationId} ORDER BY event_id`);
  if (result.rows.length !== 1) throw new Error('Task reset operation audit set integrity check failed.');
  const row = exactRow(result.rows[0], ['event_id'], 'audit evidence');
  if (row.event_id !== operationAuditEventId(operationId, 'TASK_ADMIN_COMPLETED')) {
    throw new Error('Task reset operation audit set integrity check failed.');
  }
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
function nullableHash(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`Task reset ${label} is invalid.`);
  return value;
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
function compareCanonical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function nullableTime(value: Date | null): number | null { return value?.getTime() ?? null; }
function key(...parts: string[]): string { return JSON.stringify(parts); }
function snapshot(value: unknown): string { return JSON.stringify(value); }
function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
