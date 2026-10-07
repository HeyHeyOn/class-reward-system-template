// @vitest-environment node
// Synthetic opt-in only; no PGlite fallback, external acquisition or production authority.
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localMultiAddedProductReconciliation.postgres.test.ts --maxWorkers=1
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import { stageLocalMultiAddedProducts } from './localMultiAddedProductStage';
import { reconcileLocalMultiAddedProducts, type LocalMultiAddedProductReconciliationInput } from './localMultiAddedProductReconciliation';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
const TENANT = '20000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '20000000-0000-4000-8000-000000000002';
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Local multi-added-product reconciliation refused.';
const stageTables = ['migration_final_generations', 'migration_final_source_records', 'migration_final_targets'];
const sourceFiles = [
  'src/server/migration/localMultiAddedProductReconciliation.postgres.test.ts',
  'src/server/migration/localMultiAddedProductReconciliation.ts',
  'src/server/migration/localMultiAddedProductReconciliation.test.ts',
  'src/server/migration/localMultiAddedProductStage.postgres.test.ts',
  'src/server/migration/localMultiAddedProductStage.ts', 'src/server/migration/localMultiAddedProductPlan.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts',
  'src/server/migration/manifest.ts', 'src/server/migration/normalize.ts', 'src/server/migration/validators.ts',
  'src/server/migration/operationalProjection.ts', 'src/server/db/transaction.ts',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c',
];
const acquisition = (name: string) => ({
  sheets: makeSupportedSheets(3, (tabs) => {
    for (let index = 0; index < 3; index += 1) tabs.Products.rows.push({ rowNumber: index + 3,
      cells: [`P${index + 2}`, `${name}${index}`, '15', '3', 'TRUE', '', 'school', String(index + 2)], hash: '' });
  }),
  redis: makeRedis({ operationBindings: [], v2Claims: [] }),
});
type TransactionWitness = { xid: string; pid: number; role: string; tenant: string; isolation: string };
type ReaderProbe = {
  transaction?: TransactionWitness; statements: string[]; forbiddenStatement: boolean;
  sourceCount?: number; targetCount?: number; outcome: 'started' | 'returned' | 'refused';
};
type StagedFixture = { input: LocalMultiAddedProductReconciliationInput; transaction: TransactionWitness };

