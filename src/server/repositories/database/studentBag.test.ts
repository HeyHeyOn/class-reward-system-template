import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCheckoutVouchers, createCartPricingPreview } from '@/domain/checkout';
import type { CartItem, Product } from '@/domain/types';
import { createCheckoutPayloadHash } from '@/server/checkoutService';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDatabaseCheckoutCommand } from './checkoutCommands';
import { StudentBagError, createStudentBagCommands, giveHarvestReward, readRewardProduct } from './studentBag';
import { TransactionCancellationError, createDatabaseTransactionCommands } from './transactionCommands';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-10-09T03:00:00.000Z');
const products: Product[] = [
  { productId: 'P001', name: '연필', price: 300, stock: 20, isActive: true, sortOrder: 1 },
  { productId: 'P002', name: '자리 바꾸기권', price: 500, stock: 5, isActive: true, sortOrder: 2 },
  { productId: 'P003', name: '공책', price: 400, stock: 5, isActive: true, sortOrder: 3 },
  { productId: 'P004', name: '칭찬 배지', price: 100, stock: 5, isActive: true, sortOrder: 4 },
  { productId: 'P005', name: '초코 과자', price: 400, stock: 9, isActive: true, sortOrder: 5 },
];
let harness: PgliteDatabaseHarness;
let sequence = 0;
const op = () => `60000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const file of ['0044_class_tree.sql', '0045_student_bag.sql', '0046_vouchers.sql', '0047_tree_name.sql']) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', file), 'utf8'));
  }
  await harness.database.exec('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime');
  await harness.database.exec('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime');
  await harness.database.query(`INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, 'S001', '김민준', 'ACTIVE')`, [harness.tenantOneId]);
  await harness.database.query(`INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1, 'S001', 5000)`, [harness.tenantOneId]);
  await harness.database.query(`INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, 'S002', '이서연', 'ACTIVE')`, [harness.tenantOneId]);
  await harness.database.query(`INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1, 'S002', 0)`, [harness.tenantOneId]);
  for (const product of products) {
    await harness.database.query(`INSERT INTO products (tenant_id, product_id, name, price, stock, is_active, sort_order) VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [harness.tenantOneId, product.productId, product.name, product.price, product.stock, product.sortOrder]);
  }
});

afterEach(async () => harness?.close());

const bag = () => createStudentBagCommands({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction });
const usable = async () => (await bag().studentBag('S001', { includeUsed: false })).items;

/** 소모품 P002 (the teacher marks it used) and 수집품 P004; the others stay physical. */
async function markDigital() {
  await bag().setDigitalProduct({ productId: 'P002', digital: { kind: 'CONSUMABLE', description: '' } });
  return bag().setDigitalProduct({ productId: 'P004', digital: { kind: 'COLLECTIBLE', description: ' 1학기 칭찬 배지 ' } });
}

const give = (studentIds: string[], productId: string, count: number, operationId = op()) => bag().giveItems({ studentIds, productId, count, operationId });

async function checkout(operationId: string, items: CartItem[], voucherItemIds: string[] = [], vouchers: Record<string, number> = {}) {
  const priced = createCartPricingPreview({ products, cartItems: items, now: NOW });
  if (!priced.ok) throw new Error('fixture');
  const expected = Object.keys(vouchers).length > 0 ? applyCheckoutVouchers(priced, vouchers) : priced;
  if (!expected.ok) throw new Error('fixture');
  const base = { operationId, studentId: 'S001', items, expectedPricing: expected, operator: 'kiosk', ...(voucherItemIds.length > 0 ? { voucherItemIds } : {}) };
  return createDatabaseCheckoutCommand({ tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction, now: () => NOW })
    .execute({ ...base, payloadHash: createCheckoutPayloadHash(base) });
}

const cancel = (transactionId: string, operationId: string) => createDatabaseTransactionCommands({
  tenantId: harness.tenantOneId, runTenantTransaction: harness.runTenantTransaction, now: () => new Date(),
}).cancel({ transactionId, operationId });

