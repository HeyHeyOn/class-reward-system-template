// @vitest-environment node
// CHARACTERIZATION, not a security fix or production activation test.
// All SQL writes are confined to disposable in-memory PGlite. Use the existing
// harness/production migrations unchanged, including their existing role setup.
// Setup owner: schema, initial VALIDATED job and synthetic identity fixtures only.
// Measured state transitions and real importer/repository operations: app_runtime
// with the transaction-local tenant GUC, not distinct authenticated tenant logins.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDatabaseStudentCommands } from '@/server/repositories/database/studentCommands';
import { resolveRepositoryFromEnv } from '@/server/repositories/factory';
import { authorizeTenantAdmin } from '@/server/tenantAuth';
import type { TenantRecord } from '@/server/tenantContext';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest, inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import { prepareLegacyImportReady } from './reconcile';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { canonicalJson } from './validators';
import { readCurrentLocalStudentAttestation, stageLocalStudentAttestedPreparation } from './localStudentAttestedPreparation';

vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
const NEW_TENANT = '20000000-0000-4000-8000-000000000003';
const DIGEST = 'a'.repeat(64);
const directory = 'src/server/db/migrations';
const migrationNames = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = ['.git/index', 'AGENTS.md', 'package.json', 'vitest.config.mts',
  'src/server/db/testing/pglite.ts', 'src/server/db/transaction.ts',
  'src/server/migration/localStudentAttestedPreparation.ts', 'src/server/migration/localStudentAttestedPreparation.test.ts',
  'src/server/migration/localStudentCheckedPreparation.ts', 'src/server/migration/localFullDeltaCheckedPreparation.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts', 'src/server/migration/reconcile.ts',
  'src/server/migration/manifest.ts', 'src/server/migration/normalize.ts', 'src/server/migration/__fixtures__/normalization.ts',
  'src/server/repositories/factory.ts', 'src/server/repositories/context.ts',
  'src/server/repositories/database/studentCommands.ts', 'src/server/tenantAuth.ts',
  ...migrationNames.map((name) => join(directory, name))];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(watched.map((path) => [path, hash(readFileSync(path))]));
const initialHashes = hashes();
type Fact = { closed: boolean; phase: string; status?: string; error?: unknown;
  owner?: unknown; runtimeActors: Record<string, unknown>; observations: Record<string, unknown>; schemaUnchanged?: boolean };
const facts: Record<string, Fact> = {};
type Fixture = { h: PgliteDatabaseHarness; run: TenantImportTransactionRunner; fact: Fact };
type OwnerRow = { actor: string; login_user: string; rolsuper: boolean; rolbypassrls: boolean };
type TenantRow = Record<string, unknown> & { id: string; lifecycle: TenantRecord['lifecycle'] };
type JobRow = Record<string, unknown> & { status: string; state_version: string };

