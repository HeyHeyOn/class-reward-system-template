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
