import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {
  BulkImportCommitRequest,
  BulkImportKind,
  ProductImportCommitResult,
  ProductImportCreated,
  ProductImportRow,
  StudentImportCommitResult,
  StudentImportCreated,
  StudentImportRow,
} from '@/lib/bulkImport';
import type { TenantTransaction } from '@/server/db/transaction';
import { sortIssues } from '@/server/bulkImport/common';
import { BulkImportCommitError } from '@/server/bulkImport/errors';
import {
  allocateProductIds,
  productNameKey,
  validateProductRows,
  type ExistingProducts,
} from '@/server/bulkImport/productImport';
import { validateStudentRows, type ExistingStudent } from '@/server/bulkImport/studentImport';
import { createDatabaseCatalogCommands } from './catalogCommands';
import { createDatabaseStudentCommands } from './studentCommands';

// Bulk imports reuse the existing single-row create commands unchanged. Every row runs as
// its own STUDENT_ADMIN / PRODUCT_ADMIN operation (same ledger, audit and replay rules),
// but all rows are bound to ONE outer tenant transaction, so an import is all-or-nothing.
// Child operation IDs are derived from the client's import operationId and the row index:
// retrying the same confirm after an uncertain outcome replays the recorded rows instead
// of creating them twice.

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseBulkImportDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  now?: () => Date;
  /** Test seams for fault injection; production uses the real create commands. */
  createStudentCommands?: typeof createDatabaseStudentCommands;
  createCatalogCommands?: typeof createDatabaseCatalogCommands;
}>;

type RecordedOperation = Readonly<{ operationKind: string; resultSnapshot: unknown }>;

const STALE_MESSAGE = '파일을 확인한 뒤에 명단이 바뀌었어요. 아래 내용을 확인하고 파일을 다시 올려 주세요.';
const CONFLICT_MESSAGE = '이 추가 요청은 이미 다른 내용으로 처리됐어요. 목록을 새로고침한 뒤 파일을 다시 올려 주세요.';

