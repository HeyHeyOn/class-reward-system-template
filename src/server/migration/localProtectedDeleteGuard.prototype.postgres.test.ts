// @vitest-environment node
// SYNTHETIC PG17 / NONAUTHORITY / NOT DEPLOYED / NOT Task19/23 acceptance.
// RUN_REAL_POSTGRES=1 ./node_modules/.bin/vitest run src/server/migration/localProtectedDeleteGuard.prototype.postgres.test.ts --maxWorkers=1
// Scope: OLD-status BEFORE DELETE + unconditional statement BEFORE TRUNCATE, atop
// all current migrations and exact SQL literals from the entry/evidence/exit tests.
// No other test module is imported. Only the unchanged harness provisions test ACLs.
// DRAFT cleanup is raw SQL under existing runtime privileges, NOT authenticated approval.
// Owner-only TRUNCATE probes do NOT establish runtime TRUNCATE privilege.
// Omitted: operational ACL/authentication, external writer exclusion, deployment,
// real cutover/cleanup services, full ACTIVE repository regression, concurrent races,
// bulk/mixed-status deletion, terminal parent CASCADE, all retained evidence types,
// candidate TRUNCATE on empty jobs, pure tenants-first TRUNCATE error ordering,
// ENABLE ALWAYS/replica/owner/DDL/partition/SET ROLE bypasses, historical provenance.
// Infrastructure/approval failure fails the opt-in run; no fallback or denied-operation retry.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';

vi.mock('server-only', () => ({}));

const SELF = 'src/server/migration/localProtectedDeleteGuard.prototype.postgres.test.ts';
const PRIOR = ['Entry', 'Evidence', 'Exit'].map(kind => ({
  path: `src/server/migration/localProtected${kind}Guard.prototype.postgres.test.ts`,
  fn: `guard_migration_job_protected_${kind.toLowerCase()}`,
  trigger: `migration_jobs_protected_${kind.toLowerCase()}_guard`,
}));
const DELETE_GUARD = 'migration_jobs_protected_delete_guard';
const TRUNCATE_GUARD = 'migration_jobs_protected_truncate_guard';
const DELETE_FN = 'guard_migration_job_protected_delete';
const TRUNCATE_FN = 'guard_migration_job_protected_truncate';
const DELETE_MESSAGE = 'Prototype protected migration job deletion refused.';
const TRUNCATE_MESSAGE = 'Prototype migration jobs truncation refused.';
const MAIN = '20000000-0000-4000-8000-000000000101';
const FOREIGN = '20000000-0000-4000-8000-000000000102';
const STATUSES = ['FINAL_IMPORT', 'ACTIVE', 'ABORTED', 'FAILED'] as const;
type Status = typeof STATUSES[number] | 'DISCOVERED';
type Branch = { tenant: string; job: string; status: Status };
type Stored = { row: Record<string, unknown>; xmin: string };
type State = Record<string, Stored[]>;
type Failure = { code?: string; constraint?: string; message?: string; detail?: string; where?: string; schema?: string; table?: string };
const make = (job: string, status: Status, tenant = MAIN): Branch => ({ job, status, tenant });
const baselineDirect = STATUSES.map(status => make(`baseline-${status}`, status));
const protectedDirect = STATUSES.map(status => make(`guarded-${status}`, status));
const baselineCascade = (['FINAL_IMPORT', 'ACTIVE'] as const).map(status => make(`baseline-parent-${status}`, status, randomUUID()));
const protectedCascade = (['FINAL_IMPORT', 'ACTIVE'] as const).map(status => make(`guarded-parent-${status}`, status, randomUUID()));
const cleanDirect = make('cleanup-direct', 'DISCOVERED');
const cleanParent = make('cleanup-parent', 'DISCOVERED', randomUUID());
const retained = make('retained-snapshot', 'DISCOVERED', randomUUID());
const foreign = make('foreign-sentinel', 'ACTIVE', FOREIGN);
const abortThenDelete = make('normal-abort', 'FINAL_IMPORT');
const witness = (tenant: string) => make('preparatory-witness', 'DISCOVERED', tenant);
const branches = [...baselineDirect, ...protectedDirect, ...baselineCascade, ...protectedCascade,
  cleanDirect, cleanParent, retained, foreign, abortThenDelete,
  ...[...baselineCascade, ...protectedCascade].map(({ tenant }) => witness(tenant))];
