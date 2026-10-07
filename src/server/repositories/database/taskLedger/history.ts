import 'server-only';

import { sql } from 'drizzle-orm';
import { compareInstants, ledgerTimeline } from '@/domain/taskLedger';
import type { TaskHistoryCause, TaskHistoryDto, TaskHistoryEntryDto } from '@/lib/taskLedgerApi';
import type { TenantTransaction } from '@/server/db/transaction';
import { TEACHER_REWARD_NOTE } from './reward';
import {
  clockNow,
  groupEvents,
  readLedgerEvents,
  readLedgerFrom,
  readLedgerTasks,
  taskWindows,
  TaskLedgerError,
  type LedgerEventRow,
} from './store';

const MAX_ENTRIES = 1500;

/**
 * Why a row was written, for the teacher. `null` hides it: carried states (the move to the
 * ledger, old per-cycle copies) are bookkeeping, not something that happened.
 */
export function historyCause(event: LedgerEventRow): TaskHistoryCause | null {
  const prefix = event.id.split(':', 1)[0];
  if (event.table === 'A') {
    if (event.source === 'QR' || prefix === 'tl-q') return 'QR';
    if (event.source === 'LEGACY_SEED') return 'IMPORTED';
    if (event.source === 'CARRY_FORWARD') return prefix === 'tl-s' ? 'AUTO_RESET' : null;
    return prefix === 'tl-r' ? 'RESET' : 'TEACHER';
  }
  if (event.kind === 'UNCOMPLETED') return event.transactionId ? 'CANCELLED' : 'RESET';
  if (event.source === 'BANK') return event.note === TEACHER_REWARD_NOTE ? 'TEACHER' : 'BANK';
  if (event.source === 'CARRY_FORWARD') return prefix === 'tl-cs' ? 'AUTO_RESET' : null;
  if (event.source === 'ADMIN') return prefix === 'tl-cr' ? 'RESET' : prefix === 'tl-cq' ? 'QR' : 'TEACHER';
  return 'IMPORTED';
}

function rewardOf(event: LedgerEventRow): number | null {
  return event.table === 'C' && event.kind === 'COMPLETED' && event.reward > 0 ? event.reward : null;
}

/** Readable history of one task: every stage change, newest first, with student names. */
export async function readTaskLedgerHistory(tx: TenantTransaction, tenantId: string, taskId: string): Promise<TaskHistoryDto> {
  const [task] = await readLedgerTasks(tx, tenantId, { taskIds: [taskId] });
  if (!task) throw new TaskLedgerError('TASK_NOT_FOUND', '과제를 찾을 수 없어요. 목록을 새로 불러와 주세요.', 404);
  const now = await clockNow(tx);
  const ledgerFrom = await readLedgerFrom(tx, tenantId) ?? now;
  const names = new Map((await tx.execute(sql`SELECT student_id, name FROM students WHERE tenant_id=${tenantId}`)).rows
    .map((row) => [String((row as { student_id: unknown }).student_id), String((row as { name: unknown }).name).trim()]));
  const grouped = groupEvents(await readLedgerEvents(tx, tenantId, null, { taskInstanceIds: [task.taskInstanceId] }));
  const windows = taskWindows(task);
  const entries: TaskHistoryEntryDto[] = [];
  for (const [studentId, events] of grouped.get(task.taskInstanceId) ?? []) {
    // Before the ledger the rows followed per-cycle rules; show them as they were, without derived resets.
    const steps = ledgerTimeline({ events, windows, now, resetsFrom: ledgerFrom });
    for (const step of steps) {
      const cause = step.event ? historyCause(step.event) : 'AUTO_RESET';
      if (cause === null) continue;
      if (step.event && step.previousStage === step.stage && cause !== 'BANK') continue;
      const at = step.event?.table === 'C' && step.event.completedAt ? step.event.completedAt : step.at;
      entries.push({
        id: step.event ? step.event.id : `reset:${studentId}:${step.at}`,
        at: new Date(at).toISOString(),
        studentId,
        studentName: names.get(studentId) ?? studentId,
        stage: step.stage,
        previousStage: step.previousStage,
        cause,
        reward: step.event ? rewardOf(step.event) : null,
      });
    }
  }
  entries.sort((left, right) => compareInstants(right.at, left.at) || left.studentName.localeCompare(right.studentName, 'ko-KR'));
  return { taskId: task.taskId, title: task.title, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}
