import 'server-only';

import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { createTaskRewardPayloadHash } from '../taskCompletionCommands';
import {
  clockNow,
  derivedUuid,
  LEDGER_CYCLE_ID,
  LEDGER_CYCLE_START,
  latestEvent,
  TaskLedgerError,
  type LedgerEventRow,
  type LedgerEventSource,
  type LedgerStudent,
  type LedgerTask,
} from './store';
import { insertStageEvent, ledgerEventId } from './writes';
import { addTaskTreeDrops } from '../classTree';
import { addTaskPetGrowth } from '../pets';

export const BANK_REWARD_NOTE = 'bank-self-completion';
/** A teacher marked the task done and paid its reward; cancellable like a bank completion. */
export const TEACHER_REWARD_NOTE = 'teacher-completion-reward';

type AssignmentEvent = LedgerEventRow & { kind: 'STAGE'; table: 'A' };

function isAssigned(event: LedgerEventRow): event is AssignmentEvent {
  return event.table === 'A' && event.kind === 'STAGE' && event.stage !== 'UNASSIGNED';
}

/**
 * The assignment a paid completion points to: the student's latest ledger assignment, or —
 * when the student holds the task only through a carried 완료 or an automatic reset — a carried
 * 완료 가능 row written just before the completion (`plannedId`).
 */
export function rewardAssignment(events: LedgerEventSource | undefined, plannedId: string):
  Readonly<{ assignmentId: string; existing: boolean }> {
  const latest = latestEvent(events, isAssigned);
  return latest ? { assignmentId: latest.id, existing: true } : { assignmentId: plannedId, existing: false };
}

export async function writeCarriedAssignmentIfMissing(tx: TenantTransaction, tenantId: string, input: Readonly<{
  assignment: Readonly<{ assignmentId: string; existing: boolean }>;
  task: LedgerTask;
  studentId: string;
}>): Promise<void> {
  if (input.assignment.existing) return;
  await insertStageEvent(tx, tenantId, { id: input.assignment.assignmentId, task: input.task, studentId: input.studentId,
    stage: 'READY', writer: { source: 'CARRY_FORWARD' } });
}

/**
 * A teacher's 완료 with the reward: the same rows a bank completion writes (so the reward can be
 * cancelled from 거래 내역 the same way), marked as the teacher's by its note.
 */
export async function writeTeacherPaidCompletion(tx: TenantTransaction, tenantId: string, input: Readonly<{
  adminOperationId: string;
  task: LedgerTask;
  student: LedgerStudent;
  balance: number;
  events: LedgerEventSource | undefined;
}>): Promise<Readonly<{ balanceAfter: number; completionId: string }>> {
  const rewardOperationId = derivedUuid('task-ledger-reward', input.adminOperationId, input.task.taskInstanceId, input.student.studentId);
  const assignment = rewardAssignment(input.events, ledgerEventId('tl-a', 'reward', rewardOperationId));
  await writeCarriedAssignmentIfMissing(tx, tenantId, { assignment, task: input.task, studentId: input.student.studentId });
  const payloadHash = createTaskRewardPayloadHash({
    taskId: input.task.taskId, taskInstanceId: input.task.taskInstanceId, taskTitle: input.task.title,
    studentId: input.student.studentId, studentName: input.student.name, assignmentId: assignment.assignmentId,
    cycleId: LEDGER_CYCLE_ID, cycleStartsAt: LEDGER_CYCLE_START, cycleEndsAt: null, reward: input.task.reward,
  });
  const balanceAfter = input.balance + input.task.reward;
  if (!Number.isSafeInteger(balanceAfter)) throw new TaskLedgerError('BALANCE_LIMIT', '잔액이 너무 커서 보상을 줄 수 없어요.');
  const at = new Date(await clockNow(tx)).toISOString();
  const transactionId = `task-reward:${rewardOperationId}`;
  const completionId = `task-completion:${rewardOperationId}`;
  const result = { ok: true, operationId: rewardOperationId, completedAt: at, taskId: input.task.taskId,
    taskInstanceId: input.task.taskInstanceId, taskTitle: input.task.title, studentId: input.student.studentId,
    studentName: input.student.name, reward: input.task.reward, balanceBefore: input.balance, balanceAfter,
    cycleId: LEDGER_CYCLE_ID, transactionId, completionId, paidBy: 'TEACHER' };
  await tx.execute(sql`
    INSERT INTO operations (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
      attempt_count, started_at, finished_at, created_at, updated_at)
    VALUES (${tenantId}, ${rewardOperationId}, 'TASK_REWARD', ${payloadHash}, 'SUCCEEDED', ${JSON.stringify(result)}::jsonb,
      1, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)`);
  await tx.execute(sql`
    UPDATE accounts SET balance=${balanceAfter}, version=version+1, updated_at=${at}::timestamptz
    WHERE tenant_id=${tenantId} AND student_id=${input.student.studentId}`);
  await tx.execute(sql`
    INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind, legacy_total_amount,
       balance_delta, balance_before, balance_after, operator_snapshot, legacy_status_snapshot, operation_id,
       operation_hash, schema_version)
    VALUES
      (${tenantId}, ${transactionId}, ${at}::timestamptz, ${input.student.studentId}, ${input.student.name}, 'TASK_REWARD',
       ${input.task.reward}, ${input.task.reward}, ${input.balance}, ${balanceAfter}, 'bank-task-completion', 'COMPLETED',
       ${rewardOperationId}, ${payloadHash}, 1)`);
  await tx.execute(sql`
    INSERT INTO task_completions
      (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot, task_name_snapshot, student_id,
       student_name_snapshot, reward_snapshot, balance_before, balance_after, status, note, cycle_id, cycle_start_at,
       cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id, operation_id, operation_hash,
       schema_version, created_at)
    VALUES
      (${tenantId}, ${completionId}, ${at}::timestamptz, ${input.task.taskInstanceId}, ${input.task.taskId}, ${input.task.title},
       ${input.student.studentId}, ${input.student.name}, ${input.task.reward}, ${input.balance}, ${balanceAfter}, 'COMPLETED',
       ${TEACHER_REWARD_NOTE}, ${LEDGER_CYCLE_ID}, ${LEDGER_CYCLE_START}::timestamptz, NULL, 1, 'Asia/Seoul', 'BANK',
       ${assignment.assignmentId}, ${transactionId}, ${rewardOperationId}, ${payloadHash}, 1, clock_timestamp())`);
  await addTaskTreeDrops(tx, tenantId, { studentId: input.student.studentId, transactionId, operationId: rewardOperationId });
  await addTaskPetGrowth(tx, tenantId, { studentId: input.student.studentId, transactionId, operationId: rewardOperationId });
  return { balanceAfter, completionId };
}
