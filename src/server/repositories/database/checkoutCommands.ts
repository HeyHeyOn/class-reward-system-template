import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Promotion, Product, Student } from '@/domain/types';
import {
  checkoutPricingMatches,
  createCartPricingPreview,
  createCheckoutPreview,
} from '@/domain/checkout';
import {
  createCheckoutPayloadHash,
  type CheckoutCommand,
  type CheckoutCommandInput,
  type CheckoutCommandResult,
  type ProcessCheckoutResult,
} from '@/server/checkoutService';
import type { TenantTransaction } from '@/server/db/transaction';
import { parseCheckoutSuccessResponse } from '@/lib/checkoutSnapshotClient';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

const SHA256 = /^[0-9a-f]{64}$/;

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseCheckoutCommandDependencies = {
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
  /** Test/fault-injection seam after mutable rows change but before ledgers are written. */
  afterResourceUpdates?: () => Promise<void>;
};

type OperationRow = {
  operation_kind: string;
  payload_hash: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  result_snapshot: unknown;
  failure_code: string | null;
  finished_at: Date | string | null;
};

type StudentAccountRow = {
  student_id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  balance: string;
};

type ProductRow = {
  product_id: string;
  name: string;
  price: string;
  stock: string;
  is_active: boolean;
  image_url: string | null;
  category: string | null;
  sort_order: number;
};

type PromotionRow = {
  promotion_id: string;
  name: string;
  description: string;
  type: Promotion['type'];
  n_plus_one_buy_quantity: string | null;
  n_plus_one_free_quantity: string | null;
  promotional_price: string | null;
  percent_discount: string | null;
  fixed_discount: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  is_active: boolean;
  sort_order: number;
  schema_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  product_id: string;
};

class CheckoutBusinessFailure extends Error {
  constructor(readonly result: ProcessCheckoutResult) {
    super(result.ok ? 'Unexpected checkout success' : result.message);
  }
}

export function createDatabaseCheckoutCommand(
  dependencies: DatabaseCheckoutCommandDependencies,
): CheckoutCommand {
  return {
    async execute(input) {
      const canonicalInput = canonicalizeCheckoutInput(input);
      validateOperationBinding(canonicalInput);
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid checkout timestamp is required.');

      try {
        return await dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
          const inserted = await tx.execute(sql`
            INSERT INTO operations
              (tenant_id, operation_id, operation_kind, payload_hash, status,
               attempt_count, started_at, created_at, updated_at)
            VALUES
              (${dependencies.tenantId}, ${canonicalInput.operationId}, 'CHECKOUT', ${canonicalInput.payloadHash},
               'PENDING', 1, ${now}, ${now}, ${now})
            ON CONFLICT (tenant_id, operation_id) DO NOTHING
            RETURNING operation_id
          `);
          const ownsClaim = inserted.rows.length === 1;
          const operationResult = await tx.execute(sql`
            SELECT operation_kind, payload_hash, status, result_snapshot, failure_code, finished_at
            FROM operations
            WHERE tenant_id=${dependencies.tenantId} AND operation_id=${canonicalInput.operationId}
            FOR UPDATE
          `);
          const operation = operationResult.rows[0] as OperationRow | undefined;
          if (!operation) throw new Error('Checkout operation claim could not be read.');
          if (operation.operation_kind !== 'CHECKOUT' || operation.payload_hash !== canonicalInput.payloadHash) {
            return operationConflict();
          }
          if (!ownsClaim) {
            if (operation.status === 'SUCCEEDED') {
              const result = parseStoredCheckoutResult(operation.result_snapshot, canonicalInput);
              await assertOperationAudit(
                tx,
                dependencies.tenantId,
                checkoutAuditInput(canonicalInput.operationId, result, requiredDate(operation.finished_at)),
              );
              return result;
            }
            if (operation.status === 'FAILED') {
              return {
                ok: false,
                code: 'OPERATION_FAILED',
                message: '이 작업 ID의 결제는 이미 실패로 종료되었습니다.',
                ...(operation.failure_code ? { failureCode: operation.failure_code } : {}),
              };
            }
            return {
              ok: false,
              code: 'OPERATION_PENDING',
              message: '동일한 결제 작업이 이미 처리 중입니다.',
            };
          }

          return executeClaimedCheckout(tx, dependencies, canonicalInput, now);
        });
      } catch (error) {
        if (error instanceof CheckoutBusinessFailure) return error.result;
        throw error;
      }
    },
  };
}

