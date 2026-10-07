import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  compareInstants,
  iso,
  lastResetAt,
  nextResetAt,
  projectLedgerStage,
  type LedgerEvent,
  type LedgerStageState,
  type ResetWindow,
} from '@/domain/taskLedger';
import { resetWindowsOf, scheduleInForce, storedResetStage, type StoredTaskSchedule } from '@/domain/taskRepeat';
import { validateTaskSchedule } from '@/domain/taskSchedule';
import { isPendingAssignmentNote, type TaskStage } from '@/domain/taskStage';
import type { AdminTaskDto, TaskStudentStageDto } from '@/lib/taskLedgerApi';
import type { TenantTransaction } from '@/server/db/transaction';

/**
 * Rows of the stage ledger reuse the task event tables. Their cycle columns are fixed
 * placeholders: progress has no cycles any more, only the order of events.
 */
export const LEDGER_CYCLE_ID = 'ledger';
export const LEDGER_CYCLE_START = '1970-01-01T00:00:00.000Z';
export const LEDGER_RULE_VERSION = 1;
/** One per class: written when the class's task history was carried into the ledger. */
export const LEDGER_MARKER_OPERATION_ID = 'task-ledger:v1';

export type LedgerTask = Readonly<{
  taskInstanceId: string;
  taskId: string;
  title: string;
  description: string;
  reward: number;
  isActive: boolean;
  sortOrder: number;
  availableFrom: string | null;
  dueAt: string | null;
  prerequisiteTaskInstanceId: string | null;
  prerequisiteTaskId: string | null;
  padletBoardId: string | null;
  currentSchedule: StoredTaskSchedule;
  pendingSchedule: StoredTaskSchedule | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}>;

export type LedgerStudent = Readonly<{ studentId: string; name: string; status: 'ACTIVE' | 'INACTIVE' }>;

export type LedgerEventRow = LedgerEvent & Readonly<{
  table: 'A' | 'C';
  taskInstanceId: string;
  studentId: string;
  source: string | null;
  note: string | null;
  reward: number;
  /** Completions: when it was completed (equal to `at` for ledger rows). */
  completedAt: string | null;
  transactionId: string | null;
}>;

