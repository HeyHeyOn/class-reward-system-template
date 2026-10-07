// @vitest-environment node
// DISPOSABLE-DB PROTOTYPE ONLY: NONAUTHORITY, not a deployed migration or Task19/23 acceptance.
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localProtectedEntryGuard.prototype.postgres.test.ts --maxWorkers=1
// Only the existing harness creates roles/grants. This file changes no permissions,
// ownership or existing SQL objects; it adds one candidate function + trigger in
// its newly owned PG17 database. Historical vulnerable tests remain byte-exact.
// Old protected rows/evidence, tenant ACTIVE activation, privileged DDL, HTTP auth,
// production credentials and maintained external writer exclusion are NOT solved.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';

vi.mock('server-only', () => ({}));

const TENANT = '20000000-0000-4000-8000-000000000081';
const FOREIGN = '20000000-0000-4000-8000-000000000082';
const GUARD = 'migration_jobs_protected_entry_guard';
const GUARD_MESSAGE = 'Prototype protected migration job entry refused.';
const migrationDirectory = 'src/server/db/migrations';
const watched = ['.git/index', 'package.json', 'vitest.config.mts', 'tsconfig.json',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c',
  'src/server/db/transaction.ts', 'src/server/migration/localProtectedJobInsert.postgres.test.ts',
  'src/server/migration/localProtectedJobInsertCharacterization.test.ts',
  'src/server/migration/localProtectedEntryGuard.prototype.postgres.test.ts',
  ...readdirSync(migrationDirectory).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()
    .map(name => join(migrationDirectory, name))];
