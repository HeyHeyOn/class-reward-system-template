import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { QueryResult } from 'pg';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createTenantTransactionRunner, type TenantTransaction, type TransactionConnection } from '@/server/db/transaction';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { stageLegacyFinalGeneration } from './finalGeneration';
import { stageLocalMultiAddedProducts } from './localMultiAddedProductStage';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { inspectLocalMultiAddedProductGeneration, reconcileLocalMultiAddedProducts,
  type LocalMultiAddedProductReconciliationInput } from './localMultiAddedProductReconciliation';

vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Local multi-added-product reconciliation refused.';
let harness: PgliteDatabaseHarness;
let runFixture: TenantImportTransactionRunner;
let runRepeatable: TenantImportTransactionRunner;
let observed: string[];
const dialect = new PgDialect();
const acquisition = (count = 0, retainedName = 'Pencil', addedName = 'Notebook') => ({
  sheets: makeSupportedSheets(3, (tabs) => {
    tabs.Products.rows[0].cells[1] = retainedName;
    for (let index = 0; index < count; index += 1) tabs.Products.rows.push({ rowNumber: index + 3,
      cells: [`P${index + 2}`, `${addedName}${index}`, '15', '3', 'TRUE', '', 'school', String(index + 2)], hash: '' });
  }),
  redis: makeRedis({ operationBindings: [], v2Claims: [] }),
});
beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
  // Synthetic owner connection only: no new GRANT, role bypass or external DB.
  // Real SQL/constraints/transactions are exercised, but positive runtime ACL and
  // separate-connection PostgreSQL concurrency are NOT claimed by this fixture.
  const connection: TransactionConnection = {
    query: async (text, values) => await harness.database.query(text, values) as unknown as QueryResult<never>,
    release() {},
  };
  const dependencies = { pool: { connect: async () => connection },
    createDatabase: () => ({ execute: async (query: Parameters<TenantTransaction['execute']>[0]) => {
      const rendered = typeof query === 'string' ? { sql: query, params: [] } : dialect.sqlToQuery(query.getSQL());
      return harness.database.query(rendered.sql, rendered.params);
    } } as TenantTransaction),
  };
  runFixture = createTenantTransactionRunner(dependencies, { maxAttempts: 1 });
  runRepeatable = createTenantTransactionRunner(dependencies, { maxAttempts: 1, isolationLevel: 'REPEATABLE READ' });
  observed = [];
});
afterEach(async () => { await harness?.close(); });
const readOnly: TenantImportTransactionRunner = (tenantId, callback) => runFixture(tenantId, (tx) => callback(new Proxy(tx, {
  get(target, key, receiver) {
    if (key !== 'execute') return Reflect.get(target, key, receiver);
    return (query: Parameters<TenantTransaction['execute']>[0]) => {
      const text = typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
      observed.push(text);
      if (!/^\s*SELECT\b/i.test(text) || /\b(?:set_config|nextval)\s*\(/i.test(text)
        || /\b(?:migration_local_generation_reconciliation|reconciliation_results)\b/i.test(text)) {
        throw new Error('Inspector issued a forbidden statement.');
      }
      return tx.execute(query);
    };
  },
})));
async function originalFixture() {
  const original = acquisition();
  const manifest = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, ...original });
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, manifest, runTransaction: runFixture });
  await harness.database.exec("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1; UPDATE migration_jobs SET status='READY',state_version=state_version+1");
  const { rows } = await harness.database.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs');
  return { tenantId: harness.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSourceId: `sheet:${manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
    exclusionGenerationReference: 'a'.repeat(64), original, candidate: acquisition(3) };
}
type Request = Awaited<ReturnType<typeof originalFixture>>;
function binding(request: Request, generationId: string, digest?: string): LocalMultiAddedProductReconciliationInput {
  return { tenantId: request.tenantId, migrationJobId: request.migrationJobId, expectedStateVersion: request.expectedStateVersion,
    originalSourceId: request.originalSourceId, originalSnapshotId: request.originalSnapshotId, generationId,
    candidateManifestDigest: digest ?? createLegacyNormalizationManifest({ tenantId: request.tenantId, migrationJobId: JOB, ...request.candidate }).manifestDigest };
}
async function fixture(count = 3) {
  const request = await originalFixture();
  request.candidate = acquisition(count);
  // Only fixture setup calls a stage. The inspector is a separate later transaction.
  const staged = await stageLocalMultiAddedProducts(request, { runTransaction: runFixture });
  return { request, input: binding(request, staged.generationId) };
}
const inspect = (input: LocalMultiAddedProductReconciliationInput) => reconcileLocalMultiAddedProducts(input, { runTransaction: readOnly });
async function snapshot() {
  const { rows } = await harness.database.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result: Record<string, string> = {};
  for (const { tablename } of rows) {
    const actual = await harness.database.query(`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM "${tablename.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`);
    result[tablename] = sha256(canonicalJson(actual.rows));
  }
  return result;
}
async function refused(input: LocalMultiAddedProductReconciliationInput) {
  const before = await snapshot();
  await expect(inspect(input)).rejects.toThrow(REFUSAL);
  expect(await snapshot()).toEqual(before);
}
async function corrupt(table: 'migration_final_targets' | 'migration_final_source_records' | 'migration_final_generations' | 'audit_events', statement: string) {
  // Owner-only corrupt persisted bytes in this disposable fixture. Restore every
  // immutable guard before calling the inspector; never change FK/CHECK/UNIQUE.
  await harness.database.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_immutable`);
  try { await harness.database.exec(statement); }
  finally { await harness.database.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_immutable`); }
}
async function aggregate(input: LocalMultiAddedProductReconciliationInput, status = 'MATCH') {
  await harness.database.query(`INSERT INTO migration_local_generation_reconciliation
    (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,category,expected_count,actual_count,delta,status)
    VALUES ($1,$2,$3,$4,$5,$6,'PRODUCTS',3,3,0,$7)`,
  [input.tenantId, input.migrationJobId, input.generationId, input.originalSourceId, input.originalSnapshotId, input.candidateManifestDigest, status]);
}
// Build archived adversarial/unsupported generations through actual preparation,
// then persist their independent envelopes and row sets without the stage's guard.
// Self-consistent hashes are deliberately NOT treated as source authenticity.
async function archived(request: Request, edit?: (candidate: Record<string, unknown>, plan: Record<string, unknown>) => void) {
  const prepared = await stageLegacyFinalGeneration(request, { runTransaction: runFixture });
  const read = async (id: string) => (await harness.database.query<{ redacted_details: Record<string, unknown> }>(
    'SELECT redacted_details FROM audit_events WHERE tenant_id=$1 AND event_id=$2', [request.tenantId, id])).rows[0].redacted_details;
  const candidate = await read(prepared.candidateGenerationId);
  const plan = await read(prepared.planId);
  edit?.(candidate, plan);
  const manifest = candidate.manifest as LegacyNormalizationManifest;
  const generationId = `preparation:candidate:${sha256(canonicalJson(candidate))}`;
  plan.candidateGenerationId = generationId;
  plan.candidateManifestDigest = manifest.manifestDigest;
  const planId = `preparation:plan:${sha256(canonicalJson(plan))}`;
  for (const [id, kind, details] of [[generationId, 'CANDIDATE', candidate], [planId, 'PLAN', plan]] as const) {
    await harness.database.query(`INSERT INTO audit_events (tenant_id,event_id,job_id,event_type,redacted_details)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (tenant_id,event_id) DO NOTHING`,
    [request.tenantId, id, JOB, `MIGRATION_PREPARATION_${kind}`, JSON.stringify(details)]);
  }
  await harness.database.query(`INSERT INTO migration_final_generations
    (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_event_id,plan_event_id,
      candidate_manifest_digest,candidate_sheet_digest,expected_state_version)
    VALUES ($1,$2,$3,$4,$5,$3,$6,$7,$8,$9::bigint)`, [request.tenantId, JOB, generationId,
    request.originalSourceId, request.originalSnapshotId, planId, manifest.manifestDigest, manifest.sourceArtifacts.sheets.digest, request.expectedStateVersion]);
  const original = createLegacyNormalizationManifest({ tenantId: request.tenantId, migrationJobId: JOB, ...request.original });
  for (const product of manifest.records.products.filter((row) => !original.records.products.some((prior) => prior.productId === row.productId))) {
    const source = manifest.sourceRecords.find((row) => row.targetTable === 'products' && row.targetId === product.productId)!;
    if (source.source.kind !== 'SHEET') throw new Error('synthetic fixture');
    const recordId = `local-final-record:${sha256(canonicalJson([request.tenantId, JOB, generationId, source.source.rowHash, product.productId]))}`;
    await harness.database.query(`INSERT INTO migration_final_source_records
      (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
      VALUES ($1,$2,$3,$4,$5,$6,'Products',$7,$8::jsonb,$9::jsonb)`, [request.tenantId, JOB, generationId, recordId,
      source.source.rowNumber, source.source.rowHash, product.productId, JSON.stringify(source.redactedSourceRecord), JSON.stringify(source.canonicalRecord)]);
    await harness.database.query(`INSERT INTO migration_final_targets
      (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target) VALUES ($1,$2,$3,$4,'products',$5,$6::jsonb)`,
    [request.tenantId, JOB, generationId, recordId, product.productId, JSON.stringify(product)]);
  }
  return binding(request, generationId, manifest.manifestDigest);
}

