import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));
let harness: PgliteDatabaseHarness;
const USER = '20000000-0000-4000-8000-000000000019';
const RECEIPT = '30000000-0000-4000-8000-000000000019';
const HASH = 'a'.repeat(64);
beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
  await harness.database.query("INSERT INTO users (id,google_subject,canonical_email) VALUES ($1,'owner-subject','owner@example.invalid')", [USER]);
  for (const tenant of [harness.tenantOneId, harness.tenantTwoId]) {
    await harness.database.query("INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [tenant, USER]);
    await harness.database.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1", [tenant]);
    await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status,source_fingerprint) VALUES ($1,'job','READY',$2)", [tenant, HASH]);
    await harness.database.query(`INSERT INTO migration_sources (tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
      VALUES ($1,'job','sheet','GOOGLE_SHEETS',$2,$3)`, [tenant, `external-${tenant}`, HASH]);
  }
  // Deliberately grant storage access to a NON-BYPASS role. This is not an authority adapter.
  await harness.database.exec('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime');
});
afterEach(async () => { await harness?.close(); });

function record(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: harness.tenantOneId, receipt_id: RECEIPT, job_id: 'job', source_id: 'sheet',
    provider: 'GOOGLE_SHEETS', external_source_id: `external-${harness.tenantOneId}`,
    actor_user_id: USER, actor_subject: 'owner-subject', action: 'START_FREEZING_APPROVAL',
    expected_status: 'READY', expected_state_version: '1', source_fingerprint: HASH,
    issued_at_ms: '1000000', expires_at_ms: '1060000', issuer_digest: HASH, content_digest: HASH,
    final_sheet_digest: null, final_redis_digest: null, final_report_digest: null, ...overrides,
  };
}
async function insertRow(overrides: Record<string, unknown> = {}) {
  const row = record(overrides);
  return harness.database.query(`INSERT INTO migration_authority_receipts (${Object.keys(row).join(',')})
    VALUES (${Object.keys(row).map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

describe('NON-AUTHORITY receipt storage: every production migration', () => {
  it('has durable receipt and replay relations', async () => {
    const { rows } = await harness.database.query("SELECT to_regclass('migration_authority_receipts') AS receipts, to_regclass('migration_authority_replays') AS replays");
    expect(rows[0]).toEqual({ receipts: 'migration_authority_receipts', replays: 'migration_authority_replays' });
  });
  it('stores preparatory approval without nonexistent final capture hashes', async () => {
    await insertRow();
    expect((await harness.database.query('SELECT * FROM migration_authority_receipts')).rows).toHaveLength(1);
  });
  it('requires all final hashes only for activation approval', async () => {
    await expect(insertRow({ action: 'ACTIVATE_APPROVAL', expected_status: 'FINAL_IMPORT' })).rejects.toThrow();
    await insertRow({ action: 'ACTIVATE_APPROVAL', expected_status: 'FINAL_IMPORT', final_sheet_digest: HASH, final_redis_digest: HASH, final_report_digest: HASH });
  });
  it.each([
    { action: 'FREEZING_CONSENT', final_sheet_digest: HASH }, { action: 'START_FREEZING_APPROVAL', final_report_digest: HASH },
    { action: 'ACTIVATE' }, { expected_state_version: '0' }, { expected_state_version: '9007199254740992' },
    { expires_at_ms: '1000000' }, { expires_at_ms: '1600001' }, { content_digest: 'secret-token' },
    { source_fingerprint: 'b' }, { issuer_digest: '' }, { actor_subject: ' owner-subject' },
    { job_id: 'other-job' }, { source_id: 'other-source' }, { actor_user_id: '20000000-0000-4000-8000-000000000099' },
  ])('rejects malformed or cross-binding SQL receipt %j', async (patch) => {
    await expect(insertRow(patch)).rejects.toThrow(/check constraint|foreign key constraint/);
  });
  it('makes receipts append-only even for identical UPDATE and DELETE', async () => {
    await insertRow();
    await expect(harness.database.exec('UPDATE migration_authority_receipts SET content_digest=content_digest')).rejects.toThrow('immutable');
    await expect(harness.database.exec('DELETE FROM migration_authority_receipts')).rejects.toThrow('immutable');
  });
  it('forces tenant RLS for receipt reads and writes with a real non-bypass role', async () => {
    await insertRow();
    await harness.database.exec('SET ROLE app_runtime');
    expect((await harness.database.query('SELECT * FROM migration_authority_receipts')).rows).toEqual([]);
    await expect(insertRow({ receipt_id: '30000000-0000-4000-8000-000000000020' })).rejects.toThrow('row-level security');
    await harness.database.query("SELECT set_config('app.tenant_id',$1,false)", [harness.tenantTwoId]);
    expect((await harness.database.query('SELECT * FROM migration_authority_receipts')).rows).toEqual([]);
    await harness.database.query("SELECT set_config('app.tenant_id',$1,false)", [harness.tenantOneId]);
    expect((await harness.database.query('SELECT * FROM migration_authority_receipts')).rows).toHaveLength(1);
  });
});

async function fresh(patch: Record<string, unknown> = {}) {
  const { rows } = await harness.database.query<{ now: string }>("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now");
  return { ...record(), issued_at_ms: String(BigInt(rows[0].now) - BigInt(1000)),
    expires_at_ms: String(BigInt(rows[0].now) + BigInt(60000)), replay_digest: HASH, ...patch };
}
async function storage(runTransaction = harness.runTenantTransaction) {
  const { createNonAuthorityReceiptStorage } = await import('./authorityReceiptStorage');
  return createNonAuthorityReceiptStorage({ tenantId: harness.tenantOneId, runTransaction });
}
async function stored() {
  return Promise.all(['migration_authority_receipts', 'migration_authority_replays'].map(async (table) =>
    (await harness.database.query(`SELECT * FROM ${table}`)).rows));
}
describe('internal consistency storage, not an approval capability', () => {
  it('atomically archives exact bindings without changing jobs or sources', async () => {
    const before = (await harness.database.query('SELECT * FROM migration_jobs')).rows;
    const input = await fresh(); const store = await storage();
    expect(await store.append(input)).toEqual({ storage: 'NON_AUTHORITY', receiptId: RECEIPT });
    expect(await store.recover(input)).toEqual({ storage: 'NON_AUTHORITY', receiptId: RECEIPT });
    expect((await stored()).map((rows) => rows.length)).toEqual([1, 1]);
    expect((await harness.database.query('SELECT * FROM migration_jobs')).rows).toEqual(before);
  });
  it.each([
    { expected_state_version: '2' }, { expected_status: 'FINAL_IMPORT' }, { source_fingerprint: 'b'.repeat(64) },
    { external_source_id: 'different' }, { source_id: 'missing' }, { actor_subject: 'different' },
    { actor_user_id: '20000000-0000-4000-8000-000000000099' }, { issued_at_ms: '1000000', expires_at_ms: '1060000' },
    { issued_at_ms: '9007199254000000', expires_at_ms: '9007199254060000' },
    { replay_digest: 'raw-secret' }, { token: 'raw-secret' }, { expected_state_version: '01' },
  ])('refuses stale or malformed fresh input %j without writes', async (patch) => {
    await expect((await storage()).append(await fresh(patch))).rejects.toThrow('Receipt storage refused.');
    expect(await stored()).toEqual([[], []]);
  });
  it('rejects removed membership and mismatched tenant', async () => {
    await harness.database.exec('DELETE FROM tenant_memberships');
    const store = await storage();
    await expect(store.append(await fresh())).rejects.toThrow('Receipt storage refused.');
    await expect(store.append(await fresh({ tenant_id: harness.tenantTwoId }))).rejects.toThrow('Receipt storage refused.');
    expect(await stored()).toEqual([[], []]);
  });
  it('consumes globally once including identical retries and other tenants', async () => {
    const input = await fresh(); const store = await storage(); await store.append(input);
    await expect(store.append(input)).rejects.toThrow('Receipt storage refused.');
    const { createNonAuthorityReceiptStorage } = await import('./authorityReceiptStorage');
    const other = createNonAuthorityReceiptStorage({ tenantId: harness.tenantTwoId, runTransaction: harness.runTenantTransaction });
    await expect(other.append({ ...input, tenant_id: harness.tenantTwoId, external_source_id: `external-${harness.tenantTwoId}` })).rejects.toThrow('Receipt storage refused.');
    expect((await stored()).map((rows) => rows.length)).toEqual([1, 1]);
  });
  it.each(['migration_authority_receipts', 'migration_authority_replays'])('rolls back silently suppressed %s insertion', async (table) => {
    await harness.database.exec(`CREATE FUNCTION suppress_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER suppress_receipt BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_receipt();`);
    await expect((await storage()).append(await fresh())).rejects.toThrow('Receipt storage refused.');
    expect(await stored()).toEqual([[], []]);
  });
  it('rolls both rows back on failure after exact readback', async () => {
    const store = await storage((tenant, callback) => harness.runTenantTransaction(tenant, async (tx) => {
      await callback(tx); throw new Error('local failure');
    }));
    await expect(store.append(await fresh())).rejects.toThrow('Receipt storage refused.');
    expect(await stored()).toEqual([[], []]);
  });
  it('recovers uncertain committed archival evidence, never replays or grants current permission', async () => {
    const input = await fresh();
    const uncertain = await storage(async (tenant, callback) => {
      await harness.runTenantTransaction(tenant, callback); throw new Error('lost commit response');
    });
    await expect(uncertain.append(input)).rejects.toThrow('Receipt storage refused.');
    await harness.database.exec("UPDATE migration_jobs SET status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now(); DELETE FROM tenant_memberships");
    const store = await storage();
    expect(await store.recover(input)).toEqual({ storage: 'NON_AUTHORITY', receiptId: RECEIPT });
    for (const key of Object.keys(input)) {
      await expect(store.recover({ ...input, [key]: key.startsWith('final_') ? HASH : 'different' })).rejects.toThrow('Receipt storage refused.');
    }
    await expect(store.recover({ ...input, receipt_id: '30000000-0000-4000-8000-000000000099' })).rejects.toThrow('Receipt storage refused.');
    await expect(store.append(input)).rejects.toThrow('Receipt storage refused.');
  });
  it('makes replay rows immutable and invisible across tenants', async () => {
    await (await storage()).append(await fresh());
    await expect(harness.database.exec('UPDATE migration_authority_replays SET replay_digest=replay_digest')).rejects.toThrow('immutable');
    await expect(harness.database.exec('DELETE FROM migration_authority_replays')).rejects.toThrow('immutable');
    await harness.database.exec('SET ROLE app_runtime');
    await harness.database.query("SELECT set_config('app.tenant_id',$1,false)", [harness.tenantTwoId]);
    expect((await harness.database.query('SELECT * FROM migration_authority_replays')).rows).toEqual([]);
  });
});

 it('matches Drizzle receipt/replay columns and named constraints to production DDL', async () => {
  const schema = await import('@/server/db/schema');
  const { getTableConfig } = await import('drizzle-orm/pg-core');
  for (const [name, table] of Object.entries({ migration_authority_receipts: schema.migrationAuthorityReceipts,
    migration_authority_replays: schema.migrationAuthorityReplays })) {
    expect(table).toBeDefined();
    const config = getTableConfig(table);
    const { rows } = await harness.database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position", [name]);
    expect(config.columns.map((col) => col.name)).toEqual(rows.map((row) => row.column_name));
    const constraints = await harness.database.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('c','f','p','u') ORDER BY conname", [name]);
    expect([...config.checks.map((v) => v.name), ...config.foreignKeys.map((v) => v.getName()),
      ...config.primaryKeys.map((v) => v.getName()), ...config.uniqueConstraints.map((v) => v.name)].sort())
      .toEqual(constraints.rows.map((row) => row.conname));
  }
});

describe('additional action and archival regression coverage', () => {
  it.each(['FREEZING_CONSENT', 'ACTIVATE_APPROVAL'])('stores %s as non-authority, preserving final bindings', async (action) => {
    const patch: Record<string, unknown> = { action };
    if (action === 'ACTIVATE_APPROVAL') {
      await harness.database.exec("UPDATE migration_jobs SET status='FREEZING',state_version=2,updated_at=now(); UPDATE migration_jobs SET status='FINAL_IMPORT',state_version=3,updated_at=now()");
      Object.assign(patch, { expected_status: 'FINAL_IMPORT', expected_state_version: '3',
        final_sheet_digest: 'b'.repeat(64), final_redis_digest: 'c'.repeat(64), final_report_digest: 'd'.repeat(64) });
    }
    const input = await fresh(patch); const store = await storage();
    expect(await store.append(input)).toEqual({ storage: 'NON_AUTHORITY', receiptId: RECEIPT });
    expect(await store.recover(input)).toEqual({ storage: 'NON_AUTHORITY', receiptId: RECEIPT });
  });
  it('archivally reads expired SQL records without claiming fresh authorization', async () => {
    await insertRow();
    await harness.database.query('INSERT INTO migration_authority_replays VALUES ($1,$2,$3)', [HASH, harness.tenantOneId, RECEIPT]);
    const store = await storage(); const input = { ...record(), replay_digest: HASH };
    expect(await store.recover(input)).toEqual({ storage: 'NON_AUTHORITY', receiptId: RECEIPT });
    await expect(store.append(input)).rejects.toThrow('Receipt storage refused.');
  });
  it('rejects getters without evaluation and detaches scalars before awaits', async () => {
    const input = await fresh(); const getter = vi.fn(() => HASH);
    Object.defineProperty(input, 'content_digest', { enumerable: true, get: getter });
    await expect((await storage()).append(input)).rejects.toThrow('Receipt storage refused.');
    expect(getter).not.toHaveBeenCalled();
    const clean = await fresh();
    const store = await storage(async (tenant, callback) => {
      clean.content_digest = 'b'.repeat(64);
      return harness.runTenantTransaction(tenant, callback);
    });
    await store.append(clean);
    expect((await stored())[0][0]).toMatchObject({ content_digest: HASH });
  });
});
