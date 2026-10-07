import 'server-only';

import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { readLedgerTasks, type LedgerTask } from './store';

/** Graph edits serialize; independent completions share this gate. Always before task rows. */
export async function lockTaskGraph(tx: TenantTransaction, tenantId: string, mode: 'shared' | 'exclusive'): Promise<void> {
  const key = `task-ledger-graph:${tenantId}`;
  await tx.execute(mode === 'shared'
    ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key},0))`
    : sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
}

async function dependencyIds(tx: TenantTransaction, tenantId: string, taskId: string): Promise<string[]> {
  const result = await tx.execute(sql`
    WITH RECURSIVE dependencies AS (
      SELECT task_instance_id,prerequisite_task_instance_id FROM tasks
      WHERE tenant_id=${tenantId} AND task_id=${taskId} AND deleted_at IS NULL
      UNION
      SELECT t.task_instance_id,t.prerequisite_task_instance_id FROM tasks t
      JOIN dependencies d ON t.task_instance_id=d.prerequisite_task_instance_id
      WHERE t.tenant_id=${tenantId} AND t.deleted_at IS NULL
    ) SELECT task_instance_id FROM dependencies ORDER BY task_instance_id`);
  return (result.rows as Array<{ task_instance_id: string }>).map(row => row.task_instance_id);
}

/**
 * Locks just the target and its prerequisite closure in the global row order.
 * Recheck after locking also covers an older writer that did not take the graph
 * gate: changed edges cause a full transaction retry, never a partial lock set.
 */
export async function readCompletionTasks(tx: TenantTransaction, tenantId: string, taskId: string, lock: boolean): Promise<LedgerTask[]> {
  if (lock) await lockTaskGraph(tx, tenantId, 'shared');
  const ids = await dependencyIds(tx, tenantId, taskId);
  const tasks = await readLedgerTasks(tx, tenantId, { taskInstanceIds: ids, lock });
  if (lock) {
    const after = await dependencyIds(tx, tenantId, taskId);
    if (ids.length !== after.length || ids.some((id, index) => id !== after[index])) {
      throw Object.assign(new Error('Task dependencies changed while acquiring locks.'), { code: '40001' });
    }
  }
  return tasks;
}
