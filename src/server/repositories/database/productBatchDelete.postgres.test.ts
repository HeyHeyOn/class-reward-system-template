// @vitest-environment node
// D08: actual scoped handlers against an owned, network-none native PostgreSQL only.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Product } from '@/domain/types';
import { createCartPricingPreview } from '@/domain/checkout';
import { createCheckoutPayloadHash } from '@/server/checkoutService';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { setGoogleSessionCookie, GOOGLE_AUTH_COOKIE } from '@/server/googleOAuth';
import { DELETE, GET, PATCH } from '@/app/api/c/[slug]/[...path]/route';
import { createDatabaseCatalogCommands } from './catalogCommands';
import { createDatabaseCheckoutCommand } from './checkoutCommands';
const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined, google: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('D08_OWNED_DATABASE_REQUIRED');
  return { pool: destination.pool };
} }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: destination.google, createConfiguredSheetsReader: destination.google }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const A = 'd0800000-0000-4000-8000-000000000001';
const B = 'd0800000-0000-4000-8000-000000000002';
let db: DisposablePostgres;
let cookie: string;
const evidence = (kind: string, value: unknown) => console.info('D08_PG', JSON.stringify({ kind, value }));
const commands = () => createDatabaseCatalogCommands({ tenantId: A, runTenantTransaction: db.runTenantTransaction });
const input = (ids: string[], operationId = randomUUID(), version = 1) => ({ operationId, products: ids.map((productId) => ({ productId, expectedProductVersion: version })) });
async function remove(body: unknown, slug = 'd08-a', authorized = true, id = 'batch') {
  return DELETE(new Request(`http://localhost/api/c/${slug}/products/${id}?tenantId=${B}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', 'x-tenant-id': B, ...(authorized ? { cookie } : {}) }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ slug, path: ['products', id] }) });
}
async function get(admin = true) {
  const response = await GET(new Request(`http://localhost/api/c/d08-a/products${admin ? '?includeInactive=1' : ''}`, { headers: admin ? { cookie } : {} }), {
    params: Promise.resolve({ slug: 'd08-a', path: ['products'] }),
  });
  expect(response.status).toBe(200); return response.json();
}
async function create(...ids: string[]) {
  for (const productId of ids) await commands().create({ operationId: randomUUID(), productId, name: productId, price: 10, stock: 20, isActive: true, sortOrder: 1 });
}
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ['products', 'operations', 'audit_events', 'inventory_ledger', 'transactions', 'transaction_items', 'accounts', 'promotions', 'promotion_products']) {
    result[table] = (await db.owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
suite('D08 isolated native PostgreSQL product batch DELETE', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    db = await createDisposablePostgres(); destination.pool = db.runtime; evidence('owned', db.evidence);
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql'); vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_ID', B);
    vi.stubEnv('CLASS_STORE_CENTRAL_TENANT_STATUS', 'ACTIVE'); vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
    destination.google.mockImplementation(() => { throw new Error('D08_GOOGLE_FORBIDDEN'); });
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
    await db.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid,text) TO app_runtime');
    // Synthetic pre-existing ACTIVE tenants, not an activation/import of any class.
    for (const [id, slug] of [[A, 'd08-a'], [B, 'd08-b']]) await db.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$2,'ACTIVE')", [id, slug]);
    const user = (await db.owner.query("INSERT INTO users(google_subject,canonical_email) VALUES('d08-owner','d08@example.test') RETURNING id")).rows[0].id;
    await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [A, user]);
    const reply = NextResponse.json({});
    setGoogleSessionCookie(reply, { subject: 'd08-owner', email: 'd08@example.test', issuedAt: Date.now() });
    cookie = `${GOOGLE_AUTH_COOKIE}=${reply.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
    await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,'FOREIGN','Foreign',1,777,true,1)", [B]);
    const identity = (await db.runtime.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows;
    expect(identity).toEqual([{ current_user: 'app_runtime', rolsuper: false, rolbypassrls: false }]); evidence('runtime_role', identity);
  }, 60_000);
  afterAll(async () => {
    try { expect(destination.google).not.toHaveBeenCalled(); } finally {
      if (db) evidence('cleanup', await db.close());
      destination.pool = undefined; vi.unstubAllEnvs();
    }
  }, 30_000);
  it('executes real multi-ID dispatch, persists tombstones and stock, hides deleted rows on subsequent public/admin read', async () => {
    await create('ONE', 'TWO', 'batch');
    await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,'ONE','Foreign One',1,777,true,1)", [B]);
    const before = await state(); const body = input(['TWO', 'ONE']);
    const response = await remove(body); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ productIds: ['ONE', 'TWO'], operationId: body.operationId });
    // A separately acquired runtime connection, not the command's returned snapshot.
    const readback = await db.runTenantTransaction(A, (tx) => tx.execute(sql`SELECT product_id,stock::text,version::text,is_active,deleted_at IS NOT NULL AS deleted FROM products WHERE tenant_id=${A} AND product_id IN ('ONE','TWO','batch') ORDER BY product_id`));
    expect(readback.rows).toEqual([
      { product_id: 'ONE', stock: '20', version: '2', is_active: false, deleted: true },
      { product_id: 'TWO', stock: '20', version: '2', is_active: false, deleted: true },
      { product_id: 'batch', stock: '20', version: '1', is_active: true, deleted: false },
    ]);
    expect((await get()).products.map((p: Product) => p.productId)).not.toEqual(expect.arrayContaining(['ONE', 'TWO']));
    expect((await get(false)).map((p: Product) => p.productId)).not.toEqual(expect.arrayContaining(['ONE', 'TWO']));
    const after = await state(); expect(after.inventory_ledger).toEqual(before.inventory_ledger);
    const foreign = (await db.owner.query("SELECT stock::text,version::text,deleted_at FROM products WHERE tenant_id=$1 AND product_id='ONE'", [B])).rows;
    expect(foreign).toEqual([{ stock: '777', version: '1', deleted_at: null }]);
    const replay = await remove({ ...body, products: [...body.products].reverse() });
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ productIds: ['ONE', 'TWO'], operationId: body.operationId }); expect(await state()).toEqual(after);
    const conflict = await remove({ ...body, products: [body.products[0]] });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await state()).toEqual(after); evidence('persistent_multi_id_and_replay', { readback: readback.rows, foreign, operationId: body.operationId });
  });
  it('denies absent/nonmember auth; missing, foreign-only, malformed and stale batches roll back without any side effects', async () => {
    await create('ATOMIC');
    const before = await state();
    expect((await remove(input(['ATOMIC']), 'd08-a', false)).status).toBe(401);
    expect((await remove(input(['FOREIGN']), 'd08-b')).status).toBe(403);
    for (const id of ['MISSING', 'FOREIGN']) {
      const response = await remove(input(['ATOMIC', id])); expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    }
    expect((await remove(input(['ATOMIC', 'ATOMIC']))).status).toBe(400);
    const stale = await remove(input(['ATOMIC'], randomUUID(), 2)); expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'STALE_VERSION' }); expect(await state()).toEqual(before);
    evidence('negative_atomicity', { unchanged: true, authentication: [401, 403], missing: 404, malformed: 400, stale: 409 });
  });
  it('rolls back after product updates when required audit fails; no Sheets fallback', async () => {
    await create('ROLL1', 'ROLL2'); const before = await state(); const body = input(['ROLL1', 'ROLL2']);
    await db.owner.query(`CREATE FUNCTION d08_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'D08 injected audit failure'; END $$;
      CREATE TRIGGER d08_reject_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION d08_reject_audit()`);
    try {
      const response = await remove(body); expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain('injected'); expect(await state()).toEqual(before);
      expect(destination.google).not.toHaveBeenCalled();
    } finally { await db.owner.query('DROP TRIGGER d08_reject_audit ON audit_events; DROP FUNCTION d08_reject_audit()'); }
    expect((await remove(body)).status).toBe(200); evidence('post_update_rollback', { operationId: body.operationId, rollback: true, retrySucceeded: true });
  });
  it('preserves nonzero stock, checkout history and promotion references rather than inventing a hard-delete/protection rule', async () => {
    await create('REFERENCED', 'ZERO');
    await db.owner.query("UPDATE products SET stock=0 WHERE tenant_id=$1 AND product_id='ZERO'", [A]);
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'BUYER','Buyer','ACTIVE')", [A]);
    await db.owner.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'BUYER',1000)", [A]);
    const product: Product = { productId: 'REFERENCED', name: 'REFERENCED', price: 10, stock: 20, isActive: true, sortOrder: 1 };
    const items = [{ productId: product.productId, quantity: 2 }];
    const pricing = createCartPricingPreview({ products: [product], cartItems: items, now: new Date() });
    if (!pricing.ok) throw new Error('Invalid D08 pricing fixture');
    const checkout = { operationId: randomUUID(), studentId: 'BUYER', items, expectedPricing: pricing, operator: 'D08' };
    const purchase = await createDatabaseCheckoutCommand({ tenantId: A, runTenantTransaction: db.runTenantTransaction }).execute({ ...checkout, payloadHash: createCheckoutPayloadHash(checkout) });
    expect(purchase.ok).toBe(true);
    await db.owner.query("INSERT INTO promotions(tenant_id,promotion_id,name,description,type,fixed_discount,starts_at,ends_at) VALUES($1,'PROMO','Promo','D08 fixture','FIXED_DISCOUNT',1,now(),now()+interval '1 day')", [A]);
    await db.owner.query("INSERT INTO promotion_products(tenant_id,promotion_product_id,promotion_id,product_id) VALUES($1,'LINK','PROMO','REFERENCED')", [A]);
    const snapshot = await get(); const before = await state();
    const body = { operationId: randomUUID(), products: ['REFERENCED', 'ZERO'].map((productId) => ({ productId, expectedProductVersion: snapshot.mutationPreconditions.find((p: { productId: string }) => p.productId === productId).expectedVersion })) };
    expect((await remove(body)).status).toBe(200); const after = await state();
    for (const table of ['transactions', 'transaction_items', 'accounts', 'promotions', 'promotion_products', 'inventory_ledger']) expect(after[table]).toEqual(before[table]);
    const rows = (await db.owner.query("SELECT product_id,stock::text,is_active,deleted_at IS NOT NULL AS deleted FROM products WHERE tenant_id=$1 AND product_id IN ('REFERENCED','ZERO') ORDER BY product_id", [A])).rows;
    expect(rows).toEqual([{ product_id: 'REFERENCED', stock: '18', is_active: false, deleted: true }, { product_id: 'ZERO', stock: '0', is_active: false, deleted: true }]);
    await expect(db.owner.query("UPDATE products SET stock=-1 WHERE tenant_id=$1 AND product_id='REFERENCED'", [A])).rejects.toMatchObject({ code: '23514' });
    await expect(db.owner.query("DELETE FROM products WHERE tenant_id=$1 AND product_id='REFERENCED'", [A])).rejects.toMatchObject({ code: '23503' });
    const again = await remove(input(['REFERENCED'], randomUUID(), body.products[0].expectedProductVersion + 1));
    expect(again.status).toBe(409); expect(await again.json()).toMatchObject({ code: 'PRODUCT_DELETED' });
    evidence('reference_and_stock_constraints', { rows, historyPreserved: true, hardDeleteBlocked: '23503', negativeStockBlocked: '23514' });
  });
  it('concurrent identical operations replay once; different operations conflict atomically', async () => {
    await create('SAME1', 'SAME2', 'RACE1', 'RACE2');
    const same = input(['SAME1', 'SAME2']);
    const responses = await Promise.all([remove(same), remove(same)]); expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    const first = input(['RACE1', 'RACE2']); const second = input(['RACE2', 'RACE1']);
    const racers = await Promise.all([remove(first), remove(second)]); expect(racers.map((r) => r.status).sort()).toEqual([200, 409]);
    const count = (await db.owner.query('SELECT count(*)::int AS n FROM operations WHERE tenant_id=$1 AND operation_id=ANY($2::text[])', [A, [same.operationId, first.operationId, second.operationId]])).rows[0].n;
    expect(count).toBe(2); evidence('concurrency', { sameStatuses: [200, 200], competingStatuses: [200, 409], persistedOperations: count });
  });
  it('keeps single DELETE and D06 PATCH operational; a concurrent PATCH/delete cannot silently overwrite', async () => {
    await create('SINGLE', 'EDIT', 'EDITRACE');
    const single = await remove({ operationId: randomUUID(), expectedProductVersion: 1 }, 'd08-a', true, 'SINGLE');
    expect(single.status).toBe(200); expect(await single.json()).toEqual({ productId: 'SINGLE' });
    async function patch(productId: string) {
      const body = { operationId: randomUUID(), products: [{ productId, name: 'Edited', price: 10, stock: 25, isActive: true, sortOrder: 1, expectedProductVersion: 1 }] };
      return PATCH(new Request('http://localhost/api/c/d08-a/products/batch', { method: 'PATCH', headers: { cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ slug: 'd08-a', path: ['products', 'batch'] }) });
    }
    const edited = await patch('EDIT'); expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual([expect.objectContaining({ productId: 'EDIT', stock: 25, productVersion: 2 })]);
    const race = await Promise.all([patch('EDITRACE'), remove(input(['EDITRACE']))]);
    // D06 PATCH keeps its established 400 for tombstoned rows; only DELETE gains
    // the explicit conflict contract. In either ordering exactly one writer wins.
    expect(race.map((r) => r.status)).toEqual(race[0].status === 200 ? [200, 409] : [400, 200]);
    const row = (await db.owner.query("SELECT stock::text,version::text,deleted_at IS NOT NULL AS deleted FROM products WHERE tenant_id=$1 AND product_id='EDITRACE'", [A])).rows[0];
    expect(row).toEqual({ stock: race[0].status === 200 ? '25' : '20', version: '2', deleted: race[1].status === 200 });
    evidence('single_patch_regression_and_race', { single: 200, patch: 200, race: race.map((r) => r.status), row });
  });
});
