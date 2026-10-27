import 'server-only';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';

/** Rows of the 딴쌤 board link tables (0061). Every function runs inside the caller's tenant transaction. */

export type BoardFormat = 'mini' | 'group' | 'quiz' | 'survey';

export type BoardLinkRow = Readonly<{
  taskInstanceId: string;
  taskId: string;
  boardId: string;
  boardCode: string;
  boardTitle: string;
  boardFormat: BoardFormat;
  groupId: string | null;
  groupName: string | null;
  linkedBySub: string;
  linkedAt: string;
}>;

export type BoardLinkSyncRow = Readonly<{
  boardKey: string;
  checkedAt: string | null;
  succeededAt: string | null;
  errorCode: string | null;
  checking: boolean;
}>;

/** One board, or one group of a group board: what is read and synced together. */
export function boardKeyOf(link: Readonly<{ boardId: string; groupId: string | null }>): string {
  return `${link.boardId}:${link.groupId ?? ''}`;
}

const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const iso = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', '${ISO}')`);
const list = (values: readonly string[]) => sql.join(values.length ? values.map((value) => sql`${value}`) : [sql`NULL`], sql`, `);
const keyMatches = (boardKey: string) => sql`(l.board_id || ':' || coalesce(l.group_id, ''))=${boardKey}`;

/** Links of live (not deleted) tasks, optionally of one board key. */
export async function readBoardLinks(tx: TenantTransaction, tenantId: string, boardKey?: string): Promise<BoardLinkRow[]> {
  const result = await tx.execute(sql`
    SELECT l.task_instance_id, t.task_id, l.board_id, l.board_code, l.board_title, l.board_format, l.group_id, l.group_name,
      l.linked_by_sub, ${iso('l.linked_at')} AS linked_at
    FROM task_board_links l
    JOIN tasks t ON t.tenant_id=l.tenant_id AND t.task_instance_id=l.task_instance_id AND t.deleted_at IS NULL
    WHERE l.tenant_id=${tenantId} ${boardKey ? sql`AND ${keyMatches(boardKey)}` : sql``}
    ORDER BY l.board_id, l.group_id NULLS FIRST, t.task_id`);
  return (result.rows as Array<Record<string, string | null>>).map((row) => ({
    taskInstanceId: String(row.task_instance_id), taskId: String(row.task_id), boardId: String(row.board_id),
    boardCode: String(row.board_code), boardTitle: String(row.board_title ?? ''), boardFormat: row.board_format as BoardFormat,
    groupId: row.group_id ?? null, groupName: row.group_name ?? null, linkedBySub: String(row.linked_by_sub), linkedAt: String(row.linked_at),
  }));
}

export async function writeBoardLinks(tx: TenantTransaction, tenantId: string, taskInstanceIds: readonly string[], link: Readonly<{
  boardId: string; boardCode: string; boardTitle: string; boardFormat: BoardFormat; groupId: string | null; groupName: string | null; linkedBySub: string;
}>): Promise<void> {
  for (const taskInstanceId of [...taskInstanceIds].sort()) {
    await tx.execute(sql`
      INSERT INTO task_board_links (tenant_id, task_instance_id, board_id, board_code, board_title, board_format, group_id, group_name,
        linked_by_sub, linked_at)
      VALUES (${tenantId}, ${taskInstanceId}, ${link.boardId}, ${link.boardCode}, ${link.boardTitle}, ${link.boardFormat},
        ${link.groupId}, ${link.groupName}, ${link.linkedBySub}, clock_timestamp())
      ON CONFLICT (tenant_id, task_instance_id) DO UPDATE SET board_id=EXCLUDED.board_id, board_code=EXCLUDED.board_code,
        board_title=EXCLUDED.board_title, board_format=EXCLUDED.board_format, group_id=EXCLUDED.group_id, group_name=EXCLUDED.group_name,
        linked_by_sub=EXCLUDED.linked_by_sub,
        linked_at=CASE WHEN task_board_links.board_id=EXCLUDED.board_id AND task_board_links.group_id IS NOT DISTINCT FROM EXCLUDED.group_id
          THEN task_board_links.linked_at ELSE EXCLUDED.linked_at END`);
  }
  await tx.execute(sql`
    INSERT INTO board_link_syncs (tenant_id, board_key) VALUES (${tenantId}, ${boardKeyOf(link)}) ON CONFLICT DO NOTHING`);
}

