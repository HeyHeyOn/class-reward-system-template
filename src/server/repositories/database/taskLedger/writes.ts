import 'server-only';

import { sql } from 'drizzle-orm';
import { PENDING_ASSIGNMENT_NOTE, type TaskStage } from '@/domain/taskStage';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  LEDGER_CYCLE_ID,
  LEDGER_CYCLE_START,
  LEDGER_RULE_VERSION,
  sha256,
  type LedgerStudent,
  type LedgerTask,
} from './store';

/** Who wrote an event: a teacher action (bound to its TASK_ADMIN operation) or a carried state. */
export type CarriedWriter = Readonly<{ source: 'CARRY_FORWARD' }>;
export type TeacherWriter = Readonly<{ source: 'ADMIN'; operationId: string; payloadHash: string }>;
export type LedgerWriter = Readonly<{ source: 'ADMIN' | 'QR'; operationId: string; payloadHash: string }> | CarriedWriter;

export const ADMIN_COMPLETION_NOTE = '관리자 완료 표시 (보상 없음)';
export const CARRIED_COMPLETION_NOTE = '이전 기록에서 옮김';
export const RESET_COMPLETION_NOTE = '자동 초기화로 완료';
export const RESET_NOW_COMPLETION_NOTE = '지금 초기화로 완료';

/** Event IDs carry their origin in the prefix (tl-a teacher, tl-q QR, tl-r reset now, tl-s settled automatic reset, tl-c… completions). */
export function ledgerEventId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(JSON.stringify(parts)).slice(0, 40)}`;
}

function binding(writer: LedgerWriter) {
  return writer.source === 'CARRY_FORWARD'
    ? { operationId: null, payloadHash: null }
    : { operationId: writer.operationId, payloadHash: writer.payloadHash };
}

/** Appends 미부여 / 미완료 / 완료 가능 for one student. Returns the event ID. */
export async function insertStageEvent(tx: TenantTransaction, tenantId: string, input: Readonly<{
  id: string;
  task: LedgerTask;
  studentId: string;
  stage: Exclude<TaskStage, 'COMPLETED'>;
  writer: LedgerWriter;
  /** Defaults to the current clock; a settled automatic reset keeps its own time. */
  at?: string;
}>): Promise<string> {
  const bound = binding(input.writer);
  const at = input.at === undefined ? sql`clock_timestamp()` : sql`${input.at}::timestamptz`;
  await tx.execute(sql`
    INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at, cycle_end_at,
       rule_version, timezone, student_id, event_type, source, previous_assignment_id, created_at,
       schema_version, note, admin_operation_id, admin_operation_hash)
    VALUES
      (${tenantId}, ${input.id}, ${input.task.taskId}, ${input.task.taskInstanceId}, ${LEDGER_CYCLE_ID},
       ${LEDGER_CYCLE_START}::timestamptz, NULL, ${LEDGER_RULE_VERSION}, 'Asia/Seoul', ${input.studentId},
       ${input.stage === 'UNASSIGNED' ? 'UNASSIGNED' : 'ASSIGNED'}, ${input.writer.source}, NULL, ${at}, 1,
       ${input.stage === 'PENDING' ? PENDING_ASSIGNMENT_NOTE : null}, ${bound.operationId}, ${bound.payloadHash})`);
  return input.id;
}

/** Appends a 완료 without a reward (teacher, automatic reset carried, or the carry-over). */
export async function insertUnpaidCompletion(tx: TenantTransaction, tenantId: string, input: Readonly<{
  id: string;
  task: LedgerTask;
  student: LedgerStudent;
  balance: number;
  assignmentId: string | null;
  note: string;
  /** Completions have no QR source: a QR 완료 is written as the teacher's. */
  writer: TeacherWriter | CarriedWriter;
  at?: string;
}>): Promise<string> {
  const bound = binding(input.writer);
  const at = input.at === undefined ? sql`clock_timestamp()` : sql`${input.at}::timestamptz`;
  await tx.execute(sql`
    INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot, task_name_snapshot,
       student_id, student_name_snapshot, reward_snapshot, balance_before, balance_after, status, note,
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
       operation_id, operation_hash, schema_version, created_at, admin_operation_id, admin_operation_hash)
    SELECT ${tenantId}, ${input.id}, c.t, ${input.task.taskInstanceId}, ${input.task.taskId}, ${input.task.title},
       ${input.student.studentId}, ${input.student.name}, 0, ${input.balance}, ${input.balance}, 'COMPLETED', ${input.note},
       ${LEDGER_CYCLE_ID}, ${LEDGER_CYCLE_START}::timestamptz, NULL, ${LEDGER_RULE_VERSION}, 'Asia/Seoul',
       ${input.writer.source}, ${input.assignmentId}, NULL, NULL, NULL, 1, c.t, ${bound.operationId}, ${bound.payloadHash}
    FROM (SELECT ${at} AS t) c`);
  return input.id;
}

export async function readBalances(tx: TenantTransaction, tenantId: string, studentIds: readonly string[],
  lock = false): Promise<Map<string, number>> {
  if (studentIds.length === 0) return new Map();
  const result = await tx.execute(sql`
    SELECT student_id, balance::text AS balance FROM accounts
    WHERE tenant_id=${tenantId} AND student_id IN (${sql.join(studentIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY student_id ${lock ? sql`FOR UPDATE` : sql``}`);
  return new Map((result.rows as Array<{ student_id: string; balance: string }>).map((row) => [row.student_id, Number(row.balance)]));
}