/** Event times keep microseconds: they order a student's events. */
const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
/** Task times leave the server, so they take the standard form (milliseconds, like Date#toISOString). */
const ISO_MS = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export class TaskLedgerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = 'TaskLedgerError';
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A UUID-shaped ID derived from its parts (stable, so a replay writes nothing new). */
export function derivedUuid(...parts: string[]): string {
  const hex = sha256(JSON.stringify(parts));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function clockNow(tx: TenantTransaction): Promise<string> {
  const result = await tx.execute(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${ISO}) AS now`);
  return String((result.rows[0] as { now: string }).now);
}

export async function readLedgerFrom(tx: TenantTransaction, tenantId: string): Promise<string | null> {
  const result = await tx.execute(sql`
    SELECT result_snapshot->>'ledgerFrom' AS ledger_from FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${LEDGER_MARKER_OPERATION_ID} AND status='SUCCEEDED'`);
  const value = (result.rows[0] as { ledger_from?: unknown } | undefined)?.ledger_from;
  return typeof value === 'string' && value ? value : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Task ledger read an unsafe number.');
  return parsed;
}

function fallbackSchedule(createdAt: string): StoredTaskSchedule {
  return { ruleVersion: 1, effectiveFrom: createdAt, timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' },
    resetAssignmentOnCycle: false, resetCompletionOnCycle: false };
}

function parseSchedule(value: unknown, createdAt: string): StoredTaskSchedule | null {
  if (value === null || value === undefined) return null;
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    const schedule = validateTaskSchedule(raw) as StoredTaskSchedule;
    const extra = (raw as { resetStage?: unknown }).resetStage;
    return extra === undefined ? schedule : { ...schedule, resetStage: extra };
  } catch {
    return fallbackSchedule(createdAt);
  }
}

/** Live (not deleted) tasks of the class. `lock` takes their rows in a fixed order. */
export async function readLedgerTasks(tx: TenantTransaction, tenantId: string,
  options: Readonly<{ lock?: boolean; taskInstanceIds?: readonly string[]; taskIds?: readonly string[] }> = {}): Promise<LedgerTask[]> {
  const list = (ids: readonly string[]) => sql.join(ids.length ? ids.map((id) => sql`${id}`) : [sql`NULL`], sql`, `);
  const filter = sql`${options.taskInstanceIds ? sql`AND t.task_instance_id IN (${list(options.taskInstanceIds)})` : sql``}
    ${options.taskIds ? sql`AND t.task_id IN (${list(options.taskIds)})` : sql``}`;
  const result = await tx.execute(sql`
    SELECT t.task_instance_id, t.task_id, t.title, t.description, t.reward::text AS reward, t.is_active, t.sort_order,
           to_char(date_trunc('milliseconds', t.available_from) AT TIME ZONE 'UTC', ${ISO_MS}) AS available_from,
           to_char(date_trunc('milliseconds', t.due_at) AT TIME ZONE 'UTC', ${ISO_MS}) AS due_at,
           t.prerequisite_task_instance_id, p.task_id AS prerequisite_task_id, t.padlet_board_id,
           t.current_schedule, t.pending_schedule,
           to_char(date_trunc('milliseconds', t.created_at) AT TIME ZONE 'UTC', ${ISO_MS}) AS created_at,
           to_char(date_trunc('milliseconds', t.updated_at) AT TIME ZONE 'UTC', ${ISO_MS}) AS updated_at, t.version::text AS version
    FROM tasks t
    LEFT JOIN tasks p ON p.tenant_id=t.tenant_id AND p.task_instance_id=t.prerequisite_task_instance_id AND p.deleted_at IS NULL
    WHERE t.tenant_id=${tenantId} AND t.deleted_at IS NULL ${filter}
    ORDER BY t.task_instance_id
    ${options.lock ? sql`FOR UPDATE OF t` : sql``}`);
  return (result.rows as Record<string, unknown>[]).map((row) => {
    const createdAt = text(row.created_at);
    return {
      taskInstanceId: text(row.task_instance_id),
      taskId: text(row.task_id),
      title: text(row.title),
      description: text(row.description),
      reward: number(row.reward),
      isActive: row.is_active === true,
      sortOrder: number(row.sort_order),
      availableFrom: nullableText(row.available_from),
      dueAt: nullableText(row.due_at),
      prerequisiteTaskInstanceId: nullableText(row.prerequisite_task_instance_id),
      prerequisiteTaskId: nullableText(row.prerequisite_task_id),
      padletBoardId: nullableText(row.padlet_board_id),
      currentSchedule: parseSchedule(row.current_schedule, createdAt) ?? fallbackSchedule(createdAt),
      pendingSchedule: parseSchedule(row.pending_schedule, createdAt),
      createdAt,
      updatedAt: text(row.updated_at),
      version: number(row.version),
    };
  });
}

/** Students of the class that are not deleted. */
export async function readLedgerStudents(tx: TenantTransaction, tenantId: string,
  options: Readonly<{ studentIds?: readonly string[]; lock?: boolean }> = {}): Promise<LedgerStudent[]> {
  const filter = options.studentIds
    ? sql`AND student_id IN (${sql.join(options.studentIds.length ? options.studentIds.map((id) => sql`${id}`) : [sql`NULL`], sql`, `)})`
    : sql``;
  const result = await tx.execute(sql`
    SELECT student_id, name, status FROM students
    WHERE tenant_id=${tenantId} AND deleted_at IS NULL ${filter}
    ORDER BY student_id ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    studentId: text(row.student_id), name: text(row.name).trim(), status: row.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
  }));
}

function toEvent(row: Record<string, unknown>): LedgerEventRow | null {
  const base = {
    id: text(row.id), at: text(row.at), seq: number(row.seq), taskInstanceId: text(row.task_instance_id),
    studentId: text(row.student_id), source: nullableText(row.source), note: nullableText(row.note),
    reward: row.reward === null || row.reward === undefined ? 0 : number(row.reward),
    completedAt: nullableText(row.completed_at), transactionId: nullableText(row.transaction_id),
  };
  if (row.k === 'A') {
    const stage = row.event_type === 'UNASSIGNED' ? 'UNASSIGNED' as const
      : isPendingAssignmentNote(base.note) ? 'PENDING' as const : 'READY' as const;
    return { ...base, table: 'A', kind: 'STAGE', stage };
  }
  if (row.status === 'COMPLETED') return { ...base, table: 'C', kind: 'COMPLETED' };
  if (row.status === 'CANCELLED') return { ...base, table: 'C', kind: 'UNCOMPLETED' };
  return null;
}

/**
 * Stage events of the class written at or after `from` (the ledger start), optionally narrowed.
 * Pass `from = null` to read the whole history (used only for display and the carry-over).
 * Writers serialize on the task rows (readLedgerTasks with `lock`), not on these append-only rows.
 */
