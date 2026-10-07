import 'server-only';

import { sql } from 'drizzle-orm';
import { isTaskStage } from '@/domain/taskLedger';
import type { TenantTransaction } from '@/server/db/transaction';
import { toLedgerEvent, type LedgerCurrentSnapshot, type LedgerEventRow } from './store';

const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const optionalInstant = (value: unknown) => value === null ? null : String(value);

/**
 * One indexed as-of checkpoint per live task/student, plus two primary-key
 * lookups for reward/evidence provenance. Neither rows transferred nor JS fold
 * work grows with the historical event count. Legacy history stays separate.
 */
export async function readCurrentLedgerStates(tx: TenantTransaction, tenantId: string, now: string,
  options: Readonly<{ taskInstanceIds: readonly string[]; studentId?: string }>): Promise<Map<string, Map<string, LedgerCurrentSnapshot>>> {
  if (options.taskInstanceIds.length === 0) return new Map();
  const result = await tx.execute(sql`
    SELECT c.*, to_char(c.event_at AT TIME ZONE 'UTC',${ISO}) AS event_at_iso,
      to_char(c.since AT TIME ZONE 'UTC',${ISO}) AS since_iso,
      to_char(c.before_completion_since AT TIME ZONE 'UTC',${ISO}) AS before_since_iso,
      to_char(c.last_completion_at AT TIME ZONE 'UTC',${ISO}) AS last_completion_at_iso,
      CASE WHEN a.assignment_id IS NOT NULL THEN jsonb_build_object('k','A','id',a.assignment_id,
        'task_instance_id',a.task_instance_id,'student_id',a.student_id,'seq',a.event_sequence::text,
        'at',to_char(a.created_at AT TIME ZONE 'UTC',${ISO}),'source',a.source,'note',a.note,'event_type',a.event_type) END AS assignment,
      CASE WHEN d.completion_id IS NOT NULL THEN jsonb_build_object('k','C','id',d.completion_id,
        'task_instance_id',d.task_instance_id,'student_id',d.student_id,'seq',d.event_sequence::text,
        'at',to_char(d.created_at AT TIME ZONE 'UTC',${ISO}),'source',d.source,'note',d.note,'status',d.status,
        'reward',d.reward_snapshot::text,'completed_at',to_char(d.completed_at AT TIME ZONE 'UTC',${ISO}),
        'transaction_id',d.transaction_id) END AS completion
    FROM tasks t CROSS JOIN students s
    CROSS JOIN LATERAL (
      SELECT * FROM task_ledger_checkpoints c
      WHERE c.tenant_id=${tenantId} AND c.task_instance_id=t.task_instance_id AND c.student_id=s.student_id
        AND c.event_at<=${now}::timestamptz
      ORDER BY c.event_at DESC,c.event_kind DESC,c.event_sequence DESC LIMIT 1
    ) c
    LEFT JOIN LATERAL (SELECT * FROM task_assignments a WHERE a.tenant_id=${tenantId}
      AND a.assignment_id=c.latest_assignment_id LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT * FROM task_completions d WHERE d.tenant_id=${tenantId}
      AND d.completion_id=c.latest_completion_id LIMIT 1) d ON true
    WHERE t.tenant_id=${tenantId} AND s.tenant_id=${tenantId} AND t.deleted_at IS NULL
      ${options.studentId === undefined ? sql`AND s.deleted_at IS NULL` : sql``}
      AND t.task_instance_id IN (${sql.join(options.taskInstanceIds.map(id => sql`${id}`),sql`, `)})
      ${options.studentId === undefined ? sql`` : sql`AND s.student_id=${options.studentId}`}`);
  const grouped = new Map<string, Map<string, LedgerCurrentSnapshot>>();
  for (const row of result.rows as Record<string, unknown>[]) {
    if (!isTaskStage(row.stage) || !isTaskStage(row.before_completion)) throw new Error('Invalid task ledger checkpoint stage.');
    const seq = Number(row.event_sequence), completionCount = Number(row.completion_count);
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(completionCount)) throw new Error('Unsafe task ledger checkpoint count.');
    const base = { id: String(row.event_id), at: String(row.event_at_iso), seq,
      taskInstanceId: String(row.task_instance_id), studentId: String(row.student_id),
      source: row.event_source === null ? null : String(row.event_source), note: null, reward: 0, completedAt: null, transactionId: null };
    const lastEvent: LedgerEventRow = row.event_table === 'A'
      ? { ...base, table: 'A', kind: 'STAGE', stage: row.stage === 'COMPLETED' ? 'READY' : row.stage }
      : { ...base, table: 'C', kind: Number(row.event_kind) === 1 ? 'COMPLETED' : 'UNCOMPLETED' };
    const snapshot: LedgerCurrentSnapshot = {
      checkpoint: { stage: row.stage, since: optionalInstant(row.since_iso), beforeCompletion: row.before_completion,
        beforeCompletionSince: optionalInstant(row.before_since_iso), lastEventId: base.id,
        lastCompletionAt: optionalInstant(row.last_completion_at_iso), lastAt: base.at },
      lastEvent, completionCount,
      latestAssignment: row.assignment ? toLedgerEvent(row.assignment as Record<string, unknown>) : null,
      latestCompletion: row.completion ? toLedgerEvent(row.completion as Record<string, unknown>) : null,
    };
    const students = grouped.get(base.taskInstanceId) ?? new Map<string, LedgerCurrentSnapshot>();
    students.set(base.studentId, snapshot); grouped.set(base.taskInstanceId, students);
  }
  return grouped;
}