export function bulkImportChildOperationId(
  kind: BulkImportKind,
  parentOperationId: string,
  index: number,
): string {
  if (typeof parentOperationId !== 'string' || !parentOperationId.trim()
    || !Number.isSafeInteger(index) || index < 0) {
    throw new Error('A valid bulk import operation is required.');
  }
  const bytes = createHash('sha256').update(JSON.stringify({
    kind: kind === 'students' ? 'BULK_IMPORT_STUDENT' : 'BULK_IMPORT_PRODUCT',
    parentOperationId,
    index,
  }), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function readExistingStudents(
  tx: TenantTransaction,
  tenantId: string,
): Promise<Map<string, ExistingStudent>> {
  const result = await tx.execute(sql`
    SELECT student_id, name, deleted_at IS NOT NULL AS deleted
    FROM students
    WHERE tenant_id=${tenantId}
  `);
  const existing = new Map<string, ExistingStudent>();
  for (const row of result.rows as Array<{ student_id: string; name: string; deleted: boolean }>) {
    existing.set(row.student_id, { studentId: row.student_id, name: row.name, deleted: row.deleted === true });
  }
  return existing;
}

export async function readExistingProducts(tx: TenantTransaction, tenantId: string): Promise<ExistingProducts> {
  const result = await tx.execute(sql`
    SELECT product_id, name, sort_order, deleted_at IS NOT NULL AS deleted
    FROM products
    WHERE tenant_id=${tenantId}
    ORDER BY product_id
  `);
  const activeNames = new Map<string, string>();
  const usedProductIds: string[] = [];
  let maxSortOrder = 0;
  for (const row of result.rows as Array<{ product_id: string; name: string; sort_order: number | string; deleted: boolean }>) {
    usedProductIds.push(row.product_id);
    if (row.deleted === true) continue;
    const key = productNameKey(row.name);
    if (!activeNames.has(key)) activeNames.set(key, row.product_id);
    const sortOrder = Number(row.sort_order);
    if (Number.isSafeInteger(sortOrder)) maxSortOrder = Math.max(maxSortOrder, sortOrder);
  }
  return { activeNames, maxSortOrder, usedProductIds };
}

async function readRecordedOperations(
  tx: TenantTransaction,
  tenantId: string,
  operationIds: ReadonlyArray<string>,
): Promise<Map<string, RecordedOperation>> {
  const result = await tx.execute(sql`
    SELECT operation_id, operation_kind, result_snapshot
    FROM operations
    WHERE tenant_id=${tenantId}
      AND operation_id IN (${sql.join(operationIds.map((id) => sql`${id}`), sql`, `)})
  `);
  const recorded = new Map<string, RecordedOperation>();
  for (const row of result.rows as Array<{ operation_id: string; operation_kind: string; result_snapshot: unknown }>) {
    recorded.set(row.operation_id, { operationKind: row.operation_kind, resultSnapshot: row.result_snapshot });
  }
  return recorded;
}

function boundTo(tx: TenantTransaction, tenantId: string): RunTenantTransaction {
  return async (requestedTenantId, callback) => {
    if (requestedTenantId !== tenantId) throw new Error('Bulk import transaction scope mismatch.');
    return callback(tx);
  };
}

function translateCommandError(error: unknown): unknown {
  if (error instanceof Error && (error.message === 'Student administration operation conflict.'
    || error.message === 'Product administration operation conflict.')) {
    return new BulkImportCommitError('OPERATION_CONFLICT', CONFLICT_MESSAGE);
  }
  return error;
}

export function createDatabaseStudentImport(dependencies: DatabaseBulkImportDependencies) {
  const { tenantId } = dependencies;
  return {
    loadExisting(): Promise<Map<string, ExistingStudent>> {
      return dependencies.runTenantTransaction(tenantId, (tx) => readExistingStudents(tx, tenantId));
    },

    async commit(request: BulkImportCommitRequest<StudentImportRow>): Promise<StudentImportCommitResult> {
      const rows = [...request.rows];
      if (rows.length === 0) throw new Error('A nonempty bulk import is required.');
      const childIds = rows.map((_, index) => bulkImportChildOperationId('students', request.operationId, index));
      return dependencies.runTenantTransaction(tenantId, async (tx) => {
        const recorded = await readRecordedOperations(tx, tenantId, childIds);
        const replayed = recorded.size > 0;
        if (replayed && recorded.size !== childIds.length) {
          throw new BulkImportCommitError('OPERATION_CONFLICT', CONFLICT_MESSAGE);
        }
        if (!replayed) {
          const { errors } = validateStudentRows(rows, await readExistingStudents(tx, tenantId));
          if (errors.length) throw new BulkImportCommitError('VALIDATION_FAILED', STALE_MESSAGE, sortIssues(errors));
        }

        const commands = (dependencies.createStudentCommands ?? createDatabaseStudentCommands)({
          tenantId,
          runTenantTransaction: boundTo(tx, tenantId),
          now: dependencies.now,
        });
        const items: StudentImportCreated[] = [];
        for (const [index, row] of rows.entries()) {
          let created;
          try {
            created = await commands.create({
              operationId: childIds[index],
              studentId: row.studentId,
              name: row.name,
              balance: row.balance,
              status: 'ACTIVE',
            });
          } catch (error) {
            throw translateCommandError(error);
          }
          const student = created.students.length === 1 ? created.students[0] : undefined;
          if (!student || created.operationId !== childIds[index] || student.studentId !== row.studentId
            || student.name !== row.name || student.balance !== row.balance || student.status !== 'ACTIVE') {
            throw new Error('Bulk student import result integrity check failed.');
          }
          items.push({ rowNumber: row.rowNumber, studentId: student.studentId, name: student.name, balance: student.balance });
        }
        return { ok: true, kind: 'students', operationId: request.operationId, created: items.length, replayed, items };
      });
    },
  };
}

export function createDatabaseProductImport(dependencies: DatabaseBulkImportDependencies) {
  const { tenantId } = dependencies;
  return {
    loadExisting(): Promise<ExistingProducts> {
      return dependencies.runTenantTransaction(tenantId, (tx) => readExistingProducts(tx, tenantId));
    },

    async commit(request: BulkImportCommitRequest<ProductImportRow>): Promise<ProductImportCommitResult> {
      const rows = [...request.rows];
      if (rows.length === 0) throw new Error('A nonempty bulk import is required.');
      const childIds = rows.map((_, index) => bulkImportChildOperationId('products', request.operationId, index));
      return dependencies.runTenantTransaction(tenantId, async (tx) => {
        const recorded = await readRecordedOperations(tx, tenantId, childIds);
        const replayed = recorded.size > 0;
        let productIds: string[];
        if (replayed) {
          // The IDs were allocated by the original commit; recover them from its receipts.
          const recoveredIds = childIds.map((id) => recordedProductId(recorded.get(id)));
          if (recoveredIds.some((id) => id === null)) {
            throw new BulkImportCommitError('OPERATION_CONFLICT', CONFLICT_MESSAGE);
          }
          productIds = recoveredIds as string[];
        } else {
          const existing = await readExistingProducts(tx, tenantId);
          const { errors } = validateProductRows(rows, existing);
          if (errors.length) throw new BulkImportCommitError('VALIDATION_FAILED', STALE_MESSAGE, sortIssues(errors));
          productIds = allocateProductIds(existing.usedProductIds, rows.length);
        }

        const commands = (dependencies.createCatalogCommands ?? createDatabaseCatalogCommands)({
          tenantId,
          runTenantTransaction: boundTo(tx, tenantId),
          now: dependencies.now,
        });
        const items: ProductImportCreated[] = [];
        for (const [index, row] of rows.entries()) {
          let created;
          try {
            created = await commands.create({
              operationId: childIds[index],
              productId: productIds[index],
              name: row.name,
              price: row.price,
              stock: row.stock,
              isActive: row.isActive,
              sortOrder: row.sortOrder,
              ...(row.imageUrl === null ? {} : { imageUrl: row.imageUrl }),
              ...(row.category === null ? {} : { category: row.category }),
            });
          } catch (error) {
            throw translateCommandError(error);
          }
          const product = created.products.length === 1 ? created.products[0] : undefined;
          if (!product || created.operationId !== childIds[index] || product.productId !== productIds[index]
            || product.name !== row.name || product.price !== row.price || product.stock !== row.stock) {
            throw new Error('Bulk product import result integrity check failed.');
          }
          items.push({ rowNumber: row.rowNumber, productId: product.productId, name: product.name });
        }
        return { ok: true, kind: 'products', operationId: request.operationId, created: items.length, replayed, items };
      });
    },
  };
}

function recordedProductId(operation: RecordedOperation | undefined): string | null {
  if (!operation || operation.operationKind !== 'PRODUCT_ADMIN') return null;
  const snapshot = operation.resultSnapshot as { products?: unknown } | null;
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.products) || snapshot.products.length !== 1) {
    return null;
  }
  const productId = (snapshot.products[0] as { productId?: unknown } | null)?.productId;
  return typeof productId === 'string' && productId ? productId : null;
}