async function executeClaimedCheckout(
  tx: TenantTransaction,
  dependencies: DatabaseCheckoutCommandDependencies,
  input: CheckoutCommandInput,
  now: Date,
): Promise<CheckoutCommandResult> {
  const normalizedItems = normalizeItems(input.items);
  const productIds = normalizedItems.map((item) => item.productId).sort((left, right) => left.localeCompare(right));

  const accountResult = await tx.execute(sql`
    SELECT s.student_id, s.name, s.status, a.balance::text AS balance
    FROM students s
    JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${dependencies.tenantId} AND s.student_id=${input.studentId}
    FOR UPDATE OF s, a
  `);
  const account = accountResult.rows[0] as StudentAccountRow | undefined;
  if (!account) fail({ ok: false, code: 'STUDENT_NOT_FOUND', message: '학생을 찾을 수 없습니다.' });
  if (account.status !== 'ACTIVE') {
    fail({ ok: false, code: 'STUDENT_INACTIVE', message: '현재 이용할 수 없는 학생입니다.' });
  }

  const productResult = await tx.execute(sql`
    SELECT product_id, name, price::text AS price, stock::text AS stock, is_active,
           image_url, category, sort_order
    FROM products
    WHERE tenant_id=${dependencies.tenantId}
      AND deleted_at IS NULL
      AND product_id IN (${sql.join(productIds.map((productId) => sql`${productId}`), sql`, `)})
    ORDER BY product_id
    FOR UPDATE
  `);
  const productRows = productResult.rows as ProductRow[];
  const domainProducts = productRows.map(toProduct);
  const promotions = await loadPromotions(tx, dependencies.tenantId, productIds, now);
  const student: Student = {
    studentId: account.student_id,
    name: account.name,
    status: account.status,
    balance: safeInteger(account.balance, 'account balance'),
  };

  const authoritativePricing = createCartPricingPreview({
    products: domainProducts,
    cartItems: normalizedItems,
    promotions,
    now,
  });
  if (!authoritativePricing.ok) fail(authoritativePricing);
  if (!checkoutPricingMatches(input.expectedPricing, authoritativePricing)) {
    fail({
      ok: false,
      code: 'PRICE_CHANGED',
      message: '상품 가격 또는 행사가 변경되었습니다. 최신 금액을 확인해 주세요.',
      latestPricing: authoritativePricing,
    });
  }

  const preview = createCheckoutPreview({
    student,
    products: domainProducts,
    cartItems: normalizedItems,
    promotions,
    now,
  });
  if (!preview.ok) fail(preview);

  await tx.execute(sql`
    UPDATE accounts
    SET balance=${preview.balanceAfter}, version=version+1, updated_at=${now}
    WHERE tenant_id=${dependencies.tenantId} AND student_id=${student.studentId}
  `);
  const productById = new Map(domainProducts.map((product) => [product.productId, product]));
  const sortedPreviewItems = [...preview.items].sort((left, right) => left.productId.localeCompare(right.productId));
  for (const item of sortedPreviewItems) {
    await tx.execute(sql`
      UPDATE products
      SET stock=stock-${item.totalQuantity}, updated_at=${now}
      WHERE tenant_id=${dependencies.tenantId} AND product_id=${item.productId}
    `);
  }
  await dependencies.afterResourceUpdates?.();

  const transactionId = checkoutTransactionId(input.operationId);
  await tx.execute(sql`
    INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
       legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
       legacy_status_snapshot, operation_id, operation_hash, schema_version)
    VALUES
      (${dependencies.tenantId}, ${transactionId}, ${now}, ${student.studentId}, ${student.name},
       'CHECKOUT', ${preview.totalAmount}, ${-preview.totalAmount}, ${preview.balanceBefore},
       ${preview.balanceAfter}, ${input.operator ?? 'kiosk'}, 'COMPLETED', ${input.operationId},
       ${input.payloadHash}, 1)
  `);

  for (const [index, item] of preview.items.entries()) {
    await tx.execute(sql`
      INSERT INTO transaction_items
        (tenant_id, transaction_id, line_number, product_id_snapshot, current_product_id,
         product_name_snapshot, quantity, unit_price_snapshot, subtotal_snapshot,
         regular_unit_price, regular_total, total_quantity, paid_quantity, free_quantity,
         final_total, total_discount, adjustments_snapshot, applied_promotions_snapshot)
      VALUES
        (${dependencies.tenantId}, ${transactionId}, ${index + 1}, ${item.productId}, ${item.productId},
         ${item.name}, ${item.quantity}, ${item.price}, ${item.subtotal}, ${item.regularUnitPrice},
         ${item.regularTotal}, ${item.totalQuantity}, ${item.paidQuantity}, ${item.freeQuantity},
         ${item.finalTotal}, ${item.totalDiscount}, ${JSON.stringify(item.adjustments)}::jsonb,
         ${JSON.stringify(item.appliedPromotions)}::jsonb)
    `);
  }

  for (const item of sortedPreviewItems) {
    const product = productById.get(item.productId);
    if (!product) throw new Error('Locked checkout product disappeared.');
    await tx.execute(sql`
      INSERT INTO inventory_ledger
        (tenant_id, product_id, transaction_id, quantity_delta, stock_before, stock_after,
         reason, operation_id, operation_hash, occurred_at)
      VALUES
        (${dependencies.tenantId}, ${item.productId}, ${transactionId}, ${-item.totalQuantity},
         ${product.stock}, ${product.stock - item.totalQuantity}, 'CHECKOUT', NULL, NULL, ${now})
    `);
  }

  const result = {
    ok: true as const,
    transactionId,
    studentId: student.studentId,
    studentName: student.name,
    totalAmount: preview.totalAmount,
    balanceBefore: preview.balanceBefore,
    balanceAfter: preview.balanceAfter,
    items: preview.items,
  };
  await appendOperationAudit(
    tx,
    dependencies.tenantId,
    checkoutAuditInput(input.operationId, result, now),
  );
  await tx.execute(sql`
    UPDATE operations
    SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
        finished_at=${now}, updated_at=${now}
    WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
  `);
  return result;
}

