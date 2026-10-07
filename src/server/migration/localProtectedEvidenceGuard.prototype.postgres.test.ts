// @vitest-environment node
// SYNTHETIC PG17 PROTOTYPE / NONAUTHORITY / NOT DEPLOYED / NOT Task19/23 acceptance.
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localProtectedEvidenceGuard.prototype.postgres.test.ts --maxWorkers=1
// Only the unchanged harness provisions baseline test roles/grants. No ACL/owner
// changes here. New trigger functions exist only in the freshly owned database.
// Missing: operational ACL/auth/authority, old evidence authenticity, tenant ACTIVE,
// external writer exclusion, UPSERT/COPY/MERGE/delete/races/full repository coverage.
// FINAL_IMPORT null final/start/verified directions are a bundle, not per-field coverage.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';

vi.mock('server-only', () => ({}));

const SELF = 'src/server/migration/localProtectedEvidenceGuard.prototype.postgres.test.ts';
const ENTRY_SOURCE = 'src/server/migration/localProtectedEntryGuard.prototype.postgres.test.ts';
const AUDIT_ROOT = '/home/haeon/workhub-tasks/live/class-store-supervision';
const TENANT = '20000000-0000-4000-8000-000000000091';
const FOREIGN = '20000000-0000-4000-8000-000000000092';
const GUARD = 'migration_jobs_protected_evidence_guard';
const FUNCTION = 'guard_migration_job_protected_evidence';
const MESSAGE = 'Prototype protected migration job evidence change refused.';
const SOURCE = 'a'.repeat(64);
const FINAL = 'b'.repeat(64);
const REWRITE = 'c'.repeat(64);
const ACQUISITION = 'd'.repeat(64); // Deliberately distinct from the job semantic digest.
const at = (minute: string) => `2026-08-01T00:${minute}:00.123456+00:00`;
const TYPES = { tenant_id: 'uuid', job_id: 'text', status: 'text', state_version: 'bigint',
  source_fingerprint: 'text', final_fingerprint: 'text', freeze_started_at: 'timestamptz',
  freeze_verified_at: 'timestamptz', created_at: 'timestamptz', completed_at: 'timestamptz', updated_at: 'timestamptz' } as const;
type Patch = Partial<Record<keyof typeof TYPES, string | null>>;
type ProtectedStatus = 'FINAL_IMPORT' | 'ACTIVE';
type Target = { tenant: string; id: string; status: ProtectedStatus | 'DISCOVERED' | 'READY' };
type Spec = { key: string; status: ProtectedStatus; patch: Patch; initial?: Patch; foreign?: boolean; spoof?: boolean };
type Stored = { row: Record<string, unknown>; xmin: string };
type State = Record<string, Stored[]>;
type Failure = { code: string; message?: string; constraint?: string; where?: string; detail?: string };
const statuses: ProtectedStatus[] = ['FINAL_IMPORT', 'ACTIVE'];
const specs: Spec[] = statuses.flatMap(status => [
  { key: 'source-hash', status, patch: { source_fingerprint: REWRITE } },
  { key: 'final-hash', status, patch: { final_fingerprint: REWRITE } },
  { key: 'start-time', status, patch: { freeze_started_at: at('11') } },
  { key: 'verified-microsecond', status, patch: { freeze_verified_at: '2026-08-01T00:20:00.123457+00:00' } },
  { key: 'created-time', status, patch: { created_at: at('01') } },
  { key: 'source-to-null', status, patch: { source_fingerprint: null } },
  { key: 'source-from-null', status, initial: { source_fingerprint: null }, patch: { source_fingerprint: REWRITE } },
  { key: 'spoof-local', status, spoof: true, patch: { source_fingerprint: REWRITE } },
  { key: 'spoof-foreign', status, foreign: true, spoof: true, patch: { source_fingerprint: REWRITE } },
]);
specs.push({ key: 'completed-time', status: 'ACTIVE', patch: { completed_at: at('31') } },
  { key: 'nullable-bundle-clear', status: 'FINAL_IMPORT', patch: { final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null } },
  { key: 'nullable-bundle-fill', status: 'FINAL_IMPORT', initial: { final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null },
    patch: { final_fingerprint: FINAL, freeze_started_at: at('10'), freeze_verified_at: at('20') } });
