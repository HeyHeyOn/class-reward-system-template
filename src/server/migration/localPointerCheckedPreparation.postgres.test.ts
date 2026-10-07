// @vitest-environment node
// REAL DISPOSABLE PG17 / SYNTHETIC / NONAUTHORITY. No production connection or cutover.
// Only fault injection: drop one candidate Notes source record AFTER the real normalizer
// returns. Real manifest hashes, stage envelopes, SQL, pointer checker and runner still run.
// This proves transactional composition, NOT naturally reachable normalizer data loss.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTenantTransactionRunner, type TransactionConnection } from '@/server/db/transaction';
import { importLegacyNormalizationManifest, inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { createLegacyNormalizationManifest } from './manifest';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import * as normalization from './normalize';
import * as coverage from './localCapturedSourceCoverage';
import { stageLocalPointerCheckedPreparation } from './localPointerCheckedPreparation';

vi.mock('server-only', () => ({})); // Environment marker only, not a service replacement.
const TENANT = '20000000-0000-4000-8000-000000000401';
const OTHER = '20000000-0000-4000-8000-000000000402';
const JOB = '20000000-0000-4000-8000-000000000019';
const REFUSAL = 'Local pointer-checked preparation refused.';
const FILE = 'src/server/migration/localPointerCheckedPreparation.postgres.test.ts';
const flags = { scope: 'LOCAL_POINTER_CHECKED_PREPARATION_ONLY', authority: 'NONAUTHORITY', complete: false,
  activationAllowed: false, exclusion: 'NOT_PROVEN', fullSourceReconciliation: 'NOT_PERFORMED',
  fullTargetReconciliation: 'NOT_PERFORMED', preRedactionInventory: 'NOT_OBSERVED',
  canonicalBusinessValidation: 'NOT_PERFORMED', contributorMultiplicityValidation: 'NOT_PERFORMED' };
const directory = 'src/server/db/migrations';
const migrations = readdirSync(directory).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const watched = [FILE, '.git/index', 'AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.mts',
  'src/server/db/testing/disposablePostgres.ts', 'src/server/db/testing/pgStdioRelay.c', 'src/server/db/transaction.ts',
  'src/server/migration/localPointerCheckedPreparation.ts', 'src/server/migration/localPointerCheckedPreparation.test.ts',
  'src/server/migration/localCapturedSourceCoverage.ts', 'src/server/migration/localCapturedSourceCoverage.test.ts',
  'src/server/migration/finalGeneration.ts', 'src/server/migration/importer.ts', 'src/server/migration/manifest.ts',
  'src/server/migration/normalize.ts', 'src/server/migration/validators.ts', 'src/server/migration/sensitiveRedaction.ts',
  'src/server/migration/sheetsSnapshot.ts', 'src/server/migration/redisClaimSnapshot.ts',
  'src/server/migration/__fixtures__/normalization.ts', ...migrations.map((name) => join(directory, name))];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashes = () => Object.fromEntries(watched.map((path) => [path, hash(readFileSync(path))]));
const initialHashes = hashes();
type Fact = Record<string, unknown>;
type Acquisition = FinalGenerationPreparationInput['original'];
type Stored = { row: Record<string, unknown>; xmin: string };
type State = Record<string, Stored[]>;
type Envelope = { tenant_id: string; event_id: string; job_id: string; event_type: string;
  operation_id: null; actor_user_id: null; entity_type: null; entity_id: null;
  redacted_details: Record<string, unknown>; xmin: string };
const facts: Fact[] = [];

async function capture(fresh: boolean): Promise<Acquisition> {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  if (fresh) workbook.Notes = [['future'], ['synthetic pointer-only note']];
  const operation = makeRedis().operationBindings[0];
  const entries: Array<readonly [string, string]> = [[operation.claimField, operation.operationId],
    [`op:${sha256(operation.operationId)}`, JSON.stringify({ binding: operation.binding, claimField: operation.claimField })]];
  const capturedAt = fresh ? '2026-09-01T00:00:00.000Z' : '2026-08-31T00:00:00.000Z';
  const sheets = await captureSheetsSnapshot({ spreadsheetId: 'synthetic-pointer-pg-workbook', capturedAt, reader: {
    listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
    getRevision: async () => fresh ? 'synthetic-sheet-2' : 'synthetic-sheet-1',
  } });
  const redis = await captureRedisClaimSnapshot({
    hscan: async (key, cursor) => { expect([key, cursor]).toEqual(['padlet:evidence-bindings:v2', '0']);
      return { cursor: '0', entries: structuredClone(entries) }; },
    scan: async (cursor, pattern) => { expect([cursor, pattern]).toEqual(['0', 'padlet:evidence-claim:v1:*']);
      return { cursor: '0', keys: [] }; },
    get: async () => { throw Error('No v1 key exists in this synthetic fixture'); },
    getRevision: async () => fresh ? 'synthetic-redis-2' : 'synthetic-redis-1',
  }, { capturedAt });
  return { sheets, redis };
}
async function state(connection: Pool | PoolClient): Promise<State> {
  const result: State = {};
  const { rows: tables } = await connection.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for (const { tablename } of tables) {
    expect(tablename).toMatch(/^[a-z_][a-z0-9_]*$/);
    result[tablename] = (await connection.query<Stored>(`SELECT to_jsonb(t) AS row,t.xmin::text FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function catalog(connection: Pool | PoolClient) {
  return {
    relations: (await connection.query(`SELECT oid::text,relname,relkind,relowner::text,relacl,relrowsecurity,relforcerowsecurity
      FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`)).rows,
    functions: (await connection.query(`SELECT oid::text,xmin::text,proname,proowner::text,proacl,prosecdef,proconfig,prosrc
      FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows,
    triggers: (await connection.query(`SELECT oid::text,xmin::text,tgname,tgrelid::text,tgfoid::text,tgenabled,pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY oid`)).rows,
    policies: (await connection.query(`SELECT oid::text,xmin::text,polname,polrelid::text,polcmd,polroles,
      pg_get_expr(polqual,polrelid) AS predicate,pg_get_expr(polwithcheck,polrelid) AS check_predicate
      FROM pg_policy ORDER BY oid`)).rows,
    roles: (await connection.query(`SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls
      FROM pg_roles ORDER BY oid`)).rows,
    memberships: (await connection.query('SELECT to_jsonb(m) AS row FROM pg_auth_members m ORDER BY to_jsonb(m)::text')).rows,
  };
}
async function stored(connection: Pool | PoolClient) {
  return (await connection.query<Envelope>(`SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,
    entity_type,entity_id,redacted_details,xmin::text FROM audit_events WHERE tenant_id=$1 AND job_id=$2
    AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`, [TENANT, JOB])).rows;
}
const withoutAudit = (value: State) => Object.fromEntries(Object.entries(value).filter(([table]) => table !== 'audit_events'));
function diagnostic(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error };
  const cause = error.cause as { code?: string; constraint?: string } | undefined;
  return { name: error.name, message: 'query' in error ? 'Database query failed' : error.message,
    code: 'code' in error ? error.code : cause?.code, constraint: cause?.constraint };
}
async function fixture(db: DisposablePostgres, fact: Fact) {
  fact.phase = 'SYNTHETIC_CAPTURE_AND_REAL_IMPORT';
  await db.owner.query(`INSERT INTO tenants(id,slug,display_name) VALUES
    ($1,'pointer-pg-one','Synthetic pointer one'),($2,'pointer-pg-other','Synthetic pointer other')`, [TENANT, OTHER]);
  await db.owner.query(`INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED'),($3,'unrelated-job','DISCOVERED')`, [TENANT, JOB, OTHER]);
  await db.owner.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details) VALUES
    ($1,'prior-own-audit',$2,'SYNTHETIC_BASELINE','{"synthetic":true}'::jsonb),
    ($3,'prior-other-audit','unrelated-job','SYNTHETIC_BASELINE','{"synthetic":true}'::jsonb)`, [TENANT, JOB, OTHER]);
  const original = await capture(false), candidate = await capture(true);
  const manifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...original });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  expect(manifest.records.padlet_evidence_claims).toHaveLength(1);
  expect(manifest.records.legacy_operation_bindings).toHaveLength(1);
  fact.importResult = await importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest, runTransaction: db.runTenantTransaction });
  // Historical synthetic readiness only, using existing transitions; NOT an authority ceremony.
  for (const status of ['RECONCILING', 'READY']) await db.owner.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND job_id=$2', [TENANT, JOB, status]);
  expect(await db.runTenantTransaction(TENANT, (tx) => inspectLegacyImport(tx, { tenantId: TENANT, migrationJobId: JOB, manifest }, manifest))).toEqual([]);
  const versions = (await db.owner.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, JOB])).rows;
  const snapshots = (await db.owner.query<{ source_id: string; snapshot_id: string }>("SELECT source_id,snapshot_id FROM migration_snapshots WHERE tenant_id=$1 AND job_id=$2 AND phase='PREFLIGHT'", [TENANT, JOB])).rows;
  expect(versions).toHaveLength(1); expect(snapshots).toHaveLength(1);
  const input: FinalGenerationPreparationInput = { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: versions[0].version,
    originalSourceId: snapshots[0].source_id, originalSnapshotId: snapshots[0].snapshot_id,
    original, candidate, exclusionGenerationReference: 'a'.repeat(64) }; // Label only; never an exclusion proof.
  expect(await stored(db.owner)).toEqual([]);
  const before = await state(db.owner), catalogBefore = await catalog(db.owner);
  fact.originalInspection = []; fact.baselineHash = hash(JSON.stringify(before));
  fact.catalogBeforeHash = hash(JSON.stringify(catalogBefore));
  // Acquire the retained observer last, so a setup assertion cannot strand it.
  const observer = await db.owner.connect();
  return { db, input, manifest, observer, before, catalogBefore, fact };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Observation = { commands: Array<{ sent: string; acknowledged: string }>; attempts: number;
  backend?: Record<string, unknown>; rows?: Envelope[]; observerRows?: Envelope[]; callbackError?: ReturnType<typeof diagnostic> };
function observedRunner(f: Fixture, observation: Observation): TenantImportTransactionRunner {
  // Documented runner pool dependency; forward every original query/config/result/error
  // unchanged to the actual node-postgres client, and record only control-command ACKs.
  const run = createTenantTransactionRunner({ pool: { connect: async () => {
    const client = await f.db.runtime.connect();
    const connection: TransactionConnection = {
      query: async <T extends QueryResultRow>(text: string, values?: unknown[]) => {
        const result = await client.query<T>(text, values);
        if (typeof text === 'string' && ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
          observation.commands.push({ sent: text, acknowledged: result.command });
        }
        return result;
      },
      release: (error) => client.release(error),
    };
    return connection;
  } } });
  return (tenant, callback) => run(tenant, async (tx) => {
    observation.attempts++;
    const identity = await tx.execute(sql`SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid,
      current_user AS actor,session_user AS login,current_setting('app.tenant_id') AS tenant,
      current_setting('transaction_isolation') AS isolation,inet_server_addr() AS address,
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged,
      (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.audit_events'::regclass) AS audit_owner`);
    observation.backend = identity.rows[0];
    try { return await callback(tx); }
    catch (error) { observation.callbackError = diagnostic(error); throw error; }
    finally {
      // Checker rejection is a JS error, so all real inserts remain visible here
      // BEFORE the real runner rolls back. Never substitute returned SQL rows.
      observation.rows = (await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,
        entity_type,entity_id,redacted_details,xmin::text FROM audit_events WHERE tenant_id=${tenant} AND job_id=${JOB}
        AND event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id`)).rows as Envelope[];
      observation.observerRows = await stored(f.observer);
    }
  });
}
function assertObservation(f: Fixture, observed: Observation, command: 'COMMIT' | 'ROLLBACK') {
  expect(observed.attempts).toBe(1);
  expect(observed.commands).toEqual([{ sent: 'BEGIN', acknowledged: 'BEGIN' }, { sent: command, acknowledged: command }]);
  expect(observed.backend).toMatchObject({ actor: 'app_runtime', login: 'app_runtime', tenant: TENANT,
    isolation: 'read committed', address: null, privileged: false, audit_owner: 'postgres' });
  expect(Number(observed.backend!.pid)).toBeGreaterThan(0);
  expect(observed.backend!.pid).not.toBe((f.fact.observer as { pid: number }).pid);
  expect(observed.observerRows).toEqual([]);
  expect(observed.rows).toHaveLength(3);
  expect(observed.rows!.map((row) => row.event_type).sort()).toEqual(['CANDIDATE', 'ORIGINAL', 'PLAN'].map((kind) => `MIGRATION_PREPARATION_${kind}`));
  for (const row of observed.rows!) {
    expect(row).toMatchObject({ tenant_id: TENANT, job_id: JOB, operation_id: null, actor_user_id: null, entity_type: null, entity_id: null });
    expect(row.xmin).toBe(observed.backend!.xid);
    expect(row.event_id).toBe(`preparation:${row.event_type.slice('MIGRATION_PREPARATION_'.length).toLowerCase()}:${sha256(canonicalJson(row.redacted_details))}`);
  }
  f.fact.transaction = { ...observed, rows: observed.rows!.map(({ event_id, event_type, xmin, redacted_details }) =>
    ({ event_id, event_type, xmin, envelopeHash: sha256(canonicalJson(redacted_details)) })) };
}
async function preserved(f: Fixture, expected: State) {
  expect(await state(f.observer)).toEqual(expected);
  expect(await catalog(f.observer)).toEqual(f.catalogBefore);
  expect(await f.db.runTenantTransaction(TENANT, (tx) => inspectLegacyImport(tx,
    { tenantId: TENANT, migrationJobId: JOB, manifest: f.manifest }, f.manifest))).toEqual([]);
  const expectedAudits = expected.audit_events.filter(({ row }) => row.tenant_id === TENANT).map(({ row, xmin }) => ({ row, xmin }));
  const runtime = await f.db.runTenantTransaction(TENANT, (tx) => tx.execute(sql`SELECT to_jsonb(a) AS row,a.xmin::text FROM audit_events a ORDER BY to_jsonb(a)::text`));
  expect(runtime.rows).toEqual(expectedAudits);
  expect((await f.db.runTenantTransaction(OTHER, (tx) => tx.execute(sql`SELECT event_id FROM audit_events ORDER BY event_id`))).rows).toEqual([{ event_id: 'prior-other-audit' }]);
  expect((await f.observer.query('SELECT pg_blocking_pids($1) AS blockers', [(f.fact.transaction as Observation).backend!.pid])).rows).toEqual([{ blockers: [] }]);
  f.fact.catalogAfterHash = hash(JSON.stringify(await catalog(f.observer)));
  f.fact.finalStateHash = hash(JSON.stringify(expected));
}
function checked(name: string, body: (f: Fixture) => Promise<void>) {
  it(name, async () => {
    const fact: Fact = { test: name, authority: 'NONAUTHORITY', phase: 'CREATE_OWNED_ISOLATED_PG17', passed: false };
    facts.push(fact);
    let db: DisposablePostgres | undefined, f: Fixture | undefined;
    let unexpectedFetches = 0;
    vi.stubGlobal('fetch', async () => { unexpectedFetches++; throw Error('External fetch forbidden in synthetic PG test'); });
    try {
      db = await createDisposablePostgres(); fact.infrastructure = db.evidence;
      expect(String(db.evidence.version)).toMatch(/^17\./);
      f = await fixture(db, fact);
      fact.observer = (await f.observer.query('SELECT pg_backend_pid() AS pid,current_user AS actor')).rows[0];
      fact.phase = 'EXERCISE_POINTER_CHECK_COMPOSITION';
      await body(f); fact.passed = true; fact.phase = 'VERIFIED_DISPOSABLE_ONLY';
    } catch (error) { fact.failure = { phase: fact.phase, ...diagnostic(error) }; throw error; }
    finally {
      vi.restoreAllMocks(); vi.unstubAllGlobals();
      f?.observer.release();
      try { if (db) fact.cleanup = await db.close(); }
      finally {
        fact.externalFetches = unexpectedFetches;
        console.info(`LOCAL_POINTER_CHECKED_PREPARATION_PG ${JSON.stringify(fact)}`);
      }
      expect(unexpectedFetches).toBe(0);
      expect(hashes()).toEqual(initialHashes);
    }
  }, 0);
}
afterAll(() => {
  const current = hashes();
  console.info(`LOCAL_POINTER_CHECKED_PREPARATION_PG_SOURCES ${JSON.stringify({ sourceHashes: current,
    sourceHashesUnchanged: canonicalJson(current) === canonicalJson(initialHashes), tests: facts.length,
    authority: 'NONAUTHORITY', operationalProtection: 'NOT_PROVEN', externalWriterExclusion: 'NOT_PROVEN' })}`);
  expect(current).toEqual(initialHashes);
});

describe.skipIf(process.env.RUN_REAL_POSTGRES !== '1')('real PG17 local pointer-checked preparation composition', () => {
  checked('commits three actual audit envelopes only after both real pointer checks succeed', async (f) => {
    const checker = vi.spyOn(coverage, 'verifyLocalCapturedSourceCoverage'); // Delegates; no manufactured report.
    const observed: Observation = { commands: [], attempts: 0 };
    const inputBefore = canonicalJson(f.input);
    const result = await stageLocalPointerCheckedPreparation(f.input, observedRunner(f, observed));
    expect(result).toMatchObject(flags);
    expect(result.preparation).toMatchObject({ storage: 'UNTRUSTED_PREPARATION', plan: { status: 'DIFF_VALIDATED', changes: [], blockers: [] } });
    assertObservation(f, observed, 'COMMIT');
    expect(observed.callbackError).toBeUndefined();
    expect(checker).toHaveBeenCalledTimes(2);
    expect(checker.mock.results.map(({ type }) => type)).toEqual(['return', 'return']);
    for (const [index, side, kind, id] of [[0, 'original', 'ORIGINAL', result.preparation.originalGenerationId],
      [1, 'candidate', 'CANDIDATE', result.preparation.candidateGenerationId]] as const) {
      const row = observed.rows!.find((row) => row.event_id === id)!;
      expect(row.event_type).toBe(`MIGRATION_PREPARATION_${kind}`);
      const manifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...f.input[side] });
      expect(row.redacted_details.acquisition).toEqual(f.input[side]);
      expect(row.redacted_details.manifest).toEqual(manifest);
      expect(checker.mock.calls[index][0]).toEqual({ capture: { tenantId: TENANT, migrationJobId: JOB, ...f.input[side] }, manifest });
      expect(result.reports[side]).toEqual(checker.mock.results[index].value);
      expect(result.reports[side]).toMatchObject({ status: 'CAPTURE_POINTERS_ACCOUNTED', pointerAccounting: 'ACCOUNTED',
        authority: 'NONAUTHORITY', normalizationStatus: 'READY_FOR_IMPORT', missingSourceUnits: 0, unexpectedSourceReferences: 0 });
    }
    expect(result.reports.original.manifestDigest).not.toBe(result.reports.candidate.manifestDigest);
    expect(result.reports.original.sheetsDigest).not.toBe(result.reports.candidate.sheetsDigest);
    expect(result.reports.original.redisDigest).not.toBe(result.reports.candidate.redisDigest);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reports.candidate.units)).toBe(true);
    expect(canonicalJson(f.input)).toBe(inputBefore);
    expect(await stored(f.observer)).toEqual(observed.rows);
    const after = await state(f.observer);
    expect(withoutAudit(after)).toEqual(withoutAudit(f.before));
    const added = after.audit_events.filter(({ row }) => String(row.event_type).startsWith('MIGRATION_PREPARATION_'));
    expect(added).toHaveLength(3);
    expect(after.audit_events.filter(({ row }) => !String(row.event_type).startsWith('MIGRATION_PREPARATION_'))).toEqual(f.before.audit_events);
    expect(added.map(({ row }) => row.event_id).sort()).toEqual([result.preparation.originalGenerationId, result.preparation.candidateGenerationId, result.preparation.planId].sort());
    await preserved(f, after);
    f.fact.pointerReports = result.reports;
    f.fact.verified = { realCheckerCalls: 2, uncommittedAuditRows: 3, committedAuditRows: 3,
      priorAuditRowsAndXminUnchanged: true, allNonAuditRowsAndXminUnchanged: true, catalogUnchanged: true };
  });

  checked('rejects a deliberately omitted candidate capture pointer after real append and rolls back every new audit row', async (f) => {
    const realNormalize = normalization.normalizeLegacySnapshots;
    const candidateManifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...f.input.candidate });
    expect(candidateManifest.status).toBe('READY_FOR_IMPORT');
    const note = candidateManifest.sourceRecords.filter(({ source }) => source.kind === 'SHEET' && source.tab === 'Notes');
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ canonicalRecord: null, mappingStatus: 'STAGED', errorCodes: [] });
    expect(note[0].targetId).toBeUndefined();
    const pointer = note[0].source, pointerDigest = sha256(canonicalJson(pointer));
    const baselineReport = coverage.verifyLocalCapturedSourceCoverage({ capture: { tenantId: TENANT, migrationJobId: JOB, ...f.input.candidate }, manifest: candidateManifest });
    expect(baselineReport).toMatchObject({ status: 'CAPTURE_POINTERS_ACCOUNTED', missingSourceUnits: 0 });
    let injected = 0;
    const producer = vi.spyOn(normalization, 'normalizeLegacySnapshots').mockImplementation((input, budget) => {
      const full = realNormalize(input, budget);
      if (input.sheets.digest !== f.input.candidate.sheets.digest) return full;
      const removed = full.sourceRecords.filter(({ source }) => canonicalJson(source) === canonicalJson(pointer));
      expect(removed).toEqual(note); injected++;
      // Narrow producer-output fault, NOT a capture edit, checker stub, DB-row
      // substitution, SQL error or immutable-ledger tampering. The real manifest
      // producer now computes its own semantic fingerprint/digest for this omission.
      return { ...full, sourceRecords: full.sourceRecords.filter(({ source }) => canonicalJson(source) !== canonicalJson(pointer)) };
    });
    const checker = vi.spyOn(coverage, 'verifyLocalCapturedSourceCoverage');
    const observed: Observation = { commands: [], attempts: 0 };
    const inputBefore = canonicalJson(f.input);
    await expect(stageLocalPointerCheckedPreparation(f.input, observedRunner(f, observed))).rejects.toThrow(REFUSAL);
    expect(injected).toBe(1); expect(producer).toHaveBeenCalledTimes(2);
    assertObservation(f, observed, 'ROLLBACK');
    expect(observed.callbackError).toEqual({ name: 'Error', message: REFUSAL, code: undefined, constraint: undefined });
    expect(checker).toHaveBeenCalledTimes(2);
    expect(checker.mock.results.map(({ type }) => type)).toEqual(['return', 'return']);
    expect(checker.mock.results[0].value).toMatchObject({ status: 'CAPTURE_POINTERS_ACCOUNTED', pointerAccounting: 'ACCOUNTED' });
    const rejected = checker.mock.results[1].value as ReturnType<typeof coverage.verifyLocalCapturedSourceCoverage>;
    expect(rejected).toMatchObject({ status: 'BLOCKED', pointerAccounting: 'MISMATCH', normalizationStatus: 'READY_FOR_IMPORT',
      missingSourceUnits: 1, unexpectedSourceReferences: 0, omittedDiagnostics: 0 });
    expect(rejected.diagnostics).toEqual([{ code: 'MISSING_CAPTURE_SOURCE', referenceDigest: pointerDigest }]);
    expect(rejected.expectedSourceUnits).toBe(baselineReport.expectedSourceUnits);
    expect(rejected.units.find((unit) => unit.pointerDigest === pointerDigest)).toMatchObject({ sourceRecordReferences: 0 });
    const row = observed.rows!.find(({ event_type }) => event_type === 'MIGRATION_PREPARATION_CANDIDATE')!;
    expect(row.redacted_details.acquisition).toEqual(f.input.candidate);
    const archived = row.redacted_details.manifest as typeof candidateManifest;
    expect(archived.records).toEqual(candidateManifest.records); expect(archived.mappings).toEqual(candidateManifest.mappings);
    expect(archived.sourceRecords).toEqual(candidateManifest.sourceRecords.filter(({ source }) => canonicalJson(source) !== canonicalJson(pointer)));
    const { manifestDigest, ...body } = archived;
    expect(manifestDigest).toBe(sha256(canonicalJson(body)));
    expect(checker.mock.calls[1][0]).toEqual({ capture: { tenantId: TENANT, migrationJobId: JOB, ...f.input.candidate }, manifest: archived });
    expect(observed.rows!.find(({ event_type }) => event_type === 'MIGRATION_PREPARATION_PLAN')!.redacted_details)
      .toMatchObject({ status: 'DIFF_VALIDATED', changes: [], blockers: [] });
    expect(canonicalJson(f.input)).toBe(inputBefore);
    producer.mockRestore(); checker.mockRestore();
    expect(await stored(f.observer)).toEqual([]);
    await preserved(f, f.before);
    f.fact.rejectionReport = rejected;
    f.fact.verified = { classification: 'INJECTED_NORMALIZER_OUTPUT_OMISSION', naturalMissingPointerProven: false,
      exactPointerDigest: pointerDigest, realCheckerCalls: 2, uncommittedAuditRows: 3, committedNewAuditRows: 0,
      actualRollbackAcknowledged: true, existingRowsAndXminUnchanged: true, catalogUnchanged: true };
  });
});
