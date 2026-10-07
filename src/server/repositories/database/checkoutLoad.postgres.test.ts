// @vitest-environment node
// E-03: direct real route/application load, NOT HTTP sockets, browser, deployment or SLA.
// Reuses E-01/E-02's owned native PG helper; no production implementation is changed.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { POST } from '@/app/api/c/[slug]/[...path]/route';
import { createCartPricingPreview } from '@/domain/checkout';
import type { Product } from '@/domain/types';
import { createSignedStudentQr } from '@/server/studentQr';
import { withTenantTransaction } from '@/server/db/transaction';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';

const destination = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => {
  if (!destination.pool) throw new Error('E03_OWNED_DATABASE_REQUIRED');
  return { pool: destination.pool };
} }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const tenants = ['e0300000-0000-4000-8000-000000000001', 'e0300000-0000-4000-8000-000000000002',
  'e0300000-0000-4000-8000-000000000003'];
const products: Product[] = Array.from({ length: 16 }, (_, i) => ({
  productId: `P${i}`, name: `synthetic-${i}`, price: 10, stock: 1000, isActive: true, sortOrder: i,
}));
const tables = ['tenants', 'students', 'accounts', 'products', 'promotions', 'promotion_products',
  'operations', 'transactions', 'transaction_items', 'inventory_ledger', 'adjustments', 'audit_events'] as const;
type Row = Record<string, unknown>;
type State = Record<string, Row[]>;
type Input = { tenant: number; operationId: string; student: string; product: string; identity?: number };
type Reply = { input: Input; status: number | null; body: Row; elapsed_ms: number; error?: Row };
type Acquisition = { elapsed_ms: number; queued_at_entry: number; busy_at_entry: number; pid?: number; error?: Row };
type QueryMeasure = { kind: string; elapsed_ms: number; pid: number; error?: Row };
type Sample = { elapsed_ms: number; query_elapsed_ms: number; pool_total: number; pool_idle: number; pool_waiting: number; backends: Row[] };
type Profile = { name: string; concurrency: number; pool: number; count: number; mode: 'spread' | 'hot' | 'duplicate' | 'lock-timeout' | 'statement-timeout';
  acquisition_ms: number; lock_ms: number; statement_ms: number };
