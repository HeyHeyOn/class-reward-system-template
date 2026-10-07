// @vitest-environment node
// SYNTHETIC PG17 / NONAUTHORITY / NO PERMANENT MIGRATION / NOT Task19/23 acceptance.
// ONLY readiness-audit section 8 case 1: middle Exit name collision rolls back DDL.
// Cases 2/3 (waiting writer + COMMIT/ROLLBACK), writer-first races, runtime DDL/ACL,
// replica/owner governance, migration ledger/retry, restore, auth and operational
// writer exclusion are NOT_TESTED. No service/cutover/Sheet/Redis/operational DB.
// Existing PostgreSQL behavior characterization, not a new production TDD RED/GREEN.
// Exact prototype source bytes are pinned; only SQL literals are read, never test
// import/eval. Historical fixtures and unattached sentinel precede installation.
// No trigger disabling, CREATE OR REPLACE, grants, owner changes or guard relaxation.
// Installer/observer are distinct owner backends; runtime performs readback only.
// Row/xmin preservation is not sequence/OID-counter rollback or concurrency proof.
// No added test/hook wall-clock budget; existing harness per-I/O bounds unchanged.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from './testing/disposablePostgres';

vi.mock('server-only', () => ({}));
const SELF = 'src/server/db/localFourGuardInstallAtomicity.postgres.test.ts';
const PROTOTYPES = [
  ['Entry', '2474310608c3d9d03728ba09e43b9c1d2ddde6cfc157d1243b4d1d51d2132a0d'],
  ['Evidence', 'a6ab9bd656aaac19992114c1d70e0d74175d77e0100f859f0e79e41ed066a267'],
  ['Exit', 'fb2ee8ebffacd91ccc4a96c6c157fcb2246eca2283db92ffb1794d0fc3dc0c51'],
  ['Delete', '89abed47eed3b3a706ee323824f9dfdfe1cd39967bcdf257e52e44709d13b8ea'],
].map(([kind, digest]) => ({ kind, digest, path: `src/server/migration/localProtected${kind}Guard.prototype.postgres.test.ts` }));
const CANDIDATES = [
  ['entry', 'BEFORE INSERT OR UPDATE', 'ROW'], ['evidence', 'BEFORE UPDATE', 'ROW'],
  ['exit', 'AFTER UPDATE', 'ROW'], ['delete', 'BEFORE DELETE', 'ROW'], ['truncate', 'BEFORE TRUNCATE', 'STATEMENT'],
].map(([kind, timing, level]) => ({ kind, timing, level, fn: `guard_migration_job_protected_${kind}`,
  trigger: `migration_jobs_protected_${kind}_guard` }));
