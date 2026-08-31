import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TaskCycle } from '@/domain/taskRecurrence';
import type { TenantTransaction } from '@/server/db/transaction';

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

type Assignment = ReturnType<typeof parseAssignment>;
type Completion = ReturnType<typeof parseCompletion>;
type Mirror = ReturnType<typeof parseMirror>;

export type TaskConfigurationBoundaryMaterialization = Readonly<{
  assignmentEventIds: readonly string[];
  completionEventIds: readonly string[];
}>;

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
  const assignments = (await input.tx.execute(sql`SELECT assignment_id,
    event_sequence::text AS event_sequence, task_id_snapshot, task_instance_id, cycle_id,
    cycle_start_at, cycle_end_at, rule_version, timezone, student_id, event_type, source,
    previous_assignment_id, admin_operation_id, admin_operation_hash, created_at,
    schema_version, note FROM task_assignments WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId}
    ORDER BY student_id, event_sequence FOR UPDATE`)).rows.map(parseAssignment);
  const completions = (await input.tx.execute(sql`SELECT completion_id,
    event_sequence::text AS event_sequence, completed_at, task_instance_id, task_id_snapshot,
    task_name_snapshot, student_id, student_name_snapshot,
    reward_snapshot::text AS reward_snapshot, balance_before::text AS balance_before,
    balance_after::text AS balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
    rule_version, timezone, source, assignment_id, transaction_id, operation_id, operation_hash,
    admin_operation_id, admin_operation_hash, schema_version, evidence_provider,
    evidence_board_id, evidence_post_id, evidence_created_at, evidence_author_full_name, created_at
    FROM task_completions WHERE tenant_id=${input.tenantId}
      AND task_instance_id=${input.taskInstanceId}
    ORDER BY event_sequence FOR UPDATE`)).rows.map(parseCompletion);

  validateEvidence(input, mirrors, assignments, completions);
  // A configuration boundary preserves the mutable availability mirror and its latest
  // ledger state even when the edit happens just after an old natural boundary.
  const oldAssignments = latestBySubject(assignments);
  const oldCompletions = latestBySubject(completions);
  const mirrorIds = new Set(mirrors.map((mirror) => mirror.student_id));
  const assignmentEventIds: string[] = [];
  const carriedAssignmentByStudent = new Map<string, string>();

  for (const studentId of [...mirrorIds].sort(compareText)) {
    const predecessor = oldAssignments.get(studentId);
    if (!predecessor || predecessor.event_type !== 'ASSIGNED') {
      throw new Error('Task cycle materialization availability ownership integrity check failed.');
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
    if (!assignmentId) {
      throw new Error('Task cycle materialization completion ownership integrity check failed.');
    }
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

function validateEvidence(input: Parameters<typeof materializeTaskConfigurationBoundaryCycleInternal>[0],
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
  const assignmentIds = new Set<string>();
  let priorSequence = 0;
  for (const event of [...assignments].sort((a, b) => a.event_sequence - b.event_sequence)) {
    if (event.task_instance_id !== input.taskInstanceId || event.task_id_snapshot !== input.taskId
      || event.timezone !== input.timeZone || event.cycle_id !== cycleId(event)
      || event.event_sequence <= priorSequence || assignmentIds.has(event.assignment_id)) {
      throw new Error('Task cycle materialization assignment evidence integrity check failed.');
    }
    assignmentIds.add(event.assignment_id); priorSequence = event.event_sequence;
  }
  const latest = latestBySubject(assignments);
  for (const [studentId, event] of latest) {
    if ((event.event_type === 'ASSIGNED') !== mirrorIds.has(studentId)) {
      throw new Error('Task cycle materialization availability ownership integrity check failed.');
    }
  }
  for (const studentId of mirrorIds) if (!latest.has(studentId)) {
    throw new Error('Task cycle materialization availability ownership integrity check failed.');
  }
  const completionIds = new Set<string>();
  priorSequence = 0;
  for (const event of completions) {
    if (event.task_instance_id !== input.taskInstanceId || event.task_id_snapshot !== input.taskId
      || event.timezone !== input.timeZone || event.cycle_id !== cycleId(event)
      || event.event_sequence <= priorSequence || completionIds.has(event.completion_id)) {
      throw new Error('Task cycle materialization completion evidence integrity check failed.');
    }
    completionIds.add(event.completion_id); priorSequence = event.event_sequence;
  }
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
  const source = row.source as string;
  const bound = source === 'ADMIN' || source === 'QR';
  if (bound ? (typeof row.admin_operation_id !== 'string'
    || typeof row.admin_operation_hash !== 'string' || !HASH.test(row.admin_operation_hash))
    : (row.admin_operation_id !== null || row.admin_operation_hash !== null)) {
    throw new Error('Task cycle materialization assignment evidence integrity check failed.');
  }
  return { assignment_id: id(row.assignment_id), event_sequence: positive(row.event_sequence),
    task_id_snapshot: id(row.task_id_snapshot), task_instance_id: id(row.task_instance_id),
    cycle_id: id(row.cycle_id), cycle_start_at: date(row.cycle_start_at),
    cycle_end_at: row.cycle_end_at === null ? null : date(row.cycle_end_at),
    rule_version: integer(row.rule_version), timezone: id(row.timezone), student_id: id(row.student_id),
    event_type: row.event_type as 'ASSIGNED' | 'UNASSIGNED', source,
    previous_assignment_id: row.previous_assignment_id === null ? null : id(row.previous_assignment_id),
    admin_operation_id: row.admin_operation_id, admin_operation_hash: row.admin_operation_hash,
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
    admin_operation_hash: adminHash, schema_version: 1, created_at: date(row.created_at) };
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
function assertOne(rows: readonly unknown[], key: string, value: string, label: string) {
  if (rows.length !== 1) throw new Error(`Task cycle materialization ${label} integrity check failed.`);
  const row = exactRow(rows[0], [key] as const, label);
  if (row[key] !== value) throw new Error(`Task cycle materialization ${label} integrity check failed.`);
}
function assignmentMaterializationId(taskInstanceId: string, cycleIdValue: string, studentId: string) {
  return `task-assignment-materialization:${sha256({ domain: 'task-assignment-materialization-v1',
    source: 'CARRY_FORWARD', taskInstanceId, cycleId: cycleIdValue, studentId })}`;
}
function completionMaterializationId(taskInstanceId: string, cycleIdValue: string, studentId: string) {
  return `task-completion-materialization:${sha256({ domain: 'task-completion-materialization-v1',
    source: 'CARRY_FORWARD', taskInstanceId, cycleId: cycleIdValue, studentId })}`;
}
function cycleId(event: { task_instance_id: string; rule_version: number; cycle_start_at: Date }) {
  return `v1|${event.task_instance_id}|r${event.rule_version}|${event.cycle_start_at.toISOString().replace('.000Z', 'Z')}`;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) throw new Error('Invalid identity evidence.');
  return value;
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid timestamp evidence.');
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
function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
