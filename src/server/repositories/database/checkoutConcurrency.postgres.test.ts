// @vitest-environment node
// E-01: actual scoped route -> QR verification -> repository -> native PG wire protocol.
// Only the database-client destination and server-only marker are substituted.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCartPricingPreview } from '@/domain/checkout';
import type { Product } from '@/domain/types';
import { createSignedStudentQr } from '@/server/studentQr';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { withTenantTransaction } from '@/server/db/transaction';
import { POST } from '@/app/api/c/[slug]/[...path]/route';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({
  getDatabaseClient: () => {
    if (!destination.pool) throw new Error('E01_OWNED_DATABASE_REQUIRED');
    return { pool: destination.pool };
  },
}));

const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const A = 'e0100000-0000-4000-8000-000000000001';
const B = 'e0100000-0000-4000-8000-000000000002';
const products: Product[] = ['P1', 'P2', 'P3'].map((productId, index) => ({
  productId, name: productId, price: 80, stock: 10, isActive: true, sortOrder: index,
}));
type Reply = { status: number; body: Record<string, unknown> };
type Wait = { pid: number; usename: string; state: string; wait_event_type: string;
  wait_event: string; blockers: number[]; xact_start: Date; query: string };
let pg: DisposablePostgres | undefined;
let caseName = '';
const evidence = (kind: string, value: unknown) => console.info('E01_EVENT', JSON.stringify({ case: caseName, kind, value }));
const db = () => { if (!pg) throw new Error('Owned PG not initialized'); return pg; };

