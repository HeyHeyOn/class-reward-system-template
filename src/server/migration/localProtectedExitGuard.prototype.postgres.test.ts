// @vitest-environment node
// SYNTHETIC PG17 / NONAUTHORITY / NOT DEPLOYED / NOT Task19/23 acceptance.
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localProtectedExitGuard.prototype.postgres.test.ts --maxWorkers=1
// Scope: one added AFTER UPDATE candidate, on top of unchanged entry/evidence prototypes.
// Only the unchanged disposable harness provisions baseline roles/grants. No extra ACL/owner changes.
// Normal ABORT below exercises cutover.ts:83-88 SQL semantics, NOT its authenticated service.
// Missing: full audit acceptance, caller auth, operational ACL, external writer exclusion,
// DELETE/TRUNCATE/CASCADE, INSERT/UPSERT/COPY/MERGE, races, other trigger ordering,
// ACTIVE/FAILED/all evidence-field permutations, GUC attacks, full repository compatibility,
// ENABLE ALWAYS/owner/replica bypass protection, old evidence authenticity and deployment.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';

vi.mock('server-only', () => ({}));

const SELF = 'src/server/migration/localProtectedExitGuard.prototype.postgres.test.ts';
const ENTRY_SOURCE = 'src/server/migration/localProtectedEntryGuard.prototype.postgres.test.ts';
const EVIDENCE_SOURCE = 'src/server/migration/localProtectedEvidenceGuard.prototype.postgres.test.ts';
const AUDITS = '/home/haeon/workhub-tasks/live/class-store-supervision';
const TENANT = '20000000-0000-4000-8000-000000000093';
const FOREIGN = '20000000-0000-4000-8000-000000000094';
const SOURCE = 'a'.repeat(64);
const FINAL = 'b'.repeat(64);
const REWRITE = 'c'.repeat(64);
const GUARD = 'migration_jobs_protected_exit_guard';
const FUNCTION = 'guard_migration_job_protected_exit';
const MESSAGE = 'Prototype protected migration job exit evidence change refused.';
const CASES = ['combined', 'source', 'completion', 'reconcile'] as const;
const watched = ['.git/index', SELF, ENTRY_SOURCE, EVIDENCE_SOURCE, 'AGENTS.md', 'package.json', 'vitest.config.mts', 'tsconfig.json',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c', 'src/server/db/transaction.ts',
  'src/server/migration/cutover.ts', 'src/server/migration/localProtectedJobEvidenceMutation.test.ts',
  'src/server/migration/localProtectedJobInsert.postgres.test.ts',
  ...['secondbot-protected-exit-audit-20260926.md', 'secondbot-protected-evidence-audit-20260926.md',
    'secondbot-protected-insert-guard-audit-20260926.md'].map(name => join(AUDITS, name)),
  ...readdirSync('src/server/db/migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()
    .map(name => join('src/server/db/migrations', name))];
const hashes = () => Object.fromEntries(watched.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));

// Byte-checked SQL literals only; never import another test module or edit its helpers.
const ENTRY_SQL = `CREATE FUNCTION public.guard_migration_job_protected_entry()
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
          ON public.migration_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_migration_job_protected_entry()`;
const EVIDENCE_SQL = `CREATE FUNCTION public.guard_migration_job_protected_evidence()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
        BEGIN
          IF OLD.status IN ('FINAL_IMPORT','ACTIVE')
             AND NEW.status IS NOT DISTINCT FROM OLD.status
             AND ROW(NEW.source_fingerprint,NEW.final_fingerprint,NEW.freeze_started_at,
                     NEW.freeze_verified_at,NEW.created_at,NEW.completed_at)
                 IS DISTINCT FROM
                 ROW(OLD.source_fingerprint,OLD.final_fingerprint,OLD.freeze_started_at,
                     OLD.freeze_verified_at,OLD.created_at,OLD.completed_at) THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
              MESSAGE = 'Prototype protected migration job evidence change refused.',
              DETAIL = TG_OP, SCHEMA = 'public', TABLE = 'migration_jobs',
              CONSTRAINT = 'migration_jobs_protected_evidence_guard';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER migration_jobs_protected_evidence_guard BEFORE UPDATE
          ON public.migration_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_migration_job_protected_evidence()`;