const profiles: Profile[] = [
  ...[1, 4, 8].map(c => ({ name: `spread-c${c}`, concurrency: c, pool: c, count: 128, mode: 'spread' as const,
    acquisition_ms: 2000, lock_ms: 0, statement_ms: 3000 })),
  { name: 'hot-account-stock-c8', concurrency: 8, pool: 8, count: 128, mode: 'hot', acquisition_ms: 2000, lock_ms: 0, statement_ms: 3000 },
  { name: 'duplicate-c16-p8', concurrency: 16, pool: 8, count: 128, mode: 'duplicate', acquisition_ms: 2000, lock_ms: 0, statement_ms: 3000 },
  { name: 'queue-overload-c32-p8', concurrency: 32, pool: 8, count: 128, mode: 'spread', acquisition_ms: 2000, lock_ms: 0, statement_ms: 3000 },
  { name: 'held-lock-overload-c32-p8', concurrency: 32, pool: 8, count: 32, mode: 'lock-timeout', acquisition_ms: 150, lock_ms: 500, statement_ms: 2000 },
  { name: 'held-statement-timeout-c8', concurrency: 8, pool: 8, count: 8, mode: 'statement-timeout', acquisition_ms: 2000, lock_ms: 0, statement_ms: 150 },
];
let pg: DisposablePostgres | undefined;
let caseName = '';
let acquisitions: Acquisition[] = [];
let queries: QueryMeasure[] = [];
const db = () => { if (!pg) throw new Error('Owned PG required'); return pg; };
const event = (kind: string, value: unknown) => {
  const record = { case: caseName, kind, value };
  console.info('E03_EVENT', JSON.stringify(record));
  // JSON-only Vitest reporters suppress console output. Persist the measured
  // distributions explicitly when the operator supplies an evidence path.
  if (kind === 'measurement' && process.env.CRS_NATIVE_LOAD_REPORT) {
    appendFileSync(process.env.CRS_NATIVE_LOAD_REPORT, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function errorRecord(error: unknown): Row {
  const e = error as { name?: string; message?: string; code?: string; cause?: unknown };
  return { name: e?.name ?? 'unknown', message: e?.message ?? String(error), code: e?.code ?? null };
}
function distribution(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const q = (fraction: number) => ordered.length ? ordered[Math.ceil(ordered.length * fraction) - 1] : null;
  return { n: ordered.length, p50: q(.5), p95: q(.95), p99: q(.99), max: ordered.at(-1) ?? null };
}

// Transparent Promise-only transaction-connect observer. The directory still uses
// the original pool.query (including its own callback acquisition semantics).
// Query args/results/errors and release policy pass through unchanged; no injected retry.
function instrument(pool: Pool): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key !== 'connect') {
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return async () => {
      const start = performance.now();
      const entry: Acquisition = { elapsed_ms: 0, queued_at_entry: target.waitingCount, busy_at_entry: target.totalCount - target.idleCount };
      try {
        const client = await target.connect();
        const pid = (client as PoolClient & { processID: number }).processID;
        entry.pid = pid;
        return new Proxy(client, { get(connection, property) {
          if (property !== 'query') {
            const value = Reflect.get(connection, property);
            return typeof value === 'function' ? value.bind(connection) : value;
          }
          return async (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text: string }).text);
            const kind = text.trim().split(/\s+/)[0].toUpperCase();
            const started = performance.now();
            const query: QueryMeasure = { kind, pid, elapsed_ms: 0 };
            try { return await Reflect.apply(connection.query, connection, args); }
            catch (error) { query.error = errorRecord(error); throw error; }
            finally { query.elapsed_ms = performance.now() - started; queries.push(query); }
          };
        } });
      } catch (error) { entry.error = errorRecord(error); throw error; }
      finally { entry.elapsed_ms = performance.now() - start; acquisitions.push(entry); }
    };
  } });
}
async function checkout(input: Input): Promise<Reply> {
  const slug = `e03-${input.tenant}`;
  const items = [{ productId: input.product, quantity: 1 }];
  const expectedPricing = createCartPricingPreview({ products, cartItems: items, now: new Date() });
  if (!expectedPricing.ok) throw new Error('Invalid fixture pricing');
  const request = new Request(`http://e03.invalid/api/c/${slug}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: input.operationId, studentId: createSignedStudentQr({
      tenantId: tenants[input.identity ?? input.tenant], studentId: input.student }), items, expectedPricing }) });
  const start = performance.now();
  try {
    const response = await POST(request, { params: Promise.resolve({ slug, path: ['checkout'] }) });
    return { input, status: response.status, body: await response.json(), elapsed_ms: performance.now() - start };
  } catch (error) {
    return { input, status: null, body: {}, elapsed_ms: performance.now() - start, error: errorRecord(error) };
  }
}
async function snapshot(): Promise<State> {
  const state: State = {};
  for (const table of tables) state[table] = (await db().owner.query(
    `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row);
  return state;
}
async function isolation(label: string) {
  const before = await snapshot();
  const denials = await Promise.all([0, 1].map(tenant => checkout({ tenant, identity: 1 - tenant,
    operationId: randomUUID(), student: 'S0', product: 'P0' })));
  expect(denials.map(r => r.status)).toEqual([400, 400]);
  const probes = [];
  for (const [index, tenant] of tenants.entries()) {
    probes.push(await withTenantTransaction(tenant, async tx => {
      const own = (await tx.execute(sql`SELECT count(*)::int AS n FROM accounts`)).rows;
      const hidden = (await tx.execute(sql`SELECT * FROM accounts WHERE tenant_id=${tenants[(index + 1) % 3]}`)).rows;
      const write = (await tx.execute(sql`UPDATE accounts SET balance=0 WHERE tenant_id=${tenants[(index + 1) % 3]} RETURNING student_id`)).rows;
      expect(own).toEqual([{ n: 16 }]); expect(hidden).toEqual([]); expect(write).toEqual([]);
      return { tenant, own, hidden, write };
    }));
  }
  const after = await snapshot();
  expect(after).toEqual(before);
  event('isolation', { label, denials, probes, before_sha256: hash(before), after_sha256: hash(after), unchanged: true });
}
async function reconcile(before: State, replies: Reply[], label: string) {
  const after = await snapshot();
  const successful = new Map<string, Reply>();
  for (const reply of replies.filter(r => r.status === 200)) {
    const key = `${reply.input.tenant}:${reply.input.operationId}`;
    if (successful.has(key)) expect(reply.body).toEqual(successful.get(key)!.body);
    successful.set(key, reply);
  }
  const count = successful.size;
  for (const table of ['operations', 'transactions', 'transaction_items', 'inventory_ledger', 'audit_events']) expect(after[table]).toHaveLength(count);
  for (const reply of successful.values()) {
    const tenant = tenants[reply.input.tenant];
    expect(reply.body).toMatchObject({ ok: true, studentId: reply.input.student, totalAmount: 10 });
    const tx = after.transactions.filter(r => r.tenant_id === tenant && r.operation_id === reply.input.operationId);
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ transaction_id: reply.body.transactionId, kind: 'CHECKOUT', balance_delta: -10,
      balance_before: reply.body.balanceBefore, balance_after: reply.body.balanceAfter, student_id: reply.input.student });
    const operation = after.operations.filter(r => r.tenant_id === tenant && r.operation_id === reply.input.operationId);
    expect(operation).toHaveLength(1);
    expect(operation[0]).toMatchObject({ status: 'SUCCEEDED', payload_hash: tx[0].operation_hash, result_snapshot: reply.body, attempt_count: 1 });
    const item = after.transaction_items.filter(r => r.tenant_id === tenant && r.transaction_id === reply.body.transactionId);
    const ledger = after.inventory_ledger.filter(r => r.tenant_id === tenant && r.transaction_id === reply.body.transactionId);
    const audit = after.audit_events.filter(r => r.tenant_id === tenant && r.operation_id === reply.input.operationId);
    expect(item).toHaveLength(1); expect(ledger).toHaveLength(1); expect(audit).toHaveLength(1);
    expect(item[0]).toMatchObject({ product_id_snapshot: reply.input.product, total_quantity: 1, final_total: 10 });
    expect(ledger[0]).toMatchObject({ product_id: reply.input.product, quantity_delta: -1, reason: 'CHECKOUT' });
    expect(audit[0]).toMatchObject({ event_type: 'CHECKOUT_COMPLETED', entity_type: 'TRANSACTION', entity_id: reply.body.transactionId,
      redacted_details: { itemCount: 1, studentId: reply.input.student, totalAmount: 10 } });
  }
  for (const account of after.accounts) {
    const original = before.accounts.find(r => r.tenant_id === account.tenant_id && r.student_id === account.student_id)!;
    const chain = after.transactions.filter(r => r.tenant_id === account.tenant_id && r.student_id === account.student_id)
      .sort((a, b) => Number(b.balance_before) - Number(a.balance_before));
    let balance = Number(original.balance);
    for (const tx of chain) { expect(tx.balance_before).toBe(balance); balance += Number(tx.balance_delta); expect(tx.balance_after).toBe(balance); }
    expect(account.balance).toBe(balance); expect(balance).toBeGreaterThanOrEqual(0);
    expect(Number(account.version)).toBe(Number(original.version) + chain.length);
  }
  for (const product of after.products) {
    const original = before.products.find(r => r.tenant_id === product.tenant_id && r.product_id === product.product_id)!;
    const chain = after.inventory_ledger.filter(r => r.tenant_id === product.tenant_id && r.product_id === product.product_id)
      .sort((a, b) => Number(b.stock_before) - Number(a.stock_before));
    let stock = Number(original.stock);
    for (const row of chain) { expect(row.stock_before).toBe(stock); stock += Number(row.quantity_delta); expect(row.stock_after).toBe(stock); }
    expect(product.stock).toBe(stock); expect(stock).toBeGreaterThanOrEqual(0);
    expect(Number(product.version)).toBe(Number(original.version) + chain.length);
  }
  for (const table of tables) {
    const sentinel = (rows: Row[]) => rows.filter(r => (table === 'tenants' ? r.id : r.tenant_id) === tenants[2]);
    expect(sentinel(after[table])).toEqual(sentinel(before[table]));
  }
  for (const table of ['tenants', 'students', 'promotions', 'promotion_products', 'adjustments']) expect(after[table]).toEqual(before[table]);
  event('invariants', { label, passed: true, unique_successes: count, duplicate_success_responses: replies.filter(r => r.status === 200).length - count,
    before, after, before_sha256: hash(before), after_sha256: hash(after),
    checks: ['response-operation-hash-result-binding', 'one-tx-item-ledger-audit-per-operation', 'account-chain-and-version',
      'stock-chain-and-version', 'no-negative-resource', 'no-pending-or-orphan-operation', 'sentinel-tenant-unchanged', 'noncheckout-tables-unchanged'] });
  return after;
}
async function monitor(samples: Sample[], stop: () => boolean) {
  const start = performance.now();
  while (!stop()) {
    const queryStart = performance.now();
    const pool = db().runtime;
    const sample: Sample = { elapsed_ms: queryStart - start, query_elapsed_ms: 0,
      pool_total: pool.totalCount, pool_idle: pool.idleCount, pool_waiting: pool.waitingCount, backends: [] };
    sample.backends = (await db().owner.query(`SELECT pid,state,wait_event_type,wait_event,
      pg_blocking_pids(pid) AS blockers, EXTRACT(EPOCH FROM (clock_timestamp()-query_start))*1000 AS query_age_ms,
      CASE WHEN query LIKE '%INSERT INTO operations%' THEN 'operation-claim'
        WHEN query LIKE '%FOR UPDATE%' THEN 'resource-lock' ELSE split_part(ltrim(query),' ',1) END AS query_kind
      FROM pg_stat_activity WHERE datname=current_database() AND usename='app_runtime' ORDER BY pid`)).rows;
    sample.query_elapsed_ms = performance.now() - queryStart;
    samples.push(sample);
    await pause(10);
  }
}
async function load(inputs: Input[], concurrency: number, label: string) {
  acquisitions = []; queries = [];
  const samples: Sample[] = [];
  let stopped = false, cursor = 0, inflight = 0, peak = 0;
  const replies: Reply[] = [];
  const watch = monitor(samples, () => stopped);
  const start = performance.now();
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= inputs.length) return;
        inflight++; peak = Math.max(peak, inflight);
        try { replies[index] = await checkout(inputs[index]); } finally { inflight--; }
      }
    }));
  } finally { stopped = true; await watch; }
  const elapsed_ms = performance.now() - start;
  const sqlErrors = queries.filter(q => q.error);
  const outcome = Object.fromEntries([...new Set(replies.map(r => String(r.status)))].map(status => [status, replies.filter(r => String(r.status) === status).length]));
  event('measurement', { label, elapsed_ms, peak_inflight: peak, throughput_responses_per_second: replies.length / (elapsed_ms / 1000),
    latency_ms: distribution(replies.map(r => r.elapsed_ms)), latency_by_status_ms: Object.fromEntries(Object.keys(outcome)
      .map(status => [status, distribution(replies.filter(r => String(r.status) === status).map(r => r.elapsed_ms))])),
    transaction_acquisition_ms: distribution(acquisitions.map(a => a.elapsed_ms)), outcome, sqlErrors,
    transaction_commands: Object.fromEntries(['BEGIN', 'COMMIT', 'ROLLBACK'].map(kind => [kind, queries.filter(q => q.kind === kind && !q.error).length])),
    samples, acquisitions, queries, replies });
  expect(db().runtime.waitingCount).toBe(0);
  expect(db().runtime.idleCount).toBe(db().runtime.totalCount);
  const settled = (await db().owner.query(`SELECT pid,state,xact_start,wait_event_type,pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity WHERE datname=current_database() AND usename='app_runtime' ORDER BY pid`)).rows;
  expect(settled.every(row => row.state === 'idle' && row.xact_start === null && row.blockers.length === 0)).toBe(true);
  event('settled', { label, pool_waiting: db().runtime.waitingCount, backends: settled, passed: true });
  return { replies, samples, sqlErrors };
}

