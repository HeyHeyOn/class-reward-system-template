// @vitest-environment node
// E-02: bounded synthetic logical backup rehearsal, NOT managed backup/PITR.
// The application route is real; only its DB destination and server-only marker differ.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCartPricingPreview } from '@/domain/checkout';
import type { Product } from '@/domain/types';
import { POST } from '@/app/api/c/[slug]/[...path]/route';
import { createSignedStudentQr } from '@/server/studentQr';
import { withTenantTransaction } from '@/server/db/transaction';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('E02_OWNED_DATABASE_REQUIRED');
  return { pool: destination.pool };
} }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const A = 'e0200000-0000-4000-8000-000000000001';
const B = 'e0200000-0000-4000-8000-000000000002';
const tenants = [A, B];
const products: Product[] = ['P1', 'P2'].map((productId, sortOrder) => ({
  productId, name: productId, price: 80, stock: 10, isActive: true, sortOrder,
}));
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
type Query = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
type Summary = { count: number; sha256: string };
type Witness = { tables: Record<string, Summary & { tenants: Record<string, Summary> }>;
  sequences: Record<string, unknown>; guards: string; roles: Record<string, unknown>[]; memberships: Record<string, unknown>[] };
const owned: DisposablePostgres[] = [];
let source: DisposablePostgres;
let caseName = '';
const event = (kind: string, value: unknown) => console.info('E02_EVENT', JSON.stringify({ case: caseName, kind, value }));