const target = (spec: Spec, phase: 'baseline' | 'guarded'): Target => ({
  tenant: spec.foreign ? FOREIGN : TENANT, id: `${phase}-${spec.status}-${spec.key}`, status: spec.status });
const control = (status: Target['status'], name: string, tenant = TENANT): Target => ({ tenant, id: `${name}-${status}`, status });
const watched = ['.git/index', 'AGENTS.md', 'package.json', 'vitest.config.mts', 'tsconfig.json', SELF, ENTRY_SOURCE,
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c', 'src/server/db/transaction.ts',
  'src/server/migration/localProtectedJobEvidenceMutation.test.ts', 'src/server/migration/localProtectedJobInsert.postgres.test.ts',
  join(AUDIT_ROOT, 'secondbot-protected-evidence-audit-20260926.md'),
  join(AUDIT_ROOT, 'secondbot-protected-insert-guard-audit-20260926.md'),
  ...readdirSync('src/server/db/migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()
    .map(name => join('src/server/db/migrations', name))];
const fileHashes = () => Object.fromEntries(watched.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));

// Literal of the existing entry prototype, verified against its unchanged source.
// Do not import a test module or extract/export helpers from another team's file.
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

// Opted-in setup/infrastructure failures must fail, never skip or change connection.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('synthetic PG17 same-status evidence guard prototype', () => {
  let database: DisposablePostgres | undefined;
  let beforeHashes: ReturnType<typeof fileHashes> | undefined;
  let originalCatalog: Awaited<ReturnType<typeof catalog>> | undefined;
  let fixture: State | undefined;
  const facts: Array<Record<string, unknown>> = [];
  const evidence: Record<string, unknown> = { authority: 'NONAUTHORITY', deployed: false, activationAllowed: false,
    task19Accepted: false, task23Accepted: false, externalWriterExclusion: 'NOT_PROVEN',
    authentication: 'SEPARATE_NONOWNER_LOGIN_OWNED_LOCAL_TRUST_SOCKET_NOT_PRODUCTION_AUTH',
    missingCases: ['UPSERT_COPY_MERGE_DELETE', 'CONCURRENCY_AND_LOCK_RACES', 'FULL_ACTIVE_REPOSITORY_COMPATIBILITY',
      'INDIVIDUAL_FINAL_NULL_DIRECTIONS_BEYOND_BUNDLE', 'ALL_EXIT_TRANSITIONS', 'OPERATIONAL_ACL_AND_AUTHORITY',
      'TENANT_ACTIVE_GUARD', 'EXTERNAL_WRITER_EXCLUSION', 'OLD_EVIDENCE_AUTHENTICITY'],
    limitations: ['UPDATED_AT_NOT_SEALED_OR_MONOTONIC', 'EXIT_PLUS_EVIDENCE_CHANGE_NOT_BLOCKED', 'ENTRY_GUARD_NOT_DEPLOYED'] };
  const externalFetch = vi.fn(async () => { throw new Error('External fetch forbidden in synthetic evidence guard test'); });
  const db = () => { if (!database) throw new Error('Owned PG17 setup incomplete'); return database; };

  async function snapshot(): Promise<State> {
    const tables = (await db().owner.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const result: State = {};
    for (const { tablename } of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected synthetic table identifier');
      result[tablename] = (await db().owner.query<Stored>(
        `SELECT to_jsonb(t) AS row,xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }

  async function catalog(excludeEntry = false) {
    const functions = [FUNCTION, ...(excludeEntry ? ['guard_migration_job_protected_entry'] : [])];
    const triggers = [GUARD, ...(excludeEntry ? ['migration_jobs_protected_entry_guard'] : [])];
    const owner = db().owner;
    return {
      roles: (await owner.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows,
      memberships: (await owner.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
      relations: (await owner.query("SELECT relname,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows,
      columns: (await owner.query(`SELECT attrelid::regclass::text AS relation,attname,attacl::text FROM pg_attribute
        WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY relation,attnum`)).rows,
      policies: (await owner.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
      functions: (await owner.query(`SELECT oid::regprocedure::text AS signature,proowner::text,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) AS definition
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND NOT (proname=ANY($1::text[])) ORDER BY signature`, [functions])).rows,
      triggers: (await owner.query(`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
        AND NOT (tgname=ANY($1::text[])) ORDER BY relation,tgname`, [triggers])).rows,
      constraints: (await owner.query("SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname,contype")).rows,
    };
  }

  async function runtime<T>(tenant: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db().runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      const identity = (await client.query(`SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid,
        current_setting('app.tenant_id',true) AS tenant,current_setting('transaction_isolation') AS isolation,
        r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,inet_server_addr() AS address
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows[0];
      expect(identity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', tenant, isolation: 'read committed',
        rolsuper: false, rolbypassrls: false, rolcanlogin: true, rolinherit: false, rolcreaterole: false,
        rolcreatedb: false, rolreplication: false, relrowsecurity: true, relforcerowsecurity: true, can_update: true, address: null });
      expect(identity.owner).not.toBe('app_runtime');
      expect(identity.pid).not.toBe((evidence.ownerIdentity as { pid: number }).pid);
      evidence.runtimeIdentity = identity;
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  function entries(patch: Patch) {
    return Object.entries(patch).map(([key, value]) => {
      if (!Object.hasOwn(TYPES, key)) throw new Error('Unexpected test column');
      return { key, value, type: TYPES[key as keyof typeof TYPES] };
    });
  }

  async function normalized(patch: Patch): Promise<Record<string, unknown>> {
    const fields = entries(patch);
    if (!fields.length) return {};
    // Only named SQL column types are normalized by PostgreSQL. Never Date.parse,
    // JS Date conversion or blanket date-like string rewriting of evidence.
    return (await db().owner.query(`SELECT jsonb_build_object(${fields.map((f, i) => `'${f.key}',$${i + 1}::${f.type}`).join(',')}) AS patch`,
      fields.map(f => f.value))).rows[0].patch;
  }

  function ownRow(state: State, t: Target): Stored {
    const rows = state.migration_jobs.filter(({ row }) => row.tenant_id === t.tenant && row.job_id === t.id);
    expect(rows, `actual owner target ${t.id}`).toHaveLength(1);
    return rows[0];
  }

  async function readTarget(client: PoolClient, t: Target): Promise<Stored> {
    const result = await client.query<Stored>('SELECT to_jsonb(j) AS row,xmin::text FROM public.migration_jobs j WHERE tenant_id=$1 AND job_id=$2', [t.tenant, t.id]);
    expect(result.rowCount, `visible runtime target ${t.id}`).toBe(1);
    return result.rows[0];
  }

  async function mutate(client: PoolClient, t: Target, patch: Patch): Promise<Stored> {
    const fields = entries(patch);
    expect(fields.length).toBeGreaterThan(0);
    const result = await client.query<Stored>(`UPDATE public.migration_jobs SET ${fields.map((f, i) => `${f.key}=$${i + 4}::${f.type}`).join(',')}
      WHERE tenant_id=$1 AND job_id=$2 AND status=$3 AND state_version=7 RETURNING to_jsonb(migration_jobs) AS row,xmin::text`,
    [t.tenant, t.id, t.status, ...fields.map(f => f.value)]);
    expect(result.rowCount, `actual UPDATE RETURNING ${t.id}; zero is not refusal`).toBe(1);
    return result.rows[0];
  }

  async function seed(t: Target, initial: Patch = {}) {
    const protectedRow = statuses.includes(t.status as ProtectedStatus);
    const values: Patch = { tenant_id: t.tenant, job_id: t.id, status: t.status, state_version: '7',
      source_fingerprint: protectedRow || t.status === 'READY' ? SOURCE : null,
      final_fingerprint: protectedRow ? FINAL : null, created_at: at('00'), updated_at: at('40'),
      freeze_started_at: protectedRow ? at('10') : null, freeze_verified_at: protectedRow ? at('20') : null,
      completed_at: t.status === 'ACTIVE' ? at('30') : null, ...initial };
    const fields = entries(values);
    await runtime(t.tenant, async client => {
      const result = await client.query(`INSERT INTO public.migration_jobs(${fields.map(f => f.key).join(',')})
        VALUES(${fields.map((f, i) => `$${i + 1}::${f.type}`).join(',')}) RETURNING job_id,status,state_version::text`, fields.map(f => f.value));
      expect(result.rows).toEqual([{ job_id: t.id, status: t.status, state_version: '7' }]);
      const sourceId = `synthetic:${t.tenant}:${t.id}`;
      const child = await client.query(`INSERT INTO public.migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
        VALUES($1,$2,$3,'GOOGLE_SHEETS',$3,$4) RETURNING job_id,source_fingerprint`, [t.tenant, t.id, sourceId, ACQUISITION]);
      expect(child.rows).toEqual([{ job_id: t.id, source_fingerprint: ACQUISITION }]);
    });
  }

  async function spoof(client: PoolClient, tenant: string) {
    const result = await client.query(`SELECT set_config('app.tenant_id',$1,true) AS tenant,
      set_config('app.trusted_migration','true',true) AS trusted,set_config('app.attested','true',true) AS attested,
      set_config('app.actor_id','postgres',true) AS claimed_actor,current_user AS actor`, [tenant]);
    expect(result.rows).toEqual([{ tenant, trusted: 'true', attested: 'true', claimed_actor: 'postgres', actor: 'app_runtime' }]);
  }

  async function allowed(t: Target, patch: Patch, label: string, shouldSpoof = false) {
    const before = await snapshot();
    const original = ownRow(before, t);
    const expected = { ...original.row, ...await normalized(patch) };
    const returned = await runtime(t.tenant, async client => {
      if (shouldSpoof) await spoof(client, t.tenant);
      expect(await readTarget(client, t)).toEqual(original);
      return mutate(client, t, patch);
    });
    expect(returned.row).toEqual(expected);
    const after = await snapshot();
    const saved = ownRow(after, t);
    expect(saved).toEqual(returned);
    expect(saved.xmin).not.toBe(original.xmin);
    const without = (rows: Stored[]) => rows.filter(({ row }) => !(row.tenant_id === t.tenant && row.job_id === t.id));
    expect(without(after.migration_jobs)).toEqual(without(before.migration_jobs));
    for (const table of Object.keys(before).filter(name => name !== 'migration_jobs')) expect(after[table], table).toEqual(before[table]);
    expect(await runtime(t.tenant, client => readTarget(client, t))).toEqual(saved);
    const changed = Object.keys(patch);
    const pick = (row: Record<string, unknown>) => Object.fromEntries(['status', 'state_version', ...changed].map(key => [key, row[key]]));
    facts.push({ label, id: t.id, tenant: t.tenant, observed: 'COMMITTED_AND_OWNER_PLUS_RUNTIME_READBACK',
      before: pick(original.row), persisted: pick(saved.row), priorXmin: original.xmin, persistedXmin: saved.xmin,
      otherRowsChildrenAndTenantLifecyclesUnchanged: true, spoofSucceeded: shouldSpoof });
    return saved;
  }

  async function denied(label: string, action: () => Promise<unknown>, expected: Failure, isEvidence = true) {
    const before = await snapshot();
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    expect(caught, label).toEqual(expect.objectContaining(expected));
    if (isEvidence) {
      expect(caught).toMatchObject({ schema: 'public', table: 'migration_jobs', detail: 'UPDATE' });
      expect((caught as Failure).where).toContain(`${FUNCTION}()`);
      expect((caught as Failure).where).toContain('RAISE');
    } else { expect((caught as Failure).constraint).not.toBe(GUARD); }
    expect(await snapshot(), `${label}: entire failed transaction rows/xmin preserved`).toEqual(before);
    facts.push({ label, observed: isEvidence ? 'EVIDENCE_GUARD_REFUSAL' : 'EXISTING_CONSTRAINT_REFUSAL',
      code: (caught as Failure).code, constraint: (caught as Failure).constraint, message: (caught as Failure).message,
      where: (caught as Failure).where, allPublicRowsAndXminUnchanged: true });
  }

  const guardError = { code: '42501', constraint: GUARD, message: MESSAGE };
  async function installEvidenceGuard() {
    const client = await db().owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE FUNCTION public.guard_migration_job_protected_evidence()
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
          ON public.migration_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_migration_job_protected_evidence()`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  beforeAll(async () => {
    beforeHashes = fileHashes();
    expect(readFileSync(ENTRY_SOURCE, 'utf8')).toContain(ENTRY_SQL);
    vi.stubGlobal('fetch', externalFetch);
    database = await createDisposablePostgres();
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner',
      networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true,
      droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(database.evidence.version).toMatch(/^17\./);
    expect(database.evidence.tmpfs).toEqual(['/test-bin', '/tmp', '/var/lib/postgresql/data', '/var/run/postgresql']);
    evidence.infrastructure = database.evidence;
    evidence.ownerIdentity = (await database.owner.query('SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid')).rows[0];
    expect(evidence.ownerIdentity).toMatchObject({ actor: 'postgres', login: 'postgres' });
    expect((await database.owner.query('SELECT * FROM public.tenants')).rows).toEqual([]);
    expect((await database.owner.query('SELECT * FROM public.migration_jobs')).rows).toEqual([]);
    const absent = await database.owner.query("SELECT to_regprocedure('public.guard_migration_job_protected_entry()') AS entry,to_regprocedure('public.guard_migration_job_protected_evidence()') AS evidence");
    expect(absent.rows).toEqual([{ entry: null, evidence: null }]);
    const initialCatalog = await catalog(true);
    await database.owner.query(`INSERT INTO public.tenants(id,slug,display_name,lifecycle) VALUES
      ($1,'evidence-guard-one','Synthetic Evidence One','DRAFT'),($2,'evidence-guard-two','Synthetic Evidence Two','DRAFT')`, [TENANT, FOREIGN]);
    for (const spec of specs) for (const phase of ['baseline', 'guarded'] as const) await seed(target(spec, phase), spec.initial);
    for (const status of statuses) {
      for (const name of ['exact', 'updated', 'offset', 'rollback-protected', 'historical']) {
        await seed(control(status, name), name === 'exact' ? { source_fingerprint: null } : {});
      }
      await seed(control(status, 'historical', FOREIGN));
      await seed(control('DISCOVERED', `rollback-safe-${status}`));
    }
    for (const tenant of [TENANT, FOREIGN]) await seed(control('DISCOVERED', 'sentinel', tenant));
    await seed(control('DISCOVERED', 'preparatory'));
    await seed(control('READY', 'preparatory'));
    await seed(control('FINAL_IMPORT', 'abort'));
    await seed(control('FINAL_IMPORT', 'exit-limitation'));
    const beforeEntry = await snapshot();
    await database.owner.query(ENTRY_SQL);
    expect(await snapshot()).toEqual(beforeEntry);
    expect(await catalog(true)).toEqual(initialCatalog);
    originalCatalog = await catalog(); // Retains the existing entry function + trigger.
    // Every hostile case first proves current SQL + entry-only really accepts it.
    // Independent donor pairs; no trigger disable, rollback repair or reused victims.
    for (const spec of specs) {
      await allowed(target(spec, 'baseline'), spec.patch, `BASELINE ${spec.status} ${spec.key}`, spec.spoof);
    }
    evidence.baselineCases = specs.map(spec => `${spec.status} ${spec.key}`);
    fixture = await snapshot();
    await installEvidenceGuard();
    expect(await snapshot()).toEqual(fixture);
    expect(await catalog()).toEqual(originalCatalog);
    evidence.installationPreservedRowsAclRolesOwnersPoliciesAndExistingObjects = true;
  }, 0);

  afterAll(async () => {
    try {
      if (database && originalCatalog) expect(await catalog()).toEqual(originalCatalog);
      if (database && fixture) {
        const after = await snapshot();
        for (const table of Object.keys(fixture).filter(name => name !== 'migration_jobs')) expect(after[table], table).toEqual(fixture[table]);
        const retained = (rows: Stored[]) => rows.filter(({ row }) => String(row.job_id).startsWith('historical-') || String(row.job_id).startsWith('sentinel-'));
        expect(retained(after.migration_jobs)).toEqual(retained(fixture.migration_jobs));
        for (const spec of specs) expect(ownRow(after, target(spec, 'guarded'))).toEqual(ownRow(fixture, target(spec, 'guarded')));
        evidence.originalAndGuardedRowsChildrenSentinelsAndDraftLifecyclesPreserved = true;
      }
    } finally {
      try {
        if (database) {
          evidence.cleanup = await database.close();
          expect(evidence.cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
        }
      } finally {
        vi.unstubAllGlobals();
        const afterHashes = fileHashes();
        evidence.sourceHashes = afterHashes;
        evidence.sourceFilesUnchanged = JSON.stringify(afterHashes) === JSON.stringify(beforeHashes);
        evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
        // JSON reporter suppresses intercepted console output; retain real safe
        // synthetic receipts on stdout without writing any additional files.
        process.stdout.write('LOCAL_PROTECTED_EVIDENCE_GUARD_PROTOTYPE ' + JSON.stringify({ ...evidence, facts }) + '\n');
        expect(afterHashes).toEqual(beforeHashes);
        expect(externalFetch).not.toHaveBeenCalled();
      }
    }
  }, 0);

  it('installs only a SECURITY INVOKER row BEFORE UPDATE evidence trigger; existing ACL/entry guard unchanged', async () => {
    const result = await db().owner.query(`SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,t.tgenabled,
      (t.tgtype::int & 1)=1 AS row_level,(t.tgtype::int & 2)=2 AS before_row,(t.tgtype::int & 4)=4 AS inserts,
      (t.tgtype::int & 16)=16 AS updates,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.migration_jobs'::regclass AND t.tgname=$1`, [GUARD]);
    expect(result.rows).toEqual([expect.objectContaining({ prosecdef: false, proconfig: ['search_path=pg_catalog'],
      owner: 'postgres', tgenabled: 'O', row_level: true, before_row: true, inserts: false, updates: true })]);
    expect(result.rows[0].definition).toContain('BEFORE UPDATE');
    evidence.candidateCatalog = result.rows[0];
  }, 0);

  for (const spec of specs) it(`rejects ${spec.status} ${spec.key} on an actual independent row after its committed baseline`, async () => {
    const t = target(spec, 'guarded');
    const original = ownRow(await snapshot(), t);
    let actualTargetRead = false;
    await denied(`${spec.status} ${spec.key}`, () => runtime(t.tenant, async client => {
      if (spec.spoof) await spoof(client, t.tenant);
      expect(await readTarget(client, t)).toEqual(original);
      actualTargetRead = true;
      const result = await mutate(client, t, spec.patch);
      facts.push({ label: `${spec.status} ${spec.key}`, observed: 'UNGUARDED_UPDATE_RETURNED', row: result.row });
      return result;
    }), guardError);
    expect(actualTargetRead).toBe(true);
    expect(await runtime(t.tenant, client => readTarget(client, t))).toEqual(original);
  }, 0);

  for (const status of statuses) {
    it(`allows ${status} full exact retry including NULL and keeps evidence identical`, async () => {
      const t = control(status, 'exact');
      const original = ownRow(await snapshot(), t);
      const patch = Object.fromEntries(Object.entries(original.row).map(([key, value]) => [key, value === null ? null : String(value)])) as Patch;
      const saved = await allowed(t, patch, `${status} full exact retry`);
      expect(saved.row).toEqual(original.row);
      expect(saved.row.source_fingerprint).toBeNull();
    }, 0);

    it(`allows ${status} updated_at-only commit without changing evidence`, async () => {
      await allowed(control(status, 'updated'), { updated_at: at('41') }, `${status} updated_at only`);
    }, 0);

    it(`allows ${status} same-instant offset equality without millisecond normalization`, async () => {
      const t = control(status, 'offset');
      const original = ownRow(await snapshot(), t);
      const saved = await allowed(t, { freeze_verified_at: '2026-08-01T09:20:00.123456+09:00' }, `${status} same instant offset`);
      expect(saved.row).toEqual(original.row);
      const microSpec = specs.find(spec => spec.status === status && spec.key === 'verified-microsecond')!;
      const baseline = ownRow(await snapshot(), target(microSpec, 'baseline'));
      const comparison = (await db().owner.query(`SELECT $1::timestamptz IS DISTINCT FROM $2::timestamptz AS distinct_instants,
        $2::timestamptz-$1::timestamptz=interval '1 microsecond' AS one_microsecond`,
      [saved.row.freeze_verified_at, baseline.row.freeze_verified_at])).rows[0];
      expect(comparison).toEqual({ distinct_instants: true, one_microsecond: true });
      facts.push({ label: `${status} precision`, storedOriginal: saved.row.freeze_verified_at,
        storedBaselineRewrite: baseline.row.freeze_verified_at, ...comparison });
    }, 0);

    it(`rolls back a witnessed preparatory UPDATE when ${status} evidence mutation is refused`, async () => {
      const safe = control('DISCOVERED', `rollback-safe-${status}`);
      const t = control(status, 'rollback-protected');
      const initial = await snapshot();
      let witnessed = false;
      await denied(`${status} full rollback after actual write`, () => runtime(TENANT, async client => {
        const changed = await mutate(client, safe, { status: 'VALIDATED', state_version: '8', updated_at: at('41') });
        expect(changed.row).toEqual({ ...ownRow(initial, safe).row, status: 'VALIDATED', state_version: 8, updated_at: at('41') });
        expect(await readTarget(client, safe)).toEqual(changed);
        expect(ownRow(await snapshot(), safe)).toEqual(ownRow(initial, safe)); // Owner cannot see the uncommitted write.
        witnessed = true;
        expect(await readTarget(client, t)).toEqual(ownRow(initial, t));
        return mutate(client, t, { source_fingerprint: REWRITE });
      }), guardError);
      expect(witnessed).toBe(true);
      evidence[`${status}_rollbackWitness`] = { returning: true, sameTransactionRead: true, invisibleToOwnerBeforeRollback: true, allRowsAndXminRestored: true };
    }, 0);
  }

  it('preserves synthetic DISCOVERED->VALIDATED preparatory writes', async () => {
    await allowed(control('DISCOVERED', 'preparatory'), { status: 'VALIDATED', state_version: '8', updated_at: at('41') }, 'preparatory VALIDATED');
  }, 0);
  it('preserves synthetic READY->FREEZING with freeze_started_at', async () => {
    await allowed(control('READY', 'preparatory'), { status: 'FREEZING', state_version: '8', freeze_started_at: at('10'), updated_at: at('41') }, 'preparatory FREEZING');
  }, 0);
  it('preserves synthetic FINAL_IMPORT->ABORTED with completion', async () => {
    await allowed(control('FINAL_IMPORT', 'abort'), { status: 'ABORTED', state_version: '8', completed_at: at('30'), updated_at: at('41') }, 'allowed abort; not actor authorization');
  }, 0);
  it('labels exit-plus-evidence-rewrite as a remaining limitation, not guard coverage', async () => {
    await allowed(control('FINAL_IMPORT', 'exit-limitation'), { status: 'ABORTED', state_version: '8', source_fingerprint: REWRITE,
      completed_at: at('30'), updated_at: at('41') }, 'LIMITATION: status exit can still change evidence');
  }, 0);

  it('keeps version-only P0001 separate from evidence refusal', async () => {
    const t = control('ACTIVE', 'historical');
    await denied('version-only', () => runtime(TENANT, client => mutate(client, t, { state_version: '8' })),
      { code: 'P0001', message: 'state_version may change only with status' }, false);
  }, 0);
  it('keeps nonprotected hash CHECK separate from evidence refusal', async () => {
    const t = control('DISCOVERED', 'sentinel');
    await denied('hash shape', () => runtime(TENANT, client => mutate(client, t, { source_fingerprint: 'not-a-hash' })),
      { code: '23514', constraint: 'migration_jobs_hashes_check' }, false);
  }, 0);
  it('labels mismatched tenant GUC zero-row UPDATE as RLS visibility, never a guard pass', async () => {
    const t = control('ACTIVE', 'historical', FOREIGN);
    const before = await snapshot();
    expect(ownRow(before, t).row.status).toBe('ACTIVE');
    const result = await runtime(TENANT, client => client.query(`UPDATE public.migration_jobs SET source_fingerprint=$3
      WHERE tenant_id=$1 AND job_id=$2 RETURNING job_id`, [FOREIGN, t.id, REWRITE]));
    expect(result.rowCount).toBe(0);
    expect(result.rows).toEqual([]);
    expect(await snapshot()).toEqual(before);
    facts.push({ label: 'wrong GUC existing foreign target', observed: 'ZERO_ROWS_RLS_NOT_EVIDENCE_GUARD_PROOF' });
  }, 0);
});
