import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseTransactionQueries,
  type DatabaseTransactionQueryDependencies,
} from '@/server/repositories/database/transactionQueries';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import { getTransactions as getSheetTransactions, type SheetsReader } from '@/server/sheetsRepository';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;

const STUDENT_ID = 'S1';
const BASE_ID = 'BASE';
const EXTENDED_ID = 'EXTENDED';
const ADMIN_ID = 'ADMIN';
const REVERSAL_ID = 'REVERSAL';
const TIED_ID = 'TIED';
const OTHER_TENANT_ONLY_ID = 'OTHER-ONLY';

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedStudent(harness.tenantOneId, STUDENT_ID, '김학생');
  await seedStudent(harness.tenantTwoId, STUDENT_ID, '다른 반 학생');

  await seedTransaction(harness.tenantOneId, {
    transactionId: BASE_ID,
    occurredAt: '2026-08-29T01:00:00.000Z',
    kind: 'CHECKOUT', totalAmount: 700, balanceDelta: -700,
    balanceBefore: 2000, balanceAfter: 1300, operator: 'kiosk', status: 'COMPLETED',
  });
  await seedBaseItem(harness.tenantOneId, BASE_ID, 2, 'P2', '지우개', 1, 500, 500);
  await seedBaseItem(harness.tenantOneId, BASE_ID, 1, 'P1', '연필', 2, 100, 200);

  await seedTransaction(harness.tenantOneId, {
    transactionId: EXTENDED_ID,
    occurredAt: '2026-08-29T02:00:00.000Z',
    kind: 'CHECKOUT', totalAmount: 600, balanceDelta: -600,
    balanceBefore: 1300, balanceAfter: 700, operator: 'teacher', status: 'COMPLETED',
  });
  await seedExtendedItem(harness.tenantOneId, EXTENDED_ID);

  await seedTransaction(harness.tenantOneId, {
    transactionId: ADMIN_ID,
    occurredAt: '2026-08-29T03:00:00.000Z',
    kind: 'ADMIN_ADJUSTMENT', totalAmount: -300, balanceDelta: 300,
    balanceBefore: 700, balanceAfter: 1000, operator: 'admin', status: 'ADMIN_ADJUSTMENT',
  });
  await seedTransaction(harness.tenantOneId, {
    transactionId: TIED_ID,
    occurredAt: '2026-08-29T03:00:00.000Z',
    kind: 'TASK_REWARD', totalAmount: 50, balanceDelta: 50,
    balanceBefore: 1000, balanceAfter: 1050, operator: 'task', status: 'TASK_REWARD',
  });
  await seedTransaction(harness.tenantOneId, {
    transactionId: REVERSAL_ID,
    occurredAt: '2026-08-29T04:00:00.000Z',
    kind: 'CANCELLATION', totalAmount: -700, balanceDelta: 700,
    balanceBefore: 1050, balanceAfter: 1750, operator: `cancel:${BASE_ID}`,
    status: 'CANCEL_REVERSAL', reversesTransactionId: BASE_ID,
  });

  await seedTransaction(harness.tenantTwoId, {
    transactionId: BASE_ID,
    occurredAt: '2026-08-30T00:00:00.000Z',
    kind: 'CHECKOUT', totalAmount: 999, balanceDelta: -999,
    balanceBefore: 2000, balanceAfter: 1001, operator: 'other', status: 'COMPLETED',
    studentName: '다른 반 학생',
  });
  await seedTransaction(harness.tenantTwoId, {
    transactionId: OTHER_TENANT_ONLY_ID,
    occurredAt: '2026-08-30T01:00:00.000Z',
    kind: 'CANCELLATION', totalAmount: -999, balanceDelta: 999,
    balanceBefore: 1001, balanceAfter: 2000, operator: `cancel:${BASE_ID}`,
    status: 'CANCEL_REVERSAL', reversesTransactionId: BASE_ID,
    studentName: '다른 반 학생',
  });
});

afterEach(async () => {
  await harness?.close();
});

function queries(overrides: Partial<DatabaseTransactionQueryDependencies> = {}) {
  return createDatabaseTransactionQueries({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    ...overrides,
  });
}

type TransactionSeed = {
  transactionId: string;
  occurredAt: string;
  kind: 'CHECKOUT' | 'CANCELLATION' | 'ADMIN_ADJUSTMENT' | 'TASK_REWARD' | 'LEGACY';
  totalAmount: number;
  balanceDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  operator: string;
  status: string | null;
  reversesTransactionId?: string;
  studentName?: string;
};