// Do not turn an arbitrary thrown assertion/harness error into SQL refusal proof.
function errorTrail(error: unknown) {
  const trail: Array<{ message: string; code?: unknown; constraint?: unknown }> = [];
  const seen = new Set<unknown>();
  for (let cursor = error; cursor && !seen.has(cursor) && trail.length < 8;) {
    seen.add(cursor);
    if (typeof cursor !== 'object') { trail.push({ message: String(cursor) }); break; }
    const e = cursor as { message?: string; code?: unknown; constraint?: unknown; cause?: unknown };
    trail.push({ message: String(e.message), code: e.code, constraint: e.constraint }); cursor = e.cause;
  }
  return trail;
}
async function schemaState(h: PgliteDatabaseHarness) {
  return {
    roles: (await h.database.query('SELECT rolname,rolsuper,rolbypassrls,rolinherit FROM pg_roles ORDER BY rolname')).rows,
    relations: (await h.database.query(`SELECT c.relname,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname`)).rows,
    triggers: (await h.database.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,t.tgname`)).rows,
    constraints: (await h.database.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,k.conname`)).rows,
  };
}
function checked(name: string, body: (f: Fixture) => Promise<void>) {
  it(name, async () => {
    const fact: Fact = { closed: false, phase: 'schema and actors', runtimeActors: {}, observations: {} }; facts[name] = fact;
    let h: PgliteDatabaseHarness | undefined;
    let schema: Awaited<ReturnType<typeof schemaState>> | undefined;
    try {
      h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
      for (const name of migrationNames.filter((name) => name.slice(0, 4) > '0008')) await h.database.exec(readFileSync(join(directory, name), 'utf8'));
      const { rows: owner } = await h.database.query<OwnerRow>(`SELECT current_user AS actor,session_user AS login_user,
        r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`);
      expect(owner).toHaveLength(1); expect(owner[0].actor).not.toBe('app_runtime'); expect(owner[0].rolsuper).toBe(true);
      fact.owner = owner[0]; schema = await schemaState(h);
      const database = h;
      const run: TenantImportTransactionRunner = (tenantId, callback) => database.runTenantTransaction(tenantId, async (tx) => {
        const { rows } = await tx.execute(sql`SELECT current_user AS actor,session_user AS login_user,
          current_setting('app.tenant_id',true) AS tenant_id,r.rolsuper,r.rolbypassrls,
          current_setting('transaction_isolation') AS isolation FROM pg_roles r WHERE r.rolname=current_user`);
        expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ actor: 'app_runtime', tenant_id: tenantId,
          rolsuper: false, rolbypassrls: false, isolation: 'read committed' });
        expect(rows[0].login_user).toBe(owner[0].login_user); fact.runtimeActors[tenantId] = rows[0];
        return callback(tx);
      });
      fact.phase = 'runtime characterization';
      await body({ h, run, fact }); fact.status = 'passed';
    } catch (error) { fact.status = 'failed'; fact.error = errorTrail(error); throw error; }
    finally {
      try {
        if (h && schema) {
          const after = await schemaState(h); fact.schemaUnchanged = canonicalJson(after) === canonicalJson(schema);
          expect(after).toEqual(schema);
        }
      } finally { await h?.close(); fact.closed = Boolean(h); }
    }
  }, 120_000);
}
async function state(h: PgliteDatabaseHarness) {
  const result: Record<string, string[]> = {};
  const { rows: tables } = await h.database.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for (const { tablename } of tables) {
    expect(tablename).toMatch(/^[a-z_][a-z0-9_]*$/);
    result[tablename] = (await h.database.query(`SELECT row_to_json(t) AS row,xmin::text FROM public."${tablename}" t`)).rows
      .map((row) => canonicalJson(row)).sort();
  }
  return result; // Row/xmin preservation, not sequence advancement or concurrency.
}
async function denied(f: Fixture, name: string, action: () => Promise<unknown>, expected: { code: string; constraint?: string; message?: string }) {
  const baseline = await state(f.h); let error: unknown;
  try { await action(); } catch (caught) { error = caught; }
  const trail = errorTrail(error); f.fact.observations[name] = { disposition: error ? 'REJECTED' : 'UNEXPECTEDLY_ALLOWED', errors: trail };
  expect(error, name).toBeDefined(); expect(trail).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  expect(await state(f.h)).toEqual(baseline);
}
async function receipts(f: Fixture) {
  const result = (await f.h.database.query(`SELECT
    (SELECT count(*)::text FROM audit_events WHERE event_type='MIGRATION_LOCAL_STUDENT_ATTESTATION') AS student,
    (SELECT count(*)::text FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%') AS envelopes,
    (SELECT count(*)::text FROM migration_authority_receipts) AS authority,
    (SELECT count(*)::text FROM migration_authority_replays) AS replays`)).rows;
  expect(result).toHaveLength(1); return result[0];
}
async function tenant(f: Fixture, id: string) {
  return (await f.h.database.query<TenantRow>('SELECT id,slug,display_name,lifecycle,credential_version,created_at::text,updated_at::text,xmin::text FROM tenants WHERE id=$1', [id])).rows;
}
async function job(f: Fixture, tenantId: string, jobId = JOB) {
  return (await f.h.database.query<JobRow>(`SELECT tenant_id,job_id,status,state_version::text,source_fingerprint,final_fingerprint,
    freeze_started_at::text,freeze_verified_at::text,completed_at::text,created_at::text,updated_at::text,xmin::text
    FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2`, [tenantId, jobId])).rows;
}
async function lifecycle(f: Fixture, tenantId: string, next: string) {
  const before = await tenant(f, tenantId);
  const changed = await f.run(tenantId, (tx) => tx.execute(sql`UPDATE tenants SET lifecycle=${next},updated_at=now() WHERE id=${tenantId} RETURNING id,lifecycle`));
  expect(changed.rows).toEqual([{ id: tenantId, lifecycle: next }]);
  const after = await tenant(f, tenantId); expect(after[0].lifecycle).toBe(next);
  f.fact.observations[`tenant:${tenantId}:${next}`] = { before, after, actor: 'app_runtime' };
}
async function ready(f: Fixture, tenantId: string) {
  // Real capture adapter fed only generated in-memory cells. Separate source
  // identities per tenant; never reuse another tenant's globally owned source.
  const seed = makeSupportedSheets(3, (tabs) => { tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf('ruleVersion')] = '2'; });
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  const sheets = await captureSheetsSnapshot({ spreadsheetId: `activation-characterization-${tenantId}`, capturedAt: seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => `synthetic-${tenantId}` } });
  const redis = await captureRedisClaimSnapshot({ hscan: async () => ({ cursor: '0', entries: [] }),
    scan: async () => ({ cursor: '0', keys: [] }), get: async () => { throw new Error('Unexpected synthetic Redis GET'); },
    getRevision: async () => `synthetic-empty-${tenantId}` }, { capturedAt: seed.capturedAt });
  const manifest = createLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, sheets, redis });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  // Setup-owner seed only. The measured importer/reconciler and later direct
  // forward transitions all use the existing restricted runtime runner.
  await f.h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [tenantId, JOB]);
  await importLegacyNormalizationManifest({ tenantId, migrationJobId: JOB, manifest, runTransaction: f.run });
  expect(await f.run(tenantId, (tx) => inspectLegacyImport(tx, { tenantId, migrationJobId: JOB, manifest }, manifest))).toEqual([]);
  const prepared = await prepareLegacyImportReady({ tenantId, migrationJobId: JOB, manifest, currentManifest: manifest,
    comparisonInstant: '2026-08-31T03:00:00.000Z', runTransaction: f.run });
  f.fact.observations[`preparation:${tenantId}`] = { readiness: prepared.readiness, report: prepared.report,
    provenance: 'SYNTHETIC_CAPTURE_ACTUAL_IMPORTER_AND_PREPARE_READY_NOT_LIVE_FREEZE' };
  expect(prepared.readiness, JSON.stringify(prepared.report)).toBe('READY');
  const current = (await job(f, tenantId))[0]; expect(current.status).toBe('READY');
  const { rows: snapshots } = await f.h.database.query<{ source_id: string; snapshot_id: string }>(
    "SELECT source_id,snapshot_id FROM migration_snapshots WHERE tenant_id=$1 AND job_id=$2 AND phase='PREFLIGHT'", [tenantId, JOB]);
  expect(snapshots).toHaveLength(1);
  return { tenantId, migrationJobId: JOB, expectedStateVersion: String(current.state_version),
    originalSourceId: snapshots[0].source_id, originalSnapshotId: snapshots[0].snapshot_id,
    exclusionGenerationReference: DIGEST, original: { sheets, redis }, candidate: { sheets, redis } };
}
async function insertJob(f: Fixture, actorTenant: string, targetTenant: string, status: 'FINAL_IMPORT' | 'ACTIVE', id = `insert-${status}`) {
  return f.run(actorTenant, (tx) => tx.execute(sql`INSERT INTO migration_jobs
    (tenant_id,job_id,status,state_version,final_fingerprint,freeze_started_at,freeze_verified_at,created_at,updated_at,completed_at)
    VALUES(${targetTenant},${id},${status},1,${status === 'ACTIVE' ? DIGEST : null},
      ${status === 'ACTIVE' ? sql`now()` : sql`NULL`},${status === 'ACTIVE' ? sql`now()` : sql`NULL`},now(),now(),
      ${status === 'ACTIVE' ? sql`now()` : sql`NULL`}) RETURNING tenant_id,job_id,status,state_version::text`));
}
async function creators(f: Fixture, tenantId: string) {
  const records = await tenant(f, tenantId); expect(records).toHaveLength(1);
  return resolveRepositoryFromEnv({ CLASS_STORE_STORAGE: 'postgresql' },
    { tenantId: records[0].id, tenantStatus: records[0].lifecycle }, {
      createPostgresql: (authority) => createDatabaseStudentCommands({ tenantId: authority.tenantId, runTenantTransaction: f.run }),
      createSheets: () => { throw new Error('Unexpected Sheets fallback'); },
    }); // Internal repository contract only; NOT a public HTTP identity test.
}

