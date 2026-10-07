import { expect } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import type { MixedRetentionPin } from '@/server/db/testing/task19MixedRetentionV2';
import { makeSupportedSheets, makeRedis } from '@/server/migration/__fixtures__/normalization';
import { captureSheetsSnapshot } from '@/server/migration/sheetsSnapshot';
import { captureRedisClaimSnapshot } from '@/server/migration/redisClaimSnapshot';
import { captureFinalCandidateWindow } from '@/server/migration/finalCaptureWindow';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { TABLES, TENANT, OTHER, JOB, type MutablePin, type MutableChildRequest } from './task19MutableFixture';
import { witness, REPORTS, type ColdDatabase } from './task19MixedCold';
export type MixedArchiveRequest = {phase:'produce'; tombstone:boolean} | (MutableChildRequest & {
  phase:'rebuild'|'retry'; pin:MixedRetentionPin; tombstone:boolean;
});
export const MIXED_ARCHIVE_RESULTS = '.task19-mixed-v2-results';
export async function allocateMixed(databases: DisposablePostgres[], ownerId: string, role: 'SOURCE'|'DESTINATION') {
  const db = await createDisposablePostgres(); databases.push(db);
  console.info('TASK19_MIXED_V2_PG',JSON.stringify(db.evidence));
  await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'archive-one','Synthetic'),($2,'archive-two','Other')",[TENANT,OTHER]);
  await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
  for (const table of TABLES.filter(name => name.startsWith('migration_full_'))) await db.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)',[db.runId,ownerId,role,TENANT,JOB]);
  await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
  await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  const pin: MutablePin = {databaseId:db.runId,containerId:String(db.evidence.containerId),imageId:String(db.evidence.imageId),
    systemIdentifier:(await db.owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id};
  return {db,pin, cold:{owner:db.owner,runtime:db.runtime,lease:{kind:'SYNTHETIC_DISPOSABLE' as const,
    databaseId:db.runId,ownerId,queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction}}};
}
// Independent one-contributor fixture oracle, no runtime deltaEntries/projector.
function image(manifest: LegacyNormalizationManifest, table: string, id: string) {
  const sources = manifest.sourceRecords.flatMap((sourceValue,sourceOrdinal) => sourceValue.targetTable === table
    && sourceValue.targetId === id ? [{sourceValue,sourceOrdinal}] : []);
  if (!sources.length) return null;
  const mappings = manifest.mappings.flatMap((mappingValue,mappingOrdinal) => mappingValue.targetTable === table
    && mappingValue.targetId === id ? [{mappingValue,mappingOrdinal}] : []);
  expect(sources).toHaveLength(1); expect(mappings).toHaveLength(1);
  const target = {...sources[0].sourceValue.canonicalRecord,tenantId:manifest.tenantId};
  expect(manifest.records[table]).toContainEqual(target);
  return {target,sources,mappings,contributors:[{sourceOrdinal:sources[0].sourceOrdinal,mappingOrdinal:mappings[0].mappingOrdinal}]};
}
export async function produceMixed(source: ColdDatabase, tombstone: boolean) {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name,tab]) => [name,[[...tab.headers],...tab.rows.map(row => [...row.cells])]]));
  workbook.Products.push(['PX','Removed cold product','9','0','TRUE','','school','2']);
  const operation = makeRedis().operationBindings[0], tombstoneKey = `padlet:evidence-claim:v1:${sha256('cold historical tombstone')}`;
  let revision = 'cold-original', claimRevision = 'claims-original';
  const acquire = async () => ({
    sheets:await captureSheetsSnapshot({spreadsheetId:seed.spreadsheetId,capturedAt:seed.capturedAt,reader:{
      listSheetNames:async () => Object.keys(workbook),getRows:async name => structuredClone(workbook[name]),getRevision:async () => revision,
    }}),
    redis:await captureRedisClaimSnapshot({
      hscan:async () => ({cursor:'0',entries:[[operation.claimField,operation.operationId],
        [`op:${sha256(operation.operationId)}`,JSON.stringify({binding:operation.binding,claimField:operation.claimField})]]}),
      scan:async () => ({cursor:'0',keys:tombstone ? [tombstoneKey] : []}),
      get:async key => {expect(key).toBe(tombstoneKey); return 'synthetic-prior-owner';},getRevision:async () => claimRevision,
    },{capturedAt:seed.capturedAt}),
  });
  const original = await acquire(), old = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...original});
  expect(old.status).toBe('READY_FOR_IMPORT');
  await importLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,manifest:old,runTransaction:source.lease.runTransaction});
  for (const status of ['RECONCILING','READY']) await source.owner.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2',[TENANT,JOB,status]);
  const version = (await source.owner.query('SELECT state_version::text AS version FROM migration_jobs')).rows[0].version as string;
  workbook.Products[1][1] = 'Cold captured pencil'; workbook.Products[1][2] = '27';
  workbook.Products.splice(workbook.Products.findIndex(row => row[0] === 'PX'),1);
  workbook.Settings.find(row => row[0] === 'themeColor')![1] = 'green';
  revision = 'cold-final'; claimRevision = 'claims-final';
  let controls = 0;
  const window = await captureFinalCandidateWindow(async () => {controls++; return {generation:7,disabled:true};},acquire);
  expect(controls).toBe(2);
  const input = {tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:version,originalSourceId:`sheet:${original.sheets.digest}`,
    originalSnapshotId:`import:${old.manifestDigest}`,exclusionGenerationReference:sha256('UNPROVEN local mixed cold capture'),original,candidate:window.candidate};
  const staged = await stageLocalFullGeneration(input,source.lease.runTransaction);
  expect(staged).toMatchObject({scope:'LOCAL_FULL_RECAPTURE_SNAPSHOT',activationAllowed:false,authority:'NONAUTHORITY'});
  const next = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...window.candidate});
  const binding: LocalCandidateBinding = {tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:version,generationId:staged.generationId,
    sourceFingerprint:next.sourceFingerprint,manifestDigest:next.manifestDigest};
  const envelopes = (await source.owner.query("SELECT event_id,redacted_details FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id")).rows;
  expect(envelopes).toHaveLength(3);
  expect(envelopes.find(row => row.redacted_details.phase === 'FINAL_CANDIDATE')!.redacted_details.acquisition).toEqual(window.candidate);
  const deltas = (await source.owner.query('SELECT * FROM migration_full_delta_entries ORDER BY target_table,target_id')).rows;
  expect(deltas.map(row => [row.target_table,row.change_kind])).toEqual([['products','MUTATED'],['products','REMOVED'],['settings','MUTATED']]);
  const recaptures = (await source.owner.query('SELECT * FROM migration_full_claim_recaptures')).rows;
  expect(recaptures).toHaveLength(1);
  for (const row of [...deltas,...recaptures]) {
    expect(row).toMatchObject({tenant_id:TENANT,migration_job_id:JOB,generation_id:binding.generationId});
    for (const [side,manifest] of [['before',old],['after',next]] as const) {
      const expected = image(manifest,row.target_table,row.target_id);
      expect(row.entry_value[side]).toEqual(expected);
      expect(row.entry_value[`${side}Digest`]).toBe(expected ? sha256(canonicalJson(expected.target)) : null);
    }
  }
  expect(recaptures[0].entry_value.kind).toBe('RECAPTURED');
  expect(recaptures[0].entry_value.beforeDigest).not.toBe(recaptures[0].entry_value.afterDigest);
  const reports = (await source.owner.query('SELECT * FROM migration_full_reconciliation ORDER BY category')).rows;
  expect(reports.map(row => row.category)).toEqual([...REPORTS].sort());
  expect(reports.find(row => row.category === 'padlet_claim_digest_tombstones')).toMatchObject({expected_count:tombstone ? 1 : 0,observed_count:tombstone ? 1 : 0,status:'MATCH'});
  for (const table of ['migration_full_delta_entries','migration_full_claim_recaptures','migration_full_reconciliation']) {
    await expect(source.owner.query(`UPDATE ${table} SET generation_id=generation_id`)).rejects.toMatchObject({code:'55000'});
  }
  return {binding,inventory:{envelopes,deltas,recaptures,reports},sourceWitness:await witness(source,false)};
}