export async function readLedgerEvents(tx: TenantTransaction, tenantId: string, from: string | null,
  options: Readonly<{ taskInstanceIds?: readonly string[]; studentId?: string }> = {}): Promise<LedgerEventRow[]> {
  const since = from === null ? sql`` : sql`AND created_at >= ${from}::timestamptz`;
  const tasks = options.taskInstanceIds
    ? sql`AND task_instance_id IN (${sql.join(options.taskInstanceIds.length ? options.taskInstanceIds.map((id) => sql`${id}`) : [sql`NULL`], sql`, `)})`
    : sql``;
  const student = options.studentId === undefined ? sql`` : sql`AND student_id=${options.studentId}`;
  const result = await tx.execute(sql`
    SELECT 'A' AS k, assignment_id AS id, task_instance_id, student_id,
           to_char(created_at AT TIME ZONE 'UTC', ${ISO}) AS at, event_sequence::text AS seq,
           event_type, note, source, NULL::text AS status, NULL::text AS reward, NULL::text AS completed_at, NULL::text AS transaction_id
    FROM task_assignments WHERE tenant_id=${tenantId} ${since} ${tasks} ${student}
    UNION ALL
    SELECT 'C' AS k, completion_id AS id, task_instance_id, student_id,
           to_char(created_at AT TIME ZONE 'UTC', ${ISO}) AS at, event_sequence::text AS seq,
           NULL::text AS event_type, note, source, status, reward_snapshot::text AS reward,
           to_char(completed_at AT TIME ZONE 'UTC', ${ISO}) AS completed_at, transaction_id
    FROM task_completions WHERE tenant_id=${tenantId} AND task_instance_id IS NOT NULL ${since} ${tasks} ${student}`);
  return (result.rows as Record<string, unknown>[]).map(toEvent).filter((event): event is LedgerEventRow => event !== null);
}

export function groupEvents(events: readonly LedgerEventRow[]): Map<string, Map<string, LedgerEventRow[]>> {
  const byTask = new Map<string, Map<string, LedgerEventRow[]>>();
  for (const event of events) {
    const byStudent = byTask.get(event.taskInstanceId) ?? new Map<string, LedgerEventRow[]>();
    const list = byStudent.get(event.studentId) ?? [];
    list.push(event);
    byStudent.set(event.studentId, list);
    byTask.set(event.taskInstanceId, byStudent);
  }
  return byTask;
}

export function taskWindows(task: LedgerTask): ResetWindow[] {
  return resetWindowsOf(task.currentSchedule, task.pendingSchedule);
}

export function stageOf(task: LedgerTask, events: readonly LedgerEventRow[] | undefined, now: string): LedgerStageState {
  return projectLedgerStage({ events: events ?? [], windows: taskWindows(task), now });
}

/** The latest event of a kind for one student, in ledger order. */
export function latestEvent<T extends LedgerEventRow>(events: readonly LedgerEventRow[] | undefined,
  predicate: (event: LedgerEventRow) => event is T): T | null {
  let latest: T | null = null;
  for (const event of events ?? []) {
    if (!predicate(event)) continue;
    if (latest === null || compareInstants(event.at, latest.at) > 0
      || (compareInstants(event.at, latest.at) === 0 && event.table === latest.table && event.seq > latest.seq)) latest = event;
  }
  return latest;
}

export function buildAdminTaskDto(task: LedgerTask, students: readonly LedgerStudent[],
  eventsByStudent: ReadonlyMap<string, readonly LedgerEventRow[]> | undefined, now: string): AdminTaskDto {
  const inForce = scheduleInForce(task.currentSchedule, task.pendingSchedule, now);
  const windows = taskWindows(task);
  const counts: Record<TaskStage, number> = { UNASSIGNED: 0, PENDING: 0, READY: 0, COMPLETED: 0 };
  const rows: TaskStudentStageDto[] = [];
  for (const student of students) {
    const state = stageOf(task, eventsByStudent?.get(student.studentId), now);
    if (student.status !== 'ACTIVE' && state.stage === 'UNASSIGNED') continue;
    if (student.status === 'ACTIVE') counts[state.stage] += 1;
    rows.push({ studentId: student.studentId, stage: state.stage, since: state.since === null ? null : iso(state.since), byReset: state.byReset });
  }
  return {
    taskId: task.taskId,
    taskInstanceId: task.taskInstanceId,
    version: task.version,
    title: task.title,
    description: task.description,
    reward: task.reward,
    isActive: task.isActive,
    sortOrder: task.sortOrder,
    availableFrom: task.availableFrom,
    dueAt: task.dueAt,
    prerequisiteTaskId: task.prerequisiteTaskId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    repeat: {
      recurrence: inForce.recurrence,
      resetStage: storedResetStage(inForce),
      nextResetAt: nextResetAt(windows, now),
      lastResetAt: lastResetAt(windows, now),
    },
    students: rows,
    counts,
  };
}

export function sortTasks<T extends Readonly<{ sortOrder: number; taskId: string }>>(tasks: readonly T[]): T[] {
  return [...tasks].sort((left, right) => left.sortOrder - right.sortOrder
    || left.taskId.localeCompare(right.taskId, 'ko-KR', { numeric: true }));
}
