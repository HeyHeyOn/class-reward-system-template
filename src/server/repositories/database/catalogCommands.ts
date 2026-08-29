import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

export type ProductAdminAction = 'CREATE' | 'UPDATE' | 'DEACTIVATE';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseCatalogCommandDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
}>;

export type CreateProductAdminInput = Readonly<{
  operationId: string;
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl?: string;
  category?: string;
  sortOrder: number;
}>;

export type UpdateProductAdminInput = Readonly<{
  operationId: string;
  productId: string;
  expectedProductVersion: number;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl?: string;
  category?: string;
  sortOrder: number;
}>;

type CanonicalCreateProductAdminInput = Readonly<{
  operationId: string;
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl: string | null;
  category: string | null;
  sortOrder: number;
}>;

type CanonicalUpdateProductAdminInput = CanonicalCreateProductAdminInput & Readonly<{
  expectedProductVersion: number;
}>;

type ProductAdminPayloadProduct = Readonly<{
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl?: string | null;
  category?: string | null;
  sortOrder: number;
  expectedProductVersion?: number;
}>;

export type ProductAdminPayload = Readonly<{
  action: ProductAdminAction;
  products: ReadonlyArray<ProductAdminPayloadProduct>;
}>;

export type ProductAdminProductResult = Readonly<{
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl: string | null;
  category: string | null;
  sortOrder: number;
  productVersionBefore: number | null;
  productVersionAfter: number;
  stockBefore: number | null;
  stockAfter: number;
  inventoryEventId: string | null;
}>;

export type ProductAdminSuccess = Readonly<{
  ok: true;
  operationId: string;
  action: ProductAdminAction;
  completedAt: string;
  products: ReadonlyArray<ProductAdminProductResult>;
}>;

type OperationRow = Readonly<{
  operation_kind: string;
  payload_hash: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  result_snapshot: unknown;
  finished_at: Date | string | null;
  attempt_count: string | number | bigint;
  failure_code: string | null;
  started_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}>;

export function createProductAdminPayloadHash(payload: ProductAdminPayload): string {
  const products = payload.products.map((product) => {
    const canonical = {
      productId: canonicalText(product.productId, 'product ID'),
      name: canonicalText(product.name, 'product name'),
      price: nonnegativeSafeInteger(product.price, 'product price'),
      stock: nonnegativeSafeInteger(product.stock, 'product stock'),
      isActive: booleanValue(product.isActive, 'product active flag'),
      imageUrl: optionalText(product.imageUrl),
      category: optionalText(product.category),
      sortOrder: int32(product.sortOrder, 'product sort order'),
    };
    return payload.action === 'UPDATE'
      ? {
          ...canonical,
          expectedProductVersion: positiveSafeInteger(
            product.expectedProductVersion,
            'product version',
          ),
        }
      : canonical;
  }).sort(compareProductId);
  return createHash('sha256').update(JSON.stringify({
    kind: 'PRODUCT_ADMIN',
    action: payload.action,
    products,
    schemaVersion: 1,
  }), 'utf8').digest('hex');
}

export function createProductAdminResultHash(result: ProductAdminSuccess): string {
  return createHash('sha256').update(JSON.stringify({
    action: result.action,
    completedAt: result.completedAt,
    ok: result.ok,
    operationId: result.operationId,
    products: result.products.map((product) => ({
      category: product.category,
      imageUrl: product.imageUrl,
      inventoryEventId: product.inventoryEventId,
      isActive: product.isActive,
      name: product.name,
      price: product.price,
      productId: product.productId,
      productVersionAfter: product.productVersionAfter,
      productVersionBefore: product.productVersionBefore,
      sortOrder: product.sortOrder,
      stock: product.stock,
      stockAfter: product.stockAfter,
      stockBefore: product.stockBefore,
    })),
  }), 'utf8').digest('hex');
}

export function createProductAdminInventoryEventId(parentOperationId: string, productId: string): string {
  return deterministicUuid('PRODUCT_ADMIN_INVENTORY_EVENT', parentOperationId, productId);
}

