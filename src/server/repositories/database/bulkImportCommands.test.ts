import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductImportRow, StudentImportRow } from '@/lib/bulkImport';
import { BulkImportCommitError } from '@/server/bulkImport/errors';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import {
  bulkImportChildOperationId,
  createDatabaseProductImport,
  createDatabaseStudentImport,
} from './bulkImportCommands';
import { createDatabaseCatalogCommands } from './catalogCommands';
import { createDatabaseStudentCommands } from './studentCommands';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-10-06T01:00:00.000Z');
const OPERATION_ID = '10000000-0000-4000-8000-0000000000a1';
const OTHER_OPERATION_ID = '10000000-0000-4000-8000-0000000000a2';
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
});

afterEach(async () => harness?.close());

function studentImport(overrides: Partial<Parameters<typeof createDatabaseStudentImport>[0]> = {}) {
  return createDatabaseStudentImport({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => new Date(NOW),
    ...overrides,
  });
}

function productImport(overrides: Partial<Parameters<typeof createDatabaseProductImport>[0]> = {}) {
  return createDatabaseProductImport({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    now: () => new Date(NOW),
    ...overrides,
  });
}

async function count(table: string, tenantId = harness.tenantOneId): Promise<number> {
  const result = await harness.database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id=$1`, [tenantId],
  );
  return Number(result.rows[0].count);
}

async function tableCounts() {
  return {
    students: await count('students'),
    accounts: await count('accounts'),
    products: await count('products'),
    operations: await count('operations'),
    audits: await count('audit_events'),
    transactions: await count('transactions'),
    inventory: await count('inventory_ledger'),
  };
}

async function seedStudent(studentId: string, name: string, deleted = false) {
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status, version, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5, $6)`,
    [harness.tenantOneId, studentId, name, deleted ? 'INACTIVE' : 'ACTIVE', NOW, deleted ? NOW : null],
  );
  await harness.database.query(
    'INSERT INTO accounts (tenant_id, student_id, balance, version, updated_at) VALUES ($1, $2, 0, 1, $3)',
    [harness.tenantOneId, studentId, NOW],
  );
}

async function seedProduct(productId: string, name: string, sortOrder: number, deleted = false) {
  await harness.database.query(
    `INSERT INTO products (tenant_id, product_id, name, price, stock, is_active, sort_order, version,
       created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, 100, 0, $4, $5, 1, $6, $6, $7)`,
    [harness.tenantOneId, productId, name, !deleted, sortOrder, NOW, deleted ? NOW : null],
  );
}

const STUDENTS: StudentImportRow[] = [
  { rowNumber: 2, studentId: '01', name: '김민준', balance: 1000 },
  { rowNumber: 3, studentId: '02', name: '이서연', balance: 0 },
  { rowNumber: 5, studentId: '03', name: '박도윤', balance: -200 },
];

function product(rowNumber: number, name: string, overrides: Partial<ProductImportRow> = {}): ProductImportRow {
  return {
    rowNumber, name, price: 500, stock: 0, category: null, imageUrl: null, sortOrder: rowNumber, isActive: true,
    ...overrides,
  };
}

