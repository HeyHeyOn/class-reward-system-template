import 'server-only';

import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { compareInstants, firstResetInWindow } from '@/domain/taskLedger';
import type { TaskStage } from '@/domain/taskStage';
import { parseId, TaskLedgerRequestError, type TaskHistoryDto, type TaskHistoryEntryDto, type TaskHistoryPageRequest } from '@/lib/taskLedgerApi';
import type { TenantTransaction } from '@/server/db/transaction';
import { clockNow, readLedgerFrom, readLedgerTasks, taskWindows, TaskLedgerError } from './store';

const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
type PageRequest = { limit: number; cursor: string | null; studentId: string };
type Cursor = { v: 1; tenant: string; task: string; student: string; revision: string; cutoff: string; snapshot: string; at: string; key: string };
type Item = TaskHistoryEntryDto & { key: string };
const invalid = (): never => { throw new TaskLedgerRequestError('기록 조회 조건이 올바르지 않아요. 기록을 다시 열어 주세요.'); };

function requestOf(value: TaskHistoryPageRequest): PageRequest {
  const limit = value.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
  const studentId = value.studentId ?? '';
  if (studentId) parseId(studentId, '학생 번호');
  const cursor = value.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))) invalid();
  return { limit, studentId, cursor };
}

export function parseTaskHistoryPageRequest(params: URLSearchParams): TaskHistoryPageRequest {
  for (const key of ['limit', 'cursor', 'studentId']) if (params.getAll(key).length > 1) invalid();
  const limit = params.get('limit');
  if (limit !== null && !/^\d{1,3}$/.test(limit)) invalid();
  return requestOf({ limit: limit === null ? undefined : Number(limit), cursor: params.get('cursor'), studentId: params.get('studentId') ?? '' });
}

function decodeCursor(request: PageRequest, tenant: string, task: string): Cursor | null {
  if (!request.cursor) return null;
  try {
    const [payload, signature] = request.cursor.split('.');
    const received = Buffer.from(signature, 'base64url');
    const expected = signCursor(payload);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) invalid();
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Cursor;
    const sequence = (x: unknown) => typeof x === 'string' && /^\d{1,19}$/.test(x) && BigInt(x) <= BigInt('9223372036854775807');
    const instant = (x: unknown) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(x) && compareInstants(x, x) === 0;
    if (!c || c.v !== 1 || c.tenant !== tenant || c.task !== task || c.student !== request.studentId
      || !sequence(c.revision) || !sequence(c.cutoff) || !instant(c.snapshot) || !instant(c.at)
      || typeof c.key !== 'string' || !c.key || c.key.length > 2048) invalid();
    return c;
  } catch { return invalid(); }
}

function signCursor(payload: string): Buffer {
  const secret = process.env.AUTH_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim() || process.env.ADMIN_PASSWORD?.trim();
  if (!secret) throw new Error('Task history cursor signing is not configured.');
  return createHmac('sha256', secret).update('class-store:task-history:v1\0').update(payload).digest();
}

/** Stable C-collation tie key, independent of mutable names and Date's millisecond truncation. */
function compareItems(a: Item, b: Item): number {
  return compareInstants(b.at, a.at) || Buffer.compare(Buffer.from(b.key), Buffer.from(a.key));
}

/**
 * Persisted rows use indexed keyset seeks. Only the latest prefix per roster
 * student is read for virtual tail resets. Returned rows and application folds
 * depend on the roster/page, with no source-ledger scan. An older snapshot may
 * additionally skip entries appended after its cutoff; signed cursors expire
 * after 30 minutes rather than promising a fixed scan bound during live writes.
 */
