// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { makeSupportedSheets, makeRedis } from '@/server/migration/__fixtures__/normalization';
import { captureSheetsSnapshot } from '@/server/migration/sheetsSnapshot';
import { captureRedisClaimSnapshot } from '@/server/migration/redisClaimSnapshot';
import { captureFinalCandidateWindow } from '@/server/migration/finalCaptureWindow';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from '@/server/migration/manifest';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import { materializeLocalCandidate, type LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { TENANT, OTHER, JOB } from './task19MutableFixture';
import { coldConnections, denyWrites, clearWriteGuard, witness, REPORTS, type MixedColdRequest, type ColdDatabase } from './task19MixedCold';
vi.mock('server-only', () => ({}));
const path = process.env.TASK19_MIXED_COLD_REQUEST;
if (path && !/^\.task19-mixed-cold-results\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid cold request path');
const REFUSED = 'Local candidate domain materialization refused.';

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
async function produce(source: ColdDatabase, tombstone: boolean) {
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

type Fault = {name:string;table:string;predicate:string;values:unknown[];update?:string};
async function exercise(source: ColdDatabase, destination: ColdDatabase, request: MixedColdRequest) {
  const binding = request.binding!;
  expect(binding).toBeDefined();
  const run = () => createOwnedLocalMaterializationRunner(TENANT,JOB,source.lease,destination.lease);
  const state = async () => ({source:await witness(source),destination:await witness(destination)});
  // Negatives run with normal runtime permissions and original SQL guards ONLY.
  // An extra test no-write trigger here could mask a read-side healing bug.
  const observations: Record<string,unknown>[] = [];
  const refuse = async (name: string, candidate = binding, runner = run()) => {
    const before = await state();
    const outcome = await materializeLocalCandidate(candidate,runner).then(value => ({accepted:true,value}),
      error => ({accepted:false,error:(error as Error).message}));
    const after = await state();
    observations.push({name,outcome,before,after});
    expect(outcome,name).toEqual({accepted:false,error:REFUSED});
    expect(after,name).toEqual(before);
  };
  for (const [key,value] of Object.entries({tenantId:OTHER,migrationJobId:randomUUID(),generationId:'wrong-cold-generation',
    expectedStateVersion:'99',sourceFingerprint:sha256('wrong cold source'),manifestDigest:sha256('wrong cold manifest')})) {
    await refuse(`binding:${key}`,{...binding,[key]:value});
  }
  await refuse('physical-source-database-id',binding,createOwnedLocalMaterializationRunner(TENANT,JOB,
    {...source.lease,databaseId:randomUUID()},destination.lease));
  const faults: Fault[] = REPORTS.flatMap(category => [
    {name:`missing-report:${category}`,table:'migration_full_reconciliation',predicate:'category=$1',values:[category]},
    {name:`corrupt-report:${category}`,table:'migration_full_reconciliation',predicate:'category=$1',values:[category],
      update:"expected_digest=repeat('0',64),observed_digest=repeat('0',64)"},
  ]);
  faults.push(
    {name:'removed-product-missing',table:'migration_full_delta_entries',predicate:"change_kind='REMOVED'",values:[]},
    {name:'removed-product-before',table:'migration_full_delta_entries',predicate:"change_kind='REMOVED'",values:[],update:"entry_value=jsonb_set(entry_value,'{before,target,name}','\"wrong\"')"},
    {name:'product-after',table:'migration_full_delta_entries',predicate:"target_table='products' AND change_kind='MUTATED'",values:[],update:"entry_value=jsonb_set(entry_value,'{after,target,name}','\"wrong\"')"},
    {name:'settings-before',table:'migration_full_delta_entries',predicate:"target_table='settings'",values:[],update:"entry_value=jsonb_set(entry_value,'{before,target,value}','\"wrong\"')"},
    {name:'recapture-missing',table:'migration_full_claim_recaptures',predicate:'true',values:[]},
    {name:'recapture-before',table:'migration_full_claim_recaptures',predicate:'true',values:[],update:"entry_value=jsonb_set(entry_value,'{beforeDigest}',to_jsonb(repeat('0',64)))"},
    {name:'recapture-after',table:'migration_full_claim_recaptures',predicate:'true',values:[],update:"entry_value=jsonb_set(entry_value,'{afterDigest}',to_jsonb(repeat('0',64)))"},
    {name:'original-source-pointer',table:'audit_events',predicate:"redacted_details->>'phase'='ORIGINAL_PREFLIGHT'",values:[],update:"redacted_details=jsonb_set(redacted_details,'{originalSourceId}','\"sheet:wrong\"')"},
  );
  if (request.tombstone) faults.push(
    {name:'claim-tombstone-missing',table:'migration_full_targets',predicate:"target_table='padlet_claim_digest_tombstones'",values:[]},
    {name:'claim-tombstone-corrupt',table:'migration_full_targets',predicate:"target_table='padlet_claim_digest_tombstones'",values:[],update:"canonical_value=jsonb_set(canonical_value,'{ownerDigest}',to_jsonb(repeat('0',64)))"},
  );
  for (const fault of faults) {
    const {table,predicate,values} = fault;
    // Damaged-storage simulation on the owned fixture only: bypass the inbound
    // target FK during deletion, then restore ALL triggers before runtime reads.
    const triggerScope = table === 'migration_full_targets' && !fault.update ? 'ALL' : 'USER';
    const saved = (await source.owner.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${predicate}`,values)).rows;
    expect(saved,fault.name).toHaveLength(1);
    await source.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER ${triggerScope}`);
    try {
      const changed = await source.owner.query(`${fault.update ? `UPDATE ${table} SET ${fault.update}` : `DELETE FROM ${table}`} WHERE ${predicate} RETURNING to_jsonb(${table}.*) AS value`,values);
      expect(changed.rowCount).toBe(1); expect(changed.rows,fault.name).not.toEqual(fault.update ? saved : []);
    } finally {await source.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER ${triggerScope}`);}
    try {await refuse(fault.name);}
    finally {
      // Explicit owner-only corruption undo, outside the measured runtime interval.
      await source.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER ${triggerScope}`);
      try {
        if (fault.update) {
          // Preserve referenced row identity (audit envelope FKs remain enabled).
          const columns = Object.keys(saved[0].value).map(key => `"${key}"`).join(',');
          await source.owner.query(`UPDATE ${table} SET (${columns})=(SELECT ${columns} FROM
            jsonb_populate_record(NULL::${table},$${values.length+1}::jsonb)) WHERE ${predicate}`,
          [...values,JSON.stringify(saved[0].value)]);
        } else {
          await source.owner.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(saved.map(row => row.value))]);
        }
      } finally {await source.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER ${triggerScope}`);}
    }
  }
  const sourceBefore = await witness(source), destinationBefore = await witness(destination);
  // Positives additionally reject even attempted writes (including ON CONFLICT).
  await denyWrites(source);
  if (request.phase === 'retry') await denyWrites(destination);
  const receipt = await materializeLocalCandidate(binding,run());
  expect(receipt).toMatchObject({binding,authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
  expect(await witness(source)).toBe(sourceBefore);
  if (request.phase === 'retry') expect(await witness(destination)).toBe(destinationBefore);
  expect((await destination.owner.query('SELECT product_id,name,price::text FROM products ORDER BY product_id')).rows)
    .toEqual([{product_id:'P1',name:'Cold captured pencil',price:'27'}]);
  expect((await destination.owner.query("SELECT settings->>'themeColor' AS value FROM tenant_settings")).rows).toEqual([{value:'green'}]);
  expect((await destination.owner.query('SELECT * FROM padlet_claim_digest_tombstones')).rows).toHaveLength(request.tombstone ? 1 : 0);
  expect((await destination.owner.query('SELECT * FROM padlet_evidence_claims')).rows).toHaveLength(1);
  expect((await destination.owner.query('SELECT status,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
    .toEqual([{status:'IMPORTING',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
  await clearWriteGuard(source);
  if (request.phase === 'retry') await clearWriteGuard(destination);
  return {receipt,observations,sourceWitness:await witness(source,false),destinationWitness:await witness(destination)};
}

it.skipIf(!path)('Task19 mixed recapture process phase', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const request = JSON.parse(readFileSync(path!,'utf8')) as MixedColdRequest;
  // Recovery accepts ONLY physical pins + expected binding, never captures/rows.
  expect(Object.keys(request).sort()).toEqual(['source','destination','ownerId','tombstone','phase',...(request.phase === 'produce' ? [] : ['binding'])].sort());
  const connections = coldConnections(request);
  const result: Record<string,unknown> = {pid:process.pid,phase:request.phase,success:false};
  try {
    const source = await connections.connect(request.source,'SOURCE');
    if (request.phase === 'produce') Object.assign(result,await produce(source,request.tombstone));
    else {
      const destination = await connections.connect(request.destination,'DESTINATION');
      Object.assign(result,await exercise(source,destination,request));
    }
    result.success = true;
  } finally {
    await connections.close(); result.poolsClosed = true; result.backends = connections.backends;
    writeFileSync(path!.replace('-request.json','-result.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
  }
},300_000);
