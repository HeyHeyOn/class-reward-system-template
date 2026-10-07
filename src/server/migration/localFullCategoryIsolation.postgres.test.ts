// @vitest-environment node
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localFullCategoryIsolation.postgres.test.ts --maxWorkers=1
// Synthetic regression evidence, NOT full-category final persistence/activation.
// No schema/role/grant edits here. The existing harness provisions a NEW isolated
// PG17 cluster. Every fixture write, probe and row assertion below uses its actual
// app_runtime login, never database.owner, SET ROLE, or mocked PostgreSQL.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { importLegacyNormalizationManifest, inspectLegacyImport } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { stageLocalMultiAddedProducts } from './localMultiAddedProductStage';
import { reconcileLocalMultiAddedProducts, type LocalMultiAddedProductReconciliationInput } from './localMultiAddedProductReconciliation';
import { verifyLocalFullCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';
import { finalizeSheetsSnapshot, makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('Operational DB access forbidden'); } }));
const A = '30000000-0000-4000-8000-000000000001';
const B = '30000000-0000-4000-8000-000000000002';
// Deliberately shared job/business IDs: isolation must include the tenant.
const JOB = '40000000-0000-4000-8000-000000000001';
const TABLES = ['migration_jobs', 'migration_sources', 'migration_snapshots', 'audit_events',
  'migration_final_generations', 'migration_final_source_records', 'migration_final_targets'] as const;
const INSERTS = {
  migration_final_generations: ['tenant_id', 'job_id', 'generation_id', 'original_source_id', 'original_snapshot_id',
    'original_snapshot_phase', 'candidate_event_id', 'plan_event_id', 'candidate_manifest_digest', 'candidate_sheet_digest',
    'expected_state_version', 'phase', 'exclusion'],
  migration_final_source_records: ['tenant_id', 'job_id', 'generation_id', 'record_id', 'source_row_number',
    'source_row_hash', 'source_collection', 'source_record_id', 'redacted_record', 'canonical_record'],
  migration_final_targets: ['tenant_id', 'job_id', 'generation_id', 'record_id', 'target_table', 'target_id', 'canonical_target'],
  audit_events: ['tenant_id', 'event_id', 'job_id', 'event_type', 'operation_id', 'actor_user_id', 'entity_type', 'entity_id', 'redacted_details'],
} as const;
type InsertTable = keyof typeof INSERTS;
type Row = Record<string, unknown>;
type Acquisition = FinalGenerationPreparationInput['original'];
const sourceFiles = [
  'src/server/migration/localFullCategoryIsolation.postgres.test.ts',
  'src/server/migration/localMultiAddedProductReconciliation.postgres.test.ts',
  'src/server/migration/localMultiAddedProductReconciliation.ts', 'src/server/migration/localMultiAddedProductStage.ts',
  'src/server/migration/localMultiAddedProductPlan.ts', 'src/server/migration/localFullCategoryDeltaCoverage.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts', 'src/server/migration/manifest.ts',
  'src/server/migration/normalize.ts', 'src/server/migration/validators.ts',
  'src/server/migration/__fixtures__/normalization.ts', 'src/server/db/transaction.ts',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c',
];
const BLOCKERS = [
  'Full-category persisted source/target reconciliation: 0024 only accepts Products/products; no complete 16-table final store.',
  'Non-superuser SQL table-owner isolation: unchanged harness owns tables as postgres; no ALTER OWNER/role/grant changes allowed here.',
] as const;
function acquisition(tenant: string, added: boolean): Acquisition {
  const sheets = makeSupportedSheets(3, (tabs) => {
    if (added) for (let i = 0; i < 3; i++) tabs.Products.rows.push({ rowNumber: i + 3,
      cells: [`P${i + 2}`, `Synthetic-${i}`, '15', '3', 'TRUE', '', 'school', String(i + 2)], hash: '' });
  });
  return {
    sheets: finalizeSheetsSnapshot({ ...sheets, spreadsheetId: `synthetic-sheet-${tenant}` }),
    // Distinct synthetic Redis acquisitions avoid the real global source-owner
    // uniqueness constraint. No connection to Redis is made.
    redis: makeRedis({ operationBindings: [], v2Claims: [], sourceRevision: `synthetic-redis-${tenant}` }),
  };
}