export function createProductAdminLedgerOperationId(parentOperationId: string, productId: string): string {
  return deterministicUuid('PRODUCT_ADMIN_LEDGER_OPERATION', parentOperationId, productId);
}

export function createDatabaseCatalogCommands(dependencies: DatabaseCatalogCommandDependencies) {
  return {
    async create(rawInput: CreateProductAdminInput): Promise<ProductAdminSuccess> {
      const input = canonicalizeCreate(rawInput);
      const payloadHash = createProductAdminPayloadHash({ action: 'CREATE', products: [input] });
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) {
        throw new Error('A valid product administration timestamp is required.');
      }

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExistingCreate(tx, dependencies.tenantId, existing, payloadHash, input);
        }
        const operation = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status,
             attempt_count, started_at, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.operationId}, 'PRODUCT_ADMIN', ${payloadHash},
             'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        if (operation.rows.length !== 1) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Product administration operation race integrity check failed.');
          return resolveExistingCreate(tx, dependencies.tenantId, winner, payloadHash, input);
        }
        await tx.execute(sql`
          INSERT INTO products
            (tenant_id, product_id, name, price, stock, is_active, image_url, category,
             sort_order, version, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.productId}, ${input.name}, ${input.price},
             ${input.stock}, ${input.isActive}, ${input.imageUrl}, ${input.category},
             ${input.sortOrder}, 1, ${now}, ${now})
        `);

        const inventoryEventId = input.stock === 0
          ? null
          : createProductAdminInventoryEventId(input.operationId, input.productId);
        if (inventoryEventId) {
          await tx.execute(sql`
            INSERT INTO inventory_ledger
              (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
               stock_before, stock_after, reason, operation_id, operation_hash, occurred_at)
            VALUES
              (${dependencies.tenantId}, ${inventoryEventId}, ${input.productId}, NULL,
               ${input.stock}, 0, ${input.stock}, 'ADMIN_ADJUSTMENT',
               ${createProductAdminLedgerOperationId(input.operationId, input.productId)},
               ${payloadHash}, ${now})
          `);
        }

        const result: ProductAdminSuccess = {
          ok: true,
          operationId: input.operationId,
          action: 'CREATE',
          completedAt: now.toISOString(),
          products: [{
            productId: input.productId,
            name: input.name,
            price: input.price,
            stock: input.stock,
            isActive: input.isActive,
            imageUrl: input.imageUrl,
            category: input.category,
            sortOrder: input.sortOrder,
            productVersionBefore: null,
            productVersionAfter: 1,
            stockBefore: null,
            stockAfter: input.stock,
            inventoryEventId,
          }],
        };
        await appendOperationAudit(
          tx,
          dependencies.tenantId,
          productAdminAuditInput(result, now),
        );
        const terminal = await tx.execute(sql`
          UPDATE operations
          SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
              finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id, status
        `);
        if (terminal.rows.length !== 1
          || (terminal.rows[0] as { operation_id?: unknown; status?: unknown }).operation_id !== input.operationId
          || (terminal.rows[0] as { status?: unknown }).status !== 'SUCCEEDED') {
          throw new Error('Product administration terminal operation integrity check failed.');
        }
        return result;
      });
    },

    async update(rawInput: UpdateProductAdminInput): Promise<ProductAdminSuccess> {
      const input = canonicalizeUpdate(rawInput);
      const payloadHash = createProductAdminPayloadHash({ action: 'UPDATE', products: [input] });
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) {
        throw new Error('A valid product administration timestamp is required.');
      }

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId);
        if (existing) {
          return resolveExistingUpdate(tx, dependencies.tenantId, existing, payloadHash, input);
        }
        const operation = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status,
             attempt_count, started_at, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.operationId}, 'PRODUCT_ADMIN', ${payloadHash},
             'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        if (operation.rows.length !== 1) {
          const winner = await readOperation(tx, dependencies.tenantId, input.operationId);
          if (!winner) throw new Error('Product administration operation race integrity check failed.');
          return resolveExistingUpdate(tx, dependencies.tenantId, winner, payloadHash, input);
        }

        const locked = await tx.execute(sql`
          SELECT product_id, stock, version
          FROM products
          WHERE tenant_id=${dependencies.tenantId}
            AND product_id=${input.productId}
            AND deleted_at IS NULL
          FOR UPDATE
        `);
        if (locked.rows.length !== 1) throw new Error('Product not found.');
        const row = locked.rows[0] as Record<string, unknown>;
        const stockBefore = nonnegativeSafeInteger(dbSafeInteger(row.stock), 'stored product stock');
        const versionBefore = positiveSafeInteger(dbSafeInteger(row.version), 'stored product version');
        if (versionBefore !== input.expectedProductVersion) {
          throw new Error('Product version is stale.');
        }
        const versionAfter = positiveSafeInteger(versionBefore + 1, 'product version successor');

        const updated = await tx.execute(sql`
          UPDATE products
          SET name=${input.name}, price=${input.price}, stock=${input.stock},
              is_active=${input.isActive}, image_url=${input.imageUrl}, category=${input.category},
              sort_order=${input.sortOrder}, version=${versionAfter}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId}
            AND product_id=${input.productId}
            AND deleted_at IS NULL
            AND version=${input.expectedProductVersion}
          RETURNING product_id
        `);
        if (updated.rows.length !== 1) throw new Error('Product version is stale.');

        const stockDelta = input.stock - stockBefore;
        const inventoryEventId = stockDelta === 0
          ? null
          : createProductAdminInventoryEventId(input.operationId, input.productId);
        if (inventoryEventId) {
          await tx.execute(sql`
            INSERT INTO inventory_ledger
              (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
               stock_before, stock_after, reason, operation_id, operation_hash, occurred_at)
            VALUES
              (${dependencies.tenantId}, ${inventoryEventId}, ${input.productId}, NULL,
               ${stockDelta}, ${stockBefore}, ${input.stock}, 'ADMIN_ADJUSTMENT',
               ${createProductAdminLedgerOperationId(input.operationId, input.productId)},
               ${payloadHash}, ${now})
          `);
        }

        const result: ProductAdminSuccess = {
          ok: true,
          operationId: input.operationId,
          action: 'UPDATE',
          completedAt: now.toISOString(),
          products: [{
            productId: input.productId,
            name: input.name,
            price: input.price,
            stock: input.stock,
            isActive: input.isActive,
            imageUrl: input.imageUrl,
            category: input.category,
            sortOrder: input.sortOrder,
            productVersionBefore: versionBefore,
            productVersionAfter: versionAfter,
            stockBefore,
            stockAfter: input.stock,
            inventoryEventId,
          }],
        };
        await appendOperationAudit(tx, dependencies.tenantId, productAdminAuditInput(result, now));
        const terminal = await tx.execute(sql`
          UPDATE operations
          SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
              finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
          RETURNING operation_id, status
        `);
        if (terminal.rows.length !== 1
          || (terminal.rows[0] as { operation_id?: unknown; status?: unknown }).operation_id !== input.operationId
          || (terminal.rows[0] as { status?: unknown }).status !== 'SUCCEEDED') {
          throw new Error('Product administration terminal operation integrity check failed.');
        }
        return result;
      });
    },
  };
}