async function balance(): Promise<number> {
  const result = await harness.database.query<{ balance: string }>(`SELECT balance::text AS balance FROM accounts WHERE tenant_id=$1 AND student_id='S001'`, [harness.tenantOneId]);
  return Number(result.rows[0].balance);
}

describe('digital products', () => {
  it('keeps each product type and makes a product physical again; a digital product never pays for another', async () => {
    expect(await markDigital()).toEqual([
      { productId: 'P002', kind: 'CONSUMABLE', description: '' },
      { productId: 'P004', kind: 'COLLECTIBLE', description: '1학기 칭찬 배지' },
    ]);
    const refused = (digital: unknown, productId = 'P001') => bag().setDigitalProduct({ productId, digital }).catch((error: StudentBagError) => error.code);
    expect(await refused({ kind: 'COUPON', description: '' })).toBe('INVALID_INPUT');
    expect(await refused({ kind: 'CONSUMABLE', description: 'x'.repeat(501) })).toBe('INVALID_INPUT');
    expect(await refused({ kind: 'CONSUMABLE', description: '' }, 'NOPE')).toBe('PRODUCT_NOT_FOUND');
    // An old screen sending a product to exchange is ignored: 교환권 are not sold.
    await bag().setDigitalProduct({ productId: 'P003', digital: { kind: 'CONSUMABLE', voucherProductId: 'P005', description: '' } });
    const row = await harness.database.query(`SELECT voucher_product_id FROM coupon_products WHERE tenant_id=$1 AND product_id='P003'`, [harness.tenantOneId]);
    expect(row.rows).toEqual([{ voucher_product_id: null }]);
    expect((await bag().setDigitalProduct({ productId: 'P004', digital: null })).map((product) => product.productId)).toEqual(['P002', 'P003']);
  });

  it('puts one item per unit bought into the storage with its type, and nothing for a physical product', async () => {
    await markDigital();
    const result = await checkout(op(), [{ productId: 'P001', quantity: 1 }, { productId: 'P002', quantity: 2 }, { productId: 'P004', quantity: 1 }]);
    expect(result.ok).toBe(true);
    const items = await usable();
    expect(items.map((item) => [item.title, item.kind, item.source, item.voucherProductId]).sort()).toEqual([
      ['자리 바꾸기권', 'CONSUMABLE', 'STORE_PURCHASE', null],
      ['자리 바꾸기권', 'CONSUMABLE', 'STORE_PURCHASE', null],
      ['칭찬 배지', 'COLLECTIBLE', 'STORE_PURCHASE', null],
    ]);
    expect(items.find((item) => item.kind === 'COLLECTIBLE')).toMatchObject({ description: '1학기 칭찬 배지' });
  });

  it('lets the teacher mark any 소모품 used but never a 수집품', async () => {
    await markDigital();
    await checkout(op(), [{ productId: 'P002', quantity: 1 }, { productId: 'P004', quantity: 1 }]);
    await give(['S001'], 'P005', 1);
    const items = await usable();
    const of = (productId: string) => items.find((item) => item.productId === productId)!.itemId;
    expect((await bag().setItemUsed({ itemId: of('P002'), used: true })).usedAt).not.toBeNull();
    expect((await bag().setItemUsed({ itemId: of('P005'), used: true })).usedAt).not.toBeNull();
    await expect(bag().setItemUsed({ itemId: of('P004'), used: true })).rejects.toMatchObject({ code: 'NOT_CONSUMABLE' });
    expect((await usable()).map((item) => item.kind)).toEqual(['COLLECTIBLE']);
    expect((await bag().studentBag('S001', { includeUsed: true })).items).toHaveLength(3);
    // A 교환권 marked used by the teacher is not offered at the kiosk any more.
    expect(await bag().checkoutVouchers('S001', ['P005'])).toEqual([]);
  });

  it('reads a coupon row written by the app from before 0046 as a 소모품', async () => {
    await harness.database.query(`INSERT INTO student_items (tenant_id, item_id, student_id, kind, title, source, source_ref, operation_id)
      VALUES ($1, 'legacy-1', 'S001', 'COUPON', '자리 바꾸기권', 'TREE_HARVEST', '1', 'op-legacy')`, [harness.tenantOneId]);
    expect(await usable()).toEqual([expect.objectContaining({ itemId: 'legacy-1', kind: 'CONSUMABLE', voucherProductId: null })]);
    expect((await bag().setItemUsed({ itemId: 'legacy-1', used: true })).usedAt).not.toBeNull();
  });
});

