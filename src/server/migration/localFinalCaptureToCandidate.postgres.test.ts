// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { retainOwnedMutableProvenance } from '@/server/db/testing/task19MutableRetention';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { captureFinalCandidateWindow } from './finalCaptureWindow';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';
import { stageLocalFullGeneration } from './localFullGenerationStage';
import { materializeLocalCandidate, type LocalCandidateBinding } from './localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import { canonicalJson, sha256 } from './validators';
import { mutableState, forbidMutableWrites, TABLES, TENANT, OTHER, JOB } from '../../../test-support/task19MutableFixture';

vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const databases: DisposablePostgres[] = [];
const REFUSED = 'Local candidate domain materialization refused.';
const STAGE_REFUSED = 'Local full-generation stage refused.';
// Deliberately independent of the runtime catalog and manifest record keys.
const NORMALIZED = ['students','accounts','products','settings','tasks','task_allowed_students',
  'promotions','promotion_products','transactions','transaction_items','adjustments','task_assignments',
  'task_completions','legacy_operation_bindings','padlet_evidence_claims','padlet_claim_digest_tombstones'];
const BASE_REPORTS = [...NORMALIZED,'SOURCE_RECORDS','MAPPINGS','CONTRIBUTORS','DELTA_ENTRIES'];
afterEach(async () => {
  const results = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    const result = await db.close();
    console.info('TASK19_CAPTURE_CLEANUP', JSON.stringify(result));
  }));
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed, 'Owned capture fixture cleanup failed');
});