describe('student bulk import commit', () => {
  it('creates every row through the existing create command, with ledgers and audits', async () => {
    const result = await studentImport().commit({ operationId: OPERATION_ID, rows: STUDENTS });

    expect(result).toEqual({
      ok: true, kind: 'students', operationId: OPERATION_ID, created: 3, replayed: false,
      items: STUDENTS.map(({ rowNumber, studentId, name, balance }) => ({ rowNumber, studentId, name, balance })),
    });
    const rows = await harness.database.query<{ student_id: string; name: string; status: string; balance: string }>(
      `SELECT s.student_id, s.name, s.status, a.balance::text AS balance FROM students s
       JOIN accounts a USING (tenant_id, student_id) WHERE s.tenant_id=$1 ORDER BY s.student_id`, [harness.tenantOneId],
    );
    expect(rows.rows).toEqual([
      { student_id: '01', name: '김민준', status: 'ACTIVE', balance: '1000' },
      { student_id: '02', name: '이서연', status: 'ACTIVE', balance: '0' },
      { student_id: '03', name: '박도윤', status: 'ACTIVE', balance: '-200' },
    ]);
    // One STUDENT_ADMIN operation + audit per row; ledger rows only for nonzero balances.
    expect(await tableCounts()).toMatchObject({ students: 3, accounts: 3, operations: 3, audits: 3, transactions: 2 });
    const operations = await harness.database.query<{ operation_id: string; operation_kind: string }>(
      'SELECT operation_id, operation_kind FROM operations WHERE tenant_id=$1 ORDER BY operation_id', [harness.tenantOneId],
    );
    expect(operations.rows.map((row) => row.operation_kind)).toEqual(['STUDENT_ADMIN', 'STUDENT_ADMIN', 'STUDENT_ADMIN']);
    expect(operations.rows.map((row) => row.operation_id).sort()).toEqual(
      [0, 1, 2].map((index) => bulkImportChildOperationId('students', OPERATION_ID, index)).sort(),
    );
  });

  it('replays a retried confirm without creating anything twice', async () => {
    await studentImport().commit({ operationId: OPERATION_ID, rows: STUDENTS });
    const before = await tableCounts();

    const retried = await studentImport({ now: () => new Date('2026-10-06T02:00:00.000Z') })
      .commit({ operationId: OPERATION_ID, rows: STUDENTS });

    expect(retried).toMatchObject({ ok: true, created: 3, replayed: true });
    expect(retried.items.map((item) => item.studentId)).toEqual(['01', '02', '03']);
    expect(await tableCounts()).toEqual(before);
  });

  it('refuses the same operationId with different rows, writing nothing', async () => {
    await studentImport().commit({ operationId: OPERATION_ID, rows: STUDENTS });
    const before = await tableCounts();

    const changed = STUDENTS.map((row, index) => index === 1 ? { ...row, name: '다른 이름' } : row);
    await expect(studentImport().commit({ operationId: OPERATION_ID, rows: changed }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(studentImport().commit({ operationId: OPERATION_ID, rows: [...STUDENTS, { rowNumber: 9, studentId: '09', name: '추가', balance: 0 }] }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await tableCounts()).toEqual(before);
  });

  it('is all-or-nothing: a failure on a later row rolls back the earlier rows', async () => {
    let calls = 0;
    const failingCommands: typeof createDatabaseStudentCommands = (dependencies) => {
      const real = createDatabaseStudentCommands(dependencies);
      return {
        ...real,
        async create(input) {
          calls += 1;
          if (calls === 3) throw new Error('injected failure on the third row');
          return real.create(input);
        },
      };
    };

    await expect(studentImport({ createStudentCommands: failingCommands }).commit({ operationId: OPERATION_ID, rows: STUDENTS }))
      .rejects.toThrow('injected failure');
    expect(calls).toBe(3);
    expect(await tableCounts()).toEqual({
      students: 0, accounts: 0, products: 0, operations: 0, audits: 0, transactions: 0, inventory: 0,
    });

    // The same confirm can then be retried and succeeds exactly once.
    const retried = await studentImport().commit({ operationId: OPERATION_ID, rows: STUDENTS });
    expect(retried).toMatchObject({ created: 3, replayed: false });
    expect(await count('students')).toBe(3);
  });

  it('re-validates against the current class inside the transaction', async () => {
    await seedStudent('02', '먼저 추가됨');
    await seedStudent('03', '삭제된 학생', true);
    const before = await tableCounts();

    const error = await studentImport().commit({ operationId: OPERATION_ID, rows: STUDENTS }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BulkImportCommitError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      issues: [
        { rowNumber: 3, column: '학생 번호', message: '이미 등록된 학생 번호예요 (먼저 추가됨).' },
        { rowNumber: 5, column: '학생 번호', message: expect.stringContaining('삭제한 학생') },
      ],
    });
    expect(await tableCounts()).toEqual(before);
  });

  it('loads existing students including deleted ones for the preview', async () => {
    await seedStudent('01', '김민준');
    await seedStudent('99', '전학', true);
    await harness.database.query(
      `INSERT INTO students (tenant_id, student_id, name, status, version, created_at, updated_at)
       VALUES ($1, 'other', '다른 반', 'ACTIVE', 1, $2, $2)`, [harness.tenantTwoId, NOW],
    );
    const existing = await studentImport().loadExisting();
    expect([...existing.values()].sort((a, b) => a.studentId.localeCompare(b.studentId))).toEqual([
      { studentId: '01', name: '김민준', deleted: false },
      { studentId: '99', name: '전학', deleted: true },
    ]);
  });

  it('keeps tenants apart', async () => {
    await studentImport().commit({ operationId: OPERATION_ID, rows: STUDENTS });
    const other = createDatabaseStudentImport({
      tenantId: harness.tenantTwoId, runTenantTransaction: harness.runTenantTransaction, now: () => new Date(NOW),
    });
    const result = await other.commit({ operationId: OPERATION_ID, rows: STUDENTS });
    expect(result).toMatchObject({ created: 3, replayed: false });
    expect(await count('students', harness.tenantTwoId)).toBe(3);
    expect(await count('students')).toBe(3);
  });
});

describe('product bulk import commit', () => {
  it('allocates fresh P-numbers (skipping deleted IDs) and creates products with inventory ledgers', async () => {
    await seedProduct('P001', '기존 과자', 4);
    await seedProduct('P002', '삭제된 상품', 9, true);
    const rows = [
      product(2, '초코파이', { stock: 20, category: '간식' }),
      product(3, '연필', { imageUrl: 'https://example.com/pencil.png', isActive: false }),
    ];

    const result = await productImport().commit({ operationId: OPERATION_ID, rows });

    expect(result).toEqual({
      ok: true, kind: 'products', operationId: OPERATION_ID, created: 2, replayed: false,
      items: [
        { rowNumber: 2, productId: 'P003', name: '초코파이' },
        { rowNumber: 3, productId: 'P004', name: '연필' },
      ],
    });
    const stored = await harness.database.query(
      `SELECT product_id, name, price::text, stock::text, is_active, image_url, category, sort_order
       FROM products WHERE tenant_id=$1 AND product_id IN ('P003', 'P004') ORDER BY product_id`, [harness.tenantOneId],
    );
    expect(stored.rows).toEqual([
      { product_id: 'P003', name: '초코파이', price: '500', stock: '20', is_active: true, image_url: null, category: '간식', sort_order: 2 },
      { product_id: 'P004', name: '연필', price: '500', stock: '0', is_active: false, image_url: 'https://example.com/pencil.png', category: null, sort_order: 3 },
    ]);
    expect(await tableCounts()).toMatchObject({ products: 4, operations: 2, audits: 2, inventory: 1 });
  });

  it('replays a retried confirm with the originally allocated IDs', async () => {
    const rows = [product(2, '초코파이'), product(3, '연필', { stock: 3 })];
    await productImport().commit({ operationId: OPERATION_ID, rows });
    const before = await tableCounts();

    const retried = await productImport().commit({ operationId: OPERATION_ID, rows });

    expect(retried).toMatchObject({ created: 2, replayed: true });
    expect(retried.items.map((item) => item.productId)).toEqual(['P001', 'P002']);
    expect(await tableCounts()).toEqual(before);
    await expect(productImport().commit({ operationId: OPERATION_ID, rows: [rows[0], { ...rows[1], price: 999 }] }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await tableCounts()).toEqual(before);
  });

  it('is all-or-nothing when a later product fails', async () => {
    let calls = 0;
    const failingCommands: typeof createDatabaseCatalogCommands = (dependencies) => {
      const real = createDatabaseCatalogCommands(dependencies);
      return {
        ...real,
        async create(input) {
          calls += 1;
          if (calls === 2) throw new Error('injected product failure');
          return real.create(input);
        },
      };
    };
    const rows = [product(2, '초코파이', { stock: 5 }), product(3, '연필')];

    await expect(productImport({ createCatalogCommands: failingCommands }).commit({ operationId: OPERATION_ID, rows }))
      .rejects.toThrow('injected product failure');
    expect(await tableCounts()).toMatchObject({ products: 0, operations: 0, audits: 0, inventory: 0 });
  });

  it('re-validates names against products added after the preview', async () => {
    await seedProduct('P001', '초코 파이', 1);
    const error = await productImport().commit({ operationId: OTHER_OPERATION_ID, rows: [product(2, '초코파이')] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      issues: [{ rowNumber: 2, column: '상품 이름', message: '이미 같은 이름의 상품이 있어요 (P001).' }],
    });
    expect(await count('operations')).toBe(0);
  });

  it('loads existing products for the preview, ignoring deleted names and sort orders', async () => {
    await seedProduct('P001', '초코파이', 3);
    await seedProduct('P002', '연필', 50, true);
    const existing = await productImport().loadExisting();
    expect(existing).toEqual({
      activeNames: new Map([['초코파이', 'P001']]),
      maxSortOrder: 3,
      usedProductIds: ['P001', 'P002'],
    });
  });
});