const fileHashes = () => Object.fromEntries(watched.map(path =>
  [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const at = (minute: string) => `2026-08-01T00:${minute}:00+00:00`;
type ProtectedStatus = 'FINAL_IMPORT' | 'ACTIVE';
type SeedStatus = ProtectedStatus | 'FREEZING';
type Stored = { row: Record<string, unknown>; xmin: string };
type State = Record<string, Stored[]>;
type SqlFailure = { code: string; message?: string; constraint?: string; schema?: string; table?: string; where?: string };

// No opt-in means skipped; opt-in infrastructure/setup failure is a FAILURE.
// No connection, image-pull, PGlite, weaker-grant or owner-as-runtime fallback.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('synthetic PG17 protected-entry embargo prototype', () => {
  let database: DisposablePostgres | undefined;
  let beforeHashes: ReturnType<typeof fileHashes> | undefined;
  let originalCatalog: Awaited<ReturnType<typeof catalog>> | undefined;
  let fixture: State | undefined;
  let sequence = 0;
  const facts: Array<Record<string, unknown>> = [];
  const evidence: Record<string, unknown> = {
    authority: 'NONAUTHORITY', activationAllowed: false, deployed: false, task19Accepted: false,
    externalWriterExclusion: 'NOT_PROVEN', authentication: 'SEPARATE_LOGIN_OVER_OWNED_LOCAL_TRUST_SOCKET',
    scope: 'CANDIDATE_TRIGGER_ONLY_NO_ACL_OR_OWNERSHIP_CHANGE',
    limitations: ['OLD_PROTECTED_ROWS_NOT_REPAIRED', 'SAME_STATUS_EVIDENCE_NOT_SEALED',
      'TENANT_ACTIVE_NOT_GUARDED', 'NO_HTTP_OR_OPERATIONAL_AUTH_PROOF', 'NO_EXTERNAL_EXCLUSION',
      'NO_UPSERT_COPY_CONCURRENCY_OR_FULL_REPOSITORY_COMPATIBILITY_PROOF'],
  };
  const externalFetch = vi.fn(async () => { throw new Error('External fetch forbidden in disposable guard prototype'); });
  const seedId = (status: SeedStatus) => `pre-embargo-${status}`;

  function db(): DisposablePostgres {
    if (!database) throw new Error('Owned disposable PostgreSQL setup incomplete');
    return database;
  }

  async function snapshot(): Promise<State> {
    const tables = await db().owner.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const result: State = {};
    for (const { tablename } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected synthetic table identifier');
      result[tablename] = (await db().owner.query<Stored>(
        `SELECT to_jsonb(t) AS row,xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }

  // Exclude only the two explicitly new candidate objects; all original objects,
  // relation/column ACLs, role flags and memberships must remain exactly equal.
  async function catalog() {
    const owner = db().owner;
    return {
      roles: (await owner.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows,
      memberships: (await owner.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
      relations: (await owner.query(`SELECT relname,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity
        FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname`)).rows,
      columns: (await owner.query(`SELECT attrelid::regclass::text AS relation,attname,attacl::text
        FROM pg_attribute WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
        ORDER BY relation,attnum`)).rows,
      policies: (await owner.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
      functions: (await owner.query(`SELECT proname,oid::regprocedure::text AS signature,proowner::text,proacl::text,
        prosecdef,proconfig,pg_get_functiondef(oid) AS definition FROM pg_proc
        WHERE pronamespace='public'::regnamespace AND proname<>'guard_migration_job_protected_entry'
        ORDER BY signature`)).rows,
      triggers: (await owner.query(`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
        AND tgname<>$1 ORDER BY relation,tgname`, [GUARD])).rows,
      constraints: (await owner.query(`SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname,contype`)).rows,
    };
  }

  async function runtime<T>(tenant: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db().runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      const identity = (await client.query(`SELECT current_user AS actor,session_user AS login,
        current_setting('app.tenant_id',true) AS tenant,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolinherit,
        r.rolcreaterole,r.rolcreatedb,r.rolreplication,pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity,c.relforcerowsecurity,has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
        has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,inet_server_addr() AS address
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows;
      expect(identity).toEqual([expect.objectContaining({ actor: 'app_runtime', login: 'app_runtime', tenant,
        rolsuper: false, rolbypassrls: false, rolcanlogin: true, rolinherit: false,
        rolcreaterole: false, rolcreatedb: false, rolreplication: false,
        relrowsecurity: true, relforcerowsecurity: true, can_insert: true, can_update: true, address: null })]);
      expect(identity[0].owner).not.toBe('app_runtime');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  function insertProtected(client: PoolClient, status: SeedStatus, id: string, tenant = TENANT, defaultVersion = false) {
    const values: Array<string | null> = [tenant, id, status, 'a'.repeat(64), 'b'.repeat(64),
      at('00'), at('10'), at('20'), status === 'ACTIVE' ? at('30') : null, at('40')];
    if (!defaultVersion) values.push('7');
    return client.query(`INSERT INTO public.migration_jobs
      (tenant_id,job_id,status,source_fingerprint,final_fingerprint,created_at,freeze_started_at,
        freeze_verified_at,completed_at,updated_at,state_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${defaultVersion ? 'DEFAULT' : '$11'})
      RETURNING tenant_id,job_id,status,state_version::text`, values);
  }

  function discovered(client: PoolClient, id: string, tenant = TENANT) {
    return client.query(`INSERT INTO public.migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'DISCOVERED')
      RETURNING to_jsonb(migration_jobs) AS row`, [tenant, id]);
  }

  async function forward(client: PoolClient, from: 'FREEZING' | 'FINAL_IMPORT', to: ProtectedStatus, id = seedId(from)) {
    const result = await client.query(`UPDATE public.migration_jobs SET status=$1,state_version=state_version+1,
      completed_at=$2,updated_at=$3 WHERE tenant_id=$4 AND job_id=$5 AND status=$6 AND state_version=7
      RETURNING job_id,status,state_version::text`,
    [to, to === 'ACTIVE' ? at('30') : null, at('40'), TENANT, id, from]);
    expect(result.rows).toEqual([{ job_id: id, status: to, state_version: '8' }]);
    facts.push({ case: 'actual forward UPDATE returned', id, from, to, stateVersion: '8' });
    return result;
  }

  async function spoof(client: PoolClient, tenant: string) {
    const { rows } = await client.query(`SELECT set_config('app.tenant_id',$1,true) AS tenant,
      set_config('app.trusted_migration','true',true) AS trusted,
      set_config('app.activation_allowed','true',true) AS activation,
      set_config('app.actor_id','postgres',true) AS actor`, [tenant]);
    expect(rows).toEqual([{ tenant, trusted: 'true', activation: 'true', actor: 'postgres' }]);
  }

  async function denied(label: string, action: () => Promise<unknown>, expected: SqlFailure, guardOperation?: 'INSERT' | 'UPDATE') {
    const before = await snapshot();
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    // SQLSTATE alone is insufficient: RLS/ACL also use 42501.
    expect(caught, label).toEqual(expect.objectContaining(expected));
    if (guardOperation) {
      expect(caught).toEqual(expect.objectContaining({ detail: guardOperation }));
      expect((caught as SqlFailure).where).toContain('guard_migration_job_protected_entry()');
      expect((caught as SqlFailure).where).toContain('RAISE');
    } else {
      expect((caught as SqlFailure).constraint).not.toBe(GUARD);
    }
    expect(await snapshot(), `${label}: full durable rows/xmin unchanged`).toEqual(before);
    facts.push({ case: label, sqlstate: expected.code, constraint: (caught as SqlFailure).constraint,
      message: (caught as SqlFailure).message, guardOperation: guardOperation ?? null,
      allPublicRowsAndXminUnchanged: true });
  }

  function embargo(label: string, operation: 'INSERT' | 'UPDATE', action: () => Promise<unknown>) {
    return denied(label, action, { code: '42501', message: GUARD_MESSAGE, constraint: GUARD,
      schema: 'public', table: 'migration_jobs' }, operation);
  }

  async function installCandidate() {
    // New objects ONLY in the already ownership-verified disposable database.
    // No grant/revoke, ALTER OWNER, role change or mutation of the existing guard.
    const client = await db().owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE FUNCTION public.guard_migration_job_protected_entry()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
        DECLARE block_entry boolean;
        BEGIN
          IF TG_OP = 'INSERT' THEN
            block_entry := NEW.status IN ('FINAL_IMPORT','ACTIVE');
          ELSE
            block_entry := NEW.status IN ('FINAL_IMPORT','ACTIVE') AND (
              NEW.status IS DISTINCT FROM OLD.status OR
              ROW(NEW.tenant_id,NEW.job_id) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.job_id));
          END IF;
          IF block_entry THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
              MESSAGE = 'Prototype protected migration job entry refused.',
              DETAIL = TG_OP, SCHEMA = 'public', TABLE = 'migration_jobs',
              CONSTRAINT = 'migration_jobs_protected_entry_guard';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER migration_jobs_protected_entry_guard BEFORE INSERT OR UPDATE
          ON public.migration_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_migration_job_protected_entry()`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  // Existing harness per-I/O safety bounds remain; no new hook/test wall-clock budget.
  beforeAll(async () => {
    beforeHashes = fileHashes();
    vi.stubGlobal('fetch', externalFetch);
    database = await createDisposablePostgres();
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner',
      networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0,
      readOnlyRoot: true, droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(database.evidence.tmpfs).toEqual(['/test-bin', '/tmp', '/var/lib/postgresql/data', '/var/run/postgresql']);
    evidence.infrastructure = database.evidence;
    evidence.ownerIdentity = (await database.owner.query('SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid')).rows[0];
    expect(evidence.ownerIdentity).toMatchObject({ actor: 'postgres', login: 'postgres' });
    expect((await database.owner.query('SELECT * FROM public.tenants')).rows).toEqual([]);
    expect((await database.owner.query('SELECT * FROM public.migration_jobs')).rows).toEqual([]);
    expect((await database.owner.query("SELECT to_regprocedure('public.guard_migration_job_protected_entry()') AS candidate")).rows)
      .toEqual([{ candidate: null }]);
    expect((await database.owner.query('SELECT tgname FROM pg_trigger WHERE tgname=$1', [GUARD])).rows).toEqual([]);
    await database.owner.query(`INSERT INTO public.tenants(id,slug,display_name,lifecycle) VALUES
      ($1,'entry-guard-one','Synthetic One','DRAFT'),($2,'entry-guard-two','Synthetic Two','DRAFT')`, [TENANT, FOREIGN]);
    for (const tenant of [TENANT, FOREIGN]) await runtime(tenant, client => discovered(client, 'sentinel', tenant));
    // Historical rows are explicitly created BEFORE the candidate exists, through
    // the genuine runtime login. Never disable the candidate to create fixtures.
    for (const status of ['FREEZING', 'FINAL_IMPORT', 'ACTIVE'] as const) {
      const result = await runtime(TENANT, client => insertProtected(client, status, seedId(status)));
      expect(result.rows).toEqual([{ tenant_id: TENANT, job_id: seedId(status), status, state_version: '7' }]);
    }
    // Each adversarial UPDATE owns a distinct donor, even during behavioral RED:
    // an unguarded identity move must not make a later status UPDATE hit zero rows.
    for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) {
      for (const prefix of ['identity', 'historical']) {
        await runtime(TENANT, client => insertProtected(client, status, `${prefix}-${status}`));
      }
    }
    for (const status of ['FREEZING', 'FINAL_IMPORT'] as const) {
      await runtime(TENANT, client => insertProtected(client, status, `spoof-${status}`));
    }
    for (const [from, to] of [['FREEZING', 'FINAL_IMPORT'], ['FINAL_IMPORT', 'ACTIVE']] as const) {
      const before = await snapshot();
      await runtime(TENANT, async client => {
        await client.query('SAVEPOINT unguarded_transition');
        expect((await forward(client, from, to)).rows).toEqual([{ job_id: seedId(from), status: to, state_version: '8' }]);
        expect((await client.query('SELECT status FROM public.migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, seedId(from)])).rows)
          .toEqual([{ status: to }]);
        await client.query('ROLLBACK TO SAVEPOINT unguarded_transition');
      });
      expect(await snapshot()).toEqual(before);
      facts.push({ case: `${from}->${to} before installation`, result: 'ACTUAL_RUNTIME_UPDATE_WITNESSED_THEN_SAVEPOINT_ROLLED_BACK' });
    }
    fixture = await snapshot();
    originalCatalog = await catalog();
    await installCandidate();
    expect(await snapshot()).toEqual(fixture);
    expect(await catalog()).toEqual(originalCatalog);
    evidence.installationPreservedExistingRowsRolesAclPoliciesFunctionsAndTriggers = true;
  }, 0);

  afterAll(async () => {
    try {
      if (database && originalCatalog) expect(await catalog()).toEqual(originalCatalog);
      if (database && fixture) {
        const after = await snapshot();
        for (const table of Object.keys(fixture).filter(name => name !== 'migration_jobs')) expect(after[table], table).toEqual(fixture[table]);
        expect(after.migration_jobs.filter(({ row }) => row.tenant_id === FOREIGN || row.job_id === 'sentinel'))
          .toEqual(fixture.migration_jobs.filter(({ row }) => row.tenant_id === FOREIGN || row.job_id === 'sentinel'));
        evidence.unrelatedRowsXminAndDraftLifecyclePreserved = true;
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
        console.info('LOCAL_PROTECTED_ENTRY_GUARD_PROTOTYPE ' + JSON.stringify({ ...evidence, facts }));
        expect(afterHashes).toEqual(beforeHashes);
        expect(externalFetch).not.toHaveBeenCalled();
      }
    }
  }, 0);

  it('uses a separate nonowner PG17 app_runtime login with unchanged INSERT/UPDATE privileges', async () => {
    const identity = await runtime(TENANT, async client => (await client.query(`SELECT current_user AS actor,
      session_user AS login,pg_backend_pid() AS pid,current_setting('server_version') AS version,
      current_setting('transaction_isolation') AS isolation,inet_server_addr() AS address,inet_server_port() AS port`)).rows[0]);
    expect(identity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', isolation: 'read committed', address: null, port: null });
    expect(identity.version).toMatch(/^17\./);
    expect(identity.pid).not.toBe((evidence.ownerIdentity as { pid: number }).pid);
    evidence.runtimeIdentity = identity;
  }, 0);

  it('installs exactly a SECURITY INVOKER row BEFORE INSERT OR UPDATE trigger with fixed search_path', async () => {
    const result = await db().owner.query(`SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
      t.tgenabled,(t.tgtype::int & 1)=1 AS row_level,(t.tgtype::int & 2)=2 AS before_row,
      (t.tgtype::int & 4)=4 AS inserts,(t.tgtype::int & 16)=16 AS updates,
      pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='public.migration_jobs'::regclass AND t.tgname=$1`, [GUARD]);
    expect(result.rows).toEqual([expect.objectContaining({ prosecdef: false, proconfig: ['search_path=pg_catalog'],
      owner: 'postgres', tgenabled: 'O', row_level: true, before_row: true, inserts: true, updates: true })]);
    expect(result.rows[0].definition).toContain('BEFORE INSERT OR UPDATE');
    evidence.candidateCatalog = result.rows[0];
  }, 0);

  for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) {
    for (const defaultVersion of [false, true]) it(`rejects fabricated ${status} INSERT with ${defaultVersion ? 'DEFAULT version' : 'version 7'} at the candidate guard`, async () => {
      await embargo(`${status} INSERT default=${defaultVersion}`, 'INSERT', () => runtime(TENANT,
        client => insertProtected(client, status, `refused-${++sequence}`, TENANT, defaultVersion)));
    }, 0);

    it(`does not unlock ${status} INSERT after spoofing trusted flags and switching to a matching foreign tenant GUC`, async () => {
      await embargo(`${status} spoofed INSERT`, 'INSERT', () => runtime(TENANT, async client => {
        await spoof(client, FOREIGN);
        expect((await client.query("SELECT job_id FROM public.migration_jobs WHERE tenant_id=$1 AND job_id='sentinel'", [FOREIGN])).rows)
          .toEqual([{ job_id: 'sentinel' }]);
        return insertProtected(client, status, `spoofed-${++sequence}`, FOREIGN);
      }));
    }, 0);

    it(`rejects same-status ${status} job identity transfer without requiring UPDATE OF status`, async () => {
      await embargo(`${status} job identity transfer`, 'UPDATE', () => runtime(TENANT, client => client.query(
        'UPDATE public.migration_jobs SET job_id=$1 WHERE tenant_id=$2 AND job_id=$3 RETURNING job_id',
        [`moved-${++sequence}`, TENANT, `identity-${status}`])));
    }, 0);

    it(`rolls back a witnessed safe INSERT when a later ${status} INSERT reaches the candidate guard`, async () => {
      const id = `rollback-${++sequence}`;
      let witnessed = false;
      await embargo(`${status} rollback`, 'INSERT', () => runtime(TENANT, async client => {
        expect((await discovered(client, id)).rows).toEqual([{ row: expect.objectContaining({ tenant_id: TENANT, job_id: id, status: 'DISCOVERED' }) }]);
        expect((await client.query('SELECT job_id FROM public.migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, id])).rows)
          .toEqual([{ job_id: id }]);
        expect((await db().owner.query('SELECT job_id FROM public.migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, id])).rows).toEqual([]);
        witnessed = true;
        return insertProtected(client, status, `refused-after-witness-${++sequence}`);
      }));
      expect(witnessed).toBe(true);
      evidence[`${status}_rollbackWitness`] = { returningAndSameTransactionRead: true, invisibleToOtherConnection: true, fullRollback: true };
    }, 0);
  }

  it('rejects minimal FINAL_IMPORT INSERT even without hash or freeze evidence', async () => {
    await embargo('minimal FINAL_IMPORT', 'INSERT', () => runtime(TENANT, client => client.query(
      "INSERT INTO public.migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'FINAL_IMPORT')", [TENANT, `minimal-${++sequence}`])));
  }, 0);

  for (const [from, to] of [['FREEZING', 'FINAL_IMPORT'], ['FINAL_IMPORT', 'ACTIVE']] as const) {
    it(`rejects otherwise valid ${from}->${to} UPDATE specifically at the candidate guard`, async () => {
      await embargo(`${from}->${to}`, 'UPDATE', () => runtime(TENANT, client => forward(client, from, to)));
    }, 0);
    it(`does not unlock ${from}->${to} UPDATE with trusted GUC spoofing`, async () => {
      await embargo(`${from}->${to} spoofed`, 'UPDATE', () => runtime(TENANT, async client => {
        await spoof(client, TENANT);
        return forward(client, from, to, `spoof-${from}`);
      }));
    }, 0);
  }

  it('commits safe DISCOVERED insertion and preparatory DISCOVERED->VALIDATED with exact persisted readback', async () => {
    const before = await snapshot();
    const id = `safe-${++sequence}`;
    const created = await runtime(TENANT, async client => (await discovered(client, id)).rows[0].row as Record<string, unknown>);
    expect(created).toEqual({ tenant_id: TENANT, job_id: id, status: 'DISCOVERED', state_version: 1,
      source_fingerprint: null, final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null,
      completed_at: null, created_at: expect.any(String), updated_at: expect.any(String) });
    expect(created.updated_at).toBe(created.created_at);
    const inserted = await snapshot();
    expect(inserted.migration_jobs.filter(({ row }) => row.job_id === id)).toEqual([{ row: created, xmin: expect.any(String) }]);
    const updated = await runtime(TENANT, async client => (await client.query(`UPDATE public.migration_jobs
      SET status='VALIDATED',state_version=state_version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND job_id=$2 AND status='DISCOVERED' AND state_version=1
      RETURNING to_jsonb(migration_jobs) AS row`, [TENANT, id])).rows);
    expect(updated).toEqual([{ row: { ...created, status: 'VALIDATED', state_version: 2, updated_at: expect.any(String) } }]);
    const after = await snapshot();
    expect(after.migration_jobs.filter(({ row }) => row.job_id === id)).toEqual([{ row: updated[0].row, xmin: expect.any(String) }]);
    expect(after.migration_jobs.filter(({ row }) => row.job_id !== id)).toEqual(before.migration_jobs);
    for (const table of Object.keys(before).filter(name => name !== 'migration_jobs')) expect(after[table], table).toEqual(before[table]);
    facts.push({ case: 'safe preparatory path', inserted: created, persisted: updated[0].row, unrelatedRowsAndXminUnchanged: true });
  }, 0);

  it('retains old protected fixtures rather than repairing or authenticating their fabricated evidence', async () => {
    expect(fixture).toBeDefined();
    const state = await snapshot();
    for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) {
      const historical = (rows: Stored[]) => rows.filter(({ row }) => row.tenant_id === TENANT && row.job_id === `historical-${status}`);
      expect(historical(state.migration_jobs)).toEqual(historical(fixture!.migration_jobs));
      expect(historical(state.migration_jobs)).toHaveLength(1);
    }
  }, 0);

  it('keeps nonprotected foreign-tenant RLS refusal distinct from the candidate 42501', async () => {
    await denied('nonprotected RLS', () => runtime(TENANT, client => discovered(client, `foreign-${++sequence}`, FOREIGN)),
      { code: '42501', message: 'new row violates row-level security policy for table "migration_jobs"' });
  }, 0);

  it('keeps the existing hash CHECK on nonprotected INSERT distinct from guard success', async () => {
    await denied('nonprotected hash shape', () => runtime(TENANT, client => client.query(
      'INSERT INTO public.migration_jobs(tenant_id,job_id,source_fingerprint) VALUES($1,$2,$3)',
      [TENANT, `bad-hash-${++sequence}`, 'not-a-digest'])), { code: '23514', constraint: 'migration_jobs_hashes_check' });
  }, 0);

  it('keeps existing version-only UPDATE rejection distinct from guard success', async () => {
    await denied('version-only', () => runtime(TENANT, client => client.query(
      "UPDATE public.migration_jobs SET state_version=state_version+1 WHERE tenant_id=$1 AND job_id='sentinel'", [TENANT])),
    { code: 'P0001', message: 'state_version may change only with status' });
  }, 0);
});
