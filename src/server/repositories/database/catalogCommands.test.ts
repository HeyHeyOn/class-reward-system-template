import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseCatalogCommands,
  createProductAdminInventoryEventId,
  createProductAdminLedgerOperationId,
  createProductAdminPayloadHash,
  createProductAdminResultHash,
  type DatabaseCatalogCommandDependencies,
} from './catalogCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

import { appendOperationAudit } from './operationAudit';
import { createDatabaseTransactionCommands } from './transactionCommands';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-29T13:30:00.000Z');
const OPERATION_ID = 'product-create-op-001';
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
});

afterEach(async () => harness?.close());

function commands(overrides: Partial<DatabaseCatalogCommandDependencies> = {}) {
  return createDatabaseCatalogCommands({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => new Date(NOW),
    ...overrides,
  });
}

async function withOperationAuditTampering<TResult>(callback: () => Promise<TResult>): Promise<TResult> {
  await harness.database.exec(`
    ALTER TABLE operations DISABLE TRIGGER operations_update_guard;
    ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
  `);
  try {
    return await callback();
  } finally {
    await harness.database.exec(`
      ALTER TABLE operations ENABLE TRIGGER operations_update_guard;
      ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable;
    `);
  }
}

async function snapshot(tenantId = harness.tenantOneId) {
  const [products, inventory, operations, audits] = await Promise.all([
    harness.database.query(
      `SELECT product_id, name, price::text, stock::text, is_active, image_url, category,
              sort_order, version::text, deleted_at
       FROM products WHERE tenant_id=$1 ORDER BY product_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT inventory_event_id::text, product_id, transaction_id, quantity_delta::text,
              stock_before::text, stock_after::text, reason, operation_id, operation_hash,
              occurred_at
       FROM inventory_ledger WHERE tenant_id=$1 ORDER BY inventory_event_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT operation_id, operation_kind, payload_hash, status, result_snapshot
       FROM operations WHERE tenant_id=$1 ORDER BY operation_id`,
      [tenantId],
    ),
    harness.database.query(
      `SELECT operation_id, event_type, entity_type, entity_id, redacted_details, occurred_at
       FROM audit_events WHERE tenant_id=$1 ORDER BY event_id`,
      [tenantId],
    ),
  ]);
  return { products: products.rows, inventory: inventory.rows, operations: operations.rows, audits: audits.rows };
}

const createInput = (overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION_ID,
  productId: 'P001',
  name: ' 연필 ',
  price: 500,
  stock: 12,
  isActive: true,
  imageUrl: ' https://example.com/pencil.png ',
  category: ' 문구 ',
  sortOrder: -2,
  ...overrides,
});

async function seedProduct(input: {
  productId: string;
  name?: string;
  price?: number;
  stock?: number;
  isActive?: boolean;
  version?: number;
}) {
  const createdAt = new Date('2026-08-28T00:00:00.000Z');
  await harness.database.query(
    `INSERT INTO products
      (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $8)`,
    [
      harness.tenantOneId, input.productId, input.name ?? '기존 상품', input.price ?? 100,
      input.stock ?? 5, input.isActive ?? true, input.version ?? 1, createdAt,
    ],
  );
}