type Stored = { row: Record<string, unknown>; xmin: string };
type State = Record<string, Stored[]>;
type Transaction = { client: PoolClient; xid: string; clock: string };
const assignments = {
  abort: "status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now()",
  combined: "status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now(),source_fingerprint=$6::text",
  source: 'source_fingerprint=$6::text,updated_at=now()',
  completion: "completed_at=completed_at+interval '1 microsecond',updated_at=completed_at+interval '1 second'",
  reconcile: "status='RECONCILING',state_version=state_version+1,updated_at=now()",
  prepare: "status='VALIDATED',state_version=state_version+1,updated_at=now()",
  invalidHash: "status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now(),source_fingerprint='not-a-hash'",
  invalidVersion: "status='ABORTED',completed_at=now(),updated_at=now()",
} as const;
type Mutation = keyof typeof assignments;

// Opt-in infrastructure failure is failure, never skip or a fallback database.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('synthetic PG17 bounded protected exit guard prototype', () => {
  let database: DisposablePostgres | undefined;
  let originalHashes: ReturnType<typeof hashes> | undefined;
  let originalCatalog: Awaited<ReturnType<typeof catalog>> | undefined;
  let fixture: State | undefined;
  let ownerPid: number;
  const facts: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = { authority: 'NONAUTHORITY', deployed: false, task19Accepted: false,
    task23Accepted: false, callerAuthentication: 'NOT_TESTED', externalWriterExclusion: 'NOT_PROVEN',
    scope: 'ONE_AFTER_UPDATE_EXIT_CANDIDATE_NOT_FULL_AUDIT_ACCEPTANCE',
    connection: 'SEPARATE_NONOWNER_LOGIN_OWNED_TRUST_SOCKET_NOT_PRODUCTION_AUTH',
    missing: ['FULL_CUTOVER_SERVICE', 'OPERATIONAL_ACL_AND_AUTHORITY', 'EXTERNAL_WRITERS', 'INSERT_UPSERT_COPY_MERGE',
      'DELETE_TRUNCATE_CASCADE', 'CONCURRENCY', 'OTHER_TRIGGER_ORDERING', 'ACTIVE_FAILED_AND_ALL_FIELD_PERMUTATIONS',
      'GUC_ATTACKS', 'FULL_REPOSITORY_COMPATIBILITY', 'ENABLE_ALWAYS_OWNER_REPLICA_BYPASSES', 'OLD_EVIDENCE_AUTHENTICITY'] };
  const externalFetch = vi.fn(async () => { throw new Error('External fetch forbidden in synthetic exit test'); });
  const db = () => { if (!database) throw new Error('Owned PG17 setup incomplete'); return database; };

  async function snapshot(): Promise<State> {
    const tables = (await db().owner.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const result: State = {};
    for (const { tablename } of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected synthetic relation');
      result[tablename] = (await db().owner.query<Stored>(`SELECT to_jsonb(t) AS row,xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }
  function target(state: State, id: string): Stored {
    const found = state.migration_jobs.filter(({ row }) => row.tenant_id === TENANT && row.job_id === id);
    expect(found, `owner actual row ${id}`).toHaveLength(1);
    return found[0];
  }
  function otherRowsUnchanged(before: State, after: State, id: string) {
    for (const table of Object.keys(before)) {
      const retain = (rows: Stored[]) => table !== 'migration_jobs' ? rows
        : rows.filter(({ row }) => row.tenant_id !== TENANT || row.job_id !== id);
      expect(retain(after[table]), table).toEqual(retain(before[table]));
    }
  }
  async function catalog(excludePriorPrototypes = false) {
    const functions = [FUNCTION, ...(excludePriorPrototypes ? ['guard_migration_job_protected_entry', 'guard_migration_job_protected_evidence'] : [])];
    const triggers = [GUARD, ...(excludePriorPrototypes ? ['migration_jobs_protected_entry_guard', 'migration_jobs_protected_evidence_guard'] : [])];
    return {
      roles: (await db().owner.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows,
      memberships: (await db().owner.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
      relations: (await db().owner.query("SELECT relname,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows,
      columns: (await db().owner.query("SELECT attrelid::regclass::text AS relation,attname,attacl::text FROM pg_attribute WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY relation,attnum")).rows,
      policies: (await db().owner.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
      functions: (await db().owner.query(`SELECT oid::regprocedure::text AS signature,proowner::text,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) AS definition
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND NOT (proname=ANY($1::text[])) ORDER BY signature`, [functions])).rows,
      triggers: (await db().owner.query(`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) AND NOT (tgname=ANY($1::text[])) ORDER BY relation,tgname`, [triggers])).rows,
      constraints: (await db().owner.query("SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname,contype")).rows,
    };
  }
  async function runtime<T>(action: (tx: Transaction) => Promise<T>) {
    const client = await db().runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT]);
      const identity = (await client.query(`SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid,
        pg_current_xact_id()::text AS xid,to_jsonb(now()) AS clock,current_setting('app.tenant_id') AS tenant,
        r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'UPDATE') AS can_update
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows[0];
      expect(identity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', tenant: TENANT, rolsuper: false,
        rolbypassrls: false, rolcanlogin: true, rolinherit: false, rolcreaterole: false, rolcreatedb: false,
        rolreplication: false, relrowsecurity: true, relforcerowsecurity: true, can_update: true });
      expect(identity.owner).not.toBe('app_runtime');
      expect(identity.pid).not.toBe(ownerPid);
      expect(identity.xid).toMatch(/^\d+$/);
      expect(typeof identity.clock).toBe('string');
      evidence.runtimeIdentity = identity;
      const value = await action({ client, xid: identity.xid, clock: identity.clock });
      await client.query('COMMIT');
      return { value, xid: identity.xid as string };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function readTarget(client: PoolClient, id: string): Promise<Stored> {
    const result = await client.query<Stored>('SELECT to_jsonb(j) AS row,xmin::text FROM public.migration_jobs j WHERE tenant_id=$1 AND job_id=$2', [TENANT, id]);
    expect(result.rowCount, `visible runtime target ${id}`).toBe(1);
    return result.rows[0];
  }
  async function mutate(tx: Transaction, id: string, kind: Mutation, original: Stored): Promise<Stored> {
    expect(await readTarget(tx.client, id)).toEqual(original);
    const changesSource = kind === 'source' || kind === 'combined';
    const result = await tx.client.query<Stored>(`UPDATE public.migration_jobs SET ${assignments[kind]}
      WHERE tenant_id=$1 AND job_id=$2 AND status=$3 AND state_version=$4::bigint
        AND source_fingerprint IS NOT DISTINCT FROM $5::text RETURNING to_jsonb(migration_jobs) AS row,xmin::text`,
    [TENANT, id, original.row.status, original.row.state_version, original.row.source_fingerprint, ...(changesSource ? [REWRITE] : [])]);
    expect(result.rowCount, `${id} actual UPDATE RETURNING; zero is not guard refusal`).toBe(1);
    return result.rows[0];
  }
  async function allowed(id: string, kind: Mutation) {
    const before = await snapshot();
    const original = target(before, id);
    const committed = await runtime(async tx => {
      const changed = await mutate(tx, id, kind, original);
      const expected = { ...original.row };
      if (kind === 'abort' || kind === 'combined') {
        expect(original.row.completed_at).toBeNull();
        Object.assign(expected, { status: 'ABORTED', state_version: 8, completed_at: tx.clock, updated_at: tx.clock });
      } else if (kind === 'reconcile') Object.assign(expected, { status: 'RECONCILING', state_version: 8, updated_at: tx.clock });
      else if (kind === 'completion') {
        const times = (await tx.client.query("SELECT to_jsonb($1::timestamptz+interval '1 microsecond') AS completed,to_jsonb($1::timestamptz+interval '1 second') AS updated", [original.row.completed_at])).rows[0];
        Object.assign(expected, { completed_at: times.completed, updated_at: times.updated });
      } else if (kind === 'source') expected.updated_at = tx.clock;
      else throw new Error('Unspecified allowed mutation');
      if (kind === 'combined' || kind === 'source') expected.source_fingerprint = REWRITE;
      expect(changed.row).toEqual(expected);
      expect(changed.xmin).not.toBe(original.xmin);
      expect(await readTarget(tx.client, id)).toEqual(changed);
      return changed;
    });
    const after = await snapshot();
    expect(target(after, id)).toEqual(committed.value);
    otherRowsUnchanged(before, after, id);
    expect((await runtime(tx => readTarget(tx.client, id))).value).toEqual(committed.value);
    facts.push({ id, kind, observed: 'COMMITTED_OWNER_AND_RUNTIME_READBACK', xid: committed.xid,
      before: original.row, persisted: committed.value.row, otherRowsAndChildrenPreserved: true });
    return committed;
  }
  async function denied(id: string, action: () => Promise<unknown>, expected: Record<string, unknown>, candidate = true) {
    const before = await snapshot();
    let caught: unknown;
    let returned: unknown;
    try { returned = await action(); } catch (error) { caught = error; }
    const after = await snapshot();
    if (caught === undefined) facts.push({ id, observed: 'UNEXPECTED_COMMITTED_UPDATE', returning: returned,
      before: target(before, id), persisted: target(after, id) });
    expect(caught, `${id}: a committed UPDATE or zero rows is not refusal`).toEqual(expect.objectContaining(expected));
    const error = caught as { code: string; constraint?: string; message: string; where?: string };
    if (candidate) {
      expect(caught).toMatchObject({ code: '42501', message: MESSAGE, constraint: GUARD,
        schema: 'public', table: 'migration_jobs', detail: 'UPDATE' });
      expect(error.where).toContain(`${FUNCTION}()`);
      expect(error.where).toContain('RAISE');
    } else expect(error.constraint).not.toBe(GUARD);
    expect(after, `${id}: rollback all public rows/xmin`).toEqual(before);
    expect((await runtime(tx => readTarget(tx.client, id))).value).toEqual(target(before, id));
    facts.push({ id, observed: candidate ? 'EXIT_GUARD_REFUSAL' : 'UNRELATED_ERROR_CONTROL',
      code: error.code, constraint: error.constraint, message: error.message, where: error.where, allRowsAndXminPreserved: true });
  }
  async function installCandidate() {
    // One additive AFTER UPDATE guard, only in this run's freshly owned database.
    // No trigger-disable/role exception, ACL change, or permanent migration.
    // ACTIVE/FAILED branches are deliberately labelled untested in this bounded suite.
    const client = await db().owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE FUNCTION public.guard_migration_job_protected_exit()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
        DECLARE refused boolean := false;
        BEGIN
          IF OLD.status IN ('FINAL_IMPORT','ACTIVE','ABORTED','FAILED') THEN
            IF ROW(NEW.tenant_id,NEW.job_id,NEW.source_fingerprint,NEW.final_fingerprint,
                   NEW.freeze_started_at,NEW.freeze_verified_at,NEW.created_at)
               IS DISTINCT FROM
               ROW(OLD.tenant_id,OLD.job_id,OLD.source_fingerprint,OLD.final_fingerprint,
                   OLD.freeze_started_at,OLD.freeze_verified_at,OLD.created_at) THEN
              refused := true;
            ELSIF OLD.status='FINAL_IMPORT' AND NEW.status='ABORTED' THEN
              refused := OLD.completed_at IS NOT NULL
                OR NEW.state_version IS DISTINCT FROM (OLD.state_version+1)
                OR NEW.completed_at IS DISTINCT FROM transaction_timestamp()
                OR NEW.updated_at IS DISTINCT FROM transaction_timestamp();
            ELSE
              refused := ROW(NEW.status,NEW.state_version,NEW.completed_at)
                IS DISTINCT FROM ROW(OLD.status,OLD.state_version,OLD.completed_at);
            END IF;
          END IF;
          IF refused THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
              MESSAGE = 'Prototype protected migration job exit evidence change refused.',
              DETAIL = TG_OP, SCHEMA = 'public', TABLE = 'migration_jobs',
              CONSTRAINT = 'migration_jobs_protected_exit_guard';
          END IF;
          RETURN NULL;
        END;
        $$;
        CREATE TRIGGER migration_jobs_protected_exit_guard AFTER UPDATE
          ON public.migration_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_migration_job_protected_exit()`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  beforeAll(async () => {
    originalHashes = hashes();
    expect(readFileSync(ENTRY_SOURCE, 'utf8')).toContain(ENTRY_SQL);
    expect(readFileSync(EVIDENCE_SOURCE, 'utf8')).toContain(EVIDENCE_SQL);
    vi.stubGlobal('fetch', externalFetch);
    database = await createDisposablePostgres();
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner',
      networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true,
      droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.version).toMatch(/^17\./);
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(database.evidence.tmpfs).toEqual(['/test-bin', '/tmp', '/var/lib/postgresql/data', '/var/run/postgresql']);
    evidence.infrastructure = database.evidence;
    const owner = (await database.owner.query('SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid')).rows[0];
    expect(owner).toMatchObject({ actor: 'postgres', login: 'postgres' });
    ownerPid = owner.pid;
    expect((await database.owner.query('SELECT * FROM public.migration_jobs')).rows).toEqual([]);
    expect((await database.owner.query('SELECT * FROM public.tenants')).rows).toEqual([]);
    const schemaCatalog = await catalog(true);
    await database.owner.query(`INSERT INTO public.tenants(id,slug,display_name,lifecycle) VALUES
      ($1,'exit-guard-one','Synthetic Exit One','DRAFT'),($2,'exit-guard-two','Synthetic Exit Two','DRAFT')`, [TENANT, FOREIGN]);
    const ids = [...CASES.flatMap(kind => [`baseline-${kind}`, `guarded-${kind}`]), 'rollback-protected', 'null-abort',
      'control-invalidHash', 'control-invalidVersion'];
    for (const id of ids) await database.owner.query(`INSERT INTO public.migration_jobs
      (tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,created_at,freeze_started_at,freeze_verified_at,updated_at)
      VALUES($1,$2,'FINAL_IMPORT',7,$3,$4,'2026-08-01T00:00:00.123456Z','2026-08-01T00:10:00.123456Z',
        '2026-08-01T00:20:00.123456Z','2026-08-01T00:40:00.123456Z')`, [TENANT, id, id === 'null-abort' ? null : SOURCE, FINAL]);
    await database.owner.query(`INSERT INTO public.migration_jobs(tenant_id,job_id,status,state_version) VALUES
      ($1,'rollback-safe','DISCOVERED',7),($2,'sentinel','DISCOVERED',7)`, [TENANT, FOREIGN]);
    for (const [tenant, id] of [[TENANT, 'guarded-combined'], [FOREIGN, 'sentinel']]) {
      await database.owner.query(`INSERT INTO public.migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
        VALUES($1,$2,$2,'GOOGLE_SHEETS',$2,$3)`, [tenant, id, 'd'.repeat(64)]);
    }
    const beforePrior = await snapshot();
    await database.owner.query(ENTRY_SQL);
    await database.owner.query(EVIDENCE_SQL);
    expect(await snapshot()).toEqual(beforePrior);
    expect(await catalog(true)).toEqual(schemaCatalog);
    originalCatalog = await catalog(); // Includes both unchanged earlier prototypes.
    expect((await database.owner.query('SELECT to_regprocedure($1) AS candidate', [`public.${FUNCTION}()`])).rows).toEqual([{ candidate: null }]);
    await allowed('baseline-combined', 'combined');
    for (const kind of ['source', 'completion'] as const) {
      const aborted = await allowed(`baseline-${kind}`, 'abort');
      const rewritten = await allowed(`baseline-${kind}`, kind);
      expect(rewritten.xid).not.toBe(aborted.xid);
    }
    await allowed('baseline-reconcile', 'reconcile');
    evidence.baselineCompletedUnderBothPriorPrototypes = true;
    fixture = await snapshot();
    await installCandidate();
    expect(await snapshot()).toEqual(fixture);
    expect(await catalog()).toEqual(originalCatalog);
  }, 0);

  afterAll(async () => {
    try {
      if (database && originalCatalog) expect(await catalog()).toEqual(originalCatalog);
      if (database && fixture) {
        const after = await snapshot();
        for (const table of Object.keys(fixture).filter(name => name !== 'migration_jobs')) expect(after[table], table).toEqual(fixture[table]);
        for (const id of ['guarded-combined', 'guarded-reconcile', 'rollback-protected', 'rollback-safe']) expect(target(after, id)).toEqual(target(fixture, id));
        const retained = (rows: Stored[]) => rows.filter(({ row }) => row.tenant_id === FOREIGN
          || String(row.job_id).startsWith('baseline-') || String(row.job_id).startsWith('control-'));
        expect(retained(after.migration_jobs)).toEqual(retained(fixture.migration_jobs));
        evidence.unchangedHistoricalRowsChildrenSentinelAndDraftTenants = true;
      }
    } finally {
      try {
        if (database) {
          evidence.cleanup = await database.close();
          expect(evidence.cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
        }
      } finally {
        vi.unstubAllGlobals();
        const afterHashes = hashes();
        evidence.sourceHashes = afterHashes;
        evidence.sourceFilesUnchanged = JSON.stringify(afterHashes) === JSON.stringify(originalHashes);
        evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
        process.stdout.write('LOCAL_PROTECTED_EXIT_GUARD_PROTOTYPE ' + JSON.stringify({ ...evidence, facts }) + '\n');
        expect(afterHashes).toEqual(originalHashes);
        expect(externalFetch).not.toHaveBeenCalled();
      }
    }
  }, 0);

  it('adds only a nondeferred SECURITY INVOKER row AFTER UPDATE candidate, preserving prior schema/ACL/prototypes', async () => {
    expect(evidence.baselineCompletedUnderBothPriorPrototypes).toBe(true);
    const { rows } = await db().owner.query(`SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
      t.tgenabled,t.tgtype::int AS kind,t.tgdeferrable,t.tginitdeferred,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.migration_jobs'::regclass AND t.tgname=$1`, [GUARD]);
    expect(rows).toEqual([expect.objectContaining({ prosecdef: false, proconfig: ['search_path=pg_catalog'], owner: 'postgres',
      tgenabled: 'O', kind: 17, tgdeferrable: false, tginitdeferred: false })]);
    expect(rows[0].definition).toContain('AFTER UPDATE');
    evidence.candidateCatalog = rows[0];
  }, 0);

  it('rejects the baseline-proven FINAL_IMPORT->ABORTED plus source rewrite on a visible independent row', async () => {
    const id = 'guarded-combined';
    const original = target(await snapshot(), id);
    await denied(id, () => runtime(tx => mutate(tx, id, 'combined', original)), { code: '42501', constraint: GUARD });
  }, 0);

  for (const kind of ['source', 'completion'] as const) it(`allows normal ABORT commit then rejects ${kind} rewrite in a separate transaction`, async () => {
    const id = `guarded-${kind}`;
    const aborted = await allowed(id, 'abort');
    expect(aborted.value.row).toMatchObject({ status: 'ABORTED', state_version: 8, source_fingerprint: SOURCE });
    expect(typeof aborted.value.row.completed_at).toBe('string');
    let secondXid: string | undefined;
    await denied(id, () => runtime(tx => {
      secondXid = tx.xid;
      expect(secondXid).not.toBe(aborted.xid);
      return mutate(tx, id, kind, aborted.value);
    }), { code: '42501', constraint: GUARD });
    expect(secondXid).toMatch(/^\d+$/);
    facts.push({ id, observed: 'ABORT_COMMITTED_BEFORE_SEPARATE_REFUSED_TRANSACTION', abortXid: aborted.xid, refusedXid: secondXid });
  }, 0);

  it('allows first completion while retaining an unbound NULL source without fabricating evidence', async () => {
    const result = await allowed('null-abort', 'abort');
    expect(result.value.row.source_fingerprint).toBeNull();
  }, 0);

  it('refuses baseline-proven FINAL_IMPORT->RECONCILING without relying on the old transition trigger', async () => {
    const id = 'guarded-reconcile';
    const original = target(await snapshot(), id);
    await denied(id, () => runtime(tx => mutate(tx, id, 'reconcile', original)), { code: '42501', constraint: GUARD });
  }, 0);

  it('rolls back a witnessed preparatory UPDATE when the later combined exit is refused', async () => {
    const before = await snapshot();
    let witnessed = false;
    await denied('rollback-protected', () => runtime(async tx => {
      const changed = await mutate(tx, 'rollback-safe', 'prepare', target(before, 'rollback-safe'));
      expect(changed.row).toEqual({ ...target(before, 'rollback-safe').row, status: 'VALIDATED', state_version: 8, updated_at: tx.clock });
      expect(await readTarget(tx.client, 'rollback-safe')).toEqual(changed);
      expect(target(await snapshot(), 'rollback-safe')).toEqual(target(before, 'rollback-safe'));
      witnessed = true;
      return mutate(tx, 'rollback-protected', 'combined', target(before, 'rollback-protected'));
    }), { code: '42501', constraint: GUARD });
    expect(witnessed).toBe(true);
    evidence.rollbackWitness = { updateReturning: true, sameTransactionRead: true, invisibleToOwnerBeforeRollback: true, allRowsAndXminRestored: true };
  }, 0);

  it.each([
    { kind: 'invalidHash' as const, error: { code: '23514', constraint: 'migration_jobs_hashes_check' } },
    { kind: 'invalidVersion' as const, error: { code: 'P0001', message: 'migration state_version must increment' } },
  ])('keeps $kind rejection separate from candidate guard success', async ({ kind, error }) => {
    const id = `control-${kind}`;
    const original = target(await snapshot(), id);
    await denied(id, () => runtime(tx => mutate(tx, id, kind, original)), error, false);
  }, 0);
});
