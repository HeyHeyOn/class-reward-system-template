import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { parseCheckoutLineSnapshot } from '@/lib/checkoutSnapshotClient';
import { createTaskRewardPayloadHash } from './taskCompletionCommands';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REVERSIBLE_KINDS = new Set(['CHECKOUT', 'TASK_REWARD', 'ADMIN_ADJUSTMENT']);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseTransactionCommandDependencies = {
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
  /** Fault-injection seam after account/inventory updates and before immutable ledgers. */
  afterResourceUpdates?: () => Promise<void>;
  /** Fault-injection seam after reversal transaction and before completion/operation ledgers. */
  afterReversalTransaction?: () => Promise<void>;
};

export type CancelTransactionInput = Readonly<{
  operationId: string;
  transactionId: string;
  /** Optional trusted-caller binding; browsers send only the operation ID. */
  payloadHash?: string;
}>;

export type CancellationSuccess = Readonly<{
  ok: true;
  operationId: string;
  originalTransactionId: string;
  reversalTransactionId: string;
  studentId: string;
  studentName: string;
  originalKind: 'CHECKOUT' | 'TASK_REWARD' | 'ADMIN_ADJUSTMENT';
  reversalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  restoredItems: ReadonlyArray<Readonly<{
    productId: string;
    productName: string;
    quantity: number;
  }>>;
  originalCompletionId: string | null;
  cancellationCompletionId: string | null;
  cancelledAt: string;
}>;

export type TransactionCancellationErrorCode =
  | 'NOT_FOUND'
  | 'NOT_REVERSIBLE'
  | 'ALREADY_REVERSED'
  | 'MANUAL_RECONCILIATION_REQUIRED'
  | 'NEGATIVE_BALANCE'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_PENDING'
  | 'OPERATION_FAILED';

export class TransactionCancellationError extends Error {
  constructor(readonly code: TransactionCancellationErrorCode) {
    super(messageFor(code));
    this.name = 'TransactionCancellationError';
  }
}

type OperationRow = {
  operation_kind: string;
  payload_hash: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  result_snapshot: unknown;
  finished_at: Date | string | null;
};

type OriginalTransactionRow = {
  transaction_id: string;
  occurred_at: Date | string;
  student_id: string;
  student_name_snapshot: string;
  kind: string;
  legacy_total_amount: string | number | bigint;
  balance_delta: string | number | bigint;
  balance_before: string | number | bigint;
  balance_after: string | number | bigint;
  operator_snapshot: string;
  legacy_status_snapshot: string | null;
  reverses_transaction_id: string | null;
  operation_id: string | null;
  operation_hash: string | null;
  schema_version: number;
};

type TransactionItemRow = {
  line_number: number;
  product_id_snapshot: string;
  current_product_id: string | null;
  product_name_snapshot: string;
  quantity: string | number | bigint;
  unit_price_snapshot: string | number | bigint;
  subtotal_snapshot: string | number | bigint;
  regular_unit_price: string | number | bigint | null;
  regular_total: string | number | bigint | null;
  total_quantity: string | number | bigint | null;
  paid_quantity: string | number | bigint | null;
  free_quantity: string | number | bigint | null;
  final_total: string | number | bigint | null;
  total_discount: string | number | bigint | null;
  adjustments_snapshot: unknown;
  applied_promotions_snapshot: unknown;
};

type AccountRow = {
  student_id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  balance: string;
};

type ProductRow = {
  product_id: string;
  name: string;
  stock: string;
  deleted_at: Date | string | null;
  updated_at: Date | string;
};

type TaskCompletionRow = {
  completion_id: string;
  completed_at: Date | string;
  task_instance_id: string | null;
  task_id_snapshot: string;
  task_name_snapshot: string;
  student_id: string;
  student_name_snapshot: string;
  reward_snapshot: string | number | bigint;
  balance_before: string | number | bigint;
  balance_after: string | number | bigint;
  status: string;
  note: string | null;
  cycle_id: string | null;
  cycle_start_at: Date | string | null;
  cycle_end_at: Date | string | null;
  rule_version: number | null;
  timezone: string | null;
  source: string | null;
  assignment_id: string | null;
  transaction_id: string | null;
  operation_id: string | null;
  operation_hash: string | null;
  schema_version: number;
  evidence_provider: string | null;
  evidence_board_id: string | null;
  evidence_post_id: string | null;
  evidence_created_at: Date | string | null;
  evidence_author_full_name: string | null;
};

type TaskAssignmentRow = {
  assignment_id: string;
  task_id_snapshot: string;
  task_instance_id: string;
  cycle_id: string;
  cycle_start_at: Date | string;
  cycle_end_at: Date | string | null;
  rule_version: number;
  timezone: string;
  student_id: string;
  event_type: string;
  source: string;
  schema_version: number;
};

type CancellationState = {
  original: OriginalTransactionRow & { kind: CancellationSuccess['originalKind'] };
  items: TransactionItemRow[];
  restoredItems: CancellationSuccess['restoredItems'];
  originalCompletion: TaskCompletionRow | null;
  payloadHash: string;
};