async function readOperation(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
): Promise<OperationRow | undefined> {
  const result = await tx.execute(sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at,
           attempt_count, failure_code, started_at, created_at, updated_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  `);
  return result.rows[0] as OperationRow | undefined;
}

async function resolveExistingCreate(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: CanonicalCreateProductAdminInput,
): Promise<ProductAdminSuccess> {
  if (operation.operation_kind !== 'PRODUCT_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Product administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Product administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const result = parseStoredCreateResult(operation.result_snapshot, input, finishedAt);
  assertOperationEvidence(operation, result);
  await assertCreateState(tx, tenantId, result, payloadHash);
  await assertOperationAudit(tx, tenantId, productAdminAuditInput(result, finishedAt));
  await assertSingleOperationAudit(tx, tenantId, result.operationId);
  return result;
}

async function resolveExistingUpdate(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  payloadHash: string,
  input: CanonicalUpdateProductAdminInput,
): Promise<ProductAdminSuccess> {
  if (operation.operation_kind !== 'PRODUCT_ADMIN' || operation.payload_hash !== payloadHash) {
    throw new Error('Product administration operation conflict.');
  }
  if (operation.status !== 'SUCCEEDED' || !operation.result_snapshot) {
    throw new Error('Product administration operation is not replayable.');
  }
  const finishedAt = operationTimestamp(operation.finished_at);
  const result = parseStoredUpdateResult(operation.result_snapshot, input, finishedAt);
  assertOperationEvidence(operation, result);
  await assertUpdateLedger(tx, tenantId, result, payloadHash);
  await assertOperationAudit(tx, tenantId, productAdminAuditInput(result, finishedAt));
  await assertSingleOperationAudit(tx, tenantId, result.operationId);
  return result;
}

function parseStoredUpdateResult(
  value: unknown,
  input: CanonicalUpdateProductAdminInput,
  finishedAt: Date,
): ProductAdminSuccess {
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'products'])
    || value.ok !== true || value.action !== 'UPDATE' || value.operationId !== input.operationId
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.products)
    || value.products.length !== 1) {
    throw new Error('Product administration stored result integrity check failed.');
  }
  const product = value.products[0];
  const keys = [
    'category', 'imageUrl', 'inventoryEventId', 'isActive', 'name', 'price', 'productId',
    'productVersionAfter', 'productVersionBefore', 'sortOrder', 'stock', 'stockAfter', 'stockBefore',
  ];
  if (!isExactRecord(product, keys)) {
    throw new Error('Product administration stored result integrity check failed.');
  }
  const stockBefore = nonnegativeSafeInteger(product.stockBefore, 'stored product stock');
  const versionBefore = positiveSafeInteger(product.productVersionBefore, 'stored product version');
  const versionAfter = positiveSafeInteger(product.productVersionAfter, 'stored product version');
  const expectedEventId = stockBefore === input.stock
    ? null
    : createProductAdminInventoryEventId(input.operationId, input.productId);
  if (product.productId !== input.productId || product.name !== input.name
    || product.price !== input.price || product.stock !== input.stock
    || product.isActive !== input.isActive || product.imageUrl !== input.imageUrl
    || product.category !== input.category || product.sortOrder !== input.sortOrder
    || versionBefore !== input.expectedProductVersion || versionAfter !== versionBefore + 1
    || product.stockAfter !== input.stock || product.inventoryEventId !== expectedEventId) {
    throw new Error('Product administration stored result integrity check failed.');
  }
  return value as ProductAdminSuccess;
}

async function assertUpdateLedger(
  tx: TenantTransaction,
  tenantId: string,
  result: ProductAdminSuccess,
  payloadHash: string,
): Promise<void> {
  const product = result.products[0];
  const candidateEventId = createProductAdminInventoryEventId(result.operationId, product.productId);
  const ledgerOperationId = createProductAdminLedgerOperationId(result.operationId, product.productId);
  const ledger = await tx.execute(sql`
    SELECT inventory_event_id::text, product_id, transaction_id, quantity_delta,
           stock_before, stock_after, reason, operation_id, operation_hash, occurred_at
    FROM inventory_ledger
    WHERE tenant_id=${tenantId}
      AND (inventory_event_id=${candidateEventId}::uuid
        OR operation_id=${ledgerOperationId}
        OR operation_hash=${payloadHash})
    ORDER BY inventory_event_id
  `);
  if (product.inventoryEventId === null) {
    if (ledger.rows.length !== 0) throw new Error('Product administration ledger integrity check failed.');
    return;
  }
  if (ledger.rows.length !== 1) throw new Error('Product administration ledger integrity check failed.');
  const evidence = ledger.rows[0] as Record<string, unknown>;
  const stockBefore = nonnegativeSafeInteger(product.stockBefore, 'stored product stock');
  const stockDelta = product.stockAfter - stockBefore;
  if (evidence.inventory_event_id !== candidateEventId
    || evidence.product_id !== product.productId || evidence.transaction_id !== null
    || dbSafeInteger(evidence.quantity_delta) !== stockDelta
    || dbSafeInteger(evidence.stock_before) !== stockBefore
    || dbSafeInteger(evidence.stock_after) !== product.stockAfter
    || evidence.reason !== 'ADMIN_ADJUSTMENT' || evidence.operation_id !== ledgerOperationId
    || evidence.operation_hash !== payloadHash
    || operationTimestamp(evidence.occurred_at as Date | string).toISOString() !== result.completedAt) {
    throw new Error('Product administration ledger integrity check failed.');
  }
}

function parseStoredCreateResult(
  value: unknown,
  input: CanonicalCreateProductAdminInput,
  finishedAt: Date,
): ProductAdminSuccess {
  if (!isExactRecord(value, ['action', 'completedAt', 'ok', 'operationId', 'products'])
    || value.ok !== true || value.action !== 'CREATE' || value.operationId !== input.operationId
    || value.completedAt !== finishedAt.toISOString() || !Array.isArray(value.products)
    || value.products.length !== 1) {
    throw new Error('Product administration stored result integrity check failed.');
  }
  const product = value.products[0];
  const keys = [
    'category', 'imageUrl', 'inventoryEventId', 'isActive', 'name', 'price', 'productId',
    'productVersionAfter', 'productVersionBefore', 'sortOrder', 'stock', 'stockAfter', 'stockBefore',
  ];
  if (!isExactRecord(product, keys)
    || product.productId !== input.productId || product.name !== input.name
    || product.price !== input.price || product.stock !== input.stock
    || product.isActive !== input.isActive || product.imageUrl !== input.imageUrl
    || product.category !== input.category || product.sortOrder !== input.sortOrder
    || product.productVersionBefore !== null || product.productVersionAfter !== 1
    || product.stockBefore !== null || product.stockAfter !== input.stock
    || product.inventoryEventId !== (input.stock === 0
      ? null
      : createProductAdminInventoryEventId(input.operationId, input.productId))) {
    throw new Error('Product administration stored result integrity check failed.');
  }
  return value as ProductAdminSuccess;
}

async function assertCreateState(
  tx: TenantTransaction,
  tenantId: string,
  result: ProductAdminSuccess,
  payloadHash: string,
): Promise<void> {
  const product = result.products[0];
  const state = await tx.execute(sql`
    SELECT product_id, created_at
    FROM products
    WHERE tenant_id=${tenantId} AND product_id=${product.productId}
    FOR UPDATE
  `);
  const productRow = state.rows[0] as { product_id?: unknown; created_at?: Date | string } | undefined;
  if (state.rows.length !== 1 || productRow?.product_id !== product.productId
    || operationTimestamp(productRow.created_at ?? null).toISOString() !== result.completedAt) {
    throw new Error('Product administration product integrity check failed.');
  }

  const expectedEventId = product.inventoryEventId;
  const candidateEventId = createProductAdminInventoryEventId(result.operationId, product.productId);
  const expectedLedgerOperationId = createProductAdminLedgerOperationId(
    result.operationId,
    product.productId,
  );
  const ledger = await tx.execute(sql`
    SELECT inventory_event_id::text, product_id, transaction_id, quantity_delta,
           stock_before, stock_after, reason, operation_id, operation_hash, occurred_at
    FROM inventory_ledger
    WHERE tenant_id=${tenantId}
      AND (inventory_event_id=${candidateEventId}::uuid
        OR operation_id=${expectedLedgerOperationId}
        OR operation_hash=${payloadHash})
    ORDER BY inventory_event_id
  `);
  if (expectedEventId === null) {
    if (ledger.rows.length !== 0) throw new Error('Product administration ledger integrity check failed.');
    return;
  }
  if (ledger.rows.length !== 1) throw new Error('Product administration ledger integrity check failed.');
  const evidence = ledger.rows[0] as Record<string, unknown>;
  if (evidence.inventory_event_id !== expectedEventId
    || evidence.product_id !== product.productId || evidence.transaction_id !== null
    || dbSafeInteger(evidence.quantity_delta) !== product.stockAfter
    || dbSafeInteger(evidence.stock_before) !== 0
    || dbSafeInteger(evidence.stock_after) !== product.stockAfter
    || evidence.reason !== 'ADMIN_ADJUSTMENT'
    || evidence.operation_id !== createProductAdminLedgerOperationId(result.operationId, product.productId)
    || evidence.operation_hash !== payloadHash
    || operationTimestamp(evidence.occurred_at as Date | string).toISOString() !== result.completedAt) {
    throw new Error('Product administration ledger integrity check failed.');
  }
}

async function assertSingleOperationAudit(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
): Promise<void> {
  const auditCount = await tx.execute(sql`
    SELECT count(*)::text AS count
    FROM audit_events
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
  `);
  if (auditCount.rows.length !== 1
    || (auditCount.rows[0] as { count?: unknown }).count !== '1') {
    throw new Error('Product administration audit integrity check failed.');
  }
}

function assertOperationEvidence(operation: OperationRow, result: ProductAdminSuccess): void {
  if (dbSafeInteger(operation.attempt_count) !== 1 || operation.failure_code !== null
    || operationTimestamp(operation.started_at).toISOString() !== result.completedAt
    || operationTimestamp(operation.created_at).toISOString() !== result.completedAt
    || operationTimestamp(operation.updated_at).toISOString() !== result.completedAt
    || operationTimestamp(operation.finished_at).toISOString() !== result.completedAt) {
    throw new Error('Product administration operation integrity check failed.');
  }
}

function productAdminAuditInput(result: ProductAdminSuccess, occurredAt: Date) {
  return {
    operationId: result.operationId,
    eventType: 'PRODUCT_ADMIN_COMPLETED',
    entityType: 'OPERATION',
    entityId: result.operationId,
    redactedDetails: {
      action: result.action,
      changedProductCount: result.products.length,
      ledgerCount: result.products.filter((product) => product.inventoryEventId !== null).length,
      productCount: result.products.length,
      resultHash: createProductAdminResultHash(result),
    },
    occurredAt,
  } as const;
}

function operationTimestamp(value: Date | string | null): Date {
  const timestamp = value instanceof Date ? value : new Date(value ?? 'invalid');
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Product administration operation integrity check failed.');
  }
  return timestamp;
}

function dbSafeInteger(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value) ? Number(value)
      : value;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Product administration stored integer integrity check failed.');
  }
  return parsed as number;
}

function isExactRecord(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function canonicalizeCreate(input: CreateProductAdminInput): CanonicalCreateProductAdminInput {
  return {
    operationId: canonicalText(input.operationId, 'operation ID'),
    productId: canonicalText(input.productId, 'product ID'),
    name: canonicalText(input.name, 'product name'),
    price: nonnegativeSafeInteger(input.price, 'product price'),
    stock: nonnegativeSafeInteger(input.stock, 'product stock'),
    isActive: booleanValue(input.isActive, 'product active flag'),
    imageUrl: optionalText(input.imageUrl),
    category: optionalText(input.category),
    sortOrder: int32(input.sortOrder, 'product sort order'),
  };
}

function canonicalizeUpdate(input: UpdateProductAdminInput): CanonicalUpdateProductAdminInput {
  return {
    ...canonicalizeCreate(input),
    expectedProductVersion: positiveSafeInteger(
      input.expectedProductVersion,
      'product version',
    ),
  };
}

function canonicalText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`A ${label} is required.`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Optional product text must be a string.');
  return value.trim() || null;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`The ${label} must be a nonnegative safe integer.`);
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
  return value as number;
}

function int32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < -2147483648 || (value as number) > 2147483647) {
    throw new Error(`The ${label} must be a 32-bit integer.`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`The ${label} must be a boolean.`);
  return value;
}

function compareProductId(left: { productId: string }, right: { productId: string }): number {
  return left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0;
}

function deterministicUuid(kind: string, parentOperationId: string, productId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify({
    kind,
    parentOperationId: canonicalText(parentOperationId, 'parent operation ID'),
    productId: canonicalText(productId, 'product ID'),
  }), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
