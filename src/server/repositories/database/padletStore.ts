import 'server-only';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PadletPostOutcome } from '@/domain/padlet';
import type { TenantTransaction } from '@/server/db/transaction';

/** Rows of the Padlet link tables (0054). Every function runs inside the caller's tenant transaction. */

export type PadletLinkRow = Readonly<{
  taskInstanceId: string;
  taskId: string;
  boardId: string;
  boardTitle: string;
  boardUrl: string;
  sectionId: string | null;
  sectionTitle: string | null;
  linkedAt: string;
}>;

export type PadletBoardSyncRow = Readonly<{
  boardId: string;
  checkedAt: string | null;
  succeededAt: string | null;
  errorCode: string | null;
  checking: boolean;
  retryAt: string | null;
  summary: readonly PadletPostOutcome[];
}>;

const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const iso = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', '${ISO}')`);
const list = (values: readonly string[]) => sql.join(values.length ? values.map((value) => sql`${value}`) : [sql`NULL`], sql`, `);

export async function readPadletKey(tx: TenantTransaction, tenantId: string): Promise<{ sealed: string; hint: string } | null> {
  const result = await tx.execute(sql`SELECT api_key_sealed, api_key_hint FROM padlet_settings WHERE tenant_id=${tenantId}`);
  const row = result.rows[0] as { api_key_sealed: string; api_key_hint: string } | undefined;
  return row ? { sealed: row.api_key_sealed, hint: row.api_key_hint } : null;
}

export async function writePadletKey(tx: TenantTransaction, tenantId: string, value: { sealed: string; hint: string } | null): Promise<void> {
  if (value === null) {
    await tx.execute(sql`DELETE FROM padlet_settings WHERE tenant_id=${tenantId}`);
    return;
  }
  await tx.execute(sql`
    INSERT INTO padlet_settings (tenant_id, api_key_sealed, api_key_hint, updated_at)
    VALUES (${tenantId}, ${value.sealed}, ${value.hint}, clock_timestamp())
    ON CONFLICT (tenant_id) DO UPDATE SET api_key_sealed=EXCLUDED.api_key_sealed, api_key_hint=EXCLUDED.api_key_hint,
      updated_at=EXCLUDED.updated_at`);
}

/** Links of live (not deleted) tasks, optionally of one board. */
export async function readPadletLinks(tx: TenantTransaction, tenantId: string, boardId?: string): Promise<PadletLinkRow[]> {
  const result = await tx.execute(sql`
    SELECT l.task_instance_id, t.task_id, l.board_id, l.board_title, l.board_url, l.section_id, l.section_title,
      ${iso('l.linked_at')} AS linked_at
    FROM task_padlet_links l
    JOIN tasks t ON t.tenant_id=l.tenant_id AND t.task_instance_id=l.task_instance_id AND t.deleted_at IS NULL
    WHERE l.tenant_id=${tenantId} ${boardId ? sql`AND l.board_id=${boardId}` : sql``}
    ORDER BY l.board_id, t.task_id`);
  return (result.rows as Array<Record<string, string | null>>).map((row) => ({
    taskInstanceId: String(row.task_instance_id), taskId: String(row.task_id), boardId: String(row.board_id),
    boardTitle: String(row.board_title ?? ''), boardUrl: String(row.board_url ?? ''),
    sectionId: row.section_id ?? null, sectionTitle: row.section_title ?? null, linkedAt: String(row.linked_at),
  }));
}

export async function writePadletLinks(tx: TenantTransaction, tenantId: string, taskInstanceIds: readonly string[], link: Readonly<{
  boardId: string; boardTitle: string; boardUrl: string; sectionId: string | null; sectionTitle: string | null;
}>): Promise<void> {
  for (const taskInstanceId of [...taskInstanceIds].sort()) {
    await tx.execute(sql`
      INSERT INTO task_padlet_links (tenant_id, task_instance_id, board_id, board_title, board_url, section_id, section_title, linked_at)
      VALUES (${tenantId}, ${taskInstanceId}, ${link.boardId}, ${link.boardTitle}, ${link.boardUrl}, ${link.sectionId}, ${link.sectionTitle},
        clock_timestamp())
      ON CONFLICT (tenant_id, task_instance_id) DO UPDATE SET board_id=EXCLUDED.board_id, board_title=EXCLUDED.board_title,
        board_url=EXCLUDED.board_url, section_id=EXCLUDED.section_id, section_title=EXCLUDED.section_title,
        linked_at=CASE WHEN task_padlet_links.board_id=EXCLUDED.board_id THEN task_padlet_links.linked_at ELSE EXCLUDED.linked_at END`);
  }
  await tx.execute(sql`
    INSERT INTO padlet_board_syncs (tenant_id, board_id) VALUES (${tenantId}, ${link.boardId}) ON CONFLICT DO NOTHING`);
}