function checkoutAuditInput(
  operationId: string,
  result: Extract<CheckoutCommandResult, { ok: true }>,
  occurredAt: Date,
) {
  return {
    operationId,
    eventType: 'CHECKOUT_COMPLETED',
    entityType: 'TRANSACTION',
    entityId: result.transactionId,
    redactedDetails: {
      itemCount: result.items.length,
      studentId: result.studentId,
      totalAmount: result.totalAmount,
    },
    occurredAt,
  } as const;
}

function requiredDate(value: Date | string | null): Date {
  if (value === null) throw new Error('Checkout audit integrity check failed.');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Checkout audit integrity check failed.');
  return date;
}

async function loadPromotions(
  tx: TenantTransaction,
  tenantId: string,
  productIds: string[],
  now: Date,
): Promise<Promotion[]> {
  const result = await tx.execute(sql`
    SELECT p.promotion_id, p.name, p.description, p.type,
           p.n_plus_one_buy_quantity::text AS n_plus_one_buy_quantity,
           p.n_plus_one_free_quantity::text AS n_plus_one_free_quantity,
           p.promotional_price::text AS promotional_price,
           p.percent_discount::text AS percent_discount,
           p.fixed_discount::text AS fixed_discount,
           p.starts_at, p.ends_at, p.is_active, p.sort_order, p.schema_version,
           p.created_at, p.updated_at, linked.product_id
    FROM promotions p
    JOIN promotion_products linked
      ON linked.tenant_id=p.tenant_id AND linked.promotion_id=p.promotion_id
    WHERE p.tenant_id=${tenantId}
      AND p.is_active
      AND p.deleted_at IS NULL
      AND p.starts_at<=${now}
      AND p.ends_at>${now}
      AND EXISTS (
        SELECT 1 FROM promotion_products selected
        WHERE selected.tenant_id=p.tenant_id
          AND selected.promotion_id=p.promotion_id
          AND selected.product_id IN (${sql.join(productIds.map((productId) => sql`${productId}`), sql`, `)})
      )
    ORDER BY p.sort_order, p.promotion_id, linked.product_id
  `);
  const grouped = new Map<string, PromotionRow[]>();
  for (const row of result.rows as PromotionRow[]) {
    const rows = grouped.get(row.promotion_id) ?? [];
    rows.push(row);
    grouped.set(row.promotion_id, rows);
  }
  return [...grouped.values()].map(toPromotion);
}

function toProduct(row: ProductRow): Product {
  return {
    productId: row.product_id,
    name: row.name,
    price: safeInteger(row.price, `price for ${row.product_id}`),
    stock: safeInteger(row.stock, `stock for ${row.product_id}`),
    isActive: row.is_active,
    ...(row.image_url === null ? {} : { imageUrl: row.image_url }),
    ...(row.category === null ? {} : { category: row.category }),
    sortOrder: row.sort_order,
  };
}