export async function deleteBoardLinks(tx: TenantTransaction, tenantId: string, taskInstanceIds: readonly string[]): Promise<void> {
  if (taskInstanceIds.length === 0) return;
  await tx.execute(sql`DELETE FROM task_board_links WHERE tenant_id=${tenantId} AND task_instance_id IN (${list(taskInstanceIds)})`);
  // A board no task uses any more keeps no sync row.
  await tx.execute(sql`
    DELETE FROM board_link_syncs s WHERE s.tenant_id=${tenantId}
      AND NOT EXISTS (SELECT 1 FROM task_board_links l WHERE l.tenant_id=s.tenant_id
        AND (l.board_id || ':' || coalesce(l.group_id, ''))=s.board_key)`);
}

export async function readBoardUses(tx: TenantTransaction, tenantId: string, taskInstanceIds: readonly string[]):
Promise<Array<{ taskInstanceId: string; evidenceId: string; studentId: string }>> {
  if (taskInstanceIds.length === 0) return [];
  const result = await tx.execute(sql`
    SELECT task_instance_id, evidence_id, student_id FROM board_evidence_uses
    WHERE tenant_id=${tenantId} AND task_instance_id IN (${list(taskInstanceIds)})`);
  return (result.rows as Array<{ task_instance_id: string; evidence_id: string; student_id: string }>)
    .map((row) => ({ taskInstanceId: row.task_instance_id, evidenceId: row.evidence_id, studentId: row.student_id }));
}

export async function insertBoardUse(tx: TenantTransaction, tenantId: string, use: Readonly<{
  taskInstanceId: string; evidenceId: string; boardId: string; studentId: string; evidenceCreatedAt: string; operationId: string;
}>): Promise<void> {
  await tx.execute(sql`
    INSERT INTO board_evidence_uses (tenant_id, task_instance_id, evidence_id, board_id, student_id, evidence_created_at, used_at, operation_id)
    VALUES (${tenantId}, ${use.taskInstanceId}, ${use.evidenceId}, ${use.boardId}, ${use.studentId}, ${use.evidenceCreatedAt}::timestamptz,
      clock_timestamp(), ${use.operationId}::uuid)
    ON CONFLICT DO NOTHING`);
}

export async function readBoardLinkSyncs(tx: TenantTransaction, tenantId: string): Promise<BoardLinkSyncRow[]> {
  const result = await tx.execute(sql`
    SELECT board_key, ${iso('checked_at')} AS checked_at, ${iso('succeeded_at')} AS succeeded_at, error_code,
      coalesce(sync_attempt_id IS NOT NULL AND sync_lease_until > clock_timestamp(), false) AS checking
    FROM board_link_syncs WHERE tenant_id=${tenantId} ORDER BY board_key`);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    boardKey: String(row.board_key), checkedAt: (row.checked_at as string | null) ?? null, succeededAt: (row.succeeded_at as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null, checking: row.checking === true,
  }));
}

async function lockActiveTenant(tx: TenantTransaction, tenantId: string): Promise<boolean> {
  const result = await tx.execute(sql`SELECT id FROM tenants
    WHERE id=${tenantId} AND lifecycle='ACTIVE' AND deleted_at IS NULL FOR SHARE`);
  return result.rows.length > 0;
}

const liveLink = (tenantId: string, boardKey: string) => sql`EXISTS (
  SELECT 1 FROM task_board_links l JOIN tasks t ON t.tenant_id=l.tenant_id AND t.task_instance_id=l.task_instance_id
  WHERE l.tenant_id=${tenantId} AND ${keyMatches(boardKey)} AND t.deleted_at IS NULL)`;

