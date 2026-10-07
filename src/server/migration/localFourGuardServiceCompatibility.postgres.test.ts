// @vitest-environment node
// SYNTHETIC PG17 / NONAUTHORITY / NOT DEPLOYED / NOT Task19/23 acceptance.
// Opt-in: RUN_REAL_POSTGRES=1 vitest run <this file> --maxWorkers=1.
// Existing service/runner/repository code is exercised unchanged; this is added
// integration coverage, NOT a new production implementation or a claimed TDD RED.
// Historical fixtures precede all four exact, hash-pinned prototype SQL literals.
// No prototype test import/eval, guard relaxation, trigger disabling or extra ACL.
// getAuthenticatedSubject is an explicitly synthetic dependency, not HTTP/OIDC proof.
// ACTIVE is preexisting owner-seeded history, NOT activation/cutover authorization.
// NOT_TESTED: public auth, operational ACL/owner/replica/order/races, service failure
// after audit insertion, lost commit ACK, full ACTIVE app, import/start/forward
// ceremony, tenant activation guards, bulk/CASCADE/TRUNCATE matrix, permanent
// upgrade/restore and maintained external writer exclusion. No Sheets/Redis access.
// Whole-row/xmin rollback is not sequence rollback or concurrency proof.
// Existing harness I/O bounds only; no new test/hook wall-clock budget or fallback.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseStudentCommands } from '@/server/repositories/database/studentCommands';
import { resolveRepositoryFromEnv } from '@/server/repositories/factory';
import { createLegacyCutoverAbortService, type CutoverAbortIntent } from './cutover';
import type { TenantImportTransactionRunner } from './importer';

vi.mock('server-only', () => ({}));
const SELF = 'src/server/migration/localFourGuardServiceCompatibility.postgres.test.ts';
const PROTOTYPES = [
  ['Entry', '2474310608c3d9d03728ba09e43b9c1d2ddde6cfc157d1243b4d1d51d2132a0d'],
  ['Evidence', 'a6ab9bd656aaac19992114c1d70e0d74175d77e0100f859f0e79e41ed066a267'],
  ['Exit', 'fb2ee8ebffacd91ccc4a96c6c157fcb2246eca2283db92ffb1794d0fc3dc0c51'],
  ['Delete', '89abed47eed3b3a706ee323824f9dfdfe1cd39967bcdf257e52e44709d13b8ea'],
].map(([kind, digest]) => ({ kind, digest, path: `src/server/migration/localProtected${kind}Guard.prototype.postgres.test.ts` }));
const candidates = [
  ['entry', 'BEFORE INSERT OR UPDATE', 'ROW'], ['evidence', 'BEFORE UPDATE', 'ROW'],
  ['exit', 'AFTER UPDATE', 'ROW'], ['delete', 'BEFORE DELETE', 'ROW'], ['truncate', 'BEFORE TRUNCATE', 'STATEMENT'],
].map(([kind, timing, level]) => ({ kind, timing, level, fn: `guard_migration_job_protected_${kind}`,
  trigger: `migration_jobs_protected_${kind}_guard` }));
const MAIN = '20000000-0000-4000-8000-000000000201';
const MISSING = '20000000-0000-4000-8000-000000000202';
const ACTIVE = '20000000-0000-4000-8000-000000000203';
const FOREIGN = '20000000-0000-4000-8000-000000000204';
const USER = '20000000-0000-4000-8000-000000000205';
const SUBJECT = 'four-guard-synthetic-subject';
const SOURCE = 'a'.repeat(64), FINAL = 'b'.repeat(64);
const migrationPaths = readdirSync('src/server/db/migrations').filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map(name => join('src/server/db/migrations', name));
const watched = ['.git/index', SELF, 'AGENTS.md', 'package.json', 'vitest.config.mts', 'tsconfig.json',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c', 'src/server/db/transaction.ts',
  'src/server/migration/cutover.ts', 'src/server/migration/cutover.test.ts', 'src/server/migration/importer.ts',
  'src/server/migration/validators.ts', 'src/server/migration/localActivationCompatibility.test.ts',
  'src/server/repositories/database/studentCommands.ts', 'src/server/repositories/database/operationAudit.ts',
  'src/server/repositories/factory.ts', 'src/server/repositories/context.ts',
  '/home/haeon/workhub-tasks/live/class-store-supervision/secondbot-guard-integration-audit-20260926.md',
  ...PROTOTYPES.map(p => p.path), ...migrationPaths];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(watched.map(path => [path, hash(readFileSync(path))]));