describe('teacher gives and takes back', () => {
  it('gives a digital product as itself and a physical one as its 교환권, once per operation', async () => {
    await markDigital();
    const operationId = op();
    expect(await give(['S001'], 'P004', 3, operationId)).toBe(3);
    expect(await give(['S001'], 'P004', 3, operationId)).toBe(0);
    expect(await usable()).toEqual(Array(3).fill(expect.objectContaining({ kind: 'COLLECTIBLE', source: 'TEACHER', title: '칭찬 배지' })));
    expect(await give(['S001'], 'P005', 1)).toBe(1);
    expect((await usable()).find((item) => item.productId === 'P005')).toMatchObject({
      kind: 'CONSUMABLE', title: '초코 과자 교환권', voucherProductId: 'P005', voucherProductName: '초코 과자', source: 'TEACHER',
    });
    expect((await bag().checkoutVouchers('S001', ['P005'])).map((voucher) => voucher.title)).toEqual(['초코 과자 교환권']);
    await expect(give(['S001'], 'P004', 21)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(give([], 'P004', 1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(give(['S001'], 'NOPE', 1)).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });

  it('gives to several students at once, all or none', async () => {
    const operationId = op();
    expect(await give(['S001', 'S002', 'S001'], 'P005', 2, operationId)).toBe(4);
    expect(await give(['S002', 'S001'], 'P005', 2, operationId)).toBe(0);
    for (const studentId of ['S001', 'S002']) {
      expect((await bag().studentBag(studentId, { includeUsed: false })).items).toHaveLength(2);
    }
    await expect(give(['S001', 'S999'], 'P005', 1)).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
    expect((await bag().studentBag('S001', { includeUsed: false })).items).toHaveLength(2);
  });

  it('takes back an unused item but not a used one', async () => {
    await markDigital();
    await give(['S001'], 'P002', 2);
    const [first, second] = await usable();
    await bag().revokeItem({ itemId: first.itemId });
    expect((await usable()).map((item) => item.itemId)).toEqual([second.itemId]);
    await expect(bag().revokeItem({ itemId: first.itemId })).rejects.toMatchObject({ code: 'ITEM_REVOKED' });
    await bag().setItemUsed({ itemId: second.itemId, used: true });
    await expect(bag().revokeItem({ itemId: second.itemId })).rejects.toMatchObject({ code: 'ITEM_USED' });
  });
});

describe('교환권 at the store checkout', () => {
  async function rewardVouchers(count: number) {
    await harness.runTenantTransaction(harness.tenantOneId, async (tx) => {
      const product = await readRewardProduct(tx, harness.tenantOneId, 'P005');
      if (!product) throw new Error('fixture');
      for (let n = 0; n < count; n++) await giveHarvestReward(tx, harness.tenantOneId, { studentId: 'S001', product, treeNo: n + 1, operationId: op() });
    });
    return (await usable()).map((item) => item.itemId);
  }

  it('lists the 교환권 for the cart, pays one unit each, and refuses one already used', async () => {
    const [first, second] = await rewardVouchers(2);
    // Oldest first at the kiosk (the storage lists newest first).
    expect((await bag().checkoutVouchers('S001', ['P005', 'P001'])).map((voucher) => voucher.itemId)).toEqual([second, first]);
    expect(await bag().checkoutVouchers('S001', ['P001'])).toEqual([]);

    const operationId = op();
    const paid = await checkout(operationId, [{ productId: 'P005', quantity: 3 }], [first, second], { P005: 2 });
    expect(paid).toMatchObject({ ok: true, totalAmount: 400, balanceBefore: 5000, balanceAfter: 4600 });
    if (!paid.ok) throw new Error('checkout failed');
    expect(paid.items[0]).toMatchObject({ finalTotal: 400, totalDiscount: 800, adjustments: [{ type: 'VOUCHER', voucherCount: 2, discountAmount: 800 }] });
    expect(await checkout(operationId, [{ productId: 'P005', quantity: 3 }], [first, second], { P005: 2 })).toEqual(paid);
    expect(await usable()).toEqual([]);
    await expect(bag().setItemUsed({ itemId: first, used: false })).rejects.toMatchObject({ code: 'USED_AT_CHECKOUT' });
    expect(await checkout(op(), [{ productId: 'P005', quantity: 1 }], [first], { P005: 1 })).toMatchObject({ ok: false, code: 'VOUCHER_UNAVAILABLE' });
    expect(await balance()).toBe(4600);
  });

  it('refuses more 교환권 than units in the cart and a price quote without them', async () => {
    const [first, second] = await rewardVouchers(2);
    expect(await checkout(op(), [{ productId: 'P005', quantity: 1 }], [first, second], {})).toMatchObject({ ok: false, code: 'INVALID_VOUCHERS' });
    expect(await checkout(op(), [{ productId: 'P005', quantity: 1 }], [first], {})).toMatchObject({ ok: false, code: 'PRICE_CHANGED' });
    expect(await usable()).toHaveLength(2);
  });

  it('gives the 교환권 back when the checkout is cancelled', async () => {
    const [first] = await rewardVouchers(1);
    const paid = await checkout(op(), [{ productId: 'P005', quantity: 1 }, { productId: 'P001', quantity: 1 }], [first], { P005: 1 });
    expect(paid).toMatchObject({ ok: true, totalAmount: 300 });
    if (!paid.ok) throw new Error('checkout failed');
    await cancel(paid.transactionId, op());
    expect(await balance()).toBe(5000);
    expect(await usable()).toEqual([expect.objectContaining({ itemId: first, usedAt: null, usedAtCheckout: false })]);
  });
});

describe('cancelling a purchase', () => {
  it('takes back unused items and refuses once one is used', async () => {
    await markDigital();
    const first = await checkout(op(), [{ productId: 'P002', quantity: 1 }]);
    const second = await checkout(op(), [{ productId: 'P002', quantity: 1 }]);
    if (!first.ok || !second.ok) throw new Error('checkout failed');
    const firstItem = (await usable()).find((item) => item.itemId.includes(first.transactionId));
    if (!firstItem) throw new Error('missing item');
    await bag().setItemUsed({ itemId: firstItem.itemId, used: true });
    const refusedOperation = op();
    await expect(cancel(first.transactionId, refusedOperation)).rejects.toMatchObject({ code: 'COUPON_ALREADY_USED' });
    await expect(cancel(first.transactionId, refusedOperation)).rejects.toBeInstanceOf(TransactionCancellationError);

    await cancel(second.transactionId, op());
    expect((await bag().studentBag('S001', { includeUsed: true })).items.map((item) => item.itemId)).toEqual([firstItem.itemId]);
    await bag().setItemUsed({ itemId: firstItem.itemId, used: false });
    await cancel(first.transactionId, op());
    expect(await usable()).toHaveLength(0);
    await expect(bag().setItemUsed({ itemId: firstItem.itemId, used: true })).rejects.toMatchObject({ code: 'ITEM_REVOKED' });
  });

  it('keeps each class to its own storage', async () => {
    await markDigital();
    await checkout(op(), [{ productId: 'P002', quantity: 1 }]);
    const other = createStudentBagCommands({ tenantId: harness.tenantTwoId, runTenantTransaction: harness.runTenantTransaction });
    await expect(other.studentBag('S001', { includeUsed: true })).rejects.toMatchObject({ code: 'STUDENT_NOT_FOUND' });
    expect(await other.digitalProducts()).toEqual([]);
    expect(await other.checkoutVouchers('S001', ['P005'])).toEqual([]);
  });
});