export function createDatabaseTransactionCommands(
  dependencies: DatabaseTransactionCommandDependencies,
) {
  return {
    async cancel(rawInput: CancelTransactionInput): Promise<CancellationSuccess> {
      const input = canonicalizeInput(rawInput);
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid cancellation timestamp is required.');

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        // LOCK ORDER: an existing operation row (when present), original transaction,
        // student/account, then products in stable product_id order. A fresh operation has
        // no row to lock and is serialized by the unique INSERT ... ON CONFLICT below.
        // PGlite exercises this sequentially; real multi-session PostgreSQL lock behavior
        // is covered by the later concurrency task.
        const initiallyExisting = await readOperation(tx, dependencies.tenantId, input.operationId, true);
        const state = await readAndValidateOriginal(tx, dependencies.tenantId, input.transactionId);

        if (input.payloadHash && input.payloadHash !== state.payloadHash) {
          throw new TransactionCancellationError('OPERATION_CONFLICT');
        }
        if (initiallyExisting) {
          return resolveExistingOperation(tx, dependencies.tenantId, input, state, initiallyExisting);
        }

        const priorReversal = await readReversalForOriginal(
          tx, dependencies.tenantId, input.transactionId, true,
        );
        if (priorReversal) throw new TransactionCancellationError('ALREADY_REVERSED');

        const inserted = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status,
             attempt_count, started_at, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.operationId}, 'CANCELLATION', ${state.payloadHash},
             'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        const operation = await readOperation(tx, dependencies.tenantId, input.operationId, true);
        if (!operation) throw new Error('Cancellation operation could not be read.');
        if (inserted.rows.length === 0) {
          return resolveExistingOperation(tx, dependencies.tenantId, input, state, operation);
        }

        const accountResult = await tx.execute(sql`
          SELECT s.student_id, s.name, s.status, a.balance::text AS balance
          FROM students s
          JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
          WHERE s.tenant_id=${dependencies.tenantId} AND s.student_id=${state.original.student_id}
          FOR UPDATE OF s, a
        `);
        const account = accountResult.rows[0] as AccountRow | undefined;
        if (!account || account.status !== 'ACTIVE') {
          throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
        }
        const currentBalance = safeInteger(account.balance, 'account balance');
        const originalDelta = safeInteger(state.original.balance_delta, 'original balance delta');
        const reversalDelta = checkedNegation(originalDelta, 'original balance delta');
        const balanceAfter = checkedSum(currentBalance, reversalDelta, 'cancellation balance');
        if (balanceAfter < 0) throw new TransactionCancellationError('NEGATIVE_BALANCE');

        const productIds = state.restoredItems.map((item) => item.productId);
        const products = productIds.length > 0
          ? await lockProducts(tx, dependencies.tenantId, productIds)
          : [];
        const productById = new Map(products.map((product) => [product.product_id, product]));
        if (productById.size !== productIds.length) {
          throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
        }

        await tx.execute(sql`
          UPDATE accounts
          SET balance=${balanceAfter}, version=version+1, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND student_id=${state.original.student_id}
        `);
        const restoredStock = new Map<string, { before: number; after: number }>();
        for (const item of state.restoredItems) {
          const product = productById.get(item.productId);
          if (!product || product.name !== item.productName) {
            throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
          }
          if (product.deleted_at !== null) {
            const deletedAt = product.deleted_at instanceof Date
              ? product.deleted_at
              : new Date(product.deleted_at);
            const updatedAt = product.updated_at instanceof Date
              ? product.updated_at
              : new Date(product.updated_at);
            if (!Number.isFinite(deletedAt.getTime()) || !Number.isFinite(updatedAt.getTime())
              || now.getTime() <= deletedAt.getTime() || now.getTime() <= updatedAt.getTime()) {
              throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
            }
          }
          const before = safeInteger(product.stock, `stock for ${item.productId}`);
          const after = checkedSum(before, item.quantity, `stock for ${item.productId}`);
          if (after < 0) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
          await tx.execute(sql`
            UPDATE products SET stock=${after}, version=version+1, updated_at=${now}
            WHERE tenant_id=${dependencies.tenantId} AND product_id=${item.productId}
          `);
          restoredStock.set(item.productId, { before, after });
        }
        await dependencies.afterResourceUpdates?.();

        const reversalTransactionId = cancellationTransactionId(input.operationId);
        await tx.execute(sql`
          INSERT INTO transactions
            (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
             legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
             legacy_status_snapshot, reverses_transaction_id, operation_id, operation_hash,
             schema_version)
          VALUES
            (${dependencies.tenantId}, ${reversalTransactionId}, ${now}, ${state.original.student_id},
             ${state.original.student_name_snapshot}, 'CANCELLATION', ${checkedNegation(reversalDelta, 'reversal amount')},
             ${reversalDelta}, ${currentBalance}, ${balanceAfter}, 'admin-cancellation',
             'CANCEL_REVERSAL', ${state.original.transaction_id}, ${input.operationId},
             ${state.payloadHash}, 1)
        `);
        await dependencies.afterReversalTransaction?.();
        const cancellationCompletionId = state.originalCompletion
          ? cancellationTaskCompletionId(input.operationId)
          : null;
        if (state.originalCompletion) {
          const completion = state.originalCompletion;
          await tx.execute(sql`
            INSERT INTO task_completions
              (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
               task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
               balance_before, balance_after, status, note, cycle_id, cycle_start_at,
               cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
               operation_id, operation_hash, schema_version, evidence_provider,
               evidence_board_id, evidence_post_id, evidence_created_at,
               evidence_author_full_name)
            VALUES
              (${dependencies.tenantId}, ${cancellationCompletionId}, ${now},
               ${completion.task_instance_id}, ${completion.task_id_snapshot},
               ${completion.task_name_snapshot}, ${completion.student_id},
               ${completion.student_name_snapshot}, ${safeInteger(completion.reward_snapshot, 'completion reward')},
               ${currentBalance}, ${balanceAfter}, 'CANCELLED',
               ${`cancels-completion:${completion.completion_id}`}, ${completion.cycle_id},
               ${completion.cycle_start_at}, ${completion.cycle_end_at}, ${completion.rule_version},
               ${completion.timezone}, 'ADMIN_RESET', ${completion.assignment_id},
               ${reversalTransactionId}, ${input.operationId}, ${state.payloadHash}, 1,
               NULL, NULL, NULL, NULL, NULL)
          `);
        }
        for (const item of state.restoredItems) {
          const stock = restoredStock.get(item.productId);
          if (!stock) throw new Error('Locked cancellation product disappeared.');
          await tx.execute(sql`
            INSERT INTO inventory_ledger
              (tenant_id, product_id, transaction_id, quantity_delta, stock_before, stock_after,
               reason, operation_id, operation_hash, occurred_at)
            VALUES
              (${dependencies.tenantId}, ${item.productId}, ${reversalTransactionId}, ${item.quantity},
               ${stock.before}, ${stock.after}, 'CANCELLATION', NULL, NULL, ${now})
          `);
        }

        const result: CancellationSuccess = {
          ok: true,
          operationId: input.operationId,
          originalTransactionId: state.original.transaction_id,
          reversalTransactionId,
          studentId: state.original.student_id,
          studentName: state.original.student_name_snapshot,
          originalKind: state.original.kind,
          reversalAmount: reversalDelta,
          balanceBefore: currentBalance,
          balanceAfter,
          restoredItems: state.restoredItems,
          originalCompletionId: state.originalCompletion?.completion_id ?? null,
          cancellationCompletionId,
          cancelledAt: now.toISOString(),
        };
        await appendOperationAudit(
          tx,
          dependencies.tenantId,
          cancellationAuditInput(input.operationId, result, now),
        );
        await tx.execute(sql`
          UPDATE operations
          SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
              finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
        `);
        return result;
      });
    },
  };
}

