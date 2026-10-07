// @vitest-environment node
// CHARACTERIZATION ONLY: passing means today's SQL behavior was observed, NOT
// that protected-job safety is fixed or that activation/cutover is authorized.
// Synthetic in-memory PGlite; unchanged migrations and existing harness grants.
// Setup owner seeds protected jobs directly: no real importer/freeze/receipt.
// Every measured mutation uses app_runtime + tenant GUC (not a separate login).
// Future reviewed policy may reject evidence/identity changes while preserving
// exact retries/updated_at. Existing ACTIVE repository/business compatibility is
// a separate contract in localActivationCompatibility.test.ts, not re-proven here.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';

vi.mock('server-only', () => ({}));

const directory = 'src/server/db/migrations';
const migrationNames = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'AGENTS.md', 'package.json', 'vitest.config.mts', 'tsconfig.json',
  'src/server/db/testing/pglite.ts', 'src/server/db/transaction.ts',
  'src/server/migration/localActivationCompatibility.test.ts', ...migrationNames.map((name) => join(directory, name))];
const hashes = () => Object.fromEntries(watched.map((path) =>
  [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const initialHashes = hashes();
const SOURCE = 'a'.repeat(64);
const FINAL = 'b'.repeat(64);
const REWRITE = 'c'.repeat(64);
const at = (minute: string) => `2026-08-01T00:${minute}:00+00:00`;
const MISSING_TENANT = '20000000-0000-4000-8000-000000000099';
type ProtectedStatus = 'FINAL_IMPORT' | 'ACTIVE';
type Stored = { row: Record<string, unknown>; xmin: string };
type SqlFailure = { code: string; constraint?: string; message?: string };
type Fixture = { h: PgliteDatabaseHarness; status: ProtectedStatus; jobId: string; login: string };
const facts: Array<Record<string, unknown>> = [];

// Follow Drizzle's cause without mistaking an assertion/setup failure for a DB
// refusal. The SQLSTATE plus exact constraint/message must match the case.
function errors(error: unknown) {
  const result: Array<{ message: string; code?: unknown; constraint?: unknown }> = [];
  const seen = new Set<unknown>();
  for (let cursor = error; cursor && !seen.has(cursor) && result.length < 8;) {
    seen.add(cursor);
    if (typeof cursor !== 'object') break;
    const e = cursor as { message?: string; code?: unknown; constraint?: unknown; cause?: unknown };
    result.push({ message: String(e.message), code: e.code, constraint: e.constraint });
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
  };
}

// Owner readback sees all tenants, including rows hidden by runtime RLS. Include
// xmin so failed transactions cannot pass merely because values were restored.
// This says nothing about sequences, concurrent sessions or external systems.
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

async function run<T>(f: Fixture, callback: (tx: TenantTransaction) => Promise<T>, tenantId = f.h.tenantOneId) {
  return f.h.runTenantTransaction(tenantId, async (tx) => {
    const { rows } = await tx.execute(sql`SELECT current_user AS actor,session_user AS login,
      current_setting('app.tenant_id',true) AS tenant_id,r.rolsuper,r.rolbypassrls,
      pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
      has_table_privilege(current_user,c.oid,'UPDATE') AS can_update
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='migration_jobs'::regclass`);
    expect(rows).toEqual([expect.objectContaining({ actor: 'app_runtime', login: f.login, tenant_id: tenantId,
      rolsuper: false, rolbypassrls: false, relrowsecurity: true, relforcerowsecurity: true, can_update: true })]);
    expect(rows[0].owner).not.toBe('app_runtime');
    return callback(tx);
  });
}

async function seed(f: Fixture, referenced = true) {
  await f.h.database.query(`INSERT INTO migration_jobs
    (tenant_id,job_id,status,state_version,source_fingerprint,final_fingerprint,
     created_at,freeze_started_at,freeze_verified_at,completed_at,updated_at)
    VALUES($1,$2,$3,7,$4,$5,$6,$7,$8,$9,$10)`,
  [f.h.tenantOneId, f.jobId, f.status, SOURCE, FINAL, at('00'), at('10'), at('20'),
    f.status === 'ACTIVE' ? at('30') : null, at('40')]);
  if (referenced) await f.h.database.query(`INSERT INTO migration_sources
    (tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
    VALUES($1,$2,$3,'GOOGLE_SHEETS',$3,$4)`, [f.h.tenantOneId, f.jobId, `synthetic-${f.jobId}`, SOURCE]);
}

function selectJob(rows: Stored[], tenantId: string, jobId: string) {
  const matches = rows.filter(({ row }) => row.tenant_id === tenantId && row.job_id === jobId);
  expect(matches).toHaveLength(1);
  return matches[0];
}

async function allowed(f: Fixture, label: string, set: SQL, changed: Record<string, unknown>) {
  const before = await state(f.h);
  const original = selectJob(before.migration_jobs, f.h.tenantOneId, f.jobId);
  const result = await run(f, (tx) => tx.execute(sql`UPDATE migration_jobs SET ${set}
    WHERE tenant_id=${f.h.tenantOneId} AND job_id=${f.jobId} RETURNING tenant_id,job_id,status,state_version::text`));
  expect(result.rows).toEqual([{ tenant_id: f.h.tenantOneId, job_id: changed.job_id ?? f.jobId,
    status: f.status, state_version: '7' }]);
  // Separate post-COMMIT owner SELECT, not merely the UPDATE's RETURNING clause.
  const after = await state(f.h);
  const saved = selectJob(after.migration_jobs, f.h.tenantOneId, String(changed.job_id ?? f.jobId));
  const expected = { ...original.row, ...changed };
  for (const field of ['created_at', 'freeze_started_at', 'freeze_verified_at', 'completed_at', 'updated_at']) {
    if (typeof changed[field] !== 'string') continue;
    const expectedInstant = Date.parse(changed[field]);
    const persistedInstant = Date.parse(String(saved.row[field]));
    expect(Number.isFinite(expectedInstant) && Number.isFinite(persistedInstant)).toBe(true);
    expect(persistedInstant, `${field} must retain the same instant despite DB timezone formatting`).toBe(expectedInstant);
    expected[field] = saved.row[field];
  }
  expect(saved.row).toEqual(expected);
  expect(saved.xmin).not.toBe(original.xmin);
  const otherJobs = (rows: Stored[], own: Stored) => rows.filter((item) => item !== own);
  expect(otherJobs(after.migration_jobs, saved)).toEqual(otherJobs(before.migration_jobs, original));
  for (const table of Object.keys(before).filter((name) => name !== 'migration_jobs')) expect(after[table], table).toEqual(before[table]);
  const fields = ['tenant_id', 'job_id', 'status', 'state_version', ...Object.keys(changed)];
  const pick = (row: Record<string, unknown>) => Object.fromEntries(fields.map((key) => [key, row[key]]));
  facts.push({ status: f.status, case: label, observed: 'ALLOWED_CURRENT_BEHAVIOR_NOT_POLICY_APPROVAL',
    before: pick(original.row), persisted: pick(saved.row), unrelatedRowsUnchanged: true });
}

async function denied(f: Fixture, label: string, action: () => Promise<unknown>, expected: SqlFailure) {
  const before = await state(f.h);
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  const trail = errors(caught);
  expect(caught, label).toBeDefined();
  expect(trail).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  expect(await state(f.h)).toEqual(before);
  facts.push({ status: f.status, case: label, observed: 'REJECTED_BY_EXISTING_CONSTRAINT_NOT_NEW_GUARD',
    databaseError: trail.find((entry) => entry.code === expected.code), allPublicRowsAndXminUnchanged: true });
}

function update(f: Fixture, set: SQL) {
  return run(f, (tx) => tx.execute(sql`UPDATE migration_jobs SET ${set}
    WHERE tenant_id=${f.h.tenantOneId} AND job_id=${f.jobId} RETURNING job_id`));
}

for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) describe(`same-status ${status} evidence: NONAUTHORITY`, () => {
  let h: PgliteDatabaseHarness;
  let login: string;
  let schema: Awaited<ReturnType<typeof schemaState>>;
  let sequence = 0;
  beforeAll(async () => {
    h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
    for (const name of migrationNames.filter((name) => name.slice(0, 4) > '0008')) {
      await h.database.exec(readFileSync(join(directory, name), 'utf8'));
    }
    const { rows } = await h.database.query<{ actor: string; login: string; rolsuper: boolean }>(
      'SELECT current_user AS actor,session_user AS login,rolsuper FROM pg_roles WHERE rolname=current_user');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).not.toBe('app_runtime');
    expect(rows[0].rolsuper).toBe(true);
    login = rows[0].login;
    schema = await schemaState(h);
  }, 120_000);
  afterAll(async () => {
    try { if (schema) expect(await schemaState(h)).toEqual(schema); }
    finally { await h?.close(); }
  }, 120_000);

  function checked(name: string, body: (f: Fixture) => Promise<void>, referenced = true) {
    it(name, async () => {
      const f = { h, login, status, jobId: `protected-${status}-${++sequence}` };
      await seed(f, referenced);
      await body(f);
    }, 120_000);
  }

  checked('exact same-value retry commits without altering evidence values', async (f) => {
    await allowed(f, 'exact retry', sql`status=status,state_version=state_version,source_fingerprint=source_fingerprint,
      final_fingerprint=final_fingerprint,freeze_started_at=freeze_started_at,freeze_verified_at=freeze_verified_at,
      completed_at=completed_at,created_at=created_at,updated_at=updated_at,tenant_id=tenant_id,job_id=job_id`, {});
  });

  const rewrites: Array<{ field: string; value: string; set: SQL }> = [
    { field: 'source_fingerprint', value: REWRITE, set: sql`source_fingerprint=${REWRITE}` },
    { field: 'final_fingerprint', value: REWRITE, set: sql`final_fingerprint=${REWRITE}` },
    { field: 'freeze_started_at', value: at('11'), set: sql`freeze_started_at=${at('11')}` },
    { field: 'freeze_verified_at', value: at('21'), set: sql`freeze_verified_at=${at('21')}` },
    { field: 'created_at', value: '2026-07-31T23:59:00+00:00', set: sql`created_at='2026-07-31T23:59:00+00:00'` },
    { field: 'updated_at', value: at('41'), set: sql`updated_at=${at('41')}` },
    ...(status === 'ACTIVE' ? [{ field: 'completed_at', value: at('31'), set: sql`completed_at=${at('31')}` }] : []),
  ];
  for (const { field, value, set } of rewrites) checked(`${field} valid rewrite persists with same status/version and unchanged referenced source`,
    (f) => allowed(f, `${field} value rewrite`, set, { [field]: value }));

  checked('nullable source fingerprint can be erased and replaced even with a referenced source', async (f) => {
    await allowed(f, 'source value to NULL', sql`source_fingerprint=NULL`, { source_fingerprint: null });
    await allowed(f, 'source NULL to value', sql`source_fingerprint=${REWRITE}`, { source_fingerprint: REWRITE });
  });

  if (status === 'FINAL_IMPORT') {
    checked('nullable final fingerprint can be erased and replaced', async (f) => {
      await allowed(f, 'final value to NULL', sql`final_fingerprint=NULL`, { final_fingerprint: null });
      await allowed(f, 'final NULL to value', sql`final_fingerprint=${REWRITE}`, { final_fingerprint: REWRITE });
    });
    checked('freeze verification can be erased and replaced', async (f) => {
      await allowed(f, 'verified value to NULL', sql`freeze_verified_at=NULL`, { freeze_verified_at: null });
      await allowed(f, 'verified NULL to value', sql`freeze_verified_at=${at('21')}`, { freeze_verified_at: at('21') });
    });
    checked('both freeze timestamps can be erased then restored in shape-valid order', async (f) => {
      await allowed(f, 'both freeze values to NULL', sql`freeze_started_at=NULL,freeze_verified_at=NULL`,
        { freeze_started_at: null, freeze_verified_at: null });
      await allowed(f, 'started NULL to value', sql`freeze_started_at=${at('11')}`, { freeze_started_at: at('11') });
      await allowed(f, 'verified NULL to value after start', sql`freeze_verified_at=${at('21')}`, { freeze_verified_at: at('21') });
    });
  }

  const refusals: Array<{ name: string; set: SQL; error: SqlFailure }> = [
    { name: 'version-only increment: transition trigger, not evidence immutability', set: sql`state_version=state_version+1`,
      error: { code: 'P0001', message: 'state_version may change only with status' } },
    { name: 'malformed source hash: format CHECK', set: sql`source_fingerprint='not-a-digest'`,
      error: { code: '23514', constraint: 'migration_jobs_hashes_check' } },
    { name: 'malformed final hash: format CHECK', set: sql`final_fingerprint='not-a-digest'`,
      error: { code: '23514', constraint: 'migration_jobs_hashes_check' } },
    { name: 'verification before start: freeze shape CHECK', set: sql`freeze_verified_at=${at('09')}`,
      error: { code: '23514', constraint: 'migration_jobs_freeze_shape_check' } },
    { name: 'start before creation: chronology CHECK', set: sql`freeze_started_at='2026-07-31T23:59:00+00:00'`,
      error: { code: '23514', constraint: 'migration_jobs_chronology_check' } },
    { name: 'creation after freeze start: chronology CHECK', set: sql`created_at=${at('11')}`,
      error: { code: '23514', constraint: 'migration_jobs_chronology_check' } },
    { name: 'updated_at before evidence: chronology CHECK', set: sql`updated_at=${at('19')}`,
      error: { code: '23514', constraint: 'migration_jobs_chronology_check' } },
    { name: 'completion nullability: status-dependent terminal shape CHECK',
      set: status === 'ACTIVE' ? sql`completed_at=NULL` : sql`completed_at=${at('30')}`,
      error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
    { name: 'blank job id: id CHECK before child FK', set: sql`job_id=' '`,
      error: { code: '23514', constraint: 'migration_jobs_id_check' } },
  ];
  if (status === 'ACTIVE') refusals.push(
    { name: 'NULL final fingerprint: ACTIVE terminal shape CHECK', set: sql`final_fingerprint=NULL`,
      error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
    { name: 'NULL verification: ACTIVE terminal shape CHECK', set: sql`freeze_verified_at=NULL`,
      error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
    { name: 'both freeze timestamps NULL: ACTIVE terminal shape, not freeze shape', set: sql`freeze_started_at=NULL,freeze_verified_at=NULL`,
      error: { code: '23514', constraint: 'migration_jobs_terminal_shape_check' } },
    { name: 'completion before verification: chronology CHECK', set: sql`completed_at=${at('19')}`,
      error: { code: '23514', constraint: 'migration_jobs_chronology_check' } },
  );
  for (const { name, set, error } of refusals) checked(name, (f) => denied(f, name, () => update(f, set), error));

  checked('start NULL while verification exists: freeze shape CHECK (ACTIVE also lacks terminal shape)', async (f) => {
    // Two CHECKs would reject ACTIVE. Record the actual first failure; do not
    // mistake the error order for a guarantee that the other CHECK is absent.
    await denied(f, 'start NULL alone', () => update(f, sql`freeze_started_at=NULL`),
      { code: '23514', constraint: 'migration_jobs_freeze_shape_check' });
  });

  checked('unreferenced job id may be renamed: transition trigger does not freeze identity', async (f) => {
    const renamed = `${f.jobId}-renamed`;
    await allowed(f, 'unreferenced job_id rename', sql`job_id=${renamed}`, { job_id: renamed });
    expect((await h.database.query('SELECT job_id FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2',
      [h.tenantOneId, f.jobId])).rows).toEqual([]);
  }, false);

  checked('duplicate unreferenced job id: primary key, not a protected-state guard', async (f) => {
    const occupied = { ...f, jobId: `${f.jobId}-occupied` };
    await seed(occupied, false);
    await denied(f, 'duplicate job_id', () => update(f, sql`job_id=${occupied.jobId}`),
      { code: '23505', constraint: 'migration_jobs_pkey' });
  }, false);

  checked('referenced job id rename: source child FK, not a protected-state guard', async (f) => {
    await denied(f, 'source-bound job_id', () => update(f, sql`job_id=${`${f.jobId}-renamed`}`),
      { code: '23503', constraint: 'migration_sources_job_fk' });
  });

  checked('audit-referenced job id rename: audit child FK independently blocks it', async (f) => {
    await h.database.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type)
      VALUES($1,$2,$3,'SYNTHETIC_CHARACTERIZATION')`, [h.tenantOneId, `audit-${f.jobId}`, f.jobId]);
    await denied(f, 'audit-bound job_id', () => update(f, sql`job_id=${`${f.jobId}-renamed`}`),
      { code: '23503', constraint: 'audit_events_job_fk' });
  }, false);

  for (const target of ['existing-foreign', 'missing'] as const) checked(`tenant_id rewrite to ${target}: RLS WITH CHECK before FK`, async (f) => {
    const tenantId = target === 'existing-foreign' ? h.tenantTwoId : MISSING_TENANT;
    expect((await h.database.query('SELECT id FROM tenants WHERE id=$1', [tenantId])).rows)
      .toEqual(target === 'existing-foreign' ? [{ id: tenantId }] : []);
    await denied(f, `tenant_id to ${target}`, () => update(f, sql`tenant_id=${tenantId}`),
      { code: '42501', message: 'new row violates row-level security policy for table "migration_jobs"' });
    // Missing target does not establish migration_jobs_tenant_fk as the cause:
    // RLS rejects first. No owner mutation, RLS disable or grant change to unmask it.
  }, false);

  checked('target-tenant GUC cannot see/move the old tenant job: zero rows is not SQL refusal', async (f) => {
    const before = await state(h);
    await run(f, async (tx) => {
      expect((await tx.execute(sql`SELECT job_id FROM migration_jobs
        WHERE tenant_id=${h.tenantOneId} AND job_id=${f.jobId}`)).rows).toEqual([]);
      expect((await tx.execute(sql`UPDATE migration_jobs SET tenant_id=${h.tenantTwoId}
        WHERE tenant_id=${h.tenantOneId} AND job_id=${f.jobId} RETURNING job_id`)).rows).toEqual([]);
    }, h.tenantTwoId);
    expect(await state(h)).toEqual(before);
    facts.push({ status, case: 'foreign GUC identity move', observed: 'ZERO_VISIBLE_ROWS_NOT_SQL_ERROR',
      allPublicRowsAndXminUnchanged: true });
  }, false);
});

afterAll(() => {
  const finalHashes = hashes();
  expect(finalHashes).toEqual(initialHashes);
  console.info('LOCAL_PROTECTED_JOB_EVIDENCE_MUTATION ' + JSON.stringify({
    authority: 'NONAUTHORITY', complete: false, activationAllowed: false, securityFix: false,
    engine: 'synthetic in-memory PGlite', actualPostgreSQL: false, externalWriterExclusion: 'NOT_PROVEN',
    runtimeIdentity: 'APP_RUNTIME_SET_ROLE_WITH_TENANT_GUC_NOT_INDEPENDENT_LOGIN',
    existingActiveBusinessCompatibility: 'SEPARATE_EXISTING_TEST_NOT_RERUN_HERE',
    setup: 'OWNER_SEEDED_PROTECTED_ROWS_NOT_REAL_IMPORT_OR_FREEZE',
    unchangedFileHashes: finalHashes, facts,
  }));
});
