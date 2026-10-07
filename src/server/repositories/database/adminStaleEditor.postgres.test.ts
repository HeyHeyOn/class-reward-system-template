// @vitest-environment node
// D-02: existing PG repository contract only; the Sheets batch routes are NOT wired to it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createDatabaseStudentCommands } from './studentCommands';
import { createDatabaseCatalogCommands } from './catalogCommands';

vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const TENANT = 'd0200000-0000-4000-8000-000000000010';
let database: DisposablePostgres;

suite('D-02 native PG boundary (not browser or deployed acceptance)', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    database = await createDisposablePostgres();
    console.info('D02_PG_OWNED', JSON.stringify(database.evidence));
    await database.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,'d02-local','D02 local','ACTIVE')", [TENANT]);
    await database.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S001','Student','ACTIVE')", [TENANT]);
    await database.owner.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'S001',90)", [TENANT]);
    await database.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,'P001','Pencil',10,2,true,1)", [TENANT]);
  }, 60_000);
  afterAll(async () => {
    if (database) console.info('D02_PG_CLEANUP', JSON.stringify(await database.close()));
  }, 60_000);

  it('rejects stale full rows after SQL-simulated restoration; accepts explicit current edits and effect-free replay', async () => {
    const dependencies = { tenantId: TENANT, runTenantTransaction: database.runTenantTransaction };
    const students = createDatabaseStudentCommands(dependencies);
    const catalog = createDatabaseCatalogCommands(dependencies);
    // Fixture restoration, not a claim that a native cancellation API was exercised here.
    await database.owner.query("UPDATE accounts SET balance=100,version=2 WHERE tenant_id=$1", [TENANT]);
    await database.owner.query("UPDATE products SET stock=3,version=2 WHERE tenant_id=$1", [TENANT]);
    const snapshot = async () => ({
      students: (await database.owner.query('SELECT student_id,name,status,version::text FROM students WHERE tenant_id=$1', [TENANT])).rows,
      accounts: (await database.owner.query('SELECT student_id,balance::text,version::text FROM accounts WHERE tenant_id=$1', [TENANT])).rows,
      products: (await database.owner.query('SELECT product_id,stock::text,is_active,version::text FROM products WHERE tenant_id=$1', [TENANT])).rows,
      operations: (await database.owner.query('SELECT operation_id,status FROM operations WHERE tenant_id=$1 ORDER BY operation_id', [TENANT])).rows,
      transactions: (await database.owner.query('SELECT transaction_id,balance_delta::text FROM transactions WHERE tenant_id=$1 ORDER BY transaction_id', [TENANT])).rows,
      inventory: (await database.owner.query('SELECT inventory_event_id,quantity_delta::text FROM inventory_ledger WHERE tenant_id=$1 ORDER BY inventory_event_id', [TENANT])).rows,
    });
    const restored = await snapshot();
    const studentInput = { operationId: 'd02-student', students: [{ studentId: 'S001', expectedStudentVersion: 1, expectedAccountVersion: 1, name: 'Student', balance: 90, status: 'INACTIVE' as const }] };
    const productInput = { operationId: 'd02-product', productId: 'P001', expectedProductVersion: 1, name: 'Pencil', price: 10, stock: 2, isActive: false, sortOrder: 1 };
    await expect(students.updateBatch(studentInput)).rejects.toThrow(/stale version/i);
    await expect(catalog.update(productInput)).rejects.toThrow('Product version is stale.');
    expect(await snapshot()).toEqual(restored);
    const currentStudent = { ...studentInput, students: [{ ...studentInput.students[0], expectedAccountVersion: 2, balance: 125 }] };
    const currentProduct = { ...productInput, expectedProductVersion: 2, stock: 5 };
    expect((await students.updateBatch(currentStudent)).ok).toBe(true);
    expect((await catalog.update(currentProduct)).ok).toBe(true);
    const committed = await snapshot();
    expect(committed.accounts[0].balance).toBe('125');
    expect(committed.products[0].stock).toBe('5');
    expect((await students.updateBatch(currentStudent)).ok).toBe(true);
    expect((await catalog.update(currentProduct)).ok).toBe(true);
    expect(await snapshot()).toEqual(committed);
    console.info('D02_PG_READBACK', JSON.stringify({ restored, committed, staleRefusalsUnchanged: true, exactReplayUnchanged: true }));
  }, 60_000);
});