async function readAndValidateOriginal(
  tx: TenantTransaction,
  tenantId: string,
  transactionId: string,
): Promise<CancellationState> {
  const originalResult = await tx.execute(sql`
    SELECT transaction_id, occurred_at, student_id, student_name_snapshot, kind,
           legacy_total_amount::text AS legacy_total_amount,
           balance_delta::text AS balance_delta, balance_before::text AS balance_before,
           balance_after::text AS balance_after, operator_snapshot, legacy_status_snapshot,
           reverses_transaction_id, operation_id, operation_hash, schema_version
    FROM transactions
    WHERE tenant_id=${tenantId} AND transaction_id=${transactionId}
    FOR UPDATE
  `);
  const original = originalResult.rows[0] as OriginalTransactionRow | undefined;
  if (!original) throw new TransactionCancellationError('NOT_FOUND');
  if (!REVERSIBLE_KINDS.has(original.kind) || original.reverses_transaction_id !== null) {
    throw new TransactionCancellationError('NOT_REVERSIBLE');
  }

  validateOriginalMoney(original);
  const completionRows = await readTaskCompletionsForTransaction(tx, tenantId, transactionId, true);
  const originalCompletion = validateOriginalCompletion(original, completionRows);
  if (originalCompletion) {
    await readAndValidateOriginalAssignment(tx, tenantId, originalCompletion);
  }
  const itemResult = await tx.execute(sql`
    SELECT line_number, product_id_snapshot, current_product_id, product_name_snapshot,
           quantity::text AS quantity, unit_price_snapshot::text AS unit_price_snapshot,
           subtotal_snapshot::text AS subtotal_snapshot,
           regular_unit_price::text AS regular_unit_price, regular_total::text AS regular_total,
           total_quantity::text AS total_quantity, paid_quantity::text AS paid_quantity,
           free_quantity::text AS free_quantity, final_total::text AS final_total,
           total_discount::text AS total_discount, adjustments_snapshot,
           applied_promotions_snapshot
    FROM transaction_items
    WHERE tenant_id=${tenantId} AND transaction_id=${transactionId}
    ORDER BY line_number
    FOR UPDATE
  `);
  const items = itemResult.rows as TransactionItemRow[];
  const restoredItems = validateItems(original, items);
  const typedOriginal = original as CancellationState['original'];
  return {
    original: typedOriginal,
    items,
    restoredItems,
    originalCompletion,
    payloadHash: createCancellationPayloadHash(typedOriginal, items, originalCompletion),
  };
}

function validateOriginalMoney(original: OriginalTransactionRow): void {
  const delta = safeInteger(original.balance_delta, 'original balance delta');
  const before = safeInteger(original.balance_before, 'original balance before');
  const after = safeInteger(original.balance_after, 'original balance after');
  safeInteger(original.legacy_total_amount, 'original legacy total');
  if (checkedSum(before, delta, 'original balance snapshot') !== after) {
    throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  }
}

async function readTaskCompletionsForTransaction(
  tx: TenantTransaction,
  tenantId: string,
  transactionId: string,
  lock: boolean,
): Promise<TaskCompletionRow[]> {
  const statement = sql`
    SELECT completion_id, completed_at, task_instance_id, task_id_snapshot,
           task_name_snapshot, student_id, student_name_snapshot,
           reward_snapshot::text AS reward_snapshot,
           balance_before::text AS balance_before, balance_after::text AS balance_after,
           status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
           source, assignment_id, transaction_id, operation_id, operation_hash,
           schema_version, evidence_provider, evidence_board_id, evidence_post_id,
           evidence_created_at, evidence_author_full_name
    FROM task_completions
    WHERE tenant_id=${tenantId} AND transaction_id=${transactionId}
    ORDER BY completion_id
  `;
  const result = lock
    ? await tx.execute(sql`${statement} FOR UPDATE`)
    : await tx.execute(statement);
  return result.rows as TaskCompletionRow[];
}