afterAll(() => {
  const finalHashes = hashes();
  console.info('LOCAL_ACTIVATION_COMPATIBILITY_EVIDENCE ' + JSON.stringify({
    authority: 'NONAUTHORITY', complete: false, activationAllowed: false, securityImprovement: false,
    engine: 'synthetic in-memory PGlite', actualPostgreSQL: false, externalWriterExclusion: 'NOT_PROVEN',
    operationalActivation: 'NOT_PERFORMED', runtimeIdentity: 'ONE_APP_RUNTIME_ROLE_WITH_TENANT_GUC_NOT_AUTHENTICATED_TENANT_LOGINS',
    initialHashes, finalHashes, facts,
  }));
  expect(finalHashes).toEqual(initialHashes);
});

describe('current activation SQL boundaries and existing ACTIVE compatibility, NONAUTHORITY', () => {
  checked('actors: owner setup versus same NOSUPERUSER NOBYPASSRLS runtime under two tenant GUCs', async (f) => {
    for (const tenantId of [f.h.tenantOneId, f.h.tenantTwoId]) await f.run(tenantId, async (tx) => {
      const { rows } = await tx.execute(sql`SELECT id FROM tenants ORDER BY id`); expect(rows).toEqual([{ id: tenantId }]);
      const acl = (await tx.execute(sql`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,
        has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,has_table_privilege(current_user,c.oid,'UPDATE') AS can_update
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('tenants','migration_jobs','audit_events') ORDER BY c.relname`)).rows;
      expect(acl).toHaveLength(3);
      for (const r of acl) { expect(r.owner).not.toBe('app_runtime'); expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, can_insert: true, can_update: true }); }
      f.fact.observations[`acl:${tenantId}`] = acl;
    });
  });
  checked('job UPDATE: actual imported READY to FREEZING to FINAL_IMPORT to ACTIVE without student or authority receipt', async (f) => {
    const a = await ready(f, f.h.tenantOneId); await ready(f, f.h.tenantTwoId);
    const foreign = await job(f, f.h.tenantTwoId); const tenants = [await tenant(f, f.h.tenantOneId), await tenant(f, f.h.tenantTwoId)];
    expect(await receipts(f)).toEqual({ student: '0', envelopes: '0', authority: '0', replays: '0' });
    let version = BigInt(a.expectedStateVersion);
    for (const next of ['FREEZING', 'FINAL_IMPORT', 'ACTIVE'] as const) {
      const before = await job(f, a.tenantId);
      const result = await f.run(a.tenantId, (tx) => tx.execute(sql`UPDATE migration_jobs SET status=${next},state_version=state_version+1,updated_at=now(),
        freeze_started_at=COALESCE(freeze_started_at,now()),
        freeze_verified_at=CASE WHEN ${next}='ACTIVE' THEN now() ELSE freeze_verified_at END,
        final_fingerprint=CASE WHEN ${next}='ACTIVE' THEN ${DIGEST} ELSE final_fingerprint END,
        completed_at=CASE WHEN ${next}='ACTIVE' THEN now() ELSE NULL END
        WHERE tenant_id=${a.tenantId} AND job_id=${JOB} RETURNING status,state_version::text`));
      version += BigInt(1); expect(result.rows).toEqual([{ status: next, state_version: String(version) }]);
      const after = await job(f, a.tenantId); expect(after[0]).toMatchObject({ status: next, state_version: String(version) });
      f.fact.observations[next] = { before, after, classification: 'UNAUTHENTICATED_SQL_GAP_NOT_CUTOVER_SUCCESS' };
    }
    expect(await job(f, f.h.tenantTwoId)).toEqual(foreign);
    expect([await tenant(f, f.h.tenantOneId), await tenant(f, f.h.tenantTwoId)]).toEqual(tenants);
    expect(await receipts(f)).toEqual({ student: '0', envelopes: '0', authority: '0', replays: '0' });
  });
  for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) checked(`job INSERT ${status}: UPDATE-only transition trigger does not require predecessor or receipt`, async (f) => {
    const result = await insertJob(f, f.h.tenantOneId, f.h.tenantOneId, status);
    expect(result.rows).toEqual([{ tenant_id: f.h.tenantOneId, job_id: `insert-${status}`, status, state_version: '1' }]);
    const saved = await job(f, f.h.tenantOneId, `insert-${status}`); expect(saved[0].status).toBe(status);
    if (status === 'FINAL_IMPORT') expect(saved[0]).toMatchObject({ final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null, completed_at: null });
    expect(await receipts(f)).toEqual({ student: '0', envelopes: '0', authority: '0', replays: '0' });
    expect((await tenant(f, f.h.tenantOneId))[0].lifecycle).toBe('DRAFT'); f.fact.observations.persisted = saved;
  });
  for (const kind of ['skipped-state', 'no-version-increment', 'version-only'] as const) checked(`job UPDATE refusal ${kind}: existing transition guard and baseline survive`, async (f) => {
    await ready(f, f.h.tenantOneId);
    const update = kind === 'skipped-state'
      ? sql`UPDATE migration_jobs SET status='ACTIVE',state_version=state_version+1,final_fingerprint=${DIGEST},freeze_started_at=now(),freeze_verified_at=now(),completed_at=now(),updated_at=now() WHERE tenant_id=${f.h.tenantOneId} AND job_id=${JOB}`
      : kind === 'no-version-increment'
        ? sql`UPDATE migration_jobs SET status='FREEZING',updated_at=now() WHERE tenant_id=${f.h.tenantOneId} AND job_id=${JOB}`
        : sql`UPDATE migration_jobs SET state_version=state_version+1,updated_at=now() WHERE tenant_id=${f.h.tenantOneId} AND job_id=${JOB}`;
    await denied(f, kind, () => f.run(f.h.tenantOneId, (tx) => tx.execute(update)), { code: 'P0001', message: kind === 'skipped-state'
      ? 'invalid migration state transition' : kind === 'no-version-increment' ? 'migration state_version must increment' : 'state_version may change only with status' });
  });
  checked('job INSERT refusal: incomplete ACTIVE terminal shape is not hidden by characterization', async (f) => {
    await denied(f, 'terminal shape', () => f.run(f.h.tenantOneId, (tx) => tx.execute(sql`INSERT INTO migration_jobs(tenant_id,job_id,status)
      VALUES(${f.h.tenantOneId},'malformed-active','ACTIVE')`)), { code: '23514', constraint: 'migration_jobs_terminal_shape_check' });
  });
  checked('job foreign tenant: eligible foreign READY invisible, UPDATE zero rows, INSERT denied by RLS', async (f) => {
    await ready(f, f.h.tenantOneId); await ready(f, f.h.tenantTwoId); const baseline = await state(f.h);
    await f.run(f.h.tenantOneId, async (tx) => {
      expect((await tx.execute(sql`SELECT job_id FROM migration_jobs WHERE tenant_id=${f.h.tenantTwoId}`)).rows).toEqual([]);
      expect((await tx.execute(sql`UPDATE migration_jobs SET status='FREEZING',state_version=state_version+1,updated_at=now()
        WHERE tenant_id=${f.h.tenantTwoId} AND job_id=${JOB} RETURNING job_id`)).rows).toEqual([]);
    });
    expect(await state(f.h)).toEqual(baseline);
    for (const status of ['FINAL_IMPORT', 'ACTIVE'] as const) await denied(f, `foreign-${status}`,
      () => insertJob(f, f.h.tenantOneId, f.h.tenantTwoId, status), { code: '42501' });
  });
  checked('tenant ACTIVE INSERT: runtime can create its GUC-matching row without migration or attestation', async (f) => {
    expect(await tenant(f, NEW_TENANT)).toEqual([]);
    await f.run(NEW_TENANT, async (tx) => {
      expect((await tx.execute(sql`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES(${NEW_TENANT},'runtime-created','Synthetic new tenant','ACTIVE')
        RETURNING id,lifecycle`)).rows).toEqual([{ id: NEW_TENANT, lifecycle: 'ACTIVE' }]);
    });
    expect((await tenant(f, NEW_TENANT))[0].lifecycle).toBe('ACTIVE'); expect(await job(f, NEW_TENANT)).toEqual([]);
    f.fact.observations.persisted = await tenant(f, NEW_TENANT); expect(await receipts(f)).toEqual({ student: '0', envelopes: '0', authority: '0', replays: '0' });
  });
  checked('tenant UPDATE: DRAFT to ACTIVE and existing ACTIVE metadata change preserve unrelated tenant', async (f) => {
    const foreign = await tenant(f, f.h.tenantTwoId); await lifecycle(f, f.h.tenantOneId, 'ACTIVE');
    const before = await tenant(f, f.h.tenantOneId);
    await f.run(f.h.tenantOneId, (tx) => tx.execute(sql`UPDATE tenants SET display_name='Synthetic renamed',updated_at=now()
      WHERE id=${f.h.tenantOneId} RETURNING id`));
    const after = await tenant(f, f.h.tenantOneId); expect(after[0]).toMatchObject({ lifecycle: 'ACTIVE', display_name: 'Synthetic renamed' });
    expect(after[0].created_at).toBe(before[0].created_at); expect(await tenant(f, f.h.tenantTwoId)).toEqual(foreign);
    f.fact.observations.metadata = { before, after };
  });
  for (const inactive of ['SUSPENDED', 'MIGRATION_READ_ONLY'] as const) checked(`tenant deactivate/reactivate ${inactive}: SQL permits, repository rejects inactive state`, async (f) => {
    await lifecycle(f, f.h.tenantOneId, 'ACTIVE'); await lifecycle(f, f.h.tenantOneId, inactive);
    await expect(creators(f, f.h.tenantOneId)).rejects.toThrow('Request-scoped tenant status must be exactly "ACTIVE" for PostgreSQL storage.');
    await lifecycle(f, f.h.tenantOneId, 'ACTIVE'); expect((await creators(f, f.h.tenantOneId)).storage).toBe('postgresql');
    expect(await receipts(f)).toEqual({ student: '0', envelopes: '0', authority: '0', replays: '0' });
  });
  for (const conflict of ['nothing', 'update'] as const) checked(`tenant UPSERT ON CONFLICT ${conflict}: new ACTIVE insert and same-ID conflict are separate paths`, async (f) => {
    const put = () => f.run(NEW_TENANT, (tx) => tx.execute(sql`INSERT INTO tenants(id,slug,display_name,lifecycle)
      VALUES(${NEW_TENANT},'upsert-tenant','Synthetic upsert','ACTIVE') ON CONFLICT(id)
      ${conflict === 'nothing' ? sql`DO NOTHING` : sql`DO UPDATE SET display_name=EXCLUDED.display_name,lifecycle=EXCLUDED.lifecycle,updated_at=now()`}
      RETURNING id,lifecycle`));
    expect((await put()).rows).toEqual([{ id: NEW_TENANT, lifecycle: 'ACTIVE' }]); const before = await tenant(f, NEW_TENANT);
    if (conflict === 'update') await lifecycle(f, NEW_TENANT, 'SUSPENDED');
    const result = await put(); const after = await tenant(f, NEW_TENANT);
    expect(result.rows).toEqual(conflict === 'nothing' ? [] : [{ id: NEW_TENANT, lifecycle: 'ACTIVE' }]);
    if (conflict === 'nothing') expect(after).toEqual(before);
    else { expect(after[0].created_at).toBe(before[0].created_at); expect(after[0].lifecycle).toBe('ACTIVE'); }
    f.fact.observations.upsert = { before, after, returning: result.rows };
  });
  checked('tenant foreign INSERT/UPSERT denied, foreign UPDATE invisible, invalid lifecycle rejected', async (f) => {
    const baseline = await state(f.h);
    await f.run(f.h.tenantOneId, async (tx) => {
      expect((await tx.execute(sql`SELECT id FROM tenants WHERE id=${f.h.tenantTwoId}`)).rows).toEqual([]);
      expect((await tx.execute(sql`UPDATE tenants SET lifecycle='ACTIVE' WHERE id=${f.h.tenantTwoId} RETURNING id`)).rows).toEqual([]);
    }); expect(await state(f.h)).toEqual(baseline);
    await denied(f, 'foreign-insert', () => f.run(f.h.tenantOneId, (tx) => tx.execute(sql`INSERT INTO tenants(id,slug,display_name,lifecycle)
      VALUES(${NEW_TENANT},'foreign-insert','Synthetic foreign','ACTIVE')`)), { code: '42501' });
    await denied(f, 'foreign-upsert', () => f.run(f.h.tenantOneId, (tx) => tx.execute(sql`INSERT INTO tenants(id,slug,display_name,lifecycle)
      VALUES(${f.h.tenantTwoId},'transaction-tenant-two','Synthetic foreign','ACTIVE') ON CONFLICT(id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle`)), { code: '42501' });
    await denied(f, 'invalid-lifecycle', () => f.run(f.h.tenantOneId, (tx) => tx.execute(sql`UPDATE tenants SET lifecycle='INVALID' WHERE id=${f.h.tenantOneId}`)),
      { code: '23514', constraint: 'tenants_lifecycle_check' });
  });
  checked('ACTIVE business: actual repository selection and student command/retry work without migration receipts', async (f) => {
    await lifecycle(f, f.h.tenantOneId, 'ACTIVE'); const repository = await creators(f, f.h.tenantOneId);
    const input = { operationId: 'activation-characterization-create', studentId: 'SYNTHETIC-STUDENT', name: 'Synthetic student', balance: 25, status: 'ACTIVE' as const };
    const result = await repository.adapter.create(input); expect(result).toMatchObject({ ok: true, action: 'CREATE', operationId: input.operationId });
    const stored = (await f.h.database.query(`SELECT s.student_id,s.name,s.status,a.balance::text FROM students s JOIN accounts a USING(tenant_id,student_id)
      WHERE s.tenant_id=$1 AND s.student_id=$2`, [f.h.tenantOneId, input.studentId])).rows;
    expect(stored).toEqual([{ student_id: input.studentId, name: input.name, status: 'ACTIVE', balance: '25' }]);
    const baseline = await state(f.h); expect(await repository.adapter.create(input)).toEqual(result); expect(await state(f.h)).toEqual(baseline);
    await f.run(f.h.tenantTwoId, async (tx) => { expect((await tx.execute(sql`SELECT student_id FROM students WHERE tenant_id=${f.h.tenantOneId}`)).rows).toEqual([]); });
    expect(await receipts(f)).toEqual({ student: '0', envelopes: '0', authority: '0', replays: '0' });
    f.fact.observations.business = { result, stored, classification: 'INTERNAL_REPOSITORY_CONTRACT_NOT_AUTHENTICATED_HTTP' };
  });
  checked('four local records: valid READY revalidation refuses after tenant ACTIVE; records persist, no certification', async (f) => {
    const input = await ready(f, f.h.tenantOneId);
    const attested = await stageLocalStudentAttestedPreparation(input, f.run);
    expect(attested).toMatchObject({ authority: 'NONAUTHORITY', complete: false, activationAllowed: false, issuerAuthenticity: 'NOT_PROVEN' });
    expect(await readCurrentLocalStudentAttestation({ tenantId: input.tenantId, runTransaction: f.run }, attested.selection)).toEqual(attested);
    expect(await receipts(f)).toEqual({ student: '1', envelopes: '3', authority: '0', replays: '0' });
    const before = await state(f.h); const currentJob = await job(f, input.tenantId);
    await lifecycle(f, input.tenantId, 'ACTIVE'); const active = await state(f.h);
    expect(active.audit_events).toEqual(before.audit_events); expect(await job(f, input.tenantId)).toEqual(currentJob);
    await expect(readCurrentLocalStudentAttestation({ tenantId: input.tenantId, runTransaction: f.run }, attested.selection)).rejects.toThrow('Local student attestation refused.');
    expect(await state(f.h)).toEqual(active);
    f.fact.observations.classification = 'TENANT_SQL_ACTIVATION_ALLOWED_BUT_READY_READER_REFUSES_NOT_SUFFICIENT_AUTHORITY';
  });
  checked('admin negatives: ACTIVE does not create membership or authenticate a null session', async (f) => {
    await lifecycle(f, f.h.tenantOneId, 'ACTIVE'); const current = (await tenant(f, f.h.tenantOneId))[0];
    const selected: TenantRecord = { id: String(current.id), slug: String(current.slug), displayName: String(current.display_name), lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
    const memberships = { findByTenantAndSubject: async (tenantId: string, subject: string) => {
      const { rows } = await f.run(tenantId, (tx) => tx.execute(sql`SELECT m.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=${tenantId} AND u.google_subject=${subject}`));
      expect(rows).toEqual([]); return null;
    } };
    const baseline = await state(f.h);
    await expect(authorizeTenantAdmin(selected, null, memberships)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    await expect(authorizeTenantAdmin(selected, { subject: 'synthetic-nonmember-not-an-OIDC-proof' }, memberships)).rejects.toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
    expect(await state(f.h)).toEqual(baseline);
  });
});