suite('E-01 native PostgreSQL checkout API concurrency', () => {
  beforeEach(async (context) => {
    caseName = context.task.name;
    expect(process.env.DATABASE_URL).toBeUndefined();
    pg = await createDisposablePostgres();
    evidence('owned_pg', pg.evidence);
    // The migration harness defaults to two. Four real connections permit three
    // contending checkout transactions plus short directory reads; no promise queue.
    pg.runtime.options.max = 4;
    destination.pool = pg.runtime;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('STUDENT_QR_ACTIVE_KEY_ID', 'e01');
    vi.stubEnv('STUDENT_QR_SIGNING_KEYS', JSON.stringify({ e01: randomBytes(32).toString('base64url') }));
    await pg.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
    for (const [tenant, slug] of [[A, 'e01-a'], [B, 'e01-b']]) {
      await pg.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$2,'ACTIVE')", [tenant, slug]);
      for (const student of ['S1', 'S2', 'S3']) {
        await pg.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,$2,$2,'ACTIVE')", [tenant, student]);
        await pg.owner.query('INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,$2,100)', [tenant, student]);
      }
      for (const product of products) await pg.owner.query(`INSERT INTO products
        (tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,$2,$2,80,10,true,$3)`,
      [tenant, product.productId, product.sortOrder]);
    }
    const role = (await pg.runtime.query(`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows;
    expect(role).toEqual([{ current_user: 'app_runtime', rolsuper: false, rolbypassrls: false }]);
    evidence('runtime_identity', role);
  }, 60_000);

  afterEach(async () => {
    destination.pool = undefined;
    vi.unstubAllEnvs();
    if (pg) {
      const owned = pg; pg = undefined;
      evidence('cleanup', await owned.close());
    }
  }, 60_000);

  it('last stock one: three independent students contend; exactly one purchase', async () => {
    await db().owner.query("UPDATE products SET stock=1 WHERE tenant_id=$1 AND product_id='P1'", [A]);
    const before = await snapshot();
    const replies = await contend('product', () => ['S1', 'S2', 'S3'].map(student => checkout({ student })));
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 400).map(reply => reply.body.code))
      .toEqual(['INSUFFICIENT_STOCK', 'INSUFFICIENT_STOCK']);
    await reconcile(before, 1);
    expect((await db().owner.query("SELECT stock::text FROM products WHERE tenant_id=$1 AND product_id='P1'", [A])).rows)
      .toEqual([{ stock: '0' }]);
    evidence('responses', replies);
  }, 60_000);

  it('same student: three independent competing debits cannot overspend', async () => {
    const before = await snapshot();
    const replies = await contend('account', () => products.map(product => checkout({ product: product.productId })));
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 400).map(reply => reply.body.code))
      .toEqual(['INSUFFICIENT_BALANCE', 'INSUFFICIENT_BALANCE']);
    await reconcile(before, 1);
    expect((await db().owner.query("SELECT balance::text FROM accounts WHERE tenant_id=$1 AND student_id='S1'", [A])).rows)
      .toEqual([{ balance: '20' }]);
    evidence('responses', replies);
  }, 60_000);

  it('same operation and payload: concurrent and subsequent replay have one ledger effect', async () => {
    const before = await snapshot(), operationId = randomUUID();
    const replies = await contend('account', () => Array.from({ length: 3 }, () => checkout({ operationId })), true);
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200]);
    expect(replies[1]).toEqual(replies[0]); expect(replies[2]).toEqual(replies[0]);
    await reconcile(before, 1);
    const committed = await snapshot();
    expect(await checkout({ operationId })).toEqual(replies[0]);
    expect(await snapshot()).toEqual(committed);
    evidence('responses', replies);
    evidence('subsequent_replay_state_equal', true);
  }, 60_000);

  it('same operation changed payload: contending loser and later replay are rejected', async () => {
    const before = await snapshot(), operationId = randomUUID();
    let first: Promise<Reply> | undefined;
    // Establish the canonical claimant before starting changed-payload requests.
    const replies = await contend('account', async () => {
      first = checkout({ operationId });
      await waitForLocks(1);
      return [first, checkout({ operationId, product: 'P2' }), checkout({ operationId, product: 'P3' })];
    }, true);
    expect(replies[0].status).toBe(200);
    expect(replies.slice(1).map(reply => [reply.status, reply.body.code]))
      .toEqual([[409, 'OPERATION_CONFLICT'], [409, 'OPERATION_CONFLICT']]);
    await reconcile(before, 1);
    const committed = await snapshot();
    const late = await checkout({ operationId, product: 'P2' });
    expect(late.status).toBe(409); expect(late.body.code).toBe('OPERATION_CONFLICT');
    expect(await snapshot()).toEqual(committed);
    evidence('responses', replies); evidence('late_conflict_state_equal', true);
  }, 60_000);

  it('cross tenant: signed student identity and runtime RLS deny without any state change', async () => {
    const before = await snapshot();
    const replies = await Promise.all([
      checkout({ slug: 'e01-b', identityTenant: A }),
      checkout({ slug: 'e01-a', identityTenant: B }),
      checkout({ slug: 'e01-b', identityTenant: A, extra: { tenantId: B, studentTenantId: B } }),
    ]);
    expect(replies.map(reply => reply.status)).toEqual([400, 400, 400]);
    expect(replies.map(reply => reply.body)).toEqual(Array(3).fill({ error: '학생 정보를 찾을 수 없습니다.' }));
    // The real runtime role also cannot read/write B with transaction tenant A.
    const rls = await withTenantTransaction(A, async tx => {
      const identity = (await tx.execute(sql`SELECT current_user,current_setting('app.tenant_id') AS tenant`)).rows;
      const hidden = (await tx.execute(sql`SELECT * FROM accounts WHERE tenant_id=${B}`)).rows;
      const write = (await tx.execute(sql`UPDATE accounts SET balance=0 WHERE tenant_id=${B} RETURNING student_id`)).rows;
      return { identity, hidden, write };
    });
    expect(rls).toEqual({ identity: [{ current_user: 'app_runtime', tenant: A }], hidden: [], write: [] });
    expect(await snapshot()).toEqual(before);
    evidence('responses', replies); evidence('rls_denial', rls); evidence('all_tables_unchanged', true);
    // Positive control: the same B identity is valid at B (not a deny-everything test).
    const valid = await checkout({ slug: 'e01-b', identityTenant: B });
    expect(valid.status).toBe(200);
    await reconcile(before, 1, B);
    evidence('matching_tenant_positive_control', valid);
  }, 60_000);
});

async function checkout({ operationId = randomUUID(), student = 'S1', product = 'P1',
  slug = 'e01-a', identityTenant = A, extra = {} }: {
    operationId?: string; student?: string; product?: string; slug?: string;
    identityTenant?: string; extra?: Record<string, unknown>;
  } = {}): Promise<Reply> {
  const items = [{ productId: product, quantity: 1 }];
  const expectedPricing = createCartPricingPreview({ products, cartItems: items, now: new Date() });
  if (!expectedPricing.ok) throw new Error('Invalid test pricing');
  const request = new Request(`http://e01.invalid/api/c/${slug}/checkout`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...extra, operationId,
      studentId: createSignedStudentQr({ tenantId: identityTenant, studentId: student }), items, expectedPricing }) });
  const response = await POST(request, { params: Promise.resolve({ slug, path: ['checkout'] }) });
  return { status: response.status, body: await response.json() };
}

async function waitForLocks(count: number): Promise<Wait[]> {
  const deadline = Date.now() + 8_000;
  let rows: Wait[] = [];
  do {
    rows = (await db().owner.query<Wait>(`SELECT pid,usename,state,wait_event_type,wait_event,xact_start,
      pg_blocking_pids(pid) AS blockers,regexp_replace(query,'\\s+',' ','g') AS query
      FROM pg_stat_activity WHERE datname=current_database() AND usename='app_runtime'
      AND state='active' AND wait_event_type='Lock' ORDER BY pid`)).rows;
    if (rows.length === count) return rows;
    await new Promise(done => setTimeout(done, 15));
  } while (Date.now() < deadline);
  evidence('lock_wait_timeout', rows);
  throw new Error(`Expected ${count} actual simultaneously blocked PostgreSQL backends, found ${rows.length}`);
}