function validateOriginalCompletion(
  original: OriginalTransactionRow,
  rows: TaskCompletionRow[],
): TaskCompletionRow | null {
  if (original.kind !== 'TASK_REWARD') {
    if (rows.length !== 0) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
    return null;
  }
  if (rows.length !== 1) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  const row = rows[0];
  const reward = safeInteger(row.reward_snapshot, 'original completion reward');
  const delta = safeInteger(original.balance_delta, 'original task reward delta');
  const evidence = [
    row.evidence_provider, row.evidence_board_id, row.evidence_post_id,
    row.evidence_created_at, row.evidence_author_full_name,
  ];
  const evidenceCount = evidence.filter((value) => value !== null).length;
  const hasValidEvidence = evidenceCount === 0 || (evidenceCount === evidence.length
    && row.evidence_provider === 'PADLET'
    && isNonblank(row.evidence_board_id)
    && isNonblank(row.evidence_post_id)
    && canonicalTimestamp(row.evidence_created_at as Date | string).length > 0
    && isNonblank(row.evidence_author_full_name));
  const validCycle = isNonblank(row.task_instance_id)
    && isNonblank(row.cycle_id)
    && row.cycle_start_at !== null
    && Number.isSafeInteger(row.rule_version)
    && (row.rule_version as number) >= 1
    && row.timezone === 'Asia/Seoul'
    && (row.cycle_end_at === null
      || new Date(row.cycle_end_at).getTime() > new Date(row.cycle_start_at).getTime());
  let rewardPayloadHash: string | null = null;
  if (hasValidEvidence && validCycle && isNonblank(row.assignment_id)) {
    try {
      rewardPayloadHash = createTaskRewardPayloadHash({
        taskId: row.task_id_snapshot,
        taskInstanceId: row.task_instance_id as string,
        taskTitle: row.task_name_snapshot,
        studentId: row.student_id,
        studentName: row.student_name_snapshot,
        assignmentId: row.assignment_id,
        cycleId: row.cycle_id as string,
        cycleStartsAt: canonicalTimestamp(row.cycle_start_at as Date | string),
        cycleEndsAt: row.cycle_end_at === null ? null : canonicalTimestamp(row.cycle_end_at),
        reward,
        ...(evidenceCount === evidence.length ? {
          evidence: {
            evidenceProvider: row.evidence_provider as 'PADLET',
            evidenceBoardId: row.evidence_board_id as string,
            evidencePostId: row.evidence_post_id as string,
            evidenceCreatedAt: canonicalTimestamp(row.evidence_created_at as Date | string),
            evidenceAuthorFullName: row.evidence_author_full_name as string,
          },
        } : {}),
      });
    } catch {
      rewardPayloadHash = null;
    }
  }
  if (row.status !== 'COMPLETED'
      || row.student_id !== original.student_id
      || row.student_name_snapshot !== original.student_name_snapshot
      || !isNonblank(row.task_id_snapshot)
      || !isNonblank(row.task_name_snapshot)
      || !validCycle
      || !isNonblank(row.assignment_id)
      || reward <= 0
      || reward !== delta
      || reward !== safeInteger(original.legacy_total_amount, 'original task reward total')
      || safeInteger(row.balance_before, 'original completion balance before') !== safeInteger(original.balance_before, 'original transaction balance before')
      || safeInteger(row.balance_after, 'original completion balance after') !== safeInteger(original.balance_after, 'original transaction balance after')
      || row.transaction_id !== original.transaction_id
      || row.operation_id !== original.operation_id
      || row.operation_hash !== original.operation_hash
      || original.transaction_id !== `task-reward:${row.operation_id}`
      || row.completion_id !== `task-completion:${row.operation_id}`
      || rewardPayloadHash === null
      || rewardPayloadHash !== row.operation_hash
      || !row.operation_id || !UUID.test(row.operation_id)
      || !row.operation_hash || !SHA256.test(row.operation_hash)
      || row.schema_version !== 1
      || original.schema_version !== 1
      || original.operator_snapshot !== 'bank-task-completion'
      || original.legacy_status_snapshot !== 'COMPLETED'
      || canonicalTimestamp(row.completed_at) !== canonicalTimestamp(original.occurred_at)
      || row.source !== 'BANK'
      || row.note !== 'bank-self-completion'
      || !hasValidEvidence) {
    throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  }
  return row;
}