/** A read of this board key may start: not read within `staleSeconds`, and no unfinished read. Returns its token. */
export async function claimBoardLinkSync(tx: TenantTransaction, tenantId: string, boardKey: string,
  staleSeconds: number, manual = false): Promise<string | null> {
  if (!await lockActiveTenant(tx, tenantId)) return null;
  const linked = await tx.execute(sql`SELECT t.task_instance_id FROM task_board_links l JOIN tasks t
    ON t.tenant_id=l.tenant_id AND t.task_instance_id=l.task_instance_id
    WHERE l.tenant_id=${tenantId} AND ${keyMatches(boardKey)} AND t.deleted_at IS NULL
    ORDER BY t.task_instance_id FOR SHARE OF t`);
  if (linked.rows.length === 0) return null;
  const attemptId = randomUUID();
  const result = await tx.execute(sql`
    INSERT INTO board_link_syncs (tenant_id, board_key, checked_at, sync_attempt_id, sync_lease_until)
    SELECT ${tenantId}, ${boardKey}, clock_timestamp(), ${attemptId}::uuid, clock_timestamp() + interval '60 seconds'
    WHERE ${liveLink(tenantId, boardKey)}
    ON CONFLICT (tenant_id, board_key) DO UPDATE SET checked_at=EXCLUDED.checked_at,
      sync_attempt_id=EXCLUDED.sync_attempt_id, sync_lease_until=EXCLUDED.sync_lease_until, retry_after=NULL
    WHERE (board_link_syncs.sync_lease_until IS NULL OR board_link_syncs.sync_lease_until <= clock_timestamp())
      AND (board_link_syncs.retry_after IS NULL OR board_link_syncs.retry_after <= clock_timestamp())
      AND (${manual} OR board_link_syncs.checked_at IS NULL
        OR board_link_syncs.checked_at < clock_timestamp() - make_interval(secs => ${staleSeconds}))
    RETURNING sync_attempt_id`);
  return result.rows.length > 0 ? attemptId : null;
}

/** Hold the sync row until the same transaction has written every stage, use and result of this read. */
export async function lockBoardLinkSyncAttempt(tx: TenantTransaction, tenantId: string, boardKey: string, attemptId: string): Promise<boolean> {
  if (!await lockActiveTenant(tx, tenantId)) return false;
  const result = await tx.execute(sql`SELECT board_key FROM board_link_syncs
    WHERE tenant_id=${tenantId} AND board_key=${boardKey} AND ${liveLink(tenantId, boardKey)}
      AND sync_attempt_id=${attemptId}::uuid AND sync_lease_until IS NOT NULL
    FOR UPDATE`);
  return result.rows.length > 0;
}

/** Where the last read of this board key stopped among the class's 미완료 students (null: from the first). */
export async function readBoardEvidenceAfter(tx: TenantTransaction, tenantId: string, boardKey: string): Promise<string | null> {
  const result = await tx.execute(sql`SELECT evidence_after FROM board_link_syncs WHERE tenant_id=${tenantId} AND board_key=${boardKey}`);
  const value = (result.rows[0] as { evidence_after?: unknown } | undefined)?.evidence_after;
  return typeof value === 'string' ? value : null;
}

/** Saves where this read stopped, if the read still holds the board key's sync attempt. */
export async function saveBoardEvidenceAfter(tx: TenantTransaction, tenantId: string, boardKey: string, attemptId: string,
  after: string | null): Promise<void> {
  await tx.execute(sql`UPDATE board_link_syncs SET evidence_after=${after}
    WHERE tenant_id=${tenantId} AND board_key=${boardKey} AND sync_attempt_id=${attemptId}::uuid`);
}

export async function recordBoardLinkSync(tx: TenantTransaction, tenantId: string, boardKey: string,
  outcome: Readonly<{ ok: true } | { ok: false; errorCode: string }>, attemptId: string): Promise<boolean> {
  if (!await lockBoardLinkSyncAttempt(tx, tenantId, boardKey, attemptId)) return false;
  const result = await tx.execute(sql`UPDATE board_link_syncs SET checked_at=clock_timestamp(), sync_lease_until=NULL,
    succeeded_at=${outcome.ok ? sql`clock_timestamp()` : sql`succeeded_at`},
    error_code=${outcome.ok ? null : outcome.errorCode},
    retry_after=${!outcome.ok && outcome.errorCode === 'RATE_LIMITED' ? sql`clock_timestamp() + interval '60 seconds'` : sql`NULL`}
    WHERE tenant_id=${tenantId} AND board_key=${boardKey} RETURNING board_key`);
  return result.rows.length > 0;
}