type Stored = { row: Record<string, unknown>; xmin: string };
type State = Record<string, Stored[]>;
type Failure = { message?: string; code?: string; constraint?: string; schema?: string; table?: string; where?: string; cause?: unknown };
type Context = { actor: string; login: string; tenant: string; xid: string; stamp: string; pid: number };
function errorTrail(error: unknown) {
  const result: Omit<Failure, 'cause'>[] = [], seen = new Set<unknown>();
  for (let cursor = error; cursor && typeof cursor === 'object' && !seen.has(cursor) && result.length < 8;) {
    seen.add(cursor);
    const e = cursor as Failure;
    // Drizzle query text/parameters are not diagnostic provenance. SQL errors and
    // the service's exact internal binding/actor messages are sufficient here.
    result.push({ code: e.code, constraint: e.constraint, schema: e.schema, table: e.table, where: e.where,
      message: e.code || ['binding', 'actor'].includes(e.message ?? '') ? e.message : undefined });
    cursor = e.cause;
  }
  return result;
}
function extract(p: typeof PROTOTYPES[number]) {
  const bytes = readFileSync(p.path), text = bytes.toString('utf8');
  expect(hash(bytes), `${p.kind} reviewed source`).toBe(p.digest);
  const start = `CREATE FUNCTION public.guard_migration_job_protected_${p.kind.toLowerCase()}()`;
  expect(text.split(start)).toHaveLength(2);
  const from = text.indexOf(start), end = text.indexOf('`);', from);
  expect(end).toBeGreaterThan(from);
  const literal = text.slice(from, end);
  expect(literal).not.toContain('${');
  expect(literal).not.toContain('\\');
  expect(literal.match(/CREATE FUNCTION /g)).toHaveLength(p.kind === 'Delete' ? 2 : 1);
  expect(literal.match(/CREATE TRIGGER /g)).toHaveLength(p.kind === 'Delete' ? 2 : 1);
  return { ...p, literal, sqlHash: hash(literal) };
}

