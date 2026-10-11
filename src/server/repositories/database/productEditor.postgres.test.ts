// @vitest-environment node
// D06: native owned fixture only; actual scoped GET/PATCH, no deployed/migration claim.
import { issueTeacherTestSession, grantProductionTestRuntime } from '@/server/db/testing/teacherIdentity';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Product } from '@/domain/types';
import { createCartPricingPreview } from '@/domain/checkout';
import { createCheckoutPayloadHash } from '@/server/checkoutService';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner } from '@/server/db/transaction';
import { setGoogleSessionCookie, GOOGLE_AUTH_COOKIE } from '@/server/googleOAuth';
import { GET, PATCH } from '@/app/api/c/[slug]/[...path]/route';
import { GET as unscopedGet } from '@/app/api/products/route';
import { PATCH as unscopedPatch } from '@/app/api/products/batch/route';
import { createDatabaseCatalogCommands } from './catalogCommands';
import { createDatabaseCheckoutCommand } from './checkoutCommands';
import { createDatabaseTransactionCommands } from './transactionCommands';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined, google: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('D06_OWNED_DATABASE_REQUIRED');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: destination.google, createConfiguredSheetsReader: destination.google }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const A = 'd0600000-0000-4000-8000-000000000001';
const B = 'd0600000-0000-4000-8000-000000000002';
const DRAFT = 'd0600000-0000-4000-8000-000000000003';
type Displayed = Product & { expectedProductVersion: number };
let db: DisposablePostgres;
let cookie: string;
const evidence = (kind: string, value: unknown) => console.info('D06_PG', JSON.stringify({ kind, value }));
const command = () => createDatabaseCatalogCommands({ tenantId: A, runTenantTransaction: db.runTenantTransaction });
async function get(slug = 'd06-a', admin = true, snapshot = true) {
  return GET(new Request(`http://localhost/api/c/${slug}/products${snapshot ? '?includeInactive=1' : ''}`, {
    headers: admin ? { cookie } : {},
  }), { params: Promise.resolve({ slug, path: ['products'] }) });
}
async function patch(body: unknown, slug = 'd06-a', admin = true) {
  return PATCH(new Request(`http://localhost/api/c/${slug}/products/batch`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-tenant-id': B, ...(admin ? { cookie } : {}) }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ slug, path: ['products', 'batch'] }) });
}
async function row(id: string): Promise<Displayed> {
  const response = await get(); expect(response.status).toBe(200);
  const snapshot = await response.json();
  const product = snapshot.products.find((p: Product) => p.productId === id);
  expect(product).toBeTruthy();
  return { ...product, expectedProductVersion: snapshot.mutationPreconditions.find((p: { productId: string }) => p.productId === id).expectedVersion };
}
async function state() {
  const result: Record<string, Array<{ row: Record<string, unknown> }>> = {};
  for (const table of ['products', 'inventory_ledger', 'operations', 'audit_events', 'students', 'accounts', 'transactions', 'transaction_items']) {
    result[table] = (await db.owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [A])).rows;
  }
  return result;
}
function checkoutInput(product: Product) {
  const items = [{ productId: product.productId, quantity: 2 }];
  const pricing = createCartPricingPreview({ products: [product], cartItems: items, now: new Date() });
  if (!pricing.ok) throw new Error('Invalid D06 pricing fixture');
  const input = { operationId: randomUUID(), studentId: 'BUYER', items, expectedPricing: pricing, operator: 'D06' };
  return { ...input, payloadHash: createCheckoutPayloadHash(input) };
}

suite('D06 isolated native PG product editor', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres(); await grantProductionTestRuntime(db.owner); destination.pool = db.runtime;
    evidence('owned', db.evidence);
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_ID', B);
    vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_STATUS', 'ACTIVE');
    vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    destination.google.mockImplementation(() => { throw new Error('D06_GOOGLE_FORBIDDEN'); });
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_validate_teacher_session(text,uuid,uuid,boolean,text) TO app_runtime');
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO app_runtime');
    // Pre-existing ACTIVE business fixtures; the separate DRAFT is never promoted.
    for (const [id, slug, lifecycle] of [[A, 'd06-a', 'ACTIVE'], [B, 'd06-b', 'ACTIVE'], [DRAFT, 'd06-draft', 'DRAFT']]) {
      await db.owner.query('INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$2,$3)', [id, slug, lifecycle]);
    }
    const user = (await db.owner.query("INSERT INTO users(google_subject,canonical_email) VALUES('d06-owner','d06@example.test') RETURNING id")).rows[0].id;
    for (const id of [A, DRAFT]) await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [id, user]);
    const reply = NextResponse.json({});
    setGoogleSessionCookie(reply, await issueTeacherTestSession(db.owner,{ subject:'d06-owner',email:'d06@example.test' }));
    cookie = `${GOOGLE_AUTH_COOKIE}=${reply.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
    for (const id of ['READ', 'INACTIVE', 'DELETED', 'EDIT', 'RACE1', 'RACE2', 'ROLLBACK']) {
      await command().create({ operationId: randomUUID(), productId: id, name: id, price: 10, stock: 20, isActive: id !== 'INACTIVE', sortOrder: 1 });
    }
    await db.owner.query("UPDATE products SET deleted_at=now(), is_active=false WHERE tenant_id=$1 AND product_id='DELETED'", [A]);
    await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,'FOREIGN','FOREIGN',1,777,true,1)", [B]);
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'BUYER','Buyer','ACTIVE')", [A]);
    await db.owner.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'BUYER',1000)", [A]);
    const identity = (await db.runtime.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows;
    expect(identity).toEqual([{ current_user: 'app_runtime', rolsuper: false, rolbypassrls: false }]);
    evidence('admission_fixture', { identity, activeTenants: [A, B], draftTenant: DRAFT, limitation: 'Synthetic pre-existing active fixtures; no initialization, activation, migration or real binding claimed.' });
  }, 60_000);
  afterAll(async () => {
    destination.pool = undefined; vi.unstubAllEnvs();
    if (db) evidence('cleanup', await db.close());
  }, 60_000);

  it('authenticates tenant-bound nondeleted active/inactive snapshot; ordinary active GET is unchanged', async () => {
    expect((await get('d06-a', false)).status).toBe(401);
    expect((await get('d06-b')).status).toBe(403);
    const snapshot = await (await get()).json();
    expect(snapshot.products.some((p: Product) => p.productId === 'INACTIVE')).toBe(true);
    expect(snapshot.products.some((p: Product) => ['DELETED', 'FOREIGN'].includes(p.productId))).toBe(false);
    expect(snapshot.mutationPreconditions).toEqual(snapshot.products.map((p: Product) => ({ productId: p.productId, expectedVersion: 1 })));
    const normal = await (await get('d06-a', false, false)).json();
    expect(Array.isArray(normal)).toBe(true);
    expect(normal.every((p: Product) => p.isActive && !('version' in p) && !('productVersion' in p))).toBe(true);
    evidence('admin_read', { snapshot, normal, unauthenticated: 401, foreign: 403, googleCalls: destination.google.mock.calls.length });
    expect(destination.google).not.toHaveBeenCalled();
  });

  it('scoped PATCH commits metadata/stock/ledger/operation atomically; exact lost-response replay and changed-ID conflict', async () => {
    const body = { operationId: randomUUID(), products: [{ ...await row('EDIT'), name: 'Edited', price: 12, stock: 25, isActive: false, imageUrl: '/d06.png', category: 'D06', sortOrder: 7 }] };
    const first = await patch(body); expect(first.status).toBe(200); const saved = await first.json();
    expect(saved).toEqual([{ productId: 'EDIT', name: 'Edited', price: 12, stock: 25, isActive: false, imageUrl: '/d06.png', category: 'D06', sortOrder: 7, productVersion: 2 }]);
    expect(await row('EDIT')).toMatchObject({ ...body.products[0], expectedProductVersion: 2 });
    const committed = await state();
    const replay = await patch(body); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(saved);
    expect(await state()).toEqual(committed);
    const changed = await patch({ ...body, products: [{ ...body.products[0], stock: 26 }] });
    expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await state()).toEqual(committed);
    const operation = (await db.owner.query('SELECT xmin::text AS xid,status,result_snapshot FROM operations WHERE tenant_id=$1 AND operation_id=$2', [A, body.operationId])).rows[0];
    const event = operation.result_snapshot.products[0].inventoryEventId;
    const ledger = (await db.owner.query('SELECT xmin::text AS xid, quantity_delta::text,stock_before::text,stock_after::text,reason FROM inventory_ledger WHERE tenant_id=$1 AND inventory_event_id=$2', [A, event])).rows[0];
    const product = (await db.owner.query("SELECT xmin::text AS xid,stock::text,version FROM products WHERE tenant_id=$1 AND product_id='EDIT'", [A])).rows[0];
    expect(new Set([operation.xid, ledger.xid, product.xid]).size).toBe(1);
    expect(operation.status).toBe('SUCCEEDED');
    expect(ledger).toMatchObject({ quantity_delta: '5', stock_before: '20', stock_after: '25', reason: 'ADMIN_ADJUSTMENT' });
    evidence('committed_replay', { operationId: body.operationId, operation, product, ledger, exactReplayUnchanged: true, changedPayloadStatus: 409 });
    expect(destination.google).not.toHaveBeenCalled();
  });

  it.each(['checkout', 'cancellation'] as const)('real second connection %s races displayed edit; stale PATCH leaves no residuals; explicit fresh edit succeeds', async (kind) => {
    let transactionId = '';
    if (kind === 'cancellation') {
      const purchase = await createDatabaseCheckoutCommand({ tenantId: A, runTenantTransaction: db.runTenantTransaction }).execute(checkoutInput(await row('RACE2')));
      expect(purchase.ok).toBe(true);
      if (purchase.ok) transactionId = purchase.transactionId;
    }
    const stale = [await row('RACE1'), await row('RACE2')];
    const beforeRace = await state();
    const other = await db.runtime.connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    let write: Promise<unknown> | undefined;
    let edit: Promise<Response> | undefined;
    try {
      const otherPid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const runTenantTransaction = createTenantTransactionRunner({ pool: { connect: async () => ({ query: other.query.bind(other), release: () => undefined }) } });
      const dependencies = { tenantId: A, runTenantTransaction, afterResourceUpdates: async () => { entered(); await gate; } };
      if (kind === 'checkout') {
        write = createDatabaseCheckoutCommand(dependencies).execute(checkoutInput(stale[1]));
      } else {
        write = createDatabaseTransactionCommands(dependencies).cancel({ operationId: randomUUID(), transactionId });
      }
      await locked;
      const body = { operationId: randomUUID(), products: stale.map((p) => ({ ...p, stock: 23, name: `stale-${p.name}`, isActive: false })) };
      edit = patch(body);
      const deadline = Date.now() + 3000;
      let waiters: { pid: number; wait_event_type: string }[] = [];
      do {
        waiters = (await db.owner.query("SELECT pid,wait_event_type FROM pg_stat_activity WHERE usename='app_runtime' AND wait_event_type='Lock' AND pid<>$1", [otherPid])).rows;
        if (waiters.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      expect(waiters.length).toBeGreaterThan(0);
      // Stale edit is blocked on the product row; capture its competing writer's committed state after release.
      release(); await write;
      const staleResponse = await edit;
      expect(staleResponse.status).toBe(409); expect(await staleResponse.json()).toMatchObject({ code: 'STALE_VERSION' });
      const current = await row('RACE2');
      expect(current).toEqual({ ...stale[1], expectedProductVersion: stale[1].expectedProductVersion + 1,
        stock: stale[1].stock + (kind === 'checkout' ? -2 : 2) });
      const unchangedFirst = await row('RACE1'); expect(unchangedFirst).toEqual(stale[0]);
      expect(current.name).toBe(stale[1].name); expect(current.isActive).toBe(true);
      expect((await db.owner.query('SELECT status FROM operations WHERE tenant_id=$1 AND operation_id=$2', [A, body.operationId])).rows).toEqual([]);
      expect((await db.owner.query("SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1 AND status='PENDING'", [A])).rows).toEqual([{ n: 0 }]);
      const before = await state();
      // The actual lock race may leave ONLY the competing writer's immutable evidence.
      // Do not use a snapshot taken after the first stale edit as the sole rollback oracle.
      const deltas: Record<string, Array<{ row: Record<string, unknown> }>> = {};
      for (const table of ['inventory_ledger', 'operations', 'audit_events']) {
        expect(before[table]).toHaveLength(beforeRace[table].length + 1);
        for (const previous of beforeRace[table]) expect(before[table]).toContainEqual(previous);
        deltas[table] = before[table].filter((value) => !beforeRace[table].some((previous) => JSON.stringify(previous) === JSON.stringify(value)));
        expect(deltas[table]).toHaveLength(1);
      }
      expect(deltas.inventory_ledger[0].row).toMatchObject({ product_id: 'RACE2', reason: kind === 'checkout' ? 'CHECKOUT' : 'CANCELLATION',
        quantity_delta: kind === 'checkout' ? -2 : 2, stock_before: stale[1].stock, stock_after: current.stock });
      expect(deltas.operations[0].row).toMatchObject({ status: 'SUCCEEDED' });
      expect(deltas.operations[0].row.operation_id).not.toBe(body.operationId);
      expect(before.products.filter(({ row: p }) => p.product_id !== 'RACE2'))
        .toEqual(beforeRace.products.filter(({ row: p }) => p.product_id !== 'RACE2'));
      const staleAgain = await patch({ ...body, operationId: randomUUID() }); expect(staleAgain.status).toBe(409);
      expect(await state()).toEqual(before);
      const fresh = await patch({ operationId: randomUUID(), products: [{ ...current, stock: 30, name: 'Fresh explicit edit' }] });
      expect(fresh.status).toBe(200);
      expect(await row('RACE2')).toMatchObject({ name: 'Fresh explicit edit', stock: 30, expectedProductVersion: current.expectedProductVersion + 1 });
      evidence('race_stale_fresh', { kind, otherPid, waiters, displayed: stale, afterWriter: current, unchangedFirst,
        competingWriterOnlyDeltas: deltas, staleStatus: 409, exactRepeatedStaleStateUnchanged: true, pending: 0, freshStatus: 200,
        freshReadback: await row('RACE2') });
    } finally { release(); await Promise.allSettled([write, edit]); other.release(); }
    expect(destination.google).not.toHaveBeenCalled();
  }, 15_000);

  it('denies foreign/unauthenticated/injected/malformed/DRAFT writes with no fallback and preserves other tenant', async () => {
    const body = { operationId: randomUUID(), products: [await row('READ')] }; const before = await state();
    expect((await patch(body, 'd06-a', false)).status).toBe(401);
    expect((await patch(body, 'd06-b')).status).toBe(403);
    expect((await patch({ ...body, tenantId: B })).status).toBe(400);
    expect((await patch({ ...body, products: [{ ...body.products[0], productId: 'FOREIGN' }] })).status).toBe(400);
    for (const bad of [undefined, 0, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect((await patch({ ...body, products: [{ ...body.products[0], expectedProductVersion: bad }] })).status).toBe(400);
    }
    expect((await get('d06-draft')).status).toBe(500);
    expect((await patch(body, 'd06-draft')).status).toBe(400);
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [DRAFT])).rows).toEqual([{ lifecycle: 'DRAFT' }]);
    expect((await unscopedGet(new Request('http://localhost/api/products?includeInactive=1', { headers: { cookie } }))).status).toBe(401);
    expect((await unscopedPatch(new Request('http://localhost/api/products/batch', { method: 'PATCH', headers: { cookie }, body: JSON.stringify(body) }))).status).toBe(401);
    expect(await state()).toEqual(before);
    expect((await db.owner.query('SELECT stock::text FROM products WHERE tenant_id=$1', [B])).rows).toEqual([{ stock: '777' }]);
    evidence('admission', { noResidualState: true, foreignStock: 777, draft: 'DRAFT', googleCalls: destination.google.mock.calls.length });
    expect(destination.google).not.toHaveBeenCalled();
  });

  it('native ledger failure rolls back product, stock, operation and audit without Google fallback', async () => {
    const before = await state();
    await db.owner.query(`CREATE FUNCTION d06_fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.product_id='ROLLBACK' THEN RAISE EXCEPTION 'D06_LEDGER_FAILURE'; END IF; RETURN NEW; END $$`);
    await db.owner.query('CREATE TRIGGER d06_fail_ledger BEFORE INSERT ON inventory_ledger FOR EACH ROW EXECUTE FUNCTION d06_fail_ledger()');
    try {
      const reply = await patch({ operationId: randomUUID(), products: [{ ...await row('ROLLBACK'), stock: 25, name: 'Must rollback' }] });
      expect(reply.status).toBe(400); expect(await state()).toEqual(before);
      expect(destination.google).not.toHaveBeenCalled();
      evidence('ledger_failure', { status: reply.status, exactStateUnchanged: true, googleCalls: destination.google.mock.calls.length });
    } finally { await db.owner.query('DROP TRIGGER d06_fail_ledger ON inventory_ledger; DROP FUNCTION d06_fail_ledger()'); }
  });
});
