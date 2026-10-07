// @vitest-environment node
// Opt-in CHARACTERIZATION ONLY: not a security fix, real freeze or Task19 acceptance.
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localProtectedJobInsert.postgres.test.ts --maxWorkers=1
// Unlike the PGlite SET ROLE test, pg authenticates a separate app_runtime login
// over the unchanged harness's owned-container Unix socket. Local trust auth is
// NOT proof of production credentials, HTTP authorization or external exclusion.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';

vi.mock('server-only', () => ({}));

const TENANT = '20000000-0000-4000-8000-000000000071';
const FOREIGN = '20000000-0000-4000-8000-000000000072';
const MISSING = '20000000-0000-4000-8000-000000000079';
const migrationDirectory = 'src/server/db/migrations';
const migrationNames = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'package.json', 'vitest.config.mts', 'tsconfig.json',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c',
  'src/server/db/transaction.ts', 'src/server/migration/localProtectedJobInsertCharacterization.test.ts',
  'src/server/migration/localProtectedJobInsert.postgres.test.ts',
  ...migrationNames.map((name) => join(migrationDirectory, name))];
const fileHashes = () => Object.fromEntries(watched.map((path) =>
  [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const at = (minute: string) => `2026-08-01T00:${minute}:00+00:00`;
type ProtectedStatus = 'FINAL_IMPORT' | 'ACTIVE';
type Job = {
  tenant_id: string; job_id: string; status: ProtectedStatus; state_version: string | null;
  source_fingerprint: string | null; final_fingerprint: string | null;
  created_at: string; freeze_started_at: string | null; freeze_verified_at: string | null;
  completed_at: string | null; updated_at: string;
};
type Stored = { row: Record<string, unknown>; xmin: string };
type SqlFailure = { code: string; constraint?: string; column?: string };

// Only absence of opt-in skips. Once opted in, infrastructure/setup errors throw;
// no PGlite, host connection, existing container or weaker-grant fallback exists.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('direct protected INSERT via a separate disposable PG17 runtime login', () => {
  let database: DisposablePostgres | undefined;
  let beforeHashes: Record<string, string> | undefined;
  let beforeCatalog: Awaited<ReturnType<typeof catalog>> | undefined;
  let sequence = 0;
  const facts: Array<Record<string, unknown>> = [];
  const evidence: Record<string, unknown> = {
    authority: 'NONAUTHORITY', complete: false, activationAllowed: false, securityFix: false,
    engine: 'PostgreSQL 17, newly owned isolated disposable container',
    runtimeIdentity: 'SEPARATE_APP_RUNTIME_LOGIN_NOT_SET_ROLE_FROM_OWNER',
    authenticationLimit: 'OWNED_LOCAL_SOCKET_TRUST_NOT_PRODUCTION_CREDENTIAL_AUTHENTICATION',
    externalWriterExclusion: 'NOT_PROVEN',
    syntheticEvidence: 'FABRICATED_HASHES_AND_TIMESTAMPS_NO_RECEIPTS_OR_PREDECESSOR_TRANSITIONS',
    scope: 'DIRECT_INSERT_RLS_SHAPE_ROLLBACK_NOT_UPDATE_UPSERT_COPY_CONCURRENCY_OR_BUSINESS_COMPATIBILITY',
    setup: 'NOT_STARTED',
  };
  const externalFetch = vi.fn(async () => { throw new Error('External fetch is forbidden in this disposable DB test'); });

  function db(): DisposablePostgres {
    if (!database) throw new Error('Owned disposable PostgreSQL setup did not complete');
    return database;
  }

  // Owner is an observer after DRAFT-only tenant setup. All public tables belong
  // exclusively to this fresh fixture; no operational database can be selected.
  async function snapshot(): Promise<Record<string, Stored[]>> {
    const tables = await db().owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const result: Record<string, Stored[]> = {};
    for (const { tablename } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected synthetic table identifier');
      result[tablename] = (await db().owner.query<Stored>(
        `SELECT to_jsonb(t) AS row,xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }

  async function catalog() {
    const owner = db().owner;
    return {
      roles: (await owner.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows,
      memberships: (await owner.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
      relations: (await owner.query(`SELECT relname,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity
        FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname`)).rows,
      policies: (await owner.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
      triggers: (await owner.query(`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
        ORDER BY relation,tgname`)).rows,
      constraints: (await owner.query(`SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname,contype`)).rows,
      transition: (await owner.query("SELECT pg_get_functiondef('enforce_migration_job_transition()'::regprocedure) AS definition")).rows,
    };
  }

  async function runtime<T>(tenant: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db().runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      const identity = (await client.query(`SELECT current_user AS actor,session_user AS login,
        current_setting('app.tenant_id',true) AS tenant,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolinherit,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,inet_server_addr() AS address
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='migration_jobs'::regclass`)).rows;
      expect(identity).toEqual([expect.objectContaining({ actor: 'app_runtime', login: 'app_runtime', tenant,
        rolsuper: false, rolbypassrls: false, rolcanlogin: true, rolinherit: false,
        relrowsecurity: true, relforcerowsecurity: true, can_insert: true, address: null })]);
      expect(identity[0].owner).not.toBe('app_runtime');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function candidate(status: ProtectedStatus, change: Partial<Job> = {}): Job {
    return { tenant_id: TENANT, job_id: `pg-insert-${status}-${++sequence}`, status, state_version: '7',
      source_fingerprint: 'a'.repeat(64), final_fingerprint: 'b'.repeat(64), created_at: at('00'),
      freeze_started_at: at('10'), freeze_verified_at: at('20'),
      completed_at: status === 'ACTIVE' ? at('30') : null, updated_at: at('40'), ...change };
  }

  function insert(client: PoolClient, job: Job, defaultVersion = false) {
    // Only a fixed DEFAULT token is interpolated; all fixture values are bound.
    const version = defaultVersion ? 'DEFAULT' : '$11';
    const values = [job.tenant_id, job.job_id, job.status,
      job.source_fingerprint, job.final_fingerprint, job.created_at, job.freeze_started_at,
      job.freeze_verified_at, job.completed_at, job.updated_at];
    if (!defaultVersion) values.push(job.state_version);
    return client.query(`INSERT INTO migration_jobs (tenant_id,job_id,status,source_fingerprint,final_fingerprint,
        created_at,freeze_started_at,freeze_verified_at,completed_at,updated_at,state_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${version})
      RETURNING tenant_id,job_id,status,state_version::text`, values);
  }

  async function allowed(label: string, job: Job, defaultVersion = false) {
    const before = await snapshot();
    expect(before.migration_jobs.some(({ row }) => row.tenant_id === job.tenant_id && row.job_id === job.job_id)).toBe(false);
    const result = await runtime(job.tenant_id, (client) => insert(client, job, defaultVersion));
    const version = defaultVersion ? '1' : job.state_version;
    expect(result.rows).toEqual([{ tenant_id: job.tenant_id, job_id: job.job_id, status: job.status, state_version: version }]);
    const after = await snapshot();
    const matches = after.migration_jobs.filter(({ row }) => row.tenant_id === job.tenant_id && row.job_id === job.job_id);
    expect(matches).toHaveLength(1);
    const saved = matches[0];
    const expected: Record<string, unknown> = { ...job, state_version: Number(version) };
    // Compare only designated timestamptz columns as instants; keep evidence
    // strings, IDs and every other persisted field literal and exact.
    for (const field of ['created_at', 'freeze_started_at', 'freeze_verified_at', 'completed_at', 'updated_at'] as const) {
      if (job[field] === null) continue;
      const expectedInstant = Date.parse(job[field]);
      const storedInstant = Date.parse(String(saved.row[field]));
      expect(Number.isFinite(expectedInstant) && Number.isFinite(storedInstant)).toBe(true);
      expect(storedInstant, field).toBe(expectedInstant);
      expected[field] = saved.row[field];
    }
    expect(saved.row).toEqual(expected);
    expect(after.migration_jobs.filter((row) => row !== saved)).toEqual(before.migration_jobs);
    for (const table of Object.keys(before).filter((table) => table !== 'migration_jobs')) expect(after[table], table).toEqual(before[table]);
    expect(after.tenants.map(({ row }) => row.lifecycle)).toEqual(['DRAFT', 'DRAFT']);
    facts.push({ status: job.status, case: label, result: 'DIRECT_RUNTIME_INSERT_COMMITTED_NOT_VALID_ACTIVATION',
      stored: saved, unrelatedPublicRowsAndXminUnchanged: true, tenantLifecycleUnchanged: true });
  }

  async function denied(label: string, action: () => Promise<unknown>, expected: SqlFailure) {
    const before = await snapshot();
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    expect(caught, label).toEqual(expect.objectContaining(expected));
    expect(await snapshot()).toEqual(before);
    const error = caught as SqlFailure;
    facts.push({ case: label, result: 'EXISTING_SQL_BOUNDARY_REFUSED_NOT_NEW_SECURITY_GUARD',
      sqlstate: error.code, constraint: error.constraint, column: error.column, allPublicRowsAndXminUnchanged: true });
  }

  // No test/hook wall-clock budget; unchanged harness per-I/O safety bounds apply.
  beforeAll(async () => {
    beforeHashes = fileHashes();
    vi.stubGlobal('fetch', externalFetch);
    evidence.setup = 'STARTED';
    // This unchanged harness first verifies its newly created exact container
    // ID + unpredictable ownership label and isolation, BEFORE docker start/SQL.
    database = await createDisposablePostgres();
    expect(database.evidence).toMatchObject({ runId: database.runId,
      ownerLabel: 'io.class-store.synthetic-pg-owner', networkMode: 'none',
      publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true,
      droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(database.evidence.tmpfs).toEqual(['/test-bin', '/tmp', '/var/lib/postgresql/data', '/var/run/postgresql']);
    evidence.infrastructure = database.evidence;
    const owner = (await database.owner.query('SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid')).rows[0];
    expect(owner).toMatchObject({ actor: 'postgres', login: 'postgres' });
    evidence.ownerIdentity = owner;
    expect((await database.owner.query('SELECT * FROM tenants')).rows).toEqual([]);
    expect((await database.owner.query('SELECT * FROM migration_jobs')).rows).toEqual([]);
    await database.owner.query(`INSERT INTO tenants (id,slug,display_name,lifecycle) VALUES
      ($1,'protected-pg-one','Synthetic One','DRAFT'),($2,'protected-pg-two','Synthetic Two','DRAFT')`, [TENANT, FOREIGN]);
    // Nonempty unrelated sentinel rows, inserted by the same real runtime login.
    // No owner-created protected jobs, receipts or plausible-looking authority.
    for (const tenant of [TENANT, FOREIGN]) {
      await runtime(tenant, (client) => client.query(
        "INSERT INTO migration_jobs (tenant_id,job_id) VALUES ($1,'unrelated-discovered-sentinel')", [tenant]));
    }
    const baseline = await snapshot();
    expect(baseline.tenants).toHaveLength(2);
    expect(baseline.migration_jobs.map(({ row }) => row.status)).toEqual(['DISCOVERED', 'DISCOVERED']);
    for (const [table, rows] of Object.entries(baseline)) {
      if (table !== 'tenants' && table !== 'migration_jobs') expect(rows, table).toEqual([]);
    }
    beforeCatalog = await catalog();
    evidence.setup = 'COMPLETED_DRAFT_TENANTS_AND_RUNTIME_DISCOVERED_SENTINELS_ONLY';
  }, 0);

  afterAll(async () => {
    try {
      if (database && beforeCatalog) {
        expect(await catalog()).toEqual(beforeCatalog);
        evidence.catalogUnchangedAfterFixtureSetup = true;
      }
    } finally {
      try {
        if (database) {
          const cleanup = await database.close();
          expect(cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
          evidence.cleanup = cleanup;
        }
      } finally {
        vi.unstubAllGlobals();
        const afterHashes = fileHashes();
        evidence.sourceHashes = afterHashes;
        evidence.sourceFilesUnchanged = JSON.stringify(afterHashes) === JSON.stringify(beforeHashes);
        evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
        console.info('LOCAL_PROTECTED_JOB_INSERT_POSTGRES ' + JSON.stringify({ ...evidence, facts }));
        expect(afterHashes).toEqual(beforeHashes);
        expect(externalFetch).not.toHaveBeenCalled();
      }
    }
  }, 0);

  it('uses actual PG17 with current_user = session_user = app_runtime, distinct from setup owner', async () => {
    const identity = await runtime(TENANT, async (client) => (await client.query(`SELECT
      current_setting('server_version') AS version,current_user AS actor,session_user AS login,
      pg_backend_pid() AS pid,current_setting('transaction_isolation') AS isolation,
      inet_server_addr() AS address,inet_server_port() AS port`)).rows[0]);
    expect(identity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', isolation: 'read committed', address: null, port: null });
    expect(identity.version).toMatch(/^17\./);
    expect(identity.pid).not.toBe((evidence.ownerIdentity as { pid: number }).pid);
    evidence.runtimeIdentityObserved = identity;
    const client = await db().runtime.connect();
    try {
      expect((await client.query("SELECT NULLIF(current_setting('app.tenant_id',true),'') AS tenant")).rows)
        .toEqual([{ tenant: null }]);
    } finally { client.release(); }
  }, 0);

  for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) describe(status, () => {
    it('commits direct INSERT at version 7 with fabricated evidence and no predecessor job', async () => {
      await allowed(`${status}: explicit version 7`, candidate(status));
    }, 0);

    it('commits direct INSERT at DEFAULT version 1 without transition history', async () => {
      await allowed(`${status}: DEFAULT version 1`, candidate(status), true);
    }, 0);

    it(status === 'FINAL_IMPORT' ? 'permits minimal FINAL_IMPORT without hashes or freeze evidence'
      : 'permits ACTIVE without source fingerprint when terminal shape is satisfied', async () => {
      await allowed(`${status}: missing evidence accepted by present shape`, candidate(status,
        status === 'FINAL_IMPORT' ? { source_fingerprint: null, final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null }
          : { source_fingerprint: null }), true);
    }, 0);

    const invalid: Array<{ label: string; change: Partial<Job>; constraint: string }> = [
      { label: 'version zero', change: { state_version: '0' }, constraint: 'migration_jobs_state_version_check' },
      { label: 'malformed final hash', change: { final_fingerprint: 'not-a-digest' }, constraint: 'migration_jobs_hashes_check' },
      { label: 'verification before freeze start', change: { freeze_verified_at: at('09') }, constraint: 'migration_jobs_freeze_shape_check' },
      { label: 'status-dependent completion nullability', change: { completed_at: status === 'ACTIVE' ? null : at('30') }, constraint: 'migration_jobs_terminal_shape_check' },
      { label: 'updated timestamp before evidence', change: { updated_at: at('00') }, constraint: 'migration_jobs_chronology_check' },
    ];
    if (status === 'ACTIVE') invalid.push(
      { label: 'missing final fingerprint', change: { final_fingerprint: null }, constraint: 'migration_jobs_terminal_shape_check' },
      { label: 'missing freeze verification', change: { freeze_verified_at: null }, constraint: 'migration_jobs_terminal_shape_check' },
    );
    for (const { label, change, constraint } of invalid) it(`rejects ${label} by the existing shape constraint`, async () => {
      await denied(`${status}: ${label}`, () => runtime(TENANT, (client) => insert(client, candidate(status, change))),
        { code: '23514', constraint });
    }, 0);

    it('rejects otherwise valid INSERT into a real foreign DRAFT tenant by RLS', async () => {
      expect((await db().owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [FOREIGN])).rows).toEqual([{ lifecycle: 'DRAFT' }]);
      await denied(`${status}: foreign tenant`, () => runtime(TENANT, (client) => insert(client,
        candidate(status, { tenant_id: FOREIGN }))), { code: '42501' });
    }, 0);

    it('rejects an empty transaction-local tenant GUC by RLS, not missing INSERT privileges', async () => {
      await denied(`${status}: empty GUC`, () => runtime('', (client) => insert(client, candidate(status))), { code: '42501' });
    }, 0);

    it('rejects a malformed tenant GUC at UUID conversion', async () => {
      await denied(`${status}: malformed GUC`, () => runtime('not-a-uuid', (client) => insert(client, candidate(status))), { code: '22P02' });
    }, 0);

    it('reaches the parent FK when GUC matches a nonexistent tenant', async () => {
      expect((await db().owner.query('SELECT id FROM tenants WHERE id=$1', [MISSING])).rows).toEqual([]);
      await denied(`${status}: matching GUC, missing parent`, () => runtime(MISSING, (client) => insert(client,
        candidate(status, { tenant_id: MISSING }))), { code: '23503', constraint: 'migration_jobs_tenant_fk' });
    }, 0);

    it('rolls back a witnessed first protected INSERT when a later INSERT fails', async () => {
      const first = candidate(status);
      let firstInsertObserved = false;
      await denied(`${status}: later constraint failure rolls back earlier INSERT`, () => runtime(TENANT, async (client) => {
        expect((await insert(client, first)).rows).toEqual([{ tenant_id: TENANT, job_id: first.job_id, status, state_version: '7' }]);
        expect((await client.query('SELECT job_id,status FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, first.job_id])).rows)
          .toEqual([{ job_id: first.job_id, status }]);
        firstInsertObserved = true;
        // A separate owner backend does not observe the uncommitted row.
        expect((await db().owner.query('SELECT job_id FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, first.job_id])).rows).toEqual([]);
        return insert(client, candidate(status, { final_fingerprint: 'bad' }));
      }), { code: '23514', constraint: 'migration_jobs_hashes_check' });
      expect(firstInsertObserved).toBe(true);
      evidence[`${status}_rollbackWitness`] = { returningAndRuntimeReadObserved: true,
        separateOwnerCouldNotSeeUncommittedRow: true, allPublicRowsAndXminRestored: true };
    }, 0);
  });
});