describe('PostgreSQL catalog administration commands', () => {
  it('restores operation and audit tamper guards when a fixture callback throws', async () => {
    await expect(withOperationAuditTampering(async () => {
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');

    const triggers = await harness.database.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgname IN ('operations_update_guard', 'audit_events_immutable')
       ORDER BY tgname`,
    );
    expect(triggers.rows).toEqual([
      { tgname: 'audit_events_immutable', tgenabled: 'O' },
      { tgname: 'operations_update_guard', tgenabled: 'O' },
    ]);
  });

  it('creates a product with immutable initial-stock evidence and audit in one operation', async () => {
    const result = await commands().create(createInput());
    const payloadHash = createProductAdminPayloadHash({
      action: 'CREATE',
      products: [{
        productId: 'P001', name: '연필', price: 500, stock: 12, isActive: true,
        imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: -2,
      }],
    });

    expect(result).toEqual({
      ok: true,
      operationId: OPERATION_ID,
      action: 'CREATE',
      completedAt: NOW.toISOString(),
      products: [{
        productId: 'P001', name: '연필', price: 500, stock: 12, isActive: true,
        imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: -2,
        productVersionBefore: null,
        productVersionAfter: 1,
        stockBefore: null,
        stockAfter: 12,
        inventoryEventId: createProductAdminInventoryEventId(OPERATION_ID, 'P001'),
      }],
    });

    const state = await snapshot();
    expect(state.products).toEqual([{
      product_id: 'P001', name: '연필', price: '500', stock: '12', is_active: true,
      image_url: 'https://example.com/pencil.png', category: '문구', sort_order: -2,
      version: '1', deleted_at: null,
    }]);
    expect(state.inventory).toEqual([{
      inventory_event_id: createProductAdminInventoryEventId(OPERATION_ID, 'P001'),
      product_id: 'P001', transaction_id: null, quantity_delta: '12', stock_before: '0',
      stock_after: '12', reason: 'ADMIN_ADJUSTMENT',
      operation_id: createProductAdminLedgerOperationId(OPERATION_ID, 'P001'),
      operation_hash: payloadHash, occurred_at: NOW,
    }]);
    expect(state.operations).toEqual([expect.objectContaining({
      operation_id: OPERATION_ID, operation_kind: 'PRODUCT_ADMIN', payload_hash: payloadHash,
      status: 'SUCCEEDED', result_snapshot: result,
    })]);
    expect(state.audits).toEqual([{
      operation_id: OPERATION_ID,
      event_type: 'PRODUCT_ADMIN_COMPLETED',
      entity_type: 'OPERATION',
      entity_id: OPERATION_ID,
      redacted_details: {
        action: 'CREATE', changedProductCount: 1, ledgerCount: 1, productCount: 1,
        resultHash: createProductAdminResultHash(result),
      },
      occurred_at: NOW,
    }]);
  });

  it('returns the exact stored create result on retry without duplicating product evidence', async () => {
    const first = await commands().create(createInput());
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') })
      .create(createInput());

    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.products).toHaveLength(1);
    expect(state.inventory).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('replays historical create evidence after the product is legitimately changed later', async () => {
    const first = await commands().create(createInput());
    await harness.database.query(
      `UPDATE products
       SET name='새 연필', price=600, is_active=false, category='새 분류', version=2, updated_at=$3
       WHERE tenant_id=$1 AND product_id=$2`,
      [harness.tenantOneId, 'P001', new Date('2026-08-30T00:00:00.000Z')],
    );

    await expect(commands().create(createInput())).resolves.toEqual(first);
  });

  it('creates zero stock without fabricating inventory evidence and replays exactly', async () => {
    const input = createInput({ operationId: 'product-create-zero-op', productId: 'P000', stock: 0 });
    const first = await commands().create(input);
    const second = await commands().create(input);

    expect(second).toEqual(first);
    expect(first.products[0].inventoryEventId).toBeNull();
    const state = await snapshot();
    expect(state.products).toHaveLength(1);
    expect(state.inventory).toHaveLength(0);
    expect(state.audits[0]).toEqual(expect.objectContaining({
      redacted_details: expect.objectContaining({ ledgerCount: 0 }),
    }));
  });

  it('fails closed when zero-stock replay finds deterministic inventory attribution with a wrong hash', async () => {
    const input = createInput({ operationId: 'product-create-zero-corrupt-op', productId: 'P000', stock: 0 });
    await commands().create(input);
    await harness.database.query(
      `INSERT INTO inventory_ledger
        (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
         stock_before, stock_after, reason, operation_id, operation_hash, occurred_at)
       VALUES ($1, '40000000-0000-4000-8000-000000000001', 'P000', NULL, 0, 0, 0,
               'ADMIN_ADJUSTMENT', $2, 'wrong-hash', $3)`,
      [harness.tenantOneId, createProductAdminLedgerOperationId(input.operationId, 'P000'), NOW],
    );

    await expect(commands().create(input)).rejects.toThrow(/ledger integrity/i);
  });

  it('fails closed when replay finds an extra audit for the operation', async () => {
    await commands().create(createInput());
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      await appendOperationAudit(tx, harness.tenantOneId, {
        operationId: OPERATION_ID,
        eventType: 'PRODUCT_ADMIN_EXTRA',
        entityType: 'OPERATION',
        entityId: OPERATION_ID,
        redactedDetails: { action: 'CREATE' },
        occurredAt: NOW,
      });
    });

    await expect(commands().create(createInput())).rejects.toThrow(/audit integrity/i);
  });

  it('fails closed when zero-stock replay finds its deterministic event ID with unrelated attribution', async () => {
    const input = createInput({ operationId: 'product-create-zero-event-op', productId: 'P000', stock: 0 });
    await commands().create(input);
    await harness.database.query(
      `INSERT INTO inventory_ledger
        (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
         stock_before, stock_after, reason, operation_id, operation_hash, occurred_at)
       VALUES ($1, $2, 'P000', NULL, 0, 0, 0, 'ADMIN_ADJUSTMENT',
               'unrelated-operation', 'unrelated-hash', $3)`,
      [harness.tenantOneId, createProductAdminInventoryEventId(input.operationId, 'P000'), NOW],
    );

    await expect(commands().create(input)).rejects.toThrow(/ledger integrity/i);
  });

  it('fails closed when a zero-stock product is hard-deleted and replaced under the same ID', async () => {
    const input = createInput({ operationId: 'product-create-zero-replaced-op', productId: 'P000', stock: 0 });
    await commands().create(input);
    await harness.database.query('DELETE FROM products WHERE tenant_id=$1 AND product_id=$2', [
      harness.tenantOneId, 'P000',
    ]);
    await harness.database.query(
      `INSERT INTO products
        (tenant_id, product_id, name, price, stock, is_active, sort_order, version, created_at, updated_at)
       VALUES ($1, 'P000', 'replacement', 1, 0, true, 0, 1, $2, $2)`,
      [harness.tenantOneId, new Date('2026-08-30T00:00:00.000Z')],
    );

    await expect(commands().create(input)).rejects.toThrow(/product integrity/i);
  });

  it('rolls back when the terminal operation transition affects no row', async () => {
    await harness.database.exec(`
      CREATE FUNCTION suppress_product_operation_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.operation_kind='PRODUCT_ADMIN' AND NEW.status='SUCCEEDED' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER operations_suppress_product_terminal
      BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION suppress_product_operation_terminal();
    `);

    await expect(commands().create(createInput())).rejects.toThrow(/terminal operation/i);
    const state = await snapshot();
    expect(state.products).toHaveLength(0);
    expect(state.inventory).toHaveLength(0);
    expect(state.operations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('rejects reusing an operation ID with a different canonical payload', async () => {
    await commands().create(createInput());
    await expect(commands().create(createInput({ price: 501 }))).rejects.toThrow(/operation conflict/i);
    const state = await snapshot();
    expect(state.products).toHaveLength(1);
    expect(state.inventory).toHaveLength(1);
  });

  it('fails closed when successful operation lifecycle evidence is corrupted', async () => {
    await commands().create(createInput());
    await harness.database.query(
      'UPDATE operations SET attempt_count=2 WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, OPERATION_ID],
    );

    await expect(commands().create(createInput())).rejects.toThrow(/operation integrity/i);
  });

  it('fails closed when replay is missing its immutable audit', async () => {
    await commands().create(createInput());
    await withOperationAuditTampering(() => harness.database.query(
      'DELETE FROM audit_events WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantOneId, OPERATION_ID],
    ));

    await expect(commands().create(createInput())).rejects.toThrow(/audit integrity/i);
  });

  it('fails closed when replay is missing its immutable inventory evidence', async () => {
    await commands().create(createInput());
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      'DELETE FROM inventory_ledger WHERE tenant_id=$1 AND inventory_event_id=$2',
      [harness.tenantOneId, createProductAdminInventoryEventId(OPERATION_ID, 'P001')],
    ));

    await expect(commands().create(createInput())).rejects.toThrow(/ledger integrity/i);
  });

  it('rejects unsafe numeric inputs before opening a tenant transaction', async () => {
    const transactionSpy = vi.fn();
    const runTenantTransaction: DatabaseCatalogCommandDependencies['runTenantTransaction'] =
      async () => {
        transactionSpy();
        throw new Error('unexpected tenant transaction');
      };
    await expect(commands({ runTenantTransaction }).create(
      createInput({ stock: Number.MAX_SAFE_INTEGER + 1 }),
    )).rejects.toThrow(/safe integer/i);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('does not reuse a tombstoned product ID or leave a failed operation claim', async () => {
    await harness.database.query(
      `INSERT INTO products
        (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
         created_at, updated_at, deleted_at)
       VALUES ($1, 'P001', 'old', 1, 0, false, 0, 2, $2, $2, $2)`,
      [harness.tenantOneId, NOW],
    );

    await expect(commands().create(createInput())).rejects.toThrow();
    const state = await snapshot();
    expect(state.products).toHaveLength(1);
    expect(state.operations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('updates a product with optimistic versioning and immutable stock-delta evidence', async () => {
    await seedProduct({ productId: 'P010', name: '기존', price: 100, stock: 5 });
    const operationId = 'product-update-op-001';

    const result = await commands().update({
      operationId,
      productId: 'P010',
      expectedProductVersion: 1,
      name: ' 새 상품 ',
      price: 250,
      stock: 9,
      isActive: false,
      imageUrl: '',
      category: ' 새 분류 ',
      sortOrder: 3,
    });

    expect(result).toEqual({
      ok: true,
      operationId,
      action: 'UPDATE',
      completedAt: NOW.toISOString(),
      products: [{
        productId: 'P010', name: '새 상품', price: 250, stock: 9, isActive: false,
        imageUrl: null, category: '새 분류', sortOrder: 3,
        productVersionBefore: 1, productVersionAfter: 2,
        stockBefore: 5, stockAfter: 9,
        inventoryEventId: createProductAdminInventoryEventId(operationId, 'P010'),
      }],
    });
    const state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({
      product_id: 'P010', name: '새 상품', price: '250', stock: '9', is_active: false,
      image_url: null, category: '새 분류', sort_order: 3, version: '2', deleted_at: null,
    })]);
    expect(state.inventory).toEqual([expect.objectContaining({
      inventory_event_id: createProductAdminInventoryEventId(operationId, 'P010'),
      product_id: 'P010', transaction_id: null, quantity_delta: '4',
      stock_before: '5', stock_after: '9', reason: 'ADMIN_ADJUSTMENT',
      operation_id: createProductAdminLedgerOperationId(operationId, 'P010'),
    })]);
    expect(state.operations).toEqual([expect.objectContaining({
      operation_id: operationId, operation_kind: 'PRODUCT_ADMIN', status: 'SUCCEEDED',
      result_snapshot: result,
    })]);
    expect(state.audits).toEqual([expect.objectContaining({
      operation_id: operationId,
      redacted_details: expect.objectContaining({ action: 'UPDATE', ledgerCount: 1 }),
    })]);
  });

  it('exactly replays a product update without incrementing version or stock twice', async () => {
    await seedProduct({ productId: 'P010', stock: 5 });
    const input = {
      operationId: 'product-update-replay-op',
      productId: 'P010',
      expectedProductVersion: 1,
      name: '수정 상품',
      price: 200,
      stock: 8,
      isActive: true,
      imageUrl: undefined,
      category: undefined,
      sortOrder: 1,
    };
    const first = await commands().update(input);
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') }).update(input);

    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({ version: '2', stock: '8' })]);
    expect(state.inventory).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('fails closed on update-specific result and ledger corruption', async () => {
    await seedProduct({ productId: 'P010', stock: 5 });
    const input = {
      operationId: 'product-update-corruption-op', productId: 'P010', expectedProductVersion: 1,
      name: '수정', price: 200, stock: 8, isActive: true, sortOrder: 1,
    };
    const result = await commands().update(input);
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      'DELETE FROM inventory_ledger WHERE tenant_id=$1 AND inventory_event_id=$2',
      [harness.tenantOneId, result.products[0].inventoryEventId],
    ));
    await expect(commands().update(input)).rejects.toThrow(/ledger integrity/i);

    await withOperationAuditTampering(() => harness.database.query(
      `UPDATE operations
       SET result_snapshot=jsonb_set(result_snapshot, '{products,0,productVersionAfter}', '3'::jsonb)
       WHERE tenant_id=$1 AND operation_id=$2`,
      [harness.tenantOneId, input.operationId],
    ));
    await expect(commands().update(input)).rejects.toThrow(/stored result integrity/i);
  });

  it('fails closed on deterministic update evidence for a zero stock delta', async () => {
    await seedProduct({ productId: 'P010', stock: 5 });
    const input = {
      operationId: 'product-update-zero-corrupt-op', productId: 'P010', expectedProductVersion: 1,
      name: '수정', price: 200, stock: 5, isActive: true, sortOrder: 1,
    };
    await commands().update(input);
    await harness.database.query(
      `INSERT INTO inventory_ledger
        (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
         stock_before, stock_after, reason, operation_id, operation_hash, occurred_at)
       VALUES ($1, $2, 'P010', NULL, 0, 5, 5, 'ADMIN_ADJUSTMENT',
               'unrelated-operation', 'unrelated-hash', $3)`,
      [harness.tenantOneId, createProductAdminInventoryEventId(input.operationId, 'P010'), NOW],
    );
    await expect(commands().update(input)).rejects.toThrow(/ledger integrity/i);
  });

  it('rolls back an update when its terminal operation transition is suppressed', async () => {
    await seedProduct({ productId: 'P010', stock: 5 });
    await harness.database.exec(`
      CREATE FUNCTION suppress_product_update_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id='product-update-terminal-op' AND NEW.status='SUCCEEDED' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER operations_suppress_product_update_terminal
      BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION suppress_product_update_terminal();
    `);
    await expect(commands().update({
      operationId: 'product-update-terminal-op', productId: 'P010', expectedProductVersion: 1,
      name: '수정', price: 200, stock: 8, isActive: true, sortOrder: 1,
    })).rejects.toThrow(/terminal operation/i);
    const state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({ name: '기존 상품', stock: '5', version: '1' })]);
    expect(state.inventory).toHaveLength(0);
    expect(state.operations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('rolls back the operation when the expected product version is stale', async () => {
    await seedProduct({ productId: 'P010', stock: 5, version: 2 });
    await expect(commands().update({
      operationId: 'product-update-stale-op', productId: 'P010', expectedProductVersion: 1,
      name: '수정', price: 200, stock: 8, isActive: true, sortOrder: 1,
    })).rejects.toThrow(/stale/i);
    const state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({ version: '2', stock: '5', name: '기존 상품' })]);
    expect(state.inventory).toHaveLength(0);
    expect(state.operations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('increments the version without fabricating inventory evidence when stock is unchanged', async () => {
    await seedProduct({ productId: 'P010', stock: 5 });
    const input = {
      operationId: 'product-update-no-delta-op', productId: 'P010', expectedProductVersion: 1,
      name: '이름만 변경', price: 150, stock: 5, isActive: true, sortOrder: 2,
    };
    const first = await commands().update(input);
    const second = await commands().update(input);
    expect(second).toEqual(first);
    expect(first.products[0]).toEqual(expect.objectContaining({
      productVersionBefore: 1, productVersionAfter: 2,
      stockBefore: 5, stockAfter: 5, inventoryEventId: null,
    }));
    const state = await snapshot();
    expect(state.inventory).toHaveLength(0);
    expect(state.audits[0]).toEqual(expect.objectContaining({
      redacted_details: expect.objectContaining({ ledgerCount: 0 }),
    }));
  });

  it('replays an earlier update after a later legitimate update changes the live row', async () => {
    await seedProduct({ productId: 'P010', stock: 5 });
    const firstInput = {
      operationId: 'product-update-history-1', productId: 'P010', expectedProductVersion: 1,
      name: '첫 변경', price: 150, stock: 7, isActive: true, sortOrder: 1,
    };
    const first = await commands().update(firstInput);
    await commands().update({
      operationId: 'product-update-history-2', productId: 'P010', expectedProductVersion: 2,
      name: '둘째 변경', price: 175, stock: 9, isActive: false, sortOrder: 2,
    });
    expect(await commands().update(firstInput)).toEqual(first);
  });

  it('rejects tombstoned products and unsafe version successors', async () => {
    await seedProduct({ productId: 'P010', stock: 5 });
    await harness.database.query(
      `UPDATE products SET is_active=false, deleted_at=$3
       WHERE tenant_id=$1 AND product_id=$2`,
      [harness.tenantOneId, 'P010', NOW],
    );
    await expect(commands().update({
      operationId: 'product-update-tombstone-op', productId: 'P010', expectedProductVersion: 1,
      name: '수정', price: 100, stock: 5, isActive: false, sortOrder: 0,
    })).rejects.toThrow(/not found/i);

    await harness.database.query(
      `UPDATE products SET deleted_at=NULL, is_active=true, version=9007199254740991
       WHERE tenant_id=$1 AND product_id=$2`,
      [harness.tenantOneId, 'P010'],
    );
    await expect(commands().update({
      operationId: 'product-update-overflow-op', productId: 'P010',
      expectedProductVersion: Number.MAX_SAFE_INTEGER,
      name: '수정', price: 100, stock: 5, isActive: true, sortOrder: 0,
    })).rejects.toThrow(/successor|safe integer/i);
  });

  it('deactivates a product as a versioned tombstone without changing stock or creating a ledger', async () => {
    await seedProduct({ productId: 'P020', name: '삭제 상품', price: 300, stock: 5 });
    const operationId = 'product-deactivate-op-001';
    const result = await commands().deactivate({
      operationId,
      productId: 'P020',
      expectedProductVersion: 1,
    });

    expect(result).toEqual({
      ok: true,
      operationId,
      action: 'DEACTIVATE',
      completedAt: NOW.toISOString(),
      products: [{
        productId: 'P020', name: '삭제 상품', price: 300, stock: 5, isActive: false,
        imageUrl: null, category: null, sortOrder: 0, deletedAt: NOW.toISOString(),
        productVersionBefore: 1, productVersionAfter: 2,
        stockBefore: 5, stockAfter: 5, inventoryEventId: null,
      }],
    });
    const state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({
      product_id: 'P020', name: '삭제 상품', price: '300', stock: '5', is_active: false,
      version: '2', deleted_at: NOW,
    })]);
    expect(state.inventory).toHaveLength(0);
    expect(state.operations).toEqual([expect.objectContaining({
      operation_id: operationId, operation_kind: 'PRODUCT_ADMIN', status: 'SUCCEEDED',
      result_snapshot: result,
    })]);
    expect(state.audits).toEqual([expect.objectContaining({
      operation_id: operationId,
      redacted_details: expect.objectContaining({ action: 'DEACTIVATE', ledgerCount: 0 }),
    })]);
  });

  it('exactly replays a product deactivation from frozen tombstone evidence', async () => {
    await seedProduct({ productId: 'P020', name: ' 삭제 상품 ', price: 300, stock: 5 });
    const input = {
      operationId: 'product-deactivate-replay-op', productId: 'P020', expectedProductVersion: 1,
    };
    const first = await commands().deactivate(input);
    const second = await commands({ now: () => new Date('2026-08-30T00:00:00.000Z') }).deactivate(input);
    expect(second).toEqual(first);
    expect(second.products[0].name).toBe(' 삭제 상품 ');
    const state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({
      product_id: 'P020', is_active: false, version: '2', deleted_at: NOW,
    })]);
    expect(state.inventory).toHaveLength(0);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('rejects stale or already tombstoned product deactivation without partial evidence', async () => {
    await seedProduct({ productId: 'P020', stock: 5, version: 2 });
    await expect(commands().deactivate({
      operationId: 'product-deactivate-stale-op', productId: 'P020', expectedProductVersion: 1,
    })).rejects.toThrow(/stale/i);
    let state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({ version: '2', deleted_at: null })]);
    expect(state.operations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);

    const first = await commands().deactivate({
      operationId: 'product-deactivate-first-op', productId: 'P020', expectedProductVersion: 2,
    });
    await expect(commands().deactivate({
      operationId: 'product-deactivate-second-op', productId: 'P020', expectedProductVersion: 3,
    })).rejects.toThrow(/already tombstoned/i);
    state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({
      version: String(first.products[0].productVersionAfter), deleted_at: NOW,
    })]);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('fails closed when deactivation replay finds changed tombstone state or unexpected ledger evidence', async () => {
    await seedProduct({ productId: 'P020', stock: 5 });
    const input = {
      operationId: 'product-deactivate-corrupt-op', productId: 'P020', expectedProductVersion: 1,
    };
    await commands().deactivate(input);
    await harness.database.query(
      `INSERT INTO inventory_ledger
        (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
         stock_before, stock_after, reason, operation_id, operation_hash, occurred_at)
       VALUES ($1, $2, 'P020', NULL, 0, 5, 5, 'ADMIN_ADJUSTMENT',
               'unrelated-operation', 'unrelated-hash', $3)`,
      [harness.tenantOneId, createProductAdminInventoryEventId(input.operationId, 'P020'), NOW],
    );
    await expect(commands().deactivate(input)).rejects.toThrow(/ledger integrity/i);

    await harness.database.query(
      `UPDATE products SET name='tampered tombstone'
       WHERE tenant_id=$1 AND product_id='P020'`,
      [harness.tenantOneId],
    );
    await expect(commands().deactivate(input)).rejects.toThrow(/tombstone.*integrity/i);
  });

  it('replays deactivation after a legitimate checkout cancellation restores tombstoned stock', async () => {
    await seedProduct({ productId: 'P020', name: '삭제 상품', price: 300, stock: 5 });
    await harness.database.query(
      `INSERT INTO students (tenant_id, student_id, name, status)
       VALUES ($1, 'S020', '학생', 'ACTIVE')`,
      [harness.tenantOneId],
    );
    await harness.database.query(
      `INSERT INTO accounts (tenant_id, student_id, balance)
       VALUES ($1, 'S020', 700)`,
      [harness.tenantOneId],
    );
    await harness.database.query(
      `INSERT INTO transactions
        (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
         legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
         legacy_status_snapshot, operation_id, operation_hash, schema_version)
       VALUES ($1, 'checkout:before-delete', $3, 'S020', '학생',
               'CHECKOUT', 300, -300, 1000, 700, 'kiosk', 'COMPLETED',
               'checkout-before-delete-op', $2, 1)`,
      [harness.tenantOneId, 'c'.repeat(64), NOW],
    );
    await harness.database.query(
      `INSERT INTO transaction_items
        (tenant_id, transaction_id, line_number, product_id_snapshot, current_product_id,
         product_name_snapshot, quantity, unit_price_snapshot, subtotal_snapshot,
         regular_unit_price, regular_total, total_quantity, paid_quantity, free_quantity,
         final_total, total_discount, adjustments_snapshot, applied_promotions_snapshot)
       VALUES ($1, 'checkout:before-delete', 1, 'P020', 'P020', '삭제 상품',
               1, 300, 300, 300, 300, 1, 1, 0, 300, 0, '[]', '[]')`,
      [harness.tenantOneId],
    );
    await harness.database.query(
      `INSERT INTO inventory_ledger
        (tenant_id, inventory_event_id, product_id, transaction_id, quantity_delta,
         stock_before, stock_after, reason, operation_id, operation_hash, occurred_at)
       VALUES ($1, '40000000-0000-4000-8000-000000000020', 'P020',
               'checkout:before-delete', -1, 6, 5, 'CHECKOUT', NULL, NULL, $2)`,
      [harness.tenantOneId, NOW],
    );
    const input = {
      operationId: 'product-deactivate-before-cancel-op', productId: 'P020', expectedProductVersion: 1,
    };
    const first = await commands().deactivate(input);
    const transactionCommandsAt = (timestamp: Date) => createDatabaseTransactionCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => timestamp,
    });
    await expect(transactionCommandsAt(NOW).cancel({
      operationId: '30000000-0000-4000-8000-000000000019',
      transactionId: 'checkout:before-delete',
    })).rejects.toMatchObject({ code: 'MANUAL_RECONCILIATION_REQUIRED' });
    await transactionCommandsAt(new Date('2026-08-29T14:00:00.000Z')).cancel({
      operationId: '30000000-0000-4000-8000-000000000020',
      transactionId: 'checkout:before-delete',
    });
    await harness.database.query(
      `INSERT INTO transactions
        (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
         legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
         legacy_status_snapshot, operation_id, operation_hash, schema_version)
       VALUES ($1, 'checkout:second-before-delete', '2026-08-29T12:30:00Z', 'S020', '학생',
               'CHECKOUT', 300, -300, 1300, 1000, 'kiosk', 'COMPLETED',
               'checkout-second-before-delete-op', $2, 1)`,
      [harness.tenantOneId, 'd'.repeat(64)],
    );
    await harness.database.query(
      `INSERT INTO transaction_items
        (tenant_id, transaction_id, line_number, product_id_snapshot, current_product_id,
         product_name_snapshot, quantity, unit_price_snapshot, subtotal_snapshot,
         regular_unit_price, regular_total, total_quantity, paid_quantity, free_quantity,
         final_total, total_discount, adjustments_snapshot, applied_promotions_snapshot)
       VALUES ($1, 'checkout:second-before-delete', 1, 'P020', 'P020', '삭제 상품',
               1, 300, 300, 300, 300, 1, 1, 0, 300, 0, '[]', '[]')`,
      [harness.tenantOneId],
    );
    await expect(transactionCommandsAt(new Date('2026-08-29T14:00:00.000Z')).cancel({
      operationId: '30000000-0000-4000-8000-000000000021',
      transactionId: 'checkout:second-before-delete',
    })).rejects.toMatchObject({ code: 'MANUAL_RECONCILIATION_REQUIRED' });
    await transactionCommandsAt(new Date('2026-08-29T15:00:00.000Z')).cancel({
      operationId: '30000000-0000-4000-8000-000000000022',
      transactionId: 'checkout:second-before-delete',
    });

    await expect(commands().deactivate(input)).resolves.toEqual(first);
    const state = await snapshot();
    expect(state.products).toEqual([expect.objectContaining({
      product_id: 'P020', stock: '7', version: '4', is_active: false, deleted_at: NOW,
    })]);
  });

  it('fails closed when the frozen tombstone updated timestamp changes', async () => {
    await seedProduct({ productId: 'P020', stock: 5 });
    const input = {
      operationId: 'product-deactivate-updated-at-op', productId: 'P020', expectedProductVersion: 1,
    };
    await commands().deactivate(input);
    await harness.database.query(
      `UPDATE products SET updated_at=$3
       WHERE tenant_id=$1 AND product_id=$2`,
      [harness.tenantOneId, 'P020', new Date('2026-08-30T00:00:00.000Z')],
    );
    await expect(commands().deactivate(input)).rejects.toThrow(/tombstone.*integrity/i);
  });

  it('batch-updates products in stable ID order with one operation and only changed-stock ledgers', async () => {
    await seedProduct({ productId: 'P031', name: '둘', stock: 4 });
    await seedProduct({ productId: 'P030', name: '하나', stock: 2 });
    const result = await commands().updateBatch({
      operationId: 'product-update-batch-op',
      products: [
        {
          productId: 'P031', expectedProductVersion: 1, name: '둘 수정', price: 200,
          stock: 4, isActive: true, imageUrl: '', category: 'B', sortOrder: 2,
        },
        {
          productId: 'P030', expectedProductVersion: 1, name: '하나 수정', price: 100,
          stock: 5, isActive: true, imageUrl: '', category: 'A', sortOrder: 1,
        },
      ],
    });
    expect(result.products.map((product) => product.productId)).toEqual(['P030', 'P031']);
    expect(result.products.map((product) => ({
      productId: product.productId,
      version: product.productVersionAfter,
      stockBefore: product.stockBefore,
      stockAfter: product.stockAfter,
      hasLedger: product.inventoryEventId !== null,
    }))).toEqual([
      { productId: 'P030', version: 2, stockBefore: 2, stockAfter: 5, hasLedger: true },
      { productId: 'P031', version: 2, stockBefore: 4, stockAfter: 4, hasLedger: false },
    ]);
    const state = await snapshot();
    expect(state.operations).toHaveLength(1);
    expect(state.inventory).toHaveLength(1);
    expect(state.audits).toEqual([expect.objectContaining({
      operation_id: 'product-update-batch-op',
      redacted_details: expect.objectContaining({ action: 'UPDATE', productCount: 2, ledgerCount: 1 }),
    })]);
  });

  it('exactly replays a canonical product update batch without duplicate mutations', async () => {
    await seedProduct({ productId: 'P031', stock: 4 });
    await seedProduct({ productId: 'P030', stock: 2 });
    const input = {
      operationId: 'product-update-batch-replay-op',
      products: [
        {
          productId: 'P031', expectedProductVersion: 1, name: '둘', price: 200,
          stock: 4, isActive: true, imageUrl: '', category: 'B', sortOrder: 2,
        },
        {
          productId: 'P030', expectedProductVersion: 1, name: '하나', price: 100,
          stock: 5, isActive: true, imageUrl: '', category: 'A', sortOrder: 1,
        },
      ],
    };
    const first = await commands().updateBatch(input);
    const second = await commands().updateBatch({ ...input, products: [...input.products].reverse() });
    expect(second).toEqual(first);
    const state = await snapshot();
    expect((state.products as Array<{ product_id: string; version: string }>).map((product) => ({
      id: product.product_id, version: product.version,
    }))).toEqual([
      { id: 'P030', version: '2' }, { id: 'P031', version: '2' },
    ]);
    expect(state.inventory).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('batch-deactivates products in stable ID order with one operation and no stock ledger', async () => {
    await seedProduct({ productId: 'P041', name: '둘', stock: 4 });
    await seedProduct({ productId: 'P040', name: '하나', stock: 2 });
    const result = await commands().deactivateBatch({
      operationId: 'product-deactivate-batch-op',
      products: [
        { productId: 'P041', expectedProductVersion: 1 },
        { productId: 'P040', expectedProductVersion: 1 },
      ],
    });
    expect(result.products.map((product) => ({
      id: product.productId,
      version: product.productVersionAfter,
      deletedAt: product.deletedAt,
    }))).toEqual([
      { id: 'P040', version: 2, deletedAt: NOW.toISOString() },
      { id: 'P041', version: 2, deletedAt: NOW.toISOString() },
    ]);
    const state = await snapshot();
    expect(state.products).toEqual([
      expect.objectContaining({ product_id: 'P040', is_active: false, stock: '2', version: '2' }),
      expect.objectContaining({ product_id: 'P041', is_active: false, stock: '4', version: '2' }),
    ]);
    expect(state.inventory).toHaveLength(0);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toEqual([expect.objectContaining({
      operation_id: 'product-deactivate-batch-op',
      redacted_details: expect.objectContaining({ action: 'DEACTIVATE', productCount: 2, ledgerCount: 0 }),
    })]);
  });

  it('exactly replays a canonical product deactivation batch', async () => {
    await seedProduct({ productId: 'P041', stock: 4 });
    await seedProduct({ productId: 'P040', stock: 2 });
    const input = {
      operationId: 'product-deactivate-batch-replay-op',
      products: [
        { productId: 'P041', expectedProductVersion: 1 },
        { productId: 'P040', expectedProductVersion: 1 },
      ],
    };
    const first = await commands().deactivateBatch(input);
    const second = await commands().deactivateBatch({ ...input, products: [...input.products].reverse() });
    expect(second).toEqual(first);
    const state = await snapshot();
    expect(state.inventory).toHaveLength(0);
    expect(state.operations).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it('locks all deactivation replay products in one database-ordered query', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/server/repositories/database/catalogCommands.ts'), 'utf8');
    const start = source.indexOf('async function resolveExistingDeactivateBatch');
    const end = source.indexOf('async function resolveExistingDeactivate(', start);
    const body = source.slice(start, end);
    expect(body).toMatch(/SELECT[\s\S]*product_id IN \([\s\S]*ORDER BY product_id[\s\S]*FOR UPDATE/);
  });

  it('rejects oversized and duplicate product batches before entering a tenant transaction', async () => {
    const transactionSpy = vi.fn(async () => {
      throw new Error('entered tenant transaction');
    });
    const runTenantTransaction: DatabaseCatalogCommandDependencies['runTenantTransaction'] =
      async (_tenantId, callback) => {
        await transactionSpy();
        return callback({} as never);
      };
    const isolated = createDatabaseCatalogCommands({
      tenantId: harness.tenantOneId,
      runTenantTransaction,
      now: () => NOW,
    });
    const updateProduct = (index: number) => ({
      productId: `P${String(index).padStart(3, '0')}`,
      expectedProductVersion: 1,
      name: '상품', price: 1, stock: 1, isActive: true, imageUrl: '', category: '', sortOrder: 0,
    });
    await expect(isolated.updateBatch({
      operationId: 'oversized-update', products: Array.from({ length: 101 }, (_, index) => updateProduct(index)),
    })).rejects.toThrow(/at most 100/i);
    await expect(isolated.deactivateBatch({
      operationId: 'oversized-deactivate',
      products: Array.from({ length: 101 }, (_, index) => ({
        productId: `P${String(index).padStart(3, '0')}`, expectedProductVersion: 1,
      })),
    })).rejects.toThrow(/at most 100/i);
    await expect(isolated.updateBatch({
      operationId: 'duplicate-update', products: [updateProduct(1), updateProduct(1)],
    })).rejects.toThrow(/duplicate/i);
    await expect(isolated.deactivateBatch({
      operationId: 'duplicate-deactivate',
      products: [
        { productId: ' P001 ', expectedProductVersion: 1 },
        { productId: 'P001', expectedProductVersion: 1 },
      ],
    })).rejects.toThrow(/duplicate/i);
    expect(transactionSpy).not.toHaveBeenCalled();
    await expect(isolated.updateBatch({
      operationId: 'exact-update-cap',
      products: Array.from({ length: 100 }, (_, index) => updateProduct(index)),
    })).rejects.toThrow(/entered tenant transaction/i);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    transactionSpy.mockClear();
    await expect(isolated.deactivateBatch({
      operationId: 'exact-deactivate-cap',
      products: Array.from({ length: 100 }, (_, index) => ({
        productId: `P${String(index).padStart(3, '0')}`, expectedProductVersion: 1,
      })),
    })).rejects.toThrow(/entered tenant transaction/i);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    transactionSpy.mockClear();
    await expect(isolated.updateBatch({ operationId: 'empty-update', products: [] }))
      .rejects.toThrow(/at least one/i);
    await expect(isolated.deactivateBatch({ operationId: 'empty-deactivate', products: [] }))
      .rejects.toThrow(/at least one/i);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('keeps the outer operation ID authoritative over runtime batch entry fields', async () => {
    await seedProduct({ productId: 'P060', stock: 1 });
    await seedProduct({ productId: 'P061', stock: 1 });
    const updateEntry = {
      operationId: 'malicious-update-entry',
      productId: 'P060', expectedProductVersion: 1, name: '수정', price: 1,
      stock: 2, isActive: true, imageUrl: '', category: '', sortOrder: 0,
    };
    const update = await commands().updateBatch({
      operationId: 'outer-update-operation',
      products: [updateEntry],
    });
    expect(update.operationId).toBe('outer-update-operation');
    expect(update.products[0].inventoryEventId).toBe(
      createProductAdminInventoryEventId('outer-update-operation', 'P060'),
    );
    const deactivateEntry = {
      operationId: 'malicious-deactivate-entry',
      productId: 'P061', expectedProductVersion: 1,
    };
    const deactivated = await commands().deactivateBatch({
      operationId: 'outer-deactivate-operation',
      products: [deactivateEntry],
    });
    expect(deactivated.operationId).toBe('outer-deactivate-operation');
    const state = await snapshot();
    expect((state.operations as Array<{ operation_id: string }>).map((row) => row.operation_id).sort())
      .toEqual(['outer-deactivate-operation', 'outer-update-operation']);
  });

  it('rolls back whole update and deactivate batches when a later product is stale', async () => {
    await seedProduct({ productId: 'P050', stock: 2 });
    await seedProduct({ productId: 'P051', stock: 4, version: 2 });
    const before = await snapshot();
    await expect(commands().updateBatch({
      operationId: 'stale-update-batch',
      products: [
        {
          productId: 'P050', expectedProductVersion: 1, name: '첫째 수정', price: 10,
          stock: 3, isActive: true, imageUrl: '', category: '', sortOrder: 0,
        },
        {
          productId: 'P051', expectedProductVersion: 1, name: '둘째 수정', price: 10,
          stock: 5, isActive: true, imageUrl: '', category: '', sortOrder: 0,
        },
      ],
    })).rejects.toThrow(/stale/i);
    expect(await snapshot()).toEqual(before);
    await expect(commands().deactivateBatch({
      operationId: 'stale-deactivate-batch',
      products: [
        { productId: 'P050', expectedProductVersion: 1 },
        { productId: 'P051', expectedProductVersion: 1 },
      ],
    })).rejects.toThrow(/stale/i);
    expect(await snapshot()).toEqual(before);
  });

  it('allows the same product and operation IDs independently in another tenant', async () => {
    const first = await commands().create(createInput());
    const second = await createDatabaseCatalogCommands({
      tenantId: harness.tenantTwoId,
      runTenantTransaction: harness.runTenantTransaction,
      now: () => new Date(NOW),
    }).create(createInput());

    expect(second).toEqual(first);
    expect((await snapshot(harness.tenantOneId)).products).toHaveLength(1);
    expect((await snapshot(harness.tenantTwoId)).products).toHaveLength(1);
  });
});
