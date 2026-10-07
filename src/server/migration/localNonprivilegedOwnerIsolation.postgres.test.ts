// @vitest-environment node
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localNonprivilegedOwnerIsolation.postgres.test.ts --maxWorkers=1
// Synthetic NONAUTHORITY: FORCE RLS constrains owner DML, NOT malicious owner DDL.
// Only bootstrap uses the harness's postgres connection. Probes use actual login
// roles over its exact owned Unix-socket stream, never SET ROLE from a superuser.
// All adversarial DDL/DML is transaction-local and unconditionally rolled back.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { importLegacyNormalizationManifest } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { stageLocalMultiAddedProducts } from './localMultiAddedProductStage';
import { reconcileLocalMultiAddedProducts, type LocalMultiAddedProductReconciliationInput } from './localMultiAddedProductReconciliation';
import { finalizeSheetsSnapshot, makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('Operational DB access forbidden'); } }));
const A = '50000000-0000-4000-8000-000000000001';
const B = '50000000-0000-4000-8000-000000000002';
const JOB = '60000000-0000-4000-8000-000000000001';
const OWNER = 'synthetic_provenance_owner';
const MEMBER = 'synthetic_owner_member';
const RUNTIME = 'app_runtime';
type Login = typeof OWNER | typeof MEMBER | typeof RUNTIME;
type Row = Record<string, unknown>;
const TABLES = ['migration_jobs', 'migration_sources', 'migration_snapshots', 'audit_events',
  'migration_final_generations', 'migration_final_source_records', 'migration_final_targets'] as const;
