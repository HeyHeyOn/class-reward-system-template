// @vitest-environment node
// Native, synthetic PG only. No writer fence, operational source, or authority.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { hash, sqlImage, rows, type Image } from '../../../test-support/task19PublicationOracle';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { stageLegacyFinalGeneration, inspectLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const TENANT = '20000000-0000-4000-8000-000000000001';
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Final generation preparation refused.';
let db: DisposablePostgres | undefined;
afterEach(async () => { if (db) console.info('EMPTY_CATEGORY_PG_CLEANUP', JSON.stringify(await db.close())); db = undefined; });
function evidence(name: string, value: unknown) {
  const directory = '.task19-empty-category-results';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/${name}-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  console.info('TASK19_EMPTY_CATEGORY_WITNESS', JSON.stringify({ name, path, sha256: hash(value) }));
}
function acquisition(variant: 'unchanged' | 'added' | 'mixed') {
  return { redis: makeRedis({ operationBindings: [], v2Claims: [] }), sheets: makeSupportedSheets(3, tabs => {
    tabs.Promotions.rows = []; tabs.PromotionProducts.rows = [];
    if (variant !== 'mixed') tabs.Products.rows.push({ rowNumber: 3, cells: ['PX', 'Spare original', '9', '2', 'TRUE', '', '', '2'], hash: '' });
    if (variant === 'mixed') tabs.Products.rows[0].cells[1] = 'Modified candidate pencil';
    if (variant === 'added') tabs.Products.rows.push({ rowNumber: 4, cells: ['P2', 'Added candidate', '11', '3', 'TRUE', '', '', '3'], hash: '' });
  }) };
}
async function fixture(variant: Parameters<typeof acquisition>[0] = 'mixed') {
  const source = await createDisposablePostgres(); db = source;
  console.info('EMPTY_CATEGORY_PG', JSON.stringify(source.evidence));
  await source.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'empty-category','Synthetic empty category')", [TENANT]);
  const original = acquisition('unchanged');
  const manifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...original });
  expect(manifest.status).toBe('READY_FOR_IMPORT'); expect(manifest.records.promotions).toEqual([]);
  expect(manifest.records.promotion_products).toEqual([]);
  await source.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [TENANT, JOB]);
  await importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest, runTransaction: source.runTenantTransaction });
  for (const status of ['RECONCILING', 'READY']) await source.owner.query('UPDATE migration_jobs SET status=$1,state_version=state_version+1', [status]);
  const version = (await source.owner.query('SELECT state_version::text AS version FROM migration_jobs')).rows[0].version;
  const input: FinalGenerationPreparationInput = { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: version,
    originalSourceId: `sheet:${original.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
    exclusionGenerationReference: hash('UNPROVEN synthetic empty category'), original, candidate: acquisition(variant) };
  const initial = await sqlImage(source);
  expect(initial.promotions).toEqual([]); expect(initial.promotion_products).toEqual([]);
  return { source, input, initial };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const insert = `INSERT INTO promotions(tenant_id,promotion_id,name,description,type,fixed_discount,starts_at,ends_at)
  VALUES($1,'CONCURRENT','Synthetic concurrent promotion','','FIXED_DISCOUNT',1,'2026-08-31T00:00:00Z','2026-09-01T00:00:00Z') RETURNING to_jsonb(promotions) AS row`;
const metadata = `SELECT pg_backend_pid() AS pid,txid_current()::text AS xid,current_user,
  current_setting('transaction_isolation') AS isolation,current_setting('session_replication_role') AS replication,
  rolsuper,rolbypassrls,has_table_privilege(current_user,'promotions','INSERT') AS can_insert,
  has_table_privilege(current_user,'promotions','TRIGGER') AS can_install_trigger
  FROM pg_roles WHERE rolname=current_user`;
function noAuthority(image: Image) {
  expect(rows(image, 'tenants')).toMatchObject([{ id: TENANT, lifecycle: 'IMPORTING' }]);
  expect(rows(image, 'migration_jobs')).toMatchObject([{ tenant_id: TENANT, job_id: JOB, status: 'READY', state_version: 4,
    final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null, completed_at: null }]);
  for (const table of Object.keys(image).filter(table => table.startsWith('migration_full_')
    || table.startsWith('migration_authority_') || table === 'migration_local_materializations')) expect(image[table], table).toEqual([]);
}
function onlyEnvelopes(before: Image, after: Image) {
  for (const table of Object.keys(before).filter(table => table !== 'audit_events')) expect(after[table], table).toEqual(before[table]);
  const added = rows(after, 'audit_events').filter(row => !rows(before, 'audit_events').some(prior => prior.event_id === row.event_id));
  expect(added.map(row => row.event_type).sort()).toEqual(['MIGRATION_PREPARATION_CANDIDATE', 'MIGRATION_PREPARATION_ORIGINAL', 'MIGRATION_PREPARATION_PLAN']);
  for (const row of added) expect(row.redacted_details).toMatchObject({ storage: 'UNTRUSTED_PREPARATION' });
  noAuthority(after);
}
async function stage(f: Fixture, runTransaction: TenantImportTransactionRunner = f.source.runTenantTransaction) {
  return stageLegacyFinalGeneration(f.input, { runTransaction });
}
// A scheduling observer only: every product SQL statement executes unchanged.
// Stop before the first envelope INSERT: initial full graph and job checks completed.
function afterValidation(f: Fixture, hook: (tx: Parameters<Parameters<TenantImportTransactionRunner>[1]>[0], trace: string[]) => Promise<void>) {
  let reached = 0;
  const trace: string[] = [], dialect = new PgDialect();
  const run: TenantImportTransactionRunner = (tenant, callback) => f.source.runTenantTransaction(tenant, async tx => {
    const execute = tx.execute.bind(tx);
    const observed = new Proxy(tx, { get(target, key, receiver) {
      if (key !== 'execute') return Reflect.get(target, key, receiver);
      return async (query: Parameters<typeof tx.execute>[0]) => {
        const text = typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
        if (!reached && text.startsWith('INSERT INTO audit_events')) {
          reached += 1;
          expect(trace.some(statement => statement.startsWith('SELECT * FROM "promotions"') && statement.endsWith('FOR UPDATE'))).toBe(true);
          expect(trace.at(-1)).toContain('final_fingerprint,freeze_started_at,freeze_verified_at,completed_at');
          await hook(tx, trace);
        }
        const result = await execute(query); trace.push(text); return result;
      };
    } });
    return callback(observed);
  });
  return { run, trace, reached: () => reached };
}
async function outcome(action: () => Promise<unknown>) {
  return action().then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error: (error as Error).message }));
}

suite('Task19 originally empty category native freshness', () => {
  it('reach/control: real runtime INSERT works without locks; accepted validation blocks another transaction by native FK, not isolation or permissions', async () => {
    const f = await fixture();
    const writer = await f.source.runtime.connect();
    let control: unknown, blocked: unknown;
    try {
      await writer.query('BEGIN'); await writer.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      const role = (await writer.query(metadata)).rows[0];
      expect(role).toMatchObject({ current_user: 'app_runtime', isolation: 'read committed', replication: 'origin', rolsuper: false,
        rolbypassrls: false, can_insert: true, can_install_trigger: false });
      const inserted = (await writer.query(insert, [TENANT])).rows;
      const inside = (await writer.query('SELECT to_jsonb(p) AS row FROM promotions p')).rows;
      const outside = await sqlImage(f.source);
      control = { role, inserted, inside, outside };
      expect(inside).toHaveLength(1); expect(outside).toEqual(f.initial);
      await writer.query('ROLLBACK'); expect(await sqlImage(f.source)).toEqual(f.initial);
      const observer = afterValidation(f, async tx => {
        const first = (await tx.execute(sql.raw(metadata))).rows[0];
        await writer.query('BEGIN'); await writer.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
        await writer.query("SET LOCAL lock_timeout='1500ms'");
        const second = (await writer.query(metadata)).rows[0];
        expect(second.pid).not.toBe(first.pid); expect(second.xid).not.toBe(first.xid);
        const pending = writer.query(insert, [TENANT]).then(result => ({ reached: true, rows: result.rows, code: null }),
          error => ({ reached: false, rows: [], code: String(error.code), context: String(error.where) }));
        let wait: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          wait = (await f.source.owner.query(`SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
            FROM pg_stat_activity WHERE pid=$1`, [second.pid])).rows[0];
          if (wait?.wait_event_type === 'Lock') break;
          await delay(10);
        }
        const result = await pending;
        const visible = await sqlImage(f.source);
        const constraints = (await f.source.owner.query(`SELECT conname,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conrelid='promotions'::regclass AND contype='f'`)).rows;
        blocked = { first, second, wait, result, visible, constraints };
        // Persist before assertions so an unexpected scheduling/permission failure
        // cannot be mistaken for a product failure or silently lose the witness.
        evidence('native-lock-reach', { original: f.input.original, before: f.initial, control, blocked });
        await writer.query('ROLLBACK');
        expect(wait).toMatchObject({ wait_event_type: 'Lock', blockers: [first.pid] });
        expect(result).toMatchObject({ reached: false, code: '55P03' });
        expect(result).toHaveProperty('context', expect.stringContaining('FOR KEY SHARE'));
        expect(constraints).toMatchObject([{ conname: 'promotions_tenant_fk', convalidated: true, condeferrable: false, condeferred: false }]);
        expect(visible).toEqual(f.initial);
      });
      const result = await stage(f, observer.run), after = await sqlImage(f.source);
      expect(observer.reached()).toBe(1); expect(result.plan.status).toBe('DIFF_VALIDATED');
      onlyEnvelopes(f.initial, after);
      evidence('native-lock-final', { before: f.initial, after, control, blocked, result, trace: observer.trace });
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  }, 120_000);

  it('same-transaction runtime INSERT after accepted validation reaches SQL but final empty-category readback rolls it and all envelopes back', async () => {
    const f = await fixture();
    let inside: unknown;
    const observer = afterValidation(f, async tx => {
      const role = (await tx.execute(sql.raw(metadata))).rows;
      const inserted = (await tx.execute(sql`INSERT INTO promotions(tenant_id,promotion_id,name,description,type,fixed_discount,starts_at,ends_at)
        VALUES(${TENANT},'CONCURRENT','Synthetic concurrent promotion','','FIXED_DISCOUNT',1,'2026-08-31T00:00:00Z','2026-09-01T00:00:00Z')
        RETURNING to_jsonb(promotions) AS row`)).rows;
      const visible = (await tx.execute(sql`SELECT to_jsonb(p) AS row FROM promotions p WHERE tenant_id=${TENANT}`)).rows;
      inside = { role, inserted, visible };
      expect(inserted).toHaveLength(1); expect(visible).toEqual(inserted);
      expect(await sqlImage(f.source)).toEqual(f.initial);
    });
    const refused = await outcome(() => stage(f, observer.run)), after = await sqlImage(f.source);
    evidence('same-transaction-empty-refusal', { input: f.input, before: f.initial, inside, after, refused, trace: observer.trace });
    expect(observer.reached()).toBe(1); expect(refused).toEqual({ accepted: false, error: REFUSAL });
    expect(observer.trace.filter(text => text.startsWith('INSERT INTO audit_events'))).toHaveLength(3);
    expect(after).toEqual(f.initial); noAuthority(after);
    const result = await stage(f), committed = await sqlImage(f.source);
    onlyEnvelopes(f.initial, committed); expect(await stage(f)).toEqual(result); expect(await sqlImage(f.source)).toEqual(committed);
    evidence('same-transaction-rollback-retry', { before: f.initial, after: committed, result });
  }, 120_000);

  it('precommitted INSERT in an originally empty category fails closed; exact input succeeds after synthetic row removal', async () => {
    const f = await fixture(), client = await f.source.runtime.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      const role = (await client.query(metadata)).rows[0];
      const inserted = (await client.query(insert, [TENANT])).rows; await client.query('COMMIT');
      const before = await sqlImage(f.source), refused = await outcome(() => stage(f)), after = await sqlImage(f.source);
      evidence('empty-precommitted-refusal', { original: f.input.original, baseline: f.initial, role, inserted, before, after, refused });
      expect(rows(before, 'promotions')).toHaveLength(1); expect(refused).toEqual({ accepted: false, error: REFUSAL });
      expect(after).toEqual(before); noAuthority(after);
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      expect((await client.query("DELETE FROM promotions WHERE tenant_id=$1 AND promotion_id='CONCURRENT'", [TENANT])).rowCount).toBe(1);
      await client.query('COMMIT'); expect(await sqlImage(f.source)).toEqual(f.initial);
      const result = await stage(f), committed = await sqlImage(f.source);
      onlyEnvelopes(f.initial, committed); expect(await stage(f)).toEqual(result); expect(await sqlImage(f.source)).toEqual(committed);
      evidence('empty-restored-same-input', { input: f.input, before: f.initial, after: committed, result });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }, 120_000);

  it('post-COMMIT insertion is reachable, but retained PLAN is rejected on exact-input retry (no continuing fence)', async () => {
    const f = await fixture(), result = await stage(f), committed = await sqlImage(f.source);
    onlyEnvelopes(f.initial, committed);
    const client = await f.source.runtime.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      const role = (await client.query(metadata)).rows[0], inserted = (await client.query(insert, [TENANT])).rows;
      await client.query('COMMIT');
      const before = await sqlImage(f.source), refused = await outcome(() => stage(f));
      const readOnly = await outcome(() => inspectLegacyFinalGeneration(f.input, f.source.runTenantTransaction)), after = await sqlImage(f.source);
      evidence('empty-after-commit', { result, committed, role, inserted, before, refused, readOnly, after });
      expect(refused).toEqual({ accepted: false, error: REFUSAL }); expect(readOnly).toEqual(refused);
      expect(after).toEqual(before); noAuthority(after);
    } finally { await client.query('ROLLBACK'); client.release(); }
  }, 120_000);

  it.each(['unchanged', 'added'] as const)('explicit %s control retains exact envelopes and retry without authority', async variant => {
    const f = await fixture(variant), result = await stage(f), after = await sqlImage(f.source);
    expect(result.plan.status).toBe('DIFF_VALIDATED');
    expect(result.plan.changes.map(change => [change.table, change.identity, change.kind]))
      .toEqual(variant === 'added' ? [['products', '["P2"]', 'ADDED']] : []);
    onlyEnvelopes(f.initial, after);
    expect(await stage(f)).toEqual(result); expect(await inspectLegacyFinalGeneration(f.input, f.source.runTenantTransaction)).toEqual(result);
    expect(await sqlImage(f.source)).toEqual(after);
    evidence(`control-${variant}`, { input: f.input, before: f.initial, after, result });
  }, 120_000);

  // Distinct pivot: actual before-image of REMOVED PX, not PLAN append effects.
  // Runtime DML commits with all native guards intact, then the retained candidate
  // MUST be refused even though its own targets no longer include this product.
  it.each(['modified', 'deleted'] as const)('pivot: committed %s removed-product before-image invalidates retained candidate; exact restore/retry', async kind => {
    const f = await fixture(), result = await stage(f), committed = await sqlImage(f.source);
    expect(result.plan.changes.map(change => [change.table, change.identity, change.kind]))
      .toEqual([['products', '["P1"]', 'MUTATED'], ['products', '["PX"]', 'REMOVED']]);
    const originalRow = rows(committed, 'products').find(row => row.product_id === 'PX'); expect(originalRow).toBeDefined();
    const client = await f.source.runtime.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      const role = (await client.query(metadata)).rows[0];
      const changed = await client.query(kind === 'modified'
        ? "UPDATE products SET name='Drifted removed before-image' WHERE tenant_id=$1 AND product_id='PX' RETURNING to_jsonb(products) AS row"
        : "DELETE FROM products WHERE tenant_id=$1 AND product_id='PX' RETURNING to_jsonb(products) AS row", [TENANT]);
      expect(changed.rowCount).toBe(1); await client.query('COMMIT');
      const before = await sqlImage(f.source), refused = await outcome(() => stage(f));
      const readOnly = await outcome(() => inspectLegacyFinalGeneration(f.input, f.source.runTenantTransaction)), after = await sqlImage(f.source);
      evidence(`pivot-${kind}-refusal`, { input: f.input, result, baseline: committed, role, changed: changed.rows, before, refused, readOnly, after });
      expect(refused).toEqual({ accepted: false, error: REFUSAL }); expect(readOnly).toEqual(refused);
      expect(after).toEqual(before); noAuthority(after);
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      if (kind === 'modified') await client.query("UPDATE products SET name=$2 WHERE tenant_id=$1 AND product_id='PX'", [TENANT, originalRow!.name]);
      else await client.query('INSERT INTO products SELECT * FROM jsonb_populate_record(NULL::products,$1::jsonb)', [JSON.stringify(originalRow)]);
      await client.query('COMMIT'); expect(await sqlImage(f.source)).toEqual(committed);
      expect(await stage(f)).toEqual(result); expect(await sqlImage(f.source)).toEqual(committed);
      evidence(`pivot-${kind}-restored`, { before: committed, after: await sqlImage(f.source), result });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }, 120_000);
});
