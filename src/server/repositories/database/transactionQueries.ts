import 'server-only';

import { sql } from 'drizzle-orm';
import type { Transaction } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  isoString,
  nullableIsoString,
  nullableString,
  projectTransactionItem,
  safeInteger,
  type TransactionItemRow,
} from '@/server/repositories/database/queryProjection';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseTransactionQueryDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
}>;

type TransactionRow = TransactionItemRow & {
  transaction_id: unknown;
  event_sequence: unknown;
  occurred_at: unknown;
  student_id: unknown;
  student_name_snapshot: unknown;
  kind: unknown;
  legacy_total_amount: unknown;
  balance_delta: unknown;
  balance_before: unknown;
  balance_after: unknown;
  operator_snapshot: unknown;
  legacy_status_snapshot: unknown;
  reverses_transaction_id: unknown;
  schema_version: unknown;
  reversal_count: unknown;
  cancelled_at: unknown;
  cancellation_student_id: unknown;
  cancellation_balance_delta: unknown;
  reversed_transaction_at: unknown;
  reversed_transaction_kind: unknown;
  reversed_transaction_student_id: unknown;
  reversed_transaction_balance_delta: unknown;
  line_number: unknown;
};

const SUPPORTED_KINDS = new Set([
  'CHECKOUT', 'CANCELLATION', 'ADMIN_ADJUSTMENT', 'TASK_REWARD', 'LEGACY',
]);

export function createDatabaseTransactionQueries(
  dependencies: DatabaseTransactionQueryDependencies,
) {
  return {
    async getTransactions(): Promise<Transaction[]> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const rows = await readTransactionRows(transaction, dependencies.tenantId);
        return projectTransactions(rows);
      });
    },

    async getTransactionById(transactionId: string): Promise<Transaction | null> {
      assertCanonicalTransactionId(transactionId);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const rows = await readTransactionRows(transaction, dependencies.tenantId, transactionId);
        const projected = projectTransactions(rows);
        if (projected.length > 1) throw new Error('Transaction query returned duplicate rows.');
        return projected[0] ?? null;
      });
    },
  };
}

async function readTransactionRows(
  transaction: TenantTransaction,
  tenantId: string,
  transactionId?: string,
): Promise<TransactionRow[]> {
  const idPredicate = transactionId === undefined
    ? sql``
    : sql`AND t.transaction_id = ${transactionId}`;
  const result = await transaction.execute(sql`
    SELECT t.transaction_id, t.event_sequence::text AS event_sequence, t.occurred_at,
           t.student_id, t.student_name_snapshot, t.kind,
           t.legacy_total_amount::text AS legacy_total_amount,
           t.balance_delta::text AS balance_delta,
           t.balance_before::text AS balance_before,
           t.balance_after::text AS balance_after,
           t.operator_snapshot, t.legacy_status_snapshot, t.reverses_transaction_id,
           t.schema_version,
           (
             SELECT count(*)::text
             FROM transactions reversal_count_row
             WHERE reversal_count_row.tenant_id = ${tenantId}
               AND reversal_count_row.reverses_transaction_id = t.transaction_id
               AND reversal_count_row.kind = 'CANCELLATION'
           ) AS reversal_count,
           (
             SELECT max(reversal_time_row.occurred_at)
             FROM transactions reversal_time_row
             WHERE reversal_time_row.tenant_id = ${tenantId}
               AND reversal_time_row.reverses_transaction_id = t.transaction_id
               AND reversal_time_row.kind = 'CANCELLATION'
           ) AS cancelled_at,
           (
             SELECT max(reversal_student_row.student_id)
             FROM transactions reversal_student_row
             WHERE reversal_student_row.tenant_id = ${tenantId}
               AND reversal_student_row.reverses_transaction_id = t.transaction_id
               AND reversal_student_row.kind = 'CANCELLATION'
           ) AS cancellation_student_id,
           (
             SELECT max(reversal_delta_row.balance_delta)::text
             FROM transactions reversal_delta_row
             WHERE reversal_delta_row.tenant_id = ${tenantId}
               AND reversal_delta_row.reverses_transaction_id = t.transaction_id
               AND reversal_delta_row.kind = 'CANCELLATION'
           ) AS cancellation_balance_delta,
           original.occurred_at AS reversed_transaction_at,
           original.kind AS reversed_transaction_kind,
           original.student_id AS reversed_transaction_student_id,
           original.balance_delta::text AS reversed_transaction_balance_delta,
           item.line_number, item.product_id_snapshot, item.product_name_snapshot,
           item.quantity::text AS quantity,
           item.unit_price_snapshot::text AS unit_price_snapshot,
           item.subtotal_snapshot::text AS subtotal_snapshot,
           item.regular_unit_price::text AS regular_unit_price,
           item.regular_total::text AS regular_total,
           item.total_quantity::text AS total_quantity,
           item.paid_quantity::text AS paid_quantity,
           item.free_quantity::text AS free_quantity,
           item.final_total::text AS final_total,
           item.total_discount::text AS total_discount,
           item.adjustments_snapshot, item.applied_promotions_snapshot
    FROM transactions t
    LEFT JOIN transactions original
      ON original.tenant_id = ${tenantId}
     AND original.transaction_id = t.reverses_transaction_id
    LEFT JOIN transaction_items item
      ON item.tenant_id = ${tenantId}
     AND item.transaction_id = t.transaction_id
    WHERE t.tenant_id = ${tenantId}
      ${idPredicate}
    ORDER BY t.occurred_at DESC, t.event_sequence ASC, item.line_number ASC
  `);
  return result.rows as TransactionRow[];
}