async function readAndValidateOriginalAssignment(
  tx: TenantTransaction,
  tenantId: string,
  completion: TaskCompletionRow,
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT assignment_id, task_id_snapshot, task_instance_id, cycle_id,
           cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
           event_type, source, schema_version
    FROM task_assignments
    WHERE tenant_id=${tenantId} AND assignment_id=${completion.assignment_id}
    FOR UPDATE
  `);
  const assignment = result.rows[0] as TaskAssignmentRow | undefined;
  const validSource = assignment
    && ['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(assignment.source);
  if (result.rows.length !== 1
      || !assignment
      || assignment.assignment_id !== completion.assignment_id
      || assignment.task_id_snapshot !== completion.task_id_snapshot
      || assignment.task_instance_id !== completion.task_instance_id
      || assignment.student_id !== completion.student_id
      || assignment.cycle_id !== completion.cycle_id
      || canonicalTimestamp(assignment.cycle_start_at) !== nullableTimestamp(completion.cycle_start_at)
      || nullableTimestamp(assignment.cycle_end_at) !== nullableTimestamp(completion.cycle_end_at)
      || assignment.rule_version !== completion.rule_version
      || assignment.timezone !== completion.timezone
      || assignment.event_type !== 'ASSIGNED'
      || !validSource
      || !Number.isSafeInteger(assignment.schema_version)
      || assignment.schema_version < 1) {
    throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  }
}

function validateItems(
  original: OriginalTransactionRow,
  items: TransactionItemRow[],
): CancellationSuccess['restoredItems'] {
  if (original.kind !== 'CHECKOUT') {
    if (items.length !== 0) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
    return [];
  }
  if (items.length === 0) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  const seenProducts = new Set<string>();
  let finalTotal = 0;
  const restored: Array<{ productId: string; productName: string; quantity: number }> = [];
  for (const [index, item] of items.entries()) {
    if (item.line_number !== index + 1
        || !item.product_id_snapshot
        || item.current_product_id !== item.product_id_snapshot
        || !item.product_name_snapshot
        || seenProducts.has(item.product_id_snapshot)) {
      throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
    }
    seenProducts.add(item.product_id_snapshot);
    const parsed = parseCheckoutLineSnapshot({
      productId: item.product_id_snapshot,
      name: item.product_name_snapshot,
      price: safeInteger(item.unit_price_snapshot, `unit price for ${item.product_id_snapshot}`),
      quantity: safeInteger(item.quantity, `quantity for ${item.product_id_snapshot}`),
      subtotal: safeInteger(item.subtotal_snapshot, `subtotal for ${item.product_id_snapshot}`),
      regularUnitPrice: safeInteger(item.regular_unit_price, `regular unit price for ${item.product_id_snapshot}`),
      regularTotal: safeInteger(item.regular_total, `regular total for ${item.product_id_snapshot}`),
      totalQuantity: safeInteger(item.total_quantity, `total quantity for ${item.product_id_snapshot}`),
      paidQuantity: safeInteger(item.paid_quantity, `paid quantity for ${item.product_id_snapshot}`),
      freeQuantity: safeInteger(item.free_quantity, `free quantity for ${item.product_id_snapshot}`),
      finalTotal: safeInteger(item.final_total, `final total for ${item.product_id_snapshot}`),
      totalDiscount: safeInteger(item.total_discount, `discount for ${item.product_id_snapshot}`),
      adjustments: item.adjustments_snapshot,
      appliedPromotions: item.applied_promotions_snapshot,
    });
    if (!parsed) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
    finalTotal = checkedSum(finalTotal, parsed.finalTotal, 'checkout final total');
    restored.push({
      productId: item.product_id_snapshot,
      productName: item.product_name_snapshot,
      quantity: parsed.totalQuantity,
    });
  }
  const legacyTotal = safeInteger(original.legacy_total_amount, 'checkout total');
  const delta = safeInteger(original.balance_delta, 'checkout balance delta');
  if (finalTotal !== legacyTotal || checkedNegation(delta, 'checkout balance delta') !== legacyTotal) {
    throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  }
  return restored.sort((left, right) => left.productId.localeCompare(right.productId));
}

async function lockProducts(
  tx: TenantTransaction,
  tenantId: string,
  productIds: string[],
): Promise<ProductRow[]> {
  const result = await tx.execute(sql`
    SELECT product_id, name, stock::text AS stock, deleted_at, updated_at
    FROM products
    WHERE tenant_id=${tenantId}
      AND product_id IN (${sql.join(productIds.map((productId) => sql`${productId}`), sql`, `)})
    ORDER BY product_id
    FOR UPDATE
  `);
  return result.rows as ProductRow[];
}

async function readOperation(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
  lock: boolean,
): Promise<OperationRow | undefined> {
  const result = await tx.execute(lock ? sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  ` : sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
  `);
  return result.rows[0] as OperationRow | undefined;
}

async function readReversalForOriginal(
  tx: TenantTransaction,
  tenantId: string,
  originalTransactionId: string,
  lock: boolean,
): Promise<OriginalTransactionRow | undefined> {
  const result = await tx.execute(lock ? sql`
    SELECT transaction_id, occurred_at, student_id, student_name_snapshot, kind,
           legacy_total_amount::text AS legacy_total_amount, balance_delta::text AS balance_delta,
           balance_before::text AS balance_before, balance_after::text AS balance_after,
           operator_snapshot, legacy_status_snapshot, reverses_transaction_id,
           operation_id, operation_hash, schema_version
    FROM transactions
    WHERE tenant_id=${tenantId} AND reverses_transaction_id=${originalTransactionId}
    ORDER BY transaction_id
    FOR UPDATE
  ` : sql`
    SELECT transaction_id, occurred_at, student_id, student_name_snapshot, kind,
           legacy_total_amount::text AS legacy_total_amount, balance_delta::text AS balance_delta,
           balance_before::text AS balance_before, balance_after::text AS balance_after,
           operator_snapshot, legacy_status_snapshot, reverses_transaction_id,
           operation_id, operation_hash, schema_version
    FROM transactions
    WHERE tenant_id=${tenantId} AND reverses_transaction_id=${originalTransactionId}
    ORDER BY transaction_id
  `);
  if (result.rows.length > 1) throw new Error('Cancellation reversal integrity failure.');
  return result.rows[0] as OriginalTransactionRow | undefined;
}

async function resolveExistingOperation(
  tx: TenantTransaction,
  tenantId: string,
  input: CancelTransactionInput,
  state: CancellationState,
  operation: OperationRow,
): Promise<CancellationSuccess> {
  if (operation.operation_kind !== 'CANCELLATION' || operation.payload_hash !== state.payloadHash) {
    throw new TransactionCancellationError('OPERATION_CONFLICT');
  }
  if (operation.status === 'PENDING') throw new TransactionCancellationError('OPERATION_PENDING');
  if (operation.status === 'FAILED') throw new TransactionCancellationError('OPERATION_FAILED');
  const result = parseStoredResult(operation.result_snapshot, input, state);
  await validateStoredLedgers(tx, tenantId, state, result);
  await assertOperationAudit(
    tx,
    tenantId,
    cancellationAuditInput(input.operationId, result, requiredAuditDate(operation.finished_at)),
  );
  return result;
}

function cancellationAuditInput(
  operationId: string,
  result: CancellationSuccess,
  occurredAt: Date,
) {
  return {
    operationId,
    eventType: 'CANCELLATION_COMPLETED',
    entityType: 'TRANSACTION',
    entityId: result.reversalTransactionId,
    redactedDetails: {
      originalTransactionId: result.originalTransactionId,
      cancellationTransactionId: result.reversalTransactionId,
      studentId: result.studentId,
      reversalAmount: result.reversalAmount,
    },
    occurredAt,
  } as const;
}

function requiredAuditDate(value: Date | string | null): Date {
  if (value === null) throw new Error('Cancellation audit integrity check failed.');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Cancellation audit integrity check failed.');
  return date;
}

function parseStoredResult(
  value: unknown,
  input: CancelTransactionInput,
  state: CancellationState,
): CancellationSuccess {
  if (!isRecord(value)) throw new Error('Stored cancellation result is invalid.');
  const expectedKeys = ['ok', 'operationId', 'originalTransactionId', 'reversalTransactionId',
    'studentId', 'studentName', 'originalKind', 'reversalAmount', 'balanceBefore',
    'balanceAfter', 'restoredItems', 'originalCompletionId', 'cancellationCompletionId',
    'cancelledAt'];
  if (Object.keys(value).sort().join('|') !== [...expectedKeys].sort().join('|')
      || value.ok !== true
      || value.operationId !== input.operationId
      || value.originalTransactionId !== state.original.transaction_id
      || value.reversalTransactionId !== cancellationTransactionId(input.operationId)
      || value.studentId !== state.original.student_id
      || value.studentName !== state.original.student_name_snapshot
      || value.originalKind !== state.original.kind
      || !Number.isSafeInteger(value.reversalAmount)
      || value.reversalAmount !== checkedNegation(safeInteger(state.original.balance_delta, 'original balance delta'), 'original balance delta')
      || !Number.isSafeInteger(value.balanceBefore)
      || !Number.isSafeInteger(value.balanceAfter)
      || checkedSum(value.balanceBefore as number, value.reversalAmount as number, 'stored cancellation result') !== value.balanceAfter
      || !storedItemsMatch(value.restoredItems, state.restoredItems)
      || value.originalCompletionId !== (state.originalCompletion?.completion_id ?? null)
      || value.cancellationCompletionId !== (state.originalCompletion
        ? cancellationTaskCompletionId(input.operationId)
        : null)
      || typeof value.cancelledAt !== 'string'
      || !Number.isFinite(new Date(value.cancelledAt).getTime())) {
    throw new Error('Stored cancellation result is invalid.');
  }
  return value as CancellationSuccess;
}

async function validateStoredLedgers(
  tx: TenantTransaction,
  tenantId: string,
  state: CancellationState,
  result: CancellationSuccess,
): Promise<void> {
  const reversal = await readReversalForOriginal(tx, tenantId, state.original.transaction_id, true);
  if (!reversal
      || reversal.transaction_id !== result.reversalTransactionId
      || reversal.kind !== 'CANCELLATION'
      || reversal.student_id !== result.studentId
      || reversal.student_name_snapshot !== result.studentName
      || safeInteger(reversal.balance_delta, 'stored reversal delta') !== result.reversalAmount
      || safeInteger(reversal.balance_before, 'stored reversal balance before') !== result.balanceBefore
      || safeInteger(reversal.balance_after, 'stored reversal balance after') !== result.balanceAfter
      || safeInteger(reversal.legacy_total_amount, 'stored reversal legacy total') !== checkedNegation(result.reversalAmount, 'stored reversal amount')
      || reversal.operator_snapshot !== 'admin-cancellation'
      || reversal.legacy_status_snapshot !== 'CANCEL_REVERSAL'
      || reversal.operation_id !== result.operationId
      || reversal.operation_hash !== state.payloadHash
      || canonicalTimestamp(reversal.occurred_at) !== result.cancelledAt
      || reversal.schema_version !== 1) {
    throw new Error('Stored cancellation ledger integrity failure.');
  }
  const cancellationCompletions = await readTaskCompletionsForTransaction(
    tx, tenantId, result.reversalTransactionId, true,
  );
  validateCancellationCompletion(state, result, cancellationCompletions);
  const reversalItems = await tx.execute(sql`
    SELECT line_number
    FROM transaction_items
    WHERE tenant_id=${tenantId} AND transaction_id=${result.reversalTransactionId}
    FOR UPDATE
  `);
  if (reversalItems.rows.length !== 0) {
    throw new Error('Stored cancellation item integrity failure.');
  }
  const ledgerResult = await tx.execute(sql`
    SELECT product_id, transaction_id, quantity_delta::text AS quantity_delta,
           stock_before::text AS stock_before, stock_after::text AS stock_after,
           reason, operation_id, operation_hash, occurred_at
    FROM inventory_ledger
    WHERE tenant_id=${tenantId} AND transaction_id=${result.reversalTransactionId}
    ORDER BY product_id
    FOR UPDATE
  `);
  const ledger = ledgerResult.rows as Array<{
    product_id: string; transaction_id: string; quantity_delta: string;
    stock_before: string; stock_after: string; reason: string;
    operation_id: string | null; operation_hash: string | null;
    occurred_at: Date | string;
  }>;
  if (ledger.length !== state.restoredItems.length) throw new Error('Stored cancellation inventory ledger integrity failure.');
  for (const [index, item] of state.restoredItems.entries()) {
    const row = ledger[index];
    if (!row || row.product_id !== item.productId
        || row.transaction_id !== result.reversalTransactionId
        || safeInteger(row.quantity_delta, 'stored inventory delta') !== item.quantity
        || checkedSum(safeInteger(row.stock_before, 'stored stock before'), item.quantity, 'stored stock') !== safeInteger(row.stock_after, 'stored stock after')
        || row.reason !== 'CANCELLATION' || row.operation_id !== null || row.operation_hash !== null
        || canonicalTimestamp(row.occurred_at) !== result.cancelledAt) {
      throw new Error('Stored cancellation inventory ledger integrity failure.');
    }
  }
}

function validateCancellationCompletion(
  state: CancellationState,
  result: CancellationSuccess,
  rows: TaskCompletionRow[],
): void {
  const original = state.originalCompletion;
  if (!original) {
    if (rows.length !== 0
        || result.originalCompletionId !== null
        || result.cancellationCompletionId !== null) {
      throw new Error('Stored cancellation completion integrity failure.');
    }
    return;
  }
  if (rows.length !== 1) throw new Error('Stored cancellation completion integrity failure.');
  const row = rows[0];
  if (row.completion_id !== result.cancellationCompletionId
      || result.originalCompletionId !== original.completion_id
      || row.completed_at === null
      || canonicalTimestamp(row.completed_at) !== result.cancelledAt
      || row.task_instance_id !== original.task_instance_id
      || row.task_id_snapshot !== original.task_id_snapshot
      || row.task_name_snapshot !== original.task_name_snapshot
      || row.student_id !== original.student_id
      || row.student_name_snapshot !== original.student_name_snapshot
      || safeInteger(row.reward_snapshot, 'stored cancellation completion reward') !== safeInteger(original.reward_snapshot, 'original completion reward')
      || safeInteger(row.balance_before, 'stored cancellation completion balance before') !== result.balanceBefore
      || safeInteger(row.balance_after, 'stored cancellation completion balance after') !== result.balanceAfter
      || row.status !== 'CANCELLED'
      || row.note !== `cancels-completion:${original.completion_id}`
      || row.cycle_id !== original.cycle_id
      || nullableTimestamp(row.cycle_start_at) !== nullableTimestamp(original.cycle_start_at)
      || nullableTimestamp(row.cycle_end_at) !== nullableTimestamp(original.cycle_end_at)
      || row.rule_version !== original.rule_version
      || row.timezone !== original.timezone
      || row.source !== 'ADMIN_RESET'
      || row.assignment_id !== original.assignment_id
      || row.transaction_id !== result.reversalTransactionId
      || row.operation_id !== result.operationId
      || row.operation_hash !== state.payloadHash
      || row.schema_version !== 1
      || [row.evidence_provider, row.evidence_board_id, row.evidence_post_id,
        row.evidence_created_at, row.evidence_author_full_name].some((value) => value !== null)) {
    throw new Error('Stored cancellation completion integrity failure.');
  }
}

export function createCancellationPayloadHash(
  original: OriginalTransactionRow,
  items: readonly TransactionItemRow[],
  originalCompletion: TaskCompletionRow | null = null,
): string {
  const canonical = JSON.stringify({
    kind: 'CANCELLATION',
    original: {
      transactionId: original.transaction_id,
      occurredAt: canonicalTimestamp(original.occurred_at),
      studentId: original.student_id,
      studentName: original.student_name_snapshot,
      kind: original.kind,
      legacyTotalAmount: canonicalInteger(original.legacy_total_amount),
      balanceDelta: canonicalInteger(original.balance_delta),
      balanceBefore: canonicalInteger(original.balance_before),
      balanceAfter: canonicalInteger(original.balance_after),
      operator: original.operator_snapshot,
      legacyStatus: original.legacy_status_snapshot,
      operationId: original.operation_id,
      operationHash: original.operation_hash,
      schemaVersion: original.schema_version,
    },
    originalCompletion: originalCompletion ? {
      completionId: originalCompletion.completion_id,
      completedAt: canonicalTimestamp(originalCompletion.completed_at),
      taskInstanceId: originalCompletion.task_instance_id,
      taskId: originalCompletion.task_id_snapshot,
      taskName: originalCompletion.task_name_snapshot,
      studentId: originalCompletion.student_id,
      studentName: originalCompletion.student_name_snapshot,
      reward: canonicalInteger(originalCompletion.reward_snapshot),
      balanceBefore: canonicalInteger(originalCompletion.balance_before),
      balanceAfter: canonicalInteger(originalCompletion.balance_after),
      status: originalCompletion.status,
      note: originalCompletion.note,
      cycleId: originalCompletion.cycle_id,
      cycleStartsAt: nullableTimestamp(originalCompletion.cycle_start_at),
      cycleEndsAt: nullableTimestamp(originalCompletion.cycle_end_at),
      ruleVersion: originalCompletion.rule_version,
      timezone: originalCompletion.timezone,
      source: originalCompletion.source,
      assignmentId: originalCompletion.assignment_id,
      transactionId: originalCompletion.transaction_id,
      operationId: originalCompletion.operation_id,
      operationHash: originalCompletion.operation_hash,
      schemaVersion: originalCompletion.schema_version,
      evidence: originalCompletion.evidence_provider === null ? null : {
        provider: originalCompletion.evidence_provider,
        boardId: originalCompletion.evidence_board_id,
        postId: originalCompletion.evidence_post_id,
        createdAt: nullableTimestamp(originalCompletion.evidence_created_at),
        authorFullName: originalCompletion.evidence_author_full_name,
      },
    } : null,
    items: [...items].sort((left, right) => left.line_number - right.line_number).map((item) => ({
      lineNumber: item.line_number,
      productId: item.product_id_snapshot,
      currentProductId: item.current_product_id,
      productName: item.product_name_snapshot,
      quantity: canonicalInteger(item.quantity),
      unitPrice: canonicalInteger(item.unit_price_snapshot),
      subtotal: canonicalInteger(item.subtotal_snapshot),
      regularUnitPrice: nullableCanonicalInteger(item.regular_unit_price),
      regularTotal: nullableCanonicalInteger(item.regular_total),
      totalQuantity: nullableCanonicalInteger(item.total_quantity),
      paidQuantity: nullableCanonicalInteger(item.paid_quantity),
      freeQuantity: nullableCanonicalInteger(item.free_quantity),
      finalTotal: nullableCanonicalInteger(item.final_total),
      totalDiscount: nullableCanonicalInteger(item.total_discount),
      adjustments: item.adjustments_snapshot,
      appliedPromotions: item.applied_promotions_snapshot,
    })),
    reversal: {
      transactionKind: 'CANCELLATION',
      operatorSnapshot: 'admin-cancellation',
      legacyStatusSnapshot: 'CANCEL_REVERSAL',
      inventoryReason: 'CANCELLATION',
    },
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalizeInput(input: CancelTransactionInput): CancelTransactionInput {
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  if (typeof input.transactionId !== 'string' || !input.transactionId.trim()
      || input.transactionId !== input.transactionId.trim()) {
    throw new Error('A nonblank, trimmed transaction ID is required.');
  }
  if (input.payloadHash !== undefined
      && (typeof input.payloadHash !== 'string' || !SHA256.test(input.payloadHash))) {
    throw new Error('A lowercase SHA-256 payload hash is required.');
  }
  return input;
}

function cancellationTransactionId(operationId: string): string {
  return `cancellation:${operationId}`;
}

/** Distinct from transaction IDs and original task-completion IDs. */
function cancellationTaskCompletionId(operationId: string): string {
  return `task-completion-cancellation:${operationId}`;
}

function safeInteger(value: string | number | bigint | null, label: string): number {
  if (value === null) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  let parsed: bigint;
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  }
  if (parsed > MAX_SAFE || parsed < MIN_SAFE) throw new Error(`Unsafe integer for ${label}.`);
  return Number(parsed);
}

function checkedSum(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(left + right)) {
    throw new Error(`Unsafe integer for ${label}.`);
  }
  return left + right;
}

function checkedNegation(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(-value)) {
    throw new Error(`Unsafe integer for ${label}.`);
  }
  return -value;
}

function canonicalInteger(value: string | number | bigint): string {
  return BigInt(value).toString();
}

function nullableCanonicalInteger(value: string | number | bigint | null): string | null {
  return value === null ? null : canonicalInteger(value);
}

function canonicalTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TransactionCancellationError('MANUAL_RECONCILIATION_REQUIRED');
  return date.toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : canonicalTimestamp(value);
}

function isNonblank(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function storedItemsMatch(
  value: unknown,
  expected: CancellationSuccess['restoredItems'],
): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((candidate, index) => {
    const item = expected[index];
    return isRecord(candidate)
      && Object.keys(candidate).sort().join('|') === 'productId|productName|quantity'
      && candidate.productId === item.productId
      && candidate.productName === item.productName
      && candidate.quantity === item.quantity;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageFor(code: TransactionCancellationErrorCode): string {
  switch (code) {
    case 'NOT_FOUND': return '거래 내역을 찾을 수 없습니다.';
    case 'NOT_REVERSIBLE': return '취소할 수 없는 거래입니다.';
    case 'ALREADY_REVERSED': return '이미 취소된 거래입니다.';
    case 'MANUAL_RECONCILIATION_REQUIRED': return '거래 기록을 자동으로 취소할 수 없어 수동 조정이 필요합니다.';
    case 'NEGATIVE_BALANCE': return '거래 취소 후 잔액은 0보다 작아질 수 없습니다.';
    case 'OPERATION_CONFLICT': return '동일한 작업 ID가 다른 취소 요청에 사용되었습니다.';
    case 'OPERATION_PENDING': return '동일한 취소 작업이 이미 처리 중입니다.';
    case 'OPERATION_FAILED': return '이 작업 ID의 취소는 이미 실패로 종료되었습니다.';
  }
}
