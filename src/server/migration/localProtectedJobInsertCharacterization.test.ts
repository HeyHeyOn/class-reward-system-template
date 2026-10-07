// @vitest-environment node
// CHARACTERIZATION ONLY: SQL acceptance is NOT a valid cutover or a security fix.
// In-memory PGlite, unchanged production migrations and existing harness grants.
// The setup owner seeds only DRAFT tenants, never the protected jobs under test.
// All measured INSERTs use app_runtime + tenant GUC via SET LOCAL ROLE, not an
// independent PostgreSQL login. Hashes/timestamps are FAKE evidence, not receipts,
// an authenticated importer, a verified freeze, or activation authority.
// No actual PostgreSQL concurrency or maintained external writer exclusion is proven.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';

vi.mock('server-only', () => ({}));

const directory = 'src/server/db/migrations';
const migrationNames = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'AGENTS.md', 'package.json', 'vitest.config.mts', 'tsconfig.json',
  'src/server/db/testing/pglite.ts', 'src/server/db/transaction.ts',
  'src/server/migration/localProtectedJobEvidenceMutation.test.ts',
  ...migrationNames.map((name) => join(directory, name))];
const hashes = () => Object.fromEntries(watched.map((path) =>
  [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const initialHashes = hashes();
const SOURCE = 'a'.repeat(64);
const FINAL = 'b'.repeat(64);
const at = (minute: string) => `2026-08-01T00:${minute}:00+00:00`;
const MISSING_TENANT = '20000000-0000-4000-8000-000000000099';
type ProtectedStatus = 'FINAL_IMPORT' | 'ACTIVE';
type Job = {
  tenant_id: string; job_id: string; status: ProtectedStatus; state_version: string | null;
  source_fingerprint: string | null; final_fingerprint: string | null;
  created_at: string; freeze_started_at: string | null; freeze_verified_at: string | null;
  completed_at: string | null; updated_at: string;
};
type Stored = { row: Record<string, unknown>; xmin: string };
type SqlFailure = { code: string; constraint?: string; column?: string; message?: string };
const facts: Array<Record<string, unknown>> = [];

function errors(error: unknown) {
  const result: Array<{ message: string; code?: unknown; constraint?: unknown; column?: unknown }> = [];
  const seen = new Set<unknown>();
  for (let cursor = error; cursor && !seen.has(cursor) && result.length < 8;) {
    seen.add(cursor);
    if (typeof cursor !== 'object') break;
    const e = cursor as { message?: string; code?: unknown; constraint?: unknown; column?: unknown; cause?: unknown };
    result.push({ message: String(e.message), code: e.code, constraint: e.constraint, column: e.column });
    cursor = e.cause;
  }
  return result;
}

async function schemaState(h: PgliteDatabaseHarness) {
  return {
    roles: (await h.database.query('SELECT rolname,rolsuper,rolbypassrls,rolinherit FROM pg_roles ORDER BY rolname')).rows,
    tables: (await h.database.query(`SELECT relname,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity
      FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname`)).rows,
    triggers: (await h.database.query(`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
      ORDER BY relation,tgname`)).rows,
    constraints: (await h.database.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY relation,conname`)).rows,
    policies: (await h.database.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
    transition: (await h.database.query("SELECT pg_get_functiondef('enforce_migration_job_transition()'::regprocedure) AS definition")).rows,
  };
}

// Owner SELECT after commit/rollback sees even rows hidden from runtime by RLS.
// Compare all public rows and xmin, not sequences or any external system state.
async function state(h: PgliteDatabaseHarness) {
  const result: Record<string, Stored[]> = {};
  const { rows: tables } = await h.database.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for (const { tablename } of tables) {
    expect(tablename).toMatch(/^[a-z_][a-z0-9_]*$/);
    result[tablename] = (await h.database.query<Stored>(`SELECT row_to_json(t) AS row,xmin::text FROM public."${tablename}" t`)).rows
      .sort((a, b) => JSON.stringify(a.row).localeCompare(JSON.stringify(b.row)));
  }
  return result;
}

function insert(tx: TenantTransaction, job: Job, defaultVersion = false) {
  return tx.execute(sql`INSERT INTO migration_jobs
    (tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
     created_at,freeze_started_at,freeze_verified_at,completed_at,updated_at)
    VALUES(${job.tenant_id},${job.job_id},${job.status},${defaultVersion ? sql`DEFAULT` : sql`${job.state_version}`},
      ${job.source_fingerprint},${job.final_fingerprint},${job.created_at},${job.freeze_started_at},
      ${job.freeze_verified_at},${job.completed_at},${job.updated_at})
    RETURNING tenant_id,job_id,status,state_version::text`);
}

for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) describe(`direct ${status} INSERT: NONAUTHORITY`, () => {
  let h: PgliteDatabaseHarness;
  let login: string;
  let schema: Awaited<ReturnType<typeof schemaState>>;
  let sequence = 0;

  beforeAll(async () => {
    h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
    // Baseline harness grants are made after 0008. Do not grant later tables or
    // weaken any policy/trigger to make these probes pass.
    for (const name of migrationNames.filter((name) => name.slice(0, 4) > '0008')) {
      await h.database.exec(readFileSync(join(directory, name), 'utf8'));
    }
    const { rows } = await h.database.query<{ actor: string; login: string; rolsuper: boolean }>(
      'SELECT current_user AS actor,session_user AS login,rolsuper FROM pg_roles WHERE rolname=current_user');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).not.toBe('app_runtime');
    expect(rows[0].rolsuper).toBe(true);
    login = rows[0].login;
    const initial = await state(h);
    expect(initial.migration_jobs).toEqual([]);
    expect(initial.tenants).toHaveLength(2);
    for (const tenant of initial.tenants) expect(tenant.row.lifecycle).toBe('DRAFT');
    for (const table of ['migration_sources', 'migration_snapshots', 'reconciliation_results', 'audit_events']) {
      expect(initial[table], table).toEqual([]);
    }
    schema = await schemaState(h);
  }, 120_000);

  afterAll(async () => {
    try { if (schema) expect(await schemaState(h)).toEqual(schema); }
    finally { await h?.close(); }
  }, 120_000);

  function candidate(overrides: Partial<Job> = {}): Job {
    return { tenant_id: h.tenantOneId, job_id: `direct-${status}-${++sequence}`, status, state_version: '7',
      source_fingerprint: SOURCE, final_fingerprint: FINAL, created_at: at('00'),
      freeze_started_at: at('10'), freeze_verified_at: at('20'),
      completed_at: status === 'ACTIVE' ? at('30') : null, updated_at: at('40'), ...overrides };
  }

  async function run<T>(callback: (tx: TenantTransaction) => Promise<T>, tenantId = h.tenantOneId) {
    return h.runTenantTransaction(tenantId, async (tx) => {
      const { rows } = await tx.execute(sql`SELECT current_user AS actor,session_user AS login,
        current_setting('app.tenant_id',true) AS tenant_id,r.rolsuper,r.rolbypassrls,
        pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'INSERT') AS can_insert
        FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='migration_jobs'::regclass`);
      expect(rows).toEqual([expect.objectContaining({ actor: 'app_runtime', login, tenant_id: tenantId,
        rolsuper: false, rolbypassrls: false, relrowsecurity: true, relforcerowsecurity: true, can_insert: true })]);
      expect(rows[0].owner).not.toBe('app_runtime');
      return callback(tx);
    });
  }

  async function allowed(label: string, job: Job, defaultVersion = false, tenantId = h.tenantOneId) {
    const before = await state(h);
    expect(before.migration_jobs.some(({ row }) => row.tenant_id === job.tenant_id && row.job_id === job.job_id)).toBe(false);
    const result = await run((tx) => insert(tx, job, defaultVersion), tenantId);
    const version = defaultVersion ? '1' : job.state_version;
    expect(result.rows).toEqual([{ tenant_id: job.tenant_id, job_id: job.job_id, status, state_version: version }]);
    const after = await state(h);
    const matches = after.migration_jobs.filter(({ row }) => row.tenant_id === job.tenant_id && row.job_id === job.job_id);
    expect(matches).toHaveLength(1);
    const saved = matches[0];
    const expected: Record<string, unknown> = { ...job, state_version: Number(version) };
    for (const field of ['created_at', 'freeze_started_at', 'freeze_verified_at', 'completed_at', 'updated_at'] as const) {
      if (job[field] === null) continue;
      // timestamptz JSON may use +09 even when the literal is +00.
      const expectedInstant = Date.parse(job[field]);
      const persistedInstant = Date.parse(String(saved.row[field]));
      expect(Number.isFinite(expectedInstant) && Number.isFinite(persistedInstant)).toBe(true);
      expect(persistedInstant, field).toBe(expectedInstant);
      expected[field] = saved.row[field];
    }
    expect(saved.row).toEqual(expected);
    expect(after.migration_jobs.filter((item) => item !== saved)).toEqual(before.migration_jobs);
    for (const table of Object.keys(before).filter((name) => name !== 'migration_jobs')) expect(after[table], table).toEqual(before[table]);
    for (const tenant of after.tenants) expect(tenant.row.lifecycle).toBe('DRAFT');
    facts.push({ status, case: label, observed: 'RUNTIME_INSERT_COMMITTED_NOT_VALID_CUTOVER',
      persisted: saved.row, unrelatedRowsAndTenantLifecycleUnchanged: true });
  }

  async function denied(label: string, action: () => Promise<unknown>, expected: SqlFailure) {
    const before = await state(h);
    let caught: unknown;
    try { await action(); } catch (error) { caught = error; }
    const trail = errors(caught);
    expect(caught, label).toBeDefined();
    expect(trail).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
    expect(await state(h)).toEqual(before);
    facts.push({ status, case: label, observed: 'REJECTED_BY_EXISTING_SQL_BOUNDARY_NOT_NEW_GUARD',
      databaseError: trail.find((entry) => entry.code === expected.code), allPublicRowsAndXminUnchanged: true });
  }

  it('well-shaped fake evidence commits at explicit version 7 without any earlier job or source', async () => {
    await allowed('explicit version 7, fabricated evidence, no predecessor', candidate());
  }, 120_000);

  it('well-shaped fake evidence also commits at DEFAULT version 1: no INSERT transition history', async () => {
    await allowed('DEFAULT version 1, fabricated evidence', candidate(), true);
  }, 120_000);

  if (status === 'FINAL_IMPORT') {
    it('SQL permits minimal FINAL_IMPORT with no source/final hash or freeze timestamps', async () => {
      await allowed('minimal FINAL_IMPORT, no evidence', candidate({ source_fingerprint: null,
        final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null }), true);
    }, 120_000);
  } else {
    it('ACTIVE permits NULL source fingerprint when terminal shape is otherwise satisfied', async () => {
      await allowed('ACTIVE without source fingerprint', candidate({ source_fingerprint: null }));
    }, 120_000);
  }

  const refusals: Array<{ name: string; change: Partial<Job>; error: SqlFailure }> = [
    { name: 'blank job id', change: { job_id: ' ' }, error: { code: '23514', constraint: 'migration_jobs_id_check' } },
    { name: 'nontrimmed job id', change: { job_id: ' padded ' }, error: { code: '23514', constraint: 'migration_jobs_id_check' } },
    { name: 'version zero', change: { state_version: '0' }, error: { code: '23514', constraint: 'migration_jobs_state_version_check' } },
    { name: 'version above safe maximum', change: { state_version: '9007199254740992' },
      error: { code: '23514', constraint: 'migration_jobs_state_version_check' } },
    { name: 'NULL version is not DEFAULT', change: { state_version: null }, error: { code: '23502', column: 'state_version' } },
    { name: 'malformed source hash', change: { source_fingerprint: 'not-a-digest' }, error: { code: '23514', constraint: 'migration_jobs_hashes_check' } },
    { name: 'malformed final hash', change: { final_fingerprint: 'not-a-digest' }, error: { code: '23514', constraint: 'migration_jobs_hashes_check' } },
    { name: 'verification before start', change: { freeze_verified_at: at('09') }, error: { code: '23514', constraint: 'migration_jobs_freeze_shape_check' } },
    // ACTIVE also violates terminal shape here: report the actual first CHECK,
    // not an assertion that the other independent CHECK is absent.
    { name: 'verification without start', change: { freeze_started_at: null }, error: { code: '23514', constraint: 'migration_jobs_freeze_shape_check' } },
    { name: 'start before creation', change: { freeze_started_at: '2026-07-31T23:59:00+00:00' },
      error: { code: '23514', constraint: 'migration_jobs_chronology_check' } },
    { name: 'updated_at before evidence', change: { updated_at: at('19') }, error: { code: '23514', constraint: 'migration_jobs_chronology_check' } },
    { name: 'status-dependent completion nullability', change: { completed_at: status === 'ACTIVE' ? null : at('30') },
      error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
  ];
  if (status === 'ACTIVE') refusals.push(
    { name: 'ACTIVE lacks final fingerprint', change: { final_fingerprint: null }, error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
    { name: 'ACTIVE lacks verification', change: { freeze_verified_at: null }, error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
    { name: 'ACTIVE lacks both freeze timestamps', change: { freeze_started_at: null, freeze_verified_at: null },
      error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
    { name: 'ACTIVE completes before verification', change: { completed_at: at('19') }, error: { code: '23514', constraint: 'migration_jobs_chronology_check' } },
  );
  for (const { name, change, error } of refusals) it(`${name}: existing constraint, not activation authentication`, async () => {
    await denied(name, () => run((tx) => insert(tx, candidate(change))), error);
  }, 120_000);

  it('duplicate protected job is rejected by the tenant/job primary key, not transition history', async () => {
    const job = candidate();
    await allowed('runtime-created duplicate fixture, not owner seeding', job);
    await denied('duplicate job', () => run((tx) => insert(tx, job)), { code: '23505', constraint: 'migration_jobs_pkey' });
  }, 120_000);

  for (const target of ['existing-foreign', 'missing'] as const) it(`${target} tenant with mismatching GUC: RLS before FK`, async () => {
    const tenantId = target === 'existing-foreign' ? h.tenantTwoId : MISSING_TENANT;
    expect((await h.database.query('SELECT id FROM tenants WHERE id=$1', [tenantId])).rows)
      .toEqual(target === 'existing-foreign' ? [{ id: tenantId }] : []);
    await denied(`mismatching GUC, ${target} tenant`, () => run((tx) => insert(tx, candidate({ tenant_id: tenantId }))),
      { code: '42501', message: 'new row violates row-level security policy for table "migration_jobs"' });
  }, 120_000);

  it('matching but nonexistent tenant GUC reaches the tenant FK instead of RLS', async () => {
    expect((await h.database.query('SELECT id FROM tenants WHERE id=$1', [MISSING_TENANT])).rows).toEqual([]);
    await denied('matching GUC, missing parent tenant', () => run((tx) => insert(tx,
      candidate({ tenant_id: MISSING_TENANT })), MISSING_TENANT), { code: '23503', constraint: 'migration_jobs_tenant_fk' });
  }, 120_000);

  for (const guc of ['', 'not-a-uuid']) it(`${guc === '' ? 'empty' : 'malformed'} tenant GUC refuses INSERT at its own SQL boundary`, async () => {
    // Deliberately alter only the transaction-local GUC after the harness's valid
    // initial context. Empty exercises NULLIF, not a brand-new unset connection.
    await denied(`tenant GUC ${guc === '' ? 'empty' : 'malformed'}`, () => run(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id',${guc},true)`);
      expect((await tx.execute(sql`SELECT current_user AS actor,current_setting('app.tenant_id',true) AS tenant_id`)).rows)
        .toEqual([{ actor: 'app_runtime', tenant_id: guc }]);
      return insert(tx, candidate());
    }), guc === '' ? { code: '42501', message: 'new row violates row-level security policy for table "migration_jobs"' }
      : { code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' });
  }, 120_000);

  it('same job id can be inserted in each matching tenant context, and reads stay GUC-scoped', async () => {
    const first = candidate();
    const second = { ...first, tenant_id: h.tenantTwoId };
    await allowed('tenant one', first);
    await allowed('tenant two with its matching GUC', second, false, h.tenantTwoId);
    const beforeReads = await state(h);
    for (const tenantId of [h.tenantOneId, h.tenantTwoId]) {
      await run(async (tx) => {
        expect((await tx.execute(sql`SELECT tenant_id,job_id FROM migration_jobs WHERE job_id=${first.job_id}`)).rows)
          .toEqual([{ tenant_id: tenantId, job_id: first.job_id }]);
      }, tenantId);
    }
    expect(await state(h)).toEqual(beforeReads);
    // The harness can choose either GUC. This is not HTTP membership/issuer auth.
  }, 120_000);

  it('a later malformed INSERT rolls back an earlier well-shaped protected INSERT in the same transaction', async () => {
    await denied('transaction rollback, no partially inserted protected job', () => run(async (tx) => {
      const job = candidate();
      expect((await insert(tx, job)).rows).toHaveLength(1);
      expect((await tx.execute(sql`SELECT job_id FROM migration_jobs WHERE job_id=${job.job_id}`)).rows)
        .toEqual([{ job_id: job.job_id }]);
      return insert(tx, candidate({ final_fingerprint: 'bad' }));
    }), { code: '23514', constraint: 'migration_jobs_hashes_check' });
  }, 120_000);
});

afterAll(() => {
  const finalHashes = hashes();
  expect(finalHashes).toEqual(initialHashes);
  console.info('LOCAL_PROTECTED_JOB_INSERT_CHARACTERIZATION ' + JSON.stringify({
    authority: 'NONAUTHORITY', complete: false, activationAllowed: false, securityFix: false,
    engine: 'synthetic in-memory PGlite', actualPostgreSQL: false, externalWriterExclusion: 'NOT_PROVEN',
    runtimeIdentity: 'APP_RUNTIME_SET_ROLE_WITH_TENANT_GUC_NOT_INDEPENDENT_LOGIN',
    setup: 'OWNER_SEEDED_DRAFT_TENANTS_ONLY_PROTECTED_JOBS_INSERTED_BY_RUNTIME',
    evidence: 'FABRICATED_HASHES_AND_TIMESTAMPS_NO_AUTHENTIC_FREEZE_OR_APPROVAL',
    scope: 'DIRECT_INSERT_ONLY_NOT_UPDATE_COPY_UPSERT_CONCURRENCY_OR_BUSINESS_COMPATIBILITY',
    unchangedFileHashes: finalHashes, facts,
  }));
});
