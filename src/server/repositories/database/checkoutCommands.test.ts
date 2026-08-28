import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCartPricingPreview } from '@/domain/checkout';
import type { CartItem, Product, Promotion } from '@/domain/types';
import { createCheckoutPayloadHash } from '@/server/checkoutService';
import {
  createDatabaseCheckoutCommand,
  type DatabaseCheckoutCommandDependencies,
} from '@/server/repositories/database/checkoutCommands';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-15T00:00:00.000Z');
const STUDENT_ID = 'S001';
const products: Product[] = [
  { productId: 'P001', name: '연필', price: 300, stock: 20, isActive: true, sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 15, isActive: true, sortOrder: 2 },
];

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedCheckoutState();
});

afterEach(async () => {
  await harness?.close();
});

function expectedPricing(items: CartItem[], sourceProducts = products) {
  const result = createCartPricingPreview({ products: sourceProducts, cartItems: items, now: NOW });
  if (!result.ok) throw new Error(`invalid fixture: ${result.code}`);
  return result;
}

function input(operationId: string, items: CartItem[] = [{ productId: 'P001', quantity: 2 }]) {
  const expected = expectedPricing(items);
  const checkout = { operationId, studentId: STUDENT_ID, items, expectedPricing: expected, operator: 'kiosk' };
  return { ...checkout, payloadHash: createCheckoutPayloadHash(checkout) };
}

function command(overrides: Partial<DatabaseCheckoutCommandDependencies> = {}) {
  return createDatabaseCheckoutCommand({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => NOW,
    ...overrides,
  });
}

async function seedCheckoutState(options: { balance?: number; stock?: number; active?: boolean } = {}) {
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status)
     VALUES ($1, $2, '김민준', 'ACTIVE')`,
    [harness.tenantOneId, STUDENT_ID],
  );
  await harness.database.query(
    `INSERT INTO accounts (tenant_id, student_id, balance)
     VALUES ($1, $2, $3)`,
    [harness.tenantOneId, STUDENT_ID, options.balance ?? 3500],
  );
  for (const product of products) {
    await harness.database.query(
      `INSERT INTO products
         (tenant_id, product_id, name, price, stock, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        harness.tenantOneId,
        product.productId,
        product.name,
        product.price,
        product.productId === 'P001' ? options.stock ?? product.stock : product.stock,
        options.active ?? product.isActive,
        product.sortOrder,
      ],
    );
  }
}