async function contend(resource: 'account' | 'product',
  start: () => Promise<Reply>[] | Promise<Promise<Reply>[]>, expectOperationWait = false) {
  const gate: PoolClient = await db().owner.connect();
  let pending: Promise<Reply>[] = [];
  try {
    await gate.query('BEGIN');
    const gatePid = (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await gate.query(resource === 'account'
      ? "SELECT * FROM accounts WHERE tenant_id=$1 AND student_id='S1' FOR UPDATE"
      : "SELECT * FROM products WHERE tenant_id=$1 AND product_id='P1' FOR UPDATE", [A]);
    pending = await start();
    const waits = await waitForLocks(3);
    const pids = waits.map(row => row.pid);
    expect(new Set(pids).size).toBe(3);
    expect(pids).not.toContain(gatePid);
    for (const row of waits) {
      expect(row.xact_start).toBeTruthy();
      expect(row.blockers.length).toBeGreaterThan(0);
      expect(row.blockers.every(pid => pid === gatePid || pids.includes(pid))).toBe(true);
    }
    // This checks observed server activity, not source SQL text. The followers
    // must wait on the first request's uncommitted operation-key insertion.
    if (expectOperationWait) {
      expect(waits.filter(row => row.query.includes('INSERT INTO operations'))).toHaveLength(2);
      expect(waits.filter(row => row.blockers.some(pid => pids.includes(pid))).length).toBeGreaterThanOrEqual(2);
    }
    evidence('overlap', { gatePid, requestPids: pids, waits, resource, expectOperationWait });
    await gate.query('ROLLBACK');
    return await Promise.all(pending);
  } finally {
    await gate.query('ROLLBACK').catch(() => {});
    gate.release();
    await Promise.allSettled(pending);
  }
}

const tables = ['tenants', 'students', 'accounts', 'products', 'promotions', 'promotion_products',
  'operations', 'transactions', 'transaction_items', 'inventory_ledger', 'adjustments', 'audit_events'] as const;
async function snapshot() {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) result[table] = (await db().owner.query(
    `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(value => value.row);
  return result;
}

async function reconcile(before: Awaited<ReturnType<typeof snapshot>>, count: number, tenant = A) {
  const after = await snapshot();
  const own = (table: string) => after[table].filter(row => table === 'tenants' ? row.id === tenant : row.tenant_id === tenant);
  const txs = own('transactions'), ledger = own('inventory_ledger'), items = own('transaction_items');
  expect(txs).toHaveLength(count); expect(ledger).toHaveLength(count); expect(items).toHaveLength(count);
  expect(own('operations')).toHaveLength(count); expect(own('audit_events')).toHaveLength(count);
  for (const operation of own('operations')) {
    expect(operation.status).toBe('SUCCEEDED');
    expect(txs.filter(tx => tx.operation_id === operation.operation_id && tx.operation_hash === operation.payload_hash)).toHaveLength(1);
  }
  for (const tx of txs) {
    expect(tx.kind).toBe('CHECKOUT'); expect(tx.balance_delta).toBe(-80);
    expect(Number(tx.balance_after) - Number(tx.balance_before)).toBe(tx.balance_delta);
    expect(items.filter(item => item.transaction_id === tx.transaction_id)).toHaveLength(1);
    expect(ledger.filter(entry => entry.transaction_id === tx.transaction_id)).toHaveLength(1);
    expect(own('audit_events').filter(event => event.operation_id === tx.operation_id)).toHaveLength(1);
  }
  for (const account of own('accounts')) {
    const original = before.accounts.find(row => row.tenant_id === tenant && row.student_id === account.student_id)!;
    expect(account.balance).toBe(Number(original.balance) + txs.filter(tx => tx.student_id === account.student_id)
      .reduce((sum, tx) => sum + Number(tx.balance_delta), 0));
    expect(Number(account.balance)).toBeGreaterThanOrEqual(0);
  }
  for (const product of own('products')) {
    const original = before.products.find(row => row.tenant_id === tenant && row.product_id === product.product_id)!;
    const entries = ledger.filter(entry => entry.product_id === product.product_id);
    expect(product.stock).toBe(Number(original.stock) + entries.reduce((sum, entry) => sum + Number(entry.quantity_delta), 0));
    expect(Number(product.stock)).toBeGreaterThanOrEqual(0);
    for (const entry of entries) {
      expect(entry.quantity_delta).toBe(-1);
      expect(Number(entry.stock_after) - Number(entry.stock_before)).toBe(entry.quantity_delta);
    }
  }
  for (const table of tables) {
    const other = (rows: Record<string, unknown>[]) => rows.filter(row => table === 'tenants' ? row.id !== tenant : row.tenant_id !== tenant);
    expect(other(after[table])).toEqual(other(before[table]));
  }
  expect(own('adjustments')).toEqual([]);
  evidence('reconciliation', { tenant, counts: Object.fromEntries(tables.map(table => [table, own(table).length])),
    accounts: own('accounts'), products: own('products'), transactions: txs, items, inventory: ledger,
    operations: own('operations'), audits: own('audit_events'), otherTenantUnchanged: true });
}