export async function deletePadletLinks(tx: TenantTransaction, tenantId: string, taskInstanceIds: readonly string[]): Promise<void> {
  if (taskInstanceIds.length === 0) return;
  await tx.execute(sql`DELETE FROM task_padlet_links WHERE tenant_id=${tenantId} AND task_instance_id IN (${list(taskInstanceIds)})`);
  // A board no task uses any more keeps no summary.
  await tx.execute(sql`
    DELETE FROM padlet_board_syncs s WHERE s.tenant_id=${tenantId}
      AND NOT EXISTS (SELECT 1 FROM task_padlet_links l WHERE l.tenant_id=s.tenant_id AND l.board_id=s.board_id)`);
}

export async function readPadletUses(tx: TenantTransaction, tenantId: string, taskInstanceIds: readonly string[]):
Promise<Array<{ taskInstanceId: string; postId: string; studentId: string }>> {
  if (taskInstanceIds.length === 0) return [];
  const result = await tx.execute(sql`
    SELECT task_instance_id, post_id, student_id FROM padlet_post_uses
    WHERE tenant_id=${tenantId} AND task_instance_id IN (${list(taskInstanceIds)})`);
  return (result.rows as Array<{ task_instance_id: string; post_id: string; student_id: string }>)
    .map((row) => ({ taskInstanceId: row.task_instance_id, postId: row.post_id, studentId: row.student_id }));
}

export async function insertPadletUse(tx: TenantTransaction, tenantId: string, use: Readonly<{
  taskInstanceId: string; postId: string; boardId: string; studentId: string; postCreatedAt: string; operationId: string;
}>): Promise<void> {
  await tx.execute(sql`
    INSERT INTO padlet_post_uses (tenant_id, task_instance_id, post_id, board_id, student_id, post_created_at, used_at, operation_id)
    VALUES (${tenantId}, ${use.taskInstanceId}, ${use.postId}, ${use.boardId}, ${use.studentId}, ${use.postCreatedAt}::timestamptz,
      clock_timestamp(), ${use.operationId}::uuid)
    ON CONFLICT DO NOTHING`);
}

export async function readPadletBoardSyncs(tx: TenantTransaction, tenantId: string): Promise<PadletBoardSyncRow[]> {
  const result = await tx.execute(sql`
    SELECT board_id, ${iso('checked_at')} AS checked_at, ${iso('succeeded_at')} AS succeeded_at, error_code, summary,
      coalesce(sync_attempt_id IS NOT NULL AND sync_lease_until > clock_timestamp(), false) AS checking,
      CASE WHEN retry_after > clock_timestamp() THEN ${iso('retry_after')} ELSE NULL END AS retry_at
    FROM padlet_board_syncs WHERE tenant_id=${tenantId} ORDER BY board_id`);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    boardId: String(row.board_id), checkedAt: (row.checked_at as string | null) ?? null, succeededAt: (row.succeeded_at as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null, summary: Array.isArray(row.summary) ? row.summary as PadletPostOutcome[] : [],
    checking: row.checking === true, retryAt: (row.retry_at as string | null) ?? null,
  }));
}

/** Serialize against deletion/withdrawal before taking task and sync locks. */
async function lockActiveTenant(tx: TenantTransaction, tenantId: string): Promise<boolean> {
  const result = await tx.execute(sql`SELECT id FROM tenants
    WHERE id=${tenantId} AND lifecycle='ACTIVE' AND deleted_at IS NULL FOR SHARE`);
  return result.rows.length > 0;
}

const liveLink = (tenantId: string, boardId: string) => sql`EXISTS (
  SELECT 1 FROM task_padlet_links l JOIN tasks t
    ON t.tenant_id=l.tenant_id AND t.task_instance_id=l.task_instance_id
  WHERE l.tenant_id=${tenantId} AND l.board_id=${boardId} AND t.deleted_at IS NULL)`;