const IMMUTABLE = ['migration_snapshots', 'audit_events', 'migration_final_generations',
  'migration_final_source_records', 'migration_final_targets'] as const;
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
const SOURCE_FILES = [
  'src/server/migration/localNonprivilegedOwnerIsolation.postgres.test.ts',
  'src/server/migration/localFullCategoryIsolation.postgres.test.ts',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c',
  'src/server/migration/localMultiAddedProductStage.ts', 'src/server/migration/localMultiAddedProductReconciliation.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts',
  'src/server/migration/__fixtures__/normalization.ts', 'src/server/db/migrations/0024_local_final_generation_stage.sql',
];
function acquisition(tenant: string, added: boolean): FinalGenerationPreparationInput['original'] {
  const sheets = makeSupportedSheets(3, (tabs) => {
    if (added) for (let i = 0; i < 3; i++) tabs.Products.rows.push({ rowNumber: i + 3,
      cells: [`P${i + 2}`, `Synthetic-${i}`, '15', '3', 'TRUE', '', 'school', String(i + 2)], hash: '' });
  });
  return { sheets: finalizeSheetsSnapshot({ ...sheets, spreadsheetId: `owner-synthetic-sheet-${tenant}` }),
    redis: makeRedis({ operationBindings: [], v2Claims: [], sourceRevision: `owner-synthetic-redis-${tenant}` }) };
}
function insert(table: InsertTable, row: Row) {
  const columns = INSERTS[table];
  return { text: `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
    values: columns.map((column) => row[column]) };
}

// Opt-in prerequisite failures fail the suite; no PGlite fallback/skipped acceptance.
// No suite/hook time budget; unchanged harness per-I/O bounds remain in force.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('PG17 nonprivileged provenance owner: FORCE RLS and its DDL trust boundary', () => {
  let database: DisposablePostgres | undefined;
  const pools = new Map<Login, Pool>();
  const inputs = new Map<string, LocalMultiAddedProductReconciliationInput>();
  const samples = new Map<string, Record<InsertTable, Row>>();
  let beforeHashes: Record<string, string>;
  let globalBaseline: unknown;
  let baseline: unknown;
  const cases: Record<string, string> = {};
  const outcomes: Row[] = [];
  const attempt = randomUUID();
  const network = vi.fn(() => { throw new Error('External network forbidden'); });
  const evidence: Row = {
    authority: 'NONAUTHORITY', syntheticOnly: true, productionRoleIsolationProven: false,
    fullCategoryFinalReconciliationProven: false, externalWriterExclusionProven: false,
    activationAllowed: false, complete: false,
    boundaries: ['Only synthetic Products LOCAL_CANDIDATE provenance is staged.',
      'FORCE RLS constrains ordinary owner DML only while policies and FORCE remain intact.',
      'Table owners can change RLS/policies/user triggers; NOINHERIT does not prevent authorized SET ROLE.',
      'app.tenant_id is trusted application context, not an unforgeable login-to-tenant binding.'],
  };
  async function hashes() {
    return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (file) =>
      [file, createHash('sha256').update(await readFile(resolve(file))).digest('hex')] as const)));
  }
  async function identity(client: PoolClient, login: Login, ownerRole: boolean, tenant: string | null) {
    const result = await client.query(`SELECT current_user AS role,session_user AS login,
      NULLIF(current_setting('app.tenant_id',true),'') AS tenant,
      rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit
      FROM pg_roles WHERE rolname=current_user`);
    expect(result.rows).toEqual([{ role: ownerRole ? OWNER : login, login, tenant,
      rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false }]);
    return result.rows[0];
  }
  async function probe<T>(login: Login, tenant: string | null, work: (client: PoolClient) => Promise<T>, ownerRole = false): Promise<T> {
    const client = await pools.get(login)!.connect();
    try {
      await client.query('BEGIN');
      if (tenant !== null) await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      if (ownerRole) {
        expect(login).toBe(MEMBER);
        await client.query(`SET LOCAL ROLE ${OWNER}`);
      }
      await identity(client, login, ownerRole, tenant);
      return await work(client);
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
  }
  async function state(label: string, login: Login, tenant: string | null, text: string, values: unknown[],
    code: string, ownerRole = false, constraint?: string, message?: RegExp) {
    let actual = 'NO_ERROR'; let actualConstraint: string | undefined; let actualMessage = '';
    try { await probe(login, tenant, (client) => client.query(text, values), ownerRole); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
        actual = error.code;
        if ('constraint' in error && typeof error.constraint === 'string') actualConstraint = error.constraint;
        if ('message' in error && typeof error.message === 'string') actualMessage = error.message;
      } else actual = 'NON_SQL_ERROR';
    }
    outcomes.push({ label, login, role: ownerRole ? OWNER : login, tenant, sqlstate: actual,
      ...(actualConstraint ? { constraint: actualConstraint } : {}) });
    expect(actual, label).toBe(code);
    if (constraint) expect(actualConstraint, label).toBe(constraint);
    if (message) expect(actualMessage, label).toMatch(message);
  }
  // Catalog access is public metadata, not privileged evidence row access.
  async function globalContract(client: PoolClient) {
    return {
      roles: (await client.query(`SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit,rolcanlogin
        FROM pg_roles WHERE rolname IN ('postgres','app_runtime') ORDER BY rolname`)).rows,
      memberships: (await client.query(`SELECT to_jsonb(m) AS membership FROM pg_auth_members m
        WHERE m.member IN (SELECT oid FROM pg_roles WHERE rolname IN ('postgres','app_runtime')) ORDER BY m.roleid,m.member,m.grantor`)).rows,
      schemas: (await client.query(`SELECT nspname,nspowner::text,nspacl::text FROM pg_namespace
        WHERE nspname='public'`)).rows,
      functions: (await client.query(`SELECT oid::text,proowner::text,proacl::text,prosecdef,pg_get_functiondef(oid) AS definition
        FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows,
      runtimeAcl: (await client.query(`SELECT c.relname,p.privilege,has_table_privilege('app_runtime',c.oid,p.privilege) AS allowed
        FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.relname,p.privilege`)).rows,
      runtimeColumnAcl: (await client.query(`SELECT c.relname,a.attname,p.privilege,
        has_column_privilege('app_runtime',c.oid,a.attnum,p.privilege) AS allowed
        FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
        CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(privilege)
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname,a.attnum,p.privilege`)).rows,
    };
  }
  async function catalog(client: PoolClient) {
    return {
      tables: (await client.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity,c.relforcerowsecurity,c.relacl::text FROM pg_class c
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.relname`)).rows,
      policies: (await client.query(`SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
        FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`)).rows,
      triggers: (await client.query(`SELECT t.oid::text,t.tgrelid::text,t.tgname,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid`)).rows,
      constraints: (await client.query(`SELECT c.oid::text,c.conname,c.convalidated,pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c WHERE c.connamespace='public'::regnamespace ORDER BY c.oid`)).rows,
    };
  }
  async function snapshot() {
    const rows: Record<string, unknown> = {};
    for (const tenant of [A, B]) rows[tenant] = await probe(OWNER, tenant, async (client) => {
      const tables: Row = {};
      for (const table of TABLES) {
        const result = await client.query(`SELECT jsonb_build_array(t.xmin::text,to_jsonb(t))::text AS row FROM ${table} t ORDER BY row`);
        expect(result.rows.length, `${tenant}/${table} nonvacuous baseline`).toBeGreaterThan(0);
        tables[table] = { count: result.rowCount, digest: sha256(canonicalJson(result.rows)) };
      }
      return tables;
    });
    return { rows, catalog: await probe(RUNTIME, null, catalog), global: await probe(RUNTIME, null, globalContract) };
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

  beforeAll(async () => {
    beforeHashes = await hashes();
    vi.stubGlobal('fetch', network);
    evidence.setup = 'started';
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    expect(database.evidence).toMatchObject({ networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0 });
    pools.set(RUNTIME, database.runtime);
    globalBaseline = await probe(RUNTIME, null, globalContract);
    const initialCatalog = await probe(RUNTIME, null, catalog);
    // Actual app calls stage separate tenant-bound generations with colliding
    // business/job IDs, so foreign-row absence is never an empty-fixture proof.
    for (const tenant of [A, B]) {
      await database.runTenantTransaction(tenant, async (tx) => {
        await tx.execute(sql`INSERT INTO tenants (id,slug,display_name) VALUES (${tenant},${`owner-synthetic-${tenant}`},'Synthetic')`);
        await tx.execute(sql`INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES (${tenant},${JOB},'VALIDATED')`);
      });
      const original = acquisition(tenant, false);
      const manifest = createLegacyNormalizationManifest({ tenantId: tenant, migrationJobId: JOB, ...original });
      expect(manifest.status).toBe('READY_FOR_IMPORT');
      await importLegacyNormalizationManifest({ tenantId: tenant, migrationJobId: JOB, manifest, runTransaction: database.runTenantTransaction });
      await database.runTenantTransaction(tenant, async (tx) => {
        await tx.execute(sql`UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now() WHERE tenant_id=${tenant} AND job_id=${JOB}`);
        await tx.execute(sql`UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now() WHERE tenant_id=${tenant} AND job_id=${JOB}`);
      });
      const version = await probe(RUNTIME, tenant, async (client) =>
        (await client.query('SELECT state_version::text AS version FROM migration_jobs WHERE job_id=$1', [JOB])).rows[0].version as string);
      const request: FinalGenerationPreparationInput = { tenantId: tenant, migrationJobId: JOB, expectedStateVersion: version,
        originalSourceId: `sheet:${manifest.sourceArtifacts.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
        exclusionGenerationReference: 'a'.repeat(64), original, candidate: acquisition(tenant, true) };
      const staged = await stageLocalMultiAddedProducts(request, { runTransaction: database.runTenantTransaction });
      expect(staged).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN', activationAllowed: false, complete: false });
      const candidate = createLegacyNormalizationManifest({ tenantId: tenant, migrationJobId: JOB, ...request.candidate });
      inputs.set(tenant, { tenantId: tenant, migrationJobId: JOB, expectedStateVersion: version,
        originalSourceId: request.originalSourceId, originalSnapshotId: request.originalSnapshotId,
        generationId: staged.generationId, candidateManifestDigest: candidate.manifestDigest });
      samples.set(tenant, await probe(RUNTIME, tenant, async (client) => {
        const result = {} as Record<InsertTable, Row>;
        for (const table of Object.keys(INSERTS) as InsertTable[]) {
          const rows = await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
          expect(rows.rows.length).toBeGreaterThan(0);
          result[table] = rows.rows[0].row;
        }
        return result;
      }));
    }
    // The sole privileged SQL block provisions only this new owned synthetic
    // cluster. No original role, policy, function, schema ACL or runtime grant is
    // changed. Ownership changes are explicit and limited to TABLES above.
    const bootstrap = await database.owner.connect();
    try {
      await bootstrap.query('BEGIN');
      await bootstrap.query(`CREATE ROLE ${OWNER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
        CREATE ROLE ${MEMBER} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
        GRANT ${OWNER} TO ${MEMBER} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      for (const table of TABLES) await bootstrap.query(`ALTER TABLE ${table} OWNER TO ${OWNER}`);
      await bootstrap.query('COMMIT');
    } catch (error) { await bootstrap.query('ROLLBACK'); throw error; }
    finally { bootstrap.release(); }
    // Reuse ONLY the harness's exact stream factory; explicitly bind connection
    // settings rather than consulting PGHOST/PGUSER/DATABASE_URL/host ports.
    const stream = database.runtime.options.stream;
    if (typeof stream !== 'function') throw new Error('Owned harness stream unavailable; do not fall back to a host connection');
    for (const login of [OWNER, MEMBER] as const) {
      const pool = new Pool({ ...database.runtime.options, user: login, database: 'postgres', host: '/var/run/postgresql',
        port: 5432, password: () => '', connectionString: undefined, ssl: false, stream, max: 1 });
      pool.on('error', () => { /* Queries fail closed; do not log connection config. */ });
      pools.set(login, pool);
    }
    expect(await probe(RUNTIME, null, globalContract)).toEqual(globalBaseline);
    const afterCatalog = await probe(RUNTIME, null, catalog);
    expect(afterCatalog.policies).toEqual(initialCatalog.policies);
    expect(afterCatalog.triggers).toEqual(initialCatalog.triggers);
    expect(afterCatalog.constraints).toEqual(initialCatalog.constraints);
    expect(afterCatalog.tables.map((row) => ({ ...row,
      owner: (TABLES as readonly string[]).includes(row.relname) ? 'postgres' : row.owner,
      relacl: row.relacl === null ? null : row.relacl.replaceAll(OWNER, 'postgres') }))).toEqual(initialCatalog.tables);
    evidence.ownershipChange = { tables: TABLES, from: 'postgres', to: OWNER, existingGlobalContractUnchanged: true };
    baseline = await snapshot();
    evidence.setup = 'completed';
  }, 0);

  afterAll(async () => {
    try {
      // Custom pools share the owned relay factory; close them before the harness
      // validates/removes its exact ID+label. Never enumerate/remove other PGs.
      const ended = await Promise.allSettled([pools.get(OWNER)?.end(), pools.get(MEMBER)?.end()]);
      evidence.customPoolsClosed = ended.every((result) => result.status === 'fulfilled');
      if (database) evidence.cleanup = await database.close();
      expect(ended.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      const after = await hashes();
      evidence.sourceFiles = after;
      evidence.sourceFilesUnchanged = beforeHashes !== undefined && canonicalJson(after) === canonicalJson(beforeHashes);
      evidence.baseline = baseline;
      evidence.cases = cases;
      evidence.sqlOutcomes = outcomes;
      const path = join(tmpdir(), `class-store-pg-owner-isolation-${database?.runId ?? attempt}-evidence.json`);
      await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.info(`Synthetic nonprivileged owner evidence: ${path}`);
      expect(after).toEqual(beforeHashes);
    }
  }, 0);

  checked('proves real PG17 login/owner flags, FORCE RLS and unchanged global/runtime contracts by SQL', async () => {
    const metadata = await probe(OWNER, A, async (client) => {
      const server = (await client.query('SELECT version(),inet_server_addr() AS address')).rows[0];
      expect(server.version).toMatch(/^PostgreSQL 17\./); expect(server.address).toBeNull();
      const role = await identity(client, OWNER, false, A);
      const relations = (await client.query(`SELECT relname,pg_get_userbyid(relowner) AS owner,relrowsecurity,relforcerowsecurity,
        row_security_active(oid) AS active FROM pg_class WHERE relname=ANY($1::text[]) AND relnamespace='public'::regnamespace ORDER BY relname`, [[...TABLES]])).rows;
      expect(relations).toHaveLength(TABLES.length);
      for (const relation of relations) expect(relation).toMatchObject({ owner: OWNER, relrowsecurity: true, relforcerowsecurity: true, active: true });
      const memberships = (await client.query(`SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,
        admin_option,inherit_option,set_option FROM pg_auth_members WHERE member IN
        (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2,$3)) ORDER BY role,member`, [OWNER, MEMBER, RUNTIME])).rows;
      expect(memberships).toEqual([{ role: OWNER, member: MEMBER, admin_option: false, inherit_option: false, set_option: true }]);
      expect((await client.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS create_schema")).rows).toEqual([{ create_schema: false }]);
      return { server, role, relations, memberships };
    });
    evidence.rolesAndRls = metadata;
    evidence.memberLogin = await probe(MEMBER, A, (client) => identity(client, MEMBER, false, A));
    evidence.assumedOwner = await probe(MEMBER, A, (client) => identity(client, MEMBER, true, A), true);
    expect(await probe(RUNTIME, null, globalContract)).toEqual(globalBaseline);
  });

  checked('direct owner and authorized SET ROLE see exact own provenance but no foreign rows for both tenants', async () => {
    const visibility: Row[] = [];
    for (const tenant of [A, B]) for (const login of [OWNER, MEMBER] as const) {
      const own = await probe(login, tenant, async (client) => {
        const sets: Row = {};
        for (const table of TABLES) {
          const rows = await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
          expect(rows.rows.length).toBeGreaterThan(0);
          expect(rows.rows.every((row) => row.row.tenant_id === tenant)).toBe(true);
          sets[table] = sha256(canonicalJson(rows.rows));
          const foreign = await client.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [tenant === A ? B : A]);
          expect(foreign.rowCount).toBe(0);
          visibility.push({ tenant, login, table, ownCount: rows.rowCount, foreignCount: foreign.rowCount });
        }
        return sets;
      }, login === MEMBER);
      const runtime = await probe(RUNTIME, tenant, async (client) => {
        const sets: Row = {};
        for (const table of TABLES) sets[table] = sha256(canonicalJson((await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
        return sets;
      });
      expect(own).toEqual(runtime);
      expect(await reconcileLocalMultiAddedProducts(inputs.get(tenant)!, { runTransaction: database!.runTenantTransaction }))
        .toMatchObject({ status: 'MATCH', sourceCount: 3, targetCount: 3, authority: 'NONAUTHORITY', complete: false, activationAllowed: false });
    }
    evidence.visibility = visibility;
  });

  for (const table of Object.keys(INSERTS) as InsertTable[]) checked(`owner RLS rejects foreign INSERT into ${table} before duplicate PK`, async () => {
    for (const login of [OWNER, MEMBER] as const) for (const tenant of [A, B]) {
      const row = insert(table, samples.get(tenant)![table]);
      await state(`own duplicate ${table}`, login, tenant, row.text, row.values, '23505', login === MEMBER);
      await state(`foreign insert ${table}`, login, tenant === A ? B : A, row.text, row.values, '42501', login === MEMBER, undefined, /row-level security/);
    }
  });

  checked('owner cannot graft the foreign generation/source/record into a valid same-job tenant via composite FK', async () => {
    for (const [table, constraint] of [
      ['migration_final_generations', 'migration_final_generations_source_fk'],
      ['migration_final_source_records', 'migration_final_source_records_generation_fk'],
      ['migration_final_targets', 'migration_final_targets_record_fk'],
    ] as const) for (const tenant of [A, B]) {
      const row = insert(table, { ...samples.get(tenant === A ? B : A)![table], tenant_id: tenant });
      await state(`foreign parent ${table}`, OWNER, tenant, row.text, row.values, '23503', false, constraint);
    }
  });

  checked('foreign owner UPDATE/DELETE affects zero rows; own immutable evidence is rejected by triggers not ACL', async () => {
    for (const tenant of [A, B]) {
      await probe(OWNER, tenant, async (client) => {
        for (const table of TABLES) for (const command of [
          `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1 RETURNING tenant_id`,
          `DELETE FROM ${table} WHERE tenant_id=$1 RETURNING tenant_id`,
        ]) expect((await client.query(command, [tenant === A ? B : A])).rowCount).toBe(0);
      });
      for (const table of IMMUTABLE) for (const command of [
        `UPDATE ${table} SET tenant_id=tenant_id`, `DELETE FROM ${table}`,
      ]) await state(`own immutable ${table}`, OWNER, tenant, command, [], 'P0001', false, undefined, /is immutable/);
    }
    await state('owner TRUNCATE trigger', OWNER, A, 'TRUNCATE migration_final_targets', [], 'P0001', false, undefined, /is immutable/);
  });

  checked('row_security=off is an error not bypass, and missing tenant context fails closed', async () => {
    for (const login of [OWNER, MEMBER] as const) {
      await state('row_security off', login, A, 'SET LOCAL row_security=off; SELECT * FROM migration_final_generations', [], '42501', login === MEMBER, undefined, /row-level security/);
      await probe(login, null, async (client) => {
        for (const table of TABLES) expect((await client.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
      }, login === MEMBER);
      const row = insert('migration_final_source_records', samples.get(A)!.migration_final_source_records);
      await state('missing tenant INSERT', login, null, row.text, row.values, '42501', login === MEMBER);
    }
  });

  checked('NOINHERIT denies implicit owner access; runtime cannot assume owner or perform owner DDL', async () => {
    await state('member implicit SELECT', MEMBER, A, 'SELECT 1 FROM migration_final_generations', [], '42501');
    await state('member implicit ALTER', MEMBER, A, 'ALTER TABLE migration_final_generations NO FORCE ROW LEVEL SECURITY', [], '42501');
    for (const command of [`SET LOCAL ROLE ${OWNER}`, `SET LOCAL ROLE ${MEMBER}`,
      'ALTER TABLE migration_final_generations NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE migration_final_generations DISABLE ROW LEVEL SECURITY',
      'ALTER POLICY migration_final_generations_tenant_isolation ON migration_final_generations USING (true)',
      'ALTER TABLE migration_final_targets DISABLE TRIGGER USER',
      `ALTER TABLE migration_final_targets OWNER TO ${OWNER}`,
    ]) await state(`runtime denied: ${command}`, RUNTIME, A, command, [], '42501');
  });

  checked('nonprivileged owner/member cannot escalate to superuser, BYPASSRLS, session identity or grant owner onward', async () => {
    for (const command of ['SET LOCAL ROLE postgres', 'SET SESSION AUTHORIZATION postgres',
      `ALTER ROLE ${OWNER} SUPERUSER`, `ALTER ROLE ${OWNER} BYPASSRLS`, `ALTER ROLE ${OWNER} CREATEROLE`,
      'CREATE ROLE synthetic_forbidden_escalation LOGIN', `GRANT ${OWNER} TO app_runtime`,
      'SET LOCAL session_replication_role=replica',
      'ALTER TABLE migration_final_targets DISABLE TRIGGER ALL',
    ]) await state(`owner escalation denied: ${command}`, OWNER, A, command, [], '42501');
    await state('member cannot impersonate owner session', MEMBER, A, `SET SESSION AUTHORIZATION ${OWNER}`, [], '42501');
    await state('assumed owner cannot grant onward', MEMBER, A, `GRANT ${OWNER} TO app_runtime`, [], '42501', true);
  });

  for (const [label, command] of [
    ['NO FORCE', 'ALTER TABLE migration_final_generations NO FORCE ROW LEVEL SECURITY'],
    ['DISABLE RLS', 'ALTER TABLE migration_final_generations DISABLE ROW LEVEL SECURITY'],
    ['policy rewrite', 'ALTER POLICY migration_final_generations_tenant_isolation ON migration_final_generations USING (true) WITH CHECK (true)'],
  ] as const) checked(`documents owner ${label} capability by rollback-only counterexample, NOT hardened-owner acceptance`, async () => {
    await probe(OWNER, A, async (client) => {
      const foreign = 'SELECT generation_id FROM migration_final_generations WHERE tenant_id=$1';
      expect((await client.query(foreign, [B])).rowCount).toBe(0);
      await client.query(command);
      expect((await client.query(foreign, [B])).rows).toEqual([{ generation_id: inputs.get(B)!.generationId }]);
      const flags = (await client.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='migration_final_generations'::regclass`)).rows[0];
      outcomes.push({ label: `owner DDL limitation: ${label}`, login: OWNER, sqlstate: '00000', foreignRowsVisible: 1, flags,
        rolledBackOnly: true, hardenedOwnerIsolationProven: false });
    });
  });

  checked('authorized SET ROLE grants real owner DDL despite NOINHERIT, with rollback restoring FORCE', async () => {
    await probe(MEMBER, A, async (client) => {
      await client.query('ALTER TABLE migration_final_generations NO FORCE ROW LEVEL SECURITY');
      expect((await client.query('SELECT generation_id FROM migration_final_generations WHERE tenant_id=$1', [B])).rows)
        .toEqual([{ generation_id: inputs.get(B)!.generationId }]);
      outcomes.push({ label: 'SET ROLE owner DDL capability', login: MEMBER, role: OWNER, sqlstate: '00000', rolledBackOnly: true });
    }, true);
    await probe(MEMBER, null, (client) => identity(client, MEMBER, false, null));
  });

  checked('owner can disable USER immutable trigger but not internal FK triggers: record limitation without durable changes', async () => {
    await probe(OWNER, A, async (client) => {
      await client.query('ALTER TABLE migration_final_targets DISABLE TRIGGER USER');
      const flags = (await client.query(`SELECT tgisinternal,tgenabled FROM pg_trigger WHERE tgrelid='migration_final_targets'::regclass`)).rows;
      expect(flags.some((row) => !row.tgisinternal && row.tgenabled === 'D')).toBe(true);
      expect(flags.filter((row) => row.tgisinternal).every((row) => row.tgenabled === 'O')).toBe(true);
      const witness = await client.query('UPDATE migration_final_targets SET target_id=target_id WHERE record_id=$1 RETURNING record_id',
        [samples.get(A)!.migration_final_targets.record_id]);
      expect(witness.rowCount).toBe(1);
      outcomes.push({ label: 'owner USER trigger disable capability', login: OWNER, sqlstate: '00000', mutationWitnessRows: witness.rowCount,
        rolledBackOnly: true, maliciousOwnerImmutabilityProven: false });
    });
  });

  checked('records mutable tenant GUC as a trust assumption, not login-bound isolation', async () => {
    for (const login of [OWNER, RUNTIME] as const) await probe(login, A, async (client) => {
      expect((await client.query('SELECT tenant_id FROM migration_final_generations')).rows).toEqual([{ tenant_id: A }]);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [B]);
      expect((await client.query('SELECT tenant_id FROM migration_final_generations')).rows).toEqual([{ tenant_id: B }]);
      outcomes.push({ label: 'trusted tenant context can be changed by SQL caller', login, sqlstate: '00000', rolledBackOnly: true,
        immutableLoginTenantBindingProven: false });
    });
    for (const login of [OWNER, MEMBER, RUNTIME] as const) await probe(login, null, (client) => identity(client, login, false, null));
  });

  checked('Products-only schema remains unsupported for full-category finals even for its nonprivileged owner', async () => {
    const source = insert('migration_final_source_records', { ...samples.get(A)!.migration_final_source_records,
      record_id: 'unsupported-owner-source', source_record_id: 'S-extra', source_collection: 'Students' });
    await state('unsupported Students source', OWNER, A, source.text, source.values, '23514', false, 'migration_final_source_records_shape_check');
    const target = insert('migration_final_targets', { ...samples.get(A)!.migration_final_targets, target_table: 'students' });
    await state('unsupported students target', OWNER, A, target.text, target.values, '23514', false, 'migration_final_targets_shape_check');
    for (const tenant of [A, B]) expect(await reconcileLocalMultiAddedProducts(inputs.get(tenant)!, { runTransaction: database!.runTenantTransaction }))
      .toMatchObject({ status: 'MATCH', authority: 'NONAUTHORITY', complete: false, activationAllowed: false });
  });
});