// Catalog text avoids rounding SQL bigint/timestamps in JSON.parse or relying on heap order.
const GUARDS = `SELECT COALESCE(jsonb_agg(v ORDER BY v::text),'[]'::jsonb)::text AS wire FROM (
  SELECT jsonb_build_array('table',c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner)) v
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
  UNION ALL SELECT jsonb_build_array('constraint',c.conrelid::regclass::text,c.conname,c.convalidated,pg_get_constraintdef(c.oid,true))
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
  UNION ALL SELECT jsonb_build_array('trigger',t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
  UNION ALL SELECT jsonb_build_array('function',p.proname,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL SELECT jsonb_build_array('policy',to_jsonb(p)) FROM pg_policies p WHERE schemaname='public'
  UNION ALL SELECT jsonb_build_array('column',to_jsonb(c)) FROM information_schema.columns c WHERE table_schema='public'
  UNION ALL SELECT jsonb_build_array('index',to_jsonb(i)) FROM pg_indexes i WHERE schemaname='public'
  UNION ALL SELECT jsonb_build_array('grant',to_jsonb(g)) FROM information_schema.role_table_grants g WHERE table_schema='public'
  UNION ALL SELECT jsonb_build_array('sequence',to_jsonb(s)-'last_value') FROM pg_sequences s WHERE schemaname='public'
  UNION ALL SELECT jsonb_build_array('schema',nspname,pg_get_userbyid(nspowner),nspacl)
    FROM pg_namespace WHERE nspname='public'
) s`;
async function witness(q: Query): Promise<Witness> {
  const tables: Witness['tables'] = {};
  for (const { tablename } of (await q.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    const table = String(tablename);
    const summarize = async (tenant?: string): Promise<Summary> => {
      const where = tenant ? ` WHERE to_jsonb(t)->>$1=$2` : '';
      const values = tenant ? [table === 'tenants' ? 'id' : 'tenant_id', tenant] : [];
      const row = (await q.query(`SELECT count(*)::int AS count,
        COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS wire
        FROM public.${ident(table)} t${where}`, values)).rows[0];
      return { count: Number(row.count), sha256: hash(String(row.wire)) };
    };
    tables[table] = { ...await summarize(), tenants: {} };
    for (const tenant of tenants) tables[table].tenants[tenant] = await summarize(tenant);
  }
  const sequences: Record<string, unknown> = {};
  for (const { sequencename } of (await q.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
    sequences[String(sequencename)] = (await q.query(`SELECT last_value::text,is_called FROM public.${ident(String(sequencename))}`)).rows;
  }
  const roles = (await q.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname='app_runtime' ORDER BY rolname`)).rows;
  const memberships = (await q.query(`SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,
    admin_option,inherit_option,set_option FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='app_runtime')
    OR roleid=(SELECT oid FROM pg_roles WHERE rolname='app_runtime') ORDER BY role,member`)).rows;
  return { tables, sequences, guards: hash(String((await q.query(GUARDS)).rows[0].wire)), roles, memberships };
}

async function allocate(label: string) {
  const db = await createDisposablePostgres();
  owned.push(db);
  event('owned_pg', { label, ...db.evidence, ...await inspectArchiveDatabase(db) });
  return db;
}
async function destroy(db: DisposablePostgres) {
  event('cleanup', await db.close());
  owned.splice(owned.indexOf(db), 1);
}

// No ambient Docker config, credentials, host PG env, network ports, or file mounts.
// Only an independently inspected, freshly allocated exact owned container is addressable.
async function cli(db: DisposablePostgres, args: string[], input?: Buffer) {
  const { id } = await inspectArchiveDatabase(db);
  const scratch = await mkdtemp(join(tmpdir(), 'e02-cli-'));
  const argv = ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', '--user', 'postgres', id, ...args];
  try {
    const result = await new Promise<{ code: number | null; signal: string | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
      const child = spawn('docker', argv, { env: { PATH: process.env.PATH, HOME: scratch, DOCKER_CONFIG: scratch, LANG: 'C', NODE_ENV: 'test' },
        stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let size = 0, stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('error', reject);
      // A truncated archive can close stdin early. Preserve actual child exit as the oracle.
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_000_000) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8000) stderr += chunk.toString(); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(chunks), stderr }); });
      child.stdin.end(input);
    });
    event('command', { argv: ['docker', ...argv], exit_code: result.code, signal: result.signal, stderr: result.stderr,
      stdin_bytes: input?.length ?? 0, stdin_sha256: input ? hash(input) : null,
      stdout_bytes: result.stdout.length, stdout_sha256: hash(result.stdout) });
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: false });
    event('cli_scratch_removed', true);
  }
}
const connection = ['-w', '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'postgres'];
async function capture(db: DisposablePostgres, omitLedger = false) {
  const client = await db.owner.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before = await witness(client);
    const snapshot = String((await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id);
    expect(snapshot).toMatch(/^[0-9A-F]+-[0-9A-F]+-[0-9]+$/);
    const result = await cli(db, ['pg_dump', ...connection, '--format=custom', '--no-tablespaces', `--snapshot=${snapshot}`,
      ...(omitLedger ? ['--exclude-table-data=public.inventory_ledger'] : [])]);
    expect(result.code).toBe(0); expect(result.signal).toBeNull();
    expect(result.stdout.subarray(0, 5).toString()).toBe('PGDMP');
    await client.query('COMMIT');
    expect(await witness(db.owner)).toEqual(before);
    event('capture', { witness: before, dump_bytes: result.stdout.length, dump_sha256: hash(result.stdout), omitLedger });
    return { bytes: result.stdout, sha256: hash(result.stdout), before };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function emptyTarget(label: string) {
  const db = await allocate(label);
  // Cluster roles come from the independent migration harness, NOT pg_dump globals.
  // Remove ONLY this fresh target's synthetic public objects before full DDL restore.
  // pg_dump omits the initdb-created public schema definition. Recreate only
  // that fresh-cluster baseline; all application DDL/data must come from the dump.
  await db.owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC');
  await assertEmpty(db);
  return db;
}
async function assertEmpty(db: DisposablePostgres) {
  expect((await db.owner.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'")).rows).toEqual([{ nspname: 'public' }]);
  expect((await db.owner.query(`SELECT classid::regclass::text,objid::text FROM pg_depend
    WHERE refclassid='pg_namespace'::regclass AND refobjid='public'::regnamespace`)).rows).toEqual([]);
  expect((await db.owner.query("SELECT schemaname FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows).toEqual([]);
}
async function restore(db: DisposablePostgres, bytes: Buffer) {
  return cli(db, ['pg_restore', ...connection, '--exit-on-error', '--single-transaction'], bytes);
}
// Test-only restoration acceptance oracle. Not a product recovery API or deployment gate.
async function verifiedRestore(db: DisposablePostgres, bytes: Buffer, expectedSha256: string, before: Witness) {
  if (hash(bytes) !== expectedSha256) throw new Error('E02_ARCHIVE_DIGEST_MISMATCH');
  const result = await restore(db, bytes);
  if (result.code !== 0 || result.signal) throw new Error('E02_NATIVE_RESTORE_FAILED');
  const after = await witness(db.owner);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('E02_RESTORED_STATE_MISMATCH');
  event('restoration_accepted', { before, after });
}
async function checkout(tenant: string, operationId: string, quantity = 1, identityTenant = tenant) {
  const slug = tenant === A ? 'e02-a' : 'e02-b';
  const items = [{ productId: 'P1', quantity }];
  const expectedPricing = createCartPricingPreview({ products, cartItems: items, now: new Date() });
  if (!expectedPricing.ok) throw new Error('Invalid fixture pricing');
  const request = new Request(`http://e02.invalid/api/c/${slug}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId, studentId: createSignedStudentQr({ tenantId: identityTenant, studentId: 'S1' }), items, expectedPricing }) });
  const response = await POST(request, { params: Promise.resolve({ slug, path: ['checkout'] }) });
  return { status: response.status, body: await response.json() };
}
async function roleIsolation(db: DisposablePostgres) {
  const identity = (await db.runtime.query(`SELECT current_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb
    FROM pg_roles WHERE rolname=current_user`)).rows;
  expect(identity).toEqual([{ current_user: 'app_runtime', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false }]);
  const rls = (await db.owner.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname`,
  [['accounts', 'products', 'transactions', 'transaction_items', 'inventory_ledger', 'operations', 'audit_events']])).rows;
  expect(rls).toHaveLength(7);
  expect(rls.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  const before = await witness(db.owner);
  for (const [tenant, other] of [[A, B], [B, A]]) {
    const rows = await withTenantTransaction(tenant, async tx => {
      const own = (await tx.execute(sql`SELECT student_id FROM accounts WHERE tenant_id=${tenant} ORDER BY student_id`)).rows;
      const hidden = (await tx.execute(sql`SELECT * FROM accounts WHERE tenant_id=${other}`)).rows;
      const write = (await tx.execute(sql`UPDATE accounts SET balance=0 WHERE tenant_id=${other} RETURNING student_id`)).rows;
      return { own, hidden, write };
    });
    expect(rows).toEqual({ own: [{ student_id: 'S1' }, { student_id: 'S2' }], hidden: [], write: [] });
    event('tenant_sql_isolation', { tenant, other, ...rows });
  }
  const client = await db.runtime.connect();
  try {
    await expect(client.query('SET ROLE postgres')).rejects.toMatchObject({ code: '42501' });
    await expect(client.query('SELECT * FROM public.generator_grant_claims')).rejects.toMatchObject({ code: '42501' });
    expect((await client.query('SELECT * FROM accounts')).rows).toEqual([]);
  } finally { client.release(); }
  expect(await witness(db.owner)).toEqual(before);
  event('role_isolation', { identity, rls, no_tenant_rows: 0, owner_role_switch: '42501', private_table_read: '42501', state_unchanged: true });
}

suite('E-02 isolated native PostgreSQL checkout backup restoration', () => {
  beforeEach(async context => {
    caseName = context.task.name;
    expect(process.env.DATABASE_URL).toBeUndefined();
    source = await allocate('source'); destination.pool = source.runtime;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('STUDENT_QR_ACTIVE_KEY_ID', 'e02');
    vi.stubEnv('STUDENT_QR_SIGNING_KEYS', JSON.stringify({ e02: randomBytes(32).toString('base64url') }));
    await source.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
    for (const [tenant, slug] of [[A, 'e02-a'], [B, 'e02-b']]) {
      await source.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$2,'ACTIVE')", [tenant, slug]);
      for (const student of ['S1', 'S2']) {
        await source.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,$2,$2,'ACTIVE')", [tenant, student]);
        await source.owner.query('INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,$2,500)', [tenant, student]);
      }
      for (const product of products) await source.owner.query(`INSERT INTO products
        (tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,$2,$2,80,10,true,$3)`, [tenant, product.productId, product.sortOrder]);
    }
  }, 60_000);
  afterEach(async () => {
    destination.pool = undefined; vi.unstubAllEnvs();
    const failures = [];
    for (const db of [...owned].reverse()) { try { await destroy(db); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'E02 exact owned cleanup failed');
  }, 60_000);

  it('independent full logical restore preserves counts digests RLS and replay with cross-tenant denial', async () => {
    // Same operation UUID is valid separately per tenant; each has a real purchase.
    const operationId = randomUUID();
    const first = await checkout(A, operationId, 2), second = await checkout(B, operationId);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    await roleIsolation(source);
    const captured = await capture(source);
    for (const tenant of tenants) {
      for (const table of ['transactions', 'transaction_items', 'inventory_ledger', 'operations', 'audit_events']) {
        expect(captured.before.tables[table].tenants[tenant].count).toBe(1);
      }
      for (const table of ['accounts', 'products', 'students']) expect(captured.before.tables[table].tenants[tenant].count).toBe(2);
    }
    const business = (await source.owner.query(`SELECT a.tenant_id,a.balance::text,p.stock::text,o.status,t.balance_delta::text,
      l.quantity_delta::text FROM accounts a JOIN products p ON p.tenant_id=a.tenant_id AND p.product_id='P1'
      JOIN operations o ON o.tenant_id=a.tenant_id JOIN transactions t ON t.tenant_id=o.tenant_id AND t.operation_id=o.operation_id
      JOIN inventory_ledger l ON l.tenant_id=t.tenant_id AND l.transaction_id=t.transaction_id
      WHERE a.student_id='S1' ORDER BY a.tenant_id`)).rows;
    expect(business).toEqual([
      { tenant_id: A, balance: '340', stock: '8', status: 'SUCCEEDED', balance_delta: '-160', quantity_delta: '-2' },
      { tenant_id: B, balance: '420', stock: '9', status: 'SUCCEEDED', balance_delta: '-80', quantity_delta: '-1' },
    ]);
    const sourceIdentity = await inspectArchiveDatabase(source);
    destination.pool = undefined;
    await destroy(source); // No SQL/connection/candidate re-import from the source can service the restore.
    const target = await emptyTarget('independent-restore');
    const targetIdentity = await inspectArchiveDatabase(target);
    expect(targetIdentity.id).not.toBe(sourceIdentity.id);
    expect(targetIdentity.systemIdentifier).not.toBe(sourceIdentity.systemIdentifier);
    event('independence', { sourceIdentity, targetIdentity, source_destroyed_before_target_allocation: true });
    await verifiedRestore(target, captured.bytes, captured.sha256, captured.before);
    destination.pool = target.runtime;
    await roleIsolation(target);
    const beforeReplay = await witness(target.owner);
    expect(await checkout(A, operationId, 2)).toEqual(first);
    expect(await checkout(B, operationId)).toEqual(second);
    expect(await witness(target.owner)).toEqual(beforeReplay);
    const denials = [await checkout(A, randomUUID(), 1, B), await checkout(B, randomUUID(), 1, A)];
    expect(denials).toEqual(Array(2).fill({ status: 400, body: { error: '학생 정보를 찾을 수 없어요.' } }));
    expect(await witness(target.owner)).toEqual(beforeReplay);
    event('post_restore_replay_and_denial', { replies: [first, second], denials, all_tables_and_sequences_unchanged: true, business });
  }, 180_000);

  it('tampered truncated and valid-but-incomplete archives cannot produce false restoration acceptance', async () => {
    expect((await checkout(A, randomUUID(), 2)).status).toBe(200);
    expect((await checkout(B, randomUUID())).status).toBe(200);
    const captured = await capture(source), incomplete = await capture(source, true);
    expect(incomplete.before).toEqual(captured.before);
    await destroy(source); destination.pool = undefined;
    const damagedTarget = await emptyTarget('negative-tampered-truncated');
    const changed = Buffer.from(captured.bytes); changed[changed.length - 1] ^= 1;
    await expect(verifiedRestore(damagedTarget, changed, captured.sha256, captured.before)).rejects.toThrow('E02_ARCHIVE_DIGEST_MISMATCH');
    await assertEmpty(damagedTarget);
    event('tampered_refused', { accepted: false, native_dispatched: false, target_empty: true, changed_sha256: hash(changed) });
    // Deliberately bypass the checksum precheck to measure native parser/transaction rollback.
    const truncated = captured.bytes.subarray(0, Math.floor(captured.bytes.length / 2));
    const failed = await restore(damagedTarget, truncated);
    expect(failed.code).not.toBe(0); expect(failed.code).not.toBeNull(); expect(failed.signal).toBeNull();
    expect(failed.stderr).toMatch(/pg_restore: error:/);
    await assertEmpty(damagedTarget);
    event('truncated_refused', { accepted: false, native_dispatched: true, exit_code: failed.code, target_empty: true });
    const incompleteTarget = await emptyTarget('negative-valid-incomplete');
    // A syntactically valid dump can still be incomplete. Native exit 0 is NOT acceptance.
    await expect(verifiedRestore(incompleteTarget, incomplete.bytes, incomplete.sha256, captured.before))
      .rejects.toThrow('E02_RESTORED_STATE_MISMATCH');
    const after = await witness(incompleteTarget.owner);
    expect(after.tables.inventory_ledger.count).toBe(0);
    const mismatches = Object.keys(captured.before.tables).filter(table => JSON.stringify(after.tables[table]) !== JSON.stringify(captured.before.tables[table]));
    expect(mismatches).toEqual(['inventory_ledger']);
    event('incomplete_refused', { accepted: false, native_dispatched: true, native_exit_code: 0, mismatches,
      expected: captured.before, actual: after, disposition: 'DISPOSABLE_TARGET_ONLY; destroyed in teardown, never published' });
  }, 180_000);
});
