import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { stageLocalAddedProduct } from './localAddedProductStage';
import { canonicalJson, sha256 } from './validators';
vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
let harness: PgliteDatabaseHarness;
const redis = () => makeRedis({ operationBindings: [], v2Claims: [] });
const original = () => ({ sheets: makeSupportedSheets(), redis: redis() });
const changed = () => ({ sheets: makeSupportedSheets(3, (tabs) => {
  tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', 'Notebook', '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
}), redis: redis() });
beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
  // Test-only runtime privilege. Migration 0024 deliberately provisions none.
  await harness.database.exec('GRANT SELECT, INSERT ON migration_final_generations, migration_final_source_records, migration_final_targets, migration_local_generation_reconciliation TO app_runtime');
});
afterEach(async () => { await harness?.close(); });
async function fixture() {
  const base = original();
  const manifest = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, ...base });
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, manifest, runTransaction: harness.runTenantTransaction });
  await harness.database.exec("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now(); UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now()");
  const { rows } = await harness.database.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs');
  const source = await harness.database.query<{ source_id: string; snapshot_id: string }>('SELECT source_id,snapshot_id FROM migration_snapshots');
  return { tenantId: harness.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSnapshotId: source.rows[0].snapshot_id, originalSourceId: source.rows[0].source_id,
    // Local preparation fixture identifier only; never an external-exclusion proof.
    exclusionGenerationReference: 'a'.repeat(64), original: base, candidate: changed(), manifest };
}
async function counts() {
  return Promise.all(['migration_final_generations', 'migration_final_source_records', 'migration_final_targets'].map(async (table) =>
    (await harness.database.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count));
}
async function retainedEvidence() {
  const result: Record<string, string> = {};
  for (const table of ['migration_final_generations', 'migration_final_source_records', 'migration_final_targets',
    'migration_local_generation_reconciliation', 'audit_events', 'migration_source_records',
    'migration_sources', 'migration_snapshots', 'migration_jobs', 'products']) {
    const { rows } = await harness.database.query(
      `SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM ${table} t ORDER BY to_jsonb(t)::text`,
    );
    // Report only digests on assertion failure, never retained source contents.
    result[table] = sha256(canonicalJson(rows));
  }
  return result;
}
describe('local, non-authoritative added-product generation', () => {
  it('stages one candidate source row and target in one transaction without changing original inspection', async () => {
    const input = await fixture();
    const { manifest, ...request } = input;
    const before = await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id');
    const result = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', targetTable: 'products', targetId: 'P2' });
    expect(await counts()).toEqual([1, 1, 1]);
    expect((await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows).toEqual(before.rows);
    expect((await harness.database.query("SELECT product_id FROM products ORDER BY product_id")).rows).toEqual([{ product_id: 'P1' }]);
    expect((await harness.database.query('SELECT status,state_version::text AS version FROM migration_jobs')).rows)
      .toMatchObject([{ status: 'READY', version: input.expectedStateVersion }]);
    expect(await harness.runTenantTransaction(input.tenantId, (tx) => inspectLegacyImport(tx,
      { tenantId: input.tenantId, migrationJobId: JOB, manifest }, manifest))).toEqual([]);
  });
  it('retries the same exact generation without duplicating rows', async () => {
    const input = await fixture();
    const { manifest, ...request } = input;
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    const before = await retainedEvidence();
    expect(await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction })).toEqual(first);
    expect(await counts()).toEqual([1, 1, 1]);
    expect(await retainedEvidence()).toEqual(before);
  });
  it.each(['source-only', 'extra pair'] as const)('refuses retry with a same-generation %s despite stored MATCH', async (kind) => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    // Legal runtime INSERTs only: keep FK, UNIQUE, CHECK and immutable guards enabled.
    await harness.runTenantTransaction(request.tenantId, async (tx) => {
      const inserted = await tx.execute(sql`INSERT INTO migration_final_source_records
        (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,
          source_collection,source_record_id,redacted_record,canonical_record)
        SELECT tenant_id,job_id,generation_id,'extra-record',source_row_number+100,source_row_hash,
          source_collection,'extra-product',redacted_record,canonical_record
        FROM migration_final_source_records
        WHERE tenant_id=${request.tenantId} AND generation_id=${first.generationId} AND record_id=${first.recordId}
        RETURNING record_id`);
      expect(inserted.rows).toEqual([{ record_id: 'extra-record' }]);
      if (kind === 'extra pair') {
        const target = await tx.execute(sql`INSERT INTO migration_final_targets
          (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
          SELECT tenant_id,job_id,generation_id,'extra-record',target_table,'extra-product',canonical_target
          FROM migration_final_targets
          WHERE tenant_id=${request.tenantId} AND generation_id=${first.generationId} AND record_id=${first.recordId}
          RETURNING record_id`);
        expect(target.rows).toEqual([{ record_id: 'extra-record' }]);
      }
    });
    expect(await counts()).toEqual([1, 2, kind === 'source-only' ? 1 : 2]);
    const joined = await harness.database.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM migration_final_source_records r JOIN migration_final_targets t
        ON t.tenant_id=r.tenant_id AND t.job_id=r.job_id AND t.generation_id=r.generation_id AND t.record_id=r.record_id
      WHERE r.tenant_id=$1 AND r.generation_id=$2`, [request.tenantId, first.generationId]);
    expect(joined.rows).toEqual([{ count: kind === 'source-only' ? 1 : 2 }]);
    expect((await harness.database.query(`SELECT expected_count::int,actual_count::int,delta::int,status
      FROM migration_local_generation_reconciliation WHERE tenant_id=$1 AND generation_id=$2`,
    [request.tenantId, first.generationId])).rows).toEqual([{ expected_count: 1, actual_count: 1, delta: 0, status: 'MATCH' }]);
    const before = await retainedEvidence();
    await expect(stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow('Local added-product stage refused.');
    expect(await retainedEvidence()).toEqual(before);
  });
  it('rejects a target-only extra row at the FK without bypassing it to fabricate an application case', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    const before = await retainedEvidence();
    await expect(harness.database.query(`INSERT INTO migration_final_targets
      (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
      SELECT tenant_id,job_id,generation_id,'missing-source-record',target_table,'extra-product',canonical_target
      FROM migration_final_targets WHERE tenant_id=$1 AND generation_id=$2 AND record_id=$3`,
    [request.tenantId, first.generationId, first.recordId])).rejects.toMatchObject({
      code: '23503', constraint: 'migration_final_targets_record_fk',
    });
    expect(await retainedEvidence()).toEqual(before);
    expect(await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction })).toEqual(first);
    expect(await retainedEvidence()).toEqual(before);
  });
  it.each([
    ['source record identity', 'migration_final_source_records', "NEW.record_id := 'other-record'"],
    ['source product identity', 'migration_final_source_records', "NEW.source_record_id := 'other-product'"],
    ['source row identity', 'migration_final_source_records', 'NEW.source_row_number := NEW.source_row_number + 1'],
    ['source hash', 'migration_final_source_records', "NEW.source_row_hash := repeat('f',64)"],
    ['redacted source JSON', 'migration_final_source_records', `NEW.redacted_record := NEW.redacted_record || '{"unexpected":"synthetic"}'::jsonb`],
    ['canonical source JSON', 'migration_final_source_records', `NEW.canonical_record := NEW.canonical_record || '{"unexpected":"synthetic"}'::jsonb`],
    ['target product identity', 'migration_final_targets', "NEW.target_id := 'other-product'"],
    ['canonical target JSON', 'migration_final_targets', `NEW.canonical_target := NEW.canonical_target || '{"unexpected":"synthetic"}'::jsonb`],
  ])('rejects differing %s rather than trusting a one-row count', async (_label, table, alteration) => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    // A test-owner BEFORE INSERT trigger alters only a new synthetic row;
    // production constraints and immutable UPDATE/DELETE guards stay enabled.
    await harness.database.exec(`CREATE SEQUENCE local_added_payload_witness;
      GRANT USAGE,SELECT ON SEQUENCE local_added_payload_witness TO app_runtime;
      CREATE FUNCTION alter_local_added_payload() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('local_added_payload_witness');
        ${alteration};
        RETURN NEW;
      END $$;
      CREATE TRIGGER alter_local_added_payload BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION alter_local_added_payload()`);
    const before = await retainedEvidence();
    await expect(stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow('Local added-product stage refused.');
    expect((await harness.database.query('SELECT is_called FROM local_added_payload_witness')).rows).toEqual([{ is_called: true }]);
    expect(await counts()).toEqual([0, 0, 0]);
    expect(await retainedEvidence()).toEqual(before);
  });
  it('rolls back generation, source, target and envelopes after an actual target INSERT fails', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    await harness.database.exec(`CREATE SEQUENCE local_added_failure_witness;
      GRANT USAGE,SELECT ON SEQUENCE local_added_failure_witness TO app_runtime;
      CREATE FUNCTION fail_local_added_target() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM migration_final_source_records WHERE tenant_id=NEW.tenant_id AND generation_id=NEW.generation_id)=1
          AND (SELECT count(*) FROM migration_final_targets WHERE tenant_id=NEW.tenant_id AND generation_id=NEW.generation_id)=1
          AND (SELECT count(*) FROM audit_events WHERE tenant_id=NEW.tenant_id AND event_type LIKE 'MIGRATION_PREPARATION_%')=3 THEN
          PERFORM nextval('local_added_failure_witness');
        END IF;
        RAISE EXCEPTION 'synthetic target INSERT failure';
      END $$;
      CREATE TRIGGER fail_local_added_target AFTER INSERT ON migration_final_targets
        FOR EACH ROW EXECUTE FUNCTION fail_local_added_target()`);
    const before = await retainedEvidence();
    await expect(stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction }))
      .rejects.toThrow('Local added-product stage refused.');
    expect((await harness.database.query('SELECT is_called FROM local_added_failure_witness')).rows).toEqual([{ is_called: true }]);
    expect(await counts()).toEqual([0, 0, 0]);
    expect(await retainedEvidence()).toEqual(before);
  });
  it('refuses retry under another tenant runtime without changing either retained evidence or products', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    const before = await retainedEvidence();
    await expect(stageLocalAddedProduct(request, { runTransaction: (_tenantId, callback) =>
      harness.runTenantTransaction(harness.tenantTwoId, callback) })).rejects.toThrow('Local added-product stage refused.');
    expect(await retainedEvidence()).toEqual(before);
    expect(await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction })).toEqual(first);
    expect(await retainedEvidence()).toEqual(before);
  });
  it('refuses a source-only change to an existing product alongside the added row', async () => {
    const input = await fixture();
    const { manifest, ...request } = input;
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    request.candidate = { sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows[0].cells[1] = ' Pencil ';
      tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', 'Notebook', '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
    }), redis: redis() };
    await expect(stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction })).rejects.toThrow('Local added-product stage refused.');
    expect(await counts()).toEqual([0, 0, 0]);
  });
  it('rolls back every staged row and audit envelope when the source is stale', async () => {
    const input = await fixture();
    const { manifest, ...request } = input;
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    await harness.database.exec("UPDATE migration_sources SET external_source_id='tampered' WHERE provider='GOOGLE_SHEETS'");
    await expect(stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction })).rejects.toThrow('Local added-product stage refused.');
    expect(await counts()).toEqual([0, 0, 0]);
    expect((await harness.database.query("SELECT count(*)::int AS count FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rows[0]).toEqual({ count: 0 });
  });
  it('retains both immutable generations when the same product is recaptured with new content', async () => {
    const input = await fixture();
    const { manifest, ...request } = input;
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    request.candidate = { sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', 'Other', '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
    }), redis: redis() };
    const second = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    expect(second.generationId).not.toBe(first.generationId);
    expect(await counts()).toEqual([2, 2, 2]);
    expect((await harness.database.query('SELECT DISTINCT target_id FROM migration_final_targets')).rows).toEqual([{ target_id: 'P2' }]);
  });
  it('isolates all four final-stage tables from another tenant at runtime', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const staged = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    const tables = ['migration_final_generations', 'migration_final_source_records',
      'migration_final_targets', 'migration_local_generation_reconciliation'] as const;
    for (const table of tables) {
      const own = await harness.runTenantTransaction(request.tenantId, async (tx) =>
        tx.execute(sql.raw(`SELECT generation_id FROM ${table}`)));
      const other = await harness.runTenantTransaction(harness.tenantTwoId, async (tx) =>
        tx.execute(sql.raw(`SELECT generation_id FROM ${table}`)));
      expect(own.rows).toEqual([{ generation_id: staged.generationId }]);
      expect(other.rows).toEqual([]);
    }
  });
  it('rejects a child source row with a job different from its generation', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    await expect(harness.runTenantTransaction(request.tenantId, async (tx) => tx.execute(sql`
      INSERT INTO migration_final_source_records (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,
        source_collection,source_record_id,redacted_record,canonical_record)
      VALUES (${request.tenantId},'wrong-job',${first.generationId},'bad-record',4,${'b'.repeat(64)},'Products','bad',
        '{}'::jsonb,'{}'::jsonb)`))).rejects.toThrow();
  });
  it('rejects a target assigned to a different generation from its source record', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    request.candidate = { sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', 'Other', '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
    }), redis: redis() };
    const second = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    await expect(harness.runTenantTransaction(request.tenantId, async (tx) => tx.execute(sql`
      INSERT INTO migration_final_targets (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
      VALUES (${request.tenantId},${JOB},${second.generationId},${first.recordId},'products','bad','{}'::jsonb)`))).rejects.toThrow();
  });
  it('rejects a final generation bound to a snapshot of another source in the same job', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const stage = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    await harness.database.query(`INSERT INTO migration_sources
      (tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
      VALUES ($1,$2,'other-local-source','LEGACY_REDIS_BRIDGE','other-local-source',$3)`,
    [request.tenantId, JOB, 'b'.repeat(64)]);
    await harness.database.query(`INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      VALUES ($1,$2,'other-local-source','other-local-snapshot','PREFLIGHT',$3,'{}'::jsonb,0)`,
    [request.tenantId, JOB, 'b'.repeat(64)]);
    const other = await harness.database.query<{ snapshot_id: string }>(
      'SELECT snapshot_id FROM migration_snapshots WHERE tenant_id=$1 AND source_id<>$2',
      [request.tenantId, request.originalSourceId]);
    expect(other.rows).toHaveLength(1);
    const candidate = await harness.database.query<{ candidate_event_id: string; plan_event_id: string }>(
      'SELECT candidate_event_id,plan_event_id FROM migration_final_generations WHERE tenant_id=$1 AND generation_id=$2',
      [request.tenantId, stage.generationId]);
    await expect(harness.runTenantTransaction(request.tenantId, async (tx) => tx.execute(sql`
      INSERT INTO migration_final_generations
        (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_event_id,plan_event_id,
          candidate_manifest_digest,candidate_sheet_digest,expected_state_version)
      VALUES (${request.tenantId},${JOB},'wrong-snapshot',${request.originalSourceId},${other.rows[0].snapshot_id},
        ${candidate.rows[0].candidate_event_id},${candidate.rows[0].plan_event_id},${'c'.repeat(64)},${'d'.repeat(64)},
        ${request.expectedStateVersion}::bigint)`))).rejects.toThrow();
  });
  it('binds immutable local reconciliation rows to the exact generation and candidate', async () => {
    const { manifest, ...request } = await fixture();
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    const first = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    request.candidate = { sheets: makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows.push({ rowNumber: 3, cells: ['P2', 'Other', '15', '3', 'TRUE', '', 'school', '2'], hash: '' });
    }), redis: redis() };
    const second = await stageLocalAddedProduct(request, { runTransaction: harness.runTenantTransaction });
    const binding = await harness.database.query<{ original_source_id: string; original_snapshot_id: string; candidate_manifest_digest: string }>(
      'SELECT original_source_id,original_snapshot_id,candidate_manifest_digest FROM migration_final_generations WHERE tenant_id=$1 AND generation_id=$2',
      [request.tenantId, first.generationId]);
    const row = binding.rows[0];
    const insert = (generationId: string, jobId = JOB, digest = row.candidate_manifest_digest, category = 'PRODUCTS') =>
      harness.database.query(`INSERT INTO migration_local_generation_reconciliation
        (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,category,expected_count,actual_count,delta,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,0,'MATCH')`,
      [request.tenantId, jobId, generationId, row.original_source_id, row.original_snapshot_id, digest, category]);
    const evidence = await harness.database.query<{ generation_id: string; expected_count: number; actual_count: number; status: string }>(
      'SELECT generation_id,expected_count::int,actual_count::int,status FROM migration_local_generation_reconciliation ORDER BY generation_id');
    expect(evidence.rows).toEqual([
      { generation_id: first.generationId, expected_count: 1, actual_count: 1, status: 'MATCH' },
      { generation_id: second.generationId, expected_count: 1, actual_count: 1, status: 'MATCH' },
    ].sort((a, b) => a.generation_id.localeCompare(b.generation_id)));
    await expect(insert(first.generationId)).rejects.toThrow();
    await expect(insert(first.generationId, 'wrong-job')).rejects.toThrow();
    await expect(insert(second.generationId)).rejects.toThrow();
    await expect(insert(first.generationId, JOB, 'f'.repeat(64), 'STOCK')).rejects.toThrow();
    await expect(harness.database.query('DELETE FROM migration_local_generation_reconciliation')).rejects.toThrow();
    expect((await harness.database.query<{ count: number }>('SELECT count(*)::int AS count FROM migration_local_generation_reconciliation')).rows[0].count).toBe(2);
  });
});