async function seedStudent(tenantId: string, studentId: string, name: string) {
  await harness.database.query(
    "INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, $2, $3, 'ACTIVE')",
    [tenantId, studentId, name],
  );
}

async function seedTransaction(tenantId: string, seed: TransactionSeed) {
  await harness.database.query(
    `INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
       legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
       legacy_status_snapshot, reverses_transaction_id, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1)`,
    [tenantId, seed.transactionId, seed.occurredAt, STUDENT_ID, seed.studentName ?? '김학생',
      seed.kind, seed.totalAmount, seed.balanceDelta, seed.balanceBefore, seed.balanceAfter,
      seed.operator, seed.status, seed.reversesTransactionId ?? null],
  );
}

async function seedBaseItem(
  tenantId: string,
  transactionId: string,
  lineNumber: number,
  productId: string,
  name: string,
  quantity: number,
  price: number,
  subtotal: number,
) {
  await harness.database.query(
    `INSERT INTO transaction_items
      (tenant_id, transaction_id, line_number, product_id_snapshot, product_name_snapshot,
       quantity, unit_price_snapshot, subtotal_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, transactionId, lineNumber, productId, name, quantity, price, subtotal],
  );
}

const PROMOTION = {
  promotionId: 'N21', name: '2+1', description: '', type: 'N_PLUS_ONE', buyQuantity: 2,
  freeQuantity: 1, productIds: ['P3'], startsAt: '2020-01-01T00:00:00.000Z',
  endsAt: '2099-01-01T00:00:00.000Z', isActive: true, sortOrder: 1,
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 3,
} as const;
const ADJUSTMENT = {
  promotionId: 'N21', type: 'N_PLUS_ONE', beforeAmount: 900, afterAmount: 600,
  discountAmount: 300, freeQuantity: 1,
} as const;

async function seedExtendedItem(tenantId: string, transactionId: string) {
  await harness.database.query(
    `INSERT INTO transaction_items
      (tenant_id, transaction_id, line_number, product_id_snapshot, product_name_snapshot,
       quantity, unit_price_snapshot, subtotal_snapshot, regular_unit_price, regular_total,
       total_quantity, paid_quantity, free_quantity, final_total, total_discount,
       adjustments_snapshot, applied_promotions_snapshot)
     VALUES ($1,$2,1,'P3','노트',3,300,600,300,900,3,2,1,600,300,$3::jsonb,$4::jsonb)`,
    [tenantId, transactionId, JSON.stringify([ADJUSTMENT]), JSON.stringify([PROMOTION])],
  );
}

function sheetReader(): SheetsReader {
  const extendedItem = {
    productId: 'P3', name: '노트', price: 300, quantity: 3, subtotal: 600,
    regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 2,
    freeQuantity: 1, finalTotal: 600, totalDiscount: 300,
    adjustments: [ADJUSTMENT], appliedPromotions: [PROMOTION],
  };
  return {
    getRows: async (sheetName) => sheetName === 'Transactions' ? [
      ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount',
        'balanceBefore', 'balanceAfter', 'status', 'operator'],
      [BASE_ID, '2026-08-29T01:00:00.000Z', STUDENT_ID, '김학생', JSON.stringify([
        { productId: 'P1', name: '연필', price: 100, quantity: 2, subtotal: 200 },
        { productId: 'P2', name: '지우개', price: 500, quantity: 1, subtotal: 500 },
      ]), '700', '2000', '1300', 'CANCELLED', 'kiosk'],
      [EXTENDED_ID, '2026-08-29T02:00:00.000Z', STUDENT_ID, '김학생', JSON.stringify([extendedItem]),
        '600', '1300', '700', 'COMPLETED', 'teacher'],
      [ADMIN_ID, '2026-08-29T03:00:00.000Z', STUDENT_ID, '김학생', '[]',
        '-300', '700', '1000', 'ADMIN_ADJUSTMENT', 'admin'],
      [TIED_ID, '2026-08-29T03:00:00.000Z', STUDENT_ID, '김학생', '[]',
        '50', '1000', '1050', 'TASK_REWARD', 'task'],
      [REVERSAL_ID, '2026-08-29T04:00:00.000Z', STUDENT_ID, '김학생', '[]',
        '-700', '1050', '1750', 'CANCEL_REVERSAL', `cancel:${BASE_ID}`],
    ] : [],
  };
}

describe('database transaction queries', () => {
  it('matches the actual Sheets projection for base and extended items, zero-item rows, cancellation links, and stable ordering', async () => {
    const expected = await getSheetTransactions(sheetReader());

    const actual = await queries().getTransactions();
    expect(actual[3]?.items[0])
      .toMatchObject({ productId: 'P3', finalTotal: 600, appliedPromotions: [PROMOTION] });
    expect(actual).toEqual(expected);
    expect(actual.map(({ transactionId }) => transactionId)).toEqual([
      REVERSAL_ID, ADMIN_ID, TIED_ID, EXTENDED_ID, BASE_ID,
    ]);
  });

  it('returns one transaction by exact ID, including ordered items and derived cancellation state', async () => {
    await expect(queries().getTransactionById(BASE_ID)).resolves.toEqual({
      transactionId: BASE_ID,
      timestamp: '2026-08-29T01:00:00.000Z',
      studentId: STUDENT_ID,
      studentName: '김학생',
      items: [
        { productId: 'P1', name: '연필', price: 100, quantity: 2, subtotal: 200 },
        { productId: 'P2', name: '지우개', price: 500, quantity: 1, subtotal: 500 },
      ],
      totalAmount: 700,
      balanceBefore: 2000,
      balanceAfter: 1300,
      status: 'CANCELLED',
      operator: 'kiosk',
      cancelledAt: '2026-08-29T04:00:00.000Z',
    });
    await expect(queries().getTransactionById('missing')).resolves.toBeNull();
  });

  it('projects an authoritative cancellation pair in one tenant snapshot and one SQL statement', async () => {
    let snapshots = 0;
    let statements = 0;
    const runTenantTransaction: DatabaseTransactionQueryDependencies['runTenantTransaction'] =
      async (tenantId, callback) => {
        snapshots += 1;
        return harness.runTenantTransaction(tenantId, async (transaction) => callback({
          ...transaction,
          execute: async (...args: Parameters<typeof transaction.execute>) => {
            statements += 1;
            return transaction.execute(...args);
          },
        } as unknown as typeof transaction));
      };

    await expect(queries({ runTenantTransaction }).getCancellationPair(BASE_ID, REVERSAL_ID))
      .resolves.toEqual({
        cancelledTransaction: expect.objectContaining({
          transactionId: BASE_ID,
          status: 'CANCELLED',
          cancelledAt: '2026-08-29T04:00:00.000Z',
        }),
        reversalTransaction: expect.objectContaining({
          transactionId: REVERSAL_ID,
          status: 'CANCEL_REVERSAL',
        }),
      });
    expect(snapshots).toBe(1);
    expect(statements).toBe(1);
  });

  it.each([
    ['', REVERSAL_ID],
    [' BASE', REVERSAL_ID],
    [BASE_ID, 'REVERSAL '],
    [BASE_ID, BASE_ID],
  ])('rejects malformed or non-unique cancellation pair IDs before opening a snapshot', async (
    originalId,
    reversalId,
  ) => {
    const runTenantTransaction = vi.fn();
    await expect(queries({ runTenantTransaction }).getCancellationPair(originalId, reversalId))
      .rejects.toThrow(/transaction id|unique|pair/i);
    expect(runTenantTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when either cancellation pair member is missing or belongs to another tenant', async () => {
    await expect(queries().getCancellationPair(BASE_ID, 'MISSING'))
      .rejects.toThrow(/pair|missing|integrity/i);
    await expect(queries().getCancellationPair(BASE_ID, OTHER_TENANT_ONLY_ID))
      .rejects.toThrow(/pair|missing|integrity/i);
    await expect(queries().getCancellationPair(BASE_ID, BASE_ID))
      .rejects.toThrow(/pair|unique|integrity/i);
  });

  it('fails closed when the requested reversal does not link to the requested original', async () => {
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      'UPDATE transactions SET reverses_transaction_id=$3 WHERE tenant_id=$1 AND transaction_id=$2',
      [harness.tenantOneId, REVERSAL_ID, ADMIN_ID],
    ));

    await expect(queries().getCancellationPair(BASE_ID, REVERSAL_ID))
      .rejects.toThrow(/pair|link|integrity/i);
  });

  it('does not expose same-ID transactions or item snapshots from another tenant', async () => {
    const transaction = await queries().getTransactionById(BASE_ID);
    expect(transaction).toMatchObject({ studentName: '김학생', totalAmount: 700 });
    expect(transaction?.items.map(({ productId }) => productId)).toEqual(['P1', 'P2']);
    expect((await queries().getTransactions()).some(({ studentName }) => studentName === '다른 반 학생'))
      .toBe(false);
  });

  it('keeps explicit tenant predicates behind an independently mismatched RLS context', async () => {
    const runWithTenantTwoContext: DatabaseTransactionQueryDependencies['runTenantTransaction'] =
      (_tenantId, callback) => harness.runTenantTransaction(harness.tenantTwoId, callback);
    const mismatched = queries({ runTenantTransaction: runWithTenantTwoContext });

    await expect(mismatched.getTransactions()).resolves.toEqual([]);
    await expect(mismatched.getTransactionById(BASE_ID)).resolves.toBeNull();
  });

  it('opens every read through the injected tenant transaction runner', async () => {
    const tenantIds: string[] = [];
    const runTenantTransaction: DatabaseTransactionQueryDependencies['runTenantTransaction'] =
      async <TResult>(tenantId: string, callback: Parameters<
        DatabaseTransactionQueryDependencies['runTenantTransaction']
      >[1]) => {
        tenantIds.push(tenantId);
        return harness.runTenantTransaction(tenantId, callback) as Promise<TResult>;
      };
    const repository = queries({ runTenantTransaction });

    await repository.getTransactions();
    await repository.getTransactionById(BASE_ID);

    expect(tenantIds).toEqual([harness.tenantOneId, harness.tenantOneId]);
  });

  it.each(['', ' BASE', 'BASE '])(
    'rejects non-canonical transaction ID %j before opening a transaction',
    async (transactionId) => {
      let transactionOpened = false;
      const runTenantTransaction: DatabaseTransactionQueryDependencies['runTenantTransaction'] =
        <TResult>() => {
          transactionOpened = true;
          return Promise.reject(new Error('unexpected transaction')) as Promise<TResult>;
        };

      await expect(queries({ runTenantTransaction }).getTransactionById(transactionId))
        .rejects.toThrow(/transaction id/i);
      expect(transactionOpened).toBe(false);
    },
  );

  it('fails closed on duplicate reversal links instead of choosing a cancellation timestamp', async () => {
    await seedTransaction(harness.tenantOneId, {
      transactionId: 'SECOND-REVERSAL', occurredAt: '2026-08-29T05:00:00.000Z',
      kind: 'CANCELLATION', totalAmount: -700, balanceDelta: 700,
      balanceBefore: 1750, balanceAfter: 2450, operator: `cancel:${BASE_ID}`,
      status: 'CANCEL_REVERSAL', reversesTransactionId: BASE_ID,
    });

    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/reversal|cancellation|integrity/i);
    await expect(queries().getTransactions()).rejects.toThrow(/reversal|cancellation|integrity/i);
  });

  it('fails closed on malformed and inconsistent immutable money snapshots', async () => {
    await harness.database.exec('ALTER TABLE transactions DROP CONSTRAINT transactions_balance_delta_check');
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      'UPDATE transactions SET balance_after=999 WHERE tenant_id=$1 AND transaction_id=$2',
      [harness.tenantOneId, ADMIN_ID],
    ));

    await expect(queries().getTransactionById(ADMIN_ID)).rejects.toThrow(/balance|integrity/i);
    await expect(queries().getTransactions()).rejects.toThrow(/balance|integrity/i);
  });

  it.each([
    [BASE_ID, 701],
    [ADMIN_ID, -301],
    [TIED_ID, 51],
    [REVERSAL_ID, -701],
  ])('rejects kind-inconsistent legacy totals for %s', async (transactionId, malformedTotal) => {
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      'UPDATE transactions SET legacy_total_amount=$3 WHERE tenant_id=$1 AND transaction_id=$2',
      [harness.tenantOneId, transactionId, malformedTotal],
    ));

    await expect(queries().getTransactionById(transactionId)).rejects.toThrow(/total|money|integrity/i);
  });

  it('preserves arbitrary legacy-import total semantics', async () => {
    await seedTransaction(harness.tenantOneId, {
      transactionId: 'LEGACY-ODD', occurredAt: '2026-08-28T00:00:00.000Z', kind: 'LEGACY',
      totalAmount: 123, balanceDelta: 5, balanceBefore: 10, balanceAfter: 15,
      operator: 'legacy-import', status: 'LEGACY',
    });

    await expect(queries().getTransactionById('LEGACY-ODD')).resolves.toEqual(
      expect.objectContaining({ totalAmount: 123, balanceBefore: 10, balanceAfter: 15 }),
    );
  });

  it('rejects a cancellation linked to a different student than the original', async () => {
    await seedStudent(harness.tenantOneId, 'S2', '다른 학생');
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      'UPDATE transactions SET student_id=$3 WHERE tenant_id=$1 AND transaction_id=$2',
      [harness.tenantOneId, REVERSAL_ID, 'S2'],
    ));

    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/student|reversal|integrity/i);
    await expect(queries().getTransactionById(REVERSAL_ID)).rejects.toThrow(/student|reversal|integrity/i);
  });

  it('rejects a cancellation whose delta is not the exact negation of the original', async () => {
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      `UPDATE transactions
       SET legacy_total_amount=-600, balance_delta=600, balance_after=1650
       WHERE tenant_id=$1 AND transaction_id=$2`,
      [harness.tenantOneId, REVERSAL_ID],
    ));

    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/delta|reversal|integrity/i);
    await expect(queries().getTransactionById(REVERSAL_ID)).rejects.toThrow(/delta|reversal|integrity/i);
  });

  it('rejects reversal-of-reversal chains from either side of the link', async () => {
    await seedTransaction(harness.tenantOneId, {
      transactionId: 'CHAIN', occurredAt: '2026-08-29T05:00:00.000Z', kind: 'CANCELLATION',
      totalAmount: 700, balanceDelta: -700, balanceBefore: 1750, balanceAfter: 1050,
      operator: 'cancel:REVERSAL', status: 'CANCEL_REVERSAL', reversesTransactionId: REVERSAL_ID,
    });

    await expect(queries().getTransactionById(REVERSAL_ID)).rejects.toThrow(/reversal|kind|integrity/i);
    await expect(queries().getTransactionById('CHAIN')).rejects.toThrow(/reversal|kind|integrity/i);
  });

  it('rejects cancellation chronology at or before the original transaction', async () => {
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      'UPDATE transactions SET occurred_at=$3 WHERE tenant_id=$1 AND transaction_id=$2',
      [harness.tenantOneId, REVERSAL_ID, '2026-08-28T00:00:00.000Z'],
    ));

    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/chronology|timestamp|cancellation/i);
    await expect(queries().getTransactionById(REVERSAL_ID)).rejects.toThrow(/chronology|timestamp|cancellation/i);
  });

  it('rejects checkout rows whose item totals do not match the immutable total', async () => {
    await harness.database.query(
      'UPDATE transaction_items SET subtotal_snapshot=201 WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=1',
      [harness.tenantOneId, BASE_ID],
    );

    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/item|total|integrity/i);
  });

  it('rejects checkout rows without items and non-checkout domain rows with items', async () => {
    await harness.database.query(
      'DELETE FROM transaction_items WHERE tenant_id=$1 AND transaction_id=$2',
      [harness.tenantOneId, BASE_ID],
    );
    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/item|checkout|integrity/i);

    await seedBaseItem(harness.tenantOneId, ADMIN_ID, 1, 'ADMIN-ITEM', '잘못된 항목', 1, 1, 1);
    await expect(queries().getTransactionById(ADMIN_ID)).rejects.toThrow(/item|kind|integrity/i);
  });

  it('fails closed on malformed item snapshots', async () => {
    await harness.database.exec('ALTER TABLE transaction_items DROP CONSTRAINT transaction_items_base_check');
    await harness.database.query(
      'UPDATE transaction_items SET quantity=0 WHERE tenant_id=$1 AND transaction_id=$2 AND line_number=1',
      [harness.tenantOneId, BASE_ID],
    );

    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/quantity|integrity/i);
  });

  it('fails closed on duplicate item positions', async () => {
    await harness.database.exec(
      'ALTER TABLE transaction_items DROP CONSTRAINT transaction_items_transaction_line_unique',
    );
    await seedBaseItem(harness.tenantOneId, BASE_ID, 1, 'DUP', '중복', 1, 1, 1);

    await expect(queries().getTransactionById(BASE_ID)).rejects.toThrow(/position|line|duplicate|integrity/i);
  });
});
