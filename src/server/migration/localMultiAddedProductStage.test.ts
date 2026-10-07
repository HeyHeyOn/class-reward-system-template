import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { stageLegacyFinalGeneration } from './finalGeneration';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { stageLocalMultiAddedProducts } from './localMultiAddedProductStage';

vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Local multi-added-product stage refused.';
const stageTables = ['migration_final_generations', 'migration_final_source_records', 'migration_final_targets'] as const;
let harness: PgliteDatabaseHarness;
const acquisition = (count = 0, name = 'Notebook', retainedName = 'Pencil') => ({
  sheets: makeSupportedSheets(3, (tabs) => {
    tabs.Products.rows[0].cells[1] = retainedName;
    for (let index = 0; index < count; index += 1) {
      tabs.Products.rows.push({ rowNumber: index + 3,
        cells: [`P${index + 2}`, `${name}${index}`, '15', '3', 'TRUE', '', 'school', String(index + 2)], hash: '' });
    }
  }),
  redis: makeRedis({ operationBindings: [], v2Claims: [] }),
});
beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
  // Test-only privileges, including the column privilege required by FOR UPDATE.
  // Migration 0024 intentionally does not provision this local path in production.
  await harness.database.exec('GRANT SELECT, INSERT ON migration_final_generations, migration_final_source_records, migration_final_targets TO app_runtime');
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
  return { tenantId: harness.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSourceId: `sheet:${manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
    exclusionGenerationReference: 'a'.repeat(64), original, candidate: acquisition(3) };
}
async function snapshot(exclude: readonly string[] = []) {
  const { rows } = await harness.database.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  return Promise.all(rows.filter(({ tablename }) => !exclude.includes(tablename)).map(async ({ tablename }) => ({
    table: tablename, rows: (await harness.database.query(`SELECT * FROM "${tablename}"`)).rows
      .map((row) => JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).sort(),
  })));
}
async function counts() {
  return Promise.all(stageTables.map(async (table) =>
    (await harness.database.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count));
}
async function corrupt(table: typeof stageTables[number] | 'audit_events', statement: string) {
  // Isolated owner-only corruption. Runtime is invoked only after restoring guards.
  await harness.database.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_immutable`);
  try { await harness.database.exec(statement); }
  finally { await harness.database.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_immutable`); }
}
const stage = (input: Awaited<ReturnType<typeof fixture>>) =>
  stageLocalMultiAddedProducts(input, { runTransaction: harness.runTenantTransaction });

describe('multiple ADDED Products, local non-authoritative staging only', () => {
  it('atomically stores ALL source/target pairs with distinct deterministic IDs and changes no other state', async () => {
    const request = await fixture();
    const before = await snapshot([...stageTables, 'audit_events']);
    const result = await stage(request);
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
      activationAllowed: false, complete: false, scope: 'MULTI_ADDED_PRODUCTS', targetTable: 'products' });
    expect(result.products.map((product) => product.productId)).toEqual(['P2', 'P3', 'P4']);
    expect(new Set(result.products.map((product) => product.recordId)).size).toBe(3);
    expect(await counts()).toEqual([1, 3, 3]);
    const manifest = createLegacyNormalizationManifest({ tenantId: request.tenantId, migrationJobId: JOB, ...request.candidate });
    for (const product of result.products) {
      const source = manifest.sourceRecords.find((record) => record.targetTable === 'products' && record.targetId === product.productId)!;
      expect(source.source.kind).toBe('SHEET');
      if (source.source.kind !== 'SHEET') throw new Error('fixture');
      expect(product.recordId).toBe(`local-final-record:${sha256(canonicalJson([
        request.tenantId, JOB, result.generationId, source.source.rowHash, product.productId,
      ]))}`);
      expect((await harness.database.query('SELECT source_row_number::int,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record FROM migration_final_source_records WHERE record_id=$1', [product.recordId])).rows)
        .toEqual([{ source_row_number: source.source.rowNumber, source_row_hash: source.source.rowHash,
          source_collection: 'Products', source_record_id: product.productId,
          redacted_record: source.redactedSourceRecord, canonical_record: source.canonicalRecord }]);
      expect((await harness.database.query('SELECT canonical_target FROM migration_final_targets WHERE record_id=$1', [product.recordId])).rows)
        .toEqual([{ canonical_target: manifest.records.products.find((row) => row.productId === product.productId) }]);
    }
    expect((await harness.database.query("SELECT event_type FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_type")).rows)
      .toEqual(['CANDIDATE', 'ORIGINAL', 'PLAN'].map((kind) => ({ event_type: `MIGRATION_PREPARATION_${kind}` })));
    expect(await snapshot([...stageTables, 'audit_events'])).toEqual(before);
    const original = createLegacyNormalizationManifest({ tenantId: request.tenantId, migrationJobId: JOB, ...request.original });
    expect(await harness.runTenantTransaction(request.tenantId, (tx) => inspectLegacyImport(tx,
      { tenantId: request.tenantId, migrationJobId: JOB, manifest: original }, original))).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/credential|recovery|canonical_record|redacted_record|acquisition/i);
  });

  it('retries byte-exactly and keeps distinct generations isolated when added products are recaptured', async () => {
    const request = await fixture();
    const first = await stage(request);
    const before = await snapshot();
    expect(await stage(request)).toEqual(first);
    expect(await snapshot()).toEqual(before);
    const second = await stage({ ...request, candidate: acquisition(3, 'Revised') });
    expect(second.generationId).not.toBe(first.generationId);
    expect(new Set([...first.products, ...second.products].map((product) => product.recordId)).size).toBe(6);
    expect(await counts()).toEqual([2, 6, 6]);
    expect(await stage(request)).toEqual(first);
    for (const table of stageTables) {
      expect((await harness.runTenantTransaction(harness.tenantTwoId, (tx) => tx.execute(sql.raw(`SELECT * FROM ${table}`)))).rows).toEqual([]);
    }
  });

  it.each([0, 1])('refuses %i additions instead of widening this multi-product slice', async (count) => {
    const request = await fixture();
    const before = await snapshot();
    await expect(stage({ ...request, candidate: acquisition(count) })).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
  });

  it.each([' Pencil ', 'Changed'])('refuses retained source/target mutation (%s) and rolls back the envelopes', async (name) => {
    const request = await fixture();
    const before = await snapshot();
    await expect(stage({ ...request, candidate: acquisition(3, 'Notebook', name) })).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses stale READY version, wrong original binding, job or tenant with no writes', async () => {
    const request = await fixture();
    const before = await snapshot();
    for (const overrides of [{ expectedStateVersion: '999' }, { originalSourceId: 'wrong' },
      { originalSnapshotId: 'wrong' }, { migrationJobId: 'other' }, { tenantId: harness.tenantTwoId }]) {
      await expect(stage({ ...request, ...overrides })).rejects.toThrow(REFUSAL);
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each(['ORIGINAL', 'CANDIDATE', 'PLAN'])('rejects a persisted %s envelope/binding mismatch', async (kind) => {
    const request = await fixture();
    await stageLegacyFinalGeneration(request, { runTransaction: harness.runTenantTransaction });
    const field = kind === 'ORIGINAL' ? '{originalSourceId}' : '{binding,originalSourceId}';
    await corrupt('audit_events', `UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,'${field}','"wrong"'::jsonb)
      WHERE event_type='MIGRATION_PREPARATION_${kind}'`);
    const before = await snapshot();
    await expect(stage(request)).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
    expect(await counts()).toEqual([0, 0, 0]);
  });

  it.each(['generation-only', 'missing-pair', 'missing-target'] as const)('refuses a partial retry (%s), never fills missing rows', async (kind) => {
    const request = await fixture();
    await stage(request);
    const where = kind === 'generation-only' ? '' : " WHERE target_id='P3'";
    await corrupt('migration_final_targets', `DELETE FROM migration_final_targets${where}`);
    if (kind !== 'missing-target') await corrupt('migration_final_source_records',
      `DELETE FROM migration_final_source_records${kind === 'generation-only' ? '' : " WHERE source_record_id='P3'"}`);
    const before = await snapshot();
    await expect(stage(request)).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
  });

  it.each([false, true])('rejects an extra persisted source (with target: %s) rather than just counting a join', async (withTarget) => {
    const request = await fixture();
    await stage(request);
    await harness.database.exec(`INSERT INTO migration_final_source_records
      (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
      SELECT tenant_id,job_id,generation_id,'extra-record',99,source_row_hash,source_collection,'P-extra',redacted_record,canonical_record
      FROM migration_final_source_records WHERE source_record_id='P2'`);
    if (withTarget) await harness.database.exec(`INSERT INTO migration_final_targets
      (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
      SELECT tenant_id,job_id,generation_id,'extra-record',target_table,'P-extra',canonical_target
      FROM migration_final_targets WHERE target_id='P2'`);
    const before = await snapshot();
    await expect(stage(request)).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['migration_final_generations', "UPDATE migration_final_generations SET expected_state_version=999"],
    ['migration_final_generations', `UPDATE migration_final_generations SET candidate_sheet_digest='${'f'.repeat(64)}'`],
    ['migration_final_source_records', "UPDATE migration_final_source_records SET canonical_record=jsonb_set(canonical_record,'{price}','999'::jsonb) WHERE source_record_id='P3'"],
    ['migration_final_source_records', "UPDATE migration_final_source_records SET redacted_record='{}'::jsonb WHERE source_record_id='P3'"],
    ['migration_final_targets', "UPDATE migration_final_targets SET canonical_target=jsonb_set(canonical_target,'{price}','999'::jsonb) WHERE target_id='P3'"],
    ['migration_final_targets', "UPDATE migration_final_targets SET target_id='wrong' WHERE target_id='P3'"],
  ] as const)('rejects same-count persisted corruption: %s / %s', async (table, statement) => {
    const request = await fixture();
    await stage(request);
    await corrupt(table, statement);
    const before = await snapshot();
    await expect(stage(request)).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['suppress', 'raise', 'alter'] as const)('rolls back envelopes and every pair on a middle target INSERT fault (%s)', async (fault) => {
    const request = await fixture();
    const before = await snapshot();
    const action = fault === 'suppress' ? 'RETURN NULL;' : fault === 'raise'
      ? "RAISE EXCEPTION 'injected target failure';" : "NEW.canonical_target='{}'::jsonb;";
    await harness.database.exec(`CREATE FUNCTION fault_local_multi_target() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.target_id='P3' THEN ${action} END IF; RETURN NEW; END $$;
      CREATE TRIGGER fault_local_multi_target BEFORE INSERT ON migration_final_targets FOR EACH ROW EXECUTE FUNCTION fault_local_multi_target()`);
    await expect(stage(request)).rejects.toThrow(REFUSAL);
    expect(await snapshot()).toEqual(before);
    expect(await counts()).toEqual([0, 0, 0]);
  });
});