function projectTransactions(rows: TransactionRow[]): Transaction[] {
  const groups = new Map<string, TransactionRow[]>();
  for (const row of rows) {
    const transactionId = requiredSnapshotString(row.transaction_id, 'Transaction ID');
    const group = groups.get(transactionId) ?? [];
    group.push(row);
    groups.set(transactionId, group);
  }
  return [...groups.values()].map(projectTransaction);
}

function projectTransaction(rows: TransactionRow[]): Transaction {
  const first = rows[0];
  if (!first) throw new Error('Transaction projection received no rows.');
  const transactionId = requiredSnapshotString(first.transaction_id, 'Transaction ID');
  const fingerprint = parentFingerprint(first);
  if (rows.some((row) => parentFingerprint(row) !== fingerprint)) {
    throw new Error(`Transaction ${transactionId} has inconsistent snapshots.`);
  }

  const schemaVersion = safeInteger(first.schema_version, 'Transaction schema version');
  if (schemaVersion !== 1) throw new Error('Transaction schema version is unsupported.');
  if (typeof first.kind !== 'string' || !SUPPORTED_KINDS.has(first.kind)) {
    throw new Error('Transaction kind is invalid.');
  }
  const kind = first.kind;
  const reversalId = nullableString(first.reverses_transaction_id, 'Reversed transaction ID');
  if ((first.kind === 'CANCELLATION') !== (reversalId !== undefined && reversalId.length > 0)) {
    throw new Error('Transaction cancellation link integrity check failed.');
  }

  const totalAmount = safeInteger(first.legacy_total_amount, 'Transaction total amount');
  const balanceDelta = safeInteger(first.balance_delta, 'Transaction balance delta');
  const balanceBefore = safeInteger(first.balance_before, 'Transaction balance before');
  const balanceAfter = safeInteger(first.balance_after, 'Transaction balance after');
  const studentId = requiredSnapshotString(first.student_id, 'Transaction student ID');
  if (!Number.isSafeInteger(balanceBefore + balanceDelta)
      || balanceBefore + balanceDelta !== balanceAfter) {
    throw new Error('Transaction balance snapshot integrity check failed.');
  }
  validateKindMoney(kind, totalAmount, balanceDelta);

  const timestamp = isoString(first.occurred_at, 'Transaction timestamp');
  const reversedTransactionAt = nullableIsoString(
    first.reversed_transaction_at,
    'Reversed transaction timestamp',
  );
  if (kind === 'CANCELLATION') {
    validateCancellationAgainstOriginal(first, studentId, balanceDelta);
    if (!reversedTransactionAt || Date.parse(timestamp) <= Date.parse(reversedTransactionAt)) {
      throw new Error('Transaction cancellation chronology integrity check failed.');
    }
  } else if (reversedTransactionAt !== undefined) {
    throw new Error('Transaction reversal chronology integrity check failed.');
  }

  const reversalCount = safeInteger(first.reversal_count, 'Transaction reversal count');
  if (reversalCount < 0 || reversalCount > 1) {
    throw new Error('Transaction reversal link integrity check failed.');
  }
  const cancelledAt = nullableIsoString(first.cancelled_at, 'Transaction cancellation timestamp');
  if ((reversalCount === 1) !== (cancelledAt !== undefined)) {
    throw new Error('Transaction cancellation timestamp integrity check failed.');
  }
  if (reversalCount === 1) {
    validateDerivedCancellation(first, kind, studentId, balanceDelta);
  }
  if (cancelledAt && Date.parse(cancelledAt) <= Date.parse(timestamp)) {
    throw new Error('Transaction cancellation chronology integrity check failed.');
  }

  const itemPositions = new Set<number>();
  const items = rows.flatMap((row) => {
    if (row.line_number === null || row.line_number === undefined) return [];
    const position = safeInteger(row.line_number, 'Transaction item position');
    if (position < 1 || itemPositions.has(position)) {
      throw new Error('Transaction item position integrity check failed.');
    }
    itemPositions.add(position);
    return [projectTransactionItem(row)];
  });
  validateItemsForKind(kind, items, totalAmount);

  const statusSnapshot = nullableString(first.legacy_status_snapshot, 'Transaction status');
  return {
    transactionId,
    timestamp,
    studentId,
    studentName: requiredSnapshotString(first.student_name_snapshot, 'Transaction student name'),
    items,
    totalAmount,
    balanceBefore,
    balanceAfter,
    status: reversalCount === 1 ? 'CANCELLED' : statusSnapshot || 'UNKNOWN',
    operator: requiredSnapshotString(first.operator_snapshot, 'Transaction operator'),
    ...(cancelledAt ? { cancelledAt } : {}),
  };
}

