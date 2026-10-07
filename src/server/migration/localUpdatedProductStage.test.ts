import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { stageLocalUpdatedProduct } from './localUpdatedProductStage';
import { reconcileLocalUpdatedProduct } from './localProductReconciliation';

vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
let harness: PgliteDatabaseHarness;
const acquisition = (price = '20', retainedName = 'Notebook') => ({
  sheets: makeSupportedSheets(3, (tabs) => {
    tabs.Products.rows[0].cells[2] = price;
    tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', retainedName, '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
  }),
  redis: makeRedis({ operationBindings: [], v2Claims: [] }),
});
const localTables = ['migration_final_generations', 'migration_final_source_records',
  'migration_final_targets', 'migration_local_generation_reconciliation', 'audit_events'] as const;
const originalTables = ['tenants', 'migration_jobs', 'migration_sources', 'migration_snapshots',
  'migration_source_records', 'products', 'transactions', 'transaction_items', 'inventory_ledger'] as const;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
  // Isolated test privileges only. No production grant/provisioning change.
  await harness.database.exec('GRANT SELECT, INSERT ON migration_final_generations, migration_final_source_records, migration_final_targets, migration_local_generation_reconciliation TO app_runtime');
  await harness.database.exec('GRANT UPDATE (generation_id) ON migration_final_generations TO app_runtime');
});
afterEach(async () => { await harness?.close(); });