async function fixture(tombstone = false) {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map(row => [...row.cells])]]));
  workbook.Products.push(['PX','Removed final product','9','0','TRUE','','school','2']);
  const operation = makeRedis().operationBindings[0];
  const tombstoneKey = `padlet:evidence-claim:v1:${sha256('capture local historical tombstone')}`;
  const local = { sheetRevision:'local-original', claimRevision:'local-claims-1', generation:7, disabled:true,
    failTab:false, changeRevision:false, events:[] as string[] };
  const acquire = async () => {
    const sheets = await captureSheetsSnapshot({spreadsheetId:seed.spreadsheetId,capturedAt:seed.capturedAt,reader:{
      listSheetNames:async () => Object.keys(workbook),
      getRows:async name => {
        local.events.push(`rows:${name}`);
        if (name === 'Products' && local.failTab) throw new Error('Synthetic Products read interrupted');
        const rows = structuredClone(workbook[name]);
        if (name === 'Products' && local.changeRevision) local.sheetRevision = 'changed-during-read';
        return rows;
      },
      getRevision:async () => { local.events.push(`revision:${local.sheetRevision}`); return local.sheetRevision; },
    }});
    // Local in-memory reader only: no Redis client, credential or network access.
    const redis = await captureRedisClaimSnapshot({
      hscan:async () => ({cursor:'0',entries:[[operation.claimField,operation.operationId],
        [`op:${sha256(operation.operationId)}`,JSON.stringify({binding:operation.binding,claimField:operation.claimField})]]}),
      scan:async () => ({cursor:'0',keys:tombstone ? [tombstoneKey] : []}),
      get:async key => { expect(key).toBe(tombstoneKey); return 'synthetic-prior-owner'; },
      getRevision:async () => local.claimRevision,
    },{capturedAt:seed.capturedAt});
    return {sheets,redis};
  };
  const allocate = async () => {
    const db = await createDisposablePostgres(); databases.push(db);
    console.info('TASK19_CAPTURE_PG',JSON.stringify(db.evidence));
    await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'capture-one','Synthetic'),($2,'capture-two','Other')",[TENANT,OTHER]);
    return db;
  };
  const source = await allocate(), destination = await allocate(), ownerId = randomUUID();
  const original = await acquire();
  const old = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...original});
  expect(old.status).toBe('READY_FOR_IMPORT');
  await source.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
  await importLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,manifest:old,runTransaction:source.runTenantTransaction});
  for (const status of ['RECONCILING','READY']) await source.owner.query(
    'UPDATE migration_jobs SET status=$3,state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2',[TENANT,JOB,status]);
  const version = (await source.owner.query('SELECT state_version::text AS version FROM migration_jobs')).rows[0].version as string;
  for (const table of TABLES.filter(name => name.startsWith('migration_full_'))) await source.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  await destination.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
  for (const [db,role] of [[source,'SOURCE'],[destination,'DESTINATION']] as const) {
    await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)',[db.runId,ownerId,role,TENANT,JOB]);
    await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
    await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  }
  const editFinalSource = (recapture: boolean) => {
    // Edit the SAME actual local source after original import, not a prepared manifest.
    workbook.Products[1][1] = 'Final captured pencil'; workbook.Products[1][2] = '27';
    workbook.Products.splice(workbook.Products.findIndex(row => row[0] === 'PX'),1);
    workbook.Settings.find(row => row[0] === 'themeColor')![1] = 'green';
    local.sheetRevision = 'local-final';
    if (recapture) local.claimRevision = 'local-claims-2';
    local.events.length = 0;
  };
  const capture = async (readState = async () => {
    local.events.push('control'); return {generation:local.generation,disabled:local.disabled};
  }) => {
    const window = await captureFinalCandidateWindow(readState,acquire);
    expect(window).toMatchObject({authority:'NONAUTHORITY',exclusion:'NOT_PROVEN',generation:7});
    const input: FinalGenerationPreparationInput = {tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:version,
      originalSourceId:`sheet:${original.sheets.digest}`,originalSnapshotId:`import:${old.manifestDigest}`,
      exclusionGenerationReference:sha256(canonicalJson({label:'UNPROVEN local control',generation:window.generation})),
      original,candidate:window.candidate};
    return input;
  };
  const stage = async (input: FinalGenerationPreparationInput, run: TenantImportTransactionRunner = source.runTenantTransaction) => {
    const staged = await stageLocalFullGeneration(input,run);
    const next = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...input.candidate});
    expect(next.status).toBe('READY_FOR_IMPORT');
    const binding: LocalCandidateBinding = {tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:version,
      generationId:staged.generationId,sourceFingerprint:next.sourceFingerprint,manifestDigest:next.manifestDigest};
    return {staged,next,binding};
  };
  const lease = (db: DisposablePostgres) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId,
    queryOwner:(text: string,values?: unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
  const run = () => createOwnedLocalMaterializationRunner(TENANT,JOB,lease(source),lease(destination));
  const state = async () => [await mutableState(source),await mutableState(destination)];
  return {source,destination,ownerId,local,original,old,editFinalSource,capture,stage,run,state};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function inventory(f: Fixture, input: FinalGenerationPreparationInput, result: Awaited<ReturnType<Fixture['stage']>>, recapture: boolean) {
  const {binding,next} = result;
  const envelopes = (await f.source.owner.query("SELECT event_id,redacted_details FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id")).rows;
  expect(envelopes).toHaveLength(3);
  const candidate = envelopes.find(row => row.redacted_details.phase === 'FINAL_CANDIDATE')!;
  expect(candidate.redacted_details.acquisition).toEqual(input.candidate);
  expect(candidate.redacted_details.binding).toMatchObject({tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:binding.expectedStateVersion,
    originalSnapshotId:input.originalSnapshotId,originalSourceId:input.originalSourceId,originalSourceFingerprint:f.old.sourceFingerprint});
  expect(candidate.redacted_details.exclusionGenerationReference).toBe(input.exclusionGenerationReference);
  const header = (await f.source.owner.query('SELECT * FROM migration_full_generations')).rows;
  expect(header).toHaveLength(1);
  expect(header[0]).toMatchObject({tenant_id:TENANT,migration_job_id:JOB,generation_id:binding.generationId,
    candidate_generation_id:candidate.event_id,source_fingerprint:binding.sourceFingerprint,manifest_digest:binding.manifestDigest});
  const delta = (await f.source.owner.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_table,target_id')).rows;
  expect(delta.map(row => [row.target_table,row.change_kind])).toEqual([['products','MUTATED'],['products','REMOVED'],['settings','MUTATED']]);
  for (const row of delta.filter(row => row.target_table === 'products')) {
    const entry = row.entry_value;
    expect(entry.identity).toBe(canonicalJson([row.target_id]));
    for (const [side,manifest] of [['before',f.old],['after',next]] as const) {
      const target = manifest.records.products.find(product => product.productId === row.target_id) ?? null;
      expect(entry[`${side}Digest`]).toBe(target && sha256(canonicalJson(target)));
      if (!target) { expect(entry[side]).toBeNull(); continue; }
      const sources = manifest.sourceRecords.flatMap((sourceValue,sourceOrdinal) => sourceValue.targetTable === 'products'
        && sourceValue.targetId === row.target_id ? [{sourceValue,sourceOrdinal}] : []);
      const mappings = manifest.mappings.flatMap((mappingValue,mappingOrdinal) => mappingValue.targetTable === 'products'
        && mappingValue.targetId === row.target_id ? [{mappingValue,mappingOrdinal}] : []);
      expect(sources).toHaveLength(1); expect(mappings).toHaveLength(1);
      expect(entry[side]).toEqual({target,sources,mappings,contributors:[{sourceOrdinal:sources[0].sourceOrdinal,mappingOrdinal:mappings[0].mappingOrdinal}]});
    }
  }
  const reports = (await f.source.owner.query('SELECT * FROM migration_full_reconciliation ORDER BY category')).rows;
  expect(reports.map(row => row.category)).toEqual([...BASE_REPORTS,...(recapture ? ['CLAIM_RECAPTURES'] : [])].sort());
  for (const report of reports) {
    expect(report).toMatchObject({tenant_id:TENANT,migration_job_id:JOB,generation_id:binding.generationId,status:'MATCH'});
    expect(report.expected_count).toBe(report.observed_count); expect(report.expected_digest).toBe(report.observed_digest);
    if (NORMALIZED.includes(report.category)) expect(report.expected_count).toBe((next.records[report.category] ?? []).length);
  }
  console.info('TASK19_CAPTURE_INVENTORY',JSON.stringify({binding,envelopes,delta,reports,events:f.local.events}));
}

suite('Task19 final captured source to disposable candidate', () => {
  it.each([false,true])('explicitly refuses Products-only V1 archive for a complete mixed recapture, tombstone=%s', async tombstone => {
    const f = await fixture(tombstone); f.editFinalSource(true);
    const input = await f.capture(), result = await f.stage(input);
    await inventory(f,input,result,true);
    expect((await f.source.owner.query('SELECT * FROM migration_full_claim_recaptures')).rows).toHaveLength(1);
    const parent = `.task19-mixed-unsupported/${randomUUID()}`;
    mkdirSync(parent,{recursive:true,mode:0o700});
    const before = await f.state();
    await expect(retainOwnedMutableProvenance(f.source,f.ownerId,result.binding,parent))
      .rejects.toThrow('Local mutable retention archive refused.');
    expect(readdirSync(parent)).toEqual([]);
    expect(await f.state()).toEqual(before);
    console.info('TASK19_MIXED_ARCHIVE_UNSUPPORTED',JSON.stringify({tombstone,binding:result.binding,
      status:'UNSUPPORTED_FAIL_CLOSED',archiveCreated:false,sourceDestinationUnchanged:true,
      contract:'TASK19_MUTABLE_RETENTION_V1 requires Products ADDED/MUTATED/REMOVED, empty recaptures, full-mutable-stage identity'}));
  },120_000);

  it('characterizes the existing checked mutable path without changing the ADDED-only preparation contract', async () => {
    const f = await fixture(); f.editFinalSource(false);
    const input = await f.capture(), before = await f.state();
    expect(f.local.events[0]).toBe('control'); expect(f.local.events.at(-1)).toBe('control');
    expect(f.local.events.filter(event => event === 'rows:Products')).toHaveLength(1);
    await expect(stageLocalFullDeltaCheckedPreparation(input,f.source.runTenantTransaction)).rejects.toThrow('Local full-delta-checked preparation refused.');
    expect(await f.state()).toEqual(before);
    const result = await f.stage(input); await inventory(f,input,result,false);
    const receipt = await materializeLocalCandidate(result.binding,f.run());
    expect(receipt).toMatchObject({authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
    expect((await f.destination.owner.query('SELECT product_id,name,price::text FROM products ORDER BY product_id')).rows)
      .toEqual([{product_id:'P1',name:'Final captured pencil',price:'27'}]);
    expect((await f.source.owner.query('SELECT product_id,name FROM products ORDER BY product_id')).rows)
      .toEqual([{product_id:'P1',name:'Pencil'},{product_id:'PX',name:'Removed final product'}]);
  },120_000);

  it.each([false,true])('cross-category final recapture keeps every report and tombstone, populated=%s', async tombstone => {
    const f = await fixture(tombstone); f.editFinalSource(true);
    const input = await f.capture(), result = await f.stage(input);
    expect(result.staged.scope).toBe('LOCAL_FULL_RECAPTURE_SNAPSHOT');
    await inventory(f,input,result,true);
    const recaptures = (await f.source.owner.query('SELECT entry_value FROM migration_full_claim_recaptures')).rows;
    expect(recaptures).toHaveLength(1);
    expect(recaptures[0].entry_value.beforeDigest).not.toBe(recaptures[0].entry_value.afterDigest);
    await forbidMutableWrites(f.source);
    const before = await mutableState(f.source);
    const receipt = await materializeLocalCandidate(result.binding,f.run());
    expect(receipt.binding).toEqual(result.binding); expect(receipt.activationAllowed).toBe(false);
    expect((await f.destination.owner.query('SELECT product_id,name FROM products')).rows).toEqual([{product_id:'P1',name:'Final captured pencil'}]);
    expect((await f.destination.owner.query('SELECT tuple_digest FROM padlet_claim_digest_tombstones')).rows)
      .toHaveLength(tombstone ? 1 : 0);
    const committed = await f.state(); await forbidMutableWrites(f.destination);
    expect(await materializeLocalCandidate(result.binding,f.run())).toEqual(receipt);
    expect(await f.state()).toEqual(committed); expect(await mutableState(f.source)).toEqual(before);
    expect((await f.destination.owner.query('SELECT status,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
      .toEqual([{status:'IMPORTING',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
  },120_000);

  it.each([false,true])('refuses omitted empty tombstone accounting across recapture, destination retry=%s', async retry => {
    const f = await fixture(); f.editFinalSource(true);
    const input = await f.capture(), result = await f.stage(input);
    if (retry) await materializeLocalCandidate(result.binding,f.run());
    await f.source.owner.query('ALTER TABLE migration_full_reconciliation DISABLE TRIGGER USER');
    try { await f.source.owner.query("DELETE FROM migration_full_reconciliation WHERE category='padlet_claim_digest_tombstones'"); }
    finally { await f.source.owner.query('ALTER TABLE migration_full_reconciliation ENABLE TRIGGER USER'); }
    const before = await f.state();
    const outcome = await materializeLocalCandidate(result.binding,f.run()).then(value => ({accepted:true,value}),
      error => ({accepted:false,error:(error as Error).message}));
    console.info('TASK19_CAPTURE_OMISSION',JSON.stringify({retry,binding:result.binding,outcome,
      beforeDigest:sha256(canonicalJson(before)),afterDigest:sha256(canonicalJson(await f.state()))}));
    expect(outcome).toEqual({accepted:false,error:REFUSED}); expect(await f.state()).toEqual(before);
    await expect(f.stage(input)).rejects.toThrow(STAGE_REFUSED);
    expect(await f.state()).toEqual(before); // No read-side healing on preparation retry either.
  },120_000);

  it('refuses every omitted cross-category report, removed-product image and recapture before import and receipt retry', async () => {
    const f = await fixture(); f.editFinalSource(true);
    const result = await f.stage(await f.capture());
    const cases = [...BASE_REPORTS,'CLAIM_RECAPTURES'].map(category => ({table:'migration_full_reconciliation',
      predicate:'category=$1',values:[category]}));
    cases.push({table:'migration_full_delta_entries',predicate:'change_kind=$1',values:['REMOVED']},
      {table:'migration_full_claim_recaptures',predicate:'target_table=$1',values:['padlet_evidence_claims']});
    for (const retry of [false,true]) {
      if (retry) await materializeLocalCandidate(result.binding,f.run());
      const baseline = await f.state();
      for (const {table,predicate,values} of cases) {
        const rows = (await f.source.owner.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${predicate}`,values)).rows;
        expect(rows).toHaveLength(1);
        await f.source.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        try { await f.source.owner.query(`DELETE FROM ${table} WHERE ${predicate}`,values); }
        finally { await f.source.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`); }
        const missing = await f.state();
        await expect(materializeLocalCandidate(result.binding,f.run()),`${retry}:${table}:${values}`).rejects.toThrow(REFUSED);
        expect(await f.state()).toEqual(missing);
        // Explicit owner-only fixture restoration, never runtime read-side repair.
        await f.source.owner.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
          [JSON.stringify(rows.map(row => row.value))]);
        expect(await f.state()).toEqual(baseline);
      }
    }
    console.info('TASK19_CAPTURE_OMISSION_MATRIX',JSON.stringify({binding:result.binding,cases,phases:['before-import','receipt-retry']}));
  },120_000);

  it('refuses exact preparation and materialization binding substitutions without writing', async () => {
    const f = await fixture(); f.editFinalSource(true);
    const input = await f.capture(), baseline = await f.state();
    for (const [key,value] of Object.entries({tenantId:OTHER,migrationJobId:randomUUID(),expectedStateVersion:'99',
      originalSourceId:`sheet:${sha256('wrong source')}`,originalSnapshotId:`import:${sha256('wrong snapshot')}`})) {
      await expect(f.stage({...input,[key]:value}),key).rejects.toThrow(STAGE_REFUSED);
      expect(await f.state()).toEqual(baseline);
    }
    const result = await f.stage(input);
    for (const retry of [false,true]) {
      if (retry) await materializeLocalCandidate(result.binding,f.run());
      const before = await f.state();
      for (const [key,value] of Object.entries({tenantId:OTHER,migrationJobId:randomUUID(),generationId:'wrong-generation',
        expectedStateVersion:'99',sourceFingerprint:sha256('wrong fingerprint'),manifestDigest:sha256('wrong manifest')})) {
        await expect(materializeLocalCandidate({...result.binding,[key]:value},f.run()),key).rejects.toThrow(REFUSED);
        expect(await f.state()).toEqual(before);
      }
    }
  },120_000);

  it('rejects interrupted or changing actual final source reads, then captures fresh bytes on retry', async () => {
    const f = await fixture(); f.editFinalSource(true); const before = await f.state();
    f.local.failTab = true;
    await expect(f.capture()).rejects.toThrow('Final capture window refused.');
    f.local.failTab = false; f.local.changeRevision = true;
    await expect(f.capture()).rejects.toThrow('Final capture window refused.');
    f.local.changeRevision = false;
    let reads = 0;
    await expect(f.capture(async () => ({disabled:true,generation:++reads === 1 ? 7 : 8}))).rejects.toThrow('Final capture window refused.');
    expect(await f.state()).toEqual(before);
    const input = await f.capture(), result = await f.stage(input);
    await inventory(f,input,result,true);
    expect((await materializeLocalCandidate(result.binding,f.run())).activationAllowed).toBe(false);
  },120_000);

  it('rolls back interrupted checked preparation and recovers a lost commit response without duplicate evidence', async () => {
    const f = await fixture(); f.editFinalSource(true);
    const input = await f.capture(), before = await f.state();
    let reached = false, nativeCode: unknown;
    const interrupted: TenantImportTransactionRunner = (tenant,callback) => f.source.runTenantTransaction(tenant,async tx => {
      await callback(tx); reached = true;
      // Genuine native error AFTER all three envelopes and the full graph/readback.
      const { sql } = await import('drizzle-orm');
      try { await tx.execute(sql`SELECT 1 / 0`); }
      catch (error) { nativeCode = (error as {cause?: {code?: string}}).cause?.code; throw error; }
      throw new Error('Native failure was not raised');
    });
    await expect(f.stage(input,interrupted)).rejects.toThrow(STAGE_REFUSED);
    expect(reached).toBe(true); expect(nativeCode).toBe('22012'); expect(await f.state()).toEqual(before);
    let committed = false;
    await expect(f.stage(input,async (tenant,callback) => {
      await f.source.runTenantTransaction(tenant,callback); committed = true; throw new Error('Synthetic response lost after COMMIT');
    })).rejects.toThrow(STAGE_REFUSED);
    expect(committed).toBe(true);
    const saved = await f.state(), result = await f.stage(input);
    expect(await f.state()).toEqual(saved); await inventory(f,input,result,true);
    expect((await materializeLocalCandidate(result.binding,f.run())).activationAllowed).toBe(false);
    console.info('TASK19_CAPTURE_INTERRUPTION',JSON.stringify({nativeCode,reached,committed,binding:result.binding,
      rolledBackDigest:sha256(canonicalJson(before)),committedDigest:sha256(canonicalJson(saved))}));
  },120_000);
});