function parentFingerprint(row: TransactionRow): string {
  return JSON.stringify([
    row.transaction_id, row.event_sequence, canonicalFingerprintDate(row.occurred_at),
    row.student_id, row.student_name_snapshot, row.kind, String(row.legacy_total_amount),
    String(row.balance_delta), String(row.balance_before), String(row.balance_after),
    row.operator_snapshot, row.legacy_status_snapshot, row.reverses_transaction_id,
    row.schema_version, row.reversal_count, canonicalFingerprintDate(row.cancelled_at),
    row.cancellation_student_id, String(row.cancellation_balance_delta),
    canonicalFingerprintDate(row.reversed_transaction_at),
    row.reversed_transaction_kind, row.reversed_transaction_student_id,
    String(row.reversed_transaction_balance_delta),
  ]);
}

function canonicalFingerprintDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return isoString(value, 'Transaction snapshot timestamp');
}

function requiredSnapshotString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} snapshot integrity check failed.`);
  }
  return value;
}

function validateCancellationAgainstOriginal(
  row: TransactionRow,
  studentId: string,
  balanceDelta: number,
): void {
  const originalKind = row.reversed_transaction_kind;
  if (typeof originalKind !== 'string'
      || !SUPPORTED_KINDS.has(originalKind)
      || originalKind === 'CANCELLATION') {
    throw new Error('Cancellation original-kind integrity check failed.');
  }
  const originalStudentId = requiredSnapshotString(
    row.reversed_transaction_student_id,
    'Cancellation original student ID',
  );
  if (originalStudentId !== studentId) {
    throw new Error('Cancellation student integrity check failed.');
  }
  const originalDelta = safeInteger(
    row.reversed_transaction_balance_delta,
    'Cancellation original balance delta',
  );
  assertExactNegation(balanceDelta, originalDelta);
}

function validateDerivedCancellation(
  row: TransactionRow,
  originalKind: string,
  studentId: string,
  balanceDelta: number,
): void {
  if (originalKind === 'CANCELLATION') {
    throw new Error('Reversal-of-reversal kind integrity check failed.');
  }
  const cancellationStudentId = requiredSnapshotString(
    row.cancellation_student_id,
    'Cancellation student ID',
  );
  if (cancellationStudentId !== studentId) {
    throw new Error('Cancellation student integrity check failed.');
  }
  const cancellationDelta = safeInteger(
    row.cancellation_balance_delta,
    'Cancellation balance delta',
  );
  assertExactNegation(cancellationDelta, balanceDelta);
}

function assertExactNegation(value: number, original: number): void {
  const expected = -original;
  if (!Number.isSafeInteger(expected) || value !== expected) {
    throw new Error('Cancellation balance-delta reversal integrity check failed.');
  }
}

function validateKindMoney(kind: string, totalAmount: number, balanceDelta: number): void {
  if (kind === 'LEGACY') return;
  const expected = kind === 'TASK_REWARD' ? balanceDelta : -balanceDelta;
  if (!Number.isSafeInteger(expected) || totalAmount !== expected) {
    throw new Error('Transaction kind/total money integrity check failed.');
  }
}

function validateItemsForKind(
  kind: string,
  items: Transaction['items'],
  totalAmount: number,
): void {
  if (kind === 'LEGACY') return;
  if (kind !== 'CHECKOUT') {
    if (items.length !== 0) throw new Error('Transaction kind/item integrity check failed.');
    return;
  }
  if (items.length === 0) throw new Error('Checkout transaction item integrity check failed.');
  let projectedTotal = 0;
  for (const item of items) {
    const amount = 'finalTotal' in item ? item.finalTotal : item.subtotal;
    projectedTotal += amount;
    if (!Number.isSafeInteger(projectedTotal)) {
      throw new Error('Checkout transaction item total integrity check failed.');
    }
  }
  if (projectedTotal !== totalAmount) {
    throw new Error('Checkout transaction item total integrity check failed.');
  }
}

function assertCanonicalTransactionId(transactionId: string): void {
  if (!transactionId || transactionId.trim() !== transactionId) {
    throw new Error('A canonical transaction ID is required.');
  }
}
