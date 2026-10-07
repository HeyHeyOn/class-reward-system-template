import 'server-only';

import { sql } from 'drizzle-orm';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import { projectLedgerStage } from '@/domain/taskLedger';
import type { TaskStage } from '@/domain/taskStage';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseTaskCycleQueries } from '../taskCycleQueries';
import { readDatabaseTasks } from '../taskQueries';
import {
  clockNow,
  groupEvents,
  LEDGER_MARKER_OPERATION_ID,
  readLedgerEvents,
  readLedgerFrom,
  readLedgerStudents,
  readLedgerTasks,
  sha256,
} from './store';
import {
  CARRIED_COMPLETION_NOTE,
  insertStageEvent,
  insertUnpaidCompletion,
  ledgerEventId,
  readBalances,
} from './writes';

export type RunTenantTransaction = <T>(tenantId: string, run: (tx: TenantTransaction) => Promise<T>) => Promise<T>;

/**
 * Returns the moment this class's task progress started being kept as a plain stage ledger,
 * carrying the earlier (cycle-based) progress over first if that has not happened yet.
 *
 * The carry-over writes, for every live task and every student, the stage the earlier read model
 * showed at that moment — exactly what the teacher saw — as one ledger event. From then on only
 * ledger events (and the task's reset schedule) decide a student's stage; the earlier rows stay
 * untouched as history. It runs once per class, under a class-wide lock.
 */
export async function ensureTaskLedger(input: Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  runTenantSnapshot?: RunTenantTransaction;
}>): Promise<string> {
  const read = input.runTenantSnapshot ?? input.runTenantTransaction;
  const existing = await read(input.tenantId, (tx) => readLedgerFrom(tx, input.tenantId));
  if (existing) return existing;
  return input.runTenantTransaction(input.tenantId, (tx) => carryOverTaskLedger(tx, input.tenantId));
}

/** The carry-over itself, inside the caller's write transaction. Idempotent. */
export async function carryOverTaskLedger(tx: TenantTransaction, tenantId: string): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task-ledger:${tenantId}`}, 0))`);
  const again = await readLedgerFrom(tx, tenantId);
  if (again) return again;

  const ledgerFrom = await clockNow(tx);
  const payloadHash = sha256(`task-ledger-v1:${tenantId}`);
  await tx.execute(sql`
    INSERT INTO operations (tenant_id, operation_id, operation_kind, payload_hash, status, attempt_count,
      started_at, created_at, updated_at)
    VALUES (${tenantId}, ${LEDGER_MARKER_OPERATION_ID}, 'TASK_ADMIN', ${payloadHash}, 'PENDING', 1,
      ${ledgerFrom}::timestamptz, ${ledgerFrom}::timestamptz, ${ledgerFrom}::timestamptz)
    ON CONFLICT (tenant_id, operation_id) DO NOTHING`);

  const tasks = await readLedgerTasks(tx, tenantId, { lock: true });
  const students = await readLedgerStudents(tx, tenantId);
  const studentById = new Map(students.map((student) => [student.studentId, student]));
  const baseline = await earlierStages(tx, tenantId, ledgerFrom);
  const balances = await readBalances(tx, tenantId, students.map((student) => student.studentId));

  let written = 0;
  for (const task of tasks) {
    const stages = baseline.get(task.taskInstanceId);
    if (!stages) continue;
    for (const [studentId, earlier] of [...stages].sort(([left], [right]) => left.localeCompare(right))) {
      const student = studentById.get(studentId);
      const stage = earlier.stage;
      if (!student || stage === 'UNASSIGNED') continue;
      if (stage === 'COMPLETED') {
        // A completed student who also had the task returns to it if that reward is cancelled.
        if (earlier.heldStage !== 'UNASSIGNED') {
          await insertStageEvent(tx, tenantId, {
            id: ledgerEventId('tl-a', 'carry', task.taskInstanceId, studentId), task, studentId, stage: earlier.heldStage,
            writer: { source: 'CARRY_FORWARD' },
          });
          written += 1;
        }
        await insertUnpaidCompletion(tx, tenantId, {
          id: ledgerEventId('tl-c', 'carry', task.taskInstanceId, studentId), task, student,
          balance: balances.get(studentId) ?? 0, assignmentId: null, note: CARRIED_COMPLETION_NOTE,
          writer: { source: 'CARRY_FORWARD' },
        });
      } else {
        await insertStageEvent(tx, tenantId, {
          id: ledgerEventId('tl-a', 'carry', task.taskInstanceId, studentId), task, studentId, stage,
          writer: { source: 'CARRY_FORWARD' },
        });
      }
      written += 1;
    }
  }

  const finishedAt = await clockNow(tx);
  await tx.execute(sql`
    UPDATE operations SET status='SUCCEEDED',
      result_snapshot=${JSON.stringify({ ledgerFrom, carriedEvents: written })}::jsonb,
      finished_at=${finishedAt}::timestamptz, updated_at=${finishedAt}::timestamptz
    WHERE tenant_id=${tenantId} AND operation_id=${LEDGER_MARKER_OPERATION_ID}`);
  return ledgerFrom;
}

/**
 * The stage each student had in each live task at `now` according to the earlier read model.
 * If that model cannot read this class's history (malformed legacy rows), the plain ledger fold
 * over all rows stands in, so the class is never locked out of its tasks.
 */
type EarlierStage = Readonly<{ stage: TaskStage; heldStage: Exclude<TaskStage, 'COMPLETED'> }>;

async function earlierStages(tx: TenantTransaction, tenantId: string, now: string): Promise<Map<string, Map<string, EarlierStage>>> {
  const result = new Map<string, Map<string, EarlierStage>>();
  let fallbackTasks: string[] = [];
  try {
    const tasks = await readDatabaseTasks(tx, tenantId, { activeOnly: false });
    const snapshot = await createDatabaseTaskCycleQueries({ tenantId, runTenantSnapshot: (_id, run) => run(tx) })
      .loadTaskCycleLedgerSnapshot();
    for (const task of tasks) {
      if (!task.taskInstanceId) continue;
      try {
        const state = projectTaskCycleState({ task, now, assignments: snapshot.assignments, completions: snapshot.completions });
        result.set(task.taskInstanceId, new Map(Object.entries(state.students).map(([studentId, student]) => [studentId, {
          stage: student.stage,
          heldStage: !student.assigned ? 'UNASSIGNED' as const : student.ready ? 'READY' as const : 'PENDING' as const,
        }])));
      } catch (error) {
        console.error('[task-ledger] earlier stage of a task unreadable; using the event order', task.taskInstanceId,
          error instanceof Error ? error.message : 'unknown');
        fallbackTasks.push(task.taskInstanceId);
      }
    }
  } catch (error) {
    console.error('[task-ledger] earlier history unreadable; using the event order', error instanceof Error ? error.message : 'unknown');
    fallbackTasks = (await readLedgerTasks(tx, tenantId)).map((task) => task.taskInstanceId);
  }
  if (fallbackTasks.length > 0) {
    const grouped = groupEvents(await readLedgerEvents(tx, tenantId, null, { taskInstanceIds: fallbackTasks }));
    for (const taskInstanceId of fallbackTasks) {
      const stages = new Map<string, EarlierStage>();
      for (const [studentId, events] of grouped.get(taskInstanceId) ?? []) {
        const stage = projectLedgerStage({ events, windows: [], now }).stage;
        stages.set(studentId, { stage, heldStage: stage === 'COMPLETED' ? 'UNASSIGNED' : stage });
      }
      result.set(taskInstanceId, stages);
    }
  }
  return result;
}