// Disabled by default. With opt-in, setup failures remain failures: no catch-and-skip.
// Each hook/case has no overall timer; the unchanged harness retains bounded I/O safety checks.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('independent multi-ADDED reader on disposable PostgreSQL 17', () => {
  let database: DisposablePostgres | undefined;
  let request: Parameters<typeof stageLocalMultiAddedProducts>[0];
  let beforeHashes: Record<string, string> | undefined;
  const attemptId = randomUUID();
  const probes: ReaderProbe[] = [];
  const cases: Record<string, 'passed' | 'failed'> = {};
  const stages: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = {
    syntheticOnly: true, applicationFunctions: ['stageLocalMultiAddedProducts', 'reconcileLocalMultiAddedProducts'],
    authority: 'NONAUTHORITY', externalWriterExclusionProven: false, productionRoleProvisioningProven: false,
    separateConnectionRaceProven: false,
  };
  const dialect = new PgDialect();

  async function fileHashes() {
    return Object.fromEntries(await Promise.all(sourceFiles.map(async (file) =>
      [file, createHash('sha256').update(await readFile(resolve(file))).digest('hex')] as const)));
  }
  async function snapshot(exclude: readonly string[] = []) {
    const tables = await database!.owner.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const digests: Record<string, string> = {};
    for (const { tablename } of tables.rows) {
      if (exclude.includes(tablename)) continue;
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected synthetic table name');
      // PostgreSQL formats timestamps/bigints itself. Assertions/evidence expose
      // hashes only, never acquired source, JSON payload or credential values.
      const rows = await database!.owner.query<{ value: string }>(`SELECT jsonb_build_array(t.xmin::text,to_jsonb(t))::text AS value
        FROM "${tablename}" t ORDER BY value`);
      digests[tablename] = sha256(canonicalJson(rows.rows));
    }
    return digests;
  }
  async function transactionWitness(tx: TenantTransaction) {
    const result = await tx.execute(sql`SELECT pg_current_xact_id()::text AS xid,pg_backend_pid() AS pid,
      current_user AS role,current_setting('app.tenant_id') AS tenant,current_setting('transaction_isolation') AS isolation`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ role: 'app_runtime', isolation: 'read committed' });
    expect(String(result.rows[0].xid)).toMatch(/^[0-9]+$/);
    return result.rows[0] as TransactionWitness;
  }
  async function callReader(input: LocalMultiAddedProductReconciliationInput, actualTenant = input.tenantId) {
    const probe: ReaderProbe = { statements: [], forbiddenStatement: false, outcome: 'started' };
    probes.push(probe);
    try {
      const result = await reconcileLocalMultiAddedProducts(input, {
        runTransaction: (_tenantId, work) => database!.runTenantTransaction(actualTenant, async (tx) => {
          probe.transaction = await transactionWitness(tx);
          return work(new Proxy(tx, { get(target, key, receiver) {
            if (key !== 'execute') return Reflect.get(target, key, receiver);
            return async (query: Parameters<TenantTransaction['execute']>[0]) => {
              const text = typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
              if (!/^\s*SELECT\b/i.test(text) || /\b(?:set_config|nextval)\s*\(/i.test(text)
                || /\b(?:migration_local_generation_reconciliation|reconciliation_results)\b/i.test(text)) {
                probe.forbiddenStatement = true;
                throw new Error('Reader attempted a forbidden statement');
              }
              // Forward the original SQL unchanged through the real pg driver.
              // Record only COMPLETED statements, so refusal cannot mask query failure.
              const actual = await tx.execute(query);
              probe.statements.push(text);
              if (/\bFROM migration_final_source_records\b/i.test(text)) probe.sourceCount = actual.rows.length;
              if (/\bFROM migration_final_targets\b/i.test(text)) probe.targetCount = actual.rows.length;
              return actual;
            };
          } }));
        }),
      });
      probe.outcome = 'returned';
      return result;
    } catch (error) {
      probe.outcome = 'refused';
      throw error;
    }
  }
  function assertFullReads(sources: number, targets: number) {
    const probe = probes[probes.length - 1];
    expect(probe.forbiddenStatement).toBe(false);
    expect(probe.sourceCount).toBe(sources);
    expect(probe.targetCount).toBe(targets);
  }
  function expectedResult(input: LocalMultiAddedProductReconciliationInput) {
    return { ...input, authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
      activationAllowed: false, complete: false, scope: 'MULTI_ADDED_PRODUCTS',
      expectedCount: 3, sourceCount: 3, targetCount: 3, delta: 0, status: 'MATCH' };
  }
  async function stage(name: string): Promise<StagedFixture> {
    const next = { ...request, candidate: acquisition(name) };
    const originalBefore = await snapshot([...stageTables, 'audit_events']);
    let transaction: TransactionWitness | undefined;
    const staged = await stageLocalMultiAddedProducts(next, {
      runTransaction: (tenantId, work) => database!.runTenantTransaction(tenantId, async (tx) => {
        transaction = await transactionWitness(tx);
        return work(tx);
      }),
    });
    expect(staged).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
      activationAllowed: false, complete: false, scope: 'MULTI_ADDED_PRODUCTS', targetTable: 'products' });
    expect(transaction).toBeDefined();
    const candidate = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...next.candidate });
    const expected = ['P2', 'P3', 'P4'].map((productId) => {
      const source = candidate.sourceRecords.find((row) => row.targetTable === 'products' && row.targetId === productId)!;
      if (source.source.kind !== 'SHEET') throw new Error('Synthetic fixture source must be a Sheet row');
      const recordId = `local-final-record:${sha256(canonicalJson([TENANT, JOB, staged.generationId, source.source.rowHash, productId]))}`;
      const identity = { tenant_id: TENANT, job_id: JOB, generation_id: staged.generationId, record_id: recordId };
      return { productId, recordId,
        source: { ...identity, source_row_number: String(source.source.rowNumber), source_row_hash: source.source.rowHash,
          source_collection: 'Products', source_record_id: productId, redacted_record: source.redactedSourceRecord, canonical_record: source.canonicalRecord },
        target: { ...identity, target_table: 'products', target_id: productId,
          canonical_target: candidate.records.products.find((row) => row.productId === productId) } };
    });
    expect(staged.products).toEqual(expected.map(({ productId, recordId }) => ({ productId, recordId })));
    const sources = await database!.owner.query(`SELECT tenant_id,job_id,generation_id,record_id,
      source_row_number::text,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record
      FROM migration_final_source_records WHERE tenant_id=$1 AND generation_id=$2 ORDER BY source_record_id`, [TENANT, staged.generationId]);
    const targets = await database!.owner.query(`SELECT tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target
      FROM migration_final_targets WHERE tenant_id=$1 AND generation_id=$2 ORDER BY target_id`, [TENANT, staged.generationId]);
    expect(sources.rows).toHaveLength(expected.length);
    expect(targets.rows).toHaveLength(expected.length);
    const sourceDigest = sha256(canonicalJson(sources.rows));
    const targetDigest = sha256(canonicalJson(targets.rows));
    expect(sourceDigest).toBe(sha256(canonicalJson(expected.map(({ source }) => source))));
    expect(targetDigest).toBe(sha256(canonicalJson(expected.map(({ target }) => target))));
    expect(await snapshot([...stageTables, 'audit_events'])).toEqual(originalBefore);
    stages.push({ name, generationId: staged.generationId, transaction, sources: sources.rows.length, targets: targets.rows.length,
      sourceDigest, targetDigest, fullPayloadSetsExact: true, originalRowsAndXminUnchanged: true });
    return { input: { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: request.expectedStateVersion,
      originalSourceId: request.originalSourceId, originalSnapshotId: request.originalSnapshotId,
      generationId: staged.generationId, candidateManifestDigest: candidate.manifestDigest }, transaction: transaction! };
  }
  async function fakeAggregate(input: LocalMultiAddedProductReconciliationInput) {
    // Legal, immutable, arithmetically consistent SQL evidence is not row truth.
    // Owner INSERT in the disposable fixture; no role/grant changes are needed.
    await database!.owner.query(`INSERT INTO migration_local_generation_reconciliation
      (tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_manifest_digest,
        category,expected_count,actual_count,delta,status)
      VALUES ($1,$2,$3,$4,$5,$6,'PRODUCTS',999,999,0,'MATCH')`,
    [TENANT, JOB, input.generationId, input.originalSourceId, input.originalSnapshotId, input.candidateManifestDigest]);
    const result = await database!.owner.query(`SELECT expected_count::int,actual_count::int,delta::int,status
      FROM migration_local_generation_reconciliation WHERE tenant_id=$1 AND generation_id=$2`, [TENANT, input.generationId]);
    expect(result.rows).toEqual([{ expected_count: 999, actual_count: 999, delta: 0, status: 'MATCH' }]);
    return result.rows[0];
  }
  function checked(name: string, work: () => Promise<void>) {
    it(name, async () => {
      try {
        await work();
        expect(probes.every((probe) => !probe.forbiddenStatement)).toBe(true);
        cases[name] = 'passed';
      } catch (error) { cases[name] = 'failed'; throw error; }
    }, 0);
  }

  beforeAll(async () => {
    beforeHashes = await fileHashes();
    evidence.setup = 'started';
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    await database.owner.query(`INSERT INTO tenants (id,slug,display_name) VALUES
      ($1,'pg-reader-one','Synthetic One'),($2,'pg-reader-two','Synthetic Two')`, [TENANT, OTHER_TENANT]);
    const original = { sheets: makeSupportedSheets(), redis: makeRedis({ operationBindings: [], v2Claims: [] }) };
    const manifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...original });
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    await database.owner.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [TENANT, JOB]);
    await importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest, runTransaction: database.runTenantTransaction });
    await database.owner.query(`UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now();
      UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now()`);
    const version = await database.owner.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, JOB]);
    request = { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: version.rows[0].version,
      originalSourceId: `sheet:${manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
      exclusionGenerationReference: 'a'.repeat(64), original, candidate: acquisition('Initial') };
    const issues = await database.runTenantTransaction(TENANT, (tx) => inspectLegacyImport(tx,
      { tenantId: TENANT, migrationJobId: JOB, manifest }, manifest));
    expect(issues).toEqual([]);
    evidence.initialOriginalInspectionIssues = issues.length;
    evidence.setup = 'completed';
  }, 0);

  afterAll(async () => {
    try {
      if (database) evidence.cleanup = await database.close();
      else evidence.cleanup = { verified: false, reason: 'Harness did not return; inspect its setup/cleanup error.' };
    } finally {
      const after = await fileHashes();
      evidence.sourceFiles = after;
      evidence.sourceFilesUnchanged = beforeHashes !== undefined && canonicalJson(beforeHashes) === canonicalJson(after);
      evidence.cases = cases;
      evidence.stagedGenerations = stages;
      evidence.readerTransactions = probes.map(({ statements, ...probe }) => ({ ...probe,
        completedSelectStatements: statements.length, statementDigest: sha256(canonicalJson(statements)) }));
      const path = join(tmpdir(), `class-store-pg-reader-${database?.runId ?? attemptId}-evidence.json`);
      await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.info(`PostgreSQL persisted-reader integration evidence: ${path}`);
      expect(after).toEqual(beforeHashes);
    }
  }, 0);

  checked('uses real PG17 with the existing synthetic non-owner runtime and FORCE RLS', async () => {
    const result = await database!.runTenantTransaction(TENANT, (tx) => tx.execute(sql`SELECT version() AS version,
      current_user AS role,current_setting('app.tenant_id') AS tenant,inet_server_addr() AS address,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged`));
    expect(result.rows).toMatchObject([{ role: 'app_runtime', tenant: TENANT, address: null, privileged: false }]);
    expect(String(result.rows[0].version)).toMatch(/^PostgreSQL 17\./);
    const relations = await database!.owner.query(`SELECT relname,relrowsecurity,relforcerowsecurity,
      pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname`, [stageTables]);
    expect(relations.rows).toHaveLength(stageTables.length);
    for (const row of relations.rows) {
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      expect(row.owner).not.toBe('app_runtime');
    }
    evidence.realBackend = result.rows[0];
    evidence.relationIsolation = relations.rows;
  });

  checked('stages real application rows then inspects complete exact sets in a separate read-only transaction', async () => {
    const fixture = await stage('Clean');
    const before = await snapshot();
    const result = await callReader(fixture.input);
    expect(result).toEqual(expectedResult(fixture.input));
    assertFullReads(3, 3);
    const firstReader = probes[probes.length - 1].transaction!;
    expect(firstReader.xid).not.toBe(fixture.transaction.xid);
    expect(await callReader(fixture.input)).toEqual(result);
    assertFullReads(3, 3);
    expect(probes[probes.length - 1].transaction!.xid).not.toBe(firstReader.xid);
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/credential|acquisition|canonical_record|redacted_record|Clean/i);
    evidence.readOnlyInspection = { stageTransaction: fixture.transaction, firstReader,
      repeatReader: probes[probes.length - 1].transaction, allPublicRowsAndXminUnchanged: true, result };
  });

  checked('ignores a false immutable MATCH aggregate rather than substituting its counts', async () => {
    const { input } = await stage('Aggregate');
    const aggregate = await fakeAggregate(input);
    const before = await snapshot();
    const result = await callReader(input);
    expect(result).toEqual(expectedResult(input));
    assertFullReads(3, 3);
    expect(await snapshot()).toEqual(before);
    evidence.falseAggregate = { aggregate, recomputedCount: result.expectedCount, allPublicRowsAndXminUnchanged: true };
  });

  for (const withTarget of [false, true]) checked(`refuses extra source ${withTarget ? 'and target pair' : 'without target'} despite MATCH, without healing`, async () => {
    const { input } = await stage(withTarget ? 'Pair' : 'Orphan');
    const aggregate = await fakeAggregate(input);
    const extraId = `synthetic-extra:${input.generationId}`;
    const inserted = await database!.runTenantTransaction(TENANT, async (tx) => {
      // No disabled triggers, no invalid FK and no overwritten source evidence.
      const sources = await tx.execute(sql`INSERT INTO migration_final_source_records
        (tenant_id,job_id,generation_id,record_id,source_row_number,source_row_hash,source_collection,source_record_id,redacted_record,canonical_record)
        SELECT tenant_id,job_id,generation_id,${extraId},source_row_number,source_row_hash,source_collection,'P-extra',redacted_record,canonical_record
        FROM migration_final_source_records WHERE tenant_id=${TENANT} AND generation_id=${input.generationId} AND source_record_id='P2'
        RETURNING record_id`);
      let targetCount = 0;
      if (withTarget) {
        const targets = await tx.execute(sql`INSERT INTO migration_final_targets
          (tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target)
          SELECT tenant_id,job_id,generation_id,${extraId},target_table,'P-extra',canonical_target FROM migration_final_targets
          WHERE tenant_id=${TENANT} AND generation_id=${input.generationId} AND target_id='P2' RETURNING record_id`);
        targetCount = targets.rows.length;
      }
      return { sources: sources.rows.length, targets: targetCount };
    });
    expect(inserted).toEqual({ sources: 1, targets: withTarget ? 1 : 0 });
    const joined = await database!.owner.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM migration_final_source_records s JOIN migration_final_targets t
        ON t.tenant_id=s.tenant_id AND t.job_id=s.job_id AND t.generation_id=s.generation_id AND t.record_id=s.record_id
      WHERE s.tenant_id=$1 AND s.generation_id=$2`, [TENANT, input.generationId]);
    expect(joined.rows).toEqual([{ count: withTarget ? 4 : 3 }]);
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(callReader(input)).rejects.toThrow(REFUSAL);
      assertFullReads(4, withTarget ? 4 : 3);
      expect(await snapshot()).toEqual(before);
    }
    evidence[withTarget ? 'extraPairRefusal' : 'orphanRefusal'] = { aggregate, inserted, joinedCount: joined.rows[0].count,
      actualSources: probes[probes.length - 1].sourceCount, actualTargets: probes[probes.length - 1].targetCount,
      attempts: 2, allPublicRowsAndXminUnchanged: true, constraintsAndImmutableGuardsNotDisabled: true };
  });

  checked('enforces runtime tenant isolation and refuses wrong tenant/job/binding without writes', async () => {
    const { input } = await stage('Isolation');
    const before = await snapshot();
    const visibility: Record<string, { own: number; other: number }> = {};
    for (const table of stageTables) {
      const readCount = (tenant: string) => database!.runTenantTransaction(tenant, (tx) => tx.execute(sql.raw(`SELECT count(*)::int AS count FROM ${table}`)));
      const own = await readCount(TENANT);
      const other = await readCount(OTHER_TENANT);
      expect(Number(own.rows[0].count)).toBeGreaterThan(0);
      expect(other.rows).toEqual([{ count: 0 }]);
      visibility[table] = { own: Number(own.rows[0].count), other: Number(other.rows[0].count) };
    }
    for (const changed of [{ tenantId: OTHER_TENANT }, { migrationJobId: 'foreign-job' }, { expectedStateVersion: '999' },
      { candidateManifestDigest: 'b'.repeat(64) }, { originalSnapshotId: `import:${'c'.repeat(64)}` }]) {
      await expect(callReader({ ...input, ...changed })).rejects.toThrow(REFUSAL);
    }
    await expect(callReader(input, OTHER_TENANT)).rejects.toThrow(REFUSAL);
    expect(await callReader(input)).toEqual(expectedResult(input));
    assertFullReads(3, 3);
    expect(await snapshot()).toEqual(before);
    const connection = await database!.runtime.connect();
    try { expect((await connection.query("SELECT NULLIF(current_setting('app.tenant_id',true),'') AS tenant")).rows).toEqual([{ tenant: null }]); }
    finally { connection.release(); }
    evidence.tenantIsolation = { visibility, wrongBindingRefused: true, transactionTenantMismatchRefused: true,
      borrowedConnectionTenantCleared: true, allPublicRowsAndXminUnchanged: true };
  });
});