// Missing infrastructure with opt-in is a failure, never a skip or PGlite fallback.
// No overall suite/hook timer; unchanged harness keeps its per-I/O safety bounds.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('PG17 LOCAL_CANDIDATE provenance/isolation (full-category acceptance blocked)', () => {
  let database: DisposablePostgres | undefined;
  let beforeHashes: Record<string, string>;
  let baseline: unknown;
  let request: FinalGenerationPreparationInput;
  let input: LocalMultiAddedProductReconciliationInput;
  let generation: Row;
  let samples: Record<InsertTable, Row>;
  const fixtures = new Map<string, { original: Acquisition; manifest: ReturnType<typeof createLegacyNormalizationManifest>; version: string }>();
  const cases: Record<string, string> = {};
  const statements: { label: string; tenant: string; code: string; constraint?: string }[] = [];
  const attemptId = randomUUID();
  const evidence: Record<string, unknown> = {
    syntheticOnly: true, authority: 'NONAUTHORITY', externalWriterExclusionProven: false,
    productionRoleEvidence: false, fullCategoryReconciliationProven: false,
    trustedTenantContextAssumed: true, sharedActualSqlRole: 'app_runtime',
    sqlTableOwnerIsolationProven: false, blockers: BLOCKERS,
  };
  const network = vi.fn(() => { throw new Error('External network forbidden'); });
  async function hashes() {
    return Object.fromEntries(await Promise.all(sourceFiles.map(async (file) =>
      [file, createHash('sha256').update(await readFile(resolve(file))).digest('hex')] as const)));
  }
  // Actual non-superuser login. Always rollback raw SQL probes, even on unexpected
  // success. Assertions still require the expected SQLSTATE (rollback is not denial).
  async function probe<T>(tenant: string | null, work: (connection: PoolClient) => Promise<T>): Promise<T> {
    const connection = await database!.runtime.connect();
    try {
      await connection.query('BEGIN');
      if (tenant !== null) await connection.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      const who = await connection.query(`SELECT current_user AS role,session_user AS login,
        NULLIF(current_setting('app.tenant_id',true),'') AS tenant,
        (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged`);
      expect(who.rows).toEqual([{ role: 'app_runtime', login: 'app_runtime', tenant, privileged: false }]);
      return await work(connection);
    } finally {
      try { await connection.query('ROLLBACK'); } finally { connection.release(); }
    }
  }
  async function snapshot() {
    const result: Record<string, Record<string, string>> = {};
    for (const tenant of [A, B]) result[tenant] = await probe(tenant, async (connection) => {
      const values: Record<string, string> = {};
      for (const table of TABLES) {
        const rows = await connection.query(`SELECT jsonb_build_array(t.xmin::text,to_jsonb(t))::text AS value FROM ${table} t ORDER BY value`);
        values[table] = sha256(canonicalJson(rows.rows));
      }
      return values;
    });
    return result;
  }
  async function state(label: string, tenant: string | null, text: string, values: unknown[], code: string, constraint?: string) {
    let actual = 'NO_ERROR'; let actualConstraint: string | undefined;
    try { await probe(tenant, (connection) => connection.query(text, values)); }
    catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
        actual = error.code;
        if ('constraint' in error && typeof error.constraint === 'string') actualConstraint = error.constraint;
      } else actual = 'NON_SQL_ERROR';
    }
    statements.push({ label, tenant: tenant ?? 'UNSET', code: actual, ...(actualConstraint ? { constraint: actualConstraint } : {}) });
    expect(actual, label).toBe(code);
    if (constraint) expect(actualConstraint, label).toBe(constraint);
  }
  function insert(table: InsertTable, row: Row) {
    const columns = INSERTS[table];
    return { text: `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
      values: columns.map((column) => row[column]) };
  }
  function checked(name: string, work: () => Promise<void>) {
    it(name, async () => {
      try {
        await work();
        expect(await snapshot()).toEqual(baseline);
        expect(network).not.toHaveBeenCalled();
        cases[name] = 'passed';
      } catch (error) { cases[name] = 'failed'; throw error; }
    }, 0);
  }
  async function inspect(actualTenant = A, override: Partial<LocalMultiAddedProductReconciliationInput> = {}) {
    return reconcileLocalMultiAddedProducts({ ...input, ...override }, {
      runTransaction: (_tenant, work) => database!.runTenantTransaction(actualTenant, work),
    });
  }

  beforeAll(async () => {
    beforeHashes = await hashes();
    vi.stubGlobal('fetch', network);
    evidence.setup = 'started';
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    // No privileged fixture writes: even tenant/job bootstrap runs as app_runtime
    // in this isolated cluster under its existing synthetic harness permissions.
    for (const tenant of [A, B]) {
      await database.runTenantTransaction(tenant, async (tx) => {
        await tx.execute(sql`INSERT INTO tenants (id,slug,display_name) VALUES (${tenant},${`synthetic-${tenant}`},'Synthetic')`);
        await tx.execute(sql`INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES (${tenant},${JOB},'VALIDATED')`);
      });
      const original = acquisition(tenant, false);
      const manifest = createLegacyNormalizationManifest({ tenantId: tenant, migrationJobId: JOB, ...original });
      expect(manifest.status).toBe('READY_FOR_IMPORT');
      await importLegacyNormalizationManifest({ tenantId: tenant, migrationJobId: JOB, manifest, runTransaction: database.runTenantTransaction });
      await database.runTenantTransaction(tenant, async (tx) => {
        await tx.execute(sql`UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now() WHERE tenant_id=${tenant} AND job_id=${JOB}`);
        await tx.execute(sql`UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now() WHERE tenant_id=${tenant} AND job_id=${JOB}`);
        expect(await inspectLegacyImport(tx, { tenantId: tenant, migrationJobId: JOB, manifest }, manifest)).toEqual([]);
      });
      const version = await probe(tenant, (connection) => connection.query('SELECT state_version::text AS version FROM migration_jobs WHERE job_id=$1', [JOB]));
      fixtures.set(tenant, { original, manifest, version: String(version.rows[0].version) });
    }
    const original = fixtures.get(A)!;
    request = { tenantId: A, migrationJobId: JOB, expectedStateVersion: original.version,
      originalSourceId: `sheet:${original.manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${original.manifest.manifestDigest}`,
      exclusionGenerationReference: 'a'.repeat(64), original: original.original, candidate: acquisition(A, true) };
    const staged = await stageLocalMultiAddedProducts(request, { runTransaction: database.runTenantTransaction });
    expect(staged).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN', activationAllowed: false, complete: false });
    const candidate = createLegacyNormalizationManifest({ tenantId: A, migrationJobId: JOB, ...request.candidate });
    input = { tenantId: A, migrationJobId: JOB, expectedStateVersion: original.version, originalSourceId: request.originalSourceId,
      originalSnapshotId: request.originalSnapshotId, generationId: staged.generationId, candidateManifestDigest: candidate.manifestDigest };
    samples = await probe(A, async (connection) => {
      const result = {} as Record<InsertTable, Row>;
      for (const table of Object.keys(INSERTS) as InsertTable[]) {
        const rows = await connection.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
        if (table === 'migration_final_generations') expect(rows.rows).toHaveLength(1);
        expect(rows.rows.length).toBeGreaterThan(0);
        result[table] = rows.rows[0].row;
      }
      return result;
    });
    generation = samples.migration_final_generations;
    baseline = await snapshot();
    evidence.generationId = staged.generationId;
    evidence.setup = 'completed';
  }, 0);

  afterAll(async () => {
    try {
      if (database) evidence.cleanup = await database.close();
      else evidence.cleanup = { verified: false, reason: 'Harness did not return; setup failure is not acceptance.' };
    } finally {
      vi.unstubAllGlobals();
      const after = await hashes();
      evidence.sourceFiles = after;
      evidence.sourceFilesUnchanged = beforeHashes !== undefined && canonicalJson(beforeHashes) === canonicalJson(after);
      evidence.cases = cases;
      evidence.sqlOutcomes = statements;
      evidence.provenanceSnapshots = baseline;
      const path = join(tmpdir(), `class-store-pg-full-isolation-${database?.runId ?? attemptId}-evidence.json`);
      await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.info(`Synthetic PostgreSQL isolation evidence: ${path}`);
      expect(after).toEqual(beforeHashes);
    }
  }, 0);

  checked('runs PostgreSQL 17 over owned no-network socket as non-superuser/non-owner login with FORCE RLS', async () => {
    expect(database!.evidence).toMatchObject({ networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0 });
    const metadata = await probe(A, async (connection) => {
      const backend = await connection.query("SELECT version() AS version,inet_server_addr() AS address,current_setting('transaction_isolation') AS isolation");
      const role = await connection.query(`SELECT current_user AS role,session_user AS login,
        rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user`);
      expect(role.rows).toEqual([{ role: 'app_runtime', login: 'app_runtime', rolsuper: false, rolbypassrls: false, rolinherit: false }]);
      const relations = await connection.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        pg_get_userbyid(c.relowner) AS owner,r.rolsuper AS owner_superuser,r.rolbypassrls AS owner_bypass
        FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [[...TABLES, 'migration_local_generation_reconciliation']]);
      expect(relations.rows).toHaveLength(TABLES.length + 1);
      for (const row of relations.rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owner: 'postgres', owner_superuser: true });
      expect(String(backend.rows[0].version)).toMatch(/^PostgreSQL 17\./);
      expect(backend.rows[0]).toMatchObject({ address: null, isolation: 'read committed' });
      return { backend: backend.rows[0], runtimeRole: role.rows[0], relations: relations.rows };
    });
    evidence.rolesAndRls = metadata;
  });

  checked('binds one stored generation and full normalized catalog plan without claiming full-category target reconciliation', async () => {
    const provenance = await probe(A, async (connection) => {
      const audit = await connection.query(`SELECT event_id,event_type,redacted_details FROM audit_events
        WHERE job_id=$1 AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_type`, [JOB]);
      expect(audit.rows).toHaveLength(3);
      for (const row of audit.rows) {
        const kind = String(row.event_type).replace('MIGRATION_PREPARATION_', '').toLowerCase();
        expect(row.event_id).toBe(`preparation:${kind}:${sha256(canonicalJson(row.redacted_details))}`);
        expect(row.redacted_details.storage).toBe('UNTRUSTED_PREPARATION');
      }
      const original = audit.rows.find((row) => row.event_type === 'MIGRATION_PREPARATION_ORIGINAL')!;
      const candidate = audit.rows.find((row) => row.event_type === 'MIGRATION_PREPARATION_CANDIDATE')!;
      const plan = audit.rows.find((row) => row.event_type === 'MIGRATION_PREPARATION_PLAN')!;
      expect(generation).toMatchObject({ tenant_id: A, job_id: JOB, generation_id: input.generationId,
        candidate_event_id: candidate.event_id, plan_event_id: plan.event_id,
        original_source_id: input.originalSourceId, original_snapshot_id: input.originalSnapshotId,
        candidate_manifest_digest: input.candidateManifestDigest, phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN' });
      expect(candidate.redacted_details.originalGenerationId).toBe(original.event_id);
      expect(plan.redacted_details.candidateGenerationId).toBe(candidate.event_id);
      const before = createLegacyNormalizationManifest({ tenantId: A, migrationJobId: JOB, ...original.redacted_details.acquisition as Acquisition });
      const after = createLegacyNormalizationManifest({ tenantId: A, migrationJobId: JOB, ...candidate.redacted_details.acquisition as Acquisition });
      expect(sha256(canonicalJson(before))).toBe(sha256(canonicalJson(original.redacted_details.manifest)));
      expect(sha256(canonicalJson(after))).toBe(sha256(canonicalJson(candidate.redacted_details.manifest)));
      const { status, blockers, changes } = plan.redacted_details;
      const coverage = verifyLocalFullCategoryDeltaCoverage(before.records, after.records, { status, blockers, changes });
      expect(coverage).toMatchObject({ authority: 'NONAUTHORITY', complete: false, activationAllowed: false,
        sourceReconciliation: 'NOT_PERFORMED', targetReconciliation: 'NOT_PERFORMED' });
      expect(coverage.coverage).toHaveLength(16);
      expect(coverage.coverage.filter((row) => row.addedCount)).toEqual([{ table: 'products', originalCount: 1, candidateCount: 4, addedCount: 3 }]);
      const binding = await connection.query(`SELECT s.source_id,p.snapshot_id,p.phase FROM migration_sources s
        JOIN migration_snapshots p ON p.tenant_id=s.tenant_id AND p.job_id=s.job_id AND p.source_id=s.source_id
        WHERE s.source_id=$1 AND p.snapshot_id=$2 AND s.job_id=$3`, [input.originalSourceId, input.originalSnapshotId, JOB]);
      expect(binding.rows).toEqual([{ source_id: input.originalSourceId, snapshot_id: input.originalSnapshotId, phase: 'PREFLIGHT' }]);
      const sources = await connection.query(`SELECT tenant_id,job_id,generation_id,record_id,source_row_number::text,
        source_row_hash,source_collection,source_record_id,redacted_record,canonical_record FROM migration_final_source_records`);
      const targets = await connection.query('SELECT tenant_id,job_id,generation_id,record_id,target_table,target_id,canonical_target FROM migration_final_targets');
      const expected = ['P2', 'P3', 'P4'].map((productId) => {
        const source = after.sourceRecords.find((row) => row.targetTable === 'products' && row.targetId === productId)!;
        if (source.source.kind !== 'SHEET') throw new Error('Synthetic product source not Sheet');
        const recordId = `local-final-record:${sha256(canonicalJson([A, JOB, input.generationId, source.source.rowHash, productId]))}`;
        const identity = { tenant_id: A, job_id: JOB, generation_id: input.generationId, record_id: recordId };
        return { source: { ...identity, source_row_number: String(source.source.rowNumber), source_row_hash: source.source.rowHash,
          source_collection: 'Products', source_record_id: productId, redacted_record: source.redactedSourceRecord, canonical_record: source.canonicalRecord },
        target: { ...identity, target_table: 'products', target_id: productId, canonical_target: after.records.products.find((row) => row.productId === productId) } };
      });
      const digest = (rows: readonly unknown[]) => sha256(canonicalJson(rows.map((row) => canonicalJson(row)).sort()));
      expect(sources.rows).toHaveLength(3); expect(targets.rows).toHaveLength(3);
      expect(digest(sources.rows)).toBe(digest(expected.map((row) => row.source)));
      expect(digest(targets.rows)).toBe(digest(expected.map((row) => row.target)));
      return { envelopeCount: audit.rows.length, sourceCount: sources.rows.length, targetCount: targets.rows.length,
        sourceSetDigest: digest(sources.rows), targetSetDigest: digest(targets.rows), coverage };
    });
    expect(await inspect()).toMatchObject({ status: 'MATCH', sourceCount: 3, targetCount: 3, authority: 'NONAUTHORITY', complete: false, activationAllowed: false });
    evidence.provenance = provenance;
  });

  checked('hides foreign provenance even with the exact IDs, while both tenants have valid own same-job imports', async () => {
    const visibility: Row[] = [];
    for (const tenant of [A, B]) await probe(tenant, async (connection) => {
      expect((await connection.query('SELECT job_id,status FROM migration_jobs')).rows).toEqual([{ job_id: JOB, status: 'READY' }]);
      expect((await connection.query('SELECT student_id FROM students')).rows).toEqual([{ student_id: 'S1' }]);
      for (const table of TABLES) {
        const own = await connection.query(`SELECT tenant_id,count(*)::int AS count FROM ${table} GROUP BY tenant_id`);
        expect(own.rows.every((row) => row.tenant_id === tenant)).toBe(true);
        if (tenant === A || ['migration_jobs', 'migration_sources', 'migration_snapshots'].includes(table)) expect(own.rows.length).toBe(1);
        const foreign = await connection.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [tenant === A ? B : A]);
        expect(foreign.rows).toHaveLength(0);
        visibility.push({ tenant, table, ownCount: own.rows[0]?.count ?? 0, foreignCount: foreign.rowCount });
      }
      if (tenant === B) expect((await connection.query('SELECT 1 FROM migration_final_generations WHERE generation_id=$1', [input.generationId])).rows).toHaveLength(0);
    });
    await expect(inspect(B)).rejects.toThrow('Local multi-added-product reconciliation refused.');
    const other = fixtures.get(B)!;
    await expect(inspect(B, { tenantId: B, expectedStateVersion: other.version,
      originalSourceId: `sheet:${other.manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${other.manifest.manifestDigest}` }))
      .rejects.toThrow('Local multi-added-product reconciliation refused.');
    await expect(inspect(A, { originalSourceId: `sheet:${other.manifest.sourceArtifacts.sheets.digest}` }))
      .rejects.toThrow('Local multi-added-product reconciliation refused.');
    expect(await inspect()).toMatchObject({ status: 'MATCH', complete: false });
    evidence.visibility = visibility;
  });

  for (const table of Object.keys(INSERTS) as InsertTable[]) checked(`RLS rejects tenant B INSERT of tenant A ${table}, not just a uniqueness error`, async () => {
    const query = insert(table, samples[table]);
    // Identical values pass the owner's RLS and reach UNIQUE; cross-tenant must
    // fail at RLS (42501), not because the borrowed parent/identity is missing.
    await state(`owner duplicate ${table}`, A, query.text, query.values, '23505');
    await state(`foreign insert ${table}`, B, query.text, query.values, '42501');
  });

  for (const [table, constraint] of [
    ['migration_final_generations', 'migration_final_generations_source_fk'],
    ['migration_final_source_records', 'migration_final_source_records_generation_fk'],
    ['migration_final_targets', 'migration_final_targets_record_fk'],
  ] as const) checked(`composite provenance FK rejects grafting foreign ${table} into the attacker's valid job`, async () => {
    const query = insert(table, { ...samples[table], tenant_id: B });
    await state(`foreign parent graft ${table}`, B, query.text, query.values, '23503', constraint);
  });

  checked('keeps owner evidence immutable and distinguishes trigger protection from missing mutation grants', async () => {
    await state('owner generation immutable', A, 'UPDATE migration_final_generations SET generation_id=generation_id WHERE generation_id=$1', [input.generationId], 'P0001');
    for (const table of ['audit_events', 'migration_snapshots']) {
      const key = table === 'audit_events' ? 'event_id' : 'snapshot_id';
      await state(`owner immutable UPDATE ${table}`, A, `UPDATE ${table} SET ${key}=${key}`, [], 'P0001');
      await state(`owner immutable DELETE ${table}`, A, `DELETE FROM ${table}`, [], 'P0001');
    }
    for (const table of ['migration_final_source_records', 'migration_final_targets']) {
      await state(`owner UPDATE ACL ${table}`, A, `UPDATE ${table} SET record_id=record_id`, [], '42501');
      await state(`owner DELETE ACL ${table}`, A, `DELETE FROM ${table}`, [], '42501');
      await state(`foreign UPDATE ACL ${table}`, B, `UPDATE ${table} SET record_id=record_id WHERE tenant_id=$1`, [A], '42501');
      await state(`foreign DELETE ACL ${table}`, B, `DELETE FROM ${table} WHERE tenant_id=$1`, [A], '42501');
    }
    await state('TRUNCATE ACL', A, 'TRUNCATE migration_final_targets', [], '42501');
  });

  checked('filters granted foreign UPDATE/DELETE to zero rather than relying on a privileged trigger probe', async () => {
    await probe(B, async (connection) => {
      const generationUpdate = await connection.query('UPDATE migration_final_generations SET generation_id=generation_id WHERE tenant_id=$1 RETURNING generation_id', [A]);
      expect(generationUpdate.rowCount).toBe(0);
      for (const table of ['audit_events', 'migration_snapshots']) {
        const key = table === 'audit_events' ? 'event_id' : 'snapshot_id';
        expect((await connection.query(`UPDATE ${table} SET ${key}=${key} WHERE tenant_id=$1 RETURNING ${key}`, [A])).rowCount).toBe(0);
        expect((await connection.query(`DELETE FROM ${table} WHERE tenant_id=$1 RETURNING ${key}`, [A])).rowCount).toBe(0);
      }
    });
  });

  checked('fails closed without tenant context and clears the pool context after successes/refusals', async () => {
    await probe(null, async (connection) => {
      for (const table of TABLES) expect((await connection.query(`SELECT 1 FROM ${table}`)).rows).toHaveLength(0);
    });
    const query = insert('migration_final_source_records', samples.migration_final_source_records);
    await state('unset context INSERT', null, query.text, query.values, '42501');
    expect(await inspect()).toMatchObject({ status: 'MATCH', complete: false });
    await probe(null, async (connection) => {
      expect((await connection.query('SELECT 1 FROM migration_final_generations')).rows).toHaveLength(0);
    });
  });

  checked('records actual Products-only CHECK and missing aggregate ACL as blockers, not full-category success', async () => {
    const source = insert('migration_final_source_records', { ...samples.migration_final_source_records,
      record_id: 'unsupported-source', source_record_id: 'S-extra', source_collection: 'Students' });
    await state('unsupported Students source', A, source.text, source.values, '23514', 'migration_final_source_records_shape_check');
    const target = insert('migration_final_targets', { ...samples.migration_final_targets, target_table: 'students' });
    await state('unsupported students target', A, target.text, target.values, '23514', 'migration_final_targets_shape_check');
    for (const tenant of [A, B]) await state('aggregate SELECT ACL', tenant, 'SELECT 1 FROM migration_local_generation_reconciliation', [], '42501');
    const privileges = await probe(A, (connection) => connection.query(`SELECT
      has_table_privilege(current_user,'migration_local_generation_reconciliation','SELECT') AS readable,
      has_table_privilege(current_user,'migration_local_generation_reconciliation','INSERT') AS writable`));
    expect(privileges.rows).toEqual([{ readable: false, writable: false }]);
    evidence.aggregateAcl = privileges.rows[0];
  });

  for (const blocker of BLOCKERS) it.skip(`BLOCKED acceptance: ${blocker}`, () => {
    throw new Error(blocker); // Deliberate, visible unimplemented acceptance; never a green placeholder.
  });
});