function toPromotion(rows: PromotionRow[]): Promotion {
  const row = rows[0];
  const base = {
    promotionId: row.promotion_id,
    name: row.name,
    description: row.description,
    productIds: rows.map((entry) => entry.product_id),
    startsAt: isoString(row.starts_at),
    endsAt: isoString(row.ends_at),
    isActive: row.is_active,
    sortOrder: row.sort_order,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    schemaVersion: row.schema_version,
  };
  switch (row.type) {
    case 'N_PLUS_ONE':
      return {
        ...base,
        type: row.type,
        buyQuantity: safeInteger(row.n_plus_one_buy_quantity, `buy quantity for ${row.promotion_id}`),
        freeQuantity: safeInteger(row.n_plus_one_free_quantity, `free quantity for ${row.promotion_id}`),
      };
    case 'PROMOTIONAL_PRICE':
      return {
        ...base,
        type: row.type,
        promotionalUnitPrice: safeInteger(row.promotional_price, `promotional price for ${row.promotion_id}`),
      };
    case 'PERCENT_DISCOUNT': {
      const percent = Number(row.percent_discount);
      if (!Number.isFinite(percent)) throw new Error(`Unsafe percent for promotion ${row.promotion_id}.`);
      return { ...base, type: row.type, percent };
    }
    case 'FIXED_DISCOUNT':
      return {
        ...base,
        type: row.type,
        discountAmount: safeInteger(row.fixed_discount, `fixed discount for ${row.promotion_id}`),
      };
  }
}

function normalizeItems(items: CheckoutCommandInput['items']): CheckoutCommandInput['items'] {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const productId = item.productId.trim();
    const quantity = (quantities.get(productId) ?? 0) + item.quantity;
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error('Checkout items are invalid.');
    }
    quantities.set(productId, quantity);
  }
  if (quantities.size === 0) throw new Error('Checkout items are required.');
  return [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
}

function canonicalizeCheckoutInput(input: CheckoutCommandInput): CheckoutCommandInput {
  if (typeof input.studentId !== 'string' || !input.studentId.trim()) {
    throw new Error('A nonblank student ID is required.');
  }
  if (input.operator !== undefined && typeof input.operator !== 'string') {
    throw new Error('Checkout operator is invalid.');
  }
  return {
    ...input,
    studentId: input.studentId.trim(),
    operator: input.operator?.trim() || 'kiosk',
  };
}

function validateOperationBinding(input: CheckoutCommandInput): void {
  if (typeof input.operationId !== 'string' || input.operationId.trim() !== input.operationId || !input.operationId) {
    throw new Error('A nonblank, trimmed operation ID is required.');
  }
  if (typeof input.payloadHash !== 'string' || !SHA256.test(input.payloadHash)) {
    throw new Error('A lowercase SHA-256 payload hash is required.');
  }
  const authoritativeHash = createCheckoutPayloadHash(input);
  if (input.payloadHash !== authoritativeHash) {
    throw new Error('The checkout payload hash does not match the canonical request.');
  }
}

function safeInteger(value: string | number | bigint | null, label: string): number {
  if (value === null) throw new Error(`Missing ${label}.`);
  const parsed = typeof value === 'bigint' ? value : BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Unsafe integer for ${label}.`);
  }
  return Number(parsed);
}

function isoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid database timestamp.');
  return date.toISOString();
}

function fail(result: ProcessCheckoutResult): never {
  throw new CheckoutBusinessFailure(result);
}

function operationConflict(): CheckoutCommandResult {
  return {
    ok: false,
    code: 'OPERATION_CONFLICT',
    message: '동일한 작업 ID가 다른 결제 요청에 사용되었습니다.',
  };
}

function checkoutTransactionId(operationId: string): string {
  return `checkout:${createHash('sha256').update(operationId, 'utf8').digest('hex')}`;
}

function parseStoredCheckoutResult(
  value: unknown,
  input: CheckoutCommandInput,
): Extract<CheckoutCommandResult, { ok: true }> {
  const result = parseCheckoutSuccessResponse(value);
  if (!result
      || result.studentId !== input.studentId
      || result.transactionId !== checkoutTransactionId(input.operationId)
      || !checkoutPricingMatches(input.expectedPricing, result)) {
    throw new Error('Stored checkout result is invalid.');
  }
  return result;
}
