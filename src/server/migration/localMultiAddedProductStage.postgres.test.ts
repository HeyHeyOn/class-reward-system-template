// @vitest-environment node
// Opt-in, synthetic only. No production client, TCP listener, Docker volume or host mount.
// RUN_REAL_POSTGRES=1 npm test -- src/server/migration/localMultiAddedProductStage.postgres.test.ts --maxWorkers=1
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { stageLocalMultiAddedProducts } from './localMultiAddedProductStage';

vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
const TENANT = '20000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '20000000-0000-4000-8000-000000000002';
const stageTables = ['migration_final_generations', 'migration_final_source_records', 'migration_final_targets'];
const productFiles = [
  'src/server/migration/localMultiAddedProductStage.ts',
  'src/server/migration/localMultiAddedProductPlan.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts',
  'src/server/db/transaction.ts',
];
const acquisition = (name = 'Notebook') => ({
  sheets: makeSupportedSheets(3, (tabs) => {
    for (let index = 0; index < 3; index += 1) tabs.Products.rows.push({ rowNumber: index + 3,
      cells: [`P${index + 2}`, `${name}${index}`, '15', '3', 'TRUE', '', 'school', String(index + 2)], hash: '' });
  }),
  redis: makeRedis({ operationBindings: [], v2Claims: [] }),
});