export async function readTaskHistoryPage(tx: TenantTransaction, tenantId: string, taskId: string,
  input: TaskHistoryPageRequest = {}): Promise<TaskHistoryDto> {
  const request = requestOf(input);
  const [task] = await readLedgerTasks(tx, tenantId, { taskIds: [taskId] });
  if (!task) throw new TaskLedgerError('TASK_NOT_FOUND', '과제를 찾을 수 없어요. 목록을 새로 불러와 주세요.', 404);
  const cursor = decodeCursor(request, tenantId, task.taskInstanceId);
  const now = await clockNow(tx);
  const meta = (await tx.execute(sql`
    SELECT coalesce((SELECT r.revision::text FROM task_history_revisions r WHERE r.tenant_id=${tenantId} AND r.task_instance_id=${task.taskInstanceId}
      ORDER BY r.revision DESC LIMIT 1),'0') AS revision,
      coalesce((SELECT p.event_version::text FROM task_history_prefixes p WHERE p.tenant_id=${tenantId} AND p.task_instance_id=${task.taskInstanceId}
        ORDER BY p.event_version DESC LIMIT 1),'0') AS cutoff`)).rows[0] as { revision: string; cutoff: string };
  if (cursor && cursor.revision !== meta.revision) throw new TaskLedgerError('HISTORY_CHANGED', '기록이 바뀌었어요. 최신 기록부터 다시 보여 드릴게요.', 409);
  if (cursor && Date.parse(now) - Date.parse(cursor.snapshot) > 30 * 60_000)
    throw new TaskLedgerError('HISTORY_CHANGED', '기록 조회 시간이 지나 최신 기록부터 다시 보여 드릴게요.', 409);
  if (cursor && (BigInt(cursor.cutoff) > BigInt(meta.cutoff) || compareInstants(cursor.snapshot, now) > 0)) invalid();
  const snapshot = cursor?.snapshot ?? now;
  const cutoff = cursor?.cutoff ?? meta.cutoff;
  const ledgerFrom = await readLedgerFrom(tx, tenantId);
  const entries = (await tx.execute(sql`
    SELECT h.entry_key,h.id,h.student_id,coalesce(nullif(btrim(s.name),''),h.student_id) AS student_name,
      to_char(h.display_at AT TIME ZONE 'UTC',${ISO}) AS at,h.stage,h.previous_stage,h.cause,h.reward::text AS reward
    FROM task_history_entries h LEFT JOIN students s ON s.tenant_id=h.tenant_id AND s.student_id=h.student_id
    WHERE h.tenant_id=${tenantId} AND h.task_instance_id=${task.taskInstanceId}
      AND h.event_version<=${cutoff}::bigint AND h.event_at<=${snapshot}::timestamptz
      ${request.studentId ? sql`AND h.student_id=${request.studentId}` : sql``}
      ${cursor ? sql`AND (h.display_at,h.entry_key)<(${cursor.at}::timestamptz,${cursor.key}::text COLLATE "C")` : sql``}
    ORDER BY h.display_at DESC,h.entry_key DESC LIMIT ${request.limit + 1}`)).rows as Array<Record<string, unknown>>;
  const items: Item[] = entries.map((r) => ({ key: String(r.entry_key), id: String(r.id), at: String(r.at), studentId: String(r.student_id),
    studentName: String(r.student_name), stage: r.stage as TaskStage, previousStage: r.previous_stage as TaskStage,
    cause: r.cause as TaskHistoryEntryDto['cause'], reward: r.reward === null ? null : Number(r.reward) }));
  if (ledgerFrom !== null && taskWindows(task).some((w) => w.resetStage !== null && w.recurrence.type !== 'NONE')) {
    const tails = (await tx.execute(sql`
      SELECT s.student_id,coalesce(nullif(btrim(s.name),''),s.student_id) AS student_name,p.stage,p.before_completion,
        to_char(p.event_at AT TIME ZONE 'UTC',${ISO}) AS at
      FROM students s CROSS JOIN LATERAL (
        SELECT event_at,stage,before_completion FROM task_history_prefixes
        WHERE tenant_id=${tenantId} AND task_instance_id=${task.taskInstanceId} AND student_id=s.student_id
          AND event_at<=${snapshot}::timestamptz AND event_version<=${cutoff}::bigint
        ORDER BY event_at DESC,kind_order DESC,event_sequence DESC LIMIT 1
      ) p WHERE s.tenant_id=${tenantId} AND p.stage<>'UNASSIGNED' AND p.event_at>=${ledgerFrom}::timestamptz
        ${request.studentId ? sql`AND s.student_id=${request.studentId}` : sql``}`)).rows as Array<Record<string, unknown>>;
    const windows = [...taskWindows(task)].sort((a, b) => compareInstants(a.from, b.from));
    for (const row of tails) {
      let at = String(row.at); let stage = row.stage as TaskStage;
      if (compareInstants(at, ledgerFrom) < 0) continue;
      // At most one change per schedule window. Match ledgerTimeline's skip of
      // a same-stage window and exclusion of a boundary at the next window start.
      for (let guard = 0; guard < 8 && stage !== 'UNASSIGNED'; guard += 1) {
        let next: { at: string; stage: TaskStage; until: string | null } | null = null;
        for (const window of windows) {
          if (window.until !== null && compareInstants(window.until, at) <= 0) continue;
          const reset = firstResetInWindow(window, at, snapshot);
          if (reset !== null && window.resetStage !== null && (next === null || compareInstants(reset, next.at) < 0))
            next = { at: reset, stage: window.resetStage, until: window.until };
        }
        if (next === null) break;
        if (next.stage === stage) { if (next.until === null) break; at = next.until; continue; }
        const id = `reset:${String(row.student_id)}:${next.at}`;
        const item: Item = { key: `R:${id}`, id: `R:${id}`, at: next.at, studentId: String(row.student_id), studentName: String(row.student_name),
          stage: next.stage, previousStage: stage, cause: 'AUTO_RESET', reward: null };
        if (!cursor || compareItems(item, { at: cursor.at, key: cursor.key } as Item) > 0) items.push(item);
        stage = next.stage; at = next.at;
      }
    }
  }
  items.sort(compareItems);
  const page = items.slice(0, request.limit);
  const last = page.at(-1);
  const payload = items.length > request.limit && last ? Buffer.from(JSON.stringify({
    v: 1, tenant: tenantId, task: task.taskInstanceId, student: request.studentId, revision: meta.revision,
    cutoff, snapshot, at: last.at, key: last.key,
  } satisfies Cursor)).toString('base64url') : null;
  const nextCursor = payload === null ? null : `${payload}.${signCursor(payload).toString('base64url')}`;
  return { taskId: task.taskId, title: task.title, entries: page.map(({ id, at, studentId, studentName, stage, previousStage, cause, reward }) =>
    ({ id, at, studentId, studentName, stage, previousStage, cause, reward })),
    truncated: nextCursor !== null, nextCursor, snapshotAt: snapshot };
}