const EXIT_FN = 'guard_migration_job_protected_exit';
const SENTINEL_BODY = '\nBEGIN\n  -- SYNTHETIC_CASE1_PREEXISTING_EXIT_SENTINEL_NOT_A_GUARD\n  RETURN NEW;\nEND;\n';
const MAIN = '20000000-0000-4000-8000-000000000301';
const OTHER = '20000000-0000-4000-8000-000000000302';
const SOURCE = 'a'.repeat(64), FINAL = 'b'.repeat(64);
const migrationPaths = readdirSync('src/server/db/migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map(name => join('src/server/db/migrations', name));
const watched = [SELF, '.git/index', 'AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.mts',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c', 'src/server/db/testing/pglite.ts',
  'src/server/db/transaction.ts', 'src/server/migration/cutover.ts',
  'src/server/migration/localFourGuardServiceCompatibility.postgres.test.ts',
  ...PROTOTYPES.map(p => p.path), ...migrationPaths];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(watched.map(path => [path, hash(readFileSync(path))]));
type Stored = { row: Record<string, unknown>; xmin: string };
type State = Record<string, Stored[]>;
type SqlFailure = { code?: string; message?: string; severity?: string; schema?: string; table?: string;
  constraint?: string; file?: string; routine?: string };
function diagnostic(error: unknown): SqlFailure {
  if (!error || typeof error !== 'object') return {};
  const e = error as SqlFailure;
  return { code: e.code, message: e.message, severity: e.severity, schema: e.schema,
    table: e.table, constraint: e.constraint, file: e.file, routine: e.routine };
}
function extract(p: typeof PROTOTYPES[number]) {
  const bytes = readFileSync(p.path), text = bytes.toString('utf8');
  expect(hash(bytes), `${p.kind} exact reviewed source`).toBe(p.digest);
  const start = `CREATE FUNCTION public.guard_migration_job_protected_${p.kind.toLowerCase()}()`;
  expect(text.split(start)).toHaveLength(2);
  const from = text.indexOf(start), end = text.indexOf('`);', from);
  expect(end).toBeGreaterThan(from);
  const literal = text.slice(from, end);
  expect(literal).not.toContain('${');
  expect(literal).not.toContain('\\');
  expect(literal).not.toContain('CREATE OR REPLACE');
  expect(literal.match(/CREATE FUNCTION /g)).toHaveLength(p.kind === 'Delete' ? 2 : 1);
  expect(literal.match(/CREATE TRIGGER /g)).toHaveLength(p.kind === 'Delete' ? 2 : 1);
  return { ...p, literal, sqlHash: hash(literal) };
}
async function snapshot(client: PoolClient): Promise<State> {
  const tables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result: State = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw Error('Unexpected synthetic table name');
    result[tablename] = (await client.query<Stored>(`SELECT to_jsonb(t) AS row,xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function catalog(client: PoolClient) {
  // No candidate exclusions: after rollback the complete public catalog must match.
  return {
    functions: (await client.query(`SELECT p.oid::text,p.xmin::text,p.proname,p.proargtypes::text AS arguments,
      p.prorettype::regtype::text AS returns,p.prosrc,p.prosecdef,p.proconfig,p.proacl::text,
      p.proowner::text,pg_get_userbyid(p.proowner) AS owner,pg_get_functiondef(p.oid) AS definition,
      COALESCE(p.proacl,acldefault('f',p.proowner))::text AS effective_acl
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.proname,p.proargtypes`)).rows,
    triggers: (await client.query(`SELECT t.oid::text,t.xmin::text,t.tgname,t.tgfoid::text,t.tgrelid::regclass::text AS relation,
      t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY relation,t.tgname`)).rows,
    policies: (await client.query(`SELECT p.oid::text,p.xmin::text,p.polrelid::regclass::text AS relation,p.polname,
      p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid) AS qual,
      pg_get_expr(p.polwithcheck,p.polrelid) AS with_check FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      WHERE c.relnamespace='public'::regnamespace ORDER BY relation,p.polname`)).rows,
    relations: (await client.query(`SELECT oid::text,relname,relkind,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity
      FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname`)).rows,
    constraints: (await client.query(`SELECT oid::text,xmin::text,conrelid::regclass::text AS relation,conname,
      contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname`)).rows,
    columns: (await client.query(`SELECT attrelid::regclass::text AS relation,attname,attacl::text FROM pg_attribute
      WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY relation,attnum`)).rows,
    schemas: (await client.query("SELECT nspname,nspowner::text,nspacl::text FROM pg_namespace WHERE nspname='public'")).rows,
    defaults: (await client.query('SELECT oid::text,defaclrole::text,defaclnamespace::text,defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY oid')).rows,
    roles: (await client.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows,
    memberships: (await client.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
  };
}
function candidateObjects(state: Awaited<ReturnType<typeof catalog>>) {
  return { functions: state.functions.filter(f => CANDIDATES.some(c => c.fn === f.proname)),
    triggers: state.triggers.filter(t => CANDIDATES.some(c => c.trigger === t.tgname)) };
}
async function identity(client: PoolClient) {
  const result = await client.query(`SELECT pg_backend_pid() AS pid,current_user AS actor,session_user AS login,
    current_database() AS database,current_setting('transaction_isolation') AS isolation`);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ actor: 'postgres', login: 'postgres', database: 'postgres', isolation: 'read committed' });
  return result.rows[0];
}
async function runtimeReadback(database: DisposablePostgres, before: State) {
  const client = await database.runtime.connect();
  try {
    for (const tenant of [MAIN, OTHER]) {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
        const actor = (await client.query(`SELECT current_user AS actor,session_user AS login,r.rolsuper,r.rolbypassrls,
          pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity FROM pg_roles r CROSS JOIN pg_class c
          WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows;
        expect(actor).toEqual([{ actor: 'app_runtime', login: 'app_runtime', rolsuper: false, rolbypassrls: false,
          owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true }]);
        expect((await client.query('SELECT to_jsonb(t) AS row,xmin::text FROM tenants t ORDER BY to_jsonb(t)::text')).rows)
          .toEqual(before.tenants.filter(t => t.row.id === tenant));
        for (const table of ['migration_jobs', 'migration_sources', 'migration_source_records', 'migration_snapshots', 'audit_events']) {
          expect((await client.query(`SELECT to_jsonb(t) AS row,xmin::text FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows)
            .toEqual(before[table].filter(t => t.row.tenant_id === tenant));
        }
        expect((await client.query('COMMIT')).command).toBe('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { client.release(); }
}

describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('four-guard install case 1 only: PG17 collision rollback, NONAUTHORITY', () => {
  let database: DisposablePostgres | undefined;
  let sourceBefore: ReturnType<typeof hashes> | undefined;
  const externalFetch = vi.fn(async () => { throw Error('External fetch is forbidden'); });
  const evidence: Record<string, unknown> = { case: 1, authority: 'NONAUTHORITY', case1Verified: false,
    cases2And3: 'NOT_TESTED', operationalProtection: 'NOT_PROVEN', task19Accepted: false, task23Accepted: false,
    runtimeWriterRace: 'NOT_TESTED', externalWriterExclusion: 'NOT_PROVEN', phase: 'NOT_STARTED' };

  afterAll(async () => {
    try {
      if (database) {
        evidence.cleanup = await database.close();
        expect(evidence.cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
      }
    } finally {
      vi.unstubAllGlobals();
      const after = hashes();
      evidence.sourceHashes = after;
      evidence.sourceHashesUnchanged = sourceBefore !== undefined && JSON.stringify(after) === JSON.stringify(sourceBefore);
      evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
      process.stdout.write('LOCAL_FOUR_GUARD_INSTALL_CASE1 ' + JSON.stringify(evidence) + '\n');
      expect(after).toEqual(sourceBefore);
      expect(externalFetch).not.toHaveBeenCalled();
    }
  }, 0);

  it('rolls back witnessed Entry/Evidence DDL on the exact middle Exit function collision and preserves the sentinel', async () => {
    sourceBefore = hashes();
    evidence.phase = 'PIN_SOURCES';
    const literals = PROTOTYPES.map(extract);
    expect(literals.map(p => p.kind)).toEqual(['Entry', 'Evidence', 'Exit', 'Delete']);
    evidence.exactSql = literals.map(({ kind, digest, sqlHash }) => ({ kind, sourceHash: digest, sqlHash }));
    vi.stubGlobal('fetch', externalFetch);
    evidence.phase = 'ISOLATED_PG17_SETUP';
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner',
      networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true,
      droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.version).toMatch(/^17\./);
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.migrations).toEqual(migrationPaths.map(path => ({ name: path.split('/').at(-1), sha256: sourceBefore![path] })));
    const installer = await database.owner.connect();
    let observer: PoolClient | undefined, transactionOpen = false;
    try {
      observer = await database.owner.connect(); // Hold both: cannot accidentally reuse installer backend.
      const installerIdentity = await identity(installer), observerIdentity = await identity(observer);
      expect(observerIdentity.pid).not.toBe(installerIdentity.pid);
      evidence.connections = { installer: installerIdentity, observer: observerIdentity };
      expect(candidateObjects(await catalog(observer))).toEqual({ functions: [], triggers: [] });
      expect((await observer.query('SELECT * FROM tenants')).rows).toEqual([]);
      expect((await observer.query('SELECT * FROM migration_jobs')).rows).toEqual([]);
      evidence.phase = 'HISTORICAL_FIXTURES_AND_SENTINEL';
      await installer.query('BEGIN'); transactionOpen = true;
      await installer.query(`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES
        ($1,'atomicity-draft','Synthetic DRAFT history','DRAFT'),($2,'atomicity-active','Synthetic ACTIVE history','ACTIVE')`, [MAIN, OTHER]);
      for (const [tenant, job, status] of [[MAIN, 'historical-final', 'FINAL_IMPORT'], [OTHER, 'historical-active', 'ACTIVE']]) {
        await installer.query(`INSERT INTO migration_jobs(tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
          created_at,freeze_started_at,freeze_verified_at,updated_at,completed_at) VALUES($1,$2,$3,7,$4,$5,
          '2026-08-01T00:00:00.123456Z','2026-08-01T00:10:00.123456Z','2026-08-01T00:20:00.123456Z',
          '2026-08-01T00:30:00.123456Z',CASE WHEN $3='ACTIVE' THEN '2026-08-01T00:30:00.123456Z'::timestamptz ELSE NULL END)`,
        [tenant, job, status, SOURCE, FINAL]);
        await installer.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
          VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5)`, [tenant, job, `source-${job}`, `synthetic/${tenant}/${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_source_records(tenant_id,job_id,source_id,record_id,source_collection,source_record_id,
          source_row_hash,redacted_record,canonical_record,mapping_status,error_details) VALUES($1,$2,$3,$4,'Synthetic','1',$5,
          '{"synthetic":true}','{"preserved":true}','QUARANTINED','["SYNTHETIC_ONLY"]')`, [tenant, job, `source-${job}`, `record-${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
          VALUES($1,$2,$3,$4,'PREFLIGHT',$5,'{"synthetic":true}',1)`, [tenant, job, `source-${job}`, `snapshot-${job}`, SOURCE]);
        await installer.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
          VALUES($1,$2,$3,'SYNTHETIC_HISTORICAL_EVIDENCE','{"nonAuthority":true}')`, [tenant, `audit-${job}`, job]);
      }
      await installer.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'historical-draft','DISCOVERED')", [MAIN]);
      await installer.query(`CREATE FUNCTION public.${EXIT_FN}() RETURNS trigger LANGUAGE plpgsql
        SECURITY INVOKER SET search_path = pg_catalog AS $$${SENTINEL_BODY}$$`);
      expect((await installer.query('COMMIT')).command).toBe('COMMIT'); transactionOpen = false;
      const rowsBefore = await snapshot(observer), catalogBefore = await catalog(observer);
      expect(rowsBefore.tenants).toHaveLength(2);
      expect(rowsBefore.migration_jobs).toHaveLength(3);
      for (const table of ['migration_sources', 'migration_source_records', 'migration_snapshots', 'audit_events']) expect(rowsBefore[table]).toHaveLength(2);
      const initialCandidates = candidateObjects(catalogBefore);
      expect(initialCandidates.functions).toHaveLength(1);
      expect(initialCandidates.triggers).toEqual([]);
      const sentinel = initialCandidates.functions[0];
      expect(sentinel).toMatchObject({ proname: EXIT_FN, arguments: '', returns: 'trigger', prosrc: SENTINEL_BODY,
        owner: 'postgres', prosecdef: false, proconfig: ['search_path=pg_catalog'] });
      expect(sentinel.oid).toMatch(/^\d+$/);
      await runtimeReadback(database, rowsBefore);
      evidence.sentinelBefore = sentinel;
      evidence.rowsBeforeHash = hash(JSON.stringify(rowsBefore));
      evidence.catalogBeforeHash = hash(JSON.stringify(catalogBefore));
      evidence.phase = 'ENTRY_EVIDENCE_INSTALL_WITNESS';
      await installer.query('BEGIN'); transactionOpen = true;
      const xid = (await installer.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
      const attempted: string[] = [], completed: string[] = [];
      for (const p of literals.slice(0, 2)) {
        attempted.push(p.kind);
        await installer.query(p.literal);
        completed.push(p.kind);
      }
      const inside = candidateObjects(await catalog(installer));
      expect(inside.functions.map(f => f.proname)).toEqual([CANDIDATES[0].fn, CANDIDATES[1].fn, EXIT_FN]);
      expect(inside.functions.find(f => f.proname === EXIT_FN)).toEqual(sentinel);
      expect(inside.triggers).toHaveLength(2);
      for (const [i, c] of CANDIDATES.slice(0, 2).entries()) {
        const literal = literals[i].literal, start = literal.indexOf('AS $$') + 'AS $$'.length;
        const body = literal.slice(start, literal.indexOf('$$;', start));
        const fn = inside.functions.find(f => f.proname === c.fn);
        expect(fn).toMatchObject({ xmin: xid, prosrc: body, owner: 'postgres', prosecdef: false, proconfig: ['search_path=pg_catalog'] });
        const trigger = inside.triggers.find(t => t.tgname === c.trigger);
        expect(trigger).toMatchObject({ xmin: xid, tgfoid: fn!.oid, tgenabled: 'O', tgisinternal: false,
          tgdeferrable: false, tginitdeferred: false,
          definition: `CREATE TRIGGER ${c.trigger} ${c.timing} ON public.migration_jobs FOR EACH ${c.level} EXECUTE FUNCTION ${c.fn}()` });
      }
      expect(await catalog(observer)).toEqual(catalogBefore);
      expect(await snapshot(observer)).toEqual(rowsBefore);
      evidence.installWitness = { xid, attempted: [...attempted], completed: [...completed], objects: inside,
        observerCatalogUnchanged: true, observerRowsAndXminUnchanged: true };
      evidence.phase = 'EXACT_EXIT_SIMPLE_CREATE';
      attempted.push(literals[2].kind);
      let collision: unknown;
      // Only this exact query may supply the expected 42723; earlier failures escape.
      try { await installer.query(literals[2].literal); }
      catch (error) { collision = error; }
      evidence.collision = diagnostic(collision);
      expect(collision).toBeInstanceOf(Error);
      expect(diagnostic(collision)).toMatchObject({ code: '42723', severity: 'ERROR',
        message: 'function "guard_migration_job_protected_exit" already exists with same argument types' });
      expect(attempted).toEqual(['Entry', 'Evidence', 'Exit']);
      expect(completed).toEqual(['Entry', 'Evidence']);
      // Prove the transaction is failed, not silently recovered with a savepoint.
      await expect(installer.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
      evidence.failedTransactionState = '25P02';
      evidence.phase = 'ROLLBACK_AND_INDEPENDENT_OBSERVER';
      expect((await installer.query('ROLLBACK')).command).toBe('ROLLBACK'); transactionOpen = false;
      expect(await identity(observer)).toEqual(observerIdentity);
      const catalogAfter = await catalog(observer), rowsAfter = await snapshot(observer);
      expect(catalogAfter).toEqual(catalogBefore);
      expect(rowsAfter).toEqual(rowsBefore);
      const remaining = candidateObjects(catalogAfter);
      expect(remaining).toEqual({ functions: [sentinel], triggers: [] });
      expect(await catalog(installer)).toEqual(catalogBefore);
      await runtimeReadback(database, rowsBefore);
      evidence.sentinelAfter = remaining.functions[0];
      evidence.rowsAfterHash = hash(JSON.stringify(rowsAfter));
      evidence.catalogAfterHash = hash(JSON.stringify(catalogAfter));
      evidence.afterRollback = { observerPid: observerIdentity.pid, remaining,
        entryEvidenceFunctionsAndTriggersAbsent: true, exitCandidateTriggerAbsent: true,
        deleteTruncateNotAttemptedAndAbsent: true, allRowsAndXminUnchanged: true, fullCatalogUnchanged: true,
        runtimeReadback: 'BOTH_SYNTHETIC_TENANTS_READ_ONLY' };
      evidence.case1Verified = true;
      evidence.phase = 'CASE1_VERIFIED_NOT_INSTALLED';
    } catch (error) {
      evidence.unexpectedFailure = { phase: evidence.phase, ...diagnostic(error) };
      throw error;
    } finally {
      try { if (transactionOpen) await installer.query('ROLLBACK'); }
      finally { observer?.release(); installer.release(); }
    }
  }, 0);
});

// Appended case 2 only. The case-1 implementation/receipt and its historical
// NOT_TESTED labels above are byte-preserved, not a file-wide coverage claim.
// Case 3 (installer ROLLBACK releases an unprotected writer) stays NOT_TESTED.
// Independent fresh PG17; no sentinel, guard removal, grant changes or sleeps.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('four-guard install case 2 only: PG17 waiting DELETE after COMMIT, NONAUTHORITY', () => {
  let database: DisposablePostgres | undefined;
  let sourceBefore: ReturnType<typeof hashes> | undefined;
  const externalFetch = vi.fn(async () => { throw Error('External fetch is forbidden'); });
  const evidence: Record<string, unknown> = { case: 2, authority: 'NONAUTHORITY', case2Verified: false,
    case3: 'NOT_TESTED', operationalProtection: 'NOT_PROVEN', task19Accepted: false, task23Accepted: false,
    externalWriterExclusion: 'NOT_PROVEN', writerFirstRace: 'NOT_TESTED', phase: 'NOT_STARTED' };
  const target = 'case2-childless-final';
  const deleteSql = 'DELETE FROM public.migration_jobs WHERE tenant_id=$1 AND job_id=$2 RETURNING tenant_id,job_id,status';
  type WriterOutcome = { kind: 'RETURNED'; rowCount: number | null; rows: unknown[] }
    | { kind: 'REFUSED'; error: unknown };
  type Lock = { pid: number; mode: string; granted: boolean; relation: string; database: string; waitstart: string | null };
  type Wait = { pid: number; usename: string; state: string; wait_event_type: string | null; wait_event: string | null;
    query: string; blockers: number[]; locks: Lock[] };
  const failure = (error: unknown) => {
    const extra = error && typeof error === 'object' ? error as { where?: string; detail?: string } : {};
    return { ...diagnostic(error), where: extra.where, detail: extra.detail };
  };
  const withoutGuards = (state: Awaited<ReturnType<typeof catalog>>) => ({ ...state,
    functions: state.functions.filter(f => !CANDIDATES.some(c => c.fn === f.proname)),
    triggers: state.triggers.filter(t => !CANDIDATES.some(c => c.trigger === t.tgname)) });

  afterAll(async () => {
    try {
      if (database) {
        evidence.cleanup = await database.close();
        expect(evidence.cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
      }
    } finally {
      vi.unstubAllGlobals();
      const after = hashes();
      evidence.sourceHashes = after;
      evidence.sourceHashesUnchanged = sourceBefore !== undefined && JSON.stringify(after) === JSON.stringify(sourceBefore);
      evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
      process.stdout.write('LOCAL_FOUR_GUARD_INSTALL_CASE2 ' + JSON.stringify(evidence) + '\n');
      expect(after).toEqual(sourceBefore);
      expect(externalFetch).not.toHaveBeenCalled();
    }
  }, 0);

  it('observes the runtime DELETE blocked by the uncommitted installer then refused by the committed Delete guard', async () => {
    sourceBefore = hashes();
    evidence.phase = 'PIN_SOURCES';
    const literals = PROTOTYPES.map(extract);
    expect(literals.map(p => p.kind)).toEqual(['Entry', 'Evidence', 'Exit', 'Delete']);
    evidence.exactSql = literals.map(({ kind, digest, sqlHash }) => ({ kind, sourceHash: digest, sqlHash }));
    vi.stubGlobal('fetch', externalFetch);
    evidence.phase = 'INDEPENDENT_ISOLATED_PG17_SETUP';
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner',
      networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true,
      droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.version).toMatch(/^17\./);
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.migrations).toEqual(migrationPaths.map(path => ({ name: path.split('/').at(-1), sha256: sourceBefore![path] })));
    const installer = await database.owner.connect();
    let observer: PoolClient | undefined, writer: PoolClient | undefined;
    let installerOpen = false, writerOpen = false;
    let pendingDelete: Promise<WriterOutcome> | undefined, settled: WriterOutcome | undefined;
    try {
      observer = await database.owner.connect();
      const installerIdentity = await identity(installer), observerIdentity = await identity(observer);
      expect(observerIdentity.pid).not.toBe(installerIdentity.pid);
      expect(candidateObjects(await catalog(observer))).toEqual({ functions: [], triggers: [] });
      expect((await observer.query('SELECT * FROM tenants')).rows).toEqual([]);
      expect((await observer.query('SELECT * FROM migration_jobs')).rows).toEqual([]);
      evidence.phase = 'HISTORICAL_FIXTURES_BEFORE_GUARDS';
      await installer.query('BEGIN'); installerOpen = true;
      await installer.query(`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES
        ($1,'atomicity-commit-draft','Synthetic DRAFT history','DRAFT'),
        ($2,'atomicity-commit-active','Synthetic ACTIVE history','ACTIVE')`, [MAIN, OTHER]);
      for (const [tenant, job, status] of [[MAIN, 'historical-final', 'FINAL_IMPORT'], [OTHER, 'historical-active', 'ACTIVE'],
        [MAIN, target, 'FINAL_IMPORT']]) {
        await installer.query(`INSERT INTO migration_jobs(tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
          created_at,freeze_started_at,freeze_verified_at,updated_at,completed_at) VALUES($1,$2,$3,7,$4,$5,
          '2026-08-01T00:00:00.123456Z','2026-08-01T00:10:00.123456Z','2026-08-01T00:20:00.123456Z',
          '2026-08-01T00:30:00.123456Z',CASE WHEN $3='ACTIVE' THEN '2026-08-01T00:30:00.123456Z'::timestamptz ELSE NULL END)`,
        [tenant, job, status, SOURCE, FINAL]);
        if (job === target) continue; // Deliberately childless; separately proved against every actual job FK below.
        await installer.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
          VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5)`, [tenant, job, `source-${job}`, `synthetic/${tenant}/${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_source_records(tenant_id,job_id,source_id,record_id,source_collection,source_record_id,
          source_row_hash,redacted_record,canonical_record,mapping_status,error_details) VALUES($1,$2,$3,$4,'Synthetic','1',$5,
          '{"synthetic":true}','{"preserved":true}','QUARANTINED','["SYNTHETIC_ONLY"]')`, [tenant, job, `source-${job}`, `record-${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
          VALUES($1,$2,$3,$4,'PREFLIGHT',$5,'{"synthetic":true}',1)`, [tenant, job, `source-${job}`, `snapshot-${job}`, SOURCE]);
        await installer.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
          VALUES($1,$2,$3,'SYNTHETIC_HISTORICAL_EVIDENCE','{"nonAuthority":true}')`, [tenant, `audit-${job}`, job]);
      }
      await installer.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'historical-draft','DISCOVERED')", [MAIN]);
      expect((await installer.query('COMMIT')).command).toBe('COMMIT'); installerOpen = false;
      const rowsBefore = await snapshot(observer), catalogBefore = await catalog(observer);
      expect(rowsBefore.tenants).toHaveLength(2);
      expect(rowsBefore.migration_jobs).toHaveLength(4);
      for (const table of ['migration_sources', 'migration_source_records', 'migration_snapshots', 'audit_events']) expect(rowsBefore[table]).toHaveLength(2);
      const targetBefore = rowsBefore.migration_jobs.filter(t => t.row.tenant_id === MAIN && t.row.job_id === target);
      expect(targetBefore).toHaveLength(1);
      expect(targetBefore[0].row.status).toBe('FINAL_IMPORT');
      // Check real FK metadata, not merely an empty hand-selected child list.
      const foreignKeys = (await observer.query<{ relation: string; conname: string; child_columns: string[]; parent_columns: string[] }>(`
        SELECT c.conrelid::regclass::text AS relation,c.conname,
          ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS child_columns,
          ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) AS parent_columns
        FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='public.migration_jobs'::regclass ORDER BY c.conname`)).rows;
      expect(foreignKeys.map(f => f.conname)).toEqual(['audit_events_job_fk', 'exports_job_fk', 'migration_final_generations_job_fk',
        'migration_sources_job_fk', 'migration_start_executions_job_fk', 'reconciliation_results_job_fk']);
      for (const fk of foreignKeys) {
        expect(fk.child_columns).toEqual(['tenant_id', 'job_id']);
        expect(fk.parent_columns).toEqual(['tenant_id', 'job_id']);
        expect(rowsBefore[fk.relation], fk.relation).toBeDefined();
        expect(rowsBefore[fk.relation].filter(t => t.row.tenant_id === MAIN && t.row.job_id === target), fk.conname).toEqual([]);
      }
      evidence.childlessTarget = { target, row: targetBefore[0], foreignKeys };
      await runtimeReadback(database, rowsBefore);
      writer = await database.runtime.connect();
      await writer.query('BEGIN'); writerOpen = true;
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [MAIN]);
      const writerIdentity = (await writer.query(`SELECT pg_backend_pid() AS pid,current_user AS actor,session_user AS login,
        current_database() AS database,current_setting('transaction_isolation') AS isolation,r.rolsuper,r.rolbypassrls,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'SELECT') AS can_select,has_table_privilege(current_user,c.oid,'DELETE') AS can_delete
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows[0];
      expect(writerIdentity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', database: 'postgres', isolation: 'read committed',
        rolsuper: false, rolbypassrls: false, owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true, can_select: true, can_delete: true });
      expect(new Set([installerIdentity.pid, observerIdentity.pid, writerIdentity.pid]).size).toBe(3);
      const priorRead = (await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows;
      expect(priorRead).toEqual(targetBefore);
      evidence.connections = { installer: installerIdentity, observer: observerIdentity, writer: writerIdentity };
      evidence.writerPriorRead = priorRead;
      evidence.rowsBeforeHash = hash(JSON.stringify(rowsBefore));
      evidence.catalogBeforeHash = hash(JSON.stringify(catalogBefore));
      evidence.phase = 'ALL_FIVE_UNCOMMITTED_GUARDS';
      await installer.query('BEGIN'); installerOpen = true;
      const xid = (await installer.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
      for (const p of literals) await installer.query(p.literal);
      const insideCatalog = await catalog(installer), inside = candidateObjects(insideCatalog);
      expect(inside.functions).toHaveLength(5);
      expect(inside.triggers).toHaveLength(5);
      expect(withoutGuards(insideCatalog)).toEqual(catalogBefore);
      for (const c of CANDIDATES) {
        const literal = literals.find(p => p.kind.toLowerCase() === (c.kind === 'truncate' ? 'delete' : c.kind))!.literal;
        const from = literal.indexOf(`CREATE FUNCTION public.${c.fn}()`);
        expect(from).toBeGreaterThanOrEqual(0);
        const start = literal.indexOf('AS $$', from) + 'AS $$'.length;
        const body = literal.slice(start, literal.indexOf('$$;', start));
        const fn = inside.functions.find(f => f.proname === c.fn);
        expect(fn).toMatchObject({ xmin: xid, arguments: '', returns: 'trigger', prosrc: body, owner: 'postgres',
          prosecdef: false, proconfig: ['search_path=pg_catalog'] });
        expect(fn!.oid).toMatch(/^\d+$/);
        expect(inside.triggers.find(t => t.tgname === c.trigger)).toMatchObject({ xmin: xid, tgfoid: fn!.oid, relation: 'migration_jobs',
          tgenabled: 'O', tgisinternal: false, tgdeferrable: false, tginitdeferred: false,
          definition: `CREATE TRIGGER ${c.trigger} ${c.timing} ON public.migration_jobs FOR EACH ${c.level} EXECUTE FUNCTION ${c.fn}()` });
      }
      expect(await catalog(observer)).toEqual(catalogBefore);
      expect(await snapshot(observer)).toEqual(rowsBefore);
      evidence.installWitness = { xid, objects: inside, observerCatalogUnchanged: true, observerRowsAndXminUnchanged: true };
      evidence.phase = 'ACTUAL_RUNTIME_DELETE_LOCK_WAIT';
      // Attach both settlements immediately; only this DELETE supplies the expected guard error.
      pendingDelete = writer.query(deleteSql, [MAIN, target]).then(result => {
        settled = { kind: 'RETURNED', rowCount: result.rowCount, rows: result.rows }; return settled;
      }, error => { settled = { kind: 'REFUSED', error }; return settled; });
      let wait: Wait;
      for (;;) {
        // Each observer query is a fresh autocommit stats snapshot. No sleep or elapsed-time evidence.
        const observations = (await observer.query<Wait>(`SELECT a.pid,a.usename,a.state,a.wait_event_type,a.wait_event,a.query,
          pg_blocking_pids(a.pid) AS blockers,COALESCE((SELECT jsonb_agg(jsonb_build_object('pid',l.pid,'mode',l.mode,
            'granted',l.granted,'relation',l.relation::text,'database',l.database::text,'waitstart',l.waitstart) ORDER BY l.pid,l.mode)
            FROM pg_locks l WHERE l.pid=ANY($2::int[]) AND l.locktype='relation'
            AND l.relation='public.migration_jobs'::regclass AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())),
            '[]'::jsonb) AS locks FROM pg_stat_activity a WHERE a.pid=$1`,
        [writerIdentity.pid, [writerIdentity.pid, installerIdentity.pid]])).rows;
        expect(observations).toHaveLength(1);
        wait = observations[0];
        evidence.lastWaitObservation = wait;
        if (settled !== undefined) {
          evidence.prematureWriterOutcome = settled.kind === 'REFUSED' ? { kind: settled.kind, ...failure(settled.error) } : settled;
          throw Error('BLOCKED: runtime DELETE settled before the required installer lock witness; not a case-2 pass');
        }
        if (wait.blockers.includes(installerIdentity.pid) && wait.wait_event_type === 'Lock' && wait.wait_event === 'relation'
          && wait.locks.some(l => l.pid === writerIdentity.pid && l.mode === 'RowExclusiveLock' && !l.granted)
          && wait.locks.some(l => l.pid === installerIdentity.pid && l.mode === 'ShareRowExclusiveLock' && l.granted)) break;
      }
      expect(wait).toMatchObject({ pid: writerIdentity.pid, usename: 'app_runtime', state: 'active', query: deleteSql,
        wait_event_type: 'Lock', wait_event: 'relation', blockers: [installerIdentity.pid] });
      const relationOid = (await observer.query("SELECT 'public.migration_jobs'::regclass::oid::text AS oid")).rows[0].oid;
      expect(wait.locks.every(l => l.relation === relationOid)).toBe(true);
      expect(wait.locks.find(l => l.pid === writerIdentity.pid && l.mode === 'RowExclusiveLock')?.waitstart).toEqual(expect.any(String));
      expect(wait.locks).toEqual(expect.arrayContaining([expect.objectContaining({ pid: writerIdentity.pid, mode: 'AccessShareLock', granted: true })]));
      expect(settled).toBeUndefined();
      evidence.waitWitness = { ...wait, relationOid, installerCommitNotYetSent: true, writerUnsettled: true };
      evidence.phase = 'COMMIT_ONLY_AFTER_REAL_LOCK_WITNESS';
      expect((await installer.query('COMMIT')).command).toBe('COMMIT'); installerOpen = false;
      evidence.installerCommit = 'COMMIT';
      const outcome = await pendingDelete;
      evidence.writerOutcome = outcome.kind === 'REFUSED' ? { kind: outcome.kind, ...failure(outcome.error) } : outcome;
      expect(outcome.kind, 'RETURNING success or zero rows cannot substitute for the Delete guard').toBe('REFUSED');
      if (outcome.kind !== 'REFUSED') throw Error('The protected row was not refused by the installed Delete guard');
      expect(outcome.error).toBeInstanceOf(Error);
      const refusal = failure(outcome.error);
      expect(refusal).toMatchObject({ code: '42501', severity: 'ERROR', schema: 'public', table: 'migration_jobs',
        constraint: 'migration_jobs_protected_delete_guard', message: 'Prototype protected migration job deletion refused.', routine: 'exec_stmt_raise' });
      // The pinned SECURITY INVOKER function uses search_path=pg_catalog, so PG qualifies its error context.
      expect(refusal.where).toBe('PL/pgSQL function public.guard_migration_job_protected_delete() line 4 at RAISE');
      expect(JSON.parse(refusal.detail!)).toEqual({ operation: 'DELETE', actor: 'app_runtime', login: 'app_runtime', depth: 1 });
      await expect(writer.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
      expect((await writer.query('ROLLBACK')).command).toBe('ROLLBACK'); writerOpen = false;
      evidence.writerRollback = 'ROLLBACK';
      evidence.phase = 'COMMITTED_GUARDS_AND_UNCHANGED_HISTORY_READBACK';
      expect(await identity(observer)).toEqual(observerIdentity);
      const catalogAfter = await catalog(observer), rowsAfter = await snapshot(observer);
      expect(catalogAfter).toEqual(insideCatalog); // Includes guard OIDs, xmin, body, owner, ACL and every existing trigger/policy.
      expect(withoutGuards(catalogAfter)).toEqual(catalogBefore);
      expect(rowsAfter).toEqual(rowsBefore);
      expect(await catalog(installer)).toEqual(catalogAfter);
      await runtimeReadback(database, rowsBefore);
      // Also re-read the exact target on the SAME runtime backend after its failed transaction.
      await writer.query('BEGIN'); writerOpen = true;
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [MAIN]);
      expect((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(writerIdentity.pid);
      expect((await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows).toEqual(targetBefore);
      expect((await writer.query('COMMIT')).command).toBe('COMMIT'); writerOpen = false;
      expect((await observer.query('SELECT pg_blocking_pids($1) AS blockers', [writerIdentity.pid])).rows).toEqual([{ blockers: [] }]);
      expect((await observer.query(`SELECT pid FROM pg_locks WHERE pid=ANY($1::int[])
        AND locktype='relation' AND relation='public.migration_jobs'::regclass`, [[installerIdentity.pid, writerIdentity.pid]])).rows).toEqual([]);
      evidence.rowsAfterHash = hash(JSON.stringify(rowsAfter));
      evidence.catalogAfterHash = hash(JSON.stringify(catalogAfter));
      evidence.afterCommit = { allFiveGuardFunctionsAndTriggersCommitted: true, existingCatalogUnchanged: true,
        allRowsAndXminUnchanged: true, runtimeReadback: 'BOTH_SYNTHETIC_TENANTS_AND_SAME_WRITER_TARGET',
        writerDeleteRefusedByExactConstraintAndFunction: true, relationLocksReleased: true };
      evidence.case2Verified = true;
      evidence.phase = 'CASE2_VERIFIED_DISPOSABLE_ONLY';
    } catch (error) {
      evidence.unexpectedFailure = { phase: evidence.phase, ...failure(error) };
      throw error;
    } finally {
      // On assertion failure release the installer first, settle the queued query,
      // then roll back the writer (even if it unexpectedly deleted the synthetic row).
      try { if (installerOpen) await installer.query('ROLLBACK'); }
      finally {
        try { if (pendingDelete) await pendingDelete; if (writerOpen && writer) await writer.query('ROLLBACK'); }
        finally { writer?.release(); observer?.release(); installer.release(); }
      }
    }
  }, 0);
});

// Appended case 3 only; case-1/2 bytes and their fixture-scoped historical labels
// above remain unchanged. A NEW independently owned container is used here.
// Negative control: rolled-back candidate DDL leaves the old path UNPROTECTED.
// A successful synthetic DELETE is required, never relabeled operational safety.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('four-guard install case 3 only: PG17 waiting DELETE after ROLLBACK, NONAUTHORITY', () => {
  let database: DisposablePostgres | undefined;
  let sourceBefore: ReturnType<typeof hashes> | undefined;
  const externalFetch = vi.fn(async () => { throw Error('External fetch is forbidden'); });
  const evidence: Record<string, unknown> = { case: 3, authority: 'NONAUTHORITY', case3Verified: false,
    negativeControl: 'ROLLED_BACK_INSTALL_LEAVES_UNPROTECTED_OLD_PATH', operationalProtection: 'NOT_PROVEN',
    task19Accepted: false, task23Accepted: false, externalWriterExclusion: 'NOT_PROVEN',
    writerFirstRace: 'NOT_TESTED', phase: 'NOT_STARTED' };
  const target = 'case3-childless-final';
  const deleteSql = 'DELETE FROM public.migration_jobs AS t WHERE tenant_id=$1 AND job_id=$2 RETURNING to_jsonb(t) AS row,t.xmin::text';
  type WriterOutcome = { kind: 'RETURNED'; command: string; rowCount: number | null; rows: Stored[] }
    | { kind: 'REFUSED'; error: unknown };
  type Lock = { pid: number; mode: string; granted: boolean; relation: string; database: string; waitstart: string | null };
  type Wait = { pid: number; usename: string; state: string; wait_event_type: string | null; wait_event: string | null;
    query: string; blockers: number[]; locks: Lock[] };
  const failure = (error: unknown) => {
    const extra = error && typeof error === 'object' ? error as { where?: string; detail?: string } : {};
    return { ...diagnostic(error), where: extra.where, detail: extra.detail };
  };
  const withoutGuards = (state: Awaited<ReturnType<typeof catalog>>) => ({ ...state,
    functions: state.functions.filter(f => !CANDIDATES.some(c => c.fn === f.proname)),
    triggers: state.triggers.filter(t => !CANDIDATES.some(c => c.trigger === t.tgname)) });

  afterAll(async () => {
    try {
      if (database) {
        evidence.cleanup = await database.close();
        expect(evidence.cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
      }
    } finally {
      vi.unstubAllGlobals();
      const after = hashes();
      evidence.sourceHashes = after;
      evidence.sourceHashesUnchanged = sourceBefore !== undefined && JSON.stringify(after) === JSON.stringify(sourceBefore);
      evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
      process.stdout.write('LOCAL_FOUR_GUARD_INSTALL_CASE3 ' + JSON.stringify(evidence) + '\n');
      expect(after).toEqual(sourceBefore);
      expect(externalFetch).not.toHaveBeenCalled();
    }
  }, 0);

  it('observes a waiting nonowner DELETE commit exactly the childless target after candidate installation ROLLBACK', async () => {
    sourceBefore = hashes();
    evidence.phase = 'PIN_SOURCES';
    const literals = PROTOTYPES.map(extract);
    expect(literals.map(p => p.kind)).toEqual(['Entry', 'Evidence', 'Exit', 'Delete']);
    evidence.exactSql = literals.map(({ kind, digest, sqlHash }) => ({ kind, sourceHash: digest, sqlHash }));
    vi.stubGlobal('fetch', externalFetch);
    evidence.phase = 'INDEPENDENT_ISOLATED_PG17_SETUP';
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner',
      networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true,
      droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.version).toMatch(/^17\./);
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.migrations).toEqual(migrationPaths.map(path => ({ name: path.split('/').at(-1), sha256: sourceBefore![path] })));
    const installer = await database.owner.connect();
    let observer: PoolClient | undefined, writer: PoolClient | undefined;
    let installerOpen = false, writerOpen = false;
    let pendingDelete: Promise<WriterOutcome> | undefined, settled: WriterOutcome | undefined;
    try {
      observer = await database.owner.connect();
      const installerIdentity = await identity(installer), observerIdentity = await identity(observer);
      expect(observerIdentity.pid).not.toBe(installerIdentity.pid);
      expect(candidateObjects(await catalog(observer))).toEqual({ functions: [], triggers: [] });
      expect((await observer.query('SELECT * FROM tenants')).rows).toEqual([]);
      expect((await observer.query('SELECT * FROM migration_jobs')).rows).toEqual([]);
      evidence.phase = 'HISTORICAL_FIXTURES_BEFORE_GUARDS';
      await installer.query('BEGIN'); installerOpen = true;
      await installer.query(`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES
        ($1,'atomicity-rollback-draft','Synthetic DRAFT history','DRAFT'),
        ($2,'atomicity-rollback-active','Synthetic ACTIVE history','ACTIVE')`, [MAIN, OTHER]);
      for (const [tenant, job, status] of [[MAIN, 'historical-final', 'FINAL_IMPORT'], [OTHER, 'historical-active', 'ACTIVE'],
        [MAIN, target, 'FINAL_IMPORT']]) {
        await installer.query(`INSERT INTO migration_jobs(tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
          created_at,freeze_started_at,freeze_verified_at,updated_at,completed_at) VALUES($1,$2,$3,7,$4,$5,
          '2026-08-01T00:00:00.123456Z','2026-08-01T00:10:00.123456Z','2026-08-01T00:20:00.123456Z',
          '2026-08-01T00:30:00.123456Z',CASE WHEN $3='ACTIVE' THEN '2026-08-01T00:30:00.123456Z'::timestamptz ELSE NULL END)`,
        [tenant, job, status, SOURCE, FINAL]);
        if (job === target) continue; // Childless target; real FK metadata is checked below.
        await installer.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
          VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5)`, [tenant, job, `source-${job}`, `synthetic/${tenant}/${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_source_records(tenant_id,job_id,source_id,record_id,source_collection,source_record_id,
          source_row_hash,redacted_record,canonical_record,mapping_status,error_details) VALUES($1,$2,$3,$4,'Synthetic','1',$5,
          '{"synthetic":true}','{"preserved":true}','QUARANTINED','["SYNTHETIC_ONLY"]')`, [tenant, job, `source-${job}`, `record-${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
          VALUES($1,$2,$3,$4,'PREFLIGHT',$5,'{"synthetic":true}',1)`, [tenant, job, `source-${job}`, `snapshot-${job}`, SOURCE]);
        await installer.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
          VALUES($1,$2,$3,'SYNTHETIC_HISTORICAL_EVIDENCE','{"nonAuthority":true}')`, [tenant, `audit-${job}`, job]);
      }
      await installer.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'historical-draft','DISCOVERED')", [MAIN]);
      expect((await installer.query('COMMIT')).command).toBe('COMMIT'); installerOpen = false;
      const rowsBefore = await snapshot(observer), catalogBefore = await catalog(observer);
      expect(candidateObjects(catalogBefore)).toEqual({ functions: [], triggers: [] });
      expect(rowsBefore.tenants).toHaveLength(2);
      expect(rowsBefore.migration_jobs).toHaveLength(4);
      for (const table of ['migration_sources', 'migration_source_records', 'migration_snapshots', 'audit_events']) expect(rowsBefore[table]).toHaveLength(2);
      const targetBefore = rowsBefore.migration_jobs.filter(t => t.row.tenant_id === MAIN && t.row.job_id === target);
      expect(targetBefore).toHaveLength(1);
      expect(targetBefore[0].row.status).toBe('FINAL_IMPORT');
      const foreignKeys = (await observer.query<{ relation: string; conname: string; child_columns: string[]; parent_columns: string[] }>(`
        SELECT c.conrelid::regclass::text AS relation,c.conname,
          ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS child_columns,
          ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) AS parent_columns
        FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='public.migration_jobs'::regclass ORDER BY c.conname`)).rows;
      expect(foreignKeys.map(f => f.conname)).toEqual(['audit_events_job_fk', 'exports_job_fk', 'migration_final_generations_job_fk',
        'migration_sources_job_fk', 'migration_start_executions_job_fk', 'reconciliation_results_job_fk']);
      for (const fk of foreignKeys) {
        expect(fk.child_columns).toEqual(['tenant_id', 'job_id']);
        expect(fk.parent_columns).toEqual(['tenant_id', 'job_id']);
        expect(rowsBefore[fk.relation], fk.relation).toBeDefined();
        expect(rowsBefore[fk.relation].filter(t => t.row.tenant_id === MAIN && t.row.job_id === target), fk.conname).toEqual([]);
      }
      evidence.childlessTarget = { target, row: targetBefore[0], foreignKeys };
      // Construct the sole permitted difference BEFORE the DELETE, without changing baseline evidence.
      const expectedAfter: State = { ...rowsBefore,
        migration_jobs: rowsBefore.migration_jobs.filter(t => !(t.row.tenant_id === MAIN && t.row.job_id === target)) };
      expect(expectedAfter.migration_jobs).toHaveLength(3);
      evidence.expectedAfterHash = hash(JSON.stringify(expectedAfter));
      await runtimeReadback(database, rowsBefore);
      writer = await database.runtime.connect();
      await writer.query('BEGIN'); writerOpen = true;
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [MAIN]);
      const writerIdentity = (await writer.query(`SELECT pg_backend_pid() AS pid,current_user AS actor,session_user AS login,
        current_database() AS database,current_setting('transaction_isolation') AS isolation,r.rolsuper,r.rolbypassrls,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'SELECT') AS can_select,has_table_privilege(current_user,c.oid,'DELETE') AS can_delete
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows[0];
      expect(writerIdentity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', database: 'postgres', isolation: 'read committed',
        rolsuper: false, rolbypassrls: false, owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true, can_select: true, can_delete: true });
      expect(new Set([installerIdentity.pid, observerIdentity.pid, writerIdentity.pid]).size).toBe(3);
      const priorRead = (await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows;
      expect(priorRead).toEqual(targetBefore);
      evidence.connections = { installer: installerIdentity, observer: observerIdentity, writer: writerIdentity };
      evidence.writerPriorRead = priorRead;
      evidence.rowsBeforeHash = hash(JSON.stringify(rowsBefore));
      evidence.catalogBeforeHash = hash(JSON.stringify(catalogBefore));
      evidence.phase = 'ALL_FIVE_UNCOMMITTED_GUARDS';
      await installer.query('BEGIN'); installerOpen = true;
      const xid = (await installer.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
      for (const p of literals) await installer.query(p.literal);
      const insideCatalog = await catalog(installer), inside = candidateObjects(insideCatalog);
      expect(inside.functions).toHaveLength(5);
      expect(inside.triggers).toHaveLength(5);
      expect(withoutGuards(insideCatalog)).toEqual(catalogBefore);
      for (const c of CANDIDATES) {
        const literal = literals.find(p => p.kind.toLowerCase() === (c.kind === 'truncate' ? 'delete' : c.kind))!.literal;
        const from = literal.indexOf(`CREATE FUNCTION public.${c.fn}()`);
        expect(from).toBeGreaterThanOrEqual(0);
        const start = literal.indexOf('AS $$', from) + 'AS $$'.length;
        const body = literal.slice(start, literal.indexOf('$$;', start));
        const fn = inside.functions.find(f => f.proname === c.fn);
        expect(fn).toMatchObject({ xmin: xid, arguments: '', returns: 'trigger', prosrc: body, owner: 'postgres',
          prosecdef: false, proconfig: ['search_path=pg_catalog'] });
        expect(fn!.oid).toMatch(/^\d+$/);
        expect(inside.triggers.find(t => t.tgname === c.trigger)).toMatchObject({ xmin: xid, tgfoid: fn!.oid, relation: 'migration_jobs',
          tgenabled: 'O', tgisinternal: false, tgdeferrable: false, tginitdeferred: false,
          definition: `CREATE TRIGGER ${c.trigger} ${c.timing} ON public.migration_jobs FOR EACH ${c.level} EXECUTE FUNCTION ${c.fn}()` });
      }
      const uncommittedCatalog = await catalog(observer);
      expect(uncommittedCatalog).toEqual(catalogBefore);
      expect(candidateObjects(uncommittedCatalog)).toEqual({ functions: [], triggers: [] });
      expect(await snapshot(observer)).toEqual(rowsBefore);
      evidence.installWitness = { xid, objects: inside, observerCandidatesAbsent: true,
        observerCatalogUnchanged: true, observerRowsAndXminUnchanged: true };
      evidence.phase = 'ACTUAL_RUNTIME_DELETE_LOCK_WAIT';
      pendingDelete = writer.query<Stored>(deleteSql, [MAIN, target]).then(result => {
        settled = { kind: 'RETURNED', command: result.command, rowCount: result.rowCount, rows: result.rows }; return settled;
      }, error => { settled = { kind: 'REFUSED', error }; return settled; });
      let wait: Wait;
      for (;;) {
        // Each query is a fresh observer stats snapshot; no sleep or elapsed-time inference.
        const observations = (await observer.query<Wait>(`SELECT a.pid,a.usename,a.state,a.wait_event_type,a.wait_event,a.query,
          pg_blocking_pids(a.pid) AS blockers,COALESCE((SELECT jsonb_agg(jsonb_build_object('pid',l.pid,'mode',l.mode,
            'granted',l.granted,'relation',l.relation::text,'database',l.database::text,'waitstart',l.waitstart) ORDER BY l.pid,l.mode)
            FROM pg_locks l WHERE l.pid=ANY($2::int[]) AND l.locktype='relation'
            AND l.relation='public.migration_jobs'::regclass AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())),
            '[]'::jsonb) AS locks FROM pg_stat_activity a WHERE a.pid=$1`,
        [writerIdentity.pid, [writerIdentity.pid, installerIdentity.pid]])).rows;
        expect(observations).toHaveLength(1);
        wait = observations[0];
        evidence.lastWaitObservation = wait;
        if (settled !== undefined) {
          evidence.prematureWriterOutcome = settled.kind === 'REFUSED' ? { kind: settled.kind, ...failure(settled.error) } : settled;
          throw Error('BLOCKED: runtime DELETE settled before the required installer lock witness; not a case-3 pass');
        }
        if (wait.blockers.includes(installerIdentity.pid) && wait.wait_event_type === 'Lock' && wait.wait_event === 'relation'
          && wait.locks.some(l => l.pid === writerIdentity.pid && l.mode === 'RowExclusiveLock' && !l.granted)
          && wait.locks.some(l => l.pid === installerIdentity.pid && l.mode === 'ShareRowExclusiveLock' && l.granted)) break;
      }
      expect(wait).toMatchObject({ pid: writerIdentity.pid, usename: 'app_runtime', state: 'active', query: deleteSql,
        wait_event_type: 'Lock', wait_event: 'relation', blockers: [installerIdentity.pid] });
      const relationOid = (await observer.query("SELECT 'public.migration_jobs'::regclass::oid::text AS oid")).rows[0].oid;
      expect(wait.locks.every(l => l.relation === relationOid)).toBe(true);
      expect(wait.locks.find(l => l.pid === writerIdentity.pid && l.mode === 'RowExclusiveLock')?.waitstart).toEqual(expect.any(String));
      expect(wait.locks).toEqual(expect.arrayContaining([expect.objectContaining({ pid: writerIdentity.pid, mode: 'AccessShareLock', granted: true })]));
      expect(settled).toBeUndefined();
      evidence.waitWitness = { ...wait, relationOid, installerRollbackNotYetSent: true, writerUnsettled: true };
      evidence.phase = 'ROLLBACK_ONLY_AFTER_REAL_LOCK_WITNESS';
      expect((await installer.query('ROLLBACK')).command).toBe('ROLLBACK'); installerOpen = false;
      evidence.installerRollback = 'ROLLBACK';
      const outcome = await pendingDelete;
      evidence.writerOutcome = outcome.kind === 'REFUSED' ? { kind: outcome.kind, ...failure(outcome.error) } : outcome;
      expect(outcome.kind, 'Any refusal, timeout, FK error or zero rows fails this negative control').toBe('RETURNED');
      if (outcome.kind !== 'RETURNED') throw Error('The rolled-back install did not leave the expected unprotected DELETE path');
      expect(outcome).toEqual({ kind: 'RETURNED', command: 'DELETE', rowCount: 1, rows: targetBefore });
      // The writer alone sees its uncommitted DELETE. The independent observer must
      // still see every original row, while all five rolled-back guards are absent.
      expect((await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows).toEqual([]);
      const writerTransaction = (await writer.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
      expect(writerTransaction.pid).toBe(writerIdentity.pid);
      expect(writerTransaction.xid).toMatch(/^\d+$/);
      expect(writerTransaction.xid).not.toBe(xid);
      const afterRollbackCatalog = await catalog(observer);
      expect(afterRollbackCatalog).toEqual(catalogBefore);
      expect(candidateObjects(afterRollbackCatalog)).toEqual({ functions: [], triggers: [] });
      expect(await snapshot(observer)).toEqual(rowsBefore);
      evidence.beforeWriterCommit = { writerTransaction, writerTargetAbsent: true, observerRowsAndXminUnchanged: true,
        allFiveCandidateFunctionsAndTriggersAbsent: true, catalogUnchanged: true };
      evidence.phase = 'COMMIT_EXACT_TARGET_DELETE_NEGATIVE_CONTROL';
      expect((await writer.query('COMMIT')).command).toBe('COMMIT'); writerOpen = false;
      evidence.writerCommit = 'COMMIT';
      expect(await identity(observer)).toEqual(observerIdentity);
      const catalogAfter = await catalog(observer), rowsAfter = await snapshot(observer);
      expect(catalogAfter).toEqual(catalogBefore); // No candidate exclusions in rollback readback.
      expect(candidateObjects(catalogAfter)).toEqual({ functions: [], triggers: [] });
      expect(rowsAfter).toEqual(expectedAfter); // Every public table/row/xmin except the single permitted deletion.
      expect((await observer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows).toEqual([]);
      expect(await catalog(installer)).toEqual(catalogBefore);
      expect(await snapshot(installer)).toEqual(expectedAfter);
      await runtimeReadback(database, expectedAfter);
      await writer.query('BEGIN'); writerOpen = true;
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [MAIN]);
      expect((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(writerIdentity.pid);
      expect((await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows).toEqual([]);
      expect((await writer.query('COMMIT')).command).toBe('COMMIT'); writerOpen = false;
      expect((await observer.query('SELECT pg_blocking_pids($1) AS blockers', [writerIdentity.pid])).rows).toEqual([{ blockers: [] }]);
      expect((await observer.query(`SELECT pid FROM pg_locks WHERE pid=ANY($1::int[])
        AND locktype='relation' AND relation='public.migration_jobs'::regclass`, [[installerIdentity.pid, writerIdentity.pid]])).rows).toEqual([]);
      evidence.rowsAfterHash = hash(JSON.stringify(rowsAfter));
      evidence.catalogAfterHash = hash(JSON.stringify(catalogAfter));
      evidence.afterWriterCommit = { exactlyTargetDeleted: true, allOtherRowsChildrenAndXminUnchanged: true,
        allFiveCandidateFunctionsAndTriggersAbsent: true, fullCatalogUnchanged: true,
        runtimeReadback: 'BOTH_SYNTHETIC_TENANTS_AND_SAME_WRITER_TARGET_ABSENT', relationLocksReleased: true,
        meaning: 'NEGATIVE_CONTROL_UNPROTECTED_OLD_PATH_NOT_OPERATIONAL_PROTECTION' };
      evidence.case3Verified = true;
      evidence.phase = 'CASE3_VERIFIED_NEGATIVE_CONTROL_DISPOSABLE_ONLY';
    } catch (error) {
      evidence.unexpectedFailure = { phase: evidence.phase, ...failure(error) };
      throw error;
    } finally {
      // Never leave the queued writer behind a failed assertion's installer.
      // Roll back an uncommitted writer even when it has already returned a row.
      try { if (installerOpen) await installer.query('ROLLBACK'); }
      finally {
        try { if (pendingDelete) await pendingDelete; if (writerOpen && writer) await writer.query('ROLLBACK'); }
        finally { writer?.release(); observer?.release(); installer.release(); }
      }
    }
  }, 0);
});

// Appended case 4; all prior bytes/fixture-scoped labels are historical and unchanged.
// WRITER FIRST: installation cannot retroactively protect a committed deletion.
// No operational installation, fleet exclusion, or Task19/23 acceptance is proved.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('four-guard install case 4 only: PG17 writer-first DELETE, NONAUTHORITY', () => {
  let database: DisposablePostgres | undefined;
  let sourceBefore: ReturnType<typeof hashes> | undefined;
  const externalFetch = vi.fn(async () => { throw Error('External fetch is forbidden'); });
  const evidence: Record<string, unknown> = { case: 4, authority: 'NONAUTHORITY', case4Verified: false,
    operationalProtection: 'NOT_PROVEN', externalWriterExclusion: 'NOT_PROVEN', task19Accepted: false, task23Accepted: false,
    phase: 'NOT_STARTED' };
  const target = 'case4-childless-final', survivor = 'case4-surviving-final';
  const deleteSql = 'DELETE FROM public.migration_jobs AS t WHERE tenant_id=$1 AND job_id=$2 RETURNING to_jsonb(t) AS row,t.xmin::text';
  type InstallOutcome = { kind: 'COMPLETED' } | { kind: 'FAILED'; error: unknown };
  type Lock = { pid: number; mode: string; granted: boolean; relation: string; database: string; waitstart: string | null };
  type Wait = { pid: number; usename: string; state: string; wait_event_type: string | null; wait_event: string | null;
    query: string; blockers: number[]; locks: Lock[] };
  const failure = (error: unknown) => {
    const extra = error && typeof error === 'object' ? error as { where?: string; detail?: string } : {};
    return { ...diagnostic(error), where: extra.where, detail: extra.detail };
  };
  const withoutGuards = (state: Awaited<ReturnType<typeof catalog>>) => ({ ...state,
    functions: state.functions.filter(f => !CANDIDATES.some(c => c.fn === f.proname)),
    triggers: state.triggers.filter(t => !CANDIDATES.some(c => c.trigger === t.tgname)) });

  afterAll(async () => {
    try {
      if (database) {
        evidence.cleanup = await database.close();
        expect(evidence.cleanup).toEqual({ containerRemoved: true, scratchRemoved: true, id: database.evidence.containerId });
      }
    } finally {
      vi.unstubAllGlobals();
      const after = hashes();
      evidence.sourceHashes = after;
      evidence.sourceHashesUnchanged = sourceBefore !== undefined && JSON.stringify(after) === JSON.stringify(sourceBefore);
      evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
      process.stdout.write('LOCAL_FOUR_GUARD_INSTALL_CASE4 ' + JSON.stringify(evidence) + '\n');
      expect(after).toEqual(sourceBefore);
      expect(externalFetch).not.toHaveBeenCalled();
    }
  }, 0);

  it('witnesses an uncommitted runtime deletion blocking installation, then proves only subsequent DELETE is guarded', async () => {
    sourceBefore = hashes();
    const literals = PROTOTYPES.map(extract);
    expect(literals.map(p => p.kind)).toEqual(['Entry', 'Evidence', 'Exit', 'Delete']);
    evidence.exactSql = literals.map(({ kind, digest, sqlHash }) => ({ kind, sourceHash: digest, sqlHash }));
    vi.stubGlobal('fetch', externalFetch);
    evidence.phase = 'INDEPENDENT_ISOLATED_PG17_SETUP';
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner',
      networkMode: 'none', publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true,
      droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.version).toMatch(/^17\./);
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.migrations).toEqual(migrationPaths.map(path => ({ name: path.split('/').at(-1), sha256: sourceBefore![path] })));
    const installer = await database.owner.connect();
    let observer: PoolClient | undefined, writer: PoolClient | undefined;
    let installerOpen = false, writerOpen = false;
    let pendingInstall: Promise<InstallOutcome> | undefined, settled: InstallOutcome | undefined;
    const attempted: string[] = [], completed: string[] = [];
    try {
      observer = await database.owner.connect();
      const installerIdentity = await identity(installer), observerIdentity = await identity(observer);
      expect(observerIdentity.pid).not.toBe(installerIdentity.pid);
      expect(candidateObjects(await catalog(observer))).toEqual({ functions: [], triggers: [] });
      expect((await observer.query('SELECT * FROM tenants')).rows).toEqual([]);
      expect((await observer.query('SELECT * FROM migration_jobs')).rows).toEqual([]);
      evidence.phase = 'HISTORICAL_FIXTURES_BEFORE_ANY_CANDIDATE_DDL';
      await installer.query('BEGIN'); installerOpen = true;
      await installer.query(`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES
        ($1,'atomicity-writer-first-draft','Synthetic DRAFT history','DRAFT'),
        ($2,'atomicity-writer-first-active','Synthetic ACTIVE history','ACTIVE')`, [MAIN, OTHER]);
      for (const [tenant, job, status] of [[MAIN, target, 'FINAL_IMPORT'], [MAIN, survivor, 'FINAL_IMPORT'],
        [MAIN, 'historical-final', 'FINAL_IMPORT'], [OTHER, 'historical-active', 'ACTIVE']]) {
        await installer.query(`INSERT INTO migration_jobs(tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
          created_at,freeze_started_at,freeze_verified_at,updated_at,completed_at) VALUES($1,$2,$3,7,$4,$5,
          '2026-08-01T00:00:00.123456Z','2026-08-01T00:10:00.123456Z','2026-08-01T00:20:00.123456Z',
          '2026-08-01T00:30:00.123456Z',CASE WHEN $3='ACTIVE' THEN '2026-08-01T00:30:00.123456Z'::timestamptz ELSE NULL END)`,
        [tenant, job, status, SOURCE, FINAL]);
        if (job === target || job === survivor) continue;
        await installer.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
          VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5)`, [tenant, job, `source-${job}`, `synthetic/${tenant}/${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_source_records(tenant_id,job_id,source_id,record_id,source_collection,source_record_id,
          source_row_hash,redacted_record,canonical_record,mapping_status,error_details) VALUES($1,$2,$3,$4,'Synthetic','1',$5,
          '{"synthetic":true}','{"preserved":true}','QUARANTINED','["SYNTHETIC_ONLY"]')`, [tenant, job, `source-${job}`, `record-${job}`, SOURCE]);
        await installer.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
          VALUES($1,$2,$3,$4,'PREFLIGHT',$5,'{"synthetic":true}',1)`, [tenant, job, `source-${job}`, `snapshot-${job}`, SOURCE]);
        await installer.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
          VALUES($1,$2,$3,'SYNTHETIC_HISTORICAL_EVIDENCE','{"nonAuthority":true}')`, [tenant, `audit-${job}`, job]);
      }
      await installer.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'historical-draft','DISCOVERED')", [MAIN]);
      expect((await installer.query('COMMIT')).command).toBe('COMMIT'); installerOpen = false;
      const rowsBefore = await snapshot(observer), catalogBefore = await catalog(observer);
      expect(candidateObjects(catalogBefore)).toEqual({ functions: [], triggers: [] });
      expect(rowsBefore.tenants).toHaveLength(2);
      expect(rowsBefore.migration_jobs).toHaveLength(5);
      for (const table of ['migration_sources', 'migration_source_records', 'migration_snapshots', 'audit_events']) expect(rowsBefore[table]).toHaveLength(2);
      const targetBefore = rowsBefore.migration_jobs.filter(t => t.row.tenant_id === MAIN && t.row.job_id === target);
      const survivorBefore = rowsBefore.migration_jobs.filter(t => t.row.tenant_id === MAIN && t.row.job_id === survivor);
      expect(targetBefore).toHaveLength(1);
      expect(survivorBefore).toHaveLength(1);
      expect(targetBefore[0].row.status).toBe('FINAL_IMPORT');
      expect(survivorBefore[0].row.status).toBe('FINAL_IMPORT');
      const foreignKeys = (await observer.query<{ relation: string; conname: string; child_columns: string[]; parent_columns: string[] }>(`
        SELECT c.conrelid::regclass::text AS relation,c.conname,
          ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS child_columns,
          ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) AS parent_columns
        FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='public.migration_jobs'::regclass ORDER BY c.conname`)).rows;
      expect(foreignKeys.map(f => f.conname)).toEqual(['audit_events_job_fk', 'exports_job_fk', 'migration_final_generations_job_fk',
        'migration_sources_job_fk', 'migration_start_executions_job_fk', 'reconciliation_results_job_fk']);
      for (const fk of foreignKeys) {
        expect(fk.child_columns).toEqual(['tenant_id', 'job_id']);
        expect(fk.parent_columns).toEqual(['tenant_id', 'job_id']);
        expect(rowsBefore[fk.relation], fk.relation).toBeDefined();
        for (const job of [target, survivor]) {
          expect(rowsBefore[fk.relation].filter(t => t.row.tenant_id === MAIN && t.row.job_id === job), fk.conname).toEqual([]);
        }
      }
      const expectedAfter: State = { ...rowsBefore,
        migration_jobs: rowsBefore.migration_jobs.filter(t => !(t.row.tenant_id === MAIN && t.row.job_id === target)) };
      expect(expectedAfter.migration_jobs).toHaveLength(4);
      evidence.childlessTargets = { target: targetBefore, survivor: survivorBefore, foreignKeys };
      evidence.rowsBeforeHash = hash(JSON.stringify(rowsBefore));
      evidence.expectedAfterHash = hash(JSON.stringify(expectedAfter));
      evidence.catalogBeforeHash = hash(JSON.stringify(catalogBefore));
      await runtimeReadback(database, rowsBefore);
      writer = await database.runtime.connect();
      await writer.query('BEGIN'); writerOpen = true;
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [MAIN]);
      const writerIdentity = (await writer.query(`SELECT pg_backend_pid() AS pid,current_user AS actor,session_user AS login,
        current_database() AS database,current_setting('transaction_isolation') AS isolation,r.rolsuper,r.rolbypassrls,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'SELECT') AS can_select,has_table_privilege(current_user,c.oid,'DELETE') AS can_delete
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`)).rows[0];
      expect(writerIdentity).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', database: 'postgres', isolation: 'read committed',
        rolsuper: false, rolbypassrls: false, owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true, can_select: true, can_delete: true });
      expect(new Set([installerIdentity.pid, observerIdentity.pid, writerIdentity.pid]).size).toBe(3);
      evidence.connections = { installer: installerIdentity, observer: observerIdentity, writer: writerIdentity };
      evidence.phase = 'ACTUAL_DELETE_RETURNING_BEFORE_ANY_CANDIDATE_DDL';
      expect((await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows).toEqual(targetBefore);
      const deleted = await writer.query<Stored>(deleteSql, [MAIN, target]);
      const returned = { command: deleted.command, rowCount: deleted.rowCount, rows: deleted.rows };
      expect(returned).toEqual({ command: 'DELETE', rowCount: 1, rows: targetBefore });
      const writerTransaction = (await writer.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
      expect(writerTransaction.pid).toBe(writerIdentity.pid);
      expect(writerTransaction.xid).toMatch(/^\d+$/);
      expect((await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows).toEqual([]);
      expect(await snapshot(observer)).toEqual(rowsBefore);
      expect(await catalog(observer)).toEqual(catalogBefore);
      expect(attempted).toEqual([]);
      evidence.beforeAnyCandidateDDL = { returned, writerTransaction, writerTargetAbsent: true,
        observerRowsAndXminUnchanged: true, observerCatalogUnchanged: true, candidateDDLNotAttempted: true };

      evidence.phase = 'INSTALLER_REAL_RELATION_LOCK_WAIT_ON_WRITER';
      await installer.query('BEGIN'); installerOpen = true;
      const xid = (await installer.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
      expect(xid).not.toBe(writerTransaction.xid);
      // Attach rejection handling immediately. No COMMIT is hidden in this task.
      pendingInstall = (async () => {
        for (const p of literals) {
          attempted.push(p.kind);
          await installer.query(p.literal);
          completed.push(p.kind);
        }
      })().then(() => { settled = { kind: 'COMPLETED' }; return settled; },
        error => { settled = { kind: 'FAILED', error }; return settled; });
      let wait: Wait;
      for (;;) {
        // Fresh autocommit statistics; elapsed time/sleep is never a witness.
        const observations = (await observer.query<Wait>(`SELECT a.pid,a.usename,a.state,a.wait_event_type,a.wait_event,a.query,
          pg_blocking_pids(a.pid) AS blockers,COALESCE((SELECT jsonb_agg(jsonb_build_object('pid',l.pid,'mode',l.mode,
            'granted',l.granted,'relation',l.relation::text,'database',l.database::text,'waitstart',l.waitstart) ORDER BY l.pid,l.mode)
            FROM pg_locks l WHERE l.pid=ANY($2::int[]) AND l.locktype='relation'
            AND l.relation='public.migration_jobs'::regclass AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())),
            '[]'::jsonb) AS locks FROM pg_stat_activity a WHERE a.pid=$1`,
        [installerIdentity.pid, [installerIdentity.pid, writerIdentity.pid]])).rows;
        expect(observations).toHaveLength(1);
        wait = observations[0];
        evidence.lastWaitObservation = wait;
        if (settled !== undefined) {
          evidence.prematureInstallOutcome = settled.kind === 'FAILED' ? { kind: settled.kind, ...failure(settled.error) } : settled;
          throw Error('BLOCKED: installer settled before required writer-first relation lock witness; not a case-4 pass');
        }
        if (wait.blockers.includes(writerIdentity.pid) && wait.wait_event_type === 'Lock' && wait.wait_event === 'relation'
          && wait.locks.some(l => l.pid === installerIdentity.pid && l.mode === 'ShareRowExclusiveLock' && !l.granted)
          && wait.locks.some(l => l.pid === writerIdentity.pid && l.mode === 'RowExclusiveLock' && l.granted)) break;
      }
      // pg_stat_activity records at most track_activity_query_size - 1 bytes.
      // Compare the exact server-sized SQL, not a guessed/full-text activity value.
      const activitySetting = (await observer.query("SELECT setting::int AS bytes,unit FROM pg_settings WHERE name='track_activity_query_size'")).rows;
      expect(activitySetting).toHaveLength(1);
      expect(activitySetting[0].unit).toBe('B');
      expect(activitySetting[0].bytes).toBeGreaterThan(1);
      expect([...literals[0].literal].every(char => char.codePointAt(0)! <= 0x7f)).toBe(true);
      const recordedSql = Buffer.from(literals[0].literal).subarray(0, activitySetting[0].bytes - 1).toString('utf8');
      expect(recordedSql).toContain('CREATE TRIGGER migration_jobs_protected_entry_guard');
      evidence.activityQueryRecording = { ...activitySetting[0], submittedSqlHash: literals[0].sqlHash,
        submittedBytes: Buffer.byteLength(literals[0].literal), recordedBytes: Buffer.byteLength(recordedSql) };
      expect(wait).toMatchObject({ pid: installerIdentity.pid, usename: 'postgres', state: 'active', query: recordedSql,
        wait_event_type: 'Lock', wait_event: 'relation', blockers: [writerIdentity.pid] });
      const relationOid = (await observer.query("SELECT 'public.migration_jobs'::regclass::oid::text AS oid")).rows[0].oid;
      expect(wait.locks.every(l => l.relation === relationOid)).toBe(true);
      expect(wait.locks.find(l => l.pid === installerIdentity.pid && l.mode === 'ShareRowExclusiveLock')?.waitstart).toEqual(expect.any(String));
      expect(settled).toBeUndefined();
      expect(attempted).toEqual(['Entry']);
      expect(completed).toEqual([]);
      expect(await snapshot(observer)).toEqual(rowsBefore);
      expect(await catalog(observer)).toEqual(catalogBefore);
      evidence.waitWitness = { ...wait, relationOid, attempted: [...attempted], completed: [...completed],
        writerCommitNotYetSent: true, installerUnsettled: true, observerOriginalRowsAndXminStillVisible: true };

      evidence.phase = 'WRITER_COMMIT_RELEASES_INSTALLER';
      expect((await writer.query('COMMIT')).command).toBe('COMMIT'); writerOpen = false;
      evidence.writerCommit = 'COMMIT';
      const outcome = await pendingInstall;
      evidence.installOutcome = outcome.kind === 'FAILED' ? { kind: outcome.kind, ...failure(outcome.error) } : outcome;
      expect(outcome).toEqual({ kind: 'COMPLETED' });
      expect(attempted).toEqual(['Entry', 'Evidence', 'Exit', 'Delete']);
      expect(completed).toEqual(attempted);
      const insideCatalog = await catalog(installer), inside = candidateObjects(insideCatalog);
      expect(inside.functions).toHaveLength(5);
      expect(inside.triggers).toHaveLength(5);
      expect(withoutGuards(insideCatalog)).toEqual(catalogBefore);
      for (const c of CANDIDATES) {
        const literal = literals.find(p => p.kind.toLowerCase() === (c.kind === 'truncate' ? 'delete' : c.kind))!.literal;
        const from = literal.indexOf(`CREATE FUNCTION public.${c.fn}()`);
        expect(from).toBeGreaterThanOrEqual(0);
        const start = literal.indexOf('AS $$', from) + 'AS $$'.length;
        const body = literal.slice(start, literal.indexOf('$$;', start));
        const fn = inside.functions.find(f => f.proname === c.fn);
        expect(fn).toMatchObject({ xmin: xid, arguments: '', returns: 'trigger', prosrc: body, owner: 'postgres',
          prosecdef: false, proconfig: ['search_path=pg_catalog'] });
        expect(fn!.oid).toMatch(/^\d+$/);
        expect(inside.triggers.find(t => t.tgname === c.trigger)).toMatchObject({ xmin: xid, tgfoid: fn!.oid, relation: 'migration_jobs',
          tgenabled: 'O', tgisinternal: false, tgdeferrable: false, tginitdeferred: false,
          definition: `CREATE TRIGGER ${c.trigger} ${c.timing} ON public.migration_jobs FOR EACH ${c.level} EXECUTE FUNCTION ${c.fn}()` });
      }
      expect(await catalog(observer)).toEqual(catalogBefore);
      expect(await snapshot(observer)).toEqual(expectedAfter);
      expect(await snapshot(installer)).toEqual(expectedAfter);
      evidence.installWitness = { xid, objects: inside, attempted, completed, observerCandidatesNotYetVisible: true,
        writerDeletionAlreadyCommitted: true, allOtherRowsAndXminUnchanged: true };
      expect((await installer.query('COMMIT')).command).toBe('COMMIT'); installerOpen = false;
      evidence.installerCommit = 'COMMIT';
      expect(await identity(observer)).toEqual(observerIdentity);
      const catalogAfter = await catalog(observer);
      expect(catalogAfter).toEqual(insideCatalog); // Independent OID/xmin/body/ACL/owner readback.
      expect(withoutGuards(catalogAfter)).toEqual(catalogBefore);
      expect(await snapshot(observer)).toEqual(expectedAfter);
      await runtimeReadback(database, expectedAfter);

      evidence.phase = 'DISTINCT_RUNTIME_TRANSACTION_SUBSEQUENT_DELETE_REFUSED';
      await writer.query('BEGIN'); writerOpen = true;
      await writer.query("SELECT set_config('app.tenant_id',$1,true)", [MAIN]);
      const laterTransaction = (await writer.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,current_user AS actor,session_user AS login')).rows[0];
      expect(laterTransaction).toMatchObject({ pid: writerIdentity.pid, actor: 'app_runtime', login: 'app_runtime' });
      expect(laterTransaction.xid).not.toBe(writerTransaction.xid);
      expect(laterTransaction.xid).not.toBe(xid);
      expect((await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, target])).rows).toEqual([]);
      expect((await writer.query('SELECT to_jsonb(t) AS row,xmin::text FROM public.migration_jobs t WHERE tenant_id=$1 AND job_id=$2', [MAIN, survivor])).rows).toEqual(survivorBefore);
      let rejection: unknown;
      try { await writer.query(deleteSql, [MAIN, survivor]); } catch (error) { rejection = error; }
      expect(rejection).toBeInstanceOf(Error);
      const refusal = failure(rejection);
      expect(refusal).toMatchObject({ code: '42501', severity: 'ERROR', schema: 'public', table: 'migration_jobs',
        constraint: 'migration_jobs_protected_delete_guard', message: 'Prototype protected migration job deletion refused.', routine: 'exec_stmt_raise' });
      expect(refusal.where).toBe('PL/pgSQL function public.guard_migration_job_protected_delete() line 4 at RAISE');
      expect(JSON.parse(refusal.detail!)).toEqual({ operation: 'DELETE', actor: 'app_runtime', login: 'app_runtime', depth: 1 });
      await expect(writer.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
      expect((await writer.query('ROLLBACK')).command).toBe('ROLLBACK'); writerOpen = false;
      evidence.subsequentDelete = { laterTransaction, refusal, rollback: 'ROLLBACK', survivor: survivorBefore };
      const rowsAfter = await snapshot(observer);
      expect(rowsAfter).toEqual(expectedAfter);
      expect(await catalog(observer)).toEqual(catalogAfter);
      expect(await snapshot(installer)).toEqual(expectedAfter);
      await runtimeReadback(database, expectedAfter);
      expect((await observer.query('SELECT pg_blocking_pids($1) AS blockers', [installerIdentity.pid])).rows).toEqual([{ blockers: [] }]);
      expect((await observer.query(`SELECT pid FROM pg_locks WHERE pid=ANY($1::int[])
        AND locktype='relation' AND relation='public.migration_jobs'::regclass`, [[installerIdentity.pid, writerIdentity.pid]])).rows).toEqual([]);
      evidence.rowsAfterHash = hash(JSON.stringify(rowsAfter));
      evidence.catalogAfterHash = hash(JSON.stringify(catalogAfter));
      evidence.afterCommit = { exactlyOriginalTargetDeleted: true, allOtherRowsChildrenAndXminUnchanged: true,
        allFiveGuardFunctionsAndTriggersCommitted: true, existingCatalogUnchanged: true, subsequentDeleteRefused: true,
        retroactiveProtection: false, relationLocksReleased: true, runtimeReadback: 'BOTH_SYNTHETIC_TENANTS' };
      evidence.case4Verified = true;
      evidence.phase = 'CASE4_VERIFIED_WRITER_FIRST_NOT_RETROACTIVELY_PROTECTED';
    } catch (error) {
      evidence.unexpectedFailure = { phase: evidence.phase, ...failure(error) };
      throw error;
    } finally {
      // Writer is the blocker in THIS case. Release it before awaiting/rolling back
      // the installer; reversing teardown order could queue ROLLBACK behind DDL.
      try { if (writerOpen && writer) await writer.query('ROLLBACK'); }
      finally {
        try { if (pendingInstall) await pendingInstall; if (installerOpen) await installer.query('ROLLBACK'); }
        finally { writer?.release(); observer?.release(); installer.release(); }
      }
    }
  }, 0);
});