// Docker opt-in is explicit; when enabled, unavailable prerequisites FAIL rather
// than silently falling back to PGlite, a SQL model, or a skip.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('actual multi-ADDED stage on disposable PostgreSQL 17', () => {
  let database: DisposablePostgres | undefined;
  let request: Parameters<typeof stageLocalMultiAddedProducts>[0];
  let first: Awaited<ReturnType<typeof stageLocalMultiAddedProducts>>;
  let beforeHashes: Record<string, string>;
  const attemptId = randomUUID();
  const evidence: Record<string, unknown> = { syntheticOnly: true, applicationFunction: 'stageLocalMultiAddedProducts' };

  async function fileHashes() {
    return Object.fromEntries(await Promise.all(productFiles.map(async (file) =>
      [file, createHash('sha256').update(await readFile(resolve(file))).digest('hex')] as const)));
  }
  async function snapshot(exclude: readonly string[] = []) {
    const owner = database!.owner;
    const tables = await owner.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const result: { table: string; rows: string[] }[] = [];
    for (const { tablename } of tables.rows) {
      if (exclude.includes(tablename)) continue;
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected fixture table name');
      // PostgreSQL renders timestamps/bigints, avoiding JS Date serialization.
      // xmin also detects replacement writes with otherwise identical values.
      const rows = await owner.query<{ value: string }>(`SELECT jsonb_build_array(t.xmin::text, to_jsonb(t))::text AS value FROM "${tablename}" t ORDER BY value`);
      result.push({ table: tablename, rows: rows.rows.map(({ value }) => value) });
    }
    return result;
  }
  const stage = (value = request) => stageLocalMultiAddedProducts(value, {
    runTransaction: (tenantId, work) => database!.runTenantTransaction(tenantId, async (tx) => {
      try { return await work(tx); }
      catch (error) {
        // The public function intentionally masks internal errors. Retain only
        // diagnostic messages from the synthetic transaction, never SQL, query
        // parameters, or the acquired source payloads.
        const causes: { name: string; message: string }[] = [];
        let current: unknown = error;
        while (current instanceof Error && causes.length < 4) {
          causes.push({ name: current.name, message: 'query' in current ? 'Database query failed' : current.message });
          current = current.cause;
        }
        evidence.transactionFailure = causes;
        console.info('Synthetic transaction diagnostic:', JSON.stringify(causes));
        throw error;
      }
    }),
  });

  beforeAll(async () => {
    beforeHashes = await fileHashes();
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    await database.owner.query(`INSERT INTO tenants (id,slug,display_name) VALUES
      ($1,'pg-app-one','Synthetic One'),($2,'pg-app-two','Synthetic Two')`, [TENANT, OTHER_TENANT]);
    const original = { sheets: makeSupportedSheets(), redis: makeRedis({ operationBindings: [], v2Claims: [] }) };
    const manifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...original });
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    await database.owner.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [TENANT, JOB]);
    // These are the real importer + transaction runner, not a SQL stand-in.
    await importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest,
      runTransaction: database.runTenantTransaction });
    await database.owner.query(`UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now();
      UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now()`);
    const version = await database.owner.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs');
    request = { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: version.rows[0].version,
      originalSourceId: `sheet:${manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
      exclusionGenerationReference: 'a'.repeat(64), original, candidate: acquisition() };
    const initialInspection = await database.runTenantTransaction(TENANT, (tx) => inspectLegacyImport(tx,
      { tenantId: TENANT, migrationJobId: JOB, manifest }, manifest));
    evidence.initialOriginalInspection = initialInspection;
    // Observe the native application driver representation, without replacing
    // parsers, rewriting values, removing history, or bypassing the inspector.
    const instant = await database.runTenantTransaction(TENANT, (tx) => tx.execute(sql`
      SELECT starts_at,pg_typeof(starts_at)::text AS sql_type FROM promotions
      WHERE tenant_id=${TENANT} AND promotion_id='PROMO1'`));
    const actual = instant.rows[0].starts_at;
    const expected = manifest.records.promotions.find((row) => row.promotionId === 'PROMO1')!.startsAt;
    evidence.originalTimestampReadback = { actual, actualType: typeof actual, expected,
      sameInstant: typeof actual === 'string' && typeof expected === 'string' && Date.parse(actual) === Date.parse(expected),
      sameString: actual === expected, sqlType: instant.rows[0].sql_type };
  }, 120_000);

  afterAll(async () => {
    try {
      if (database) evidence.cleanup = await database.close();
    } finally {
      const after = await fileHashes();
      evidence.productFiles = after;
      evidence.productFilesUnchanged = canonicalJson(after) === canonicalJson(beforeHashes);
      const path = join(tmpdir(), `class-store-pg-app-${database?.runId ?? attemptId}-evidence.json`);
      await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.info(`PostgreSQL application integration evidence: ${path}`);
      expect(after).toEqual(beforeHashes);
    }
  }, 45_000);

  it('uses actual PG17 and a non-owner/non-bypass role over an isolated Unix socket', async () => {
    const result = await database!.runTenantTransaction(TENANT, (tx) => tx.execute(sql`SELECT version() AS version,
      current_user AS role, current_setting('app.tenant_id') AS tenant,
      inet_server_addr() AS address, pg_backend_pid() AS pid,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged`));
    expect(result.rows).toMatchObject([{ role: 'app_runtime', tenant: TENANT, address: null, privileged: false }]);
    expect(String(result.rows[0].version)).toMatch(/^PostgreSQL 17\./);
    expect(Number(result.rows[0].pid)).toBeGreaterThan(0);
    const connection = await database!.runtime.connect();
    try { expect((await connection.query("SELECT NULLIF(current_setting('app.tenant_id',true),'') AS tenant")).rows).toEqual([{ tenant: null }]); }
    finally { connection.release(); }
    evidence.realBackend = result.rows[0];
  });

  it('calls the actual TypeScript stage and stores all three source/target pairs without changing original state', async () => {
    expect(evidence.initialOriginalInspection).toEqual([]);
    const before = await snapshot([...stageTables, 'audit_events']);
    first = await stage();
    expect(first).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
      activationAllowed: false, complete: false, scope: 'MULTI_ADDED_PRODUCTS', targetTable: 'products' });
    expect(first.products.map(({ productId }) => productId)).toEqual(['P2', 'P3', 'P4']);
    expect(new Set(first.products.map(({ recordId }) => recordId)).size).toBe(3);
    const candidate = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...request.candidate });
    const sources = await database!.owner.query('SELECT tenant_id,job_id,generation_id,record_id,source_row_number::int,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record FROM migration_final_source_records ORDER BY source_record_id');
    const targets = await database!.owner.query('SELECT tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target FROM migration_final_targets ORDER BY target_id');
    expect(sources.rows).toHaveLength(3);
    expect(targets.rows).toHaveLength(3);
    for (const [index, product] of first.products.entries()) {
      const source = candidate.sourceRecords.find((row) => row.targetTable === 'products' && row.targetId === product.productId)!;
      if (source.source.kind !== 'SHEET') throw new Error('Fixture source is not a Sheet row');
      expect(product.recordId).toBe(`local-final-record:${sha256(canonicalJson([
        TENANT, JOB, first.generationId, source.source.rowHash, product.productId,
      ]))}`);
      const identity = { tenant_id: TENANT, job_id: JOB, generation_id: first.generationId, record_id: product.recordId };
      expect(sources.rows[index]).toEqual({ ...identity, source_row_number: source.source.rowNumber,
        source_row_hash: source.source.rowHash, source_collection: 'Products', source_record_id: product.productId,
        redacted_record: source.redactedSourceRecord, canonical_record: source.canonicalRecord });
      expect(targets.rows[index]).toEqual({ ...identity, target_table: 'products', target_id: product.productId,
        canonical_target: candidate.records.products.find((row) => row.productId === product.productId) });
    }
    expect((await database!.owner.query('SELECT count(*)::int AS count FROM migration_final_generations')).rows).toEqual([{ count: 1 }]);
    expect((await database!.owner.query("SELECT event_type FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_type")).rows)
      .toEqual(['CANDIDATE', 'ORIGINAL', 'PLAN'].map((kind) => ({ event_type: `MIGRATION_PREPARATION_${kind}` })));
    expect(await snapshot([...stageTables, 'audit_events'])).toEqual(before);
    const original = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...request.original });
    expect(await database!.runTenantTransaction(TENANT, (tx) => inspectLegacyImport(tx,
      { tenantId: TENANT, migrationJobId: JOB, manifest: original }, original))).toEqual([]);
    evidence.initialStage = { generations: 1, sources: 3, targets: 3, sourceTargetBytesExact: true, originalStateUnchanged: true };
  });

  it('retries twice without replacing rows or changing any public table and denies cross-tenant visibility', async () => {
    const before = await snapshot();
    expect(await stage()).toEqual(first);
    expect(await stage()).toEqual(first);
    expect(await snapshot()).toEqual(before);
    for (const table of stageTables) {
      const hidden = await database!.runTenantTransaction(OTHER_TENANT, (tx) => tx.execute(sql.raw(`SELECT * FROM ${table}`)));
      expect(hidden.rows).toEqual([]);
    }
    await expect(stage({ ...request, tenantId: OTHER_TENANT })).rejects.toThrow('Local multi-added-product stage refused.');
    expect(await snapshot()).toEqual(before);
    evidence.exactRetry = { attempts: 2, allPublicRowsAndXminUnchanged: true, crossTenantDenied: true };
  });

  it('proves a middle INSERT was reached, rolls back every new envelope/pair, then permits a clean retry', async () => {
    const next = { ...request, candidate: acquisition('Second generation') };
    const before = await snapshot();
    // nextval is intentionally not transactional: an owner-created fixture witness
    // survives rollback, so an unrelated early refusal cannot produce a false PASS.
    await database!.owner.query(`CREATE SEQUENCE public.fixture_mid_insert START 1;
      GRANT USAGE ON SEQUENCE public.fixture_mid_insert TO app_runtime;
      CREATE FUNCTION public.fixture_fail_middle() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE seen_sources integer; seen_targets integer; seen_envelopes integer;
      BEGIN
        IF NEW.target_id='P3' THEN
          SELECT count(*) INTO seen_sources FROM migration_final_source_records WHERE tenant_id=NEW.tenant_id AND generation_id=NEW.generation_id;
          SELECT count(*) INTO seen_targets FROM migration_final_targets WHERE tenant_id=NEW.tenant_id AND generation_id=NEW.generation_id;
          SELECT count(*) INTO seen_envelopes FROM audit_events a JOIN migration_final_generations g
            ON a.tenant_id=g.tenant_id AND a.event_id IN (g.candidate_event_id,g.plan_event_id,
              (SELECT redacted_details->>'originalGenerationId' FROM audit_events WHERE tenant_id=g.tenant_id AND event_id=g.candidate_event_id))
            WHERE g.tenant_id=NEW.tenant_id AND g.generation_id=NEW.generation_id;
          IF seen_sources<>2 OR seen_targets<>1 OR seen_envelopes<>3 THEN RAISE EXCEPTION 'fixture did not reach the expected middle'; END IF;
          PERFORM nextval('public.fixture_mid_insert');
          RAISE EXCEPTION 'fixture middle-target failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_fail_middle BEFORE INSERT ON migration_final_targets FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_middle()`);
    try {
      await expect(stage(next)).rejects.toThrow('Local multi-added-product stage refused.');
      const witness = await database!.owner.query('SELECT last_value::text,is_called FROM public.fixture_mid_insert');
      expect(witness.rows).toEqual([{ last_value: '1', is_called: true }]);
      expect(await snapshot()).toEqual(before);
      evidence.midInsertRollback = { witness: witness.rows[0], sourcesVisibleBeforeFault: 2,
        targetsVisibleBeforeFault: 1, envelopesVisibleBeforeFault: 3, allPublicRowsAndXminUnchanged: true };
    } finally {
      await database!.owner.query('DROP TRIGGER fixture_fail_middle ON migration_final_targets; DROP FUNCTION public.fixture_fail_middle(); DROP SEQUENCE public.fixture_mid_insert');
    }
    const recovered = await stage(next);
    expect(recovered.generationId).not.toBe(first.generationId);
    expect(recovered.products).toHaveLength(3);
    const counts = await database!.owner.query(`SELECT
      (SELECT count(*)::int FROM migration_final_generations) AS generations,
      (SELECT count(*)::int FROM migration_final_source_records) AS sources,
      (SELECT count(*)::int FROM migration_final_targets) AS targets`);
    expect(counts.rows).toEqual([{ generations: 2, sources: 6, targets: 6 }]);
    expect(await stage(next)).toEqual(recovered);
    evidence.retryAfterRollback = { ...counts.rows[0], exactRetry: true };
  });
});