suite('E-03 bounded native application checkout load', () => {
  afterEach(async () => {
    destination.pool = undefined;
    vi.unstubAllEnvs();
    if (pg) { const owned = pg; pg = undefined; event('cleanup', await owned.close()); }
  }, 60_000);
  for (const profile of profiles) it(profile.name, async () => {
    caseName = profile.name;
    expect(process.env.DATABASE_URL).toBeUndefined();
    pg = await createDisposablePostgres();
    event('owned_pg', pg.evidence);
    // All resource/timeout adjustments are local to this owned test pool.
    pg.runtime.options.max = profile.pool;
    pg.runtime.options.connectionTimeoutMillis = 2000;
    pg.runtime.options.idleTimeoutMillis = 60_000;
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    vi.stubEnv('STUDENT_QR_ACTIVE_KEY_ID', 'e03');
    vi.stubEnv('STUDENT_QR_SIGNING_KEYS', JSON.stringify({ e03: randomBytes(32).toString('base64url') }));
    await pg.owner.query('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
    for (const [i, tenant] of tenants.entries()) {
      await pg.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$2,'ACTIVE')", [tenant, `e03-${i}`]);
      await pg.owner.query(`INSERT INTO students(tenant_id,student_id,name,status)
        SELECT $1,'S'||n,'synthetic-'||n,'ACTIVE' FROM generate_series(0,15) n`, [tenant]);
      await pg.owner.query(`INSERT INTO accounts(tenant_id,student_id,balance)
        SELECT $1,'S'||n,100000 FROM generate_series(0,15) n`, [tenant]);
      await pg.owner.query(`INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,sort_order)
        SELECT $1,'P'||n,'synthetic-'||n,10,1000,true,n FROM generate_series(0,15) n`, [tenant]);
    }
    const warmed = await Promise.all(Array.from({ length: profile.pool }, () => db().runtime.connect()));
    try {
      for (const client of warmed) await client.query(`SET lock_timeout='${profile.lock_ms}ms'; SET statement_timeout='${profile.statement_ms}ms'`);
      const identities = await Promise.all(warmed.map(client => client.query(`SELECT pg_backend_pid() AS pid,current_user,rolsuper,rolbypassrls,
        current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout
        FROM pg_roles WHERE rolname=current_user`)));
      const rows = identities.map(r => r.rows[0]);
      expect(new Set(rows.map(r => r.pid)).size).toBe(profile.pool);
      expect(rows.every(r => r.current_user === 'app_runtime' && !r.rolsuper && !r.rolbypassrls)).toBe(true);
      event('configuration', { profile, identities: rows, server: (await db().owner.query(`SELECT current_setting('max_connections') AS max_connections,
        current_setting('shared_buffers') AS shared_buffers,current_setting('fsync') AS fsync`)).rows,
        instrumentation: '10ms target polling plus real query duration; transaction connect+query pass-through proxy; pool directory acquisitions sampled only; nearest-rank quantiles; no HTTP/browser' });
    } finally { warmed.forEach(client => client.release()); }
    pg.runtime.options.connectionTimeoutMillis = profile.acquisition_ms;
    destination.pool = instrument(pg.runtime);
    await isolation('before');
    const before = await snapshot();
    const ids = Array.from({ length: profile.count }, () => randomUUID());
    const timeout = profile.mode.endsWith('timeout');
    const inputs: Input[] = Array.from({ length: profile.count }, (_, i) => {
      const group = profile.mode === 'duplicate' ? Math.floor(i / 8) : Math.floor(i / 2);
      return { tenant: timeout ? 0 : i % 2, operationId: ids[group],
        student: `S${timeout || profile.mode === 'hot' ? 0 : group % 16}`,
        product: `P${timeout || profile.mode === 'hot' ? 0 : group % 16}` };
    });
    let gate: PoolClient | undefined;
    let run: Awaited<ReturnType<typeof load>>;
    try {
      if (timeout) {
        gate = await pg.owner.connect(); await gate.query('BEGIN');
        await gate.query("SELECT * FROM accounts WHERE tenant_id=$1 AND student_id='S0' FOR UPDATE", [tenants[0]]);
        event('held_lock', { pid: (await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, resource: 'A/S0 account', release: 'after bounded attempts settle' });
      }
      run = await load(inputs, profile.concurrency, 'primary');
    } finally { if (gate) { await gate.query('ROLLBACK'); gate.release(); } }
    if (timeout) {
      expect(run.replies.every(r => r.status !== 200)).toBe(true);
      expect(run.sqlErrors.some(q => q.error?.code === (profile.mode === 'lock-timeout' ? '55P03' : '57014'))).toBe(true);
      expect(run.samples.some(s => s.backends.some(r => r.wait_event_type === 'Lock'))).toBe(true);
      expect(await snapshot()).toEqual(before);
      await reconcile(before, run.replies, 'timeout-no-effects');
      // Same operation IDs after an acknowledged rollback, not blind lost-COMMIT replay.
      pg.runtime.options.connectionTimeoutMillis = 2000;
      const recovery = await load(inputs, 4, 'recovery');
      expect(recovery.replies.every(r => r.status === 200)).toBe(true);
      run = recovery;
    } else expect(run.replies.every(r => r.status === 200)).toBe(true);
    expect(run.samples.every(s => s.pool_total <= profile.pool)).toBe(true);
    const committed = await reconcile(before, run.replies, 'committed');
    const replayInputs = [...new Map(inputs.map(i => [`${i.tenant}:${i.operationId}`, i])).values()].slice(0, 16);
    const replays = await load(replayInputs, Math.min(8, profile.pool), 'late-replay');
    expect(replays.replies.every(r => r.status === 200)).toBe(true);
    for (const reply of replays.replies) expect(reply.body).toEqual(run.replies.find(r =>
      r.input.tenant === reply.input.tenant && r.input.operationId === reply.input.operationId)!.body);
    const conflicts = await Promise.all(replayInputs.slice(0, 4).map(input => checkout({ ...input, product: input.product === 'P0' ? 'P1' : 'P0' })));
    expect(conflicts.map(r => [r.status, r.body.code])).toEqual(Array(conflicts.length).fill([409, 'OPERATION_CONFLICT']));
    expect(await snapshot()).toEqual(committed);
    event('replay_no_effects', { changed_payload: conflicts, before_sha256: hash(committed), after_sha256: hash(await snapshot()), passed: true });
    await isolation('after');
  }, 90_000);
});
