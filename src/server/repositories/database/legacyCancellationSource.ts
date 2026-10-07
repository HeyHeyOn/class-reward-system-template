import 'server-only';

import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { createHeaderIndex, parseTransactionRow } from '@/server/sheetsRows';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { isoString, projectTransactionItem, safeInteger } from './queryProjection';
import type { CancellationSuccess, OriginalTransactionRow, TaskCompletionRow, TransactionItemRow } from './transactionCommands';

const HEADERS = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items',
  'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];
function fail(): never { throw new Error('Imported cancellation source integrity check failed.'); }

/** Reads only immutable financial/task provenance. A historical record supplies
 * facts, never a modern operation or administrator identity. The caller must
 * execute the new cancellation through the authenticated tenant command. */
export async function validateLegacyCancellationSource(
  tx: TenantTransaction,
  tenantId: string,
  original: OriginalTransactionRow,
  items: readonly TransactionItemRow[],
  completions: readonly TaskCompletionRow[],
): Promise<{ originalCompletion: TaskCompletionRow | null; restoredItems: CancellationSuccess['restoredItems'] }> {
  const result = await tx.execute(sql`
    SELECT o.job_id, o.source_id, o.source_digest, o.source_row_number,
           o.source_row_digest, o.original_cells, o.reverses_transaction_id
    FROM legacy_transaction_origins o
    JOIN migration_sources s ON s.tenant_id=o.tenant_id AND s.job_id=o.job_id AND s.source_id=o.source_id
      AND s.source_fingerprint=o.source_digest AND s.provider='GOOGLE_SHEETS'
    WHERE o.tenant_id=${tenantId} AND o.transaction_id=${original.transaction_id}
  `);
  if (result.rows.length !== 1) fail();
  const origin = result.rows[0];
  const cells = origin.original_cells;
  if (!Array.isArray(cells) || cells.length < HEADERS.length
    || !cells.every(cell => typeof cell === 'string') || cells.slice(HEADERS.length).some(Boolean)
    || sha256(canonicalJson({ tab: 'Transactions', rowNumber: origin.source_row_number, cells })) !== origin.source_row_digest
    || origin.reverses_transaction_id !== null || original.reverses_transaction_id !== null
    || original.kind !== 'LEGACY' || original.schema_version !== 1
    || original.operation_id !== null || original.operation_hash !== null) fail();
  const source = parseTransactionRow(cells, createHeaderIndex(HEADERS));
  if (!source || source.itemsMalformed || !['COMPLETED', 'TASK_REWARD', 'ADMIN_ADJUSTMENT'].includes(source.status)
    || source.transactionId !== original.transaction_id || source.studentId !== original.student_id
    || source.studentName !== original.student_name_snapshot
    || source.timestamp !== isoString(original.occurred_at, 'source timestamp')
    || source.status !== original.legacy_status_snapshot || source.operator !== original.operator_snapshot
    || source.totalAmount !== safeInteger(original.legacy_total_amount, 'source total')
    || source.balanceBefore !== safeInteger(original.balance_before, 'source balance')
    || source.balanceAfter !== safeInteger(original.balance_after, 'source balance')
    || source.balanceAfter - source.balanceBefore !== safeInteger(original.balance_delta, 'source delta')
    || source.totalAmount !== source.balanceBefore - source.balanceAfter
    || items.some((item, i) => item.line_number !== i + 1 || item.current_product_id !== null)
    || canonicalJson(items.map(projectTransactionItem)) !== canonicalJson(source.items)) fail();
  let rawItems: unknown;
  try { rawItems = JSON.parse(cells[4]); } catch { fail(); }
  if (canonicalJson(rawItems) !== canonicalJson(source.items)
    || source.items.reduce((sum, item) => sum + BigInt('finalTotal' in item ? item.finalTotal : item.subtotal), BigInt(0)) !== BigInt(source.totalAmount)) fail();

  const restored = new Map<string, { productId: string; productName: string; quantity: number }>();
  if (source.status === 'COMPLETED') {
    if (source.totalAmount < 0 || source.items.length === 0) fail();
    for (const item of source.items) {
      if (item.price < 0 || item.subtotal < 0
        || (!('totalQuantity' in item) && BigInt(item.price) * BigInt(item.quantity) !== BigInt(item.subtotal))) fail();
      const quantity = 'totalQuantity' in item ? item.totalQuantity : item.quantity;
      const previous = restored.get(item.productId);
      if (previous && previous.productName !== item.name) fail();
      const totalQuantity = quantity + (previous?.quantity ?? 0);
      if (!Number.isSafeInteger(totalQuantity) || totalQuantity < 1) fail();
      restored.set(item.productId, { productId: item.productId, productName: item.name, quantity: totalQuantity });
    }
  }
  if (source.status !== 'TASK_REWARD') {
    if (completions.length !== 0) fail();
    return { originalCompletion: null, restoredItems: [...restored.values()].sort((a, b) => a.productId.localeCompare(b.productId)) };
  }
  if (completions.length !== 1) fail();
  const completion = completions[0];
  const matched = await tx.execute(sql`
    SELECT c.completion_id
    FROM task_completions c
    JOIN legacy_task_origins o ON o.tenant_id=c.tenant_id AND o.origin_id=c.legacy_origin_id
      AND o.target_table='task_completions' AND o.target_id=c.completion_id
    WHERE c.tenant_id=${tenantId} AND c.completion_id=${completion.completion_id}
      AND o.job_id=${origin.job_id} AND o.source_id=${origin.source_id} AND o.source_digest=${origin.source_digest}
      AND (to_jsonb(c)-'event_sequence'-'legacy_origin_id')=
        (to_jsonb(jsonb_populate_record(NULL::task_completions,o.projection))-'event_sequence'-'legacy_origin_id')
  `);
  if (matched.rows.length !== 1 || completion.status !== 'COMPLETED' || completion.source !== 'BANK'
    || completion.transaction_id !== original.transaction_id || completion.student_id !== source.studentId
    || completion.student_name_snapshot !== source.studentName || !completion.legacy_origin_id
    || completion.operation_id !== null || completion.operation_hash !== null
    || safeInteger(completion.reward_snapshot, 'source reward') !== -source.totalAmount || source.totalAmount >= 0
    || safeInteger(completion.balance_before, 'completion balance') !== source.balanceBefore
    || safeInteger(completion.balance_after, 'completion balance') !== source.balanceAfter
    || isoString(completion.completed_at, 'completion timestamp') !== source.timestamp
    || source.items.length !== 1 || source.items[0].productId !== completion.task_id_snapshot
    || source.items[0].quantity !== 1 || source.items[0].price !== source.totalAmount
    || source.items[0].subtotal !== source.totalAmount || !completion.assignment_id
    || !completion.task_instance_id || !completion.cycle_id || completion.schema_version !== 1) fail();
  return { originalCompletion: completion, restoredItems: [] };
}

export async function readCancellationItems(tx: TenantTransaction, tenantId: string, transactionId: string, lock = false) {
  const query = sql`
    SELECT line_number, product_id_snapshot, current_product_id, product_name_snapshot,
      quantity::text AS quantity, unit_price_snapshot::text AS unit_price_snapshot,
      subtotal_snapshot::text AS subtotal_snapshot, regular_unit_price::text AS regular_unit_price,
      regular_total::text AS regular_total, total_quantity::text AS total_quantity,
      paid_quantity::text AS paid_quantity, free_quantity::text AS free_quantity,
      final_total::text AS final_total, total_discount::text AS total_discount,
      adjustments_snapshot, applied_promotions_snapshot
    FROM transaction_items WHERE tenant_id=${tenantId} AND transaction_id=${transactionId} ORDER BY line_number
  `;
  return (await tx.execute(lock ? sql`${query} FOR UPDATE` : query)).rows as TransactionItemRow[];
}