describe('independent persisted multi-ADDED LOCAL_CANDIDATE inspector', () => {
  it.each([2, 3])('recomputes %i additions in a separate read-only transaction and retains every row/xmin', async (count) => {
    const { input } = await fixture(count);
    const before = await snapshot();
    const result = await inspect(input);
    expect(result).toEqual({ ...input, authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
      activationAllowed: false, complete: false, scope: 'MULTI_ADDED_PRODUCTS', expectedCount: count,
      sourceCount: count, targetCount: count, delta: 0, status: 'MATCH' });
    expect(await inspect(input)).toEqual(result);
    expect(await snapshot()).toEqual(before);
    expect(observed.some((text) => /FROM migration_final_source_records/.test(text))).toBe(true);
    expect(observed.some((text) => /FROM migration_final_targets/.test(text))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/credential|acquisition|canonical_record|redacted_record|Notebook/i);
  });
  it.each(['MATCH', 'MISMATCH', 'BLOCKED'])('ignores a stored %s aggregate, including fabricated count three', async (status) => {
    const { input } = await fixture(2);
    const result = await inspect(input);
    await aggregate(input, status);
    const before = await snapshot();
    expect(await inspect(input)).toEqual(result);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['all', 'pair', 'target'])('refuses missing %s rows despite fake MATCH and never heals', async (kind) => {
    const { input } = await fixture();
    await aggregate(input);
    await corrupt('migration_final_targets', `DELETE FROM migration_final_targets${kind === 'all' ? '' : " WHERE target_id='P3'"}`);
    if (kind !== 'target') await corrupt('migration_final_source_records',
      `DELETE FROM migration_final_source_records${kind === 'all' ? '' : " WHERE source_record_id='P3'"}`);
    await refused(input);
  });
  it.each([false, true])('refuses a legal extra source (extra target: %s), including reused row/hash', async (withTarget) => {
    const { input } = await fixture();
    await harness.database.exec(`INSERT INTO migration_final_source_records
      (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
      SELECT tenant_id,job_id,generation_id,'extra-record',source_row_number,source_row_hash,source_collection,'P-extra',redacted_record,canonical_record
      FROM migration_final_source_records WHERE source_record_id='P2'`);
    if (withTarget) await harness.database.exec(`INSERT INTO migration_final_targets
      (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
      SELECT tenant_id,job_id,generation_id,'extra-record',target_table,'P-extra',canonical_target FROM migration_final_targets WHERE target_id='P2'`);
    await aggregate(input);
    await refused(input);
  });
  it.each([
    ['migration_final_source_records', "UPDATE migration_final_source_records SET redacted_record='{}'::jsonb WHERE source_record_id='P3'"],
    ['migration_final_source_records', "UPDATE migration_final_source_records SET canonical_record=canonical_record || '{\"extra\":true}'::jsonb WHERE source_record_id='P3'"],
    ['migration_final_source_records', "UPDATE migration_final_source_records SET source_row_number=999,source_row_hash=repeat('f',64) WHERE source_record_id='P3'"],
    ['migration_final_source_records', "UPDATE migration_final_source_records SET source_record_id='wrong' WHERE source_record_id='P3'"],
    ['migration_final_targets', "UPDATE migration_final_targets SET canonical_target=canonical_target || '{\"extra\":true}'::jsonb WHERE target_id='P3'"],
    ['migration_final_targets', "UPDATE migration_final_targets SET target_id='wrong' WHERE target_id='P3'"],
    ['migration_final_generations', "UPDATE migration_final_generations SET expected_state_version=999"],
    ['migration_final_generations', "UPDATE migration_final_generations SET candidate_sheet_digest=repeat('f',64)"],
  ] as const)('refuses same-count mismatches (%s: %s)', async (table, statement) => {
    const { input } = await fixture();
    await corrupt(table, statement);
    await refused(input);
  });
  it('refuses a same-count replacement recordId with otherwise unchanged source/target payload', async () => {
    const { input } = await fixture();
    await corrupt('migration_final_targets', "DELETE FROM migration_final_targets WHERE target_id='P3'");
    await corrupt('migration_final_source_records', "UPDATE migration_final_source_records SET record_id='other-record' WHERE source_record_id='P3'");
    await harness.database.exec(`INSERT INTO migration_final_targets
      (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
      SELECT tenant_id,job_id,generation_id,record_id,'products',source_record_id,
        canonical_record || jsonb_build_object('tenantId',tenant_id)
      FROM migration_final_source_records WHERE source_record_id='P3'`);
    await refused(input);
    expect(observed.some((text) => /FROM migration_final_source_records/.test(text))).toBe(true);
    expect(observed.some((text) => /FROM migration_final_targets/.test(text))).toBe(true);
  });
  it('keeps duplicate and target-without-source cases at real UNIQUE/FK constraints', async () => {
    const { input } = await fixture();
    const before = await snapshot();
    await expect(harness.database.exec('INSERT INTO migration_final_targets SELECT * FROM migration_final_targets'))
      .rejects.toMatchObject({ code: '23505' });
    await expect(harness.database.exec(`INSERT INTO migration_final_targets
      (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
      SELECT tenant_id,job_id,generation_id,'missing-source',target_table,'extra-product',canonical_target
      FROM migration_final_targets WHERE target_id='P2'`)).rejects.toMatchObject({ code: '23503' });
    expect(await snapshot()).toEqual(before);
    expect((await inspect(input)).status).toBe('MATCH');
  });
  it('refuses wrong tenant/job/binding/version and a foreign transaction tenant', async () => {
    const { input } = await fixture();
    for (const overrides of [{ tenantId: harness.tenantTwoId }, { migrationJobId: 'wrong' }, { expectedStateVersion: '999' },
      { originalSourceId: `sheet:${'f'.repeat(64)}` }, { originalSnapshotId: `import:${'f'.repeat(64)}` },
      { generationId: `preparation:candidate:${'f'.repeat(64)}` }, { candidateManifestDigest: 'f'.repeat(64) }]) {
      await refused({ ...input, ...overrides });
    }
    const before = await snapshot();
    await expect(reconcileLocalMultiAddedProducts(input, { runTransaction: (_tenant, callback) => readOnly(harness.tenantTwoId, callback) })).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
  });
  it('refuses REPEATABLE READ before any evidence reads instead of claiming fresh lock snapshots', async () => {
    const { input } = await fixture();
    const before = await snapshot();
    await expect(runRepeatable(input.tenantId, (tx) => inspectLocalMultiAddedProductGeneration(tx, input))).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
  });
  it('detaches primitive input before the runner awaits and rejects caller evidence before opening it', async () => {
    const { input } = await fixture();
    const expected = await inspect(input);
    const mutable = { ...input };
    expect(await reconcileLocalMultiAddedProducts(mutable, { runTransaction: (tenant, callback) => {
      mutable.candidateManifestDigest = 'f'.repeat(64);
      return readOnly(tenant, callback);
    } })).toEqual(expected);
    const never = vi.fn(async () => { throw new Error('must not start'); });
    for (const extra of [{ changes: [] }, { authority: 'ACTIVE' }, { acquisition: {} }, { expectedCount: 3 }]) {
      await expect(reconcileLocalMultiAddedProducts({ ...input, ...extra }, { runTransaction: never })).rejects.toThrow(REFUSAL);
    }
    const getter = vi.fn(() => input.generationId);
    await expect(reconcileLocalMultiAddedProducts(Object.defineProperty({ ...input }, 'generationId', { get: getter }), { runTransaction: never })).rejects.toThrow(REFUSAL);
    expect(getter).not.toHaveBeenCalled();
    expect(never).not.toHaveBeenCalled();
  });
  it.each(['ORIGINAL', 'CANDIDATE', 'PLAN'])('refuses a changed persisted %s envelope', async (kind) => {
    const { input } = await fixture();
    await corrupt('audit_events', `UPDATE audit_events SET redacted_details=redacted_details || '{"unexpected":true}'::jsonb WHERE event_type='MIGRATION_PREPARATION_${kind}'`);
    await refused(input);
  });
  it('refuses a missing original acquisition envelope without trusting retained normalized rows', async () => {
    const { input } = await fixture();
    await corrupt('audit_events', "DELETE FROM audit_events WHERE event_type='MIGRATION_PREPARATION_ORIGINAL'");
    await refused(input);
  });
  it('rejects self-rehashed candidate manifest forgery against its stored acquisition before row lookup', async () => {
    const request = await originalFixture();
    const input = await archived(request, (candidate) => {
      const manifest = candidate.manifest as unknown as { records: Record<string, Record<string, unknown>[]>; manifestDigest: string };
      manifest.records.products.find((row) => row.productId === 'P3')!.price = 999;
      const unsigned = { ...manifest } as Record<string, unknown>;
      delete unsigned.manifestDigest;
      manifest.manifestDigest = sha256(canonicalJson(unsigned));
    });
    await refused(input);
    expect(observed.some((text) => /FROM audit_events/.test(text))).toBe(true);
    expect(observed.some((text) => /FROM migration_final_source_records/.test(text))).toBe(false);
  });
  it('rejects an omitted ADDED change even after rehashing every plan link', async () => {
    const request = await originalFixture();
    const input = await archived(request, (_candidate, plan) => { plan.changes = (plan.changes as unknown[]).slice(1); });
    await refused(input);
    expect(observed.some((text) => /FROM migration_final_source_records/.test(text))).toBe(false);
  });
  it.each(['none', 'single', 'mutation', 'removal', 'other-table', 'new-setting', 'source-only'])('explicitly refuses unsupported %s delta from persisted acquisitions', async (kind) => {
    const request = await originalFixture();
    if (kind === 'none' || kind === 'single') request.candidate = acquisition(kind === 'none' ? 0 : 1);
    else if (kind === 'mutation' || kind === 'source-only') request.candidate = acquisition(3, kind === 'mutation' ? 'Changed' : ' Pencil ');
    else request.candidate = { sheets: makeSupportedSheets(3, (tabs) => {
      if (kind === 'removal') tabs.Products.rows = [];
      else if (kind === 'new-setting') tabs.Settings.rows.push({ rowNumber: 7, cells: ['className', 'Synthetic class'], hash: '' });
      else tabs.Settings.rows.find((row) => row.cells[0] === 'themeColor')!.cells[1] = 'green';
      for (let index = 0; index < 3; index += 1) tabs.Products.rows.push({ rowNumber: index + 3,
        cells: [`P${index + 2}`, `Notebook${index}`, '15', '3', 'TRUE', '', 'school', String(index + 2)], hash: '' });
    }), redis: request.original.redis };
    if (kind === 'new-setting') expect(createLegacyNormalizationManifest({ tenantId: request.tenantId,
      migrationJobId: JOB, ...request.candidate }).status).toBe('READY_FOR_IMPORT');
    const input = await archived(request);
    await aggregate(input);
    await refused(input);
  });
  it('inspects two independent generations with repeated product IDs, without combining their sets', async () => {
    const { request, input } = await fixture();
    const secondRequest = { ...request, candidate: acquisition(3, 'Pencil', 'Revised') };
    const second = await stageLocalMultiAddedProducts(secondRequest, { runTransaction: runFixture });
    const before = await snapshot();
    expect((await inspect(input)).targetCount).toBe(3);
    expect((await inspect(binding(secondRequest, second.generationId))).targetCount).toBe(3);
    expect(second.generationId).not.toBe(input.generationId);
    expect(await snapshot()).toEqual(before);
  });
  it('refuses original operational drift and returns no raw SQL/candidate error payload', async () => {
    const { input } = await fixture();
    await harness.database.exec('UPDATE products SET price=price+1');
    await refused(input);
    const error = await reconcileLocalMultiAddedProducts(input, { runTransaction: async () => {
      throw new Error('synthetic-credential-canary');
    } }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', REFUSAL);
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('synthetic-credential-canary');
  });
});