async function snapshot() {
  const [account, productRows, transactionRows, itemRows, ledgerRows, operationRows] = await Promise.all([
    harness.database.query<{ balance: string; version: string }>(
      `SELECT balance::text, version::text FROM accounts WHERE tenant_id=$1 AND student_id=$2`,
      [harness.tenantOneId, STUDENT_ID],
    ),
    harness.database.query<{ product_id: string; stock: string }>(
      `SELECT product_id, stock::text FROM products WHERE tenant_id=$1 ORDER BY product_id`,
      [harness.tenantOneId],
    ),
    harness.database.query(
      `SELECT transaction_id, kind, legacy_total_amount::text, balance_delta::text,
              operation_id, operation_hash
       FROM transactions WHERE tenant_id=$1`,
      [harness.tenantOneId],
    ),
    harness.database.query<{
      product_id_snapshot: string;
      quantity: string;
      total_quantity: string;
      regular_total: string;
      final_total: string;
    }>(
      `SELECT product_id_snapshot, quantity::text, total_quantity::text,
              regular_total::text, final_total::text
       FROM transaction_items WHERE tenant_id=$1 ORDER BY line_number`,
      [harness.tenantOneId],
    ),
    harness.database.query<{
      product_id: string;
      transaction_id: string;
      quantity_delta: string;
      stock_before: string;
      stock_after: string;
      operation_id: string | null;
      operation_hash: string | null;
    }>(
      `SELECT product_id, transaction_id, quantity_delta::text, stock_before::text,
              stock_after::text, operation_id, operation_hash
       FROM inventory_ledger WHERE tenant_id=$1 ORDER BY product_id`,
      [harness.tenantOneId],
    ),
    harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1`, [harness.tenantOneId]),
  ]);
  return {
    account: account.rows,
    products: productRows.rows,
    transactions: transactionRows.rows,
    items: itemRows.rows,
    ledger: ledgerRows.rows,
    operations: operationRows.rows,
  };
}

describe('database checkout command', () => {
  it('atomically updates balance and stock and inserts immutable checkout snapshots', async () => {
    const result = await command().execute(input('checkout-op-001', [
      { productId: 'P002', quantity: 1 },
      { productId: 'P001', quantity: 2 },
    ]));

    expect(result).toMatchObject({
      ok: true,
      studentId: STUDENT_ID,
      studentName: '김민준',
      totalAmount: 1100,
      balanceBefore: 3500,
      balanceAfter: 2400,
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.transactionId).toMatch(/^checkout:[0-9a-f]{64}$/);

    const state = await snapshot();
    expect(state.account).toEqual([{ balance: '2400', version: '2' }]);
    expect(state.products).toEqual([
      { product_id: 'P001', stock: '18' },
      { product_id: 'P002', stock: '14' },
    ]);
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({
      transaction_id: result.transactionId,
      kind: 'CHECKOUT',
      legacy_total_amount: '1100',
      balance_delta: '-1100',
      operation_id: 'checkout-op-001',
      operation_hash: input('checkout-op-001', [
        { productId: 'P002', quantity: 1 },
        { productId: 'P001', quantity: 2 },
      ]).payloadHash,
    });
    expect(state.items).toHaveLength(2);
    expect(state.items.map((row) => ({
      product: row.product_id_snapshot,
      quantity: row.quantity,
      totalQuantity: row.total_quantity,
      regularTotal: row.regular_total,
      finalTotal: row.final_total,
    }))).toEqual([
      { product: 'P002', quantity: '1', totalQuantity: '1', regularTotal: '500', finalTotal: '500' },
      { product: 'P001', quantity: '2', totalQuantity: '2', regularTotal: '600', finalTotal: '600' },
    ]);
    expect(state.ledger).toHaveLength(2);
    expect(state.ledger.map((row) => ({
      product: row.product_id,
      transaction: row.transaction_id,
      delta: row.quantity_delta,
      before: row.stock_before,
      after: row.stock_after,
      operationId: row.operation_id,
      operationHash: row.operation_hash,
    }))).toEqual([
      { product: 'P001', transaction: result.transactionId, delta: '-2', before: '20', after: '18', operationId: null, operationHash: null },
      { product: 'P002', transaction: result.transactionId, delta: '-1', before: '15', after: '14', operationId: null, operationHash: null },
    ]);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]).toMatchObject({
      operation_id: 'checkout-op-001',
      operation_kind: 'CHECKOUT',
      status: 'SUCCEEDED',
      result_snapshot: result,
    });
  });

  it.each([
    { studentId: ' S001 ', operator: ' admin ', expectedOperator: 'admin' },
    { studentId: 'S001', operator: '', expectedOperator: 'kiosk' },
  ])('uses canonical student/operator values for execution and audit snapshots', async ({ studentId, operator, expectedOperator }) => {
    const base = {
      operationId: `checkout-op-canonical-${expectedOperator}`,
      studentId,
      items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: expectedPricing([{ productId: 'P001', quantity: 1 }]),
      operator,
    };

    const result = await command().execute({ ...base, payloadHash: createCheckoutPayloadHash(base) });

    expect(result).toMatchObject({ ok: true, studentId: STUDENT_ID });
    const audit = await harness.database.query<{ student_id: string; operator_snapshot: string }>(
      `SELECT student_id, operator_snapshot FROM transactions WHERE tenant_id=$1`,
      [harness.tenantOneId],
    );
    expect(audit.rows).toEqual([{ student_id: STUDENT_ID, operator_snapshot: expectedOperator }]);
  });

  it('aggregates duplicate cart lines deterministically before locking and mutation', async () => {
    const checkoutInput = input('checkout-op-duplicate', [
      { productId: 'P001', quantity: 1 },
      { productId: 'P001', quantity: 2 },
    ]);
    const result = await command().execute(checkoutInput);

    expect(result).toMatchObject({ ok: true, totalAmount: 900, items: [{ productId: 'P001', totalQuantity: 3 }] });
    const state = await snapshot();
    expect(state.products[0]).toEqual({ product_id: 'P001', stock: '17' });
    expect(state.items).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
  });

  it('returns the exact stored result for an idempotent retry without double mutation', async () => {
    const checkoutInput = input('checkout-op-retry');
    const first = await command().execute(checkoutInput);
    const second = await command().execute(checkoutInput);

    expect(first).toEqual(second);
    const state = await snapshot();
    expect(state.account).toEqual([{ balance: '2900', version: '2' }]);
    expect(state.products[0]).toEqual({ product_id: 'P001', stock: '18' });
    expect(state.transactions).toHaveLength(1);
    expect(state.items).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
  });

  it('rejects a malformed stored success snapshot as an integrity error', async () => {
    const checkoutInput = input('checkout-op-malformed-result');
    await harness.database.query(
      `INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status,
         result_snapshot, started_at, finished_at, created_at, updated_at)
       VALUES ($1, $2, 'CHECKOUT', $3, 'SUCCEEDED', $4::jsonb, $5, $5, $5, $5)`,
      [harness.tenantOneId, checkoutInput.operationId, checkoutInput.payloadHash, JSON.stringify({ ok: true }), NOW],
    );

    await expect(command().execute(checkoutInput)).rejects.toThrow('Stored checkout result is invalid.');
    expect((await snapshot()).transactions).toHaveLength(0);
  });

  it.each([
    { kind: 'CHECKOUT', expectedCode: 'OPERATION_PENDING' },
    { kind: 'TASK_REWARD', expectedCode: 'OPERATION_CONFLICT' },
  ])('fails closed for a pre-existing $kind operation claim', async ({ kind, expectedCode }) => {
    const checkoutInput = input(`checkout-op-existing-${kind.toLowerCase()}`);
    await harness.database.query(
      `INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $5, $5)`,
      [harness.tenantOneId, checkoutInput.operationId, kind, checkoutInput.payloadHash, NOW],
    );

    const result = await command().execute(checkoutInput);

    expect(result).toMatchObject({ ok: false, code: expectedCode });
    const state = await snapshot();
    expect(state.transactions).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
    expect(state.operations).toHaveLength(1);
  });

  it('fails closed when an operation ID is reused for a different payload', async () => {
    await command().execute(input('checkout-op-conflict', [{ productId: 'P001', quantity: 1 }]));
    const conflict = await command().execute(input('checkout-op-conflict', [{ productId: 'P002', quantity: 1 }]));

    expect(conflict).toEqual({
      ok: false,
      code: 'OPERATION_CONFLICT',
      message: '동일한 작업 ID가 다른 결제 요청에 사용되었습니다.',
    });
    const state = await snapshot();
    expect(state.account).toEqual([{ balance: '3200', version: '2' }]);
    expect(state.products).toEqual([
      { product_id: 'P001', stock: '19' },
      { product_id: 'P002', stock: '15' },
    ]);
    expect(state.transactions).toHaveLength(1);
  });

  it('rejects unsafe bigint values returned by the database adapter', async () => {
    const checkoutInput = input('checkout-op-unsafe-bigint');
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ operation_id: checkoutInput.operationId }] })
      .mockResolvedValueOnce({ rows: [{
        operation_kind: 'CHECKOUT', payload_hash: checkoutInput.payloadHash,
        status: 'PENDING', result_snapshot: null, failure_code: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        student_id: STUDENT_ID, name: '김민준', status: 'ACTIVE',
        balance: '9007199254740992',
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const runTenantTransaction: DatabaseCheckoutCommandDependencies['runTenantTransaction'] = async (
      _tenantId,
      callback,
    ) => callback({ execute } as never);

    await expect(command({ runTenantTransaction }).execute(checkoutInput))
      .rejects.toThrow('Unsafe integer for account balance.');
  });

  it.each([
    { label: 'blank operation ID', mutate: (value: ReturnType<typeof input>) => ({ ...value, operationId: '  ' }) },
    { label: 'noncanonical hash', mutate: (value: ReturnType<typeof input>) => ({ ...value, payloadHash: 'A'.repeat(64) }) },
    { label: 'caller-forged hash', mutate: (value: ReturnType<typeof input>) => ({ ...value, payloadHash: '0'.repeat(64) }) },
  ])('rejects $label before acquiring transactional authority', async ({ mutate }) => {
    const transactionCalls = vi.fn();
    const runTenantTransaction: DatabaseCheckoutCommandDependencies['runTenantTransaction'] = async (
      tenantId,
      callback,
    ) => {
      transactionCalls();
      return harness.runTenantTransaction(tenantId, callback);
    };
    const result = command({ runTenantTransaction }).execute(mutate(input('checkout-op-invalid')));
    await expect(result).rejects.toThrow(/operation id|payload hash/i);
    expect(transactionCalls).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing student', studentId: 'MISSING', expectedCode: 'STUDENT_NOT_FOUND' },
    { name: 'inactive student', studentId: STUDENT_ID, expectedCode: 'STUDENT_INACTIVE', inactiveStudent: true },
    { name: 'missing product', items: [{ productId: 'MISSING', quantity: 1 }], expectedCode: 'PRODUCT_NOT_FOUND' },
    { name: 'inactive product', items: [{ productId: 'P001', quantity: 1 }], expectedCode: 'PRODUCT_INACTIVE', inactiveProduct: true },
  ])('rolls back the operation claim for $name', async ({
    studentId = STUDENT_ID,
    items = [{ productId: 'P001', quantity: 1 }],
    expectedCode,
    inactiveStudent,
    inactiveProduct,
  }) => {
    if (inactiveStudent) {
      await harness.database.query(`UPDATE students SET status='INACTIVE' WHERE tenant_id=$1 AND student_id=$2`, [harness.tenantOneId, STUDENT_ID]);
    }
    if (inactiveProduct) {
      await harness.database.query(`UPDATE products SET is_active=false WHERE tenant_id=$1 AND product_id='P001'`, [harness.tenantOneId]);
    }
    const expected = items[0].productId === 'MISSING'
      ? { ok: true as const, totalAmount: 1, items: [{ ...expectedPricing([{ productId: 'P001', quantity: 1 }]).items[0], productId: 'MISSING' }] }
      : expectedPricing(items);
    const base = { operationId: `checkout-op-${expectedCode}`, studentId, items, expectedPricing: expected, operator: 'kiosk' };
    const result = await command().execute({ ...base, payloadHash: createCheckoutPayloadHash(base) });

    expect(result).toMatchObject({ ok: false, code: expectedCode });
    expect((await snapshot()).operations).toHaveLength(0);
  });

  it('loads only linked active promotions and preserves R2 snapshot ordering', async () => {
    const startsAt = '2026-01-01T00:00:00.000Z';
    const endsAt = '2027-01-01T00:00:00.000Z';
    await harness.database.query(
      `INSERT INTO promotions
        (tenant_id, promotion_id, name, description, type,
         n_plus_one_buy_quantity, n_plus_one_free_quantity, percent_discount,
         starts_at, ends_at, is_active, sort_order, schema_version, created_at, updated_at)
       VALUES
        ($1, 'N21', '2+1', '', 'N_PLUS_ONE', 2, 1, NULL, $2, $3, true, 1, 3, $2, $2),
        ($1, 'P10', '10% 할인', '', 'PERCENT_DISCOUNT', NULL, NULL, 10, $2, $3, true, 2, 3, $2, $2),
        ($1, 'OTHER', '다른 상품 할인', '', 'PERCENT_DISCOUNT', NULL, NULL, 50, $2, $3, true, 0, 3, $2, $2)`,
      [harness.tenantOneId, startsAt, endsAt],
    );
    await harness.database.query(
      `INSERT INTO promotion_products
        (tenant_id, promotion_product_id, promotion_id, product_id)
       VALUES
        ($1, 'LINK-N21', 'N21', 'P001'),
        ($1, 'LINK-P10', 'P10', 'P001'),
        ($1, 'LINK-OTHER', 'OTHER', 'P002')`,
      [harness.tenantOneId],
    );
    const base = {
      description: '', productIds: ['P001'], startsAt, endsAt, isActive: true,
      createdAt: startsAt, updatedAt: startsAt, schemaVersion: 3,
    };
    const expectedPromotions: Promotion[] = [
      { ...base, promotionId: 'N21', name: '2+1', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1, sortOrder: 1 },
      { ...base, promotionId: 'P10', name: '10% 할인', type: 'PERCENT_DISCOUNT', percent: 10, sortOrder: 2 },
    ];
    const items = [{ productId: 'P001', quantity: 3 }];
    const expected = createCartPricingPreview({ products, cartItems: items, promotions: expectedPromotions, now: NOW });
    if (!expected.ok) throw new Error('invalid promotion fixture');
    const checkout = { operationId: 'checkout-op-promotions', studentId: STUDENT_ID, items, expectedPricing: expected, operator: 'kiosk' };

    const result = await command().execute({ ...checkout, payloadHash: createCheckoutPayloadHash(checkout) });

    expect(result).toMatchObject({
      ok: true,
      totalAmount: 540,
      items: [{
        productId: 'P001', totalQuantity: 3, paidQuantity: 2, freeQuantity: 1,
        finalTotal: 540,
        adjustments: [{ type: 'N_PLUS_ONE' }, { type: 'PERCENT_DISCOUNT' }],
        appliedPromotions: [{ promotionId: 'N21' }, { promotionId: 'P10' }],
      }],
    });
  });

  it('rejects authoritative pricing drift and leaves every resource unchanged', async () => {
    const checkoutInput = input('checkout-op-drift', [{ productId: 'P001', quantity: 1 }]);
    await harness.database.query(`UPDATE products SET price=350 WHERE tenant_id=$1 AND product_id='P001'`, [harness.tenantOneId]);
    const before = await snapshot();

    const result = await command().execute(checkoutInput);

    expect(result).toMatchObject({ ok: false, code: 'PRICE_CHANGED', latestPricing: { totalAmount: 350 } });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { label: 'stock', balance: 3500, stock: 1, code: 'INSUFFICIENT_STOCK' },
    { label: 'balance', balance: 500, stock: 20, code: 'INSUFFICIENT_BALANCE' },
  ])('does not persist partial state for insufficient $label', async ({ label, balance, stock, code }) => {
    await harness.database.query(`UPDATE accounts SET balance=$3 WHERE tenant_id=$1 AND student_id=$2`, [harness.tenantOneId, STUDENT_ID, balance]);
    await harness.database.query(`UPDATE products SET stock=$2 WHERE tenant_id=$1 AND product_id='P001'`, [harness.tenantOneId, stock]);
    const before = await snapshot();

    const result = await command().execute(input(`checkout-op-insufficient-${label}`));

    expect(result).toMatchObject({ ok: false, code });
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back account, product, operation, transaction, items, and ledger after a post-update failure', async () => {
    const before = await snapshot();
    const injected = new Error('injected failure after resource updates');

    await expect(command({ afterResourceUpdates: async () => { throw injected; } }).execute(input('checkout-op-rollback')))
      .rejects.toBe(injected);

    expect(await snapshot()).toEqual(before);
  });

  it('uses a serialized PGlite fallback to prevent stock consumption after a committed checkout', async () => {
    // This harness shares one in-process PGlite connection. Promise.all interleaves one
    // transaction state instead of modeling independent PostgreSQL sessions/row locks.
    // PostgreSQL lock shape is asserted separately below; this is the behavioral fallback.
    await harness.database.query(`UPDATE products SET stock=1 WHERE tenant_id=$1 AND product_id='P001'`, [harness.tenantOneId]);
    const one = input('checkout-op-race-one', [{ productId: 'P001', quantity: 1 }]);
    const two = input('checkout-op-race-two', [{ productId: 'P001', quantity: 1 }]);

    const results = [await command().execute(one), await command().execute(two)];

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }),
    ]);
    const state = await snapshot();
    expect(state.products[0]).toEqual({ product_id: 'P001', stock: '0' });
    expect(state.account).toEqual([{ balance: '3200', version: '2' }]);
    expect(state.transactions).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
  });

  it('uses account and stable product row locks required for PostgreSQL race serialization', async () => {
    const source = await readFile(resolve(
      process.cwd(),
      'src/server/repositories/database/checkoutCommands.ts',
    ), 'utf8');

    expect(source).toMatch(/FOR UPDATE OF s, a/);
    expect(source).toMatch(/ORDER BY product_id\s+FOR UPDATE/);
    expect(source).toMatch(/FROM operations[\s\S]*operation_id=[\s\S]*FOR UPDATE/);
  });

  it('uses a serialized PGlite fallback for exact shared-operation replay', async () => {
    const checkoutInput = input('checkout-op-concurrent-retry');
    const first = await command().execute(checkoutInput);
    const second = await command().execute(checkoutInput);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    const state = await snapshot();
    expect(state.transactions).toHaveLength(1);
    expect(state.items).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.operations).toHaveLength(1);
  });
});