/** Manual reads bypass freshness, but never an unfinished lease or a rate-limit cooldown. */
export async function claimPadletBoardSync(tx: TenantTransaction, tenantId: string, boardId: string,
  staleSeconds: number, manual = false): Promise<string | null> {
  if (!await lockActiveTenant(tx, tenantId)) return null;
  // Match unlink/apply ordering: tenant -> tasks -> sync. The second live-link check below
  // uses a fresh statement snapshot after any concurrent task deletion/relink has finished.
  const linked = await tx.execute(sql`SELECT t.task_instance_id FROM task_padlet_links l JOIN tasks t
    ON t.tenant_id=l.tenant_id AND t.task_instance_id=l.task_instance_id
    WHERE l.tenant_id=${tenantId} AND l.board_id=${boardId} AND t.deleted_at IS NULL
    ORDER BY t.task_instance_id FOR SHARE OF t`);
  if (linked.rows.length === 0) return null;
  const attemptId = randomUUID();
  const result = await tx.execute(sql`
    INSERT INTO padlet_board_syncs (tenant_id, board_id, checked_at, sync_attempt_id, sync_lease_until)
    SELECT ${tenantId}, ${boardId}, clock_timestamp(), ${attemptId}::uuid, clock_timestamp() + interval '60 seconds'
    WHERE ${liveLink(tenantId, boardId)}
    ON CONFLICT (tenant_id, board_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,
      sync_attempt_id=EXCLUDED.sync_attempt_id, sync_lease_until=EXCLUDED.sync_lease_until, retry_after=NULL
    WHERE (padlet_board_syncs.sync_lease_until IS NULL OR padlet_board_syncs.sync_lease_until <= clock_timestamp())
      AND (padlet_board_syncs.retry_after IS NULL OR padlet_board_syncs.retry_after <= clock_timestamp())
      AND (${manual} OR padlet_board_syncs.checked_at IS NULL
        OR padlet_board_syncs.checked_at < clock_timestamp() - make_interval(secs => ${staleSeconds}))
    RETURNING sync_attempt_id`);
  return result.rows.length > 0 ? attemptId : null;
}

/** Hold this row lock until the same transaction commits all stage/use/result changes.
 * An expired token remains eligible only until another request takes over. A completed token
 * is never reusable. Legacy callers without a token cannot write over an unfinished attempt.
 */
export async function lockPadletBoardSyncAttempt(tx: TenantTransaction, tenantId: string, boardId: string,
  attemptId?: string): Promise<boolean> {
  if (!await lockActiveTenant(tx, tenantId)) return false;
  const result = await tx.execute(sql`SELECT board_id FROM padlet_board_syncs
    WHERE tenant_id=${tenantId} AND board_id=${boardId} AND ${liveLink(tenantId, boardId)}
      AND ${attemptId ? sql`sync_attempt_id=${attemptId}::uuid AND sync_lease_until IS NOT NULL`
        : sql`sync_lease_until IS NULL AND (retry_after IS NULL OR retry_after <= clock_timestamp())`}
    FOR UPDATE`);
  return result.rows.length > 0;
}

export async function recordPadletBoardSync(tx: TenantTransaction, tenantId: string, boardId: string, outcome: Readonly<
  { ok: true; summary: readonly PadletPostOutcome[] } | { ok: false; errorCode: string }
>, attemptId?: string): Promise<boolean> {
  if (!await lockPadletBoardSyncAttempt(tx, tenantId, boardId, attemptId)) return false;
  // UPDATE only: a response arriving after unlink/delete must not resurrect a sync row.
  const result = await tx.execute(sql`UPDATE padlet_board_syncs SET checked_at=clock_timestamp(), sync_lease_until=NULL,
    succeeded_at=${outcome.ok ? sql`clock_timestamp()` : sql`succeeded_at`},
    error_code=${outcome.ok ? null : outcome.errorCode},
    summary=${outcome.ok ? sql`${JSON.stringify(outcome.summary)}::jsonb` : sql`summary`},
    retry_after=${!outcome.ok && outcome.errorCode === 'RATE_LIMITED'
      ? sql`greatest(retry_after, clock_timestamp() + interval '60 seconds')` : sql`NULL`}
    WHERE tenant_id=${tenantId} AND board_id=${boardId} RETURNING board_id`);
  return result.rows.length > 0;
}