// No suite import and no eager infrastructure use when the explicit opt-in is absent.
describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('four exact guards: real internal service compatibility on synthetic PG17', () => {
  let database: DisposablePostgres | undefined;
  let sourceBefore: ReturnType<typeof hashes>;
  let schemaBefore: Awaited<ReturnType<typeof catalog>>;
  let installed: Awaited<ReturnType<typeof guardCatalog>>;
  let seeded: State;
  let ownerPid: number;
  let literals: ReturnType<typeof extract>[];
  const facts: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = { authority: 'NONAUTHORITY', deployed: false, task19Accepted: false,
    task23Accepted: false, operationalIdentity: 'NOT_TESTED', externalWriterExclusion: 'NOT_PROVEN',
    externalCleanup: 'NOT_PERFORMED', productionAcl: 'NOT_TESTED', activeCompatibility: 'NOT_TESTED' };
  const externalFetch = vi.fn(async () => { throw Error('External fetch forbidden in synthetic service compatibility test'); });
  const db = () => { if (!database) throw Error('Owned PG17 setup incomplete'); return database; };
  async function snapshot(): Promise<State> {
    const tables = (await db().owner.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const state: State = {};
    for (const { tablename } of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw Error('Unexpected synthetic relation');
      state[tablename] = (await db().owner.query<Stored>(`SELECT to_jsonb(t) AS row,xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return state;
  }
  async function catalog() {
    return {
      roles: (await db().owner.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows,
      memberships: (await db().owner.query('SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor')).rows,
      relations: (await db().owner.query("SELECT relname,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows,
      columns: (await db().owner.query("SELECT attrelid::regclass::text AS relation,attname,attacl::text FROM pg_attribute WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY relation,attnum")).rows,
      policies: (await db().owner.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
      functions: (await db().owner.query(`SELECT oid::regprocedure::text AS signature,proowner::text,proacl::text,pg_get_functiondef(oid) AS definition
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND NOT (proname=ANY($1::text[])) ORDER BY signature`, [candidates.map(c => c.fn)])).rows,
      triggers: (await db().owner.query(`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) AND NOT (tgname=ANY($1::text[])) ORDER BY relation,tgname`, [candidates.map(c => c.trigger)])).rows,
      constraints: (await db().owner.query("SELECT conrelid::regclass::text AS relation,conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname,contype")).rows,
    };
  }
  async function guardCatalog() {
    return (await db().owner.query(`SELECT t.tgname,t.tgenabled,t.tgdeferrable,t.tginitdeferred,p.proname,p.prosrc,p.prosecdef,p.proconfig,
      pg_get_userbyid(p.proowner) AS owner,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='public.migration_jobs'::regclass AND t.tgname=ANY($1::text[]) ORDER BY t.tgname`, [candidates.map(c => c.trigger)])).rows;
  }
  async function context(tx: TenantTransaction, tenant: string): Promise<Context> {
    const result = await tx.execute(sql`SELECT current_user AS actor,session_user AS login,current_setting('app.tenant_id') AS tenant,
      pg_current_xact_id()::text AS xid,to_jsonb(transaction_timestamp()) AS stamp,pg_backend_pid() AS pid,
      r.rolsuper,r.rolbypassrls,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
      pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
      has_table_privilege(current_user,c.oid,'TRUNCATE') AS can_truncate
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='public.migration_jobs'::regclass`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', tenant, owner: 'postgres',
      rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
      relrowsecurity: true, relforcerowsecurity: true, can_truncate: false });
    expect(result.rows[0].pid).not.toBe(ownerPid);
    expect(result.rows[0].xid).toMatch(/^\d+$/);
    expect((await tx.execute(sql`SELECT id FROM tenants WHERE id=${FOREIGN}`)).rows).toEqual([]);
    return result.rows[0] as Context;
  }
  async function readback(tenant: string, job: string, state: State) {
    await db().runTenantTransaction(tenant, async tx => {
      await context(tx, tenant);
      expect((await tx.execute(sql`SELECT to_jsonb(t) AS row,xmin::text FROM tenants t WHERE id=${tenant}`)).rows)
        .toEqual(state.tenants.filter(e => e.row.id === tenant));
      for (const table of ['migration_jobs', 'migration_sources', 'migration_source_records', 'migration_snapshots', 'audit_events']) {
        expect((await tx.execute(sql`SELECT to_jsonb(t) AS row,xmin::text FROM ${sql.identifier(table)} t
          WHERE tenant_id=${tenant} AND job_id=${job} ORDER BY to_jsonb(t)::text`)).rows)
          .toEqual(state[table].filter(e => e.row.tenant_id === tenant && e.row.job_id === job));
      }
    });
  }
  function intent(job: string): CutoverAbortIntent {
    return { migrationJobId: job, expectedStatus: 'FINAL_IMPORT', expectedStateVersion: '7', expectedSourceFingerprint: SOURCE };
  }
  function service(tenant: string) {
    const contexts: Context[] = [], failures: ReturnType<typeof errorTrail>[] = [];
    const subject = vi.fn(async () => SUBJECT);
    // Transparent observation at the documented dependency seam: actual runner,
    // actual Drizzle tx and unchanged callback. No result/query substitution.
    const runner: TenantImportTransactionRunner = (id, callback) => db().runTenantTransaction(id, async tx => {
      contexts.push(await context(tx, id));
      try { return await callback(tx); }
      catch (error) { failures.push(errorTrail(error)); throw error; }
    });
    return { contexts, failures, subject, abort: createLegacyCutoverAbortService({ tenantId: tenant,
      getAuthenticatedSubject: subject, runTransaction: runner }) };
  }
  async function commitAbort(job: string) {
    const before = await snapshot(), call = service(MAIN);
    const old = before.migration_jobs.filter(e => e.row.tenant_id === MAIN && e.row.job_id === job);
    expect(old).toHaveLength(1);
    expect(old[0].row).toMatchObject({ status: 'FINAL_IMPORT', state_version: 7, completed_at: null });
    await readback(MAIN, job, before);
    const result = await call.abort(intent(job));
    expect(call.subject).toHaveBeenCalledTimes(1);
    expect(call.failures).toEqual([]);
    expect(call.contexts).toHaveLength(1);
    const meta = call.contexts[0], after = await snapshot();
    const nextVersion = String(BigInt(intent(job).expectedStateVersion) + BigInt(1));
    expect(result).toEqual({ status: 'ABORTED', stateVersion: nextVersion, auditEventId: expect.stringMatching(/^cutover-abort:[a-f0-9]{64}$/), externalCleanup: 'NOT_PERFORMED' });
    const actual = after.migration_jobs.filter(e => e.row.tenant_id === MAIN && e.row.job_id === job);
    expect(actual).toEqual([{ row: { ...old[0].row, status: 'ABORTED', state_version: Number(nextVersion),
      completed_at: meta.stamp, updated_at: meta.stamp }, xmin: meta.xid }]);
    const audit = after.audit_events.filter(e => e.row.event_id === result.auditEventId);
    expect(audit).toEqual([{ row: { tenant_id: MAIN, event_id: result.auditEventId, job_id: job, actor_user_id: USER,
      event_type: 'MIGRATION_CUTOVER_ABORTED', operation_id: null, entity_type: null, entity_id: null,
      redacted_details: { previousStatus: 'FINAL_IMPORT', previousStateVersion: '7', sourceFingerprint: SOURCE, externalCleanup: 'NOT_PERFORMED' },
      occurred_at: meta.stamp }, xmin: meta.xid }]);
    for (const table of Object.keys(before)) {
      const keep = (e: Stored) => table === 'migration_jobs' ? !(e.row.tenant_id === MAIN && e.row.job_id === job)
        : table === 'audit_events' ? e.row.event_id !== result.auditEventId : true;
      expect(after[table].filter(keep), `preserved ${table}`).toEqual(before[table].filter(keep));
    }
    await readback(MAIN, job, after);
    facts.push({ phase: 'REAL_SERVICE_COMMITTED', job, result, context: meta,
      persistedJob: actual, audit, allOtherRowsAndXminPreserved: true, caller: 'SYNTHETIC_DEPENDENCY_NOT_OPERATIONAL_IDENTITY' });
    return meta;
  }

  beforeAll(async () => {
    sourceBefore = hashes();
    literals = PROTOTYPES.map(extract);
    vi.stubGlobal('fetch', externalFetch);
    database = await createDisposablePostgres();
    evidence.infrastructure = database.evidence;
    expect(database.evidence).toMatchObject({ runId: database.runId, ownerLabel: 'io.class-store.synthetic-pg-owner', networkMode: 'none',
      publishedPorts: 0, hostBinds: 0, existingVolumes: 0, readOnlyRoot: true, droppedCapabilities: ['ALL'], noNewPrivileges: true });
    expect(database.evidence.version).toMatch(/^17\./);
    expect(database.evidence.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(database.evidence.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(database.evidence.migrations).toEqual(migrationPaths.map(path => ({ name: path.split('/').at(-1), sha256: sourceBefore[path] })));
    const owner = (await database.owner.query('SELECT current_user AS actor,session_user AS login,pg_backend_pid() AS pid')).rows[0];
    expect(owner).toMatchObject({ actor: 'postgres', login: 'postgres' }); ownerPid = owner.pid;
    expect((await database.owner.query('SELECT * FROM tenants')).rows).toEqual([]);
    expect((await database.owner.query('SELECT * FROM migration_jobs')).rows).toEqual([]);
    expect(await guardCatalog()).toEqual([]);
    schemaBefore = await catalog();
    await database.owner.query(`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES
      ($1,'four-main','Synthetic abort','IMPORTING'),($2,'four-no-member','Synthetic nonmember','IMPORTING'),
      ($3,'four-active','Preexisting synthetic ACTIVE','ACTIVE'),($4,'four-foreign','Foreign synthetic sentinel','ACTIVE')`, [MAIN, MISSING, ACTIVE, FOREIGN]);
    await database.owner.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,$2,'four-owner@example.invalid')", [USER, SUBJECT]);
    await database.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [MAIN, USER]);
    const jobs = [[MAIN, 'normal'], [MAIN, 'stale'], [MAIN, 'post-abort'], [MISSING, 'missing-member'], [ACTIVE, 'active-history'], [FOREIGN, 'foreign-history']];
    for (const [tenant, job] of jobs) {
      const status = [ACTIVE, FOREIGN].includes(tenant) ? 'ACTIVE' : 'FINAL_IMPORT';
      await database.owner.query(`INSERT INTO migration_jobs(tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
        created_at,freeze_started_at,freeze_verified_at,completed_at,updated_at) VALUES($1,$2,$3,7,$4,$5,
        '2026-08-01T00:00:00.123456Z','2026-08-01T00:10:00.123456Z','2026-08-01T00:20:00.123456Z',
        CASE WHEN $3='ACTIVE' THEN '2026-08-01T00:30:00.123456Z'::timestamptz ELSE NULL END,'2026-08-01T00:40:00.123456Z')`, [tenant, job, status, SOURCE, FINAL]);
      await database.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
        VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5)`, [tenant, job, `source-${job}`, `${tenant}/${job}`, 'c'.repeat(64)]);
      await database.owner.query(`INSERT INTO migration_source_records(tenant_id,job_id,source_id,record_id,source_collection,source_record_id,
        source_row_hash,redacted_record,canonical_record,mapping_status,error_details) VALUES($1,$2,$3,$4,'Synthetic','1',$5,
        '{"synthetic":true}','{"preserved":true}','QUARANTINED','["SYNTHETIC_ONLY"]')`, [tenant, job, `source-${job}`, `record-${job}`, SOURCE]);
      await database.owner.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
        VALUES($1,$2,$3,$4,'PREFLIGHT',$5,'{"synthetic":true}',1)`, [tenant, job, `source-${job}`, `snapshot-${job}`, SOURCE]);
    }
    await database.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'rollback-witness','DISCOVERED')", [MAIN]);
    seeded = await snapshot();
    const client = await database.owner.connect();
    try {
      await client.query('BEGIN');
      for (const p of literals) await client.query(p.literal);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    expect(await snapshot()).toEqual(seeded);
    expect(await catalog()).toEqual(schemaBefore);
    installed = await guardCatalog();
    evidence.exactPrototypeSql = literals.map(({ kind, digest, sqlHash }) => ({ kind, sourceHash: digest, sqlHash }));
  }, 0);

  afterAll(async () => {
    try {
      if (database && installed) expect(await guardCatalog()).toEqual(installed);
      if (database && schemaBefore) expect(await catalog()).toEqual(schemaBefore);
      if (database && seeded) {
        const end = await snapshot();
        for (const table of Object.keys(seeded)) {
          const foreign = (e: Stored) => table === 'tenants' ? e.row.id === FOREIGN : e.row.tenant_id === FOREIGN;
          expect(end[table].filter(foreign)).toEqual(seeded[table].filter(foreign));
        }
        evidence.foreignRowsAndXminPreserved = true;
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
        evidence.sourceHashesUnchanged = JSON.stringify(after) === JSON.stringify(sourceBefore);
        evidence.unexpectedExternalFetches = externalFetch.mock.calls.length;
        process.stdout.write('LOCAL_FOUR_GUARD_SERVICE_COMPATIBILITY ' + JSON.stringify({ ...evidence, facts }) + '\n');
        expect(after).toEqual(sourceBefore);
        expect(externalFetch).not.toHaveBeenCalled();
      }
    }
  }, 0);

  it('installs exact hash-pinned bodies and every candidate trigger without altering existing catalog or rows', async () => {
    expect(installed).toHaveLength(candidates.length);
    for (const c of candidates) {
      const rows = installed.filter(row => row.tgname === c.trigger);
      expect(rows).toHaveLength(1);
      const literal = literals.find(p => p.literal.includes(`CREATE FUNCTION public.${c.fn}()`))!.literal;
      const from = literal.indexOf(`CREATE FUNCTION public.${c.fn}()`), bodyStart = literal.indexOf('AS $$', from) + 'AS $$'.length;
      const bodyEnd = literal.indexOf('$$;', bodyStart);
      expect(rows[0]).toMatchObject({ proname: c.fn, prosrc: literal.slice(bodyStart, bodyEnd), prosecdef: false,
        proconfig: ['search_path=pg_catalog'], owner: 'postgres', tgenabled: 'O', tgdeferrable: false, tginitdeferred: false });
      expect(rows[0].definition).toBe(`CREATE TRIGGER ${c.trigger} ${c.timing} ON public.migration_jobs FOR EACH ${c.level} EXECUTE FUNCTION ${c.fn}()`);
    }
    evidence.candidateCatalog = installed.map(({ prosrc, ...row }) => ({ ...row, bodyHash: hash(String(prosrc)) }));
  }, 0);

  it('commits the actual FINAL_IMPORT abort with audit, first completion and preserved children', async () => {
    await commitAbort('normal');
  }, 0);

  for (const kind of ['stale', 'missing-member'] as const) it(`rejects real service ${kind} without mutation at its distinct service gate`, async () => {
    const tenant = kind === 'stale' ? MAIN : MISSING, before = await snapshot(), call = service(tenant);
    await readback(tenant, kind, before);
    expect(before.migration_jobs.filter(e => e.row.tenant_id === tenant && e.row.job_id === kind))
      .toEqual([expect.objectContaining({ row: expect.objectContaining({ status: 'FINAL_IMPORT', state_version: 7, source_fingerprint: SOURCE }) })]);
    await db().runTenantTransaction(tenant, async tx => {
      const actors = await tx.execute(sql`SELECT u.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=${tenant} AND u.google_subject=${SUBJECT} AND m.role IN ('OWNER','ADMIN')`);
      expect(actors.rows).toEqual(kind === 'stale' ? [{ id: USER }] : []);
    });
    await expect(call.abort({ ...intent(kind), expectedStateVersion: kind === 'stale' ? '6' : '7' })).rejects.toThrow('Cutover abort refused.');
    expect(call.subject).toHaveBeenCalledTimes(1);
    expect(call.contexts).toHaveLength(1);
    expect(call.failures).toEqual([[expect.objectContaining({ message: kind === 'stale' ? 'binding' : 'actor', code: undefined })]]);
    expect(await snapshot()).toEqual(before);
    await readback(tenant, kind, before);
    facts.push({ phase: 'SERVICE_REFUSAL_NOT_GUARD_PROOF', kind, contexts: call.contexts, failures: call.failures, allRowsAndXminUnchanged: true });
  }, 0);

  it('rejects actual post-service ABORT rewrite and DELETE in separate transactions, rolling back a witnessed update', async () => {
    const committed = await commitAbort('post-abort');
    for (const action of ['rewrite', 'delete'] as const) {
      const before = await snapshot(); let caught: unknown, attempted: Context | undefined, witnessed = false;
      try {
        await db().runTenantTransaction(MAIN, async tx => {
          attempted = await context(tx, MAIN);
          expect(attempted.xid).not.toBe(committed.xid);
          expect((await tx.execute(sql`SELECT status FROM migration_jobs WHERE tenant_id=${MAIN} AND job_id='post-abort'`)).rows).toEqual([{ status: 'ABORTED' }]);
          const changed = await tx.execute(sql`UPDATE migration_jobs SET status='VALIDATED',state_version=state_version+1,updated_at=now()
            WHERE tenant_id=${MAIN} AND job_id='rollback-witness' RETURNING job_id,status,state_version::text`);
          expect(changed.rows).toEqual([{ job_id: 'rollback-witness', status: 'VALIDATED', state_version: '2' }]);
          expect((await tx.execute(sql`SELECT status FROM migration_jobs WHERE tenant_id=${MAIN} AND job_id='rollback-witness'`)).rows).toEqual([{ status: 'VALIDATED' }]);
          witnessed = true;
          if (action === 'rewrite') await tx.execute(sql`UPDATE migration_jobs SET source_fingerprint=${'d'.repeat(64)},updated_at=now()
            WHERE tenant_id=${MAIN} AND job_id='post-abort' RETURNING job_id,status,source_fingerprint`);
          else await tx.execute(sql`DELETE FROM migration_jobs WHERE tenant_id=${MAIN} AND job_id='post-abort' RETURNING job_id,status`);
        });
      } catch (error) { caught = error; }
      const trail = errorTrail(caught), kind = action === 'rewrite' ? 'exit' : 'delete';
      facts.push({ phase: 'POST_ABORT_GUARD_REFUSAL', action, committedXid: committed.xid, context: attempted, witnessed, trail });
      expect(witnessed).toBe(true);
      expect(trail).toEqual(expect.arrayContaining([expect.objectContaining({ code: '42501', schema: 'public', table: 'migration_jobs',
        constraint: `migration_jobs_protected_${kind}_guard`, where: expect.stringContaining(`guard_migration_job_protected_${kind}()`),
        message: action === 'rewrite' ? 'Prototype protected migration job exit evidence change refused.' : 'Prototype protected migration job deletion refused.' })]));
      expect(await snapshot()).toEqual(before);
      await readback(MAIN, 'post-abort', before);
    }
  }, 0);

  it('preserves preexisting ACTIVE student creation and exact operationId retry via real repository and runner', async () => {
    const before = await snapshot(), contexts: Context[] = [];
    const runner: TenantImportTransactionRunner = (tenant, callback) => db().runTenantTransaction(tenant, async tx => {
      contexts.push(await context(tx, tenant)); return callback(tx);
    });
    const tenants = await db().runTenantTransaction(ACTIVE, tx => tx.execute(sql`SELECT id,lifecycle FROM tenants WHERE id=${ACTIVE}`));
    expect(tenants.rows).toEqual([{ id: ACTIVE, lifecycle: 'ACTIVE' }]);
    const repository = await resolveRepositoryFromEnv({ CLASS_STORE_STORAGE: 'postgresql' },
      { tenantId: String(tenants.rows[0].id), tenantStatus: String(tenants.rows[0].lifecycle) }, {
        createPostgresql: authority => createDatabaseStudentCommands({ tenantId: authority.tenantId, runTenantTransaction: runner }),
        createSheets: () => { throw Error('Sheets fallback forbidden'); },
      });
    const input = { operationId: 'four-guard-student-create', studentId: 'SYNTHETIC-FOUR-STUDENT', name: 'Synthetic student', balance: 25, status: 'ACTIVE' as const };
    const result = await repository.adapter.create(input);
    expect(result).toMatchObject({ ok: true, operationId: input.operationId, action: 'CREATE',
      students: [{ studentId: input.studentId, name: input.name, status: 'ACTIVE', balance: 25, balanceAfter: 25 }] });
    const after = await snapshot();
    const permitted = new Set(['students', 'accounts', 'operations', 'transactions', 'adjustments', 'audit_events']);
    for (const table of Object.keys(before)) {
      const keep = (e: Stored) => !(permitted.has(table) && e.row.tenant_id === ACTIVE);
      expect(after[table].filter(keep), `ACTIVE preserves ${table}`).toEqual(before[table].filter(keep));
      if (permitted.has(table)) expect(after[table].filter(e => e.row.tenant_id === ACTIVE)).toHaveLength(1);
    }
    expect(after.transactions.find(e => e.row.tenant_id === ACTIVE)?.row).toMatchObject({ transaction_id: result.students[0].transactionId,
      student_id: input.studentId, kind: 'ADMIN_ADJUSTMENT', balance_before: 0, balance_after: 25, balance_delta: 25 });
    expect(after.operations.find(e => e.row.tenant_id === ACTIVE)?.row).toMatchObject({ operation_id: input.operationId, status: 'SUCCEEDED', result_snapshot: result });
    await db().runTenantTransaction(ACTIVE, async tx => {
      for (const table of permitted) expect((await tx.execute(sql`SELECT to_jsonb(t) AS row,xmin::text FROM ${sql.identifier(table)} t
        WHERE tenant_id=${ACTIVE} ORDER BY to_jsonb(t)::text`)).rows).toEqual(after[table].filter(e => e.row.tenant_id === ACTIVE));
      expect((await tx.execute(sql`SELECT s.student_id,s.name,s.status,a.balance::text FROM students s JOIN accounts a USING(tenant_id,student_id)
        WHERE s.tenant_id=${ACTIVE} AND s.student_id=${input.studentId}`)).rows)
        .toEqual([{ student_id: input.studentId, name: input.name, status: 'ACTIVE', balance: '25' }]);
    });
    expect(await repository.adapter.create(input)).toEqual(result);
    expect(await snapshot()).toEqual(after);
    expect(contexts).toHaveLength(2);
    expect(contexts[1].xid).not.toBe(contexts[0].xid);
    await readback(ACTIVE, 'active-history', after);
    await db().runTenantTransaction(MAIN, async tx => {
      expect((await tx.execute(sql`SELECT student_id FROM students WHERE tenant_id=${ACTIVE}`)).rows).toEqual([]);
    });
    evidence.activeCompatibility = 'PREEXISTING_ACTIVE_CREATE_AND_IDENTICAL_RETRY_VERIFIED_NOT_ACTIVATION';
    facts.push({ phase: 'ACTIVE_INTERNAL_REPOSITORY', result, contexts, sameOperationRetryRowsAndXminUnchanged: true });
  }, 0);
});
