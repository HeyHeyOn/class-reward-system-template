import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { makeSupportedSheets, makeRedis } from '@/server/migration/__fixtures__/normalization';
import { captureSheetsSnapshot } from '@/server/migration/sheetsSnapshot';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { canonicalJson, sha256 } from '@/server/migration/validators';

export const TENANT = '20000000-0000-4000-8000-000000000001';
export const OTHER = '20000000-0000-4000-8000-000000000002';
export const JOB = '20000000-0000-4000-8000-000000000019';
const FULL = ['migration_full_generations','migration_full_sources','migration_full_targets','migration_full_mappings',
  'migration_full_contributors','migration_full_delta_entries','migration_full_claim_recaptures','migration_full_reconciliation'];
export const TABLES = ['tenants','migration_jobs','audit_events','migration_sources','migration_source_records','migration_snapshots',
  'migration_local_disposable_database','migration_local_materializations',...FULL,'products','students','accounts','tenant_settings',
  'promotions','promotion_products','transactions','transaction_items','adjustments','tasks','task_allowed_students',
  'task_assignments','task_completions','operations','inventory_ledger','padlet_evidence_claims',
  'padlet_claim_digest_tombstones','padlet_claim_digest_registry'];
const databases: DisposablePostgres[] = [];
export async function cleanupMutableFixture() {
  const results = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    const result = await db.close();
    console.info('TASK19_MUTABLE_CLEANUP', JSON.stringify(result));
    return result;
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures, 'Task19 owned cleanup failed');
}
export async function mutableState(db: DisposablePostgres) {
  const values: Record<string, string[]> = {};
  for (const table of TABLES) {
    values[table] = (await db.owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows
      .map(row => canonicalJson(row.row)).sort();
  }
  return values;
}
export type MutableVariant = 'mixed' | 'final-only' | 'mutated-only' | 'removed-only';
async function capture(candidate: boolean, variant: MutableVariant) {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([tab, data]) =>
    [tab, [[...data.headers], ...data.rows.map(row => [...row.cells])]]));
  if (candidate && variant !== 'removed-only') {
    workbook.Products[1][1] = 'Mutable pencil';
    workbook.Products[1][2] = '27';
    workbook.Products[1][3] = '8';
  }
  if (candidate && variant === 'mixed') workbook.Products.push(['PNEW','Added notebook','15','3','TRUE','','school','2']);
  if (!candidate && variant !== 'mutated-only') workbook.Products.push(['PX','Removed unreferenced','9','0','TRUE','','school','2']);
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId, capturedAt: seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async name => structuredClone(workbook[name]),
      getRevision: async () => candidate ? 'mutable-candidate' : 'mutable-original' } });
  return { sheets, redis: makeRedis() };
}
export type MutablePin = { containerId: string; databaseId: string; imageId: string; systemIdentifier: string };
export type MutableChildRequest = { source: MutablePin; destination: MutablePin; ownerId: string; binding: LocalCandidateBinding };
export async function mutableFixture(variant: MutableVariant = 'mixed') {
  const allocate = async () => {
    const db = await createDisposablePostgres();
    databases.push(db);
    console.info('TASK19_MUTABLE_PG', JSON.stringify(db.evidence));
    await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'mutable-one','Synthetic'),($2,'mutable-two','Synthetic other')", [TENANT, OTHER]);
    return db;
  };
  const source = await allocate(), destination = await allocate(), ownerId = randomUUID();
  const original = await capture(false, variant), candidate = await capture(true, variant);
  const old = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...original });
  const next = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...candidate });
  expect(old.status).toBe('READY_FOR_IMPORT'); expect(next.status).toBe('READY_FOR_IMPORT');
  await source.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [TENANT, JOB]);
  await importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest: old, runTransaction: source.runTenantTransaction });
  for (const status of ['RECONCILING','READY']) await source.owner.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2', [TENANT, JOB, status]);
  const version = (await source.owner.query('SELECT state_version::text AS v FROM migration_jobs')).rows[0].v as string;
  // Existing synthetic fixture privileges only; no production role/DDL changes.
  for (const table of FULL) await source.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  const staged = await stageLocalFullGeneration({ tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: version,
    originalSourceId: `sheet:${original.sheets.digest}`, originalSnapshotId: `import:${old.manifestDigest}`,
    exclusionGenerationReference: sha256('UNPROVEN Task19 synthetic label'), original, candidate }, source.runTenantTransaction);
  expect(staged.scope).toBe('LOCAL_FULL_MUTABLE_SNAPSHOT');
  await destination.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [TENANT, JOB]);
  for (const [db, role] of [[source,'SOURCE'],[destination,'DESTINATION']] as const) {
    await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)', [db.runId, ownerId, role, TENANT, JOB]);
    await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
    await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  }
  const lease = (db: DisposablePostgres) => ({ kind: 'SYNTHETIC_DISPOSABLE' as const, databaseId: db.runId, ownerId,
    queryOwner: (text: string, values?: unknown[]) => db.owner.query(text, values), runTransaction: db.runTenantTransaction });
  const run = () => createOwnedLocalMaterializationRunner(TENANT, JOB, lease(source), lease(destination));
  const binding: LocalCandidateBinding = { tenantId: TENANT, migrationJobId: JOB, generationId: staged.generationId,
    expectedStateVersion: version, sourceFingerprint: next.sourceFingerprint, manifestDigest: next.manifestDigest };
  const pin = async (db: DisposablePostgres): Promise<MutablePin> => ({ databaseId: db.runId,
    containerId: String(db.evidence.containerId), imageId: String(db.evidence.imageId),
    systemIdentifier: (await db.owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id });
  const request: MutableChildRequest = { source: await pin(source), destination: await pin(destination), ownerId, binding };
  return { source, destination, ownerId, old, next, binding, run, request };
}

/** Fail at SQL if the application attempts to repair or republish any rows. */
export async function forbidMutableWrites(db: DisposablePostgres) {
  await db.owner.query("CREATE FUNCTION task19_no_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Task19 retry attempted a write'; END $$");
  for (const table of TABLES) await db.owner.query(`CREATE TRIGGER task19_no_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION task19_no_write()`);
}