const watched = ['.git/index', SELF, 'AGENTS.md', 'package.json', 'vitest.config.mts', 'tsconfig.json',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c', 'src/server/db/testing/pglite.ts',
  'src/server/migration/cutover.ts', 'src/server/migration/localProtectedJobEvidenceMutation.test.ts',
  'src/server/migration/localProtectedJobInsert.postgres.test.ts', ...PRIOR.map(p => p.path),
  ...['delete', 'exit', 'evidence', 'insert'].map(kind => `/home/haeon/workhub-tasks/live/class-store-supervision/secondbot-protected-${kind}${kind === 'insert' ? '-guard' : ''}-audit-20260926.md`),
  ...readdirSync('src/server/db/migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort().map(name => join('src/server/db/migrations', name))];
const hashes = () => Object.fromEntries(watched.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));

// Read precisely one existing, uninterpolated SQL literal; fail rather than silently
// adapting a changed prior prototype. Never evaluate TypeScript or import its tests.
function priorSql({ path, fn }: typeof PRIOR[number]) {
  const text = readFileSync(path, 'utf8');
  const start = `CREATE FUNCTION public.${fn}()`;
  expect(text.split(start)).toHaveLength(2);
  const from = text.indexOf(start);
  const end = text.indexOf('`);', from);
  expect(end).toBeGreaterThan(from);
  const sql = text.slice(from, end);
  expect(sql).not.toContain('${');
  expect(sql).toContain('SECURITY INVOKER SET search_path = pg_catalog');
  expect(sql).toContain(`EXECUTE FUNCTION public.${fn}()`);
  return sql;
}

describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('synthetic PG17 protected deletion guard prototype', () => {
  let database: DisposablePostgres | undefined;
  let sourceBefore: ReturnType<typeof hashes> | undefined;
  let priorCatalog: Awaited<ReturnType<typeof catalog>> | undefined;
  let fixture: State | undefined;
  let ownerPid: number;
  const facts: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = { authority: 'NONAUTHORITY', deployed: false,
    task19Accepted: false, task23Accepted: false, externalWriterExclusion: 'NOT_PROVEN',
    callerAuthentication: 'NOT_TESTED', operationalAcl: 'NOT_TESTED',
    connection: 'SEPARATE_NONOWNER_LOGIN_OWNED_TRUST_SOCKET_NOT_PRODUCTION_AUTH' };
  const externalFetch = vi.fn(async () => { throw Error('External fetch forbidden in synthetic deletion test'); });
  const db = () => { if (!database) throw Error('Owned PG17 setup incomplete'); return database; };

  async function snapshot(): Promise<State> {
    const tables = (await db().owner.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const result: State = {};
    for (const { tablename } of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw Error('Unexpected synthetic relation');
      result[tablename] = (await db().owner.query<Stored>(`SELECT to_jsonb(t) AS row,xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }
  async function catalog(excludePrior = false) {
    const fns = [DELETE_FN, TRUNCATE_FN, ...(excludePrior ? PRIOR.map(p => p.fn) : [])];
    const triggers = [DELETE_GUARD, TRUNCATE_GUARD, ...(excludePrior ? PRIOR.map(p => p.trigger) : [])];
    return {
      roles: (await db().owner.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows,
      memberships: (await db().owner.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
      relations: (await db().owner.query("SELECT relname,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows,
      columns: (await db().owner.query("SELECT attrelid::regclass::text AS relation,attname,attacl::text FROM pg_attribute WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY relation,attnum")).rows,
      policies: (await db().owner.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
      functions: (await db().owner.query(`SELECT oid::regprocedure::text AS signature,proowner::text,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) AS definition
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND NOT (proname=ANY($1::text[])) ORDER BY signature`, [fns])).rows,
      triggers: (await db().owner.query(`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
        AND NOT (tgname=ANY($1::text[])) ORDER BY relation,tgname`, [triggers])).rows,
      constraints: (await db().owner.query("SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname,contype")).rows,
    };
  }
  async function transaction<T>(actor: 'runtime' | 'owner', tenant: string, action: (client: PoolClient, xid: string) => Promise<T>) {
    const client = await db()[actor].connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      const identity = (await client.query(`SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid,
        pg_current_xact_id()::text AS xid,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
        has_table_privilege(current_user,c.oid,'TRUNCATE') AS can_truncate,
        has_table_privilege(current_user,'public.tenants','DELETE') AS can_delete_parent
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows[0];
      if (actor === 'runtime') {
        expect(identity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', rolsuper: false, rolbypassrls: false,
          rolcanlogin: true, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
          relrowsecurity: true, relforcerowsecurity: true, can_delete: true, can_truncate: false, can_delete_parent: true });
        expect(identity.owner).not.toBe('app_runtime');
        expect(identity.pid).not.toBe(ownerPid);
        evidence.runtimeIdentity = identity;
      } else expect(identity).toMatchObject({ actor: 'postgres', login: 'postgres', can_truncate: true });
      expect(identity.xid).toMatch(/^\d+$/);
      const value = await action(client, identity.xid as string);
      await client.query('COMMIT');
      return { value, xid: identity.xid as string };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function visible(client: PoolClient, b: Branch) {
    const parents = await client.query('SELECT id,lifecycle FROM public.tenants WHERE id=$1', [b.tenant]);
    expect(parents.rows).toEqual([{ id: b.tenant, lifecycle: 'DRAFT' }]);
    const jobs = await client.query<Stored>('SELECT to_jsonb(j) AS row,xmin::text FROM public.migration_jobs j WHERE tenant_id=$1 AND job_id=$2', [b.tenant, b.job]);
    expect(jobs.rowCount, `actual job ${b.job}`).toBe(1);
    expect(jobs.rows[0].row.status).toBe(b.status);
    const children = await client.query('SELECT source_id FROM public.migration_sources WHERE tenant_id=$1 AND job_id=$2', [b.tenant, b.job]);
    expect(children.rows).toEqual([{ source_id: `source-${b.job}` }]);
    return jobs.rows[0];
  }
  async function remove(client: PoolClient, b: Branch, parent: boolean) {
    await visible(client, b);
    return parent
      ? client.query('DELETE FROM public.tenants WHERE id=$1 RETURNING id', [b.tenant])
      : client.query('DELETE FROM public.migration_jobs WHERE tenant_id=$1 AND job_id=$2 RETURNING tenant_id,job_id,status', [b.tenant, b.job]);
  }
  async function allowedDelete(b: Branch, parent: boolean, phase: string) {
    const before = await snapshot();
    const result = await transaction('runtime', b.tenant, client => remove(client, b, parent));
    expect(result.value.rowCount).toBe(1);
    expect(result.value.rows).toEqual(parent ? [{ id: b.tenant }] : [{ tenant_id: b.tenant, job_id: b.job, status: b.status }]);
    const after = await snapshot();
    // Only the exact tenant branch (or job+source) may disappear. Compare every
    // public table and surviving row/xmin, not only the targeted job count.
    const expected = Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows.filter(({ row }) => {
      if (parent) return table === 'tenants' ? row.id !== b.tenant : row.tenant_id !== b.tenant;
      return !(['migration_jobs', 'migration_sources'].includes(table) && row.tenant_id === b.tenant && row.job_id === b.job);
    })]));
    expect(after).toEqual(expected);
    await transaction('runtime', b.tenant, async client => {
      expect((await client.query('SELECT job_id FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [b.tenant, b.job])).rows).toEqual([]);
      expect((await client.query('SELECT source_id FROM migration_sources WHERE tenant_id=$1 AND job_id=$2', [b.tenant, b.job])).rows).toEqual([]);
      expect((await client.query('SELECT id FROM tenants WHERE id=$1', [b.tenant])).rows).toEqual(parent ? [] : [{ id: b.tenant }]);
    });
    facts.push({ phase, job: b.job, status: b.status, parent, xid: result.xid, returned: result.value.rows,
      observed: 'COMMITTED_DELETE_OWNER_AND_RUNTIME_READBACK', otherRowsAndXminUnchanged: true });
  }
  async function denied(label: string, action: () => Promise<unknown>, expected: Failure, candidate?: 'DELETE' | 'TRUNCATE') {
    const before = await snapshot();
    let caught: Failure | undefined;
    try { await action(); } catch (error) { caught = error as Failure; }
    const after = await snapshot();
    facts.push({ label, code: caught?.code, constraint: caught?.constraint, message: caught?.message,
      detail: caught?.detail, where: caught?.where, observed: caught ? 'SQL_REFUSAL' : 'UNEXPECTED_COMMIT',
      allRowsAndXminUnchanged: JSON.stringify(after) === JSON.stringify(before) });
    expect(caught, `${label}: a successful or zero-row command is not guard refusal`).toMatchObject(expected);
    if (candidate) {
      expect(caught).toMatchObject({ schema: 'public', table: 'migration_jobs',
        message: candidate === 'DELETE' ? DELETE_MESSAGE : TRUNCATE_MESSAGE });
      expect(caught?.where).toContain(`${candidate === 'DELETE' ? DELETE_FN : TRUNCATE_FN}()`);
      expect(caught?.where).toContain('RAISE');
      const detail = JSON.parse(caught!.detail!) as { operation: string; actor: string; login: string; depth: number };
      expect(detail.operation).toBe(candidate);
      expect(detail.depth).toBeGreaterThanOrEqual(1);
    } else {
      expect(caught?.constraint).not.toBe(DELETE_GUARD);
      expect(caught?.constraint).not.toBe(TRUNCATE_GUARD);
    }
    expect(after, `${label}: full transaction rollback`).toEqual(before);
    return caught!;
  }
  async function installCandidate() {
    // Additive test-only objects in the exact fresh database. No role/ACL changes,
    // trigger disabling, actor/depth exceptions, or conditionally allowed TRUNCATE.
    const client = await db().owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE FUNCTION public.guard_migration_job_protected_delete()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
        BEGIN
          IF OLD.status IN ('FINAL_IMPORT','ACTIVE','ABORTED','FAILED') THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
              MESSAGE = 'Prototype protected migration job deletion refused.',
              SCHEMA = 'public', TABLE = 'migration_jobs',
              CONSTRAINT = 'migration_jobs_protected_delete_guard',
              DETAIL = json_build_object('operation',TG_OP,'actor',current_user,
                'login',session_user,'depth',pg_trigger_depth())::text;
          END IF;
          RETURN OLD;
        END;
        $$;
        CREATE TRIGGER migration_jobs_protected_delete_guard BEFORE DELETE
          ON public.migration_jobs FOR EACH ROW EXECUTE FUNCTION public.guard_migration_job_protected_delete();
        CREATE FUNCTION public.guard_migration_job_protected_truncate()
        RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
        BEGIN
          RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'Prototype migration jobs truncation refused.',
            SCHEMA = 'public', TABLE = 'migration_jobs',
            CONSTRAINT = 'migration_jobs_protected_truncate_guard',
            DETAIL = json_build_object('operation',TG_OP,'actor',current_user,
              'login',session_user,'depth',pg_trigger_depth())::text;
        END;
        $$;
        CREATE TRIGGER migration_jobs_protected_truncate_guard BEFORE TRUNCATE
          ON public.migration_jobs FOR EACH STATEMENT EXECUTE FUNCTION public.guard_migration_job_protected_truncate()`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  beforeAll(async () => {
    sourceBefore = hashes();
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
    evidence.ownerIdentity = owner;
    expect((await database.owner.query('SELECT * FROM migration_jobs')).rows).toEqual([]);
    expect((await database.owner.query('SELECT * FROM tenants')).rows).toEqual([]);
    // No privileged success is fabricated: empty snapshots still reject TRUNCATE.
    await denied('baseline empty snapshot TRUNCATE', () => transaction('owner', MAIN,
      client => client.query('TRUNCATE public.migration_snapshots,public.migration_jobs CASCADE')),
    { code: 'P0001', message: 'migration_snapshots is immutable' });
    const existing = await catalog(true);
    // Historical protected fixtures precede all entry guards. No trigger disabling.
    for (const tenant of new Set(branches.map(b => b.tenant))) await database.owner.query(
      "INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Synthetic deletion fixture','DRAFT')", [tenant, `delete-${tenant}`]);
    for (const b of branches) {
      await database.owner.query(`INSERT INTO migration_jobs(tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
        created_at,freeze_started_at,freeze_verified_at,completed_at,updated_at)
        VALUES($1,$2,$3,7,repeat('a',64),repeat('b',64),'2026-08-01T00:00:00Z','2026-08-01T00:10:00Z','2026-08-01T00:20:00Z',
          CASE WHEN $3 IN ('ACTIVE','ABORTED','FAILED') THEN '2026-08-01T00:30:00Z'::timestamptz ELSE NULL END,'2026-08-01T00:40:00Z')`,
      [b.tenant, b.job, b.status]);
      await database.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
        VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,repeat('a',64))`, [b.tenant, b.job, `source-${b.job}`, `${b.tenant}/${b.job}`]);
    }
    await database.owner.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      VALUES($1,$2,$3,'retained-original','PREFLIGHT',repeat('c',64),'{"synthetic":true}',0)`,
    [retained.tenant, retained.job, `source-${retained.job}`]);
    const seeded = await snapshot();
    for (const prior of PRIOR) await database.owner.query(priorSql(prior));
    expect(await snapshot()).toEqual(seeded);
    expect(await catalog(true)).toEqual(existing);
    priorCatalog = await catalog();
    expect((await database.owner.query('SELECT tgname FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname', [PRIOR.map(p => p.trigger)])).rows)
      .toEqual(PRIOR.map(p => ({ tgname: p.trigger })).sort((a, b) => a.tgname.localeCompare(b.tgname)));
    // No retained child evidence belongs to a baseline donor; source is mutable.
    expect(seeded.migration_snapshots).toHaveLength(1);
    expect(seeded.audit_events).toEqual([]);
    expect(seeded.migration_authority_receipts).toEqual([]);
    expect(seeded.migration_final_generations).toEqual([]);
    for (const b of baselineDirect) await allowedDelete(b, false, 'BASELINE_WITH_ALL_PRIOR_PROTOTYPES');
    for (const b of baselineCascade) await allowedDelete(b, true, 'BASELINE_WITH_ALL_PRIOR_PROTOTYPES');
    await denied('baseline runtime TRUNCATE permission', () => transaction('runtime', MAIN,
      client => client.query('TRUNCATE public.migration_jobs CASCADE')), { code: '42501', message: 'permission denied for table migration_jobs' });
    await denied('baseline owner TRUNCATE RESTRICT FK', () => transaction('owner', MAIN,
      client => client.query('TRUNCATE public.migration_jobs')), { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' });
    await denied('baseline old snapshot TRUNCATE with retained rows', () => transaction('owner', MAIN,
      client => client.query('TRUNCATE public.migration_snapshots,public.migration_jobs CASCADE')),
    { code: 'P0001', message: 'migration_snapshots is immutable' });
    evidence.baselineCompletedUnderAllPriorPrototypes = true;
    fixture = await snapshot();
    await installCandidate();
    expect(await snapshot()).toEqual(fixture);
    expect(await catalog()).toEqual(priorCatalog);
  }, 0);

  afterAll(async () => {
    try {
      if (database && priorCatalog) expect(await catalog()).toEqual(priorCatalog);
      if (database && fixture) {
        const after = await snapshot();
        for (const table of Object.keys(fixture)) {
          const retainedRows = (rows: Stored[]) => rows.filter(({ row }) => table === 'tenants'
            ? [FOREIGN, retained.tenant].includes(String(row.id)) : [FOREIGN, retained.tenant].includes(String(row.tenant_id)));
          expect(retainedRows(after[table]), `${table} immutable/foreign sentinel`).toEqual(retainedRows(fixture[table]));
        }
        evidence.retainedEvidenceAndForeignRowsAndXminUnchanged = true;
      }
    } finally {
      try {
        if (database) {
          evidence.cleanup = await database.close();
          expect(evidence.cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
        }
      } finally {
        vi.unstubAllGlobals();
        const after = hashes();
        evidence.sourceHashes = after;
        evidence.sourceFilesUnchanged = JSON.stringify(after) === JSON.stringify(sourceBefore);
        evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
        process.stdout.write('LOCAL_PROTECTED_DELETE_GUARD_PROTOTYPE ' + JSON.stringify({ ...evidence, facts }) + '\n');
        expect(after).toEqual(sourceBefore);
        expect(externalFetch).not.toHaveBeenCalled();
      }
    }
  }, 0);

  it('adds only SECURITY INVOKER BEFORE DELETE row and BEFORE TRUNCATE statement candidates', async () => {
    expect(evidence.baselineCompletedUnderAllPriorPrototypes).toBe(true);
    const rows = (await db().owner.query(`SELECT t.tgname,t.tgtype::int AS kind,t.tgenabled,t.tgdeferrable,t.tginitdeferred,
      p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.migration_jobs'::regclass AND t.tgname=ANY($1::text[]) ORDER BY t.tgname`,
    [[DELETE_GUARD, TRUNCATE_GUARD]])).rows;
    expect(rows).toEqual([expect.objectContaining({ tgname: DELETE_GUARD, kind: 11 }), expect.objectContaining({ tgname: TRUNCATE_GUARD, kind: 34 })]);
    for (const row of rows) expect(row).toMatchObject({ prosecdef: false, proconfig: ['search_path=pg_catalog'], owner: 'postgres', tgenabled: 'O', tgdeferrable: false, tginitdeferred: false });
    expect(rows[0].definition).toContain('BEFORE DELETE');
    expect(rows[1].definition).toContain('BEFORE TRUNCATE');
    evidence.candidateCatalog = rows;
  }, 0);

  for (const b of protectedDirect) it(`rejects actual runtime ${b.status} DELETE with candidate-specific evidence`, async () => {
    const error = await denied(`direct ${b.status}`, () => transaction('runtime', b.tenant, client => remove(client, b, false)),
      { code: '42501', constraint: DELETE_GUARD }, 'DELETE');
    expect(JSON.parse(error.detail!)).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', depth: 1 });
    await transaction('runtime', b.tenant, client => visible(client, b));
  }, 0);

  for (const b of protectedCascade) it(`rolls back witnessed update and tenant CASCADE into ${b.status}`, async () => {
    const before = await snapshot();
    let witnessed = false;
    const error = await denied(`parent CASCADE ${b.status}`, () => transaction('runtime', b.tenant, async client => {
      const w = witness(b.tenant);
      await visible(client, w);
      const changed = await client.query(`UPDATE migration_jobs SET status='VALIDATED',state_version=state_version+1,updated_at=now()
        WHERE tenant_id=$1 AND job_id=$2 RETURNING job_id,status,state_version::text`, [w.tenant, w.job]);
      expect(changed.rows).toEqual([{ job_id: w.job, status: 'VALIDATED', state_version: '8' }]);
      expect((await client.query('SELECT status FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [w.tenant, w.job])).rows).toEqual([{ status: 'VALIDATED' }]);
      expect(await snapshot()).toEqual(before);
      witnessed = true;
      return remove(client, b, true);
    }), { code: '42501', constraint: DELETE_GUARD }, 'DELETE');
    expect(witnessed).toBe(true);
    const detail = JSON.parse(error.detail!);
    expect(detail).toMatchObject({ actor: 'postgres', login: 'app_runtime' });
    expect(detail.depth).toBeGreaterThan(1);
    await transaction('runtime', b.tenant, async client => { await visible(client, b); await visible(client, witness(b.tenant)); });
    facts.push({ label: `parent rollback ${b.status}`, updateReturningAndReadWitness: true, ownerSawUncommittedOriginal: true, fullRollback: true });
  }, 0);

  it('allows normal ABORT commit then refuses ABORTED deletion in a distinct runtime transaction', async () => {
    const b = abortThenDelete;
    const before = await snapshot();
    const aborted = await transaction('runtime', b.tenant, async client => {
      await visible(client, b);
      const changed = await client.query(`UPDATE migration_jobs SET status='ABORTED',state_version=state_version+1,completed_at=now(),updated_at=now()
        WHERE tenant_id=$1 AND job_id=$2 RETURNING to_jsonb(migration_jobs) AS row,xmin::text`, [b.tenant, b.job]);
      expect(changed.rowCount).toBe(1);
      expect(changed.rows[0].row).toMatchObject({ status: 'ABORTED', state_version: 8, source_fingerprint: 'a'.repeat(64) });
      expect(changed.rows[0].row.completed_at).toEqual(changed.rows[0].row.updated_at);
      expect(typeof changed.rows[0].row.completed_at).toBe('string');
      return changed.rows[0] as Stored;
    });
    const after = await snapshot();
    const expected = { ...before, migration_jobs: before.migration_jobs.map(row => row.row.tenant_id === b.tenant && row.row.job_id === b.job ? aborted.value : row) };
    expect(after).toEqual(expected);
    await transaction('runtime', b.tenant, async client => expect(await visible(client, { ...b, status: 'ABORTED' })).toEqual(aborted.value));
    let refusedXid: string | undefined;
    await denied('delete after committed ABORT', () => transaction('runtime', b.tenant, (client, xid) => {
      refusedXid = xid;
      expect(xid).not.toBe(aborted.xid);
      return remove(client, { ...b, status: 'ABORTED' }, false);
    }), { code: '42501', constraint: DELETE_GUARD }, 'DELETE');
    expect(refusedXid).toMatch(/^\d+$/);
    facts.push({ label: 'ABORT_THEN_DELETE', abortXid: aborted.xid, refusedXid, abortCommittedAndReadBack: true });
  }, 0);

  it('preserves existing runtime-permitted DRAFT job cleanup, not caller authentication', async () => {
    await allowedDelete(cleanDirect, false, 'DRAFT_SQL_CLEANUP_NOT_AUTHENTICATED_SERVICE');
  }, 0);
  it('preserves DRAFT parent cleanup and mutable child cascade without widening ACLs', async () => {
    await allowedDelete(cleanParent, true, 'DRAFT_SQL_CLEANUP_NOT_AUTHENTICATED_SERVICE');
  }, 0);

  for (const parent of [false, true]) it(`retains old snapshot immutable refusal for DRAFT ${parent ? 'parent CASCADE' : 'job DELETE'}`, async () => {
    const error = await denied(`existing snapshot ${parent ? 'parent' : 'job'}`, () => transaction('runtime', retained.tenant,
      client => remove(client, retained, parent)), { code: 'P0001', message: 'migration_snapshots is immutable' });
    expect(error.where).toContain('reject_immutable_row()');
    await transaction('runtime', retained.tenant, client => visible(client, retained));
  }, 0);

  it('separates RLS zero-row probes from a visible foreign target guard refusal', async () => {
    const before = await snapshot();
    expect(before.migration_jobs.filter(r => r.row.tenant_id === FOREIGN && r.row.job_id === foreign.job)).toHaveLength(1);
    for (const tenant of [MAIN, '']) await transaction('runtime', tenant, async client => {
      const result = await client.query('DELETE FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2 RETURNING job_id', [FOREIGN, foreign.job]);
      expect(result.rowCount).toBe(0);
      expect(result.rows).toEqual([]);
      facts.push({ label: 'RLS_ONLY_NOT_CANDIDATE_PASS', context: tenant || 'MISSING', actualForeignTarget: true, rowCount: result.rowCount });
    });
    expect(await snapshot()).toEqual(before);
    // Setting another tenant's GUC makes the row visible; it is not authority.
    await denied('foreign GUC with actual row', () => transaction('runtime', FOREIGN, client => remove(client, foreign, false)),
      { code: '42501', constraint: DELETE_GUARD }, 'DELETE');
    await transaction('runtime', FOREIGN, client => visible(client, foreign));
  }, 0);

  it('keeps runtime TRUNCATE privilege denial and owner RESTRICT FK refusal distinct after installation', async () => {
    await denied('runtime TRUNCATE permission after candidate', () => transaction('runtime', MAIN,
      client => client.query('TRUNCATE migration_jobs CASCADE')), { code: '42501', message: 'permission denied for table migration_jobs' });
    await denied('owner TRUNCATE RESTRICT after candidate', () => transaction('owner', MAIN,
      client => client.query('TRUNCATE migration_jobs')), { code: '0A000', message: 'cannot truncate a table referenced in a foreign key constraint' });
  }, 0);
  it('observes unique owner TRUNCATE guard before descendant guards without granting runtime TRUNCATE', async () => {
    const error = await denied('root jobs TRUNCATE CASCADE', () => transaction('owner', '',
      client => client.query('TRUNCATE public.migration_jobs CASCADE')), { code: '42501', constraint: TRUNCATE_GUARD }, 'TRUNCATE');
    expect(JSON.parse(error.detail!)).toMatchObject({ actor: 'postgres', login: 'postgres', operation: 'TRUNCATE' });
  }, 0);
  it('distinguishes the old snapshot-first refusal from the candidate jobs-first tenant closure', async () => {
    await denied('snapshot-first TRUNCATE remains old refusal', () => transaction('owner', MAIN,
      client => client.query('TRUNCATE public.migration_snapshots,public.migration_jobs CASCADE')),
    { code: 'P0001', message: 'migration_snapshots is immutable' });
    await denied('jobs-first tenant TRUNCATE closure', () => transaction('owner', MAIN,
      client => client.query('TRUNCATE public.migration_jobs,public.tenants CASCADE')),
    { code: '42501', constraint: TRUNCATE_GUARD }, 'TRUNCATE');
  }, 0);
});