async function fixture() {
  const original = acquisition();
  const manifest = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, ...original });
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, manifest, runTransaction: harness.runTenantTransaction });
  await harness.database.exec("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now(); UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now()");
  const { rows } = await harness.database.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs');
  return {
    tenantId: harness.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSourceId: `sheet:${manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
    exclusionGenerationReference: 'a'.repeat(64), original, candidate: acquisition('25'),
  };
}
async function snapshot(tables: readonly string[]) {
  return Promise.all(tables.map(async (table) => ({
    table, rows: (await harness.database.query(`SELECT * FROM ${table}`)).rows
      .map((row) => JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).sort(),
  })));
}
function readBinding(request: Awaited<ReturnType<typeof fixture>>, generationId: string) {
  const manifest = createLegacyNormalizationManifest({ tenantId: request.tenantId, migrationJobId: JOB, ...request.candidate });
  return { tenantId: request.tenantId, migrationJobId: JOB, generationId,
    originalSourceId: request.originalSourceId, originalSnapshotId: request.originalSnapshotId,
    expectedStateVersion: request.expectedStateVersion, candidateManifestDigest: manifest.manifestDigest };
}
async function corrupt(table: 'migration_final_targets' | 'migration_final_source_records' | 'migration_final_generations', statement: string) {
  // Owner-only corruption fixture; restore the real guard before calling product code.
  await harness.database.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_immutable`);
  try { await harness.database.exec(statement); }
  finally { await harness.database.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_immutable`); }
}

describe('single UPDATED product LOCAL_CANDIDATE stage and independent reconciliation', () => {
  it('persists a new product version with before/after provenance and leaves all original data unchanged', async () => {
    const request = await fixture();
    const before = await snapshot(originalTables);
    const result = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', activationAllowed: false,
      scope: 'SINGLE_UPDATED_PRODUCT', productId: 'P1', expectedCount: 1, actualCount: 1, status: 'MATCH' });
    const summary = await reconcileLocalUpdatedProduct(readBinding(request, result.generationId), { runTransaction: harness.runTenantTransaction });
    expect(summary).toEqual(result);
    const originalManifest = createLegacyNormalizationManifest({ tenantId: request.tenantId, migrationJobId: JOB, ...request.original });
    const candidateManifest = createLegacyNormalizationManifest({ tenantId: request.tenantId, migrationJobId: JOB, ...request.candidate });
    expect(result.beforeDigest).toBe(sha256(canonicalJson(originalManifest.records.products.find((row) => row.productId === 'P1'))));
    expect(result.afterDigest).toBe(sha256(canonicalJson(candidateManifest.records.products.find((row) => row.productId === 'P1'))));
    expect(result.beforeSourceRowHash).not.toBe(result.afterSourceRowHash);
    expect((await harness.database.query("SELECT canonical_target->>'price' AS price FROM migration_final_targets")).rows).toEqual([{ price: '25' }]);
    expect(await snapshot(originalTables)).toEqual(before);
    expect(await harness.runTenantTransaction(request.tenantId, (tx) => inspectLegacyImport(tx,
      { tenantId: request.tenantId, migrationJobId: JOB, manifest: originalManifest }, originalManifest))).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/credential|recovery|canonical_record|redacted_record|acquisition|diagnostics/i);
  });

  it('retries exactly, keeps every persisted byte, and coexists with a different candidate generation', async () => {
    const request = await fixture();
    const first = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    const before = await snapshot(localTables);
    expect(await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction })).toEqual(first);
    expect(await reconcileLocalUpdatedProduct(readBinding(request, first.generationId), { runTransaction: harness.runTenantTransaction })).toEqual(first);
    expect(await snapshot(localTables)).toEqual(before);
    const secondRequest = { ...request, candidate: acquisition('30') };
    const second = await stageLocalUpdatedProduct(secondRequest, { runTransaction: harness.runTenantTransaction });
    expect(second.generationId).not.toBe(first.generationId);
    expect((await harness.database.query('SELECT target_id FROM migration_final_targets')).rows).toEqual([{ target_id: 'P1' }, { target_id: 'P1' }]);
    expect(await reconcileLocalUpdatedProduct(readBinding(request, first.generationId), { runTransaction: harness.runTenantTransaction })).toEqual(first);
    await expect(reconcileLocalUpdatedProduct(readBinding(secondRequest, first.generationId), { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
  });

  it('rejects changed retained source spelling even when its normalized target is unchanged, with full rollback', async () => {
    const request = await fixture();
    const before = await snapshot([...originalTables, ...localTables]);
    await expect(stageLocalUpdatedProduct({ ...request, candidate: acquisition('25', ' Notebook ') }, { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    expect(await snapshot([...originalTables, ...localTables])).toEqual(before);
  });

  it('refuses ADDED, REMOVED and no-change plans rather than treating them as an update', async () => {
    const request = await fixture();
    const before = await snapshot(localTables);
    const removed = { sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows = []; tabs.Transactions.rows = []; tabs.Adjustments.rows = []; tabs.PromotionProducts.rows = [];
    }), redis: makeRedis({ operationBindings: [], v2Claims: [] }) };
    for (const candidate of [request.original, removed, { ...request.original, sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows.push({ rowNumber: 3, cells: ['P3', 'New', '10', '2', 'TRUE', '', '', '3'], hash: '' });
    }) }]) {
      await expect(stageLocalUpdatedProduct({ ...request, candidate }, { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    }
    expect(await snapshot(localTables)).toEqual(before);
  });

  it('rejects stale version, wrong source/snapshot/job/tenant without writes', async () => {
    const request = await fixture();
    const before = await snapshot([...originalTables, ...localTables]);
    for (const overrides of [
      { expectedStateVersion: '999' }, { originalSourceId: 'wrong' }, { originalSnapshotId: 'wrong' },
      { migrationJobId: 'other' }, { tenantId: harness.tenantTwoId },
    ]) await expect(stageLocalUpdatedProduct({ ...request, ...overrides }, { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    expect(await snapshot([...originalTables, ...localTables])).toEqual(before);
  });

  it('refuses missing/wrong generation or snapshot and enforces runtime tenant isolation', async () => {
    const request = await fixture();
    const result = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    const binding = readBinding(request, result.generationId);
    for (const overrides of [{ generationId: 'missing' }, { originalSnapshotId: 'wrong' },
      { migrationJobId: 'other' }, { tenantId: harness.tenantTwoId }, { candidateManifestDigest: 'f'.repeat(64) }]) {
      await expect(reconcileLocalUpdatedProduct({ ...binding, ...overrides }, { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    }
    for (const table of localTables.filter((table) => table !== 'audit_events')) {
      const other = await harness.runTenantTransaction(harness.tenantTwoId, (tx) => tx.execute(sql.raw(`SELECT * FROM ${table}`)));
      expect(other.rows).toEqual([]);
    }
  });

  it.each(['tampered', 'missing'] as const)('detects a %s target despite stored MATCH evidence, without repairing on retry', async (kind) => {
    const request = await fixture();
    const result = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    await corrupt('migration_final_targets', kind === 'tampered'
      ? "UPDATE migration_final_targets SET canonical_target=jsonb_set(canonical_target,'{price}','999'::jsonb)"
      : 'DELETE FROM migration_final_targets');
    expect((await harness.database.query('SELECT status FROM migration_local_generation_reconciliation')).rows).toEqual([{ status: 'MATCH' }]);
    const before = await snapshot(localTables);
    await expect(reconcileLocalUpdatedProduct(readBinding(request, result.generationId), { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    await expect(stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    expect(await snapshot(localTables)).toEqual(before);
  });

  it('detects source-row hash corruption and refuses to trust newly inserted MATCH counts', async () => {
    const request = await fixture();
    const result = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    await corrupt('migration_final_source_records', `UPDATE migration_final_source_records SET source_row_hash='${'b'.repeat(64)}'`);
    const before = await snapshot(localTables);
    await expect(reconcileLocalUpdatedProduct(readBinding(request, result.generationId), { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    expect(await snapshot(localTables)).toEqual(before);
  });

  it('rejects a stored generation with the wrong sheet binding despite immutable MATCH evidence', async () => {
    const request = await fixture();
    const result = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    const binding = readBinding(request, result.generationId);
    expect(await reconcileLocalUpdatedProduct(binding, { runTransaction: harness.runTenantTransaction })).toEqual(result);
    await corrupt('migration_final_generations', `UPDATE migration_final_generations SET candidate_sheet_digest='${'f'.repeat(64)}'`);
    expect((await harness.database.query('SELECT status FROM migration_local_generation_reconciliation')).rows).toEqual([{ status: 'MATCH' }]);
    const before = await snapshot([...originalTables, ...localTables]);
    await expect(reconcileLocalUpdatedProduct(binding, { runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow('Local updated-product reconciliation refused.');
    expect(await snapshot([...originalTables, ...localTables])).toEqual(before);
  });

  it.each([false, true])('rejects an extra staged source (with target: %s) without trusting MATCH or healing rows', async (withTarget) => {
    const request = await fixture();
    const result = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    const binding = readBinding(request, result.generationId);
    expect(await reconcileLocalUpdatedProduct(binding, { runTransaction: harness.runTenantTransaction })).toEqual(result);
    // Legal owner INSERTs retain all FK/check/immutability guards. An inner join
    // would hide the orphan source; a first-row-only check would miss the pair.
    await harness.database.exec(`INSERT INTO migration_final_source_records
      (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
      SELECT tenant_id,job_id,generation_id,'extra-record',3,source_row_hash,source_collection,'P-extra',redacted_record,canonical_record
      FROM migration_final_source_records`);
    if (withTarget) await harness.database.exec(`INSERT INTO migration_final_targets
      (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
      SELECT tenant_id,job_id,generation_id,'extra-record',target_table,'P-extra',canonical_target FROM migration_final_targets`);
    expect((await harness.database.query(`SELECT expected_count::text,actual_count::text,status
      FROM migration_local_generation_reconciliation`)).rows).toEqual([{ expected_count: '1', actual_count: '1', status: 'MATCH' }]);
    expect((await harness.database.query(`SELECT
      (SELECT count(*)::text FROM migration_final_source_records) AS sources,
      (SELECT count(*)::text FROM migration_final_targets) AS targets`)).rows)
      .toEqual([{ sources: '2', targets: withTarget ? '2' : '1' }]);
    const before = await snapshot([...originalTables, ...localTables]);
    await expect(reconcileLocalUpdatedProduct(binding, { runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow('Local updated-product reconciliation refused.');
    expect(await snapshot([...originalTables, ...localTables])).toEqual(before);
  });

  it('rolls back envelopes, generation, source and target when the target INSERT is suppressed', async () => {
    const request = await fixture();
    const before = await snapshot([...originalTables, ...localTables]);
    await harness.database.exec(`CREATE FUNCTION suppress_local_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER suppress_local_target BEFORE INSERT ON migration_final_targets FOR EACH ROW EXECUTE FUNCTION suppress_local_target()`);
    await expect(stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    expect(await snapshot([...originalTables, ...localTables])).toEqual(before);
  });

  it('does not need a caller MATCH row: independent inspection recomputes stored bytes, and immutable rows reject rewrites', async () => {
    const request = await fixture();
    const result = await stageLocalUpdatedProduct(request, { runTransaction: harness.runTenantTransaction });
    for (const table of localTables.filter((table) => table !== 'audit_events')) {
      await expect(harness.database.query(`DELETE FROM ${table}`)).rejects.toThrow();
    }
    await harness.database.exec('ALTER TABLE migration_local_generation_reconciliation DISABLE TRIGGER migration_local_generation_reconciliation_immutable');
    try { await harness.database.exec('DELETE FROM migration_local_generation_reconciliation'); }
    finally { await harness.database.exec('ALTER TABLE migration_local_generation_reconciliation ENABLE TRIGGER migration_local_generation_reconciliation_immutable'); }
    const before = await snapshot(localTables);
    expect(await reconcileLocalUpdatedProduct(readBinding(request, result.generationId), { runTransaction: harness.runTenantTransaction })).toEqual(result);
    expect(await snapshot(localTables)).toEqual(before);
  });
});
