import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { makeSupportedSheets, makeRedis } from '@/server/migration/__fixtures__/normalization';
import { captureSheetsSnapshot } from '@/server/migration/sheetsSnapshot';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import type { FinalGenerationPreparationInput } from '@/server/migration/finalGeneration';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { TENANT, OTHER, JOB, TABLES } from './task19MutableFixture';
export { TENANT, OTHER, JOB };
export const INITIAL = '2026-09-28T00:00:00.000Z';
export const FINAL = '2026-09-28T00:01:00.000Z';
export const STALE = '2026-09-27T23:59:59.999Z';
const databases: DisposablePostgres[] = [];
export async function cleanupDeleteFixture() {
  const results = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    const result = await db.close();
    console.info('TASK19_DELETE_CLEANUP', JSON.stringify({ runId: db.runId, ...result }));
    return result;
  }));
  if (results.some(row => row.status === 'rejected')) throw new AggregateError(results, 'Owned delete cleanup failed');
}
export function deletionEvidence(label: string, value: unknown) {
  mkdirSync('.task19-delete-results', { recursive: true, mode: 0o700 });
  const path = `.task19-delete-results/${label}-${randomUUID()}.json`;
  writeFileSync(path, canonicalJson(value), { flag: 'wx', mode: 0o600 });
  console.info('TASK19_DELETE_EVIDENCE', path);
}
export async function deleteState(db: DisposablePostgres) {
  const tables = (await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    const name = String(tablename).replaceAll('"', '""');
    result[String(tablename)] = (await db.owner.query(`SELECT to_jsonb(t) AS row,xmin::text,ctid::text FROM public."${name}" t`)).rows
      .map(row => canonicalJson(row)).sort();
  }
  return result;
}
export async function deleteFixture() {
  const allocate = async () => {
    const db = await createDisposablePostgres(); databases.push(db);
    console.info('TASK19_DELETE_PG', JSON.stringify(db.evidence));
    return db;
  };
  // The actual editable synthetic source is separate from the immutable original
  // importer mirror. No operational tables/source or external Sheets reader.
  const local = await allocate(), source = await allocate(), destination = await allocate();
  const seed = makeSupportedSheets(), redis = makeRedis(), ownerId = randomUUID();
  const rows = Object.entries(seed.tabs).flatMap(([tab, data]) => [data.headers, ...data.rows.map(row => row.cells)]
    .map((cells, ordinal) => ({ tenant: TENANT, tab, ordinal, cells })));
  rows.push({ tenant: TENANT, tab: 'Products', ordinal: 2, cells: ['PX','Delete me','9','0','TRUE','','school','2'] });
  rows.push({ tenant: OTHER, tab: 'Products', ordinal: 2, cells: ['PX','Other tenant sentinel','9','0','TRUE','','school','2'] });
  await local.owner.query(`CREATE TABLE task19_delete_rows(tenant uuid,tab text,ordinal integer,cells jsonb,PRIMARY KEY(tenant,tab,ordinal));
    CREATE TABLE task19_delete_checkpoint(tenant uuid PRIMARY KEY,revision bigint NOT NULL);
    CREATE TABLE task19_delete_log(sequence bigint PRIMARY KEY,tenant uuid,identity text,before_value jsonb,after_value jsonb);
    CREATE SEQUENCE task19_delete_sequence;`);
  await local.owner.query(`INSERT INTO task19_delete_rows SELECT (v->>'tenant')::uuid,v->>'tab',(v->>'ordinal')::int,v->'cells'
    FROM jsonb_array_elements($1::jsonb) v`, [JSON.stringify(rows)]);
  await local.owner.query('INSERT INTO task19_delete_checkpoint VALUES($1,1),($2,1)', [TENANT, OTHER]);
  const capture = async (capturedAt = FINAL, spreadsheetId = seed.spreadsheetId) => ({ redis,
    sheets: await captureSheetsSnapshot({ spreadsheetId, capturedAt, reader: {
      listSheetNames: async () => (await local.owner.query('SELECT DISTINCT tab FROM task19_delete_rows WHERE tenant=$1 ORDER BY tab', [TENANT])).rows.map(row => row.tab),
      getRows: async tab => (await local.owner.query('SELECT cells FROM task19_delete_rows WHERE tenant=$1 AND tab=$2 ORDER BY ordinal', [TENANT, tab])).rows.map(row => row.cells),
      getRevision: async () => String((await local.owner.query('SELECT revision::text FROM task19_delete_checkpoint WHERE tenant=$1', [TENANT])).rows[0].revision),
    } }),
  });
  const original = await capture(INITIAL);
  const old = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...original });
  expect(old.status).toBe('READY_FOR_IMPORT');
  for (const db of [source, destination]) {
    await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'delete-synthetic','Synthetic')", [TENANT]);
    await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [TENANT, JOB]);
    for (const table of TABLES.filter(name => name.startsWith('migration_full_'))) await db.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  }
  await importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest: old, runTransaction: source.runTenantTransaction });
  for (const status of ['RECONCILING', 'READY']) await source.owner.query('UPDATE migration_jobs SET status=$1,state_version=state_version+1', [status]);
  const version = String((await source.owner.query('SELECT state_version::text AS version FROM migration_jobs')).rows[0].version);
  for (const [db, role] of [[source, 'SOURCE'], [destination, 'DESTINATION']] as const) {
    await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)', [db.runId, ownerId, role, TENANT, JOB]);
    await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
    await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
    await db.owner.query('GRANT SELECT ON migration_local_restore_databases,migration_local_restorations TO app_runtime');
  }
  const commitDelete = async (commit = true) => {
    const before = await deleteState(local), client = await local.owner.connect();
    let deleted: unknown, sequence: unknown;
    try {
      await client.query('BEGIN');
      sequence = (await client.query("SELECT nextval('task19_delete_sequence')::text AS sequence")).rows[0].sequence;
      deleted = (await client.query("DELETE FROM task19_delete_rows WHERE tenant=$1 AND tab='Products' AND cells->>0='PX' RETURNING *", [TENANT])).rows;
      expect(deleted).toHaveLength(1);
      await client.query('INSERT INTO task19_delete_log SELECT $1,tenant,cells->>0,cells,NULL FROM jsonb_populate_recordset(NULL::task19_delete_rows,$2::jsonb)', [sequence, JSON.stringify(deleted)]);
      await client.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1', [TENANT]);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    } finally { client.release(); }
    const after = await deleteState(local);
    const witness = { commit, before, after, deleted, sequence,
      checkpoint: (await local.owner.query('SELECT tenant,revision::text FROM task19_delete_checkpoint ORDER BY tenant')).rows,
      sequenceState: (await local.owner.query('SELECT last_value::text,is_called FROM task19_delete_sequence')).rows };
    deletionEvidence(commit ? 'committed-delete' : 'rolled-back-delete', witness);
    return witness;
  };
  const input = (candidate: FinalGenerationPreparationInput['candidate']): FinalGenerationPreparationInput => ({
    tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: version, original,
    candidate, originalSourceId: `sheet:${original.sheets.digest}`, originalSnapshotId: `import:${old.manifestDigest}`,
    exclusionGenerationReference: sha256('NONOPERATIONAL synthetic SQL source; no writer exclusion'),
  });
  const stage = async (candidate: FinalGenerationPreparationInput['candidate']) => {
    const staged = await stageLocalFullGeneration(input(candidate), source.runTenantTransaction);
    const next = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...candidate });
    const binding: LocalCandidateBinding = { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: version,
      generationId: staged.generationId, sourceFingerprint: next.sourceFingerprint, manifestDigest: next.manifestDigest };
    return { staged, binding, next };
  };
  const lease = (db: DisposablePostgres) => ({ kind: 'SYNTHETIC_DISPOSABLE' as const, databaseId: db.runId, ownerId,
    queryOwner: (text: string, values?: unknown[]) => db.owner.query(text, values), runTransaction: db.runTenantTransaction });
  const run = () => createOwnedLocalMaterializationRunner(TENANT, JOB, lease(source), lease(destination));
  const state = async () => ({ local: await deleteState(local), source: await deleteState(source), destination: await deleteState(destination) });
  return { local, source, destination, ownerId, original, old, capture, commitDelete, input, stage, run, state };
}
