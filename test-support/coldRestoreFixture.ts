import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { makeSupportedSheets, makeRedis, finalizeRedisSnapshot } from '@/server/migration/__fixtures__/normalization';
import { captureSheetsSnapshot } from '@/server/migration/sheetsSnapshot';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import { materializeLocalCandidate, type LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { canonicalJson, sha256 } from '@/server/migration/validators';

const TENANT = '20000000-0000-4000-8000-000000000001';

const JOB = '20000000-0000-4000-8000-000000000019';
const FULL = ['migration_full_generations','migration_full_sources','migration_full_targets','migration_full_mappings',
  'migration_full_contributors','migration_full_reconciliation','migration_full_delta_entries','migration_full_claim_recaptures'];
const databases: DisposablePostgres[] = [];
export async function cleanupColdFixture() { for (const db of databases.splice(0).reverse()) console.info('COLD_CLEANUP',JSON.stringify(await db.close())); }
async function database() {
  const db = await createDisposablePostgres(); databases.push(db);
  console.info('RESTORE_PG',JSON.stringify(db.evidence));
  return db;
}
export async function coldState(db: DisposablePostgres) {
  const tables = (await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  return Object.fromEntries(await Promise.all(tables.map(async ({tablename}) => [tablename,
    (await db.owner.query(`SELECT to_jsonb(t) AS value FROM public."${tablename}" t`)).rows.map(r => canonicalJson(r.value)).sort()])));
}
async function acquisition(mixed: boolean) {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([tab,data]) => [tab, [[...data.headers],...data.rows.map(row => [...row.cells])]]));
  if (mixed) {
    workbook.Products[1][1] = 'Changed pencil'; workbook.Products.push(['P2','Notebook','15','3','TRUE','','school','2']);
    workbook.Promotions = [workbook.Promotions[0]]; workbook.PromotionProducts = [workbook.PromotionProducts[0]];
  }
  const sheets = await captureSheetsSnapshot({spreadsheetId:seed.spreadsheetId,capturedAt:seed.capturedAt,
    reader:{listSheetNames:async () => Object.keys(workbook),getRows:async name => structuredClone(workbook[name]),getRevision:async () => mixed ? 'candidate' : 'original'}});
  const redis = makeRedis({v1Tombstones:[{tupleDigest:sha256('deleted-post'),ownerDigest:sha256('old-owner'),sourceProvenance:'upstash:padlet:evidence-claim:v1'}]});
  const op = redis.operationBindings[0];
  return {sheets,redis:finalizeRedisSnapshot({...redis,sourceRevision:mixed ? 'candidate-redis' : 'original-redis',
    operationBindings:mixed ? [op,{...op,operationId:'new-operation',binding:{...op.binding,evidence:{...op.binding.evidence,evidencePostId:'new-post'}}}] : [op]})};
}
export async function coldFixture(mixed = true) {
  const staged = await database(), source = await database();
  const ownerId = randomUUID();
  for (const db of [staged,source]) {
    await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'restore-test','Synthetic')",[TENANT]);
    await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
    for (const table of FULL) await db.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
    await db.owner.query('GRANT SELECT ON migration_local_restore_databases,migration_local_restorations TO app_runtime');
  }
  const original = await acquisition(false), candidate = await acquisition(mixed);
  const old = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...original});
  const next = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...candidate});
  expect(old.status).toBe('READY_FOR_IMPORT'); expect(next.status).toBe('READY_FOR_IMPORT');
  await importLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,manifest:old,runTransaction:staged.runTenantTransaction});
  for (const status of ['RECONCILING','READY']) await staged.owner.query('UPDATE migration_jobs SET status=$1,state_version=state_version+1',[status]);
  const version = (await staged.owner.query('SELECT state_version::text AS v FROM migration_jobs')).rows[0].v;
  const generation = await stageLocalFullGeneration({tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:version,
    originalSourceId:`sheet:${original.sheets.digest}`,originalSnapshotId:`import:${old.manifestDigest}`,
    exclusionGenerationReference:sha256('UNPROVEN local label'),original,candidate},staged.runTenantTransaction);
  for (const [db,role] of [[staged,'SOURCE'],[source,'DESTINATION']] as const) {
    await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)',[db.runId,ownerId,role,TENANT,JOB]);
    await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
    await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  }
  const lease = (db: DisposablePostgres) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId,
    queryOwner:async (text: string,values?: unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
  const binding: LocalCandidateBinding = {tenantId:TENANT,migrationJobId:JOB,generationId:generation.generationId,
    expectedStateVersion:version,sourceFingerprint:next.sourceFingerprint,manifestDigest:next.manifestDigest};
  await materializeLocalCandidate(binding,createOwnedLocalMaterializationRunner(TENANT,JOB,lease(staged),lease(source)));
  await staged.close();
  return {source,ownerId,binding,mixed};
}
